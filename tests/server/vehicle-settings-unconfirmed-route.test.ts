/**
 * `GET /api/vehicle-settings/unconfirmed` の**認可** (Refs #988)。
 *
 * **ここは D 段 (認可ゼロ) ではなく B 段だった** — `alcProxyFetch` が browser JWT を
 * 転送し、上流 auth-worker `/alc-proxy` が token 不在を 401 にする。それでも A 段へ
 * 上げるのは、① B 段の防御が**上流の実装依存**でこの repo からは保証できない、
 * ② **上流 401 を待つ前に R2 list が走ってしまう** (handler の `Promise.all` は
 * listing を並行で回す) の 2 点。②はここで実測して固定する。
 *
 * - **陰性対照**: 未ログインは 401 で、**R2 list も上流フェッチも 1 度も起きない**
 *   (`requireAuth` の行を消すと「R2 を触らない」が落ちる)
 * - **陽性対照**: 認証が通れば従来どおり「マスタ − dump 済み」が vehicle_cd 順で返る
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock, alcProxyFetchMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  alcProxyFetchMock: vi.fn(),
}))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('../../server/utils/alc-proxy', () => ({ alcProxyFetch: alcProxyFetchMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

import handler from '../../server/api/vehicle-settings/unconfirmed.get'
import type { UnconfirmedVehicle } from '../../server/api/vehicle-settings/unconfirmed.get'

const call = (event: unknown) =>
  (handler as unknown as (e: unknown) => Promise<UnconfirmedVehicle[]>)(event)

interface FakeObject { key: string }

class FakeR2 {
  list = vi.fn(async (opts: { prefix?: string, cursor?: string }) => {
    const all = this.objects.filter(o => !opts.prefix || o.key.startsWith(opts.prefix))
    const start = opts.cursor ? Number(opts.cursor) : 0
    const page = all.slice(start, start + this.pageSize)
    const next = start + this.pageSize
    return {
      objects: page,
      truncated: next < all.length,
      cursor: next < all.length ? String(next) : undefined,
    }
  })

  constructor(public objects: FakeObject[], public pageSize = 1000) {}
}

const DUMPED: FakeObject[] = [
  { key: 'vehicle-settings/4437/20260514_093253-0-0-4437.json' },
  { key: 'vehicle-settings/4437/20260514_093253-0-0-4437.cfg' },
  // prefix 直下でスラッシュが無い / 先頭スラッシュの key は vehicle_cd を取れない
  { key: 'vehicle-settings/broken.json' },
  { key: 'vehicle-settings//odd.json' },
]

const VEHICLES = [
  { id: 'a', tenant_id: 't', vehicle_cd: '4437', vehicle_name: '大型A' },
  { id: 'b', tenant_id: 't', vehicle_cd: '1201', vehicle_name: '中型B' },
  { id: 'c', tenant_id: 't', vehicle_cd: '0900', vehicle_name: '' },
  // vehicle_cd が空の行は数えない
  { id: 'd', tenant_id: 't', vehicle_cd: '', vehicle_name: '無番' },
  // vehicle_name 欠落は空文字で埋める (null を画面へ出さない)
  { id: 'e', tenant_id: 't', vehicle_cd: '0500' },
]

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })
const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

function okUpstream(body: unknown = VEHICLES) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body }
}

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
  alcProxyFetchMock.mockReset()
  alcProxyFetchMock.mockResolvedValue(okUpstream())
})

describe('GET /api/vehicle-settings/unconfirmed — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 list も上流フェッチも 1 度も起きない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = new FakeR2(DUMPED)
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2 })))).rejects.toMatchObject({ statusCode: 401 })
    // ★ ここが「上流が弾くから要らない」では届かない部分 — 上流 401 を待つ間に
    //    `Promise.all` が listing を回してしまうのを止めている。
    expect(r2.list).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ DTAKO_R2: new FakeR2(DUMPED) }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {} })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_R2: new FakeR2([]) }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: new FakeR2([]) })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: new FakeR2([]) })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2([]), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2([]), NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2([]), NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('GET /api/vehicle-settings/unconfirmed — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('DTAKO_R2 未設定なら 503 (ログイン後。secret の 503 と文言で分ける)', async () => {
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('★ 認証が通れば従来どおり「マスタ − dump 済み」が vehicle_cd 順で返る', async () => {
    const res = await call(eventWith(okEnv({ DTAKO_R2: new FakeR2(DUMPED) })))
    expect(res).toEqual([
      { vehicle_cd: '0500', vehicle_name: '' },
      { vehicle_cd: '0900', vehicle_name: '' },
      { vehicle_cd: '1201', vehicle_name: '中型B' },
    ])
    expect(alcProxyFetchMock).toHaveBeenCalledWith(expect.anything(), { path: '/api/dtako/vehicles' })
  })

  it('R2 の cursor を辿って全件を「dump 済み」に数える', async () => {
    const r2 = new FakeR2(DUMPED, 1)
    const res = await call(eventWith(okEnv({ DTAKO_R2: r2 })))
    expect(r2.list.mock.calls.length).toBeGreaterThan(1)
    expect(res.map(v => v.vehicle_cd)).not.toContain('4437')
  })

  it('上流エラーはその status と本文で loud fail する', async () => {
    alcProxyFetchMock.mockResolvedValue({
      ok: false, status: 502, statusText: 'Bad Gateway', text: async () => 'upstream down',
    })
    await expect(call(eventWith(okEnv({ DTAKO_R2: new FakeR2([]) })))).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: expect.stringContaining('upstream down'),
    })
  })

  it('上流の本文が読めないときは statusText に落とす (黙って空にしない)', async () => {
    alcProxyFetchMock.mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => { throw new Error('boom') },
    })
    await expect(call(eventWith(okEnv({ DTAKO_R2: new FakeR2([]) })))).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: expect.stringContaining('Unauthorized'),
    })
  })
})
