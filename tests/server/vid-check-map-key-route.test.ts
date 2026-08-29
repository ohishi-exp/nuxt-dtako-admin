/**
 * `GET /api/vid-check/map-key` の**認可** (Refs #988)。
 *
 * **D 段の中で唯一「秘密そのものを平文で返す」口**だった
 * (`docs/plan-922-single-signin.md` §1)。前段は Cloudflare Access だけで、
 * 鍵に掛かっているのは Google 側の HTTP referrer 制限のみ。
 *
 * **「referrer 制限があるから無認証でよい」は成り立たない** — `Referer` は
 * 呼び出し元が自由に名乗れるヘッダで、ブラウザの外 (curl / server-side fetch) からは
 * 任意の値を付けられる。referrer 制限は課金の保険であって認証ではない。
 * **このテストは「口の側で相手を見る」ことだけを固定する** — referrer の検証は
 * この repo には無く、足してもいない (名乗れるものを検証しても意味がないため)。
 *
 * - **陰性対照**: 未ログインは 401 で、**Secrets Store の `.get()` を 1 度も呼ばない**
 *   (= 鍵を取り出しさえしない。`requireAuth` の行を消すとこの it が落ちる)
 * - **陽性対照**: 認証が通れば従来どおり `{ key }` が返り、
 *   miniflare の reject → `process.env` フォールバックもそのまま
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

import handler from '../../server/api/vid-check/map-key.get'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<{ key: string | null }>)(event)

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })
const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

const ORIGINAL_FALLBACK = process.env.NUXT_PUBLIC_GOOGLEMAP_KEY

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin' })
  delete process.env.NUXT_PUBLIC_GOOGLEMAP_KEY
})

afterEach(() => {
  if (ORIGINAL_FALLBACK === undefined) delete process.env.NUXT_PUBLIC_GOOGLEMAP_KEY
  else process.env.NUXT_PUBLIC_GOOGLEMAP_KEY = ORIGINAL_FALLBACK
})

describe('GET /api/vid-check/map-key — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、鍵の `.get()` を 1 度も呼ばない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const get = vi.fn(async () => 'AIza-secret')
    await expect(call(eventWith(okEnv({ GOOGLEMAP_KEY_SECRET: { get } })))).rejects.toMatchObject({ statusCode: 401 })
    expect(get).not.toHaveBeenCalled()
  })

  it('★ 未ログインなら `process.env` フォールバックの鍵も返さない', async () => {
    // **「binding が無い環境なら 401 を通り越して素の鍵が出る」を塞ぐ。**
    process.env.NUXT_PUBLIC_GOOGLEMAP_KEY = 'AIza-from-env'
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({ statusCode: 401 })
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ GOOGLEMAP_KEY_SECRET: 'AIza-plain' }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {} })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' } }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined } })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123 })))
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

describe('GET /api/vid-check/map-key — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('★ 認証が通れば Secrets Store binding の鍵をそのまま返す', async () => {
    const res = await call(eventWith(okEnv({ GOOGLEMAP_KEY_SECRET: { get: async () => 'AIza-from-store' } })))
    expect(res).toEqual({ key: 'AIza-from-store' })
  })

  it('binding が文字列 (dev の plain 変数) でもそのまま返す', async () => {
    expect(await call(eventWith(okEnv({ GOOGLEMAP_KEY_SECRET: 'AIza-plain' })))).toEqual({ key: 'AIza-plain' })
  })

  it('miniflare の `.get()` が reject したら process.env フォールバックへ落ちる', async () => {
    process.env.NUXT_PUBLIC_GOOGLEMAP_KEY = 'AIza-from-env'
    const res = await call(eventWith(okEnv({
      GOOGLEMAP_KEY_SECRET: { get: async () => { throw new Error('Secret "GOOGLEMAP_KEY_SECRET" not found') } },
    })))
    expect(res).toEqual({ key: 'AIza-from-env' })
  })

  it('`.get()` が reject して process.env も無ければ key: null (空文字ではない)', async () => {
    const res = await call(eventWith(okEnv({
      GOOGLEMAP_KEY_SECRET: { get: async () => { throw new Error('not found') } },
    })))
    expect(res).toEqual({ key: null })
  })

  it('`.get()` が undefined を返したら key: null', async () => {
    const res = await call(eventWith(okEnv({ GOOGLEMAP_KEY_SECRET: { get: async () => undefined as unknown as string } })))
    expect(res).toEqual({ key: null })
  })

  it('binding が無ければ process.env フォールバック / それも無ければ null', async () => {
    process.env.NUXT_PUBLIC_GOOGLEMAP_KEY = 'AIza-from-env'
    expect(await call(eventWith(okEnv()))).toEqual({ key: 'AIza-from-env' })

    process.env.NUXT_PUBLIC_GOOGLEMAP_KEY = ''
    expect(await call(eventWith(okEnv()))).toEqual({ key: null })

    delete process.env.NUXT_PUBLIC_GOOGLEMAP_KEY
    expect(await call(eventWith(okEnv()))).toEqual({ key: null })
  })
})
