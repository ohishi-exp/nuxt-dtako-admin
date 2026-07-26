/**
 * 給与DB取得 (/kyuyo-fetch) の純粋ロジック (Refs #369)。
 *
 * - 会社 (複数) × 月範囲 (from〜to) の取得プラン展開
 * - 取得済み給与明細の sessionStorage キー規則と、セッション所有者 (JWT sub) が
 *   変わった時の purge 判定 — タブを閉じれば消える + 別ユーザーには引き継がない
 *
 * fetch / sessionStorage 操作はページ側の責務 — ここは判定と変換のみ。
 */
import type { ParsedSalaryCsv, SalaryCsvRow } from './salary-compare'

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

// ── 給与比較への橋渡し (Refs #369 PR-B2) ─────────────────────

/**
 * `/api/kyuyo/payroll` の 1 行 (rust-ichibanboshi#94 以降)。
 *
 * **`payments` と `deductions` は分かれている** — 以前の `amounts` は支給と控除が
 * 混在しており、そのまま給与比較へ流すと健康保険料・所得税が支給項目として
 * 集計され支給合計が過大になった (Refs rust-ichibanboshi#93)。
 */
export interface KyuyoPayrollRow {
  /** 社員番号 (原文、前ゼロあり)。 */
  employee_code: string
  /** 前ゼロ除去済みの突合キー。 */
  employee_code_key: string
  employee_name: string
  /** 支給日 ("YYYY-MM-DD")。給与明細 CSV の「給与・賞与名」の年月に相当する。 */
  pay_date: string
  /** **支給**項目名 → 金額 (円)。 */
  payments: Record<string, number>
  /**
   * **勤怠**項目名 → 値 (出勤日数・公休日数・有休日数・欠勤日数・残業時間 等、
   * rust-ichibanboshi#104)。単位は項目ごとに違う (日 / 時間 / 回)。
   *
   * **optional** — この項目を返さない版の rust-ichibanboshi が動いている環境でも
   * 取り込みを成功させるため (デプロイ順に依存しない)。
   */
  attendance?: Record<string, number>
  /** 基本単価 (日額)。取れなければ null。 */
  base_rate: number | null
  /** 残業単価 (時給)。取れなければ null。 */
  overtime_rate: number | null
  /** `SHUKEI1` の計算済み合計。無い月は null。 */
  totals: { soshikyu: number } | null
}

const PAY_DATE_RE = /^(\d{4})-(\d{2})-\d{2}$/

/**
 * 給与DB の取得結果を給与比較の `ParsedSalaryCsv` 形へ変換する (Refs #369 PR-B2)。
 *
 * 貼り付け CSV と同じ形に寄せることで、突合・比較計算 (`compareSalaryMonth`) を
 * 一切変更せずに DB 由来のデータを流せる。
 *
 * - **`company` は給与大臣の会社コード** — 社員マスタの突合キーと同じ体系
 *   (Refs #405。CONAME1 は表記揺れするうえ payroll 応答に無い)
 * - **月は `pay_date` から採る** (支給月)。給与比較は「勤務月の翌月に支給」で
 *   突合するため、賃金期間ではなく支給日が正しい
 * - **控除は載せない** — API が `payments` / `deductions` を分けているので支給だけ使う
 * - 支給項目が 1 つも無い行 (全額 0 等) と `pay_date` が壊れた行は落として warning
 */
export function payrollToParsedSalary(
  rows: KyuyoPayrollRow[],
  company: string,
): ParsedSalaryCsv {
  const warnings: string[] = []
  const itemLabels: string[] = []
  const seenLabel = new Set<string>()
  const months = new Set<string>()
  const out: SalaryCsvRow[] = []

  for (const row of rows) {
    const matched = PAY_DATE_RE.exec(row.pay_date)
    if (!matched) {
      warnings.push(`社員 ${row.employee_code}: 支給日が不正なため除外しました (${row.pay_date || '空'})`)
      continue
    }
    const month = `${matched[1]}-${matched[2]}`
    const amounts: Record<string, number> = {}
    for (const [label, amount] of Object.entries(row.payments)) {
      amounts[label] = amount
      if (!seenLabel.has(label)) {
        seenLabel.add(label)
        itemLabels.push(label)
      }
    }
    months.add(month)
    out.push({
      driverCd: row.employee_code,
      cdKey: row.employee_code_key,
      company,
      driverName: row.employee_name,
      month,
      amounts,
      reportedTotal: row.totals?.soshikyu ?? null,
      rates: { base: row.base_rate, overtime: row.overtime_rate },
      // 勤怠日数 (`KINDATA*` 由来、rust-ichibanboshi#104)。項目名は給与明細の
      // 【勤怠】欄の見出しと同じなので、貼り付け CSV 経路と同じキーで引ける。
      // 返さない版の API でも空で通す (Refs #433)
      attendance: row.attendance ?? {},
    })
  }

  return { rows: out, itemLabels, months: [...months].sort(), warnings }
}
