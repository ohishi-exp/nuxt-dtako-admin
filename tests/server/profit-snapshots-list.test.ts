import { beforeEach, describe, it, expect, vi } from 'vitest'

import handler from '../../server/api/profit/snapshots.get'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
})

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

/**
 * **既定でログイン済みの event。** `requireAuth` (Refs #988) が読む
 * `INTERNAL_SHARED_SECRET` を env に足しておく — 認可そのものは
 * 「認可 (Refs #988)」の describe で測る。`env` に同名を渡せば上書きできる。
 */
function eventWith(env: Record<string, unknown>, query: Record<string, string> = {}) {
  return { context: { cloudflare: { env: { INTERNAL_SHARED_SECRET: 'secret', ...env } } }, _query: query }
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

  it('limit=0 なら既定の上限を使う (0 件表示に倒さない)', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600')

    const result = await call(eventWith({ PROFIT_R2: bucket }, { limit: '0' })) as { items: unknown[] }
    expect(result.items).toHaveLength(1)
  })

  it('list に出るが get すると null (削除race等) なキーは一覧から外し、「読めなかった」として数える', async () => {
    const bucket = new FakeR2Bucket()
    bucket.phantomKeys.push('profit/2026-06/8504/unko-1/0-3600/latest.json')
    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: unknown[], total: number, unreadable: number }
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
    // **黙って飛ばさない** — 「保存が無い」と「読めなかった」を同じ見た目にしない (Refs #850)。
    expect(result.unreadable).toBe(1)
  })

  it('保存済みが無ければ空配列を返す', async () => {
    const bucket = new FakeR2Bucket()
    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: unknown[], total: number, unreadable: number }
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
    expect(result.unreadable).toBe(0)
  })

  // --- profit/ 配下の別種の latest.json (Refs #850) ---

  it('profit/{ym}/margin-summary/latest.json (#826) を読まない — `?ym=` が 500 だった原因', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-07', '8504', 'unko-1', '0-3600')
    // 粗利集計の版 (MarginSummarySnapshot)。confirmedSlips を持たないので
    // ProfitSnapshot として読むと toSnapshotListItem の .map で落ちる。
    await bucket.put('profit/2026-07/margin-summary/latest.json', JSON.stringify({ ym: '2026-07', totals: { operations: 91, salesYen: 10260265, allowanceYen: 2499500, marginYen: 4467597 } }))

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' })) as { items: Array<{ unkoNo: string }>, total: number, unreadable: number }
    expect(result.items.map(i => i.unkoNo)).toEqual(['unko-1'])
    expect(result.total).toBe(1)
    // **仲間ではないので「欠けている」ではない。** 数えない。
    expect(result.unreadable).toBe(0)
  })

  it('profit/allowance-overrides/{kind}/latest.json (#845) を読まない — `ym` 無しが 500 だった原因', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-07', '8504', 'unko-1', '0-3600')
    await bucket.put('profit/allowance-overrides/provisional/latest.json', JSON.stringify({ kind: 'provisional', entries: [] }))

    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: Array<{ unkoNo: string }>, total: number, unreadable: number }
    expect(result.items.map(i => i.unkoNo)).toEqual(['unko-1'])
    expect(result.total).toBe(1)
    expect(result.unreadable).toBe(0)
  })

  it('スナップショットのキーなのに本文が壊れていれば数えて返す (投げない)', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600')
    await bucket.put('profit/2026-06/8504/unko-2/100-200/latest.json', '{壊れた')

    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: Array<{ unkoNo: string }>, total: number, unreadable: number }
    expect(result.items.map(i => i.unkoNo)).toEqual(['unko-1'])
    expect(result.total).toBe(1)
    expect(result.unreadable).toBe(1)
  })

  it('スナップショットのキーなのに中身が ProfitSnapshot でなければ数えて返す', async () => {
    const bucket = new FakeR2Bucket()
    await bucket.put('profit/2026-06/8504/unko-2/100-200/latest.json', JSON.stringify({ ym: '2026-06' }))

    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: unknown[], total: number, unreadable: number }
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
    expect(result.unreadable).toBe(1)
  })
})


/**
 * **認可** (Refs #988)。この読み口は **Cloudflare Access だけが前段**で、Nitro 側に
 * 認可が 1 つも無かった (`docs/plan-922-single-signin.md` §1 の D 段)。書き込み側は
 * #995 で塞いだので、同じ A 段の `requireAuth` を読む側にも掛ける。
 *
 * - **陰性対照**: 未ログインは 401 で、**R2 を 1 回も叩かない**
 *   (`requireAuth` を外すとこの it が落ちる)
 * - **陽性対照**: 認証が通れば**従来どおりの応答が返る** (塞いだだけで使えなくしていない)
 */
describe('GET /api/profit/snapshots — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 を 1 回も叩かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600')
    const listSpy = vi.spyOn(bucket, 'list')
    const getSpy = vi.spyOn(bucket, 'get')
    await expect(call(eventWith({ PROFIT_R2: bucket }))).rejects.toMatchObject({ statusCode: 401 })
    expect(listSpy).not.toHaveBeenCalled()
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call({ context: { cloudflare: { env: { PROFIT_R2: new FakeR2Bucket() } } }, _query: {} }))
      .rejects.toMatchObject({ statusCode: 503, statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET') })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {}, _query: {} })).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, PROFIT_R2: new FakeR2Bucket() }, {}))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, PROFIT_R2: new FakeR2Bucket() }, {})))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, PROFIT_R2: new FakeR2Bucket() }, {})))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' }, {}))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: '' }, {}))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: 7 }, {}))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  it('★ 陽性対照: 認証が通れば従来どおり一覧が返る', async () => {
    const bucket = new FakeR2Bucket()
    await putSnapshot(bucket, '2026-06', '8504', 'unko-1', '0-3600')
    const result = await call(eventWith({ PROFIT_R2: bucket })) as { items: Array<{ unkoNo: string }>, total: number }
    expect(result.items.map(i => i.unkoNo)).toEqual(['unko-1'])
    expect(result.total).toBe(1)
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
  })
})
