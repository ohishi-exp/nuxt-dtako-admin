// 道東卸しの便を釧路営業所発で組み直す試算のテスト (Refs #760 の 34)。
//
// 共有 fixture は `tests/fixtures/kushiro-loading/doto-operations-2026-07.json` —
// **kyuyo-mcp 側の双子実装が同じ fixture と同じ golden を読んで bit 一致を検証する**
// (`tests/fixtures/restraint-wage/` と同じ流儀)。
//
// golden (`golden/doto-2026-07.json`) は本物の出力。意図したロジック変更のときは
//   UPDATE_GOLDEN=1 npx vitest run tests/utils/kushiro-doto-rebuild.test.ts
// で再生成し、diff を PR で説明してレビューする。
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEST_AREA,
  DEFAULT_LEGS_PER_DRIVER_MONTH,
  DEST_AREAS,
  DOTO_PLACES,
  addRebuildLeg,
  emptyRebuildTotals,
  estimateCalibrationRatio,
  haulSpeedKmh,
  hourlyWageYen,
  hoursOfSeconds,
  isDotoDest,
  isDotoPlace,
  legsPerRunDistribution,
  matchesDestArea,
  rebuildDeadheadSpeedKmh,
  rebuiltDeadheadKm,
  rebuiltDepotDiffKm,
  rebuiltRuns,
  requiredDrivers,
  restraintHours,
  selectRebuildLegs,
  summarizeDotoRebuild,
} from '../../app/utils/kushiro-doto-rebuild'
import type {
  RebuildLegInput,
  RebuildOperationInput,
  RebuildTotals,
} from '../../app/utils/kushiro-doto-rebuild'
import { classifyKushiroOperation, KUSHIRO_LOADERS } from '../../app/utils/kushiro-loading-legs'
import { DEPOTS, haversineKm } from '../../app/utils/depot-distance'
import rawOperations from '../fixtures/kushiro-loading/doto-operations-2026-07.json'
import measured from '../fixtures/kushiro-loading/doto-measured-2026-07.json'
import golden from '../fixtures/kushiro-loading/golden/doto-2026-07.json'

const operations = rawOperations as unknown as RebuildOperationInput[]

const KUSHIRO_ADDRESS = '北海道釧路市西港1-98-41'
const SHIBECHA_ADDRESS = '北海道川上郡標茶町多和星空の黒牛'
const OBIHIRO_ADDRESS = '北海道帯広市川西町'
const HIROO_ADDRESS = '北海道広尾郡広尾町白樺通'

const KUSHIRO_POINT = { lat: 42.98, lng: 144.335 }
const SHIBECHA_POINT = { lat: 43.28, lng: 144.63 }

function leg(over: Partial<RebuildLegInput> = {}): RebuildLegInput {
  return {
    seq: 1,
    originCity: KUSHIRO_ADDRESS,
    destCity: SHIBECHA_ADDRESS,
    salesYen: 36000,
    allowanceYen: 8000,
    haulKm: 60,
    deadheadKm: 120,
    loadPoint: KUSHIRO_POINT,
    unloadPoint: SHIBECHA_POINT,
    haulSec: 7200,
    deadheadSec: 14400,
    ...over,
  }
}

function operation(over: Partial<RebuildOperationInput> = {}): RebuildOperationInput {
  return {
    unkoNo: '2607010615000000001101',
    driverName: '中村 一由',
    kmBreakdown: { preLoadKm: 120, haulKm: 60, betweenKm: 0, postUnloadKm: 0, otherKm: 0 },
    firstLoadPoint: KUSHIRO_POINT,
    lastUnloadPoint: SHIBECHA_POINT,
    legs: [leg()],
    ...over,
  }
}

// --- 道東の判定 ---------------------------------------------------------------

describe('道東の判定', () => {
  it('DOTO_PLACES は釧路・根室の 2 振興局を 1 定数にまとめてある', () => {
    expect(DOTO_PLACES).toContain('標茶')
    expect(DOTO_PLACES).toContain('別海')
    expect(DOTO_PLACES).toContain('釧路')
    // 市/町/村 は落とした語彙 (`routePlace` と同じ粒度)
    expect(DOTO_PLACES.some(p => /[市町村]$/.test(p))).toBe(false)
    expect(new Set(DOTO_PLACES).size).toBe(DOTO_PLACES.length)
  })

  it('isDotoPlace は語彙 (routePlace の出力) で判定する', () => {
    expect(isDotoPlace('標茶')).toBe(true)
    expect(isDotoPlace('帯広')).toBe(false)
  })

  it('実データの住所でもマスタの語彙でも同じ判定になる', () => {
    expect(isDotoDest('北海道川上郡標茶町多和星空の黒牛')).toBe(true)
    expect(isDotoDest('北海道川上郡標茶町西熊牛原野')).toBe(true)
    expect(isDotoDest('北海道野付郡別海町中西別')).toBe(true)
    expect(isDotoDest('標茶')).toBe(true)
    expect(isDotoDest('別海')).toBe(true)
    // 十勝は道東ではない (この案件の対象外)
    expect(isDotoDest('北海道帯広市川西町')).toBe(false)
    expect(isDotoDest('北海道河東郡音更町駒場')).toBe(false)
    expect(isDotoDest('北海道河東郡上士幌町上士幌東3線')).toBe(false)
    // 空の卸地は `(不明)` に落ちる = 道東ではない
    expect(isDotoDest('')).toBe(false)
  })

  it('DEST_AREAS / matchesDestArea', () => {
    expect(DEST_AREAS).toEqual(['doto', 'all'])
    expect(DEFAULT_DEST_AREA).toBe('doto')
    expect(matchesDestArea(OBIHIRO_ADDRESS, 'all')).toBe(true)
    expect(matchesDestArea(OBIHIRO_ADDRESS, 'doto')).toBe(false)
    expect(matchesDestArea(SHIBECHA_ADDRESS, 'doto')).toBe(true)
  })
})

// --- 便の切り出し -------------------------------------------------------------

describe('selectRebuildLegs', () => {
  it('積地=釧路 かつ 卸地=道東 の便だけを取る (既定)', () => {
    const ops = [
      operation({
        legs: [
          leg({ seq: 1 }),
          leg({ seq: 2, destCity: OBIHIRO_ADDRESS }),
          leg({ seq: 3, originCity: HIROO_ADDRESS, destCity: SHIBECHA_ADDRESS }),
        ],
      }),
    ]
    const selected = selectRebuildLegs(ops)
    expect(selected.legs.map(s => s.leg.seq)).toEqual([1])
    expect(selected.operations).toBe(1)
    expect(selected.legsPerOperation).toEqual([1])
    expect(selected.legs[0]!.unkoNo).toBe('2607010615000000001101')
    expect(selected.legs[0]!.driverName).toBe('中村 一由')
  })

  it("area='all' は釧路積みの便を卸地に関係なく取る", () => {
    const ops = [
      operation({
        legs: [leg({ seq: 1 }), leg({ seq: 2, destCity: OBIHIRO_ADDRESS }), leg({ seq: 3, originCity: HIROO_ADDRESS })],
      }),
    ]
    expect(selectRebuildLegs(ops, 'all').legs.map(s => s.leg.seq)).toEqual([1, 2])
  })

  it('対象便が 1 本も無い運行は運行数に数えない', () => {
    const ops = [operation({ legs: [leg({ destCity: OBIHIRO_ADDRESS })] })]
    const selected = selectRebuildLegs(ops)
    expect(selected.legs).toEqual([])
    expect(selected.operations).toBe(0)
    expect(selected.legsPerOperation).toEqual([])
  })
})

// --- 1 運行あたり便数の分布 ---------------------------------------------------

describe('legsPerRunDistribution', () => {
  it('分布と平均を出す (平均が legsPerRun の既定になる)', () => {
    const dist = legsPerRunDistribution({
      legs: [],
      operations: 3,
      legsPerOperation: [2, 1, 2],
    })
    expect(dist.buckets).toEqual([
      { legsInOperation: 1, operations: 1 },
      { legsInOperation: 2, operations: 2 },
    ])
    expect(dist.operations).toBe(3)
    expect(dist.legs).toBe(0)
    expect(dist.mean).toBe(0)
  })

  it('運行が 0 なら平均は null (1 に倒さない)', () => {
    const dist = legsPerRunDistribution({ legs: [], operations: 0, legsPerOperation: [] })
    expect(dist.mean).toBeNull()
    expect(dist.buckets).toEqual([])
  })
})

// --- 集計行 -------------------------------------------------------------------

describe('addRebuildLeg', () => {
  it('座標が揃った便は全営業所ぶん推定に入る', () => {
    const totals = emptyRebuildTotals()
    addRebuildLeg(totals, leg())
    expect(totals.legs).toBe(1)
    expect(totals.salesYen).toBe(36000)
    expect(totals.allowanceYen).toBe(8000)
    expect(totals.haulKm).toBe(60)
    expect(totals.deadheadKm).toBe(120)
    expect(totals.haulSec).toBe(7200)
    expect(totals.haulKmTimed).toBe(60)
    expect(totals.deadheadSec).toBe(14400)
    expect(totals.deadheadKmTimed).toBe(120)
    expect(totals.estimatedLegs).toBe(1)
    expect(totals.missingLegs).toBe(0)
    expect(totals.comparableDeadheadKm).toBe(120)
    expect(totals.destToLoadKm).toBeCloseTo(haversineKm(SHIBECHA_POINT, KUSHIRO_POINT)!, 9)
    expect(totals.depotToLoadKm.kushiro).toBeCloseTo(haversineKm(DEPOTS.kushiro, KUSHIRO_POINT)!, 9)
    expect(totals.destToDepotKm.obihiro).toBeCloseTo(haversineKm(SHIBECHA_POINT, DEPOTS.obihiro)!, 9)
  })

  it('積地の座標が欠けた便は推定に入れない (0km にしない)', () => {
    const totals = emptyRebuildTotals()
    addRebuildLeg(totals, leg({ loadPoint: null }))
    expect(totals.legs).toBe(1)
    expect(totals.estimatedLegs).toBe(0)
    expect(totals.missingLegs).toBe(1)
    expect(totals.comparableDeadheadKm).toBe(0)
    expect(totals.destToLoadKm).toBe(0)
    expect(totals.depotToLoadKm.kushiro).toBe(0)
  })

  it('卸地の座標が欠けた便も同じ扱い', () => {
    const totals = emptyRebuildTotals()
    addRebuildLeg(totals, leg({ unloadPoint: undefined }))
    expect(totals.missingLegs).toBe(1)
    expect(totals.estimatedLegs).toBe(0)
  })

  it('時刻が読めない便は km も秒も数えない (速度が壊れるため)', () => {
    const totals = emptyRebuildTotals()
    // `null` (読めなかった) も `undefined` (列そのものが無い) も同じ扱い
    addRebuildLeg(totals, leg({ haulSec: null }))
    addRebuildLeg(totals, leg({ haulSec: undefined }))
    addRebuildLeg(totals, leg({ deadheadSec: null }))
    addRebuildLeg(totals, leg({ deadheadSec: undefined }))
    expect(totals.legs).toBe(4)
    expect(totals.haulKm).toBe(240)
    expect(totals.haulSec).toBe(7200 * 2)
    expect(totals.haulKmTimed).toBe(120)
    expect(totals.deadheadSec).toBe(14400 * 2)
    expect(totals.deadheadKmTimed).toBe(240)
  })

  it('営業所の座標は差し替えられる (正式所在地が決まったとき用)', () => {
    const totals = emptyRebuildTotals()
    const moved = { obihiro: DEPOTS.obihiro, kushiro: { lat: 43.0, lng: 144.4 } }
    addRebuildLeg(totals, leg(), moved)
    expect(totals.depotToLoadKm.kushiro).toBeCloseTo(haversineKm(moved.kushiro, KUSHIRO_POINT)!, 9)
    expect(totals.depotToLoadKm.kushiro).not.toBeCloseTo(haversineKm(DEPOTS.kushiro, KUSHIRO_POINT)!, 3)
  })
})

// --- 組み直しの式 -------------------------------------------------------------

function totalsOf(legs: readonly RebuildLegInput[]): RebuildTotals {
  const totals = emptyRebuildTotals()
  for (const l of legs) addRebuildLeg(totals, l)
  return totals
}

describe('組み直しの回送 (推定)', () => {
  it('1 便 1 運行なら 出庫 + 帰庫 に落ちる', () => {
    const totals = totalsOf([leg(), leg()])
    const expected = totals.depotToLoadKm.kushiro + totals.destToDepotKm.kushiro
    expect(rebuiltDeadheadKm(totals, 'kushiro', 1)).toBeCloseTo(expected, 9)
    expect(rebuiltRuns(totals, 1)).toBe(2)
  })

  it('便数を増やすほど 卸地→積地 の往復だけに近づく', () => {
    const totals = totalsOf([leg(), leg()])
    expect(rebuiltDeadheadKm(totals, 'kushiro', 1e9)).toBeCloseTo(totals.destToLoadKm, 3)
  })

  it('行を足すと全体に戻る (Σ ÷ N に畳めるため按分が要らない)', () => {
    const a = totalsOf([leg(), leg()])
    const b = totalsOf([leg({ destCity: '北海道野付郡別海町中西別', unloadPoint: { lat: 43.47, lng: 144.98 } })])
    const all = totalsOf([
      leg(),
      leg(),
      leg({ destCity: '北海道野付郡別海町中西別', unloadPoint: { lat: 43.47, lng: 144.98 } }),
    ])
    const n = 1.6521739130434783
    expect(rebuiltDeadheadKm(a, 'kushiro', n)! + rebuiltDeadheadKm(b, 'kushiro', n)!)
      .toBeCloseTo(rebuiltDeadheadKm(all, 'kushiro', n)!, 9)
  })

  it('legsPerRun が正でなければ null (0 に倒さない)', () => {
    const totals = totalsOf([leg()])
    expect(rebuiltDeadheadKm(totals, 'kushiro', 0)).toBeNull()
    expect(rebuiltDeadheadKm(totals, 'kushiro', Number.NaN)).toBeNull()
    expect(rebuiltRuns(totals, -1)).toBeNull()
    expect(rebuiltDepotDiffKm(totals, 'obihiro', 'kushiro', 0)).toBeNull()
  })

  it('営業所の差は両側とも推定 (実測と引き算しない)', () => {
    const totals = totalsOf([leg()])
    const diff = rebuiltDepotDiffKm(totals, 'obihiro', 'kushiro', 1)!
    expect(diff).toBeCloseTo(
      rebuiltDeadheadKm(totals, 'kushiro', 1)! - rebuiltDeadheadKm(totals, 'obihiro', 1)!,
      9,
    )
    // 釧路積み・道東卸しなら釧路営業所の方が短い
    expect(diff).toBeLessThan(0)
  })

  it('較正比は 推定 ÷ 実測。実測が無ければ null', () => {
    const totals = totalsOf([leg()])
    expect(estimateCalibrationRatio(totals, 'kushiro', 1)).toBeCloseTo(
      rebuiltDeadheadKm(totals, 'kushiro', 1)! / totals.comparableDeadheadKm,
      9,
    )
    expect(estimateCalibrationRatio(totals, 'kushiro', 0)).toBeNull()
    expect(estimateCalibrationRatio(emptyRebuildTotals(), 'kushiro', 1)).toBeNull()
  })
})

// --- 速度・拘束時間・賃金 ------------------------------------------------------

describe('速度と拘束時間', () => {
  it('平均速度は実測から出す。秒が無ければ null (既定値に落とさない)', () => {
    const totals = totalsOf([leg()])
    expect(haulSpeedKmh(totals)).toBeCloseTo(60 / 2, 9)
    expect(rebuildDeadheadSpeedKmh(totals)).toBeCloseTo(120 / 4, 9)
    const noSec = totalsOf([leg({ haulSec: null, deadheadSec: null })])
    expect(haulSpeedKmh(noSec)).toBeNull()
    expect(rebuildDeadheadSpeedKmh(noSec)).toBeNull()
  })

  it('hoursOfSeconds', () => {
    expect(hoursOfSeconds(5400)).toBe(1.5)
  })

  it('拘束は 走行 + 回送 の下限で、旗が必ず立つ', () => {
    const totals = totalsOf([leg()])
    const hours = restraintHours(totals, 'kushiro', 1)
    expect(hours.haulHours).toBe(2)
    expect(hours.measuredDeadheadHours).toBe(4)
    expect(hours.measuredTotalHours).toBe(6)
    expect(hours.restraintIsLowerBound).toBe(true)
    const km = rebuiltDeadheadKm(totals, 'kushiro', 1)!
    expect(hours.rebuiltDeadheadHours).toBeCloseTo(km / rebuildDeadheadSpeedKmh(totals)!, 9)
    expect(hours.rebuiltTotalHours).toBeCloseTo(2 + hours.rebuiltDeadheadHours!, 9)
  })

  it('速度が出せない / legsPerRun が不正なら 組み直し後の時間は null', () => {
    const noSec = totalsOf([leg({ deadheadSec: null })])
    expect(restraintHours(noSec, 'kushiro', 1).rebuiltDeadheadHours).toBeNull()
    expect(restraintHours(noSec, 'kushiro', 1).rebuiltTotalHours).toBeNull()
    expect(restraintHours(totalsOf([leg()]), 'kushiro', 0).rebuiltDeadheadHours).toBeNull()
  })

  it('必要乗務員数は切り上げ。分母が正でなければ null', () => {
    expect(DEFAULT_LEGS_PER_DRIVER_MONTH).toBe(57)
    // 帯広実績 284 便 / 5 名 の商を丸めた値であることを、その場で確かめる
    expect(Math.round(284 / 5)).toBe(DEFAULT_LEGS_PER_DRIVER_MONTH)
    expect(requiredDrivers(38, DEFAULT_LEGS_PER_DRIVER_MONTH)).toBe(1)
    expect(requiredDrivers(115, DEFAULT_LEGS_PER_DRIVER_MONTH)).toBe(3)
    expect(requiredDrivers(38, 0)).toBeNull()
  })

  it('換算時給は 0 除算を出さない', () => {
    expect(hourlyWageYen(311000, 167)).toBeCloseTo(311000 / 167, 9)
    expect(hourlyWageYen(311000, null)).toBeNull()
    expect(hourlyWageYen(311000, 0)).toBeNull()
  })
})

// --- 束ね ---------------------------------------------------------------------

describe('summarizeDotoRebuild', () => {
  it('既定は道東卸しだけ・legsPerRun は実測の平均', () => {
    const summary = summarizeDotoRebuild(operations)
    expect(summary.area).toBe('doto')
    expect(summary.totals.legs).toBe(measured.legs)
    expect(summary.distribution.operations).toBe(measured.operations)
    expect(summary.legsPerRun).toBeCloseTo(measured.legs / measured.operations, 12)
    expect(summary.legsPerRun).toBe(summary.distribution.mean)
  })

  it('options で 卸地の範囲 / 便数 / 営業所の座標 を差し替えられる', () => {
    const moved = { obihiro: DEPOTS.obihiro, kushiro: { lat: 43.0, lng: 144.4 } }
    const summary = summarizeDotoRebuild(operations, { area: 'all', legsPerRun: 2, depots: moved })
    expect(summary.area).toBe('all')
    expect(summary.legsPerRun).toBe(2)
    expect(summary.totals.legs).toBeGreaterThan(measured.legs)
    // 十勝卸しの便が混ざるので卸地に帯広・音更が出る
    expect(summary.routes.some(r => !r.doto)).toBe(true)
    const base = summarizeDotoRebuild(operations, { area: 'all', legsPerRun: 2 })
    expect(summary.totals.depotToLoadKm.kushiro).not.toBeCloseTo(base.totals.depotToLoadKm.kushiro, 3)
  })

  it('行を足すと全体に戻る (経路別・乗務員別とも)', () => {
    const summary = summarizeDotoRebuild(operations)
    for (const rows of [summary.routes, summary.drivers]) {
      const sum = rows.reduce(
        (acc, row) => {
          acc.legs += row.totals.legs
          acc.salesYen += row.totals.salesYen
          acc.allowanceYen += row.totals.allowanceYen
          acc.haulKm += row.totals.haulKm
          acc.deadheadKm += row.totals.deadheadKm
          acc.destToLoadKm += row.totals.destToLoadKm
          return acc
        },
        { legs: 0, salesYen: 0, allowanceYen: 0, haulKm: 0, deadheadKm: 0, destToLoadKm: 0 },
      )
      expect(sum.legs).toBe(summary.totals.legs)
      expect(sum.salesYen).toBe(summary.totals.salesYen)
      expect(sum.allowanceYen).toBe(summary.totals.allowanceYen)
      expect(sum.haulKm).toBeCloseTo(summary.totals.haulKm, 6)
      expect(sum.deadheadKm).toBeCloseTo(summary.totals.deadheadKm, 6)
      expect(sum.destToLoadKm).toBeCloseTo(summary.totals.destToLoadKm, 6)
    }
  })

  it('経路の推定を足すと全体の推定に戻る', () => {
    const summary = summarizeDotoRebuild(operations)
    const n = summary.legsPerRun!
    const sum = summary.routes.reduce((acc, r) => acc + rebuiltDeadheadKm(r.totals, 'kushiro', n)!, 0)
    expect(sum).toBeCloseTo(rebuiltDeadheadKm(summary.totals, 'kushiro', n)!, 6)
  })

  it('行は 便数 → 売上 の降順、同数同額は初出順', () => {
    const ops = [
      operation({
        driverName: 'B',
        legs: [leg({ seq: 1, salesYen: 10 }), leg({ seq: 2, salesYen: 10 })],
      }),
      operation({ driverName: 'A', legs: [leg({ seq: 1, salesYen: 999 })] }),
      operation({ driverName: 'C', legs: [leg({ seq: 1, salesYen: 999 })] }),
    ]
    const summary = summarizeDotoRebuild(ops)
    expect(summary.drivers.map(d => d.driverName)).toEqual(['B', 'A', 'C'])
    // 経路は 1 本に畳まれる (積地・卸地が同じ)
    expect(summary.routes).toHaveLength(1)
    expect(summary.routes[0]!.from).toBe('釧路')
    expect(summary.routes[0]!.to).toBe('標茶')
    expect(summary.routes[0]!.doto).toBe(true)
  })

  it('対象便が 0 本なら legsPerRun は null (推定を出さない)', () => {
    const summary = summarizeDotoRebuild([operation({ legs: [leg({ destCity: OBIHIRO_ADDRESS })] })])
    expect(summary.totals.legs).toBe(0)
    expect(summary.legsPerRun).toBeNull()
    expect(summary.routes).toEqual([])
    expect(summary.drivers).toEqual([])
  })
})

// --- 共有 fixture が本番実測に戻る ---------------------------------------------

describe('共有 fixture が本番実測 (2026-07 の道東卸し 38 便) の集計に戻る', () => {
  const summary = summarizeDotoRebuild(operations)

  it('便数・運行数・売上・手当・km・時間', () => {
    expect(summary.totals.legs).toBe(measured.legs)
    expect(summary.distribution.operations).toBe(measured.operations)
    expect(summary.totals.salesYen).toBe(measured.salesYen)
    expect(summary.totals.allowanceYen).toBe(measured.allowanceYen)
    expect(summary.totals.haulKm).toBeCloseTo(measured.haulKm, 6)
    expect(summary.totals.deadheadKm).toBeCloseTo(measured.deadheadKm, 6)
    expect(hoursOfSeconds(summary.totals.haulSec)).toBeCloseTo(measured.haulHours, 6)
    expect(hoursOfSeconds(summary.totals.deadheadSec)).toBeCloseTo(measured.deadheadHours, 6)
  })

  it('卸地・乗務員の内訳 (集計器を通さず fixture から直接数えても同じ)', () => {
    const destCounts = new Map<string, number>()
    const driverCounts = new Map<string, number>()
    for (const op of operations) {
      for (const l of op.legs) {
        if (!l.originCity.includes('釧路市西港')) continue
        if (!isDotoDest(l.destCity)) continue
        destCounts.set(l.destCity, (destCounts.get(l.destCity) ?? 0) + 1)
        driverCounts.set(op.driverName, (driverCounts.get(op.driverName) ?? 0) + 1)
      }
    }
    expect(Object.fromEntries(destCounts)).toEqual(measured.destLegs)
    expect(Object.fromEntries(driverCounts)).toEqual(measured.driverLegs)
    expect(Object.fromEntries(summary.drivers.map(d => [d.driverName, d.totals.legs])))
      .toEqual(measured.driverLegs)
  })

  it('23 運行すべてが混在運行 (pure は 0) — だから営業所の差し替えでは動かせない', () => {
    const kinds = operations.map(op => classifyKushiroOperation(op.legs))
    expect(kinds.filter(k => k === 'pure')).toHaveLength(measured.pureOperations)
    expect(kinds.filter(k => k === 'mixed')).toHaveLength(measured.operations)
  })

  it('1 運行あたりの対象便数の分布 (legsPerRun の既定の根拠)', () => {
    expect(summary.distribution.buckets).toEqual([
      { legsInOperation: 1, operations: 8 },
      { legsInOperation: 2, operations: 15 },
    ])
    expect(summary.distribution.buckets.reduce((a, b) => a + b.legsInOperation * b.operations, 0))
      .toBe(measured.legs)
  })

  it('手当の合計は 手当マスタ (標茶 ¥8,000 / 別海 ¥9,000) で説明が付く', () => {
    const shibecha = summary.routes.find(r => r.to === '標茶')!
    const betsukai = summary.routes.find(r => r.to === '別海')!
    expect(shibecha.totals.legs).toBe(21 + 8 + 2)
    expect(betsukai.totals.legs).toBe(7)
    expect(shibecha.totals.allowanceYen).toBe(shibecha.totals.legs * 8000)
    expect(betsukai.totals.allowanceYen).toBe(betsukai.totals.legs * 9000)
    expect(shibecha.totals.allowanceYen + betsukai.totals.allowanceYen).toBe(measured.allowanceYen)
  })

  it('意図的な欠測が入っている (推定を 0km に倒さないことの検証)', () => {
    const all = summarizeDotoRebuild(operations, { area: 'all' })
    // 座標の欠測 2 本 (積地 1 / 卸地 1)、秒の欠測 2 本 (走行 1 / 回送 1)。
    // **どれも釧路積みの十勝卸し便に仕込んである** — 道東の実測合計を汚さないため。
    const kushiroLegs = operations.flatMap(op => op.legs.filter(l => l.originCity.includes('釧路市西港')))
    expect(kushiroLegs.filter(l => l.loadPoint === null)).toHaveLength(1)
    expect(kushiroLegs.filter(l => l.unloadPoint === null)).toHaveLength(1)
    expect(kushiroLegs.filter(l => l.haulSec === null)).toHaveLength(1)
    expect(kushiroLegs.filter(l => l.deadheadSec === null)).toHaveLength(1)
    expect(all.totals.missingLegs).toBe(2)
    expect(all.totals.legs - all.totals.estimatedLegs).toBe(2)
    // 道東だけに絞れば欠測は無い (実測集計がそのまま出る)
    expect(summary.totals.missingLegs).toBe(0)
  })
})

// --- golden -------------------------------------------------------------------

const UPDATE_GOLDEN = Boolean(
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.UPDATE_GOLDEN,
)
const GOLDEN_PATH = 'tests/fixtures/kushiro-loading/golden/doto-2026-07.json'

/**
 * 双子 (kyuyo-mcp 側) が同じ入力から同じ値を出すことを固定する golden。
 * **`kushiroLoaders` は #796 が `RATE_MASTER` から導出する定数**で、双子側は
 * literal で持つ (worker から app/utils は import できない)。ここに焼いておくと
 * マスタが動いたときに両側とも落ちる。
 */
function buildDotoGolden(): unknown {
  const summary = summarizeDotoRebuild(operations)
  const all = summarizeDotoRebuild(operations, { area: 'all' })
  const n = summary.legsPerRun!
  return {
    kushiroLoaders: KUSHIRO_LOADERS,
    doto: {
      summary,
      legsPerRun: n,
      runs: rebuiltRuns(summary.totals, n),
      rebuiltDeadheadKm: {
        obihiro: rebuiltDeadheadKm(summary.totals, 'obihiro', n),
        kushiro: rebuiltDeadheadKm(summary.totals, 'kushiro', n),
      },
      depotDiffKm: rebuiltDepotDiffKm(summary.totals, 'obihiro', 'kushiro', n),
      calibrationRatio: {
        obihiro: estimateCalibrationRatio(summary.totals, 'obihiro', n),
        kushiro: estimateCalibrationRatio(summary.totals, 'kushiro', n),
      },
      speedKmh: {
        haul: haulSpeedKmh(summary.totals),
        deadhead: rebuildDeadheadSpeedKmh(summary.totals),
      },
      restraint: {
        obihiro: restraintHours(summary.totals, 'obihiro', n),
        kushiro: restraintHours(summary.totals, 'kushiro', n),
      },
      requiredDrivers: requiredDrivers(summary.totals.legs, DEFAULT_LEGS_PER_DRIVER_MONTH),
    },
    all: { legsPerRun: all.legsPerRun, totals: all.totals, routes: all.routes },
  }
}

describe('golden (共有 fixture の出力を丸ごと固定)', () => {
  const output = buildDotoGolden()

  if (UPDATE_GOLDEN) {
    it('golden を再生成した (UPDATE_GOLDEN)', async () => {
      const fs = (await import(/* @vite-ignore */ 'node' + ':fs')) as {
        writeFileSync: (path: string, data: string) => void
      }
      fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(output, null, 1)}\n`)
      expect(output).toBeTruthy()
    })
    return
  }

  it('出力が golden と 1 ビットも違わない', () => {
    expect(JSON.parse(JSON.stringify(output))).toEqual(golden)
  })
})
