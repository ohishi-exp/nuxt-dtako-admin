/**
 * 粗利の集計結果 (`MarginCache`) を R2 に**版管理**で残すための pure 部分 (Refs #826)。
 *
 * オーナーの要望は「**いつ変わったのか追えるようにしたい**」。**確定ボタンは作らない** —
 * 粗利タブが再計算するたびに保存し、**内容が同じなら版を増やさない** (sha256 差分検知)。
 *
 * 作法は `profit-r2.ts` / `server/utils/profit-r2-io.ts` の検証スナップショット
 * (`latest.json` + `v-{ts}.json` + `history.jsonl`) を**そのまま流用する** — 再発明しない。
 * 版の suffix (`profitVersionTimestamp`) と JSONL の追記・行数上限
 * (`appendProfitHistoryJsonl` / `PROFIT_HISTORY_MAX_LINES`) もあちらのものを使う。
 *
 * **粗利の数字には 1 円も効かない。** `margin.ts` の計算にも `MarginCache` の形にも
 * 手を入れず、**保存先が 1 つ増えるだけ**にしてある (`reconcileVehicles` も無改変)。
 * localStorage の `MARGIN_CACHE_KEY` は**残す** — R2 が使えないときに画面が死なないため。
 *
 * IO (R2 read/write) はここに置かない。R2 binding は Nitro server route からしか
 * 触れないので `server/api/profit/margin-summary.post.ts` が持つ (`profit-r2.ts` と同じ分け方)。
 */
import { resolveCodeVersion } from './code-version'
import type { MarginCache, MarginTotals } from './margin'
import type { ProfitR2Paths } from './profit-r2'

// --- キー設計 ---

/**
 * `profit/{ym}/margin-summary/` 配下に月 1 系列で置く。
 *
 * 検証スナップショット (`profitR2Paths`) は運行区間ごとに枝が分かれるが、こちらは
 * **月の集計そのもの**なので車輌CD / 運行NO で割らない — 粗利タブの突合
 * (`reconcileVehicles`) は明細のプールを月まとめて消費するので、**月より細かい単位に
 * 割った版は復元できない** (割った瞬間に別の数字になる)。
 */
export function marginR2Paths(ym: string): ProfitR2Paths {
  const dir = `profit/${ym}/margin-summary`
  return {
    dir,
    latest: `${dir}/latest.json`,
    version: ts => `${dir}/v-${ts}.json`,
    history: `${dir}/history.jsonl`,
  }
}

// --- コード版 ---

/**
 * コード版の決め方は `code-version.ts` (import を 1 つも持たない) が持つ —
 * `nuxt.config.ts` がビルド時定数を組むために直接 import する必要があるため。
 * ここからは**そのまま re-export** して、粗利側の呼び出し元が輸入元を意識しないで済むようにする。
 */
export { UNKNOWN_CODE_VERSION, resolveCodeVersion, ciBuildCodeVersion } from './code-version'

// --- 保存する形 ---

export const MARGIN_SUMMARY_SCHEMA_VERSION = 1

/**
 * 画面が送る中身。**`savedAt` と `codeVersion` は入っていない** — 時計もビルド時定数も
 * サーバー側の持ち物なので、`snapshot.post.ts` と同じくサーバーが埋める。
 */
export interface MarginSummaryInput {
  schemaVersion: typeof MARGIN_SUMMARY_SCHEMA_VERSION
  ym: string
  /**
   * **この数字を出したコードの版** (`v0.0.517` / `unknown`)。ビルド時定数
   * (`runtimeConfig.public.codeVersion`) を画面が読んで送る — **計算するのは画面**
   * なので、画面が名乗る版がその数字を作った版そのものになる (古いタブが残っていれば
   * 古い版が記録され、それが事実として正しい)。受け取る側も `resolveCodeVersion` を通す。
   */
  codeVersion: string
  /**
   * 画面に出ている合計 (`summarizeMargins` の結果) **そのまま**。
   * **ここで数字を作り直さない** — 作り直すと画面と版で額が食い違う。
   */
  totals: MarginTotals
  /**
   * localStorage に書くのと**同じ形の同じ中身** (`MarginCache`)。形は変えない —
   * 版を読み直す側 (版の一覧・差分ビューは別 PR) が `parseMarginCache` をそのまま使える。
   *
   * 明細は入っていない (量が桁違いなので `margin.ts` が意図して合計に畳んでいる)。
   * R2 の容量が運行本数×月で膨らまないのはこの設計のおかげなので、**明細を足さない**。
   */
  cache: MarginCache
}

/** R2 に置く JSON。`MarginSummaryInput` にサーバーが保存時刻を足しただけ。 */
export interface MarginSummarySnapshot extends MarginSummaryInput {
  /** サーバーが埋める保存時刻 (ISO8601)。**毎回変わるのでハッシュ対象から外す。** */
  savedAt: string
}

/**
 * 画面の状態から送る中身を組む。**`savedAt` を持たない**ので、この関数は時計に
 * 依存しない (テスト容易性のため、`buildProfitSnapshot` と同じ流儀)。
 * `ym` は `cache.ym` から採る — 保存先の月と中身の月がずれない唯一の作法。
 */
export function buildMarginSummaryInput(params: {
  cache: MarginCache
  totals: MarginTotals
  codeVersion: unknown
}): MarginSummaryInput {
  return {
    schemaVersion: MARGIN_SUMMARY_SCHEMA_VERSION,
    ym: params.cache.ym,
    codeVersion: resolveCodeVersion(params.codeVersion),
    totals: params.totals,
    cache: params.cache,
  }
}

/**
 * sha256 差分検知に渡す文字列。**保存の時刻だけを抜く。**
 *
 * `MarginCache.savedAt` は再計算のたびに `new Date().toISOString()` で埋まるので、
 * そのままハッシュすると**毎回「内容が変わった」ことになり版が無限に増える**
 * (= dedup が死に、R2 の容量が青天井になる)。`codeVersion` も外す — 版を分けるのは
 * **数字が動いたとき**であって、数字が同じままコードだけ上がったのは
 * `lastVerifiedCodeVersion` (customMetadata) で足りる。
 */
export function marginSummaryHashInput(input: MarginSummaryInput): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    ym: input.ym,
    totals: input.totals,
    cache: { ...input.cache, savedAt: '' },
  })
}

/** `history.jsonl` の 1 行。**本文は入れない** (版そのものは `v-{ts}.json` に有る)。 */
export interface MarginSummaryHistoryLine {
  ts: string
  changed: boolean
  codeVersion: string
  ym: string
  operations: number
  salesYen: number
  allowanceYen: number
  marginYen: number
}

/**
 * 「いつ・どの版で・いくらだったか」を 1 行に畳む。**行を小さく保つ**のが要件
 * (`PROFIT_HISTORY_MAX_LINES` 行ぶんが 1 オブジェクトに載るため)。
 */
export function marginSummaryHistoryLine(
  snapshot: MarginSummarySnapshot,
  changed: boolean,
): MarginSummaryHistoryLine {
  return {
    ts: snapshot.savedAt,
    changed,
    codeVersion: snapshot.codeVersion,
    ym: snapshot.ym,
    operations: snapshot.totals.operations,
    salesYen: snapshot.totals.salesYen,
    allowanceYen: snapshot.totals.allowanceYen,
    marginYen: snapshot.totals.marginYen,
  }
}

// --- 画面に出す注記 ---

/** 保存の結果 (`POST /api/profit/margin-summary` の応答)。 */
export interface MarginSummarySaveResult {
  saved: boolean
  changed: boolean
  savedAt: string
  codeVersion: string
  /**
   * **`latest` がいま指している版の R2 キー**。新しい版を書いた回はそれ自身、
   * 版が増えなかった回は**同じ内容だった既存の版**。この機能より前に書かれた
   * 保存には無いので空文字になりうる。
   */
  versionKey: string
}

/**
 * 版の R2 キーから、人に見せる版の名前 (`v-20260824T102030`) を取り出す。
 * **キーそのものを画面に出さない** — `profit/{ym}/margin-summary/` の部分は
 * 画面が既に月として出しているぶんの重複で、長いだけで読めない。
 * 空文字 (版キーを持たない古い保存) は空文字のまま返す — 名前が無いことを
 * 言葉で出すのは注記側の仕事 (`MARGIN_VERSION_UNNAMED`)。
 */
export function marginVersionLabel(versionKey: string): string {
  // `lastIndexOf` は見つからなければ -1 なので、`/` が無いときは丸ごと残る。
  // (`split('/').pop()` だと **到達しない** `?? ''` を書くことになるので使わない。)
  const base = versionKey.slice(versionKey.lastIndexOf('/') + 1)
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base
}

/**
 * 版キーを持たない古い保存 (この機能より前に書かれたもの) で、**版の名前の代わりに置く言葉**
 * (Refs #831)。
 *
 * **空白で埋めない。**「前回の版 から」と穴が空くと、値の埋め込みに失敗した
 * **レンダリングの不具合にしか読めない** — 実際に本番 v0.0.522 でそう見えた。
 * 名前が無い理由まで書くのは、次に内容が変われば `v-…` の付いた版になり、
 * **この文言が自然に消える**ため (人が何かを直す必要は無い、と読めるようにする)。
 */
export const MARGIN_VERSION_UNNAMED = '(この機能より前に保存されたため名前がありません)'

/**
 * **どちらが正かを画面で明示する**ための文言 (Refs #826 の要件)。
 *
 * localStorage は**その端末にしか無い**ので、他端末から見ると空に見える。R2 に版が
 * 残っていれば「いつ変わったか」を後から辿れるのはそちら。**残せなかったときに
 * 黙らない** — 黙ると、端末のキャッシュだけを見て「記録が残っている」と誤読する。
 */
export function marginSummarySaveNote(result: MarginSummarySaveResult | null, error: string | null): string {
  if (error !== null) {
    return `この集計を R2 に版として残せませんでした (${error}) — 記録はこの端末のキャッシュだけです。`
      + '他の端末からは見えず、いつ変わったかも追えません。'
  }
  if (result === null) return ''
  // **どの版になったかを名前で出す。**「保存しました」だけだと、版が増えなかった回に
  // どの版と同じなのかが人に分からない。版キーを持たない古い保存には名前が無いので、
  // **空白ではなく言葉**を置く (Refs #831)。`changed` で分けないのは、新しい版を書いた回
  // (`changed: true`) の版キーは `putVersionedProfit` が受け取った `paths.version(ts)` を
  // そのまま返すもので、**空になりようが無い**ため (分けると死に分岐になる)。
  const label = marginVersionLabel(result.versionKey)
  const version = label === '' ? ` ${MARGIN_VERSION_UNNAMED}` : ` ${label}`
  const tail = 'いつ変わったかは R2 の版で追えます (端末のキャッシュは表示を速くするための写しです)。'
  if (result.changed) {
    return `この集計を R2 に新しい版${version} として保存しました (コード版 ${result.codeVersion})。${tail}`
  }
  return `この集計は前回の版${version} から変わっていないので、版は増やしていません (コード版 ${result.codeVersion})。${tail}`
}
