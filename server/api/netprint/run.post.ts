/**
 * 運転日報を かんたんnetprint に登録し、予約番号を LINE WORKS へ通知する処理を、
 * cron (JST 6:30) を待たずに 1 回走らせる endpoint (Refs #874 の 5)。
 * スクレイプ画面 (`/scraper`) の「日報netprint」タブが叩く。
 *
 * POST /api/netprint/run
 *   body `{date?, branch_cd?, channel_id?, recipient_id?, branch_name?, operation_no?, comp_id?}`
 *   (宛先は `channel_id` = トークルーム / `recipient_id` = 個人 の**どちらか一方**、Refs #874 の 10)
 *   (`operation_no` = 22 桁の運行No。指定するとその**1 運行だけ**、Refs #913)
 *   200 — relay の応答 JSON をそのまま (`{ok, date, results[]}`。`results[].detail` に
 *         DO の応答本文 = 予約番号を含む JSON が畳まれている)
 *   400 — body の形式不正 (JSON でない / date が YYYY-MM-DD でない /
 *         branch_cd と宛先の片方だけ / channel_id と recipient_id の両方指定 /
 *         operation_no が 22 桁数字でない)、または **relay の 400**
 *         (= 指定された運行NO が対象日・営業所に無い。理由は `data.results[].detail`)
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
 * relay を呼ぶ。定型は `server/utils/scraper-relay.ts` に集約 (`net780/archive.post.ts` と
 * 同じ形)。
 *
 * **応答は同期で、netprint の status poll 完了まで待つので数分かかりうる。**
 */

import { defineEventHandler, readBody, createError } from 'h3'
import { parseNetprintRunBody, describeNetprintRunFailure } from '../../utils/netprint-run'
import { authorizeScraperRelay, sendToScraperRelay } from '../../utils/scraper-relay'

export default defineEventHandler(async (event) => {
  const auth = await authorizeScraperRelay(event)

  // body が JSON でない (readBody が投げる) のも 400 に寄せる。
  const body = await readBody(event).catch(() => null)
  const parsed = parseNetprintRunBody(body)
  if (!parsed.ok) {
    throw createError({ statusCode: 400, statusMessage: parsed.error })
  }

  return sendToScraperRelay(event, auth, '/kintai-relay/netprint-run', parsed.body, {
    describeFailure: describeNetprintRunFailure,
  })
})
