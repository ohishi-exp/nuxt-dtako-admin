/**
 * 「ETC アカウントを取り直す」(Refs #1287)。relay (`workers/dtako-scraper-relay`) の `POST /kintai-relay/etc-run`
 * — ETC 明細 CSV の取得を cron (JST 6,7,8,9 時) と**同じ道**で 1 回走らせる口 — へ SCRAPER_RELAY service
 * binding で転送するだけ。新しい口は作らない (cron と別経路を作らない方針。relay `index.ts` の `handleEtcRun` の doc)。
 * そのログインで各アカウントの法人/個人の種別とログイン後のパスが relay に記録され、
 * 「今すぐ登録」の担当判定に使われる。relay は各アカウントを 202 で受けて裏で回すので、
 * 応答の時点ではログインはまだ終わっていない。
 *
 * ★ relay の応答 (`{results:[{kind,target,ok,detail}]}`) は `target` / `detail` に user_id の全桁を持つので
 * そのまま返さず、件数 `{ total, ok }` だけを返す。失敗 (全滅の 502 等) も relay の本文を `data` に
 * 載せたまま投げない (`sendToScraperRelay` は本文を `data` に入れるので、ここで詰め直す)。
 */
import { createError, defineEventHandler } from 'h3'
import { etcCardsContext } from '../../utils/etc-scan'
import { sendToScraperRelay } from '../../utils/scraper-relay'

export interface EtcAccountsRecheckResponse {
  /** relay が転送したアカウント数 */
  total: number
  /** そのうち受け付けられた数 */
  ok: number
}

function countResults(data: unknown): EtcAccountsRecheckResponse {
  const results = (data as { results?: unknown } | null)?.results
  const list = Array.isArray(results) ? results : []
  return { total: list.length, ok: list.filter(r => (r as { ok?: unknown } | null)?.ok === true).length }
}

export default defineEventHandler(async (event): Promise<EtcAccountsRecheckResponse> => {
  const { auth } = await etcCardsContext(event)
  let data: unknown
  try {
    data = await sendToScraperRelay(event, auth, '/kintai-relay/etc-run', {})
  }
  catch (e) {
    // relay の非 2xx だけ詰め直す (binding 未設定の 503 等、data を持たない例外はそのまま)
    const err = e as { statusCode?: unknown, data?: unknown }
    if (typeof err.statusCode !== 'number' || err.data === undefined) throw e
    const counts = countResults(err.data)
    const relayError = (err.data as { error?: unknown } | null)?.error
    const message = counts.total > 0
      ? `relay: ${counts.total} 件中 ${counts.ok} 件しか受け付けられませんでした`
      : `relay: ${typeof relayError === 'string' ? relayError.slice(0, 120) : `HTTP ${err.statusCode}`}`
    throw createError({ statusCode: err.statusCode, statusMessage: 'relay etc-run failed', message, data: counts })
  }
  return countResults(data)
})
