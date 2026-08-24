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
 * `buildOperationMargins(ops, costs, overrides, runCostShareMode)` の**後ろ 2 つは版に
 * 入っていない** — `overrides` (燃費の上書き、`FuelRateMap`) も `runCostShareMode`
 * (運行経費の配分の比) も**集計した端末の localStorage にしか無い**。つまり
 * **保存済みの版から運行 1 本の粗利は厳密に再現できない**ので、再計算すると
 * 「画面が実際に見た `totals.marginYen`」とズレる数字を作りかねない。
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
 * あちらの `schemaVersion` は**リテラル型** (`typeof MARGIN_SUMMARY_SCHEMA_VERSION` = `1`)
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
  before: number
  after: number
  /** `after - before`。 */
  delta: number
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
    delta: after[spec.key] - before[spec.key],
  }))
}

/** 上のうち**動いた行だけ**。運行・便の一覧はこちら (動いていない行を並べると読めない)。 */
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
 * `marginSummaryHashInput` は `totals` をハッシュ対象に含めるのに、`totals` を動かす
 * **燃費の上書き** (`FuelRateMap`) は**その端末の localStorage にしか無い**。つまり
 * 燃費を上書きした端末で集計すると `totals` が動いて**新しい版が生まれる**が、その版には
 * 「燃費を上書きしたせいだ」と読めるものが**何も残っていない**。
 *
 * **この issue では直さない** (根本の解 = 版に入力の指紋を残す は別 PR)。ここは
 * **差分を読む人に断るところまで**。粗利が動いていない回は出さない (常に出すと読み飛ばされる)。
 */
export const MARGIN_DIFF_OVERRIDE_CAVEAT
  = 'この粗利の差は、集計した端末の設定 (燃費の上書き) でも起こりえます — '
    + '燃費の上書きと運行経費の配分は集計した端末にしか無い設定で、版には残っていません。'
    + 'データが 1 円も変わっていないのに版が増えていることがあります。'

export function marginDiffOverrideCaveat(marginDelta: number): string {
  if (marginDelta === 0) return ''
  return MARGIN_DIFF_OVERRIDE_CAVEAT
}

/**
 * **運行 1 本ごとの粗利を出していない**ことを画面で言う。**黙って出さない**と、
 * 「粗利の列が無い = 粗利が動いていない」と読まれる。
 */
export const MARGIN_DIFF_NO_OPERATION_MARGIN_NOTE
  = '運行 1 本ごとの粗利 (経費・燃料代を引いた額) は出していません — 燃費の上書きと運行経費の配分は'
    + '集計した端末にしか無い設定で版に入っていないため、保存済みの版から運行 1 本の粗利は厳密に'
    + '再現できません。ここに出しているのは版に保存された生の入力値 (売上・手当・走行km・便数) だけです。'
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
    overrideCaveat: marginDiffOverrideCaveat(afterTotals.marginYen - beforeTotals.marginYen),
  }
}
