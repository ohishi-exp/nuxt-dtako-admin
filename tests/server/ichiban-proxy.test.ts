import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import handler from '../../server/api/ichiban/[...path].get'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)

/**
 * `requireAuth` (Refs #988) が通る前提の event。**`INTERNAL_SHARED_SECRET` を既定で
 * 載せる** — CF Access binding の 503 を見るテストが、認証側の 503 で先に落ちて
 * 「別の理由の 503」を緑にしてしまわないようにする。認証側だけを見たいテストは
 * `opts.env` で env を丸ごと差し替える。
 */
function eventWith(env: Record<string, unknown>, opts: { path?: string, url?: string, env?: Record<string, unknown> } = {}) {
  const path = opts.path ?? 'sales/vehicle-daily'
  const url = opts.url ?? `https://dtako.ippoan.org/api/ichiban/${path}?vehicle=101&from=2026-06-01`
  return {
    context: {
      cloudflare: { env: opts.env ?? { INTERNAL_SHARED_SECRET: 'secret', ...env } },
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
    requireAuthMock.mockReset()
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID/SECRET が両方あれば upstream に CF-Access ヘッダ付きで転送する', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventWith({
      NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'client-id-x',
      ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'client-secret-x',
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
      NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a',
      ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b',
      NUXT_ICHIBAN_API_URL: 'https://ichiban-staging.example.com',
    })

    await call(event)

    const [url] = fetchMock.mock.calls[0]! as [URL]
    expect(url.origin).toBe('https://ichiban-staging.example.com')
  })

  it('Secrets Store binding (.get()) 形式でも解決する', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))
    const event = eventWith({
      NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: { get: async () => 'from-store-id' },
      ICHIBAN_CF_ACCESS_CLIENT_SECRET: { get: async () => 'from-store-secret' },
    })

    await call(event)

    const [, init] = fetchMock.mock.calls[0]! as [URL, RequestInit]
    expect((init.headers as Record<string, string>)['CF-Access-Client-Id']).toBe('from-store-id')
    expect((init.headers as Record<string, string>)['CF-Access-Client-Secret']).toBe('from-store-secret')
  })

  it('NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID 未設定なら 503 で弾き fetch しない', async () => {
    const event = eventWith({ ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ICHIBAN_CF_ACCESS_CLIENT_SECRET 未設定なら 503 で弾き fetch しない', async () => {
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a' })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Secrets Store binding.get() が reject する場合も未設定として 503', async () => {
    const event = eventWith({
      NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: { get: async () => { throw new Error('not found') } },
      ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b',
    })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('本文がある非 2xx は status も本文もそのまま返す (意味づけしない)', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"bad request"}', {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })

    const body = await call(event)

    expect(event.__statusCode).toBe(400)
    expect(body).toBe('{"error":"bad request"}')
  })

  it('fetch 自体が失敗 (tunnel down 等) したら 502 を返す', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })

    await expect(call(event)).rejects.toMatchObject({ statusCode: 502 })
  })

  it('fetch が Error でない値で reject しても 502 (String() でメッセージ化)', async () => {
    fetchMock.mockRejectedValue('connection refused')
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })

    await expect(call(event)).rejects.toMatchObject({
      statusCode: 502,
      statusMessage: expect.stringContaining('connection refused'),
    })
  })

  /** env がまるごと無い形。**いまは認証側 (`INTERNAL_SHARED_SECRET`) の 503 が先に出る** —
   * #988 で認証を上流 fetch より手前に置いたため。どちらにせよ「binding 未設定は 503、
   * upstream は叩かない」は変わらない。 */
  it('cloudflare.env が無くても binding 未設定として 503 で弾き fetch しない', async () => {
    const event = { context: { params: { path: 'x' } }, _url: 'https://dtako.ippoan.org/api/ichiban/x' }
    await expect(call(event)).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('Secrets Store binding.get() が空値解決 (undefined) の場合も未設定として 503', async () => {
    const event = eventWith({
      NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: { get: async () => undefined as unknown as string },
      ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b',
    })
    await expect(call(event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('path パラメータが無ければ base の root に転送する', async () => {
    fetchMock.mockResolvedValue(new Response('ok', { status: 200 }))
    const event = eventWith(
      { NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' },
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
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })

    await call(event)

    expect(event.__responseHeaders['Content-Type']).toBeUndefined()
  })
  /**
   * ★ 本文が空の非 2xx にだけ、こちら側で日本語の理由を作る (Refs #900)。
   *
   * 一番星はエラー側が素の `StatusCode` なので**本文を 1 バイトも返さない**。
   * そのまま素通しすると画面に出るのは ofetch が組んだ `[GET] "…": 503` だけで、
   * 「一番星が落ちた」が 1 文字も出ない (実測: dev + スタブ upstream)。
   *
   * **文言に status を入れないこと** — 画面側の `describeApiError` が
   * `${statusCode} ${理由}` で組むので、入れると status が 2 回出る。
   */
  it('本文が空の 503 には日本語の理由を作って返す (status は変えない)', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 503 }))
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })

    const body = await call(event) as string

    expect(event.__statusCode).toBe(503)
    expect(event.__responseHeaders['Content-Type']).toBe('application/json')
    const parsed = JSON.parse(body) as { error: string }
    expect(parsed.error).toContain('一番星 API が応答しませんでした')
    // どの口が落ちたか分かるように upstream のパスを載せる
    expect(parsed.error).toContain('/sales/vehicle-daily')
    // 理由が無いのは画面のバグではなく上流の仕様、と言い切る
    expect(parsed.error).toContain('一番星が理由を返していません')
    // ★ status は文言に入れない (画面側が前置するため)
    expect(parsed.error).not.toContain('503')
  })

  it('本文が空の 400 は「リクエストを拒否」、500 は「内部エラー」と書き分ける', async () => {
    const env = { NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' }

    fetchMock.mockResolvedValue(new Response('', { status: 400 }))
    const bad = JSON.parse(await call(eventWith(env)) as string) as { error: string }
    expect(bad.error).toContain('一番星 API がリクエストを拒否しました')

    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    const oops = JSON.parse(await call(eventWith(env)) as string) as { error: string }
    expect(oops.error).toContain('一番星 API が内部エラーで失敗しました')
  })

  it('空白だけの本文も「空」として扱う', async () => {
    fetchMock.mockResolvedValue(new Response('  \n ', { status: 503 }))
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })

    const parsed = JSON.parse(await call(event) as string) as { error: string }

    expect(parsed.error).toContain('一番星 API が応答しませんでした')
  })

  /** ★ 陰性対照 (Refs #900)。**上流が理由を持っているならそれが正**で、書き換えない。 */
  it('★ 本文がある 503 は、理由を作らず 1 文字も書き換えない', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"vehicle は必須です"}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })

    const body = await call(event)

    expect(body).toBe('{"error":"vehicle は必須です"}')
    expect(body).not.toContain('一番星 API が応答しませんでした')
  })

  /** ★ 陰性対照。**2xx の空本文は正常**なので触らない (204 等)。 */
  it('本文が空でも 2xx なら何も足さない', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 200 }))
    const event = eventWith({ NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'a', ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'b' })

    const body = await call(event)

    expect(body).toBe('')
    expect(event.__statusCode).toBe(200)
  })
})

/**
 * ★ **`requireAuth` を入れた 1 点** (Refs #988)。
 *
 * この route は「呼び出し元の身元を一切見ずに、CF Access Service Token を付けて
 * 上流へ丸ごと転送する」classic な confused deputy だった — 前段は Cloudflare Access
 * だけで、それは edge の設定であって**この repo が意図して置いた防御ではない**。
 *
 * **陰性対照 (2026-08-27 実測)**: `requireAuth` の 3 行を外すと、この describe の
 * 4 本 (401 / 503 / secret 解決 / authWorkerUrl) が落ちる。とくに 1 本目は
 * 直す前のコードでは **200 が返り upstream が 1 回叩かれる**。
 *
 * ★ **`fetch` は mock なので、このテスト単体は「上流が答えたか」を測っていない。**
 * ただしこの route については**上流側にも認可の段が無い**ことを別途実読で確認済み
 * (`ohishi-exp/rust-ichibanboshi` `origin/main` = `a17067a`。`authorize()` を呼ぶのは
 * `src/routes/kyuyo.rs` だけで、全体に掛かる auth layer も無い) — なので
 * 「前段は実質 Cloudflare Access だけだった」は成り立つ。**根拠はテストではなく
 * そちらの実読**であることを混ぜないこと。
 *
 * 姉妹の `/api/kyuyo/**` が `requireAuth` ではなく「渡す身元が無ければ 401」なのは
 * 機構の違い (route の JSDoc 参照) — あちらは認可の正本が上流にあり (しかも上流は
 * fail-closed)、こちらは上流へ渡す身元をそもそも持たない。
 */
describe('ichiban proxy の認可 (Refs #988)', () => {
  const fetchMock = vi.fn()
  const ENV = {
    INTERNAL_SHARED_SECRET: 'secret',
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'client-id-x',
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'client-secret-x',
  }
  const eventFor = (env: Record<string, unknown>) => ({
    context: { cloudflare: { env }, params: { path: 'sales/vehicle-daily' } },
    __responseHeaders: {} as Record<string, string>,
    __statusCode: undefined as number | undefined,
    _url: 'https://dtako.ippoan.org/api/ichiban/sales/vehicle-daily?vehicle=101',
  })

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    requireAuthMock.mockReset()
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** ★★ **この PR の本体**。直す前は 200 が返り、upstream が 1 回叩かれていた。 */
  it('★ 未ログインは 401 で、upstream を 1 回も叩かない (Service Token を貸さない)', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    fetchMock.mockResolvedValue(new Response('{"ok":true}', { status: 200 }))

    await expect(call(eventFor(ENV))).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ログイン済みなら従来どおり転送する (陽性対照)', async () => {
    fetchMock.mockResolvedValue(new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventFor(ENV)

    expect(await call(event)).toBe('{"ok":true}')
    expect(event.__statusCode).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (requireAuth を呼ぶ前に落ちる)', async () => {
    const { INTERNAL_SHARED_SECRET: _drop, ...rest } = ENV
    await expect(call(eventFor(rest))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET は Secrets Store binding (.get()) でも解決する', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
    await call(eventFor({ ...ENV, INTERNAL_SHARED_SECRET: { get: async () => 'from-store' } }))

    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('authWorkerUrl は NUXT_PUBLIC_AUTH_WORKER_URL、空/非文字列なら auth.ippoan.org', async () => {
    // 3 回叩くので **毎回新しい Response** を返す (使い回すと body が二度読めない)。
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })))

    await call(eventFor({ ...ENV, NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventFor({ ...ENV, NUXT_PUBLIC_AUTH_WORKER_URL: '' }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventFor({ ...ENV, NUXT_PUBLIC_AUTH_WORKER_URL: 7 }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  /** ★ **passthrough の契約 (Refs #900) に触れていない**ことを固定する。
   * 401 は「本文が空の非 2xx に日本語の理由を作る」分岐より**手前**で投げるので、
   * upstream 由来の 401 は今までどおり素通しされる (両者は別物)。 */
  it('upstream 由来の 401 は今までどおり passthrough する (requireAuth の 401 とは別物)', async () => {
    fetchMock.mockResolvedValue(new Response('{"error":"upstream unauthorized"}', {
      status: 401,
      headers: { 'content-type': 'application/json' },
    }))
    const event = eventFor(ENV)

    expect(await call(event)).toBe('{"error":"upstream unauthorized"}')
    expect(event.__statusCode).toBe(401)
  })
})
