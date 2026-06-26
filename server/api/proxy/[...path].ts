/**
 * REST API プロキシ
 * /api/proxy/* → rust-alc-api の /api/* に転送
 *
 * #434 step 2: introspect 検証 → X-Tenant-ID + X-User-ID/Email/Role 注入を
 * @ippoan/auth-client/server の createIdentityProxyHandler に集約。rust-alc-api
 * は #441 で JWT 検証を撤去し注入 identity を信頼する dumb backend になったため、
 * X-User-* を載せないと require_tenant_header が AuthUser を復元できず AuthUser
 * 必須 handler が 500 になる。createIdentityProxyHandler は introspect 結果から
 * X-User-* も載せてこれを解消する。
 *
 * introspect は AUTH_WORKER service binding (worker-to-worker, in-process) で
 * 叩くので外部 req を増やさない。INTERNAL_SHARED_SECRET は Secrets Store
 * binding (.get()) のため route 側で resolve してから渡す。
 *
 * pathPrefix は '/' に設定する。client (`app/utils/api.ts`) は backend route と
 * 同じ `/api/drivers` 等を `apiBase` (= /api/proxy) に連結して叩くため、catch-all
 * の path は `api/drivers` になる。`'/' + 'api/drivers'` = `/api/drivers` で
 * backend route に一致する (= api.ts の route 文字列を書き換えずに済む)。
 */
import type { H3Event } from 'h3'
import { createIdentityProxyHandler } from '@ippoan/auth-client/server'

function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す。 */
async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

export default defineEventHandler(async (event) => {
  const env = cfEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({
      statusCode: 503,
      statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です',
    })
  }
  const authWorkerUrl =
    typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined

  const proxy = createIdentityProxyHandler({
    backendUrl: (e) =>
      (useRuntimeConfig(e).alcApiUrl as string) ||
      'https://rust-alc-api-566bls5vfq-an.a.run.app',
    authWorkerUrl,
    sharedSecret,
    // api.ts は backend と同じ /api/* path を叩くので prefix は '/' (二重 /api 防止)。
    pathPrefix: '/',
    // AUTH_WORKER service binding 経由で introspect (worker-to-worker, in-process)。
    introspectFetch: authWorker ? () => authWorker.fetch.bind(authWorker) : undefined,
  })
  return proxy(event)
})
