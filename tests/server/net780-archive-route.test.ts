import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 の defineEventHandler は identity に差し替える (他の server route テストと同じ)。
// readBody は event.body をそのまま返すモック。createError は実体を残し、throw された
// H3Error の statusCode を assert する。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    readBody: async (event: { body?: unknown, bodyThrows?: boolean }) => {
      if (event.bodyThrows) throw new Error('invalid json')
      return event.body
    },
  }
})

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import handler from '../../server/api/net780/archive.post'
import { NET780_ARCHIVE_MAX_ITEMS } from '../../app/utils/net780-archive'

const UNKO_22 = '2607060418590000001109'

/** 末尾 4 桁だけ変えた 22 桁の運行NO を n 本作る。 */
function unkoNos(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${UNKO_22.slice(0, 18)}${String(i).padStart(4, '0')}`)
}

interface TestEvent {
  context: Record<string, unknown>
  path: string
  body?: unknown
  bodyThrows?: boolean
  node: { req: { url: string, headers: Record<string, string | undefined> }, res: { setHeader: (k: string, v: string) => void } }
}

function eventWith(env: Record<string, unknown>, body: unknown = { operationNos: [UNKO_22] }, bodyThrows = false): TestEvent {
  const url = '/api/net780/archive'
  return {
    context: { cloudflare: { env } },
    path: url,
    body,
    bodyThrows,
    node: { req: { url, headers: {} }, res: { setHeader: vi.fn() } },
  }
}

const call = (event: TestEvent) => (handler as unknown as (e: TestEvent) => Promise<unknown>)(event)

/** 投げられた H3Error の status とメッセージ本文 (日本語メッセージは ASCII の目印で見る)。 */
async function rejection(p: Promise<unknown>): Promise<{ statusCode: number, text: string }> {
  try {
    await p
  }
  catch (e) {
    const err = e as { statusCode?: number, statusMessage?: string, message?: string }
    return { statusCode: err.statusCode ?? 0, text: `${err.statusMessage ?? ''} ${err.message ?? ''}` }
  }
  throw new Error('例外が投げられませんでした')
}

function relayResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function okRelay(opeNos: string[] = [UNKO_22]) {
  return relayResponse({
    ok: true,
    comp_id: '27324455',
    results: opeNos.map(ope_no => ({ ope_no, status: 'archived', bytes: 1234 })),
    success_count: opeNos.length,
    failure_count: 0,
    truncated: false,
    remaining: 0,
    theearth_logins: 1,
    theearth_kicked: false,
  })
}

function envWithRelay(fetchMock: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return { INTERNAL_SHARED_SECRET: 'secret-x', SCRAPER_RELAY: { fetch: fetchMock }, ...extra }
}

describe('POST /api/net780/archive', () => {
  beforeEach(() => {
    requireAuthMock.mockReset()
    requireAuthMock.mockResolvedValue({ sub: 'user-1', role: 'admin' })
  })

  it('INTERNAL_SHARED_SECRET 未設定は 503 (relay も requireAuth も呼ばない)', async () => {
    await expect(call(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env 自体が無くても 503 になる', async () => {
    const event = { context: {}, path: '/x', node: { req: { url: '/x', headers: {} }, res: { setHeader: vi.fn() } } }
    await expect(call(event as unknown as TestEvent)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('INTERNAL_SHARED_SECRET が Secrets Store binding (.get()) でも解決する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRelay())
    const env = { INTERNAL_SHARED_SECRET: { get: async () => 'secret-store' }, SCRAPER_RELAY: { fetch: fetchMock } }
    await call(eventWith(env))
    expect(fetchMock.mock.calls[0]![1].headers['X-Alc-Proxy-Secret']).toBe('secret-store')
  })

  it('Secrets Store binding の .get() が null を返しても 503 になる', async () => {
    const env = { INTERNAL_SHARED_SECRET: { get: async () => null } }
    await expect(call(eventWith(env))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('未ログイン (requireAuth が投げる) はそのまま伝播する (relay を呼ばない)', async () => {
    const fetchMock = vi.fn()
    requireAuthMock.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
    await expect(call(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requireAuth には auth-worker URL と secret を渡す (未設定なら本番既定)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRelay())
    await call(eventWith(envWithRelay(fetchMock)))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({
      authWorkerUrl: 'https://auth.ippoan.org',
      sharedSecret: 'secret-x',
    })
    await call(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth-staging.ippoan.org' })))
    expect(requireAuthMock.mock.calls[1]![1]).toMatchObject({ authWorkerUrl: 'https://auth-staging.ippoan.org' })
    await call(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[2]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  it('body の形式不正 (operationNos 無し / 空 / 上限超過 / 桁違い) は 400 で relay を呼ばない', async () => {
    const fetchMock = vi.fn()
    const env = envWithRelay(fetchMock)
    await expect(call(eventWith(env, {}))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { operationNos: [] }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { operationNos: unkoNos(NET780_ARCHIVE_MAX_ITEMS + 1) }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { operationNos: ['12345'] }))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('body が JSON として読めない (readBody が投げる) のも 400', async () => {
    const fetchMock = vi.fn()
    await expect(call(eventWith(envWithRelay(fetchMock), undefined, true))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SCRAPER_RELAY binding 未設定は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  // relay の body のキーは `items[].ope_no / start_ope` (comp_id は relay が補完)。
  it('運行NO から items を組んで relay を叩き、relay の JSON をそのまま返す', async () => {
    const opeNos = unkoNos(3)
    const fetchMock = vi.fn().mockResolvedValue(okRelay(opeNos))
    const result = await call(eventWith(envWithRelay(fetchMock), { operationNos: [`${opeNos[0]}1`, opeNos[1], opeNos[2]] }))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.internal/kintai-relay/net780-archive')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['X-Alc-Proxy-Secret']).toBe('secret-x')
    const body = JSON.parse(init.body)
    expect(Object.keys(body)).toEqual(['items'])
    expect(body.items).toHaveLength(opeNos.length)
    expect(body.items[0]).toEqual({ ope_no: opeNos[0], start_ope: '2026/07/06 4:18:59' })
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(['ope_no', 'start_ope'])
    expect(result).toMatchObject({ ok: true, success_count: opeNos.length, truncated: false })
    expect((result as { results: unknown[] }).results).toHaveLength(opeNos.length)
  })

  it('relay が非 2xx ならその status と `relay:` 前置のメッセージを返す (口が無い 404 も同じ)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ error: '不明なエンドポイントです' }, 404))
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(404)
    expect(text).toContain('relay:')
  })

  it('relay が非 2xx で本文が JSON でなくても status は保つ (HTTP 番号入りの既定文)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json') },
    } as unknown as Response)
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(502)
    expect(text).toContain('relay:')
    expect(text).toContain('502')
  })

  it('relay が 2xx なのに JSON でなければ 502 (null を返さない)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json') },
    } as unknown as Response)
    await expect(call(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 502 })
  })
})
