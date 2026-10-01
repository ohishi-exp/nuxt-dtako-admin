/**
 * 訴訟準備の「給与比較」タブの pure ロジック。
 *
 * 拘束×賃金の給与比較タブ (`restraint-wage.vue`) と**同じ比較** (`compareSalaryMonth`) を、
 * 案件の乗務員 × 月に並べる。比べるのは給与明細の実支給 (基本給・残業代・総支給) と、
 * 明細の【補助】単価 × システムの勤務日数・残業時間で出した額。残業時間は wage report が正本
 * (`SalaryComparisonRow.overtimeMinutes`、週 40 時間超を含む) で、ここでは数え直さない。
 *
 * | 側 | 素材 | 口 |
 * | --- | --- | --- |
 * | 給与明細 | 給与大臣の支給項目 (支給月 = 勤務月の翌月) | `GET /api/kyuyo/payroll?company=&month=<勤務月>` — 保存が無い月は給与大臣から読んで保存する (読み通し) |
 * | 計算 | エラータブで取った wage-report (拘束は GCP、乗務員ぶんに切り出したもの) | `GET /restraint-api/wage-report?source=gcp` (エラータブの「検知を実行」) |
 *
 * **金額と氏名はブラウザに残さない** (拘束×賃金と同じ方針、Refs #467) — 給与明細はメモリだけに持ち、
 * 開き直したら読み直す (保存済みの月は給与大臣を開かずに返るので速い)。
 */
import { fmtMinutes, fmtYen, nextYm, WAGE_COLUMNS } from './restraint-wage-view'
import type { WageCategoryKey, WageReportResponse, WageReportRow } from './restraint-wage-view'
import {
  BASE_RATE_NONE_LABELS, baseRateBasisNotes, baseRateBasisText, baseRateDaysSourceLabel, compareSalaryMonth,
  CSV_ATTENDANCE_LABELS, CSV_BASE_SALARY_ITEM_LABEL, CSV_OVERTIME_HOURS_LABEL, fmtHoursOneDecimal, suggestCdMapEntries,
} from './salary-compare'
import type { SalaryCdMap, SalaryComparisonRow, SalaryCsvRow, SalaryItemConfig, SalaryRateBasis } from './salary-compare'
import { splitCdMapKey } from './employee-master'
import type { EmployeeMasterEntry, KyuyoEmployeesResponse } from './employee-master'
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
  /** 拘束の材料の段階で止まった行だけ、その行の支給月の明細の状況 (それ以外は message が言うので '')。
   * 状態 (バッジ) は変えない — 明細を何か月読んでも表に出ない、を避けるための 1 行 */
  payrollNote: string
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
  /** いま読んでいる支給月 (読んでいなければ null)。保存済みをまとめて読む間は複数なので集合も取る */
  loadingPayMonth: string | ReadonlySet<string> | null
}

function isLoadingPayMonth(payMonth: string, loading: string | ReadonlySet<string> | null): boolean {
  return typeof loading === 'string' ? payMonth === loading : loading?.has(payMonth) === true
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
    // (拘束×賃金の salaryMonthRows と同じ絞り方。compareSalaryMonth の month は 60h 超の割増率用の勤務月)
    const payMonth = nextYm(month)
    const compared = compareSalaryMonth(pay.value.filter(r => r.month === payMonth), reportRows, input.config, month, input.cdMap)
    byMonth.set(month, { rows: compared.rows, conflictCds: compared.conflicts.map(c => c.driverCd) })
  }

  const out: LitigationSalaryRow[] = []
  for (const driverCd of input.driverCds) {
    for (const month of input.months) {
      const payMonth = nextYm(month)
      const base = { driverCd, month, payMonth, compared: null, payrollNote: '' }
      const wage = input.wageReports.get(litigationDriverMonthKey(driverCd, month))
      const pay = input.payroll.get(payMonth)
      const payrollNote = !pay
        ? (isLoadingPayMonth(payMonth, input.loadingPayMonth) ? '明細: 読込中' : '明細: 未読込')
        : pay.ok ? '明細: 読込済み' : `明細: 読めない — ${pay.reason}`
      if (!wage) {
        out.push({ ...base, payrollNote, state: 'pending', message: '拘束の材料が未取得 (9/29 以前の古い形の保存も含む) — 「拘束の材料を取る」' })
        continue
      }
      if (!wage.ok) {
        out.push({ ...base, payrollNote, state: 'unknown', message: `拘束の材料が取れていない: ${wage.reason}` })
        continue
      }
      if (!wage.value.rows.some(r => sameCd(r.summary.driverCd, driverCd))) {
        out.push({ ...base, payrollNote, state: 'unknown', message: 'この月の賃金計算にこの乗務員の行が無い' })
        continue
      }
      if (!pay) {
        out.push({ ...base, state: 'pending', message: '給与明細が未読込 (給与比較タブを開くと自動で読みます)' })
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

/** 明細を 1 本読む単位 (会社 × 勤務月)。 */
export interface PayrollTarget {
  company: string
  workMonth: string
  payMonth: string
}

/**
 * 読む対象を「保存済み (cached)」と「保存が無い (live)」に分ける。`synced` は
 * `GET /api/kyuyo/synced-months` の (会社, 勤務月) を `${company}|${workMonth}` にした集合。
 * 保存済みは通常、上流が給与大臣を開かずに返す (並列で読める)。保存が無い月は給与大臣を開くので
 * 直列に読む。synced-months が読めなければ空集合を渡す = 全部 live = 従来どおりの直列。
 * 並びは入力の順を保つ。
 */
export function splitPayrollTargets(
  targets: readonly PayrollTarget[],
  synced: ReadonlySet<string>,
): { cached: PayrollTarget[], live: PayrollTarget[] } {
  const cached: PayrollTarget[] = []
  const live: PayrollTarget[] = []
  for (const t of targets) (synced.has(`${t.company}|${t.workMonth}`) ? cached : live).push(t)
  return { cached, live }
}

/** 給与比較タブから社員マスタへ 1 人ずつ登録する候補 (給与大臣の社員 → 乗務員CD)。 */
export interface LitigationRegisterCandidate {
  company: string
  payrollCd: string
  name: string
  driverCd: string
}

export interface LitigationRegisterInput {
  /** 読み込み済みの全支給月の明細 (連結) */
  payrollRows: readonly SalaryCsvRow[]
  /** **全乗務員** (案件の乗務員だけにしない — 同姓同名の別人が居れば一意でないとして提案しないため) */
  drivers: readonly { summary: { driverCd: string, driverName: string } }[]
  cdMap: SalaryCdMap
  /** 社員マスタに既に在る (会社, 給与コード) の全件 */
  registered: readonly { company: string, payrollCd: string }[]
  /** 案件の乗務員CD */
  caseDriverCds: readonly string[]
}

const registeredKey = (company: string, payrollCd: string) =>
  `${company.normalize('NFKC').trim()}|${String(Number(payrollCd))}`

/**
 * 拘束×賃金の「氏名一致で自動設定」(`suggestCdMapEntries`) と同じ一意判定で、案件の乗務員に
 * 引き当たる明細の社員を挙げる。次の 3 つは捨てる:
 * - 提案先が案件の乗務員でない
 * - 社員マスタに (会社, 給与コード) が既に在る — PUT は氏名と乗務員CD を上書きするので、既存の
 *   突合を黙って付け替えない (表記揺れで cdMap に引っかからない既存行もここで落ちる)
 * - 同じ乗務員に 2 件以上の給与コードが提案された (明細側の同姓同名・複数社) — その乗務員の候補は全部
 */
export function litigationRegisterCandidates(input: LitigationRegisterInput): LitigationRegisterCandidate[] {
  const known = new Set(input.registered.map(e => registeredKey(e.company, e.payrollCd)))
  const candidates = Object.entries(suggestCdMapEntries([...input.payrollRows], input.drivers, input.cdMap))
    .map(([key, driverCd]) => ({ ...splitCdMapKey(key), driverCd }))
    .filter(c => input.caseDriverCds.some(cd => sameCd(cd, c.driverCd))
      && !known.has(registeredKey(c.company, c.payrollCd)))
  return candidates.filter(c => candidates.filter(o => sameCd(o.driverCd, c.driverCd)).length === 1)
}

/**
 * 社員マスタに乗務員CD が入っているのに属性 (給与区分・所属) が 1 行も無い、案件の乗務員の社員。
 * 属性が空だと relay の wage-report に `pay_kubun` が付かず、給与比較の基本給の計算が出ない。
 * **属性が 1 行でも在る人は出さない** (入れ直すと既存の履歴と食い違うため)。
 */
export function litigationAttrsCandidates(input: {
  employees: readonly EmployeeMasterEntry[]
  caseDriverCds: readonly string[]
}): LitigationRegisterCandidate[] {
  return input.employees
    .filter(e => e.driverCd && e.attrs.length === 0 && input.caseDriverCds.some(cd => sameCd(cd, e.driverCd!)))
    .map(e => ({ company: e.company, payrollCd: e.payrollCd, name: e.name, driverCd: e.driverCd! }))
}

/** 給与大臣の社員一覧を、給与コードが一致する 1 人だけに絞る (前ゼロは同じ社員として見る)。
 * 絞った結果を `planPayrollDbImport` に渡すと、その 1 人ぶんの属性だけの計画になる。 */
export function narrowKyuyoEmployees(res: KyuyoEmployeesResponse, payrollCd: string): KyuyoEmployeesResponse {
  const key = (v: string) => String(Number(v.trim()))
  return { ...res, employees: res.employees.filter(r => key(r.employee_code_key) === key(payrollCd)) }
}

/**
 * 差の符号で決める文字色 (給与比較の「差」の行)。正 (> 0) は青、負 (< 0) は赤、
 * 0 と null (計算できない) は色を付けない。
 * 拘束×賃金の給与比較 (`restraint-wage.vue`) の色はこれと独立 (そちらは変えない)。
 */
export function diffSignClass(v: number | null): string {
  if (v === null || v === 0) return ''
  return v > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-red-600 dark:text-red-400'
}

/** 差の表示 (+ は明細の方が多い)。計算できない (単価なし・固定残業) は「-」 */
export function fmtSalaryDiff(v: number | null): string {
  if (v === null) return '-'
  return `${v > 0 ? '+' : ''}${fmtYen(v)}`
}

export interface LitigationSalaryAmountCell {
  key: 'base' | 'overtime' | 'total'
  csv: number
  sys: number | null
  diff: number | null
  /** 「計算」の根拠 (基本給 = `最低賃金 1,000 円/h × 法定時間内 150h00m`、残業 = `1,500 円/h × 10h00m`)。総支給は null (基本給と残業の和なので根拠を持たない) */
  basis: string | null
  /** 基本給の明細の内訳 (`うち基本給 N / 手当 M`)。基本給だけ。 */
  breakdown: string | null
  /** 残業だけ: 最低賃金ベースの残業代との比較。基本給の単価 × 法定内時間は「計算」そのものなのでここに出さない。基本給・総支給は null */
  minWage: LitigationSalaryMinWageLine | null
}

/** 最低賃金ベースの比較の 1 行。`diff` は明細 − 最低賃金ベース (負 = 明細が下回る)。比べられないときは理由を `text` に、`diff` は null。 */
export interface LitigationSalaryMinWageLine {
  text: string
  diff: number | null
  /** 明細が下回った (`diff` が負) — **エラー** (赤) */
  shortfall: boolean
}

/** 時間セルの 1 行 (ラベル + 値)。`key` は `data-salary-line` に入る。 */
export interface LitigationSalaryHoursLine {
  key: string
  label: string
  value: string
}

/** 「勤務日 / 時間外」列の中身 (計算で使った労働時間)。 */
export interface LitigationSalaryHours {
  /** デジタコ: 稼働日数 / 実働 / 法定区分 (0 の区分は出さない。法定内と実働は 0 でも出す) — wage report の欄をそのまま */
  digitaco: LitigationSalaryHoursLine[]
  /** 明細: 出勤日数 / 有休日数 / 残業時間 (在るものだけ) */
  csv: LitigationSalaryHoursLine[]
  /** 明細に 出勤日数 も 有休日数 も無い (37条の分母がデジタコの稼働日数に倒れる月) — 「明細に日数なし」と言う */
  csvNoDays: boolean
  /** 37条の分母 (`所定 150.0h (= 明細 20 日 × 7h30m)`)。日給以外・出せない行は null */
  denominator: string | null
}

export interface LitigationSalaryOver37 {
  rate: number | null
  minutes: number
  theory: number
  paid: number
  diff: number | null
  /** 明細の残業代が理論値を下回った (差が負) — 太字にするのはこれだけ */
  shortfall: boolean
  /** 基礎単価の根拠 (`baseRateBasisText`。拘束×賃金の給与比較と同じ文字列)。分母は所定労働時間 */
  rateBasis: string
  /** 根拠に添える注記 (`baseRateBasisNotes`: 日数をデジタコ稼働に倒した / 所定を引けず法定 8 時間)。無ければ空 */
  rateNotes: string[]
  /** 37条の基礎単価がその月の最低賃金を下回る — **エラー** (赤太字)。最低賃金が引けない月は false */
  belowMinWage: boolean
  /** `belowMinWage` の比べた相手 (その月の最低賃金、円/h)。引けない月は null */
  minWageRate: number | null
}

export interface LitigationSalaryRowCells {
  /** 基本給・残業・総支給 (明細 / 計算 / 差) */
  amounts: LitigationSalaryAmountCell[]
  /** 残業の差を出さない月給 (固定残業) */
  overtimeFixed: boolean
  /** 37条の比較。出せないときは null と、その理由 */
  over37: LitigationSalaryOver37 | null
  over37NoneReason: string
  /** 計算で使った労働時間 (画面の列と紙面の列が同じ部品で出す) */
  hours: LitigationSalaryHours
}

const yen = (v: number) => v.toLocaleString('ja-JP')

const WAGE_LABEL = Object.fromEntries(WAGE_COLUMNS.map(c => [c.key, c.label])) as Record<WageCategoryKey, string>

/** 基本給の明細 (区分 base) を 項目名「基本給」とそれ以外 (割増基礎に入る手当) に分けた内訳。 */
function baseBreakdownText(items: SalaryComparisonRow['csvBaseItems']): string {
  const salary = items.filter(i => i.label === CSV_BASE_SALARY_ITEM_LABEL).reduce((sum, i) => sum + i.amount, 0)
  const allowance = items.filter(i => i.label !== CSV_BASE_SALARY_ITEM_LABEL).reduce((sum, i) => sum + i.amount, 0)
  return `うち${CSV_BASE_SALARY_ITEM_LABEL} ${yen(salary)} / 手当 ${yen(allowance)}`
}

/**
 * 基本給(計算) の根拠。計算 = 単価マスタ × 法定時間内 (wage report の金額。ここで掛け算しない)。
 * 掛けた単価は単価マスタ。最低賃金と一致する月 (右端の列と同じ `rateBasisStatus` が ok) だけ「最低賃金」と呼び、違う月は単価マスタと書く。
 */
function baseBasisText(c: SalaryComparisonRow): string {
  const rate = c.rateBasis.hourlyRate
  if (c.sysBase === null || rate === null) return '単価なし (単価マスタに単価が無い)'
  const name = rateBasisStatus(c.rateBasis).status === 'ok' ? '最低賃金' : '単価マスタ'
  return `${name} ${yen(rate)} 円/h × ${WAGE_LABEL.statutory} ${fmtMinutes(c.hours.minutes.statutory)}`
}

function overtimeMinWageLine(c: SalaryComparisonRow): LitigationSalaryMinWageLine {
  if (c.minWageOvertimePay === null) return { text: '最低賃金ベースの残業代なし (最低賃金が引けない)', diff: null, shortfall: false }
  return {
    text: `最低賃金ベース ${yen(c.minWageOvertimePay)}`,
    diff: c.diffCsvVsMinWageOvertime,
    shortfall: (c.diffCsvVsMinWageOvertime ?? 0) < 0,
  }
}

/** 時間セルの行。時間は全部 wage report の欄 (`row.hours`)・明細の勤怠・37条の分母 (`baseRateBasis`) を並べるだけ。 */
function hoursCell(c: SalaryComparisonRow): LitigationSalaryHours {
  const digitaco: LitigationSalaryHoursLine[] = [
    { key: 'work-days', label: '稼働日数', value: `${c.hours.workDays} 日` },
    { key: 'working', label: '実働', value: fmtMinutes(c.hours.workingMinutes) },
  ]
  for (const col of WAGE_COLUMNS) {
    const m = c.hours.minutes[col.key]
    if (m > 0 || col.key === 'statutory') digitaco.push({ key: col.key, label: col.label, value: fmtMinutes(m) })
  }
  const csvDays = c.attendanceDays.csv
  const csv: LitigationSalaryHoursLine[] = []
  if (csvDays.work !== undefined) csv.push({ key: 'csv-work', label: CSV_ATTENDANCE_LABELS.work, value: `${csvDays.work} 日` })
  if (csvDays.paidLeave !== undefined) csv.push({ key: 'csv-paid-leave', label: CSV_ATTENDANCE_LABELS.paidLeave, value: `${csvDays.paidLeave} 日` })
  if (c.csvOvertimeHours !== null) csv.push({ key: 'csv-overtime', label: CSV_OVERTIME_HOURS_LABEL, value: `${c.csvOvertimeHours} h` })
  const b = c.baseRateBasis
  const denominator = b.kind === 'days' && b.none === null && b.hours !== null
    ? b.capped
      ? `所定 ${fmtHoursOneDecimal(b.hours)} (頭打ち)`
      : `所定 ${fmtHoursOneDecimal(b.hours)} (= ${baseRateDaysSourceLabel(b.daysSource)} ${b.days} 日 × ${fmtMinutes(b.dailyMinutes)})`
    : null
  return { digitaco, csv, csvNoDays: csvDays.work === undefined && csvDays.paidLeave === undefined, denominator }
}

/**
 * 比較済みの 1 行を、表示用のセル一式にする。画面と印刷の紙面は同じ縦に積んだセル
 * (明細 / 計算 / 差 + 根拠) をこれで組む。
 */
export function salaryRowCells(c: SalaryComparisonRow): LitigationSalaryRowCells {
  return {
    amounts: [
      {
        key: 'base', csv: c.csvBase, sys: c.sysBase, diff: c.diffBase, basis: baseBasisText(c),
        breakdown: baseBreakdownText(c.csvBaseItems), minWage: null,
      },
      {
        key: 'overtime', csv: c.csvOvertime, sys: c.sysOvertime, diff: c.diffOvertime,
        basis: c.sysOvertimeRate === null ? '単価なし' : `${yen(c.sysOvertimeRate)} 円/h × ${fmtMinutes(c.overtimeMinutes)}`,
        breakdown: null, minWage: overtimeMinWageLine(c),
      },
      { key: 'total', csv: c.csvTotal, sys: c.sysTotal, diff: c.diffTotal, basis: null, breakdown: null, minWage: null },
    ],
    overtimeFixed: c.overtimeFixed,
    over37: c.baseRateOvertimePay === null
      ? null
      : {
          rate: c.baseRateActual,
          minutes: c.overtimeMinutes,
          theory: c.baseRateOvertimePay,
          paid: c.csvOvertime,
          diff: c.diffCsvVsBaseRateOvertime,
          shortfall: (c.diffCsvVsBaseRateOvertime ?? 0) < 0,
          rateBasis: baseRateBasisText(c),
          rateNotes: baseRateBasisNotes(c.baseRateBasis),
          belowMinWage: isBaseRateBelowMinWage(c),
          minWageRate: c.rateBasis.minWageRate,
        },
    over37NoneReason: c.baseRateBasis.none === null ? '' : `(${BASE_RATE_NONE_LABELS[c.baseRateBasis.none]})`,
    hours: hoursCell(c),
  }
}

/** 37条の基礎単価がその月の最低賃金を下回るか (どちらかが無い月は false — 判定しない)。 */
export function isBaseRateBelowMinWage(c: Pick<SalaryComparisonRow, 'baseRateActual' | 'rateBasis'>): boolean {
  return c.baseRateActual !== null && c.rateBasis.minWageRate !== null && c.baseRateActual < c.rateBasis.minWageRate
}

// --- 計算に使った単価 (単価マスタ) と最低賃金 (Refs #1133) ---

export type RateBasisStatus = 'ok' | 'mismatch' | 'unknown'

/** "YYYY-MM-DD" → "YYYY-MM" */
const ym = (d: string) => d.slice(0, 7)

/** 単価の表示 (`1,000円/h (2024-10 適用、架空県)`)。適用開始日が無い (古い保存物) ときはそう書く。 */
export function rateBasisLabel(b: SalaryRateBasis): string {
  if (b.hourlyRate === null) return '単価なし (単価マスタに無い)'
  const pref = b.prefecture ? `、${b.prefecture}` : ''
  return b.effectiveFrom
    ? `${yen(b.hourlyRate)}円/h (${ym(b.effectiveFrom)} 適用${pref})`
    : `${yen(b.hourlyRate)}円/h (適用開始 不明 — 拘束の材料を取り直すと出る${pref})`
}

/** 最低賃金の表示 (`架空県 1,000円/h (2024-10 発効)`)。 */
export function minWageBasisLabel(b: { minWageRate: number, minWagePrefecture: string | null, minWageEffectiveFrom: string | null }): string {
  const pref = b.minWagePrefecture ? `${b.minWagePrefecture} ` : ''
  const from = b.minWageEffectiveFrom ? `${ym(b.minWageEffectiveFrom)} 発効` : '発効 不明'
  return `${pref}${yen(b.minWageRate)}円/h (${from})`
}

/**
 * 単価 (単価マスタ) がその月の最低賃金と一致するか。この会社は単価マスタに最低賃金を入れて
 * 運用しているので、**違う月 (上下どちらも) はエラー**。どちらかが無い月は `unknown` で理由を返す —
 * 黙って一致扱いにしない。
 */
export function rateBasisStatus(b: SalaryRateBasis): { status: RateBasisStatus, message: string } {
  if (b.hourlyRate === null) return { status: 'unknown', message: '判定できない: 単価マスタに単価が無い (上の『直し方』の ② → ③)' }
  // 県が引けない月も古い保存物 (最低賃金の欄が無い) も minWagePrefecture は null で見分けられないので、
  // どちらにも正しい「パネルの ① → ③」へ誘導する (① が取り込みか県の設定かはパネルが出し分ける)
  if (b.minWageRate === null) return { status: 'unknown', message: '判定できない: この月の最低賃金が引けない (上の『直し方』の ① → ③)' }
  if (b.hourlyRate === b.minWageRate) return { status: 'ok', message: '最低賃金と一致' }
  return { status: 'mismatch', message: `最低賃金 ${minWageBasisLabel({ ...b, minWageRate: b.minWageRate })} と違う` }
}

/** 紙面の「計算に使った単価」一覧の 1 行。 */
export interface RateBasisPeriod {
  driverCd: string
  /** 勤務月 `YYYY-MM` (両端を含む) */
  from: string
  to: string
  hourlyRate: number | null
  effectiveFrom: string | null
  prefecture: string | null
  /** 期間の月数 / そのうち最低賃金と違う月 / 判定できない月 */
  months: number
  mismatchMonths: number
  unknownMonths: number
  /** 違う月の最低賃金 (額・県・発効の組で重複を除く、出現順) */
  mismatchMinWages: string[]
}

/**
 * 乗務員ごと・月順に、同じ単価 (額・適用開始日・県) が続く月を 1 期間にまとめる。
 * 比較できていない月 (`compared` が無い) で期間を切る — 間の月の単価は分からないため。
 * 入力は `buildLitigationSalaryRows` の並び (乗務員ごと・月の古い順) のまま渡す。
 */
export function rateBasisPeriods(rows: readonly LitigationSalaryRow[]): RateBasisPeriod[] {
  const out: RateBasisPeriod[] = []
  let cur: RateBasisPeriod | null = null
  for (const row of rows) {
    const b = row.compared?.rateBasis
    if (!b) {
      cur = null
      continue
    }
    if (!cur || cur.driverCd !== row.driverCd || cur.hourlyRate !== b.hourlyRate
      || cur.effectiveFrom !== b.effectiveFrom || cur.prefecture !== b.prefecture) {
      cur = {
        driverCd: row.driverCd, from: row.month, to: row.month,
        hourlyRate: b.hourlyRate, effectiveFrom: b.effectiveFrom, prefecture: b.prefecture,
        months: 0, mismatchMonths: 0, unknownMonths: 0, mismatchMinWages: [],
      }
      out.push(cur)
    }
    cur.to = row.month
    cur.months++
    const { status } = rateBasisStatus(b)
    if (status === 'unknown') cur.unknownMonths++
    if (status === 'mismatch') {
      cur.mismatchMonths++
      const label = minWageBasisLabel({ ...b, minWageRate: b.minWageRate! })
      if (!cur.mismatchMinWages.includes(label)) cur.mismatchMinWages.push(label)
    }
  }
  return out
}

