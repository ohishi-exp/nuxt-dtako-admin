/**
 * `PUT /api/y-time-template` の**認可** (Refs #988)。
 *
 * この口は `docs/plan-922-single-signin.md` §1 が D 段の実例として名指ししたもの —
 * JSDoc に「管理者専用画面 (要 JWT) で叩く想定」と書いてあるのに、**その JWT を
 * 検証するコードが無かった**。規約が doc にしか無く、コードが実装していない型。
 * A 段の `requireAuth` を足したので、
 *
 * - **陰性対照**: 未ログインは 401 で、**body を読む前に**落ちる
 *   (`readRawBody` が 1 度も呼ばれない。`requireAuth` を外すとこの it が落ちる)
 * - **陽性対照**: 認証が通れば**従来どおり R2 に put され、`{ok, key, size}` が返る**
 *
 * **読み口 (`y-time-template.get.ts`) にも #988 の 2 本目で同じ 2 行が入り、
 * `tests/server/y-time-template-get-route.test.ts` が同じ形で固定している** —
 * #995 当時の「この PR では触っていない・読み取り系は別 PR」はもう本当ではない。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock, readRawBodyMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  readRawBodyMock: vi.fn(),
}))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getQuery: (event: { _query?: Record<string, unknown> }) => event._query ?? {},
    getHeader: (event: { _contentType?: string }) => event._contentType,
    readRawBody: readRawBodyMock,
  }
})

import handler from '../../server/api/y-time-template.put'

interface PutResult { ok: boolean, key: string, size: number }
const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<PutResult>)(event)

const TEMPLATE_KEY = 'templates/kyoto-soft/base.xlsx'

class FakeR2 {
  puts: { key: string, bytes: number, contentType?: string }[] = []
  async put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) {
    this.puts.push({ key, bytes: value.byteLength, contentType: options?.httpMetadata?.contentType })
    return null
  }
}

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })

function eventWith(
  env: Record<string, unknown>,
  query: Record<string, unknown> = { key: TEMPLATE_KEY },
  contentType?: string,
) {
  return { context: { cloudflare: { env } }, _query: query, _contentType: contentType }
}

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
  readRawBodyMock.mockReset()
  readRawBodyMock.mockResolvedValue(Buffer.from('PKfake-xlsx'))
})

describe('PUT /api/y-time-template — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、body を 1 バイトも読まない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = new FakeR2()
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2 })))).rejects.toMatchObject({ statusCode: 401 })
    expect(readRawBodyMock).not.toHaveBeenCalled()
    // **R2 のテンプレは 1 つも上書きされない。**
    expect(r2.puts).toEqual([])
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ DTAKO_R2: new FakeR2() }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {}, _query: { key: TEMPLATE_KEY } })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_R2: new FakeR2() }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: new FakeR2() })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: new FakeR2() })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2(), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2(), NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2(), NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('PUT /api/y-time-template — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('★ 認証が通れば従来どおり R2 に put され `{ok, key, size}` が返る', async () => {
    const r2 = new FakeR2()
    const res = await call(eventWith(okEnv({ DTAKO_R2: r2 })))
    expect(res).toMatchObject({ ok: true, key: TEMPLATE_KEY })
    expect(r2.puts).toHaveLength(1)
    expect(r2.puts[0]!.key).toBe(TEMPLATE_KEY)
    expect(res.size).toBe(r2.puts[0]!.bytes)
  })

  it('content-type は header が有れば header、無ければ xlsx の既定', async () => {
    const r2 = new FakeR2()
    await call(eventWith(okEnv({ DTAKO_R2: r2 }), { key: TEMPLATE_KEY }, 'application/octet-stream'))
    expect(r2.puts[0]!.contentType).toBe('application/octet-stream')

    const r2b = new FakeR2()
    await call(eventWith(okEnv({ DTAKO_R2: r2b })))
    expect(r2b.puts[0]!.contentType).toContain('spreadsheetml.sheet')
  })

  it('key が無い / 文字列でない / templates/ 以外は従来どおり 400 (認証の後)', async () => {
    const env = okEnv({ DTAKO_R2: new FakeR2() })
    await expect(call(eventWith(env, {}))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { key: 7 }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { key: '' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { key: 'etc/other.xlsx' }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('DTAKO_R2 未設定なら 503 (ログイン後)', async () => {
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
  })

  it('body が空なら従来どおり 400', async () => {
    readRawBodyMock.mockResolvedValue(null)
    await expect(call(eventWith(okEnv({ DTAKO_R2: new FakeR2() })))).rejects.toMatchObject({ statusCode: 400 })
  })
})
