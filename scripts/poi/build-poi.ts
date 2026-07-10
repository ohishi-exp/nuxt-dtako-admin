// POI 収集パイプライン CLI (Refs #198)
//
// Overpass (OSM) + 国土数値情報 P35 (道の駅) からトラック休憩ポイントの
// 正規化 GeoJSON を生成する月次バッチ。出力は R2 (dtako-uploads の poi/
// prefix) に `wrangler r2 object put` で配置する想定 (README.md 参照)。
//
// 使い方:
//   node scripts/poi/build-poi.ts --region kyushu \
//     [--p35 P35-18_Roadside_Station.geojson] \
//     [--overpass-json cached-overpass.json] \
//     [--out poi-kyushu.geojson]
//
// Node 22.18+ の type stripping で直接実行できる (追加依存なし)。

import { readFileSync, writeFileSync } from 'node:fs'
import { REGION_BBOX, buildOverpassQuery, fetchOverpass } from './overpass.ts'
import type { OverpassElement } from './overpass.ts'
import { normalizeOsmElements, normalizeP35 } from './normalize.ts'
import type { P35Collection } from './normalize.ts'
import { dedupePois } from './dedupe.ts'
import type { PoiCollection, PoiFeature } from './types.ts'

export interface CliArgs {
  region: string
  p35?: string
  overpassJson?: string
  out: string
}

export function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === undefined || !key.startsWith('--') || value === undefined) {
      throw new Error(`invalid argument: ${key ?? '(none)'}`)
    }
    args[key.slice(2)] = value
  }
  const region = args.region ?? 'kyushu'
  if (!(region in REGION_BBOX)) {
    throw new Error(`unknown region: ${region} (known: ${Object.keys(REGION_BBOX).join(', ')})`)
  }
  return {
    region,
    p35: args.p35,
    overpassJson: args['overpass-json'],
    out: args.out ?? `poi-${region}.geojson`,
  }
}

/** UTF-8 (BOM 許容) / Shift_JIS 両対応で JSON を読む (P35 配布物は年度で符号化が揺れる) */
export function readJsonFile<T>(path: string): T {
  const raw = readFileSync(path)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    text = new TextDecoder('shift_jis').decode(raw)
  }
  return JSON.parse(text.replace(/^﻿/, '')) as T
}

export interface BuildResult {
  collection: PoiCollection
  osmCount: number
  p35Count: number
}

/** 正規化 → dedupe → FeatureCollection 組み立て (I/O なし、テスト対象) */
export function buildCollection(
  region: string,
  elements: OverpassElement[],
  p35: P35Collection | null,
  now: Date = new Date(),
): BuildResult {
  const bbox = REGION_BBOX[region]
  if (!bbox) throw new Error(`unknown region: ${region}`)

  const osmFeatures = normalizeOsmElements(elements)
  const p35Features = p35 ? normalizeP35(p35, bbox) : []
  const features = dedupePois([...osmFeatures, ...p35Features])

  const counts: Record<string, number> = {}
  for (const f of features) {
    counts[f.properties.kind] = (counts[f.properties.kind] ?? 0) + 1
  }

  const attribution = ['© OpenStreetMap contributors (ODbL)']
  if (p35) attribution.push('国土数値情報 (道の駅データ P35) 国土交通省')

  return {
    collection: {
      type: 'FeatureCollection',
      metadata: {
        generatedAt: now.toISOString(),
        region,
        bbox: [bbox.south, bbox.west, bbox.north, bbox.east],
        attribution,
        counts,
      },
      features,
    },
    osmCount: osmFeatures.length,
    p35Count: p35Features.length,
  }
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const bbox = REGION_BBOX[args.region]!

  let elements: OverpassElement[]
  if (args.overpassJson) {
    elements = readJsonFile<{ elements: OverpassElement[] }>(args.overpassJson).elements
    console.log(`overpass (cached): ${elements.length} elements`)
  } else {
    elements = await fetchOverpass(buildOverpassQuery(bbox), { log: console.log })
    console.log(`overpass (live): ${elements.length} elements`)
  }

  const p35 = args.p35 ? readJsonFile<P35Collection>(args.p35) : null
  const { collection, osmCount, p35Count } = buildCollection(args.region, elements, p35)

  writeFileSync(args.out, JSON.stringify(collection))
  console.log(
    `wrote ${args.out}: ${collection.features.length} features ` +
      `(osm=${osmCount}, p35=${p35Count}, dedup=${osmCount + p35Count - collection.features.length})`,
  )
  console.log('counts:', JSON.stringify(collection.metadata.counts))
}

// vitest からの import 時は実行しない
const isDirectRun = process.argv[1]?.endsWith('build-poi.ts') === true
if (isDirectRun) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e)
    process.exitCode = 1
  })
}

// PoiFeature は re-export しておくと consumer (将来の server route) が使える
export type { PoiFeature, PoiCollection }
