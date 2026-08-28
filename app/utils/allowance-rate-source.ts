/**
 * 運行手当マスタを**どこから持ってくるか**を決める (pure、Refs #805 PR-2)。
 *
 * マスタの実体は R2 (`restraint/{compId}/allowance-rate/latest.json`、PR-1 =
 * [#973](https://github.com/ohishi-exp/nuxt-dtako-admin/pull/973) が置いた口)。
 * `app/utils/allowance-rate-master.ts` の `RATE_MASTER` は**消さずに初期値
 * (seed) として残す** — R2 にまだ何も入っていない間もこの画面が動くように。
 *
 * ## 3 つの状態を別々に扱う。同じ見た目にしない
 *
 * | 状態 | 意味 | 画面 |
 * |---|---|---|
 * | `r2` | R2 の版で計算している | どの版かを出す |
 * | `seed` | **同梱の初期値で計算している** | 「R2 未設定のため同梱の初期値で表示しています」 |
 * | `error` | **どちらとも言えない** | loud fail。**金額を出さない** |
 *
 * **`error` を `seed` に倒さないこと。** 最低賃金マスタで実際に踏んだ形で、
 * フォールバックを黙って使うとフロントの値と本番 R2 の値が食い違ったまま誰も
 * 気付かない。だから `error` の `rows` は存在しない (union で持たせていない) —
 * 呼び出し側が `?? RATE_MASTER` と書けないようにするため。
 *
 * **0 行も `error` にする。** 空のマスタは全便を `unknown` にするので、画面には
 * 「手当 ¥0」として出てしまう。「読めなかった」と「1 円も出ない」は別の話。
 *
 * ## 行の検証は **3 か所**にある。「両方直す」ではもう足りない
 *
 * relay 側の `normalizeAllowanceRateMaster` (`workers/dtako-scraper-relay/src/
 * restraint-wage.ts`) と規則は同じだが、**`app/` から `workers/` は import
 * できない** (別ビルド・別 tsconfig) ので写しになっている。**#805 PR-3 で
 * 書き込み側 (3 つ目) が増えた:**
 *
 * | 場所 | 関数 | 列の持ち方 |
 * |---|---|---|
 * | relay | `normalizeAllowanceRateMaster` | `ALLOWANCE_RATE_TEXT_FIELDS` の列挙 |
 * | front (読み) | `parseRateRow` (下) | `TEXT_FIELDS` (下) の列挙 |
 * | front (書き) | `parseAllowanceRateDraft` (`allowance-rate-editor.ts`) | 列挙を持たず `AllowanceRateDraftRow` の型が列 |
 *
 * **列は将来足される前提** (設計 U3 — 他の営業所ぶんが出たら袋を分けるのではなく
 * 行に列を足す)。だから「規則を変えるときは両方直す」では足りない。**3 か所直す。**
 *
 * ## tsc がどこを守り、どこを守らないか (`RateRow` に 1 列足して実測、Refs #1017 ④)
 *
 * - **relay が列を足しただけでは front は 1 件も型エラーにならない。** `RateRow`
 *   (app) と `AllowanceRateRow` (relay) は別宣言で、front は relay の型を 1 つも
 *   import していない — **型は build 境界を越えない**。この段階では
 *   **front 3 系統とも新しい列を黙って落とす**
 * - **`RateRow` に列を足すと** tsc が止めるのは **2 か所だけ** —
 *   `parseRateRow` の return リテラルと `parseAllowanceRateDraft` の
 *   `rows.push({...})`。`toAllowanceRateDraft` は `RateRow` を**読む**向きなので
 *   余分なプロパティで型エラーにならず、**落ちない**
 * - **`TEXT_FIELDS` と `ALLOWANCE_RATE_TEXT_FIELDS` の 2 つの列挙は、最後まで誰にも
 *   強制されない。** 型に列を足して構築側へ cast を 1 行書けば typecheck は通り、
 *   **その列だけ実行時の型検証を素通りする** — 列が落ちるより静かな壊れ方
 *
 * ⇒ **tsc が守るのは「行の組み立て」で、「検証の列挙」ではない。**
 * 「列挙を持つ側が危なくて型の側は安全」ではないので、**列を足すときは tsc に
 * 教わる前に上の表の 3 か所を先に見る。**
 *
 * ここで落ちるのは relay を通っていない応答 (経路の取り違え・中間のプロキシが
 * 別物を返した) だけのはずで、**落ちたら黙って初期値に倒さず `error` にする**
 * のがこのファイルの仕事。
 */
import { RATE_MASTER, type RateRow } from './allowance-rate-master'

/** relay の運行手当マスタ (PR-1)。**Nitro ではなく relay worker へ転送される。** */
export const ALLOWANCE_RATE_ENDPOINT = '/restraint-api/allowance-rate'

/** マスタの出どころ。**`error` は「出どころが決まらなかった」で、seed ではない。** */
export type AllowanceRateState =
  /** R2 の `latest.json` を読めた。`version` は sha256、`updatedAt` は保存時刻。 */
  | { status: 'r2', rows: RateRow[], version: string | null, updatedAt: string | null }
  /** R2 に `latest.json` が無い (`exists: false`)。**同梱の初期値で計算している。** */
  | { status: 'seed', rows: RateRow[] }
  /** 読めなかった / 壊れていた。**初期値へ倒さない。** */
  | { status: 'error', reason: string }

/** 各行で string を要求する項目。**`note` を含めて 7 つ** — `RateRow` の
 * `note` は optional ではないので、省略を許すと seed と形が揃わなくなる。 */
const TEXT_FIELDS = ['shipper', 'customer', 'loader', 'origin', 'dest', 'brand', 'note'] as const

/** 1 行を検証して `RateRow` にする。**壊れていれば理由 (string) を返す。** */
function parseRateRow(raw: unknown): RateRow | string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'がオブジェクトではありません'
  const r = raw as Record<string, unknown>
  for (const field of TEXT_FIELDS) {
    if (typeof r[field] !== 'string') return `.${field} が文字列ではありません`
  }
  const yen = r.allowanceYen
  if (typeof yen !== 'number' || !Number.isFinite(yen) || yen < 0) {
    return '.allowanceYen が 0 以上の数値ではありません'
  }
  // `farePerT` は「無い」を null で表す。**0 に倒さない** — 倒すと単価の検算が
  // 黙って mismatch になる (中継の内訳など単価が無い便が実在する)。
  const fare = r.farePerT
  if (fare !== null && (typeof fare !== 'number' || !Number.isFinite(fare))) {
    return '.farePerT が数値でも null でもありません'
  }
  return {
    shipper: r.shipper as string,
    customer: r.customer as string,
    loader: r.loader as string,
    origin: r.origin as string,
    dest: r.dest as string,
    brand: r.brand as string,
    farePerT: fare as number | null,
    allowanceYen: yen,
    note: r.note as string,
  }
}

/** 応答の文字列フィールド。**文字列でなければ「不明」扱いの null** にする
 * (欠けているだけで版そのものは在るので、error には倒さない)。 */
function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * `GET /restraint-api/allowance-rate` の応答から、引き当てに使う配列を決める。
 *
 * 応答の形は relay の `handleWageMasterRoute`:
 * `{ exists: false, data: null, version: null }` /
 * `{ exists: true, data: {rows: [...]}, updated_at, version }`。
 *
 * `seed` は差し替えられる (テストが本物の 62 行に依存しないため)。
 */
export function resolveAllowanceRateMaster(res: unknown, seed: RateRow[] = RATE_MASTER): AllowanceRateState {
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    return { status: 'error', reason: '応答が JSON オブジェクトではありません' }
  }
  const exists = (res as { exists?: unknown }).exists
  if (exists === false) return { status: 'seed', rows: seed }
  // **`exists` が真偽値でない応答は「無い」ではない。** relay 以外の何かが
  // 答えている (経路の取り違え) ので、初期値に倒さず理由を出す。
  if (exists !== true) return { status: 'error', reason: '応答に exists がありません' }
  const data = (res as { data?: unknown }).data
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { status: 'error', reason: 'data が JSON オブジェクトではありません' }
  }
  const rawRows = (data as { rows?: unknown }).rows
  if (!Array.isArray(rawRows)) return { status: 'error', reason: 'data.rows が配列ではありません' }
  const rows: RateRow[] = []
  for (let i = 0; i < rawRows.length; i++) {
    const row = parseRateRow(rawRows[i])
    if (typeof row === 'string') return { status: 'error', reason: `data.rows[${i}]${row}` }
    rows.push(row)
  }
  // 0 行は「読めた」ではない。全便が `unknown` になり、画面には手当 ¥0 として出る。
  if (rows.length === 0) return { status: 'error', reason: 'R2 のマスタが 0 行です' }
  return {
    status: 'r2',
    rows,
    version: textOrNull((res as { version?: unknown }).version),
    updatedAt: textOrNull((res as { updated_at?: unknown }).updated_at),
  }
}

/** 通信そのものが失敗した / 認証情報が無い。**理由をそのまま画面へ運ぶ。** */
export function allowanceRateReadError(reason: string): AllowanceRateState {
  return { status: 'error', reason }
}

/** 引き当てに渡す配列。**`error` では `null`** — 呼び出し側が初期値に倒せないように。 */
export function allowanceRateRows(state: AllowanceRateState): RateRow[] | null {
  return state.status === 'error' ? null : state.rows
}

/**
 * 画面に出す 1 文の本体。
 *
 * `amountsLabel` は**その画面で出なくなるもの**。理由は共通でも**結果は画面ごとに違う**
 * ので、1 本の文を 2 枚目に貼ると嘘になる (memory `shared-notice-lies-on-second-screen`)。
 * 運行手当タブは「手当・収支」、粗利タブは「手当・粗利」。
 */
function noticeBody(state: AllowanceRateState, amountsLabel: string): string {
  if (state.status === 'seed') {
    return `R2 未設定のため同梱の初期値で表示しています (同梱 ${state.rows.length} 行)。`
      + 'R2 に登録すると deploy なしで金額を変えられます。'
  }
  if (state.status === 'error') {
    return `運行手当マスタを読めませんでした — ${state.reason}。`
      + `同梱の初期値には倒さないため、${amountsLabel}は表示しません。`
  }
  return `R2 の運行手当マスタで計算しています (${state.rows.length} 行 / 版 ${state.version ?? '不明'}`
    + ` / 更新 ${state.updatedAt ?? '不明'})。`
}

/**
 * 運行手当タブ (`/profit/allowance`) に出す 1 文。
 * **合成後の文字列をテストで固定してある** — ヘルパを 1 本ずつ見て「書いてある」と
 * 判断すると、実際に出る文が別物になることがあるため。
 */
export function allowanceRateNotice(state: AllowanceRateState): string {
  return noticeBody(state, '手当・収支')
}

// --- キャッシュに刻んだ版と、いま読んでいる版の突き合わせ (Refs #1017 ③) ----------
//
// 粗利タブの localStorage キャッシュ (`MarginCache`) は**計算済みの金額**を持つのに、
// **どの手当マスタの版で計算したか**を持っていなかった。そのため注記は永久に
// 「この版で計算したとは限りません」としか言えず、注記が出す「版 X」は
// **いま読んでいる版**だったので、利用者は 2 つの版を見比べられなかった。
//
// **画面の状態は 3 つ (一致 / 不一致 / 不明)。ただし「不明」の内訳は 4 通りあり、
// 1 文に束ねるとどれかで必ず嘘になる** — 内訳は `CacheRateVerdict` の (a)〜(d)。

/**
 * キャッシュに刻んである版 (`MarginCache.rateVersion` / `rateUpdatedAt` **そのまま**)。
 *
 * **欄が無い / null は「記録されていない」**で、`MarginCache` 側が optional なので
 * ここも optional で受ける (**分解せず透過させる** — `MarginCache` に列が増えても
 * この口の型は変わらない)。
 */
export interface CachedRateVersion {
  /**
   * **保存時の `AllowanceRateState.status`。** `version` だけでは「版が無い」の理由を
   * 言い分けられないので刻む — 詳細は `MarginCache.rateSource` の表 (`margin.ts`)。
   * **欄が無い / 知らない値は null** で、それが「このPR より前に保存された」の印。
   */
  source?: 'r2' | 'seed' | null
  version?: string | null
  updatedAt?: string | null
}

/**
 * 突き合わせの結果。**3 つ。`unknown` を `match` に倒さないこと** —
 * 「読まなかった」と「読めなかった」を同じ見た目にするのがこの repo で最も多い欠陥の型。
 */
export type MarginCacheRateMatch = 'match' | 'mismatch' | 'unknown'

/**
 * 突き合わせの内訳。**`unknown` は 2 通りある**ので、ここでは畳まない。
 *
 * - `unrecorded` — **キャッシュに版が刻まれていない** (このPR より前に保存された /
 *   保存した回が `seed` だった)
 * - `no-current` — **刻んだ版はあるが、いま読んでいるマスタに版が無い** (`seed` に
 *   落ちた / 応答に `version` が無い)
 *
 * この 2 つを 1 文に束ねると、**版を刻んであるのに「記録されていません」と言う**回が
 * 出る (集計時は R2 に `latest.json` があり、その後 R2 から消えると `seed` になる。
 * `run()` は `seed` でも保存するので実在する)。
 */
type CacheRateVerdict =
  /** (a) 版も出どころも刻まれていない = **このPR より前に保存された**キャッシュ。 */
  | { kind: 'unrecorded' }
  /** (b) 出どころは刻んである。**それが `seed` (同梱の初期値) だった** — 版は元から無い。 */
  | { kind: 'saved-seed' }
  /** (c) 出どころは `r2`。**応答に版が付いていなかった** (`textOrNull` が null にした)。 */
  | { kind: 'saved-r2-no-version' }
  /** (d) 刻んだ版はある。**いま読んでいるマスタの側に版が無い**ので突き合わせられない。 */
  | { kind: 'no-current', saved: string }
  | { kind: 'match', saved: string }
  | { kind: 'mismatch', saved: string }

/** **判定は 1 か所だけ**にする — 文と色で別々に数えると、片方だけ直したときに黙ってずれる。 */
function rateVerdict(state: AllowanceRateState, cached: CachedRateVersion): CacheRateVerdict {
  const saved = cached.version
  if (typeof saved === 'string') {
    // **`r2` 以外は版そのものが無い。** `seed` の「同梱の初期値」に版は付かない。
    const current = state.status === 'r2' ? state.version : null
    if (current === null) return { kind: 'no-current', saved }
    return { kind: saved === current ? 'match' : 'mismatch', saved }
  }
  // 版が無い。**なぜ無いのかを `rateSource` が言い分ける** — (b) を (a) に倒さない。
  if (cached.source === 'seed') return { kind: 'saved-seed' }
  if (cached.source === 'r2') return { kind: 'saved-r2-no-version' }
  return { kind: 'unrecorded' }
}

/**
 * キャッシュの金額が**いま読んでいる版で計算されたものか**。画面の色分けもこれで決める。
 * **`unknown` を `match` に倒さない** — 倒すと、版を刻む前に保存されたキャッシュが
 * 「この版で計算した」と名乗る。
 */
export function marginCacheRateStatus(state: AllowanceRateState, cached: CachedRateVersion): MarginCacheRateMatch {
  const { kind } = rateVerdict(state, cached)
  return kind === 'match' || kind === 'mismatch' ? kind : 'unknown'
}

/**
 * いま読んでいるマスタの版を、**キャッシュに刻む形**にする (保存側)。
 * **`r2` 以外と「まだ読んでいない」(`null`) は版が無いので `null`** — ここを
 * 「とりあえず今の版」で埋めると、初期値で計算した金額に R2 の版の名札が付く。
 */
export function cachedRateVersionOf(state: AllowanceRateState | null): CachedRateVersion {
  if (state === null || state.status === 'error') return { source: null, version: null, updatedAt: null }
  // **`seed` は「出どころは分かっているが版が無い」。** null に潰すと (a) と混ざる。
  if (state.status === 'seed') return { source: 'seed', version: null, updatedAt: null }
  return { source: 'r2', version: state.version, updatedAt: state.updatedAt }
}

/**
 * キャッシュから出している回に足す 1 文。**6 通りとも別の文**にする
 * (画面の状態は 3 つ = 一致 / 不一致 / 不明。**「不明」の内訳が 4 通り**)。
 *
 * `match` にだけ「集計 を押すと引き直します」を付けないのは、**引き直す理由が版の側には
 * 無い**ため (取り込み直しがあれば古い、という話は別の注記が出している)。
 */
function marginCacheSentence(state: AllowanceRateState, cached: CachedRateVersion): string {
  const head = '表示中の金額は前回の集計 (キャッシュ) のもの'
  const again = '集計 を押すと引き直します。'
  const undecidable = '同じ版かどうかは判定できません。'
  const verdict = rateVerdict(state, cached)
  // (a) 出どころも版も無い = このPR より前のキャッシュ。**ここに (b)(c) を混ぜない。**
  if (verdict.kind === 'unrecorded') {
    return `${head}で、保存時の版が記録されていません。この版で計算したとは限りません。${again}`
  }
  // (b) 記録してある。**それが「同梱の初期値」だった** — 「記録していない」ではない。
  if (verdict.kind === 'saved-seed') {
    return `${head}で、保存時は R2 未設定のため同梱の初期値で計算しています。`
      + `同梱の初期値に版は無いので、${undecidable}${again}`
  }
  // (c) R2 のマスタではあるが、応答に版が付いていなかった。
  if (verdict.kind === 'saved-r2-no-version') {
    return `${head}で、保存時は R2 のマスタで計算していますが、版が付いていません。${undecidable}${again}`
  }
  // **`noticeBody` と同じ並び**にする (「版 X / 更新 Y」)。並びが違うと見比べられない。
  const label = `版 ${verdict.saved} / 更新 ${cached.updatedAt ?? '不明'}`
  // (d) 刻んだ版はある。いま読んでいるマスタの側に版が無い。
  if (verdict.kind === 'no-current') {
    return `${head}で、保存時は ${label} で計算しています。`
      + `いま読んでいるマスタに版が無いため、${undecidable}${again}`
  }
  if (verdict.kind === 'match') {
    return `${head}で、いま読んでいるこの版 (${label}) で計算したものです。`
  }
  return `${head}で、別の版 (${label}) で計算した金額です。${again}`
}

/**
 * 粗利タブ (`/profit/margin`) に出す 1 文。**運行手当タブと 2 か所違う。**
 *
 * 1. 出なくなるのは「手当・粗利」(この画面に「収支」の合計は無い)
 * 2. **キャッシュから出している回は、刻んだ版といまの版を突き合わせた 1 文を足す** —
 *    運行手当タブのキャッシュは金額を残さず読み込み時に引き直すが、
 *    **粗利タブのキャッシュは計算済みの金額そのもの**を持っているため
 *
 * `error` では金額を 1 つも出さない (キャッシュも復元しない) ので 2 は足さない。
 */
export function allowanceRateNoticeForMargin(
  state: AllowanceRateState,
  restoredFromCache: boolean,
  cachedRate: CachedRateVersion,
): string {
  const base = noticeBody(state, '手当・粗利')
  if (state.status === 'error' || !restoredFromCache) return base
  return base + marginCacheSentence(state, cachedRate)
}
