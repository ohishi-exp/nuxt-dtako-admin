/**
 * OCR に失敗した scan をもう一度 OCR する (Refs #1287)。D1 に残した PDF を auth-worker の
 * RPC `AlcRedactEntrypoint.extractEtcCard` (service binding ALC_REDACT) に渡し、読めた行を足す。
 * 失敗した scan だけが対象 (成功済みをやり直すと、要確認の行が二重にできるため)。
 *
 *   200 — `{ok: true, row_count, inserted}` / OCR がまた失敗したら `{ok: false, error}`
 *   400 — sha256 の形が違う
 *   404 — scan が無い (他テナントも同じ)
 *   409 — OCR が既に成功している
 *   503 — ALC_REDACT 未設定
 */
import { createError, defineEventHandler, getRouterParam } from 'h3'
import { cfEnv } from '../../../../utils/cf-env'
import { blobToBytes, etcCardsContext, getScan, isSha256Hex, runOcr, shaPrefix, type AlcRedactRpc } from '../../../../utils/etc-scan'

export default defineEventHandler(async (event) => {
  const { tenantId, db } = await etcCardsContext(event)
  const sha256 = getRouterParam(event, 'sha256')
  if (!isSha256Hex(sha256)) throw createError({ statusCode: 400, statusMessage: 'sha256 が正しくありません' })
  const redact = cfEnv<{ ALC_REDACT?: AlcRedactRpc }>(event).ALC_REDACT
  if (!redact) throw createError({ statusCode: 503, statusMessage: 'ALC_REDACT service binding が未設定です' })

  const scan = await getScan(db, tenantId, sha256)
  if (!scan) throw createError({ statusCode: 404, statusMessage: 'scan が見つかりません' })
  if (scan.ocr_status === 'ok') throw createError({ statusCode: 409, statusMessage: 'OCR は既に済んでいます' })
  const pdf = blobToBytes(scan.pdf)
  if (!pdf) throw createError({ statusCode: 500, statusMessage: 'PDF を読めません' })

  const out = await runOcr(db, redact, sha256, pdf, new Date().toISOString())
  console.log(`etc-scan ocr: ${JSON.stringify({ sha: shaPrefix(sha256), ok: out.ok, rows: out.ok ? out.rowCount : undefined })}`)
  return out.ok ? { ok: true, row_count: out.rowCount, inserted: out.inserted } : { ok: false, error: out.error }
})
