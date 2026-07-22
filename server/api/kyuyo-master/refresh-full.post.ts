/**
 * 会社×年度リストのフル更新 (Refs #369)。
 *
 * rust の完全版 `GET /api/kyuyo/companies` (会社名 + HAS_DBACCESS 権限チェック
 * 込み。AUTO_CLOSE の全 DB を開いて回るため**〜10 秒かかる**) を JWT pass-through
 * で取得し、D1 `kyuyo_companies` を上書きする。初回シードと会社名の補完用 —
 * 通常のリスト更新は refresh.post (差分、ミリ秒) を使う。
 */
import { defineEventHandler, getHeader, createError } from 'h3'
import { fetchIchiban, cfEnv, type IchibanUpstreamError } from '../../utils/ichiban-upstream'
import { getKyuyoDb, listKyuyoCompanies, upsertKyuyoCompany } from '../../utils/kyuyo-master-db'

export default defineEventHandler(async (event) => {
  const db = getKyuyoDb(event)
  if (!db) {
    throw createError({ statusCode: 503, statusMessage: 'DTAKO_DB binding が未設定です' })
  }
  const authorization = getHeader(event, 'authorization')
  if (!authorization) {
    throw createError({ statusCode: 401, statusMessage: 'Authorization: Bearer <JWT> が必要です' })
  }

  let upstreamRes: Response
  try {
    upstreamRes = await fetchIchiban(cfEnv(event), 'api/kyuyo/companies', '', { Authorization: authorization })
  }
  catch (e: unknown) {
    const err = e as IchibanUpstreamError
    throw createError({ statusCode: err.statusCode, statusMessage: err.message })
  }
  if (!upstreamRes.ok) {
    const body = await upstreamRes.text()
    throw createError({ statusCode: upstreamRes.status, statusMessage: `upstream: ${body.slice(0, 200)}` })
  }

  const payload = (await upstreamRes.json()) as { companies?: unknown, warnings?: unknown }
  const companies = Array.isArray(payload.companies) ? payload.companies : []
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === 'string')
    : []

  const now = new Date().toISOString()
  try {
    for (const entry of companies) {
      const row = entry as { company?: unknown, name?: unknown, years?: unknown }
      if (typeof row.company !== 'string' || row.company === '') continue
      const years = Array.isArray(row.years)
        ? row.years.filter((y): y is number => typeof y === 'number')
        : []
      const name = typeof row.name === 'string' ? row.name : ''
      await upsertKyuyoCompany(db, row.company, name, years, now)
    }
  }
  catch (e: unknown) {
    throw createError({
      statusCode: 500,
      statusMessage: `kyuyo_companies の更新に失敗: ${e instanceof Error ? e.message : String(e)}`,
    })
  }

  return {
    warnings,
    companies: await listKyuyoCompanies(db),
  }
})
