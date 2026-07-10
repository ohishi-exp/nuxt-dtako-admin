import { describe, expect, it } from 'vitest'
import type { OverpassElement } from '../../scripts/poi/overpass.ts'
import {
  normalizeOsmElement,
  normalizeOsmElements,
  normalizeP35,
  normalizeP35Feature,
} from '../../scripts/poi/normalize.ts'
import type { P35Feature } from '../../scripts/poi/normalize.ts'

function node(tags: Record<string, string>, id = 1): OverpassElement {
  return { type: 'node', id, lat: 33.5, lon: 130.5, tags }
}

describe('normalizeOsmElement', () => {
  it('node の座標とタグを正規化する', () => {
    const f = normalizeOsmElement(
      node({ 'highway': 'services', 'name': '古賀SA', 'opening_hours': '24/7', 'capacity:hgv': '48' }),
    )!
    expect(f.geometry.coordinates).toEqual([130.5, 33.5])
    expect(f.properties).toMatchObject({
      id: 'osm:node:1',
      name: '古賀SA',
      kind: 'sa',
      sources: ['osm'],
      open24h: true,
      hgvCapacity: 48,
    })
  })

  it('way / relation は center の座標を使う', () => {
    const f = normalizeOsmElement({
      type: 'way',
      id: 2,
      center: { lat: 33.1, lon: 131.2 },
      tags: { highway: 'rest_area' },
    })!
    expect(f.geometry.coordinates).toEqual([131.2, 33.1])
    expect(f.properties.id).toBe('osm:way:2')
    expect(f.properties.kind).toBe('pa')
  })

  it('座標が無い要素は捨てる', () => {
    expect(normalizeOsmElement({ type: 'way', id: 3, tags: { highway: 'services' } })).toBeNull()
  })

  it('名称で SA/PA/道の駅 を分類する (日本の OSM は PA も highway=services)', () => {
    expect(normalizeOsmElement(node({ highway: 'services', name: '鞍手PA' }))!.properties.kind).toBe('pa')
    expect(normalizeOsmElement(node({ highway: 'services', name: '山田サービスエリア' }))!.properties.kind).toBe('sa')
    expect(normalizeOsmElement(node({ highway: 'services', name: '道の駅むなかた' }))!.properties.kind).toBe('michi_no_eki')
    expect(normalizeOsmElement(node({ highway: 'rest_area', name: '広川ＳＡ' }))!.properties.kind).toBe('sa')
    // 名称で判定できなければタグにフォールバック
    expect(normalizeOsmElement(node({ highway: 'services' }))!.properties.kind).toBe('sa')
    expect(normalizeOsmElement(node({ highway: 'rest_area', name: '休憩所' }))!.properties.kind).toBe('pa')
  })

  it('大型可駐車場は hgv=yes|designated|only のみ採用する', () => {
    const f = normalizeOsmElement(node({ amenity: 'parking', hgv: 'designated' }))!
    expect(f.properties.kind).toBe('truck_parking')
    expect(f.properties.hgv).toBe(true)
    expect(normalizeOsmElement(node({ amenity: 'parking', hgv: 'no' }))).toBeNull()
    expect(normalizeOsmElement(node({ amenity: 'parking' }))).toBeNull()
  })

  it('対象外タグ / 不正 capacity は落とす・null にする', () => {
    expect(normalizeOsmElement(node({ shop: 'convenience' }))).toBeNull()
    const f = normalizeOsmElement(node({ 'highway': 'services', 'capacity:hgv': 'many' }))!
    expect(f.properties.hgvCapacity).toBeNull()
  })

  it('opening_hours が 24/7 以外なら open24h は不明 (null)', () => {
    const f = normalizeOsmElement(node({ highway: 'services', opening_hours: 'Mo-Su 08:00-20:00' }))!
    expect(f.properties.open24h).toBeNull()
  })

  it('shower / toilets / hgv=no を反映する', () => {
    const f = normalizeOsmElement(
      node({ highway: 'services', shower: 'yes', toilets: 'no', hgv: 'no' }),
    )!
    expect(f.properties.shower).toBe(true)
    expect(f.properties.toilet).toBe(false)
    expect(f.properties.hgv).toBe(false)
  })

  it('normalizeOsmElements は null を除いて返す', () => {
    const els = [node({ highway: 'services' }), node({ shop: 'convenience' }, 2)]
    expect(normalizeOsmElements(els)).toHaveLength(1)
  })
})

function p35Feature(overrides: Partial<P35Feature['properties']> = {}, lon = 130.78, lat = 33.35): P35Feature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      P35_003: '福岡県',
      P35_004: '朝倉市',
      P35_005: '40228',
      P35_006: '原鶴',
      P35_013: 1, // レストラン: あり
      P35_021: 2, // ガソリンスタンド: なし
      P35_024: 2, // シャワー: なし
      P35_027: 1, // 身障者トイレ: あり
      ...overrides,
    },
  }
}

describe('normalizeP35', () => {
  it('P35 属性コードを正規化する', () => {
    const f = normalizeP35Feature(p35Feature())!
    expect(f.properties).toMatchObject({
      id: 'p35:40228:原鶴',
      name: '原鶴',
      kind: 'michi_no_eki',
      sources: ['p35'],
      open24h: true,
      restaurant: true,
      fuel: false,
      shower: false,
      toilet: true,
      pref: '福岡県',
      city: '朝倉市',
    })
    expect(f.geometry.coordinates).toEqual([130.78, 33.35])
  })

  it('設備フラグが 1/2 以外なら不明 (null)', () => {
    const f = normalizeP35Feature(p35Feature({ P35_013: 0, P35_024: undefined }))!
    expect(f.properties.restaurant).toBeNull()
    expect(f.properties.shower).toBeNull()
  })

  it('座標が無い feature は捨てる', () => {
    const broken = { ...p35Feature(), geometry: undefined } as unknown as P35Feature
    expect(normalizeP35Feature(broken)).toBeNull()
  })

  it('bbox でリージョン内に絞る (全国データ → 九州)', () => {
    const collection = {
      type: 'FeatureCollection' as const,
      features: [
        p35Feature(), // 福岡 (bbox 内)
        p35Feature({ P35_003: '北海道', P35_006: '足寄' }, 143.5, 43.2), // bbox 外
      ],
    }
    const out = normalizeP35(collection, { south: 30.9, west: 128.4, north: 34.3, east: 132.2 })
    expect(out).toHaveLength(1)
    expect(out[0]!.properties.name).toBe('原鶴')
  })

  it('bbox なしなら全件返す', () => {
    const collection = { type: 'FeatureCollection' as const, features: [p35Feature()] }
    expect(normalizeP35(collection)).toHaveLength(1)
  })
})
