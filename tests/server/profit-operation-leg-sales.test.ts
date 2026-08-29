import { beforeEach, describe, it, expect, vi } from 'vitest'

import handler from '../../server/api/profit/operation-leg-sales.get'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'
import type { OperationLegSalesR2 } from '../../app/utils/operation-leg-sales-r2'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<OperationLegSalesR2>)(event)

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
    getQuery: (event: { _query: Record<string, string> }) => event._query,
  }
})

class FakeR2Bucket implements R2BucketLite {
  store = new Map<string, string>()
  /** `get()` されたキー。**組み立てたキーが正しいこと**を固定するため。 */
  gotKeys: string[] = []

  async get(key: string) {
    this.gotKeys.push(key)
    const body = this.store.get(key)
    if (body === undefined) return null
    return { key, text: async () => body }
  }

  async head(key: string) {
    return this.store.has(key) ? {} : null
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    this.store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array))
    return {}
  }

  async delete(key: string) {
    this.store.delete(key)
    return {}
  }

  async list(options?: { prefix?: string, cursor?: string }) {
    const prefix = options?.prefix ?? ''
    const objects: R2ObjectLite[] = [...this.store.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key }))
    return { objects, truncated: false as const, cursor: undefined }
  }
}

const OP_A = '2607031000000000001109'
const LATEST_2607 = 'profit/2026-07/margin-summary/latest.json'
const SAVED_AT = '2026-08-24T10:01:53.000Z'

function snapshotJson(unkoNo: string) {
  return JSON.stringify({
    schemaVersion: 1,
    ym: '2026-07',
    codeVersion: 'v0.0.524',
    savedAt: SAVED_AT,
    totals: {},
    cache: {
      ym: '2026-07',
      savedAt: SAVED_AT,
      operations: [{
        unkoNo,
        date: '2026-07-03',
        legs: [{ seq: 1, customers: [{ code: '0012', name: '○○牧場', yen: 41250 }] }],
      }],
      costs: [],
    },
  })
}

/**
 * **既定でログイン済みの event。** `requireAuth` (Refs #988) が読む
 * `INTERNAL_SHARED_SECRET` を env に足しておく — 認可そのものは
 * 「認可 (Refs #988)」の describe で測る。`env` に同名を渡せば上書きできる。
 */
function eventWith(env: Record<string, unknown>, query: Record<string, string> = {}) {
  return { context: { cloudflare: { env: { INTERNAL_SHARED_SECRET: 'secret', ...env } } }, _query: query }
}

describe('GET /api/profit/operation-leg-sales', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    await expect(call(eventWith({}, { ym: '2026-07', unkoNo: OP_A })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it.each([['無い', {}], ['形が違う', { ym: '2026/07' }], ['月まで無い', { ym: '2026' }]])(
    'ym が %s なら 400',
    async (_label, extra) => {
      const bucket = new FakeR2Bucket()
      await expect(call(eventWith({ PROFIT_R2: bucket }, { unkoNo: OP_A, ...extra as Record<string, string> })))
        .rejects.toMatchObject({ statusCode: 400 })
    },
  )

  it('unkoNo が無ければ 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('★ 読むのは latest.json だけ (版の一覧を舐めない)', async () => {
    const bucket = new FakeR2Bucket()
    bucket.store.set(LATEST_2607, snapshotJson(OP_A))
    bucket.store.set('profit/2026-07/margin-summary/v-20260824T190153.json', snapshotJson(OP_A))
    await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', unkoNo: OP_A }))
    expect(bucket.gotKeys).toEqual([LATEST_2607])
  })

  it('★ 版の金額をそのまま返す (1 円も作らない。code は落とす)', async () => {
    const bucket = new FakeR2Bucket()
    bucket.store.set(LATEST_2607, snapshotJson(OP_A))
    expect(await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', unkoNo: OP_A }))).toEqual({
      status: 'ready',
      ym: '2026-07',
      savedAt: SAVED_AT,
      legs: [{ seq: 1, customers: [{ name: '○○牧場', yen: 41250 }], slipIds: [] }],
    })
  })

  it('★ その月に版が無いのは 404 ではなく no-version (理由を画面が言い分けるため)', async () => {
    const bucket = new FakeR2Bucket()
    expect(await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', unkoNo: OP_A })))
      .toEqual({ status: 'no-version', ym: '2026-07' })
  })

  it('★ 本文が JSON でなければ unreadable (投げない・0 円に倒さない)', async () => {
    const bucket = new FakeR2Bucket()
    bucket.store.set(LATEST_2607, 'これは JSON ではない')
    expect(await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', unkoNo: OP_A })))
      .toEqual({ status: 'unreadable', ym: '2026-07' })
  })

  it('版にこの運行が居なければ not-aggregated', async () => {
    const bucket = new FakeR2Bucket()
    bucket.store.set(LATEST_2607, snapshotJson('2607111000000000001109'))
    expect(await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', unkoNo: OP_A })))
      .toEqual({ status: 'not-aggregated', ym: '2026-07', savedAt: SAVED_AT })
  })

  it('★ 月ごとにキーを組み直す (別の月の版を返さない)', async () => {
    const bucket = new FakeR2Bucket()
    bucket.store.set('profit/2026-06/margin-summary/latest.json', snapshotJson(OP_A))
    const r = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-06', unkoNo: OP_A }))
    expect(bucket.gotKeys).toEqual(['profit/2026-06/margin-summary/latest.json'])
    expect(r.ym).toBe('2026-06')
  })
})

/**
 * **`requireAuth` に渡った引数だけを見る呼び出し。** この event の R2 は空なので
 * 応答そのものは「無い」側に落ちるが、見たいのは auth に渡った値なので握り潰す
 * (**「無い」ときの挙動は上の describe が固定している**)。
 */
const callForAuthArgs = (event: unknown) => Promise.resolve(call(event)).catch(() => null)

/**
 * **認可** (Refs #988)。この読み口は **Cloudflare Access だけが前段**で、Nitro 側に
 * 認可が 1 つも無かった (`docs/plan-922-single-signin.md` §1 の D 段)。書き込み側
 * (`margin-summary.post.ts`) は #995 で塞いだので、同じ版を読む側にも同じ A 段の
 * `requireAuth` を掛ける。
 *
 * - **陰性対照**: 未ログインは 401 で、**R2 を 1 回も叩かない**
 *   (`requireAuth` を外すとこの it が落ちる)
 * - **陽性対照**: 認証が通れば**従来どおりの応答が返る** (塞いだだけで使えなくしていない)
 */
describe('GET /api/profit/operation-leg-sales — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 を 1 回も叩かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const bucket = new FakeR2Bucket()
    bucket.store.set(LATEST_2607, snapshotJson(OP_A))
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', unkoNo: OP_A }))).rejects.toMatchObject({ statusCode: 401 })
    expect(bucket.gotKeys).toEqual([])
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call({ context: { cloudflare: { env: { PROFIT_R2: new FakeR2Bucket() } } }, _query: { ym: '2026-07', unkoNo: OP_A } }))
      .rejects.toMatchObject({ statusCode: 503, statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET') })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {}, _query: { ym: '2026-07', unkoNo: OP_A } })).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await callForAuthArgs(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, PROFIT_R2: new FakeR2Bucket() }, { ym: '2026-07', unkoNo: OP_A }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, PROFIT_R2: new FakeR2Bucket() }, { ym: '2026-07', unkoNo: OP_A })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, PROFIT_R2: new FakeR2Bucket() }, { ym: '2026-07', unkoNo: OP_A })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' }, { ym: '2026-07', unkoNo: OP_A }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: '' }, { ym: '2026-07', unkoNo: OP_A }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: 7 }, { ym: '2026-07', unkoNo: OP_A }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  it('★ 陽性対照: 認証が通れば従来どおり便が返る (401 を no-version に混ぜない)', async () => {
    const bucket = new FakeR2Bucket()
    bucket.store.set(LATEST_2607, snapshotJson(OP_A))
    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', unkoNo: OP_A }))
    expect(result.status).toBe('ready')
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
  })
})
