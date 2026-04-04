import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock useRuntimeConfig - the Nuxt auto-import transform resolves it from #app/nuxt
vi.mock('#app/nuxt', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    useRuntimeConfig: () => ({ public: { apiBase: 'http://test', authWorkerUrl: 'https://auth.mtamaramu.com' } }),
  }
})

// Helper: create a JWT with given payload (no real signature needed)
function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = btoa(JSON.stringify(payload))
  return `${header}.${body}.fake-signature`
}

// Helper: create a valid (non-expired) JWT with standard claims
function makeValidJwt(overrides: Record<string, unknown> = {}): string {
  return makeJwt({
    sub: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    org: 'tenant-456',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  })
}

// Helper: create an expired JWT
function makeExpiredJwt(): string {
  return makeJwt({
    sub: 'user-123',
    email: 'test@example.com',
    name: 'Test User',
    org: 'tenant-456',
    iat: Math.floor(Date.now() / 1000) - 7200,
    exp: Math.floor(Date.now() / 1000) - 3600,
  })
}

const TOKEN_KEY = 'dtako_token'

describe('useAuth', () => {
  let useAuth: typeof import('~/composables/useAuth')['useAuth']

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    const mod = await import('~/composables/useAuth')
    useAuth = mod.useAuth
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('init', () => {
    it('sets isLoading to false after init', () => {
      const auth = useAuth()
      auth.init()
      expect(auth.isLoading.value).toBe(false)
    })

    it('restores valid token from localStorage', () => {
      const token = makeValidJwt()
      localStorage.setItem(TOKEN_KEY, token)

      const auth = useAuth()
      auth.init()

      expect(auth.accessToken.value).toBe(token)
      expect(auth.user.value).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        tenant_id: 'tenant-456',
      })
      expect(auth.tenantId.value).toBe('tenant-456')
      expect(auth.isAuthenticated.value).toBe(true)
    })

    it('removes expired token from localStorage', () => {
      const token = makeExpiredJwt()
      localStorage.setItem(TOKEN_KEY, token)

      const auth = useAuth()
      auth.init()

      expect(auth.accessToken.value).toBeNull()
      expect(auth.user.value).toBeNull()
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    })

    it('does nothing if already initialized (singleton guard)', () => {
      const token = makeValidJwt()

      const auth = useAuth()
      auth.init()
      expect(auth.accessToken.value).toBeNull()

      localStorage.setItem(TOKEN_KEY, token)
      auth.init()
      expect(auth.accessToken.value).toBeNull()
    })

    it('handles no token in localStorage gracefully', () => {
      const auth = useAuth()
      auth.init()

      expect(auth.accessToken.value).toBeNull()
      expect(auth.user.value).toBeNull()
      expect(auth.isLoading.value).toBe(false)
    })
  })

  describe('JWT decoding (via init/handleCallback)', () => {
    it('handles url-safe base64 chars (- and _)', () => {
      const payload = {
        sub: 'user~>?123',
        email: 'test@example.com',
        name: 'Test User',
        org: 'tenant-456',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }
      const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
      const body = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const token = `${header}.${body}.fake-sig`

      localStorage.setItem(TOKEN_KEY, token)
      const auth = useAuth()
      auth.init()

      expect(auth.user.value?.id).toBe('user~>?123')
    })

    it('handles invalid JWT gracefully (no payload part)', () => {
      localStorage.setItem(TOKEN_KEY, 'invalid-token-no-dots')
      const auth = useAuth()
      auth.init()

      expect(auth.accessToken.value).toBeNull()
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    })

    it('handles JWT with invalid base64 payload', () => {
      localStorage.setItem(TOKEN_KEY, 'header.!!!invalid-base64!!!.sig')
      const auth = useAuth()
      auth.init()

      expect(auth.accessToken.value).toBeNull()
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    })

    it('treats token without exp claim as expired', () => {
      const token = makeJwt({
        sub: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        org: 'tenant-456',
      })
      localStorage.setItem(TOKEN_KEY, token)
      const auth = useAuth()
      auth.init()

      expect(auth.accessToken.value).toBeNull()
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    })
  })

  describe('handleCallback', () => {
    let replaceStateSpy: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
      replaceStateSpy = vi.spyOn(history, 'replaceState').mockImplementation(() => {})
    })

    it('extracts token from URL hash fragment and saves to localStorage', () => {
      const token = makeValidJwt()
      Object.defineProperty(window, 'location', {
        value: {
          ...window.location,
          hash: `#token=${token}`,
          pathname: '/auth/callback',
          search: '',
          origin: 'http://localhost:3000',
        },
        writable: true,
        configurable: true,
      })

      const auth = useAuth()
      const result = auth.handleCallback()

      expect(result).toBe(true)
      expect(auth.accessToken.value).toBe(token)
      expect(auth.user.value).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        name: 'Test User',
        tenant_id: 'tenant-456',
      })
      expect(localStorage.getItem(TOKEN_KEY)).toBe(token)
      expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/auth/callback')
    })

    it('returns false if no hash', () => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, hash: '', pathname: '/', search: '', origin: 'http://localhost:3000' },
        writable: true,
        configurable: true,
      })

      const auth = useAuth()
      expect(auth.handleCallback()).toBe(false)
    })

    it('returns false if no token param in hash', () => {
      Object.defineProperty(window, 'location', {
        value: { ...window.location, hash: '#other=value', pathname: '/', search: '', origin: 'http://localhost:3000' },
        writable: true,
        configurable: true,
      })

      const auth = useAuth()
      expect(auth.handleCallback()).toBe(false)
    })

    it('returns false if token is expired', () => {
      const token = makeExpiredJwt()
      Object.defineProperty(window, 'location', {
        value: {
          ...window.location,
          hash: `#token=${token}`,
          pathname: '/auth/callback',
          search: '',
          origin: 'http://localhost:3000',
        },
        writable: true,
        configurable: true,
      })

      const auth = useAuth()
      const result = auth.handleCallback()

      expect(result).toBe(false)
      expect(auth.accessToken.value).toBeNull()
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    })

    it('clears URL fragment after extraction', () => {
      const token = makeValidJwt()
      Object.defineProperty(window, 'location', {
        value: {
          ...window.location,
          hash: `#token=${token}`,
          pathname: '/auth/callback',
          search: '?foo=bar',
          origin: 'http://localhost:3000',
        },
        writable: true,
        configurable: true,
      })

      const auth = useAuth()
      auth.handleCallback()

      expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/auth/callback?foo=bar')
    })
  })

  describe('loginWithGoogleRedirect', () => {
    it('redirects to rust-alc-api with callback', () => {
      Object.defineProperty(window, 'location', {
        value: {
          origin: 'http://localhost:3000',
          href: 'http://localhost:3000/',
          pathname: '/',
          search: '',
          hash: '',
        },
        writable: true,
        configurable: true,
      })

      const auth = useAuth()
      auth.loginWithGoogleRedirect()

      const expectedCallback = encodeURIComponent('http://localhost:3000/auth/callback')
      expect(window.location.href).toBe(
        `http://test/api/auth/google/redirect?redirect_uri=${expectedCallback}`,
      )
    })
  })

  describe('logout', () => {
    it('clears user, accessToken, tenantId and removes token from localStorage', () => {
      const token = makeValidJwt()
      localStorage.setItem(TOKEN_KEY, token)

      const auth = useAuth()
      auth.init()

      expect(auth.accessToken.value).toBe(token)
      expect(auth.user.value).not.toBeNull()
      expect(auth.tenantId.value).toBe('tenant-456')

      auth.logout()

      expect(auth.accessToken.value).toBeNull()
      expect(auth.user.value).toBeNull()
      expect(auth.tenantId.value).toBeNull()
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
    })

    it('handles logout when not authenticated', () => {
      const auth = useAuth()
      auth.init()

      auth.logout()

      expect(auth.accessToken.value).toBeNull()
      expect(auth.user.value).toBeNull()
    })
  })

  describe('isAuthenticated', () => {
    it('is true when accessToken is set', () => {
      const token = makeValidJwt()
      localStorage.setItem(TOKEN_KEY, token)

      const auth = useAuth()
      auth.init()

      expect(auth.isAuthenticated.value).toBe(true)
    })

    it('is false when no token', () => {
      const auth = useAuth()
      auth.init()

      expect(auth.isAuthenticated.value).toBe(false)
    })

    it('becomes false after logout', () => {
      const token = makeValidJwt()
      localStorage.setItem(TOKEN_KEY, token)

      const auth = useAuth()
      auth.init()
      expect(auth.isAuthenticated.value).toBe(true)

      auth.logout()
      expect(auth.isAuthenticated.value).toBe(false)
    })
  })

  describe('SSR (window undefined)', () => {
    it('init() when window is undefined sets isLoading to false', () => {
      const originalWindow = globalThis.window
      vi.stubGlobal('window', undefined)

      const auth = useAuth()
      auth.init()

      expect(auth.isLoading.value).toBe(false)
      expect(auth.accessToken.value).toBeNull()
      expect(auth.user.value).toBeNull()

      vi.stubGlobal('window', originalWindow)
    })

    it('handleCallback() when window is undefined returns false', () => {
      const originalWindow = globalThis.window
      vi.stubGlobal('window', undefined)

      const auth = useAuth()
      const result = auth.handleCallback()

      expect(result).toBe(false)

      vi.stubGlobal('window', originalWindow)
    })

    it('logout() when window is undefined clears state but does not touch localStorage', () => {
      // First set up authenticated state with window available
      const token = makeValidJwt()
      localStorage.setItem(TOKEN_KEY, token)
      const auth = useAuth()
      auth.init()
      expect(auth.accessToken.value).toBe(token)

      // Now simulate SSR: window is undefined
      const originalWindow = globalThis.window
      vi.stubGlobal('window', undefined)

      auth.logout()

      expect(auth.accessToken.value).toBeNull()
      expect(auth.user.value).toBeNull()
      expect(auth.tenantId.value).toBeNull()

      vi.stubGlobal('window', originalWindow)
      // Token should still be in localStorage since window was "undefined" during logout
      expect(localStorage.getItem(TOKEN_KEY)).toBe(token)
    })
  })

  describe('setToken with decode failure', () => {
    it('setToken handles decode failure by not setting user', () => {
      const token = makeValidJwt()
      // Set token in hash for handleCallback
      Object.defineProperty(window, 'location', {
        value: {
          ...window.location,
          hash: `#token=${token}`,
          pathname: '/auth/callback',
          search: '',
          origin: 'http://localhost:3000',
        },
        writable: true,
        configurable: true,
      })
      vi.spyOn(history, 'replaceState').mockImplementation(() => {})

      // Make atob fail on the second call (setToken's decodeJwt) but succeed on the first (isTokenExpired's decodeJwt)
      const originalAtob = globalThis.atob
      let atobCallCount = 0
      vi.stubGlobal('atob', (s: string) => {
        atobCallCount++
        // 1st atob call: isTokenExpired -> decodeJwt -> atob(parts[1])
        // 2nd atob call: setToken -> decodeJwt -> atob(parts[1])
        if (atobCallCount >= 2) {
          throw new Error('simulated atob failure')
        }
        return originalAtob(s)
      })

      const auth = useAuth()
      const result = auth.handleCallback()

      // handleCallback returns true (token passed isTokenExpired), but setToken's decodeJwt fails
      expect(result).toBe(true)
      // user should be null because decodeJwt returned null in setToken
      expect(auth.user.value).toBeNull()

      vi.stubGlobal('atob', originalAtob)
    })
  })

  describe('singleton behavior across multiple useAuth() calls', () => {
    it('shares state between multiple useAuth() calls in same module', () => {
      const token = makeValidJwt()
      localStorage.setItem(TOKEN_KEY, token)

      const auth1 = useAuth()
      auth1.init()

      const auth2 = useAuth()
      expect(auth2.accessToken.value).toBe(token)
      expect(auth2.user.value?.email).toBe('test@example.com')
      expect(auth2.isAuthenticated.value).toBe(true)
    })
  })
})
