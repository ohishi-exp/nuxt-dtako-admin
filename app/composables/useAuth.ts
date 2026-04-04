/**
 * auth-worker ベースの認証 composable
 * auth-worker が発行する JWT の `org` クレームを tenant_id として使用
 * rust-alc-api には X-Tenant-ID ヘッダーで転送
 */

const TOKEN_KEY = 'dtako_token'

interface JwtPayload {
  sub: string
  email: string
  name: string
  org: string  // tenant_id
  exp: number
  iat: number
}

export interface AuthUser {
  id: string
  email: string
  name: string
  tenant_id: string
  role?: string
}

// シングルトン state
const user = ref<AuthUser | null>(null)
const accessToken = ref<string | null>(null)
const isLoading = ref(true)
const tenantId = ref<string | null>(null)

let initialized = false

function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.')
    if (!parts[1]) return null
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    return payload
  } catch {
    return null
  }
}

function isTokenExpired(token: string): boolean {
  const payload = decodeJwt(token)
  if (!payload?.exp) return true
  return Date.now() > payload.exp * 1000
}

export function useAuth() {
  const config = useRuntimeConfig()

  const isAuthenticated = computed(() => !!accessToken.value)

  /** アプリ起動時: localStorage からトークン復元 */
  function init() {
    if (initialized) return
    initialized = true

    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(TOKEN_KEY)
      if (saved && !isTokenExpired(saved)) {
        setToken(saved)
      } else if (saved) {
        localStorage.removeItem(TOKEN_KEY)
      }
    }

    isLoading.value = false
  }

  /** auth-worker へリダイレクト (Google OAuth) */
  function loginWithGoogleRedirect(): void {
    const callbackUrl = `${window.location.origin}/auth/callback`
    const authWorkerUrl = config.public.authWorkerUrl as string

    // state は auth-worker 側で HMAC 生成するので、redirect_uri だけ渡す
    window.location.href = `${authWorkerUrl}/oauth/google/redirect?redirect_uri=${encodeURIComponent(callbackUrl)}`
  }

  /** auth-worker コールバック: URL fragment から JWT を取得 */
  function handleCallback(): boolean {
    if (typeof window === 'undefined') return false

    const hash = window.location.hash
    if (!hash) return false

    const params = new URLSearchParams(hash.substring(1))
    const token = params.get('token')
    if (!token) return false

    // fragment をクリア
    history.replaceState(null, '', window.location.pathname + window.location.search)

    if (isTokenExpired(token)) {
      return false
    }

    setToken(token)
    localStorage.setItem(TOKEN_KEY, token)
    return true
  }

  /** JWT をセットして user state を更新 */
  function setToken(token: string) {
    accessToken.value = token
    const payload = decodeJwt(token)
    if (payload) {
      tenantId.value = payload.org
      user.value = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        tenant_id: payload.org,
      }
    }
  }

  /** ログアウト */
  function logout() {
    accessToken.value = null
    user.value = null
    tenantId.value = null
    if (typeof window !== 'undefined') {
      localStorage.removeItem(TOKEN_KEY)
    }
  }

  return {
    user: readonly(user),
    accessToken: readonly(accessToken),
    tenantId: readonly(tenantId),
    isAuthenticated,
    isLoading: readonly(isLoading),
    init,
    loginWithGoogleRedirect,
    handleCallback,
    logout,
  }
}
