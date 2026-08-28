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
 *
 * ★ **形式 2 から「その版を作った端末の設定」の指紋を持つ** (Refs #886) —
 * 燃費の上書き (`fuelRateOverrides`) と運行経費の配分の比 (`runCostShareMode`)。
 * どちらも localStorage 由来で、**版に入っていないと「なぜその数字になったか」が
 * 版のどこにも残らない**。ここでも**数字は 1 円も作らない** — 画面が計算に渡したものを
 * そのまま持ち回るだけ (`margin.ts` は 1 行も触っていない)。
 */
import { resolveCodeVersion } from './code-version'
import type { FuelRateMap, MarginCache, MarginTotals, RunCostShareMode } from './margin'
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

/**
 * 保存する形の版。**`1` → `2` で「その版を作った端末の設定」の指紋
 * (`fuelRateOverrides` / `runCostShareMode`) が入った** (Refs #886)。
 *
 * ★ **形式 1 の版に指紋を後から足すことはできない。** 上書きした値は集計した端末の
 * localStorage にしか無く、版を保存した時点で失われている。**指紋が付くのはこれから
 * 保存される版だけ**で、形式 1 の版は永久に「なぜその数字になったか」を持たない。
 * 形式が違う版どうしは差分にしない (`marginDiffSchemaMismatchNote`) — 片方にしか
 * 指紋が無い 2 版を並べても、意味のある比較にならないため。
 */
export const MARGIN_SUMMARY_SCHEMA_VERSION = 2

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
  /**
   * ★ **その版を作った端末の燃費・単価の上書き** (`FuelRateMap`、localStorage
   * `FUEL_RATE_KEY` = `dtako:margin:fuel-rate:v1`。Refs #886)。
   * `buildOperationMargins` の 3 つ目の引数**そのまま**。
   *
   * **`totals` を動かす** (`fuelYenFor` → `marginYen` → `summarizeMargins`) ので、
   * 燃費を上書きした端末で集計すると**取り込みデータが 1 円も変わっていないのに版が増える**。
   * その理由が版のどこにも残っていなかったのが #886 の実害で、**この欄が理由を名乗る。**
   *
   * **`cache.operations` からは復元できない** — あちらは `MarginOperationInput[]` =
   * 生の入力で、上書きを適用した後の `OperationMargin.fuelRate` を持たない
   * (`margin.ts` の `MarginCache`)。だから別の欄として持つ。
   *
   * **上書きが 1 台も無ければ空オブジェクト** (`{}`)。**null に倒さない** —
   * 「上書きしていない」と「指紋そのものが無い (形式 1)」は別の意味で、混ぜると
   * 版を読む人が区別できなくなる。形式 1 かどうかは `schemaVersion` が言う。
   */
  fuelRateOverrides: FuelRateMap
  /**
   * ★ **その版を作った端末の運行経費の配分の比** (`RunCostShareMode`、localStorage
   * 粗利タブの `RUN_COST_SHARE_MODE_KEY` = `dtako:margin:runCostShareMode`。Refs #886)。
   * `buildOperationMargins` の 4 つ目の引数そのまま。
   *
   * こちらは **`totals` を 1 円も動かさない** — `buildLegMargins` にしか流れず、
   * `marginYen` はその**前**に確定する。動くのは**便 (leg) の内訳**だけで、その内訳は
   * `MarginCache` に保存されない。⇒ 指紋が無いと**版から便の内訳を再現できない**という、
   * 燃費の上書きとは別の (静かな) 穴になる。**2 つの影響は同じではない。**
   */
  runCostShareMode: RunCostShareMode
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
  /**
   * **画面が `buildOperationMargins` に渡したものと同じ参照を渡す** (Refs #886)。
   * ここで作り直したり既定に倒したりしない — 版が名乗る指紋は
   * **その数字を実際に作った設定**でなければ意味が無い。
   */
  fuelRateOverrides: FuelRateMap
  runCostShareMode: RunCostShareMode
}): MarginSummaryInput {
  return {
    schemaVersion: MARGIN_SUMMARY_SCHEMA_VERSION,
    ym: params.cache.ym,
    codeVersion: resolveCodeVersion(params.codeVersion),
    totals: params.totals,
    cache: params.cache,
    fuelRateOverrides: params.fuelRateOverrides,
    runCostShareMode: params.runCostShareMode,
  }
}

/**
 * **`FuelRateMap` のキーの順番をハッシュから外す** (Refs #886)。
 *
 * ★ **車輌C によって並びの決まり方が違う** (node で実測):
 * `{'1234':…,'5678':…}` のような**整数として正規な文字列**のキーは JS が**昇順に揃える**ので
 * 入れた順に依存しない。ところが `vehicleCodeFromUnkoNo` は `padStart(4, '0')` を通すので
 * **車輌C が 1000 未満だと `'0123'` になり、これは整数として正規ではない** —
 * `Object.keys({'0456':…,'0123':…})` は `['0456','0123']` のまま、つまり**入れた順**になる。
 * ⇒ 4 桁目に 0 が立つ車輌の上書きを 1 台消して入れ直すだけで `JSON.stringify` の文字列が変わり、
 * **中身が同じなのに版が増える**。`marginSummaryHashInput` が防いでいるもの (理由の無い版)
 * そのものなので、ここで並べ直す。値も `[車輌C, 円/L, km/L]` の順に組み直して、
 * 欄の並びにも依存しないようにする。
 *
 * **保存する本文 (`MarginSummaryInput.fuelRateOverrides`) は並べ替えない** — 版には
 * 端末が持っていたものをそのまま残す。並べ直すのは**比べるときだけ**。
 *
 * ★ **欄を落としたまま気づかない事故を型で止める** (親のレビュー、Refs #886)。
 * `FuelRateOverride` に欄が 1 つ増えたとき、ここに書き足すのを忘れると
 * **その欄は本文には載るのにハッシュには入らない** — 「本文は違うのに同じ版」が生まれ、
 * 指紋を足した意味が消える (この関数のすぐ下、`marginSummaryHashInput` の doc が
 * 警戒しているのとまったく同じ失敗で、**テストは緑のまま通る**)。
 * `_exhaustive` の代入がその歯止め: 残りの欄 (`rest`) が空でなくなった瞬間に
 * **型検査が落ちる**。`RunCostShareMode` に `RUN_COST_SHARE_MODES` を置いたのと同じ規律。
 * **実行時の値は 1 ミリも変わらない** (載せる欄も並びも同じ)。
 */
function fuelRateFingerprint(map: FuelRateMap): Array<[string, number | null, number | null]> {
  return Object.keys(map).sort().map((vehicle) => {
    const { yenPerLiter, kmPerLiter, ...rest } = map[vehicle]!
    const _exhaustive: Record<string, never> = rest
    return [vehicle, yenPerLiter, kmPerLiter]
  })
}

/**
 * sha256 差分検知に渡す文字列。**保存の時刻だけを抜く。**
 *
 * `MarginCache.savedAt` は再計算のたびに `new Date().toISOString()` で埋まるので、
 * そのままハッシュすると**毎回「内容が変わった」ことになり版が無限に増える**
 * (= dedup が死に、R2 の容量が青天井になる)。`codeVersion` も外す — 版を分けるのは
 * **中身が動いたとき**であって、中身が同じままコードだけ上がったのは
 * `lastVerifiedCodeVersion` (customMetadata) で足りる。
 *
 * ★ **指紋 (`fuelRateOverrides` / `runCostShareMode`) は逆にハッシュへ入れる** (Refs #886)。
 * 入れないと**版の本文とハッシュの対象が食い違い**、「本文は違うのに同じ版」が生まれる
 * (= 指紋を足した意味が消える)。**これで挙動が 1 つ変わる**: 運行経費の配分の比だけを
 * 変えて集計し直すと、**`totals` は 1 円も動かないのに版が 1 本増える**。それが正しい —
 * 便の内訳は実際に変わっており、その内訳は版の外 (画面) にしか無いので、
 * **指紋が違えば別の版として残す**以外に後から見分ける術が無い。
 *
 * ★ **`cache` は丸ごと対象なので、`MarginCache` に列を足すと自動的にハッシュへ入る**
 * (Refs #1017 ③ で `rateSource` / `rateVersion` / `rateUpdatedAt` を足した)。**列を足した
 * 回の最初の保存は、取り込みデータが 1 円も変わっていなくても版が 1 本増える** —
 * 2 回目からは増えない (`changed: false` = 「前回の版から変わっていないので版は増やして
 * いません」)。これは上の指紋と同じ理屈で**正しい**: 同じ運行データを**違う手当マスタ**で
 * 計算した 2 回が同じ版にまとまると、後から見分ける術が無い。
 * **`MARGIN_SUMMARY_SCHEMA_VERSION` は上げない** — 既にある列の読み方は変わっておらず、
 * 上げると `marginDiffSchemaMismatchNote` で既存の版との比較が全部「比較不能」になる。
 */
export function marginSummaryHashInput(input: MarginSummaryInput): string {
  return JSON.stringify({
    schemaVersion: input.schemaVersion,
    ym: input.ym,
    totals: input.totals,
    fuelRateOverrides: fuelRateFingerprint(input.fuelRateOverrides),
    runCostShareMode: input.runCostShareMode,
    cache: { ...input.cache, savedAt: '' },
  })
}

/**
 * **`RunCostShareMode` の値を型の側から数え上げた表** (Refs #886)。値は使わずキーだけ引く。
 *
 * `margin.ts` を**値として import しない**ためにここで持つ (型は erase されるので
 * 依存が増えない。`margin.ts` は粗利の計算そのもので、保存の口が引きずり込むには重い)。
 * それでも取りこぼさないのは `Record<RunCostShareMode, true>` が**両方向に効く**ため —
 * `margin.ts` に比が 1 つ増えれば「欠けている」で、消えれば「余分」で型検査が落ちる。
 */
const RUN_COST_SHARE_MODES: Record<RunCostShareMode, true> = { km: true, legs: true, time: true }

/**
 * 受け取った値が `RunCostShareMode` か。**既定に倒さない** — `parseRunCostShareMode`
 * (画面側) は読めない値を `km` に丸めるが、**保存の口で丸めると嘘の指紋を版に刻む**。
 * 版は「その数字を実際に作った設定」を名乗るものなので、名乗れないものは受けない。
 */
export function isRunCostShareMode(value: unknown): value is RunCostShareMode {
  return typeof value === 'string' && Object.hasOwn(RUN_COST_SHARE_MODES, value)
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
 * 保存に失敗した回に、症状のあとへ足す**次にやること** (Refs #889)。
 *
 * それまでの注記は**症状しか出していなかった**。読んだ人にできるのは「画面を開き直す」
 * だけなのに、そう書いていないので「**R2 が壊れている / この機能が壊れている**」としか
 * 読めない — 実際には**自分のタブが古い**だけのことがある (デプロイで
 * `MARGIN_SUMMARY_SCHEMA_VERSION` が上がると、古い bundle を掴んだタブは古い形式を
 * 送って 400 になる。Refs #886 / #888)。
 *
 * **★ 逆方向の誤読も同時に潰す。**「開き直してください」だけだと、**R2 が本当に
 * 落ちている回**にも同じ文が出て、開き直しても直らない人が「**言われたとおりにしたのに
 * 直らない = やはり壊れている**」を踏む。**開き直して直らなかったときの意味まで**
 * 1 文に入れて、どちらに転んでも次の行動が決まるようにする。
 */
export const MARGIN_SUMMARY_SAVE_FAILED_NEXT
  = 'まず画面を開き直してください — デプロイ後に古いタブが残っていただけならこれで直ります。'
    + '開き直しても同じなら R2 側の障害です。'

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
      + MARGIN_SUMMARY_SAVE_FAILED_NEXT
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
