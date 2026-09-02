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
 * ## なぜ server route を挟むか
 *
 * relay の `POST /kintai-relay/net780-archive` は `X-Alc-Proxy-Secret`
 * (= `INTERNAL_SHARED_SECRET`) の worker→worker 経路で、ブラウザから直接は叩けない。
 * secret をブラウザに出さないため、Nitro 側で `requireAuth` (auth-worker ログイン必須。
 * cookie `logi_auth_token` 優先 + `Authorization: Bearer` 併用) を通してから service
 * binding で relay を呼ぶ。`comp_id` は relay が `KINTAI_COMP_ID` で補完するので送らない。
 * 定型は `server/utils/scraper-relay.ts` に集約。
 *
 * 1 件ごとに theearth を検索してダウンロードするので **1 回 (最大 20 件) で数分かかりうる**。
 * 画面は `NET780_ARCHIVE_BATCH_SIZE` 件ずつ直列に呼び (進捗が動く間隔を短くするため
 * 上限より小さい、Refs #760 の 29)、`results` に載らなかった運行 (`truncated`) を続けて呼ぶ。
 */

import { defineEventHandler, readBody, createError } from 'h3'
import { parseNet780ArchiveBody } from '../../utils/net780-archive'
import { authorizeScraperRelay, sendToScraperRelay } from '../../utils/scraper-relay'

/** relay の非 2xx を 1 行にする。`{error}` が無ければ HTTP 番号だけの定型文。 */
function describeNet780ArchiveFailure(data: unknown, status: number): string {
  const error = (data as { error?: unknown } | null)?.error
  return typeof error === 'string' && error !== '' ? error : `NET780 の取得に失敗しました (HTTP ${status})`
}

export default defineEventHandler(async (event) => {
  const auth = await authorizeScraperRelay(event)

  // body が JSON でない (readBody が投げる) のも 400 に寄せる。
  const body = await readBody(event).catch(() => null)
  const parsed = parseNet780ArchiveBody(body)
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.error })
  }

  return sendToScraperRelay(event, auth, '/kintai-relay/net780-archive', { items: parsed.items }, {
    describeFailure: describeNet780ArchiveFailure,
  })
})
