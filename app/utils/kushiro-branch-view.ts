/**
 * 粗利タブ「釧路積み (釧路営業所試算)」区画の**表示用の素材**を作る pure util
 * (Refs #760 の 36)。
 *
 * 計算そのものは `kushiro-doto-rebuild.ts` (双子が `workers/kyuyo-mcp` にあり、
 * 共有 fixture + golden で固定済み) が全部持っている。**ここは「画面が並べる形」に
 * 畳むだけ** — 新しい式を 1 つも作らない。作ってよいのは
 *
 * 1. **既定値の根拠づけ** (便/日 のスライダーの上下限・候補を実測分布から出す)
 * 2. **最低賃金マスタからの額の引き方** (下の「マスタのキーの罠」)
 * 3. **最低賃金を満たす最小の 便/日** (`minWageLegsPerDay`。`breakEvenLegsPerDay` が
 *    営業利益の分岐しか出さないため)
 *
 * の 3 つだけ。`KushiroBranchPanel.vue` は**この util が返した plain object を
 * 並べるだけ**で、コンポーネント側では 1 つも計算しない。
 *
 * ## ★ 最低賃金マスタのキーの罠 (本番実測済み)
 *
 * `MinWageMaster` は**読み書きするキーの流儀が 2 つある**:
 *
 * - **本番 R2 (`restraint/{company}/min-wage/latest.json`) は県名キー**。
 *   2026-08-23 の実測: `prefectures: { 北海道: [{2025-10-04, 1075}], 東京都: [...] }` /
 *   `branchToPrefecture: { 帯広: 北海道, 本社: 東京都 }` / `defaultPrefecture` **無し**。
 * - **フロントの単価マスタタブ (`restraint-wage.vue`) は `'全社共通'` の 1 本しか
 *   読み書きしない** (`MIN_WAGE_DEFAULT_KEY`)。
 *
 * **実在しない釧路営業所は `branchToPrefecture` に載らない** (社員マスタ由来なので当然)
 * ので、営業所名で県を引くと `rate: null` になり比較行が丸ごと消える。
 * ⇒ `resolveKushiroMinWage` は **実在する営業所 (`帯広`) で県を引く** ことから始める。
 * 帯広も釧路も北海道なので、これで両方の比較行に同じ額が載る
 * (kyuyo-mcp 側は「会社既定の県 = 北海道」へフォールバックする実装で、結果は同じ額)。
 * 引けなかったときは **0 に倒さず `null`** のままにして、どのキーを試したかを画面に出す。
 *
 * ## 前提 (感度分析) を定数で持つ理由
 *
 * 人件費 / 燃費 / 単価は `sensitivityGrid` が**引数で受け取る**ので、既定を持つのは
 * 呼び出し側の責務 (`kushiro-doto-rebuild.ts` の JSDoc)。画面の既定は
 * **#760 の 34 で固定した golden と同じ前提**にしてある — 数字が動いたら
 * `tests/fixtures/kushiro-loading/golden/doto-2026-07.json` と食い違うので気付ける。
 * 換算時給の分子 (`monthlyWageYen`) だけは定数ではなく**対象便の手当合計**
 * (= 実データ) を使う。
 *
 * ## この区画の数字は粗利タブの数字に 1 円も効かない
 *
 * 入力は `rebuildInputs` (GPS 付きの便) だけで、`buildOperationMargins` の結果には
 * 触れない。**実在しない営業所の試算**なので、画面には必ずバッジを固定表示する。
 */
import {
  DEFAULT_LEGS_PER_DRIVER_MONTH,
  DEFAULT_RUNS_PER_DRIVER_MONTH,
  breakEvenLegsPerDay,
  hoursOfSeconds,
  matchesDestArea,
  rebuildDeadheadSpeedKmh,
  rebuiltDeadheadKm,
  rebuiltDepotDiffKm,
  sensitivityRow,
  summarizeDotoRebuild,
  type DestArea,
  type LegsPerRunDistribution,
  type RebuildOperationInput,
  type RebuildTotals,
  type SensitivityInput,
  type SensitivityRow,
} from './kushiro-doto-rebuild'
import { DEPOT_KEYS, isKushiroLoadingLeg } from './kushiro-loading-legs'
import type { DepotKey } from './depot-distance'
import { MIN_WAGE_DEFAULT_KEY, type MinWageEntry, type MinWageMaster } from './restraint-wage-view'

// ---------------------------------------------------------------------------
// 前提 (感度分析)
// ---------------------------------------------------------------------------

/** 乗務員 1 名あたりの月間人件費 (円)。#760 の 34 の golden と同じ前提。 */
export const KUSHIRO_MONTHLY_LABOR_COST_YEN = 400000
/** 燃費 (km/L)。同上。 */
export const KUSHIRO_FUEL_KM_PER_LITER = 3
/** 軽油単価 (円/L)。同上。 */
export const KUSHIRO_FUEL_YEN_PER_LITER = 150

/**
 * 最低賃金の県を引くのに使う**実在する営業所**。
 *
 * 釧路営業所は実在しないのでマスタに載らない。帯広も釧路も北海道なので、
 * 帯広で引いた県をそのまま両方に使う (上の「マスタのキーの罠」参照)。
 */
export const KUSHIRO_MIN_WAGE_BRANCH = '帯広'

/** 営業所の見出し。`DepotKey` を増やしたらここも足す (足し忘れは型が落とす)。 */
export const DEPOT_LABELS: Record<DepotKey, string> = {
  obihiro: '帯広発',
  kushiro: '釧路発',
}

// ---------------------------------------------------------------------------
// 表示 (欠測は 0 に倒さず「−」)
// ---------------------------------------------------------------------------

/** 欠測を表す記号。**0 と区別が付く形にする** (要件)。 */
export const DASH = '−'

/**
 * 円。`null` は `DASH`。
 *
 * **`+ 0` は `-0` を潰すためだけ** (Refs #843 / #928)。粗利・営業利益は負になり、
 * `Math.round` は `-0.5 ≤ v < 0` で `-0` を返す。`(-0).toLocaleString()` は `"-0"`
 * なので、素で書くと `¥-0` と出て「0 円」か「符号が化けた」か読めない。
 * **丸め方も符号も変えない** — `-0.6` は `¥-1` のまま。
 *
 * 下の `fmtSignedYen` には要らない。あちらは `Math.abs` を通すので、`-0` も
 * 端数つきの負も符号ごと落ちる (`-0 >= 0` は `true` なので `+¥0`)。
 */
export function fmtYen(v: number | null): string {
  return v === null ? DASH : `¥${(Math.round(v) + 0).toLocaleString('ja-JP')}`
}

/** 符号付きの円 (最低賃金との差)。`null` は `DASH`。 */
export function fmtSignedYen(v: number | null): string {
  return v === null ? DASH : `${v >= 0 ? '+' : '−'}¥${Math.round(Math.abs(v)).toLocaleString('ja-JP')}`
}

/** 小数 `digits` 桁。`null` は `DASH`。 */
export function fmtNum(v: number | null, digits = 1): string {
  if (v === null) return DASH
  const p = 10 ** digits
  return String(Math.round(v * p) / p)
}

/** km (小数 1 桁)。`null` は `DASH`。 */
export function fmtKm(v: number | null): string {
  return v === null ? DASH : `${fmtNum(v, 1)}km`
}

/** 時間 (小数 1 桁)。`null` は `DASH`。 */
export function fmtHours(v: number | null): string {
  return v === null ? DASH : `${fmtNum(v, 1)}h`
}

/**
 * 良し悪しの色分け。**判定はここで済ませ、コンポーネントは `Record` 引きだけにする**
 * — テンプレートに三項を積むと分岐 100% の担保が読みにくくなるため。
 */
export type Tone = 'ok' | 'ng' | 'unknown'

/** 最低賃金の判定。`null` (額が引けない / 拘束が出ない) は `unknown`。 */
export function minWageTone(belowMinWage: boolean | null): Tone {
  if (belowMinWage === null) return 'unknown'
  return belowMinWage ? 'ng' : 'ok'
}

/** 金額の符号。`null` は `unknown`、マイナスは `ng`。 */
export function amountTone(v: number | null): Tone {
  if (v === null) return 'unknown'
  return v < 0 ? 'ng' : 'ok'
}

/** 最低賃金の判定ラベル。 */
export const MIN_WAGE_TONE_LABEL: Record<Tone, string> = {
  ok: 'クリア',
  ng: '割れ',
  unknown: DASH,
}

// ---------------------------------------------------------------------------
// 最低賃金
// ---------------------------------------------------------------------------

/** 額をどのキーから引いたか。 */
export type MinWageKeySource = 'branch' | 'default-prefecture' | 'company-key'

/** `resolveKushiroMinWage` の返り。 */
export interface KushiroMinWage {
  /** 円/h。引けなければ `null` (**0 に倒さない**)。 */
  rate: number | null
  /** 額を引いたマスタのキー。引けなければ `null`。 */
  key: string | null
  /** キーの決まり方。引けなければ `null`。 */
  source: MinWageKeySource | null
  /** その額の発効日。引けなければ `null`。 */
  effectiveFrom: string | null
  /** 試したキー (順番どおり)。引けなかったときの切り分け用に画面へ出す。 */
  triedKeys: string[]
}

/** `effectiveFrom <= anchor` の中で最新の行。無ければ `null`。 */
function entryAt(entries: readonly MinWageEntry[], anchor: string): MinWageEntry | null {
  let best: MinWageEntry | null = null
  for (const e of entries) {
    if (e.effectiveFrom <= anchor && (best === null || e.effectiveFrom > best.effectiveFrom)) best = e
  }
  return best
}

/**
 * 対象月 (`ym` = `YYYY-MM`) に有効な最低賃金を引く。
 *
 * キーは **実在する営業所の県 → マスタの既定県 → フロントの `'全社共通'`** の順に試す。
 * 本番 (県名キー) でもフロントの単価マスタタブで入れた形 (`'全社共通'`) でも引けるようにし、
 * **どのキーで引けたかを返す** — 「額が出ない」ときにマスタ側の問題だと切り分けられるように。
 */
export function resolveKushiroMinWage(master: MinWageMaster | null, ym: string): KushiroMinWage {
  const anchor = `${ym}-01`
  const branchPrefecture = master?.branchToPrefecture?.[KUSHIRO_MIN_WAGE_BRANCH]
  const candidates: Array<{ key: string, source: MinWageKeySource }> = []
  if (branchPrefecture) candidates.push({ key: branchPrefecture, source: 'branch' })
  if (master?.defaultPrefecture) candidates.push({ key: master.defaultPrefecture, source: 'default-prefecture' })
  candidates.push({ key: MIN_WAGE_DEFAULT_KEY, source: 'company-key' })
  const triedKeys = candidates.map(c => c.key)
  for (const c of candidates) {
    const hit = entryAt(master?.prefectures?.[c.key] ?? [], anchor)
    if (hit !== null) {
      return { rate: hit.rate, key: c.key, source: c.source, effectiveFrom: hit.effectiveFrom, triedKeys }
    }
  }
  return { rate: null, key: null, source: null, effectiveFrom: null, triedKeys }
}

/**
 * 最低賃金マスタ (`GET /restraint-api/min-wage`) を引くときの会社ID の探し先。
 *
 * 粗利タブは theearth ログインを持たないので、**拘束時間タブが localStorage に
 * 残した会社ID を借りる**。新しいキーは増やさない (増やすと「どちらが正か」が
 * 分からなくなる)。並びは拘束時間タブと同じ「セッション → 閲覧モードの手入力 →
 * 前回ログイン」。
 */
export const VIEWER_COMP_STORAGE_KEYS = [
  'theearth-session',
  'restraint-viewer-comp',
  'theearth-last-account',
] as const

/** localStorage の 1 件から会社ID を取り出す。JSON でない値はそのものが会社ID。 */
function compIdOf(raw: string): string {
  if (!raw.startsWith('{')) return raw.trim()
  try {
    const parsed = JSON.parse(raw) as { compId?: unknown }
    return typeof parsed.compId === 'string' ? parsed.compId : ''
  }
  catch {
    // 壊れた JSON は次の候補へ (会社ID が読めないだけで画面は動く)
    return ''
  }
}

/** 会社ID を探す。見つからなければ空文字 (**呼び出し側は取得を諦める**)。 */
export function readViewerCompId(storage: Pick<Storage, 'getItem'> | null): string {
  if (storage === null) return ''
  for (const key of VIEWER_COMP_STORAGE_KEYS) {
    const raw = storage.getItem(key)
    if (raw === null || raw === '') continue
    const compId = compIdOf(raw)
    if (compId !== '') return compId
  }
  return ''
}

/**
 * **最低賃金をちょうど満たす 便/日** (これ以上なら上回る)。
 *
 * `breakEvenLegsPerDay` は営業利益の分岐しか出さないので別に置く。
 * 換算時給は `賃金 ÷ (走行時間 + 回送km ÷ 回送平均速度)` で、回送km は
 * `Σ(卸地→積地) + 端 ÷ n` なので **n について解析的に解ける** (グリッド探索より正確):
 *
 * ```
 * 端 ÷ n ≦ (賃金 ÷ 最低賃金 − 走行時間) × 回送平均速度 − Σ(卸地→積地)
 * ```
 *
 * 右辺 (= 回送km の予算) か 端 のどちらかが 0 以下なら `null`
 * — 「どの 便/日 でも満たす」か「どれだけ増やしても満たさない」で、
 * **境界という数字が存在しない**。0 や候補の端に倒さない。
 */
export function minWageLegsPerDay(
  totals: RebuildTotals,
  depot: DepotKey,
  monthlyWageYen: number,
  minWageYen: number | null,
): number | null {
  const speed = rebuildDeadheadSpeedKmh(totals)
  if (speed === null || minWageYen === null || minWageYen <= 0) return null
  const budgetKm = (monthlyWageYen / minWageYen - hoursOfSeconds(totals.haulSec)) * speed - totals.destToLoadKm
  const boundaryKm = totals.depotToLoadKm[depot] + totals.destToDepotKm[depot] - totals.destToLoadKm
  if (!(boundaryKm > 0) || !(budgetKm > 0)) return null
  return boundaryKm / budgetKm
}

// ---------------------------------------------------------------------------
// 便/日 (スライダー・候補) — 既定は実測分布から出す
// ---------------------------------------------------------------------------

/** スライダーの上下限・刻み・実測平均。**すべて実測分布から出す** (決め打ちしない)。 */
export interface LegsPerDaySlider {
  /**
   * つまみの下限 = 実測で観測された最小の「1 運行あたり対象便数」。
   *
   * **観測が 1 件も無いときは 0**。これは測定値ではなく `<input type="range">` の
   * 属性なので、「観測が無い」は `disabled` (と `mean === null`) が持つ。
   * 数字として読ませる値ではない。
   */
  min: number
  /** 同・上限。観測が無ければ 0。 */
  max: number
  /** 実測平均 (`distribution.mean`)。**対象 0 件なら `null`** (0 に倒さない)。 */
  mean: number | null
  /** つまみの刻み。**表示の粒度**であって実測ではないので、ここだけ定数。 */
  step: number
  /** 振れる幅が無い (対象 0 件 / 観測が 1 種類だけ)。画面はつまみを無効にする。 */
  disabled: boolean
}

/** つまみの刻み (便/日)。実測の分布は整数だが、間を見られないと感度が読めない。 */
export const LEGS_PER_DAY_STEP = 0.01

/** スライダーの範囲。観測が 1 種類しか無ければ `min === max` になる (画面側で無効化する)。 */
export function legsPerDaySlider(distribution: LegsPerRunDistribution): LegsPerDaySlider {
  const buckets = distribution.buckets
  const min = buckets[0]?.legsInOperation ?? 0
  const max = buckets[buckets.length - 1]?.legsInOperation ?? 0
  // 観測が 0 件なら `0 >= 0` で、1 種類だけなら `n >= n` で無効になる — 「振れる幅が
  // あるか」だけを見るので、対象 0 件を別扱いする分岐が要らない。
  return { min, max, mean: distribution.mean, step: LEGS_PER_DAY_STEP, disabled: min >= max }
}

/**
 * 感度分析の候補 (便/日)。**実測で観測された値 + 実測平均**を昇順・重複除去で並べる。
 *
 * 2026-07 の実データ (1 便の運行 11 / 2 便 9 / 3 便 3) では `[1, 1.652, 2, 3]` になり、
 * #760 の 34 の golden が並べた 4 点と一致する。**候補を定数で書かない**ための関数。
 */
export function legsPerDayCandidates(distribution: LegsPerRunDistribution): number[] {
  const values = distribution.buckets.map(b => b.legsInOperation)
  if (distribution.mean !== null) values.push(distribution.mean)
  return [...new Set(values)].filter(n => n > 0).sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// 画面が並べる行 (plain object)
// ---------------------------------------------------------------------------

/** 経路 / 乗務員 1 行。**距離だけを持ち、判定はしない。** */
export interface KushiroBreakdownRow {
  /** `v-for` の key。 */
  key: string
  label: string
  legs: number
  salesYen: number
  allowanceYen: number
  haulKm: number
  /** **現状**の回送km (実測)。組み直し後の推定と引き算しないこと。 */
  measuredDeadheadKm: number
  /** 組み直し後の回送km (推定)。営業所ごと。 */
  rebuiltDeadheadKm: Record<DepotKey, number | null>
  /** 帯広発 → 釧路発 の差 (マイナス = 釧路発の方が短い)。 */
  depotDiffKm: number | null
  /** 座標が欠けて推定に入れられなかった便数。 */
  missingLegs: number
  /**
   * そのうち、**卸地を運行終了の位置で代用**した便数 (Refs #760 の 38)。
   * **`missingLegs` とは別物** — 代用した便は推定に入っている。実測の卸地だけの
   * 推定に戻したい読み手のために、混ぜたまま黙らせない。
   */
  substitutedUnloadLegs: number
}

/** 便/日 を 1 点に固定したときの、営業所 1 つぶんの姿 (`SensitivityRow` を平らにしたもの)。 */
export interface KushiroDepotFigures {
  depot: DepotKey
  label: string
  runs: number | null
  requiredDrivers: number | null
  rebuiltDeadheadKm: number | null
  restraintHours: number | null
  restraintHoursPerDriver: number | null
  hourlyYen: number | null
  minWageDiffYen: number | null
  belowMinWage: boolean | null
  fuelYen: number | null
  marginYen: number | null
  laborCostYen: number | null
  operatingMarginYen: number | null
}

/** 便/日 1 点 × 全営業所。 */
export interface KushiroGridRow {
  legsPerDay: number
  /** 実測平均そのものの行か (画面で印を付ける)。 */
  isMean: boolean
  depots: KushiroDepotFigures[]
}

/** 区画の見出しに出す実測の合計。 */
export interface KushiroBranchSummary {
  legs: number
  /** 対象便を含む**元の**運行数。 */
  operations: number
  /** そのうち、対象便だけで閉じている運行 (= 営業所差し替えで動かせる運行)。 */
  pureOperations: number
  /** 対象便と対象外の便が混ざった運行。 */
  mixedOperations: number
  salesYen: number
  allowanceYen: number
  haulKm: number
  measuredDeadheadKm: number
  missingLegs: number
  /**
   * そのうち、**卸地を運行終了の位置で代用**した便数 (Refs #760 の 38)。
   * **`missingLegs` とは別物** — 代用した便は推定に入っている。実測の卸地だけの
   * 推定に戻したい読み手のために、混ぜたまま黙らせない。
   */
  substitutedUnloadLegs: number
  haulSpeedKmh: number | null
  deadheadSpeedKmh: number | null
}

/** 前提 (画面に必ず出す)。 */
export interface KushiroAssumptions {
  monthlyWageYen: number
  monthlyLaborCostYen: number
  kmPerLiter: number
  yenPerLiter: number
  legsPerDriverMonth: number
  runsPerDriverMonth: number
}

/** `buildKushiroBranchView` の返り。**画面はこれを並べるだけ。** */
export interface KushiroBranchView {
  /** 対象便が 1 本も無い (= 区画を出す意味が無い)。 */
  empty: boolean
  summary: KushiroBranchSummary
  distribution: LegsPerRunDistribution
  slider: LegsPerDaySlider
  /** スライダーで選んでいる 便/日 (呼び出し側が渡した値)。 */
  legsPerDay: number
  /** 選んでいる 便/日 での 2 営業所。 */
  selected: KushiroGridRow
  /** 実測分布から作った候補の表 (golden と同じ 4 点になる)。 */
  grid: KushiroGridRow[]
  routes: KushiroBreakdownRow[]
  drivers: KushiroBreakdownRow[]
  minWage: KushiroMinWage
  /** 最低賃金を満たす最小の 便/日 (営業所ごと)。 */
  minWageLegsPerDay: Record<DepotKey, number | null>
  /** 営業利益が 0 以上になる最小の候補 (営業所ごと)。候補の外は測らない。 */
  breakEvenLegsPerDay: Record<DepotKey, number | null>
  assumptions: KushiroAssumptions
}

/** `buildKushiroBranchView` の options。 */
export interface KushiroBranchViewOptions {
  /** 卸地の絞り込み。既定は `summarizeDotoRebuild` の既定 (`doto`)。 */
  area?: DestArea
  /** スライダーで選んだ 便/日。**省略時は実測平均**、それも無ければ `null` 扱い。 */
  legsPerDay?: number | null
  /** 対象月 (`YYYY-MM`)。最低賃金の額を引くのに使う。 */
  ym: string
  /** 最低賃金マスタ (未取得なら `null`)。 */
  minWageMaster: MinWageMaster | null
}

function mapDepots<T>(pick: (depot: DepotKey) => T): Record<DepotKey, T> {
  return Object.fromEntries(DEPOT_KEYS.map(d => [d, pick(d)])) as Record<DepotKey, T>
}

/** 対象便を含む運行を「対象便だけで閉じているか」で数える。 */
function countOperationKinds(
  operations: readonly RebuildOperationInput[],
  area: DestArea,
): { pure: number, mixed: number } {
  let pure = 0
  let mixed = 0
  for (const operation of operations) {
    const target = operation.legs.filter(
      leg => isKushiroLoadingLeg(leg) && matchesDestArea(leg.destCity, area)).length
    if (target === 0) continue
    if (target === operation.legs.length) pure += 1
    else mixed += 1
  }
  return { pure, mixed }
}

function breakdownRow(
  key: string,
  label: string,
  totals: RebuildTotals,
  legsPerDay: number,
): KushiroBreakdownRow {
  return {
    key,
    label,
    legs: totals.legs,
    salesYen: totals.salesYen,
    allowanceYen: totals.allowanceYen,
    haulKm: totals.haulKm,
    measuredDeadheadKm: totals.deadheadKm,
    // 便/日 が 0 以下なら `rebuiltDeadheadKm` 自身が `null` を返す (0 に倒さない) ので、
    // ここで `null` 判定を持たない — 持つと**対象 0 件では行が 1 本も無い**ぶん、
    // 到達しない分岐になる。
    rebuiltDeadheadKm: mapDepots(d => rebuiltDeadheadKm(totals, d, legsPerDay)),
    depotDiffKm: rebuiltDepotDiffKm(totals, 'obihiro', 'kushiro', legsPerDay),
    missingLegs: totals.missingLegs,
    substitutedUnloadLegs: totals.substitutedUnloadLegs,
  }
}

function depotFigures(row: SensitivityRow, depot: DepotKey): KushiroDepotFigures {
  return {
    depot,
    label: DEPOT_LABELS[depot],
    runs: row.runs,
    requiredDrivers: row.requiredDrivers.drivers,
    rebuiltDeadheadKm: row.rebuiltDeadheadKm,
    restraintHours: row.restraint.rebuiltTotalHours,
    restraintHoursPerDriver: row.restraintHoursPerDriver,
    hourlyYen: row.hourlyYen,
    minWageDiffYen: row.minWageDiffYen,
    belowMinWage: row.belowMinWage,
    fuelYen: row.fuelYen,
    marginYen: row.marginYen,
    laborCostYen: row.laborCostYen,
    operatingMarginYen: row.operatingMarginYen,
  }
}

function gridRow(
  totals: RebuildTotals,
  legsPerDay: number,
  mean: number | null,
  input: SensitivityInput,
): KushiroGridRow {
  return {
    legsPerDay,
    isMean: legsPerDay === mean,
    depots: DEPOT_KEYS.map(d => depotFigures(sensitivityRow(totals, d, legsPerDay, input), d)),
  }
}

/**
 * 粗利タブの釧路区画がそのまま描ける形に畳む。
 *
 * **`operations` は `margin.vue` の `rebuildInputs` をそのまま渡す** — 新しく CSV も
 * GPS も読まない。`legsPerDay` を省略すると実測平均 (`distribution.mean`) を使う。
 */
export function buildKushiroBranchView(
  operations: readonly RebuildOperationInput[],
  options: KushiroBranchViewOptions,
): KushiroBranchView {
  const summary = summarizeDotoRebuild(operations, { area: options.area })
  const totals = summary.totals
  const distribution = summary.distribution
  // `summarizeDotoRebuild` の `legsPerRun` は「省略時 = 実測平均」を既に解決済み。
  // スライダーの値はそれを上書きするだけなので、ここで既定を書き直さない。
  // 対象 0 件では実測平均が無い。**0 に倒しても `rebuiltDeadheadKm` が `null` を返す**
  // ので数字が化けることは無く、「対象便なし」の表示は `empty` が担う。
  const legsPerDay = options.legsPerDay ?? distribution.mean ?? 0
  const minWage = resolveKushiroMinWage(options.minWageMaster, options.ym)
  const assumptions: KushiroAssumptions = {
    // 換算時給の分子は**対象便の手当合計** (実データ)。定数ではない。
    monthlyWageYen: totals.allowanceYen,
    monthlyLaborCostYen: KUSHIRO_MONTHLY_LABOR_COST_YEN,
    kmPerLiter: KUSHIRO_FUEL_KM_PER_LITER,
    yenPerLiter: KUSHIRO_FUEL_YEN_PER_LITER,
    legsPerDriverMonth: DEFAULT_LEGS_PER_DRIVER_MONTH,
    runsPerDriverMonth: DEFAULT_RUNS_PER_DRIVER_MONTH,
  }
  const input: SensitivityInput = {
    capacity: {
      legsPerDriverMonth: assumptions.legsPerDriverMonth,
      runsPerDriverMonth: assumptions.runsPerDriverMonth,
    },
    monthlyWageYen: assumptions.monthlyWageYen,
    minWageYen: minWage.rate,
    fuel: { kmPerLiter: assumptions.kmPerLiter, yenPerLiter: assumptions.yenPerLiter },
    monthlyLaborCostYen: assumptions.monthlyLaborCostYen,
  }
  const candidates = legsPerDayCandidates(distribution)
  const kinds = countOperationKinds(operations, summary.area)
  return {
    empty: totals.legs === 0,
    summary: {
      legs: totals.legs,
      operations: distribution.operations,
      pureOperations: kinds.pure,
      mixedOperations: kinds.mixed,
      salesYen: totals.salesYen,
      allowanceYen: totals.allowanceYen,
      haulKm: totals.haulKm,
      measuredDeadheadKm: totals.deadheadKm,
      missingLegs: totals.missingLegs,
      substitutedUnloadLegs: totals.substitutedUnloadLegs,
      haulSpeedKmh: totals.haulSec <= 0 ? null : totals.haulKmTimed / hoursOfSeconds(totals.haulSec),
      deadheadSpeedKmh: rebuildDeadheadSpeedKmh(totals),
    },
    distribution,
    slider: legsPerDaySlider(distribution),
    legsPerDay,
    selected: gridRow(totals, legsPerDay, distribution.mean, input),
    grid: candidates.map(n => gridRow(totals, n, distribution.mean, input)),
    routes: summary.routes.map(r =>
      breakdownRow(`${r.from} ${r.to}`, `${r.from} → ${r.to}`, r.totals, legsPerDay)),
    drivers: summary.drivers.map(d => breakdownRow(d.driverName, d.driverName, d.totals, legsPerDay)),
    minWage,
    minWageLegsPerDay: mapDepots(d => minWageLegsPerDay(totals, d, assumptions.monthlyWageYen, minWage.rate)),
    breakEvenLegsPerDay: mapDepots(d => breakEvenLegsPerDay(totals, d, candidates, input)),
    assumptions,
  }
}
