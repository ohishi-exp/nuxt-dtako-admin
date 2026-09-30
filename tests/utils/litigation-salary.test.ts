/**
 * 訴訟準備の「給与比較」タブの pure ロジック (`app/utils/litigation-salary.ts`)。
 *
 * - 比較そのものは拘束×賃金と同じ `compareSalaryMonth` に任せる (支給月 = 勤務月の翌月で合わせる)
 * - 材料が取れていない・明細に居ない・引き当てが衝突 を「比較済み」と同じ見た目にしない
 */
import { describe, it, expect } from 'vitest'
import { buildLitigationSalaryRows, litigationPayrollMonths, type LitigationSalaryInput } from '~/utils/litigation-salary'
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
    driverCds: ['1590'],
    months: ['2023-06'],
    wageReports: new Map([['1590|2023-06', wage([reportRow('1590', '髙浪 久典')])]]),
    payroll: new Map([['2023-07', { ok: true, value: [pay('1590', '髙浪 久典', '2023-07')] }]]),
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
    expect(row).toMatchObject({ driverCd: '1590', month: '2023-06', payMonth: '2023-07', state: 'ok' })
    expect(row!.compared).toMatchObject({ csvBase: 200000, sysBase: 200000, diffBase: 0, csvOvertime: 30000, sysOvertime: 15000, diffOvertime: 15000 })
  })

  it('★ 同じ月の明細でも支給月がずれていれば (勤務月ラベルの明細) 突き合わせない', () => {
    const [row] = buildLitigationSalaryRows(input({ payroll: new Map([['2023-07', { ok: true, value: [pay('1590', '髙浪 久典', '2023-06')] }]]) }))
    expect(row!.state).toBe('noPayroll')
    expect(row!.message).toContain('2023-07 支給の明細にこの乗務員が居ない')
  })

  it('給与コードが乗務員CD と別体系でも、社員マスタの引き当てで比較する', () => {
    const [row] = buildLitigationSalaryRows(input({
      payroll: new Map([['2023-07', { ok: true, value: [pay('747', '髙浪 久典', '2023-07')] }]]),
      cdMap: { entries: { '0200|747|髙浪久典': '1590' } },
    }))
    expect(row!.state).toBe('ok')
  })

  it('拘束の材料: 未取得 / 取れていない / この乗務員の行が無い を言い分ける', () => {
    expect(buildLitigationSalaryRows(input({ wageReports: new Map() }))[0]).toMatchObject({ state: 'pending', message: '拘束の材料が未取得 (9/29 以前の古い形の保存も含む) — 「拘束の材料を取る」' })
    expect(buildLitigationSalaryRows(input({ wageReports: new Map([['1590|2023-06', { ok: false, reason: '504' }]]) }))[0]).toMatchObject({ state: 'unknown', message: '拘束の材料が取れていない: 504' })
    expect(buildLitigationSalaryRows(input({ wageReports: new Map([['1590|2023-06', wage([])]]) }))[0]!.state).toBe('unknown')
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
    expect(buildLitigationSalaryRows(input({ wageReports: new Map([['1590|2023-06', { ok: false, reason: '504' }]]) }))[0]!.payrollNote).toBe('明細: 読込済み')
    expect(buildLitigationSalaryRows(input({ wageReports: new Map([['1590|2023-06', wage([])]]) }))[0]!.payrollNote).toBe('明細: 読込済み')
  })

  it('★ 材料が有って先へ進んだ行は payrollNote を出さない (message が明細の状況を言っている)', () => {
    expect(buildLitigationSalaryRows(input())[0]!.payrollNote).toBe('')
    expect(buildLitigationSalaryRows(input({ payroll: new Map() }))[0]).toMatchObject({ message: expect.stringContaining('未読込'), payrollNote: '' })
    expect(buildLitigationSalaryRows(input({ payroll: new Map([['2023-07', { ok: false, reason: 'x' }]]) }))[0]!.payrollNote).toBe('')
  })

  it('★ 氏名の違う給与行が同じ乗務員に引き当たったら比較せず「比較できない」', () => {
    const [row] = buildLitigationSalaryRows(input({
      payroll: new Map([['2023-07', { ok: true, value: [pay('1590', '髙浪 久典', '2023-07'), pay('9', '別人 太郎', '2023-07', { company: '0100' })] }]]),
      cdMap: { entries: { '0100|9|別人太郎': '1590', '0200|1590|髙浪久典': '1590' } },
    }))
    expect(row!.state).toBe('unknown')
    expect(row!.message).toContain('社員マスタで直す')
  })

  it('並びは乗務員ごと・月の古い順', () => {
    const rows = buildLitigationSalaryRows(input({ driverCds: ['1590', '1078'], months: ['2023-06', '2023-07'] }))
    expect(rows.map(r => `${r.driverCd}|${r.month}`)).toEqual(['1590|2023-06', '1590|2023-07', '1078|2023-06', '1078|2023-07'])
  })
})
