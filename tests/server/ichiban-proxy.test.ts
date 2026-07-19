import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import handler from '../../server/api/ichiban/[...path].get'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

function eventWith(env: Record<string, unknown>, opts: { path?: string, url?: string } = {}) {
  const path = opts.path ?? 'sales/vehicle-daily'
  const url = opts.url ?? `https://dtako.ippoan.org/api/ichiban/${path}?vehicle=101&from=2026-06-01`
  return {
    context: {
      cloudflare: { env },
      params: { path },
    },
    __responseHeaders: {} as Record<string, string>,
    __statusCode: undefined as number | undefined,
    _url: url,
  }
}

// getRequestURL / getRouterParam / setResponseStatus / setHeader は h3 の実装が
// event.node.req や webstandard Request context を読むため、テスト用の軽量な event
// shape とは噛み合わない。よってこれらをテスト用に差し替える (defineEventHandler /
// createError は実体のまま — createError が throw する H3Error の statusCode を assert する)。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getRequestURL: (event: { _url: string }) => new URL(event._url),
    getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
      event.context.params?.[name],
    setResponseStatus: (event: { __statusCode?: number }, code: number) => { event.__statusCode = code },
    setHeader: (event: { __responseHeaders: Record<string, string> }, name: string, value: string) => {
      event.__responseHeaders[name] = value
    },
  }
})

describe('ichiban proxy handler (thin passthrough, Refs #330)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('ICHIBAN_ACCESS_CLIENT_ID/SECRET が両方あれば upstream に CF-Access ヘッダ付きで転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventWith({
      ICHIBAN_ACCESS_CLIENT_ID: 'client-id-x',
      ICHIBAN_ACCESS_CLIENT_SECRET: 'client-secret-x',
    })

    const body = await call(event)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]! as [URL, RequestInit]
    expect(url.toString()).toBe('https://rust-ichiban.mtamaramu.com/sales/vehicle-daily?vehicle=101&from=2026-06-01')
    expect(init.method).toBe('GET')
    expect((init.headers as Record<string, string>)['CF-Access-Client-Id']).toBe('client-id-x')
    expect((init.headers as Record<string, string>)['CF-Access-Client-Secret']).toBe('client-secret-x')
    expect(body).toBe('{"ok":true}')
    expect(event.__statusCode).toBe(200)
    expect(event.__responseHeaders['Content-Type']).toBe('application/json')
  })

  it('NUXT_ICHIBAN_API_URL が設定されていればそちらを base に使う', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))
    const event = eventWith({
      ICHIBAN_ACCESS_CLIENT_ID: 'a',
      ICHIBAN_ACCESS_CLIENT_SECRET: 'b',
      NUXT_ICHIBAN_API_URL: 'https://ichiban-staging.example.com',
    })

    await call(event)

    const [url] = fetchMock.mock.calls[0]! as [URL]
    expect(url.origin).toBe('https://ichiban-staging.example.com')
  })

  it('Secrets Store binding (.get()) 形式でも解決する', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))
    const event = eventWith({
      ICHIBAN_ACCESS_CLIENT_ID: { get: async () => 'from-store-id' },
      ICHIBAN_ACCESS_CLIENT_SECRET: { get: async () => 'from-store-secret' },
    })

    await call(event)

    const [, init] = fetchMock.mock.calls[0]! as [URL, RequestInit]
    expect((init.headers as Record<string, string>)['CF-Access-Client-Id']).toBe('from-store-id')
    expect((init.headers as Record<string, string>)['CF-Access-Client-Secret']).toBe('from-store-secret')
  })

  it('ICHIBAN_ACCESS_CLIENT_ID 未設定なら 503 で弾き fetch しない', async () => {
    const event = eventWith({ ICHIBAN_ACCESS_CLIENT_SECRET: 'b' })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ICHIBAN_ACCESS_CLIENT_SECRET 未設定なら 503 で弾き fetch しない', async () => {
    const event = eventWith({ ICHIBAN_ACCESS_CLIENT_ID: 'a' })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Secrets Store binding.get() が reject する場合も未設定として 503', async () => {
    const event = eventWith({
      ICHIBAN_ACCESS_CLIENT_ID: { get: async () => { throw new Error('not found') } },
      ICHIBAN_ACCESS_CLIENT_SECRET: 'b',
    })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('upstream の非 2xx はそのまま passthrough する (意味づけしない)', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"bad request"}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventWith({ ICHIBAN_ACCESS_CLIENT_ID: 'a', ICHIBAN_ACCESS_CLIENT_SECRET: 'b' })

    const body = await call(event)

    expect(event.__statusCode).toBe(400)
    expect(body).toBe('{"error":"bad request"}')
  })

  it('fetch 自体が失敗 (tunnel down 等) したら 502 を返す', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const event = eventWith({ ICHIBAN_ACCESS_CLIENT_ID: 'a', ICHIBAN_ACCESS_CLIENT_SECRET: 'b' })

    await expect(call(event)).rejects.toMatchObject({ statusCode: 502 })
  })

  it('fetch が Error でない値で reject しても 502 (String() でメッセージ化)', async () => {
    fetchMock.mockRejectedValue('connection refused')
    const event = eventWith({ ICHIBAN_ACCESS_CLIENT_ID: 'a', ICHIBAN_ACCESS_CLIENT_SECRET: 'b' })

    await expect(call(event)).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: expect.stringContaining('connection refused'),
    })
  })

  it('cloudflare.env が無くても binding 未設定として 503 で弾く', async () => {
    const event = { context: { params: { path: 'x' } }, _url: 'https://dtako.ippoan.org/api/ichiban/x' }
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding.get() が空値解決 (undefined) の場合も未設定として 503', async () => {
    const event = eventWith({
      ICHIBAN_ACCESS_CLIENT_ID: { get: async () => undefined as unknown as string },
      ICHIBAN_ACCESS_CLIENT_SECRET: 'b',
    })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('path パラメータが無ければ base の root に転送する', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))
    const event = eventWith(
      { ICHIBAN_ACCESS_CLIENT_ID: 'a', ICHIBAN_ACCESS_CLIENT_SECRET: 'b' },
      { path: undefined as unknown as string, url: 'https://dtako.ippoan.org/api/ichiban' },
    )
    event.context.params = {} as unknown as { path: string }

    await call(event)

    const [url] = fetchMock.mock.calls[0]! as [URL]
    expect(url.pathname).toBe('/')
  })

  it('upstream 応答に content-type が無ければ Content-Type ヘッダを設定しない', async () => {
    // body なし応答は Response が Content-Type を自動付与しない (文字列 body だと
    // text/plain;charset=UTF-8 が自動で付くため、意図的に body なしにする)。
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))
    const event = eventWith({ ICHIBAN_ACCESS_CLIENT_ID: 'a', ICHIBAN_ACCESS_CLIENT_SECRET: 'b' })

    await call(event)

    expect(event.__responseHeaders['Content-Type']).toBeUndefined()
  })
})
