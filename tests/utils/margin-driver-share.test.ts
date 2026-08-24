// 乗務員ごとの 100% 積み上げ棒 (Refs #760 の 39)。
//
// **表示専用の並べ替えなので、固定するのは 2 つ**:
//   1. 棒の 5 区分を足すと 100% になる (= 表の売上をぜんぶ塗り切る)
//   2. 棒の売上・区分の額が**乗務員の表の列そのもの**である
// 棒は `OperationMargin[]` から `groupMarginsByDriver` (= 表が使う関数そのもの) を
// 通して作った `DriverMargin[]` に対して測る — テスト用に totals を手で書くと
// 「表と一致」を確かめたことにならない。
import { describe, expect, it } from 'vitest'
import { driverShareBars } from '~/utils/margin-driver-share'
import { groupMarginsByDriver, summarizeMargins, SHARE_SEGMENT_LABELS, type OperationMargin } from '~/utils/margin'

const RATE = { yenPerLiter: 120, kmPerLiter: 3, dieselTaxPerLiter: 0 }

/** 運行 1 本。既定は「粗利を出せた運行」(燃料も売上走行/回送に分かれている)。 */
function op(over: Partial<OperationMargin> = {}): OperationMargin {
  const base: OperationMargin = {
    unkoNo: 'U1',
    date: '2026-07-01',
    driverName: '甲',
    vehicleCode: '1109',
    totalKm: 150,
    listedTotalKm: 150,
    kmBreakdown: { preLoadKm: 20, haulKm: 100, betweenKm: 10, postUnloadKm: 20, otherKm: 0 },
    vehicleTotalKm: 1000,
    salesYen: 100000,
    allowanceYen: 28000,
    fuelYen: 29000,
    fuelHaulYen: 16000,
    fuelDeadheadYen: 13000,
    directCostYen: 5000,
    allocatedCostYen: 4000,
    marginYen: 34000,
    laborYen: 30000,
    fuelRate: { ...RATE },
    costsMissing: false,
    runCostShareFallback: false,
    legs: [],
  }
  return { ...base, ...over }
}

const pcts = (bar: { segments: { key: string, yen: number, pct: number }[] }) =>
  Object.fromEntries(bar.segments.map(s => [s.key, s.pct]))
const yens = (bar: { segments: { key: string, yen: number }[] }) =>
  Object.fromEntries(bar.segments.map(s => [s.key, s.yen]))

describe('driverShareBars — 乗務員ごとの 100% 積み上げ棒 (Refs #760 の 39)', () => {
  it('先頭は合計、続けて渡された順 (= 表の 乗務員CD 順) で 1 本ずつ。segments は凡例の順', () => {
    const drivers = groupMarginsByDriver([
      op({ driverName: '乙', unkoNo: 'U9' }),
      op({ driverName: '甲', unkoNo: 'U1' }),
      op({ driverName: '甲', unkoNo: 'U2' }),
    ])
    // `groupMarginsByDriver` は名前の文字列順で返す (乙 → 甲)。画面はここから
    // 乗務員CD 順に並べ替えるので、**棒は渡された順をそのまま守る**ことを
    // 逆順 (甲 → 乙) で渡して確かめる。
    expect(drivers.map(d => d.driverName)).toEqual(['乙', '甲'])
    const res = driverShareBars([...drivers].reverse())
    expect(res.skipped).toBe(0)
    expect(res.bars.map(b => [b.key, b.label, b.operations, b.salesYen])).toEqual([
      ['total', '合計', 3, 300000],
      ['甲', '甲', 2, 200000],
      ['乙', '乙', 1, 100000],
    ])
    expect(res.bars.map(b => b.segments.map(s => s.key)))
      .toEqual(Array(3).fill(SHARE_SEGMENT_LABELS.map(l => l.key)))
  })

  it('区分の額は表の列そのもの (運行経費の配分 = 直課経費 + 固定費按分)、pct の和は 100', () => {
    const drivers = groupMarginsByDriver([op({ driverName: '甲' })])
    const res = driverShareBars(drivers)
    const t = drivers[0]!.totals
    for (const bar of res.bars) {
      // 表の列と 1 円も違わない
      expect(bar.salesYen).toBe(t.salesYen)
      expect(yens(bar)).toEqual({
        allowance: t.allowanceYen,
        fuelHaul: t.fuelHaulYen,
        fuelDeadhead: t.fuelDeadheadYen,
        runCost: t.directCostYen + t.allocatedCostYen,
        margin: t.marginYen,
      })
      expect(pcts(bar)).toEqual({ allowance: 28, fuelHaul: 16, fuelDeadhead: 13, runCost: 9, margin: 34 })
      expect(bar.segments.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100, 9)
      expect(bar.overflowPct).toBe(0)
      expect(bar.noMarginOperations).toBe(0)
      expect(bar.fuelUnsplitYen).toBe(0)
    }
  })

  it('乗務員ごとに額が違っても、それぞれの棒の 5 区分の和はちょうど 100%', () => {
    const drivers = groupMarginsByDriver([
      op({ driverName: '甲', salesYen: 250000, allowanceYen: 70000, fuelYen: 41000, fuelHaulYen: 30000, fuelDeadheadYen: 11000, directCostYen: 9000, allocatedCostYen: 7000, marginYen: 123000 }),
      op({ driverName: '乙', salesYen: 80000, allowanceYen: 30000, fuelYen: 20000, fuelHaulYen: 12000, fuelDeadheadYen: 8000, directCostYen: 1000, allocatedCostYen: 2000, marginYen: 27000 }),
    ])
    const res = driverShareBars(drivers)
    for (const bar of res.bars) {
      expect(bar.segments.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100, 9)
      expect(bar.overflowPct).toBe(0)
    }
    // 合計は Σ (乗務員の棒の和ではなく summarizeMargins にもう一度畳ませている)
    expect(res.bars[0]!.salesYen).toBe(330000)
    expect(yens(res.bars[0]!)).toEqual({ allowance: 100000, fuelHaul: 42000, fuelDeadhead: 19000, runCost: 19000, margin: 150000 })
  })

  it('合計は `summarizeMargins` の値と 1 円も違わない (= 粗利タブの合計)', () => {
    const ops = [
      op({ driverName: '甲', salesYen: 250000, marginYen: 123000 }),
      op({ driverName: '乙', salesYen: 80000, allowanceYen: 30000, marginYen: 18000 }),
    ]
    const total = summarizeMargins(ops)
    const bar = driverShareBars(groupMarginsByDriver(ops)).bars[0]!
    expect(bar.key).toBe('total')
    expect(bar.operations).toBe(total.operations)
    expect(bar.salesYen).toBe(total.salesYen)
    expect(yens(bar)).toEqual({
      allowance: total.allowanceYen,
      fuelHaul: total.fuelHaulYen,
      fuelDeadhead: total.fuelDeadheadYen,
      runCost: total.directCostYen + total.allocatedCostYen,
      margin: total.marginYen,
    })
  })

  it('pct は丸めない (表示側で 1 桁に丸める)', () => {
    const res = driverShareBars(groupMarginsByDriver([
      op({ driverName: '甲', salesYen: 3, allowanceYen: 1, fuelYen: 0, fuelHaulYen: 0, fuelDeadheadYen: 0, directCostYen: 0, allocatedCostYen: 0, marginYen: 2 }),
    ]))
    const a = res.bars[1]!
    expect(pcts(a).allowance).toBeCloseTo(33.333333333, 9)
    expect(pcts(a).margin).toBeCloseTo(66.666666667, 9)
    expect(pcts(a).allowance).not.toBe(33.3)
  })

  it('粗利を出せない運行が混ざる乗務員は、その売上ぶんが塗られず 100% に届かない (印は noMarginOperations)', () => {
    // 出せる運行 (売上 100000) + 出せない運行 (売上 60000。燃料も粗利も null)
    const res = driverShareBars(groupMarginsByDriver([
      op({ driverName: '甲' }),
      op({ driverName: '甲', unkoNo: 'U2', salesYen: 60000, allowanceYen: 0, fuelYen: null, fuelHaulYen: null, fuelDeadheadYen: null, directCostYen: 0, allocatedCostYen: 0, marginYen: null }),
    ]))
    const a = res.bars[1]!
    expect(a.noMarginOperations).toBe(1)
    expect(a.salesYen).toBe(160000)
    // 塗られるのは 100000 ぶんだけ = 62.5%
    expect(a.segments.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(62.5, 9)
    expect(a.overflowPct).toBe(0)
  })

  it('売上走行と回送に分けられなかった燃料代は、どちらの燃料区分にも寄せない (印は fuelUnsplitYen)', () => {
    // `区間距離` の列が無い CSV の運行: fuelYen はあるが haul/deadhead が null
    const res = driverShareBars(groupMarginsByDriver([
      op({ driverName: '甲', fuelHaulYen: null, fuelDeadheadYen: null }),
    ]))
    const a = res.bars[1]!
    expect(a.fuelUnsplitYen).toBe(29000)
    expect(yens(a).fuelHaul).toBe(0)
    expect(yens(a).fuelDeadhead).toBe(0)
    // 燃料 29000 ぶん (29%) だけ棒が届かない。粗利の額は変わらない
    expect(a.segments.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(71, 9)
    expect(yens(a).margin).toBe(34000)
  })

  it('費用 4 区分が売上を超えたら 100 に縮め、超過分を overflowPct に出す (粗利の pct は 0)', () => {
    // 手当 60000 + 燃料 40000 + 30000 + 配分 20000 = 150000 > 売上 100000
    const res = driverShareBars(groupMarginsByDriver([
      op({ driverName: '甲', allowanceYen: 60000, fuelYen: 70000, fuelHaulYen: 40000, fuelDeadheadYen: 30000, directCostYen: 12000, allocatedCostYen: 8000, marginYen: -50000 }),
    ]))
    const a = res.bars[1]!
    expect(a.segments.reduce((sum, s) => sum + s.pct, 0)).toBeCloseTo(100, 9)
    expect(pcts(a).allowance).toBeCloseTo(40, 9)
    expect(pcts(a).fuelHaul).toBeCloseTo(80 / 3, 9)
    expect(pcts(a).fuelDeadhead).toBeCloseTo(20, 9)
    expect(pcts(a).runCost).toBeCloseTo(40 / 3, 9)
    expect(pcts(a).margin).toBe(0)
    expect(yens(a).margin).toBe(-50000)
    expect(a.overflowPct).toBe(50)
  })

  // ★ 赤字の判定は「画面に出る円の精度」でやる (Refs #840)。
  //
  // 棒の `costSum` は**費用 4 区分をその場で足し直したもの**、比べる相手の売上から出る粗利は
  // **運行 1 本ずつ足し込んだもの** (`summarizeMargins` の `totals.marginYen`) — 同じ量を
  // 別の足し順で出した 2 つなので double では一致しない。下の 2 本は**1 本ずつ見ると
  // 粗利ちょうど 0** (十進で費用が売上をちょうど使い切る) なのに、**列ごとに足し直すと
  // 1 ulp だけ売上を超える**。取引先別 (`margin.ts` の `shareBarOf`) と同じ穴なので、
  // **同じ 1 つの `costExceedsSalesAtYen`** に判定を預けてある。
  const tailOps = () => [
    op({ driverName: '甲', unkoNo: 'T1', salesYen: 139000, allowanceYen: 16000, fuelYen: 16722.9 + 8934.6, fuelHaulYen: 16722.9, fuelDeadheadYen: 8934.6, directCostYen: 7304.4, allocatedCostYen: 90038.1, marginYen: 0 }),
    op({ driverName: '甲', unkoNo: 'T2', salesYen: 122000, allowanceYen: 19000, fuelYen: 15002.7 + 9223, fuelHaulYen: 15002.7, fuelDeadheadYen: 9223, directCostYen: 7217.3, allocatedCostYen: 71557, marginYen: 0 }),
  ]

  it('★ 粗利ちょうど 0 の乗務員の「尾だけの超過」を赤字にしない (Refs #840)', () => {
    const ops = tailOps()
    // 運行 1 本ずつは 売上 − 手当 − 燃料 − 直課 − 按分 = ちょうど 0 (画面と同じ足し順)
    for (const o of ops) expect(o.salesYen - o.allowanceYen - o.fuelYen! - o.directCostYen - o.allocatedCostYen).toBe(0)
    const t = summarizeMargins(ops)
    expect(t.marginYen).toBe(0)
    // ところが棒の側で列ごとに足し直すと 1 ulp 超える (= 直す前の判定は true)
    const costSum = t.allowanceYen + t.fuelHaulYen + t.fuelDeadheadYen + (t.directCostYen + t.allocatedCostYen)
    expect(costSum).toBe(261000.00000000003)
    expect(costSum > t.salesYen).toBe(true)
    expect(Math.round(costSum)).toBe(Math.round(t.salesYen))     // 画面はどちらも ¥261,000

    const res = driverShareBars(groupMarginsByDriver(ops))
    const a = res.bars[1]!
    expect(a.overflowPct).toBe(0)          // 画面の v-if="bar.overflowPct > 0" が false
    expect(res.bars[0]!.overflowPct).toBe(0)
  })

  it('★ 尾だけの超過を落としても棒の幅は動かない (scale が ≒1 から厳密な 1 になるだけ、Refs #840)', () => {
    const ops = tailOps()
    const t = summarizeMargins(ops)
    const costs = [t.allowanceYen, t.fuelHaulYen, t.fuelDeadheadYen, t.directCostYen + t.allocatedCostYen]
    const costSum = costs.reduce((sum, c) => sum + c, 0)
    const a = driverShareBars(groupMarginsByDriver(ops)).bars[1]!
    // 額は 1 円も動いていない (丸めたのは比較の 2 値だけ)
    expect(a.segments.map(s => s.yen)).toEqual([...costs, 0])
    const after = costs.map(c => (c * 100) / t.salesYen)
    expect(a.segments.slice(0, 4).map(s => s.pct)).toEqual(after)
    expect(a.segments.reduce((sum, s) => sum + s.pct, 0)).toBe(100)
    // 直す前 (scale = 売上 ÷ Σ費用 ≒ 1) との差は 15 桁目だけ。画面の書式では区別が付かない
    const before = costs.map(c => (c * 100 * (t.salesYen / costSum)) / t.salesYen)
    expect(before).not.toEqual(after)
    const pct1 = (v: number) => `${Math.round(v * 10) / 10}%`
    expect(before.map(pct1)).toEqual(after.map(pct1))
    for (const [i, v] of after.entries()) expect(Math.abs(v - before[i]!) * 10).toBeLessThan(1e-12)   // 1000px の棒での px 差
  })

  it('★ 円の精度で超えていれば これまでどおり赤字。境界は 0.5 円 (Refs #840)', () => {
    const bar = (runCostExtra: number) => driverShareBars(groupMarginsByDriver([
      op({ driverName: '甲', salesYen: 100000, allowanceYen: 30000, fuelYen: 50000, fuelHaulYen: 30000, fuelDeadheadYen: 20000, directCostYen: 20000, allocatedCostYen: runCostExtra, marginYen: -runCostExtra }),
    ])).bars[1]!
    // 0.6 円超過 → 画面の円は ¥100,001 と ¥100,000 で**実際に違う** → 赤字のまま
    expect(bar(0.6).overflowPct).toBeGreaterThan(0)
    // 0.4 円超過 → 画面の円はどちらも ¥100,000 → 赤字にしない (**ここが変わったところ**)
    expect(bar(0.4).overflowPct).toBe(0)
  })

  it('粗利が負でも 4 区分の和が売上を超えていなければ縮めず、粗利の pct だけ 0', () => {
    // 出せる運行 (売上 30000・手当 50000 → 粗利 −20000) + 出せない運行 (売上 70000)
    const res = driverShareBars(groupMarginsByDriver([
      op({ driverName: '甲', salesYen: 30000, allowanceYen: 50000, fuelYen: 0, fuelHaulYen: 0, fuelDeadheadYen: 0, directCostYen: 0, allocatedCostYen: 0, marginYen: -20000 }),
      op({ driverName: '甲', unkoNo: 'U2', salesYen: 70000, allowanceYen: 0, fuelYen: null, fuelHaulYen: null, fuelDeadheadYen: null, directCostYen: 0, allocatedCostYen: 0, marginYen: null }),
    ]))
    const a = res.bars[1]!
    expect(pcts(a)).toEqual({ allowance: 50, fuelHaul: 0, fuelDeadhead: 0, runCost: 0, margin: 0 })
    expect(yens(a).margin).toBe(-20000)
    expect(a.overflowPct).toBe(0)
  })

  it('売上 0 の乗務員は棒にせず skipped に数える (合計には入れる)', () => {
    const res = driverShareBars(groupMarginsByDriver([
      op({ driverName: '甲' }),
      op({ driverName: '丙', salesYen: 0, allowanceYen: 5000, fuelYen: 1000, fuelHaulYen: 600, fuelDeadheadYen: 400, directCostYen: 0, allocatedCostYen: 0, marginYen: -6000 }),
    ]))
    expect(res.skipped).toBe(1)
    expect(res.bars.map(b => b.key)).toEqual(['total', '甲'])
    // 売上 0 の乗務員の手当・燃料・粗利は合計には乗る
    expect(yens(res.bars[0]!)).toEqual({ allowance: 33000, fuelHaul: 16600, fuelDeadhead: 13400, runCost: 9000, margin: 28000 })
  })

  it('乗務員が 0 人 / 全員が売上 0 なら棒は 1 本も出ない (合計も出さない — 0 で割らない)', () => {
    expect(driverShareBars([])).toEqual({ bars: [], skipped: 0 })
    const allZero = driverShareBars(groupMarginsByDriver([
      op({ driverName: '甲', salesYen: 0, marginYen: -34000 }),
    ]))
    expect(allZero).toEqual({ bars: [], skipped: 1 })
  })
})


