/**
 * 乗務員マスタ同期 (theearth → alc employees) が**最後に走った記録**を、会社ごとに読む endpoint
 * (Refs #1186)。`/scraper` の「乗務員マスタ同期」の欄が叩く。定時の同期 (cron) が走ったか・
 * 成功したかを、画面から見られるようにするためのもの。**読むだけ** (同期は走らせない)。
 *
 * GET /api/driver-master/status   (query は読まない。いつも全社ぶん)
 *   200 — `{results: [{comp_id, last, error}]}`
 *         - `last`: 直近 1 回の記録 `{trigger: 'cron' | 'manual' | null, finished_at, ok, error}`。
 *           まだ 1 回も走っていなければ `null`
 *         - `error`: その会社の記録を読めなかったか (真偽だけ。理由の文は返さない)
 *   401 — 未ログイン (`requireAuth`)
 *   4xx/5xx — relay の応答をそのまま (status + `relay:` 前置のメッセージ)
 *   502 — relay の応答を読めない (JSON でない・`results` が配列でない)
 *   503 — SCRAPER_RELAY / INTERNAL_SHARED_SECRET binding 未設定
 *
 * relay の `POST /kintai-relay/driver-master-status` は、記録の全部の欄 (件数など) を返す。
 * 画面が使うのは上の 4 つだけなので、**ここで絞って返す** (余分な欄をブラウザへ出さない)。
 * 認可と relay の呼び方の定型は `server/utils/scraper-relay.ts` (同期ボタンの `run.post.ts` と同じ)。
 */

import { createError, defineEventHandler } from 'h3'
import { authorizeScraperRelay, sendToScraperRelay } from '../../utils/scraper-relay'

function describeDriverMasterStatusFailure(data: unknown, status: number): string {
  const error = (data as { error?: unknown } | null)?.error
  return typeof error === 'string' && error !== '' ? error : `乗務員マスタ同期の記録を取得できませんでした (HTTP ${status})`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 直近 1 回の記録から、画面が使う 4 つだけを取り出す。記録が無い (object でない) なら null。 */
function pickLastRun(value: unknown) {
  const last = asRecord(value)
  if (last === null) return null
  return {
    trigger: last.trigger === 'cron' || last.trigger === 'manual' ? last.trigger : null,
    finished_at: typeof last.finished_at === 'string' ? last.finished_at : '',
    ok: last.ok === true,
    error: typeof last.error === 'string' && last.error !== '' ? last.error : null,
  }
}

export default defineEventHandler(async (event) => {
  const auth = await authorizeScraperRelay(event)
  const data = await sendToScraperRelay(event, auth, '/kintai-relay/driver-master-status', {}, {
    describeFailure: describeDriverMasterStatusFailure,
  })

  const results = asRecord(data)?.results
  if (!Array.isArray(results)) {
    throw createError({ statusCode: 502, statusMessage: 'relay の応答を読めません' })
  }
  return {
    results: results.flatMap((raw) => {
      const item = asRecord(raw)
      if (item === null || typeof item.comp_id !== 'string' || item.comp_id === '') return []
      return [{ comp_id: item.comp_id, last: pickLastRun(item.last), error: 'error' in item && item.error != null }]
    }),
  }
})
