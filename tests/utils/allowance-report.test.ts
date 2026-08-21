import { describe, it, expect } from 'vitest'
import {
  legDate,
  toReportRows,
  summarizeByDriver,
  reportRowsToCsvLines,
  type OperationAllowance,
  type AllowanceReportRow,
} from '~/utils/allowance-report'
import type { LegAllowance } from '~/utils/allowance-trips'

function leg(over: Partial<LegAllowance['leg']> = {}): LegAllowance['leg'] {
  return {
    loadRowIndex: 0, unloadRowIndexes: [1], originCity: '釧路市', destCity: '上士幌町',
    viaCities: ['上士幌町'], fromTs: null, toTs: null, ...over,
  }
}

function op(over: Partial<OperationAllowance> = {}): OperationAllowance {
  return {
    unkoNo: '2607010419590000001109', readingDate: '2026-07-02', operationDate: '2026-07-01',
    driverName: '中村 一由', vehicleName: '帯広800か1109', legs: [], error: null, ...over,
  }
}

const OK: LegAllowance = { leg: leg(), lookup: { status: 'ok', allowanceYen: 9000, dest: '上士幌', rows: [] } }
const NG: LegAllowance = { leg: leg({ destCity: '芽室町', viaCities: ['芽室町'] }), lookup: { status: 'unknown', dest: '芽室' } }

describe('legDate', () => {
  it('積みの時刻が読めればその日付', () => {
    expect(legDate(op(), Date.UTC(2026, 6, 1, 4, 19, 59) / 1000)).toBe('2026-07-01')
  })

  it('読めなければ運行日、それも無ければ読取日に落とす', () => {
    expect(legDate(op(), null)).toBe('2026-07-01')
    expect(legDate(op({ operationDate: null }), null)).toBe('2026-07-02')
  })
})

describe('toReportRows', () => {
  it('便 1 行ずつに開き、決まった便だけ金額を入れる', () => {
    const rows = toReportRows([op({ legs: [OK, NG] })])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      seq: 1, date: '2026-07-01', driverName: '中村 一由', originCity: '釧路市',
      destCity: '上士幌町', masterDest: '上士幌', allowanceYen: 9000, status: 'ok',
    })
    expect(rows[1]).toMatchObject({ seq: 2, masterDest: '', allowanceYen: null, status: 'unknown' })
  })

  it('複数卸しは途中の市町村を > で連ねる', () => {
    const via: LegAllowance = {
      leg: leg({ viaCities: ['清水町', '帯広市'], destCity: '帯広市' }),
      lookup: { status: 'ok', allowanceYen: 12000, dest: '富士', rows: [] },
    }
    expect(toReportRows([op({ legs: [via] })])[0]!.viaCities).toBe('清水町>帯広市')
  })

  it('乗務員名・車輌名が無い運行は空文字にする', () => {
    const rows = toReportRows([op({ driverName: null, vehicleName: null, legs: [OK] })])
    expect(rows[0]).toMatchObject({ driverName: '', vehicleName: '' })
  })

  it('便が無い運行は行を作らない', () => {
    expect(toReportRows([op()])).toEqual([])
  })
})

describe('summarizeByDriver', () => {
  it('乗務員ごとに合計し、決まらなかった便は合計に入れず数だけ出す', () => {
    const rows = toReportRows([
      op({ driverName: '中村 一由', legs: [OK, OK, NG] }),
      op({ driverName: '柳井 亮祐', legs: [OK] }),
    ])
    expect(summarizeByDriver(rows)).toEqual([
      { driverName: '中村 一由', trips: 2, totalYen: 18000, irregularTrips: 1 },
      { driverName: '柳井 亮祐', trips: 1, totalYen: 9000, irregularTrips: 0 },
    ])
  })

  it('名前順で安定して並ぶ', () => {
    const rows = toReportRows([
      op({ driverName: 'B', legs: [OK] }),
      op({ driverName: 'A', legs: [OK] }),
    ])
    expect(summarizeByDriver(rows).map(d => d.driverName)).toEqual(['A', 'B'])
  })

  it('空なら空', () => {
    expect(summarizeByDriver([])).toEqual([])
  })
})

describe('reportRowsToCsvLines', () => {
  const rows: AllowanceReportRow[] = toReportRows([op({ legs: [OK, NG] })])

  it('ヘッダ + 便の行を返し、値は必ず引用する', () => {
    const lines = reportRowsToCsvLines(rows)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('"運行NO","日付"')
    expect(lines[1]).toContain('"9000"')
    // 決まらなかった便の金額は空欄
    expect(lines[2]).toContain('"","unknown"')
  })

  it('値に含まれる引用符を escape する', () => {
    const dirty = [{ ...rows[0]!, driverName: '中村 "一由"' }]
    expect(reportRowsToCsvLines(dirty)[1]).toContain('"中村 ""一由"""')
  })
})
