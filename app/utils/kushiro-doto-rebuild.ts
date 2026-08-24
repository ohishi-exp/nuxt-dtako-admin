/**
 * 釧路積み **かつ 道東卸し**の便を切り出して、**釧路営業所発の運行として組み直す**試算
 * (Refs #760 の 34)。**pure — DOM も fetch も持たない。**
 *
 * オーナー (2026-08-23):「**道東に降ろす便 (標茶・別海、38 便) → 釧路営業所が有利。
 * だけにして**」。#796 (`kushiro-loading-legs.ts`) が数えた「釧路積み」のうち、
 * **卸地が道東のものだけ**が対象になる。釧路積みでも十勝へ降ろす便は帯広のまま。
 *
 * ## なぜ「営業所を差し替える」モデルでは足りないか
 *
 * 本番 2026-07 の実測では、対象 38 便は **23 運行すべてが「道東卸しの便と十勝卸しの便が
 * 混ざった運行」** (`classifyKushiroOperation` で言う `mixed`) で、道東卸しだけで
 * 閉じた運行 (`pure`) は **0 本**。⇒ #796 の `depotShiftDiff` (= 既存の運行の起終点を
 * 差し替える) では 1 便も動かせない。**便を既存の運行から切り出して、釧路営業所発の
 * 新しい運行として組み直す**しかない。
 *
 * ## 組み直しの形 (オーナー提示)
 *
 * ```
 * 釧路市役所 →(空車)→ 釧路西港 (積み) →(積載)→ 道東の卸地 →(空車)→ 釧路市役所
 * ```
 *
 * 1 運行に `legsPerRun` 便を載せるので、2 便目以降は**卸地から積地へ戻る**回送が挟まる:
 *
 * ```
 * 営業所 →積地→ 卸地1 →積地→ 卸地2 … →積地→ 卸地N →営業所
 *  └ 出庫 ┘      └ 便間 ┘     └ 便間 ┘        └ 帰庫 ┘
 * ```
 *
 * ⇒ 対象便 L 本・1 運行あたり N 便 なら **運行数 R = L ÷ N**、回送の推定は
 *
 * ```
 * 回送 = Σ(卸地→積地) − R×平均(卸地→積地) + R×平均(営業所→積地) + R×平均(卸地→営業所)
 *      = Σ(卸地→積地) + ( Σ(営業所→積地) + Σ(卸地→営業所) − Σ(卸地→積地) ) ÷ N
 * ```
 *
 * **`R × 平均` が `Σ ÷ N` に畳めるので、この式は行 (経路別・乗務員別) を足すと必ず
 * 全体に戻る** — 「どの便が運行の最終便になるか」を決め打ちせずに済み、按分も要らない。
 * `N = 1` なら `Σ(営業所→積地) + Σ(卸地→営業所)` (= 1 便 1 運行) に、`N → ∞` なら
 * `Σ(卸地→積地)` (= 積地と卸地を往復し続ける) に落ちる。
 *
 * ## 距離は直線 — 推定と実測を引き算しない (#795 の申し送り)
 *
 * 組み直し後の回送は `haversineKm` の**推定**。実測 (`LegMargin.deadheadKm` の積算) は
 * **較正用に別フィールド**で持ち回る。**営業所どうしの差 (`rebuiltDepotDiffKm`) は
 * 両側とも推定**なので引き算してよいが、**「実測 − 推定」を営業所の差として読まない**
 * — それは測り方の差 (直線は道なりの下限)。橋渡しは `推定 ÷ 実測` の比
 * (`estimateCalibrationRatio`) で見る。
 *
 * ## 1 運行 = 1 日。「1 日に何便まわすか」は**変数**
 *
 * 組み直しは日帰り (営業所を出て営業所へ戻る) なので、**`legsPerRun` は画面・MCP tool が
 * 言う「便/日」と同じ値**。オーナー (2026-08-23):「**1 日何便まわす想定か → これは変数にして**」。
 * ⇒ **想定値を固定しないこと自体が要件**なので、`sensitivityGrid` / `breakEvenLegsPerDay` は
 * **便/日 を引数で受け取るだけの純粋関数**にしてある (既定値をこのファイルに埋めない —
 * 既定を決めるのは呼び出し側 = tool / 画面の責務。画面はここをスライダーにする)。
 *
 * ## 現状の回送 (実測) をそのまま引き算しない
 *
 * 実データの道東卸しは**運行の途中**にあり、降ろした後は必ず十勝へ戻ってきている
 * (#797 の実測: 道東卸し 38 便に対し帰庫は 27km/運行しかない)。⇒ **現状の回送
 * 4,288.9km には十勝への戻りが含まれる**ので、組み直し後の推定との差をそのまま
 * 「削減量」と読んではいけない。この試算は**現状からの差分ではなく、新しい運行を
 * 1 から組んだ姿**。営業所どうしの比較 (`rebuiltDepotDiffKm`) だけが同じ方法どうしの
 * 引き算として成立する。
 *
 * ## 魔法の定数を埋めない
 *
 * `legsPerRun` の既定は**実測の分布から出す** (`legsPerRunDistribution().mean`)。
 * 回送km → 時間 の平均速度も**実測から出す** (`rebuildDeadheadSpeedKmh`)。
 * このファイルが持つ数値定数は `DEFAULT_LEGS_PER_DRIVER_MONTH` (帯広実績、
 * 由来をその JSDoc に書いてある) だけで、それも引数で上書きできる。
 *
 * ## 金額は別立て
 *
 * 回送km が減っても**実績の燃料代は 1 円も動かない** (memory `margin-fuel-total-invariant`)。
 * 差km の金額化は #796 の `deadheadFuelYen`(差km, 燃費, 単価) で**別立て**に出し、
 * `OperationMargin.fuelYen` (実績) と足したり引いたりしない。
 */
import { DEPOTS, haversineKm, isValidLatLng } from './depot-distance'
import type { DepotKey, LatLng } from './depot-distance'
import { DEPOT_KEYS, SECONDS_PER_HOUR, deadheadFuelYen, isKushiroLoadingLeg } from './kushiro-loading-legs'
import type { KushiroLegInput, KushiroOperationInput } from './kushiro-loading-legs'
import { routePlace } from './margin'
// `FuelRate` は `margin.ts` が持つ型。`kushiro-loading-legs.ts` は type-only import
// しているだけで再 export していないので、**宣言元から直接取る**
// (#796 のファイルに re-export を足すより、型の出どころが 1 か所で分かる)。
// 双子 (`workers/kyuyo-mcp/src/kushiro-doto-rebuild.ts`) は worker に `margin.ts` が
// 無いので、双子の `kushiro-loading-legs.ts` が宣言する同名の型を使う。
import type { FuelRate } from './margin'

/**
 * **道東 = 釧路総合振興局 + 根室振興局の全市町村** (`routePlace` の語彙 = 市/町/村 を
 * 落とした形)。実測 2026-07 に出た卸地 (標茶・別海) だけでなく振興局まるごと載せて
 * あるのは、**対象の増減がこの 1 定数の編集で済む**ようにするため (計画の合意事項)。
 *
 * `釧路市` と `釧路町` は `cityToPlace` でどちらも `釧路` に潰れるので 1 要素。
 * **新しい住所パーサは作らない** — 判定は必ず `routePlace` を通す。
 */
export const DOTO_PLACES: readonly string[] = [
  // 釧路総合振興局
  '釧路', '厚岸', '浜中', '標茶', '弟子屈', '鶴居', '白糠',
  // 根室振興局
  '根室', '別海', '中標津', '標津', '羅臼',
]

const DOTO_PLACE_SET = new Set(DOTO_PLACES)

/** `routePlace` の語彙 (`標茶` 等) が道東か。 */
export function isDotoPlace(place: string): boolean {
  return DOTO_PLACE_SET.has(place)
}

/**
 * 卸地が道東か。**マスタの語彙 (`標茶`) と 実データの住所 (`北海道川上郡標茶町多和`) の
 * どちらを渡しても同じ判定**になる (`isKushiroOrigin` と同じ流儀)。
 */
export function isDotoDest(destCity: string): boolean {
  return isDotoPlace(routePlace(destCity))
}

/** 卸地の絞り込み。`doto` = 道東卸しだけ (既定) / `all` = 釧路積みぜんぶ。 */
export const DEST_AREAS = ['doto', 'all'] as const

/** `DEST_AREAS` の要素。 */
export type DestArea = (typeof DEST_AREAS)[number]

/** 既定の絞り込み。オーナー指示は「道東に降ろす便だけ」。 */
export const DEFAULT_DEST_AREA: DestArea = 'doto'

/** 卸地がこの絞り込みに入るか。 */
export function matchesDestArea(destCity: string, area: DestArea): boolean {
  return area === 'all' || isDotoDest(destCity)
}

/**
 * 便 1 本ぶんの入力。**#796 の `KushiroLegInput` に、組み直しに要る 4 つを足しただけ**
 * — 既存の集計 (`summarizeKushiroLoading`) にそのまま渡せる (余分な列は無視される)。
 *
 * 座標は `getGpsForCell` の戻り (度分 → 十進は向こうが済ませている)、秒は
 * `allowance-idle.ts` の `LegKmDetail` から取る。**この util は座標も時刻も作らない。**
 */
export interface RebuildLegInput extends KushiroLegInput {
  /** 積地の実測 GPS。取れなければ `null` (**0 に倒さない**)。 */
  loadPoint?: LatLng | null
  /** 卸地の実測 GPS。取れなければ `null`。 */
  unloadPoint?: LatLng | null
  /**
   * `unloadPoint` が実測の降しではなく、**運行終了の位置で代用**したものか
   * (`margin-rebuild-input.ts` の `substituteOperationEnd`、Refs #760 の 38)。
   *
   * **推定には入れるが、混ぜたまま黙らせない。** 実測 2026-07 の代用 12 本のうち
   * 11 本は運行終了が中継拠点 (音更町駒場) で卸地そのものだが、1 本 (別海便) は
   * 卸地の約 20km 手前で運行が終わっている。`RebuildTotals.substitutedUnloadLegs`
   * が数えるので、読み手が「実測だけの推定」に絞り直せる。
   */
  unloadFromOperationEnd?: boolean
  /** 売上走行の実測秒 (`LegKmDetail.haulSec`)。読めなければ `null`。 */
  haulSec?: number | null
  /**
   * 回送の実測秒。`LegKmDetail` の `approachSec + tailSec`
   * (= `deadheadKm` = `approachKm + tailKm` と同じ区間)。どちらかが読めなければ `null`。
   */
  deadheadSec?: number | null
}

/** 運行 1 本ぶんの入力。**#796 の `KushiroOperationInput` の便を差し替えただけ。** */
export interface RebuildOperationInput extends KushiroOperationInput {
  legs: readonly RebuildLegInput[]
}

/** 切り出した便 1 本。どの運行から出たかを残す (運行数を数えるため)。 */
export interface SelectedLeg {
  unkoNo: string
  driverName: string
  leg: RebuildLegInput
}

/** `selectRebuildLegs` の返り。 */
export interface RebuildSelection {
  /** 対象の便 (入力の順)。 */
  legs: SelectedLeg[]
  /** 対象便を 1 本でも含む**元の**運行の数。 */
  operations: number
  /** 元の運行 1 本あたりの対象便数 (運行の初出順)。分布の材料。 */
  legsPerOperation: number[]
}

/**
 * **積地 = 釧路 かつ 卸地が `area`** の便を切り出す。
 *
 * 積地の判定は #796 の `isKushiroLoadingLeg` をそのまま使う (実住所とマスタ語彙の
 * どちらでも当たる)。**ここで新しい判定を作らない。**
 */
export function selectRebuildLegs(
  operations: readonly RebuildOperationInput[],
  area: DestArea = DEFAULT_DEST_AREA,
): RebuildSelection {
  const legs: SelectedLeg[] = []
  const legsPerOperation: number[] = []
  for (const operation of operations) {
    let count = 0
    for (const leg of operation.legs) {
      if (!isKushiroLoadingLeg(leg)) continue
      if (!matchesDestArea(leg.destCity, area)) continue
      legs.push({ unkoNo: operation.unkoNo, driverName: operation.driverName, leg })
      count += 1
    }
    if (count > 0) legsPerOperation.push(count)
  }
  return { legs, operations: legsPerOperation.length, legsPerOperation }
}

/** 「対象便 `legsInOperation` 本を含む運行が `operations` 本」。 */
export interface LegsPerRunBucket {
  legsInOperation: number
  operations: number
}

/** `legsPerRunDistribution` の返り。**`legsPerRun` の既定はここから決める。** */
export interface LegsPerRunDistribution {
  operations: number
  legs: number
  /** 便数の昇順。 */
  buckets: LegsPerRunBucket[]
  /** 平均 = `legs ÷ operations`。**運行が 0 なら `null`** (1 に倒さない)。 */
  mean: number | null
}

/**
 * 「いまの対象便が、元の運行に何便ずつ乗っているか」の分布。
 *
 * **`legsPerRun` の既定値をここから取る** — 「1 便/日 か 2 便/日 か」を定数で
 * 決め打ちせず、実測の平均をそのまま使うため (計画の合意事項)。
 */
export function legsPerRunDistribution(selection: RebuildSelection): LegsPerRunDistribution {
  const counts = new Map<number, number>()
  for (const n of selection.legsPerOperation) counts.set(n, (counts.get(n) ?? 0) + 1)
  const buckets = [...counts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([legsInOperation, operations]) => ({ legsInOperation, operations }))
  const legs = selection.legs.length
  return {
    operations: selection.operations,
    legs,
    buckets,
    mean: selection.operations === 0 ? null : legs / selection.operations,
  }
}

/**
 * 集計 1 行ぶんの素材。**距離の「和」だけを持ち、割り算 (`÷ legsPerRun`) はしない** —
 * 和のまま持てば行を足して全体に戻せるし、`legsPerRun` を変えて出し直すのも
 * 掛け算 1 回で済む (`rebuiltDeadheadKm`)。
 */
export interface RebuildTotals {
  /** 対象便数。 */
  legs: number
  salesYen: number
  allowanceYen: number
  /** 売上走行km (実測)。**組み直しても荷は同じところへ運ぶので動かない。** */
  haulKm: number
  /** **現状**の回送km (実測、便に割り付いた `LegMargin.deadheadKm`)。 */
  deadheadKm: number
  /** 売上走行の実測秒。**読めない便は km も秒も数えない** (速度が壊れるため)。 */
  haulSec: number
  /** 上の秒が読めた便だけの売上走行km (速度の分子)。 */
  haulKmTimed: number
  /** 回送の実測秒。同上。 */
  deadheadSec: number
  /** 上の秒が読めた便だけの回送km (速度の分子)。 */
  deadheadKmTimed: number
  /** 座標が揃っていて推定を出せた便数。 */
  estimatedLegs: number
  /** 座標が欠けていて推定を出せなかった便数。**黙って 0km にしない。** */
  missingLegs: number
  /**
   * `estimatedLegs` のうち、**卸地を運行終了の位置で代用した**便数
   * (`RebuildLegInput.unloadFromOperationEnd`)。実測の卸地から出した推定と
   * 区別できるようにするためだけの数で、**推定の値そのものには効かない。**
   */
  substitutedUnloadLegs: number
  /** 推定を出せた便だけの実測回送km (較正の分母)。 */
  comparableDeadheadKm: number
  /** Σ(卸地 → 積地) の直線距離。**営業所に依らない** (便間の回送)。 */
  destToLoadKm: number
  /** Σ(営業所 → 積地) の直線距離 (出庫)。 */
  depotToLoadKm: Record<DepotKey, number>
  /** Σ(卸地 → 営業所) の直線距離 (帰庫)。 */
  destToDepotKm: Record<DepotKey, number>
}

function mapDepots<T>(pick: (depot: DepotKey) => T): Record<DepotKey, T> {
  return Object.fromEntries(DEPOT_KEYS.map(depot => [depot, pick(depot)])) as Record<DepotKey, T>
}

/** 空の集計行。 */
export function emptyRebuildTotals(): RebuildTotals {
  return {
    legs: 0,
    salesYen: 0,
    allowanceYen: 0,
    haulKm: 0,
    deadheadKm: 0,
    haulSec: 0,
    haulKmTimed: 0,
    deadheadSec: 0,
    deadheadKmTimed: 0,
    estimatedLegs: 0,
    missingLegs: 0,
    substitutedUnloadLegs: 0,
    comparableDeadheadKm: 0,
    destToLoadKm: 0,
    depotToLoadKm: mapDepots(() => 0),
    destToDepotKm: mapDepots(() => 0),
  }
}

/**
 * 営業所の座標。**既定は `DEPOTS`** だが、正式所在地が決まったときに引数で
 * 差し替えられるようにしてある (`depot_lat` / `depot_lng`)。
 */
export type DepotPoints = Record<DepotKey, LatLng>

/**
 * 便 1 本を集計行に足す。**座標が片方でも欠けたら、その便は全営業所ぶん推定に
 * 入れない** — 営業所ごとに母集団が違うと差が営業所の差でなくなる (#796 `addSide` と同じ)。
 */
export function addRebuildLeg(
  totals: RebuildTotals,
  leg: RebuildLegInput,
  depots: DepotPoints = DEPOTS,
): void {
  totals.legs += 1
  totals.salesYen += leg.salesYen
  totals.allowanceYen += leg.allowanceYen
  totals.haulKm += leg.haulKm
  totals.deadheadKm += leg.deadheadKm
  if (leg.haulSec !== null && leg.haulSec !== undefined) {
    totals.haulSec += leg.haulSec
    totals.haulKmTimed += leg.haulKm
  }
  if (leg.deadheadSec !== null && leg.deadheadSec !== undefined) {
    totals.deadheadSec += leg.deadheadSec
    totals.deadheadKmTimed += leg.deadheadKm
  }
  if (!isValidLatLng(leg.loadPoint) || !isValidLatLng(leg.unloadPoint)) {
    totals.missingLegs += 1
    return
  }
  totals.estimatedLegs += 1
  // **推定に入った便だけ数える** — 欠測のまま外した便を「代用した」と数えると、
  // 代用の本数が推定の母集団と合わなくなる。
  if (leg.unloadFromOperationEnd === true) totals.substitutedUnloadLegs += 1
  totals.comparableDeadheadKm += leg.deadheadKm
  totals.destToLoadKm += haversineKm(leg.unloadPoint, leg.loadPoint)!
  for (const depot of DEPOT_KEYS) {
    totals.depotToLoadKm[depot] += haversineKm(depots[depot], leg.loadPoint)!
    totals.destToDepotKm[depot] += haversineKm(leg.unloadPoint, depots[depot])!
  }
}

/**
 * 組み直し後の**運行数** = 推定を出せた便数 ÷ `legsPerRun`。
 *
 * **推定を出せた便だけで数える** — 座標の欠けた便を運行数にだけ入れると、
 * 回送 (推定) と運行数の母集団が食い違う。`legsPerRun` が正でなければ `null`。
 */
export function rebuiltRuns(totals: RebuildTotals, legsPerRun: number): number | null {
  if (!(legsPerRun > 0)) return null
  return totals.estimatedLegs / legsPerRun
}

/**
 * 組み直し後の回送km (**推定**、直線)。式は冒頭の JSDoc のとおり:
 *
 * ```
 * Σ(卸地→積地) + ( Σ(営業所→積地) + Σ(卸地→営業所) − Σ(卸地→積地) ) ÷ legsPerRun
 * ```
 *
 * `legsPerRun` が正でなければ `null` (**0 に倒さない**)。
 */
export function rebuiltDeadheadKm(
  totals: RebuildTotals,
  depot: DepotKey,
  legsPerRun: number,
): number | null {
  if (!(legsPerRun > 0)) return null
  const boundary = totals.depotToLoadKm[depot] + totals.destToDepotKm[depot] - totals.destToLoadKm
  return totals.destToLoadKm + boundary / legsPerRun
}

/**
 * 営業所を `from` → `to` に替えたときの、組み直し後の回送km の差 (プラス = 増える)。
 *
 * **両側とも同じ式の推定**なので引き算してよい (#795 の申し送りを満たす)。
 * `Σ(卸地→積地)` は営業所に依らないので消え、**運行の端だけが効く**。
 */
export function rebuiltDepotDiffKm(
  totals: RebuildTotals,
  from: DepotKey,
  to: DepotKey,
  legsPerRun: number,
): number | null {
  // `rebuiltDeadheadKm` が null になる条件は `legsPerRun` だけ (営業所には依らない)。
  // 先にここで弾くと「片方だけ null」という到達しない分岐を作らずに済む。
  if (!(legsPerRun > 0)) return null
  return rebuiltDeadheadKm(totals, to, legsPerRun)! - rebuiltDeadheadKm(totals, from, legsPerRun)!
}

/**
 * `推定 ÷ 実測` の比 (較正)。**1 未満なら直線が実距離より短く出ている**。
 *
 * 分母は**推定を出せた便だけ**の実測回送km。0 以下なら `null`。
 * **この比は「現状の便の並び」に対するものではない** — 分子は組み直し後の推定なので、
 * 「組み直しで回送がどれだけ変わるか」と「直線がどれだけ短いか」が混ざる。
 * 直線の短さだけを見たいなら #796 の `estimateRatio` を使うこと。
 */
export function estimateCalibrationRatio(
  totals: RebuildTotals,
  depot: DepotKey,
  legsPerRun: number,
): number | null {
  if (totals.comparableDeadheadKm <= 0) return null
  const km = rebuiltDeadheadKm(totals, depot, legsPerRun)
  return km === null ? null : km / totals.comparableDeadheadKm
}

/** 実測の売上走行の平均速度 (km/h)。秒が 0 以下なら `null` (**既定値に落とさない**)。 */
export function haulSpeedKmh(totals: RebuildTotals): number | null {
  if (totals.haulSec <= 0) return null
  return totals.haulKmTimed / (totals.haulSec / SECONDS_PER_HOUR)
}

/** 実測の回送の平均速度 (km/h)。同上。**組み直し後の回送時間はこれで割って出す。** */
export function rebuildDeadheadSpeedKmh(totals: RebuildTotals): number | null {
  if (totals.deadheadSec <= 0) return null
  return totals.deadheadKmTimed / (totals.deadheadSec / SECONDS_PER_HOUR)
}

/** 秒 → 時間。**読めなかった便の秒は `addRebuildLeg` が足していない**ので、ここは素直に割る。 */
export function hoursOfSeconds(sec: number): number {
  return sec / SECONDS_PER_HOUR
}

/**
 * 拘束時間の内訳 (時間)。
 *
 * **`走行 + 回送` しか入っていない** — 積込・荷降ろしの待機時間は入力 (`LegKmDetail`) に
 * 無いので数えられない。⇒ ここで出る拘束は**下限**であり、拘束で割って出す換算時給は
 * **上限**になる。「この上限でも最低賃金を割っているなら、確実に割っている」という
 * 向きで読むこと。**欠測を 0 に倒しているのではなく、そもそも材料が無い**ので、
 * 呼び出し側は `restraintIsLowerBound` を必ず人に見せること。
 */
export interface RestraintHours {
  /** 実測の売上走行時間。 */
  haulHours: number
  /** 実測の回送時間。 */
  measuredDeadheadHours: number
  /** 実測の拘束 (= 上 2 つの和)。 */
  measuredTotalHours: number
  /** 組み直し後の回送時間 = 推定回送km ÷ 実測の回送平均速度。速度が無ければ `null`。 */
  rebuiltDeadheadHours: number | null
  /** 組み直し後の拘束 (= 走行 + 上)。`rebuiltDeadheadHours` が `null` なら `null`。 */
  rebuiltTotalHours: number | null
  /** **常に `true`** — 荷役・待機を含まない下限であることを明示するための旗。 */
  restraintIsLowerBound: true
}

/** 拘束時間の内訳を出す。 */
export function restraintHours(
  totals: RebuildTotals,
  depot: DepotKey,
  legsPerRun: number,
): RestraintHours {
  const haulHours = hoursOfSeconds(totals.haulSec)
  const measuredDeadheadHours = hoursOfSeconds(totals.deadheadSec)
  const speed = rebuildDeadheadSpeedKmh(totals)
  const km = rebuiltDeadheadKm(totals, depot, legsPerRun)
  const rebuiltDeadheadHours = speed === null || km === null ? null : km / speed
  return {
    haulHours,
    measuredDeadheadHours,
    measuredTotalHours: haulHours + measuredDeadheadHours,
    rebuiltDeadheadHours,
    rebuiltTotalHours: rebuiltDeadheadHours === null ? null : haulHours + rebuiltDeadheadHours,
    restraintIsLowerBound: true,
  }
}

/**
 * 乗務員 1 人が 1 か月に回す便数の既定 = **57**。
 *
 * 由来は帯広の実績 (オーナー報告 2026-08-23): **全体 284 便 ÷ 5 名 = 56.8 → 57**。
 * **推測値ではなく実測の商**だが、月や積み方で動くので `get_kushiro_branch_estimate` の
 * 引数で上書きできる。ここ以外にこの数字を書かないこと。
 */
export const DEFAULT_LEGS_PER_DRIVER_MONTH = 57

/**
 * 必要乗務員数の目安 = `対象便数 ÷ 1 名あたり月間便数` の**切り上げ**。
 * 分母が正でなければ `null`。
 */
export function requiredDrivers(legs: number, legsPerDriverMonth: number): number | null {
  if (!(legsPerDriverMonth > 0)) return null
  return Math.ceil(legs / legsPerDriverMonth)
}

/** 換算時給 = 賃金 ÷ 拘束時間。時間が無い / 0 以下なら `null` (**0 除算を出さない**)。 */
export function hourlyWageYen(wageYen: number, hours: number | null): number | null {
  if (hours === null || hours <= 0) return null
  return wageYen / hours
}

/** 経路 (積地 → 卸地) 1 本の行。`from` / `to` は `routePlace` の語彙。 */
export interface RebuildRouteRow {
  from: string
  to: string
  /** 卸地が道東か。`dest_area: 'all'` のとき、道東ぶんだけを拾い直せるように出す。 */
  doto: boolean
  totals: RebuildTotals
}

/** 乗務員 1 人の行。 */
export interface RebuildDriverRow {
  driverName: string
  totals: RebuildTotals
}

/** `summarizeDotoRebuild` の options。 */
export interface DotoRebuildOptions {
  /** 卸地の絞り込み。既定 `doto`。 */
  area?: DestArea
  /** 1 運行あたりの便数。**省略時は実測の分布の平均** (`distribution.mean`)。 */
  legsPerRun?: number
  /** 営業所の座標。省略時は `DEPOTS`。 */
  depots?: DepotPoints
}

/** `summarizeDotoRebuild` の返り。 */
export interface DotoRebuildSummary {
  area: DestArea
  /** 実際に使った 1 運行あたり便数 (`options.legsPerRun` ?? 実測平均)。対象 0 件なら `null`。 */
  legsPerRun: number | null
  /** 実測の分布 (既定値の根拠)。 */
  distribution: LegsPerRunDistribution
  /** 全体の合計。 */
  totals: RebuildTotals
  /** 経路の行 (便数の降順 → 売上の降順 → 初出順)。**足すと `totals` に戻る。** */
  routes: RebuildRouteRow[]
  /** 乗務員の行 (便数の降順 → 売上の降順 → 初出順)。**足すと `totals` に戻る。** */
  drivers: RebuildDriverRow[]
}

function rowKeyOrder<T extends { totals: RebuildTotals }>(rows: T[]): T[] {
  // Map の挿入順 (= 初出順) が安定ソートの tie-break になる。
  return rows.sort((a, b) =>
    b.totals.legs - a.totals.legs || b.totals.salesYen - a.totals.salesYen)
}

/**
 * 道東卸しの便を切り出して、経路別・乗務員別・全体に束ねる。
 *
 * 検算 (どの列も、丸めなし):
 * - `Σ routes[].totals === totals`
 * - `Σ drivers[].totals === totals`
 * - `totals.legs === distribution.legs`
 * - `Σ rebuiltDeadheadKm(routes[i].totals, d, N) === rebuiltDeadheadKm(totals, d, N)`
 *   (式が `Σ ÷ N` に畳めるので、行の推定を足すと全体の推定に戻る)
 */
export function summarizeDotoRebuild(
  operations: readonly RebuildOperationInput[],
  options: DotoRebuildOptions = {},
): DotoRebuildSummary {
  const area = options.area ?? DEFAULT_DEST_AREA
  const depots = options.depots ?? DEPOTS
  const selection = selectRebuildLegs(operations, area)
  const distribution = legsPerRunDistribution(selection)
  const totals = emptyRebuildTotals()
  const routeRows = new Map<string, RebuildRouteRow>()
  const driverRows = new Map<string, RebuildDriverRow>()

  for (const { driverName, leg } of selection.legs) {
    const from = routePlace(leg.originCity)
    const to = routePlace(leg.destCity)
    const routeKey = `${from} ${to}`
    const routeRow = routeRows.get(routeKey)
      ?? { from, to, doto: isDotoPlace(to), totals: emptyRebuildTotals() }
    routeRows.set(routeKey, routeRow)
    const driverRow = driverRows.get(driverName) ?? { driverName, totals: emptyRebuildTotals() }
    driverRows.set(driverName, driverRow)
    for (const target of [totals, routeRow.totals, driverRow.totals]) {
      addRebuildLeg(target, leg, depots)
    }
  }

  return {
    area,
    legsPerRun: options.legsPerRun ?? distribution.mean,
    distribution,
    totals,
    routes: rowKeyOrder([...routeRows.values()]),
    drivers: rowKeyOrder([...driverRows.values()]),
  }
}

// --- 「1 日に何便まわすか」を振る (感度分析) ---------------------------------

/**
 * 乗務員 1 名が 1 か月に回せる**運行数 (= 日数)** の既定 = **91 ÷ 5 = 18.2**。
 *
 * 由来は帯広の実績 (`tests/fixtures/kushiro-loading/operations-2026-07.json` の
 * 2026-07 実測): **運行 91 本 ÷ 乗務員 5 名**。`DEFAULT_LEGS_PER_DRIVER_MONTH`
 * (便の量の上限) と**両方**が要る — 便/日 を増やすと同じ便数でも運行数が減るので、
 * 便だけで数えると必要乗務員数が便/日 に反応しない。
 */
export const DEFAULT_RUNS_PER_DRIVER_MONTH = 91 / 5

/** 乗務員 1 名の月間キャパ。**どちらも呼び出し側が渡す** (このファイルに既定は無い)。 */
export interface DriverCapacity {
  /** 便の量の上限 (便/名/月)。 */
  legsPerDriverMonth: number
  /** 運行 (日) の量の上限 (運行/名/月)。 */
  runsPerDriverMonth: number
}

/** 必要乗務員数の内訳。**便の量と 日数 の両方で要る人数を出し、多い方を採る。** */
export interface RequiredDriverBreakdown {
  /** 便の量から (`便数 ÷ 便/名/月` の切り上げ)。 */
  byLegs: number | null
  /** 日数から (`運行数 ÷ 運行/名/月` の切り上げ)。便/日 が効くのはこちら。 */
  byRuns: number | null
  /** 実際に要る人数 = 上 2 つの大きい方。両方 null なら null。 */
  drivers: number | null
}

/**
 * 組み直し後の**運行数 (= 稼働日数)** = 対象便数 ÷ 1 日あたり便数。
 *
 * `rebuiltRuns` (推定を出せた便で数える) とは**母集団が違う** — こちらは人繰りの話なので
 * **座標が欠けた便も運ぶ**。便/日 が正でなければ `null`。
 */
export function runsForLegsPerDay(legs: number, legsPerDay: number): number | null {
  if (!(legsPerDay > 0)) return null
  return legs / legsPerDay
}

/** 必要乗務員数を 便の量と 日数の両方から出す。 */
export function requiredDriversFor(
  totals: RebuildTotals,
  legsPerDay: number,
  capacity: DriverCapacity,
): RequiredDriverBreakdown {
  const byLegs = requiredDrivers(totals.legs, capacity.legsPerDriverMonth)
  const runs = runsForLegsPerDay(totals.legs, legsPerDay)
  const byRuns = runs === null || !(capacity.runsPerDriverMonth > 0)
    ? null
    : Math.ceil(runs / capacity.runsPerDriverMonth)
  if (byLegs === null) return { byLegs, byRuns, drivers: byRuns }
  if (byRuns === null) return { byLegs, byRuns, drivers: byLegs }
  return { byLegs, byRuns, drivers: Math.max(byLegs, byRuns) }
}

/** 感度分析 1 行を出すために呼び出し側が渡す前提。**既定はここに置かない。** */
export interface SensitivityInput {
  capacity: DriverCapacity
  /** 想定の月間賃金 (対象便ぜんぶの総額)。 */
  monthlyWageYen: number
  /** 比較する最低賃金 (円/h)。引けなければ `null` (**0 で埋めない**)。 */
  minWageYen: number | null
  /** 燃費・単価。片方でも無ければ燃料と粗利は `null`。 */
  fuel: Pick<FuelRate, 'kmPerLiter' | 'yenPerLiter'>
  /** 乗務員 1 名あたりの月間人件費。無ければ営業利益は `null` (**推測で埋めない**)。 */
  monthlyLaborCostYen: number | null
}

/** 便/日 を 1 点固定したときの姿。 */
export interface SensitivityRow {
  /** この行の 便/日。 */
  legsPerDay: number
  /** 組み直し後の運行数 (= 稼働日数)。 */
  runs: number | null
  requiredDrivers: RequiredDriverBreakdown
  /** 組み直し後の回送km (推定)。 */
  rebuiltDeadheadKm: number | null
  /** 拘束時間 (走行 + 回送 の**下限**)。 */
  restraint: RestraintHours
  /** 1 名あたりの月間拘束時間。 */
  restraintHoursPerDriver: number | null
  /** 換算時給 = 想定賃金 ÷ 拘束。**拘束が下限なので上限。** */
  hourlyYen: number | null
  /** 最低賃金との差 (円/h)。プラスなら上回る。 */
  minWageDiffYen: number | null
  /** 最低賃金を割るか。額が引けなければ `null` (**false に倒さない**)。 */
  belowMinWage: boolean | null
  /** 燃料代 (売上走行 + 組み直し回送) の**試算**。実績の燃料代とは別の紙。 */
  fuelYen: number | null
  /** 粗利 = 売上 − 手当 − 燃料 (試算)。 */
  marginYen: number | null
  /** 人件費 = 1 名あたり × 必要乗務員数。 */
  laborCostYen: number | null
  /** 営業利益 = 粗利 − 人件費。**これが 0 以上になる最小の 便/日 が損益分岐。** */
  operatingMarginYen: number | null
}

/**
 * 便/日 を 1 点に固定したときの姿を出す。**便/日 は引数で、既定は無い。**
 *
 * 便数を変えたときに**何が動いて何が動かないか**:
 * - 動かない … 売上 / 手当 (便あたり定額なので便数に比例するだけ) / 売上走行km / 走行時間
 * - 動く … 組み直し後の回送km (便/日 が増えるほど運行の端が減る) → 回送時間 → 拘束 →
 *   換算時給 / 燃料代 / 稼働日数 → 必要乗務員数 → 人件費
 */
export function sensitivityRow(
  totals: RebuildTotals,
  depot: DepotKey,
  legsPerDay: number,
  input: SensitivityInput,
): SensitivityRow {
  const restraint = restraintHours(totals, depot, legsPerDay)
  const need = requiredDriversFor(totals, legsPerDay, input.capacity)
  const km = rebuiltDeadheadKm(totals, depot, legsPerDay)
  const total = restraint.rebuiltTotalHours
  // **`total` が出ている時点で対象便が 1 本以上ある**ので `drivers` は 1 以上
  // (便が 0 なら回送の実測秒が無く、速度が出ず `rebuiltTotalHours` が null になる)。
  // ⇒ ここで `drivers > 0` を足すと到達しない分岐が増えるだけなので置かない。
  const hoursPerDriver = total === null || need.drivers === null ? null : total / need.drivers
  const hourlyYen = hourlyWageYen(input.monthlyWageYen, total)
  // 燃料は 売上走行 + 組み直し回送 の両方。式は #796 と同じ (km ÷ 燃費 × 単価)。
  const fuelYen = km === null ? null : deadheadFuelYen(totals.haulKm + km, input.fuel)
  const marginYen = fuelYen === null ? null : totals.salesYen - totals.allowanceYen - fuelYen
  const laborCostYen = input.monthlyLaborCostYen === null || need.drivers === null
    ? null
    : input.monthlyLaborCostYen * need.drivers
  return {
    legsPerDay,
    runs: runsForLegsPerDay(totals.legs, legsPerDay),
    requiredDrivers: need,
    rebuiltDeadheadKm: km,
    restraint,
    restraintHoursPerDriver: hoursPerDriver,
    hourlyYen,
    minWageDiffYen: hourlyYen === null || input.minWageYen === null ? null : hourlyYen - input.minWageYen,
    belowMinWage: hourlyYen === null || input.minWageYen === null ? null : hourlyYen < input.minWageYen,
    fuelYen,
    marginYen,
    laborCostYen,
    operatingMarginYen: marginYen === null || laborCostYen === null ? null : marginYen - laborCostYen,
  }
}

/**
 * 便/日 の候補を並べた表。**候補は呼び出し側が渡す** (このファイルに既定のグリッドは無い)。
 * 昇順・重複除去してから回すので、実測平均を混ぜてもそのまま渡せる。
 */
export function sensitivityGrid(
  totals: RebuildTotals,
  depot: DepotKey,
  candidates: readonly number[],
  input: SensitivityInput,
): SensitivityRow[] {
  const uniq = [...new Set(candidates)].filter(n => n > 0).sort((a, b) => a - b)
  return uniq.map(n => sensitivityRow(totals, depot, n, input))
}

/**
 * **1 名分の人件費を賄える最小の 便/日** = `営業利益 ≥ 0` になる最小の候補。
 *
 * 候補の中に無ければ `null` (**外挿しない** — 候補の外は測っていない)。人件費・燃費・単価が
 * 無ければ営業利益が出ないので `null` になる。
 */
export function breakEvenLegsPerDay(
  totals: RebuildTotals,
  depot: DepotKey,
  candidates: readonly number[],
  input: SensitivityInput,
): number | null {
  for (const row of sensitivityGrid(totals, depot, candidates, input)) {
    if (row.operatingMarginYen !== null && row.operatingMarginYen >= 0) return row.legsPerDay
  }
  return null
}
