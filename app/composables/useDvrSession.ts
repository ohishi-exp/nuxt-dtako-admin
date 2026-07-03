/**
 * /dvr-viewer 系ページ (動画ビューア / 位置情報・動態履歴) で共有する theearth
 * credential pass-through セッション (Refs #90)。
 *
 * - パスワードはログイン 1 リクエストの body にだけ載り、どこにも保存しない
 * - token は localStorage に保持 (サーバ側 DO の TTL 8h で失効)
 * - リクエストは X-Dvr-Comp-Id / X-Dvr-User-B64 ヘッダで theearth アカウント単位の
 *   DtakoScraperRelayDO (`dvr-{comp}:{userB64}`) に routing される
 */
export interface DvrSession {
  compId: string
  userName: string
  token: string
}

const SESSION_STORAGE_KEY = 'dvr-viewer-session'

/** 前回ログインした会社ID/ユーザーID (パスワード以外) のプリフィル用。 */
const LAST_ACCOUNT_KEY = 'dvr-viewer-last-account'

/** UTF-8 文字列を base64url (padding 無し) に encode する。relay worker 側の
 * dvr-session.ts の encodeDvrUserB64 と同一形式 (ヘッダに日本語を載せるため)。 */
function b64urlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function dvrErrorMessage(e: unknown): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data
  if (data && typeof data.error === 'string') return data.error
  return e instanceof Error ? e.message : String(e)
}

export function dvrErrorStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

export function useDvrSession() {
  const session = useState<DvrSession | null>('dvr-session', () => null)
  const loginError = useState<string | null>('dvr-login-error', () => null)
  const showLoginPanel = useState<boolean>('dvr-login-panel', () => false)

  function routingHeaders(compId: string, userName: string): Record<string, string> {
    return {
      'X-Dvr-Comp-Id': compId,
      'X-Dvr-User-B64': b64urlUtf8(userName),
    }
  }

  /** ログイン済みセッションの API 呼び出しヘッダ。未ログインなら空。 */
  function authHeaders(): Record<string, string> {
    const s = session.value
    if (!s) return {}
    return {
      ...routingHeaders(s.compId, s.userName),
      'Authorization': `Bearer ${s.token}`,
    }
  }

  function persistSession(s: DvrSession | null) {
    session.value = s
    try {
      // token はブラウザを閉じても保持する (localStorage)。パスワードは保存しない。
      if (s) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(s))
      else localStorage.removeItem(SESSION_STORAGE_KEY)
    }
    catch {
      // localStorage 不可 (プライベートモード等) でも動作は継続する (再読込で再ログイン)
    }
  }

  /** localStorage から前回セッションを復元する (ページの onMounted で呼ぶ)。 */
  function restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY)
      if (raw) session.value = JSON.parse(raw) as DvrSession
    }
    catch {
      session.value = null
    }
  }

  /** 前回ログインした会社ID/ユーザーID (ログインフォームのプリフィル用)。 */
  function lastAccount(): { compId: string, userName: string } {
    try {
      const raw = localStorage.getItem(LAST_ACCOUNT_KEY)
      if (raw) {
        const last = JSON.parse(raw) as { compId?: string, userName?: string }
        return { compId: last.compId ?? '', userName: last.userName ?? '' }
      }
    }
    catch {
      // プリフィルは best-effort
    }
    return { compId: '', userName: '' }
  }

  /** theearth にログインする。失敗時は throw (呼び出し側で dvrErrorMessage 表示)。 */
  async function login(compId: string, userName: string, userPass: string): Promise<void> {
    const res = await $fetch<{ token: string }>('/dvr-api/login', {
      method: 'POST',
      headers: routingHeaders(compId, userName),
      body: { user_pass: userPass },
    })
    persistSession({ compId, userName, token: res.token })
    try {
      localStorage.setItem(LAST_ACCOUNT_KEY, JSON.stringify({ compId, userName }))
    }
    catch {
      // プリフィルは best-effort
    }
    loginError.value = null
    showLoginPanel.value = false
  }

  async function logout(): Promise<void> {
    const s = session.value
    if (s) {
      try {
        await $fetch('/dvr-api/logout', { method: 'POST', headers: authHeaders() })
      }
      catch {
        // best-effort (セッションが既に切れていても手元は消す)
      }
    }
    persistSession(null)
    loginError.value = null
    showLoginPanel.value = true
  }

  /** 401 (token/theearth セッション切れ) を受けた時の共通処理。ページ側のデータ破棄は
   * `watch(session)` (null 遷移) で行う。 */
  function expireSession(message: string) {
    persistSession(null)
    loginError.value = message
    showLoginPanel.value = true
  }

  return {
    session,
    loginError,
    showLoginPanel,
    authHeaders,
    persistSession,
    restoreSession,
    lastAccount,
    login,
    logout,
    expireSession,
  }
}
