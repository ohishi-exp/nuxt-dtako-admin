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
 * ## 行の検証を relay と 2 か所に持っている理由
 *
 * relay 側の `normalizeAllowanceRateMaster` (`workers/dtako-scraper-relay/src/
 * restraint-wage.ts`) と規則は同じだが、**`app/` から `workers/` は import
 * できない** (別ビルド・別 tsconfig) ので写しになっている。規則を変えるときは
 * 両方直す。ここで落ちるのは relay を通っていない応答 (経路の取り違え・
 * 中間のプロキシが別物を返した) だけのはずで、**落ちたら黙って初期値に倒さず
 * `error` にする**のがこのファイルの仕事。
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
 * 画面に出す 1 文。**合成後の文字列をテストで固定してある** — ヘルパを 1 本ずつ
 * 見て「書いてある」と判断すると、実際に出る文が別物になることがあるため。
 */
export function allowanceRateNotice(state: AllowanceRateState): string {
  if (state.status === 'seed') {
    return `R2 未設定のため同梱の初期値で表示しています (同梱 ${state.rows.length} 行)。`
      + 'R2 に登録すると deploy なしで金額を変えられます。'
  }
  if (state.status === 'error') {
    return `運行手当マスタを読めませんでした — ${state.reason}。`
      + '同梱の初期値には倒さないため、手当・収支は表示しません。'
  }
  return `R2 の運行手当マスタで計算しています (${state.rows.length} 行 / 版 ${state.version ?? '不明'}`
    + ` / 更新 ${state.updatedAt ?? '不明'})。`
}
