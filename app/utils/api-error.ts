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

/**
 * 非 2xx の `Response` から**人が読める 1 文**を作る (Refs #996)。
 *
 * `describeApiError` との違いは**入口と出口の両方**:
 *
 * | | 入口 | 出口 |
 * | --- | --- | --- |
 * | `describeApiError` | `$fetch` (ofetch) が投げた `FetchError` | `${status} ${理由}` |
 * | `describeResponseFailure` | 生 `fetch` の `Response` (本文は未読) | `${status} ${理由} — ${次の一手}` |
 *
 * ## ★ 直した欠陥 — 本文をそのまま画面に貼っていた (Refs #996)
 *
 * `/vehicle-settings` は `抽出失敗 (401): ${await res.text()}` の形で、
 * Nitro のエラー本文 (`{"error":true,"statusCode":401,"statusMessage":"Unauthorized",…}`)
 * を**そのまま画面に出していた**。人が読み取るべきなのは「ログインが切れた」という
 * ただ 1 つの事実なのに、**次に何をすればいいか (再ログイン) が 1 文字も無かった**。
 *
 * ## ★ 401 は `describeApiError` に通すだけでは直らない
 *
 * `requireAuth` (`@ippoan/auth-client/server`) が投げるのは
 * `createError({ statusCode: 401, statusMessage: 'Unauthorized' })` **固定**
 * (`src/server/auth.mjs`)。**日本語の理由は最初から存在しない**ので、本文を正しく
 * 読んでも画面に出るのは `401 Unauthorized` だけ。**理由を拾う話ではなく、
 * 次の一手を足す話**なので、`status` ごとの一文をこちら側で持つ。
 *
 * ## ★ 401 / 403 / 404 / 5xx を混ぜない (`kyuyo-access.ts` と同じ理由)
 *
 * | status | 意味 | 次の一手 |
 * | --- | --- | --- |
 * | **401** | ログインの話。**introspect 不達もここに来る** (下記) | 再ログイン |
 * | **403** | **その人の権限の話。**再ログインしても変わらない | 管理者に依頼 |
 * | **404** | **指した対象が無い話。**送った内容は正しい (下記) | 出し直して指し直す |
 * | **413** | 送ったファイルの大きさの話 | 小さくして送り直す |
 * | **5xx** | **設定・障害の話。権限とは無関係** | 復旧を待つ |
 * | その他 4xx | 送った内容の話 | 内容を直す |
 *
 * **`introspectToken` は auth-worker に届かなくても `{ active: false }` に倒す**
 * (`src/server/introspectCore.mjs` の `catch`) ので、**認証サーバの障害も 401 になる**。
 * ブラウザ側からこの 2 つは区別できない。だから 401 の文は「再ログイン」を先に置きつつ、
 * **「再ログインしても直らないときは認証サーバに繋がっていない」**まで書く
 * (書かないと「再ログインしたのに直らない = 自分に権限が無い」と誤読される)。
 *
 * ## ★ 404 を「その他 4xx」に落とさない (Refs #1005 #1021)
 *
 * `/vehicle-settings/history` と `<VehicleSettingsDumpPicker>` は、**一覧に出ている行を
 * クリックしただけ**で `object.get.ts` の 404 (`object not found: <key>`) を受け取る。
 * 「その他 4xx」に落ちると前置きが「**送った内容をサーバが受け付けませんでした。
 * 上の理由のとおりに直してから**」になるが、**押した人は何も送っていない**し、
 * 直せるものも無い。**一覧が古くなっただけ**なので、そう書いて画面ごとの
 * `retry` (= 一覧の取り直し) に繋ぐ。
 *
 * **一覧を取り直す動線は `retry` が持つ。**ここに「一覧を取り直してから」を書くと、
 * `retry` が既に「「履歴を取得」で一覧を取り直し、行をクリックし直してください」の
 * 画面で**同じ指示が 2 回出る**。理由は共通・やり直し方は画面ごと、を崩さないこと。
 *
 * この 2 画面は **#1005 で呼び出し側に `if (res.status === 404)` を置く暫定**を
 * 通していた (`api-error.ts` が別タスクの持ち物だったため)。**その暫定はこの枝と
 * 引き換えに消えている** — 同じものを呼び出し側へ戻さないこと。
 *
 * ## ★ 「理由が無い」と「理由を読めなかった」を同じ見た目にしない
 *
 * 本文が空 / JSON でない / JSON だが文字列の理由を持たない、の 3 つは別々の文にする
 * (`res.statusText` に落とさない — **本番は reason phrase が空**なので区切り文字の
 * 後ろが空になる)。**理由の拾い順は `describeApiError` が正**で、ここは持たない。
 *
 * ## 同じ形の先行実装との関係
 *
 * `app/pages/y-time-export.vue` の `describeApiFailure(res)` が本文を読む部分の
 * 先行実装 (Refs #890)。**あちらは「次の一手」を持たない**ので出力が違い、
 * この PR では寄せていない (#996-1 の担当範囲外 + 同ファイルを別タスクが編集中)。
 *
 * @param res  非 2xx の `Response` (**本文はまだ読んでいないこと**)
 * @param retry 画面ごとの「やり直し方」。**句点を付けずに**渡す (ここで文に組む)。
 *              理由は共通でも、やり直し方は画面ごとに違う (`kyuyo-access.ts` と同じ)。
 */
export async function describeResponseFailure(res: Response, retry: string): Promise<string> {
  return `${await responseReason(res)} — ${nextStepForStatus(res.status, retry)}`
}

/** 本文から理由を作る。`describeApiError` に渡す前に「文字列の理由があるか」だけ見る。 */
async function responseReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  if (text === '') return `${res.status} (応答本文が空でした)`
  let data: unknown
  try {
    data = JSON.parse(text)
  }
  catch {
    return `${res.status} (応答が JSON ではありません: ${text.slice(0, 120)})`
  }
  return hasStringReason(data)
    ? describeApiError({ statusCode: res.status, data })
    : `${res.status} (本文に理由の文字列がありません: ${text.slice(0, 120)})`
}

/** `describeApiError` が理由として拾える文字列を本文が持っているか。 */
function hasStringReason(data: unknown): boolean {
  if (typeof data === 'string') return data !== ''
  if (typeof data !== 'object' || data === null) return false
  const d = data as Record<string, unknown>
  return [d.error, d.message, d.statusMessage].some(v => typeof v === 'string')
}

/** status ごとの「次に何をすればいいか」。上の表が正。 */
function nextStepForStatus(status: number, retry: string): string {
  if (status === 401) {
    return `ログインが切れています。再ログインしてから${retry}`
      + ' (再ログインしても直らないときは認証サーバに繋がっていません。権限の問題ではありません)'
  }
  if (status === 403) {
    return 'この操作の権限がありません (ログインし直しても変わりません)。'
      + '管理者に許可の追加を依頼してください'
  }
  if (status === 404) {
    // ★ `retry` を素で繋ぐ (「一覧を取り直してから」を前に置かない) — 上の注記を見ること。
    return '指していた対象がサーバにもう存在しません。'
      + `画面の情報が古くなっているので、${retry}`
  }
  if (status === 413) {
    return `送ったファイルがサーバの上限を超えています。小さいファイルにしてから${retry}`
  }
  if (status >= 500) {
    return `サーバ側の設定か障害です (権限の問題ではありません)。復旧してから${retry}`
  }
  return `送った内容をサーバが受け付けませんでした。上の理由のとおりに直してから${retry}`
}
