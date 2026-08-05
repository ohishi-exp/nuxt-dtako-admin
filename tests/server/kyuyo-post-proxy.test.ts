import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import handler, { MAX_BODY_BYTES } from '../../server/api/kyuyo/[...path].post'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

function eventWith(
  env: Record<string, unknown>,
  opts: { path?: string, url?: string, body?: string, authorization?: string } = {},
) {
  const path = opts.path ?? 'wage-snapshot'
  const url = opts.url ?? `https://dtako.ippoan.org/api/kyuyo/${path}`
  return {
    context: {
      cloudflare: { env },
      params: { path },
    },
    __responseHeaders: {} as Record<string, string>,
    __statusCode: undefined as number | undefined,
    _url: url,
    _body: opts.body ?? '{"month":"2026-01"}',
    _headers: opts.authorization === undefined ? {} : { authorization: opts.authorization },
  }
}

// h3 のヘルパはテスト用の軽量 event shape と噛み合わないので差し替える
// (`ichiban-proxy.test.ts` と同じ作法。createError は実体のまま — throw される
//  H3Error の statusCode を assert する)。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getRequestURL: (event: { _url: string }) => new URL(event._url),
    getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
      event.context.params?.[name],
    getHeader: (event: { _headers: Record<string, string> }, name: string) => event._headers[name],
    readRawBody: (event: { _body: string }) => Promise.resolve(event._body),
    setResponseStatus: (event: { __statusCode?: number }, code: number) => { event.__statusCode = code },
    setHeader: (event: { __responseHeaders: Record<string, string> }, name: string, value: string) => {
      event.__responseHeaders[name] = value
    },
  }
})

const ENV = {
  NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'client-id-x',
  ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'client-secret-x',
}

describe('kyuyo POST proxy (Refs #467, #677)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('CF-Access ヘッダと body を付けて POST し、応答をそのまま返す', async () => {
    fetchMock.mockResolvedValue(new Response('{"saved":112}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventWith(ENV, { body: '{"month":"2026-01","rows":[]}' })

    const out = await call(event)

    expect(out).toBe('{"saved":112}')
    expect(event.__statusCode).toBe(200)
    expect(event.__responseHeaders['Content-Type']).toBe('application/json')
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://rust-ichiban.mtamaramu.com/api/kyuyo/wage-snapshot')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"month":"2026-01","rows":[]}')
    expect(init.headers['CF-Access-Client-Id']).toBe('client-id-x')
    expect(init.headers['CF-Access-Client-Secret']).toBe('client-secret-x')
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  /** 認可は upstream (introspect + email allowlist) が担うので、JWT は素通しする。 */
  it('ブラウザの Authorization を素通し転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, { authorization: 'Bearer jwt-x' }))

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer jwt-x')
  })

  it('Authorization が無ければ付けない (upstream が 401 を返す)', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    const event = eventWith(ENV)
    await call(event)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBeUndefined()
    expect(event.__statusCode).toBe(401)
  })

  /** **upstream パスは `api/kyuyo/` 配下に固定** — ここが自由だと、CF Access Service
   * Token を持つ server 経由で rust 側の任意の POST 口を叩けてしまう。 */
  it('upstream パスは api/kyuyo/ 配下に固定される', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, { path: 'sync' }))

    expect(String(fetchMock.mock.calls[0]![0]))
      .toBe('https://rust-ichiban.mtamaramu.com/api/kyuyo/sync')
  })

  it('query string も転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, {
      path: 'sync',
      url: 'https://dtako.ippoan.org/api/kyuyo/sync?company=0100',
    }))

    expect(String(fetchMock.mock.calls[0]![0]))
      .toBe('https://rust-ichiban.mtamaramu.com/api/kyuyo/sync?company=0100')
  })

  it('upstream の非 2xx はそのまま passthrough する (400 を 500 に丸めない)', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"month は YYYY-MM"}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventWith(ENV)

    const out = await call(event)

    expect(event.__statusCode).toBe(400)
    expect(out).toBe('{"error":"month は YYYY-MM"}')
  })

  it('binding 未設定は 503', async () => {
    await expect(call(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('upstream への接続失敗は 502', async () => {
    fetchMock.mockRejectedValue(new Error('tunnel down'))
    await expect(call(eventWith(ENV))).rejects.toMatchObject({ statusCode: 502 })
  })

  it('body が上限を超えたら 413 で upstream を叩かない', async () => {
    const event = eventWith(ENV, { body: 'x'.repeat(MAX_BODY_BYTES + 1) })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 413 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
