import { describe, it, expect } from 'vitest'

import {
  ADJUSTMENT_ITEM_LABEL,
  adjustmentWorkMonths,
  bonusToSalaryRows,
  buildAdjustmentRows,
  describeBonusFreshness,
  hasShortfallOrAdjustment,
  judgeAdjustment,
  sumAdjustments,
  yearMonths,
  yearShortfall,
  type AdjustmentSourceRow,
  type DriverAdjustment,
} from '~/utils/min-wage-adjustment'
import type { SalaryCdMap, SalaryCsvRow } from '~/utils/salary-compare'
import { salaryCdMapKey } from '~/utils/salary-compare'
import type { WageRangeAmounts, WageRangeRow } from '~/utils/wage-range-view'

// 金額・氏名はすべてダミー (public repo。実在の人・金額を写さない)

function amt(paidTotal: number, calcTotal: number): WageRangeAmounts {
  return {
    calcBase: calcTotal,
    calcOvertime: 0,
    calcTotal,
    paidBase: paidTotal,
    paidOvertime: 0,
    hourlyRate: 1000,
    workingMinutes: 10_000,
  }
}

function rangeRow(driverCd: string, byMonth: Record<string, WageRangeAmounts>): WageRangeRow {
  return {
    driverCd,
    driverName: `仮名 ${driverCd}`,
    attrs: { company: '0100', branchName: '本社', branchCode: 1, jobName: '乗務員' },
    monthsCounted: Object.keys(byMonth).length,
    monthsMissing: [],
    byMonth,
    calcBase: 0,
    calcOvertime: 0,
    calcTotal: 0,
    paidBase: 0,
    paidOvertime: 0,
    workingMinutes: 0,
  }
}

function fullYear(year: number, diffs: number[]): Record<string, WageRangeAmounts> {
  const out: Record<string, WageRangeAmounts> = {}
  diffs.forEach((d, i) => {
    out[`${year}-${String(i + 1).padStart(2, '0')}`] = amt(100_000 + d, 100_000)
  })
  return out
}

function salaryRow(over: Partial<SalaryCsvRow>): SalaryCsvRow {
  return {
    driverCd: '0101',
    cdKey: '101',
    company: '0100',
    driverName: '仮名 一郎',
    month: '2025-08',
    amounts: { [ADJUSTMENT_ITEM_LABEL]: 10_000 },
    reportedTotal: null,
    rates: { base: null, overtime: null },
    ...over,
  }
}

const EMPTY_MAP: SalaryCdMap = { entries: {} }

describe('yearMonths / adjustmentWorkMonths', () => {
  it('勤務月 1〜12 月', () => {
    expect(yearMonths(2025)).toEqual([
      '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06',
      '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
    ])
  })

  it('支給日の年が Y になる月例の勤務月 = 前年 12 月〜当年 11 月', () => {
    const ms = adjustmentWorkMonths(2025)
    expect(ms).toHaveLength(12)
    expect(ms[0]).toBe('2024-12')
    expect(ms[11]).toBe('2025-11')
  })
})

describe('yearShortfall', () => {
  it('差がマイナスの月だけを足し、プラスの月で相殺しない', () => {
    const row = rangeRow('7', fullYear(2025, [-1000, 500, 0, -250, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(yearShortfall(row, 2025)).toEqual({
      shortfall: 1250,
      shortfallMonths: ['2025-01', '2025-04'],
      countedMonths: 12,
      missingMonths: [],
    })
  })

  it('集計に入らなかった月は 0 円でなく未集計に数える (別の年の月も数えない)', () => {
    const row = rangeRow('7', { '2025-03': amt(90_000, 100_000), '2024-12': amt(0, 100_000) })
    const s = yearShortfall(row, 2025)
    expect(s.shortfall).toBe(10_000)
    expect(s.countedMonths).toBe(1)
    expect(s.missingMonths).toHaveLength(11)
    expect(s.missingMonths).not.toContain('2025-03')
  })
})

describe('bonusToSalaryRows', () => {
  it('単価の無い賞与行を給与比較の行の形にし、支給日の月で持つ', () => {
    const rows: AdjustmentSourceRow[] = [
      { employee_code: '0101', employee_code_key: '101', employee_name: '仮名 一郎', pay_date: '2025-12-10', payments: { [ADJUSTMENT_ITEM_LABEL]: 30_000, 賞与: 100_000 } },
      { employee_code: '0102', employee_code_key: '102', employee_name: '仮名 二郎', pay_date: '', payments: { 賞与: 1 } },
    ]
    const out = bonusToSalaryRows(rows, '0100')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      company: '0100',
      cdKey: '101',
      month: '2025-12',
      amounts: { [ADJUSTMENT_ITEM_LABEL]: 30_000 },
      rates: { base: null, overtime: null },
      reportedTotal: null,
    })
  })
})

describe('sumAdjustments', () => {
  it('賞与と月例を分けて足し、支給日の年が違う行・0 円・項目なしは数えない', () => {
    const got = sumAdjustments(
      [
        {
          kind: 'bonus',
          rows: [
            salaryRow({ month: '2025-08' }),
            salaryRow({ month: '2025-12', amounts: { [ADJUSTMENT_ITEM_LABEL]: 5_000 } }),
            salaryRow({ month: '2024-12' }),
          ],
        },
        {
          kind: 'payroll',
          rows: [
            salaryRow({ month: '2025-01', amounts: { [ADJUSTMENT_ITEM_LABEL]: 2_000 } }),
            salaryRow({ month: '2025-02', amounts: { [ADJUSTMENT_ITEM_LABEL]: 0 } }),
            salaryRow({ month: '2025-03', amounts: { 基本給: 1 } }),
          ],
        },
      ],
      EMPTY_MAP,
      2025,
    )
    expect([...got.entries()]).toEqual([['101', { bonus: 15_000, payroll: 2_000, driverName: '仮名 一郎' }]])
  })

  it('給与社員CD は対応表で乗務員CD に寄せる (N:1 の 2 コードが 1 人に畳まれる)', () => {
    const cdMap: SalaryCdMap = {
      entries: {
        [salaryCdMapKey('0101', '仮名 一郎', '0100')]: '0042',
        [salaryCdMapKey('0505', '仮名 一郎', '0200')]: '42',
      },
    }
    const got = sumAdjustments(
      [{
        kind: 'bonus',
        rows: [
          salaryRow({}),
          salaryRow({ driverCd: '0505', cdKey: '505', company: '0200', amounts: { [ADJUSTMENT_ITEM_LABEL]: 1_000 } }),
        ],
      }],
      cdMap,
      2025,
    )
    expect(got.get('42')).toEqual({ bonus: 11_000, payroll: 0, driverName: '仮名 一郎' })
    expect(got.size).toBe(1)
  })

  it('乗務員CD が数字でない (対応表外の文字コード) ときはそのままのキー', () => {
    const got = sumAdjustments(
      [{ kind: 'payroll', rows: [salaryRow({ cdKey: 'A1', driverCd: 'A1', month: '2025-05' })] }],
      EMPTY_MAP,
      2025,
    )
    expect([...got.keys()]).toEqual(['A1'])
  })
})

describe('judgeAdjustment', () => {
  it('不足なし', () => {
    expect(judgeAdjustment(0, 0, 0)).toEqual({ status: 'no-shortfall', remaining: 0, incomplete: false, label: '不足なし' })
  })

  it('不足合計 ≤ 補填合計 なら補填済み (ちょうど同額も)', () => {
    expect(judgeAdjustment(1000, 1000, 0)).toEqual({ status: 'covered', remaining: 0, incomplete: false, label: '補填済み' })
  })

  it('超えた分を残りの不足として出す', () => {
    expect(judgeAdjustment(12_345, 2_000, 0)).toEqual({ status: 'short', remaining: 10_345, incomplete: false, label: '残り不足 10,345 円' })
  })

  it('未集計の月があるときは言い切らない', () => {
    const j = judgeAdjustment(1000, 5000, 3)
    expect(j.status).toBe('covered')
    expect(j.incomplete).toBe(true)
    expect(j.label).toBe('補填済み (3 か月未集計のため確定でない)')
  })
})

describe('buildAdjustmentRows', () => {
  it('期間集計の人と補填だけある人の両方を出す', () => {
    const adjustments = new Map<string, DriverAdjustment>([
      ['7', { bonus: 800, payroll: 100, driverName: '仮名 七' }],
      ['99', { bonus: 0, payroll: 500, driverName: '仮名 九九' }],
    ])
    const rows = buildAdjustmentRows(
      [
        rangeRow('0007', fullYear(2025, [-1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
        rangeRow('8', fullYear(2025, Array(12).fill(0))),
      ],
      adjustments,
      2025,
    )
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ driverCd: '0007', bonus: 800, payroll: 100, adjustment: 900 })
    expect(rows[0]!.judgement).toMatchObject({ status: 'short', remaining: 100 })
    expect(rows[1]).toMatchObject({ driverCd: '8', adjustment: 0 })
    expect(rows[1]!.judgement.status).toBe('no-shortfall')
    expect(rows[2]).toMatchObject({ driverCd: '99', driverName: '仮名 九九', attrs: null, shortfall: null, adjustment: 500 })
    // 不足は 0 ではなく数えられない — 「不足なし」と書かない
    expect(rows[2]!.judgement).toMatchObject({ status: 'unmatched', incomplete: true })
    expect(rows[2]!.judgement.label).not.toContain('不足なし')

    expect(rows.map(hasShortfallOrAdjustment)).toEqual([true, false, true])
  })
})

describe('describeBonusFreshness', () => {
  it('source / synced_at の無い応答 (今の本番) は何も出さない', () => {
    expect(describeBonusFreshness([{ company: '0100', syncedAt: null }])).toBe('')
  })

  it('保存済み・直接・時刻だけ の書き分け', () => {
    expect(describeBonusFreshness([
      { company: '0100', source: 'cache', syncedAt: '2025-12-11T00:00:00Z' },
      { company: '0200', source: 'live', syncedAt: null },
      { company: '0300', syncedAt: '2025-12-12T00:00:00Z' },
    ])).toBe('0100: 保存済み 同期 2025-12-11T00:00:00Z / 0200: 給与大臣から直接 / 0300: 同期 2025-12-12T00:00:00Z')
  })
})
