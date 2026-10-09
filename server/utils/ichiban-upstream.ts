/**
 * 一番星 (rust-ichibanboshi) proxy の共通部品 (Refs #330 PR4)。上流 fetch 本体は
 * `ichiban-worker-upstream.ts` (Service Binding の Worker だけ。オンプレ経路の `fetchIchiban` は
 * Refs ohishi-exp/rust-ichibanboshi#322 で撤去)。`cfEnv` / `IchibanUpstreamError` は給与大臣の
 * `kyuyo-upstream.ts` と route も使う。
 */

/** binding未設定 (503相当) / fetch失敗 (502相当) を呼び出し元に伝える。
 * h3 の `createError` に依存しないのは、このモジュールが server route 外
 * (テスト等) からも使えるようにするため — 呼び出し元で `createError` に変換する。 */
export class IchibanUpstreamError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message)
  }
}

/**
 * **`/api/ichiban/**` proxy が中継してよい upstream path (完全一致、Refs #1015)。**
 *
 * あの route は呼び出し元 (ブラウザ) が持っていない到達経路 (当時は CF Access Service Token、
 * いまは認可なしの Worker への Service Binding) を**こちらで貸して**上流へ渡す。
 * #988 で入れた `requireAuth` が見ているのは
 * 「**誰が**呼んでいるか」までで、「**どの path を中継してよいか**」は 1 か所も
 * 見ていなかった (= 認証は在るが認可が無い)。ここで中継先を固定する。
 *
 * ★ **前方一致 (`api/` 配下なら何でも) にはしない** — それでは「path を固定する」の
 * 実効性がほとんど残らない。姉妹の `/api/kyuyo/**` は `` `api/kyuyo/${pathParam}` `` の
 * **前置き固定**だが、あちらは**認可の正本が上流にある委任設計**
 * (`kyuyo::introspect::authorize()` + email allowlist) で「外れ」の概念自体が無い。
 * **同じ型にしない。**
 *
 * ★ **中身は front が実際に叩いている path の集合。front が正で、この一覧が front に
 * 合わせる** (逆ではない)。2026-08-28 に `a028078` で
 * `git grep -n "/api/ichiban" -- 'app/**'` = 25 行を実読し、**コメント/JSDoc を除いた
 * 実リテラル 8 site / 6 distinct** を数えた:
 *
 * | path | 呼び出し元 (site) |
 * |---|---|
 * | `health` | `app/utils/ichiban-health.ts` |
 * | `api/sales/departments` | `app/utils/ichiban-health.ts` |
 * | `api/employees` | `app/utils/ichiban-health.ts` / `app/pages/restraint-wage.vue` |
 * | `api/vehicles` | `app/utils/ichiban-health.ts` |
 * | `api/sales/vehicle-daily` | `app/utils/ichiban.ts` |
 * | `api/costs/vehicle-daily` | `app/utils/margin.ts` / `app/utils/profit-actual-wage.ts` |
 *
 * **front は path を動的に組んでいない** (全部 string literal)。陽性対照として、同じ
 * 探索が `/api/kyuyo/` 側では template literal 組み立て
 * (`app/pages/kyuyo-fetch.vue:209`) を拾うことを確認してある — 「0 件」は探索の失敗
 * ではない。**front に呼び出しを足すときは、この一覧にも足す** (足し忘れると 403)。
 *
 * ★ 照合するのは ichiban proxy の route と `ichiban-worker-upstream.ts` の 2 か所
 * (kyuyo 側の allowlist は `kyuyo-upstream.ts`)。
 *
 * ★ **query string は照合しない** — 判定するのは path 部分だけで、`?` 以降は
 * 今までどおり素通しする。
 */
export const ICHIBAN_PROXY_ALLOWED_PATHS: readonly string[] = [
  'health',
  'api/employees',
  'api/vehicles',
  'api/sales/departments',
  'api/sales/vehicle-daily',
  'api/costs/vehicle-daily',
]

/**
 * `/api/ichiban/**` の path 部分が中継対象か (**完全一致**)。
 * 正規化はしない — 末尾スラッシュ等の揺れは素直に「対象外」に倒す (fail closed)。
 */
export function isAllowedIchibanProxyPath(path: string): boolean {
  return ICHIBAN_PROXY_ALLOWED_PATHS.includes(path)
}

/** `event.context.cloudflare.env` を取り出す (未設定なら空オブジェクト)。 */
export function cfEnv(event: { context: unknown }): Record<string, unknown> {
  return (event.context as { cloudflare?: { env?: Record<string, unknown> } }).cloudflare?.env ?? {}
}

/**
 * **本文が 1 バイトも無い非 2xx** に、こちら側で日本語の理由を作る (Refs #900)。
 *
 * 一番星 (`rust-ichibanboshi`) はエラー側の型が素の `StatusCode` なので、axum が
 * **本文を付けない** (`d5f4128` の `src/routes/vehicle_daily.rs:43,249` /
 * `src/routes/costs_daily.rs:221`。`src/routes/kintai.rs:459` だけは
 * `(StatusCode, String)` なので本文がある)。空のまま素通しすると、画面に出るのは
 * ofetch が自分で組んだ `[GET] "…": 503` だけになり、**「一番星が落ちた」という
 * いちばん知りたいことが 1 文字も出ない** (本番 = reason phrase が空、では
 * `describeApiError` の前置とあわせて status が 2 回出るだけになる)。
 *
 * ★ **status を文言に入れない。** 画面側の `describeApiError` が
 * `${statusCode} ${本文の理由}` で組むので、ここで status を書くと二重になる。
 *
 * **理由の中身までは書けない** — 「なぜ落ちたか」は一番星しか知らず、それを画面に
 * 出すには上流がエラー本文を返すようになるしかない (issue #900 の案 1)。
 */
export function ichibanEmptyErrorReason(status: number, path: string): string {
  const where = `/${path}`
  const head
    = status === 503
      ? `一番星 API が応答しませんでした (${where}) — 停止か DB 接続プール枯渇の可能性`
      : status >= 500
        ? `一番星 API が内部エラーで失敗しました (${where})`
        : `一番星 API がリクエストを拒否しました (${where}) — パラメータ不正の可能性`
  // ★ **「一番星 API が」を省かない。** `/profit/compare` と `ProfitPanel` は
  // この 1 文を**そのまま**出す (「売上 (一番星) が引けませんでした —」のような
  // 前置きが無い) ので、単体で誰が落ちたか読めないと画面で意味を失う。
  return `${head} (一番星が理由を返していません)`
}
