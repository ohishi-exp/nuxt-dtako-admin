import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// 転送 + introspect / ACL / OIDC mint / identity 注入の本体は auth-worker
// `/alc-proxy/*` に集約 (#434 step 3, 方式 B)。consumer 側 (本 repo) の server route は
// thin-forward の wiring だけを固定する:
//   1. INTERNAL_SHARED_SECRET binding を resolve して渡す (未設定は 503)
//   2. AUTH_WORKER service binding を解決して authWorkerFetch で委譲 (未設定は 503)
//   3. pathPrefix '/' を渡す (api.ts の /api/* と二重 /api を防ぐ)
//   4. createAuthWorkerProxyHandler の戻り値で proxy(event) を返す
//
// nuxt auto-import (defineEventHandler / createError) は @nuxt/test-utils の
// runtime 環境では実体に解決されるため vi.stubGlobal では差し替えられない。
// createError は実体が throw する H3Error の statusCode をそのまま assert する。

const { createAuthWorkerProxyHandlerMock, proxyFn } = vi.hoisted(() => {
  const proxyFn = vi.fn(() => 'PROXY_RESULT')
  return {
    proxyFn,
    createAuthWorkerProxyHandlerMock: vi.fn((_opts: unknown) => proxyFn),
  }
})
vi.mock('@ippoan/auth-client/server', () => ({
  createAuthWorkerProxyHandler: createAuthWorkerProxyHandlerMock,
}))

// h3 の defineEventHandler は (h3 v2 の wrap 挙動差を避けるため) identity に差し替える。
// createError は実体を残し、throw された H3Error の statusCode を assert する。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

mockNuxtImport('useRuntimeConfig', () => () => ({ alcApiUrl: 'https://test-api.example.com' }))

import handler from '../../server/api/proxy/[...path]'

interface ProxyWiring {
  sharedSecret: string
  authWorkerFetch: () => typeof fetch
  pathPrefix: string
}

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)
const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

describe('proxy handler wiring (createAuthWorkerProxyHandler, #434 step 3)', () => {
  beforeEach(() => {
    createAuthWorkerProxyHandlerMock.mockClear()
    proxyFn.mockClear()
  })

  it('INTERNAL_SHARED_SECRET + AUTH_WORKER があれば委譲し proxy(event) を返す', async () => {
    const event = eventWith({
      INTERNAL_SHARED_SECRET: 'secret-x',
      AUTH_WORKER: { fetch: vi.fn() },
    })
    const res = await call(event)
    expect(createAuthWorkerProxyHandlerMock).toHaveBeenCalledTimes(1)
    const opts = createAuthWorkerProxyHandlerMock.mock.calls[0]![0] as ProxyWiring
    expect(opts.sharedSecret).toBe('secret-x')
    expect(typeof opts.authWorkerFetch).toBe('function')
    expect(proxyFn).toHaveBeenCalledWith(event)
    expect(res).toBe('PROXY_RESULT')
  })

  it('pathPrefix は "/" を渡す (api.ts の /api/* と二重 /api を防ぐ)', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: 'x', AUTH_WORKER: { fetch: vi.fn() } }))
    const opts = createAuthWorkerProxyHandlerMock.mock.calls[0]![0] as ProxyWiring
    expect(opts.pathPrefix).toBe('/')
  })

  it('INTERNAL_SHARED_SECRET が Secrets Store binding (.get()) でも解決する', async () => {
    const event = eventWith({
      INTERNAL_SHARED_SECRET: { get: async () => 'from-store' },
      AUTH_WORKER: { fetch: vi.fn() },
    })
    await call(event)
    const opts = createAuthWorkerProxyHandlerMock.mock.calls[0]![0] as ProxyWiring
    expect(opts.sharedSecret).toBe('from-store')
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 で弾く (委譲しない)', async () => {
    await expect(call(eventWith({ AUTH_WORKER: { fetch: vi.fn() } }))).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(createAuthWorkerProxyHandlerMock).not.toHaveBeenCalled()
  })

  it('AUTH_WORKER 未設定なら 503 で弾く (委譲しない)', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 'x' }))).rejects.toMatchObject({
      statusCode: 503,
    })
    expect(createAuthWorkerProxyHandlerMock).not.toHaveBeenCalled()
  })
})
