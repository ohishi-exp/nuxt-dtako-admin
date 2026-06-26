import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'

// 転送 + introspect 検証 + identity 注入の本体は @ippoan/auth-client/server の
// createIdentityProxyHandler に集約 (#434 step 2)。挙動テスト (introspect /
// X-Tenant-ID + X-User-* 注入 / binary・JSON 分類) は lib 側 (auth-worker)。
// ここでは本 repo の server route の wiring を固定する:
//   1. INTERNAL_SHARED_SECRET binding を resolve して渡す (未設定は 503)
//   2. AUTH_WORKER service binding / authWorkerUrl / backendUrl / pathPrefix を解決して委譲
//   3. createIdentityProxyHandler の戻り値で proxy(event) を返す
//
// nuxt auto-import (defineEventHandler / createError / useRuntimeConfig) は
// @nuxt/test-utils の runtime 環境では実体に解決されるため vi.stubGlobal では
// 差し替えられない。useRuntimeConfig は mockNuxtImport で、createError は実体が
// throw する H3Error の statusCode をそのまま assert する。

const { createIdentityProxyHandlerMock, proxyFn } = vi.hoisted(() => {
  const proxyFn = vi.fn(() => 'PROXY_RESULT')
  return {
    proxyFn,
    createIdentityProxyHandlerMock: vi.fn((_opts: unknown) => proxyFn),
  }
})
vi.mock('@ippoan/auth-client/server', () => ({
  createIdentityProxyHandler: createIdentityProxyHandlerMock,
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
  backendUrl: (event: unknown) => string
  authWorkerUrl: string
  sharedSecret: string
  pathPrefix: string
}

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<unknown>)(event)
const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

describe('proxy handler wiring (createIdentityProxyHandler, #434)', () => {
  beforeEach(() => {
    createIdentityProxyHandlerMock.mockClear()
    proxyFn.mockClear()
  })

  it('INTERNAL_SHARED_SECRET があれば委譲し proxy(event) を返す', async () => {
    const event = eventWith({
      INTERNAL_SHARED_SECRET: 'secret-x',
      NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth-test.example.com',
      AUTH_WORKER: { fetch: vi.fn() },
    })
    const res = await call(event)
    expect(createIdentityProxyHandlerMock).toHaveBeenCalledTimes(1)
    const opts = createIdentityProxyHandlerMock.mock.calls[0]![0] as ProxyWiring
    expect(opts.sharedSecret).toBe('secret-x')
    expect(opts.authWorkerUrl).toBe('https://auth-test.example.com')
    expect(proxyFn).toHaveBeenCalledWith(event)
    expect(res).toBe('PROXY_RESULT')
  })

  it('pathPrefix は "/" を渡す (api.ts の /api/* と二重 /api を防ぐ)', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: 'x' }))
    const opts = createIdentityProxyHandlerMock.mock.calls[0]![0] as ProxyWiring
    expect(opts.pathPrefix).toBe('/')
  })

  it('INTERNAL_SHARED_SECRET が Secrets Store binding (.get()) でも解決する', async () => {
    const event = eventWith({
      INTERNAL_SHARED_SECRET: { get: async () => 'from-store' },
      AUTH_WORKER: { fetch: vi.fn() },
    })
    await call(event)
    const opts = createIdentityProxyHandlerMock.mock.calls[0]![0] as ProxyWiring
    expect(opts.sharedSecret).toBe('from-store')
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 で弾く (委譲しない)', async () => {
    await expect(call(eventWith({}))).rejects.toMatchObject({ statusCode: 503 })
    expect(createIdentityProxyHandlerMock).not.toHaveBeenCalled()
  })

  it('NUXT_PUBLIC_AUTH_WORKER_URL 未設定なら本番 auth-worker にフォールバック', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: 'x' }))
    const opts = createIdentityProxyHandlerMock.mock.calls[0]![0] as ProxyWiring
    expect(opts.authWorkerUrl).toBe('https://auth.ippoan.org')
  })

  it('backendUrl は runtimeConfig.alcApiUrl を解決する', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: 'x' }))
    const opts = createIdentityProxyHandlerMock.mock.calls[0]![0] as ProxyWiring
    expect(opts.backendUrl({})).toBe('https://test-api.example.com')
  })
})
