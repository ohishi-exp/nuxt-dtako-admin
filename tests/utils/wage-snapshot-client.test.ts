import { describe, it, expect } from 'vitest'

import {
  buildSnapshotPayload,
  contentHash,
  driverCdNumber,
  rateForMonthFromMaster,
  stableStringify,
  WAGE_LOGIC_VERSION,
  type SnapshotSourceRow,
} from '~/utils/wage-snapshot-client'
import type { MinWageMaster, WageMaster } from '~/utils/restraint-wage-view'
import type { SalaryItemConfig } from '~/utils/salary-compare'

const ITEM_CONFIG: SalaryItemConfig = { items: { 基本給: 'base', 残業手当: 'overtime' } } as SalaryItemConfig
const MIN_WAGE: MinWageMaster = {
  prefectures: { 全社共通: [{ effectiveFrom: '2025-10-01', rate: 1000 }] },
  branchToPrefecture: {},
}

function sourceRow(over: Partial<SnapshotSourceRow> = {}): SnapshotSourceRow {
  return {
    driverCd: '1035',
    driverName: '山田 太郎',
    hourlyRate: 1420,
    calcBase: 213500,
    calcOvertime: 86200,
    calcTotal: 299700,
    paidBase: 210000,
    paidOvertime: 84000,
    workingMinutes: 11820,
    restraintMissing: false,
    attrs: { company: '0200', branchCode: 210, branchName: '本社', jobName: '乗務員' },
    payKubun: 1,
    ...over,
  }
}

function build(rows: SnapshotSourceRow[], payrollSyncedAt: string | null = '2026-02-03T09:12:00Z') {
  return buildSnapshotPayload({
    compId: 'comp-a',
    month: '2026-01',
    restraintSource: 'gcp',
    rows,
    salaryItemConfig: ITEM_CONFIG,
    minWageMaster: MIN_WAGE,
    payrollSyncedAt,
  })
}

describe('stableStringify', () => {
  /** キーの並びが変わっただけで別物と判定されると、全月が無意味に stale になる。 */
  it('キー順に依存しない', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify({ x: { q: 1, p: 2 } })).toBe(stableStringify({ x: { p: 2, q: 1 } }))
  })

  /** 配列は**順序に意味がある** (単価履歴は適用開始日順) ので保つ。 */
  it('配列の順序は保つ', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  it('primitive と null を扱える', () => {
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(3)).toBe('3')
    expect(stableStringify('a')).toBe('"a"')
    expect(stableStringify(true)).toBe('true')
  })

  it('undefined のプロパティは無視する', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }))
  })

  it('undefined 単体は null になる (JSON.stringify の挙動を潰す)', () => {
    expect(stableStringify(undefined)).toBe('null')
  })
})

describe('contentHash', () => {
  it('同じ内容は同じ、違えば違う', () => {
    expect(contentHash({ a: 1 })).toBe(contentHash({ a: 1 }))
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }))
  })

  it('キー順が違っても同じ', () => {
    expect(contentHash({ a: 1, b: 2 })).toBe(contentHash({ b: 2, a: 1 }))
  })

  it('8 桁 hex を返す', () => {
    expect(contentHash({ a: 1 })).toMatch(/^[0-9a-f]{8}$/)
    expect(contentHash('')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('driverCdNumber', () => {
  it('前ゼロを除いた整数にする', () => {
    expect(driverCdNumber('01035')).toBe(1035)
    expect(driverCdNumber('1035')).toBe(1035)
  })

  it('整数にならないものは null', () => {
    expect(driverCdNumber('abc')).toBeNull()
    expect(driverCdNumber('')).toBe(0) // 空文字は Number('') = 0。呼び出し側では起きない
    expect(driverCdNumber('10.5')).toBeNull()
    expect(driverCdNumber('Infinity')).toBeNull()
  })
})

describe('buildSnapshotPayload', () => {
  it('画面の 1 行をサーバの 1 行に写す', () => {
    const { payload, skipped } = build([sourceRow()])

    expect(skipped).toEqual([])
    expect(payload.comp_id).toBe('comp-a')
    expect(payload.month).toBe('2026-01')
    expect(payload.restraint_source).toBe('gcp')
    expect(payload.wage_logic_version).toBe(WAGE_LOGIC_VERSION)
    expect(payload.masters.payroll_synced_at).toBe('2026-02-03T09:12:00Z')
    expect(payload.masters.salary_item_sha).toMatch(/^[0-9a-f]{8}$/)
    expect(payload.masters.min_wage_sha).toMatch(/^[0-9a-f]{8}$/)
    expect(payload.rows).toEqual([{
      driver_cd: 1035,
      driver_name: '山田 太郎',
      company: '0200',
      branch_name: '本社',
      branch_code: 210,
      job_name: '乗務員',
      pay_kubun: 1,
      hourly_rate: 1420,
      calc_base: 213500,
      calc_overtime: 86200,
      calc_total: 299700,
      paid_base: 210000,
      paid_overtime: 84000,
      working_minutes: 11820,
      restraint_missing: false,
    }])
  })

  /** 社員マスタで引けない人も表には出ているので、属性 null のまま送る。 */
  it('属性が引けない行は null で埋める', () => {
    const { payload } = build([sourceRow({ attrs: null, payKubun: null })])
    expect(payload.rows[0]).toMatchObject({
      company: null, branch_name: null, branch_code: null, job_name: null, pay_kubun: null,
    })
  })

  /**
   * 欠測・単価未設定・給与に無い行も**そのまま送る**。集計から外すかはサーバの規則が
   * 決める — ここで落とすと「その月にその人が居なかった」と区別が付かなくなる。
   */
  it('欠測・単価未設定・給与未取込の行も送る', () => {
    const { payload } = build([
      sourceRow({ driverCd: '1', restraintMissing: true }),
      sourceRow({ driverCd: '2', hourlyRate: null, calcBase: null, calcOvertime: null, calcTotal: null }),
      sourceRow({ driverCd: '3', paidBase: null, paidOvertime: null }),
    ])
    expect(payload.rows).toHaveLength(3)
    expect(payload.rows[0]!.restraint_missing).toBe(true)
    expect(payload.rows[1]!.calc_total).toBeNull()
    expect(payload.rows[2]!.paid_base).toBeNull()
  })

  /** サーバの主キーは BIGINT。数値にならない CD は送れないが、黙って減らさない。 */
  it('乗務員CD が数値にならない行は落とし、skipped で数える', () => {
    const { payload, skipped } = build([sourceRow(), sourceRow({ driverCd: 'X-9' })])
    expect(payload.rows).toHaveLength(1)
    expect(skipped).toEqual(['X-9'])
  })

  it('前ゼロ違いで同じ番号になる行は 1 つだけ送る', () => {
    const { payload, skipped } = build([sourceRow({ driverCd: '1035' }), sourceRow({ driverCd: '01035' })])
    expect(payload.rows).toHaveLength(1)
    expect(skipped).toEqual(['01035'])
  })

  it('金額は整数に丸める', () => {
    const { payload } = build([sourceRow({ calcBase: 1000.4, calcTotal: 2000.6, hourlyRate: 1420.5 })])
    expect(payload.rows[0]!.calc_base).toBe(1000)
    expect(payload.rows[0]!.calc_total).toBe(2001)
    expect(payload.rows[0]!.hourly_rate).toBe(1421)
  })

  it('NaN は null にする (0 円として保存しない)', () => {
    const { payload } = build([sourceRow({ calcTotal: Number.NaN, workingMinutes: Number.NaN })])
    expect(payload.rows[0]!.calc_total).toBeNull()
    expect(payload.rows[0]!.working_minutes).toBeNull()
  })

  it('給与を取り込んでいない月は payroll_synced_at が null', () => {
    const { payload } = build([sourceRow()], null)
    expect(payload.masters.payroll_synced_at).toBeNull()
  })

  /** マスタが動けば sha が変わる = その月が「要再計算」になる。 */
  it('支給項目区分が変わると salary_item_sha が変わる', () => {
    const a = build([sourceRow()]).payload.masters.salary_item_sha
    const b = buildSnapshotPayload({
      compId: 'comp-a',
      month: '2026-01',
      restraintSource: 'gcp',
      rows: [sourceRow()],
      salaryItemConfig: { items: { 基本給: 'overtime' } } as SalaryItemConfig,
      minWageMaster: MIN_WAGE,
      payrollSyncedAt: null,
    }).payload.masters.salary_item_sha
    expect(a).not.toBe(b)
  })

  it('行が 0 件でも payload は作る (その月に対象者が居ない、を保存できる)', () => {
    const { payload } = build([])
    expect(payload.rows).toEqual([])
  })
})

describe('rateForMonthFromMaster', () => {
  const master: WageMaster = {
    drivers: {
      1035: {
        rates: [
          { effectiveFrom: '2025-04-01', hourlyRate: 1300 },
          { effectiveFrom: '2026-01-01', hourlyRate: 1420 },
        ],
      },
    },
  }

  it('その月に適用される単価を返す (適用開始日つき履歴)', () => {
    expect(rateForMonthFromMaster(master, '1035', '2025-12')).toBe(1300)
    expect(rateForMonthFromMaster(master, '1035', '2026-01')).toBe(1420)
    expect(rateForMonthFromMaster(master, '1035', '2026-06')).toBe(1420)
  })

  it('適用開始より前の月は null', () => {
    expect(rateForMonthFromMaster(master, '1035', '2025-03')).toBeNull()
  })

  it('マスタに居ない乗務員は null', () => {
    expect(rateForMonthFromMaster(master, '9999', '2026-01')).toBeNull()
    expect(rateForMonthFromMaster({ drivers: {} }, '1035', '2026-01')).toBeNull()
  })
})
