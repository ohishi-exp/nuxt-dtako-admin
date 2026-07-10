// トラック休憩ポイント POI の表示ヘルパ (Refs #198 Phase 1)
//
// データ生成側のスキーマ定義 (scripts/poi/types.ts) を型として共有する
// (type-only import なので client bundle にコードは入らない)。

import type { PoiCollection, PoiFeature, PoiKind, PoiProperties } from '../../scripts/poi/types'

export type { PoiCollection, PoiFeature, PoiKind, PoiProperties }

export const POI_KIND_LABELS: Record<PoiKind, string> = {
  michi_no_eki: '道の駅',
  sa: 'SA',
  pa: 'PA',
  truck_parking: '大型可駐車場',
}

/** マーカー / 凡例の色 (kind 別) */
export const POI_KIND_COLORS: Record<PoiKind, string> = {
  michi_no_eki: '#16a34a', // green-600
  sa: '#2563eb', // blue-600
  pa: '#0891b2', // cyan-600
  truck_parking: '#d97706', // amber-600
}

export const ALL_POI_KINDS: PoiKind[] = ['michi_no_eki', 'sa', 'pa', 'truck_parking']

/** 選択中の kind だけに絞る */
export function filterPoisByKind(features: PoiFeature[], kinds: ReadonlySet<PoiKind>): PoiFeature[] {
  return features.filter(f => kinds.has(f.properties.kind))
}

export interface PoiBadge {
  label: string
  /** true = あり / false = なし (不明 null はバッジ自体を出さない) */
  value: boolean
}

/**
 * 属性パネル用のバッジ一覧。不明 (null) は「なし」と区別できないので出さない。
 */
export function poiBadges(p: PoiProperties): PoiBadge[] {
  const defs: Array<[string, boolean | null]> = [
    ['24時間', p.open24h],
    ['大型可', p.hgv],
    ['シャワー', p.shower],
    ['給油', p.fuel],
    ['食事', p.restaurant],
    ['トイレ', p.toilet],
  ]
  const badges: PoiBadge[] = []
  for (const [label, value] of defs) {
    if (value !== null) badges.push({ label, value })
  }
  if (p.hgvCapacity !== null) {
    badges.push({ label: `大型マス ${p.hgvCapacity} 台`, value: true })
  }
  return badges
}

/** 一覧・パネル表示用のタイトル (無名 POI は kind 名で代替) */
export function poiTitle(p: PoiProperties): string {
  if (p.name) {
    return p.kind === 'michi_no_eki' && !p.name.startsWith('道の駅') ? `道の駅 ${p.name}` : p.name
  }
  return `(無名の${POI_KIND_LABELS[p.kind]})`
}

/** 所在地表示 (P35 由来のみ値がある) */
export function poiLocation(p: PoiProperties): string | null {
  if (p.pref && p.city) return `${p.pref}${p.city}`
  return p.pref ?? p.city ?? null
}
