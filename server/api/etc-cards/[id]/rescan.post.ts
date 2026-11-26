/**
 * カード行の「走行日を探し直す」(Refs #1287)。中身は relay (`workers/dtako-scraper-relay`) の
 * `POST /etc-card/rescan` 本文 `{"id": <number>}` へ SCRAPER_RELAY service binding で転送するだけ
 * (theearth から読取日の範囲で運行 zip を取り直し、KUDGSIR.csv で走行日を探すのは relay の担当。
 * alc へは上げない)。relay は 202 で受けて後で回すので、ここも 202 をそのまま返す。
 * 非 2xx は status ごと返す ({@link sendToScraperRelay}。`register.post.ts` と同じ形)。
 *
 *   404 — 行が無い (他テナントも同じ) / 走行待ちでない・下 4 桁が無い (relay) / relay の口が無い
 */
import { createError, defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { etcCardsContext, getRegistration, parseId } from '../../../utils/etc-scan'
import { sendToScraperRelay } from '../../../utils/scraper-relay'

export default defineEventHandler(async (event) => {
  const { auth, tenantId, db } = await etcCardsContext(event)
  const id = parseId(getRouterParam(event, 'id'))
  if (id === null) throw createError({ statusCode: 400, statusMessage: 'id が正しくありません' })
  if (!(await getRegistration(db, tenantId, id))) throw createError({ statusCode: 404, statusMessage: '行が見つかりません' })
  const data = await sendToScraperRelay(event, auth, '/etc-card/rescan', { id }, {
    describeFailure: (body, status) => {
      const err = (body as { error?: unknown } | null)?.error
      return typeof err === 'string' ? `${status} ${err.slice(0, 120)}` : `HTTP ${status}`
    },
  })
  setResponseStatus(event, 202)
  return data
})
