// トラック休憩ポイント POI の正規化スキーマ (Refs #198)
//
// Overpass (OSM) と国土数値情報 P35 (道の駅) を単一の GeoJSON
// FeatureCollection に正規化する。POI マスタは純粋な静的データとして扱い、
// テナント業務データとの結合は front 側で行う (設計方針は issue #198)。

export type PoiKind =
  // 道の駅 (P35 由来 + OSM の名称「道の駅〜」。重複は dedupe で吸収)
  | 'michi_no_eki'
  // 高速道路 SA (名称 SA/サービスエリア、または highway=services)
  | 'sa'
  // 高速道路 PA / 一般道の rest area (名称 PA/パーキングエリア、または highway=rest_area)
  | 'pa'
  // 大型可駐車場 (OSM amenity=parking + hgv=yes|designated|only)
  | 'truck_parking'

export type PoiSource = 'osm' | 'p35'

export interface PoiProperties {
  /** 安定 ID。例: "osm:node:123456" / "p35:40228:原鶴" */
  id: string
  name: string | null
  kind: PoiKind
  /** マージ済みの場合は複数入る */
  sources: PoiSource[]
  /** 大型車 (HGV) 可。不明は null */
  hgv: boolean | null
  /** 大型マス台数 (OSM capacity:hgv)。不明は null */
  hgvCapacity: number | null
  /** 24 時間利用可 (OSM opening_hours=24/7 のみ true 判定)。不明は null */
  open24h: boolean | null
  shower: boolean | null
  fuel: boolean | null
  restaurant: boolean | null
  toilet: boolean | null
  /** 都道府県名 (P35 のみ) */
  pref: string | null
  /** 市町村名 (P35 のみ) */
  city: string | null
}

export interface PoiFeature {
  type: 'Feature'
  geometry: { type: 'Point'; coordinates: [number, number] } // [lon, lat]
  properties: PoiProperties
}

export interface PoiCollectionMetadata {
  generatedAt: string
  region: string
  /** [south, west, north, east] */
  bbox: [number, number, number, number]
  /** ODbL / 国土数値情報 の帰属表示。UI 側はこれを必ず表示する */
  attribution: string[]
  counts: Record<string, number>
}

export interface PoiCollection {
  type: 'FeatureCollection'
  metadata: PoiCollectionMetadata
  features: PoiFeature[]
}
