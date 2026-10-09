/**
 * `server/utils/kyuyo-upstream.ts` — 給与大臣の上流 (Service Binding の Worker だけ) (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * ★ Worker の binding は mock。返す値はこちらが決めているので、ここが固定するのは
 * 「何を投げるか / 投げないか」だけで、上流の実挙動の証拠ではない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchKyuyo } from '../../server/utils/kyuyo-upstream'
import { IchibanUpstreamError } from '../../server/utils/ichiban-upstream'

const AUTH = 'Bearer jwt-x'
const fetchMock = vi.fn()
const bindingFetch = vi.fn()

function ev(env: Record<string, unknown> = {}) {
  return {
    context: {
      cloudflare: {
        env: { NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'id', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'sec', ...env },
      },
    },
  }
}
const withBinding = () => ev({ ICHIBAN_KYUYO: { fetch: bindingFetch } })

beforeEach(() => {
  fetchMock.mockReset().mockImplementation(async () => new Response('onprem-body', { status: 200 }))
  bindingFetch.mockReset().mockImplementation(async () => new Response('w', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
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

describe('allowlist (上流を呼ぶ前)', () => {
  const cases: Array<['GET' | 'POST', string]> = [
    ['GET', 'unknown'], ['GET', '../probe'], ['GET', '%2e%2e/probe'], ['GET', 'sync'], ['GET', 'payroll/'], ['POST', 'payroll'], ['POST', 'sync/x'],
  ]
  for (const [m, p] of cases) {
    it(`${m} ${p} は 404 で上流を 1 本も呼ばない`, async () => {
      expect(await statusOf(fetchKyuyo(withBinding(), m, p, '', AUTH, m === 'POST' ? '{}' : undefined))).toBe(404)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(bindingFetch).not.toHaveBeenCalled()
    })
  }
})

describe('worker', () => {
  it('GET は binding へ URL・Authorization (Bearer 付き) で送り、CF Access ヘッダ無し・グローバル fetch を呼ばない', async () => {
    const res = await fetchKyuyo(withBinding(), 'GET', 'payroll', '?company=0100&month=2026-07', AUTH)
    expect(await res.text()).toBe('w')
    const req = bindingFetch.mock.calls[0]![0] as Request
    expect(req.url).toBe('https://ichibanboshi-kyuyo/kyuyo/payroll?company=0100&month=2026-07')
    expect(req.method).toBe('GET')
    expect(req.headers.get('authorization')).toBe(AUTH)
    expect([...req.headers.keys()].filter(k => k.startsWith('cf-access'))).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POST は body と content-type を送る', async () => {
    await fetchKyuyo(withBinding(), 'POST', 'sync', '', AUTH, '{"a":1}')
    const req = bindingFetch.mock.calls[0]![0] as Request
    expect(req.url).toBe('https://ichibanboshi-kyuyo/kyuyo/sync')
    expect(req.method).toBe('POST')
    expect(req.headers.get('content-type')).toBe('application/json')
    expect(req.headers.get('authorization')).toBe(AUTH)
    expect(await req.text()).toBe('{"a":1}')
  })

  it('binding 未設定は 503 (fail closed)', async () => {
    expect(await statusOf(fetchKyuyo(ev(), 'GET', 'payroll', '', AUTH))).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetch が reject したら 502', async () => {
    bindingFetch.mockImplementation(async () => { throw new Error('boom') })
    expect(await statusOf(fetchKyuyo(withBinding(), 'GET', 'payroll', '', AUTH))).toBe(502)
  })

  it('Worker の 401 は status と body をそのまま返す', async () => {
    bindingFetch.mockImplementation(async () => new Response('{"error":"unauthorized"}', { status: 401, headers: { 'content-type': 'application/json' } }))
    const res = await fetchKyuyo(withBinding(), 'GET', 'payroll', '', AUTH)
    expect(res.status).toBe(401)
    expect(await res.text()).toBe('{"error":"unauthorized"}')
  })
})
