// 粗利タブ「釧路積み (釧路営業所試算)」区画の表示素材 (Refs #760 の 36)。
//
// **数字そのものの正しさは `kushiro-doto-rebuild.test.ts` が golden で固定済み。**
// ここが見るのは
//   1. golden と同じ 4 点 (1 / 実測平均 / 2 / 3 便/日) が**実測分布から**出ること
//   2. 最低賃金マスタのキーの流儀が 2 つあっても額が引けること (本番実測の形)
//   3. 欠測が 0 に倒れず `null` (画面では「−」) のままであること
// の 3 つ。
import { describe, expect, it } from 'vitest'
import {
  DASH,
  DEPOT_LABELS,
  KUSHIRO_FUEL_KM_PER_LITER,
  KUSHIRO_FUEL_YEN_PER_LITER,
  KUSHIRO_MIN_WAGE_BRANCH,
  KUSHIRO_MONTHLY_LABOR_COST_YEN,
  LEGS_PER_DAY_STEP,
  MIN_WAGE_TONE_LABEL,
  VIEWER_COMP_STORAGE_KEYS,
  amountTone,
  buildKushiroBranchView,
  fmtHours,
  fmtKm,
  fmtNum,
  fmtSignedYen,
  fmtYen,
  legsPerDayCandidates,
  legsPerDaySlider,
  minWageLegsPerDay,
  minWageTone,
  readViewerCompId,
  resolveKushiroMinWage,
} from '../../app/utils/kushiro-branch-view'
import { emptyRebuildTotals, summarizeDotoRebuild } from '../../app/utils/kushiro-doto-rebuild'
import type { LegsPerRunDistribution, RebuildOperationInput } from '../../app/utils/kushiro-doto-rebuild'
import type { MinWageMaster } from '../../app/utils/restraint-wage-view'
import rawOperations from '../fixtures/kushiro-loading/doto-operations-2026-07.json'
import golden from '../fixtures/kushiro-loading/golden/doto-2026-07.json'

const operations = rawOperations as unknown as RebuildOperationInput[]

/**
 * **本番 R2 の min-wage マスタの形をそのまま写したもの** (2026-08-23 実測)。
 * 県名キー / `branchToPrefecture` は社員マスタ由来なので **実在しない釧路営業所は
 * 載らない** / `defaultPrefecture` は無い。
 */
const PROD_MASTER: MinWageMaster = {
  prefectures: {
    北海道: [{ effectiveFrom: '2025-10-04', rate: 1075 }],
    東京都: [{ effectiveFrom: '2025-10-01', rate: 1226 }],
  },
  branchToPrefecture: { 帯広: '北海道', 本社: '東京都' },
}

const YM = '2026-07'

function view(
  over: Partial<Parameters<typeof buildKushiroBranchView>[1]> & { operations?: RebuildOperationInput[] } = {},
) {
  const { operations: ops = operations, ...options } = over
  return buildKushiroBranchView(ops, { ym: YM, minWageMaster: PROD_MASTER, ...options })
}

function distribution(over: Partial<LegsPerRunDistribution> = {}): LegsPerRunDistribution {
  return { operations: 0, legs: 0, buckets: [], mean: null, ...over }
}

describe('表示 (欠測は 0 に倒さず「−」)', () => {
  it('null は DASH、数は丸めて出す', () => {
    expect(fmtYen(null)).toBe(DASH)
    expect(fmtYen(1234.6)).toBe('¥1,235')
    expect(fmtKm(null)).toBe(DASH)
    expect(fmtKm(1705.1226)).toBe('1705.1km')
    expect(fmtHours(null)).toBe(DASH)
    expect(fmtHours(92.5)).toBe('92.5h')
    expect(fmtNum(null)).toBe(DASH)
    expect(fmtNum(1.6521739, 2)).toBe('1.65')
  })

  it('最低賃金差は符号を付ける (0 は +)', () => {
    expect(fmtSignedYen(null)).toBe(DASH)
    expect(fmtSignedYen(849.3)).toBe('+¥849')
    expect(fmtSignedYen(0)).toBe('+¥0')
    expect(fmtSignedYen(-351.3)).toBe('−¥351')
  })

  it('色分けは null を unknown に落とす (false に倒さない)', () => {
    expect(minWageTone(null)).toBe('unknown')
    expect(minWageTone(true)).toBe('ng')
    expect(minWageTone(false)).toBe('ok')
    expect(MIN_WAGE_TONE_LABEL[minWageTone(null)]).toBe(DASH)
    expect(MIN_WAGE_TONE_LABEL.ng).toBe('割れ')
    expect(amountTone(null)).toBe('unknown')
    expect(amountTone(-1)).toBe('ng')
    expect(amountTone(0)).toBe('ok')
  })
})

describe('最低賃金マスタのキーの食い違い', () => {
  it('本番の形 (県名キー) から、実在する営業所 帯広 の県で ¥1,075 を引ける', () => {
    const hit = resolveKushiroMinWage(PROD_MASTER, YM)
    expect(hit).toEqual({
      rate: 1075,
      key: '北海道',
      source: 'branch',
      effectiveFrom: '2025-10-04',
      triedKeys: ['北海道', '全社共通'],
    })
    // 釧路営業所は `branchToPrefecture` に載っていない (社員マスタ由来なので当然)
    expect(PROD_MASTER.branchToPrefecture['釧路営業所']).toBeUndefined()
    expect(PROD_MASTER.branchToPrefecture[KUSHIRO_MIN_WAGE_BRANCH]).toBe('北海道')
  })

  it('マスタの既定県も使う (帯広が載っていない形)', () => {
    const hit = resolveKushiroMinWage({
      prefectures: { 北海道: [{ effectiveFrom: '2025-10-04', rate: 1075 }] },
      branchToPrefecture: {},
      defaultPrefecture: '北海道',
    }, YM)
    expect(hit.rate).toBe(1075)
    expect(hit.source).toBe('default-prefecture')
    expect(hit.triedKeys).toEqual(['北海道', '全社共通'])
  })

  it('フロントの単価マスタタブが書く「全社共通」からも引ける', () => {
    const hit = resolveKushiroMinWage({
      prefectures: { 全社共通: [{ effectiveFrom: '2025-10-04', rate: 1075 }] },
      branchToPrefecture: {},
    }, YM)
    expect(hit.rate).toBe(1075)
    expect(hit.source).toBe('company-key')
    expect(hit.key).toBe('全社共通')
  })

  it('対象月に有効な行が無ければ null (0 に倒さない)', () => {
    // 発効が対象月より後 → 引けない
    expect(resolveKushiroMinWage({
      prefectures: { 北海道: [{ effectiveFrom: '2026-10-01', rate: 1120 }] },
      branchToPrefecture: { 帯広: '北海道' },
    }, YM)).toEqual({
      rate: null, key: null, source: null, effectiveFrom: null, triedKeys: ['北海道', '全社共通'],
    })
    // マスタ未取得
    expect(resolveKushiroMinWage(null, YM).rate).toBeNull()
    expect(resolveKushiroMinWage(null, YM).triedKeys).toEqual(['全社共通'])
  })

  it('改定履歴があれば対象月に有効な最新を採る', () => {
    const master: MinWageMaster = {
      prefectures: {
        北海道: [
          { effectiveFrom: '2024-10-01', rate: 1010 },
          { effectiveFrom: '2025-10-04', rate: 1075 },
          { effectiveFrom: '2026-10-01', rate: 1120 },
        ],
      },
      branchToPrefecture: { 帯広: '北海道' },
    }
    expect(resolveKushiroMinWage(master, '2026-07').rate).toBe(1075)
    expect(resolveKushiroMinWage(master, '2025-09').rate).toBe(1010)
    expect(resolveKushiroMinWage(master, '2026-11').rate).toBe(1120)
  })

  it('改定履歴が降順で入っていても最新を採る (並びを前提にしない)', () => {
    expect(resolveKushiroMinWage({
      prefectures: {
        北海道: [
          { effectiveFrom: '2025-10-04', rate: 1075 },
          { effectiveFrom: '2024-10-01', rate: 1010 },
        ],
      },
      branchToPrefecture: { 帯広: '北海道' },
    }, '2026-07')).toMatchObject({ rate: 1075, effectiveFrom: '2025-10-04' })
  })

  it('branchToPrefecture ごと欠けた応答でも落ちない (全社共通へ落ちる)', () => {
    // 型では必須だが、上流が `{}` を返す事故はあり得る。**落ちるより「−」**。
    const broken = { prefectures: { 全社共通: [{ effectiveFrom: '2025-10-04', rate: 1075 }] } } as unknown as MinWageMaster
    expect(resolveKushiroMinWage(broken, YM)).toMatchObject({ rate: 1075, key: '全社共通', source: 'company-key' })
    expect(resolveKushiroMinWage({} as unknown as MinWageMaster, YM).rate).toBeNull()
  })
})

describe('会社ID の探し方', () => {
  function storage(entries: Record<string, string>) {
    return { getItem: (k: string) => entries[k] ?? null }
  }

  it('セッション → 閲覧モードの手入力 → 前回ログイン の順で探す', () => {
    expect(VIEWER_COMP_STORAGE_KEYS).toEqual([
      'theearth-session', 'restraint-viewer-comp', 'theearth-last-account',
    ])
    expect(readViewerCompId(storage({ 'theearth-session': '{"compId":"27324455"}' }))).toBe('27324455')
    expect(readViewerCompId(storage({ 'restraint-viewer-comp': ' 27324455 ' }))).toBe('27324455')
    expect(readViewerCompId(storage({ 'theearth-last-account': '{"compId":"999"}' }))).toBe('999')
  })

  it('空・壊れた JSON・compId 無しは次の候補へ落ちる', () => {
    expect(readViewerCompId(storage({
      'theearth-session': '',
      'restraint-viewer-comp': '27324455',
    }))).toBe('27324455')
    expect(readViewerCompId(storage({
      'theearth-session': '{壊れ',
      'theearth-last-account': '{"compId":"999"}',
    }))).toBe('999')
    expect(readViewerCompId(storage({ 'theearth-session': '{"compId":123}' }))).toBe('')
    expect(readViewerCompId(storage({}))).toBe('')
    expect(readViewerCompId(null)).toBe('')
  })
})

describe('便/日 の既定は実測分布から出す', () => {
  const summary = summarizeDotoRebuild(operations)

  it('候補は「観測された便数 + 実測平均」= golden と同じ 4 点', () => {
    const candidates = legsPerDayCandidates(summary.distribution)
    expect(candidates).toEqual(golden.doto.sensitivity.map(r => r.legsPerDay))
    expect(candidates).toEqual([1, golden.doto.legsPerRun, 2, 3])
  })

  it('スライダーの上下限も実測分布から出す (定数で決め打ちしない)', () => {
    const slider = legsPerDaySlider(summary.distribution)
    expect(slider).toEqual({
      min: 1, max: 3, mean: golden.doto.legsPerRun, step: LEGS_PER_DAY_STEP, disabled: false,
    })
  })

  it('観測が 1 種類 / 0 件なら振れないので無効にする', () => {
    expect(legsPerDaySlider(distribution({
      operations: 2, legs: 4, buckets: [{ legsInOperation: 2, operations: 2 }], mean: 2,
    }))).toEqual({ min: 2, max: 2, mean: 2, step: LEGS_PER_DAY_STEP, disabled: true })
    // 観測 0 件のときの 0 は「つまみの範囲」であって測定値ではない (mean は null のまま)
    expect(legsPerDaySlider(distribution())).toEqual({
      min: 0, max: 0, mean: null, step: LEGS_PER_DAY_STEP, disabled: true,
    })
    expect(legsPerDayCandidates(distribution())).toEqual([])
  })

  it('0 以下の観測は候補に入れない (0 除算を持ち込まない)', () => {
    expect(legsPerDayCandidates(distribution({
      buckets: [{ legsInOperation: 0, operations: 1 }, { legsInOperation: 2, operations: 1 }],
      mean: 2,
    }))).toEqual([2])
  })
})

describe('最低賃金をちょうど満たす 便/日', () => {
  const totals = summarizeDotoRebuild(operations).totals

  it('帯広発は ≒2.09 便/日 が境界 (2 便/日 では割り、3 便/日 でクリア)', () => {
    const n = minWageLegsPerDay(totals, 'obihiro', 311000, 1075)
    expect(n).toBeCloseTo(2.09, 2)
    // 境界の意味 = そこで換算時給がちょうど最低賃金になる
    const at = golden.doto.sensitivityObihiro
    expect(at.find(r => r.legsPerDay === 2)!.belowMinWage).toBe(true)
    expect(at.find(r => r.legsPerDay === 3)!.belowMinWage).toBe(false)
  })

  it('釧路発は 1 便/日 でも上回るので境界は 1 便/日 を下回る', () => {
    const n = minWageLegsPerDay(totals, 'kushiro', 311000, 1075)
    expect(n).not.toBeNull()
    expect(n!).toBeLessThan(1)
    expect(golden.doto.sensitivity.every(r => r.belowMinWage === false)).toBe(true)
  })

  it('額が無い / 回送の実測秒が無い / 予算が足りないときは null (端に倒さない)', () => {
    expect(minWageLegsPerDay(totals, 'obihiro', 311000, null)).toBeNull()
    expect(minWageLegsPerDay(totals, 'obihiro', 311000, 0)).toBeNull()
    // 速度が出ない (回送の実測秒が 1 秒も無い)
    expect(minWageLegsPerDay(emptyRebuildTotals(), 'obihiro', 311000, 1075)).toBeNull()
    // どれだけ便/日 を増やしても届かない (賃金が低すぎて回送km の予算がマイナス)
    expect(minWageLegsPerDay(totals, 'obihiro', 1000, 1075)).toBeNull()
    // 運行の端が 0 以下 = 便/日 を増やしても回送が減らない
    const flat = { ...totals, depotToLoadKm: { obihiro: 0, kushiro: 0 }, destToDepotKm: { obihiro: 0, kushiro: 0 } }
    expect(minWageLegsPerDay(flat, 'obihiro', 311000, 1075)).toBeNull()
  })
})

describe('画面に渡す形に畳む', () => {
  it('選択中の 便/日 を省略すると実測平均になり、golden と同じ数字が並ぶ', () => {
    const v = view()
    expect(v.empty).toBe(false)
    expect(v.legsPerDay).toBeCloseTo(golden.doto.legsPerRun, 12)
    const [obihiro, kushiro] = v.selected.depots
    expect(obihiro!.label).toBe(DEPOT_LABELS.obihiro)
    expect(kushiro!.label).toBe(DEPOT_LABELS.kushiro)
    const goldenMean = golden.doto.sensitivity.find(r => r.legsPerDay === golden.doto.legsPerRun)!
    const goldenMeanObihiro = golden.doto.sensitivityObihiro.find(r => r.legsPerDay === golden.doto.legsPerRun)!
    expect(kushiro!.hourlyYen).toBeCloseTo(goldenMean.hourlyYen, 9)
    expect(kushiro!.operatingMarginYen).toBeCloseTo(goldenMean.operatingMarginYen, 6)
    expect(obihiro!.hourlyYen).toBeCloseTo(goldenMeanObihiro.hourlyYen, 9)
    expect(obihiro!.operatingMarginYen).toBeCloseTo(goldenMeanObihiro.operatingMarginYen, 6)
  })

  it('感度分析の 4 点が golden と一致する (釧路発 ¥1,915〜1,930 / 帯広発 ¥724〜1,243)', () => {
    const grid = view().grid
    expect(grid.map(r => r.legsPerDay)).toEqual(golden.doto.sensitivity.map(r => r.legsPerDay))
    expect(grid.map(r => r.isMean)).toEqual([false, true, false, false])
    const kushiro = grid.map(r => Math.round(r.depots[1]!.hourlyYen!))
    const obihiro = grid.map(r => Math.round(r.depots[0]!.hourlyYen!))
    expect(kushiro).toEqual([1915, 1924, 1926, 1930])
    expect(obihiro).toEqual([724, 961, 1054, 1243])
    // 帯広発は 3 便/日 で初めてクリアする
    expect(grid.map(r => r.depots[0]!.belowMinWage)).toEqual([true, true, true, false])
    expect(grid.map(r => r.depots[1]!.belowMinWage)).toEqual([false, false, false, false])
  })

  it('選択中の 便/日 を渡すとそこで出し直す (売上・手当・売上走行は動かない)', () => {
    const v = view({ legsPerDay: 3 })
    expect(v.legsPerDay).toBe(3)
    const [obihiro, kushiro] = v.selected.depots
    expect(Math.round(kushiro!.hourlyYen!)).toBe(1930)
    expect(Math.round(obihiro!.operatingMarginYen!)).toBe(396644)
    expect(Math.round(kushiro!.operatingMarginYen!)).toBe(506549)
    expect(v.summary.salesYen).toBe(view().summary.salesYen)
    expect(v.summary.haulKm).toBe(view().summary.haulKm)
  })

  it('サマリは実測 (38 便 / 23 運行) で、道東だけで閉じた運行は 0 本', () => {
    const s = view().summary
    expect(s.legs).toBe(38)
    expect(s.operations).toBe(23)
    expect(s.pureOperations).toBe(0)
    expect(s.mixedOperations).toBe(23)
    expect(s.salesYen).toBe(golden.doto.summary.totals.salesYen)
    expect(s.allowanceYen).toBe(golden.doto.summary.totals.allowanceYen)
    expect(s.measuredDeadheadKm).toBeCloseTo(4288.9, 6)
    expect(s.missingLegs).toBe(0)
    // 共有 fixture の卸地はぜんぶ実測 (運行終了の代用は 1 本も無い)。
    expect(s.substitutedUnloadLegs).toBe(0)
    expect(s.haulSpeedKmh).toBeCloseTo(golden.doto.speedKmh.haul, 9)
    expect(s.deadheadSpeedKmh).toBeCloseTo(golden.doto.speedKmh.deadhead, 9)
  })

  it('卸地を運行終了で代用した便は、サマリにも 経路別・乗務員別 にも数が出る (黙って混ぜない)', () => {
    const marked: RebuildOperationInput[] = operations.map(op => ({
      ...op,
      legs: op.legs.map(l => ({ ...l, unloadFromOperationEnd: true })),
    }))
    const v = view({ operations: marked })
    expect(v.summary.legs).toBe(38)
    expect(v.summary.missingLegs).toBe(0)
    // 推定に入った便ぜんぶが代用 (欠測 0 なので 38 便すべて)。
    expect(v.summary.substitutedUnloadLegs).toBe(38)
    for (const rows of [v.routes, v.drivers]) {
      expect(rows.reduce((a, r) => a + r.substitutedUnloadLegs, 0)).toBe(38)
    }
    // **推定の数字そのものは 1 つも動かない** (代用は印であって座標ではない)。
    expect(v.selected).toEqual(view().selected)
    expect(v.routes.map(r => r.depotDiffKm)).toEqual(view().routes.map(r => r.depotDiffKm))
  })

  it('経路別・乗務員別を足すと全体に戻る (行の推定を足しても全体の推定になる)', () => {
    const v = view()
    const sum = (rows: typeof v.routes, pick: (r: typeof v.routes[number]) => number) =>
      rows.reduce((a, r) => a + pick(r), 0)
    for (const rows of [v.routes, v.drivers]) {
      expect(sum(rows, r => r.legs)).toBe(v.summary.legs)
      expect(sum(rows, r => r.salesYen)).toBe(v.summary.salesYen)
      expect(sum(rows, r => r.rebuiltDeadheadKm.kushiro!))
        .toBeCloseTo(v.selected.depots[1]!.rebuiltDeadheadKm!, 6)
    }
    expect(v.routes.map(r => r.label)).toEqual(['釧路 → 標茶', '釧路 → 別海'])
    expect(v.routes[0]!.depotDiffKm).toBeLessThan(0)
  })

  it('前提は #760 の 34 の golden と同じ (換算時給の分子は手当の実績)', () => {
    const a = view().assumptions
    expect(a.monthlyWageYen).toBe(311000)
    expect(a.monthlyLaborCostYen).toBe(KUSHIRO_MONTHLY_LABOR_COST_YEN)
    expect(a.kmPerLiter).toBe(KUSHIRO_FUEL_KM_PER_LITER)
    expect(a.yenPerLiter).toBe(KUSHIRO_FUEL_YEN_PER_LITER)
    expect(a.legsPerDriverMonth).toBe(57)
    expect(a.runsPerDriverMonth).toBeCloseTo(91 / 5, 12)
  })

  it('損益分岐は候補の中から探す (釧路発は実測平均で黒字、帯広発は 3 便/日)', () => {
    const v = view()
    expect(v.breakEvenLegsPerDay.kushiro).toBeCloseTo(golden.doto.breakEvenLegsPerDay, 12)
    expect(v.breakEvenLegsPerDay.obihiro).toBe(3)
    expect(v.minWageLegsPerDay.obihiro).toBeCloseTo(2.09, 2)
  })

  it('最低賃金マスタが無くても区画は出て、額の列だけ null になる', () => {
    const v = view({ minWageMaster: null })
    expect(v.minWage.rate).toBeNull()
    expect(v.selected.depots.every(d => d.minWageDiffYen === null)).toBe(true)
    expect(v.selected.depots.every(d => d.belowMinWage === null)).toBe(true)
    // 額に依らない列は出る
    expect(v.selected.depots.every(d => d.hourlyYen !== null)).toBe(true)
    expect(v.minWageLegsPerDay.obihiro).toBeNull()
  })

  it('対象便が 1 本も無ければ empty (0 除算を持ち込まない)', () => {
    const v = buildKushiroBranchView([], { ym: YM, minWageMaster: PROD_MASTER })
    expect(v.empty).toBe(true)
    expect(v.legsPerDay).toBe(0)
    expect(v.grid).toEqual([])
    expect(v.routes).toEqual([])
    expect(v.drivers).toEqual([])
    expect(v.summary.operations).toBe(0)
    expect(v.selected.depots.every(d => d.rebuiltDeadheadKm === null)).toBe(true)
    expect(v.selected.depots.every(d => d.hourlyYen === null)).toBe(true)
    expect(v.breakEvenLegsPerDay.kushiro).toBeNull()
  })

  it('絞り込みを釧路積みぜんぶに広げると 74 便になり、欠測 2 便もそのまま出る', () => {
    const all = view({ area: 'all' })
    expect(all.summary.legs).toBe(74)
    // 釧路積みに広げても「その運行の全便が対象」の運行は 1 本も無い (実測)
    expect(all.summary.pureOperations).toBe(0)
    // 座標が欠けた便は推定に入れず、欠測として残す (0km に倒さない)
    expect(all.summary.missingLegs).toBe(2)
  })

  it('対象便だけで閉じた運行は pure に数える (対象外の便が混ざれば mixed)', () => {
    const leg = (originCity: string) => ({
      seq: 1, originCity, destCity: '北海道川上郡標茶町多和', salesYen: 0, allowanceYen: 0,
      haulKm: 0, deadheadKm: 0, loadPoint: null, unloadPoint: null, haulSec: null, deadheadSec: null,
    })
    const ops = [
      { unkoNo: 'A', driverName: '甲', kmBreakdown: null, legs: [leg('北海道釧路市西港'), leg('北海道釧路市西港')] },
      { unkoNo: 'B', driverName: '乙', kmBreakdown: null, legs: [leg('北海道釧路市西港'), leg('北海道帯広市川西町')] },
      // 対象便を 1 本も含まない運行は数えない
      { unkoNo: 'C', driverName: '丙', kmBreakdown: null, legs: [leg('北海道帯広市川西町')] },
    ] as unknown as RebuildOperationInput[]
    const v = buildKushiroBranchView(ops, { ym: YM, minWageMaster: PROD_MASTER })
    expect(v.summary.pureOperations).toBe(1)
    expect(v.summary.mixedOperations).toBe(1)
    expect(v.summary.operations).toBe(2)
    expect(v.summary.legs).toBe(3)
  })
})
