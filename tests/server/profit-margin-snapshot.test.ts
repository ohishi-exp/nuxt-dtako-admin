import { beforeEach, describe, it, expect, vi } from 'vitest'

import handler from '../../server/api/profit/margin-snapshot.get'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'
import { emptyMarginTotals } from '../../app/utils/margin'
import { MARGIN_SUMMARY_SCHEMA_VERSION, type MarginSummarySnapshot } from '../../app/utils/margin-r2'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<MarginSummarySnapshot>)(event)

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

const DIR_2607 = 'profit/2026-07/margin-summary'

function snapshotJson(ym: string, overrides: Partial<ReturnType<typeof emptyMarginTotals>> = {}) {
  return JSON.stringify({
    schemaVersion: MARGIN_SUMMARY_SCHEMA_VERSION,
    ym,
    codeVersion: 'v0.0.524',
    savedAt: '2026-08-24T10:01:53.000Z',
    totals: { ...emptyMarginTotals(), ...overrides },
    cache: { ym, savedAt: '2026-08-24T10:01:53.000Z', operations: [], costs: [], uncovered: null, crossMonth: null },
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

describe('GET /api/profit/margin-snapshot', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    await expect(call(eventWith({}, { ym: '2026-07', version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('ym が無ければ 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym の形が違えば 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026/07', version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('version が無ければ 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('★ 版の名前の形が違えば 400 — R2 を 1 回も叩かない', async () => {
    const bucket = new FakeR2Bucket()
    for (const version of [
      'latest',
      'v-20260824T190153.json',
      '../../secret',
      'v-2026-08-24T19:01:53',
      'v-20260824T19015',
    ]) {
      await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version })))
        .rejects.toMatchObject({ statusCode: 400 })
    }
    // **画面が持っている R2 のキーをそのまま鍵にしない**ので、弾いた時点で読みに行かない。
    expect(bucket.gotKeys).toEqual([])
  })

  it('★ キーは ym と版の名前から marginR2Paths で組む (クエリのキーで get しない)', async () => {
    const bucket = new FakeR2Bucket()
    await bucket.put(`${DIR_2607}/v-20260824T190153.json`, snapshotJson('2026-07', { marginYen: 4467597 }))

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260824T190153' }))
    expect(bucket.gotKeys).toEqual([`${DIR_2607}/v-20260824T190153.json`])
    expect(result.ym).toBe('2026-07')
    expect(result.schemaVersion).toBe(MARGIN_SUMMARY_SCHEMA_VERSION)
    // **保存済みの JSON をそのまま返す** (数字を 1 円も作らない・変えない)。
    expect(result.totals.marginYen).toBe(4467597)
    expect(result.codeVersion).toBe('v0.0.524')
    expect(result.savedAt).toBe('2026-08-24T10:01:53.000Z')
    expect(result.cache.ym).toBe('2026-07')
  })

  it('★ 別の月の同じ名前の版は読まない (prefix が月ごと)', async () => {
    const bucket = new FakeR2Bucket()
    await bucket.put('profit/2026-06/margin-summary/v-20260824T190153.json', snapshotJson('2026-06'))

    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(bucket.gotKeys).toEqual([`${DIR_2607}/v-20260824T190153.json`])
  })

  it('★ 同居している別系統 (検証スナップショット) には届かない', async () => {
    // `PROFIT_R2` には `profit/{ym}/{車輌CD}/{運行NO}/{segmentId}/latest.json` (突合 2 系統目)
    // が同居している。**キーを受けずに `ym` + 版の名前から組む**ので、`version` に何を入れても
    // `profit/{ym}/margin-summary/v-*.json` 以外は組み上がらない。
    const bucket = new FakeR2Bucket()
    await bucket.put('profit/2026-07/0040/20260703-0040-1/seg1/latest.json', '{"secret":1}')
    for (const version of [
      '../0040/20260703-0040-1/seg1/latest',
      'v-20260824T190153/../../../0040/20260703-0040-1/seg1/latest',
      '..%2F..%2Fsecret',
    ]) {
      await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version })))
        .rejects.toMatchObject({ statusCode: 400 })
    }
    // 通った要求も **margin-summary の枝しか組まない**。
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260703T000000' })))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(bucket.gotKeys).toEqual([`${DIR_2607}/v-20260703T000000.json`])
    expect(bucket.gotKeys.every(k => k.startsWith(`${DIR_2607}/`))).toBe(true)
  })

  it('★ 一覧に出ていても本文が無ければ 404 (空の版に倒さない)', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260101T000000' })))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: '版 v-20260101T000000 の本文を R2 から読めませんでした' })
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
describe('GET /api/profit/margin-snapshot — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 を 1 回も叩かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const bucket = new FakeR2Bucket()
    bucket.store.set(`${DIR_2607}/v-20260824T190153.json`, snapshotJson('2026-07'))
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260824T190153' }))).rejects.toMatchObject({ statusCode: 401 })
    expect(bucket.gotKeys).toEqual([])
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call({ context: { cloudflare: { env: { PROFIT_R2: new FakeR2Bucket() } } }, _query: { ym: '2026-07', version: 'v-20260824T190153' } }))
      .rejects.toMatchObject({ statusCode: 503, statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET') })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {}, _query: { ym: '2026-07', version: 'v-20260824T190153' } })).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await callForAuthArgs(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, PROFIT_R2: new FakeR2Bucket() }, { ym: '2026-07', version: 'v-20260824T190153' }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, PROFIT_R2: new FakeR2Bucket() }, { ym: '2026-07', version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, PROFIT_R2: new FakeR2Bucket() }, { ym: '2026-07', version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' }, { ym: '2026-07', version: 'v-20260824T190153' }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: '' }, { ym: '2026-07', version: 'v-20260824T190153' }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await callForAuthArgs(eventWith({ PROFIT_R2: new FakeR2Bucket(), NUXT_PUBLIC_AUTH_WORKER_URL: 7 }, { ym: '2026-07', version: 'v-20260824T190153' }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  it('★ 陽性対照: 認証が通れば従来どおり版の本文が返る', async () => {
    const bucket = new FakeR2Bucket()
    bucket.store.set(`${DIR_2607}/v-20260824T190153.json`, snapshotJson('2026-07'))
    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260824T190153' }))
    expect(result.ym).toBe('2026-07')
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
  })
})
