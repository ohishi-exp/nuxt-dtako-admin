import { describe, expect, it, vi } from 'vitest'
import { alcInternalProxyFetch } from '../../server/utils/alc-internal-proxy'

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, createError: (opts: { statusCode: number, statusMessage: string }) => {
    const err = new Error(opts.statusMessage) as Error & { statusCode: number }
    err.statusCode = opts.statusCode
    return err
  } }
})

const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

describe('alcInternalProxyFetch', () => {
  it('INTERNAL_SHARED_SECRET 未設定は 503 throw', async () => {
    await expect(
      alcInternalProxyFetch(eventWith({}) as never, { path: '/api/internal/operations', tenantId: 't1' }),
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('cloudflare env 自体が無くても (?? {} フォールバック) 503 になる', async () => {
    const event = { context: {} }
    await expect(
      alcInternalProxyFetch(event as never, { path: '/api/internal/operations', tenantId: 't1' }),
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding の .get() が null を返しても (?? null フォールバック) 503 になる', async () => {
    const event = eventWith({ INTERNAL_SHARED_SECRET: { get: async () => null } })
    await expect(
      alcInternalProxyFetch(event as never, { path: '/api/internal/operations', tenantId: 't1' }),
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('NUXT_PUBLIC_AUTH_WORKER_URL が設定されていれば public fallback にその値を使う', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const event = eventWith({
        INTERNAL_SHARED_SECRET: 'secret-x',
        NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth-staging.ippoan.org',
      })
      await alcInternalProxyFetch(event as never, { path: '/api/internal/operations', tenantId: 't1' })
      const [url] = fetchMock.mock.calls[0] as [string]
      expect(url).toContain('auth-staging.ippoan.org/alc-internal-proxy')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })

  it('service binding があればそれを使い、X-Alc-Proxy-Secret + X-Tenant-ID を付与する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const event = eventWith({
      INTERNAL_SHARED_SECRET: 'secret-x',
      AUTH_WORKER: { fetch: fetchMock },
    })
    await alcInternalProxyFetch(event as never, {
      path: '/api/internal/operations',
      tenantId: 'tenant-1',
      query: { date_from: '2026-06-01', vehicle_cd: undefined },
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/alc-internal-proxy/api/internal/operations')
    expect(url).toContain('date_from=2026-06-01')
    expect(url).not.toContain('vehicle_cd')
    const headers = init.headers as Record<string, string>
    expect(headers['X-Alc-Proxy-Secret']).toBe('secret-x')
    expect(headers['X-Tenant-ID']).toBe('tenant-1')
  })

  it('INTERNAL_SHARED_SECRET が Secrets Store binding (.get()) でも解決する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    const event = eventWith({
      INTERNAL_SHARED_SECRET: { get: async () => 'from-store' },
      AUTH_WORKER: { fetch: fetchMock },
    })
    await alcInternalProxyFetch(event as never, { path: '/api/internal/operations', tenantId: 't1' })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['X-Alc-Proxy-Secret']).toBe('from-store')
  })

  it('service binding が無ければ public URL fallback を使う', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    try {
      const event = eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' })
      await alcInternalProxyFetch(event as never, { path: '/api/internal/operations', tenantId: 't1' })
      const [url] = fetchMock.mock.calls[0] as [string]
      expect(url).toContain('auth.ippoan.org/alc-internal-proxy')
    }
    finally {
      globalThis.fetch = originalFetch
    }
  })
})
