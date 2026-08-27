/**
 * `server/api/kyuyo/[...path].get.ts` — 給与読み取り proxy の JWT 解決 (Refs #375)。
 *
 * この route は #369 から在るがテストが無かった。#375 で「client が Bearer を組む」を
 * やめ、**cookie から組む**ように変えたので、その 1 点を落ちるテストで固定する。
 * CF Access / passthrough まわりは POST 版 (`kyuyo-post-proxy.test.ts`) と同型なので
 * ここでは重複させず、認証の解決だけを見る。
 *
 * ★ **#988 で「3 経路とも取れなければ 401 (fail closed)」を足した。**それまでは
 * `resolveBrowserAuthorization` が `null` でも **`Authorization` を付けずにそのまま
 * 転送していた**。**認可の正本は上流のまま** (introspect + email allowlist)、
 * 塞いだのは「渡す身元が無いのに転送する」1 点だけ。
 *
 * ★★ **ここのテストは「上流が何を返したか」を測っていない** — `fetch` は mock で、
 * 返す値はこちらが決めている。**上流が身元なしを通したことの証拠には一切ならない。**
 * 実際の上流は fail-closed (route の JSDoc に実読した根拠あり) なので、
 * このテストが固定するのは **「この proxy が、身元が無いと分かっているリクエストを
 * 上流へ投げない」**という**こちら側の性質だけ**。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import handler from '../../server/api/kyuyo/[...path].get'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

function eventWith(opts: { authorization?: string, cookies?: Record<string, string>, devLogin?: boolean } = {}) {
  return {
    context: {
      cloudflare: {
        env: {
          NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'client-id-x',
          ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'client-secret-x',
          ...(opts.devLogin ? { DEV_LOGIN: 'true' } : {}),
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

  /** ★ **陽性対照 3 本目** — dev cookie は `DEV_LOGIN === 'true'` のときだけ見る
   * (`browser-jwt.ts`)。#988 の 401 がこの経路を巻き込んでいないことを固定する。 */
  it('dev cookie (logi_auth_token_dev) は DEV_LOGIN=true のときだけ Bearer に組む', async () => {
    await call(eventWith({ devLogin: true, cookies: { logi_auth_token_dev: 'jwt-dev' } }))
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer jwt-dev')
  })

  /**
   * ★★ **この PR の本体** (Refs #988)。
   *
   * **直す前はここで `Authorization` を付けずに upstream へ転送していた。**
   * **陰性対照**: 401 の 3 行を外すとこのテストが落ちる (直す前のコードでは
   * `fetchMock` が 1 回呼ばれ、`out` が mock の本文になる)。
   *
   * ★ **測っているのは「投げないこと」だけ。**上流が身元なしをどう扱うかは
   * このテストの範囲外で、実際は fail-closed (401)。**この 1 本を「上流のデータが
   * 漏れていた証拠」として読まないこと。**
   *
   * **認可の正本は上流のまま**で、これは「渡す身元が無いときに黙って転送する」のを
   * 止めただけ。上流由来の 401/403 は今までどおり passthrough される。
   */
  it('★ 3 経路とも取れなければ 401 で止め、upstream を 1 回も叩かない (fail closed)', async () => {
    await expect(call(eventWith())).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: expect.stringContaining('ログインが必要です'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /** dev cookie が在っても `DEV_LOGIN` が立っていなければ身元にならない (= 401)。
   * 「dev cookie を見る」分岐の**もう一方の側**。 */
  it('DEV_LOGIN が無ければ dev cookie は身元にならず 401', async () => {
    await expect(call(eventWith({ cookies: { logi_auth_token_dev: 'jwt-dev' } })))
      .rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * 以下 3 本は **`coverage_100.toml` に載せるため**の穴埋め (Refs #988)。
   * この route は #375 当時「認証の解決だけを見る」方針でテストを絞っており、
   * upstream 失敗 / path 欠落 / Content-Type 無しの 3 arm が未通過だった。
   * **本番コードは 1 行も足していない** — 既に在る枝を通しただけ。
   */
  it('upstream への接続失敗は 502 (fetchIchiban の IchibanUpstreamError を写す)', async () => {
    fetchMock.mockRejectedValue(new Error('tunnel down'))
    await expect(call(eventWith({ cookies: { logi_auth_token: 'jwt-cookie' } })))
      .rejects.toMatchObject({ statusCode: 502 })
  })

  it('path パラメータが無ければ api/kyuyo/ の root に転送する', async () => {
    const event = eventWith({ cookies: { logi_auth_token: 'jwt-cookie' } })
    event.context.params = {} as unknown as { path: string }

    await call(event)

    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe('/api/kyuyo/')
  })

  it('upstream が Content-Type を返さなければこちらも付けない', async () => {
    // `new Response('plain')` は `text/plain;charset=UTF-8` を自動で付けるので、
    // 「upstream が Content-Type を返さない」形を作るには消してやる必要がある。
    const res = new Response('plain', { status: 200 })
    res.headers.delete('content-type')
    fetchMock.mockResolvedValue(res)
    const event = eventWith({ cookies: { logi_auth_token: 'jwt-cookie' } })

    expect(await call(event)).toBe('plain')
    expect(event.__responseHeaders['Content-Type']).toBeUndefined()
  })

  /** ★ **上流由来の 401 は今までどおり素通しする** — こちらの 401 (身元が無い) とは
   * 別物で、混ぜると「ログインし直せ」と「allowlist 外」が同じ見た目になる。 */
  it('身元が在れば upstream の 401 は今までどおり passthrough する', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }))
    const event = eventWith({ cookies: { logi_auth_token: 'jwt-cookie' } })

    const out = await call(event)

    expect(event.__statusCode).toBe(401)
    expect(out).toBe('{"error":"unauthorized"}')
  })
})
