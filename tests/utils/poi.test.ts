import { describe, expect, it } from 'vitest'
import type { PoiFeature, PoiProperties } from '../../app/utils/poi'
import {
  ALL_POI_KINDS,
  POI_KIND_COLORS,
  POI_KIND_LABELS,
  filterPoisByKind,
  poiBadges,
  poiLocation,
  poiTitle,
} from '../../app/utils/poi'

function props(overrides: Partial<PoiProperties> = {}): PoiProperties {
  return {
    id: 'x',
    name: null,
    kind: 'pa',
    sources: ['osm'],
    hgv: null,
    hgvCapacity: null,
    open24h: null,
    shower: null,
    fuel: null,
    restaurant: null,
    toilet: null,
    pref: null,
    city: null,
    ...overrides,
  }
}

function feature(overrides: Partial<PoiProperties> = {}): PoiFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [130.5, 33.5] },
    properties: props(overrides),
  }
}

describe('POI 定数', () => {
  it('全 kind にラベルと色がある', () => {
    for (const kind of ALL_POI_KINDS) {
      expect(POI_KIND_LABELS[kind]).toBeTruthy()
      expect(POI_KIND_COLORS[kind]).toMatch(/^#[0-9a-f]{6}$/)
    }
  })
})

describe('filterPoisByKind', () => {
  it('選択 kind だけ残す', () => {
    const features = [feature({ kind: 'sa' }), feature({ kind: 'pa' }), feature({ kind: 'michi_no_eki' })]
    const out = filterPoisByKind(features, new Set(['sa', 'michi_no_eki']))
    expect(out.map(f => f.properties.kind)).toEqual(['sa', 'michi_no_eki'])
  })
})

describe('poiBadges', () => {
  it('不明 (null) はバッジを出さず、true/false は出す', () => {
    const badges = poiBadges(props({ open24h: true, shower: false }))
    expect(badges).toEqual([
      { label: '24時間', value: true },
      { label: 'シャワー', value: false },
    ])
  })

  it('大型マス台数があれば台数バッジを出す', () => {
    const badges = poiBadges(props({ hgvCapacity: 48 }))
    expect(badges).toEqual([{ label: '大型マス 48 台', value: true }])
  })
})

describe('poiTitle', () => {
  it('道の駅は接頭辞を補う (重複はさせない)', () => {
    expect(poiTitle(props({ kind: 'michi_no_eki', name: 'むなかた' }))).toBe('道の駅 むなかた')
    expect(poiTitle(props({ kind: 'michi_no_eki', name: '道の駅むなかた' }))).toBe('道の駅むなかた')
  })

  it('SA/PA は名前そのまま、無名は kind 名で代替', () => {
    expect(poiTitle(props({ kind: 'sa', name: '古賀SA' }))).toBe('古賀SA')
    expect(poiTitle(props({ kind: 'truck_parking' }))).toBe('(無名の大型可駐車場)')
  })
})

describe('poiLocation', () => {
  it('都道府県 + 市町村を連結、無ければ null', () => {
    expect(poiLocation(props({ pref: '福岡県', city: '朝倉市' }))).toBe('福岡県朝倉市')
    expect(poiLocation(props({ pref: '福岡県' }))).toBe('福岡県')
    expect(poiLocation(props({ city: '朝倉市' }))).toBe('朝倉市')
    expect(poiLocation(props())).toBeNull()
  })
})
