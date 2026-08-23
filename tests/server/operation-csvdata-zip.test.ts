import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 の defineEventHandler は identity に差し替える (他の server route テストと同じ)。
// createError は実体を残し、throw された H3Error の statusCode を assert する。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import handler from '../../server/api/operations/[unko]/csvdata-zip.get'

const UNKO_22 = '2607060418590000001109'

interface TestEvent {
  context: Record<string, unknown>
  path: string
  node: { req: { url: string, headers: Record<string, string | undefined> }, res: { setHeader: (k: string, v: string) => void } }
}

const setHeaderMock = vi.fn()

function eventWith(env: Record<string, unknown>, unko = UNKO_22, query = ''): TestEvent {
  const url = `/api/operations/${unko}/csvdata-zip${query}`
  return {
    context: { cloudflare: { env }, params: { unko } },
    path: url,
    node: { req: { url, headers: {} }, res: { setHeader: setHeaderMock } },
  }
}

const call = (event: TestEvent) => (handler as unknown as (e: TestEvent) => Promise<unknown>)(event)

/**
 * 投げられた H3Error の status と**メッセージ本文**を取り出す。
 * h3 は `statusMessage` を送出時に sanitize する (非 ASCII が落ちうる) ので、
 * メッセージの assert は `statusMessage`/`message` の両方を繋いだ文字列に対して
 * **ASCII の目印**で行う (日本語部分の一致に依存しない)。
 */
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

/** relay 応答のモック (h3 の `setResponseHeader` は node.res.setHeader を触る)。 */
function relayResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

/** 中身が `zip` の 4 bytes (base64)。zip として正しい必要は無い — 素通しの確認だけ。 */
const ZIP_BASE64 = 'emlwIQ=='

function okRelay(overrides: Record<string, unknown> = {}) {
  return relayResponse({
    ok: true,
    bytes: 5,
    zip_base64: ZIP_BASE64,
    omitted: false,
    limit_bytes: 1_000_000,
    entries: ['KUDGFUL.csv', 'KUDGIVT.csv', 'KUDGURI.csv', 'SokudoData.csv'],
    ...overrides,
  })
}

function envWithRelay(fetchMock: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return { INTERNAL_SHARED_SECRET: 'secret-x', SCRAPER_RELAY: { fetch: fetchMock }, ...extra }
}

describe('GET /api/operations/:unko/csvdata-zip', () => {
  beforeEach(() => {
    requireAuthMock.mockReset()
    requireAuthMock.mockResolvedValue({ sub: 'user-1' })
    setHeaderMock.mockClear()
  })

  it('INTERNAL_SHARED_SECRET 未設定は 503 (relay も requireAuth も呼ばない)', async () => {
    await expect(call(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env 自体が無くても 503 になる', async () => {
    const event = { context: {}, path: '/x', node: { req: { url: '/x', headers: {} }, res: { setHeader: setHeaderMock } } }
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

  it('未ログイン (requireAuth が投げる) はそのまま伝播する', async () => {
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
    // 空文字は未設定と同じ扱い (本番既定へフォールバック)
    await call(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[2]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  it('運行NO が 22/23 桁の数字でなければ 400', async () => {
    const fetchMock = vi.fn()
    await expect(call(eventWith(envWithRelay(fetchMock), '12345'))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('運行NO の先頭 12 桁が日時として不正なら 400', async () => {
    const fetchMock = vi.fn()
    const bad = `261306041859${UNKO_22.slice(12)}`
    await expect(call(eventWith(envWithRelay(fetchMock), bad))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SCRAPER_RELAY binding 未設定は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('運行NO から ope_no_22 / start_ope を組んで relay を叩き、zip を返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRelay())
    const result = await call(eventWith(envWithRelay(fetchMock), `${UNKO_22}1`)) as Uint8Array
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.internal/kintai-relay/operation-zip')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ ope_no_22: UNKO_22, start_ope: '2026/07/06 4:18:59' })
    expect(new TextDecoder().decode(result)).toBe('zip!')
    const headers = Object.fromEntries(setHeaderMock.mock.calls)
    expect(headers['content-type']).toBe('application/zip')
    // 23 桁で叩いたら 23 桁のままファイル名にする (画面の表示と一致させる)
    expect(headers['content-disposition']).toBe(`attachment; filename="csvdata-${UNKO_22}1.zip"`)
    expect(headers['cache-control']).toBe('no-store')
    expect(headers['x-zip-entries']).toBe('KUDGFUL.csv,KUDGIVT.csv,KUDGURI.csv,SokudoData.csv')
  })

  it('?start_ope= が正しい形式ならそちらを優先する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRelay())
    await call(eventWith(envWithRelay(fetchMock), UNKO_22, `?start_ope=${encodeURIComponent('2026/07/06 5:00:00')}`))
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).start_ope).toBe('2026/07/06 5:00:00')
  })

  it('?start_ope= の形式が不正なら 400 (運行NO からの導出に落とさない)', async () => {
    const fetchMock = vi.fn()
    await expect(
      call(eventWith(envWithRelay(fetchMock), UNKO_22, `?start_ope=${encodeURIComponent('2026-07-06T05:00:00')}`)),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('?start_ope= が空文字なら運行NO から導出する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRelay())
    await call(eventWith(envWithRelay(fetchMock), UNKO_22, '?start_ope='))
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).start_ope).toBe('2026/07/06 4:18:59')
  })

  it('relay が非 2xx ならその status とメッセージを返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ error: 'theearth セッション切れ' }, 401))
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(401)
    expect(text).toContain('relay:')
  })

  it('relay が非 2xx で本文が JSON でなくても status は保つ', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json') },
    } as unknown as Response)
    await expect(call(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 502 })
  })

  it('ok !== true / omitted / zip_base64 欠落 は 502 (空の zip を返さない)', async () => {
    const env = (body: unknown) => envWithRelay(vi.fn().mockResolvedValue(relayResponse(body)))
    await expect(call(eventWith(env({ ok: false, error: '取得に失敗' })))).rejects.toMatchObject({ statusCode: 502 })
    // error すら無い応答でも黙って通さない
    await expect(call(eventWith(env({})))).rejects.toMatchObject({ statusCode: 502 })
    await expect(
      call(eventWith(envWithRelay(vi.fn().mockResolvedValue(okRelay({ omitted: true, zip_base64: null }))))),
    ).rejects.toMatchObject({ statusCode: 502 })
    await expect(
      call(eventWith(envWithRelay(vi.fn().mockResolvedValue(okRelay({ zip_base64: null }))))),
    ).rejects.toMatchObject({ statusCode: 502 })
    const noBase64 = await rejection(
      call(eventWith(envWithRelay(vi.fn().mockResolvedValue(okRelay({ zip_base64: null }))))),
    )
    expect(noBase64.text).toContain('zip_base64')
  })

  it('omitted の 502 は実サイズと上限をメッセージに出す (欠落時は ?)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRelay({ omitted: true, zip_base64: null, bytes: undefined, limit_bytes: undefined }))
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(502)
    // bytes / limit_bytes が欠落した応答でも `?` を出して黙らない
    expect(text).toContain('? bytes')
  })

  it('X-Zip-Entries は配列でない / 不審な名前を落とす', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okRelay({ entries: ['KUDGURI.csv', 'bad\r\nname.csv', 42] }))
    await call(eventWith(envWithRelay(fetchMock)))
    expect(Object.fromEntries(setHeaderMock.mock.calls)['x-zip-entries']).toBe('KUDGURI.csv')

    setHeaderMock.mockClear()
    const fetchMock2 = vi.fn().mockResolvedValue(okRelay({ entries: 'KUDGURI.csv' }))
    await call(eventWith(envWithRelay(fetchMock2)))
    expect(Object.fromEntries(setHeaderMock.mock.calls)['x-zip-entries']).toBe('')
  })
})
