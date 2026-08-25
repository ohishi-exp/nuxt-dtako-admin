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
 * ## ★ `data.message` を `data.statusMessage` より先に見る (順序を変えないこと)
 *
 * いま通っている Nitro のエラーハンドラは本文を sanitize しないので、
 * **`statusMessage` にも `message` にも同じ日本語が載る** (dev の実機 400 で両方確認。
 * h3 の `createError` が `new H3Error(input.message ?? input.statusMessage ?? '')` を
 * 作るので、`message` を渡していなくても `message` 側に同じ文が入る)。
 * だが **`H3Error.toJSON()` の経路は `statusMessage` だけを sanitize して
 * `message` を素通しする** — 日本語は全部落ちる。いまはその経路を通らないが、
 * **`statusMessage` を先に読む実装にすると将来そこで壊れる。**
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
  const detail = fromData || err.statusMessage || err.message || String(e)
  return err.statusCode ? `${err.statusCode} ${detail}` : detail
}
