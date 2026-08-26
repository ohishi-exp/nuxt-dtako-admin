/**
 * `server/api/kyuyo-master/refresh{,-full}.post.ts` の JWT 解決 (Refs #369, #375)。
 *
 * この 2 route はテストが無かった。#375 で「client が `Authorization: Bearer` を組む」の
 * をやめ **cookie から組む**ようにしたので、その 1 点 (と、どこからも token を取れない
 * ときの 401) を落ちるテストで固定する。D1 の突き合わせロジックは本 PR の対象外なので
 * ここでは踏み込まない (companies を空にして auth の道だけ通す)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const listKyuyoCompanies = vi.fn()
const upsertKyuyoCompany = vi.fn()

vi.mock('../../server/utils/kyuyo-master-db', () => ({
  getKyuyoDb: (event: { _db?: unknown }) => event._db ?? null,
  listKyuyoCompanies: (...args: unknown[]) => listKyuyoCompanies(...args),
  upsertKyuyoCompany: (...args: unknown[]) => upsertKyuyoCompany(...args),
}))

// h3 のヘルパはテスト用の軽量 event shape と噛み合わないので差し替える
// (`kyuyo-post-proxy.test.ts` と同じ作法。createError は実体のまま)。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getHeader: (event: { _headers: Record<string, string> }, name: string) => event._headers[name],
    getCookie: (event: { _cookies: Record<string, string> }, name: string) => event._cookies[name],
  }
})

const { default: refresh } = await import('../../server/api/kyuyo-master/refresh.post')
const { default: refreshFull } = await import('../../server/api/kyuyo-master/refresh-full.post')

const call = (handler: unknown, event: unknown) =>
  (handler as (e: unknown) => Promise<unknown>)(event)

function eventWith(opts: { authorization?: string, cookies?: Record<string, string> } = {}) {
  return {
    context: {
      cloudflare: {
        env: {
          NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: 'client-id-x',
          ICHIBAN_CF_ACCESS_CLIENT_SECRET: 'client-secret-x',
        },
      },
    },
    _db: { prepare: () => ({}) },
    _headers: opts.authorization === undefined ? {} : { authorization: opts.authorization },
    _cookies: opts.cookies ?? {},
  }
}

const ROUTES: Array<{ label: string, handler: unknown, upstream: string, payload: string }> = [
  {
    label: 'refresh (差分)',
    handler: refresh,
    upstream: 'https://rust-ichiban.mtamaramu.com/api/kyuyo/databases',
    payload: '{"databases":[]}',
  },
  {
    label: 'refresh-full (フル)',
    handler: refreshFull,
    upstream: 'https://rust-ichiban.mtamaramu.com/api/kyuyo/companies',
    payload: '{"companies":[],"warnings":[]}',
  },
]

describe.each(ROUTES)('kyuyo-master $label の JWT 解決 (Refs #375)', ({ handler, upstream, payload }) => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    listKyuyoCompanies.mockReset().mockResolvedValue([])
    upsertKyuyoCompany.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValue(new Response(payload, { status: 200 }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cookie (logi_auth_token) を Bearer に組んで upstream へ渡す', async () => {
    await call(handler, eventWith({ cookies: { logi_auth_token: 'jwt-cookie' } }))

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe(upstream)
    expect(init.headers.Authorization).toBe('Bearer jwt-cookie')
  })

  /** デプロイ skew 用の後方互換 (古いバンドルのタブが残っている間だけ効く)。 */
  it('cookie が無ければ受領した Authorization を素通し転送する', async () => {
    await call(handler, eventWith({ authorization: 'Bearer jwt-header' }))

    const [, init] = fetchMock.mock.calls[0]!
    expect(init.headers.Authorization).toBe('Bearer jwt-header')
  })

  /** **文言も直す**: client がヘッダを組まなくなったので「Authorization: Bearer が
   * 必要です」は読み手を存在しないヘッダ探しへ送る (PR の基準 (7))。 */
  it('cookie もヘッダも無ければ 401 で upstream を叩かない', async () => {
    await expect(call(handler, eventWith())).rejects.toMatchObject({
      statusCode: 401,
      statusMessage: 'ログインが必要です (認証 cookie が届いていません)',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('DTAKO_DB binding が無ければ 401 より先に 503', async () => {
    const event = { ...eventWith({ cookies: { logi_auth_token: 'jwt-cookie' } }), _db: null }
    await expect(call(handler, event)).rejects.toMatchObject({ statusCode: 503 })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
