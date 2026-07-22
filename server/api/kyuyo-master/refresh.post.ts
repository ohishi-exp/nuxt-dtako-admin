/**
 * 会社×年度リストの差分更新 (Refs #369)。
 *
 * rust の高速一覧 `GET /api/kyuyo/databases` (sys.databases 名前のみ・ミリ秒、
 * rust-ichibanboshi#91) を JWT pass-through で取得し、D1 `kyuyo_companies` と
 * 突き合わせて増減分だけ upsert する。会社名・権限チェックはここでは扱わない
 * (refresh-full.post の仕事)。
 *
 * 認可は upstream の introspect + allowlist が担う — 401/403 はそのまま返る。
 */
import { defineEventHandler, getHeader, createError } from 'h3'
import { fetchIchiban, cfEnv, type IchibanUpstreamError } from '../../utils/ichiban-upstream'
import { getKyuyoDb, listKyuyoCompanies, upsertKyuyoCompany } from '../../utils/kyuyo-master-db'

/** `KYDATA{会社4桁}_{年度3桁}C` → { company, year } (年 = 1900 + 年度3桁)。 */
function parseKydataName(name: string): { company: string, year: number } | null {
  const matched = /^KYDATA(\d{4})_(\d{3})C$/.exec(name)
  if (!matched) return null
  return { company: matched[1]!, year: 1900 + Number(matched[2]) }
}

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
    upstreamRes = await fetchIchiban(cfEnv(event), 'api/kyuyo/databases', '', { Authorization: authorization })
  }
  catch (e: unknown) {
    const err = e as IchibanUpstreamError
    throw createError({ statusCode: err.statusCode, statusMessage: err.message })
  }
  if (!upstreamRes.ok) {
    const body = await upstreamRes.text()
    throw createError({ statusCode: upstreamRes.status, statusMessage: `upstream: ${body.slice(0, 200)}` })
  }

  const payload = (await upstreamRes.json()) as { databases?: unknown }
  const names = Array.isArray(payload.databases)
    ? payload.databases.filter((n): n is string => typeof n === 'string')
    : []

  // 名前一覧 → 会社ごとの年度集合
  const fresh = new Map<string, number[]>()
  for (const name of names) {
    const parsed = parseKydataName(name)
    if (!parsed) continue
    const years = fresh.get(parsed.company) ?? []
    years.push(parsed.year)
    fresh.set(parsed.company, years)
  }

  const current = await listKyuyoCompanies(db)
  const currentByCompany = new Map(current.map(row => [row.company, row]))
  const now = new Date().toISOString()

  const added: string[] = []
  const updated: string[] = []
  let unchanged = 0
  for (const [company, yearsRaw] of fresh) {
    const years = [...new Set(yearsRaw)].sort((a, b) => a - b)
    const existing = currentByCompany.get(company)
    if (!existing) {
      // 新出の会社は name 空で登録 (フル更新で埋める)
      await upsertKyuyoCompany(db, company, null, years, now)
      added.push(company)
    }
    else if (JSON.stringify(existing.years) !== JSON.stringify(years)) {
      await upsertKyuyoCompany(db, company, null, years, now)
      updated.push(company)
    }
    else {
      unchanged++
    }
  }
  // D1 にあるが upstream から消えた会社 (DB ごと削除された等) は消さずに報告のみ
  const missing = current.map(row => row.company).filter(company => !fresh.has(company))

  return {
    added,
    updated,
    unchanged,
    missing,
    companies: await listKyuyoCompanies(db),
  }
})
