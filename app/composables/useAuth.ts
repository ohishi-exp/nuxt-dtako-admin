import type { AuthUser, AuthResponse, RefreshResponse } from '~/types'

const REFRESH_TOKEN_KEY = 'dtako_refresh_token'

// シングルトン state (composable の外で定義して複数コンポーネント間で共有)
const user = ref<AuthUser | null>(null)
const accessToken = ref<string | null>(null)
const isLoading = ref(true)

let initialized = false
let refreshTimerId: ReturnType<typeof setTimeout> | null = null

export function useAuth() {
  const config = useRuntimeConfig()
  const apiBase = (config.public.apiBase as string).replace(/\/$/, '')

  const isAuthenticated = computed(() => !!accessToken.value)

  /** アプリ起動時に呼ぶ: localStorage から復元 + token refresh 試行 */
  async function init() {
    if (initialized) return
    initialized = true

    const refreshToken = typeof window !== 'undefined'
      ? localStorage.getItem(REFRESH_TOKEN_KEY)
      : null

    if (refreshToken) {
      try {
        await refreshAccessToken(refreshToken)
      } catch {
        if (typeof window !== 'undefined') {
          localStorage.removeItem(REFRESH_TOKEN_KEY)
        }
      }
    }

    isLoading.value = false
  }

  /** Google OAuth ログイン (Authorization Code Flow) */
  function loginWithGoogleRedirect(): void {
    const clientId = config.public.googleClientId as string
    const callbackUrl = `${window.location.origin}/auth/callback`

    // CSRF 対策: state をランダム生成して sessionStorage に保存
    const state = crypto.randomUUID()
    sessionStorage.setItem('oauth_state', state)

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'login',
      max_age: '0',
      state,
    })

    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  }

  /** Google OAuth コールバック: authorization code をバックエンドと交換 */
  async function handleGoogleCallback(code: string, state: string): Promise<void> {
    const savedState = sessionStorage.getItem('oauth_state')
    sessionStorage.removeItem('oauth_state')
    if (!savedState || savedState !== state) {
      throw new Error('不正なリクエスト (state mismatch)')
    }

    const callbackUrl = `${window.location.origin}/auth/callback`
    const res = await fetch(`${apiBase}/api/auth/google/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: callbackUrl }),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`ログイン失敗 (${res.status}): ${body}`)
    }

    const data: AuthResponse = await res.json()
    setTokens(data)
  }

  /** Refresh token で access token を更新 */
  async function refreshAccessToken(refreshToken?: string): Promise<void> {
    const token = refreshToken || (typeof window !== 'undefined' ? localStorage.getItem(REFRESH_TOKEN_KEY) : null)
    if (!token) throw new Error('Refresh token がありません')

    const res = await fetch(`${apiBase}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: token }),
    })

    if (!res.ok) {
      throw new Error('Token refresh に失敗しました')
    }

    const data: RefreshResponse = await res.json()
    accessToken.value = data.access_token

    // access token からユーザー情報をデコード (JWT payload)
    try {
      const parts = data.access_token.split('.')
      if (!parts[1]) throw new Error('Invalid JWT')
      const payload = JSON.parse(atob(parts[1]))
      user.value = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        tenant_id: payload.tenant_id,
        role: payload.role,
      }
    } catch {
      // デコード失敗してもログイン状態は維持
    }

    scheduleAutoRefresh()
  }

  /** トークンをセットして state を更新 */
  function setTokens(data: AuthResponse) {
    accessToken.value = data.access_token
    user.value = data.user

    if (typeof window !== 'undefined') {
      localStorage.setItem(REFRESH_TOKEN_KEY, data.refresh_token)
    }

    scheduleAutoRefresh()
  }

  /** JWT の exp から逆算して期限前に自動リフレッシュをスケジュール */
  function scheduleAutoRefresh() {
    if (refreshTimerId) {
      clearTimeout(refreshTimerId)
      refreshTimerId = null
    }

    const token = accessToken.value
    if (!token) return

    try {
      const parts = token.split('.')
      if (!parts[1]) return
      const payload = JSON.parse(atob(parts[1]))
      if (!payload.exp) return

      const expiresAt = payload.exp * 1000
      const now = Date.now()
      const refreshIn = expiresAt - now - 60_000

      if (refreshIn <= 0) {
        refreshAccessToken().catch(() => {})
        return
      }

      refreshTimerId = setTimeout(() => {
        refreshAccessToken().catch(() => {})
      }, refreshIn)
    } catch {
      // JWT デコードエラー
    }
  }

  /** ログアウト */
  async function logout() {
    if (refreshTimerId) {
      clearTimeout(refreshTimerId)
      refreshTimerId = null
    }

    if (accessToken.value) {
      try {
        await fetch(`${apiBase}/api/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${accessToken.value}` },
        })
      } catch {
        // ログアウト API 失敗しても続行
      }
    }

    accessToken.value = null
    user.value = null
    if (typeof window !== 'undefined') {
      localStorage.removeItem(REFRESH_TOKEN_KEY)
    }
  }

  return {
    user: readonly(user),
    accessToken: readonly(accessToken),
    isAuthenticated,
    isLoading: readonly(isLoading),
    init,
    loginWithGoogleRedirect,
    handleGoogleCallback,
    refreshAccessToken,
    logout,
  }
}
