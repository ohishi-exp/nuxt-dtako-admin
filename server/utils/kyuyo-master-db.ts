/**
 * D1 `kyuyo_companies` (給与大臣の会社×年度リスト、migration 0005) の共有処理
 * (Refs #369)。金額は D1 に入れない — 識別情報のみ (#367 と同方針)。
 *
 * server route (companies.get / refresh.post / refresh-full.post) から使う。
 */
import type { H3Event } from 'h3'

export interface D1PreparedStatementLite {
  bind(...values: unknown[]): D1PreparedStatementLite
  first<T>(): Promise<T | null>
  all<T>(): Promise<{ results: T[] }>
  run(): Promise<unknown>
}
export interface D1DatabaseLite {
  prepare(sql: string): D1PreparedStatementLite
}

export function getKyuyoDb(event: H3Event): D1DatabaseLite | null {
  const ctx = event.context as { cloudflare?: { env?: { DTAKO_DB?: D1DatabaseLite } } }
  return ctx.cloudflare?.env?.DTAKO_DB ?? null
}

/** D1 行 (years は JSON 文字列)。 */
interface KyuyoCompanyD1Row {
  company: string
  name: string
  years: string
  updated_at: string
}

/** API へ返す形 (years はパース済み)。 */
export interface KyuyoCompanyRecord {
  company: string
  name: string
  years: number[]
  updated_at: string
}

function parseYears(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((y): y is number => typeof y === 'number')
  }
  catch {
    // 壊れた JSON は空扱い (フル更新で直る)
  }
  return []
}

/** 全行を company 昇順で読む。テーブル未作成 (migration 0005 未適用) は Error を投げる。 */
export async function listKyuyoCompanies(db: D1DatabaseLite): Promise<KyuyoCompanyRecord[]> {
  const { results } = await db
    .prepare('SELECT company, name, years, updated_at FROM kyuyo_companies ORDER BY company')
    .all<KyuyoCompanyD1Row>()
  return results.map(row => ({
    company: row.company,
    name: row.name,
    years: parseYears(row.years),
    updated_at: row.updated_at,
  }))
}

/** upsert (company 単位)。name は null なら「既存値を維持 (新規行なら空文字)」。
 * INSERT 側は COALESCE で NOT NULL 制約を満たす — null をそのまま挿すと
 * SQLITE_CONSTRAINT_NOTNULL で落ちる (本番 500 の実害、#369)。 */
export async function upsertKyuyoCompany(
  db: D1DatabaseLite,
  company: string,
  name: string | null,
  years: number[],
  updatedAt: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO kyuyo_companies (company, name, years, updated_at) VALUES (?1, COALESCE(?2, \'\'), ?3, ?4) '
      + 'ON CONFLICT(company) DO UPDATE SET '
      + 'name = CASE WHEN ?2 IS NULL THEN kyuyo_companies.name ELSE ?2 END, '
      + 'years = ?3, updated_at = ?4',
    )
    .bind(company, name, JSON.stringify(years), updatedAt)
    .run()
}
