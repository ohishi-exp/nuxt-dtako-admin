/**
 * `server/utils/ichiban-worker-upstream.ts` — 一番星の上流切替 (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * ★ onprem の fetch (グローバル) も Worker の binding も mock。返す値はこちらが決めているので、
 * ここが固定するのは「どの経路へ何を投げるか / 投げないか」だけで、上流の実挙動の証拠ではない。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchIchibanUpstream } from '../../server/utils/ichiban-worker-upstream'
import type { IchibanUpstreamError } from '../../server/utils/ichiban-upstream'

const fetchMock = vi.fn()
const bindingFetch = vi.fn()
const waitUntil = vi.fn()

const ACCESS = { NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'id', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'sec' }
const evt = (withCtx = true) => ({ context: { cloudflare: withCtx ? { context: { waitUntil } } : {} } })
const envOf = (mode?: unknown, binding = true): Record<string, unknown> => ({
  ...ACCESS,
  ...(binding ? { ICHIBAN_DB: { fetch: bindingFetch } } : {}),
  ...(mode === undefined ? {} : { NUXT_ICHIBAN_UPSTREAM: mode }),
})
const call = (mode: unknown, path: string, search = '', binding = true) => fetchIchibanUpstream(evt(), envOf(mode, binding), path, search)

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
  const paths = ['unknown', 'probe', '../probe', '%2e%2e/probe', 'api/employees/', '/api/employees', 'api/schema/columns']
  for (const mode of [undefined, 'onprem', 'shadow', 'worker']) {
    for (const p of paths) {
      it(`${mode ?? '未設定'}: ${p} は 403 で上流を 1 本も呼ばない`, async () => {
        expect(await statusOf(call(mode, p))).toBe(403)
        expect(fetchMock).not.toHaveBeenCalled()
        expect(bindingFetch).not.toHaveBeenCalled()
      })
    }
  }
})

describe('onprem (既定)', () => {
  for (const mode of [undefined, '', 'onprem', 'unknown', 'WORKER', 42]) {
    it(`NUXT_ICHIBAN_UPSTREAM=${String(mode)} は fetchIchiban だけ (binding を呼ばない)`, async () => {
      const res = await call(mode, 'api/sales/vehicle-daily', '?vehicle=101')
      expect(await res.text()).toBe('onprem-body')
      const [url, init] = fetchMock.mock.calls[0]!
      expect(new URL(String(url)).pathname + new URL(String(url)).search).toBe('/api/sales/vehicle-daily?vehicle=101')
      expect(init.headers['CF-Access-Client-Id']).toBe('id')
      expect(bindingFetch).not.toHaveBeenCalled()
      expect(waitUntil).not.toHaveBeenCalled()
    })
  }
})

describe('worker', () => {
  it('binding へ同じ path・クエリで GET し、認可ヘッダを付けない・onprem を呼ばない', async () => {
    bindingFetch.mockImplementation(async () => new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }))
    const res = await call('worker', 'api/costs/vehicle-daily', '?from=2026-07-01&to=2026-07-31&limit=5000')
    expect(await res.text()).toBe('{"data":[]}')
    const req = bindingFetch.mock.calls[0]![0] as Request
    expect(req.url).toBe('https://ichibanboshi-ichiban/api/costs/vehicle-daily?from=2026-07-01&to=2026-07-31&limit=5000')
    expect(req.method).toBe('GET')
    expect(req.headers.get('authorization')).toBeNull()
    expect([...req.headers.keys()].filter(k => k.startsWith('cf-access'))).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('/health も Worker へ (shadow と違い除外しない)', async () => {
    await call('worker', 'health')
    expect((bindingFetch.mock.calls[0]![0] as Request).url).toBe('https://ichibanboshi-ichiban/health')
  })

  it('binding 未設定は 503 (fail closed、onprem へ倒さない)', async () => {
    expect(await statusOf(call('worker', 'api/employees', '', false))).toBe(503)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('binding の fetch が reject したら 502', async () => {
    bindingFetch.mockImplementation(async () => { throw new Error('boom') })
    expect(await statusOf(call('worker', 'api/employees'))).toBe(502)
  })

  it('Worker の非 2xx は status と body をそのまま返す', async () => {
    bindingFetch.mockImplementation(async () => new Response('', { status: 400 }))
    const res = await call('worker', 'api/sales/vehicle-daily')
    expect(res.status).toBe(400)
    expect(await res.text()).toBe('')
  })
})

describe('shadow', () => {
  const flush = async () => { await waitUntil.mock.calls[0]![0] }

  for (const p of ['api/employees', 'api/vehicles', 'api/sales/departments', 'api/sales/vehicle-daily', 'api/costs/vehicle-daily']) {
    it(`${p} は binding にも同じ URL で投げ、比較を waitUntil に載せ、応答は onprem`, async () => {
      const res = await call('shadow', p, '?a=1')
      expect(await res.text()).toBe('onprem-body')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect((bindingFetch.mock.calls[0]![0] as Request).url).toBe(`https://ichibanboshi-ichiban/${p}?a=1`)
      expect(waitUntil).toHaveBeenCalledTimes(1)
      await flush()
      expect(infoSpy).toHaveBeenCalledTimes(1)
    })
  }

  it('health は onprem だけ (Worker の応答は commit を含まず常に不一致になるため)', async () => {
    await call('shadow', 'health')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(bindingFetch).not.toHaveBeenCalled()
    expect(waitUntil).not.toHaveBeenCalled()
  })

  it('一致: 1 行・長さと hash 先頭 12 桁・match=true、body は出さない', async () => {
    await call('shadow', 'api/employees')
    await flush()
    const line = String(infoSpy.mock.calls[0]![0])
    expect(line).toMatch(/^\[ichiban-shadow\] api\/employees onprem=200\/11\/[0-9a-f]{12} worker=200\/11\/[0-9a-f]{12} match=true$/)
    expect(line).not.toContain('onprem-body')
  })

  it('body 不一致: match=false', async () => {
    bindingFetch.mockImplementation(async () => new Response('other', { status: 200 }))
    await call('shadow', 'api/employees')
    await flush()
    expect(String(infoSpy.mock.calls[0]![0])).toMatch(/worker=200\/5\/[0-9a-f]{12} match=false$/)
  })

  it('status 不一致 (body は同じ): match=false で 2 行目は出ない', async () => {
    bindingFetch.mockImplementation(async () => new Response('onprem-body', { status: 502 }))
    await call('shadow', 'api/employees')
    await flush()
    expect(String(infoSpy.mock.calls[0]![0])).toMatch(/worker=502\/.* match=false$/)
    expect(infoSpy).toHaveBeenCalledTimes(1)
  })

  it('binding が未設定でも onprem の応答を返し、比較はスキップしてログ 1 行', async () => {
    const res = await call('shadow', 'api/employees', '', false)
    expect(await res.text()).toBe('onprem-body')
    await flush()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toBe('[ichiban-shadow] api/employees skip: 503')
  })

  it('binding が reject しても onprem の応答を返し、ログ 1 行', async () => {
    bindingFetch.mockImplementation(async () => { throw new Error('boom') })
    const res = await call('shadow', 'api/employees')
    expect(await res.text()).toBe('onprem-body')
    await flush()
    expect(infoSpy).not.toHaveBeenCalled()
    expect(String(warnSpy.mock.calls[0]![0])).toBe('[ichiban-shadow] api/employees skip: 502')
  })

  it('比較中の失敗 (body 読み取り不能) も握ってログ 1 行', async () => {
    bindingFetch.mockImplementation(async () => ({ status: 200, arrayBuffer: async () => { throw new Error('x') } }))
    await call('shadow', 'api/employees')
    await flush()
    expect(String(warnSpy.mock.calls[0]![0])).toBe('[ichiban-shadow] api/employees skip: 比較失敗')
  })

  it('waitUntil が無い環境でも応答は返る', async () => {
    expect(await (await fetchIchibanUpstream(evt(false), envOf('shadow'), 'api/employees', '')).text()).toBe('onprem-body')
    const e2 = { context: { cloudflare: { context: {} } } }
    expect(await (await fetchIchibanUpstream(e2, envOf('shadow'), 'api/employees', '')).text()).toBe('onprem-body')
    expect(await (await fetchIchibanUpstream({ context: {} }, envOf('shadow'), 'api/employees', '')).text()).toBe('onprem-body')
  })

  it('onprem が失敗したらその例外が伝わる (Worker の応答で代替しない)', async () => {
    fetchMock.mockImplementation(async () => { throw new Error('down') })
    expect(await statusOf(call('shadow', 'api/employees'))).toBe(502)
  })
})

describe('shadow 診断 (不一致のとき違うフィールド名だけ 2 行目)', () => {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
  const run = async (onprem: Response, worker: Response) => {
    fetchMock.mockImplementation(async () => onprem)
    bindingFetch.mockImplementation(async () => worker)
    await call('shadow', 'api/sales/vehicle-daily')
    await waitUntil.mock.calls.at(-1)![0]
    return infoSpy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[ichiban-shadow] api/sales/vehicle-daily '))
  }
  const base = () => ({
    data: [{ vehicle_cd: 'V1', driver_name: '架空太郎', amount: 111 }, { vehicle_cd: 'V2', driver_name: '架空花子', amount: 222 }],
    count: 2,
  })

  it('一致のときは 2 行目が出ない', async () => {
    expect(await run(json(base()), json(base()))).toHaveLength(1)
  })

  it('配列の 1 行の 1 フィールドと top の値が違う: 名前だけ出て値は出ない', async () => {
    const w = { data: [{ vehicle_cd: 'V1', driver_name: '架空太郎', amount: 111 }, { vehicle_cd: 'V2', driver_name: '架空花子', amount: 999 }], count: 3 }
    const lines = await run(json(base()), json(w))
    expect(lines[1]).toBe('[ichiban-shadow] api/sales/vehicle-daily diff: top=data,count data=2/2 rows_diff=1 fields=amount')
    for (const v of ['架空太郎', '架空花子', 'V1', '111', '999']) expect(lines.join('\n')).not.toContain(v)
  })

  it('JSON でない / object でない body は parse 失敗の 1 行', async () => {
    expect((await run(new Response('onprem-body'), new Response('other')))[1]).toBe('[ichiban-shadow] api/sales/vehicle-daily diff: parse 失敗')
    infoSpy.mockClear()
    expect((await run(json([1]), json({})))[1]).toContain('parse 失敗')
    infoSpy.mockClear()
    expect((await run(json({}), json([1])))[1]).toContain('parse 失敗')
  })

  it('どちらかが 200 でなければ 2 行目は出ない', async () => {
    expect(await run(json(base()), json({ error: 'x' }, 500))).toHaveLength(1)
    infoSpy.mockClear()
    expect(await run(json({ error: 'x' }, 503), json(base()))).toHaveLength(1)
  })

  it('fields が 20 個を超えたら … で打ち切る', async () => {
    const wide = (v: number) => Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, v]))
    const lines = await run(json({ data: [wide(1)] }), json({ data: [wide(2)] }))
    const fields = lines[1]!.split('fields=')[1]!.split(',')
    expect(fields).toHaveLength(21)
    expect(fields[19]).toBe('f19')
    expect(fields[20]).toBe('…')
  })

  it('件数が違うときは短い方まで比べる / 追加フィールドは和集合', async () => {
    const lines = await run(json({ data: [{ a: 1 }, { a: 2 }, { a: 3 }] }), json({ data: [{ a: 1, b: 1 }] }))
    expect(lines[1]).toContain('data=3/1 rows_diff=1 fields=b')
  })

  it('片側が配列でない / 要素が object でない配列は件数だけ', async () => {
    const lines = await run(json({ data: [1, 2], other: [{ a: 1 }] }), json({ data: [3], other: 'x' }))
    expect(lines[1]).toContain('data=2/1')
    expect(lines[1]).toContain('other=1/-')
    expect(lines[1]).not.toContain('rows_diff')
  })

  it('入れ子の中のキーが違っても fields には外側の名前しか出ない', async () => {
    const lines = await run(json({ data: [{ detail: { 品名: 1 } }] }), json({ data: [{ detail: { 品名: 2, 備考: 3 } }] }))
    expect(lines[1]).toContain('fields=detail')
    expect(lines[1]).not.toContain('品名')
  })

  it('不一致でも応答は onprem のまま変わらない', async () => {
    fetchMock.mockImplementation(async () => json(base()))
    bindingFetch.mockImplementation(async () => json({ ...base(), count: 9 }))
    const res = await call('shadow', 'api/sales/vehicle-daily')
    expect(await res.json()).toEqual(base())
    await waitUntil.mock.calls[0]![0]
  })
})
