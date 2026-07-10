/**
 * Worker server route から rust-alc-api の internal (共有 secret) 経路を叩く
 * ヘルパー。auth-worker `/alc-internal-proxy/*` (Refs ippoan/auth-worker#362)
 * 経由で OIDC mint を委譲する (email-receiver の `/alc-internal-proxy` 利用と
 * 同じパターン)。
 *
 * `alc-proxy.ts` の `alcProxyFetch` との違い: あちらはブラウザ JWT (cookie /
 * Bearer) を前提にする `/alc-proxy` (data 経路) 用。本ヘルパーは **ブラウザ JWT
 * が無い server-to-server 呼び出し** (nuxt-ichibanboshi からの service
 * binding 呼び出しを本 Worker が中継する場合) 用で、`INTERNAL_SHARED_SECRET`
 * + 明示 `X-Tenant-ID` のみで認証する (`/alc-internal-proxy` の
 * `shared-secret` クラス allowlist 経路、ohishi-exp/nuxt-dtako-admin#198
 * Phase 8)。
 */
import type { H3Event } from 'h3'
import { createError } from 'h3'

const ROUTE_PREFIX = '/alc-internal-proxy'

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

export interface AlcInternalProxyFetchOptions {
  /** rust-alc-api 側の path。先頭 `/` 込みで渡す (例 `/api/internal/operations`) */
  path: string
  /** HTTP method (default 'GET') */
  method?: string
  /** query string。値は String 化して付与。undefined / null は無視 */
  query?: Record<string, string | number | undefined | null>
  /** 転送先テナント (`X-Tenant-ID`)。呼び出し元が明示する (ブラウザ JWT が無いため) */
  tenantId: string
}

/**
 * auth-worker `/alc-internal-proxy` 経由で rust-alc-api の internal (共有
 * secret) 経路を叩き、Response をそのまま返す。
 *
 * - `INTERNAL_SHARED_SECRET` binding 未設定は 503 を throw。
 * - 認証失敗 (401/403 等) は upstream の Response がそのまま返るので、
 *   呼び出し側が `res.ok` を見てハンドリングする。
 */
export async function alcInternalProxyFetch(
  event: H3Event,
  opts: AlcInternalProxyFetchOptions,
): Promise<Response> {
  const env = cfEnv(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({
      statusCode: 503,
      statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です',
    })
  }

  const authWorker = env.AUTH_WORKER as { fetch: typeof fetch } | undefined
  const authWorkerUrl =
    typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  const base = authWorker ? 'https://alc-internal-proxy.internal' : authWorkerUrl.replace(/\/$/, '')
  const fetchImpl = authWorker ? authWorker.fetch.bind(authWorker) : fetch

  const url = new URL(`${base}${ROUTE_PREFIX}${opts.path}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
  }

  return fetchImpl(url.toString(), {
    method: opts.method ?? 'GET',
    headers: {
      'X-Alc-Proxy-Secret': sharedSecret,
      'X-Tenant-ID': opts.tenantId,
    },
  })
}
