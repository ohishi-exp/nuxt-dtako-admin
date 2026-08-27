/**
 * `POST /api/y-time-export` の**認可** (Refs #988)。
 *
 * **ここは D 段 (認可ゼロ) ではなく B 段だった** — `alcProxyFetch` が browser JWT を
 * 転送し、上流 auth-worker `/alc-proxy` が token 不在を 401 にする。それでも A 段へ
 * 上げるのは、**B 段の防御が上流の実装依存**でこの repo からは保証できないため
 * (`docs/plan-922-single-signin.md` §1 が `/api/ichiban/**` の項で書いている性質と同じ)。
 * 返る xlsx は**乗務員 1 人の日別 拘束/運転/休憩の実データ**。
 *
 * - **陰性対照**: 未ログインは 401 で、**body を読む前・上流を叩く前**に落ちる
 * - **陽性対照**: 認証が通れば従来どおり xlsx bytes が返り、
 *   missing-dates / warnings ヘッダも従来どおり載る
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock, alcProxyFetchMock, readBodyMock, setResponseHeaderMock, writeYTimeRowsMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  alcProxyFetchMock: vi.fn(),
  readBodyMock: vi.fn(),
  setResponseHeaderMock: vi.fn(),
  writeYTimeRowsMock: vi.fn(),
}))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('../../server/utils/alc-proxy', () => ({ alcProxyFetch: alcProxyFetchMock }))
vi.mock('~/utils/y-time-xlsx', () => ({
  writeYTimeRows: writeYTimeRowsMock,
  buildFilename: (cd: string, from: string, to: string) => `y-time_${cd}_${from}_${to}.xlsx`,
}))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    readBody: readBodyMock,
    setResponseHeader: setResponseHeaderMock,
  }
})

import handler from '../../server/api/y-time-export.post'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<Uint8Array>)(event)

const BODY = { driver_cd: '0001', from: '2026-07-01', to: '2026-07-31', template_key: 'templates/kyoto-soft/base.xlsx' }
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

function r2With(objects: Record<string, ArrayBuffer>) {
  return {
    get: vi.fn(async (key: string) => (key in objects ? { arrayBuffer: async () => objects[key]! } : null)),
  }
}
const templateR2 = () => r2With({ [BODY.template_key]: new ArrayBuffer(8) })

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })
const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
  readBodyMock.mockReset()
  readBodyMock.mockResolvedValue({ ...BODY })
  alcProxyFetchMock.mockReset()
  alcProxyFetchMock.mockResolvedValue({
    ok: true, status: 200, statusText: 'OK', json: async () => ({ rows: [], warnings: [] }),
  })
  setResponseHeaderMock.mockReset()
  writeYTimeRowsMock.mockReset()
  writeYTimeRowsMock.mockResolvedValue({ bytes: XLSX_BYTES, missingDates: [] })
})

describe('POST /api/y-time-export — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、body も読まず上流も叩かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = templateR2()
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2 })))).rejects.toMatchObject({ statusCode: 401 })
    expect(readBodyMock).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ DTAKO_R2: templateR2() }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {} })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_R2: templateR2() }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: templateR2() })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: templateR2() })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: templateR2(), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: templateR2(), NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: templateR2(), NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('POST /api/y-time-export — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('★ 認証が通れば従来どおり xlsx bytes を返し、filename も従来どおり', async () => {
    const r2 = templateR2()
    const res = await call(eventWith(okEnv({ DTAKO_R2: r2 })))
    expect(res).toBe(XLSX_BYTES)
    expect(alcProxyFetchMock).toHaveBeenCalledWith(expect.anything(), {
      path: '/api/dtako/y-time-export',
      query: { driver_cd: '0001', from: '2026-07-01', to: '2026-07-31' },
    })
    expect(r2.get).toHaveBeenCalledWith(BODY.template_key)
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'content-disposition',
      'attachment; filename="y-time_0001_2026-07-01_2026-07-31.xlsx"',
    )
  })

  it('欠落必須項目 / templates/ 以外の template_key は 400 (認証の後)', async () => {
    const env = okEnv({ DTAKO_R2: templateR2() })
    for (const bad of [null, {}, { ...BODY, driver_cd: '' }, { ...BODY, from: '' },
      { ...BODY, to: '' }, { ...BODY, template_key: '' }]) {
      readBodyMock.mockResolvedValue(bad)
      await expect(call(eventWith(env))).rejects.toMatchObject({ statusCode: 400 })
    }
    readBodyMock.mockResolvedValue({ ...BODY, template_key: 'vehicle-settings/4437/x.json' })
    await expect(call(eventWith(env))).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining('templates/'),
    })
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('上流エラーはその status と本文で loud fail する (本文が読めなければ statusText)', async () => {
    alcProxyFetchMock.mockResolvedValue({
      ok: false, status: 502, statusText: 'Bad Gateway', text: async () => 'upstream down',
    })
    await expect(call(eventWith(okEnv({ DTAKO_R2: templateR2() })))).rejects.toMatchObject({
      statusCode: 502, statusMessage: expect.stringContaining('upstream down'),
    })

    alcProxyFetchMock.mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => { throw new Error('boom') },
    })
    await expect(call(eventWith(okEnv({ DTAKO_R2: templateR2() })))).rejects.toMatchObject({
      statusCode: 401, statusMessage: expect.stringContaining('Unauthorized'),
    })
  })

  it('DTAKO_R2 未設定なら 503 (ログイン後。secret の 503 と文言で分ける)', async () => {
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
  })

  it('テンプレが R2 に無ければ 404', async () => {
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2With({}) })))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: expect.stringContaining(BODY.template_key),
    })
  })

  it('missing-dates / warnings は従来どおりヘッダに載る (本文は binary なので)', async () => {
    writeYTimeRowsMock.mockResolvedValue({ bytes: XLSX_BYTES, missingDates: ['2026-07-05', '2026-07-06'] })
    alcProxyFetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ rows: [], warnings: ['行が足りません'] }),
    })
    await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'x-y-time-missing-dates', '2026-07-05,2026-07-06',
    )
    // 日本語をそのままヘッダに入れると 500 になるので URI encode したまま
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'x-y-time-warnings', encodeURIComponent('行が足りません'),
    )
  })

  it('期間クリアの指示は従来どおり writeYTimeRows に渡る', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
    expect(writeYTimeRowsMock.mock.calls[0]![2]).toEqual({
      clearPeriod: { from: '2026-07-01', to: '2026-07-31' },
    })
  })
})
