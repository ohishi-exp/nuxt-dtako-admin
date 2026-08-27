import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 の defineEventHandler は identity に差し替え、createError の H3Error を
// そのまま assert する (tests/server/proxy.test.ts と同じ流儀)。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

// **`requireAuth` を入れた** (Refs #988)。既存の it は全部「認証が通った後も
// 従来どおり」の陽性対照になる — 通す形にしてから、下の describe で
// 未ログイン / secret 未設定を別に固定する。
const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import handler from '../../server/api/poi/[region].get'

interface TestEvent {
  context: Record<string, unknown>
  node: { res: { setHeader: (k: string, v: string) => void } }
}

const call = (event: TestEvent) => (handler as unknown as (e: TestEvent) => Promise<unknown>)(event)

/** `INTERNAL_SHARED_SECRET` は既定で載せる (認証まで到達させるため)。 */
function eventWith(env: Record<string, unknown>, region: string | undefined): TestEvent {
  return {
    context: {
      cloudflare: { env: { INTERNAL_SHARED_SECRET: 'secret', ...env } },
      // h3 getRouterParam は event.context.params を見る
      params: region === undefined ? {} : { region },
    },
    node: { res: { setHeader: vi.fn() } },
  }
}

function r2With(objects: Record<string, string>) {
  return {
    get: vi.fn(async (key: string) =>
      key in objects ? { text: async () => objects[key]! } : null,
    ),
  }
}

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
})

describe('GET /api/poi/:region — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 を 1 度も触らない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = r2With({ 'poi/kyushu.geojson': '{"type":"FeatureCollection"}' })
    await expect(call(eventWith({ DTAKO_R2: r2 }, 'kyushu'))).rejects.toMatchObject({ statusCode: 401 })
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    const event = {
      context: { cloudflare: { env: { DTAKO_R2: r2With({}) } }, params: { region: 'kyushu' } },
      node: { res: { setHeader: vi.fn() } },
    }
    await expect(call(event)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    const event = { context: { params: { region: 'kyushu' } }, node: { res: { setHeader: vi.fn() } } }
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({
      INTERNAL_SHARED_SECRET: { get: async () => 'from-store' },
      DTAKO_R2: r2With({ 'poi/kyushu.geojson': '{}' }),
    }, 'kyushu'))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: r2With({}) }, 'kyushu')))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: r2With({}) }, 'kyushu')))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    const r2 = r2With({ 'poi/kyushu.geojson': '{}' })
    await call(eventWith({ DTAKO_R2: r2, NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' }, 'kyushu'))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith({ DTAKO_R2: r2, NUXT_PUBLIC_AUTH_WORKER_URL: '' }, 'kyushu'))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith({ DTAKO_R2: r2, NUXT_PUBLIC_AUTH_WORKER_URL: 7 }, 'kyushu'))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('GET /api/poi/:region', () => {
  it('R2 の poi/<region>.geojson を返す', async () => {
    const r2 = r2With({ 'poi/kyushu.geojson': '{"type":"FeatureCollection"}' })
    const res = await call(eventWith({ DTAKO_R2: r2 }, 'kyushu'))
    expect(res).toBe('{"type":"FeatureCollection"}')
    expect(r2.get).toHaveBeenCalledWith('poi/kyushu.geojson')
  })

  it('region 形式不正は 400 (R2 key injection 防止)', async () => {
    const r2 = r2With({})
    for (const bad of ['../secret', 'Kyushu', 'a b', '', 'x'.repeat(33)]) {
      await expect(call(eventWith({ DTAKO_R2: r2 }, bad))).rejects.toMatchObject({ statusCode: 400 })
    }
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('region 欠落は 400', async () => {
    await expect(call(eventWith({ DTAKO_R2: r2With({}) }, undefined))).rejects.toMatchObject({ statusCode: 400 })
  })

  // **`requireAuth` を入れて 503 が 2 種類になった** (Refs #988) — secret 未設定でも
  // 503 なので、`statusCode` だけを見ると**別の理由で緑になる**。文言で分ける。
  it('R2 binding 未設定は 503 (認証は通った後)', async () => {
    await expect(call(eventWith({}, 'kyushu'))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
    expect(requireAuthMock).toHaveBeenCalled()
  })

  it('未配置の region は 404 (配置手順つき loud fail)', async () => {
    const r2 = r2With({})
    await expect(call(eventWith({ DTAKO_R2: r2 }, 'kanto'))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: expect.stringContaining('poi/kanto.geojson'),
    })
  })
})
