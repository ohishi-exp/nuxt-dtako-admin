/**
 * theearth-np.com credential pass-through セッションの共有 composable。
 * DVR viewer 系 (`/dvr-api`) と日報編集 (`/daily-report-api`) は **同一の
 * theearth ログインセッションを共有する** (Refs #233。かつては Refs #169 の
 * 設計で localStorage キー・useState namespace・ルーティングヘッダ・worker 側
 * DO instance まで別々だったが、theearth が同一アカウントの同時ログインを
 * 許さないため、ページを移動するたびに互いのセッションを kick し合い再ログイン
 * になる実害があった)。
 *
 * - パスワードはログイン 1 リクエストの body にだけ載り、どこにも保存しない
 * - token は localStorage に保持 (サーバ側 DO の TTL 8h で失効)
 * - リクエストは `X-Theearth-Comp-Id` / `X-Theearth-User-B64` ヘッダで
 *   theearth アカウント単位の DtakoScraperRelayDO (`theearth-{comp}:{userB64}`)
 *   に routing される
 */
export interface TheearthAccountSession {
  compId: string
  userName: string
  token: string
}

/** routing ヘッダの prefix。worker 側は旧 `X-Dvr-*` / `X-Report-*` も受理する
 * (デプロイ順 skew 対応) が、フロントは統合後この 1 系統だけを送る。 */
const HEADER_PREFIX = 'X-Theearth'
/** `useState` の名前空間。dvr / daily-report の全ページで共有する。 */
const STATE_NAMESPACE = 'theearth'
/** セッション本体を保存する localStorage key (全ページ共有)。 */
const STORAGE_KEY = 'theearth-session'
/** 前回ログインした会社ID/ユーザーIDのプリフィル用 localStorage key。 */
const LAST_ACCOUNT_STORAGE_KEY = 'theearth-last-account'
/** 統合前 (Refs #169) の per-ページ プリフィルキー。読み取り fallback 専用 —
 * 書き込みは新キーのみ。 */
const LEGACY_LAST_ACCOUNT_STORAGE_KEYS = [
  'dvr-viewer-last-account',
  'daily-report-edit-last-account',
]

/** UTF-8 文字列を base64url (padding 無し) に encode する。relay worker 側の
 * `workers/dtako-scraper-relay/src/theearth-session.ts` の encodeUserB64 と
 * 同一形式 (ヘッダに日本語を載せるため)。restraint-wage の閲覧モード (Refs #272)
 * が viewer ヘッダの組み立てにも使うため export。 */
export function b64urlUtf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * `$fetch` のエラーから**人が読める理由**だけを取り出す (Refs #890)。
 *
 * theearth 系ページ (dvr / net780 / daily-report / restraint) は全部この 1 本を
 * `dvrErrorMessage` / `net780ErrorMessage` / `dailyReportErrorMessage` /
 * `restraintErrorMessage` という別名で呼んでいる。
 *
 * ## ★ 本文の形は**呼び先で 2 通りある** — `error` が真偽値のときに落ちていた
 *
 * | 呼び先 | 本文 | `data.error` |
 * |---|---|---|
 * | relay (`/dvr-api` `/net780-api` `/daily-report-api` `/restraint-api`) | `{ error: '<日本語>' }` (`dtako-scraper-relay-do.ts` の `dvrJsonError`) | **文字列** |
 * | 自前 `server/api/**` (`/api/ichiban/**` `/api/kyuyo/**`) | `{ error: true, url, statusCode, statusMessage, message, data }` (`nitropack/dist/runtime/internal/error/prod.mjs`) | **真偽値** |
 *
 * 以前は `typeof data.error === 'string'` で当たらなければ `e.message` に落として
 * いたので、**Nitro 経路では日本語が丸ごと消えていた**。`e.message` は ofetch が
 * HTTP の reason phrase から組むもので、**本番は HTTP/3 = reason phrase そのものが
 * 無い**ため `[GET] "…": 503` で終わる (#890 の親コメント、v0.0.563 実測)。
 * ⇒ **文字列である最初の 1 つ**を選ぶ形にした。`app/utils/api-error.ts` の
 * `describeApiError` と**同じ規則・同じ順序** (`error` → `message` → `statusMessage`)。
 * 順序の根拠 (なぜ `message` を `statusMessage` より先に見るか) はそちらの doc を読む。
 *
 * relay の `{ error: '<日本語>' }` は `find` の**先頭**で当たるので、**relay 経路の
 * 出力は 1 文字も変わらない**。
 *
 * ## ★ `describeApiError` と違って `statusCode` を前置しない (契約が別)
 *
 * この関数の契約は「**理由の文字列だけ**」。呼び出し側は
 * `expireSession(theearthSessionErrorMessage(e))` のようにセッション失効の説明文へ
 * 埋めたり、既に status を別に出している注記に足したりする。**揃えようとしないこと。**
 *
 * ## ★ `responseType: 'blob'` の呼び出しには効かない (仕様)
 *
 * ofetch は**エラー応答の本文も `responseType` で読む** (`ofetch/dist/shared/*.mjs`
 * の `switch (responseType)` は 4xx/5xx でも通る)。⇒ `net780/index.vue` の
 * `$fetch<Blob>('/net780-api/…', { responseType: 'blob' })` では `e.data` が **Blob**
 * になり、ここも `describeApiError` も本文を 1 バイトも読めない (実測、Refs #890)。
 * その経路は `e.message` に落ちる — **いままでと同じ**で、後退はしない。
 */
export function theearthSessionErrorMessage(e: unknown): string {
  const data = (e as { data?: { error?: unknown, message?: unknown, statusMessage?: unknown } } | null)?.data
  // ★ `??` で繋がない — Nitro の本文は `error` が真偽値なので `true` で止まる
  //   (`app/utils/api-error.ts` と同じ罠。Refs #890)。
  const picked = data ? [data.error, data.message, data.statusMessage].find(v => typeof v === 'string') : undefined
  if (typeof picked === 'string') return picked
  return e instanceof Error ? e.message : String(e)
}

export function theearthSessionErrorStatus(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status
  return typeof status === 'number' ? status : null
}

/** 直前のログインで既存セッションを強制ログアウト (kick) したかどうか。
 * ライセンス数超過時の自動 kick (worker `theearth-client.ts` の login() 参照) を
 * フロントで可視化するために使う。 */
export interface TheearthLoginKick {
  kickedUserName?: string
}

/**
 * @param apiPrefix login/logout を叩く API のベースパス (例 `/dvr-api`、
 * `/daily-report-api`)。worker 側でどちらの login/logout も同一 DO・同一
 * セッションレコードに落ちるため、セッション状態はどの prefix 経由でも共有される。
 */
export function useTheearthSession(apiPrefix: string) {
  const session = useState<TheearthAccountSession | null>(`${STATE_NAMESPACE}-session`, () => null)
  const loginError = useState<string | null>(`${STATE_NAMESPACE}-login-error`, () => null)
  const showLoginPanel = useState<boolean>(`${STATE_NAMESPACE}-login-panel`, () => false)
  const lastLoginKick = useState<TheearthLoginKick | null>(`${STATE_NAMESPACE}-login-kick`, () => null)

  function routingHeaders(compId: string, userName: string): Record<string, string> {
    return {
      [`${HEADER_PREFIX}-Comp-Id`]: compId,
      [`${HEADER_PREFIX}-User-B64`]: b64urlUtf8(userName),
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
      if (s) localStorage.setItem(STORAGE_KEY, JSON.stringify(s))
      else localStorage.removeItem(STORAGE_KEY)
    }
    catch {
      // localStorage 不可 (プライベートモード等) でも動作は継続する (再読込で再ログイン)
    }
  }

  /** localStorage から前回セッションを復元する (ページの onMounted で呼ぶ)。 */
  function restoreSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) session.value = JSON.parse(raw) as TheearthAccountSession
    }
    catch {
      session.value = null
    }
  }

  /** 前回ログインした会社ID/ユーザーID (ログインフォームのプリフィル用)。 */
  function lastAccount(): { compId: string, userName: string } {
    for (const key of [LAST_ACCOUNT_STORAGE_KEY, ...LEGACY_LAST_ACCOUNT_STORAGE_KEYS]) {
      try {
        const raw = localStorage.getItem(key)
        if (raw) {
          const last = JSON.parse(raw) as { compId?: string, userName?: string }
          return { compId: last.compId ?? '', userName: last.userName ?? '' }
        }
      }
      catch {
        // プリフィルは best-effort
      }
    }
    return { compId: '', userName: '' }
  }

  /** theearth にログインする。失敗時は throw (呼び出し側で theearthSessionErrorMessage 表示)。 */
  async function login(compId: string, userName: string, userPass: string): Promise<void> {
    const res = await $fetch<{ token: string, kicked?: boolean, kicked_user_name?: string }>(`${apiPrefix}/login`, {
      method: 'POST',
      headers: routingHeaders(compId, userName),
      body: { user_pass: userPass },
    })
    persistSession({ compId, userName, token: res.token })
    try {
      localStorage.setItem(LAST_ACCOUNT_STORAGE_KEY, JSON.stringify({ compId, userName }))
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
        await $fetch(`${apiPrefix}/logout`, { method: 'POST', headers: authHeaders() })
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
