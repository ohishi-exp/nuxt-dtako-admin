/**
 * `GET /api/vehicle-settings/object` の**認可** (Refs #988)。
 *
 * この口は `docs/plan-922-single-signin.md` §1 の D 段 (Nitro 側の認可が 1 つも無く、
 * **Cloudflare Access だけが前段**) に居た。
 *
 * **key prefix の強制は認可ではない** — 「別用途のオブジェクトを引かせない」ための
 * 制限で、**呼び出し元が誰かは一切見ていない**。この取り違えを固定しないよう、
 * 「prefix 検査は通るが未ログイン」を 401 として明示的に固定する。
 *
 * - **陰性対照**: 未ログインは 401 で、**query を読む前に**落ちる (R2 に触らない)
 * - **陽性対照**: 認証が通れば従来どおり dump JSON がそのまま返る
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock, setResponseHeaderMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  setResponseHeaderMock: vi.fn(),
}))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getQuery: (event: { _query?: Record<string, unknown> }) => event._query ?? {},
    setResponseHeader: setResponseHeaderMock,
  }
})

import handler from '../../server/api/vehicle-settings/object.get'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<string>)(event)

const KEY = 'vehicle-settings/4437/20260514_093253-0-0-4437.json'
const BODY = '{"machine_id":"M1"}'

function r2With(objects: Record<string, { text: string, contentType?: string }>) {
  return {
    get: vi.fn(async (key: string) =>
      key in objects
        ? {
            text: async () => objects[key]!.text,
            httpMetadata: objects[key]!.contentType ? { contentType: objects[key]!.contentType } : undefined,
          }
        : null,
    ),
  }
}

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })

function eventWith(env: Record<string, unknown>, query: Record<string, unknown> = { key: KEY }) {
  return { context: { cloudflare: { env } }, _query: query }
}

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
  setResponseHeaderMock.mockReset()
})

describe('GET /api/vehicle-settings/object — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 を 1 度も触らない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = r2With({ [KEY]: { text: BODY } })
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2 })))).rejects.toMatchObject({ statusCode: 401 })
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('★ key prefix が正しくても未ログインなら 401 (prefix 検査は認可ではない)', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2With({ [KEY]: { text: BODY } }) }))))
      .rejects.toMatchObject({ statusCode: 401 })
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
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_R2: r2With({ [KEY]: { text: BODY } }) }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: r2With({}) })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: r2With({}) })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    const r2 = r2With({ [KEY]: { text: BODY } })
    await call(eventWith(okEnv({ DTAKO_R2: r2, NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: r2, NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: r2, NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('GET /api/vehicle-settings/object — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('★ 認証が通れば従来どおり dump JSON をそのまま返す', async () => {
    const r2 = r2With({ [KEY]: { text: BODY } })
    const res = await call(eventWith(okEnv({ DTAKO_R2: r2 })))
    expect(res).toBe(BODY)
    expect(r2.get).toHaveBeenCalledWith(KEY)
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'content-type', 'application/json; charset=utf-8',
    )
  })

  it('R2 の httpMetadata.contentType があればそれを使う', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: r2With({ [KEY]: { text: BODY, contentType: 'application/json' } }) })))
    expect(setResponseHeaderMock).toHaveBeenCalledWith(expect.anything(), 'content-type', 'application/json')
  })

  it('key が無い / 文字列でない / prefix 外 / ".." 入り / .json でないは 400 (認証の後)', async () => {
    const env = okEnv({ DTAKO_R2: r2With({}) })
    for (const bad of [{}, { key: 7 }, { key: '' }, { key: 'templates/base.xlsx' },
      { key: 'vehicle-settings/../templates/base.json' }, { key: 'vehicle-settings/4437/x.cfg' }]) {
      await expect(call(eventWith(env, bad))).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(requireAuthMock).toHaveBeenCalledTimes(6)
  })

  it('DTAKO_R2 未設定なら 503 (ログイン後。secret の 503 と文言で分ける)', async () => {
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
  })

  it('オブジェクトが無ければ 404', async () => {
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2With({}) })))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: expect.stringContaining(KEY),
    })
  })
})
