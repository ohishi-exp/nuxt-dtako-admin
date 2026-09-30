/**
 * 訴訟準備の「給与比較」タブの pure ロジック。
 *
 * 拘束×賃金の給与比較タブ (`restraint-wage.vue`) と**同じ比較** (`compareSalaryMonth`) を、
 * 案件の乗務員 × 月に並べる。比べるのは給与明細の実支給 (基本給・残業代・総支給) と、
 * 明細の【補助】単価 × システムの勤務日数・時間外で出した額。
 *
 * | 側 | 素材 | 口 |
 * | --- | --- | --- |
 * | 給与明細 | 給与大臣の支給項目 (支給月 = 勤務月の翌月) | `GET /api/kyuyo/payroll?company=&month=<勤務月>` — 保存が無い月は給与大臣から読んで保存する (読み通し) |
 * | 計算 | エラータブで取った wage-report (拘束は GCP、乗務員ぶんに切り出したもの) | `GET /restraint-api/wage-report?source=gcp` (エラータブの「検知を実行」) |
 *
 * **金額と氏名はブラウザに残さない** (拘束×賃金と同じ方針、Refs #467) — 給与明細はメモリだけに持ち、
 * 開き直したら読み直す (保存済みの月は給与大臣を開かずに返るので速い)。
 */
import { nextYm } from './restraint-wage-view'
import type { WageReportResponse, WageReportRow } from './restraint-wage-view'
import { compareSalaryMonth } from './salary-compare'
import type { SalaryCdMap, SalaryComparisonRow, SalaryCsvRow, SalaryItemConfig } from './salary-compare'
import type { LitigationFetched } from './litigation-errors'
import { litigationDriverMonthKey } from './litigation-errors'

export type LitigationSalaryState = 'ok' | 'pending' | 'unknown' | 'noPayroll'

export const LITIGATION_SALARY_STATE_LABELS: Record<LitigationSalaryState, string> = {
  ok: '比較済み',
  pending: '未取得',
  unknown: '比較できない',
  noPayroll: '明細なし',
}

export interface LitigationSalaryRow {
  driverCd: string
  /** 勤務月 `YYYY-MM` */
  month: string
  /** 支給月 `YYYY-MM` (勤務月の翌月) */
  payMonth: string
  state: LitigationSalaryState
  message: string
  /** `state === 'ok'` のときだけ */
  compared: SalaryComparisonRow | null
}

export interface LitigationSalaryInput {
  driverCds: readonly string[]
  /** 勤務月 (古い順) */
  months: readonly string[]
  /** キー `乗務員CD|勤務月` (エラータブの `errWageReports`) */
  wageReports: ReadonlyMap<string, LitigationFetched<WageReportResponse>>
  /** キー 支給月 `YYYY-MM` → その月の給与明細 (全会社ぶんを連結)。失敗はその 1 文 */
  payroll: ReadonlyMap<string, LitigationFetched<SalaryCsvRow[]>>
  config: SalaryItemConfig
  cdMap: SalaryCdMap
}

const sameCd = (a: string, b: string) => String(Number(a)) === String(Number(b))

/** 表の行を作る。並びは乗務員ごと・月の古い順 (エラータブと同じ)。 */
export function buildLitigationSalaryRows(input: LitigationSalaryInput): LitigationSalaryRow[] {
  const byMonth = new Map<string, { rows: SalaryComparisonRow[], conflictCds: string[] } | null>()
  for (const month of input.months) {
    const pay = input.payroll.get(nextYm(month))
    const reportRows: WageReportRow[] = input.driverCds.flatMap((cd) => {
      const w = input.wageReports.get(litigationDriverMonthKey(cd, month))
      return w?.ok ? w.value.rows.filter(r => sameCd(r.summary.driverCd, cd)) : []
    })
    if (!pay?.ok || reportRows.length === 0) {
      byMonth.set(month, null)
      continue
    }
    // 明細の月ラベルは支給日から採る (payrollToParsedSalary) ので、支給月の行だけを使う
    // (拘束×賃金の salaryMonthRows と同じ絞り方。compareSalaryMonth 自身は月を見ない)
    const payMonth = nextYm(month)
    const compared = compareSalaryMonth(pay.value.filter(r => r.month === payMonth), reportRows, input.config, input.cdMap)
    byMonth.set(month, { rows: compared.rows, conflictCds: compared.conflicts.map(c => c.driverCd) })
  }

  const out: LitigationSalaryRow[] = []
  for (const driverCd of input.driverCds) {
    for (const month of input.months) {
      const payMonth = nextYm(month)
      const base = { driverCd, month, payMonth, compared: null }
      const wage = input.wageReports.get(litigationDriverMonthKey(driverCd, month))
      const pay = input.payroll.get(payMonth)
      if (!wage) {
        out.push({ ...base, state: 'pending', message: '拘束の材料が未取得 — エラータブで「検知を実行」' })
        continue
      }
      if (!wage.ok) {
        out.push({ ...base, state: 'unknown', message: `拘束の材料が取れていない: ${wage.reason}` })
        continue
      }
      if (!wage.value.rows.some(r => sameCd(r.summary.driverCd, driverCd))) {
        out.push({ ...base, state: 'unknown', message: 'この月の賃金計算にこの乗務員の行が無い' })
        continue
      }
      if (!pay) {
        out.push({ ...base, state: 'pending', message: '給与明細が未読込 — 「給与大臣から読み込む」' })
        continue
      }
      if (!pay.ok) {
        out.push({ ...base, state: 'unknown', message: `給与明細が読めない: ${pay.reason}` })
        continue
      }
      const m = byMonth.get(month)!
      const hit = m.rows.find(r => sameCd(r.mappedDriverCd ?? r.driverCd, driverCd))
      if (hit) {
        out.push({ ...base, state: 'ok', message: '', compared: hit })
        continue
      }
      out.push(m.conflictCds.some(cd => sameCd(cd, driverCd))
        ? { ...base, state: 'unknown', message: '氏名の違う複数の給与コードがこの乗務員に引き当たっている — 社員マスタで直す' }
        : { ...base, state: 'noPayroll', message: `${payMonth} 支給の明細にこの乗務員が居ない (社員マスタの引き当てが無いか、支給が無い)` })
    }
  }
  return out
}

/** 案件の月に対応する、給与大臣へ問い合わせる勤務月 (= 支給月の前月) と支給月の組。
 * `/api/kyuyo/payroll` の `month` は**勤務月**で、返る明細の月ラベルは支給月。 */
export function litigationPayrollMonths(months: readonly string[]): { workMonth: string, payMonth: string }[] {
  return months.map(m => ({ workMonth: m, payMonth: nextYm(m) }))
}
