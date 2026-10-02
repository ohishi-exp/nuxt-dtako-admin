import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 の defineEventHandler は identity に差し替える (他の server route テストと同じ)。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import handler from '../../server/api/driver-master/status.get'

interface TestEvent {
  context: Record<string, unknown>
  path: string
  node: { req: { url: string, headers: Record<string, string | undefined> }, res: { setHeader: (k: string, v: string) => void } }
}

function eventWith(env: Record<string, unknown>, url = '/api/driver-master/status'): TestEvent {
  return {
    context: { cloudflare: { env } },
    path: url,
    node: { req: { url, headers: {} }, res: { setHeader: vi.fn() } },
  }
}

const call = (event: TestEvent) => (handler as unknown as (e: TestEvent) => Promise<unknown>)(event)

/** 投げられた H3Error の status とメッセージ。 */
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

/** relay が持つ記録の全部の欄 (画面が使わない欄を含む)。 */
const LAST_OK = {
  comp_id: '27324455',
  trigger: 'cron',
  started_at: '2026-03-02T03:00:01.000Z',
  finished_at: '2026-03-02T03:00:40.000Z',
  ok: true,
  rows: 12,
  items: 12,
  retired: 0,
  chunks: 1,
  created: 1,
  updated: 11,
  skipped: 0,
  error: null,
}

function envWithRelay(fetchMock: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return { INTERNAL_SHARED_SECRET: 'secret-x', SCRAPER_RELAY: { fetch: fetchMock }, ...extra }
}

describe('GET /api/driver-master/status', () => {
  beforeEach(() => {
    requireAuthMock.mockReset()
    requireAuthMock.mockResolvedValue({ sub: 'user-1', role: 'admin' })
  })

  it('INTERNAL_SHARED_SECRET 未設定は 503 (relay も requireAuth も呼ばない)', async () => {
    await expect(call(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('未ログイン (requireAuth が投げる) はそのまま伝播する (relay を呼ばない)', async () => {
    const fetchMock = vi.fn()
    requireAuthMock.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
    await expect(call(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('role が admin/payroll でなければ 403', async () => {
    requireAuthMock.mockResolvedValue({ sub: 'user-1', role: 'viewer' })
    const fetchMock = vi.fn()
    await expect(call(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 403 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SCRAPER_RELAY binding 未設定は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('いつも全社ぶんを読む: relay へ空の body を POST する (query の comp_id は読まない)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ results: [] }))
    const result = await call(eventWith(envWithRelay(fetchMock), '/api/driver-master/status?comp_id=27324455'))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.internal/kintai-relay/driver-master-status')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({})
    expect(init.headers['X-Alc-Proxy-Secret']).toBe('secret-x')
    expect(result).toEqual({ results: [] })
  })

  it('応答を絞って返す: last は 4 つの欄だけ、会社ごとの error は真偽だけ', async () => {
    const lastFailed = { ...LAST_OK, comp_id: '27324456', trigger: 'manual', ok: false, created: null, error: 'theearth ログインに失敗しました' }
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({
      results: [
        { comp_id: '27324455', last: LAST_OK },
        { comp_id: '27324456', last: lastFailed },
        { comp_id: '27324457', last: null },
        // 記録を読めなかった会社: relay は上流の本文を error に付ける
        { comp_id: '27324458', last: null, error: 'HTTP 500: <html>upstream body</html>' },
      ],
      extra: 'not returned',
    }))
    const result = await call(eventWith(envWithRelay(fetchMock)))
    expect(result).toEqual({
      results: [
        { comp_id: '27324455', last: { trigger: 'cron', finished_at: '2026-03-02T03:00:40.000Z', ok: true, error: null }, error: false },
        { comp_id: '27324456', last: { trigger: 'manual', finished_at: '2026-03-02T03:00:40.000Z', ok: false, error: 'theearth ログインに失敗しました' }, error: false },
        { comp_id: '27324457', last: null, error: false },
        { comp_id: '27324458', last: null, error: true },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('upstream body')
  })

  it('読めない欄は安全側に倒す: 未知の trigger は null・ok は true のときだけ・comp_id の無い要素は捨てる', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({
      results: [
        { comp_id: '27324455', last: { trigger: 'other', finished_at: 123, ok: 'yes', error: '' } },
        { comp_id: '27324456', last: 'not an object' },
        { comp_id: '27324457', last: null, error: null },
        { last: LAST_OK },
        { comp_id: '', last: LAST_OK },
        'not an object',
        null,
      ],
    }))
    expect(await call(eventWith(envWithRelay(fetchMock)))).toEqual({
      results: [
        { comp_id: '27324455', last: { trigger: null, finished_at: '', ok: false, error: null }, error: false },
        { comp_id: '27324456', last: null, error: false },
        { comp_id: '27324457', last: null, error: false },
      ],
    })
  })

  it('relay が {error} で非 2xx ならその status と relay: 前置のメッセージを返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ error: 'kintai-relay not configured' }, 503))
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(503)
    expect(text).toContain('relay: kintai-relay not configured')
  })

  it('relay が非 2xx で本文が JSON でなくても既定文 (HTTP 番号入り) になる', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json') } } as unknown as Response)
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(500)
    expect(text).toContain('relay: 乗務員マスタ同期の記録を取得できませんでした (HTTP 500)')
  })

  it('relay が 2xx なのに JSON でなければ 502', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('not json') } } as unknown as Response)
    await expect(call(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 502 })
  })

  it('relay の応答に results の配列が無ければ 502 (空の一覧として返さない)', async () => {
    for (const body of [{}, { results: 'x' }, [], 'text']) {
      const fetchMock = vi.fn().mockResolvedValue(relayResponse(body))
      const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
      expect(statusCode).toBe(502)
      expect(text).toContain('relay の応答を読めません')
    }
  })
})
