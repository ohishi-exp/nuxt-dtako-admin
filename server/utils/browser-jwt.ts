/**
 * ブラウザの auth-worker JWT を server route 側で解決するヘルパ (Refs #375)。
 *
 * client が `Authorization: Bearer` を手で組むのをやめ、**同一オリジンで自動送信される
 * cookie (`logi_auth_token`) を正**にするためのもの。ippoan/auth-worker#416 (cookie の
 * HttpOnly 化) の子タスクで、HttpOnly になると `document.cookie` から token を読めなく
 * なる = client はヘッダを組めなくなる。
 *
 * ## 優先順: cookie → dev cookie → 受領した `Authorization`
 *
 * 最後の 1 段は**デプロイ skew のための後方互換**であって、「cookie が届かない環境」を
 * 支える経路ではない — この worker の全 env (`wrangler.toml` の top-level / `env.staging` /
 * `env.preview`) は `*.ippoan.org` の route を持ち `workers_dev = false` なので、
 * `Domain=.ippoan.org` の共有 cookie は必ず届く。新しい worker がデプロイされてから
 * 古いバンドルを掴んだままのタブが消えるまでの間だけ、この段が効く。
 *
 * dev cookie (`logi_auth_token_dev`) は `DEV_LOGIN === 'true'` の時だけ見る
 * (`server/api/proxy/[...path].ts` に渡している `devLoginEnabled` と同じ条件。
 * ippoan/auth-worker#423/#425)。
 *
 * ## ここでは JWT を検証しない
 *
 * 給与系の認可は **upstream (rust-ichibanboshi の introspect + email allowlist、
 * Refs #556 / ohishi-exp/rust-ichibanboshi#82)** が持つ。この関数が決めるのは
 * 「どの文字列を upstream に渡すか」だけで、失効・allowlist 外の判定はしない
 * (upstream の 401/403 がそのまま passthrough される)。
 */
import type { H3Event } from 'h3'
import { getCookie, getHeader } from 'h3'

/** `.ippoan.org` 共有の認証 cookie 名 (`@ippoan/auth-client` の既定と同じ)。 */
export const AUTH_COOKIE_NAME = 'logi_auth_token'

/** dev-login 専用 cookie 名 (本番 cookie との混同防止で分けてある)。 */
export const DEV_AUTH_COOKIE_NAME = 'logi_auth_token_dev'

/**
 * upstream に渡す `Authorization` ヘッダ値 (`Bearer <JWT>`) を組み立てる。
 * どこからも token を取れなければ `null` — 呼び出し側が 401 にするか、ヘッダを
 * 付けずに転送して upstream に判断させるかを決める。
 */
export function resolveBrowserAuthorization(
  event: H3Event,
  env: Record<string, unknown>,
): string | null {
  const cookie = getCookie(event, AUTH_COOKIE_NAME)
  if (cookie) return `Bearer ${cookie}`

  if (env.DEV_LOGIN === 'true') {
    const devCookie = getCookie(event, DEV_AUTH_COOKIE_NAME)
    if (devCookie) return `Bearer ${devCookie}`
  }

  // デプロイ skew 用の後方互換 (上のモジュールコメント参照)。
  return getHeader(event, 'authorization') ?? null
}
