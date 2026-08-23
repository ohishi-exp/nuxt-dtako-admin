/**
 * NET780 のアーカイブが無い運行を relay に取りに行かせて R2 に保存する endpoint
 * (Refs #760 の 27)。粗利タブ (`/profit/margin`) の地図モーダルの
 * 「NET780 を取得 (未取得 N 運行)」が叩く。
 *
 * POST /api/net780/archive   body `{ operationNos: string[] }` (22/23 桁、1〜20 件)
 *   200 — relay の応答 JSON をそのまま (`Net780ArchiveResult`:
 *         `results[].status` = archived / already / not_found / error、
 *         `truncated` / `remaining` は時間切れで処理しきれなかったぶん)
 *   400 — body の形式不正 / 0 件 / 21 件以上 / 運行NO の桁・日時が不正
 *   401 — 未ログイン (`requireAuth`)
 *   4xx/5xx — relay の応答をそのまま (status + `relay:` 前置のメッセージ。
 *         relay 側の口 (#760-26) がまだ無ければ relay の 404 がそのまま出る)
 *   503 — SCRAPER_RELAY / INTERNAL_SHARED_SECRET binding 未設定
 *
 * ## なぜ server route を挟むか (`operations/[unko]/csvdata-zip.get.ts` と同じ)
 *
 * relay の `POST /kintai-relay/net780-archive` は `X-Alc-Proxy-Secret`
 * (= `INTERNAL_SHARED_SECRET`) の worker→worker 経路で、ブラウザから直接は叩けない。
 * secret をブラウザに出さないため、Nitro 側で `requireAuth` (auth-worker ログイン必須。
 * cookie `logi_auth_token` 優先 + `Authorization: Bearer` 併用) を通してから service
 * binding で relay を呼ぶ。`comp_id` は relay が `KINTAI_COMP_ID` で補完するので送らない。
 *
 * 1 件ごとに theearth を検索してダウンロードするので **1 回 (最大 20 件) で数分かかりうる**。
 * 画面は 20 件ずつ直列に呼び、`results` に載らなかった運行 (`truncated`) を続けて呼ぶ。
 */

import type { H3Event } from 'h3'
import { defineEventHandler, readBody, createError } from 'h3'
import { requireAuth } from '@ippoan/auth-client/server'
import { parseNet780ArchiveBody } from '../../utils/net780-archive'

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
 * (`etc-csv/download.get.ts` と同実装)。 */
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
  const parsed = parseNet780ArchiveBody(body)
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.error })
  }

  const relay = env.SCRAPER_RELAY
  if (!relay) {
    throw createError({ statusCode: 503, statusMessage: 'SCRAPER_RELAY service binding が未設定です' })
  }

  const res = await relay.fetch('https://relay.internal/kintai-relay/net780-archive', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Alc-Proxy-Secret': sharedSecret },
    body: JSON.stringify({ items: parsed.items }),
  })
  const data = await res.json().catch(() => null) as { error?: string } | null
  if (!res.ok) {
    throw createError({
      statusCode: res.status,
      statusMessage: `relay: ${data?.error ?? `NET780 の取得に失敗しました (HTTP ${res.status})`}`,
    })
  }
  // 2xx なのに JSON が読めない応答は relay 側の異常 (黙って null を返さない)。
  if (data === null) {
    throw createError({ statusCode: 502, statusMessage: 'relay の応答が JSON ではありません' })
  }
  return data
})
