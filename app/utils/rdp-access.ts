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
 * `wss://host` → `https://host/health`。
 *
 * 設定は WS 用に `wss://` で持っている (`scraperRelayUrl` と同じ形) ので、
 * 遷移用に http scheme へ直す。
 */
export function accessLoginUrl(base: string): string {
  return `${trimSlash(base).replace(/^ws(s?):\/\//, 'http$1://')}${ACCESS_LOGIN_PATH}`
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
