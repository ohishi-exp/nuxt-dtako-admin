// 粗利タブ「釧路積み (釧路営業所試算)」区画 (Refs #760 の 36)。
//
// **表示専用のコンポーネント**なので、ここが見るのは
//   1. 「実在しない試算」バッジが**条件に関わらず**必ず出ること (オーナー要件)
//   2. 欠測が 0 ではなく「−」で出ること
//   3. 便/日 のつまみが親へ値を返すこと
// の 3 つ。数字の正しさは `kushiro-branch-view.test.ts` (さらに下は golden) の担当。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import KushiroBranchPanel from '~/components/KushiroBranchPanel.vue'
import { DASH, buildKushiroBranchView } from '~/utils/kushiro-branch-view'
import type { RebuildOperationInput } from '~/utils/kushiro-doto-rebuild'
import type { MinWageMaster } from '~/utils/restraint-wage-view'
import rawOperations from '../fixtures/kushiro-loading/doto-operations-2026-07.json'

const operations = rawOperations as unknown as RebuildOperationInput[]

/** 本番 R2 の形 (県名キー / 釧路営業所は載らない、2026-08-23 実測)。 */
const PROD_MASTER: MinWageMaster = {
  prefectures: { 北海道: [{ effectiveFrom: '2025-10-04', rate: 1075 }] },
  branchToPrefecture: { 帯広: '北海道' },
}

function propsFor(
  ops: readonly RebuildOperationInput[],
  over: { minWageMaster?: MinWageMaster | null, legsPerDay?: number, area?: 'doto' | 'all', masterError?: string } = {},
) {
  const view = buildKushiroBranchView(ops, {
    ym: '2026-07',
    area: over.area,
    legsPerDay: over.legsPerDay,
    minWageMaster: over.minWageMaster === undefined ? PROD_MASTER : over.minWageMaster,
  })
  return { ...view, masterError: over.masterError ?? '' }
}

function mountPanel(props: ReturnType<typeof propsFor>) {
  return mount(KushiroBranchPanel, { props })
}

const BADGE = '実在しない試算'

describe('KushiroBranchPanel', () => {
  it('「実在しない試算」バッジは対象便があってもなくても必ず出る', () => {
    expect(mountPanel(propsFor(operations)).text()).toContain(BADGE)
    const empty = mountPanel(propsFor([]))
    expect(empty.text()).toContain(BADGE)
    expect(empty.text()).toContain('便がこの月にはありません')
    // 対象 0 件では表を 1 つも出さない
    expect(empty.findAll('table')).toHaveLength(0)
  })

  it('経路別・乗務員別・感度分析の 3 表を出す', () => {
    const w = mountPanel(propsFor(operations))
    const tables = w.findAll('table')
    expect(tables).toHaveLength(3)
    expect(w.text()).toContain('釧路 → 標茶')
    expect(w.text()).toContain('釧路 → 別海')
    // 感度分析は実測分布の 4 点。実測平均の行には印が付く
    expect(w.text()).toContain('実測平均')
    // 帯広発は 3 便/日 で初めてクリアする (行の判定がそのまま出ている)
    expect(w.text()).toContain('割れ')
    expect(w.text()).toContain('クリア')
  })

  it('最低賃金は引けた額とキーの出どころを出す', () => {
    const w = mountPanel(propsFor(operations))
    expect(w.text()).toContain('¥1,075/h')
    expect(w.text()).toContain('北海道')
    expect(w.text()).toContain('2025-10-04')
  })

  it('額が引けないときは 0 に倒さず「−」にし、試したキーを出す', () => {
    const w = mountPanel(propsFor(operations, { minWageMaster: null }))
    expect(w.text()).toContain('最低賃金マスタから額を引けませんでした')
    expect(w.text()).toContain('全社共通')
    expect(w.text()).toContain(DASH)
    // 判定の列は「割れ」でも「クリア」でもなく「−」
    expect(w.text()).not.toContain('割れ')
    expect(w.text()).not.toContain('クリア')
  })

  it('マスタを読めなかった理由も画面に出す (黙って「−」にしない)', () => {
    const w = mountPanel(propsFor(operations, { minWageMaster: null, masterError: '会社IDが分かりません' }))
    expect(w.text()).toContain('会社IDが分かりません')
    expect(mountPanel(propsFor(operations)).text()).not.toContain('会社IDが分かりません')
  })

  it('座標が欠けた便があれば件数を出し、経路の行にも乗務員の行にも印を付ける', () => {
    const mark = 'span[title^="座標が欠けて推定に入れられなかった便"]'
    const w = mountPanel(propsFor(operations, { area: 'all' }))
    expect(w.text()).toContain('座標が取れず推定に入れられなかった便が')
    // 3 表のうち経路別 (index 1) と乗務員別 (index 2) の**両方**に印が要る
    const tables = w.findAll('table')
    expect(tables[1]!.findAll(mark).length).toBeGreaterThan(0)
    expect(tables[2]!.findAll(mark).length).toBeGreaterThan(0)
    // 道東だけなら欠測は 0 なので、注記も印も出ない
    const doto = mountPanel(propsFor(operations))
    expect(doto.text()).not.toContain('座標が取れず推定に入れられなかった便が')
    expect(doto.findAll(mark)).toHaveLength(0)
  })

  it('つまみを動かすと 便/日 を親へ返す', async () => {
    const w = mountPanel(propsFor(operations))
    const range = w.get('input[type="range"]')
    expect((range.element as HTMLInputElement).disabled).toBe(false)
    expect(range.attributes('min')).toBe('1')
    expect(range.attributes('max')).toBe('3')
    await range.setValue('2.5')
    expect(w.emitted('update:legsPerDay')).toEqual([[2.5]])
  })

  it('「実測平均に戻す」は値を載せずに親へ投げる (平均は親が持つ)', async () => {
    const w = mountPanel(propsFor(operations, { legsPerDay: 3 }))
    expect(w.text()).toContain('3 便/日')
    await w.get('button').trigger('click')
    expect(w.emitted('reset')).toEqual([[]])
  })

  it('観測が 1 種類しか無ければつまみを無効にする', () => {
    const leg = (seq: number) => ({
      seq, originCity: '北海道釧路市西港', destCity: '北海道川上郡標茶町多和',
      salesYen: 1000, allowanceYen: 500, haulKm: 10, deadheadKm: 5,
      loadPoint: { lat: 42.98, lng: 144.33 }, unloadPoint: { lat: 43.29, lng: 144.6 },
      haulSec: 3600, deadheadSec: 1800,
    })
    const ops = [
      { unkoNo: 'A', driverName: '甲', kmBreakdown: null, legs: [leg(1)] },
      { unkoNo: 'B', driverName: '乙', kmBreakdown: null, legs: [leg(1)] },
    ] as unknown as RebuildOperationInput[]
    const w = mountPanel(propsFor(ops))
    expect((w.get('input[type="range"]').element as HTMLInputElement).disabled).toBe(true)
    // 1 種類しか無いので実測平均 = その値。感度の候補も 1 行だけ
    expect(w.text()).toContain('1 便/日')
  })
})
