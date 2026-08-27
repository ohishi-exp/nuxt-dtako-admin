/**
 * `GET /api/net780/by-operation` の**認可**と、既存の分岐 (Refs #988)。
 *
 * この口は **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1 の D 段)。**運行NO を 22 桁総当たりすれば
 * 運行の生データ ZIP が誰でも落とせる**形だったので、書き込み側 (#995) と同じ
 * A 段の `requireAuth` を掛ける。
 *
 * - **陰性対照**: 未ログインは 401 で、**D1 も R2 も 1 回も叩かない**
 *   (`requireAuth` を外すとこの it が落ちる)
 * - **陽性対照**: 認証が通れば**従来どおり ZIP のバイトがそのまま返る**
 *
 * JSDoc の「theearth セッションは不要」は**上流の話**で、こちら側の認可が要らない
 * 理由ではない — それを取り違えたまま塞がずに来た。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getQuery: (event: { _query?: Record<string, unknown> }) => event._query ?? {},
    setResponseHeader: (event: { _headers: Record<string, string> }, name: string, value: string) => {
      event._headers[name] = value
    },
  }
})

import handler from '../../server/api/net780/by-operation.get'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<Buffer>)(event)

const OP = '2607141234560000001726'
const R2_KEY = 'net780/2026-07/8504/op.zip'

/** D1 の 1 行だけを返す最小のスタブ。`bind()` に渡った値も残す。 */
class FakeD1 {
  bound: unknown[] = []
  sql = ''
  prepared = 0
  constructor(private row: { r2_key: string, operation_count: number | null } | null) {}
  prepare(sql: string) {
    this.prepared++
    this.sql = sql
    return {
      bind: (...values: unknown[]) => {
        this.bound = values
        return { first: async () => this.row }
      },
    }
  }
}

class FakeR2 {
  gotKeys: string[] = []
  constructor(private entry: { bytes: Uint8Array, contentType?: string } | null) {}
  async get(key: string) {
    this.gotKeys.push(key)
    if (!this.entry) return null
    const { bytes, contentType } = this.entry
    return {
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      httpMetadata: contentType === undefined ? undefined : { contentType },
    }
  }
}

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02])

/**
 * **既定でログイン済みの event。** `requireAuth` (Refs #988) が読む
 * `INTERNAL_SHARED_SECRET` を env に足しておく — 認可そのものは
 * 「認可」の describe で測る。`env` に同名を渡せば上書きできる。
 */
function eventWith(env: Record<string, unknown>, query: Record<string, unknown> = { operationNo: OP }) {
  return {
    context: { cloudflare: { env: { INTERNAL_SHARED_SECRET: 'secret', ...env } } },
    _query: query,
    _headers: {} as Record<string, string>,
  }
}

function okEnv(extra: Record<string, unknown> = {}) {
  return {
    DTAKO_DB: new FakeD1({ r2_key: R2_KEY, operation_count: 1 }),
    DTAKO_R2: new FakeR2({ bytes: ZIP_BYTES, contentType: 'application/zip' }),
    ...extra,
  }
}

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
})

describe('GET /api/net780/by-operation — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、D1 も R2 も 1 回も叩かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const db = new FakeD1({ r2_key: R2_KEY, operation_count: 1 })
    const r2 = new FakeR2({ bytes: ZIP_BYTES })
    await expect(call(eventWith({ DTAKO_DB: db, DTAKO_R2: r2 }))).rejects.toMatchObject({ statusCode: 401 })
    // **生データは 1 バイトも出ない。**
    expect(db.prepared).toBe(0)
    expect(r2.gotKeys).toEqual([])
  })

  it('★ 未ログインなら運行NO の形すら見ない (401 が 400 に化けない)', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    // 22 桁でない = 従来なら 400 で落ちていた入力。**認証の方が先**なので 401 のまま。
    await expect(call(eventWith(okEnv(), { operationNo: 'abc' }))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    const env = { DTAKO_DB: new FakeD1(null), DTAKO_R2: new FakeR2(null) }
    await expect(call({ context: { cloudflare: { env } }, _query: { operationNo: OP }, _headers: {} }))
      .rejects.toMatchObject({ statusCode: 503, statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET') })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {}, _query: { operationNo: OP }, _headers: {} }))
      .rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, ...okEnv() }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, ...okEnv() })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, ...okEnv() })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('GET /api/net780/by-operation — 既存の分岐 (塞いだだけで挙動を変えていない)', () => {
  it.each([
    ['22 桁でない', 'abc'],
    ['21 桁', '260714123456000000172'],
    ['23 桁', '26071412345600000017266'],
    ['数値でない文字を含む', '26071412345600000017a6'],
  ])('operationNo が %s なら 400', async (_label, operationNo) => {
    await expect(call(eventWith(okEnv(), { operationNo }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('operationNo が文字列でなければ 400', async () => {
    await expect(call(eventWith(okEnv(), { operationNo: 2607141234560000001726 })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it.each([
    ['DTAKO_DB が無い', { DTAKO_R2: new FakeR2(null) }],
    ['DTAKO_R2 が無い', { DTAKO_DB: new FakeD1(null) }],
    ['どちらも無い', {}],
  ])('%s なら 503 (ログイン後)', async (_label, env) => {
    await expect(call(eventWith(env))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_DB'),
    })
  })

  it('カタログに行が無ければ 404 (R2 は叩かない)', async () => {
    const r2 = new FakeR2({ bytes: ZIP_BYTES })
    await expect(call(eventWith({ DTAKO_DB: new FakeD1(null), DTAKO_R2: r2 })))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: expect.stringContaining('アーカイブされていません') })
    expect(r2.gotKeys).toEqual([])
  })

  it.each([
    ['複数運行がまとまっている', 2],
    ['旧データで不明 (null)', null],
  ])('operation_count が %s なら 404 (無理に返さない)', async (_label, operationCount) => {
    const r2 = new FakeR2({ bytes: ZIP_BYTES })
    const db = new FakeD1({ r2_key: R2_KEY, operation_count: operationCount as number | null })
    await expect(call(eventWith({ DTAKO_DB: db, DTAKO_R2: r2 })))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: expect.stringContaining('安全に表示できません') })
    expect(r2.gotKeys).toEqual([])
  })

  it('カタログにはあるが R2 オブジェクトが無ければ 404', async () => {
    const db = new FakeD1({ r2_key: R2_KEY, operation_count: 1 })
    await expect(call(eventWith({ DTAKO_DB: db, DTAKO_R2: new FakeR2(null) })))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: expect.stringContaining('R2 オブジェクト') })
  })

  it('★ 陽性対照: 認証が通れば ZIP のバイトがそのまま返る (JSON 化しない)', async () => {
    const db = new FakeD1({ r2_key: R2_KEY, operation_count: 1 })
    const r2 = new FakeR2({ bytes: ZIP_BYTES, contentType: 'application/zip' })
    const event = eventWith({ DTAKO_DB: db, DTAKO_R2: r2 })
    const result = await call(event)
    // **`{}` (2 バイト) にならない** — 2026-07-19 の実害と同じ形の固定。
    expect(Buffer.isBuffer(result)).toBe(true)
    expect([...result]).toEqual([...ZIP_BYTES])
    expect(event._headers['content-type']).toBe('application/zip')
    expect(r2.gotKeys).toEqual([R2_KEY])
    expect(db.bound).toEqual([OP])
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
  })

  it('httpMetadata が無ければ content-type は application/zip に倒す', async () => {
    const db = new FakeD1({ r2_key: R2_KEY, operation_count: 1 })
    const event = eventWith({ DTAKO_DB: db, DTAKO_R2: new FakeR2({ bytes: ZIP_BYTES }) })
    await call(event)
    expect(event._headers['content-type']).toBe('application/zip')
  })

  it('httpMetadata に contentType が有ればそれを使う', async () => {
    const db = new FakeD1({ r2_key: R2_KEY, operation_count: 1 })
    const event = eventWith({ DTAKO_DB: db, DTAKO_R2: new FakeR2({ bytes: ZIP_BYTES, contentType: 'application/octet-stream' }) })
    await call(event)
    expect(event._headers['content-type']).toBe('application/octet-stream')
  })
})
