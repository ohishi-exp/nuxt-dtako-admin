// POI の重複統合 (Refs #198)
//
// 同一施設が複数レコードになるパターン:
//   1. OSM 内: 同じ SA/PA が node と way の両方でマッピングされている
//   2. P35 × OSM: 道の駅が P35 と OSM (rest_area/services) の両方に存在する
//
// マージ方針:
//   - P35 を優先 (kind は michi_no_eki を維持、name も P35 側)
//   - 属性は null を相手側の値で埋める (確定値は上書きしない)
//   - truck_parking は「道の駅に隣接する別の駐車場」でありうるため、
//     無名でも P35 に吸収しない (名前が一致する時だけマージ)

import type { PoiFeature, PoiProperties } from './types.ts'

const EARTH_RADIUS_M = 6371_000

/** 2 点間の距離 (m)。haversine */
export function haversineMeters(
  a: [number, number], // [lon, lat]
  b: [number, number],
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLon = toRad(b[0] - a[0])
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(s))
}

/** 名前照合用の正規化 (NFKC + 空白除去 + 「道の駅」等の接頭辞除去 + 小文字化) */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/^道の駅/u, '')
    .replace(/(サービスエリア|パーキングエリア)$/u, '')
    .toLowerCase()
}

function namesMatch(a: string | null, b: string | null): boolean | null {
  if (a === null || b === null) return null // 判定不能
  const na = normalizeName(a)
  const nb = normalizeName(b)
  if (na === '' || nb === '') return null
  return na === nb || na.includes(nb) || nb.includes(na)
}

/** null を相手の値で埋める (確定値は保持) */
function fillNulls(target: PoiProperties, from: PoiProperties): void {
  const keys = [
    'name',
    'hgv',
    'hgvCapacity',
    'open24h',
    'shower',
    'fuel',
    'restaurant',
    'toilet',
    'pref',
    'city',
  ] as const
  for (const k of keys) {
    if (target[k] === null && from[k] !== null) {
      ;(target as Record<string, unknown>)[k] = from[k]
    }
  }
  for (const s of from.sources) {
    if (!target.sources.includes(s)) target.sources.push(s)
  }
}

function isP35(f: PoiFeature): boolean {
  return f.properties.sources.includes('p35')
}

/** f を kept にマージできるか */
function canMerge(kept: PoiFeature, f: PoiFeature): boolean {
  const p35Pair = isP35(kept) || isP35(f)
  const radius = p35Pair ? 300 : 150
  const dist = haversineMeters(kept.geometry.coordinates, f.geometry.coordinates)
  if (dist > radius) return false

  const nm = namesMatch(kept.properties.name, f.properties.name)
  if (nm === true) return true
  if (nm === false) return false

  // 名前で判定できない (少なくとも片方が無名) 場合:
  if (p35Pair) {
    // 道の駅本体が OSM では無名の rest_area/services で置かれていることが
    // あるので truck_parking 以外は吸収する (truck_parking は道の駅に
    // 隣接する別の駐車場でありうるので名前一致時のみ)
    const osmSide = isP35(kept) ? f : kept
    return osmSide.properties.kind !== 'truck_parking'
  }
  // OSM 同士は同一 kind のみ (SA と隣接 PA を誤統合しない)
  return kept.properties.kind === f.properties.kind
}

/** マージ優先度。高いものが正 (代表レコード) として残る */
function priority(f: PoiFeature): number {
  let p = 0
  if (isP35(f)) p += 100
  // 属性が多く埋まっているレコードを代表にする
  const props = f.properties
  for (const v of [props.name, props.hgv, props.hgvCapacity, props.open24h, props.shower, props.fuel, props.toilet]) {
    if (v !== null) p += 1
  }
  return p
}

/**
 * 重複統合。優先度順に走査し、既出レコードに吸収できるものはマージ、
 * できないものは新規として残す。
 */
export function dedupePois(features: PoiFeature[]): PoiFeature[] {
  const sorted = [...features].sort((a, b) => priority(b) - priority(a))
  const kept: PoiFeature[] = []
  for (const f of sorted) {
    const match = kept.find((k) => canMerge(k, f))
    if (match) {
      fillNulls(match.properties, f.properties)
    } else {
      // 呼び出し元の配列を汚さないよう properties は複製する
      kept.push({
        ...f,
        properties: { ...f.properties, sources: [...f.properties.sources] },
      })
    }
  }
  return kept
}
