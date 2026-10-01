/**
 * 訴訟準備の「給与比較」タブの pure ロジック (`app/utils/litigation-salary.ts`)。
 *
 * - 比較そのものは拘束×賃金と同じ `compareSalaryMonth` に任せる (支給月 = 勤務月の翌月で合わせる)
 * - 材料が取れていない・明細に居ない・引き当てが衝突 を「比較済み」と同じ見た目にしない
 */
import { describe, it, expect } from 'vitest'
import { buildLitigationSalaryRows, diffSignClass, minWageBasisLabel, rateBasisLabel, rateBasisPeriods, rateBasisStatus, type LitigationSalaryRow, litigationPayrollMonths, litigationAttrsCandidates, litigationRegisterCandidates, narrowKyuyoEmployees, type LitigationRegisterInput, type LitigationSalaryInput } from '~/utils/litigation-salary'
import type { SalaryCsvRow, SalaryRateBasis } from '~/utils/salary-compare'
import type { WageReportResponse, WageReportRow } from '~/utils/restraint-wage-view'
import type { LitigationFetched } from '~/utils/litigation-errors'

function reportRow(cd: string, name: string, workDays = 20): WageReportRow {
  return {
    summary: { driverCd: cd, driverName: name, workDays, workingMinutes: 9600, overtimeMinutes: 600, overtimeNightMinutes: 0, days: [] },
    pay_kubun: 2,
    // 単価 1,200 円/h × 法定時間内 150h = 180,000 (架空値)
    wage: { minutes: { statutory: 9000 }, amounts: { statutory: 180000 }, overtimeMinutes: 600, nightOvertimeMinutes: 0, minWageOvertimePay: 14000, minWageNightOvertimePay: 1000 },
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
  it('★ 勤務月の拘束と翌月支給の明細を突き合わせる (拘束×賃金と同じ計算: 単価 × 法定時間内、最低賃金ベースの残業代)', () => {
    const [row] = buildLitigationSalaryRows(input())
    expect(row).toMatchObject({ driverCd: '9101', month: '2023-06', payMonth: '2023-07', state: 'ok' })
    expect(row!.compared).toMatchObject({ csvBase: 200000, sysBase: 180000, diffBase: 20000, csvOvertime: 30000, sysOvertime: 15000, diffOvertime: 15000 })
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

import { isBaseRateBelowMinWage, salaryRowCells } from '~/utils/litigation-salary'
import type { SalaryComparisonRow } from '~/utils/salary-compare'

describe('salaryRowCells (画面の 3 段と紙面の 1 行が共用する行の組み立て)', () => {
  const base = {
    csvBase: 200000, sysBase: 150000, diffBase: 50000,
    csvOvertime: 30000, sysOvertime: 14000, diffOvertime: 16000,
    csvTotal: 250000, sysTotal: 164000, diffTotal: 86000,
    overtimeFixed: false,
    baseRateActual: 1333.3, baseRateOvertimePay: 16667, diffCsvVsBaseRateOvertime: 13333,
    overtimeMinutes: 605, csvPremiumBase: 200000,
    baseRateBasis: { kind: 'days', hours: 150, days: 20, daysSource: 'csv', capped: false, dailyMinutes: 450, scheduled: 'resolved', hourlyRate: null, none: null },
    rateBasis: { hourlyRate: 1000, minWageRate: 1000 },
    csvBaseItems: [{ label: '基本給', amount: 190000 }, { label: '通勤手当', amount: 10000 }],
    csvOvertimeHours: 10.5,
    statutoryMinutes: 9000,
  } as unknown as SalaryComparisonRow

  it('基本給・残業・総支給を 明細 / 計算 / 差 の順で返し、時間外は小数 1 桁の時間にする (残業の根拠・37条・時間外の列が同じ overtimeMinutes)', () => {
    const c = salaryRowCells(base)
    expect(c.amounts).toEqual([
      { key: 'base', csv: 200000, sys: 150000, diff: 50000, basis: '最低賃金 1,000 円/h × 法定時間内 150h00m', breakdown: 'うち基本給 190,000 / 手当 10,000' },
      { key: 'overtime', csv: 30000, sys: 14000, diff: 16000, basis: '最低賃金ベース × 残業時間 10h05m', breakdown: null },
      { key: 'total', csv: 250000, sys: 164000, diff: 86000, basis: null, breakdown: null },
    ])
    expect(c.over37!.minutes).toBe(605)
    expect(c.overtimeFixed).toBe(false)
  })

  it('★ 月給 (固定残業) の行でも残業の差を出す (負のまま運ぶ)。overtimeFixed は注記用に立つ', () => {
    const c = salaryRowCells({ ...base, overtimeFixed: true, diffOvertime: -25000 } as SalaryComparisonRow)
    expect(c.overtimeFixed).toBe(true)
    expect(c.amounts[1]).toMatchObject({ key: 'overtime', diff: -25000 })
  })

  it('★ 計算の根拠: 基本給 = 単価 × 法定時間内 (最低賃金と一致する月は「最低賃金」、違う月は「単価マスタ」、単価が無い月は計算なし)、残業 = 最低賃金ベース × 残業時間 (単価マスタとは書かない)', () => {
    const basis = (over: Partial<SalaryComparisonRow> = {}) => salaryRowCells({ ...base, ...over }).amounts.map(a => a.basis)
    expect(basis()).toEqual(['最低賃金 1,000 円/h × 法定時間内 150h00m', '最低賃金ベース × 残業時間 10h05m', null])
    expect(basis({ rateBasis: { hourlyRate: 1200, minWageRate: 1000 } } as Partial<SalaryComparisonRow>)[0]).toBe('単価マスタ 1,200 円/h × 法定時間内 150h00m')
    expect(basis({ rateBasis: { hourlyRate: 1200, minWageRate: 1000 } } as Partial<SalaryComparisonRow>)[1]).toBe('最低賃金ベース × 残業時間 10h05m')
    expect(basis({ rateBasis: { hourlyRate: 1000, minWageRate: null } } as Partial<SalaryComparisonRow>)[0]).toBe('単価マスタ 1,000 円/h × 法定時間内 150h00m')
    expect(basis({ sysBase: null, diffBase: null, rateBasis: { hourlyRate: null, minWageRate: 1000 } } as Partial<SalaryComparisonRow>)[0])
      .toBe('単価なし (単価マスタに単価が無い)')
    expect(basis({ sysOvertime: null, diffOvertime: null } as Partial<SalaryComparisonRow>)[1]).toBe('最低賃金ベースの残業代なし (最低賃金が引けない)')
    expect(salaryRowCells({ ...base, overtimeMinutes: 630 }).amounts[1]!.basis).toBe('最低賃金ベース × 残業時間 10h30m')
  })

  it('★ 基本給・残業の差が負 (明細が下回る) の月は diff が負で返る (画面が赤太字にする)。等しい月は 0、比べられない月は null', () => {
    const diffs = (over: Partial<SalaryComparisonRow>) => salaryRowCells({ ...base, ...over }).amounts.map(a => a.diff)
    expect(diffs({ diffBase: -1, diffOvertime: -2 })).toEqual([-1, -2, 86000])
    expect(diffs({ diffBase: 0, diffOvertime: 0 })).toEqual([0, 0, 86000])
    expect(diffs({ diffBase: null, diffOvertime: null })).toEqual([null, null, 86000])
  })

  it('★ 計算の行に「最低賃金ベース N (明細との差 …)」のような同じ数字の別行を持たない (セルの欄は 明細 / 内訳 / 計算 / 根拠 / 差 だけ)', () => {
    for (const a of salaryRowCells(base).amounts) {
      expect(Object.keys(a).sort()).toEqual(['basis', 'breakdown', 'csv', 'diff', 'key', 'sys'])
    }
  })

  it('37条は理論値があれば 5 項目 + 根拠、差が負のときだけ shortfall', () => {
    expect(salaryRowCells(base).over37).toEqual({
      rate: 1333.3, minutes: 605, theory: 16667, paid: 30000, diff: 13333, shortfall: false,
      rateBasis: '割増基礎 200,000 円 ÷ (明細 20 日 × 7h30m)', rateNotes: [], belowMinWage: false, minWageRate: 1000,
    })
    expect(salaryRowCells({ ...base, diffCsvVsBaseRateOvertime: -1 }).over37!.shortfall).toBe(true)
    expect(salaryRowCells({ ...base, diffCsvVsBaseRateOvertime: null }).over37!.shortfall).toBe(false)
  })

  it('★ 基礎単価の根拠の文字列 (baseRateBasisText をそのまま運ぶ): 日給 = 明細の日数 × 1 日の所定 (頭打ち / デジタコ稼働) / 時給 / 月給・その他', () => {
    const text = (b: Partial<SalaryComparisonRow['baseRateBasis']>) =>
      salaryRowCells({ ...base, baseRateBasis: { ...base.baseRateBasis, ...b } }).over37!.rateBasis
    expect(text({})).toBe('割増基礎 200,000 円 ÷ (明細 20 日 × 7h30m)')
    expect(text({ days: 24, capped: true, hours: (40 * 365) / 7 / 12 }))
      .toBe('割増基礎 200,000 円 ÷ 173.8h (明細 24 日 × 7h30m は週 40 時間相当を超えるため法定の月平均)')
    expect(text({ daysSource: 'sys' })).toBe('割増基礎 200,000 円 ÷ (デジタコ稼働 20 日 × 7h30m)')
    expect(text({ kind: 'hours', hourlyRate: 1200, hours: null, days: null, daysSource: null, dailyMinutes: null, scheduled: null }))
      .toBe('明細の時給 1,200 円/h')
    expect(text({ kind: 'monthly', hours: (40 * 365) / 7 / 12, days: null, daysSource: null, dailyMinutes: null, scheduled: null }))
      .toBe('割増基礎 200,000 円 ÷ 法定の月平均 173.8h')
  })

  it('★ 根拠の注記 (baseRateBasisNotes をそのまま運ぶ): 所定を引けなかった理由は未設定と読めなかったで別の文言、日数をデジタコ稼働に倒した理由、無ければ空', () => {
    const notes = (b: Partial<SalaryComparisonRow['baseRateBasis']>) =>
      salaryRowCells({ ...base, baseRateBasis: { ...base.baseRateBasis, dailyMinutes: 480, ...b } }).over37!.rateNotes
    expect(notes({ scheduled: 'resolved' })).toEqual([])
    expect(notes({ scheduled: 'unset' })).toEqual(['所定未設定のため法定 8 時間で計算'])
    expect(notes({ scheduled: 'unread' })).toEqual(['所定を読めなかったため法定 8 時間で計算 (古い保存物なら拘束の材料を取り直す)'])
    expect(notes({ scheduled: null })).toEqual([])
    expect(notes({ daysSource: 'sys' })).toEqual(['明細に出勤日数が無いためデジタコの稼働日数で計算'])
    expect(notes({ daysSource: 'merged', scheduled: 'unset' })).toEqual(['複数会社の給与を合算した行のためデジタコの稼働日数で計算', '所定未設定のため法定 8 時間で計算'])
  })

  it('★ belowMinWage: 基礎単価 < その月の最低賃金のときだけ true。等しい・上回る・最低賃金が引けない月は false', () => {
    const cell = (baseRateActual: number | null, minWageRate: number | null) =>
      salaryRowCells({ ...base, baseRateActual, rateBasis: { ...base.rateBasis, minWageRate } } as SalaryComparisonRow).over37!
    expect(cell(999.9, 1000)).toMatchObject({ belowMinWage: true, minWageRate: 1000 })
    expect(cell(1000, 1000).belowMinWage).toBe(false)
    expect(cell(1200, 1000).belowMinWage).toBe(false)
    expect(cell(500, null)).toMatchObject({ belowMinWage: false, minWageRate: null })
    expect(isBaseRateBelowMinWage({ baseRateActual: null, rateBasis: { minWageRate: 1000 } as SalaryComparisonRow['rateBasis'] })).toBe(false)
  })

  it('37条が出せないときは null と理由 (給与区分が不明 / 明細に時給の単価が無い / 割増の基礎に入る支給が 0 / 分母の日数が 0)', () => {
    const reason = (none: SalaryComparisonRow['baseRateBasis']['none']) =>
      salaryRowCells({ ...base, baseRateOvertimePay: null, baseRateBasis: { ...base.baseRateBasis, none } }).over37NoneReason
    expect(salaryRowCells({ ...base, baseRateOvertimePay: null }).over37).toBeNull()
    expect(reason('unknown-kind')).toBe('(給与区分が不明)')
    expect(reason('no-hourly-rate')).toBe('(明細に時給の単価が無い)')
    expect(reason('no-premium-base')).toBe('(割増の基礎に入る支給が 0)')
    expect(reason('no-denominator')).toBe('(分母の日数が 0 (明細の出勤 + 有休。無ければデジタコ稼働))')
    expect(salaryRowCells({ ...base, overtimeFixed: true }).overtimeFixed).toBe(true)
  })
})

describe('rateBasisStatus / rateBasisLabel (計算に使った単価と最低賃金、Refs #1133)', () => {
  const basis = (over: Partial<SalaryRateBasis> = {}): SalaryRateBasis => ({
    hourlyRate: 1000, effectiveFrom: '2024-10-05', prefecture: '架空県',
    minWageRate: 1000, minWagePrefecture: '架空県', minWageEffectiveFrom: '2024-10-01', ...over,
  })

  it('一致は ok', () => {
    expect(rateBasisStatus(basis())).toEqual({ status: 'ok', message: '最低賃金と一致' })
  })

  it('★ 下回る月も上回る月も mismatch。違う最低賃金の額・県・発効年月を併記する (「下回る」とは書かない)', () => {
    expect(rateBasisStatus(basis({ hourlyRate: 950 }))).toEqual({ status: 'mismatch', message: '最低賃金 架空県 1,000円/h (2024-10 発効) と違う' })
    expect(rateBasisStatus(basis({ hourlyRate: 1100 })).status).toBe('mismatch')
    // 県・発効が無い最低賃金でも併記は崩れない
    expect(rateBasisStatus(basis({ hourlyRate: 1100, minWagePrefecture: null, minWageEffectiveFrom: null })).message).toBe('最低賃金 1,000円/h (発効 不明) と違う')
  })

  it('★ どちらかが無ければ unknown (一致扱いにしない): 単価なし / 最低賃金が引けない', () => {
    expect(rateBasisStatus(basis({ hourlyRate: null })).status).toBe('unknown')
    expect(rateBasisStatus(basis({ hourlyRate: null })).message).toBe('判定できない: 単価マスタに単価が無い (上の『直し方』の ② → ③)')
    expect(rateBasisStatus(basis({ minWageRate: null })).status).toBe('unknown')
    expect(rateBasisStatus(basis({ minWageRate: null })).message).toBe('判定できない: この月の最低賃金が引けない (上の『直し方』の ① → ③)')
    // 県が引けない月 (県 null) も同じ文言 — 古い保存物と見分けられないので、パネルの ① に任せる
    expect(rateBasisStatus(basis({ minWageRate: null, minWagePrefecture: null })).message).toBe('判定できない: この月の最低賃金が引けない (上の『直し方』の ① → ③)')
  })

  it('単価の表示: 適用年月・県つき / 県なし / 適用開始なし (古い保存物) / 単価なし', () => {
    expect(rateBasisLabel(basis())).toBe('1,000円/h (2024-10 適用、架空県)')
    expect(rateBasisLabel(basis({ prefecture: null }))).toBe('1,000円/h (2024-10 適用)')
    expect(rateBasisLabel(basis({ effectiveFrom: null }))).toContain('1,000円/h (適用開始 不明')
    expect(rateBasisLabel(basis({ effectiveFrom: null, prefecture: null }))).not.toContain('、')
    expect(rateBasisLabel(basis({ hourlyRate: null }))).toBe('単価なし (単価マスタに無い)')
  })

  it('最低賃金の表示: 県・発効なし', () => {
    expect(minWageBasisLabel({ minWageRate: 1000, minWagePrefecture: null, minWageEffectiveFrom: null })).toBe('1,000円/h (発効 不明)')
  })
})

describe('rateBasisPeriods (紙面の「計算に使った単価」一覧)', () => {
  const b = (over: Partial<SalaryRateBasis> = {}): SalaryRateBasis => ({
    hourlyRate: 1000, effectiveFrom: '2024-10-05', prefecture: '架空県',
    minWageRate: 1000, minWagePrefecture: '架空県', minWageEffectiveFrom: '2024-10-01', ...over,
  })
  const row = (driverCd: string, month: string, basis: SalaryRateBasis | null): LitigationSalaryRow => ({
    driverCd, month, payMonth: month, state: basis ? 'ok' : 'unknown', message: '', payrollNote: '',
    compared: basis ? ({ rateBasis: basis } as unknown as SalaryComparisonRow) : null,
  })

  it('同じ単価 (額・適用開始・県) が続く月を 1 期間にまとめ、単価が変わったら切る', () => {
    const ps = rateBasisPeriods([row('9001', '2025-01', b()), row('9001', '2025-02', b()), row('9001', '2025-03', b({ hourlyRate: 1050, effectiveFrom: '2025-03-01', minWageRate: 1050 }))])
    expect(ps).toHaveLength(2)
    expect(ps[0]).toMatchObject({ driverCd: '9001', from: '2025-01', to: '2025-02', hourlyRate: 1000, effectiveFrom: '2024-10-05', prefecture: '架空県', months: 2, mismatchMonths: 0, unknownMonths: 0, mismatchMinWages: [] })
    expect(ps[1]).toMatchObject({ from: '2025-03', to: '2025-03', hourlyRate: 1050, months: 1 })
  })

  it('額が同じでも適用開始日や県が違えば別の期間', () => {
    expect(rateBasisPeriods([row('9001', '2025-01', b()), row('9001', '2025-02', b({ effectiveFrom: '2025-02-01' })), row('9001', '2025-03', b({ effectiveFrom: '2025-02-01', prefecture: '別県' }))])).toHaveLength(3)
  })

  it('★ 比較できていない月 (compared なし) で期間を切る。間の月の単価は分からない', () => {
    const ps = rateBasisPeriods([row('9001', '2025-01', b()), row('9001', '2025-02', null), row('9001', '2025-03', b())])
    expect(ps.map(p => [p.from, p.to])).toEqual([['2025-01', '2025-01'], ['2025-03', '2025-03']])
  })

  it('乗務員が変われば同じ単価でも別の期間', () => {
    expect(rateBasisPeriods([row('9001', '2025-01', b()), row('9002', '2025-01', b())]).map(p => p.driverCd)).toEqual(['9001', '9002'])
  })

  it('★ 最低賃金と違う月数と、その最低賃金 (重複を除く) を持つ。上側の不一致も数える。判定できない月は別に数える', () => {
    const ps = rateBasisPeriods([
      row('9001', '2025-01', b({ hourlyRate: 1100, minWageRate: 1000 })),
      row('9001', '2025-02', b({ hourlyRate: 1100, minWageRate: 1000 })),
      row('9001', '2025-03', b({ hourlyRate: 1100, minWageRate: 1020, minWageEffectiveFrom: null, minWagePrefecture: null })),
      row('9001', '2025-04', b({ hourlyRate: 1100, minWageRate: null })),
      row('9001', '2025-05', b({ hourlyRate: 1100, minWageRate: 1100 })),
    ])
    expect(ps).toHaveLength(1)
    expect(ps[0]).toMatchObject({ months: 5, mismatchMonths: 3, unknownMonths: 1 })
    expect(ps[0]!.mismatchMinWages).toEqual(['架空県 1,000円/h (2024-10 発効)', '1,020円/h (発効 不明)'])
  })

  it('単価なしの月は unknown として期間に入る (hourlyRate null)', () => {
    const ps = rateBasisPeriods([row('9001', '2025-01', b({ hourlyRate: null, effectiveFrom: null, prefecture: null }))])
    expect(ps[0]).toMatchObject({ hourlyRate: null, unknownMonths: 1, mismatchMonths: 0 })
  })
})


describe('fmtSalaryDiff', () => {
  it('+ は明細の方が多い。0 は符号なし、計算できない (null) は「-」', () => {
    expect(fmtSalaryDiff(15000)).toBe('+15,000')
    expect(fmtSalaryDiff(-6667)).toBe('-6,667')
    expect(fmtSalaryDiff(0)).toBe('0')
    expect(fmtSalaryDiff(null)).toBe('-')
  })
})

describe('salaryRowCells: 基本給の内訳・計算の根拠 (Refs #1133)', () => {
  const base = {
    csvBase: 200000, csvOvertime: 30000, overtimeFixed: false,
    csvBaseItems: [{ label: '基本給', amount: 190000 }, { label: '通勤手当', amount: 10000 }],
    statutoryMinutes: 9000,
    sysBase: 150000, diffBase: 50000, sysOvertime: 14000, diffOvertime: 16000,
    rateBasis: { hourlyRate: 1000, minWageRate: 1000 },
    overtimeMinutes: 600,
    baseRateOvertimePay: 16667, baseRateActual: 1250, diffCsvVsBaseRateOvertime: 13333, csvPremiumBase: 200000,
    baseRateBasis: { kind: 'days', hours: 150, days: 20, daysSource: 'csv', capped: false, dailyMinutes: 450, scheduled: 'resolved', hourlyRate: null, none: null },
  } as unknown as SalaryComparisonRow
  const cells = (over: Record<string, unknown> = {}) => salaryRowCells({ ...base, ...over } as SalaryComparisonRow)

  it('★ 基本給の明細の内訳: 項目名「基本給」と それ以外 (手当) に分ける。手当が無ければ手当 0', () => {
    expect(cells().amounts[0]!.breakdown).toBe('うち基本給 190,000 / 手当 10,000')
    expect(cells({ csvBaseItems: [{ label: '基本給', amount: 200000 }] }).amounts[0]!.breakdown).toBe('うち基本給 200,000 / 手当 0')
    expect(cells({ csvBaseItems: [{ label: '精勤手当', amount: 5000 }] }).amounts[0]!.breakdown).toBe('うち基本給 0 / 手当 5,000')
    expect(cells().amounts[1]!.breakdown).toBeNull()
  })

  it('★ 基本給(計算) の根拠: 単価 × 法定時間内。最低賃金と一致する月は「最低賃金」。上回る月 (差が正) は負にならない', () => {
    const c = cells().amounts[0]!
    expect(c).toMatchObject({ sys: 150000, diff: 50000, basis: '最低賃金 1,000 円/h × 法定時間内 150h00m' })
  })

  it('★ 法定時間内の分が変われば根拠の時間も変わる (計算に使った時間 = wage report の法定時間内)', () => {
    expect(cells({ statutoryMinutes: 9820 }).amounts[0]!.basis).toBe('最低賃金 1,000 円/h × 法定時間内 163h40m')
  })

  it('単価マスタと最低賃金が違う月は「単価マスタ」と書く (最低賃金と呼ばない)。最低賃金が引けない月も同じ', () => {
    expect(cells({ rateBasis: { hourlyRate: 1000, minWageRate: 1100 } }).amounts[0]!.basis).toBe('単価マスタ 1,000 円/h × 法定時間内 150h00m')
    expect(cells({ rateBasis: { hourlyRate: 1000, minWageRate: null } }).amounts[0]!.basis).toContain('単価マスタ 1,000 円/h')
  })

  it('★ 単価が無い (金額が引けない) 月は計算なし: 理由 1 行で計算も差も null', () => {
    const none = cells({ sysBase: null, diffBase: null, rateBasis: { hourlyRate: null, minWageRate: 1000 } }).amounts[0]!
    expect(none).toMatchObject({ sys: null, diff: null, basis: '単価なし (単価マスタに単価が無い)' })
  })

  it('★ 残業(計算) = 行の最低賃金ベースの残業代、根拠は「最低賃金ベース × 残業時間 H」(単価マスタの名前も明細の残業単価も出さない)。引けなければ計算なし + 理由', () => {
    expect(cells().amounts[1]).toMatchObject({ sys: 14000, diff: 16000, basis: '最低賃金ベース × 残業時間 10h00m' })
    expect(cells({ rateBasis: { hourlyRate: 1200, minWageRate: 1000 } }).amounts[1]!.basis).toBe('最低賃金ベース × 残業時間 10h00m')
    expect(cells({ sysOvertime: null, diffOvertime: null }).amounts[1]).toMatchObject({ sys: null, diff: null, basis: '最低賃金ベースの残業代なし (最低賃金が引けない)' })
  })
})
