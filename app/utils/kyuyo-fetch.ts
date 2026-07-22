/**
 * 給与DB取得 (/kyuyo-fetch) の純粋ロジック (Refs #369)。
 *
 * - 会社 (複数) × 月範囲 (from〜to) の取得プラン展開
 * - 取得済み給与明細の sessionStorage キー規則と、セッション所有者 (JWT sub) が
 *   変わった時の purge 判定 — タブを閉じれば消える + 別ユーザーには引き継がない
 *
 * fetch / sessionStorage 操作はページ側の責務 — ここは判定と変換のみ。
 */

/** 月範囲の上限 (会社数と掛け算になるため控えめに)。 */
export const MAX_RANGE_MONTHS = 12

/** "YYYY-MM" 同士の from〜to を月の配列に展開する。 */
export function expandMonthRange(
  from: string,
  to: string,
  maxMonths: number = MAX_RANGE_MONTHS,
): { months: string[] } | { error: string } {
  const parse = (s: string): number | null => {
    const matched = /^(\d{4})-(\d{2})$/.exec(s)
    if (!matched) return null
    const month = Number(matched[2])
    if (month < 1 || month > 12) return null
    return Number(matched[1]) * 12 + (month - 1)
  }
  const start = parse(from)
  const end = parse(to)
  if (start == null || end == null) return { error: '月は YYYY-MM で指定してください' }
  if (start > end) return { error: '開始月が終了月より後になっています' }
  if (end - start + 1 > maxMonths) return { error: `一度に取得できるのは ${maxMonths} ヶ月までです` }
  const months: string[] = []
  for (let index = start; index <= end; index++) {
    const year = Math.floor(index / 12)
    const month = (index % 12) + 1
    months.push(`${year}-${String(month).padStart(2, '0')}`)
  }
  return { months }
}

/** 会社×月の取得プラン (会社ごとに月昇順)。 */
export function buildFetchPlan(
  companies: string[],
  months: string[],
): { company: string, month: string }[] {
  return companies.flatMap(company => months.map(month => ({ company, month })))
}

// ── sessionStorage キー規則 ──────────────────────────────────

export const PAYROLL_STORAGE_PREFIX = 'kyuyo-payroll:'
export const SESSION_OWNER_KEY = 'kyuyo-session-owner'

export function payrollStorageKey(company: string, month: string): string {
  return `${PAYROLL_STORAGE_PREFIX}${company}:${month}`
}

export function parsePayrollStorageKey(key: string): { company: string, month: string } | null {
  if (!key.startsWith(PAYROLL_STORAGE_PREFIX)) return null
  const rest = key.slice(PAYROLL_STORAGE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator <= 0 || separator === rest.length - 1) return null
  return { company: rest.slice(0, separator), month: rest.slice(separator + 1) }
}

/**
 * セッション所有者が変わったか (= 取得済みデータを purge すべきか)。
 * 前の所有者が記録されていて、今のユーザー (sub) と違う時だけ true —
 * 別ユーザーに前の人の給与データを見せない。
 */
export function shouldPurgeSession(storedOwner: string | null, currentSub: string | null): boolean {
  return storedOwner != null && storedOwner !== '' && currentSub != null && storedOwner !== currentSub
}

// ── 取得結果の保存形 ─────────────────────────────────────────

/** sessionStorage に保存する 1 件 (会社×月)。rows は payroll 応答そのまま。 */
export interface StoredPayroll {
  database: string
  fetchedAt: string
  rowCount: number
  warningCount: number
  rows: unknown[]
  warnings: string[]
}

/** payroll 応答 → 保存形。応答形式が想定外なら null。 */
export function toStoredPayroll(body: unknown, fetchedAt: string): StoredPayroll | null {
  const rows = (body as { rows?: unknown } | null)?.rows
  const database = (body as { database?: unknown } | null)?.database
  if (!Array.isArray(rows) || typeof database !== 'string') return null
  const warningsRaw = (body as { warnings?: unknown }).warnings
  const warnings = Array.isArray(warningsRaw)
    ? warningsRaw.filter((w): w is string => typeof w === 'string')
    : []
  return {
    database,
    fetchedAt,
    rowCount: rows.length,
    warningCount: warnings.length,
    rows,
    warnings,
  }
}

/** 取得済み一覧の表示行 (会社 → 月 の昇順)。 */
export interface StoredSummary {
  company: string
  month: string
  database: string
  fetchedAt: string
  rowCount: number
  warningCount: number
}

export function summarizeStored(
  entries: { key: string, value: StoredPayroll }[],
): StoredSummary[] {
  return entries
    .flatMap(({ key, value }) => {
      const parsed = parsePayrollStorageKey(key)
      if (!parsed) return []
      return [{
        company: parsed.company,
        month: parsed.month,
        database: value.database,
        fetchedAt: value.fetchedAt,
        rowCount: value.rowCount,
        warningCount: value.warningCount,
      }]
    })
    .sort((a, b) => a.company.localeCompare(b.company) || a.month.localeCompare(b.month))
}
