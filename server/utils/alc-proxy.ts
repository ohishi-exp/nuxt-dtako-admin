/**
 * Worker server route から rust-alc-api を叩く時に、auth-worker `/alc-proxy/*` を
 * 経由して OIDC mint を auth-worker に委譲するヘルパ (rust-alc-api#434 step 3 方式 B)。
 *
 * R2 binding が要るため `/api/proxy` (catch-all passthrough) を使えない server route
 * (Y時間 export / vehicle-settings unconfirmed) 用。これらは旧来 introspect 検証済み
 * identity を **rust-alc-api に直叩き** していたが (server/utils/identity.ts、撤去)、
 * Cloud Run IAM lockdown 後は OIDC token を持てず 403 になる。よって backend データ
 * 取得を `/alc-proxy` 経由にし、introspect / ACL / OIDC mint / identity 注入を
 * auth-worker に一本化する (createAuthWorkerProxyHandler と同じ経路。違いは
 * 「passthrough せず Response を受け取りローカルで R2 + xlsx 加工する」点)。
 *
 * consumer proof = `X-Alc-Proxy-Secret` (INTERNAL_SHARED_SECRET)、browser JWT は
 * cookie / Bearer から、ACL 用 origin は `X-Alc-Proxy-Origin`。auth-worker
 * (handlers/alc-proxy.ts) がこれらを検証してから rust-alc-api に forward する。
 *
 * service binding (AUTH_WORKER) があればそれを使い (worker-to-worker, in-process)、
 * 無ければ公開 HTTP (`NUXT_PUBLIC_AUTH_WORKER_URL`) に fallback する。
 *
 * 注: `@ippoan/auth-client/server` の `buildAlcProxyHeaders` は型宣言には在るが
 * runtime export に無く、import すると Nitro の rollup build が MISSING_EXPORT で
 * fail する (identity.ts と同じ罠)。trivial なので依存せず inline する。
 */
import type { H3Event } from 'h3'
import { getCookie, getHeader, getRequestURL, createError } from 'h3'

const DEFAULT_COOKIE_NAME = 'logi_auth_token'
const ROUTE_PREFIX = '/alc-proxy'

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

function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined
  const m = /^Bearer\s+(.+)$/i.exec(authHeader)
  return m ? m[1] : undefined
}

export interface AlcProxyFetchOptions {
  /** rust-alc-api 側の path。先頭 `/` 込みで渡す (例 `/api/dtako/vehicles`) */
  path: string
  /** HTTP method (default 'GET') */
  method?: string
  /** query string。値は String 化して付与。undefined / null は無視 */
  query?: Record<string, string | number | undefined | null>
  /** body (POST/PUT 等)。JSON は呼び出し側で stringify 済みを渡す */
  body?: BodyInit
  /** body の content-type */
  contentType?: string
}

/**
 * auth-worker `/alc-proxy` 経由で rust-alc-api を叩き、Response をそのまま返す。
 *
 * - `INTERNAL_SHARED_SECRET` binding 未設定は 503 を throw (= consumer proof 不能)。
 * - 認証失敗 (401 等) は upstream の Response がそのまま返るので、呼び出し側が
 *   `res.ok` を見てハンドリングする。
 * - browser JWT は cookie (`logi_auth_token`) / `Authorization: Bearer` から拾う。
 */
export async function alcProxyFetch(
  event: H3Event,
  opts: AlcProxyFetchOptions,
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
  // service binding fetch は host を無視するが絶対 URL が要る。public fallback では
  // 実 host が要る。binding 有無で base を切り替える。
  const base = authWorker ? 'https://alc-proxy.internal' : authWorkerUrl.replace(/\/$/, '')
  const fetchImpl = authWorker ? authWorker.fetch.bind(authWorker) : fetch

  const token =
    getCookie(event, DEFAULT_COOKIE_NAME) ?? bearerToken(getHeader(event, 'authorization'))
  const origin = getRequestURL(event).origin

  const url = new URL(`${base}${ROUTE_PREFIX}${opts.path}`)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
    }
  }

  // buildAlcProxyHeaders 相当 (inline)。
  const headers: Record<string, string> = {
    'X-Alc-Proxy-Secret': sharedSecret,
    'X-Alc-Proxy-Origin': origin,
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (opts.contentType) headers['Content-Type'] = opts.contentType

  return fetchImpl(url.toString(), {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body,
  })
}
