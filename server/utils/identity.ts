/**
 * Worker server route で backend (rust-alc-api) を直叩きする時の identity 注入ヘルパ。
 *
 * rust-alc-api は #441 で JWT 検証を撤去し、注入された X-Tenant-ID + X-User-ID/Email/Role
 * を信頼する dumb backend になった。よって R2 binding が要るため /api/proxy を経由できない
 * server route (Y時間 export / vehicle-settings unconfirmed) も、自前で auth-worker
 * introspect を呼んで **検証済み** identity を組み立ててから forward する必要がある。
 * client が送ってきた生の Authorization / X-Tenant-ID をそのまま forward しない
 * (信頼境界を Worker 側に寄せる)。
 *
 * introspect は AUTH_WORKER service binding (worker-to-worker, in-process) があれば
 * それを使い、無ければ公開 HTTP に fallback する。
 */
import type { H3Event } from 'h3'
import { getCookie, getHeader, getRequestURL, createError } from 'h3'
import { introspectToken, buildIdentityHeaders } from '@ippoan/auth-client/server'

const DEFAULT_COOKIE_NAME = 'logi_auth_token'

function cfEnv(event: H3Event): Record<string, unknown> {
  return (event.context.cloudflare as { env?: Record<string, unknown> } | undefined)?.env ?? {}
}

async function resolveSecret(binding: unknown): Promise<string | null> {
  if (typeof binding === 'string') return binding
  if (binding && typeof (binding as { get?: unknown }).get === 'function') {
    return (await (binding as { get(): Promise<string> }).get()) ?? null
  }
  return null
}

function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m ? m[1] : undefined
}

/**
 * cookie / Bearer の browser JWT を auth-worker introspect で検証し、
 * 検証済み identity から `X-Tenant-ID` + `X-User-*` ヘッダーを組み立てて返す。
 * inactive / secret 未設定は createError を throw する。
 */
export async function resolveIdentityHeaders(event: H3Event): Promise<Record<string, string>> {
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

  const token =
    getCookie(event, DEFAULT_COOKIE_NAME) ?? bearerToken(getHeader(event, 'authorization'))

  const result = await introspectToken({
    authWorkerUrl,
    sharedSecret,
    token: token ?? '',
    origin: getRequestURL(event).origin,
    fetchImpl: authWorker ? authWorker.fetch.bind(authWorker) : undefined,
  })
  if (!result.active) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  return buildIdentityHeaders(result)
}
