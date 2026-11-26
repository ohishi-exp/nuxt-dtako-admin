/**
 * 要確認 (`needs_review`) のカード行の 4 項目を手で直す (Refs #1287)。
 * 本文 `{kubun?, card_number?, vehicle_number?, obu_number?}`。card_number は空なら今の値のまま
 * (画面に全桁を出さないため)。plate4 と status は保存のたびに作り直し、4 項目が揃えば `waiting_run`。
 *
 *   200 — 直した後の行 (`EtcCardView`)
 *   400 — id / 本文の誤り (文は画面にそのまま出す)
 *   404 — 行が無い (他テナントも同じ)
 *   409 — 要確認でない行 / 同じカード番号の行が既にある
 */
import { createError, defineEventHandler, getRouterParam, readBody } from 'h3'
import { etcCardsContext, getRegistration, isUniqueViolation, parseId, toView, updateRegistrationFields } from '../../utils/etc-scan'
import { applyEdit, type EtcCardView } from '~/utils/etc-cards'

export default defineEventHandler(async (event): Promise<EtcCardView> => {
  const { tenantId, db } = await etcCardsContext(event)
  const id = parseId(getRouterParam(event, 'id'))
  if (id === null) throw createError({ statusCode: 400, statusMessage: 'id が正しくありません' })
  const row = await getRegistration(db, tenantId, id)
  if (!row) throw createError({ statusCode: 404, statusMessage: '行が見つかりません' })
  if (row.status !== 'needs_review') throw createError({ statusCode: 409, statusMessage: '要確認の行だけ直せます' })

  const edit = applyEdit(row, await readBody(event).catch(() => null))
  if (!edit.ok) throw createError({ statusCode: 400, statusMessage: 'invalid body', message: edit.error, data: { error: edit.error } })
  try {
    await updateRegistrationFields(db, id, edit.fields, new Date().toISOString())
  }
  catch (e) {
    if (isUniqueViolation(e)) throw createError({ statusCode: 409, statusMessage: '同じカード番号の行が既にあります' })
    throw e
  }
  const after = await getRegistration(db, tenantId, id)
  return toView(after!)
})
