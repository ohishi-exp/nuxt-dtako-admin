/**
 * 運転日報を かんたんnetprint に登録し、予約番号を LINE WORKS へ通知する処理を、
 * cron (JST 6:30) を待たずに 1 回走らせる endpoint (Refs #874 の 5)。
 * スクレイプ画面 (`/scraper`) の「日報netprint」タブが叩く。
 *
 * POST /api/netprint/run   body `{date?, branch_cd?, channel_id?, recipient_id?, branch_name?, comp_id?}`
 *   (宛先は `channel_id` = トークルーム / `recipient_id` = 個人 の**どちらか一方**、Refs #874 の 10)
 *   200 — relay の応答 JSON をそのまま (`{ok, date, results[]}`。`results[].detail` に
 *         DO の応答本文 = 予約番号を含む JSON が畳まれている)
 *   400 — body の形式不正 (JSON でない / date が YYYY-MM-DD でない /
 *         branch_cd と宛先の片方だけ / channel_id と recipient_id の両方指定)
 *   401 — 未ログイン (`requireAuth`)
 *   4xx/5xx — relay の応答をそのまま (status + `relay:` 前置のメッセージ。
 *         **`data` に relay の応答本文を載せる** ので、一部の営業所だけ失敗した 502 でも
 *         画面が営業所ごとの理由を出せる)
 *   503 — SCRAPER_RELAY / INTERNAL_SHARED_SECRET binding 未設定
 *
 * ## なぜ server route を挟むか
 *
 * relay は 3 env とも `workers_dev = false` かつ公開 routes 無し (service binding 専用)
 * なので、`POST /kintai-relay/netprint-run` に**インターネットからは到達できない**
 * (#874 の「⚠️ 残件」)。放っておくと実行手段が毎朝 6:30 の cron だけになり、実機確認も
 * 運用上の「今すぐ刷り直す」もできない。`X-Alc-Proxy-Secret` (= `INTERNAL_SHARED_SECRET`)
 * をブラウザに出さないため、Nitro 側で `requireAuth` (auth-worker ログイン必須。cookie
 * `logi_auth_token` 優先 + `Authorization: Bearer` 併用) を通してから service binding で
 * relay を呼ぶ (`net780/archive.post.ts` と同じ形)。
 *
 * **応答は同期で、netprint の status poll 完了まで待つので数分かかりうる。**
 */

import type { H3Event } from 'h3'
import { defineEventHandler, readBody, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { parseNetprintRunBody, describeNetprintRunFailure } from '../../utils/netprint-run'

interface FetcherLike {
  fetch(input: string, init?: RequestInit): Promise<Response>
}
interface CloudflareEnv {
  SCRAPER_RELAY?: FetcherLike
  INTERNAL_SHARED_SECRET?: unknown
  NUXT_PUBLIC_AUTH_WORKER_URL?: string
}

function cfEnv(event: H3Event): CloudflareEnv {
  return (event.context.cloudflare as { env?: CloudflareEnv } | undefined)?.env ?? {}
}

/** Secrets Store binding (`.get()`) / 文字列 のいずれでも値を取り出す
 * (`net780/archive.post.ts` と同実装)。 */
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
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  // body が JSON でない (readBody が投げる) のも 400 に寄せる。
  const body = await readBody(event).catch(() => null)
  const parsed = parseNetprintRunBody(body)
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.error })
  }

  const relay = env.SCRAPER_RELAY
  if (!relay) {
    throw createError({ statusCode: 503, statusMessage: 'SCRAPER_RELAY service binding が未設定です' })
  }

  const res = await relay.fetch('https://relay.internal/kintai-relay/netprint-run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Alc-Proxy-Secret': sharedSecret },
    body: JSON.stringify(parsed.body),
  })
  const data = await res.json().catch(() => null) as unknown
  if (!res.ok) {
    throw createError({
      statusCode: res.status,
      statusMessage: `relay: ${describeNetprintRunFailure(data, res.status)}`,
      // 営業所ごとの結果 (成功した営業所の予約番号 / 失敗理由) を画面へ渡す。
      data,
    })
  }
  // 2xx なのに JSON が読めない応答は relay 側の異常 (黙って null を返さない)。
  if (data === null) {
    throw createError({ statusCode: 502, statusMessage: 'relay の応答が JSON ではありません' })
  }
  return data
})
