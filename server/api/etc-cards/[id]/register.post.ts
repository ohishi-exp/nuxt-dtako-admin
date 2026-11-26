/**
 * カード行を「今すぐ登録」する (Refs #1287)。中身は relay (`workers/dtako-scraper-relay`) の
 * `POST /etc-card/register` 本文 `{"id": <number>}` へ SCRAPER_RELAY service binding で転送するだけ
 * (走行日の照合と etc-meisai.jp への登録は relay の担当)。relay の応答は 2xx ならそのまま返し、
 * 非 2xx は status ごと返す (relay にまだ口が無い間は 404 → 画面にエラーとして出る)。
 * 共有秘密のヘッダは relay の他の口と同じ `X-Alc-Proxy-Secret` ({@link sendToScraperRelay})。
 *
 *   404 — 行が無い (他テナントも同じ) / relay の口が無い
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { etcCardsContext, getRegistration, parseId } from '../../../utils/etc-scan'
import { sendToScraperRelay } from '../../../utils/scraper-relay'

export default defineEventHandler(async (event) => {
  const { auth, tenantId, db } = await etcCardsContext(event)
  const id = parseId(getRouterParam(event, 'id'))
  if (id === null) throw createError({ statusCode: 400, statusMessage: 'id が正しくありません' })
  if (!(await getRegistration(db, tenantId, id))) throw createError({ statusCode: 404, statusMessage: '行が見つかりません' })
  return sendToScraperRelay(event, auth, '/etc-card/register', { id }, {
    describeFailure: (data, status) => {
      const err = (data as { error?: unknown } | null)?.error
      return typeof err === 'string' ? `${status} ${err.slice(0, 120)}` : `HTTP ${status}`
    },
  })
})
