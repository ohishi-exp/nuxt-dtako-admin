/**
 * `server/utils/ichiban-worker-upstream.ts` — 一番星の上流 = Worker だけ (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * ★ Worker の binding は mock。返す値はこちらが決めているので、ここが固定するのは
 * 「どの経路へ何を投げるか / 投げないか」だけで、上流の実挙動の証拠ではない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchIchibanUpstream } from '../../server/utils/ichiban-worker-upstream'
import type { IchibanUpstreamError } from '../../server/utils/ichiban-upstream'

const fetchMock = vi.fn()
const bindingFetch = vi.fn()

const envOf = (binding = true): Record<string, unknown> => (binding ? { ICHIBAN_DB: { fetch: bindingFetch } } : {})
const call = (path: string, search = '', binding = true) => fetchIchibanUpstream(envOf(binding), path, search)

beforeEach(() => {
  fetchMock.mockReset()
  bindingFetch.mockReset().mockImplementation(async () => new Response('worker-body', { status: 200 }))
  // オンプレ (グローバル fetch) へ倒れていないことを見るための見張り。
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
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
  for (const p of ['unknown', 'probe', '../probe', '%2e%2e/probe', 'api/employees/', '/api/employees', 'api/schema/columns']) {
    it(`${p} は 403 で上流を 1 本も呼ばない`, async () => {
      expect(await statusOf(call(p))).toBe(403)
      expect(bindingFetch).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }
})

describe('worker', () => {
  it('binding へ同じ path・クエリで GET し、認可ヘッダを付けない・グローバル fetch を呼ばない', async () => {
    bindingFetch.mockImplementation(async () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const res = await call('api/costs/vehicle-daily', '?from=2026-07-01&to=2026-07-31&limit=5000')
    expect(await res.text()).toBe('{"data":[]}')
    const req = bindingFetch.mock.calls[0]![0] as Request
    expect(req.url).toBe('https://ichibanboshi-ichiban/api/costs/vehicle-daily?from=2026-07-01&to=2026-07-31&limit=5000')
    expect(req.method).toBe('GET')
    expect(req.headers.get('accept')).toBe('application/json')
    expect(req.headers.get('authorization')).toBeNull()
    expect([...req.headers.keys()].filter(k => k.startsWith('cf-access'))).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allowlist の 6 本 (health を含む) が全部 Worker へ届く', async () => {
    for (const p of ['health', 'api/employees', 'api/vehicles', 'api/sales/departments', 'api/sales/vehicle-daily', 'api/costs/vehicle-daily']) {
      expect(await (await call(p)).text()).toBe('worker-body')
    }
    expect(bindingFetch.mock.calls.map(c => (c[0] as Request).url)).toEqual([
      'https://ichibanboshi-ichiban/health',
      'https://ichibanboshi-ichiban/api/employees',
      'https://ichibanboshi-ichiban/api/vehicles',
      'https://ichibanboshi-ichiban/api/sales/departments',
      'https://ichibanboshi-ichiban/api/sales/vehicle-daily',
      'https://ichibanboshi-ichiban/api/costs/vehicle-daily',
    ])
  })

  it('binding 未設定は 503 (fail closed、グローバル fetch へ倒さない)', async () => {
    expect(await statusOf(call('api/employees', '', false))).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('binding の fetch が reject したら 502', async () => {
    bindingFetch.mockImplementation(async () => { throw new Error('boom') })
    expect(await statusOf(call('api/employees'))).toBe(502)
  })

  it('Worker の非 2xx は status と body をそのまま返す', async () => {
    bindingFetch.mockImplementation(async () => new Response('', { status: 400 }))
    const res = await call('api/sales/vehicle-daily')
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('')
  })
})
