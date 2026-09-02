/**
 * server route から dtako-scraper-relay (`workers/dtako-scraper-relay`) を呼ぶ定型を
 * 1 本に集約するヘルパ (Refs ippoan/alc-app-s3#125 の c125-5)。
 *
 * relay は 3 env とも `workers_dev = false` かつ公開 routes 無し (service binding 専用)
 * なので、ブラウザから直接は届かない。secret (`X-Alc-Proxy-Secret` = `INTERNAL_SHARED_SECRET`)
 * をブラウザに出さないため、Nitro 側で `requireAuth` (auth-worker ログイン必須。cookie
 * `logi_auth_token` 優先 + `Authorization: Bearer` 併用) → `assertAllowedRole`
 * (admin/payroll のみ) を通してから service binding で relay を呼ぶ。
 *
 * `server/api/netprint/run.post.ts` / `netprint/targets.get.ts` / `netprint/targets.put.ts` /
 * `net780/archive.post.ts` の 4 route が個別に持っていた同型コピー (cfEnv → resolveSecret →
 * 503 → requireAuth → assertAllowedRole → body 検証 (route ごとに規則が違う) →
 * SCRAPER_RELAY 未設定 503 → relay.fetch → json parse → 非 2xx は `relay:` 前置で
 * createError → 2xx なのに JSON でなければ 502) を、ここへ寄せる。
 *
 * ## なぜ 1 関数ではなく 2 段に分けたか
 *
 * 4 route とも「body の検証 (400)」は **`assertAllowedRole` の後・`SCRAPER_RELAY` 未設定
 * チェックの前** に挟まる (route ごとに検証規則が違うので、ここでは持てない)。1 関数に
 * 畳むと body 検証を auth の前後どちらに置くか選ぶことになり、どちらを選んでも元の
 * route と実行順が変わる。**未ログイン + 不正な body の組み合わせが 400 と 401 の
 * どちらになるかが route ごとに変わるのは避けたい** (fail-closed の前提を route 側の
 * 書き方に依存させないため) ので、{@link authorizeScraperRelay} (secret → auth → role)
 * と {@link sendToScraperRelay} (SCRAPER_RELAY 未設定 → fetch → 応答の pass-through)
 * の 2 段に分け、呼び出し側はその間で body を読み検証する。
 */

import { createError } from 'h3'
import type { H3Event } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { assertAllowedRole } from './require-role'
import { cfEnv, resolveSecret } from './cf-env'

interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>
}
interface ScraperRelayEnv {
  SCRAPER_RELAY?: FetcherLike
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

/** {@link authorizeScraperRelay} の戻り値。secret を {@link sendToScraperRelay} へ運ぶだけ。 */
export interface ScraperRelayAuth {
  readonly sharedSecret: string
}

/**
 * secret 解決 → `requireAuth` → `assertAllowedRole` まで。
 * `INTERNAL_SHARED_SECRET` 未設定は 503、未ログインは `requireAuth` の例外がそのまま
 * 伝播 (通常 401)、role 不許可は 403。通れば {@link sendToScraperRelay} に渡す
 * `sharedSecret` を返す。
 */
export async function authorizeScraperRelay(event: H3Event): Promise<ScraperRelayAuth> {
  const env = cfEnv<ScraperRelayEnv>(event)
  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })
  assertAllowedRole(auth)
  return { sharedSecret }
}

export interface CallScraperRelayOptions {
  /** 既定 `POST`。`GET` は body を送らない (`content-type` ヘッダも付けない)。 */
  method?: 'GET' | 'POST' | 'PUT'
  /**
   * 非 2xx の relay 応答から `relay:` の後ろに続ける 1 行を組み立てる。
   * 省略時は `HTTP {status}`。
   */
  describeFailure?: (data: unknown, status: number) => string
}

/**
 * {@link authorizeScraperRelay} の後で、検証済みの body を relay へ送る。
 *
 * `SCRAPER_RELAY` service binding 未設定は 503。非 2xx は `createError` で投げる
 * (`statusCode` = relay の status、`statusMessage` = `relay: <describeFailure の 1 行>`、
 * `data` = relay の応答本文 — 呼び出し側が使わなければ無視されるだけ)。2xx なのに
 * JSON が読めない応答は 502 (relay 側の異常を黙って null として返さない)。
 *
 * `path` は relay 側の固定 route 文字列のみを想定する (`/kintai-relay/...` のリテラル)。
 * 呼び出し元が組み立てた変数をそのまま渡す口にしない — 任意 path への到達点を作らないため。
 */
export async function sendToScraperRelay(
  event: H3Event,
  auth: ScraperRelayAuth,
  path: string,
  body: unknown,
  opts: CallScraperRelayOptions = {},
): Promise<unknown> {
  const env = cfEnv<ScraperRelayEnv>(event)
  if (!env.SCRAPER_RELAY) {
    throw createError({ statusCode: 503, statusMessage: 'SCRAPER_RELAY service binding が未設定です' })
  }

  const method = opts.method ?? 'POST'
  const headers: Record<string, string> = { 'X-Alc-Proxy-Secret': auth.sharedSecret }
  const init: RequestInit = { method, headers }
  if (method !== 'GET') {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const res = await env.SCRAPER_RELAY.fetch(`https://relay.internal${path}`, init)
  const data = await res.json().catch(() => null) as unknown
  if (!res.ok) {
    const reason = opts.describeFailure?.(data, res.status) ?? `HTTP ${res.status}`
    throw createError({ statusCode: res.status, statusMessage: `relay: ${reason}`, data })
  }
  if (data === null) {
    throw createError({ statusCode: 502, statusMessage: 'relay の応答が JSON ではありません' })
  }
  return data
}
