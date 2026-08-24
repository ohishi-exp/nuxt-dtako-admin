import { describe, it, expect, vi } from 'vitest'

import getHandler from '../../server/api/profit/snapshot.get'
import { profitR2Paths, profitVersionTimestamp } from '../../app/utils/profit-r2'
import { putVersionedProfit, type R2BucketLite, type R2ObjectLite } from '../../server/utils/profit-r2-io'

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

/**
 * **保存済みのスナップショットを直に置く。**
 *
 * 元は `POST /api/profit/snapshot` を呼んで作っていたが、**書き込みの口は
 * 突合一本化 PR-2 (#848) で撤去**した (人の確定は①の強制突合に一本化)。
 * **読む口は残す** — 既存のスナップショットは人の確認作業の記録で、消さないと決めてある。
 */
async function seedSnapshot(bucket: FakeR2Bucket) {
  const savedAt = '2026-06-21T00:00:00.000Z'
  const paths = profitR2Paths('2026-06', '8504', 'unko-1', '0-3600')
  await putVersionedProfit(
    bucket,
    paths.latest,
    paths.version(profitVersionTimestamp(new Date(savedAt))),
    JSON.stringify({ ...validSnapshotInput(), savedAt }),
    JSON.stringify(validSnapshotInput()),
    savedAt,
  )
}

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
    await seedSnapshot(bucket)

    const getEvent = { context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    const result = await callGet(getEvent) as { confirmedAmount: number }
    expect(result.confirmedAmount).toBe(65000)
  })
})
