import { describe, it, expect } from 'vitest'

import {
  defaultRange,
  describeApiError,
  monthBadgeLabel,
  monthCellState,
  monthDiff,
  monthsNeedingRefresh,
  parseWageRange,
  rangeDiff,
  sumWageRangeRows,
  wageRangeCsv,
  type WageRangeMonth,
  type WageRangeRow,
} from '~/utils/wage-range-view'

function amounts(over: Record<string, number | null> = {}) {
  return {
    calc_base: 200_000,
    calc_overtime: 80_000,
    calc_total: 280_000,
    paid_base: 198_000,
    paid_overtime: 78_000,
    hourly_rate: 1420,
    ...over,
  }
}

const BODY = {
  from: '2026-01',
  to: '2026-03',
  restraint_source: 'gcp',
  months: [
    { ym: '2026-01', saved: true, drivers: 2, computed_at: '2026-08-05T01:20:00Z', stale: false },
    { ym: '2026-02', saved: true, drivers: 0, computed_at: '2026-08-05T01:21:00Z', stale: true, stale_reason: ['salary_item'], excluded: 'payroll_missing' },
    { ym: '2026-03', saved: false },
  ],
  rows: [
    {
      driver_cd: 1035,
      driver_name: '山田 太郎',
      company: '0200',
      branch_name: '本社',
      branch_code: 210,
      job_name: '乗務員',
      months_counted: 1,
      months_missing: [],
      by_month: { '2026-01': amounts() },
      calc_base: 200_000,
      calc_overtime: 80_000,
      calc_total: 280_000,
      paid_base: 198_000,
      paid_overtime: 78_000,
      working_minutes: 11_820,
    },
  ],
}

function row(over: Partial<WageRangeRow> = {}): WageRangeRow {
  return {
    driverCd: '1035',
    driverName: '山田',
    attrs: { company: '0200', branchCode: 210, branchName: '本社', jobName: '乗務員' },
    monthsCounted: 1,
    monthsMissing: [],
    byMonth: {
      '2026-01': {
        calcBase: 200_000, calcOvertime: 80_000, calcTotal: 280_000,
        paidBase: 198_000, paidOvertime: 78_000, hourlyRate: 1420,
      },
    },
    calcBase: 200_000,
    calcOvertime: 80_000,
    calcTotal: 280_000,
    paidBase: 198_000,
    paidOvertime: 78_000,
    workingMinutes: 11_820,
    ...over,
  }
}

function month(over: Partial<WageRangeMonth> = {}): WageRangeMonth {
  return {
    ym: '2026-01',
    saved: true,
    drivers: 1,
    computedAt: '2026-08-05T01:20:00Z',
    stale: false,
    staleReason: [],
    excluded: null,
    ...over,
  }
}

describe('parseWageRange', () => {
  it('応答を画面の形に写す', () => {
    const parsed = parseWageRange(BODY)
    expect(parsed.from).toBe('2026-01')
    expect(parsed.restraintSource).toBe('gcp')
    expect(parsed.months).toHaveLength(3)
    expect(parsed.months[1]!.excluded).toBe('payroll_missing')
    expect(parsed.months[1]!.staleReason).toEqual(['salary_item'])
    expect(parsed.months[2]!.saved).toBe(false)
    expect(parsed.rows[0]!.driverCd).toBe('1035')
    expect(parsed.rows[0]!.attrs.branchCode).toBe(210)
    expect(parsed.rows[0]!.byMonth['2026-01']!.calcTotal).toBe(280_000)
  })

  /** 壊れた応答で画面を落とさない (期間集計が出ないだけにする)。 */
  it('壊れていても落ちない', () => {
    expect(parseWageRange(null).rows).toEqual([])
    expect(parseWageRange({}).months).toEqual([])
    expect(parseWageRange({ months: 'x', rows: 3 }).rows).toEqual([])
    const junk = parseWageRange({ rows: [{ driver_cd: null, by_month: null, months_missing: 'x' }] })
    expect(junk.rows[0]!.driverCd).toBe('')
    expect(junk.rows[0]!.byMonth).toEqual({})
    expect(junk.rows[0]!.monthsMissing).toEqual([])
    expect(junk.rows[0]!.calcTotal).toBe(0)
  })

  /** 配列の中身が null でも落ちない (`row ?? {}` / `v ?? {}` の枝)。 */
  it('rows / by_month の要素が null でも落ちない', () => {
    const parsed = parseWageRange({
      months: [null],
      rows: [null, { driver_cd: 1, by_month: { '2026-01': null } }],
    })
    expect(parsed.months[0]!.ym).toBe('')
    expect(parsed.rows[0]!.driverCd).toBe('')
    expect(parsed.rows[1]!.byMonth['2026-01']).toEqual({
      calcBase: null, calcOvertime: null, calcTotal: null,
      paidBase: null, paidOvertime: null, hourlyRate: null,
    })
  })

  it('restraint_source が無ければ gcp とみなす', () => {
    expect(parseWageRange({}).restraintSource).toBe('gcp')
  })

  it('stale を渡していない月は null (判定していない)', () => {
    const parsed = parseWageRange({ months: [{ ym: '2026-01', saved: true }] })
    expect(parsed.months[0]!.stale).toBeNull()
    expect(parsed.months[0]!.computedAt).toBeNull()
  })
})

describe('monthDiff', () => {
  it('給与 − 計算 を 3 段で出す', () => {
    const d = monthDiff(row().byMonth['2026-01'])
    expect(d).toEqual({ base: -2_000, overtime: -2_000, total: -4_000 })
  })

  /** 集計に入っていない月は 0 ではなく null (「-」)。 */
  it('月が無ければ全 null', () => {
    expect(monthDiff(undefined)).toEqual({ base: null, overtime: null, total: null })
  })

  it('片側が無ければその段は null', () => {
    const d = monthDiff({
      calcBase: 100, calcOvertime: 50, calcTotal: 150,
      paidBase: null, paidOvertime: 40, hourlyRate: null,
    })
    expect(d.base).toBeNull()
    expect(d.overtime).toBe(-10)
    expect(d.total).toBeNull() // paid 合計が出せない
  })
})

describe('rangeDiff', () => {
  it('期間合計の差を出す', () => {
    expect(rangeDiff(row())).toEqual({ base: -2_000, overtime: -2_000, total: -4_000 })
  })

  /** 合計 0 と「1 か月も集計できていない」を混同しない。 */
  it('集計月数 0 なら全 null', () => {
    expect(rangeDiff(row({ monthsCounted: 0 }))).toEqual({ base: null, overtime: null, total: null })
  })

  /** **月ごとの差の合計 == 期間合計の差** (横に並べた値と右端が合う)。 */
  it('月ごとの差の合計と一致する', () => {
    const r = row({
      monthsCounted: 2,
      byMonth: {
        '2026-01': { calcBase: 100, calcOvertime: 50, calcTotal: 150, paidBase: 90, paidOvertime: 60, hourlyRate: null },
        '2026-02': { calcBase: 200, calcOvertime: 80, calcTotal: 280, paidBase: 210, paidOvertime: 70, hourlyRate: null },
      },
      calcBase: 300, calcOvertime: 130, calcTotal: 430, paidBase: 300, paidOvertime: 130,
    })
    const monthly = ['2026-01', '2026-02']
      .map(m => monthDiff(r.byMonth[m]).total ?? 0)
      .reduce((a, b) => a + b, 0)
    expect(monthly).toBe(rangeDiff(r).total)
  })
})

describe('sumWageRangeRows', () => {
  it('行を合算し、月ごとの差も合計する', () => {
    const rows = [row(), row({ driverCd: '2042' })]
    const t = sumWageRangeRows(rows, ['2026-01', '2026-02'])
    expect(t.drivers).toBe(2)
    expect(t.calcTotal).toBe(560_000)
    expect(t.paidBase).toBe(396_000)
    expect(t.diffByMonth['2026-01']).toBe(-8_000)
    expect(t.diff.total).toBe(-8_000)
  })

  /** 集計に入った行が 1 つも無い月は 0 ではなく null (「その月は出せない」)。 */
  it('誰も集計できていない月は null', () => {
    const t = sumWageRangeRows([row()], ['2026-01', '2026-09'])
    expect(t.diffByMonth['2026-09']).toBeNull()
  })

  it('行が 0 件なら合計も 0 で差は null', () => {
    const t = sumWageRangeRows([], ['2026-01'])
    expect(t.drivers).toBe(0)
    expect(t.calcTotal).toBe(0)
    expect(t.diff.total).toBeNull()
    expect(t.diffByMonth['2026-01']).toBeNull()
  })
})

describe('monthCellState', () => {
  it('集計に入った月は counted', () => {
    expect(monthCellState(row(), month())).toBe('counted')
  })

  it('未保存の月は unsaved', () => {
    expect(monthCellState(row(), month({ saved: false }))).toBe('unsaved')
    expect(monthCellState(row(), undefined)).toBe('unsaved')
  })

  /** 月ごと外れたのは**行の責任ではない**ので missing と区別する。 */
  it('月ごと外れていれば excluded', () => {
    expect(monthCellState(row(), month({ excluded: 'payroll_missing' }))).toBe('excluded')
  })

  it('月は対象だがその人だけ欠けていれば missing', () => {
    expect(monthCellState(row(), month({ ym: '2026-05' }))).toBe('missing')
  })
})

describe('monthBadgeLabel', () => {
  it('状態ごとのラベル', () => {
    expect(monthBadgeLabel(month())).toBe('保存済')
    expect(monthBadgeLabel(month({ saved: false }))).toBe('未保存')
    expect(monthBadgeLabel(month({ excluded: 'payroll_missing' }))).toBe('給与未取込')
    expect(monthBadgeLabel(month({ excluded: 'other' }))).toBe('集計外')
    expect(monthBadgeLabel(month({ stale: true }))).toBe('要再計算')
  })
})

describe('monthsNeedingRefresh', () => {
  it('未保存と要再計算の月を挙げる', () => {
    const months = [
      month({ ym: '2026-01' }),
      month({ ym: '2026-02', stale: true }),
      month({ ym: '2026-03', saved: false }),
      month({ ym: '2026-04', stale: null }),
    ]
    expect(monthsNeedingRefresh(months)).toEqual(['2026-02', '2026-03'])
  })
})

describe('wageRangeCsv', () => {
  it('月ごとの差と期間合計を出す', () => {
    const csv = wageRangeCsv([row()], ['2026-01', '2026-02'])
    const [head, line] = csv.split('\n')
    expect(head).toContain('2026-01 差')
    expect(head).toContain('差 合計')
    expect(line).toContain('1035')
    // 集計に入っていない 2026-02 は空欄 (0 と区別する)
    expect(line!.split(',')[7]).toBe('')
  })

  /** 社員マスタで引けない人 (属性が全部 null) も落とさず空欄で出す。 */
  it('属性が null の行も空欄で出す', () => {
    const csv = wageRangeCsv([row({
      attrs: { company: null, branchCode: null, branchName: null, jobName: null },
    })], [])
    const cells = csv.split('\n')[1]!.split(',')
    expect(cells[2]).toBe('')
    expect(cells[3]).toBe('')
    expect(cells[4]).toBe('')
  })

  it('カンマや引用符を含む氏名を壊さない', () => {
    const csv = wageRangeCsv([row({ driverName: '山田, "太郎"' })], [])
    expect(csv).toContain('"山田, ""太郎"""')
  })
})

describe('defaultRange', () => {
  /** ユーザー決定 2026-08-05: その年の 1 月 〜 選択中の月。 */
  it('その年の 1 月から選択中の月まで', () => {
    expect(defaultRange('2026-06')).toEqual({ from: '2026-01', to: '2026-06' })
    expect(defaultRange('2026-01')).toEqual({ from: '2026-01', to: '2026-01' })
    expect(defaultRange('2025-12')).toEqual({ from: '2025-01', to: '2025-12' })
  })
})

describe('describeApiError', () => {
  /** 既定の message は status しか持たない。**理由は upstream の本文にある。** */
  it('本文の error を拾って status と並べる', () => {
    expect(describeApiError({
      statusCode: 503,
      data: { error: '[kintai_push] が無効です (書き先がありません)' },
      message: '[GET] "/api/kyuyo/wage-range": 503',
    })).toBe('503 [kintai_push] が無効です (書き先がありません)')
  })

  it('本文が文字列でも拾う', () => {
    expect(describeApiError({ statusCode: 502, data: 'upstream down' })).toBe('502 upstream down')
  })

  it('data.message / statusMessage にも落ちる', () => {
    expect(describeApiError({ statusCode: 400, data: { message: 'month は YYYY-MM' } }))
      .toBe('400 month は YYYY-MM')
    expect(describeApiError({ statusCode: 401, statusMessage: 'Unauthorized' }))
      .toBe('401 Unauthorized')
  })

  it('status が無ければ理由だけ', () => {
    expect(describeApiError(new Error('Failed to fetch'))).toBe('Failed to fetch')
  })

  it('何も無くても文字列を返す', () => {
    expect(describeApiError(null)).toBe('null')
    // 拾える文言が無ければ String(e) に落ちる (黙って空文字にしない)
    expect(describeApiError({ statusCode: 500, data: {} })).toBe('500 [object Object]')
  })
})
