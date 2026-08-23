/**
 * 釧路営業所 (暫定) 試算の中核 (Refs #760 の 33)。**pure — DOM も fetch も持たない。**
 *
 * オーナー (2026-08-23):「帯広ではなく **釧路に営業所**を開く。とりあえず 釧路市役所
 * 開始終了で暫定にして、給与・手当を検討したい」「**基本、釧路積みの運行で企画する**」。
 *
 * ## この util が答える問い
 *
 * 本番 2026-07 の実測では、**釧路積みの卸地は十勝が主** (上士幌・士幌・帯広川西 …)。
 * だから営業所を釧路へ移すと **出庫回送 (帯広 → 釧路の積地) が消える代わりに、
 * 帰庫回送 (十勝の卸地 → 釧路) が同じだけ増える**可能性が高い。
 * 「釧路積みだから釧路の方が近い」という直感が正しいかを、**回送の入れ替えを数字で
 * 出して**白黒つけるのがこのファイルの目的。
 *
 * ## 推定と実測を混ぜない (`depot-distance.ts` の申し送り)
 *
 * 営業所を差し替えた回送は**帯広側も釧路側も `haversineKm` (直線) の推定**で出す。
 * 実測 (`KmBreakdown.preLoadKm` / `postUnloadKm` = デジタコの区間距離の積算) は
 * **較正用に別フィールド**で持ち回り、`推定 ÷ 実測` の比 (`estimateRatio`) で
 * 「直線がどれだけ短く出るか」を見る。**実測 − 推定 を営業所の差として読まない** —
 * それは営業所の差ではなく測り方の差 (直線は道なりの下限)。
 *
 * ## 混在運行を混ぜない
 *
 * 「釧路積みだけの運行 (`pure`)」と「他の積地と混ざった運行 (`mixed`)」は
 * **必ず分けて出す**。混在運行は釧路営業所へ単純には移せない (釧路以外の積地へ
 * 出庫する便を含む) ので、まとめて集計すると数字が嘘になる。
 *
 * ## 営業所を変えても動かない距離
 *
 * `betweenKm` (便間) と `otherKm` (分類不能) は起終点に依らないので、**実測のまま
 * 持ち回る**。合計 (`measuredDeadheadKm`) が粗利タブの回送km と一致し続けるようにする。
 *
 * ## 魔法の定数を埋めない
 *
 * 回送距離の差を拘束時間に直す平均速度は `deadheadSpeedKmh` で**実測から出す**
 * (`Σ(preLoadKm + postUnloadKm) ÷ Σ((preLoadSec + postUnloadSec)/3600)`)。
 * このファイルに `40km/h` のような定数は置かない — 呼び出し側が実測を渡す。
 *
 * ## 金額は別立て
 *
 * 月の燃料代の総額は給油実績で固定されているので、**回送km が減っても実績の燃料代は
 * 1 円も動かない** (memory `margin-fuel-total-invariant`)。試算の金額が要るときは
 * `deadheadFuelYen`(差km, 燃費, 単価) で**別立て**に出し、`OperationMargin.fuelYen`
 * (実績) と足したり引いたりしない。
 */
import type { OperationIdle } from './allowance-idle'
import { RATE_MASTER } from './allowance-rate-master'
import { DEPOTS, haversineKm } from './depot-distance'
import type { DepotKey, LatLng } from './depot-distance'
import { routePlace } from './margin'
import type { FuelRate, KmBreakdown, LegMargin, OperationMargin } from './margin'

/** 1 時間の秒数。速度の式に生の 3600 を散らさないためだけの定数。 */
export const SECONDS_PER_HOUR = 3600

/**
 * 手当マスタ (`RATE_MASTER`) が釧路の積地に使っている語彙。
 *
 * **実データの住所 (`北海道釧路市西港1-98-41` 等) もこの語彙に落ちる** —
 * `routePlace` (= `cityToPlace(addressToCity(...))`) が 住所 → `釧路市` → `釧路` と
 * 正規化するため。だから**新しい住所パーサは作らない**。
 */
export const KUSHIRO_ORIGIN = '釧路'

/**
 * 釧路積みの業者 (`RATE_MASTER` の `origin === '釧路'` の `loader`、初出順)。
 *
 * **判定には使わない** (判定は `isKushiroOrigin`)。実データの積地の住所 3 種
 * (`北海道釧路市西港1-98-41` / `西港2-101-1` / `西港1`) が**この業者たちの倉庫**である
 * ことを、マスタ側から言えるようにするために出す。
 */
export const KUSHIRO_LOADERS: readonly string[] = [
  ...new Set(RATE_MASTER.filter(row => row.origin === KUSHIRO_ORIGIN).map(row => row.loader)),
]

/** `DEPOTS` のキー一覧。両営業所を**同じ手続きで**回すために 1 か所で持つ。 */
export const DEPOT_KEYS = Object.keys(DEPOTS) as DepotKey[]

/**
 * 積地が釧路か。**マスタの語彙 (`釧路`) と 実データの住所 (`北海道釧路市西港…`) の
 * どちらを渡しても同じ判定**になる (`routePlace` で正規化してから比べる)。
 */
export function isKushiroOrigin(originCity: string): boolean {
  return routePlace(originCity) === KUSHIRO_ORIGIN
}

/** 便 1 本が釧路積みか。 */
export function isKushiroLoadingLeg(leg: Pick<LegMargin, 'originCity'>): boolean {
  return isKushiroOrigin(leg.originCity)
}

/**
 * 運行の分類。
 *
 * - `pure` … **便が 1 本以上あり、全便が釧路積み**。釧路営業所へそのまま移せる運行
 * - `mixed` … 釧路積みの便と他の積地の便が混ざる。**単純には移せない**
 * - `none` … 釧路積みの便が 1 本も無い (便の無い運行もここ)
 */
export type KushiroLoadingKind = 'pure' | 'mixed' | 'none'

/** 合計の粒度。`all` は全運行。 */
export type KushiroTotalsKey = KushiroLoadingKind | 'all'

/**
 * 便 1 本ぶんの入力。**新しい型は作らず `margin.ts` の `LegMargin` の部分型**
 * — `OperationMargin.legs` をそのまま渡せる。
 */
export type KushiroLegInput = Pick<LegMargin, 'seq' | 'originCity' | 'destCity' | 'salesYen' | 'allowanceYen' | 'haulKm' | 'deadheadKm'>

/**
 * 運行 1 本ぶんの入力。**`margin.ts` の `OperationMargin` の部分型 + 座標 2 点**。
 *
 * 座標は `OperationMargin` に無い (粗利は距離しか要らない) ので、呼び出し側が
 * `getGpsForCell` で取って添える。**この util は座標を作らない**。
 */
export interface KushiroOperationInput extends Pick<OperationMargin, 'unkoNo' | 'driverName' | 'kmBreakdown'> {
  legs: readonly KushiroLegInput[]
  /** 最初の積地の実測 GPS。取れなければ `null` (**0 に倒さない**)。 */
  firstLoadPoint?: LatLng | null
  /** 最後の卸地の実測 GPS。取れなければ `null`。 */
  lastUnloadPoint?: LatLng | null
}

/** 平均速度を出すための入力。`allowance-idle.ts` の `OperationIdle` の部分型。 */
export type DeadheadSpeedInput = Pick<OperationIdle, 'preLoadKm' | 'postUnloadKm' | 'preLoadSec' | 'postUnloadSec'>

/** 営業所 1 つぶんの、運行 1 本の回送推定 (直線)。**片方でも欠測なら `totalKm` は null**。 */
export interface DepotDeadheadEstimate {
  /** 出庫回送 = 営業所 → 初回積地 (km)。座標が欠ければ null。 */
  outboundKm: number | null
  /** 帰庫回送 = 最終卸地 → 営業所 (km)。座標が欠ければ null。 */
  inboundKm: number | null
  /** 上 2 つの和。**どちらかが null なら null** (0 に倒さない)。 */
  totalKm: number | null
}

/**
 * 出庫 (または帰庫) の片側ぶんの集計。
 *
 * **`measuredKm` は行に載せた運行ぜんぶ**の実測だが、`comparableMeasuredKm` は
 * **推定が出せた運行だけ**の実測。`推定 ÷ 実測` の比は後者を分母に取る
 * (`estimateRatio`) — 座標が欠けた運行を分母にだけ入れると比が不当に小さく出る。
 */
export interface DepotEstimateSide {
  /** 実測の回送km (`preLoadKm` / `postUnloadKm`)。 */
  measuredKm: number
  /** 推定を出せた運行数。 */
  estimatedOperations: number
  /** 座標が欠けていて推定を出せなかった運行数。**黙って 0km にしない。** */
  missingOperations: number
  /** 推定を出せた運行だけの実測km (較正の分母)。 */
  comparableMeasuredKm: number
  /** 営業所ごとの推定km の合計。**全営業所が同じ運行集合で積まれている。** */
  estimatedKm: Record<DepotKey, number>
}

/**
 * 集計 1 行。**便 単位の列と 運行 単位の列が混ざっている**ので、どちらで数えたかを
 * フィールドごとに把握すること。
 *
 * - 便 単位 … `legs` / `kushiroLegs` / `salesYen` / `allowanceYen` / `haulKm` / `deadheadKm`
 * - 運行 単位 … `operations` / `betweenKm` / `otherKm` / `outbound` / `inbound`
 *
 * 経路の行では、運行 単位の値を **`operations`・`betweenKm`・`otherKm`・`outbound` は
 * 先頭便の経路へ / `inbound` は最終便の経路へ**載せる (`allowance-idle.ts` の
 * `legKmDetail` が `approachKm` / `tailKm` を割り当てるのと同じ規則)。どの列も
 * **全行を足すと運行の合計に戻る**。
 */
export interface KushiroTotals {
  /** 運行数 (経路の行では「先頭便がこの経路だった運行」)。 */
  operations: number
  /** 便数。 */
  legs: number
  /** そのうち釧路積みの便数。 */
  kushiroLegs: number
  salesYen: number
  allowanceYen: number
  /** 売上走行km (便の `haulKm` の和)。 */
  haulKm: number
  /**
   * **便に割り付けられた回送km** (`LegMargin.deadheadKm` = その便へ向かう移動 + 最終便の帰庫)。
   *
   * 運行 単位の `outbound`/`betweenKm`/`inbound`/`otherKm` と**同じ走行を便の側から
   * 数え直したもの**なので、便が揃っている運行では `measuredDeadheadKm` と一致する。
   * **「うち釧路積み」の回送km はこちら** — 混在運行は運行まるごと釧路営業所へ
   * 移せないので、釧路積みの便に割り付いたぶんだけを数えないと過大になる。
   */
  deadheadKm: number
  /** 便間の回送km (実測)。**営業所を変えても動かない。** */
  betweenKm: number
  /** 分類不能の走行km (実測)。**営業所を変えても動かない。** */
  otherKm: number
  /** 出庫回送 (始業 → 最初の積み)。 */
  outbound: DepotEstimateSide
  /** 帰庫回送 (最後の降し → 終業)。 */
  inbound: DepotEstimateSide
}

/** 経路 (積地 → 卸地) 1 本の行。`from` / `to` は `routePlace` の語彙。 */
export interface KushiroRouteRow {
  kind: KushiroLoadingKind
  from: string
  to: string
  totals: KushiroTotals
}

/** 乗務員 1 人の行。 */
export interface KushiroDriverRow {
  kind: KushiroLoadingKind
  driverName: string
  totals: KushiroTotals
}

/** `summarizeKushiroLoading` の返り。 */
export interface KushiroLoadingSummary {
  /** 分類ごとの運行数 (`all` は全運行)。 */
  counts: Record<KushiroTotalsKey, number>
  /** 分類ごとの合計。**`pure + mixed + none === all`** (どの列も)。 */
  totals: Record<KushiroTotalsKey, KushiroTotals>
  /**
   * **釧路積みの便だけ**を束ねた行。便 単位の列は釧路積み便ぶん (= 169 便)、
   * 運行 単位の列は**釧路積みを 1 便でも含む運行** (`pure` + `mixed` = 72 運行) ぶん。
   * オーナーの実測表の「うち釧路積み」列がこの行。
   */
  kushiroOnly: KushiroTotals
  /** 経路の行 (売上の降順、同額は初出順)。 */
  routes: KushiroRouteRow[]
  /** 乗務員の行 (釧路積み便数の降順、同数は初出順)。 */
  drivers: KushiroDriverRow[]
  /**
   * **便が 1 本も無い運行の数。** 経路の行には載せようが無いので別に数える
   * (`margin.ts` の `noLegOperations` と同じ扱い)。この運行の運行 単位の値は
   * `totals` には入るが `routes` には入らない — 経路の行の合計が運行の合計より
   * 小さくなる唯一の理由。
   */
  leglessOperations: number
}

/**
 * 運行 1 本の回送推定 (直線)。**帯広側も釧路側もこの同じ関数で出す** —
 * 片方だけ実測を使うと、営業所の差ではなく測り方の差を見ることになる。
 */
export function estimateDepotDeadhead(
  depot: DepotKey,
  operation: Pick<KushiroOperationInput, 'firstLoadPoint' | 'lastUnloadPoint'>,
): DepotDeadheadEstimate {
  const point = DEPOTS[depot]
  const outboundKm = haversineKm(point, operation.firstLoadPoint)
  const inboundKm = haversineKm(operation.lastUnloadPoint, point)
  return {
    outboundKm,
    inboundKm,
    totalKm: outboundKm === null || inboundKm === null ? null : outboundKm + inboundKm,
  }
}

/**
 * 回送の**実測**平均速度 (km/h) = `Σ(preLoadKm + postUnloadKm) ÷ Σ(秒/3600)`。
 *
 * **時刻が読めない区間は km も秒も数えない** (片方だけ足すと速度が壊れる)。
 * 秒の合計が 0 以下なら `null` — **既定値に落とさない**。
 */
export function deadheadSpeedKmh(idles: readonly DeadheadSpeedInput[]): number | null {
  let km = 0
  let sec = 0
  for (const idle of idles) {
    if (idle.preLoadSec !== null) {
      km += idle.preLoadKm
      sec += idle.preLoadSec
    }
    if (idle.postUnloadSec !== null) {
      km += idle.postUnloadKm
      sec += idle.postUnloadSec
    }
  }
  if (sec <= 0) return null
  return km / (sec / SECONDS_PER_HOUR)
}

/**
 * 回送km を拘束時間 (時間) に直す。**速度は呼び出し側が実測から渡す**
 * (`deadheadSpeedKmh`)。速度が無い / 0 以下なら `null`。
 */
export function deadheadHours(km: number, speedKmh: number | null): number | null {
  if (speedKmh === null || speedKmh <= 0) return null
  return km / speedKmh
}

/**
 * **試算の燃料代** = `差km ÷ 燃費 × 単価`。
 *
 * **実績の燃料代 (`OperationMargin.fuelYen`) と足さない・引かない。** 月の燃料総額は
 * 給油実績で固定されているので、回送km が減っても実績側は 1 円も動かない
 * (memory `margin-fuel-total-invariant`)。これは「もし走らなければ浮いたはずの額」で、
 * 実績とは別の紙に書く数字。燃費・単価が無ければ `null`。
 */
export function deadheadFuelYen(km: number, rate: Pick<FuelRate, 'kmPerLiter' | 'yenPerLiter'>): number | null {
  if (rate.kmPerLiter === null || rate.kmPerLiter <= 0 || rate.yenPerLiter === null) return null
  return (km / rate.kmPerLiter) * rate.yenPerLiter
}

/**
 * `推定 ÷ 実測` の比 (較正)。**1 未満なら直線が実距離より短く出ている**という意味で、
 * この比が営業所どうしの比較でどれだけ効くかを読むための値。
 *
 * 分母は**推定を出せた運行だけ**の実測 (`comparableMeasuredKm`)。0 以下なら `null`。
 */
export function estimateRatio(side: DepotEstimateSide, depot: DepotKey): number | null {
  if (side.comparableMeasuredKm <= 0) return null
  return side.estimatedKm[depot] / side.comparableMeasuredKm
}

/**
 * **運行 単位**の実測回送km = 出庫 + 便間 + 帰庫 + 分類不能 (`KmBreakdown` の
 * `haulKm` 以外の 4 つ)。粗利タブの回送km と同じ数え方。
 *
 * 便 単位の `totals.deadheadKm` と**同じ走行を別の側から数えたもの**で、
 * その行に載せた運行の便が揃っていれば一致する。
 */
export function measuredDeadheadKm(totals: KushiroTotals): number {
  return totals.outbound.measuredKm + totals.betweenKm + totals.inbound.measuredKm + totals.otherKm
}

/** 営業所を `from` → `to` に入れ替えたときの**推定**回送km の差 (プラス = 増える)。 */
export interface DepotShiftDiff {
  outboundKm: number
  inboundKm: number
  /** 出庫 + 帰庫。**`betweenKm` / `otherKm` は動かないので入らない。** */
  totalKm: number
  /** `totalKm` を速度で割った時間 (h)。速度を渡さなければ `null`。 */
  hours: number | null
}

/**
 * 営業所の入れ替えで**推定**回送がどれだけ動くか。
 *
 * **出庫が消えるぶんと帰庫が増えるぶんが打ち消し合う**のがこの案件の焦点なので、
 * 合計だけでなく出庫・帰庫を分けて返す。速度 (`deadheadSpeedKmh` の実測) を渡すと
 * 拘束時間の差も付く。
 */
export function depotShiftDiff(
  totals: KushiroTotals,
  from: DepotKey,
  to: DepotKey,
  speedKmh: number | null = null,
): DepotShiftDiff {
  const outboundKm = totals.outbound.estimatedKm[to] - totals.outbound.estimatedKm[from]
  const inboundKm = totals.inbound.estimatedKm[to] - totals.inbound.estimatedKm[from]
  const totalKm = outboundKm + inboundKm
  return { outboundKm, inboundKm, totalKm, hours: deadheadHours(totalKm, speedKmh) }
}

/** 便の分類。`legs` が空なら `none`。 */
export function classifyKushiroOperation(legs: readonly Pick<KushiroLegInput, 'originCity'>[]): KushiroLoadingKind {
  const kushiro = legs.filter(isKushiroLoadingLeg).length
  if (kushiro === 0) return 'none'
  if (kushiro === legs.length) return 'pure'
  return 'mixed'
}

function mapDepots<T>(pick: (depot: DepotKey) => T): Record<DepotKey, T> {
  return Object.fromEntries(DEPOT_KEYS.map(depot => [depot, pick(depot)])) as Record<DepotKey, T>
}

function emptySide(): DepotEstimateSide {
  return {
    measuredKm: 0,
    estimatedOperations: 0,
    missingOperations: 0,
    comparableMeasuredKm: 0,
    estimatedKm: mapDepots(() => 0),
  }
}

function emptyTotals(): KushiroTotals {
  return {
    operations: 0,
    legs: 0,
    kushiroLegs: 0,
    salesYen: 0,
    allowanceYen: 0,
    haulKm: 0,
    deadheadKm: 0,
    betweenKm: 0,
    otherKm: 0,
    outbound: emptySide(),
    inbound: emptySide(),
  }
}

/** 運行 1 本ぶんの、片側 (出庫 or 帰庫) の実測と推定。 */
interface SideFacts {
  measuredKm: number
  estimatedKm: Record<DepotKey, number | null>
}

function addSide(side: DepotEstimateSide, facts: SideFacts): void {
  side.measuredKm += facts.measuredKm
  // **1 つでも欠測なら、その運行は全営業所ぶん推定に入れない** — 営業所ごとに
  // 母集団が違うと差が営業所の差でなくなる。
  if (DEPOT_KEYS.some(depot => facts.estimatedKm[depot] === null)) {
    side.missingOperations += 1
    return
  }
  side.estimatedOperations += 1
  side.comparableMeasuredKm += facts.measuredKm
  for (const depot of DEPOT_KEYS) side.estimatedKm[depot] += facts.estimatedKm[depot]!
}

function addLeg(totals: KushiroTotals, leg: KushiroLegInput): void {
  totals.legs += 1
  if (isKushiroLoadingLeg(leg)) totals.kushiroLegs += 1
  totals.salesYen += leg.salesYen
  totals.allowanceYen += leg.allowanceYen
  totals.haulKm += leg.haulKm
  totals.deadheadKm += leg.deadheadKm
}

/** 運行 単位の列 (`inbound` を除く) をこの行に載せる。 */
function addOperationHead(totals: KushiroTotals, km: KmBreakdown, outbound: SideFacts): void {
  totals.operations += 1
  totals.betweenKm += km.betweenKm
  totals.otherKm += km.otherKm
  addSide(totals.outbound, outbound)
}

function routeRowOf(
  rows: Map<string, KushiroRouteRow>,
  kind: KushiroLoadingKind,
  leg: KushiroLegInput,
): KushiroRouteRow {
  const from = routePlace(leg.originCity)
  const to = routePlace(leg.destCity)
  const key = `${kind} ${from} ${to}`
  const row = rows.get(key) ?? { kind, from, to, totals: emptyTotals() }
  rows.set(key, row)
  return row
}

function driverRowOf(
  rows: Map<string, KushiroDriverRow>,
  kind: KushiroLoadingKind,
  driverName: string,
): KushiroDriverRow {
  const key = `${kind} ${driverName}`
  const row = rows.get(key) ?? { kind, driverName, totals: emptyTotals() }
  rows.set(key, row)
  return row
}

/**
 * 釧路積みの便・運行を数え、**営業所を差し替えた回送を両営業所ぶん推定して**束ねる。
 *
 * 検算 (どの列も、丸めなし):
 * - `totals.pure + totals.mixed + totals.none === totals.all`
 * - `Σ routes[].totals === totals.all` (**便の無い運行を除く**。`leglessOperations`)
 * - `Σ drivers[].totals === totals.all`
 * - `kushiroOnly.kushiroLegs === kushiroOnly.legs`
 */
export function summarizeKushiroLoading(operations: readonly KushiroOperationInput[]): KushiroLoadingSummary {
  const totals: Record<KushiroTotalsKey, KushiroTotals> = {
    pure: emptyTotals(),
    mixed: emptyTotals(),
    none: emptyTotals(),
    all: emptyTotals(),
  }
  const counts: Record<KushiroTotalsKey, number> = { pure: 0, mixed: 0, none: 0, all: 0 }
  const kushiroOnly = emptyTotals()
  const routeRows = new Map<string, KushiroRouteRow>()
  const driverRows = new Map<string, KushiroDriverRow>()
  let leglessOperations = 0

  for (const operation of operations) {
    const kind = classifyKushiroOperation(operation.legs)
    const km = operation.kmBreakdown
    const outbound: SideFacts = {
      measuredKm: km.preLoadKm,
      estimatedKm: mapDepots(depot => haversineKm(DEPOTS[depot], operation.firstLoadPoint)),
    }
    const inbound: SideFacts = {
      measuredKm: km.postUnloadKm,
      estimatedKm: mapDepots(depot => haversineKm(operation.lastUnloadPoint, DEPOTS[depot])),
    }
    counts[kind] += 1
    counts.all += 1
    const driverRow = driverRowOf(driverRows, kind, operation.driverName)
    for (const target of [totals[kind], totals.all, driverRow.totals]) {
      addOperationHead(target, km, outbound)
      addSide(target.inbound, inbound)
      for (const leg of operation.legs) addLeg(target, leg)
    }
    if (kind !== 'none') {
      addOperationHead(kushiroOnly, km, outbound)
      addSide(kushiroOnly.inbound, inbound)
      for (const leg of operation.legs.filter(isKushiroLoadingLeg)) addLeg(kushiroOnly, leg)
    }

    const first = operation.legs[0]
    // 便が無い運行は経路に結べない。運行 単位の値もどの経路にも載せない。
    if (first === undefined) {
      leglessOperations += 1
      continue
    }
    // 出庫は先頭便の経路、帰庫は最終便の経路 (`legKmDetail` の approach / tail と同じ規則)。
    addOperationHead(routeRowOf(routeRows, kind, first).totals, km, outbound)
    addSide(routeRowOf(routeRows, kind, operation.legs[operation.legs.length - 1]!).totals.inbound, inbound)
    for (const leg of operation.legs) addLeg(routeRowOf(routeRows, kind, leg).totals, leg)
  }

  return {
    counts,
    totals,
    kushiroOnly,
    routes: [...routeRows.values()].sort((a, b) => b.totals.salesYen - a.totals.salesYen),
    drivers: [...driverRows.values()].sort((a, b) => b.totals.kushiroLegs - a.totals.kushiroLegs),
    leglessOperations,
  }
}
