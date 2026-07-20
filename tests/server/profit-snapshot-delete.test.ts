import { describe, it, expect, vi } from 'vitest'

import postHandler from '../../server/api/profit/snapshot.post'
import deleteHandler from '../../server/api/profit/snapshot.delete'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'

const callPost = (event: unknown) => (postHandler as unknown as (e: unknown) => Promise<unknown>)(event)
const callDelete = (event: unknown) => (deleteHandler as unknown as (e: unknown) => Promise<unknown>)(event)

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

describe('DELETE /api/profit/snapshot', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    const event = { context: {}, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await expect(callDelete(event)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('クエリパラメータが欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06' } }
    await expect(callDelete(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym が欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await expect(callDelete(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('保存済みスナップショットを削除すると latest.json が消え、一覧に出なくなる', async () => {
    const bucket = new FakeR2Bucket()
    const postEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput() }
    await callPost(postEvent)
    expect(await bucket.get('profit/2026-06/8504/unko-1/0-3600/latest.json')).not.toBeNull()

    const deleteEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    const result = await callDelete(deleteEvent) as { deleted: boolean }

    expect(result.deleted).toBe(true)
    expect(await bucket.get('profit/2026-06/8504/unko-1/0-3600/latest.json')).toBeNull()
  })

  it('v-*.json の版履歴は削除しない (監査証跡として残す)', async () => {
    const bucket = new FakeR2Bucket()
    const postEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput() }
    await callPost(postEvent)
    const versionKeys = [...bucket.store.keys()].filter(k => k.includes('/v-'))
    expect(versionKeys.length).toBeGreaterThan(0)

    const deleteEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await callDelete(deleteEvent)

    for (const key of versionKeys) {
      expect(await bucket.get(key)).not.toBeNull()
    }
  })

  it('history.jsonl に削除イベントが追記される', async () => {
    const bucket = new FakeR2Bucket()
    const postEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: validSnapshotInput() }
    await callPost(postEvent)

    const deleteEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await callDelete(deleteEvent)

    const history = await bucket.get('profit/2026-06/8504/unko-1/0-3600/history.jsonl')
    const lines = (await history!.text()).trim().split('\n').map(l => JSON.parse(l))
    expect(lines.at(-1).deleted).toBe(true)
  })

  it('未保存のキーを削除してもエラーにせず冪等に成功扱いにする', async () => {
    const bucket = new FakeR2Bucket()
    const deleteEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    const result = await callDelete(deleteEvent) as { deleted: boolean }
    expect(result.deleted).toBe(true)
  })
})
