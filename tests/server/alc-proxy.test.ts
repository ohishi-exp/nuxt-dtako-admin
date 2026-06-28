import { describe, it, expect, vi, beforeEach } from 'vitest'

// alcProxyFetch は h3 の getCookie / getHeader / getRequestURL / createError を使う。
// 入力を制御するためモックして差し替える (proxy.test.ts と同方針)。
const h3State = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  headers: {} as Record<string, string>,
  origin: 'https://dtako-staging.ippoan.org',
}))
vi.mock('h3', () => ({
  getCookie: (_e: unknown, name: string) =>
    name === 'logi_auth_token' ? h3State.cookie : undefined,
  getHeader: (_e: unknown, name: string) => h3State.headers[name.toLowerCase()],
  getRequestURL: () => new URL(h3State.origin),
  createError: (opts: { statusCode: number; statusMessage?: string }) => {
    const e = new Error(opts.statusMessage ?? 'error') as Error & { statusCode: number }
    e.statusCode = opts.statusCode
    return e
  },
}))

import { alcProxyFetch } from '../../server/utils/alc-proxy'

interface CallArgs {
  url: string
  options: RequestInit
}

const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

function bindingFetch(): { fetch: ReturnType<typeof vi.fn>; calls: () => CallArgs } {
  const fn = vi.fn(async () => new Response('ok', { status: 200 }))
  return {
    fetch: fn,
    calls: () => {
      const [url, options] = fn.mock.calls[0]! as [string, RequestInit]
      return { url, options }
    },
  }
}

describe('alcProxyFetch (#434 step 3 方式 B, service binding 委譲)', () => {
  beforeEach(() => {
    h3State.cookie = undefined
    h3State.headers = {}
    h3State.origin = 'https://dtako-staging.ippoan.org'
    vi.unstubAllGlobals()
  })

  it('AUTH_WORKER binding 経由で /alc-proxy + path を叩き Response を返す', async () => {
    h3State.cookie = 'jwt-from-cookie'
    const b = bindingFetch()
    const event = eventWith({
      INTERNAL_SHARED_SECRET: 'sek',
      AUTH_WORKER: { fetch: b.fetch },
    })
    const res = await alcProxyFetch(event as never, { path: '/api/dtako/vehicles' })
    expect(res.status).toBe(200)
    const { url, options } = b.calls()
    // service binding は host を無視するが path が /alc-proxy/... である必要がある
    expect(url).toBe('https://alc-proxy.internal/alc-proxy/api/dtako/vehicles')
    expect(options.method).toBe('GET')
    const h = options.headers as Record<string, string>
    expect(h['X-Alc-Proxy-Secret']).toBe('sek')
    expect(h['X-Alc-Proxy-Origin']).toBe('https://dtako-staging.ippoan.org')
    expect(h['Authorization']).toBe('Bearer jwt-from-cookie')
  })

  it('query を searchParams として付与する', async () => {
    h3State.cookie = 'jwt'
    const b = bindingFetch()
    const event = eventWith({ INTERNAL_SHARED_SECRET: 'sek', AUTH_WORKER: { fetch: b.fetch } })
    await alcProxyFetch(event as never, {
      path: '/api/dtako/y-time-export',
      query: { driver_cd: '4437', from: '2026-06-01', to: '2026-06-30', skip: undefined },
    })
    const { url } = b.calls()
    const parsed = new URL(url)
    expect(parsed.pathname).toBe('/alc-proxy/api/dtako/y-time-export')
    expect(parsed.searchParams.get('driver_cd')).toBe('4437')
    expect(parsed.searchParams.get('from')).toBe('2026-06-01')
    expect(parsed.searchParams.get('to')).toBe('2026-06-30')
    expect(parsed.searchParams.has('skip')).toBe(false) // undefined は無視
  })

  it('cookie が無ければ Authorization: Bearer ヘッダーから JWT を拾う', async () => {
    h3State.headers = { authorization: 'Bearer jwt-from-header' }
    const b = bindingFetch()
    const event = eventWith({ INTERNAL_SHARED_SECRET: 'sek', AUTH_WORKER: { fetch: b.fetch } })
    await alcProxyFetch(event as never, { path: '/api/dtako/vehicles' })
    const h = b.calls().options.headers as Record<string, string>
    expect(h['Authorization']).toBe('Bearer jwt-from-header')
  })

  it('token が無ければ Authorization ヘッダーを付けない (auth-worker が 401 を返す)', async () => {
    const b = bindingFetch()
    const event = eventWith({ INTERNAL_SHARED_SECRET: 'sek', AUTH_WORKER: { fetch: b.fetch } })
    await alcProxyFetch(event as never, { path: '/api/dtako/vehicles' })
    const h = b.calls().options.headers as Record<string, string>
    expect(h['Authorization']).toBeUndefined()
  })

  it('AUTH_WORKER binding 無しなら公開 HTTP (NUXT_PUBLIC_AUTH_WORKER_URL) に fallback', async () => {
    h3State.cookie = 'jwt'
    const globalFetch = vi.fn(async () => new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', globalFetch)
    const event = eventWith({
      INTERNAL_SHARED_SECRET: 'sek',
      NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth-staging.ippoan.org',
    })
    await alcProxyFetch(event as never, { path: '/api/dtako/vehicles' })
    const [url] = globalFetch.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('https://auth-staging.ippoan.org/alc-proxy/api/dtako/vehicles')
  })

  it('INTERNAL_SHARED_SECRET が Secrets Store binding (.get()) でも解決する', async () => {
    h3State.cookie = 'jwt'
    const b = bindingFetch()
    const event = eventWith({
      INTERNAL_SHARED_SECRET: { get: async () => 'from-store' },
      AUTH_WORKER: { fetch: b.fetch },
    })
    await alcProxyFetch(event as never, { path: '/api/dtako/vehicles' })
    const h = b.calls().options.headers as Record<string, string>
    expect(h['X-Alc-Proxy-Secret']).toBe('from-store')
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 を throw する', async () => {
    const event = eventWith({ AUTH_WORKER: { fetch: vi.fn() } })
    await expect(alcProxyFetch(event as never, { path: '/api/dtako/vehicles' })).rejects.toMatchObject(
      { statusCode: 503 },
    )
  })

  it('POST body / contentType を forward する', async () => {
    h3State.cookie = 'jwt'
    const b = bindingFetch()
    const event = eventWith({ INTERNAL_SHARED_SECRET: 'sek', AUTH_WORKER: { fetch: b.fetch } })
    await alcProxyFetch(event as never, {
      path: '/api/dtako/foo',
      method: 'POST',
      body: '{"a":1}',
      contentType: 'application/json',
    })
    const { options } = b.calls()
    expect(options.method).toBe('POST')
    expect(options.body).toBe('{"a":1}')
    expect((options.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})
