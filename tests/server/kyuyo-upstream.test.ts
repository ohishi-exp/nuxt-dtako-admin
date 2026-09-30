/**
 * `server/utils/kyuyo-upstream.ts` — 給与大臣の上流切替 (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * ★ onprem の fetch (グローバル) も Worker の binding も mock。返す値はこちらが決めているので、
 * ここが固定するのは「どの経路へ何を投げるか / 投げないか」だけで、上流の実挙動の証拠ではない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchKyuyo } from '../../server/utils/kyuyo-upstream'
import { IchibanUpstreamError } from '../../server/utils/ichiban-upstream'

const AUTH = 'Bearer jwt-x'
const fetchMock = vi.fn()
const bindingFetch = vi.fn()
const waitUntil = vi.fn()

function ev(env: Record<string, unknown> = {}, withCtx = true) {
  return {
    context: {
      cloudflare: {
        env: { NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'id', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'sec', ...env },
        ...(withCtx ? { context: { waitUntil } } : {}),
      },
    },
  }
}
const withBinding = (mode?: string) => ev({ ICHIBAN_KYUYO: { fetch: bindingFetch }, ...(mode === undefined ? {} : { NUXT_KYUYO_UPSTREAM: mode }) })

let infoSpy: ReturnType<typeof vi.spyOn>
let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response('onprem-body', { status: 200 }))
  bindingFetch.mockReset().mockImplementation(async () => new Response('onprem-body', { status: 200 }))
  waitUntil.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function statusOf(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p
  }
  catch (e) {
    return (e as IchibanUpstreamError).statusCode
  }
}

describe('allowlist (全モード共通・上流を呼ぶ前)', () => {
  const cases: Array<['GET' | 'POST', string]> = [
    ['GET', 'unknown'], ['GET', '../probe'], ['GET', '%2e%2e/probe'], ['GET', 'sync'], ['GET', 'payroll/'], ['POST', 'payroll'], ['POST', 'sync/x'],
  ]
  for (const mode of [undefined, 'onprem', 'shadow', 'worker']) {
    for (const [m, p] of cases) {
      it(`${mode ?? '未設定'}: ${m} ${p} は 404 で上流を 1 本も呼ばない`, async () => {
        expect(await statusOf(fetchKyuyo(withBinding(mode), m, p, '', AUTH, m === 'POST' ? '{}' : undefined))).toBe(404)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(bindingFetch).not.toHaveBeenCalled()
      })
    }
  }
})

describe('onprem (既定)', () => {
  for (const mode of [undefined, '', 'onprem', 'unknown', 42]) {
    it(`NUXT_KYUYO_UPSTREAM=${String(mode)} は fetchIchiban だけ (binding を呼ばない)`, async () => {
      const res = await fetchKyuyo(ev({ ICHIBAN_KYUYO: { fetch: bindingFetch }, ...(mode === undefined ? {} : { NUXT_KYUYO_UPSTREAM: mode }) }), 'GET', 'payroll', '?m=1', AUTH)
      expect(await res.text()).toBe('onprem-body')
      const [url, init] = fetchMock.mock.calls[0]!
      expect(String(url)).toContain('/api/kyuyo/payroll?m=1')
      expect(init.method).toBe('GET')
      expect(init.headers.Authorization).toBe(AUTH)
      expect(bindingFetch).not.toHaveBeenCalled()
    })
  }
  it('POST は body を JSON で渡す', async () => {
    await fetchKyuyo(ev(), 'POST', 'sync', '', AUTH, '{"a":1}')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toContain('/api/kyuyo/sync')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
  })
})

describe('shadow', () => {
  const flush = async () => { await waitUntil.mock.calls[0]![0] }

  for (const p of ['access', 'databases', 'employees', 'payroll']) {
    it(`GET ${p} は binding にも投げ、比較を waitUntil に載せ、応答は onprem`, async () => {
      const res = await fetchKyuyo(withBinding('shadow'), 'GET', p, '?a=1', AUTH)
      expect(await res.text()).toBe('onprem-body')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bindingFetch).toHaveBeenCalledTimes(1)
      expect(waitUntil).toHaveBeenCalledTimes(1)
      await flush()
      expect(infoSpy).toHaveBeenCalledTimes(1)
    })
  }

  for (const p of ['synced-months', 'companies']) {
    it(`GET ${p} は旧だけ`, async () => {
      await fetchKyuyo(withBinding('shadow'), 'GET', p, '', AUTH)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(bindingFetch).not.toHaveBeenCalled()
      expect(waitUntil).not.toHaveBeenCalled()
    })
  }

  it('POST sync は旧だけ (二重書き込みしない)', async () => {
    await fetchKyuyo(withBinding('shadow'), 'POST', 'sync', '', AUTH, '{}')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bindingFetch).not.toHaveBeenCalled()
  })

  it('一致: 1 行・長さと hash 先頭 12 桁・match=true、body と JWT は出さない', async () => {
    await fetchKyuyo(withBinding('shadow'), 'GET', 'payroll', '', AUTH)
    await flush()
    const line = String(infoSpy.mock.calls[0]![0])
    expect(line).toMatch(/^\[kyuyo-shadow\] payroll onprem=200\/11\/[0-9a-f]{12} worker=200\/11\/[0-9a-f]{12} match=true$/)
    expect(line).not.toContain('onprem-body')
    expect(line).not.toContain('jwt-x')
  })

  it('body 不一致: match=false', async () => {
    bindingFetch.mockImplementation(async () => new Response('other', { status: 200 }))
    await fetchKyuyo(withBinding('shadow'), 'GET', 'payroll', '', AUTH)
    await flush()
    expect(String(infoSpy.mock.calls[0]![0])).toMatch(/worker=200\/5\/[0-9a-f]{12} match=false$/)
  })

  it('status 不一致 (body は同じ): match=false', async () => {
    bindingFetch.mockImplementation(async () => new Response('onprem-body', { status: 403 }))
    await fetchKyuyo(withBinding('shadow'), 'GET', 'payroll', '', AUTH)
    await flush()
    expect(String(infoSpy.mock.calls[0]![0])).toMatch(/worker=403\/.* match=false$/)
  })

  it('binding が未設定でも旧の応答を返し、比較はスキップしてログ 1 行', async () => {
    const res = await fetchKyuyo(ev({ NUXT_KYUYO_UPSTREAM: 'shadow' }), 'GET', 'payroll', '', AUTH)
    expect(await res.text()).toBe('onprem-body')
    await flush()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('skip: 503')
  })

  it('binding が reject しても旧の応答を返し、ログ 1 行', async () => {
    bindingFetch.mockImplementation(async () => { throw new Error('boom') })
    const res = await fetchKyuyo(withBinding('shadow'), 'GET', 'payroll', '', AUTH)
    expect(await res.text()).toBe('onprem-body')
    await flush()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]![0])).toContain('skip: 502')
  })

  it('比較中の失敗 (body 読み取り不能) も握ってログ 1 行', async () => {
    bindingFetch.mockImplementation(async () => ({ status: 200, arrayBuffer: async () => { throw new Error('x') } }))
    await fetchKyuyo(withBinding('shadow'), 'GET', 'payroll', '', AUTH)
    await flush()
    expect(String(warnSpy.mock.calls[0]![0])).toContain('skip: 比較失敗')
  })

  it('waitUntil が無い環境でも応答は返る', async () => {
    const e1 = ev({ ICHIBAN_KYUYO: { fetch: bindingFetch }, NUXT_KYUYO_UPSTREAM: 'shadow' }, false)
    expect(await (await fetchKyuyo(e1, 'GET', 'payroll', '', AUTH)).text()).toBe('onprem-body')
    const e2 = ev({ ICHIBAN_KYUYO: { fetch: bindingFetch }, NUXT_KYUYO_UPSTREAM: 'shadow' })
    ;(e2.context.cloudflare as { context: unknown }).context = {}
    expect(await (await fetchKyuyo(e2, 'GET', 'payroll', '', AUTH)).text()).toBe('onprem-body')
  })

  it('onprem が失敗したらその例外が伝わる', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('down') })
    expect(await statusOf(fetchKyuyo(withBinding('shadow'), 'GET', 'payroll', '', AUTH))).toBe(502)
  })
})

describe('worker', () => {
  it('GET は binding へ URL・Authorization (Bearer 付き) で送り、CF Access ヘッダ無し・onprem 無し', async () => {
    bindingFetch.mockImplementation(async () => new Response('w', { status: 200 }))
    const res = await fetchKyuyo(withBinding('worker'), 'GET', 'payroll', '?company=0100&month=2026-07', AUTH)
    expect(await res.text()).toBe('w')
    const req = bindingFetch.mock.calls[0]![0] as Request
    expect(req.url).toBe('https://ichibanboshi-kyuyo/kyuyo/payroll?company=0100&month=2026-07')
    expect(req.method).toBe('GET')
    expect(req.headers.get('authorization')).toBe(AUTH)
    expect([...req.headers.keys()].filter(k => k.startsWith('cf-access'))).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POST は body と content-type を送る', async () => {
    await fetchKyuyo(withBinding('worker'), 'POST', 'sync', '', AUTH, '{"a":1}')
    const req = bindingFetch.mock.calls[0]![0] as Request
    expect(req.url).toBe('https://ichibanboshi-kyuyo/kyuyo/sync')
    expect(req.method).toBe('POST')
    expect(req.headers.get('content-type')).toBe('application/json')
    expect(req.headers.get('authorization')).toBe(AUTH)
    expect(await req.text()).toBe('{"a":1}')
  })

  it('binding 未設定は 503 (fail closed)', async () => {
    expect(await statusOf(fetchKyuyo(ev({ NUXT_KYUYO_UPSTREAM: 'worker' }), 'GET', 'payroll', '', AUTH))).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch が reject したら 502', async () => {
    bindingFetch.mockImplementation(async () => { throw new Error('boom') })
    expect(await statusOf(fetchKyuyo(withBinding('worker'), 'GET', 'payroll', '', AUTH))).toBe(502)
  })

  it('Worker の 401 は status と body をそのまま返す', async () => {
    bindingFetch.mockImplementation(async () => new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }))
    const res = await fetchKyuyo(withBinding('worker'), 'GET', 'payroll', '', AUTH)
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('{"error":"unauthorized"}')
  })
})
