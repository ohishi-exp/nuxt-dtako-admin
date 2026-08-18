/**
 * RemoteApp ビューア (`app/pages/remote-app.vue`) が繋ぐ中継の URL 組み立てと、
 * WebSocket を張る前に Cloudflare Access の cookie を確保する処理 (Refs #693)。
 *
 * 中継は公開ホスト名で出ていて、前段の Access が利用者を認証する。中継自身も
 * `Cf-Access-Jwt-Assertion` を JWKS で検証するので、cookie が無ければ 401 で閉じる。
 *
 * ## なぜ「先に cookie を確保する」処理が要るのか
 *
 * **`new WebSocket()` は 302 を辿れない。** Access の cookie (`CF_Authorization`) が
 * 無い状態で `wss://…/rdp` を開くと、Access が返すリダイレクトを WebSocket が
 * 処理できず、理由の分からない接続失敗になる。⇒ 先にブラウザの**ふつうの遷移**で
 * Access を通し、cookie を配ってもらってから WS を張る。
 *
 * cookie は同じ site (`*.ippoan.org`) 宛なので、配られた後は SameSite に関係なく
 * WebSocket のハンドシェイクにも載る。
 *
 * ## cookie の有無を fetch では測れない
 *
 * 中継の `/health` は素の 200 (`ok`) を返すだけで CORS ヘッダを持たず、Access も
 * この経路の preflight を 403 で落とす (実測)。⇒ 認証済みでも cross-origin の
 * `fetch` は失敗するので、「失敗した = 未ログイン」と読めない。
 *
 * **測るのは WebSocket 自身にする。** `/rdp` を開いて `open` が来たなら、Access も
 * 中継の JWT 検証も通っている — つまり本番で使う経路そのものを測ったことになる。
 */

/** 中継の待ち受けパス。ここに WebSocket を張る。 */
const RDP_PATH = '/rdp'

/**
 * Access のログイン遷移に使うパス。中継側は無認証で `ok` を返すので、
 * 表示されたら「Access を通った」ことだけが分かる。
 */
const ACCESS_LOGIN_PATH = '/health'

/**
 * 配置先ごとの既定値を配る口 (`rust-ichibanboshi` の `rdp_defaults.rs`)。
 * 宛先は中継の allowlist そのものなので、**画面は同じ値を持たない**。
 */
const DEFAULTS_PATH = '/defaults'

/**
 * 疎通確認 1 回の制限時間。
 *
 * **5 秒より短くしてある。** 未ログインなら Access が即 302 を返すので通常は 1 秒も
 * かからないが、詰まったときにここで待ちすぎると、後続の `window.open` が
 * ブラウザの transient activation (クリックから約 5 秒) を外れてブロックされる。
 */
export const PROBE_TIMEOUT_MS = 4_000

/** ログイン完了を待つ間隔。 */
export const POLL_INTERVAL_MS = 1_000

/** ログイン完了を待つ上限。IdP でパスワードを打つ時間を見込む。 */
export const LOGIN_TIMEOUT_MS = 180_000

export const POPUP_BLOCKED
  = 'Cloudflare Access のログイン画面を開けませんでした (ポップアップがブロックされています)。'
    + 'このサイトのポップアップを許可してから、もう一度「接続」を押してください。'

export const LOGIN_CLOSED
  = 'Cloudflare Access のログインが終わる前に画面が閉じられました。もう一度「接続」を押してください。'

export const LOGIN_TIMEOUT
  = 'Cloudflare Access のログインを確認できませんでした。もう一度「接続」を押してください。'

/** テストから WebSocket / ポップアップ / 待ち時間を差し替えるための口。 */
export interface AccessDeps {
  WebSocketCtor: typeof WebSocket
  /** Access のログイン画面を開く。ブロックされたら `null`。 */
  openWindow: (url: string) => Window | null
  sleep: (ms: number) => Promise<void>
}

/** 実ブラウザ用の既定。呼ばれた時点の global を見る (テストで差し替えられるように)。 */
export function browserDeps(): AccessDeps {
  return {
    WebSocketCtor: globalThis.WebSocket,
    openWindow: url => window.open(url, 'rdp-access-login', 'width=520,height=680'),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  }
}

/** 末尾の `/` を落とす。`wss://host/` と `wss://host` を同じに扱う。 */
function trimSlash(base: string): string {
  return base.replace(/\/+$/, '')
}

/** `wss://host` → `wss://host/rdp`。 */
export function rdpWsUrl(base: string): string {
  return `${trimSlash(base)}${RDP_PATH}`
}

/**
 * `wss://host` → `https://host`。
 *
 * 設定は WS 用に `wss://` で持っている (`scraperRelayUrl` と同じ形) ので、
 * HTTP で読む口はここで scheme を直す。
 */
function httpBase(base: string): string {
  return trimSlash(base).replace(/^ws(s?):\/\//, 'http$1://')
}

/** Access のログイン遷移に使う URL。 */
export function accessLoginUrl(base: string): string {
  return `${httpBase(base)}${ACCESS_LOGIN_PATH}`
}

/** 中継が配る接続の既定値。**資格情報は入っていない** (利用者ごとに違うため)。 */
export interface RdpDefaults {
  /** 繋ぎ先。中継の allowlist そのものなので、画面の値より優先してよい。 */
  destination: string
  domain: string
  remoteApp: string
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * 中継の `/defaults` を読む。**読めなければ `null`** で、画面は利用者の入力を使う。
 *
 * 失敗の形は 3 つあってどれも区別しない — cookie が無い (Access の 302 が
 * CORS で読めない)、中継が古くて口が無い (404)、CORS 未設定 (応答は返るが読めない)。
 * どれも「既定値が無い」として同じに扱えば、画面は入力欄で成立し続ける。
 */
export async function fetchRdpDefaults(
  base: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<RdpDefaults | null> {
  try {
    const res = await fetchFn(`${httpBase(base)}${DEFAULTS_PATH}`, { credentials: 'include' })
    if (!res.ok) return null
    const body = await res.json() as Record<string, unknown>
    return {
      destination: asString(body.destination),
      domain: asString(body.domain),
      remoteApp: asString(body.remote_app),
    }
  }
  catch {
    return null
  }
}

/**
 * 中継へ WebSocket を 1 本張ってみて、Access を通れるかだけ見る。
 *
 * `open` まで来たら即閉じる。RDCleanPath を送っていないので中継側は何もせず終わる。
 */
export function probeAccessSession(wsUrl: string, deps: AccessDeps): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new deps.WebSocketCtor(wsUrl)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (ok: boolean) => {
      // open の直後に close が来るなど、2 度目以降は捨てる。
      if (settled) return
      settled = true
      clearTimeout(timer)
      ws.close()
      resolve(ok)
    }
    timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS)
    ws.onopen = () => finish(true)
    ws.onerror = () => finish(false)
    ws.onclose = () => finish(false)
  })
}

/**
 * Access の cookie がある状態にしてから返る。無ければログイン画面を開いて待つ。
 *
 * **`window.open` はクリック直後にしか通らない** (transient activation) ので、
 * 呼ぶ側はユーザー操作のハンドラの先頭で await すること。
 */
export async function ensureAccessSession(base: string, deps: AccessDeps = browserDeps()): Promise<void> {
  const wsUrl = rdpWsUrl(base)
  if (await probeAccessSession(wsUrl, deps)) return

  const win = deps.openWindow(accessLoginUrl(base))
  if (!win) throw new Error(POPUP_BLOCKED)

  const attempts = Math.ceil(LOGIN_TIMEOUT_MS / POLL_INTERVAL_MS)
  for (let i = 0; i < attempts; i++) {
    await deps.sleep(POLL_INTERVAL_MS)
    if (await probeAccessSession(wsUrl, deps)) {
      // ログイン後は `/health` の `ok` が出たまま残るので、こちらで閉じる。
      win.close()
      return
    }
    // 利用者が閉じたなら待ち続けない。待っても cookie は来ない。
    if (win.closed) throw new Error(LOGIN_CLOSED)
  }
  win.close()
  throw new Error(LOGIN_TIMEOUT)
}
