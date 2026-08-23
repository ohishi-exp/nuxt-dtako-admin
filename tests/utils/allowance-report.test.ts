import { describe, it, expect } from 'vitest'
import {
  compareText,
  legDate,
  toReportRows,
  summarizeByDriver,
  reportRowsToCsvLines,
  monthReadingRange,
  buildMonthlyAllowance,
  buildMonthlyAllowanceByOperationDate,
  operationRunDate,
  applyCarryOver,
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
    driverName: '中村 一由', vehicleName: '帯広800か1109', legs: [],
    carryIn: { cities: [], toTs: null }, error: null, ...over,
  }
}

const OK: LegAllowance = { leg: leg(), lookup: { status: 'ok', allowanceYen: 9000, dest: '上士幌', rows: [] }, destSource: 'event' }
const NG: LegAllowance = { leg: leg({ destCity: '芽室町', viaCities: ['芽室町'] }), lookup: { status: 'unknown', dest: '芽室' }, destSource: 'event' }
/** 卸地を次の運行から引き継いだ便 (推定)。 */
const CARRIED: LegAllowance = { leg: leg({ destCity: '士幌町', viaCities: ['士幌町'] }), lookup: { status: 'ok', allowanceYen: 9000, dest: '溝口', rows: [] }, destSource: 'carried' }

describe('compareText', () => {
  it('昇順で比較する (localeCompare は使わない — ICU の照合順が環境で逆転するため)', () => {
    expect(compareText('B', 'A')).toBe(1)
    expect(compareText('A', 'B')).toBe(-1)
    expect(compareText('2026-07-02', '2026-07-04')).toBe(-1)
    expect(compareText('2026-08-01', '2026-07-04')).toBe(1)
  })
})

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
      destSource: 'event',
    }
    expect(toReportRows([op({ legs: [via] })])[0]!.viaCities).toBe('清水町>帯広市')
  })

  it('乗務員名・車輌名が無い運行は空文字にする', () => {
    const rows = toReportRows([op({ driverName: null, vehicleName: null, legs: [OK] })])
    expect(rows[0]).toMatchObject({ driverName: '', vehicleName: '' })
  })

  it('卸地の出どころ (推定かどうか) を行に持つ', () => {
    const rows = toReportRows([op({ legs: [OK, CARRIED] })])
    expect(rows.map(r => r.destSource)).toEqual(['event', 'carried'])
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

  it('卸地の出どころを最後の列に書く (強制突合も「イベント」と嘘をつかない)', () => {
    const forced: LegAllowance = { ...CARRIED, destSource: 'forced' }
    const lines = reportRowsToCsvLines(toReportRows([op({ legs: [OK, CARRIED, forced] })]))
    expect(lines[0]).toContain('"卸地の出どころ"')
    expect(lines[1]!.endsWith('"イベント"')).toBe(true)
    expect(lines[2]!.endsWith('"次運行の先頭の降し (推定)"')).toBe(true)
    expect(lines[3]!.endsWith('"一番星の明細 (強制突合)"')).toBe(true)
  })

  it('値に含まれる引用符を escape する', () => {
    const dirty = [{ ...rows[0]!, driverName: '中村 "一由"' }]
    expect(reportRowsToCsvLines(dirty)[1]).toContain('"中村 ""一由"""')
  })
})

// --- 月単位の集計 ---

const D = (day: number, hour = 5) => Date.UTC(2026, 6, day, hour) / 1000
const AUG = (day: number) => Date.UTC(2026, 7, day, 5) / 1000
const JUN = (day: number) => Date.UTC(2026, 5, day, 5) / 1000

function okLeg(ts: number): LegAllowance {
  return { leg: leg({ fromTs: ts }), lookup: { status: 'ok', allowanceYen: 9000, dest: '上士幌', rows: [] }, destSource: 'event' }
}
function ngLeg(ts: number): LegAllowance {
  return {
    leg: leg({ fromTs: ts, destCity: '', viaCities: [] }),
    lookup: { status: 'unknown', dest: '' },
    destSource: 'event',
  }
}

describe('monthReadingRange', () => {
  it('翌月1日まで含める (月末の日跨ぎ運行は翌日に読まれるため)', () => {
    expect(monthReadingRange('2026-07')).toEqual({ from: '2026-07-01', to: '2026-08-01' })
  })

  it('12月は翌年に繰り上がる', () => {
    expect(monthReadingRange('2026-12')).toEqual({ from: '2026-12-01', to: '2027-01-01' })
  })
})

describe('buildMonthlyAllowance', () => {
  const ops: OperationAllowance[] = [
    op({ unkoNo: 'A', readingDate: '2026-07-02', legs: [okLeg(D(1)), okLeg(D(1)), ngLeg(D(2))] }),
    op({ unkoNo: 'B', readingDate: '2026-07-04', legs: [okLeg(D(3))] }),
    // 月跨ぎ: 7/31 と 8/1 の便を持つ
    op({ unkoNo: 'C', readingDate: '2026-08-01', legs: [okLeg(D(31)), okLeg(AUG(1))] }),
    // 便を 1 つも取れなかった運行
    op({ unkoNo: 'D', readingDate: '2026-07-06', legs: [], error: 'イベントCSV が未取り込み' }),
    // 翌月ぶんしか持たない運行
    op({ unkoNo: 'E', readingDate: '2026-08-01', legs: [okLeg(AUG(2))] }),
    op({ unkoNo: 'F', readingDate: '2026-07-03', driverName: '柳井 亮祐', legs: [okLeg(D(2))] }),
  ]

  it('乗務員 → 運行 → 便 の 3 段にまとめる', () => {
    const m = buildMonthlyAllowance(ops, '2026-07')
    expect(m.drivers.map(d => d.driverName)).toEqual(['中村 一由', '柳井 亮祐'])
    expect(m.drivers[0]).toMatchObject({ trips: 4, totalYen: 36000, irregularTrips: 1, failedOperations: 1 })
    expect(m.drivers[0]!.operations.map(o => o.unkoNo)).toEqual(['A', 'B', 'D', 'C'])
    expect(m.drivers[0]!.operations[0]!.rows).toHaveLength(3)
  })

  it('月合計は対象月の便だけ。翌月に食い込むぶんは合計に入れず数だけ出す', () => {
    const m = buildMonthlyAllowance(ops, '2026-07')
    expect(m).toMatchObject({
      trips: 5, totalYen: 45000, irregularTrips: 1, failedOperations: 1, outOfMonthTrips: 2,
    })
  })

  it('対象月の便が無く失敗でもない運行は出さない', () => {
    const m = buildMonthlyAllowance(ops, '2026-07')
    const all = m.drivers.flatMap(d => d.operations.map(o => o.unkoNo))
    expect(all).not.toContain('E')
  })

  it('便が取れなかった運行は便 0 のまま理由付きで残す', () => {
    const failed = buildMonthlyAllowance(ops, '2026-07').drivers[0]!.operations.find(o => o.unkoNo === 'D')
    expect(failed).toMatchObject({ rows: [], trips: 0, error: 'イベントCSV が未取り込み' })
  })

  it('乗務員名・車輌名が無くても落ちない', () => {
    const m = buildMonthlyAllowance(
      [op({ unkoNo: 'Z', driverName: null, vehicleName: null, legs: [okLeg(D(5))] })], '2026-07')
    expect(m.drivers[0]).toMatchObject({ driverName: '', trips: 1 })
    expect(m.drivers[0]!.operations[0]!.vehicleName).toBe('')
  })

  it('空なら 0', () => {
    expect(buildMonthlyAllowance([], '2026-07')).toEqual({
      drivers: [], trips: 0, totalYen: 0, irregularTrips: 0, carriedTrips: 0,
      failedOperations: 0, outOfMonthTrips: 0,
    })
  })
})

/**
 * **運行の開始日で月を切る** (Refs #760 の 16)。粗利タブ専用。
 *
 * 粗利は運行を単位にしていて燃料代が運行まるごとの走行km から出るので、便だけを
 * 積み日で切ると月跨ぎの運行で取引先別の検算が必ずその運行のぶんだけ合わない。
 */
describe('operationRunDate — 運行をどの月に数えるか', () => {
  it('運行開始 (イベントCSV) がいちばん強い', () => {
    // 運行日・運行NO が 07-31 でも、運行開始が読めればそれを使う
    expect(operationRunDate(D(31, 4), '2026-07-30', '2607300415000000001109')).toBe('2026-07-31')
  })

  it('運行開始が読めなければ運行日に落とす', () => {
    expect(operationRunDate(null, '2026-07-30', '2607310415000000001109')).toBe('2026-07-30')
  })

  it('運行日も無ければ運行NO の先頭 6 桁 (22桁・23桁のどちらでも)', () => {
    expect(operationRunDate(null, null, '2607310415000000001109')).toBe('2026-07-31')
    expect(operationRunDate(null, null, '26073104150000000011091')).toBe('2026-07-31')
  })

  it('運行NO が 22桁・23桁でなければ null (読取日には落とさない)', () => {
    // **読取日に落とさない** — 日跨ぎ運行は翌日に読まれるので月がずれる
    expect(operationRunDate(null, null, 'A')).toBeNull()
    expect(operationRunDate(null, null, '260731041500000000110')).toBeNull()
  })
})

describe('buildMonthlyAllowanceByOperationDate', () => {
  // 07-31 に始まり 08-01 の便を持つ運行 (本番の 中村1109 / 西島1420 と同じ形)
  const CROSS = op({ unkoNo: 'X', readingDate: '2026-08-01', operationDate: '2026-07-31', legs: [okLeg(D(31)), okLeg(AUG(1))] })
  // 06-30 に始まり 07-01 の便を持つ運行 (前月の運行)
  const PREV = op({ unkoNo: 'P', readingDate: '2026-07-01', operationDate: '2026-06-30', legs: [okLeg(JUN(30)), okLeg(D(1))] })
  const IN = op({ unkoNo: 'I', readingDate: '2026-07-05', operationDate: '2026-07-05', legs: [okLeg(D(5)), ngLeg(D(5))] })
  const ops = [CROSS, PREV, IN]
  const startTs = new Map<string, number | null>([['X', D(31, 4)], ['P', JUN(30)], ['I', D(5, 4)]])

  it('運行の開始日が対象月なら、翌月日付の便も含めて全部その月に入れる', () => {
    const m = buildMonthlyAllowanceByOperationDate(ops, '2026-07', startTs)
    const unkoNos = m.drivers.flatMap(d => d.operations.map(o => o.unkoNo))
    expect(unkoNos).toEqual(['I', 'X'])
    // X は 2 便 (07-31 と 08-01) とも入る
    expect(m.drivers[0]!.operations.find(o => o.unkoNo === 'X')!.rows).toHaveLength(2)
    // **便を日付で切らないので `outOfMonthTrips` は常に 0**
    expect(m.outOfMonthTrips).toBe(0)
    expect(m).toMatchObject({ trips: 3, totalYen: 27000, irregularTrips: 1 })
  })

  it('前月に始まった運行は、当月日付の便を持っていても入れない', () => {
    const m = buildMonthlyAllowanceByOperationDate(ops, '2026-07', startTs)
    expect(m.drivers.flatMap(d => d.operations.map(o => o.unkoNo))).not.toContain('P')
  })

  it('crossMonth に「含んだ翌月便」と「含まなかった前月運行の当月便」を数で出す', () => {
    const m = buildMonthlyAllowanceByOperationDate(ops, '2026-07', startTs)
    expect(m.crossMonth).toEqual({
      nextMonthLegs: 1, nextMonthAllowanceYen: 9000,
      prevMonthOpsLegsInMonth: 1, prevMonthOpsAllowanceYen: 9000,
    })
  })

  it('手当が決まらなかった便は crossMonth の金額に 0 として数える (推測を混ぜない)', () => {
    const cross = op({ unkoNo: 'Y', operationDate: '2026-07-31', legs: [okLeg(D(31)), ngLeg(AUG(1))] })
    const m = buildMonthlyAllowanceByOperationDate([cross], '2026-07', new Map([['Y', D(31, 4)]]))
    expect(m.crossMonth).toMatchObject({ nextMonthLegs: 1, nextMonthAllowanceYen: 0 })
  })

  it('運行開始が無い運行は 運行日 → 運行NO で振り分ける (読取日は見ない)', () => {
    // 読取日は 08-02 (日跨ぎで翌々日に読まれた) が、運行日は 07-31 なので 7 月
    const noCsv = op({ unkoNo: '2607310415000000001109', readingDate: '2026-08-02', operationDate: null, legs: [], error: 'イベントCSV が未取り込み' })
    const m = buildMonthlyAllowanceByOperationDate([noCsv], '2026-07', new Map())
    expect(m.failedOperations).toBe(1)
    expect(m.drivers[0]!.operations[0]!.unkoNo).toBe('2607310415000000001109')
  })

  it('どの月にも振り分けられない運行 (運行NO が桁違い) は入れない', () => {
    const odd = op({ unkoNo: 'ODD', operationDate: null, legs: [okLeg(D(5))] })
    const m = buildMonthlyAllowanceByOperationDate([odd], '2026-07', new Map([['ODD', null]]))
    expect(m.drivers).toEqual([])
    expect(m.crossMonth).toEqual({
      nextMonthLegs: 0, nextMonthAllowanceYen: 0,
      prevMonthOpsLegsInMonth: 1, prevMonthOpsAllowanceYen: 9000,
    })
  })

  it('空なら 0 (crossMonth も 0)', () => {
    expect(buildMonthlyAllowanceByOperationDate([], '2026-07', new Map())).toEqual({
      drivers: [], trips: 0, totalYen: 0, irregularTrips: 0, carriedTrips: 0,
      failedOperations: 0, outOfMonthTrips: 0,
      crossMonth: { nextMonthLegs: 0, nextMonthAllowanceYen: 0, prevMonthOpsLegsInMonth: 0, prevMonthOpsAllowanceYen: 0 },
    })
  })

  it('buildMonthlyAllowance (便の積み日) の挙動は変えていない — 同じ入力で結果が違う', () => {
    // 運行手当タブはこれまでどおり **便の積み日**で切る (X の 08-01 便は落ち、P の 07-01 便は入る)
    const byLeg = buildMonthlyAllowance(ops, '2026-07')
    expect(byLeg.trips).toBe(3)
    expect(byLeg.outOfMonthTrips).toBe(2)
    expect(byLeg.drivers.flatMap(d => d.operations.map(o => o.unkoNo))).toEqual(['P', 'I', 'X'])
    expect(byLeg.drivers[0]!.operations.find(o => o.unkoNo === 'X')!.rows).toHaveLength(1)
  })
})

describe('applyCarryOver', () => {
  // 実データ (2026-07 / 帯広800か1109): 26070604185900000011091 の最終便 (07-07 15:21
  // 積み、降し無し) の卸地は、次の運行 26070804190900000011091 の先頭 (07-08 4:40
  // 士幌町) にあった。運行 1 本だけを見ていると永久に決まらない。
  const trailing = { ...ngLeg(D(7, 15)), leg: leg({ fromTs: D(7, 15), destCity: '', viaCities: [], unloadRowIndexes: [] }) }
  const A = op({ unkoNo: '26070604185900000011091', legs: [okLeg(D(6)), trailing] })
  const B = op({
    unkoNo: '26070804190900000011091',
    legs: [okLeg(D(8))],
    carryIn: { cities: ['士幌町'], toTs: D(8, 4) },
  })

  it('同じ乗務員+車輌の次の運行から卸地を引き継ぐ', () => {
    const out = applyCarryOver([A, B])
    expect(out[0]!.legs[1]!.leg.destCity).toBe('士幌町')
    expect(out[0]!.legs[1]!.destSource).toBe('carried')
    // 引き継ぎ元 (次の運行) 自身の便は触られない
    expect(out[1]!.legs).toEqual(B.legs)
  })

  it('運行NO 順に並べ直してから当てる (引いた順に依存しない)', () => {
    expect(applyCarryOver([B, A])[1]!.legs[1]!.leg.destCity).toBe('士幌町')
  })

  it('乗務員か車輌が違えば引き継がない (積み残しは同じ車に載っている)', () => {
    const other = op({ ...B, driverName: '柳井 亮祐' })
    expect(applyCarryOver([A, other])[0]!.legs[1]!.leg.destCity).toBe('')
    const otherVehicle = op({ ...B, vehicleName: '帯広800か1318' })
    expect(applyCarryOver([A, otherVehicle])[0]!.legs[1]!.leg.destCity).toBe('')
  })

  it('乗務員名・車輌名が無くてもキーを作れる (同じ null 同士でまとまる)', () => {
    const a = op({ ...A, driverName: null, vehicleName: null })
    const b = op({ ...B, driverName: null, vehicleName: null })
    expect(applyCarryOver([a, b])[0]!.legs[1]!.leg.destCity).toBe('士幌町')
  })

  it('引いた範囲の最後の運行は埋まらない (次の運行を持っていないため)', () => {
    expect(applyCarryOver([A])[0]!.legs[1]!.leg.destCity).toBe('')
    expect(applyCarryOver([])).toEqual([])
  })
})

describe('buildMonthlyAllowance / 推定卸地の件数', () => {
  it('引き継いだ便を carriedTrips に数える (合計には入れる)', () => {
    const carried = { ...okLeg(D(7)), destSource: 'carried' as const }
    const m = buildMonthlyAllowance([op({ legs: [okLeg(D(6)), carried] })], '2026-07')
    expect(m).toMatchObject({ trips: 2, totalYen: 18000, carriedTrips: 1 })
    expect(m.drivers[0]).toMatchObject({ carriedTrips: 1 })
    expect(m.drivers[0]!.operations[0]).toMatchObject({ carriedTrips: 1 })
  })
})
