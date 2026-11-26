/**
 * カード行の「登録日」を入れる・消す (Refs #1287)。本文 `{registration_date: "YYYY-MM-DD" | null}`
 * (`null` / 空文字で消す = 明細書の受信日に戻す)。
 *
 * relay は**この日 (空なら受信日) より前の走行を、そのカードの利用日にしない**。値が変わったら
 * 確認済みの `run_date` / `unko_no` を消し、`dry_run_ok` / `failed` は `waiting_run` に戻す
 * (古い下限で拾った走行日のまま登録されないように)。同じ値なら何も書かない。
 * status は問わない (要確認の行にも先に入れておける) が、登録済みの行は変えても意味が無いので 409。
 *
 *   200 — 保存した後の行 (`EtcCardView`)
 *   400 — id / 本文の誤り (文は画面にそのまま出す)
 *   404 — 行が無い (他テナントも同じ)
 *   409 — 登録済みの行
 */
import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { etcCardsContext, getRegistration, parseId, toView, updateRegistrationDate } from '../../../utils/etc-scan'
import { parseRegistrationDateInput, type EtcCardView } from '~/utils/etc-cards'

export default defineEventHandler(async (event): Promise<EtcCardView> => {
  const { tenantId, db } = await etcCardsContext(event)
  const id = parseId(getRouterParam(event, 'id'))
  if (id === null) throw createError({ statusCode: 400, statusMessage: 'id が正しくありません' })
  const row = await getRegistration(db, tenantId, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: '行が見つかりません' })
  if (row.status === 'registered') throw createError({ statusCode: 409, statusMessage: '登録済みの行は変えられません' })

  const input = parseRegistrationDateInput(await readBody(event).catch(() => null))
  if (!input.ok) throw createError({ statusCode: 400, statusMessage: 'invalid body', message: input.error, data: { error: input.error } })
  if (input.value === row.registration_date) return toView(row)

  await updateRegistrationDate(db, id, input.value, row.status, new Date().toISOString())
  const after = await getRegistration(db, tenantId, id)
  return toView(after!)
})
