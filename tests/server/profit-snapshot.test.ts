import { describe, it, expect, vi } from 'vitest'

import postHandler from '../../server/api/profit/snapshot.post'
import getHandler from '../../server/api/profit/snapshot.get'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'

const callPost = (event: unknown) => (postHandler as unknown as (e: unknown) => Promise<unknown>)(event)
const callGet = (event: unknown) => (getHandler as unknown as (e: unknown) => Promise<unknown>)(event)

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    readBody: (event: { _body: unknown }) => Promise.resolve(event._body),
    getQuery: (event: { _query: Record<string, string> }) => event._query,
  }
})

class FakeR2Bucket implements R2BucketLite {
  store = new Map<string, { body: string, customMetadata?: Record<string, string> }>()

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
    const objects: R2ObjectLite[] = [...this.store.keys()]
      .filter(k => k.startsWith(prefix))
      .map(key => ({ key, customMetadata: this.store.get(key)?.customMetadata }))
    return { objects, truncated: false, cursor: undefined }
  }
}

function validSnapshotInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    vehicleCode: '8504',
    unkoNo: 'unko-1',
    segmentId: '0-3600',
    ym: '2026-06',
    range: { fromTs: 0, toTs: 3600 },
    location: { originCity: '長崎市', destCity: '北九州市' },
    dtakoSummary: { distanceKm: 100, durationMin: 480, byCategory: { drive: 300, loading: 60, unloading: 60, rest: 60, idle: 0, other: 0 }, rowCount: 2 },
    confirmedSlips: [{ rowId: 'row-1', amount: 65000 }],
    confirmedAmount: 65000,
    efficiency: { yenPerKm: 650, yenPerHourBound: 8125, yenPerHourDrive: 13000 },
    ...overrides,
  }
}

describe('POST /api/profit/snapshot', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    const event = { context: {}, _body: validSnapshotInput() }
    await expect(callPost(event)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('必須フィールドが欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: { vehicleCode: '8504' } }
    await expect(callPost(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('body が無ければ 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: null }
    await expect(callPost(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym の形式が不正なら 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput({ ym: '2026/06' }) }
    await expect(callPost(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('正常な入力なら保存し savedAt を実行時刻で埋めて返す', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput() }
    const result = await callPost(event) as { saved: boolean, changed: boolean, savedAt: string }

    expect(result.saved).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.savedAt).toBeTruthy()

    const stored = await bucket.get('profit/2026-06/8504/unko-1/0-3600/latest.json')
    const parsed = JSON.parse((await stored!.text()))
    expect(parsed.confirmedAmount).toBe(65000)
    expect(parsed.savedAt).toBe(result.savedAt)
  })

  it('同一内容を2回保存しても2回目は changed=false', async () => {
    const bucket = new FakeR2Bucket()
    const event1 = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput() }
    await callPost(event1)
    // savedAt はサーバー側で都度上書きされるが、比較対象の body 自体 (savedAt 抜き) は同一
    const event2 = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput() }
    const result2 = await callPost(event2) as { changed: boolean }
    expect(result2.changed).toBe(false)
  })

  it('history.jsonl に保存イベントが追記される', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput() }
    await callPost(event)
    const history = await bucket.get('profit/2026-06/8504/unko-1/0-3600/history.jsonl')
    expect(history).not.toBeNull()
    const line = JSON.parse((await history!.text()).trim())
    expect(line.confirmedAmount).toBe(65000)
    expect(line.confirmedCount).toBe(1)
  })
})

describe('GET /api/profit/snapshot', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    const event = { context: {}, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await expect(callGet(event)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('クエリパラメータが欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06' } }
    await expect(callGet(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym が欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await expect(callGet(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('未保存なら 404', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await expect(callGet(event)).rejects.toMatchObject({ statusCode: 404 })
  })

  it('保存済みなら latest の内容を返す', async () => {
    const bucket = new FakeR2Bucket()
    const postEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput() }
    await callPost(postEvent)

    const getEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    const result = await callGet(getEvent) as { confirmedAmount: number }
    expect(result.confirmedAmount).toBe(65000)
  })
})
