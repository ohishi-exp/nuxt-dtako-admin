import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 の defineEventHandler は identity に差し替える (`netprint-run-route.test.ts` と同じ)。
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

import getHandler from '../../server/api/netprint/targets.get'
import putHandler from '../../server/api/netprint/targets.put'
import { describeNetprintTargetsFailure } from '../../server/utils/netprint-targets'

const RCP_HONDA = 'e553efc9-4dff-4171-a06d-d3c127b14b94'
const TARGETS = [{ branch_cd: '1', recipient_id: RCP_HONDA, branch_name: '本社営業所' }]

interface TestEvent {
  context: Record<string, unknown>
  path: string
  body?: unknown
  bodyThrows?: boolean
  node: { req: { url: string, headers: Record<string, string | undefined> }, res: { setHeader: (k: string, v: string) => void } }
}

function eventWith(env: Record<string, unknown>, body: unknown = TARGETS, bodyThrows = false): TestEvent {
  const url = '/api/netprint/targets'
  return {
    context: { cloudflare: { env } },
    path: url,
    body,
    bodyThrows,
    node: { req: { url, headers: {} }, res: { setHeader: vi.fn() } },
  }
}

const callGet = (event: TestEvent) => (getHandler as unknown as (e: TestEvent) => Promise<unknown>)(event)
const callPut = (event: TestEvent) => (putHandler as unknown as (e: TestEvent) => Promise<unknown>)(event)

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

function envWithRelay(fetchMock: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return { INTERNAL_SHARED_SECRET: 'secret-x', SCRAPER_RELAY: { fetch: fetchMock }, ...extra }
}

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ sub: 'user-1', role: 'admin' })
})

describe('GET /api/netprint/targets', () => {
  it('INTERNAL_SHARED_SECRET 未設定は 503 (relay も requireAuth も呼ばない)', async () => {
    await expect(callGet(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env 自体が無くても 503 になる', async () => {
    const event = { context: {}, path: '/x', node: { req: { url: '/x', headers: {} }, res: { setHeader: vi.fn() } } }
    await expect(callGet(event as TestEvent)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取り出す', async () => {
    const fetchMock = vi.fn(async () => relayResponse(TARGETS))
    const env = { INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, SCRAPER_RELAY: { fetch: fetchMock } }
    expect(await callGet(eventWith(env))).toEqual(TARGETS)
    expect(fetchMock.mock.calls[0]![1]!.headers['X-Alc-Proxy-Secret']).toBe('from-store')
  })

  it('Secrets Store が空を返したら 503 (未設定と同じ扱い)', async () => {
    const env = { INTERNAL_SHARED_SECRET: { get: async () => null } }
    await expect(callGet(eventWith(env))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('SCRAPER_RELAY 未設定は 503 (requireAuth の後)', async () => {
    await expect(callGet(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }))).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).toHaveBeenCalled()
  })

  it('未ログイン (requireAuth の throw) はそのまま伝わる', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
    const fetchMock = vi.fn()
    await expect(callGet(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('relay の GET を secret 付きで叩き、KV の生 JSON をそのまま返す', async () => {
    const fetchMock = vi.fn(async () => relayResponse(TARGETS))
    expect(await callGet(eventWith(envWithRelay(fetchMock)))).toEqual(TARGETS)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.internal/kintai-relay/netprint-targets')
    expect(init!.method).toBe('GET')
    expect(init!.headers['X-Alc-Proxy-Secret']).toBe('secret-x')
  })

  it('未設定なら [] が返る (「読めなかった」と区別できる)', async () => {
    const fetchMock = vi.fn(async () => relayResponse([]))
    expect(await callGet(eventWith(envWithRelay(fetchMock)))).toEqual([])
  })

  it('auth-worker の URL は var 優先、無ければ本番の既定', async () => {
    const fetchMock = vi.fn(async () => relayResponse([]))
    await callGet(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.dev.example' })))
    expect(requireAuthMock.mock.calls[0]![1].authWorkerUrl).toBe('https://auth.dev.example')
    await callGet(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[1]![1].authWorkerUrl).toBe('https://auth.ippoan.org')
    await callGet(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: 42 })))
    expect(requireAuthMock.mock.calls[2]![1].authWorkerUrl).toBe('https://auth.ippoan.org')
  })

  it('relay の非 2xx は status を保ち、理由を relay: 前置で出す (data も渡す)', async () => {
    const body = { error: 'DTAKO_CONFIG_KV binding が未設定です' }
    const fetchMock = vi.fn(async () => relayResponse(body, 503))
    const err = await rejection(callGet(eventWith(envWithRelay(fetchMock))))
    expect(err.statusCode).toBe(503)
    expect(err.text).toContain('relay: DTAKO_CONFIG_KV binding が未設定です')
    expect(err.data).toEqual(body)
  })

  it('relay の非 2xx が JSON でなくても status だけの定型文で落とす', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json') } } as Response))
    const err = await rejection(callGet(eventWith(envWithRelay(fetchMock))))
    expect(err.statusCode).toBe(500)
    expect(err.text).toContain('HTTP 500')
  })

  it('2xx なのに JSON でなければ 502 (黙って null を返さない)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } } as Response))
    const err = await rejection(callGet(eventWith(envWithRelay(fetchMock))))
    expect(err.statusCode).toBe(502)
  })
})

describe('PUT /api/netprint/targets', () => {
  it('INTERNAL_SHARED_SECRET 未設定は 503 (relay も requireAuth も呼ばない)', async () => {
    await expect(callPut(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env 自体が無くても 503 になる', async () => {
    const event = { context: {}, path: '/x', node: { req: { url: '/x', headers: {} }, res: { setHeader: vi.fn() } } }
    await expect(callPut(event as TestEvent)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取り出す', async () => {
    const fetchMock = vi.fn(async () => relayResponse({ ok: true, targets: TARGETS }))
    const env = { INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, SCRAPER_RELAY: { fetch: fetchMock } }
    await callPut(eventWith(env))
    expect(fetchMock.mock.calls[0]![1]!.headers['X-Alc-Proxy-Secret']).toBe('from-store')
  })

  it('Secrets Store が空を返したら 503', async () => {
    await expect(callPut(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => null } }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('body が JSON として読めなければ 400 (relay へ渡す形にできない)', async () => {
    const fetchMock = vi.fn()
    const err = await rejection(callPut(eventWith(envWithRelay(fetchMock), undefined, true)))
    expect(err.statusCode).toBe(400)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('SCRAPER_RELAY 未設定は 503 (body を読んだ後)', async () => {
    await expect(callPut(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('未ログインはそのまま伝わる (body を読む前に落ちる)', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
    const fetchMock = vi.fn()
    await expect(callPut(eventWith(envWithRelay(fetchMock)))).rejects.toMatchObject({ statusCode: 401 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('body を検証せずそのまま relay へ渡す (規則を 2 か所に持たない)', async () => {
    const fetchMock = vi.fn(async () => relayResponse({ ok: true, targets: TARGETS }))
    // 宛先が両方入った不正な body も front は素通しし、落とすのは relay。
    const invalid = [{ branch_cd: '1', channel_id: 'x', recipient_id: 'y' }]
    await callPut(eventWith(envWithRelay(fetchMock), invalid))
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.internal/kintai-relay/netprint-targets')
    expect(init!.method).toBe('PUT')
    expect(init!.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init!.body as string)).toEqual(invalid)
  })

  it('保存できたら relay の応答 (正規化後の targets) を返す', async () => {
    const fetchMock = vi.fn(async () => relayResponse({ ok: true, targets: TARGETS }))
    expect(await callPut(eventWith(envWithRelay(fetchMock)))).toEqual({ ok: true, targets: TARGETS })
  })

  it('relay の 400 は理由を落とさず画面へ運ぶ (何件目のどの営業所か)', async () => {
    const body = { error: '1 件目 (営業所 1): channel_id と recipient_id はどちらか一方だけ指定してください' }
    const fetchMock = vi.fn(async () => relayResponse(body, 400))
    const err = await rejection(callPut(eventWith(envWithRelay(fetchMock))))
    expect(err.statusCode).toBe(400)
    expect(err.text).toContain('1 件目 (営業所 1)')
    expect(err.data).toEqual(body)
  })

  it('auth-worker の URL は var 優先、無ければ本番の既定', async () => {
    const fetchMock = vi.fn(async () => relayResponse({ ok: true, targets: [] }))
    await callPut(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.dev.example' }), []))
    expect(requireAuthMock.mock.calls[0]![1].authWorkerUrl).toBe('https://auth.dev.example')
    await callPut(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: '' }), []))
    expect(requireAuthMock.mock.calls[1]![1].authWorkerUrl).toBe('https://auth.ippoan.org')
    await callPut(eventWith(envWithRelay(fetchMock, { NUXT_PUBLIC_AUTH_WORKER_URL: 42 }), []))
    expect(requireAuthMock.mock.calls[2]![1].authWorkerUrl).toBe('https://auth.ippoan.org')
  })

  it('2xx なのに JSON でなければ 502 (保存できたことにしない)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } } as Response))
    const err = await rejection(callPut(eventWith(envWithRelay(fetchMock))))
    expect(err.statusCode).toBe(502)
  })
})

describe('describeNetprintTargetsFailure', () => {
  it('relay の error をそのまま 1 行にする', () => {
    expect(describeNetprintTargetsFailure({ error: '1 件目: branch_cd (営業所コード) は必須です' }, 400))
      .toBe('1 件目: branch_cd (営業所コード) は必須です')
  })

  it('読めない形 / 空の error は status だけの定型文に倒す', () => {
    expect(describeNetprintTargetsFailure(null, 502)).toContain('HTTP 502')
    expect(describeNetprintTargetsFailure('text', 500)).toContain('HTTP 500')
    expect(describeNetprintTargetsFailure({ error: '' }, 503)).toContain('HTTP 503')
    expect(describeNetprintTargetsFailure({ error: 7 }, 401)).toContain('HTTP 401')
  })
})
