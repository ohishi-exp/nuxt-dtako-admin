/**
 * rust-ichibanboshi の給与大臣読み取り API (`/api/kyuyo/*`) への thin proxy (Refs #369)。
 *
 * GET /api/kyuyo/** → <NUXT_ICHIBAN_API_URL>/api/kyuyo/** に
 * ① CF Access Service Token (トンネル通過用、server だけが持つ) と
 * ② ブラウザの JWT を `Authorization: Bearer <JWT>` として付けて転送する。
 *
 * **② の JWT は cookie (`logi_auth_token`) から組む** (Refs #375) — client がヘッダを
 * 手で載せる必要は無い。優先順と後方互換の扱いは `server/utils/browser-jwt.ts` 参照。
 *
 * 給与データの認可は upstream 側 (rust-ichibanboshi の introspect + email allowlist、
 * ohishi-exp/rust-ichibanboshi#82) が担う — この proxy は JWT を検証しない。
 * allowlist 外ユーザーは upstream が 403 を返し、それをそのまま passthrough する。
 *
 * ## 渡す身元が無ければ **401 で止める** (fail closed、Refs #988)
 *
 * **認可の正本は上流のまま**にする — rust-ichibanboshi の introspect + email allowlist
 * (`ohishi-exp/rust-ichibanboshi#82`) が判定し、この proxy は JWT を検証しない。
 * **その設計は変えない。**欠けていたのは「**`resolveBrowserAuthorization` が `null`
 * (= 上流に渡す身元を 1 つも取れなかった) のに、そのまま転送してしまう**」ことだけで、
 * そこだけを塞ぐ。
 *
 * ★★ **「無防備だった」とは書かない — 上流は fail-closed である** (2026-08-27 に
 * `ohishi-exp/rust-ichibanboshi` の `origin/main` = `a17067a` を実読して確認)。
 * `src/kyuyo/introspect.rs` の `authorize()` は `Authorization: Bearer` が無ければ
 * **401 (`"Authorization: Bearer <JWT> が必要です"`)** を返し、introspect 未設定や
 * allowlist 空なら 503 に倒す。`/kyuyo/*` に mount されている **7 route が 7 本とも
 * `authorize()` を通る** (`src/server.rs`)。⇒ **身元なしの転送が上流でデータに化けた
 * わけではない。**
 *
 * **ではなぜ塞ぐのか** — その防御が**まるごと上流の実装に依存していて、この repo からは
 * 何も保証できない**から。上流が 1 行変われば、この proxy は「身元が無いと分かっている
 * リクエストに CF Access Service Token を付けて転送する」ままになる。**こちら側が
 * 知っている事実 (身元が取れなかった) で、こちら側が止める**のが筋。
 * 往復も 1 回減る。
 *
 * ★ **ここに `requireAuth` を足さない** (`/api/ichiban/**` とは機構が違う)。
 * 足すと introspect の往復が 1 回増えるうえ、**認可の正本が 2 か所になる**。
 * あちらは上流へ渡す身元をそもそも持たないので `requireAuth` しか手が無いが、
 * こちらは持っている — 無いときに止めれば足りる。形は
 * `server/api/kyuyo-master/refresh.post.ts` / `refresh-full.post.ts` と同じ 3 行。
 *
 * ★ **通っていたものは今までどおり通る。**`resolveBrowserAuthorization` が見るのは
 * cookie (`logi_auth_token`) → dev cookie (`DEV_LOGIN==='true'` のときだけ) →
 * 受領した `Authorization` の 3 経路で、そのどれかが取れれば挙動は 1 つも変わらない。
 * 変わるのは**3 つとも取れなかった呼び出しだけ**で、それは上流が 401 を返していた
 * (= 画面には元から出せていなかった) ものと同じ集合。
 *
 * 呼び出し元は本 repo の**ブラウザだけ** (`/kyuyo-fetch` `/restraint-wage`
 * `/ichiban-health`)。relay / cron / MCP は上流 rust を直接叩くのでこの Nitro route を
 * 通らない (2026-08-27 に語を変えて `git grep` + `scripts/xref.sh` で再確認。
 * `browser-jwt.ts` の同趣旨の記述と一致)。
 *
 * `/api/ichiban/**` proxy と違い upstream パスを `api/kyuyo/` 配下に固定し、
 * この route から給与以外のエンドポイントへは到達できないようにする。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getRequestURL, getRouterParam, createError, setResponseStatus, setHeader } from 'h3'
import { fetchIchiban, cfEnv, type IchibanUpstreamError } from '../../utils/ichiban-upstream'
import { resolveBrowserAuthorization } from '../../utils/browser-jwt'

export default defineEventHandler(async (event: H3Event) => {
  const env = cfEnv(event)
  const pathParam = getRouterParam(event, 'path') ?? ''

  const authorization = resolveBrowserAuthorization(event, env)
  if (!authorization) {
    throw createError({ statusCode: 401, statusMessage: 'ログインが必要です (認証 cookie が届いていません)' })
  }
  const extraHeaders: Record<string, string> = { Authorization: authorization }

  let upstreamRes: Response
  try {
    upstreamRes = await fetchIchiban(env, `api/kyuyo/${pathParam}`, getRequestURL(event).search, extraHeaders)
  }
  catch (e: unknown) {
    const err = e as IchibanUpstreamError
    throw createError({ statusCode: err.statusCode, statusMessage: err.message })
  }

  setResponseStatus(event, upstreamRes.status)
  const contentType = upstreamRes.headers.get('content-type')
  if (contentType) setHeader(event, 'Content-Type', contentType)
  return upstreamRes.text()
})
