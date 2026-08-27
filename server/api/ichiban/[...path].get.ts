/**
 * rust-ichibanboshi (一番星売上 API、CAPE#01 経由) への thin proxy (Refs #330)。
 *
 * GET /api/ichiban/** → <NUXT_ICHIBAN_API_URL>/** (CF Tunnel rust-ichiban.mtamaramu.com)
 * に CF Access Service Token (CF-Access-Client-Id/Secret ヘッダ) を付与して転送する。
 * Service Token は nuxt-ichibanboshi/nuxt-ichibanboshi-seikyu と共有する既存のもの
 * (`824a8b3c...`) を再利用する (新規発行しない)。client_id は公開識別子なので
 * `NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID` var、client_secret は Secrets Store binding
 * (`ICHIBAN_CF_ACCESS_CLIENT_SECRET`、secret_name="CF_ACCESS_CLIENT_SECRET" を
 * 物理共有) から解決する。追加の secrets-inventory 投入作業は不要 (wrangler.toml 参照)。
 *
 * upstream の応答は **status を変えず、本文があればそのまま passthrough** する —
 * 400 等の API 側エラーも呼び出し元がそのまま受け取れるようにするための thin proxy
 * であり、意味づけはしない。
 *
 * ★ **例外は 1 つだけ — 本文が空の非 2xx** (Refs #900)。一番星はエラー側の型が素の
 * `StatusCode` で、axum が**本文を 1 バイトも返さない**。空のまま素通しすると画面に
 * 出るのは ofetch が自分で組んだ `[GET] "…": 503` だけになり、**「一番星が落ちた」と
 * いういちばん知りたいことが 1 文字も出ない**。**そのときに限って**
 * `{"error":"<日本語の理由>"}` をこちらで作って返す — **status は変えない**し、
 * **本文がある応答は 1 文字も触らない** (上流が理由を持っているならそれが正)。
 *
 * ## `requireAuth` を付ける (Refs #988)
 *
 * ここは長らく **Cloudflare Access だけが前段**で、Nitro 側に認可が 1 つも無かった
 * (`docs/plan-922-single-signin.md` §1)。Access は edge の設定であって
 * **この repo が意図して置いた防御ではない**ため、外した瞬間にこの route は
 * 「呼び出し元の身元を一切見ずに Service Token を付けて上流へ転送する」
 * classic な confused deputy になる。
 *
 * ★ **なぜ姉妹の `/api/kyuyo/**` と機構が違うのか。**あちらは上流へ渡す身元
 * (ブラウザ JWT) を持っており、認可の正本も上流 (rust-ichibanboshi の introspect +
 * email allowlist) にあるので、「**渡す身元が無いときに黙って転送する**」ところだけを
 * 塞げば済む (`resolveBrowserAuthorization` が `null` なら 401)。
 * **この route はそもそも身元を 1 つも持っていない** — `Authorization` を見も付けも
 * しないので「無ければ止める」対象が存在しない。⇒ **Nitro 側が独立に認証する**しかなく、
 * `requireAuth` (auth-worker ログイン必須) を使う。`server/api/profit/margin-summary.post.ts`
 * (#995) と同じ形。
 *
 * ★★ **上流の側にも受け皿が無い点が `/api/kyuyo/**` と決定的に違う** (2026-08-27 に
 * `ohishi-exp/rust-ichibanboshi` の `origin/main` = `a17067a` を実読して確認)。
 * あちらは `kyuyo::introspect::authorize()` が Bearer 無しを 401 で弾く fail-closed
 * で、**この proxy が身元なしで転送しても上流が止めていた** (それでも塞いだのは、
 * 防御が上流の実装依存でこちらから保証できないため)。**こちらにはその段が無い** —
 * `authorize()` を呼ぶのは上流の `src/routes/kyuyo.rs` **だけ**で、全体に掛かる
 * auth 系の layer / middleware も無い (`src/server.rs`)。
 * ⇒ **この route の前段は実質 Cloudflare Access だけ**だった
 * (`docs/plan-922-single-signin.md` §1 の指摘どおり)。
 *
 * ★ **上流へ browser JWT を転送するようにはしない** — 上流は email allowlist を
 * 持っているので、**いままで 200 だった呼び出しが 403 になりうる** (画面の挙動が
 * 変わる)。それは別の判断で、ここでは扱わない。
 *
 * 呼ぶのは粗利・運行手当・突合・一番星ヘルスの**ブラウザだけ**で、relay / cron /
 * service binding / MCP からの呼び出しは無い (2026-08-27 に repo 全体を語を変えて
 * `git grep` + `scripts/xref.sh` で確認。`app/**` 以外のヒットは全て JSDoc か、
 * 上流 rust を直接叩く relay / kyuyo-mcp のもので、この Nitro route は通らない)。
 *
 * 401 — 未ログイン (`requireAuth`)。**空本文の非 2xx に理由を作る下の分岐より手前で
 * 投げる**ので、passthrough の契約 (Refs #900) には触れていない。
 * binding 未設定は 503 (`INTERNAL_SHARED_SECRET` / CF Access の 2 つ)、
 * fetch 自体の失敗 (tunnel down 等) は 502 で弾く。
 *
 * CF Access トークン付与ロジック本体は `server/utils/ichiban-upstream.ts` に集約
 * (もとは server/api/profit/monthly.get.ts と共有していたが、そちらは #859 で廃止。
 * Refs #330 PR4)。
 */
import type { H3Event } from 'h3'
import { defineEventHandler, getRequestURL, getRouterParam, createError, setResponseStatus, setHeader } from 'h3'
import { fetchIchiban, cfEnv, ichibanEmptyErrorReason, type IchibanUpstreamError } from '../../utils/ichiban-upstream'
import { requireAuth } from '@ippoan/auth-client/server'
import { resolveSecret } from '../../utils/cf-env'

export default defineEventHandler(async (event: H3Event) => {
  const env = cfEnv(event)
  const pathParam = getRouterParam(event, 'path') ?? ''

  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    throw createError({ statusCode: 503, statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です' })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **上流を叩く前に認証する。** ここを通れる範囲が「Access を通れる人」から
  // 「auth-worker にログインしている人」に狭まる。
  await requireAuth(event, { authWorkerUrl, sharedSecret })

  let upstreamRes: Response
  try {
    upstreamRes = await fetchIchiban(env, pathParam, getRequestURL(event).search)
  }
  // fetchIchiban は IchibanUpstreamError (503/502) のみを throw する契約 (同ファイルの JSDoc 参照)。
  catch (e: unknown) {
    const err = e as IchibanUpstreamError
    throw createError({ statusCode: err.statusCode, statusMessage: err.message })
  }

  setResponseStatus(event, upstreamRes.status)
  const body = await upstreamRes.text()

  // **本文が空のエラーにだけ、日本語の理由を作って返す** (Refs #900)。
  // 一番星はエラー側が素の `StatusCode` なので本文を 1 バイトも返さず、そのまま
  // 素通しすると画面には ofetch が組んだ `[GET] "…": 503` しか出ない
  // (= 「一番星が落ちた」が画面から消える)。**本文がある応答は今までどおり無改変で
  // 素通しする** — 意味づけをしないのがこの proxy の契約で、上流が理由を持っている
  // ならそれが正しい。status も変えない (400/500/503 の意味は上流のもの)。
  if (upstreamRes.status >= 400 && body.trim() === '') {
    setHeader(event, 'Content-Type', 'application/json')
    return JSON.stringify({ error: ichibanEmptyErrorReason(upstreamRes.status, pathParam) })
  }

  const contentType = upstreamRes.headers.get('content-type')
  if (contentType) setHeader(event, 'Content-Type', contentType)
  return body
})
