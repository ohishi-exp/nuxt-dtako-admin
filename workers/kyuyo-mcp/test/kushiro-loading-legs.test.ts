// **app/utils 側テストの双子** (Refs #760 の 34)。`workers/kyuyo-mcp/src/kushiro-loading-legs.ts`
// は `app/utils/kushiro-loading-legs.ts` の移植なので、**同じ共有 fixture に同じ期待値**を
// そのまま当てる (worker から app 側は import できない、Refs #268)。
// **golden は app 側が正本** — 双子側は再生成せず、読んで一致だけを見る。
// 釧路営業所 (暫定) 試算の中核 util のテスト (Refs #760 の 33)。
//
// 共有 fixture は `tests/fixtures/kushiro-loading/` — **後続 PR の kyuyo-mcp 側
// 双子実装が同じ fixture を読んで bit 一致を検証する**ので、入力はここでも
// 静的 JSON が正 (`tests/fixtures/restraint-wage/` と同じ流儀)。
// **釧路積みの 169 便は本番 2026-07 の経路別 実測** (17 経路)。期待値は
// `measured-2026-07.json` に置き、テストは fixture から数え直して突き合わせる
// (件数・金額をテストに直書きしない)。
//
// golden (`golden/summary-2026-07.json`) は本物の `summarizeKushiroLoading` の出力。
// 意図したロジック変更のときは (repo ルートで)
//   UPDATE_GOLDEN=1 npx vitest run tests/utils/kushiro-loading-legs.test.ts
// で再生成し、diff を PR で説明してレビューする。
import { describe, expect, it } from 'vitest'
import {
  DEPOT_KEYS,
  KUSHIRO_LOADERS,
  KUSHIRO_ORIGIN,
  SECONDS_PER_HOUR,
  classifyKushiroOperation,
  deadheadFuelYen,
  deadheadHours,
  deadheadSpeedKmh,
  depotShiftDiff,
  estimateDepotDeadhead,
  estimateRatio,
  isKushiroLoadingLeg,
  isKushiroOrigin,
  measuredDeadheadKm,
  summarizeKushiroLoading,
} from '../src/kushiro-loading-legs'
import type {
  DeadheadSpeedInput,
  KushiroLegInput,
  KushiroOperationInput,
} from '../src/kushiro-loading-legs'
import { DEPOTS, haversineKm } from '../src/depot-distance'
import { UNKNOWN_PLACE, routePlace } from '../src/route-place'
import rawOperations from '../../../tests/fixtures/kushiro-loading/operations-2026-07.json'
import rawIdles from '../../../tests/fixtures/kushiro-loading/deadhead-idle-2026-07.json'
import measured from '../../../tests/fixtures/kushiro-loading/measured-2026-07.json'
import golden from '../../../tests/fixtures/kushiro-loading/golden/summary-2026-07.json'

const operations = rawOperations as unknown as KushiroOperationInput[]
const idles = rawIdles as unknown as DeadheadSpeedInput[]

/** 積地の住所 (実データで確認されている 3 種)。 */
const KUSHIRO_ADDRESS = '北海道釧路市西港1-98-41'
const OBIHIRO_ADDRESS = '北海道帯広市川西町'
const HIROO_ADDRESS = '北海道広尾郡広尾町白樺通'

const KUSHIRO_POINT = { lat: 42.9836, lng: 144.3357 }
const TOKACHI_POINT = { lat: 43.1443, lng: 143.2411 }

function leg(over: Partial<KushiroLegInput> = {}): KushiroLegInput {
  return {
    seq: 1,
    originCity: KUSHIRO_ADDRESS,
    destCity: OBIHIRO_ADDRESS,
    salesYen: 30000,
    allowanceYen: 9000,
    haulKm: 100,
    deadheadKm: 30,
    ...over,
  }
}

function operation(over: Partial<KushiroOperationInput> = {}): KushiroOperationInput {
  return {
    unkoNo: '2607011000000000001109',
    driverName: '中村 一由',
    kmBreakdown: { preLoadKm: 130, haulKm: 100, betweenKm: 0, postUnloadKm: 27, otherKm: 0 },
    legs: [leg()],
    firstLoadPoint: KUSHIRO_POINT,
    lastUnloadPoint: TOKACHI_POINT,
    ...over,
  }
}

describe('釧路積みの判定', () => {
  it('手当マスタの語彙 (origin = 釧路) をそのまま渡しても当たる', () => {
    // マスタ (`RATE_MASTER`) は画面側の生成物で worker からは読めない。語彙が
    // マスタに実在することは app 側テストが見ている。ここは判定だけを確かめる。
    expect(KUSHIRO_ORIGIN).toBe('釧路')
    expect(isKushiroOrigin(KUSHIRO_ORIGIN)).toBe(true)
  })

  it('実データの住所 3 種 (北海道釧路市西港…) でも当たる', () => {
    for (const address of ['北海道釧路市西港1-98-41', '北海道釧路市西港2-101-1', '北海道釧路市西港1']) {
      expect(isKushiroOrigin(address)).toBe(true)
    }
  })

  it('釧路以外の積地は当たらない (空文字も)', () => {
    expect(isKushiroOrigin(HIROO_ADDRESS)).toBe(false)
    expect(isKushiroOrigin('北海道苫小牧市晴海町')).toBe(false)
    expect(isKushiroOrigin('')).toBe(false)
  })

  it('便でも同じ判定になる', () => {
    expect(isKushiroLoadingLeg(leg())).toBe(true)
    expect(isKushiroLoadingLeg(leg({ originCity: HIROO_ADDRESS }))).toBe(false)
  })

  it('釧路積みの業者は literal で持つ (app 側のマスタ導出とは共有 golden で突き合わせる)', () => {
    // 一致の検証は `kushiro-doto-rebuild.test.ts` の golden (`kushiroLoaders`)。
    expect(KUSHIRO_LOADERS.length).toBeGreaterThanOrEqual(3)
    expect(new Set(KUSHIRO_LOADERS).size).toBe(KUSHIRO_LOADERS.length)
  })
})

describe('運行の分類', () => {
  it('全便が釧路積みなら pure', () => {
    expect(classifyKushiroOperation([leg(), leg({ seq: 2 })])).toBe('pure')
  })

  it('他の積地と混ざれば mixed', () => {
    expect(classifyKushiroOperation([leg(), leg({ seq: 2, originCity: HIROO_ADDRESS })])).toBe('mixed')
  })

  it('釧路積みが 1 本も無ければ none', () => {
    expect(classifyKushiroOperation([leg({ originCity: HIROO_ADDRESS })])).toBe('none')
  })

  it('便の無い運行も none (pure に落ちない)', () => {
    expect(classifyKushiroOperation([])).toBe('none')
  })
})

describe('営業所を差し替えた回送の推定', () => {
  it('出庫 = 営業所 → 初回積地 / 帰庫 = 最終卸地 → 営業所 を同じ方法で出す', () => {
    const op = { firstLoadPoint: KUSHIRO_POINT, lastUnloadPoint: TOKACHI_POINT }
    const obihiro = estimateDepotDeadhead('obihiro', op)
    expect(obihiro.outboundKm).toBeCloseTo(haversineKm(DEPOTS.obihiro, KUSHIRO_POINT)!, 9)
    expect(obihiro.inboundKm).toBeCloseTo(haversineKm(TOKACHI_POINT, DEPOTS.obihiro)!, 9)
    expect(obihiro.totalKm).toBeCloseTo(obihiro.outboundKm! + obihiro.inboundKm!, 9)
  })

  it('釧路へ移すと出庫が縮み、帰庫が伸びる (入れ替え)', () => {
    const op = { firstLoadPoint: KUSHIRO_POINT, lastUnloadPoint: TOKACHI_POINT }
    const obihiro = estimateDepotDeadhead('obihiro', op)
    const kushiro = estimateDepotDeadhead('kushiro', op)
    expect(kushiro.outboundKm!).toBeLessThan(obihiro.outboundKm!)
    expect(kushiro.inboundKm!).toBeGreaterThan(obihiro.inboundKm!)
  })

  it('座標が欠けたら 0 ではなく null (合計も null)', () => {
    expect(estimateDepotDeadhead('kushiro', { firstLoadPoint: null, lastUnloadPoint: TOKACHI_POINT }))
      .toEqual({ outboundKm: null, inboundKm: expect.any(Number), totalKm: null })
    expect(estimateDepotDeadhead('kushiro', { firstLoadPoint: KUSHIRO_POINT, lastUnloadPoint: null }))
      .toEqual({ outboundKm: expect.any(Number), inboundKm: null, totalKm: null })
    expect(estimateDepotDeadhead('kushiro', { firstLoadPoint: null, lastUnloadPoint: null }))
      .toEqual({ outboundKm: null, inboundKm: null, totalKm: null })
  })

  it('営業所のキーは 2 つとも回せる', () => {
    expect(DEPOT_KEYS.slice().sort()).toEqual(['kushiro', 'obihiro'])
  })
})

describe('回送の平均速度 (実測から出す)', () => {
  const idle = (over: Partial<DeadheadSpeedInput> = {}): DeadheadSpeedInput => ({
    preLoadKm: 100, postUnloadKm: 20, preLoadSec: 3600, postUnloadSec: 720, ...over,
  })

  it('Σkm ÷ Σ時間', () => {
    // 120km を 1.2h → 100km/h
    expect(deadheadSpeedKmh([idle()])).toBeCloseTo(100, 9)
    expect(SECONDS_PER_HOUR).toBe(3600)
  })

  it('時刻が読めない区間は km も秒も足さない (片側だけ足して速度を壊さない)', () => {
    expect(deadheadSpeedKmh([idle({ preLoadSec: null })])).toBeCloseTo(100, 9)
    expect(deadheadSpeedKmh([idle({ postUnloadSec: null })])).toBeCloseTo(100, 9)
  })

  it('秒が 1 つも無ければ null (既定値に落とさない)', () => {
    expect(deadheadSpeedKmh([])).toBeNull()
    expect(deadheadSpeedKmh([idle({ preLoadSec: null, postUnloadSec: null })])).toBeNull()
    expect(deadheadSpeedKmh([idle({ preLoadSec: 0, postUnloadSec: 0 })])).toBeNull()
  })
})

describe('回送km を時間・金額に直す', () => {
  it('時間は速度で割るだけ', () => {
    expect(deadheadHours(100, 50)).toBeCloseTo(2, 9)
  })

  it('速度が無い / 0 以下なら null', () => {
    expect(deadheadHours(100, null)).toBeNull()
    expect(deadheadHours(100, 0)).toBeNull()
  })

  it('燃料代は 差km ÷ 燃費 × 単価 (実績とは別立て)', () => {
    expect(deadheadFuelYen(300, { kmPerLiter: 3, yenPerLiter: 122.95 })).toBeCloseTo(12295, 9)
  })

  it('燃費・単価が無い / 0 以下なら null', () => {
    expect(deadheadFuelYen(300, { kmPerLiter: null, yenPerLiter: 122.95 })).toBeNull()
    expect(deadheadFuelYen(300, { kmPerLiter: 0, yenPerLiter: 122.95 })).toBeNull()
    expect(deadheadFuelYen(300, { kmPerLiter: 3, yenPerLiter: null })).toBeNull()
  })
})

describe('集計 (小さな入力での不変条件)', () => {
  const pureOp = operation({
    unkoNo: 'A',
    legs: [leg({ deadheadKm: 130 }), leg({ seq: 2, destCity: '北海道河東郡士幌町士幌', deadheadKm: 127 })],
    kmBreakdown: { preLoadKm: 130, haulKm: 200, betweenKm: 100, postUnloadKm: 27, otherKm: 0 },
  })
  const mixedOp = operation({
    unkoNo: 'B',
    driverName: '柳井 亮祐',
    legs: [leg({ deadheadKm: 130 }), leg({ seq: 2, originCity: HIROO_ADDRESS, deadheadKm: 27 })],
  })
  const noneOp = operation({
    unkoNo: 'C',
    legs: [leg({ originCity: HIROO_ADDRESS, deadheadKm: 157 })],
    firstLoadPoint: null,
  })

  it('分類ごとの合計を足すと全体に戻る', () => {
    const s = summarizeKushiroLoading([pureOp, mixedOp, noneOp])
    expect(s.counts).toEqual({ pure: 1, mixed: 1, none: 1, all: 3 })
    for (const key of ['legs', 'kushiroLegs', 'salesYen', 'allowanceYen', 'haulKm', 'deadheadKm'] as const) {
      expect(s.totals.pure[key] + s.totals.mixed[key] + s.totals.none[key]).toBeCloseTo(s.totals.all[key], 9)
    }
    expect(measuredDeadheadKm(s.totals.all)).toBeCloseTo(s.totals.all.deadheadKm, 9)
  })

  it('釧路積み便だけの行は、混在運行から釧路積み便だけを拾う', () => {
    const s = summarizeKushiroLoading([pureOp, mixedOp, noneOp])
    // 便 = pure 2 本 + mixed の釧路積み 1 本、運行 = pure + mixed の 2 本
    expect(s.kushiroOnly.legs).toBe(3)
    expect(s.kushiroOnly.kushiroLegs).toBe(s.kushiroOnly.legs)
    expect(s.kushiroOnly.operations).toBe(2)
    // 混在運行の士幌積み便の回送 (27km) は入らない
    expect(s.kushiroOnly.deadheadKm).toBeCloseTo(130 + 127 + 130, 9)
  })

  it('座標が欠けた運行は推定に入れず、欠測として数える (0km にしない)', () => {
    const s = summarizeKushiroLoading([pureOp, mixedOp, noneOp])
    expect(s.totals.all.outbound.missingOperations).toBe(1)
    expect(s.totals.all.outbound.estimatedOperations).toBe(2)
    // 較正の分母は「推定を出せた運行だけ」の実測
    expect(s.totals.all.outbound.comparableMeasuredKm).toBeCloseTo(130 + 130, 9)
    expect(s.totals.all.outbound.measuredKm).toBeCloseTo(130 + 130 + 130, 9)
    expect(s.totals.none.outbound.estimatedKm.obihiro).toBe(0)
  })

  it('経路と乗務員の行を足すと全体に戻る (便の無い運行を除く)', () => {
    const s = summarizeKushiroLoading([pureOp, mixedOp, noneOp])
    for (const rows of [s.routes, s.drivers]) {
      for (const key of ['operations', 'legs', 'salesYen', 'haulKm', 'deadheadKm', 'betweenKm', 'otherKm'] as const) {
        const sum = rows.reduce((acc, row) => acc + row.totals[key], 0)
        expect(sum).toBeCloseTo(s.totals.all[key], 9)
      }
      for (const side of ['outbound', 'inbound'] as const) {
        const sum = rows.reduce((acc, row) => acc + row.totals[side].measuredKm, 0)
        expect(sum).toBeCloseTo(s.totals.all[side].measuredKm, 9)
      }
    }
  })

  it('経路の行は分類ごとに分かれる (混在を pure に混ぜない)', () => {
    const s = summarizeKushiroLoading([pureOp, mixedOp, noneOp])
    const kushiroToObihiro = s.routes.filter(row => row.from === '釧路' && row.to === '帯広')
    expect(kushiroToObihiro.map(row => row.kind).sort()).toEqual(['mixed', 'pure'])
  })

  it('帰庫の推定は最終便の経路に載る', () => {
    const s = summarizeKushiroLoading([pureOp])
    const first = s.routes.find(row => row.to === '帯広')!
    const last = s.routes.find(row => row.to === '士幌')!
    expect(first.totals.outbound.estimatedOperations).toBe(1)
    expect(first.totals.inbound.estimatedOperations).toBe(0)
    expect(last.totals.inbound.estimatedOperations).toBe(1)
    expect(last.totals.outbound.estimatedOperations).toBe(0)
  })

  it('便の無い運行は別に数え、経路には載せない', () => {
    const s = summarizeKushiroLoading([operation({ unkoNo: 'D', legs: [] })])
    expect(s.leglessOperations).toBe(1)
    expect(s.counts.none).toBe(1)
    expect(s.routes).toEqual([])
    expect(s.drivers).toHaveLength(1)
    expect(s.totals.all.operations).toBe(1)
  })

  it('同じ乗務員・同じ分類の運行は 1 行に束ねる', () => {
    const s = summarizeKushiroLoading([pureOp, operation({ unkoNo: 'E', legs: [leg()] })])
    expect(s.drivers).toHaveLength(1)
    expect(s.drivers[0]!.totals.operations).toBe(2)
  })

  it('推定 ÷ 実測 の比は較正の分母 (推定できた運行) で割る', () => {
    const s = summarizeKushiroLoading([pureOp])
    const ratio = estimateRatio(s.totals.all.outbound, 'obihiro')!
    expect(ratio).toBeCloseTo(s.totals.all.outbound.estimatedKm.obihiro / 130, 9)
    // 分母が 0 の行 (推定を出せた運行が無い) は null
    expect(estimateRatio(s.totals.none.outbound, 'obihiro')).toBeNull()
  })

  it('営業所の入れ替えの差は 出庫・帰庫を分けて返す。速度を渡さなければ時間は null', () => {
    const s = summarizeKushiroLoading([pureOp])
    const t = s.totals.pure
    const diff = depotShiftDiff(t, 'obihiro', 'kushiro')
    expect(diff.outboundKm).toBeCloseTo(t.outbound.estimatedKm.kushiro - t.outbound.estimatedKm.obihiro, 9)
    expect(diff.inboundKm).toBeCloseTo(t.inbound.estimatedKm.kushiro - t.inbound.estimatedKm.obihiro, 9)
    expect(diff.totalKm).toBeCloseTo(diff.outboundKm + diff.inboundKm, 9)
    expect(diff.hours).toBeNull()
    expect(depotShiftDiff(t, 'obihiro', 'kushiro', 40).hours).toBeCloseTo(diff.totalKm / 40, 9)
  })
})

// --- 共有 fixture (本番 2026-07 の実測に合わせて組んだもの) -------------------

describe('共有 fixture が本番実測の集計に戻る', () => {
  const summary = summarizeKushiroLoading(operations)

  it('全体 (運行・便・売上・手当・売上走行km・回送km)', () => {
    expect(summary.counts.all).toBe(measured.all.operations)
    expect(summary.totals.all.legs).toBe(measured.all.legs)
    expect(summary.totals.all.salesYen).toBe(measured.all.salesYen)
    expect(summary.totals.all.allowanceYen).toBe(measured.all.allowanceYen)
    expect(summary.totals.all.haulKm).toBeCloseTo(measured.all.haulKm, 1)
    expect(summary.totals.all.deadheadKm).toBeCloseTo(measured.all.deadheadKm, 1)
    // 便から数えた回送と、運行の内訳から数えた回送が一致する
    expect(measuredDeadheadKm(summary.totals.all)).toBeCloseTo(measured.all.deadheadKm, 1)
  })

  it('うち釧路積み (便 / 運行 / 売上 / 手当 / km)', () => {
    expect(summary.kushiroOnly.legs).toBe(measured.kushiro.legs)
    expect(summary.kushiroOnly.operations).toBe(measured.kushiro.operations)
    expect(summary.counts.pure).toBe(measured.kushiro.pureOperations)
    expect(summary.counts.mixed).toBe(measured.kushiro.mixedOperations)
    expect(summary.kushiroOnly.salesYen).toBe(measured.kushiro.salesYen)
    expect(summary.kushiroOnly.allowanceYen).toBe(measured.kushiro.allowanceYen)
    expect(summary.kushiroOnly.haulKm).toBeCloseTo(measured.kushiro.haulKm, 1)
    expect(summary.kushiroOnly.deadheadKm).toBeCloseTo(measured.kushiro.deadheadKm, 1)
  })

  it('釧路積みだけの 38 運行の km 内訳 (5 つを足すと総走行km)', () => {
    const t = summary.totals.pure
    expect(t.operations).toBe(measured.pure.operations)
    expect(t.legs).toBe(measured.pure.legs)
    expect(t.outbound.measuredKm).toBeCloseTo(measured.pure.preLoadKm, 1)
    expect(t.haulKm).toBeCloseTo(measured.pure.haulKm, 1)
    expect(t.betweenKm).toBeCloseTo(measured.pure.betweenKm, 1)
    expect(t.inbound.measuredKm).toBeCloseTo(measured.pure.postUnloadKm, 1)
    expect(t.otherKm).toBeCloseTo(measured.pure.otherKm, 1)
  })

  it('経路別 実測 17 本にそのまま戻る (便数 / 売上 / 手当 / 売上走行km / 回送km)', () => {
    const legs = operations.flatMap(op => op.legs.filter(isKushiroLoadingLeg))
    const seen = new Set<string>()
    for (const route of measured.routes) {
      const hit = legs.filter(l => l.destCity === route.destCity)
      seen.add(route.destCity)
      expect({ dest: route.dest, legs: hit.length }).toEqual({ dest: route.dest, legs: route.legs })
      expect(hit.reduce((sum, l) => sum + l.salesYen, 0)).toBe(route.salesYen)
      expect(hit.reduce((sum, l) => sum + l.allowanceYen, 0)).toBe(route.allowanceYen)
      expect(hit.reduce((sum, l) => sum + l.haulKm, 0)).toBeCloseTo(route.haulKm, 1)
      expect(hit.reduce((sum, l) => sum + l.deadheadKm, 0)).toBeCloseTo(route.deadheadKm, 1)
    }
    // 実測の 17 経路で釧路積み便を過不足なく覆う
    expect(seen.size).toBe(measured.routes.length)
    expect(legs.filter(l => !seen.has(l.destCity))).toEqual([])
  })

  it('手当は経路ごとの定額 — 駒場だけ ¥4,500 (暫定手当)', () => {
    const legs = operations.flatMap(op => op.legs.filter(isKushiroLoadingLeg))
    for (const route of measured.routes) {
      const rates = new Set(legs.filter(l => l.destCity === route.destCity).map(l => l.allowanceYen))
      expect(rates.size).toBe(1)
      expect([...rates][0]).toBe(route.allowanceYen / route.legs)
    }
    const komaba = measured.routes.find(r => r.dest === '駒場')!
    expect(komaba.allowanceYen / komaba.legs).toBe(4500)
    // 他の経路は 9,000 / 8,000 (と 卸地なしの 0)。定額でも経路で額が違う
    const rates = new Set(measured.routes.map(r => r.allowanceYen / r.legs))
    expect([...rates].sort((a, b) => a - b)).toEqual([0, 4500, 8000, 9000])
  })

  it('卸地の無い便 (売上 0 / 売上走行 0 / 回送 232km) が 1 本ある', () => {
    const noDest = operations.flatMap(op => op.legs).filter(l => routePlace(l.destCity) === UNKNOWN_PLACE)
    expect(noDest).toHaveLength(1)
    expect(noDest[0]!.salesYen).toBe(0)
    expect(noDest[0]!.allowanceYen).toBe(0)
    expect(noDest[0]!.haulKm).toBe(0)
    expect(noDest[0]!.deadheadKm).toBeGreaterThan(0)
  })

  it('乗務員別の釧路積み便数', () => {
    const byDriver: Record<string, number> = {}
    for (const row of summary.drivers) {
      byDriver[row.driverName] = (byDriver[row.driverName] ?? 0) + row.totals.kushiroLegs
    }
    expect(byDriver).toEqual(measured.driverKushiroLegs)
  })

  it('実測の集計は fixture から直接数えても同じ (集計器を経由しない裏取り)', () => {
    const kushiroLegs = operations.flatMap(op => op.legs.filter(isKushiroLoadingLeg))
    expect(kushiroLegs).toHaveLength(measured.kushiro.legs)
    expect(operations.filter(op => op.legs.every(isKushiroLoadingLeg)).length)
      .toBe(measured.kushiro.pureOperations)
    expect(operations.filter(op => op.legs.some(isKushiroLoadingLeg) && !op.legs.every(isKushiroLoadingLeg)).length)
      .toBe(measured.kushiro.mixedOperations)
    expect(kushiroLegs.reduce((sum, l) => sum + l.salesYen, 0)).toBe(measured.kushiro.salesYen)
    expect(operations.flatMap(op => op.legs).length).toBe(measured.all.legs)
  })

  it('運行の km 内訳の haulKm は、その運行の便の売上走行km の和と一致する', () => {
    for (const op of operations) {
      const legSum = op.legs.reduce((sum, l) => sum + l.haulKm, 0)
      expect(op.kmBreakdown.haulKm).toBeCloseTo(legSum, 6)
    }
  })

  it('拘束時間の fixture は運行の km 内訳と同じ値を持つ (別ファイルが黙ってずれない)', () => {
    expect(idles).toHaveLength(operations.length)
    for (const [i, idle] of idles.entries()) {
      expect(idle.preLoadKm).toBeCloseTo(operations[i]!.kmBreakdown.preLoadKm, 6)
      expect(idle.postUnloadKm).toBeCloseTo(operations[i]!.kmBreakdown.postUnloadKm, 6)
    }
  })
})

describe('営業所を釧路にすると回送はどれだけ変わるか (fixture)', () => {
  const summary = summarizeKushiroLoading(operations)
  const speedKmh = deadheadSpeedKmh(idles)

  it('直線推定は実測の 7 割前後に出る (較正)。この比で推定の当たり外れが読める', () => {
    for (const side of [summary.totals.pure.outbound, summary.totals.pure.inbound]) {
      const ratio = estimateRatio(side, 'obihiro')!
      expect(ratio).toBeGreaterThan(0.6)
      expect(ratio).toBeLessThan(0.85)
    }
  })

  it('釧路積みだけの運行では、消える出庫のぶんを増える帰庫がほとんど食う', () => {
    const diff = depotShiftDiff(summary.totals.pure, 'obihiro', 'kushiro', speedKmh)
    expect(diff.outboundKm).toBeLessThan(0)
    expect(diff.inboundKm).toBeGreaterThan(0)
    // 帰庫の増加が出庫の減少の 7 割以上を打ち消す = 「釧路の方が近い」は成り立たない
    expect(diff.inboundKm / -diff.outboundKm).toBeGreaterThan(0.7)
    expect(diff.hours).toBeCloseTo(diff.totalKm / speedKmh!, 9)
  })

  it('全運行で見ると、釧路積み以外の運行のぶんだけ回送はむしろ増える', () => {
    expect(depotShiftDiff(summary.totals.all, 'obihiro', 'kushiro').totalKm).toBeGreaterThan(0)
  })

  it('経路ごとに符号が反転する — 道東の卸地は近くなり、十勝の卸地は遠くなる', () => {
    const inbound = (row: { totals: Parameters<typeof depotShiftDiff>[0] }) =>
      depotShiftDiff(row.totals, 'obihiro', 'kushiro').inboundKm
    const ending = summary.routes.filter(row => row.totals.inbound.estimatedOperations > 0)
    // 道東 (標茶・別海) で終わる運行は帰庫が**短くなる** = マイナス
    for (const to of ['標茶', '別海']) {
      const row = ending.find(r => r.from === '釧路' && r.to === to)!
      expect(inbound(row)).toBeLessThan(0)
    }
    // 十勝 (帯広・士幌・音更・鹿追) で終わる運行は帰庫が**伸びる** = プラス
    for (const to of ['帯広', '士幌', '音更', '鹿追']) {
      const row = ending.find(r => r.from === '釧路' && r.to === to)!
      expect(inbound(row)).toBeGreaterThan(0)
    }
    // **合計では十勝側が勝つ** — 卸地が十勝に集中しているから
    expect(depotShiftDiff(summary.totals.pure, 'obihiro', 'kushiro').inboundKm).toBeGreaterThan(0)
  })

  it('卸地の座標が無い運行は帰庫の推定に入れず、欠測として数える (落ちない)', () => {
    const noDestOp = operations.find(op => routePlace(op.legs[op.legs.length - 1]!.destCity) === UNKNOWN_PLACE)!
    expect(noDestOp.lastUnloadPoint ?? null).toBeNull()
    // 出庫は出せるので、出庫の欠測より帰庫の欠測が多い
    expect(summary.totals.all.inbound.missingOperations)
      .toBeGreaterThan(summary.totals.all.outbound.missingOperations)
    // 欠測ぶんは実測にだけ入っていて、較正の分母には入らない
    expect(summary.totals.all.inbound.measuredKm)
      .toBeGreaterThan(summary.totals.all.inbound.comparableMeasuredKm)
  })

  it('便間と分類不能は営業所を変えても動かない', () => {
    // 差に入るのは出庫と帰庫だけ (`depotShiftDiff` は betweenKm / otherKm を見ない)
    const diff = depotShiftDiff(summary.totals.all, 'obihiro', 'kushiro')
    expect(diff.totalKm).toBeCloseTo(diff.outboundKm + diff.inboundKm, 9)
    expect(summary.totals.all.betweenKm).toBeGreaterThan(0)
    expect(summary.totals.all.otherKm).toBeGreaterThan(0)
  })
})

// --- golden (双子の bit 一致) --------------------------------------------------

describe('双子の出力が app 側 golden と 1 ビットも違わない', () => {
  it('summarizeKushiroLoading + depotShiftDiff + deadheadSpeedKmh', () => {
    const summary = summarizeKushiroLoading(operations)
    const speedKmh = deadheadSpeedKmh(idles)
    const output = {
      speedKmh,
      shift: {
        pure: depotShiftDiff(summary.totals.pure, 'obihiro', 'kushiro', speedKmh),
        kushiroOnly: depotShiftDiff(summary.kushiroOnly, 'obihiro', 'kushiro', speedKmh),
        all: depotShiftDiff(summary.totals.all, 'obihiro', 'kushiro', speedKmh),
      },
      summary,
    }
    expect(JSON.parse(JSON.stringify(output))).toEqual(golden)
  })
})
