// Overpass 要素 / P35 (道の駅) GeoJSON → 正規化 PoiFeature (Refs #198)

import type { OverpassElement, Bbox } from './overpass.ts'
import type { PoiFeature, PoiKind } from './types.ts'

/** yes/no 系 OSM タグ → boolean | null */
function yesNo(v: string | undefined): boolean | null {
  if (v === undefined) return null
  if (v === 'yes' || v === 'designated' || v === 'only') return true
  if (v === 'no') return false
  return null
}

function parseCapacity(v: string | undefined): number | null {
  if (v === undefined) return null
  const n = Number.parseInt(v, 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function osmKind(tags: Record<string, string>): PoiKind | null {
  if (tags.amenity === 'parking') {
    // クエリ側で hgv=yes|designated|only に絞っているが、キャッシュ入力
    // (--overpass-json) 経由で緩いデータが来ても大型可以外は落とす
    return yesNo(tags.hgv) === true ? 'truck_parking' : null
  }
  if (tags.highway !== 'services' && tags.highway !== 'rest_area') return null

  // 日本の OSM は SA / PA / 道の駅 のいずれも highway=services で
  // タグ付けされていることが多い (九州圏実データ: services 200 件の中に
  // 「鞍手PA」等の PA が多数)。タグだけでは区別できないので名称で分類し、
  // 判定できない時にタグへフォールバックする。
  const name = (tags.name ?? tags['name:ja'] ?? '').normalize('NFKC')
  if (/道の駅/u.test(name)) return 'michi_no_eki'
  if (/(SA|サービスエリア)$/iu.test(name)) return 'sa'
  if (/(PA|パーキングエリア)$/iu.test(name)) return 'pa'
  return tags.highway === 'services' ? 'sa' : 'pa'
}

/** Overpass 要素 1 件を正規化。対象外 / 座標なしは null */
export function normalizeOsmElement(el: OverpassElement): PoiFeature | null {
  const tags = el.tags ?? {}
  const kind = osmKind(tags)
  if (kind === null) return null

  const lat = el.lat ?? el.center?.lat
  const lon = el.lon ?? el.center?.lon
  if (lat === undefined || lon === undefined) return null

  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      id: `osm:${el.type}:${el.id}`,
      name: tags.name ?? tags['name:ja'] ?? null,
      kind,
      sources: ['osm'],
      hgv: kind === 'truck_parking' ? true : yesNo(tags.hgv),
      hgvCapacity: parseCapacity(tags['capacity:hgv']),
      // opening_hours が複雑な時間指定の場合は「24h ではない」と断定
      // できないので 24/7 のみ true、それ以外の値は null (不明) にする
      open24h: tags.opening_hours === '24/7' ? true : null,
      shower: yesNo(tags.shower),
      fuel: yesNo(tags.fuel),
      restaurant: null,
      toilet: yesNo(tags.toilets),
      pref: null,
      city: null,
    },
  }
}

export function normalizeOsmElements(elements: OverpassElement[]): PoiFeature[] {
  return elements
    .map(normalizeOsmElement)
    .filter((f): f is PoiFeature => f !== null)
}

// ---- P35 (国土数値情報 道の駅、平成 30 年度 P35-18) ----
//
// 属性コード (P35-18_Roadside_Station.geojson の実データで確認済み):
//   P35_001 緯度 / P35_002 経度 / P35_003 都道府県名 / P35_004 市町村名 /
//   P35_005 行政区域コード / P35_006 道の駅名 / P35_007..010 URL /
//   P35_011..028 設備フラグ (1=あり, 2=なし)
//   設備の並び: ATM, ベビーベッド, レストラン, 軽食・喫茶, 宿泊, 温泉,
//   キャンプ場, 公園, 展望台, 美術館・博物館, ガソリンスタンド, EV充電,
//   無線LAN, シャワー, 体験施設, 観光案内, 身障者トイレ, ショップ

export interface P35Properties {
  P35_001?: number
  P35_002?: number
  P35_003?: string | null
  P35_004?: string | null
  P35_005?: string | null
  P35_006?: string | null
  [key: string]: unknown
}

export interface P35Feature {
  type: 'Feature'
  properties: P35Properties
  geometry: { type: 'Point'; coordinates: [number, number] }
}

export interface P35Collection {
  type: 'FeatureCollection'
  features: P35Feature[]
}

/** P35 設備フラグ (1=あり / 2=なし / それ以外は不明) */
function p35Flag(v: unknown): boolean | null {
  if (v === 1) return true
  if (v === 2) return false
  return null
}

export function normalizeP35Feature(f: P35Feature): PoiFeature | null {
  const p = f.properties
  const [lon, lat] = f.geometry?.coordinates ?? []
  if (typeof lon !== 'number' || typeof lat !== 'number') return null

  const name = p.P35_006 ?? null
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      id: `p35:${p.P35_005 ?? 'na'}:${name ?? `${lat},${lon}`}`,
      name,
      kind: 'michi_no_eki',
      sources: ['p35'],
      // 道の駅の駐車場は 24h 開放が制度要件だが、大型マスの有無は
      // P35 に無いので null (OSM 側とのマージで埋まることがある)
      hgv: null,
      hgvCapacity: null,
      open24h: true,
      shower: p35Flag(p.P35_024),
      fuel: p35Flag(p.P35_021),
      restaurant: p35Flag(p.P35_013),
      toilet: p35Flag(p.P35_027),
      pref: p.P35_003 ?? null,
      city: p.P35_004 ?? null,
    },
  }
}

/** P35 全国データからリージョン bbox 内だけを正規化して返す */
export function normalizeP35(collection: P35Collection, bbox?: Bbox): PoiFeature[] {
  const features = collection.features
    .map(normalizeP35Feature)
    .filter((f): f is PoiFeature => f !== null)
  if (!bbox) return features
  return features.filter((f) => {
    const [lon, lat] = f.geometry.coordinates
    return lat >= bbox.south && lat <= bbox.north && lon >= bbox.west && lon <= bbox.east
  })
}
