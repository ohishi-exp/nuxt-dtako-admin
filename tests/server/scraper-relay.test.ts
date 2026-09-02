import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import { authorizeScraperRelay, sendToScraperRelay, type ScraperRelayAuth } from '../../server/utils/scraper-relay'

function eventWith(env: Record<string, unknown>): H3Event {
  return { context: { cloudflare: { env } } } as unknown as H3Event
}

function relayResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function envWithRelay(fetchMock: ReturnType<typeof vi.fn>, extra: Record<string, unknown> = {}) {
  return { INTERNAL_SHARED_SECRET: 'secret-x', SCRAPER_RELAY: { fetch: fetchMock }, ...extra }
}

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

describe('authorizeScraperRelay', () => {
  beforeEach(() => {
    requireAuthMock.mockReset()
    requireAuthMock.mockResolvedValue({ sub: 'user-1', role: 'admin' })
  })

  it('INTERNAL_SHARED_SECRET 未設定は 503 (requireAuth を呼ばない)', async () => {
    await expect(authorizeScraperRelay(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env 自体が無くても 503 になる', async () => {
    const event = { context: {} } as unknown as H3Event
    await expect(authorizeScraperRelay(event)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取り出す', async () => {
    const auth = await authorizeScraperRelay(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' } }))
    expect(auth.sharedSecret).toBe('from-store')
  })

  it('Secrets Store の .get() が null を返しても 503', async () => {
    await expect(authorizeScraperRelay(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => null } })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('requireAuth の throw はそのまま伝播する', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('unauthorized'), { statusCode: 401 }))
    await expect(authorizeScraperRelay(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' })))
      .rejects.toMatchObject({ statusCode: 401 })
  })

  it('role が admin/payroll のどちらでもなければ 403 (assertAllowedRole)', async () => {
    requireAuthMock.mockResolvedValue({ sub: 'user-1', role: 'viewer' })
    await expect(authorizeScraperRelay(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' })))
      .rejects.toMatchObject({ statusCode: 403 })
  })

  it('requireAuth には auth-worker URL と secret を渡す (未設定なら本番既定)', async () => {
    await authorizeScraperRelay(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org', sharedSecret: 'secret-x' })
    await authorizeScraperRelay(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x', NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth-staging.ippoan.org' }))
    expect(requireAuthMock.mock.calls[1]![1]).toMatchObject({ authWorkerUrl: 'https://auth-staging.ippoan.org' })
    await authorizeScraperRelay(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x', NUXT_PUBLIC_AUTH_WORKER_URL: '' }))
    expect(requireAuthMock.mock.calls[2]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('sendToScraperRelay', () => {
  const AUTH: ScraperRelayAuth = { sharedSecret: 'secret-x' }

  it('SCRAPER_RELAY binding 未設定は 503', async () => {
    await expect(sendToScraperRelay(eventWith({}), AUTH, '/kintai-relay/x', {}))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('POST (既定) は content-type + secret ヘッダで JSON body を送る', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ ok: true }))
    await sendToScraperRelay(eventWith(envWithRelay(fetchMock)), AUTH, '/kintai-relay/x', { a: 1 })
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://relay.internal/kintai-relay/x')
    expect(init.method).toBe('POST')
    expect(init.headers['content-type']).toBe('application/json')
    expect(init.headers['X-Alc-Proxy-Secret']).toBe('secret-x')
    expect(JSON.parse(init.body)).toEqual({ a: 1 })
  })

  it('GET は content-type を付けず body も送らない', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse([]))
    await sendToScraperRelay(eventWith(envWithRelay(fetchMock)), AUTH, '/kintai-relay/x', undefined, { method: 'GET' })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.method).toBe('GET')
    expect(init.headers['content-type']).toBeUndefined()
    expect(init.body).toBeUndefined()
  })

  it('PUT は POST と同じくヘッダ・body を送る', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ ok: true }))
    await sendToScraperRelay(eventWith(envWithRelay(fetchMock)), AUTH, '/kintai-relay/x', [1, 2], { method: 'PUT' })
    const [, init] = fetchMock.mock.calls[0]!
    expect(init.method).toBe('PUT')
    expect(init.headers['content-type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual([1, 2])
  })

  it('2xx の JSON をそのまま返す', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ ok: true, value: 42 }))
    const result = await sendToScraperRelay(eventWith(envWithRelay(fetchMock)), AUTH, '/kintai-relay/x', {})
    expect(result).toEqual({ ok: true, value: 42 })
  })

  it('2xx なのに JSON が読めなければ 502', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('not json') } } as unknown as Response)
    await expect(sendToScraperRelay(eventWith(envWithRelay(fetchMock)), AUTH, '/kintai-relay/x', {}))
      .rejects.toMatchObject({ statusCode: 502 })
  })

  it('非 2xx は describeFailure の 1 行を relay: 前置で載せ、data に応答本文を付ける', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ error: 'なにか失敗しました' }, 400))
    const describeFailure = vi.fn((data: unknown, status: number) => `カスタム: ${(data as { error: string }).error} (${status})`)
    const { statusCode, text, data } = await rejection(sendToScraperRelay(eventWith(envWithRelay(fetchMock)), AUTH, '/kintai-relay/x', {}, { describeFailure }))
    expect(statusCode).toBe(400)
    expect(text).toContain('relay: カスタム: なにか失敗しました (400)')
    expect(data).toEqual({ error: 'なにか失敗しました' })
    expect(describeFailure).toHaveBeenCalledWith({ error: 'なにか失敗しました' }, 400)
  })

  it('describeFailure 省略時は HTTP {status} だけの定型文', async () => {
    const fetchMock = vi.fn().mockResolvedValue(relayResponse({ error: 'x' }, 503))
    const { text } = await rejection(sendToScraperRelay(eventWith(envWithRelay(fetchMock)), AUTH, '/kintai-relay/x', {}))
    expect(text).toContain('relay: HTTP 503')
  })

  it('非 2xx で本文が JSON でなくても status は保つ', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('not json') } } as unknown as Response)
    const { statusCode, text } = await rejection(sendToScraperRelay(eventWith(envWithRelay(fetchMock)), AUTH, '/kintai-relay/x', {}))
    expect(statusCode).toBe(502)
    expect(text).toContain('relay: HTTP 502')
  })
})
