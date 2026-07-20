import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import handler from '../../server/api/profit/monthly.get'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getQuery: (event: { _query: Record<string, string> }) => event._query,
  }
})

class FakeR2Bucket implements R2BucketLite {
  store = new Map<string, { body: string, customMetadata?: Record<string, string> }>()
  /** list には出るが get すると null になるキー (削除race等の防御分岐のテスト用)。 */
  phantomKeys: string[] = []

  async get(key: string) {
    const entry = this.store.get(key)
    if (!entry) return null
    return { key, customMetadata: entry.customMetadata, text: async () => entry.body }
  }

  async head(key: string) {
    const entry = this.store.get(key)
    return entry ? { customMetadata: entry.customMetadata } : null
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { customMetadata?: Record<string, string> }) {
    const body = typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array)
    this.store.set(key, { body, customMetadata: options?.customMetadata })
    return {}
  }

  async delete(key: string) {
    this.store.delete(key)
    return {}
  }

  async list(options?: { prefix?: string, cursor?: string }) {
    const prefix = options?.prefix ?? ''
    const keys = [...this.store.keys(), ...this.phantomKeys].filter(k => k.startsWith(prefix))
    const objects: R2ObjectLite[] = keys.map(key => ({ key, customMetadata: this.store.get(key)?.customMetadata }))
    return { objects, truncated: false, cursor: undefined }
  }
}

function snapshotJson(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    vehicleCode: '8504',
    unkoNo: 'unko-1',
    segmentId: '0-3600',
    ym: '2026-06',
    range: { fromTs: 0, toTs: 3600 },
    location: { originCity: '長崎市', destCity: '北九州市' },
    dtakoSummary: { distanceKm: 100, durationMin: 480, byCategory: { drive: 300, loading: 60, unloading: 60, rest: 60, idle: 0, other: 0 }, rowCount: 2 },
    confirmedSlips: [{ rowId: 'row-1', originMatch: 'exact', destMatch: 'exact' }],
    confirmedAmount: 65000,
    efficiency: { yenPerKm: 650, yenPerHourBound: 8125, yenPerHourDrive: 13000 },
    savedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  })
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const validEnv = { NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'id', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'secret' }

describe('GET /api/profit/monthly', () => {
  it('vehicle が無ければ 400', async () => {
    const event = { context: {}, _query: { ym: '2026-06' } }
    await expect(call(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym の形式が不正なら 400', async () => {
    const event = { context: {}, _query: { vehicle: '8504', ym: '2026/06' } }
    await expect(call(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym が無ければ 400', async () => {
    const event = { context: {}, _query: { vehicle: '8504' } }
    await expect(call(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('PROFIT_R2 未設定なら 503', async () => {
    const event = { context: { cloudflare: { env: validEnv } }, _query: { vehicle: '8504', ym: '2026-06' } }
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('一番星 CF Access binding 未設定なら fetchIchiban 由来の 503 を伝播する', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } } }
    Object.assign(event, { _query: { vehicle: '8504', ym: '2026-06' } })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('upstream fetch 失敗なら 502', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { ...validEnv, PROFIT_R2: bucket } } }, _query: { vehicle: '8504', ym: '2026-06' } }
    await expect(call(event)).rejects.toMatchObject({ statusCode: 502 })
  })

  it('upstream が非2xxならそのstatusCodeで伝播する', async () => {
    fetchMock.mockResolvedValue(new Response('bad request', { status: 400 }))
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { ...validEnv, PROFIT_R2: bucket } } }, _query: { vehicle: '8504', ym: '2026-06' } }
    await expect(call(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('正常系: 一番星月計と保存済みスナップショットを集計して返す', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      source_table: '運転日報明細',
      data: [
        { sale_date: '2026-06-21', vehicle_number: '8504', customer_code: '000001', customer_name: 'A', origin_area_name: '', dest_area_name: '', origin: '', dest: '', is_subcontracted: false, amount: 65000, row_id: 'row-1' },
        { sale_date: '2026-06-22', vehicle_number: '8504', customer_code: '000002', customer_name: 'B', origin_area_name: '', dest_area_name: '', origin: '', dest: '', is_subcontracted: false, amount: 20000, row_id: 'row-2' },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))

    const bucket = new FakeR2Bucket()
    await bucket.put('profit/2026-06/8504/unko-1/0-3600/latest.json', snapshotJson())
    await bucket.put('profit/2026-06/8504/unko-1/0-3600/v-20260719T000000.json', snapshotJson())
    await bucket.put('profit/2026-06/8504/unko-1/0-3600/history.jsonl', '{}\n')
    // 別車輌は集計対象外
    await bucket.put('profit/2026-06/9999/unko-2/0-100/latest.json', snapshotJson({ vehicleCode: '9999', confirmedAmount: 999999 }))

    const event = { context: { cloudflare: { env: { ...validEnv, PROFIT_R2: bucket } } }, _query: { vehicle: '8504', ym: '2026-06' } }
    const result = await call(event) as { ichibanTotal: number, confirmedTotal: number, diff: number, snapshotCount: number, matchCounts: Record<string, number> }

    expect(result.ichibanTotal).toBe(85000)
    expect(result.confirmedTotal).toBe(65000)
    expect(result.diff).toBe(20000)
    expect(result.snapshotCount).toBe(1) // v-*.json/history.jsonl/別車輌は含まない
    expect(result.matchCounts).toEqual({ exact: 1, partial: 0, none: 0 })

    // upstream fetch の呼び出し内容 (パス・クエリ) を確認
    const [url] = fetchMock.mock.calls[0] as [URL]
    expect(url.pathname).toBe('/api/sales/vehicle-daily')
    expect(url.searchParams.get('vehicle')).toBe('8504')
    expect(url.searchParams.get('from')).toBe('2026-06-01')
    expect(url.searchParams.get('to')).toBe('2026-07-01')
  })

  it('list に出るが get すると null (削除race等) なキーはスキップする', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ source_table: '運転日報明細', data: [] }), { status: 200 }))
    const bucket = new FakeR2Bucket()
    bucket.phantomKeys.push('profit/2026-06/8504/unko-1/0-3600/latest.json')
    const event = { context: { cloudflare: { env: { ...validEnv, PROFIT_R2: bucket } } }, _query: { vehicle: '8504', ym: '2026-06' } }
    const result = await call(event) as { snapshotCount: number }
    expect(result.snapshotCount).toBe(0)
  })

  it('保存済みスナップショットが無ければ確認済み合計0・マッチ内訳0で返す', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ source_table: '運転日報明細', data: [] }), { status: 200 }))
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { ...validEnv, PROFIT_R2: bucket } } }, _query: { vehicle: '8504', ym: '2026-06' } }
    const result = await call(event) as { ichibanTotal: number, confirmedTotal: number, snapshotCount: number }
    expect(result.ichibanTotal).toBe(0)
    expect(result.confirmedTotal).toBe(0)
    expect(result.snapshotCount).toBe(0)
  })
})
