import { describe, it, expect, vi } from 'vitest'

import handler from '../../server/api/profit/snapshots.get'
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
    confirmedSlips: [{ rowId: 'row-1', customerName: 'A社', saleDate: '2026-06-21', originMatch: 'exact', destMatch: 'exact' }],
    confirmedAmount: 65000,
    efficiency: { yenPerKm: 650, yenPerHourBound: 8125, yenPerHourDrive: 13000 },
    savedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  })
}

async function putSnapshot(bucket: FakeR2Bucket, ym: string, vehicle: string, unkoNo: string, segmentId: string, overrides: Record<string, unknown> = {}) {
  await bucket.put(`profit/${ym}/${vehicle}/${unkoNo}/${segmentId}/latest.json`, snapshotJson({ ym, vehicleCode: vehicle, unkoNo, segmentId, ...overrides }))
  await bucket.put(`profit/${ym}/${vehicle}/${unkoNo}/${segmentId}/v-20260719T000000.json`, snapshotJson({ ym, vehicleCode: vehicle, unkoNo, segmentId, ...overrides }))
  await bucket.put(`profit/${ym}/${vehicle}/${unkoNo}/${segmentId}/history.jsonl`, '{}\n')
}

function eventWith(env: Record<string, unknown>, query: Record<string, string> = {}) {
  return { context: { cloudflare: { env } }, _query: query }
}

describe('GET /api/profit/snapshots', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    await expect(call(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('絞り込み無しなら profit/ 配下の全スナップショットを保存日時の新しい順に返す (v-*.json/history.jsonlは除く)', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600', { savedAt: '2026-07-01T00:00:00.000Z' })
    await putSnapshot(bucket, '2026-07', '9999', 'unko-2', '100-200', { savedAt: '2026-07-19T00:00:00.000Z' })

    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: Array<{ unkoNo: string }>, total: number }
    expect(result.total).toBe(2)
    expect(result.items.map(i => i.unkoNo)).toEqual(['unko-2', 'unko-1'])
  })

  it('ym を指定すると R2 prefix で絞り込む', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600')
    await putSnapshot(bucket, '2026-07', '9999', 'unko-2', '100-200')

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-06' })) as { items: Array<{ unkoNo: string }> }
    expect(result.items.map(i => i.unkoNo)).toEqual(['unko-1'])
  })

  it('ym+vehicle を指定すると R2 prefix でさらに絞り込む', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600')
    await putSnapshot(bucket, '2026-06', '9999', 'unko-2', '100-200')

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-06', vehicle: '8504' })) as { items: Array<{ unkoNo: string }> }
    expect(result.items.map(i => i.unkoNo)).toEqual(['unko-1'])
  })

  it('vehicle のみ指定 (ym無し) なら全件取得後にメモリ上でフィルタする', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600')
    await putSnapshot(bucket, '2026-07', '9999', 'unko-2', '100-200')

    const result = await call(eventWith({ PROFIT_R2: bucket }, { vehicle: '8504' })) as { items: Array<{ unkoNo: string }> }
    expect(result.items.map(i => i.unkoNo)).toEqual(['unko-1'])
  })

  it('limit を指定すると件数を絞る', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-100', { savedAt: '2026-07-01T00:00:00.000Z' })
    await putSnapshot(bucket, '2026-06', '8504', 'unko-2', '100-200', { savedAt: '2026-07-19T00:00:00.000Z' })

    const result = await call(eventWith({ PROFIT_R2: bucket }, { limit: '1' })) as { items: unknown[], total: number }
    expect(result.items).toHaveLength(1) // 表示件数は limit で絞られる
    expect(result.total).toBe(2) // total は絞り込み前の全件数
  })

  it('limit が不正な文字列でも既定の上限を使う', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600')

    const result = await call(eventWith({ PROFIT_R2: bucket }, { limit: 'abc' })) as { items: unknown[] }
    expect(result.items).toHaveLength(1)
  })

  it('list に出るが get すると null (削除race等) なキーはスキップする', async () => {
    const bucket = new FakeR2Bucket()
    bucket.phantomKeys.push('profit/2026-06/8504/unko-1/0-3600/latest.json')
    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: unknown[], total: number }
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })

  it('保存済みが無ければ空配列を返す', async () => {
    const bucket = new FakeR2Bucket()
    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: unknown[], total: number }
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
  })
})
