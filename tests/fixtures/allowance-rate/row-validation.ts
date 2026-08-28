/**
 * 運行手当マスタ **1 行の検証規則**を、front と relay の**両方に同じ入力で当てる**
 * ための共有 fixture (Refs #1017 ④ / #1022)。
 *
 * ## なぜ共有するのか — 「双子のテスト」は同じ規則を保証しない
 *
 * 検証は 2 実装ある (`app/utils/allowance-rate-source.ts` の `parseRateRow` と
 * `workers/dtako-scraper-relay/src/restraint-wage.ts` の
 * `normalizeAllowanceRateMaster`)。**`app/` から `workers/` は import できない**
 * (別ビルド・別 tsconfig) ので写しになっている。
 *
 * 両側とも既に手厚い単体テストを持つが、**それぞれが自前の入力表を持っている**ため
 * 「片側だけ規則が増えた/減った」は誰にも落とせない。**同じ行の配列を両側へ流して
 * 受理/拒否が一致することだけを見る**と、そこが初めて落ちる。
 *
 * - 片側が**規則を落とす** → その行を受理してしまい、その側のテストが落ちる
 * - 片側が**規則を足す** (例: 8 列目を必須にした) → 正常行を拒否してしまい、
 *   **その側の自前テスト (7 列をベタ書き) は緑のまま**この突合だけが落ちる
 *
 * ## 通知方式の違いは吸収する
 *
 * front は文字列 sentinel を return、relay は `WageMasterError` を throw する。
 * **文言は揃えない** — ここで見るのは受理/拒否の一致だけ。
 *
 * ## JSON ではなく `.ts` なのは NaN / Infinity / undefined を書くため
 *
 * 両実装とも `Number.isFinite` と「キーの欠落」を見る。JSON ではこの 3 つを
 * 表現できず、fixture 側にデコーダを置くと**そのデコーダが 3 つ目の写し**になる。
 * `tests/fixtures/allowance-golden-2026-07.ts` と同じく `.ts` で置く。
 *
 * ## 実在の取引先名・銘柄は書かない (この repo は public)
 */

/** 各行で string を要求する項目。**この配列から欠落/非文字列のケースを生成する**ので、
 * ベタ書きの列挙とずれることが無い。 */
export const SHARED_TEXT_FIELDS = [
  'shipper',
  'customer',
  'loader',
  'origin',
  'dest',
  'brand',
  'note',
] as const

/** 突合に使う 1 ケース。`row` は**壊れた行も入る**ので `unknown`。 */
export interface AllowanceRateRowCase {
  /** テスト名に出る短い説明。 */
  readonly name: string
  /** 検証関数へ渡す 1 行 (そのまま `rows: [row]` に入れる)。 */
  readonly row: unknown
  /** **両実装が受理すべきか。** false なら両実装が拒否すべき。 */
  readonly accept: boolean
}

/** 正常な 1 行。**9 キーちょうど** (`RateRow` / `AllowanceRateRow` と同じ形)。 */
function baseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    shipper: 'G社',
    customer: '得意先A',
    loader: '積地業者A',
    origin: '積地A',
    dest: '卸地A',
    brand: '銘柄A',
    farePerT: 2750,
    allowanceYen: 9000,
    note: '',
    ...over,
  }
}

const ACCEPTED: readonly AllowanceRateRowCase[] = [
  { name: '正常行 (farePerT は数値)', row: baseRow(), accept: true },
  // 「無い」を null で表す。**0 に倒さない** — 単価の検算が黙って mismatch になる。
  { name: 'farePerT が null (欠測を 0 に倒さない)', row: baseRow({ farePerT: null }), accept: true },
  // 無償の便を「壊れている」にしない。落とすのは負だけ。
  { name: 'allowanceYen が 0 (境界・通る)', row: baseRow({ allowanceYen: 0 }), accept: true },
  { name: 'note が空文字 (備考なしは正常)', row: baseRow({ note: '' }), accept: true },
  { name: 'brand が空文字 (卸地だけで運賃が決まる契約)', row: baseRow({ brand: '' }), accept: true },
]

/** キーごと落とした行 (`undefined` を入れるのではなく本当に消す)。 */
function withoutKey(field: string): Record<string, unknown> {
  const row = baseRow()
  delete row[field]
  return row
}

/** 7 テキスト列 × {欠落, 非文字列} = 14 ケースを列挙から生成する。 */
const TEXT_FIELD_REJECTED: readonly AllowanceRateRowCase[] = SHARED_TEXT_FIELDS.flatMap(
  (field): AllowanceRateRowCase[] => [
    { name: `${field} が欠落`, row: withoutKey(field), accept: false },
    { name: `${field} が非文字列 (数値)`, row: baseRow({ [field]: 1 }), accept: false },
  ],
)

const OTHER_REJECTED: readonly AllowanceRateRowCase[] = [
  { name: 'allowanceYen が負', row: baseRow({ allowanceYen: -1 }), accept: false },
  { name: 'allowanceYen が NaN', row: baseRow({ allowanceYen: Number.NaN }), accept: false },
  { name: 'allowanceYen が Infinity', row: baseRow({ allowanceYen: Number.POSITIVE_INFINITY }), accept: false },
  { name: 'allowanceYen が文字列', row: baseRow({ allowanceYen: '9000' }), accept: false },
  { name: 'allowanceYen が欠落', row: withoutKey('allowanceYen'), accept: false },
  { name: 'farePerT が文字列', row: baseRow({ farePerT: '2750' }), accept: false },
  { name: 'farePerT が NaN', row: baseRow({ farePerT: Number.NaN }), accept: false },
  { name: 'farePerT が Infinity', row: baseRow({ farePerT: Number.POSITIVE_INFINITY }), accept: false },
  // **`undefined` は `null` ではない。** 「明示的に無い」だけを通す。
  { name: 'farePerT が欠落 (null を明示していない)', row: withoutKey('farePerT'), accept: false },
  { name: '行が null', row: null, accept: false },
  { name: '行が配列', row: [], accept: false },
  { name: '行が文字列', row: 'row', accept: false },
  { name: '行が数値', row: 1, accept: false },
]

/** front / relay の両方に当てる行の配列。**両側が同じ受理/拒否になること**だけを見る。 */
export const ALLOWANCE_RATE_ROW_CASES: readonly AllowanceRateRowCase[] = [
  ...ACCEPTED,
  ...TEXT_FIELD_REJECTED,
  ...OTHER_REJECTED,
]
