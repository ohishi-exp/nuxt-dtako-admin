/**
 * REST API プロキシ
 * /api/proxy/* → auth-worker /alc-proxy/* → rust-alc-api の /api/*
 *
 * #434 step 3 (方式 B): introspect / ACL / OIDC mint / identity 注入を
 * auth-worker `/alc-proxy/*` に集約し、consumer は createAuthWorkerProxyHandler で
 * service binding (AUTH_WORKER) に thin-forward するだけ。旧 createIdentityProxyHandler
 * (方式 A) を置換。consumer は X-Alc-Proxy-Secret (=INTERNAL_SHARED_SECRET、consumer
 * proof) + X-Alc-Proxy-Origin + browser JWT のみ。auth-worker (#308) が
 * X-Alc-Proxy-Secret を constant-time 検証してから JWT 検証 + ACL + OIDC mint +
 * X-Tenant-ID/X-User-* 注入を行う。AUTH_WORKER は方式 B で必須 (未設定は 503)。
 *
 * pathPrefix='/': client (app/utils/api.ts) は backend と同じ /api/* を apiBase
 * (=/api/proxy) に連結するので catch-all path は api/... になる。'/' + 'api/...' で
 * /api/... に一致し二重 /api を防ぐ。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, createError } from 'h3'
import { createAuthWorkerProxyHandler, parseDevLoginWriteAllowlist } from '@ippoan/auth-client/server'

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
  const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined
  if (!authWorker) {
    throw createError({
      statusCode: 503,
      statusMessage: 'AUTH_WORKER service binding が未設定です',
    })
  }

  const proxy = createAuthWorkerProxyHandler({
    sharedSecret,
    authWorkerFetch: () => authWorker.fetch.bind(authWorker),
    pathPrefix: '/',
    // issue ippoan/auth-worker#423/#425: env.dev (DEV_LOGIN="true") のみ、通常
    // cookie が無い時に logi_auth_token_dev をフォールバックで拾う。他 env は無効。
    devLoginEnabled: env.DEV_LOGIN === 'true',
    // issue ippoan/auth-worker#423: DEV_LOGIN_BACKEND="prod" (AUTH_WORKER
    // binding を prod に向けている印) の時だけ、DEV_LOGIN_PROD_WRITE_ALLOWLIST
    // に無い非GETを auth-client 側で403にする。staging backend (通常運用) は
    // undefined を渡すため無制限のまま (devLoginWriteAllowlist 未指定 = 非破壊)。
    devLoginWriteAllowlist:
      env.DEV_LOGIN === 'true' && env.DEV_LOGIN_BACKEND === 'prod'
        ? parseDevLoginWriteAllowlist(env.DEV_LOGIN_PROD_WRITE_ALLOWLIST)
        : undefined,
  })
  return proxy(event)
})
