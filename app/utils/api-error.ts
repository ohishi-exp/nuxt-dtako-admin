/**
 * ofetch が理由の代わりに組む `[GET] "/api/foo": 503 ` の形 (`createFetchError` の
 * `` `${requestStr}: ${statusStr}` ``、`ofetch/dist/shared/*.mjs`)。**method と URL を
 * 取り出すためだけ**に使う。手投げの `{ statusCode, message: 'Bad Gateway' }` は
 * この形に当たらないので、そちらは今までどおり `502 Bad Gateway` のまま。
 */
const OFETCH_SYNTHETIC_MESSAGE = /^\[([A-Z]+)\] "(.*)": \d{3}(?: |$)/

/**
 * `@ippoan/auth-client` の `createAuthFetch` が組む
 * `` `${errorLabel} (${res.status}): ${body || res.statusText}` `` から **status だけ**を
 * 取り出す (`createAuthFetch.ts:56`)。上の `OFETCH_SYNTHETIC_MESSAGE` と同じ流儀 —
 * **上流が固定フォーマットで組んだ文字列を、正規表現で読み戻す**。
 *
 * ## ★ なぜ文字列を読むのか (**本当の直しは上流**)
 *
 * `createAuthFetch` は非 2xx を **素の `Error`** に組んで投げる。ofetch の `FetchError`
 * ではないので **`statusCode` も `data` も持たず**、status は**メッセージ文字列の中に
 * しか無い**。**本来の直しは上流 (`@ippoan/auth-client` が `statusCode` を載せる)**
 * だが、別 repo + 版上げ + 全 consumer への波及になるので #1008 の範囲外
 * — 上流が載せるようになったら `describeCaughtError` は `statusCode` の側を先に見るので、
 * **この正規表現は自然に使われなくなる** (消すのはそのとき)。
 *
 * ## ★ `errorLabel` を決め打ちしない
 *
 * ラベルは `createAuthFetch` の option で、この repo は `'API エラー'` を渡している
 * (`app/utils/api.ts:58`) が、**上流の既定は `'API error'`** で consumer ごとに違う。
 * だから見るのは**ラベルではなく `` ` (3 桁): ` `` の形**だけ。ラベル位置は
 * `[^(\n]+` (括弧を含まない 1 行) にしてあるので、**括弧を含むラベルに変わったら
 * 当たらなくなる** — そのとき起きるのは「次の一手が付かない」だけで、
 * **理由の 1 文はそのまま出る** (`describeCaughtError` の 3 番目の枝 = 現状維持)。
 *
 * **接頭辞で当てて、外れたら空撃ちになるガードにはしていない** — この repo は
 * 同じ日に「文言変更でメッセージ接頭辞のガードが空撃ちになる」事故を出している。
 * **外れたときに何が起きるかは `tests/utils/api-error.test.ts` で固定してある。**
 */
const AUTH_FETCH_ERROR_MESSAGE = /^[^(\n]+ \((\d{3})\): /

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
 * **parse 済みのエラー本文**から理由の 1 文を拾う (Refs #1050)。無ければ `null`。
 *
 * `describeApiError` が `err.data` に対してやっている選び方**だけ**を切り出したもの。
 * 入口が違う: あちらは ofetch の `FetchError`、こちらは `await res.json()` の**素の値**。
 * `${status}` の前置きも「次の一手」も付けない — それは呼び出し側が決める。
 *
 * ## ★ 順序は `[error, message, statusMessage]`。`statusMessage` を先に読まないこと
 *
 * **理由は 2 つあり、server route の書き方によってどちらが効くかが変わる** (#1050)。
 * **どちらの向きでも `message` 先が正しい**ので、route ごとに読み分けない:
 *
 * | server 側の書き方 | `statusMessage` | `message` | `statusMessage` 先だと |
 * | --- | --- | --- | --- |
 * | **role gate** (`server/utils/require-role.ts`) と ichiban proxy — **両方を明示** | ASCII | 日本語 | **画面が ASCII になる** |
 * | **`statusMessage` だけ渡す** (netprint / kyuyo-master / net780-archive の自前エラー) | 日本語 | **h3 が同じ日本語を写す** | 同じ値なので**変わらない** |
 *
 * 2 行目は h3 1.15.6 で実測 (`createError({ statusMessage: '… が未設定です' })` →
 * `e.message` に同じ文字列)。**ただし `H3Error.toJSON()` を通る経路では
 * `statusMessage` だけが sanitize され、非 ASCII が落ちる**
 * (`"SCRAPER_RELAY service binding "` になるのを実測) — `message` は素通しなので、
 * **その経路に変わったときに壊れないのも `message` 先の側**。
 *
 * **`statusMessage` に日本語を入れないこと自体は今も禁止** (本番 workerd で reason
 * phrase が壊れる。#1032 / #886)。この順序はその禁止の代わりではなく、独立した保険。
 *
 * `error` を先頭に置くのは upstream proxy が passthrough する `{ error: '…' }` (文字列)
 * を先に見るため — **この順序の根拠は `describeApiError` の doc が正**。
 *
 * ## ★ `??` で繋がない
 *
 * Nitro の既定の本文は `{ error: true, url, statusCode, statusMessage, message, data }` で
 * **`error` が真偽値**。`d.error ?? d.message` は `true` で止まる。**文字列である最初の
 * 1 つ**を選ぶ (`describeApiError` と同じ)。
 *
 * ## 拾えなかったときに何を出すかは呼び出し側の話
 *
 * `null` を返すだけで `HTTP ${status}` のような代替は作らない。**「理由が無い」と
 * 「理由を読めなかった」を同じ見た目にしない**ためで、画面ごとに書き分けたい
 * (`describeResponseFailure` の注記と同じ理由)。
 */
export function pickBodyReason(body: unknown): string | null {
  if (typeof body === 'string') return body === '' ? null : body
  if (typeof body !== 'object' || body === null) return null
  const d = body as Record<string, unknown>
  const picked = [d.error, d.message, d.statusMessage].find(v => typeof v === 'string')
  return typeof picked === 'string' ? picked : null
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
 * ## 同じ形の先行実装は畳んである (Refs #1008)
 *
 * `app/pages/y-time-export.vue` に `describeApiFailure(res)` という**本文を読む部分が
 * 同型の先行実装** (Refs #890) と、その中の `hasStringReason` の写しがあった。
 * #996 の時点では「あちらは『次の一手』を持たないので出力が違う」ことを理由に据え置いて
 * いたが、**出力が違うのは寄せられない理由ではなく、寄せたときに `retry` を渡す先が
 * 3 か所あるというだけ**だった。#1008 で 3 か所とも実在するボタン表記を渡して撤去済み。
 * **同じ拾い順の実装を 2 つ持たない** (CLAUDE.md の重複防止)。
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
  return pickBodyReason(data) !== null
}

/**
 * status ごとの「次に何をすればいいか」。上の表が正。
 *
 * `describeResponseFailure` (= `Response` を持っている経路) 以外からも使う (Refs #1008)。
 * `Response` を持たない経路 — `api.ts` の `request()` は `@ippoan/auth-client` が
 * **素の `Error`** に組んで投げるので `Response` が残らない — は
 * `describeApiError` で理由を作ってから、この関数で「次の一手」だけを足す。
 */
export function nextStepForStatus(status: number, retry: string): string {
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

/**
 * **`fetch` 自体が throw したとき**の 1 文 (Refs #1006)。`Response` が 1 つも
 * 得られなかった場合だけを相手にする。当たらなければ `null` を返すので、
 * 呼び出し側の既存の文言はそのまま残る。
 *
 * ## ★ issue #1006 の予想は**半分外れている** (2026-08-28 に本番で実測)
 *
 * `credentials:'omit'` で「未認証相当」を作って測った結果:
 *
 * | issue の予想 | 実測 |
 * | --- | --- |
 * | Access が 302 を返す | **✅ そのとおり** (`redirect:'manual'` で `type:"opaqueredirect"` / `status:0`) |
 * | ログインページの **HTML が 200 で返る** | **❌ 返らない** |
 * | ⇒ `res.ok` が真になる | **❌ ならない** |
 * | ⇒ `res.json()` が `Unexpected token '<'` で落ちる | **❌ そこまで到達しない** |
 *
 * **リダイレクト先が cross-origin** なので、`fetch` は追随先の応答を返せず
 * **CORS で弾いて `TypeError` を投げる** (既定の `redirect:'follow'` で
 * `TypeError: Failed to fetch`)。API でもページでも同じだった。
 *
 * ⇒ **`res.redirected` / `content-type` を見る枝は要らない** — そこまで到達しない。
 * **要るのは `catch` 側**。`if (!res.ok)` も `describeResponseFailure` も
 * `describeApiError` も、`res` を見るコードには **1 行も到達しない**。
 *
 * ## ★ 断定しない — 認証切れとネットワーク断は**ブラウザから区別できない**
 *
 * どちらも同じ `TypeError` になる。だから
 * **「ログインが切れました」とも「ネットワークが切れています」とも書かない**。
 * **両方を挙げて、やることを 1 つ (ページの再読み込み) だけ出す。**
 * 直していない状態で画面に出るのは **`Failed to fetch` の 1 語**で、利用者は
 * 「サーバが落ちている」と読む — この repo で最も多い欠陥の型
 * (「出ているものが別の意味に読める」) にそのまま当たる。
 *
 * ## ★ 判定は `e.message` の文字列一致にしない
 *
 * 文言はブラウザごとに違う (Chrome `Failed to fetch` /
 * Firefox `NetworkError when attempting to fetch resource.` / Safari は別)。
 * **`TypeError` かどうか**で見る。`fetch` はネットワークエラーを
 * `TypeError` で reject すると仕様で決まっている。
 *
 * ## ★ 「次の一手」の 2 文はどちらも実機で測ってある (#1006)
 *
 * 断定を 1 つでも置くなら根拠が要る。cross-origin へ 302 する中継 + headless Chrome で
 * **ページ遷移**を 1 往復させて確かめた:
 *
 * | 再読み込みしたときの状態 | 実測した画面 |
 * | --- | --- |
 * | **ログインが切れている** (Access が全経路を 302) | **ログイン画面に移る** |
 * | **ネットワークが繋がっていない** (CDP `offline:true`) | ブラウザの `ERR_INTERNET_DISCONNECTED` |
 *
 * **初稿の「ネットワークが原因のときは同じ表示のままです」は偽だった** — 画面と API は
 * 同一オリジンなので、繋がっていなければ**ページ自体が出ない**。「同じ表示のまま」に
 * ならないので、**「移らないときは」**に直してある (どちらの結果でも真になる形)。
 *
 * ## ★ `try` は `fetch` の 1 行だけを囲むこと
 *
 * 素の プログラミングエラー (`undefined.foo` 等) も `TypeError` なので、
 * **`try` に他の処理を巻き込むと「接続できませんでした」と誤って書く**。
 * だから当てる場所は**`fetch` を呼ぶ関数の中**であって、画面側の広い
 * `try { …数十行… } catch` **ではない**。
 */
export function describeFetchThrow(e: unknown): string | null {
  if (!(e instanceof TypeError)) return null
  return 'サーバに接続できませんでした。'
    + 'ログインが切れているか、ネットワークが繋がっていないかのどちらかです'
    + ' (ブラウザからは区別できません)。'
    + 'ページを再読み込みしてください'
    + ' — ログインが切れていた場合はログイン画面に移ります。'
    + '移らないときはネットワークの側を確認してください。'
}

/**
 * **catch した例外**から「理由 — 次に何をすればいいか」の 1 文を作る (Refs #1008)。
 * `describeResponseFailure` の**兄弟**で、違うのは**入口だけ**:
 *
 * | | 入口 | 出口 |
 * | --- | --- | --- |
 * | `describeResponseFailure` | 生 `fetch` の `Response` (本文は未読) | `${status} ${理由} — ${次の一手}` |
 * | `describeCaughtError` | **catch した例外** | 同じ形 |
 *
 * ## 3 つの枝
 *
 * 1. **transport failure** (`fetch` 自体が throw した) — `describeFetchThrow` の 1 文を
 *    使い、**繋がった後にやることとして `retry` を足す**。あの 1 文は
 *    「まずページを再読み込みして切り分けろ」までしか言わないので、
 *    **その画面のデータが戻ってくる操作**は別に要る。
 * 2. **status が分かる** — `${describeApiError(e)} — ${nextStepForStatus(status, retry)}`。
 * 3. **status が分からない** — `describeApiError(e)` を**そのまま返す**。
 *    **劣化ではなく現状維持** — 次の一手は status ごとに違う (401 は再ログイン、
 *    403 は管理者へ、5xx は復旧待ち) ので、**status が読めていないのに 1 つを選ぶと
 *    嘘になる**。空文字にも例外にも倒さない。
 *
 * @param retry 画面ごとの「やり直し方」。**その画面に実在するボタンの表記そのまま**を
 *              `「…」` で引用し、**句点を付けずに**渡す (`describeResponseFailure` と
 *              同じ規約。`tests/components/next-step-retry-labels.test.ts` が
 *              「その `.vue` の template に実在するか」を機械で見ている)。
 *              **押せるボタンが無い画面**は `'ページを再読み込みしてください'` のように
 *              **ボタンを名指ししない文**を渡す (`「…」` が無いものは検査の対象外)。
 */
export function describeCaughtError(e: unknown, retry: string): string {
  const transport = describeFetchThrow(e)
  // ★ 「繋がったあとで」— `describeFetchThrow` の文は末尾が
  //   「移らないときはネットワークの側を確認してください。」で終わっている。
  //   再読み込みは**切り分け**であって、この画面の取り直しではない。
  if (transport !== null) return `${transport}繋がったあとで${retry}`
  const status = caughtErrorStatus(e)
  if (status === null) return describeApiError(e)
  return `${describeApiError(e)} — ${nextStepForStatus(status, retry)}`
}

/**
 * catch した例外の HTTP status。読めなければ `null`。**2 系統ある** (#1008 で実測):
 *
 * | 投げ元 | status | 読み方 |
 * | --- | --- | --- |
 * | `$fetch` (ofetch) の `FetchError` | **`e.statusCode` を持つ** | そのまま |
 * | `app/utils/api.ts` の `request()` (= `createAuthFetch`) | **持たない** | `AUTH_FETCH_ERROR_MESSAGE` |
 *
 * `statusCode` を**先に**見る — 上流が `statusCode` を載せるようになったら、
 * 文字列を読む側は自動的に使われなくなる (`AUTH_FETCH_ERROR_MESSAGE` の注記)。
 */
function caughtErrorStatus(e: unknown): number | null {
  const err = (e ?? {}) as { statusCode?: unknown, message?: unknown }
  if (typeof err.statusCode === 'number') return err.statusCode
  if (typeof err.message !== 'string') return null
  const m = AUTH_FETCH_ERROR_MESSAGE.exec(err.message)
  return m === null ? null : Number(m[1])
}

/**
 * 一覧取得の catch を 1 行にする。`daily-hours` / `operations` / `restraint-report` /
 * `upload` の 4 画面が文字単位で同一の定義を別々に持っていたのをここへ寄せた (Refs #1074)。
 *
 * status ごとの次の一手は `describeCaughtError` が撃ち分ける。**この関数が足すのは
 * 「次の一手が付かなかった回」の穴埋めだけ** — 戻り値が `describeApiError(e)` と
 * 1 文字も違わない (= status を読めなかった) ときだけ `retry` を補う。
 *
 * @param retry 画面ごとの「やり直し方」。規約は `describeCaughtError` の `@param retry` と同じ。
 */
export function describeListFailure(e: unknown, retry: string): string {
  if (!(e instanceof Error)) return `理由を読めませんでした — ${retry}`
  const detail = describeCaughtError(e, retry)
  return detail === describeApiError(e) ? `${detail} — ${retry}` : detail
}
