/**
 * R2 に残した**粗利の集計の版**を 2 つ選んで突き合わせる pure 部分 (Refs #834)。
 *
 * オーナーの要望「**いつ変わったのか追えるようにしたい**」の後半。#833 (`margin-versions.ts`)
 * で版の一覧は出ているので、ここは**選んだ 2 版のどこが動いたか**だけを持つ。
 *
 * **新しいデータ取得をしない。** 版 (`MarginSummarySnapshot`) の中身だけを読む。R2 も
 * localStorage も触らない (IO は `server/api/profit/margin-snapshot.get.ts` が持つ)。
 *
 * **粗利の数字を 1 円も作らない・作り直さない。** `margin.ts` の計算にも `MarginCache` の
 * 形にも `reconcileVehicles` にも触らず、**保存済みの値どうしを引き算するだけ**。
 *
 * ## ★ 運行 1 本の粗利 (`marginYen`) をここで出さない
 *
 * `buildOperationMargins(ops, costs, overrides, runCostShareMode)` の**後ろ 2 つ**
 * (`overrides` = 燃費の上書き `FuelRateMap` と `runCostShareMode` = 運行経費の配分の比) は
 * **集計した端末の localStorage 由来**で、**形式 1 の版には入っていない**。
 *
 * **形式 2 (Refs #886) からは指紋として版に入る** — `fuelRateOverrides` /
 * `runCostShareMode`。ただし**入るのは #886 より後に保存された版だけ**で、
 * **形式 1 の既存の版には遡って付けられない** (上書きした値は端末にしか無く、
 * 版を保存した時点で失われている)。⇒ **形式 1 の版から運行 1 本の粗利は永久に厳密に
 * 再現できない。** この非対称性は消えない。
 *
 * そしてこのファイルは**どちらの形式でも運行 1 本の粗利を作らない** — 保存済みの値を
 * 引き算するだけで、粗利を計算し直さない (再計算すると「画面が実際に見た
 * `totals.marginYen`」とズレる数字を作りかねない)。指紋を突き合わせて
 * 「燃費の上書きが変わった」まで言うのは別 PR の担当。
 *
 * だから運行単位は**生の入力値** (`salesYen` / `allowanceYen` / `totalKm` / 便数) の比較まで。
 * 月全体の粗利は `totals.marginYen` (**保存された実測値**) で見せる — こちらは安全。
 * `buildOperationMargins` はこのファイルから 1 回も呼ばない。
 *
 * ## ★ 便は `seq` のまま突き合わせる。`date`+`originCity`+`destCity` で寄せない
 *
 * `MarginLegInput` に安定 ID は無く、`seq` は**積みの順番**でしかない。便が 1 本増減すると
 * seq が総ずれして「全便が変わった」と出るので、**便数が違えば便ごとの数値比較は出さない**
 * (`MarginDiffLegs.state === 'count-changed'`)。日付と積地・卸地で寄せる案は採らない —
 * 往復や同一区間を複数回通る運行で複数の便が同じキーになり、**別の便どうしを誤って
 * 対応付ける**。ずれた対応を差分として出すより、出さない方が安全側。
 *
 * ## ★ 動いたかどうかは「画面に出る精度」で決める (Refs #838)
 *
 * 保存された `totals.marginYen` は按分が割り算を含むぶん `4467597.000000001` のような
 * 浮動小数の尾を持つ (**それ自体は正常**)。厳密比較で「動いた」を決めると、
 * **合計の足し順が変わるだけのリファクタ**で「粗利が **¥0** 動いた」と出る。
 * だから**単位ごとに画面の精度へ丸めてから引く** (`marginDiffDisplayDelta`)。
 * **金額・距離・本数を 1 つの丸め方でまとめない** — 距離を金額と同じに丸めると
 * 0.4km の実変化が消える。**数字そのものは 1 円も変えていない** (直したのは比べ方だけで、
 * `before` / `after` は生値のまま返す)。
 *
 * ## 出さないもの
 *
 * - `costs` (`CostRow`) の明細 diff — 経費明細の増減がノイズとして大量に出る割に月次の
 *   粗利には効かないことが多い
 * - 伝票 1 行まで — 版に明細は入っておらず (量が桁違いなので `margin.ts` が意図して
 *   合計に畳んでいる)、**一番星側が持つべき監査証跡**
 */
import type { CrossMonthLegs } from './allowance-report'
import type { MarginCache, MarginLegInput, MarginOperationInput, MarginTotals, UncoveredTotals } from './margin'
import { pickMarginVersionTotals, type MarginVersionTotals } from './margin-versions'

// --- 差分が読む版の中身 ---

/**
 * 差分が読む版の中身。**`MarginSummarySnapshot` をそのまま型として受けない。**
 *
 * あちらの `schemaVersion` は**リテラル型** (`typeof MARGIN_SUMMARY_SCHEMA_VERSION` = `2`)
 * なので、そのまま受けると型の上では「形式が違う 2 版」が存在しないことになり、
 * **この issue が要求する「形式が違えば比べない」の判定が型の段階で死ぬ**。
 * R2 から読むのは**いま動いているコードが書いたとは限らない過去の JSON** で、
 * 将来 `2` にもなりうるので、ここでは `number` で受ける。
 *
 * `MarginSummarySnapshot` は構造的にこの型へ代入できる (リテラル `1` は `number`)。
 * テストで代入可能性を固定してある。
 */
export interface MarginDiffSnapshot {
  schemaVersion: number
  ym: string
  codeVersion: string
  savedAt: string
  totals: MarginTotals
  cache: MarginCache
}

/** 差分の片側。**版の名前 (`v-20260824T190153`) は R2 のキーから画面が作る**ので受け取る。 */
export interface MarginDiffSide {
  /** 人に見せる版の名前 (`marginVersionLabel` の結果)。**R2 のキーではない。** */
  label: string
  snapshot: MarginDiffSnapshot
}

/** 差分の見出しに出す、版そのものの識別。 */
export interface MarginDiffVersionRef {
  label: string
  savedAt: string
  codeVersion: string
  schemaVersion: number
}

function versionRef(side: MarginDiffSide): MarginDiffVersionRef {
  return {
    label: side.label,
    savedAt: side.snapshot.savedAt,
    codeVersion: side.snapshot.codeVersion,
    schemaVersion: side.snapshot.schemaVersion,
  }
}

// --- 数字 1 項目ぶんの差 ---

/** 数字の出し方。**書式そのものは画面が持つ** (`yen()` / `km()` を再発明しない)。 */
export type MarginDiffUnit = 'yen' | 'km' | 'count'

/** 比べる項目の定義 (鍵・見出し・出し方)。 */
export interface MarginDiffFieldSpec<K extends string> {
  readonly key: K
  readonly label: string
  readonly unit: MarginDiffUnit
}

/** 差の 1 行。**`before` / `after` を捨てない** — 差だけ出すと検算できない。 */
export interface MarginDiffRow {
  key: string
  label: string
  unit: MarginDiffUnit
  /** 版に保存された**生値そのまま**。丸めない。 */
  before: number
  after: number
  /**
   * ★ **画面に出ている数字どうしの差** (`marginDiffDisplayDelta`)。
   * **`after - before` の生の引き算ではない** — `before` / `after` は生値のままなので、
   * 両者を厳密に引き算した値とは円未満 / 0.1km 未満で食い違いうる (Refs #838)。
   */
  delta: number
}

/**
 * ★ **その単位が画面に出る精度**に載せる (Refs #838)。**画面の丸め方をそのまま写す** —
 * 金額は `yen()` の `Math.round`、距離は `km()` の `Math.round(v * 10) / 10`。
 *
 * **3 つの単位を 1 つの丸め方でまとめない。** 距離に金額と同じ `Math.round` を当てると
 * **0.4km の実変化が消える** (走行 57,829.0km → 57,829.4km が「動いていない」になる。実測)。
 * 本数 (`count`) は運行本数・便数で**整数しか取らない**ので**何もしない** — 変わらないものに
 * 丸めを足すと「丸めてあるから安全」という誤った読みだけが残る。
 */
function atDisplayPrecision(unit: MarginDiffUnit, v: number): number {
  if (unit === 'yen') return Math.round(v)
  if (unit === 'km') return Math.round(v * 10) / 10
  return v
}

/**
 * ★ **各版を画面の精度に丸めてから引く** (Refs #838)。
 *
 * 保存された `totals.marginYen` は按分が割り算を含むぶん `4467597.000000001` のような
 * 浮動小数の尾を持つ (**これ自体は正常**)。生のまま `delta !== 0` で比べると、
 * **合計の足し順が変わるだけのリファクタ**で `9.31e-10` の差が「動いた」と判定され、
 * 表示は円に丸まるので**「粗利: ¥0」**と出る (本番 v0.0.526 の値で実測)。
 *
 * **「丸めてから引く」であって「差を丸める」ではない。** 実測した反例:
 * `before = 100.4` (画面 `¥100`) / `after = 100.6` (画面 `¥101`) のとき
 * `Math.round(after - before) = Math.round(0.19999999999998863) = 0` となり
 * **「動いていない」**になる — **画面に出ている 2 つの数字は 1 円違うのに差は 0**、という
 * 食い違いが起きる。丸めてから引けば `101 - 100 = 1` で、**人が画面の数字でやる検算と一致**する。
 *
 * 引き算そのものがまた尾を作る (`57829.4 - 57829.1 = 0.3000000000029104`) ので、
 * **結果も同じ格子に載せ直す**。**これで 0 に潰れることはない** — 0.1km 格子の 2 点の差は
 * 最小 0.1 で、丸めの粒 0.05 より大きい (実測)。
 */
export function marginDiffDisplayDelta(unit: MarginDiffUnit, before: number, after: number): number {
  return atDisplayPrecision(unit, atDisplayPrecision(unit, after) - atDisplayPrecision(unit, before))
}

/**
 * 項目の定義と 2 つの値の袋から差の行を作る。
 *
 * 袋を `Record<K, number>` にしてあるので、**`specs` に無い鍵は入れられず、
 * `specs` の鍵は必ず在る** (`noUncheckedIndexedAccess` でも `undefined` にならない) —
 * 通らない `?? 0` を書かずに済む形。
 */
function diffRows<K extends string>(
  specs: readonly MarginDiffFieldSpec<K>[],
  before: Record<K, number>,
  after: Record<K, number>,
): MarginDiffRow[] {
  return specs.map(spec => ({
    key: spec.key,
    label: spec.label,
    unit: spec.unit,
    before: before[spec.key],
    after: after[spec.key],
    delta: marginDiffDisplayDelta(spec.unit, before[spec.key], after[spec.key]),
  }))
}

/**
 * 上のうち**動いた行だけ**。運行・便の一覧はこちら (動いていない行を並べると読めない)。
 *
 * `delta` は既に**画面に出る精度**なので、ここは**厳密比較のままでよい** (Refs #838) —
 * 画面に出る精度で同じなら `delta` はきっちり `0` になる。ここで改めて丸めると
 * **単位ごとの精度が消える** (`Math.round(0.4) === 0` で 0.4km の実変化が落ちる)。
 */
function changedRows<K extends string>(
  specs: readonly MarginDiffFieldSpec<K>[],
  before: Record<K, number>,
  after: Record<K, number>,
): MarginDiffRow[] {
  return diffRows(specs, before, after).filter(row => row.delta !== 0)
}

// --- 月全体 (`totals`) ---

/**
 * 月全体で出す 4 項目。**一覧 (`MarginVersionTotals`) と同じ 4 つに揃える** — 一覧で
 * 見比べた数字と差分の数字が違う項目だと、同じ画面の中で対応が取れない。
 */
export type MarginDiffTotalsKey = keyof MarginVersionTotals

export const MARGIN_DIFF_TOTALS_FIELDS: readonly MarginDiffFieldSpec<MarginDiffTotalsKey>[] = [
  { key: 'operations', label: '運行', unit: 'count' },
  { key: 'salesYen', label: '売上', unit: 'yen' },
  { key: 'allowanceYen', label: '手当', unit: 'yen' },
  { key: 'marginYen', label: '粗利', unit: 'yen' },
]

// --- 運行 (`unkoNo`) ---

/**
 * 運行 1 本で比べる項目。**`marginYen` は無い** (上の「運行 1 本の粗利を出さない」)。
 * ここに在るのは**版に保存された生の入力値**だけで、どれも再計算していない。
 */
export type MarginDiffOperationKey = 'salesYen' | 'allowanceYen' | 'totalKm' | 'legCount'

export const MARGIN_DIFF_OPERATION_FIELDS: readonly MarginDiffFieldSpec<MarginDiffOperationKey>[] = [
  { key: 'salesYen', label: '売上', unit: 'yen' },
  { key: 'allowanceYen', label: '手当', unit: 'yen' },
  { key: 'totalKm', label: '走行km', unit: 'km' },
  { key: 'legCount', label: '便数', unit: 'count' },
]

function operationValues(op: MarginOperationInput): Record<MarginDiffOperationKey, number> {
  return {
    salesYen: op.salesYen,
    allowanceYen: op.allowanceYen,
    totalKm: op.totalKm,
    legCount: op.legs.length,
  }
}

/** 片方の版にしか無い運行 (追加 / 削除) の 1 行。**差ではなく生値**を並べる。 */
export interface MarginDiffOperationSide {
  unkoNo: string
  date: string
  driverName: string
  vehicleCode: string
  salesYen: number
  allowanceYen: number
  totalKm: number
  legCount: number
}

function operationSide(op: MarginOperationInput): MarginDiffOperationSide {
  return {
    unkoNo: op.unkoNo,
    date: op.date,
    driverName: op.driverName,
    vehicleCode: op.vehicleCode,
    ...operationValues(op),
  }
}

// --- 便 (`seq`) ---

export type MarginDiffLegKey = 'salesYen' | 'allowanceYen' | 'haulKm' | 'deadheadKm'

export const MARGIN_DIFF_LEG_FIELDS: readonly MarginDiffFieldSpec<MarginDiffLegKey>[] = [
  { key: 'salesYen', label: '売上', unit: 'yen' },
  { key: 'allowanceYen', label: '手当', unit: 'yen' },
  { key: 'haulKm', label: '売上km', unit: 'km' },
  { key: 'deadheadKm', label: '回送km', unit: 'km' },
]

function legValues(leg: MarginLegInput): Record<MarginDiffLegKey, number> {
  return {
    salesYen: leg.salesYen,
    allowanceYen: leg.allowanceYen,
    haulKm: leg.haulKm,
    deadheadKm: leg.deadheadKm,
  }
}

/** 便 1 本の見出し (`2026-07-03 帯広 → 札幌`)。**同じ `seq` に別の便が来たか**を見るため。 */
export function marginDiffLegLabel(leg: MarginLegInput): string {
  return `${leg.date} ${leg.originCity} → ${leg.destCity}`
}

/**
 * 便を比べたのか、比べずに止めたのか。**`legs: []` の意味を 1 つに潰さない** —
 * 「比べたが 1 本も動いていない」と「便数が違うので比べていない」は別のこと。
 */
export type MarginDiffLegsState = 'compared' | 'count-changed'

/** 動いた便 1 本ぶん。 */
export interface MarginDiffLegChange {
  seq: number
  beforeLabel: string
  afterLabel: string
  /**
   * 同じ `seq` に**別の便**が来たか (日付・積地・卸地のどれかが違う)。金額が同じでも
   * これが立っていれば、便の並びそのものが入れ替わっている。
   */
  routeChanged: boolean
  /** 動いた数字だけ。 */
  rows: MarginDiffRow[]
}

export interface MarginDiffLegs {
  state: MarginDiffLegsState
  beforeCount: number
  afterCount: number
  /** **`state === 'compared'` のときだけ中身が入りうる。** 動いた便だけ。 */
  legs: MarginDiffLegChange[]
}

function diffLegs(before: MarginLegInput[], after: MarginLegInput[]): MarginDiffLegs {
  const counts = { beforeCount: before.length, afterCount: after.length }
  // **便数が違えば便ごとの数値は出さない。** seq が総ずれして「全便が変わった」になる。
  if (before.length !== after.length) return { state: 'count-changed', ...counts, legs: [] }
  const legs: MarginDiffLegChange[] = []
  for (const [i, a] of after.entries()) {
    // 長さが等しいことを上で確かめているので、同じ index は必ず在る。
    const b = before[i]!
    const beforeLabel = marginDiffLegLabel(b)
    const afterLabel = marginDiffLegLabel(a)
    const routeChanged = beforeLabel !== afterLabel
    const rows = changedRows(MARGIN_DIFF_LEG_FIELDS, legValues(b), legValues(a))
    if (!routeChanged && rows.length === 0) continue
    legs.push({ seq: a.seq, beforeLabel, afterLabel, routeChanged, rows })
  }
  return { state: 'compared', ...counts, legs }
}

/** 便を比べなかった理由。比べたときは空文字 (何も出さない)。 */
export function marginDiffLegCountNote(legs: MarginDiffLegs): string {
  if (legs.state === 'compared') return ''
  return `便数が ${legs.beforeCount} → ${legs.afterCount} に変わったので、便ごとの数値は比べていません`
    + ' — 便に安定した ID が無く (seq は積みの順番でしかない)、1 本増減すると以降の便が'
    + '総ずれして「全部変わった」と出るためです。'
}

/** 両方の版にある運行のうち、動いたもの。 */
export interface MarginDiffChangedOperation {
  unkoNo: string
  /** **新しい方の版**の値。運行の日付・乗務員・車輌はこの差分では比べない。 */
  date: string
  driverName: string
  vehicleCode: string
  /** 動いた項目だけ (`MARGIN_DIFF_OPERATION_FIELDS` のうち)。 */
  rows: MarginDiffRow[]
  legs: MarginDiffLegs
}

// --- 画面に出す注記 ---

/** 金額の文字列。**画面の `yen()` と同じ丸め方** (`Math.round` + 3 桁区切り)。 */
function yenText(v: number): string {
  return `¥${Math.round(v).toLocaleString()}`
}

function uncoveredText(t: UncoveredTotals | null): string {
  // `summarizeUncoveredLegs` は 1 便も無ければ null を返すので、null は 0 便のこと。
  if (t === null) return '0 便'
  return `${t.trips} 便 (売上 ${yenText(t.salesYen)}、手当 ${yenText(t.allowanceYen)})`
}

/**
 * 粗利の**対象外**の便が動いたときだけ 1 行。動いていなければ空文字。
 * (月 1 オブジェクトなので運行の一覧には混ぜない。)
 */
export function marginDiffUncoveredNote(before: UncoveredTotals | null, after: UncoveredTotals | null): string {
  const b = uncoveredText(before)
  const a = uncoveredText(after)
  if (b === a) return ''
  return `粗利の対象外の便が変わりました: ${b} → ${a} (この額は粗利の内訳とは足し合わせません)。`
}

function crossMonthText(c: CrossMonthLegs | null): string {
  if (c === null) return 'なし'
  return `翌月日付の便 ${c.nextMonthLegs} 便 (手当 ${yenText(c.nextMonthAllowanceYen)})`
    + ` / 前月開始の運行の当月便 ${c.prevMonthOpsLegsInMonth} 便 (手当 ${yenText(c.prevMonthOpsAllowanceYen)})`
}

/** 月を跨いだ便が動いたときだけ 1 行。動いていなければ空文字。 */
export function marginDiffCrossMonthNote(before: CrossMonthLegs | null, after: CrossMonthLegs | null): string {
  const b = crossMonthText(before)
  const a = crossMonthText(after)
  if (b === a) return ''
  return `月を跨いだ便が変わりました: ${b} → ${a}。`
}

/**
 * **形式が違う版どうしは比べない** (Refs #834 の条件)。黙って旧形式のフィールドを無視して
 * 差分を出すと、**形が変わっただけなのに数字が動いたように見える**。
 * `margin-summary.post.ts` の `isValidInput` が保存時に厳格一致で弾いているのと同じ思想。
 */
export function marginDiffSchemaMismatchNote(before: MarginDiffVersionRef, after: MarginDiffVersionRef): string {
  return '比較できません (版の形式が違います) — '
    + `${before.label} は形式 ${before.schemaVersion}、${after.label} は形式 ${after.schemaVersion} です。`
    + '形式が違う版を突き合わせると、形が変わっただけなのに数字が動いたように見えるので、差分は出していません。'
}

/**
 * コード版が違う 2 版を並べていることを言う。同じなら空文字。
 *
 * **同じ入力でもロジックが変われば数字は動く** — 版に `codeVersion` を刻んであるのは
 * そのためなので (map skill)、差分を読む人にもここで断る。
 */
export function marginDiffCodeVersionNote(before: MarginDiffVersionRef, after: MarginDiffVersionRef): string {
  if (before.codeVersion === after.codeVersion) return ''
  return `この 2 版はコード版が違います (${before.codeVersion} → ${after.codeVersion}) —`
    + ' 同じ入力でも計算のロジックが変われば数字は動きます。'
}

/**
 * ★ **版そのものが端末の設定で増えることがある**旨 (Refs #834 の条件)。
 *
 * `marginSummaryHashInput` は `totals` をハッシュ対象に含めるので、`totals` を動かす
 * **燃費の上書き** (`FuelRateMap`) を変えた端末で集計すると、取り込みデータが 1 円も
 * 変わっていなくても**新しい版が生まれる**。**#886 で指紋が入っても、版が増えること自体は
 * 止まらない** (増えた理由が版に残るようになるだけ) ので、ここは今も真。
 *
 * ★ **文言は「版に有る/無い」ではなく「この差分が何を出しているか」で書く** (Refs #886)。
 * 「版には残っていません」は**形式 2 どうしなら偽・形式 1 が絡めば真**で、版によって
 * 真偽が変わるため定数として成立しない。**この差分が保存された値を引き算するだけ**なのは
 * どちらの版でも変わらないので、そちらに寄せる。
 *
 * **逆方向の誤読も潰す** (#854 の型): 「指紋が記録されるようになった」と書くと
 * 「じゃあ差分に出るはず」と読まれるが、`buildMarginDiff` は指紋を突き合わせない
 * (ロジック無改変)。**出ないものを出るように読ませない。**
 * 粗利が動いていない回は出さない (常に出すと読み飛ばされる)。
 */
export const MARGIN_DIFF_OVERRIDE_CAVEAT
  = 'この粗利の差は、集計した端末の設定 (燃費の上書き) でも起こりえます — '
    + 'データが 1 円も変わっていないのに版が増えていることがあります。'
    + 'この差分は保存された値を引き算するだけなので、どちらが原因だったかまでは出していません。'

/**
 * ★ **渡すのは「画面に出る精度の粗利の差」** (`marginDiffDisplayDelta('yen', …)` の結果)。
 * 生の引き算を渡すと浮動小数の尾で「¥0 動いた」回にも注記が出る (Refs #838)。
 */
export function marginDiffOverrideCaveat(marginDelta: number): string {
  if (marginDelta === 0) return ''
  return MARGIN_DIFF_OVERRIDE_CAVEAT
}

/**
 * **運行 1 本ごとの粗利を出していない**ことを画面で言う。**黙って出さない**と、
 * 「粗利の列が無い = 粗利が動いていない」と読まれる。
 *
 * ★ **理由は 2 段で、順番を入れ替えない** (Refs #886)。①**この差分が再計算しないから**
 * (版に依存しない・これが本体) ②**形式 1 の版は端末の設定を持たないので、そもそも
 * 再現できないから**。②だけにすると形式 2 どうしで嘘になり、①だけにすると
 * 「形式 2 なら出せるのに出していない」と読める。**非対称性はここに 1 か所だけ残す** —
 * 指紋が付くのはこれから保存される版だけで、**過去の版には遡って付かない**。
 */
export const MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE
  = '運行 1 本ごとの粗利 (経費・燃料代を引いた額) は出していません — この差分は保存された値を'
    + '引き算するだけで、粗利を計算し直さないためです。加えて、形式 1 の版は燃費の上書きと'
    + '運行経費の配分を持たないので、そもそも運行 1 本の粗利を後から厳密に再現できません'
    + ' (指紋が付くのは形式 2 以降に保存された版だけで、過去の版に遡って付けることはできません)。'
    + 'ここに出しているのは版に保存された生の入力値 (売上・手当・走行km・便数) だけです。'
    + '月全体の粗利は保存された実測値です。'

/**
 * **版が 2 本に足りないときに、何が足りないのかを言葉で出す** (Refs #831 で学んだこと)。
 * 選択肢が 1 つしか無い画面を**黙って空にしない**。2 本以上あれば空文字。
 */
export function marginDiffNeedsMoreVersionsNote(versionCount: number): string {
  if (versionCount >= 2) return ''
  return `R2 に残っている版が ${versionCount} 本しかないので、まだ差分を出せません — 比べるには 2 本以上要ります。`
    + '版が増えるのは「粗利タブで集計して、前の版と数字が変わったとき」だけです'
    + ' (同じ数字なら版は増えません)。'
}

// --- 差分そのもの ---

/** 比べられたか。**比べられなかった理由を `null` や空配列に潰さない。** */
export type MarginDiffState = 'ready' | 'schema-mismatch'

export interface MarginDiff {
  state: MarginDiffState
  before: MarginDiffVersionRef
  after: MarginDiffVersionRef
  /** 比べられなかった理由。比べられたときは空文字。 */
  blockedNote: string
  /** 月全体。**動いていない項目も 4 つとも出す** (検算できるように)。 */
  totals: MarginDiffRow[]
  /** 新しい版にしか無い運行。 */
  added: MarginDiffOperationSide[]
  /** 古い版にしか無い運行。 */
  removed: MarginDiffOperationSide[]
  /** 両方にあって動いた運行。 */
  changed: MarginDiffChangedOperation[]
  /** 両方の版にあって**動かなかった**運行の本数。**黙って落とさない** (何本比べたかが分かる)。 */
  unchangedOperations: number
  uncoveredNote: string
  crossMonthNote: string
  codeVersionNote: string
  overrideCaveat: string
}

/**
 * 2 版を突き合わせる。**引数の順は画面が選んだそのまま** — 古い方を `before` に入れ替える
 * ような気を利かせ方はしない (どちらを選んだかは画面が版の名前で出しているので、
 * 勝手に入れ替えると画面の見出しと符号が食い違う)。
 */
export function buildMarginDiff(before: MarginDiffSide, after: MarginDiffSide): MarginDiff {
  const refs = { before: versionRef(before), after: versionRef(after) }
  if (refs.before.schemaVersion !== refs.after.schemaVersion) {
    return {
      ...refs,
      state: 'schema-mismatch',
      blockedNote: marginDiffSchemaMismatchNote(refs.before, refs.after),
      totals: [],
      added: [],
      removed: [],
      changed: [],
      unchangedOperations: 0,
      uncoveredNote: '',
      crossMonthNote: '',
      codeVersionNote: '',
      overrideCaveat: '',
    }
  }

  const beforeTotals = pickMarginVersionTotals(before.snapshot.totals)
  const afterTotals = pickMarginVersionTotals(after.snapshot.totals)
  const totals = diffRows(MARGIN_DIFF_TOTALS_FIELDS, beforeTotals, afterTotals)

  const beforeOps = before.snapshot.cache.operations
  const afterOps = after.snapshot.cache.operations
  // 運行NO は運行の鍵 (`directRowsByUnko` の鍵と同じ) なので、そのまま突き合わせる。
  const beforeByUnko = new Map(beforeOps.map(op => [op.unkoNo, op]))
  const afterByUnko = new Map(afterOps.map(op => [op.unkoNo, op]))

  const added: MarginDiffOperationSide[] = []
  const changed: MarginDiffChangedOperation[] = []
  let unchangedOperations = 0
  // **新しい版の並び順のまま**出す (画面が出している順)。新しい comparator を作らない。
  for (const op of afterOps) {
    const prev = beforeByUnko.get(op.unkoNo)
    if (prev === undefined) {
      added.push(operationSide(op))
      continue
    }
    const rows = changedRows(MARGIN_DIFF_OPERATION_FIELDS, operationValues(prev), operationValues(op))
    const legs = diffLegs(prev.legs, op.legs)
    // 運行の合計が同じでも便の間で動いていることがある (売上が便をまたいで移った等)。
    if (rows.length === 0 && legs.legs.length === 0) {
      unchangedOperations += 1
      continue
    }
    changed.push({
      unkoNo: op.unkoNo,
      date: op.date,
      driverName: op.driverName,
      vehicleCode: op.vehicleCode,
      rows,
      legs,
    })
  }
  const removed = beforeOps.filter(op => !afterByUnko.has(op.unkoNo)).map(operationSide)

  return {
    ...refs,
    state: 'ready',
    blockedNote: '',
    totals,
    added,
    removed,
    changed,
    unchangedOperations,
    uncoveredNote: marginDiffUncoveredNote(before.snapshot.cache.uncovered, after.snapshot.cache.uncovered),
    crossMonthNote: marginDiffCrossMonthNote(before.snapshot.cache.crossMonth, after.snapshot.cache.crossMonth),
    codeVersionNote: marginDiffCodeVersionNote(refs.before, refs.after),
    overrideCaveat: marginDiffOverrideCaveat(marginDiffDisplayDelta('yen', beforeTotals.marginYen, afterTotals.marginYen)),
  }
}
