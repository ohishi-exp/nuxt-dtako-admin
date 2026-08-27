/**
 * `GET /api/kyuyo-master/companies` の**認可** (Refs #988)。
 *
 * この口は `docs/plan-922-single-signin.md` §1 の D 段 (Nitro 側の認可が 1 つも無く、
 * **Cloudflare Access だけが前段**) に居た。**更新の口 (`refresh.post` /
 * `refresh-full.post`) は browser JWT を上流に渡して上流が弾く形なのに、
 * 読み口だけが素通しだった**という食い違いを塞ぐ。
 *
 * - **陰性対照**: 未ログインは 401 で、**D1 を 1 度も引かない**
 *   (`requireAuth` の行を消すとこの it が落ちる)
 * - **陽性対照**: 認証が通れば従来どおり `{ companies }` が返り、
 *   migration 未適用の 503 もそのまま
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

import handler from '../../server/api/kyuyo-master/companies.get'

interface CompaniesResult {
  companies: { company: string, name: string, years: number[], updated_at: string }[]
}
const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<CompaniesResult>)(event)

const ROWS = [
  { company: '01', name: '大石運輸', years: '[2025,2026]', updated_at: '2026-08-01T00:00:00Z' },
  { company: '02', name: '一番星', years: 'broken-json', updated_at: '2026-08-02T00:00:00Z' },
]

/** `listKyuyoCompanies` は実物を通す (mock しない) — 読めることまで陽性対照にする。 */
function dbWith(rows: typeof ROWS | Error) {
  const all = vi.fn(async () => {
    if (rows instanceof Error) throw rows
    return { results: rows }
  })
  return { prepare: vi.fn(() => ({ all })), _all: all }
}

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })
const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
})

describe('GET /api/kyuyo-master/companies — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、D1 を 1 度も引かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const db = dbWith(ROWS)
    await expect(call(eventWith(okEnv({ DTAKO_DB: db })))).rejects.toMatchObject({ statusCode: 401 })
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ DTAKO_DB: dbWith(ROWS) }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {} })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_DB: dbWith([]) }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_DB: dbWith([]) })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_DB: dbWith([]) })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ DTAKO_DB: dbWith([]), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_DB: dbWith([]), NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_DB: dbWith([]), NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('GET /api/kyuyo-master/companies — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('★ 認証が通れば従来どおり `{ companies }` が company 昇順で返る', async () => {
    const db = dbWith(ROWS)
    const res = await call(eventWith(okEnv({ DTAKO_DB: db })))
    expect(res.companies).toEqual([
      { company: '01', name: '大石運輸', years: [2025, 2026], updated_at: '2026-08-01T00:00:00Z' },
      // 壊れた years JSON は空配列 (フル更新で直る) — 認証を足しても挙動は変わらない
      { company: '02', name: '一番星', years: [], updated_at: '2026-08-02T00:00:00Z' },
    ])
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('FROM kyuyo_companies'))
  })

  it('DTAKO_DB 未設定なら 503 (ログイン後。secret の 503 と文言で分ける)', async () => {
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_DB'),
    })
    expect(requireAuthMock).toHaveBeenCalled()
  })

  it('migration 0005 未適用 (no such table) は 503 + 手順つき loud fail', async () => {
    await expect(call(eventWith(okEnv({ DTAKO_DB: dbWith(new Error('no such table: kyuyo_companies')) }))))
      .rejects.toMatchObject({
        statusCode: 503,
        statusMessage: expect.stringContaining('migration 0005'),
      })
  })

  it('Error でない throw も文字列化して残す (黙って空にしない)', async () => {
    const db = { prepare: vi.fn(() => ({ all: async () => { throw 'plain string' } })) }
    await expect(call(eventWith(okEnv({ DTAKO_DB: db })))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('plain string'),
    })
  })
})
