/**
 * `server/api/kyuyo/[...path].get.ts` — 給与読み取り proxy の JWT 解決 (Refs #375)。
 *
 * この route は #369 から在るがテストが無かった。#375 で「client が Bearer を組む」を
 * やめ、**cookie から組む**ように変えたので、その 1 点を落ちるテストで固定する。
 * CF Access / passthrough まわりは POST 版 (`kyuyo-post-proxy.test.ts`) と同型なので
 * ここでは重複させず、認証の解決だけを見る。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import handler from '../../server/api/kyuyo/[...path].get'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

function eventWith(opts: { authorization?: string, cookies?: Record<string, string> } = {}) {
  return {
    context: {
      cloudflare: {
        env: {
          NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'client-id-x',
          ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'client-secret-x',
        },
      },
      params: { path: 'payroll' },
    },
    __responseHeaders: {} as Record<string, string>,
    __statusCode: undefined as number | undefined,
    _url: 'https://dtako.ippoan.org/api/kyuyo/payroll?company=0100&month=2026-07',
    _headers: opts.authorization === undefined ? {} : { authorization: opts.authorization },
    _cookies: opts.cookies ?? {},
  }
}

// h3 のヘルパはテスト用の軽量 event shape と噛み合わないので差し替える
// (`kyuyo-post-proxy.test.ts` と同じ作法)。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getRequestURL: (event: { _url: string }) => new URL(event._url),
    getRouterParam: (event: { context: { params?: Record<string, string> } }, name: string) =>
      event.context.params?.[name],
    getHeader: (event: { _headers: Record<string, string> }, name: string) => event._headers[name],
    getCookie: (event: { _cookies: Record<string, string> }, name: string) => event._cookies[name],
    setResponseStatus: (event: { __statusCode?: number }, code: number) => { event.__statusCode = code },
    setHeader: (event: { __responseHeaders: Record<string, string> }, name: string, value: string) => {
      event.__responseHeaders[name] = value
    },
  }
})

describe('kyuyo GET proxy の JWT 解決 (Refs #369, #375)', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response('{"rows":[]}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cookie (logi_auth_token) を Bearer に組んで upstream へ渡す', async () => {
    await call(eventWith({ cookies: { logi_auth_token: 'jwt-cookie' } }))

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://rust-ichiban.mtamaramu.com/api/kyuyo/payroll?company=0100&month=2026-07')
    expect(init.headers.Authorization).toBe('Bearer jwt-cookie')
    expect(init.headers['CF-Access-Client-Id']).toBe('client-id-x')
  })

  /** デプロイ skew 用の後方互換 (古いバンドルのタブが残っている間だけ効く)。 */
  it('cookie が無ければ受領した Authorization を素通し転送する', async () => {
    await call(eventWith({ authorization: 'Bearer jwt-header' }))

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer jwt-header')
  })

  it('cookie とヘッダが両方あれば cookie を優先する', async () => {
    await call(eventWith({
      cookies: { logi_auth_token: 'jwt-cookie' },
      authorization: 'Bearer jwt-header',
    }))

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer jwt-cookie')
  })

  /** 認可は upstream (introspect + email allowlist) が持つので、ここでは弾かない。 */
  it('どちらも無ければ Authorization を付けずに転送する (upstream が 401 を返す)', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    const event = eventWith()

    const out = await call(event)

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBeUndefined()
    expect(event.__statusCode).toBe(401)
    expect(out).toBe('{"error":"unauthorized"}')
  })
})
