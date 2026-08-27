/**
 * `GET /api/y-time-template` (存在確認) の**認可** (Refs #988)。
 *
 * **書き口 (`y-time-template.put.ts`) は #988 の 1 本目で塞いだのに、読み口である
 * ここは残っていた。**返るのは「存在するか」だけだが、`size` / `etag` / `uploaded` は
 * テンプレの差し替えを外から観測できる情報で、`templates/` 配下を総当たりすれば
 * 配置も判る。`docs/plan-922-single-signin.md` §1 の D 段。
 *
 * - **陰性対照**: 未ログインは 401 で、**R2 を 1 度も head しない**
 * - **陽性対照**: 認証が通れば従来どおり `{exists:true,...}` / `{exists:false}`
 *   (**404 ではなく 200 + flag** という契約もそのまま)
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
  }
})

import handler from '../../server/api/y-time-template.get'

type HeadResult =
  | { exists: false, key: string }
  | { exists: true, key: string, size: number, etag: string, uploaded: string }
const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<HeadResult>)(event)

const KEY = 'templates/kyoto-soft/base.xlsx'

function r2With(heads: Record<string, { size: number, etag: string, uploaded: Date | string }>) {
  return { head: vi.fn(async (key: string) => heads[key] ?? null) }
}

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })

function eventWith(env: Record<string, unknown>, query: Record<string, unknown> = { key: KEY }) {
  return { context: { cloudflare: { env } }, _query: query }
}

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
})

describe('GET /api/y-time-template — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 を 1 度も head しない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = r2With({ [KEY]: { size: 1, etag: 'e', uploaded: new Date() } })
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2 })))).rejects.toMatchObject({ statusCode: 401 })
    expect(r2.head).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ DTAKO_R2: r2With({}) }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {}, _query: { key: KEY } })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_R2: r2With({}) }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: r2With({}) })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: r2With({}) })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: r2With({}), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: r2With({}), NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: r2With({}), NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('GET /api/y-time-template — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('★ 認証が通れば従来どおり `{exists:true, size, etag, uploaded}` を返す', async () => {
    const r2 = r2With({ [KEY]: { size: 4096, etag: 'abc', uploaded: new Date('2026-08-01T00:00:00Z') } })
    const res = await call(eventWith(okEnv({ DTAKO_R2: r2 })))
    expect(res).toEqual({
      exists: true, key: KEY, size: 4096, etag: 'abc', uploaded: '2026-08-01T00:00:00.000Z',
    })
    expect(r2.head).toHaveBeenCalledWith(KEY)
  })

  it('uploaded が文字列で来てもそのまま返す', async () => {
    const r2 = r2With({ [KEY]: { size: 1, etag: 'e', uploaded: '2026-08-02T00:00:00.000Z' } })
    const res = await call(eventWith(okEnv({ DTAKO_R2: r2 })))
    expect(res).toMatchObject({ uploaded: '2026-08-02T00:00:00.000Z' })
  })

  it('★ 未配置は 404 ではなく 200 + `{exists:false}` (契約は変えていない)', async () => {
    const res = await call(eventWith(okEnv({ DTAKO_R2: r2With({}) })))
    expect(res).toEqual({ exists: false, key: KEY })
  })

  it('key が無い / 文字列でない / templates/ 以外は従来どおり 400 (認証の後)', async () => {
    const env = okEnv({ DTAKO_R2: r2With({}) })
    await expect(call(eventWith(env, {}))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { key: 7 }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { key: '' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { key: 'vehicle-settings/4437/x.json' }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('DTAKO_R2 未設定なら 503 (ログイン後。secret の 503 と文言で分ける)', async () => {
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
  })
})
