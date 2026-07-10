import { describe, expect, it } from 'vitest'
import { dedupePois, haversineMeters, normalizeName } from '../../scripts/poi/dedupe.ts'
import type { PoiFeature, PoiKind, PoiSource } from '../../scripts/poi/types.ts'

function poi(
  overrides: Partial<PoiFeature['properties']> & { kind: PoiKind; sources: PoiSource[] },
  lon = 130.5,
  lat = 33.5,
): PoiFeature {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      id: 'x',
      name: null,
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
    },
  }
}

// 緯度 1 度 ≈ 111.2km。33.5 度近辺で 0.001 度 ≈ 111m
const NEAR = 0.0008 // ≈ 89m
const FAR = 0.01 // ≈ 1.1km

describe('haversineMeters', () => {
  it('既知の距離に一致する (緯度 0.01 度 ≈ 1112m)', () => {
    const d = haversineMeters([130.5, 33.5], [130.5, 33.51])
    expect(d).toBeGreaterThan(1100)
    expect(d).toBeLessThan(1125)
  })

  it('同一点は 0', () => {
    expect(haversineMeters([130.5, 33.5], [130.5, 33.5])).toBe(0)
  })
})

describe('normalizeName', () => {
  it('NFKC + 空白 + 接頭辞/接尾辞を正規化する', () => {
    expect(normalizeName('道の駅 むなかた')).toBe('むなかた')
    expect(normalizeName('広川ＳＡ')).toBe('広川sa')
    expect(normalizeName('山田サービスエリア')).toBe('山田')
  })
})

describe('dedupePois', () => {
  it('OSM の node/way 重複 (同名・近接) をマージする', () => {
    const a = poi({ id: 'osm:node:1', name: '古賀SA', kind: 'sa', sources: ['osm'], open24h: true })
    const b = poi({ id: 'osm:way:2', name: '古賀SA', kind: 'sa', sources: ['osm'], shower: true }, 130.5 + NEAR, 33.5)
    const out = dedupePois([a, b])
    expect(out).toHaveLength(1)
    expect(out[0]!.properties.open24h).toBe(true)
    expect(out[0]!.properties.shower).toBe(true)
  })

  it('離れていればマージしない', () => {
    const a = poi({ id: 'a', name: '古賀SA', kind: 'sa', sources: ['osm'] })
    const b = poi({ id: 'b', name: '古賀SA', kind: 'sa', sources: ['osm'] }, 130.5 + FAR, 33.5)
    expect(dedupePois([a, b])).toHaveLength(2)
  })

  it('名前が異なればマージしない', () => {
    const a = poi({ id: 'a', name: '上り', kind: 'pa', sources: ['osm'] })
    const b = poi({ id: 'b', name: '下り', kind: 'pa', sources: ['osm'] }, 130.5 + NEAR, 33.5)
    expect(dedupePois([a, b])).toHaveLength(2)
  })

  it('P35 と OSM の道の駅を統合し、P35 を代表にして属性を埋める', () => {
    const p35 = poi({
      id: 'p35:40228:むなかた',
      name: 'むなかた',
      kind: 'michi_no_eki',
      sources: ['p35'],
      restaurant: true,
      pref: '福岡県',
    })
    const osm = poi(
      { id: 'osm:node:9', name: '道の駅むなかた', kind: 'michi_no_eki', sources: ['osm'], hgvCapacity: 12 },
      130.5 + NEAR,
      33.5,
    )
    const out = dedupePois([osm, p35])
    expect(out).toHaveLength(1)
    const merged = out[0]!.properties
    expect(merged.id).toBe('p35:40228:むなかた')
    expect(merged.name).toBe('むなかた')
    expect(merged.restaurant).toBe(true)
    expect(merged.hgvCapacity).toBe(12)
    expect(merged.sources.sort()).toEqual(['osm', 'p35'])
  })

  it('P35 の近くの無名 sa/pa は道の駅本体として吸収する', () => {
    const p35 = poi({ id: 'p35:1:はらづる', name: 'はらづる', kind: 'michi_no_eki', sources: ['p35'] })
    const osm = poi({ id: 'osm:way:5', name: null, kind: 'pa', sources: ['osm'], hgv: true }, 130.5 + NEAR, 33.5)
    const out = dedupePois([p35, osm])
    expect(out).toHaveLength(1)
    expect(out[0]!.properties.hgv).toBe(true)
  })

  it('P35 の近くでも無名 truck_parking は別施設として残す', () => {
    const p35 = poi({ id: 'p35:1:はらづる', name: 'はらづる', kind: 'michi_no_eki', sources: ['p35'] })
    const parking = poi(
      { id: 'osm:node:7', name: null, kind: 'truck_parking', sources: ['osm'], hgv: true },
      130.5 + NEAR,
      33.5,
    )
    expect(dedupePois([p35, parking])).toHaveLength(2)
  })

  it('OSM 同士の無名近接は同一 kind のみマージする', () => {
    const sa = poi({ id: 'a', name: null, kind: 'sa', sources: ['osm'] })
    const sa2 = poi({ id: 'b', name: null, kind: 'sa', sources: ['osm'] }, 130.5 + NEAR, 33.5)
    const parking = poi({ id: 'c', name: null, kind: 'truck_parking', sources: ['osm'], hgv: true }, 130.5 - NEAR, 33.5)
    const out = dedupePois([sa, sa2, parking])
    expect(out).toHaveLength(2)
  })

  it('入力の features を破壊しない', () => {
    const a = poi({ id: 'a', name: '古賀SA', kind: 'sa', sources: ['osm'] })
    const b = poi({ id: 'b', name: '古賀SA', kind: 'sa', sources: ['osm', 'p35'], shower: true }, 130.5 + NEAR, 33.5)
    dedupePois([a, b])
    expect(a.properties.shower).toBeNull()
    expect(a.properties.sources).toEqual(['osm'])
  })
})
