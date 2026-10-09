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

describe('shadow 診断 (不一致のとき違うフィールド名だけ 2 行目)', () => {
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status })
  const run = async (onprem: Response, worker: Response) => {
    fetchMock.mockImplementation(async () => onprem)
    bindingFetch.mockImplementation(async () => worker)
    await fetchKyuyo(withBinding('shadow'), 'GET', 'employees', '', AUTH)
    await waitUntil.mock.calls[0]![0]
    // 直前のテストで flush されなかった payroll の比較が遅れてログを出すので、この path (employees) のものだけ見る。
    return infoSpy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('[kyuyo-shadow] employees '))
  }
  const base = () => ({
    source: 'cache', synced_at: '2026-10-09T00:00:00.123456789Z', company_name: '架空商事', warnings: [],
    employees: [{ code: 'X1', name: '架空太郎', amount: 111 }, { code: 'X2', name: '架空花子', amount: 222 }],
  })

  it('1. 一致のときは 2 行目が出ない', async () => {
    const lines = await run(json(base()), json(base()))
    expect(lines).toHaveLength(1)
  })

  it('2. synced_at だけ違う: norm=true で top に synced_at が出ない', async () => {
    const lines = await run(json(base()), json({ ...base(), synced_at: '2026-10-09T00:00:00.123Z' }))
    expect(lines).toHaveLength(2)
    expect(lines[1]).toBe('[kyuyo-shadow] employees diff: norm=true source=cache/cache top= warnings=0/0 employees=2/2 rows_diff=0 fields=')
    expect(lines[1]).not.toContain('synced_at')
  })

  it('3 & 4. company_name と employees の 1 行の 1 フィールドが違う: 名前だけ出て値は出ない', async () => {
    const w = { ...base(), company_name: '別の架空商事', employees: [{ code: 'X1', name: '架空太郎', amount: 111 }, { code: 'X2', name: '架空花子', amount: 999 }] }
    const lines = await run(json(base()), json(w))
    expect(lines[1]).toBe('[kyuyo-shadow] employees diff: norm=false source=cache/cache top=company_name,employees warnings=0/0 employees=2/2 rows_diff=1 fields=amount')
    for (const v of ['架空商事', '架空太郎', '架空花子', 'X1', '111', '999', '2026-10-09']) expect(lines.join('\n')).not.toContain(v)
  })

  it('5. JSON でない / object でない body は parse 失敗の 1 行', async () => {
    expect((await run(new Response('onprem-body'), new Response('other')))[1]).toBe('[kyuyo-shadow] employees diff: parse 失敗')
    infoSpy.mockClear(); waitUntil.mockClear()
    expect((await run(json([1]), json({})))[1]).toContain('parse 失敗')
    infoSpy.mockClear(); waitUntil.mockClear()
    expect((await run(json({}), json([1])))[1]).toContain('parse 失敗')
  })

  it('6. どちらかが 200 でなければ 2 行目は出ない', async () => {
    expect(await run(json(base()), json({ error: 'x' }, 403))).toHaveLength(1)
    infoSpy.mockClear(); waitUntil.mockClear()
    expect(await run(json({ error: 'x' }, 500), json(base()))).toHaveLength(1)
  })

  it('7a. fields が 20 個を超えたら … で打ち切る', async () => {
    const wide = (v: number) => Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, v]))
    const lines = await run(json({ rows: [wide(1)] }), json({ rows: [wide(2)] }))
    const fields = lines[1]!.split('fields=')[1]!.split(',')
    expect(fields).toHaveLength(21)
    expect(fields[19]).toBe('f19')
    expect(fields[20]).toBe('…')
  })

  it('7b. source は cache / live 以外を ? に置き換える (値は出さない)', async () => {
    const lines = await run(json({ ...base(), source: 'live' }), json({ ...base(), source: '秘密の文字列' }))
    expect(lines[1]).toContain('source=live/?')
    expect(lines[1]).not.toContain('秘密')
  })

  it('7c. 件数が違うときは短い方まで比べる / 追加フィールドは和集合', async () => {
    const lines = await run(json({ rows: [{ a: 1 }, { a: 2 }, { a: 3 }] }), json({ rows: [{ a: 1, b: 1 }] }))
    expect(lines[1]).toContain('rows=3/1 rows_diff=1 fields=b')
  })

  it('7d. 片側が配列でない / 要素が object でない配列は件数だけ', async () => {
    const lines = await run(json({ rows: [1, 2], other: [{ a: 1 }] }), json({ rows: [3], other: 'x' }))
    expect(lines[1]).toContain('rows=2/1')
    expect(lines[1]).toContain('other=1/-')
    expect(lines[1]).not.toContain('rows_diff')
  })

  it('7e. warnings は配列キーに入らず件数だけ (文言は出ない)', async () => {
    const lines = await run(json({ ...base(), warnings: ['警告A', '警告B'] }), json(base()))
    expect(lines[1]).toContain('warnings=2/0')
    expect(lines[1]).toContain('top=warnings ')
    expect(lines[1]).not.toMatch(/ warnings=\d+\/\d+ .*warnings=/)
    expect(lines[1]).not.toContain('警告')
  })

  it('7f. warnings が配列でない側は - と出す', async () => {
    const lines = await run(json({ warnings: 'x' }), json({ warnings: [] }))
    expect(lines[1]).toContain('warnings=-/0')
  })

  it('7g. 入れ子 (payments) の中のキーが違っても fields には payments しか出ない', async () => {
    const lines = await run(json({ rows: [{ payments: { 基本給: 1 } }] }), json({ rows: [{ payments: { 基本給: 2, 手当: 3 } }] }))
    expect(lines[1]).toContain('fields=payments')
    expect(lines[1]).not.toContain('基本給')
    expect(lines[1]).not.toContain('手当')
  })

  it('不一致でも応答は onprem のまま変わらない', async () => {
    fetchMock.mockImplementation(async () => json(base()))
    bindingFetch.mockImplementation(async () => json({ ...base(), company_name: 'z' }))
    const res = await fetchKyuyo(withBinding('shadow'), 'GET', 'employees', '', AUTH)
    expect(await res.json()).toEqual(base())
    await waitUntil.mock.calls[0]![0]
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
