/**
 * 賃金構成の表で、**基本給と残業の金額にホバーしたときに出す計算式**を組み立てる
 * (pure、Refs #816)。
 *
 * 表の下の注記は式の**一般形** (「基本給 = 法定内時間 × 単価」) しか書けないので、
 * 読む人がその乗務員の数字を自分で当てはめ直す必要があった。ここは**当てはめた式**を
 * 返す。注記は定義として残す — どちらか片方では足りない。
 *
 * ```
 * 基本給 方式A   209.6h × ¥1,075 = ¥225,338
 * 基本給 方式B   27日 × ¥8,600 = ¥232,200
 * 残業           (時間外 106.6h × 1.25 ＋ 深夜 15.3h × 0.25) × ¥1,075 = ¥147,378
 * ```
 *
 * ## 決まっていること (勝手に変えない)
 *
 * - **金額は 1 円も再計算しない。** `=` の右は `computeWageMixRow` が出した
 *   `baseWageYen` / `overtimeYen` をそのまま出す。ここで掛け直すと、表の金額と
 *   ホバーの金額が食い違う画面になる
 * - **時間は表と同じ丸め (小数第1位)** で出す。`209.6 × 1075` を電卓で叩くと
 *   ¥225,320 になり `=` の右 (¥225,338) と数百円ずれるが、これは**表の
 *   「法定内 209.6h」と同じ丸め**であって、金額の側は丸めていない実時間
 *   (209.6166…h) で出ている。表に出ている数字と違う時間を式に書く方が誤解を生む
 * - **方式B の単価は `(日額 ¥8,600 ÷ 8)` と括弧のまま出す。** `¥1,075` に
 *   潰すと、日額を 8 で割った値であることが式から消える (日額が 8 で割り切れない
 *   ときは丸めた単価と実際の金額も合わなくなる)
 * - **欠測の行は式を出さない (`null`)。** 拘束が引けず金額が `null` の行で
 *   `0h × ¥1,075 = ¥0` のような式を出すと、0 分働いたことになってしまう
 */

import {
  HOLIDAY_MULTIPLIER,
  NIGHT_MULTIPLIER,
  OVERTIME_MULTIPLIER,
  SCHEDULED_HOURS_PER_DAY,
  type WageMixRow,
  type WageMixSettings,
} from './profit-wage-mix'

/**
 * 金額が出ている行。**`computeWageMixRow` は時間と金額を一緒に埋めるか、一緒に
 * `null` にするかのどちらかしかしない** (欠測を 0 に倒さないため) ので、
 * 代表して `baseWageYen` を見れば残りも埋まっている。この不変条件は
 * `tests/utils/profit-wage-formula.test.ts` で両側 (欠測 / 計算済み) を突いて確かめる。
 */
export type ComputedWageMixRow = WageMixRow & {
  statutoryHours: number
  premiumHours: number
  overtimeHours: number
  nightHours: number
  holidayHours: number
  workDays: number
  baseWageYen: number
  overtimeYen: number
}

export function hasWageMixAmounts(row: WageMixRow): row is ComputedWageMixRow {
  return row.baseWageYen !== null
}

/**
 * 金額 (`¥225,338`)。表の `yen()` と同じ形。
 * **`+ 0` で `-0` を `+0` に畳む** (Refs #843)。割増ぶん (`overtimeYen`) は
 * `premiumHours * unitYen` の**端数つき**で、拘束の集計は負の分を出すことがある
 * (`timecard-compare-view.ts` の「nginx 側の異常 (負の拘束など)」と同じ事情) ため
 * `-0.5 ≤ v < 0` に落ちうる。`Math.round` はそこで `-0` を返し、
 * `(-0).toLocaleString()` が **`"-0"`** を出すので式の注記に `¥-0` と載っていた。
 * `-0.6` は `¥-1` のまま。
 */
function yen(value: number): string {
  return `¥${(Math.round(value) + 0).toLocaleString()}`
}

/** 時間 (`209.6h`)。**表の「法定内」「割増係数」と同じ丸め** (小数第1位)。 */
function hours(value: number): string {
  return `${Math.round(value * 10) / 10}h`
}

/**
 * 基本給の計算式。方式A は `法定内時間 × 単価`、方式B は `稼働日数 × 日額`。
 * 欠測 (拘束が引けていない) の行は `null`。
 */
export function wageMixBaseFormula(row: WageMixRow, settings: WageMixSettings): string | null {
  if (!hasWageMixAmounts(row)) return null
  const left = settings.method === 'hours'
    ? `${hours(row.statutoryHours)} × ${yen(settings.hourlyRateYen)}`
    : `${row.workDays}日 × ${yen(settings.dailyRateYen)}`
  return `${left} = ${yen(row.baseWageYen)}`
}

/**
 * 残業の計算式。**割増の内訳 (時間外・深夜) は表に列が無い**ので、ここが唯一の
 * 出しどころ。単価だけが方式で変わる (方式B は `日額 ÷ 8`)。
 * 欠測 (拘束が引けていない) の行は `null`。
 */
export function wageMixOvertimeFormula(row: WageMixRow, settings: WageMixSettings): string | null {
  if (!hasWageMixAmounts(row)) return null
  const terms = [
    `時間外 ${hours(row.overtimeHours)} × ${OVERTIME_MULTIPLIER}`,
    `深夜 ${hours(row.nightHours)} × ${NIGHT_MULTIPLIER}`,
  ]
  // 法定休日は拘束時間サマリが持たないので通常 0。**0 の項は並べない** —
  // 金額に 1 円も効いていない項を式に足すと、係数の読み違いを誘う。
  if (row.holidayHours > 0) terms.push(`法定休日 ${hours(row.holidayHours)} × ${HOLIDAY_MULTIPLIER}`)
  // **方式B は `(日額 ÷ 8)` のまま出す** — 単価に潰すと 8 で割った値だと分からない。
  const unit = settings.method === 'hours'
    ? yen(settings.hourlyRateYen)
    : `(日額 ${yen(settings.dailyRateYen)} ÷ ${SCHEDULED_HOURS_PER_DAY})`
  return `(${terms.join(' ＋ ')}) × ${unit} = ${yen(row.overtimeYen)}`
}
