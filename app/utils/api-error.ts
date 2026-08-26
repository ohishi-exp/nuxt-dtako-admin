/**
 * ofetch が理由の代わりに組む `[GET] "/api/foo": 503 ` の形 (`createFetchError` の
 * `` `${requestStr}: ${statusStr}` ``、`ofetch/dist/shared/*.mjs`)。**method と URL を
 * 取り出すためだけ**に使う。手投げの `{ statusCode, message: 'Bad Gateway' }` は
 * この形に当たらないので、そちらは今までどおり `502 Bad Gateway` のまま。
 */
const OFETCH_SYNTHETIC_MESSAGE = /^\[([A-Z]+)\] "(.*)": \d{3}(?: |$)/

/**
 * `$fetch` のエラーから**人が読める理由**を作る (Refs #677 / #890)。
 *
 * 既定の `e.message` は `[GET] "/api/kyuyo/wage-range?…": 503` のように
 * **status しか出ない**。proxy は upstream の本文をそのまま passthrough している
 * ので、理由はそちらにある (「[kintai_push] が無効です」「kyuyo 認可が未設定です」等)。
 * 拾わないと、画面を見ても何が起きたのか判らないまま調査に入ることになる。
 *
 * ## 自前の `server/api/*` では、日本語が `e.message` から**消える** (Refs #890)
 *
 * `createError({ statusCode, statusMessage: '… が必要です' })` を投げると、ofetch の
 * `FetchError.message` は HTTP の **reason phrase** (`response.statusText`) から組まれる。
 * reason phrase は ASCII しか運べないので、画面には
 * 「`schemaVersion(=2)/ym/totals/cache (ym )/…`」のように**日本語だけが抜けた文**が出る
 * (`一致` `が必要です` が消える)。**日本語は JSON 本文の側に無傷で残っている**ので、
 * `e.data` を読むこの関数を通せば元の 1 文が読める。
 *
 * ## ★ 拾うのは「文字列である最初の 1 つ」— `??` では拾えない
 *
 * Nitro の既定のエラー本文は **`error` が真偽値** (`{ error: true, url, statusCode,
 * statusMessage, message, data }`)。`d.error ?? d.message ?? d.statusMessage` と繋ぐと
 * **`true` で止まり**、「文字列ではない」で捨てて日本語に届かない。dev の実機 400 で
 * 実測して分かった (Refs #890)。**`find(typeof … === 'string')` に変えてある。**
 * upstream proxy の `{ error: '…' }` (文字列) を先に見る**順序は変えていない**。
 *
 * **★ 読むファイルを間違えないこと。**走っているのは
 * `nitropack/dist/runtime/internal/error/prod.mjs` の `defaultHandler` で、
 * `runtime/error.mjs` の `defaultNitroErrorHandler` でも h3 の `sendError()` でもない
 * (`grep -rn 'error: true' node_modules/nitropack/dist/runtime/` → `internal/error/` の
 * 2 件だけ)。**どれが走るかは読みでは決まらない** — worker を立てて本物の応答を見るまで
 * 3 通りの「それらしい handler」が候補として並ぶ。
 *
 * ## ★ `data.message` を `data.statusMessage` より先に見る (順序を変えないこと)
 *
 * いま通っている Nitro のエラーハンドラは本文を sanitize しないので、
 * **`statusMessage` にも `message` にも同じ日本語が載る** (dev の実機 400 で両方確認。
 * h3 の `createError` が `new H3Error(input.message ?? input.statusMessage ?? '')` を
 * 作るので、`message` を渡していなくても `message` 側に同じ文が入る)。
 *
 * **`statusMessage` へのフォールバックは無駄ではない** — `prod.mjs` は
 * `isSensitive = error.unhandled || error.fatal` のとき `message` を `'Server Error'` に
 * 潰すが、そのとき `statusMessage` も `error.statusMessage || 'Server Error'` なので
 * **どちらにせよ日本語は無い**。明示的な `createError({ statusCode: 400, … })` は
 * unhandled でも fatal でもないので、`message` に日本語が入る。
 * だが **`H3Error.toJSON()` の経路は `statusMessage` だけを sanitize して
 * `message` を素通しする** — 日本語は全部落ちる。いまはその経路を通らないが、
 * **`statusMessage` を先に読む実装にすると将来そこで壊れる。**
 *
 * ## ★ 理由が 1 つも無いとき、status を 2 回書かない (Refs #900)
 *
 * 一番星 (`/api/ichiban/**`) はエラー側の型が素の `StatusCode` で、axum が
 * **本文を 1 バイトも付けない**。本番 (h3) は reason phrase が空なので
 * `err.statusMessage` も空になり、残るのは ofetch が自分で組んだ `err.message`
 * (`[GET] "…": 503`) だけ — そこに `${statusCode}` を前置していたので、画面は
 * **`503 [GET] "…": 503`** で **status が 2 回出るだけ**だった (dev + スタブ upstream に
 * `ofetch` を当てて実測: `statusMessage: ""` / `data: ""`)。
 * **この道に落ちた時点で「応答に理由が無い」ことは確定している**ので、そう書いて
 * method と URL だけ残す。
 *
 * **transport で症状が変わる** — dev (node) は reason phrase を埋めるので、同じ空本文でも
 * `503 Service Unavailable` になる (二重にはならないが、**理由が無いのは同じ**)。
 *
 * **ichiban はもうここまで来ない** — `server/api/ichiban/[...path].get.ts` が空本文の
 * 非 2xx に日本語の理由を作って返すので `d.error` で拾える。ここは他 route の保険。
 *
 * ## 効く相手・効かない相手
 *
 * 直るのは **`$fetch` で自前の `server/api/*` を呼んでいる箇所**だけ。
 * `app/utils/api.ts` の呼び出しと `@ippoan/auth-client` の `createAuthFetch` は
 * **生 `fetch` で JSON 本文を自分で読んでいる**ので、そもそも化けない。
 */
export function describeApiError(e: unknown): string {
  const err = (e ?? {}) as {
    statusCode?: number
    statusMessage?: string
    data?: unknown
    message?: string
  }
  let fromData = ''
  if (typeof err.data === 'string') {
    fromData = err.data
  }
  else if (typeof err.data === 'object' && err.data !== null) {
    const d = err.data as Record<string, unknown>
    // ★ **`??` で繋がない** (Refs #890)。Nitro が自前の `server/api/*` のエラーで返す
    // 本文は `{ error: true, url, statusCode, statusMessage, message, data }` で、
    // **`error` は真偽値**。`??` だと `true` で止まって「文字列ではない」で捨て、
    // 日本語を持つ `message` に落ちない (dev の実機 400 で実測)。
    // **文字列である最初の 1 つ**を選ぶ。順序 (`error` → `message` → `statusMessage`)
    // は変えていない。
    const picked = [d.error, d.message, d.statusMessage].find(v => typeof v === 'string')
    if (typeof picked === 'string') fromData = picked
  }
  const fallback = fromData || err.statusMessage
  // ★ **拾える理由が 1 つも無いとき、status を 2 回書かない** (Refs #900)。
  // ここに落ちるのは「本文にも reason phrase にも文字が無い」場合だけで、
  // 残っているのは ofetch が自分で組んだ `[GET] "/api/…": 503` — **status は
  // `${err.statusCode}` として既に前置している**ので、そのまま繋ぐと本番
  // (h3 = reason phrase が空) の画面が `503 [GET] "…": 503` になる。
  // **理由が無いことはここで確定している**ので、そう書いて method と URL だけ残す。
  if (!fallback && err.statusCode) {
    const synthetic = OFETCH_SYNTHETIC_MESSAGE.exec(err.message ?? '')
    if (synthetic) return `${err.statusCode} 応答に理由が入っていません (${synthetic[1]} ${synthetic[2]})`
  }
  const detail = fallback || err.message || String(e)
  return err.statusCode ? `${err.statusCode} ${detail}` : detail
}
