/**
 * theearth-np.com credential pass-through セッションの汎用 composable factory。
 * `useDvrSession.ts` (Refs #90) と `useDailyReportSession.ts` (Refs #169) は
 * 別々の theearth ログインセッションを持つ (worker 側 DO instance も
 * `dvr-{comp}:{userB64}` / `report-{comp}:{userB64}` で分離される) が、
 * ロジック自体はヘッダ名・API prefix・保存キーが違うだけの完全な重複だった。
 * rule-of-two (同じロジックの3個目のコピーを作らない) に沿って、この factory
 * を土台に両者を薄いラッパーとして具体化する。
 *
 * - パスワードはログイン 1 リクエストの body にだけ載り、どこにも保存しない
 * - token は localStorage に保持 (サーバ側 DO の TTL 8h で失効)
 * - リクエストは `{headerPrefix}-Comp-Id` / `{headerPrefix}-User-B64` ヘッダで
 *   theearth アカウント単位の DtakoScraperRelayDO に routing される
 */
export interface TheearthAccountSession {
  compId: string
  userName: string
  token: string
}

/** UTF-8 文字列を base64url (padding 無し) に encode する。relay worker 側の
 * `workers/dtako-scraper-relay/src/theearth-session.ts` の encodeUserB64 と
 * 同一形式 (ヘッダに日本語を載せるため)。 */
function b64urlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function theearthSessionErrorMessage(e: unknown): string {
  const data = (e as { data?: { error?: unknown } } | null)?.data
  if (data && typeof data.error === 'string') return data.error
  return e instanceof Error ? e.message : String(e)
}

export function theearthSessionErrorStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

export interface TheearthSessionOptions {
  /** API のベースパス (例 `/dvr-api`、`/daily-report-api`)。login/logout はこの下。 */
  apiPrefix: string
  /** routing ヘッダの prefix (例 `X-Dvr`、`X-Report`)。 */
  headerPrefix: string
  /** `useState` の名前空間 (例 `dvr`、`daily-report`)。他の composable と衝突しない値にする。 */
  stateNamespace: string
  /** セッション本体を保存する localStorage key。 */
  storageKey: string
  /** 前回ログインした会社ID/ユーザーIDのプリフィル用 localStorage key。 */
  lastAccountStorageKey: string
}

/** 直前のログインで既存セッションを強制ログアウト (kick) したかどうか。
 * ライセンス数超過時の自動 kick (worker `theearth-client.ts` の login() 参照) を
 * フロントで可視化するために使う。 */
export interface TheearthLoginKick {
  kickedUserName?: string
}

export function useTheearthSession(opts: TheearthSessionOptions) {
  const session = useState<TheearthAccountSession | null>(`${opts.stateNamespace}-session`, () => null)
  const loginError = useState<string | null>(`${opts.stateNamespace}-login-error`, () => null)
  const showLoginPanel = useState<boolean>(`${opts.stateNamespace}-login-panel`, () => false)
  const lastLoginKick = useState<TheearthLoginKick | null>(`${opts.stateNamespace}-login-kick`, () => null)

  function routingHeaders(compId: string, userName: string): Record<string, string> {
    return {
      [`${opts.headerPrefix}-Comp-Id`]: compId,
      [`${opts.headerPrefix}-User-B64`]: b64urlUtf8(userName),
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

  function persistSession(s: TheearthAccountSession | null) {
    session.value = s
    try {
      // token はブラウザを閉じても保持する (localStorage)。パスワードは保存しない。
      if (s) localStorage.setItem(opts.storageKey, JSON.stringify(s))
      else localStorage.removeItem(opts.storageKey)
    }
    catch {
      // localStorage 不可 (プライベートモード等) でも動作は継続する (再読込で再ログイン)
    }
  }

  /** localStorage から前回セッションを復元する (ページの onMounted で呼ぶ)。 */
  function restoreSession() {
    try {
      const raw = localStorage.getItem(opts.storageKey)
      if (raw) session.value = JSON.parse(raw) as TheearthAccountSession
    }
    catch {
      session.value = null
    }
  }

  /** 前回ログインした会社ID/ユーザーID (ログインフォームのプリフィル用)。 */
  function lastAccount(): { compId: string, userName: string } {
    try {
      const raw = localStorage.getItem(opts.lastAccountStorageKey)
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

  /** theearth にログインする。失敗時は throw (呼び出し側で theearthSessionErrorMessage 表示)。 */
  async function login(compId: string, userName: string, userPass: string): Promise<void> {
    const res = await $fetch<{ token: string, kicked?: boolean, kicked_user_name?: string }>(`${opts.apiPrefix}/login`, {
      method: 'POST',
      headers: routingHeaders(compId, userName),
      body: { user_pass: userPass },
    })
    persistSession({ compId, userName, token: res.token })
    try {
      localStorage.setItem(opts.lastAccountStorageKey, JSON.stringify({ compId, userName }))
    }
    catch {
      // プリフィルは best-effort
    }
    loginError.value = null
    showLoginPanel.value = false
    lastLoginKick.value = res.kicked ? { kickedUserName: res.kicked_user_name } : null
  }

  async function logout(): Promise<void> {
    const s = session.value
    if (s) {
      try {
        await $fetch(`${opts.apiPrefix}/logout`, { method: 'POST', headers: authHeaders() })
      }
      catch {
        // best-effort (セッションが既に切れていても手元は消す)
      }
    }
    persistSession(null)
    loginError.value = null
    showLoginPanel.value = true
    lastLoginKick.value = null
  }

  /** 401 (token/theearth セッション切れ) を受けた時の共通処理。ページ側のデータ破棄は
   * `watch(session)` (null 遷移) で行う。 */
  function expireSession(message: string) {
    persistSession(null)
    loginError.value = message
    showLoginPanel.value = true
    lastLoginKick.value = null
  }

  return {
    session,
    loginError,
    showLoginPanel,
    lastLoginKick,
    authHeaders,
    persistSession,
    restoreSession,
    lastAccount,
    login,
    logout,
    expireSession,
  }
}
