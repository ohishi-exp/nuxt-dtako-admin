import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import handler, { MAX_BODY_BYTES } from '../../server/api/kyuyo/[...path].post'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

function eventWith(
  env: Record<string, unknown>,
  opts: {
    path?: string
    url?: string
    body?: string
    authorization?: string
    cookies?: Record<string, string>
    devLogin?: boolean
  } = {},
) {
  const path = opts.path ?? 'wage-snapshot'
  const url = opts.url ?? `https://dtako.ippoan.org/api/kyuyo/${path}`
  return {
    context: {
      cloudflare: { env: opts.devLogin ? { ...env, DEV_LOGIN: 'true' } : env },
      params: { path },
    },
    __responseHeaders: {} as Record<string, string>,
    __statusCode: undefined as number | undefined,
    _url: url,
    // **`?? 既定` にしない** — `body: undefined` を「本当に undefined」として渡したい
    // テスト (`readRawBody` が文字列を返さない形) があるため。
    _body: 'body' in opts ? opts.body : '{"month":"2026-01"}',
    _headers: opts.authorization === undefined ? {} : { authorization: opts.authorization },
    _cookies: opts.cookies ?? {},
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
    getCookie: (event: { _cookies: Record<string, string> }, name: string) => event._cookies[name],
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
    const event = eventWith(ENV, { body: '{"month":"2026-01","rows":[]}', cookies: { logi_auth_token: 'jwt-cookie' } })

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

  /** 認可は upstream (introspect + email allowlist) が担うので、JWT はそのまま渡す。
   * **client はヘッダを組まない** — cookie から組むのが主経路 (Refs #375)。 */
  it('cookie (logi_auth_token) を Bearer に組んで転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, { cookies: { logi_auth_token: 'jwt-cookie' } }))

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer jwt-cookie')
  })

  /** デプロイ skew 用の後方互換 (古いバンドルのタブが残っている間だけ効く)。 */
  it('cookie が無ければ受領した Authorization を素通し転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, { authorization: 'Bearer jwt-x' }))

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer jwt-x')
  })

  it('cookie とヘッダが両方あれば cookie を優先する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, {
      cookies: { logi_auth_token: 'jwt-cookie' },
      authorization: 'Bearer jwt-header',
    }))

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer jwt-cookie')
  })

  /** ★ **陽性対照 3 本目** — dev cookie は `DEV_LOGIN === 'true'` のときだけ見る。 */
  it('dev cookie (logi_auth_token_dev) は DEV_LOGIN=true のときだけ Bearer に組む', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, { devLogin: true, cookies: { logi_auth_token_dev: 'jwt-dev' } }))

    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer jwt-dev')
  })

  /**
   * ★★ **この PR の本体** (Refs #988)。**書き込み**の口。
   *
   * 直す前はここで `Authorization` を付けずに upstream へ **POST を転送していた**。
   * **陰性対照**: 401 の 3 行を外すとこのテストが落ちる (直す前は `fetchMock` が
   * 1 回呼ばれ、`__statusCode` が 401 になる)。
   *
   * ★ **以前ここには「Access の裏の上流に書きに行けた」と書いていた。誤り** —
   * 上流 (`rust-ichibanboshi` の `kyuyo::introspect::authorize()`) は Bearer 無しを
   * **401 で弾く fail-closed** で、`/kyuyo/*` の 7 route が 7 本ともそこを通る
   * (2026-08-27 に `origin/main` = `a17067a` を実読。route の JSDoc 参照)。
   * **`fetch` が mock のテストから「上流に書けた」は導けない** — 測れるのは
   * 「この proxy が投げるかどうか」だけ。塞ぐ理由は**その防御が上流の実装依存で
   * この repo からは保証できない**ことであって、実際に書けたからではない。
   */
  it('★ 3 経路とも取れなければ 401 で止め、upstream を 1 回も叩かない (fail closed)', async () => {
    await expect(call(eventWith(ENV))).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: expect.stringContaining('ログインが必要です'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /** ★ **401 は body を読むより手前**。身元を取れない呼び出し元の body は 1 バイトも
   * 読まないので、上限超過でも 413 ではなく 401 が出る (「口の存在と上限」を身元なしに
   * 教えない)。上の 413 のテストと**対**。 */
  it('身元が無ければ body が上限超過でも 413 ではなく 401', async () => {
    await expect(call(eventWith(ENV, { body: 'x'.repeat(MAX_BODY_BYTES + 1) })))
      .rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /** ★ 上流由来の 401 は今までどおり passthrough する (こちらの 401 とは別物)。 */
  it('身元が在れば upstream の 401 は今までどおり passthrough する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }))
    const event = eventWith(ENV, { cookies: { logi_auth_token: 'jwt-cookie' } })
    await call(event)

    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe('Bearer jwt-cookie')
    expect(event.__statusCode).toBe(401)
  })

  /** **upstream パスは `api/kyuyo/` 配下に固定** — ここが自由だと、CF Access Service
   * Token を持つ server 経由で rust 側の任意の POST 口を叩けてしまう。 */
  it('upstream パスは api/kyuyo/ 配下に固定される', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, { path: 'sync', cookies: { logi_auth_token: 'jwt-cookie' } }))

    expect(String(fetchMock.mock.calls[0]![0]))
      .toBe('https://rust-ichiban.mtamaramu.com/api/kyuyo/sync')
  })

  it('query string も転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, {
      path: 'sync',
      url: 'https://dtako.ippoan.org/api/kyuyo/sync?company=0100',
      cookies: { logi_auth_token: 'jwt-cookie' },
    }))

    expect(String(fetchMock.mock.calls[0]![0]))
      .toBe('https://rust-ichiban.mtamaramu.com/api/kyuyo/sync?company=0100')
  })

  it('upstream の非 2xx はそのまま passthrough する (400 を 500 に丸めない)', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"month は YYYY-MM"}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventWith(ENV, { cookies: { logi_auth_token: 'jwt-cookie' } })

    const out = await call(event)

    expect(event.__statusCode).toBe(400)
    expect(out).toBe('{"error":"month は YYYY-MM"}')
  })

  it('binding 未設定は 503', async () => {
    await expect(call(eventWith({}, { cookies: { logi_auth_token: 'jwt-cookie' } }))).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * 以下 3 本は **`coverage_100.toml` に載せるため**の穴埋め (Refs #988)。
   * path 欠落 / body が文字列でない / Content-Type 無しの 3 arm が未通過だった。
   * **本番コードは 1 行も足していない** — 既に在る枝を通しただけ。
   */
  it('path パラメータが無ければ api/kyuyo/ の root に転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    const event = eventWith(ENV, { cookies: { logi_auth_token: 'jwt-cookie' } })
    event.context.params = {} as unknown as { path: string }

    await call(event)

    expect(new URL(String(fetchMock.mock.calls[0]![0])).pathname).toBe('/api/kyuyo/')
  })

  /** `readRawBody` は body 無しのとき `undefined` を返しうる。**空文字に倒して転送する**
   * (ここで 400 にしない — 形の検証は upstream の責務)。 */
  it('body が文字列でなければ空文字として転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventWith(ENV, {
      body: undefined as unknown as string,
      cookies: { logi_auth_token: 'jwt-cookie' },
    }))

    expect(fetchMock.mock.calls[0]![1].body).toBe('')
  })

  it('upstream が Content-Type を返さなければこちらも付けない', async () => {
    // `new Response('plain')` は `text/plain;charset=UTF-8` を自動で付けるので、
    // 「upstream が Content-Type を返さない」形を作るには消してやる必要がある。
    const res = new Response('plain', { status: 200 })
    res.headers.delete('content-type')
    fetchMock.mockResolvedValue(res)
    const event = eventWith(ENV, { cookies: { logi_auth_token: 'jwt-cookie' } })

    expect(await call(event)).toBe('plain')
    expect(event.__responseHeaders['Content-Type']).toBeUndefined()
  })

  it('upstream への接続失敗は 502', async () => {
    fetchMock.mockRejectedValue(new Error('tunnel down'))
    await expect(call(eventWith(ENV, { cookies: { logi_auth_token: 'jwt-cookie' } }))).rejects.toMatchObject({ statusCode: 502 })
  })

  /** ★ **身元が在る呼び出しの 413 は今までどおり** (Refs #988 で認証を body 読みより
   * 手前に置いたが、ログイン済みブラウザから見た挙動は 1 つも変わらない)。 */
  it('body が上限を超えたら 413 で upstream を叩かない', async () => {
    const event = eventWith(ENV, { body: 'x'.repeat(MAX_BODY_BYTES + 1), cookies: { logi_auth_token: 'jwt-cookie' } })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 413 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
