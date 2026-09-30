/**
 * 訴訟準備の「給与比較」タブの pure ロジック (`app/utils/litigation-salary.ts`)。
 *
 * - 比較そのものは拘束×賃金と同じ `compareSalaryMonth` に任せる (支給月 = 勤務月の翌月で合わせる)
 * - 材料が取れていない・明細に居ない・引き当てが衝突 を「比較済み」と同じ見た目にしない
 */
import { describe, it, expect } from 'vitest'
import { buildLitigationSalaryRows, diffSignClass, litigationPayrollMonths, litigationAttrsCandidates, litigationRegisterCandidates, narrowKyuyoEmployees, type LitigationRegisterInput, type LitigationSalaryInput } from '~/utils/litigation-salary'
import type { SalaryCsvRow } from '~/utils/salary-compare'
import type { WageReportResponse, WageReportRow } from '~/utils/restraint-wage-view'
import type { LitigationFetched } from '~/utils/litigation-errors'

function reportRow(cd: string, name: string, workDays = 20): WageReportRow {
  return {
    summary: { driverCd: cd, driverName: name, workDays, workingMinutes: 9600, overtimeMinutes: 600, overtimeNightMinutes: 0, days: [] },
    pay_kubun: 2,
    wage: { minutes: { statutory: 9000 }, overtimeMinutes: 600, nightOvertimeMinutes: 0, minWageOvertimePay: null, minWageNightOvertimePay: null },
  } as unknown as WageReportRow
}

function wage(rows: WageReportRow[]): LitigationFetched<WageReportResponse> {
  return { ok: true, value: { month: '2023-06', rows, no_data_drivers: [], warnings: [], restraint_source: 'gcp' } }
}

function pay(cd: string, name: string, month: string, over: Partial<SalaryCsvRow> = {}): SalaryCsvRow {
  return {
    driverCd: cd,
    cdKey: String(Number(cd)),
    company: '0200',
    driverName: name,
    month,
    amounts: { 基本給: 200000, 残業手当: 30000 },
    reportedTotal: 230000,
    rates: { base: 10000, overtime: 1500 },
    ...over,
  } as SalaryCsvRow
}

const config = { items: { 基本給: 'base', 残業手当: 'overtime' } } as LitigationSalaryInput['config']

function input(over: Partial<LitigationSalaryInput> = {}): LitigationSalaryInput {
  return {
    driverCds: ['9101'],
    months: ['2023-06'],
    wageReports: new Map([['9101|2023-06', wage([reportRow('9101', '山田 太郎')])]]),
    payroll: new Map([['2023-07', { ok: true, value: [pay('9101', '山田 太郎', '2023-07')] }]]),
    config,
    cdMap: { entries: {} },
    loadingPayMonth: null,
    ...over,
  }
}

describe('litigationPayrollMonths', () => {
  it('給与大臣へは勤務月で問い合わせ、明細は翌月 (支給月) のラベルで返る', () => {
    expect(litigationPayrollMonths(['2023-06', '2023-12'])).toEqual([
      { workMonth: '2023-06', payMonth: '2023-07' },
      { workMonth: '2023-12', payMonth: '2024-01' },
    ])
  })
})

describe('buildLitigationSalaryRows', () => {
  it('★ 勤務月の拘束と翌月支給の明細を突き合わせる (拘束×賃金と同じ計算: 日額 × 勤務日数、残業単価 × 時間外)', () => {
    const [row] = buildLitigationSalaryRows(input())
    expect(row).toMatchObject({ driverCd: '9101', month: '2023-06', payMonth: '2023-07', state: 'ok' })
    expect(row!.compared).toMatchObject({ csvBase: 200000, sysBase: 200000, diffBase: 0, csvOvertime: 30000, sysOvertime: 15000, diffOvertime: 15000 })
  })

  it('★ 同じ月の明細でも支給月がずれていれば (勤務月ラベルの明細) 突き合わせない', () => {
    const [row] = buildLitigationSalaryRows(input({ payroll: new Map([['2023-07', { ok: true, value: [pay('9101', '山田 太郎', '2023-06')] }]]) }))
    expect(row!.state).toBe('noPayroll')
    expect(row!.message).toContain('2023-07 支給の明細にこの乗務員が居ない')
  })

  it('給与コードが乗務員CD と別体系でも、社員マスタの引き当てで比較する', () => {
    const [row] = buildLitigationSalaryRows(input({
      payroll: new Map([['2023-07', { ok: true, value: [pay('9001', '山田 太郎', '2023-07')] }]]),
      cdMap: { entries: { '0200|9001|山田太郎': '9101' } },
    }))
    expect(row!.state).toBe('ok')
  })

  it('拘束の材料: 未取得 / 取れていない / この乗務員の行が無い を言い分ける', () => {
    expect(buildLitigationSalaryRows(input({ wageReports: new Map() }))[0]).toMatchObject({ state: 'pending', message: '拘束の材料が未取得 (9/29 以前の古い形の保存も含む) — 「拘束の材料を取る」' })
    expect(buildLitigationSalaryRows(input({ wageReports: new Map([['9101|2023-06', { ok: false, reason: '504' }]]) }))[0]).toMatchObject({ state: 'unknown', message: '拘束の材料が取れていない: 504' })
    expect(buildLitigationSalaryRows(input({ wageReports: new Map([['9101|2023-06', wage([])]]) }))[0]!.state).toBe('unknown')
  })

  it('給与明細: 未読込 / 読めない を言い分ける', () => {
    expect(buildLitigationSalaryRows(input({ payroll: new Map() }))[0]).toMatchObject({ state: 'pending', message: '給与明細が未読込 (給与比較タブを開くと自動で読みます)' })
    expect(buildLitigationSalaryRows(input({ payroll: new Map([['2023-07', { ok: false, reason: '403 権限なし' }]]) }))[0]).toMatchObject({ state: 'unknown', message: '給与明細が読めない: 403 権限なし' })
  })

  it('★ payrollNote: 拘束の材料で止まった行でも、その支給月の明細の状況 (未読込 / 読込中 / 読めない / 読込済み) を言う', () => {
    const noWage = { wageReports: new Map() }
    const note = (over: Partial<LitigationSalaryInput>) => buildLitigationSalaryRows(input({ ...noWage, ...over }))[0]!
    expect(note({ payroll: new Map() }).payrollNote).toBe('明細: 未読込')
    expect(note({ payroll: new Map(), loadingPayMonth: '2023-07' }).payrollNote).toBe('明細: 読込中')
    expect(note({ payroll: new Map(), loadingPayMonth: '2023-08' }).payrollNote).toBe('明細: 未読込')
    expect(note({ payroll: new Map([['2023-07', { ok: false, reason: '403 権限なし' }]]) }).payrollNote).toBe('明細: 読めない — 403 権限なし')
    const loaded = note({})
    expect(loaded).toMatchObject({ state: 'pending', payrollNote: '明細: 読込済み' })
    // 材料が取れていない / 賃金計算に行が無い でも同じ
    expect(buildLitigationSalaryRows(input({ wageReports: new Map([['9101|2023-06', { ok: false, reason: '504' }]]) }))[0]!.payrollNote).toBe('明細: 読込済み')
    expect(buildLitigationSalaryRows(input({ wageReports: new Map([['9101|2023-06', wage([])]]) }))[0]!.payrollNote).toBe('明細: 読込済み')
  })

  it('★ 材料が有って先へ進んだ行は payrollNote を出さない (message が明細の状況を言っている)', () => {
    expect(buildLitigationSalaryRows(input())[0]!.payrollNote).toBe('')
    expect(buildLitigationSalaryRows(input({ payroll: new Map() }))[0]).toMatchObject({ message: expect.stringContaining('未読込'), payrollNote: '' })
    expect(buildLitigationSalaryRows(input({ payroll: new Map([['2023-07', { ok: false, reason: 'x' }]]) }))[0]!.payrollNote).toBe('')
  })

  it('★ 氏名の違う給与行が同じ乗務員に引き当たったら比較せず「比較できない」', () => {
    const [row] = buildLitigationSalaryRows(input({
      payroll: new Map([['2023-07', { ok: true, value: [pay('9101', '山田 太郎', '2023-07'), pay('9', '別人 太郎', '2023-07', { company: '0100' })] }]]),
      cdMap: { entries: { '0100|9|別人太郎': '9101', '0200|9101|山田太郎': '9101' } },
    }))
    expect(row!.state).toBe('unknown')
    expect(row!.message).toContain('社員マスタで直す')
  })

  it('並びは乗務員ごと・月の古い順', () => {
    const rows = buildLitigationSalaryRows(input({ driverCds: ['9101', '1078'], months: ['2023-06', '2023-07'] }))
    expect(rows.map(r => `${r.driverCd}|${r.month}`)).toEqual(['9101|2023-06', '9101|2023-07', '1078|2023-06', '1078|2023-07'])
  })
})

describe('litigationRegisterCandidates', () => {
  // 架空の社員: 給与コード 9001 の山田 太郎 = 乗務員CD 9101 (番号が違うので社員マスタが無いと引き当たらない)
  const driver = (cd: string, name: string) => ({ summary: { driverCd: cd, driverName: name } })
  function reg(over: Partial<LitigationRegisterInput> = {}): LitigationRegisterInput {
    return {
      payrollRows: [pay('9001', '山田 太郎', '2023-07'), pay('9001', '山田 太郎', '2023-08'), pay('9002', '佐藤 花子', '2023-07')],
      drivers: [driver('9101', '山田　太郎'), driver('9102', '佐藤 花子')],
      cdMap: { entries: {} },
      registered: [],
      caseDriverCds: ['9101'],
      ...over,
    }
  }

  it('氏名が一意に一致する案件の乗務員だけ、会社・給与コード・氏名・乗務員CD で 1 件にする', () => {
    expect(litigationRegisterCandidates(reg())).toEqual([{ company: '0200', payrollCd: '9001', name: '山田太郎', driverCd: '9101' }])
  })

  it('提案先が案件の乗務員でなければ出さない', () => {
    expect(litigationRegisterCandidates(reg({ caseDriverCds: ['9102'] })).map(c => c.driverCd)).toEqual(['9102'])
    expect(litigationRegisterCandidates(reg({ caseDriverCds: ['9999'] }))).toEqual([])
  })

  it('社員マスタに (会社, 給与コード) が既に在れば出さない (前ゼロ・全角は同じ社員として見る)', () => {
    expect(litigationRegisterCandidates(reg({ registered: [{ company: '０２００', payrollCd: '09001' }] }))).toEqual([])
    // 別の会社の同じ給与コードは別人
    expect(litigationRegisterCandidates(reg({ registered: [{ company: '0100', payrollCd: '9001' }] }))).toHaveLength(1)
  })

  it('全乗務員に同姓同名が居れば (案件の外でも) 出さない', () => {
    expect(litigationRegisterCandidates(reg({ drivers: [driver('9101', '山田 太郎'), driver('9201', '山田 太郎')] }))).toEqual([])
  })

  it('同じ乗務員に 2 件以上の給与コードが提案されたら、その乗務員の候補は全部出さない', () => {
    const payrollRows = [pay('9001', '山田 太郎', '2023-07'), pay('9001', '山田 太郎', '2023-07', { company: '0300' })]
    expect(litigationRegisterCandidates(reg({ payrollRows }))).toEqual([])
  })
})

describe('litigationAttrsCandidates / narrowKyuyoEmployees (属性を入れる)', () => {
  const emp = (over: Partial<{ company: string, payrollCd: string, name: string, driverCd: string | null, attrs: { effectiveFrom: string }[] }> = {}) => ({
    company: '0200', payrollCd: '9001', name: '山田太郎', driverCd: '9101', attrs: [], ...over,
  }) as never

  it('乗務員CD が案件の乗務員で、属性が空の社員だけ挙げる', () => {
    expect(litigationAttrsCandidates({ employees: [emp()], caseDriverCds: ['9101'] }))
      .toEqual([{ company: '0200', payrollCd: '9001', name: '山田太郎', driverCd: '9101' }])
    // 乗務員CD の前ゼロは同じ乗務員
    expect(litigationAttrsCandidates({ employees: [emp({ driverCd: '09101' })], caseDriverCds: ['9101'] })).toHaveLength(1)
  })

  it('属性が 1 行でも在る・乗務員CD が無い・案件の外は挙げない', () => {
    const employees = [
      emp({ attrs: [{ effectiveFrom: '2023-04-01' }] }),
      emp({ payrollCd: '9002', driverCd: null }),
      emp({ payrollCd: '9003', driverCd: '9999' }),
    ]
    expect(litigationAttrsCandidates({ employees, caseDriverCds: ['9101'] })).toEqual([])
  })

  it('給与大臣の一覧を給与コードが一致する 1 人に絞る (前ゼロは同じ社員、他の欄はそのまま)', () => {
    const row = (key: string) => ({ employee_code: key, employee_code_key: key, employee_name: key, department: '', taikei: 0, retired: false })
    const res = { company: '0200', company_name: '架空運輸', month: '2023-06', database: 'x', employees: [row('9001'), row('9002')], warnings: [] }
    const out = narrowKyuyoEmployees(res, '09001')
    expect(out.employees.map(r => r.employee_code_key)).toEqual(['9001'])
    expect(out.company).toBe('0200')
    expect(narrowKyuyoEmployees(res, '9999').employees).toEqual([])
  })
})

import { splitPayrollTargets } from '~/utils/litigation-salary'

describe('splitPayrollTargets (保存済みと保存が無い月に分ける)', () => {
  const t = (company: string, workMonth: string) => ({ company, workMonth, payMonth: `${workMonth}-pay` })
  const targets = [t('A', '2025-01'), t('B', '2025-01'), t('A', '2025-02')]

  it('全部保存済みなら live は空、入力の順を保つ', () => {
    expect(splitPayrollTargets(targets, new Set(['A|2025-01', 'B|2025-01', 'A|2025-02']))).toEqual({ cached: targets, live: [] })
  })

  it('一部だけ保存済み: 会社込みで判る (同じ月でも会社 B は live)', () => {
    const r = splitPayrollTargets(targets, new Set(['A|2025-01', 'A|2025-02']))
    expect(r.cached).toEqual([targets[0], targets[2]])
    expect(r.live).toEqual([targets[1]])
  })

  it('synced が空 (synced-months が読めない) なら全部 live = 直列', () => {
    expect(splitPayrollTargets(targets, new Set())).toEqual({ cached: [], live: targets })
  })
})

describe('diffSignClass (差の符号で文字色)', () => {
  it('正は青、負は赤 (ダークモードの色つき)', () => {
    expect(diffSignClass(1)).toBe('text-blue-600 dark:text-blue-400')
    expect(diffSignClass(-1)).toBe('text-red-600 dark:text-red-400')
  })

  it('0 と null (計算できない) は色を付けない', () => {
    expect(diffSignClass(0)).toBe('')
    expect(diffSignClass(null)).toBe('')
  })
})

import { salaryRowCells } from '~/utils/litigation-salary'
import type { SalaryComparisonRow } from '~/utils/salary-compare'

describe('salaryRowCells (画面の 3 段と紙面の 1 行が共用する行の組み立て)', () => {
  const base = {
    csvBase: 200000, sysBase: 190000, diffBase: 10000,
    csvOvertime: 30000, sysOvertime: 15000, diffOvertime: 15000,
    csvTotal: 250000, sysTotal: 205000, diffTotal: 45000,
    overtimeFixed: false,
    baseRateActual: 1333.3, baseRateOvertimePay: 16667, diffCsvVsBaseRateOvertime: 13333,
    minWageOvertimeMinutes: 600, statutoryMinutes: 9000,
    sysWorkDays: 20, sysOvertimeMinutes: 605,
  } as unknown as SalaryComparisonRow

  it('基本給・残業・総支給を 明細 / 計算 / 差 の順で返し、時間外は小数 1 桁の時間にする', () => {
    const c = salaryRowCells(base)
    expect(c.amounts).toEqual([
      { key: 'base', csv: 200000, sys: 190000, diff: 10000 },
      { key: 'overtime', csv: 30000, sys: 15000, diff: 15000 },
      { key: 'total', csv: 250000, sys: 205000, diff: 45000 },
    ])
    expect(c.workDays).toBe(20)
    expect(c.overtimeHours).toBe(10.1)
    expect(c.overtimeFixed).toBe(false)
  })

  it('37条は理論値があれば 5 項目、差が負のときだけ shortfall', () => {
    expect(salaryRowCells(base).over37).toEqual({ rate: 1333.3, minutes: 600, theory: 16667, paid: 30000, diff: 13333, shortfall: false })
    expect(salaryRowCells({ ...base, diffCsvVsBaseRateOvertime: -1 }).over37!.shortfall).toBe(true)
    expect(salaryRowCells({ ...base, diffCsvVsBaseRateOvertime: null }).over37!.shortfall).toBe(false)
  })

  it('37条が出せないときは null と理由 (法定内時間が 0 / 割増の基礎に入る支給が 0)', () => {
    const none = { ...base, baseRateOvertimePay: null }
    expect(salaryRowCells(none).over37).toBeNull()
    expect(salaryRowCells({ ...none, statutoryMinutes: 0 } as SalaryComparisonRow).over37NoneReason).toBe('(法定内時間が 0)')
    expect(salaryRowCells(none as SalaryComparisonRow).over37NoneReason).toBe('(割増の基礎に入る支給が 0)')
    expect(salaryRowCells({ ...base, overtimeFixed: true }).overtimeFixed).toBe(true)
  })
})
