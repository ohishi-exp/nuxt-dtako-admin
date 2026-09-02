/**
 * theearth の乗務員マスタ (F-MMS0320) → alc employees の同期を、cron
 * (JST 7/12/15/17/19 時) を待たずに 1 回走らせる endpoint
 * (Refs ippoan/alc-app-s3#125)。`/scraper` の「dtako」タブが叩く。
 *
 * POST /api/driver-master/run   body `{comp_id?}` (8 桁の数字。省略時は relay 側の
 *   `KINTAI_COMP_ID` フォールバック — dtako-scraper-relay の
 *   `/kintai-relay/restraint-sync` と同じ規則)
 *   200 — relay の応答 JSON をそのまま。現状は 1 社ぶんの単体形
 *         `{ok, comp_id, rows, items, created, updated, skipped:[{code,reason}],
 *         unreadable, theearth_logins, theearth_kicked}` (relay PR #1078)。
 *         **将来、複数 comp を逐次実行する `{results:[{comp_id,status,created,updated,
 *         skipped,error?}]}` 形に変わる予定** (Refs ippoan/alc-app-s3#125 の c125-4)。
 *         この route は relay の応答を reshape せず素通しするので、どちらの形で来ても
 *         そのまま返る — 形の吸収は画面側 (`app/utils/driver-master-run.ts`) が持つ。
 *   400 — comp_id が 8 桁の数字でない、または body が JSON でない
 *   401 — 未ログイン (`requireAuth`)
 *   4xx/5xx — relay の応答をそのまま (status + `relay:` 前置のメッセージ)
 *   503 — SCRAPER_RELAY / INTERNAL_SHARED_SECRET binding 未設定
 *
 * ## なぜ server route を挟むか
 *
 * relay の `POST /kintai-relay/driver-master-run` は `X-Alc-Proxy-Secret`
 * (= `INTERNAL_SHARED_SECRET`) の worker→worker 経路で、ブラウザから直接は叩けない。
 * secret をブラウザに出さないため、Nitro 側で `requireAuth` を通してから service
 * binding で relay を呼ぶ (`netprint/run.post.ts` と同じ形)。定型は
 * `server/utils/scraper-relay.ts` に集約。
 */

import { defineEventHandler, readBody, createError } from 'h3'
import { authorizeScraperRelay, sendToScraperRelay } from '../../utils/scraper-relay'

/** relay の `/kintai-relay/driver-master-run` と同じ comp_id 形式。 */
const COMP_ID_RE = /^\d{8}$/

function describeDriverMasterRunFailure(data: unknown, status: number): string {
  const error = (data as { error?: unknown } | null)?.error
  return typeof error === 'string' && error !== '' ? error : `乗務員マスタ同期に失敗しました (HTTP ${status})`
}

/** body が読めなかったことを表す番兵 (`undefined` は「空 body」と区別が付かない)。 */
const UNREADABLE = Symbol('unreadable-body')

export default defineEventHandler(async (event) => {
  const auth = await authorizeScraperRelay(event)

  // body が JSON でない (readBody が投げる) のは 400 に寄せる。
  const body = await readBody(event).catch(() => UNREADABLE) as unknown
  if (body === UNREADABLE) {
    throw createError({ statusCode: 400, statusMessage: 'body は JSON で指定してください' })
  }
  const record = typeof body === 'object' && body !== null && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
  const rawCompId = record.comp_id
  if (rawCompId !== undefined && rawCompId !== null && typeof rawCompId !== 'string') {
    throw createError({ statusCode: 400, statusMessage: 'comp_id は文字列で指定してください' })
  }
  const compId = typeof rawCompId === 'string' ? rawCompId.trim() : ''
  if (compId !== '' && !COMP_ID_RE.test(compId)) {
    throw createError({ statusCode: 400, statusMessage: 'comp_id は 8 桁の数字で指定してください' })
  }

  return sendToScraperRelay(
    event,
    auth,
    '/kintai-relay/driver-master-run',
    compId === '' ? {} : { comp_id: compId },
    { describeFailure: describeDriverMasterRunFailure },
  )
})
