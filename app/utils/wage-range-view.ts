/**
 * 期間集計タブの表示ロジック (Refs #677 PR-E)。
 *
 * `GET /api/kyuyo/wage-range` (ohishi-exp/rust-ichibanboshi#292) が返す
 * 「乗務員 × 月の確定値」を、画面の形に組み替える:
 *
 *   1 行 = 1 乗務員。**月ごとの差を横に並べ**、右端に**期間合計 (計算額 / 給与支払額 /
 *   差合計)** を置く。並び (会社 → 職員区分 → 営業所 → 乗務員CD) と 3 段
 *   (基本給 / 残業代 / 合計) は単月の最低賃金チェックのまま。
 *
 * ## 差はここで出す (サーバも DB も持たない)
 *
 * `paid - calc`。単月表の `minWageCompareRow` と**同じ向き** (給与 − 計算) で、
 * マイナス = 支払いが換算理論値を下回っている。片側が無ければ null (「-」)。
 *
 * ## 集計に入らなかった月は 0 ではなく `—`
 *
 * 欠測・単価未設定・給与未取込・未保存はすべて「その月の値が無い」であって
 * 「0 円だった」ではない。0 と見分けが付く表示にしないと、支払い不足の見落としになる。
 */

import type { MinWageRowAttrs } from './restraint-wage-view'

/** 月ごとの状態 (カバレッジバー)。 */
export interface WageRangeMonth {
  ym: string
  saved: boolean
  drivers: number
  computedAt: string | null
  /** 版を渡していない時は null (判定していない)。 */
  stale: boolean | null
  staleReason: string[]
  /** 集計から外した理由 (`"payroll_missing"` 等)。入っていれば合計に寄与しない。 */
  excluded: string | null
}

/** 乗務員 × 月の金額。 */
export interface WageRangeAmounts {
  calcBase: number | null
  calcOvertime: number | null
  calcTotal: number | null
  paidBase: number | null
  paidOvertime: number | null
  hourlyRate: number | null
}

/** 期間集計の 1 行。 */
export interface WageRangeRow {
  driverCd: string
  driverName: string
  attrs: MinWageRowAttrs
  monthsCounted: number
  monthsMissing: string[]
  byMonth: Record<string, WageRangeAmounts>
  calcBase: number
  calcOvertime: number
  calcTotal: number
  paidBase: number
  paidOvertime: number
  workingMinutes: number
}

export interface WageRangeResponse {
  from: string
  to: string
  restraintSource: string
  months: WageRangeMonth[]
  rows: WageRangeRow[]
}

/** 3 段の差 (基本給 / 残業代 / 合計)。片側が無ければ null。 */
export interface WageDiff3 {
  base: number | null
  overtime: number | null
  total: number | null
}

const NULL_DIFF: WageDiff3 = { base: null, overtime: null, total: null }

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function int(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** `wage-range` の応答を画面の形にする。壊れていても**落ちない** (空で返す)。 */
export function parseWageRange(body: unknown): WageRangeResponse {
  const b = (body ?? {}) as Record<string, unknown>
  const monthsRaw = Array.isArray(b.months) ? b.months : []
  const rowsRaw = Array.isArray(b.rows) ? b.rows : []
  return {
    from: str(b.from),
    to: str(b.to),
    restraintSource: str(b.restraint_source) || 'gcp',
    months: monthsRaw.map((m) => {
      const r = (m ?? {}) as Record<string, unknown>
      return {
        ym: str(r.ym),
        saved: r.saved === true,
        drivers: int(r.drivers),
        computedAt: strOrNull(r.computed_at),
        stale: typeof r.stale === 'boolean' ? r.stale : null,
        staleReason: Array.isArray(r.stale_reason)
          ? r.stale_reason.filter((x): x is string => typeof x === 'string')
          : [],
        excluded: strOrNull(r.excluded),
      }
    }),
    rows: rowsRaw.map((row) => {
      const r = (row ?? {}) as Record<string, unknown>
      const byMonthRaw = (r.by_month ?? {}) as Record<string, unknown>
      const byMonth: Record<string, WageRangeAmounts> = {}
      for (const [ym, v] of Object.entries(byMonthRaw)) {
        const a = (v ?? {}) as Record<string, unknown>
        byMonth[ym] = {
          calcBase: num(a.calc_base),
          calcOvertime: num(a.calc_overtime),
          calcTotal: num(a.calc_total),
          paidBase: num(a.paid_base),
          paidOvertime: num(a.paid_overtime),
          hourlyRate: num(a.hourly_rate),
        }
      }
      return {
        driverCd: String(r.driver_cd ?? ''),
        driverName: str(r.driver_name),
        attrs: {
          company: strOrNull(r.company),
          branchCode: num(r.branch_code),
          branchName: strOrNull(r.branch_name),
          jobName: strOrNull(r.job_name),
        },
        monthsCounted: int(r.months_counted),
        monthsMissing: Array.isArray(r.months_missing)
          ? r.months_missing.filter((x): x is string => typeof x === 'string')
          : [],
        byMonth,
        calcBase: int(r.calc_base),
        calcOvertime: int(r.calc_overtime),
        calcTotal: int(r.calc_total),
        paidBase: int(r.paid_base),
        paidOvertime: int(r.paid_overtime),
        workingMinutes: int(r.working_minutes),
      }
    }),
  }
}

/** その月の差 (給与 − 計算)。月が集計に入っていなければ全 null。 */
export function monthDiff(a: WageRangeAmounts | undefined): WageDiff3 {
  if (!a) return NULL_DIFF
  const paidTotal = a.paidBase == null || a.paidOvertime == null
    ? null
    : a.paidBase + a.paidOvertime
  const d = (p: number | null, c: number | null) => (p == null || c == null ? null : p - c)
  return {
    base: d(a.paidBase, a.calcBase),
    overtime: d(a.paidOvertime, a.calcOvertime),
    total: d(paidTotal, a.calcTotal),
  }
}

/**
 * 期間合計の差。**1 か月も集計できていない行は全 null** — 合計 0 と
 * 「集計できなかった」を混同しない。
 */
export function rangeDiff(row: { monthsCounted: number, calcBase: number, calcOvertime: number, calcTotal: number, paidBase: number, paidOvertime: number }): WageDiff3 {
  if (row.monthsCounted === 0) return NULL_DIFF
  return {
    base: row.paidBase - row.calcBase,
    overtime: row.paidOvertime - row.calcOvertime,
    total: row.paidBase + row.paidOvertime - row.calcTotal,
  }
}

/** 区画 (会社 × 職員区分) / 全体の合計。 */
export interface WageRangeTotals {
  drivers: number
  calcBase: number
  calcOvertime: number
  calcTotal: number
  paidBase: number
  paidOvertime: number
  workingMinutes: number
  /** 月ごとの差の合計 (合計段のみ)。集計に入った行が 1 つも無い月は null。 */
  diffByMonth: Record<string, number | null>
  diff: WageDiff3
}

/**
 * 行の合計。月ごとの差は**その月に集計できた行だけ**を足す
 * (集計外を 0 として足すと、欠測の多い月ほど差が小さく見える)。
 */
export function sumWageRangeRows(rows: readonly WageRangeRow[], months: readonly string[]): WageRangeTotals {
  const totals: WageRangeTotals = {
    drivers: rows.length,
    calcBase: 0,
    calcOvertime: 0,
    calcTotal: 0,
    paidBase: 0,
    paidOvertime: 0,
    workingMinutes: 0,
    diffByMonth: {},
    diff: NULL_DIFF,
  }
  let counted = 0
  for (const r of rows) {
    totals.calcBase += r.calcBase
    totals.calcOvertime += r.calcOvertime
    totals.calcTotal += r.calcTotal
    totals.paidBase += r.paidBase
    totals.paidOvertime += r.paidOvertime
    totals.workingMinutes += r.workingMinutes
    counted += r.monthsCounted
  }
  for (const ym of months) {
    let sum: number | null = null
    for (const r of rows) {
      const d = monthDiff(r.byMonth[ym]).total
      if (d == null) continue
      sum = (sum ?? 0) + d
    }
    totals.diffByMonth[ym] = sum
  }
  totals.diff = rangeDiff({ ...totals, monthsCounted: counted })
  return totals
}

/** 月セルの状態 (表示の出し分け)。 */
export type MonthCellState = 'counted' | 'excluded' | 'unsaved' | 'missing'

/**
 * その行 × その月をどう出すか。
 *
 * - `counted` — 集計に入った (差を出す)
 * - `excluded` — 月ごと外れた (給与未取込等)。**行の責任ではない**
 * - `unsaved` — その月がまだ保存されていない
 * - `missing` — 月は集計対象だが、その人だけ欠けた (欠測・単価未設定・給与に無い)
 */
export function monthCellState(
  row: WageRangeRow,
  month: WageRangeMonth | undefined,
): MonthCellState {
  if (!month || !month.saved) return 'unsaved'
  if (month.excluded) return 'excluded'
  return row.byMonth[month.ym] ? 'counted' : 'missing'
}

/** 月カバレッジの短いラベル (バー表示用)。 */
export function monthBadgeLabel(m: WageRangeMonth): string {
  if (!m.saved) return '未保存'
  if (m.excluded === 'payroll_missing') return '給与未取込'
  if (m.excluded) return '集計外'
  if (m.stale) return '要再計算'
  return '保存済'
}

/** 「取得し直すべき月」= 未保存 または 要再計算 (PR-F の対象)。 */
export function monthsNeedingRefresh(months: readonly WageRangeMonth[]): string[] {
  return months.filter(m => !m.saved || m.stale === true).map(m => m.ym)
}

/** CSV (表示している行をそのまま)。月ごとの差 (合計段) + 期間合計 3 ブロック。 */
export function wageRangeCsv(rows: readonly WageRangeRow[], months: readonly string[]): string {
  const head = [
    '乗務員CD', '氏名', '会社', '営業所', '職種', '集計月数',
    ...months.map(m => `${m} 差`),
    '計算 基本給', '計算 残業代', '計算 合計',
    '給与 基本給', '給与 残業代', '給与 合計',
    '差 基本給', '差 残業代', '差 合計',
  ]
  const cell = (v: number | null) => (v == null ? '' : String(v))
  const lines = [head.join(',')]
  for (const r of rows) {
    const d = rangeDiff(r)
    lines.push([
      r.driverCd,
      csvCell(r.driverName),
      csvCell(r.attrs.company ?? ''),
      csvCell(r.attrs.branchName ?? ''),
      csvCell(r.attrs.jobName ?? ''),
      String(r.monthsCounted),
      ...months.map(m => cell(monthDiff(r.byMonth[m]).total)),
      String(r.calcBase), String(r.calcOvertime), String(r.calcTotal),
      String(r.paidBase), String(r.paidOvertime), String(r.paidBase + r.paidOvertime),
      cell(d.base), cell(d.overtime), cell(d.total),
    ].join(','))
  }
  return lines.join('\n')
}

/** カンマ・引用符・改行を含むセルを CSV として安全にする。 */
function csvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * 期間の既定値: **その年の 1 月 〜 選択中の月** (ユーザー決定 2026-08-05)。
 * 選択中の月がその年の 1 月なら 1 月だけ。
 */
export function defaultRange(selectedMonth: string): { from: string, to: string } {
  const year = selectedMonth.slice(0, 4)
  return { from: `${year}-01`, to: selectedMonth }
}
