import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 の defineEventHandler は identity に差し替える (他の server route テストと同じ)。
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

import handler from '../../server/api/driver-master/run.post'

interface TestEvent {
  context: Record<string, unknown>
  path: string
  body?: unknown
  bodyThrows?: boolean
  node: { req: { url: string, headers: Record<string, string | undefined> }, res: { setHeader: (k: string, v: string) => void } }
}

function eventWith(env: Record<string, unknown>, body: unknown = {}, bodyThrows = false): TestEvent {
  const url = '/api/driver-master/run'
  return {
    context: { cloudflare: { env } },
    path: url,
    body,
    bodyThrows,
    node: { req: { url, headers: {} }, res: { setHeader: vi.fn() } },
  }
}

const call = (event: TestEvent) => (handler as unknown as (e: TestEvent) => Promise<unknown>)(event)

/** 投げられた H3Error の status / メッセージ / data。 */
async function rejection(p: Promise<unknown>): Promise<{ statusCode: number, text: string, data: unknown }> {
  try {
    await p
  }
  catch (e) {
    const err = e as { statusCode?: number, statusMessage?: string, message?: string, data?: unknown }
    return { statusCode: err.statusCode ?? 0, text: `${err.statusMessage ?? ''} ${err.message ?? ''}`, data: err.data }
  }
  throw new Error('例外が投げられませんでした')
}

function relayResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

const RELAY_OK = {
  ok: true,
  comp_id: '27324455',
  rows: 12,
  items: 12,
  created: 1,
  updated: 11,
  skipped: [],
  unreadable: null,
  theearth_logins: 1,
  theearth_kicked: false,
}

function envWithRelay(fetchMock: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return { INTERNAL_SHARED_SECRET: 'secret-x', SCRAPER_RELAY: { fetch: fetchMock }, ...extra }
}

describe('POST /api/driver-master/run', () => {
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

  it('body が JSON として読めない (readBody が投げる) のは 400', async () => {
    const fetchMock = vi.fn()
    await expect(call(eventWith(envWithRelay(fetchMock), undefined, true))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('comp_id が 8 桁の数字でなければ 400 (relay を呼ばない)', async () => {
    const fetchMock = vi.fn()
    const env = envWithRelay(fetchMock)
    await expect(call(eventWith(env, { comp_id: '1234567' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { comp_id: '123456789' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { comp_id: 'abcdefgh' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { comp_id: 27324455 }))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('comp_id 省略 (空 body) は relay に {} を送る (relay 側の KINTAI_COMP_ID フォールバック)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse(RELAY_OK))
    await call(eventWith(envWithRelay(fetchMock), {}))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.internal/kintai-relay/driver-master-run')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({})
  })

  it('comp_id (8桁) を trim して relay へ送り、relay の JSON をそのまま返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse(RELAY_OK))
    const result = await call(eventWith(envWithRelay(fetchMock), { comp_id: ' 27324455 ' }))
    const [, init] = fetchMock.mock.calls[0]!
    expect(JSON.parse(init.body)).toEqual({ comp_id: '27324455' })
    expect(init.headers['X-Alc-Proxy-Secret']).toBe('secret-x')
    expect(result).toEqual(RELAY_OK)
  })

  it('SCRAPER_RELAY binding 未設定は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }, { comp_id: '27324455' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('relay が {error} で非 2xx ならその status と relay: 前置のメッセージを返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ ok: false, comp_id: '27324455', error: 'theearth ログインに失敗しました' }, 502))
    const { statusCode, text, data } = await rejection(call(eventWith(envWithRelay(fetchMock), { comp_id: '27324455' })))
    expect(statusCode).toBe(502)
    expect(text).toContain('relay: theearth ログインに失敗しました')
    expect(data).toMatchObject({ ok: false, comp_id: '27324455' })
  })

  it('relay が非 2xx で本文が JSON でなくても既定文 (HTTP 番号入り) になる', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error('not json') } } as unknown as Response)
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock), { comp_id: '27324455' })))
    expect(statusCode).toBe(500)
    expect(text).toContain('relay:')
    expect(text).toContain('500')
  })

  it('relay が 2xx なのに JSON でなければ 502 (null を返さない)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('not json') } } as unknown as Response)
    await expect(call(eventWith(envWithRelay(fetchMock), { comp_id: '27324455' }))).rejects.toMatchObject({ statusCode: 502 })
  })
})
