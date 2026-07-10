import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCollection, parseArgs, readJsonFile } from '../../scripts/poi/build-poi.ts'
import type { OverpassElement } from '../../scripts/poi/overpass.ts'

describe('parseArgs', () => {
  it('デフォルト値を返す', () => {
    expect(parseArgs([])).toEqual({
      region: 'kyushu',
      p35: undefined,
      overpassJson: undefined,
      out: 'poi-kyushu.geojson',
    })
  })

  it('引数を解釈する', () => {
    expect(
      parseArgs(['--region', 'kyushu', '--p35', 'a.geojson', '--overpass-json', 'b.json', '--out', 'c.geojson']),
    ).toEqual({ region: 'kyushu', p35: 'a.geojson', overpassJson: 'b.json', out: 'c.geojson' })
  })

  it('未知リージョン / 不正引数は throw', () => {
    expect(() => parseArgs(['--region', 'mars'])).toThrow(/unknown region/)
    expect(() => parseArgs(['--region'])).toThrow(/invalid argument/)
    expect(() => parseArgs(['region', 'kyushu'])).toThrow(/invalid argument/)
  })
})

describe('readJsonFile', () => {
  it('UTF-8 (BOM 付き含む) と Shift_JIS を読める', () => {
    const dir = mkdtempSync(join(tmpdir(), 'poi-test-'))
    const utf8Path = join(dir, 'utf8.json')
    writeFileSync(utf8Path, '﻿{"name":"原鶴"}')
    expect(readJsonFile<{ name: string }>(utf8Path).name).toBe('原鶴')

    const sjisPath = join(dir, 'sjis.json')
    // "{"name":"道"}" を Shift_JIS で書く (道 = 0x93 0xB9)
    writeFileSync(sjisPath, Buffer.from([0x7B, 0x22, 0x6E, 0x61, 0x6D, 0x65, 0x22, 0x3A, 0x22, 0x93, 0xB9, 0x22, 0x7D]))
    expect(readJsonFile<{ name: string }>(sjisPath).name).toBe('道')
  })
})

describe('buildCollection', () => {
  const elements: OverpassElement[] = [
    { type: 'node', id: 1, lat: 33.5, lon: 130.5, tags: { highway: 'services', name: '古賀SA' } },
    // 上と同一施設の way 表現 (≈60m) → dedupe される
    { type: 'way', id: 2, center: { lat: 33.5005, lon: 130.5 }, tags: { highway: 'services', name: '古賀サービスエリア' } },
    { type: 'node', id: 3, lat: 33.0, lon: 131.0, tags: { highway: 'rest_area', name: '鞍手PA' } },
  ]
  const p35 = {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [130.78, 33.35] as [number, number] },
        properties: { P35_003: '福岡県', P35_004: '朝倉市', P35_005: '40228', P35_006: '原鶴' },
      },
    ],
  }

  it('正規化 + dedupe + metadata 付き FeatureCollection を組み立てる', () => {
    const now = new Date('2026-07-10T00:00:00Z')
    const { collection, osmCount, p35Count } = buildCollection('kyushu', elements, p35, now)
    expect(osmCount).toBe(3)
    expect(p35Count).toBe(1)
    expect(collection.features).toHaveLength(3) // 古賀SA が 1 件に統合される
    expect(collection.metadata).toMatchObject({
      generatedAt: '2026-07-10T00:00:00.000Z',
      region: 'kyushu',
      bbox: [30.9, 128.4, 34.3, 132.2],
      counts: { sa: 1, pa: 1, michi_no_eki: 1 },
    })
    expect(collection.metadata.attribution.join(' ')).toContain('OpenStreetMap')
    expect(collection.metadata.attribution.join(' ')).toContain('国土数値情報')
  })

  it('P35 なしでも動く (attribution は ODbL のみ)', () => {
    const { collection, p35Count } = buildCollection('kyushu', elements, null)
    expect(p35Count).toBe(0)
    expect(collection.metadata.attribution).toEqual(['© OpenStreetMap contributors (ODbL)'])
  })

  it('未知リージョンは throw', () => {
    expect(() => buildCollection('mars', [], null)).toThrow(/unknown region/)
  })
})
