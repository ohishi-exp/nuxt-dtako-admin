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

import handler from '../../server/api/netprint/run.post'

interface TestEvent {
  context: Record<string, unknown>
  path: string
  body?: unknown
  bodyThrows?: boolean
  node: { req: { url: string, headers: Record<string, string | undefined> }, res: { setHeader: (k: string, v: string) => void } }
}

function eventWith(env: Record<string, unknown>, body: unknown = {}, bodyThrows = false): TestEvent {
  const url = '/api/netprint/run'
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
  date: '2026-08-24',
  results: [{ kind: 'netprint', target: '27324455|1', ok: true, detail: 'HTTP 200: {"ok":true}' }],
}

function envWithRelay(fetchMock: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return { INTERNAL_SHARED_SECRET: 'secret-x', SCRAPER_RELAY: { fetch: fetchMock }, ...extra }
}

describe('POST /api/netprint/run', () => {
  beforeEach(() => {
    requireAuthMock.mockReset()
    requireAuthMock.mockResolvedValue({ sub: 'user-1' })
  })

  it('INTERNAL_SHARED_SECRET 未設定は 503 (relay も requireAuth も呼ばない)', async () => {
    await expect(call(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env 自体が無くても 503 になる', async () => {
    const event = { context: {}, path: '/x', node: { req: { url: '/x', headers: {} }, res: { setHeader: vi.fn() } } }
    await expect(call(event as unknown as TestEvent)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('INTERNAL_SHARED_SECRET が Secrets Store binding (.get()) でも解決する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse(RELAY_OK))
    const env = { INTERNAL_SHARED_SECRET: { get: async () => 'secret-store' }, SCRAPER_RELAY: { fetch: fetchMock } }
    await call(eventWith(env))
    expect(fetchMock.mock.calls[0]![1].headers['X-Alc-Proxy-Secret']).toBe('secret-store')
  })

  it('Secrets Store binding の .get() が null を返しても 503 になる', async () => {
    const env = { INTERNAL_SHARED_SECRET: { get: async () => null } }
    await expect(call(eventWith(env))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('未ログイン (requireAuth が投げる) はそのまま伝播する (relay を呼ばない)', async () => {
    const fetchMock = vi.fn()
    requireAuthMock.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
    await expect(call(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('requireAuth には auth-worker URL と secret を渡す (未設定なら本番既定)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse(RELAY_OK))
    await call(eventWith(envWithRelay(fetchMock)))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({
      authWorkerUrl: 'https://auth.ippoan.org',
      sharedSecret: 'secret-x',
    })
    await call(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth-staging.ippoan.org' })))
    expect(requireAuthMock.mock.calls[1]![1]).toMatchObject({ authWorkerUrl: 'https://auth-staging.ippoan.org' })
    await call(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[2]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  it('body の形式不正 (date / branch_cd 片方だけ) は 400 で relay を呼ばない', async () => {
    const fetchMock = vi.fn()
    const env = envWithRelay(fetchMock)
    await expect(call(eventWith(env, { date: '2026/08/24' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, { branch_cd: '1' }))).rejects.toMatchObject({ statusCode: 400 })
    await expect(call(eventWith(env, 'not an object'))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('body が JSON として読めない (readBody が投げる) のも 400', async () => {
    const fetchMock = vi.fn()
    await expect(call(eventWith(envWithRelay(fetchMock), undefined, true))).rejects.toMatchObject({ statusCode: 400 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SCRAPER_RELAY binding 未設定は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('検証した body だけを relay に送り、relay の JSON をそのまま返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse(RELAY_OK))
    const result = await call(eventWith(envWithRelay(fetchMock), {
      date: ' 2026-08-24 ',
      branch_cd: '1',
      channel_id: 'ch-1',
      comp_id: '',
      extra: 'ignored',
    }))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.internal/kintai-relay/netprint-run')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['X-Alc-Proxy-Secret']).toBe('secret-x')
    // trim 済み・空文字と未知のキーは落ちる
    expect(JSON.parse(init.body)).toEqual({ date: '2026-08-24', branch_cd: '1', channel_id: 'ch-1' })
    expect(result).toEqual(RELAY_OK)
  })

  it('body 省略 (全部 relay の既定) でも {} を送って通る', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse(RELAY_OK))
    await call(eventWith(envWithRelay(fetchMock), {}))
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({})
  })

  it('relay が {error} で非 2xx ならその status と `relay:` 前置のメッセージを返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ error: 'NETPRINT_TARGETS が未設定です' }, 400))
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(400)
    expect(text).toContain('relay: NETPRINT_TARGETS が未設定です')
  })

  // ★ 一部の営業所だけ失敗した 502 は results を持って返る。data に載せないと
  // 「どの営業所がなぜ失敗したか」が画面から消える。
  it('relay が 502 + results なら件数を要約しつつ data に応答本文を載せる', async () => {
    const relayBody = {
      ok: false,
      date: '2026-08-24',
      results: [
        { kind: 'netprint', target: '27324455|1', ok: true, detail: 'HTTP 200: {"ok":true}' },
        { kind: 'netprint', target: '27324455|8', ok: false, detail: 'HTTP 503: {"error":"LINEWORKS_BOT が未設定または不正です"}' },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue(relayResponse(relayBody, 502))
    const { statusCode, text, data } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(502)
    expect(text).toContain('2 件中 1 件の営業所が失敗しました')
    expect(data).toEqual(relayBody)
  })

  it('relay が非 2xx で本文が JSON でなくても status は保つ (HTTP 番号入りの既定文)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not json') },
    } as unknown as Response)
    const { statusCode, text } = await rejection(call(eventWith(envWithRelay(fetchMock))))
    expect(statusCode).toBe(502)
    expect(text).toContain('relay:')
    expect(text).toContain('502')
  })

  it('relay が 2xx なのに JSON でなければ 502 (null を返さない)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json') },
    } as unknown as Response)
    await expect(call(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 502 })
  })
})
