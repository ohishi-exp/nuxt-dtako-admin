import { beforeEach, describe, it, expect, vi } from 'vitest'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import deleteHandler from '../../server/api/profit/snapshot.delete'
import { profitR2Paths, profitVersionTimestamp } from '../../app/utils/profit-r2'
import { putVersionedProfit, appendProfitHistory, type R2BucketLite, type R2ObjectLite } from '../../server/utils/profit-r2-io'

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

/**
 * **保存済みのスナップショットを直に置く。**
 *
 * 元は `POST /api/profit/snapshot` を呼んで作っていたが、**書き込みの口は
 * 突合一本化 PR-2 (#848) で撤去**した (人の確定は①の強制突合に一本化)。
 * **消す口は残す** — 既存のスナップショットは人の確認作業の記録なので、
 * 「もう増えないが、消せる」状態を保つ。だから置き方だけ POST と同じ形に真似る。
 */
async function seedSnapshot(bucket: FakeR2Bucket) {
  const savedAt = '2026-06-21T00:00:00.000Z'
  const snapshot = { ...validSnapshotInput(), savedAt }
  const paths = profitR2Paths('2026-06', '8504', 'unko-1', '0-3600')
  const ts = profitVersionTimestamp(new Date(savedAt))
  await putVersionedProfit(
    bucket, paths.latest, paths.version(ts), JSON.stringify(snapshot),
    JSON.stringify(validSnapshotInput()), savedAt)
  await appendProfitHistory(bucket, paths.history, JSON.stringify({
    ts: savedAt, changed: true, confirmedAmount: 65000, confirmedCount: 1,
  }))
}

/** 認証が通る前提の env。`requireAuth` に渡す secret を必ず載せる (Refs #988)。 */
const okEnv = (bucket: R2BucketLite, extra: Record<string, unknown> = {}) =>
  ({ INTERNAL_SHARED_SECRET: 'secret', PROFIT_R2: bucket, ...extra })

const fullQuery = { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' }

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
})

/**
 * ★ **Access に依存しない認可** (Refs #988)。この口は
 * `docs/plan-922-single-signin.md` §1 の D 段 (認可が 1 つも無い) に居た。
 * **陰性対照**: `requireAuth` を外すとこの describe の 401 が落ちる。
 * **陽性対照**: 認証が通れば従来どおり消せる (下の既存テスト群がそのまま担う)。
 */
describe('DELETE /api/profit/snapshot — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 には 1 バイトも触らない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const bucket = new FakeR2Bucket()
    await seedSnapshot(bucket)
    const before = new Map(bucket.store)
    const event = { context: { cloudflare: { env: okEnv(bucket) } }, _query: fullQuery }
    await expect(callDelete(event)).rejects.toMatchObject({ statusCode: 401 })
    // latest.json も history.jsonl も動いていない。
    expect([...bucket.store.keys()].sort()).toEqual([...before.keys()].sort())
    expect(bucket.store.get('profit/2026-06/8504/unko-1/0-3600/history.jsonl')?.body)
      .toBe(before.get('profit/2026-06/8504/unko-1/0-3600/history.jsonl')?.body)
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    const event = { context: { cloudflare: { env: { PROFIT_R2: new FakeR2Bucket() } } }, _query: fullQuery }
    await expect(callDelete(event)).rejects.toMatchObject({ statusCode: 503, statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET') })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(callDelete({ context: {}, _query: fullQuery })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    const bucket = new FakeR2Bucket()
    const env = { INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, PROFIT_R2: bucket }
    await callDelete({ context: { cloudflare: { env } }, _query: fullQuery })
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    const nullish = { INTERNAL_SHARED_SECRET: { get: async () => undefined }, PROFIT_R2: new FakeR2Bucket() }
    await expect(callDelete({ context: { cloudflare: { env: nullish } }, _query: fullQuery })).rejects.toMatchObject({ statusCode: 503 })
    const wrongType = { INTERNAL_SHARED_SECRET: 123, PROFIT_R2: new FakeR2Bucket() }
    await expect(callDelete({ context: { cloudflare: { env: wrongType } }, _query: fullQuery })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await callDelete({ context: { cloudflare: { env: okEnv(new FakeR2Bucket(), { NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' }) } }, _query: fullQuery })
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await callDelete({ context: { cloudflare: { env: okEnv(new FakeR2Bucket(), { NUXT_PUBLIC_AUTH_WORKER_URL: '' }) } }, _query: fullQuery })
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await callDelete({ context: { cloudflare: { env: okEnv(new FakeR2Bucket(), { NUXT_PUBLIC_AUTH_WORKER_URL: 7 }) } }, _query: fullQuery })
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('DELETE /api/profit/snapshot', () => {
  it('PROFIT_R2 未設定なら 503 (ログイン後)', async () => {
    const event = { context: { cloudflare: { env: { INTERNAL_SHARED_SECRET: 'secret' } } }, _query: fullQuery }
    await expect(callDelete(event)).rejects.toMatchObject({ statusCode: 503, statusMessage: expect.stringContaining('PROFIT_R2') })
  })

  it('クエリパラメータが欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: okEnv(bucket) } }, _query: { ym: '2026-06' } }
    await expect(callDelete(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym が欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    const event = { context: { cloudflare: { env: okEnv(bucket) } }, _query: { vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await expect(callDelete(event)).rejects.toMatchObject({ statusCode: 400 })
  })

  it('保存済みスナップショットを削除すると latest.json が消え、一覧に出なくなる', async () => {
    const bucket = new FakeR2Bucket()
    await seedSnapshot(bucket)
    expect(await bucket.get('profit/2026-06/8504/unko-1/0-3600/latest.json')).not.toBeNull()

    const deleteEvent = { context: { cloudflare: { env: okEnv(bucket) } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    const result = await callDelete(deleteEvent) as { deleted: boolean }

    expect(result.deleted).toBe(true)
    expect(await bucket.get('profit/2026-06/8504/unko-1/0-3600/latest.json')).toBeNull()
  })

  it('v-*.json の版履歴は削除しない (監査証跡として残す)', async () => {
    const bucket = new FakeR2Bucket()
    await seedSnapshot(bucket)
    const versionKeys = [...bucket.store.keys()].filter(k => k.includes('/v-'))
    expect(versionKeys.length).toBeGreaterThan(0)

    const deleteEvent = { context: { cloudflare: { env: okEnv(bucket) } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await callDelete(deleteEvent)

    for (const key of versionKeys) {
      expect(await bucket.get(key)).not.toBeNull()
    }
  })

  it('history.jsonl に削除イベントが追記される', async () => {
    const bucket = new FakeR2Bucket()
    await seedSnapshot(bucket)

    const deleteEvent = { context: { cloudflare: { env: okEnv(bucket) } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    await callDelete(deleteEvent)

    const history = await bucket.get('profit/2026-06/8504/unko-1/0-3600/history.jsonl')
    const lines = (await history!.text()).trim().split('\n').map(l => JSON.parse(l))
    expect(lines.at(-1).deleted).toBe(true)
  })

  it('未保存のキーを削除してもエラーにせず冪等に成功扱いにする', async () => {
    const bucket = new FakeR2Bucket()
    const deleteEvent = { context: { cloudflare: { env: okEnv(bucket) } }, _query: { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' } }
    const result = await callDelete(deleteEvent) as { deleted: boolean }
    expect(result.deleted).toBe(true)
  })
})
