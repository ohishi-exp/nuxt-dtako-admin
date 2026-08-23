import { describe, it, expect } from 'vitest'
import {
  DEPOTS,
  EARTH_RADIUS_KM,
  KUSHIRO_CITY_HALL,
  OBIHIRO_DEPOT,
  isValidLatLng,
  haversineKm,
} from '~/utils/depot-distance'
import type { DepotKey, LatLng } from '~/utils/depot-distance'
import { getGpsForCell } from '~/utils/event-data-table'

describe('座標定数', () => {
  it('釧路市役所 (暫定の起終点) は釧路市域の中にある', () => {
    expect(KUSHIRO_CITY_HALL.lat).toBeCloseTo(42.98, 1)
    expect(KUSHIRO_CITY_HALL.lng).toBeCloseTo(144.38, 1)
  })

  it('帯広側の比較基準 (帯広市役所) は帯広市域の中にある', () => {
    expect(OBIHIRO_DEPOT.lat).toBeCloseTo(42.92, 1)
    expect(OBIHIRO_DEPOT.lng).toBeCloseTo(143.20, 1)
  })

  it('地球半径は IUGG の平均半径 R1', () => {
    expect(EARTH_RADIUS_KM).toBe(6371.0088)
  })
})

describe('DEPOTS (営業所をキーで選ぶ)', () => {
  it('個別定数と同じ座標を指している', () => {
    expect(DEPOTS.obihiro).toBe(OBIHIRO_DEPOT)
    expect(DEPOTS.kushiro).toBe(KUSHIRO_CITY_HALL)
  })

  it('キーは帯広と釧路の 2 つ', () => {
    expect(Object.keys(DEPOTS).sort().join(',')).toBe('kushiro,obihiro')
  })

  it('キーで回して両営業所を同じ手続きで扱える', () => {
    const from: LatLng = { lat: 42.99, lng: 144.38 } // 釧路市内の積地を想定
    const keys = Object.keys(DEPOTS) as DepotKey[]
    const km = keys.map(k => haversineKm(DEPOTS[k], from))
    expect(km.length).toBe(2)
    for (const v of km) {
      expect(v).not.toBeNull()
      expect(v!).toBeGreaterThan(-1)
    }
    // 釧路の積地なら 釧路営業所 の方が近い (起点を変えると回送距離が変わる、の最小の形)
    expect(haversineKm(DEPOTS.kushiro, from)!).toBeLessThan(haversineKm(DEPOTS.obihiro, from)!)
  })
})

describe('isValidLatLng', () => {
  it('通常の座標を受け入れる', () => {
    expect(isValidLatLng(KUSHIRO_CITY_HALL)).toBe(true)
  })

  it('境界値 (±90 / ±180) は座標として有効', () => {
    expect(isValidLatLng({ lat: 90, lng: 180 })).toBe(true)
    expect(isValidLatLng({ lat: -90, lng: -180 })).toBe(true)
  })

  it('null / undefined は無効', () => {
    expect(isValidLatLng(null)).toBe(false)
    expect(isValidLatLng(undefined)).toBe(false)
  })

  it('lat が NaN なら無効', () => {
    expect(isValidLatLng({ lat: NaN, lng: 144.3 })).toBe(false)
  })

  it('lat は有限だが lng が NaN なら無効 (|| の右側)', () => {
    expect(isValidLatLng({ lat: 42.9, lng: NaN })).toBe(false)
  })

  it('Infinity は無効', () => {
    expect(isValidLatLng({ lat: Infinity, lng: 144.3 })).toBe(false)
    expect(isValidLatLng({ lat: 42.9, lng: -Infinity })).toBe(false)
  })

  it('lat が範囲外 (|lat| > 90) なら無効', () => {
    expect(isValidLatLng({ lat: 90.0001, lng: 144.3 })).toBe(false)
    expect(isValidLatLng({ lat: -91, lng: 144.3 })).toBe(false)
  })

  it('lat は範囲内だが lng が範囲外 (|lng| > 180) なら無効 (|| の右側)', () => {
    expect(isValidLatLng({ lat: 42.9, lng: 180.0001 })).toBe(false)
    expect(isValidLatLng({ lat: 42.9, lng: -181 })).toBe(false)
  })
})

describe('haversineKm', () => {
  it('釧路市役所 ↔ 帯広市役所 は直線 約 97km', () => {
    const km = haversineKm(KUSHIRO_CITY_HALL, OBIHIRO_DEPOT)
    expect(km).not.toBeNull()
    // 実測 96.70km。道なり (帯広〜釧路 約 120km) の下限として桁が合っていることを見る
    expect(km!).toBeCloseTo(96.7, 1)
    expect(km!).toBeGreaterThan(90)
    expect(km!).toBeLessThan(105)
  })

  it('引数の順番を入れ替えても同じ距離', () => {
    expect(haversineKm(OBIHIRO_DEPOT, KUSHIRO_CITY_HALL))
      .toBeCloseTo(haversineKm(KUSHIRO_CITY_HALL, OBIHIRO_DEPOT)!, 9)
  })

  it('同一点は 0', () => {
    expect(haversineKm(KUSHIRO_CITY_HALL, KUSHIRO_CITY_HALL)).toBe(0)
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 })).toBe(0)
  })

  it('赤道上の経度 1 度は約 111.2km', () => {
    expect(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })!).toBeCloseTo(111.195, 2)
  })

  it('対蹠点でも NaN にならない (Math.min の頭打ち)', () => {
    const km = haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 180 })
    expect(km).not.toBeNaN()
    expect(km!).toBeCloseTo(Math.PI * EARTH_RADIUS_KM, 6)
  })

  it('欠測は 0 ではなく null — 左辺が欠測', () => {
    expect(haversineKm(null, KUSHIRO_CITY_HALL)).toBeNull()
    expect(haversineKm(undefined, KUSHIRO_CITY_HALL)).toBeNull()
    expect(haversineKm({ lat: NaN, lng: NaN }, KUSHIRO_CITY_HALL)).toBeNull()
  })

  it('欠測は 0 ではなく null — 右辺が欠測 (左辺は有効)', () => {
    expect(haversineKm(KUSHIRO_CITY_HALL, null)).toBeNull()
    expect(haversineKm(KUSHIRO_CITY_HALL, undefined)).toBeNull()
    expect(haversineKm(KUSHIRO_CITY_HALL, { lat: NaN, lng: NaN })).toBeNull()
  })

  it('範囲外は 0 ではなく null (両側)', () => {
    expect(haversineKm({ lat: 1000, lng: 0 }, KUSHIRO_CITY_HALL)).toBeNull()
    expect(haversineKm(KUSHIRO_CITY_HALL, { lat: 0, lng: 1000 })).toBeNull()
  })
})

describe('イベント CSV の度分形式 GPS をそのまま渡せる', () => {
  // 度分形式: 42590940 → 42度59.0940分 → 42.9849 (`toLatLng` / `getGpsForCell` が変換する)
  const headers = [
    '開始市町村名', '終了市町村名',
    '開始GPS緯度', '開始GPS経度', '開始GPS有効',
    '終了GPS緯度', '終了GPS経度', '終了GPS有効',
  ]
  // 開始 = 釧路市役所 / 終了 = 帯広市役所
  const row = ['釧路市', '帯広市', '42590940', '144229020', '1', '42554400', '143117840', '1']

  it('getGpsForCell の戻り値をそのまま haversineKm に渡せる', () => {
    const start = getGpsForCell(headers, row, '開始市町村名')
    const end = getGpsForCell(headers, row, '終了市町村名')
    expect(start!.lat).toBeCloseTo(KUSHIRO_CITY_HALL.lat, 6)
    expect(end!.lng).toBeCloseTo(OBIHIRO_DEPOT.lng, 6)
    expect(haversineKm(start, end)!).toBeCloseTo(96.7, 1)
  })

  it('回送の起点を釧路に差し替えた距離も同じ口で出せる', () => {
    const start = getGpsForCell(headers, row, '開始市町村名')
    expect(haversineKm(OBIHIRO_DEPOT, start)!).toBeCloseTo(96.7, 1)
  })

  it('GPS 無効 (有効フラグ 0) の行は null が返り、距離も null になる', () => {
    const invalid = ['釧路市', '帯広市', '42590940', '144229020', '0', '42554400', '143117840', '1']
    const start = getGpsForCell(headers, invalid, '開始市町村名')
    expect(start).toBeNull()
    expect(haversineKm(start, OBIHIRO_DEPOT)).toBeNull()
  })
})
