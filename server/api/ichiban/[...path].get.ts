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
 * ## upstream path を allowlist で固定する (Refs #1015)
 *
 * #988 で入ったのは **認証**であって **認可**ではない。`requireAuth` が見ているのは
 * 「**誰が**呼んでいるか」までで、**この route が中継してよい path** は 1 か所も
 * 見ていなかった (`getRouterParam(event, 'path')` を素通しで `fetchIchiban` へ渡していた)。
 * この route は**呼び出し元が持っていない資格情報 (CF Access Service Token) を
 * こちらで付け足す**ので、中継先は画面が実際に使う口に固定する。
 *
 * 許す path は `ICHIBAN_PROXY_ALLOWED_PATHS` (`server/utils/ichiban-upstream.ts`) の
 * **完全一致 6 件**。前方一致にしない理由・front を数えた手順・「なぜ `fetchIchiban`
 * 側で照合しないか」は全部そちらの JSDoc に書いてある。**照合するのは path 部分だけで、
 * query string は今までどおり素通し。**
 *
 * ★ **範囲はこのファイル = GET だけ。**`.get.ts` なので書き込み系は元から通らない。
 *
 * 403 — allowlist 外 (この proxy が中継する path ではない)。**404 にしない** —
 * 「そんな path は無い」と読めてしまい、実際には「この proxy が許していないだけ」
 * という事実と食い違う。姉妹の proxy クラス (auth-worker 側の shared-secret allowlist)
 * が allowlist 外を 403 で返しているのと**同じ読み方に揃える**。
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
import { fetchIchiban, cfEnv, ichibanEmptyErrorReason, isAllowedIchibanProxyPath, type IchibanUpstreamError } from '../../utils/ichiban-upstream'
import { requireAuth } from '@ippoan/auth-client/server'
import { assertAllowedRole } from '../../utils/require-role'
// ★ **`resolveSecret` だけ `cf-env.ts` から取っているのは意図的** (Refs #999/#1015)。
// `ichiban-upstream.ts` にも同名があるが、あちらは `.get()` の reject を
// `catch { return null }` で握り潰す (= binding 故障が「未設定」と同じ 503 に化ける)。
// こちらは例外を伝播させる版で、理由は `cf-env.ts` の JSDoc。**片方に寄せない。**
import { resolveSecret } from '../../utils/cf-env'

export default defineEventHandler(async (event: H3Event) => {
  const env = cfEnv(event)
  const pathParam = getRouterParam(event, 'path') ?? ''

  const sharedSecret = await resolveSecret(env.INTERNAL_SHARED_SECRET)
  if (!sharedSecret) {
    // ★ **`statusMessage` は ASCII、理由は `message` (= JSON 本文) に日本語で置く**
    // (Refs #1032/#886)。下の 403 の注記に測定条件つきで書いた穴と同じ理由。
    throw createError({
      statusCode: 503,
      statusMessage: 'INTERNAL_SHARED_SECRET binding is not configured',
      message: 'INTERNAL_SHARED_SECRET binding が未設定です',
    })
  }
  const authWorkerUrl
    = typeof env.NUXT_PUBLIC_AUTH_WORKER_URL === 'string' && env.NUXT_PUBLIC_AUTH_WORKER_URL
      ? env.NUXT_PUBLIC_AUTH_WORKER_URL
      : 'https://auth.ippoan.org'
  // **上流を叩く前に認証する。** ここを通れる範囲が「Access を通れる人」から
  // 「auth-worker にログインしている人」に狭まる。
  const auth = await requireAuth(event, { authWorkerUrl, sharedSecret })
  assertAllowedRole(auth)

  // **認証のあとに path の認可** (Refs #1015)。順序を入れ替えないこと — 未ログインを
  // 403 で返すと「ログインしたら通る」ことが読めなくなる。
  //
  // ★ **理由は `message` (= JSON 本文) に日本語で置き、`statusMessage` は ASCII に留める**
  // (Refs #1032/#886)。画面に届くのは本文だけで (`describeApiError` が `d.message` を
  // 読む)、reason phrase は当てにならない。
  //
  // **なぜ `statusMessage` に日本語を残さないか — 実測 (2026-08-28、local `wrangler dev`
  // = 本物の workerd)**: 日本語を `statusMessage` に載せると reason phrase は空ではなく
  // **`HTTP/1.1 403 proxy`** になった (非 ASCII が落ちて `proxy` の断片だけ残る) —
  // **正しい reason phrase に見えるぶん、空より紛らわしい**。本文の側は当時から無傷で
  // 届いていたので実害は無いが、壊れて見えないぶん質が悪い。⇒ ASCII に寄せて断片を消す。
  // いまの本文はこうなる:
  //   {"error":true,"url":"…","statusCode":403,
  //    "statusMessage":"path is not relayed by this proxy",
  //    "message":"この proxy が中継するパスではありません"}
  // h3 の `createError` は `message` 未指定なら `statusMessage` を写すので、
  // **写させずに両方明示する** (写しに任せると本文まで ASCII になる)。
  //
  // ★ **この直しを front の他の経路へ広げないこと。**`app/utils/api.ts:784,826` /
  // `app/utils/netprint-run.ts:139` / `app/pages/kyuyo-fetch.vue:150,214` は
  // **`statusMessage` を `message` より先に読む** ので、同じ直しを netprint / kyuyo /
  // net780-archive の server route に当てると**画面の日本語が ASCII に化ける**。
  // `/api/ichiban/**` を読む front は全数が `message` 先 (`describeApiError` ないし
  // `theearthSessionErrorMessage` = `[error, message, statusMessage]`) か、
  // 本文を読まないかのどちらかであることを実測して確かめてある (Refs #1032)。
  //
  // ★ **upstream に何が在るかを示唆しない。**書くのは「この proxy が中継する path では
  // ない」までで、要求された path も echo しない。
  if (!isAllowedIchibanProxyPath(pathParam)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'path is not relayed by this proxy',
      message: 'この proxy が中継するパスではありません',
    })
  }

  let upstreamRes: Response
  try {
    upstreamRes = await fetchIchiban(env, pathParam, getRequestURL(event).search)
  }
  // fetchIchiban は IchibanUpstreamError (503/502) のみを throw する契約 (同ファイルの JSDoc 参照)。
  catch (e: unknown) {
    const err = e as IchibanUpstreamError
    // ★ **`err.message` を `statusMessage` に載せない** (Refs #1032/#886)。
    // 中身は `server/utils/ichiban-upstream.ts` の日本語 2 本
    // (`:118` の binding 未設定 = 503 / `:139` の接続失敗 = 502) で、**日本語のまま
    // reason phrase に流すと本番 (workerd) で断片だけが残る**。`statusMessage` は
    // **502/503 のどちらにも当てはまる ASCII の固定句**にし、上流の日本語は
    // `message` (= JSON 本文) にそのまま載せる。**`ichiban-upstream.ts` 側の文言は
    // 触らない** — 本文に載るので無傷でよい。
    throw createError({
      statusCode: err.statusCode,
      statusMessage: 'ichiban upstream request failed',
      message: err.message,
    })
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
