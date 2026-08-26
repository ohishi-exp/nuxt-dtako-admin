// 最低賃金カード (拘束×賃金タブ) の「追加」「削除」が組み立てるマスタ (Refs #961)。
//
// このカードは `prefectures['全社共通']` の履歴しか画面に出していないのに、直す前は
// `minWageMaster` を**丸ごと差し替えて**いた。厚労省取り込みの 47 県と拠点→県の対応が
// ボタン 1 押しで落ち、そのまま PUT されて本番 R2 に書かれる (旧版は 7 日で消える)。
//
// ここが固定するのは 3 つ:
//   1. **不変条件** — `全社共通` 以外の県のキーと `branchToPrefecture` を 1 件も失わない
//   2. **★ 陰性対照** — 直す前の「map ごと差し替える」形を同じ不変条件に通すと**落ちる**
//      (不変条件に歯があることの確認。これが無いと 1. は空撃ちになる)
//   3. `全社共通` の行**そのもの**は意図どおり足され・差し替わり・消えること
//      (直しすぎて編集が効かなくなるのを防ぐ)
import { describe, expect, it } from 'vitest'
import type { MinWageMaster } from '../../app/utils/restraint-wage-view'
import { MIN_WAGE_DEFAULT_KEY, removeMinWageDefaultRate, upsertMinWageDefaultRate } from '../../app/utils/restraint-wage-view'

/** 厚労省取り込み後の形に近い 47 県 + 拠点→県 + 全社共通 1 本。 */
const PREFECTURES_47 = [
  '北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬',
  '埼玉', '千葉', '東京', '神奈川', '新潟', '富山', '石川', '福井', '山梨', '長野',
  '岐阜', '静岡', '愛知', '三重', '滋賀', '京都', '大阪', '兵庫', '奈良', '和歌山',
  '鳥取', '島根', '岡山', '広島', '山口', '徳島', '香川', '愛媛', '高知', '福岡',
  '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島', '沖縄',
]

function masterWith47(): MinWageMaster {
  const prefectures: MinWageMaster['prefectures'] = {}
  PREFECTURES_47.forEach((name, i) => {
    prefectures[name] = [
      { effectiveFrom: '2024-10-01', rate: 900 + i },
      { effectiveFrom: '2025-10-01', rate: 950 + i },
    ]
  })
  prefectures[MIN_WAGE_DEFAULT_KEY] = [
    { effectiveFrom: '2024-10-01', rate: 1000 },
    { effectiveFrom: '2025-10-01', rate: 1050 },
  ]
  return {
    prefectures,
    branchToPrefecture: { 本社: '福岡', 帯広: '北海道', 釧路: '北海道', 東京: '東京' },
    defaultPrefecture: '福岡',
  }
}

/**
 * 不変条件 — `全社共通` 以外は 1 件も失わない。
 *
 * **キーの件数**と**中身**の両方を見る (件数だけだと入れ替わりを見逃す)。
 */
function expectKeepsAllButDefaultKey(before: MinWageMaster, after: MinWageMaster) {
  const others = (m: MinWageMaster) =>
    Object.fromEntries(Object.entries(m.prefectures).filter(([k]) => k !== MIN_WAGE_DEFAULT_KEY))
  expect(Object.keys(others(after))).toHaveLength(Object.keys(others(before)).length)
  expect(others(after)).toEqual(others(before))
  expect(Object.keys(after.branchToPrefecture)).toHaveLength(Object.keys(before.branchToPrefecture).length)
  expect(after.branchToPrefecture).toEqual(before.branchToPrefecture)
}

/**
 * ★ 陰性対照 — `origin/main` 54d0384 時点の `addMinWageRate` (app/pages/restraint-wage.vue:4756)
 * が組み立てていた形をそのまま写したもの。**直すためのコードではない。**
 */
function preFixAdd(master: MinWageMaster, effectiveFrom: string, rate: number): MinWageMaster {
  const entries = [...(master.prefectures[MIN_WAGE_DEFAULT_KEY] ?? [])]
  const existing = entries.findIndex(e => e.effectiveFrom === effectiveFrom)
  if (existing >= 0) entries[existing] = { effectiveFrom, rate }
  else entries.push({ effectiveFrom, rate })
  entries.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  return {
    prefectures: { [MIN_WAGE_DEFAULT_KEY]: entries },
    branchToPrefecture: {},
    defaultPrefecture: MIN_WAGE_DEFAULT_KEY,
  }
}

/** ★ 陰性対照 — 同じく `removeMinWageRate` (:4767) の直す前の形。 */
function preFixRemove(master: MinWageMaster, effectiveFrom: string): MinWageMaster {
  const entries = (master.prefectures[MIN_WAGE_DEFAULT_KEY] ?? []).filter(e => e.effectiveFrom !== effectiveFrom)
  return {
    prefectures: { [MIN_WAGE_DEFAULT_KEY]: entries },
    branchToPrefecture: {},
    defaultPrefecture: entries.length ? MIN_WAGE_DEFAULT_KEY : undefined,
  }
}

describe('最低賃金カードのマージ — 47 県と拠点→県を落とさない (Refs #961)', () => {
  it('「追加」は 47 県のキーと拠点対応を 1 件も減らさない', () => {
    const before = masterWith47()
    const after = upsertMinWageDefaultRate(before, '2026-10-01', 1100)
    expectKeepsAllButDefaultKey(before, after)
    expect(Object.keys(after.prefectures)).toHaveLength(48) // 47 県 + 全社共通
    expect(Object.keys(after.branchToPrefecture)).toHaveLength(4)
  })

  it('「削除」は 47 県のキーと拠点対応を 1 件も減らさない', () => {
    const before = masterWith47()
    const after = removeMinWageDefaultRate(before, '2025-10-01')
    expectKeepsAllButDefaultKey(before, after)
    expect(Object.keys(after.prefectures)).toHaveLength(48)
    expect(Object.keys(after.branchToPrefecture)).toHaveLength(4)
  })

  it('全社共通の行を全部消しても 47 県と拠点対応は残る', () => {
    const before = masterWith47()
    const after = removeMinWageDefaultRate(
      removeMinWageDefaultRate(before, '2024-10-01'),
      '2025-10-01',
    )
    expectKeepsAllButDefaultKey(before, after)
    expect(after.prefectures[MIN_WAGE_DEFAULT_KEY]).toEqual([])
  })

  it('元のマスタを書き換えない (差し替え前の値を握っている画面を壊さない)', () => {
    const before = masterWith47()
    const snapshot = JSON.parse(JSON.stringify(before))
    upsertMinWageDefaultRate(before, '2026-10-01', 1100)
    removeMinWageDefaultRate(before, '2025-10-01')
    expect(before).toEqual(snapshot)
  })

  it('★ 陰性対照: 直す前の「map ごと差し替える」形は同じ不変条件で落ちる', () => {
    const before = masterWith47()
    // 何を失うのかを名指しで固定する (落ちる理由が別の assertion にならないように)
    const added = preFixAdd(before, '2026-10-01', 1100)
    expect(Object.keys(added.prefectures)).toEqual([MIN_WAGE_DEFAULT_KEY])
    expect(added.branchToPrefecture).toEqual({})
    const removed = preFixRemove(before, '2025-10-01')
    expect(Object.keys(removed.prefectures)).toEqual([MIN_WAGE_DEFAULT_KEY])
    expect(removed.branchToPrefecture).toEqual({})
    // そのうえで、上の 2 テストが使っているのと**同じ**不変条件が落ちること
    expect(() => expectKeepsAllButDefaultKey(before, added)).toThrow()
    expect(() => expectKeepsAllButDefaultKey(before, removed)).toThrow()
  })
})

describe('最低賃金カードのマージ — 全社共通の行そのものの編集 (Refs #961)', () => {
  it('新しい発効日は足され、発効日の昇順に並ぶ', () => {
    const after = upsertMinWageDefaultRate(masterWith47(), '2023-10-01', 960)
    expect(after.prefectures[MIN_WAGE_DEFAULT_KEY]).toEqual([
      { effectiveFrom: '2023-10-01', rate: 960 },
      { effectiveFrom: '2024-10-01', rate: 1000 },
      { effectiveFrom: '2025-10-01', rate: 1050 },
    ])
  })

  it('同じ発効日は額が差し替わる (行は増えない)', () => {
    const after = upsertMinWageDefaultRate(masterWith47(), '2025-10-01', 1234)
    expect(after.prefectures[MIN_WAGE_DEFAULT_KEY]).toEqual([
      { effectiveFrom: '2024-10-01', rate: 1000 },
      { effectiveFrom: '2025-10-01', rate: 1234 },
    ])
  })

  it('削除は指定した発効日の行だけを落とす', () => {
    const after = removeMinWageDefaultRate(masterWith47(), '2024-10-01')
    expect(after.prefectures[MIN_WAGE_DEFAULT_KEY]).toEqual([
      { effectiveFrom: '2025-10-01', rate: 1050 },
    ])
  })

  it('全社共通のキーが無いマスタにも 1 行目を足せる', () => {
    const before: MinWageMaster = { prefectures: { 東京: [{ effectiveFrom: '2025-10-01', rate: 1163 }] }, branchToPrefecture: { 本社: '東京' } }
    const after = upsertMinWageDefaultRate(before, '2025-10-01', 1000)
    expect(after.prefectures[MIN_WAGE_DEFAULT_KEY]).toEqual([{ effectiveFrom: '2025-10-01', rate: 1000 }])
    expectKeepsAllButDefaultKey(before, after)
  })

  it('全社共通のキーが無いマスタから消しても壊れない (空の履歴になるだけ)', () => {
    const before: MinWageMaster = { prefectures: { 東京: [{ effectiveFrom: '2025-10-01', rate: 1163 }] }, branchToPrefecture: {} }
    const after = removeMinWageDefaultRate(before, '2025-10-01')
    expect(after.prefectures[MIN_WAGE_DEFAULT_KEY]).toEqual([])
    expectKeepsAllButDefaultKey(before, after)
  })
})

describe('最低賃金カードのマージ — defaultPrefecture (Refs #961)', () => {
  it('既に県が入っているなら「追加」でも触らない', () => {
    const after = upsertMinWageDefaultRate(masterWith47(), '2026-10-01', 1100)
    expect(after.defaultPrefecture).toBe('福岡')
  })

  it('未設定のときだけ全社共通を入れる (カードだけで運用しているテナントを保つ)', () => {
    const before: MinWageMaster = { prefectures: {}, branchToPrefecture: {} }
    const after = upsertMinWageDefaultRate(before, '2025-10-01', 1000)
    expect(after.defaultPrefecture).toBe(MIN_WAGE_DEFAULT_KEY)
  })

  it('行が 0 件になり、全社共通を指していたときだけ外す', () => {
    const before: MinWageMaster = {
      prefectures: { [MIN_WAGE_DEFAULT_KEY]: [{ effectiveFrom: '2025-10-01', rate: 1000 }] },
      branchToPrefecture: {},
      defaultPrefecture: MIN_WAGE_DEFAULT_KEY,
    }
    const after = removeMinWageDefaultRate(before, '2025-10-01')
    expect(after.defaultPrefecture).toBeUndefined()
    expect('defaultPrefecture' in after).toBe(false)
  })

  it('行が 0 件でも、他県を指しているなら残す', () => {
    const before = masterWith47()
    const after = removeMinWageDefaultRate(
      removeMinWageDefaultRate(before, '2024-10-01'),
      '2025-10-01',
    )
    expect(after.prefectures[MIN_WAGE_DEFAULT_KEY]).toEqual([])
    expect(after.defaultPrefecture).toBe('福岡')
  })
})
