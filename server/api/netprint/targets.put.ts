/**
 * 日報 netprint の通知先設定 (KV `netprint_targets`) を保存する endpoint
 * (Refs #874 の 12)。`/scraper` の「日報netprint」タブが叩く。
 *
 * PUT /api/netprint/targets   body: JSON 配列
 *     `[{branch_cd, channel_id | recipient_id, branch_name?}, ...]` (**全体置き換え**)
 *   200 — relay の応答 (`{ok: true, targets}` = 正規化後に KV へ書いた値)
 *   400 — body が JSON でない / relay の検証に落ちた (理由は relay の文言をそのまま)
 *   401 — 未ログイン (`requireAuth`)
 *   4xx/5xx — relay の応答をそのまま (status + `relay:` 前置のメッセージ)
 *   503 — SCRAPER_RELAY / INTERNAL_SHARED_SECRET binding 未設定
 *
 * **中身の検証は front でしない。** 宛先の排他・Uuid・`branch_cd` 必須は relay の
 * `validateNetprintTargetsPayload` (cron と同じ部品) が正で、ここは body を素通しして
 * relay の 400 の理由を画面へ運ぶだけ。同じ規則を写すと「画面では保存できたのに
 * cron が落とす」設定が作れる。ここで弾くのは **JSON として読めない body だけ**
 * (relay へ渡す形にできないため)。定型は `server/utils/scraper-relay.ts` に集約。
 */

import { defineEventHandler, readBody, createError } from 'h3'
import { describeNetprintTargetsFailure } from '../../utils/netprint-targets'
import { authorizeScraperRelay, sendToScraperRelay } from '../../utils/scraper-relay'

/** body が読めなかったことを表す番兵 (`undefined` は「空 body」と区別が付かない)。 */
const UNREADABLE = Symbol('unreadable-body')

export default defineEventHandler(async (event) => {
  const auth = await authorizeScraperRelay(event)

  const body = await readBody(event).catch(() => UNREADABLE) as unknown
  if (body === UNREADABLE) {
    throw createError({ statusCode: 400, statusMessage: 'body は JSON 配列で指定してください' })
  }

  return sendToScraperRelay(event, auth, '/kintai-relay/netprint-targets', body, {
    method: 'PUT',
    describeFailure: describeNetprintTargetsFailure,
  })
})
