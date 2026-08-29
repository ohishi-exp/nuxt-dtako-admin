import { beforeEach, describe, it, expect, vi } from 'vitest'

import getHandler from '../../server/api/profit/snapshot.get'
import { profitR2Paths, profitVersionTimestamp } from '../../app/utils/profit-r2'
import { putVersionedProfit, type R2BucketLite, type R2ObjectLite } from '../../server/utils/profit-r2-io'

const callGet = (event: unknown) => (getHandler as unknown as (e: unknown) => Promise<unknown>)(event)

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin' })
})

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

/**
 * **既定でログイン済みの event。** `requireAuth` (Refs #988) が読む
 * `INTERNAL_SHARED_SECRET` を env に足しておく — 認可そのものは
 * 「認可 (Refs #988)」の describe で測る。`env` に同名を渡せば上書きできる。
 */
function eventWith(env: Record<string, unknown>, query: Record<string, string> = {}) {
  return { context: { cloudflare: { env: { INTERNAL_SHARED_SECRET: 'secret', ...env } } }, _query: query }
}

const FULL_QUERY = { ym: '2026-06', vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' }

describe('GET /api/profit/snapshot', () => {
  it('PROFIT_R2 未設定なら 503 (ログイン後)', async () => {
    await expect(callGet(eventWith({}, FULL_QUERY))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('PROFIT_R2'),
    })
  })

  it('クエリパラメータが欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(callGet(eventWith({ PROFIT_R2: bucket }, { ym: '2026-06' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym が欠けていれば 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(callGet(eventWith({ PROFIT_R2: bucket }, { vehicle: '8504', unkoNo: 'unko-1', segmentId: '0-3600' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('未保存なら 404', async () => {
    const bucket = new FakeR2Bucket()
    await expect(callGet(eventWith({ PROFIT_R2: bucket }, FULL_QUERY))).rejects.toMatchObject({ statusCode: 404 })
  })

  it('保存済みなら latest の内容を返す', async () => {
    const bucket = new FakeR2Bucket()
    await seedSnapshot(bucket)

    const result = await callGet(eventWith({ PROFIT_R2: bucket }, FULL_QUERY)) as { confirmedAmount: number }
    expect(result.confirmedAmount).toBe(65000)
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
/**
 * **`requireAuth` に渡った引数だけを見る呼び出し。** この event の R2 は空なので
 * 本文が無く 404 になるが、見たいのは auth に渡った値なので握り潰す
 * (**404 になること自体は上の describe が固定している**)。
 */
const callForAuthArgs = (event: unknown) => callGet(event).catch(() => null)

describe('GET /api/profit/snapshot — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 を 1 回も叩かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const bucket = new FakeR2Bucket()
    await seedSnapshot(bucket)
    const getSpy = vi.spyOn(bucket, 'get')
    await expect(callGet(eventWith({ PROFIT_R2: bucket }, FULL_QUERY))).rejects.toMatchObject({ statusCode: 401 })
    expect(getSpy).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(callGet({ context: { cloudflare: { env: { PROFIT_R2: new FakeR2Bucket() } } }, _query: FULL_QUERY }))
      .rejects.toMatchObject({ statusCode: 503, statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET') })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(callGet({ context: {}, _query: FULL_QUERY })).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await callForAuthArgs(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, PROFIT_R2: new FakeR2Bucket() }, FULL_QUERY))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(callGet(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, PROFIT_R2: new FakeR2Bucket() }, FULL_QUERY)))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(callGet(eventWith({ INTERNAL_SHARED_SECRET: 123, PROFIT_R2: new FakeR2Bucket() }, FULL_QUERY)))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' }, FULL_QUERY))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: '' }, FULL_QUERY))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: 7 }, FULL_QUERY))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  it('★ 陽性対照: 認証が通れば従来どおり latest の本文が返る', async () => {
    const bucket = new FakeR2Bucket()
    await seedSnapshot(bucket)
    const result = await callGet(eventWith({ PROFIT_R2: bucket }, FULL_QUERY)) as { confirmedAmount: number }
    expect(result.confirmedAmount).toBe(65000)
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
  })
})
