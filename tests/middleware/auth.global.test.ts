import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockIsAuthenticated = { value: false }
const mockIsLoading = { value: false }
const mockPublicConfig: Record<string, string> = {}

vi.mock('@ippoan/auth-client', () => ({
  useAuth: () => ({
    isAuthenticated: mockIsAuthenticated,
    isLoading: mockIsLoading,
  }),
  authMiddleware: (options: { publicPaths?: string[]; loginPath?: string } = {}) => {
    const { publicPaths = ['/login'], loginPath = '/login' } = options
    return (to: { path: string }) => {
      if (mockPublicConfig.stagingTenantId) return
      if (publicPaths.some((p) => to.path.startsWith(p))) return
      if (mockIsLoading.value) return
      if (!mockIsAuthenticated.value) {
        return navigateTo(loginPath)
      }
    }
  },
}))

vi.mock('#app/composables/router', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    navigateTo: vi.fn((path: string) => ({ __navigateTo: path })),
    defineNuxtRouteMiddleware: (fn: Function) => fn,
  }
})

import middleware from '~/middleware/auth.global'
import { navigateTo } from '#app/composables/router'

const navigateToMock = vi.mocked(navigateTo)

describe('auth.global middleware', () => {
  beforeEach(() => {
    mockIsAuthenticated.value = false
    mockIsLoading.value = false
    for (const k of Object.keys(mockPublicConfig)) delete mockPublicConfig[k]
    navigateToMock.mockClear()
  })

  it('skips /login path', () => {
    const result = (middleware as Function)({ path: '/login' })
    expect(result).toBeUndefined()
  })

  it('skips /login subpath', () => {
    const result = (middleware as Function)({ path: '/login/extra' })
    expect(result).toBeUndefined()
  })

  it('skips /auth/callback path', () => {
    const result = (middleware as Function)({ path: '/auth/callback' })
    expect(result).toBeUndefined()
  })

  it('skips /auth/callback with query-like subpath', () => {
    const result = (middleware as Function)({ path: '/auth/callback/extra' })
    expect(result).toBeUndefined()
  })

  it('skips when isLoading is true', () => {
    mockIsLoading.value = true
    const result = (middleware as Function)({ path: '/dashboard' })
    expect(result).toBeUndefined()
  })

  it('redirects to /login when not authenticated', () => {
    mockIsAuthenticated.value = false
    const result = (middleware as Function)({ path: '/dashboard' })
    expect(navigateToMock).toHaveBeenCalledWith('/login')
    expect(result).toEqual({ __navigateTo: '/login' })
  })

  it('allows access when authenticated', () => {
    mockIsAuthenticated.value = true
    const result = (middleware as Function)({ path: '/dashboard' })
    expect(result).toBeUndefined()
    expect(navigateToMock).not.toHaveBeenCalled()
  })
})
