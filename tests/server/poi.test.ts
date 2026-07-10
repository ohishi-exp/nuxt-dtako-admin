import { describe, expect, it, vi } from 'vitest'

// h3 の defineEventHandler は identity に差し替え、createError の H3Error を
// そのまま assert する (tests/server/proxy.test.ts と同じ流儀)。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

import handler from '../../server/api/poi/[region].get'

interface TestEvent {
  context: Record<string, unknown>
  node: { res: { setHeader: (k: string, v: string) => void } }
}

const call = (event: TestEvent) => (handler as unknown as (e: TestEvent) => Promise<unknown>)(event)

function eventWith(env: Record<string, unknown>, region: string | undefined): TestEvent {
  return {
    context: {
      cloudflare: { env },
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

  it('R2 binding 未設定は 503', async () => {
    await expect(call(eventWith({}, 'kyushu'))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('未配置の region は 404 (配置手順つき loud fail)', async () => {
    const r2 = r2With({})
    await expect(call(eventWith({ DTAKO_R2: r2 }, 'kanto'))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: expect.stringContaining('poi/kanto.geojson'),
    })
  })
})
