/**
 * 釧路営業所 (暫定) 試算の中核。**`app/utils/kushiro-loading-legs.ts`
 * (Refs #760 の 33、#796) の双子** — ロジックは 1 行も変えていない。移植の理由は
 * `route-place.ts` の冒頭と同じ (worker から app 側は import できない、Refs #268)。
 * **変更する時は両方に反映すること。**
 *
 * 移植で変わったのは 3 点だけ (どれも入出力の値には影響しない):
 *
 * 1. `routePlace` を `./route-place` (双子) から取る
 * 2. 入力型を `margin.ts` / `allowance-idle.ts` の部分型として書けないので、
 *    **同じ形の interface をこのファイルで宣言**する
 * 3. `KUSHIRO_LOADERS` は app 側が `RATE_MASTER` (画面側の生成物) から導出している。
 *    worker からマスタを読めないので**結果を literal で持ち**、共有 golden
 *    (`tests/fixtures/kushiro-loading/golden/doto-2026-07.json` の `kushiroLoaders`)
 *    で両側を突き合わせる — マスタが動けば両側とも落ちる
 *
 * **経路ごとに符号が反転する。** 標茶・別海 (道東) で降ろす運行は釧路の方が近く、
 * 上士幌・帯広川西・士幌 (十勝) で降ろす運行は帰庫が遠くなる。合計だけ見ると反転が
 * 消えるので、**経路 (積地 → 卸地) 単位でも差を出せる形**にしてある
 * (`depotShiftDiff` に `routes[].totals` を渡す)。
 *
 * 「うち釧路積み」の回送km は**便に割り付けたぶん** (`KushiroTotals.deadheadKm`) で
 * 数える。混在運行を丸ごと数えると、士幌積み便の回送まで釧路営業所の効果に入ってしまう。
 *
 * ## 推定と実測を混ぜない
 *
 * 営業所を差し替えた回送は**帯広側も釧路側も `haversineKm` (直線) の推定**で出す。
 * 実測は較正用に別フィールドで持ち回り、`推定 ÷ 実測` の比 (`estimateRatio`) で
 * 「直線がどれだけ短く出るか」を見る。**実測 − 推定 を営業所の差として読まない。**
 */
import { DEPOTS, haversineKm } from "./depot-distance";
import type { DepotKey, LatLng } from "./depot-distance";
import { routePlace } from "./route-place";

/** 1 時間の秒数。 */
export const SECONDS_PER_HOUR = 3600;

/**
 * 手当マスタ (`RATE_MASTER`) が釧路の積地に使っている語彙。
 * 実データの住所 (`北海道釧路市西港1-98-41` 等) も `routePlace` でこの語彙に落ちる。
 * **新しい住所パーサは作らない。**
 */
export const KUSHIRO_ORIGIN = "釧路";

/**
 * 釧路積みの業者 (`RATE_MASTER` の `origin === '釧路'` の `loader`、初出順)。
 *
 * **判定には使わない** (判定は `isKushiroOrigin`)。app 側はマスタから導出しているが、
 * worker はマスタを読めないので literal。**共有 golden で app 側の導出結果と突き合わせる。**
 */
export const KUSHIRO_LOADERS: readonly string[] = ["中部飼料", "釧路飼料", "道東飼料", "中部飼料(株)"];

/** `DEPOTS` のキー一覧。両営業所を**同じ手続きで**回すために 1 か所で持つ。 */
export const DEPOT_KEYS = Object.keys(DEPOTS) as DepotKey[];

/** 運行の km 内訳 (`app/utils/margin.ts` の `KmBreakdown` と同じ形)。 */
export interface KmBreakdown {
  /** 始業 → 最初の積み。 */
  preLoadKm: number;
  /** 積み → その便の最後の降し = **売上が立つ走行**。 */
  haulKm: number;
  /** 降し → 次の積み (便間の回送)。 */
  betweenKm: number;
  /** 最後の降し → 終業。 */
  postUnloadKm: number;
  /** 分類不能。 */
  otherKm: number;
}

/** 燃費・単価 (`app/utils/margin.ts` の `FuelRate` の部分型)。 */
export interface FuelRate {
  kmPerLiter: number | null;
  yenPerLiter: number | null;
}

/**
 * 便 1 本ぶんの入力 (`app/utils/margin.ts` の `LegMargin` の部分型と同じ形)。
 */
export interface KushiroLegInput {
  seq: number;
  originCity: string;
  destCity: string;
  salesYen: number;
  allowanceYen: number;
  haulKm: number;
  /** その便へ向かう移動 + 最終便の帰庫。 */
  deadheadKm: number;
}

/** 運行 1 本ぶんの入力 (`OperationMargin` の部分型 + 座標 2 点)。 */
export interface KushiroOperationInput {
  unkoNo: string;
  driverName: string;
  kmBreakdown: KmBreakdown;
  legs: readonly KushiroLegInput[];
  /** 最初の積地の実測 GPS。取れなければ `null` (**0 に倒さない**)。 */
  firstLoadPoint?: LatLng | null;
  /** 最後の卸地の実測 GPS。取れなければ `null`。 */
  lastUnloadPoint?: LatLng | null;
}

/** 平均速度を出すための入力 (`allowance-idle.ts` の `OperationIdle` の部分型)。 */
export interface DeadheadSpeedInput {
  preLoadKm: number;
  postUnloadKm: number;
  preLoadSec: number | null;
  postUnloadSec: number | null;
}

/**
 * 積地が釧路か。**マスタの語彙 (`釧路`) と 実データの住所 (`北海道釧路市西港…`) の
 * どちらを渡しても同じ判定**になる。
 */
export function isKushiroOrigin(originCity: string): boolean {
  return routePlace(originCity) === KUSHIRO_ORIGIN;
}

/** 便 1 本が釧路積みか。 */
export function isKushiroLoadingLeg(leg: Pick<KushiroLegInput, "originCity">): boolean {
  return isKushiroOrigin(leg.originCity);
}

/**
 * 運行の分類。
 * - `pure` … 便が 1 本以上あり、全便が釧路積み
 * - `mixed` … 釧路積みの便と他の積地の便が混ざる
 * - `none` … 釧路積みの便が 1 本も無い (便の無い運行もここ)
 */
export type KushiroLoadingKind = "pure" | "mixed" | "none";

/** 合計の粒度。`all` は全運行。 */
export type KushiroTotalsKey = KushiroLoadingKind | "all";

/** 営業所 1 つぶんの、運行 1 本の回送推定 (直線)。**片方でも欠測なら `totalKm` は null**。 */
export interface DepotDeadheadEstimate {
  outboundKm: number | null;
  inboundKm: number | null;
  totalKm: number | null;
}

/**
 * 出庫 (または帰庫) の片側ぶんの集計。
 * `comparableMeasuredKm` は**推定が出せた運行だけ**の実測 (較正の分母)。
 */
export interface DepotEstimateSide {
  measuredKm: number;
  estimatedOperations: number;
  /** 座標が欠けていて推定を出せなかった運行数。**黙って 0km にしない。** */
  missingOperations: number;
  comparableMeasuredKm: number;
  estimatedKm: Record<DepotKey, number>;
}

/**
 * 集計 1 行。便 単位の列と 運行 単位の列が混ざっている。
 * - 便 単位 … `legs` / `kushiroLegs` / `salesYen` / `allowanceYen` / `haulKm` / `deadheadKm`
 * - 運行 単位 … `operations` / `betweenKm` / `otherKm` / `outbound` / `inbound`
 */
export interface KushiroTotals {
  operations: number;
  legs: number;
  kushiroLegs: number;
  salesYen: number;
  allowanceYen: number;
  haulKm: number;
  deadheadKm: number;
  betweenKm: number;
  otherKm: number;
  outbound: DepotEstimateSide;
  inbound: DepotEstimateSide;
}

/** 経路 (積地 → 卸地) 1 本の行。 */
export interface KushiroRouteRow {
  kind: KushiroLoadingKind;
  from: string;
  to: string;
  totals: KushiroTotals;
}

/** 乗務員 1 人の行。 */
export interface KushiroDriverRow {
  kind: KushiroLoadingKind;
  driverName: string;
  totals: KushiroTotals;
}

/** `summarizeKushiroLoading` の返り。 */
export interface KushiroLoadingSummary {
  counts: Record<KushiroTotalsKey, number>;
  totals: Record<KushiroTotalsKey, KushiroTotals>;
  kushiroOnly: KushiroTotals;
  routes: KushiroRouteRow[];
  drivers: KushiroDriverRow[];
  leglessOperations: number;
}

/**
 * 運行 1 本の回送推定 (直線)。**帯広側も釧路側もこの同じ関数で出す。**
 */
export function estimateDepotDeadhead(
  depot: DepotKey,
  operation: Pick<KushiroOperationInput, "firstLoadPoint" | "lastUnloadPoint">,
): DepotDeadheadEstimate {
  const point = DEPOTS[depot];
  const outboundKm = haversineKm(point, operation.firstLoadPoint);
  const inboundKm = haversineKm(operation.lastUnloadPoint, point);
  return {
    outboundKm,
    inboundKm,
    totalKm: outboundKm === null || inboundKm === null ? null : outboundKm + inboundKm,
  };
}

/**
 * 回送の**実測**平均速度 (km/h)。**時刻が読めない区間は km も秒も数えない。**
 * 秒の合計が 0 以下なら `null` — 既定値に落とさない。
 */
export function deadheadSpeedKmh(idles: readonly DeadheadSpeedInput[]): number | null {
  let km = 0;
  let sec = 0;
  for (const idle of idles) {
    if (idle.preLoadSec !== null) {
      km += idle.preLoadKm;
      sec += idle.preLoadSec;
    }
    if (idle.postUnloadSec !== null) {
      km += idle.postUnloadKm;
      sec += idle.postUnloadSec;
    }
  }
  if (sec <= 0) return null;
  return km / (sec / SECONDS_PER_HOUR);
}

/** 回送km を拘束時間 (時間) に直す。速度が無い / 0 以下なら `null`。 */
export function deadheadHours(km: number, speedKmh: number | null): number | null {
  if (speedKmh === null || speedKmh <= 0) return null;
  return km / speedKmh;
}

/**
 * **試算の燃料代** = `差km ÷ 燃費 × 単価`。**実績の燃料代と足さない・引かない**
 * (月の燃料総額は給油実績で固定)。燃費・単価が無ければ `null`。
 */
export function deadheadFuelYen(
  km: number,
  rate: Pick<FuelRate, "kmPerLiter" | "yenPerLiter">,
): number | null {
  if (rate.kmPerLiter === null || rate.kmPerLiter <= 0 || rate.yenPerLiter === null) return null;
  return (km / rate.kmPerLiter) * rate.yenPerLiter;
}

/**
 * `推定 ÷ 実測` の比 (較正)。**1 未満なら直線が実距離より短く出ている**。
 * 分母は推定を出せた運行だけの実測。0 以下なら `null`。
 */
export function estimateRatio(side: DepotEstimateSide, depot: DepotKey): number | null {
  if (side.comparableMeasuredKm <= 0) return null;
  return side.estimatedKm[depot] / side.comparableMeasuredKm;
}

/** **運行 単位**の実測回送km = 出庫 + 便間 + 帰庫 + 分類不能。 */
export function measuredDeadheadKm(totals: KushiroTotals): number {
  return totals.outbound.measuredKm + totals.betweenKm + totals.inbound.measuredKm + totals.otherKm;
}

/** 営業所を `from` → `to` に入れ替えたときの**推定**回送km の差 (プラス = 増える)。 */
export interface DepotShiftDiff {
  outboundKm: number;
  inboundKm: number;
  /** 出庫 + 帰庫。**`betweenKm` / `otherKm` は動かないので入らない。** */
  totalKm: number;
  hours: number | null;
}

/** 営業所の入れ替えで**推定**回送がどれだけ動くか。 */
export function depotShiftDiff(
  totals: KushiroTotals,
  from: DepotKey,
  to: DepotKey,
  speedKmh: number | null = null,
): DepotShiftDiff {
  const outboundKm = totals.outbound.estimatedKm[to] - totals.outbound.estimatedKm[from];
  const inboundKm = totals.inbound.estimatedKm[to] - totals.inbound.estimatedKm[from];
  const totalKm = outboundKm + inboundKm;
  return { outboundKm, inboundKm, totalKm, hours: deadheadHours(totalKm, speedKmh) };
}

/** 便の分類。`legs` が空なら `none`。 */
export function classifyKushiroOperation(
  legs: readonly Pick<KushiroLegInput, "originCity">[],
): KushiroLoadingKind {
  const kushiro = legs.filter(isKushiroLoadingLeg).length;
  if (kushiro === 0) return "none";
  if (kushiro === legs.length) return "pure";
  return "mixed";
}

function mapDepots<T>(pick: (depot: DepotKey) => T): Record<DepotKey, T> {
  return Object.fromEntries(DEPOT_KEYS.map((depot) => [depot, pick(depot)])) as Record<DepotKey, T>;
}

function emptySide(): DepotEstimateSide {
  return {
    measuredKm: 0,
    estimatedOperations: 0,
    missingOperations: 0,
    comparableMeasuredKm: 0,
    estimatedKm: mapDepots(() => 0),
  };
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
  };
}

/** 運行 1 本ぶんの、片側 (出庫 or 帰庫) の実測と推定。 */
interface SideFacts {
  measuredKm: number;
  estimatedKm: Record<DepotKey, number | null>;
}

function addSide(side: DepotEstimateSide, facts: SideFacts): void {
  side.measuredKm += facts.measuredKm;
  // **1 つでも欠測なら、その運行は全営業所ぶん推定に入れない** — 営業所ごとに
  // 母集団が違うと差が営業所の差でなくなる。
  if (DEPOT_KEYS.some((depot) => facts.estimatedKm[depot] === null)) {
    side.missingOperations += 1;
    return;
  }
  side.estimatedOperations += 1;
  side.comparableMeasuredKm += facts.measuredKm;
  for (const depot of DEPOT_KEYS) side.estimatedKm[depot] += facts.estimatedKm[depot]!;
}

function addLeg(totals: KushiroTotals, leg: KushiroLegInput): void {
  totals.legs += 1;
  if (isKushiroLoadingLeg(leg)) totals.kushiroLegs += 1;
  totals.salesYen += leg.salesYen;
  totals.allowanceYen += leg.allowanceYen;
  totals.haulKm += leg.haulKm;
  totals.deadheadKm += leg.deadheadKm;
}

/** 運行 単位の列 (`inbound` を除く) をこの行に載せる。 */
function addOperationHead(totals: KushiroTotals, km: KmBreakdown, outbound: SideFacts): void {
  totals.operations += 1;
  totals.betweenKm += km.betweenKm;
  totals.otherKm += km.otherKm;
  addSide(totals.outbound, outbound);
}

function routeRowOf(
  rows: Map<string, KushiroRouteRow>,
  kind: KushiroLoadingKind,
  leg: KushiroLegInput,
): KushiroRouteRow {
  const from = routePlace(leg.originCity);
  const to = routePlace(leg.destCity);
  const key = `${kind} ${from} ${to}`;
  const row = rows.get(key) ?? { kind, from, to, totals: emptyTotals() };
  rows.set(key, row);
  return row;
}

function driverRowOf(
  rows: Map<string, KushiroDriverRow>,
  kind: KushiroLoadingKind,
  driverName: string,
): KushiroDriverRow {
  const key = `${kind} ${driverName}`;
  const row = rows.get(key) ?? { kind, driverName, totals: emptyTotals() };
  rows.set(key, row);
  return row;
}

/**
 * 釧路積みの便・運行を数え、**営業所を差し替えた回送を両営業所ぶん推定して**束ねる。
 *
 * 検算 (どの列も、丸めなし):
 * - `totals.pure + totals.mixed + totals.none === totals.all`
 * - `Σ routes[].totals === totals.all` (**便の無い運行を除く**)
 * - `Σ drivers[].totals === totals.all`
 * - `kushiroOnly.kushiroLegs === kushiroOnly.legs`
 */
export function summarizeKushiroLoading(
  operations: readonly KushiroOperationInput[],
): KushiroLoadingSummary {
  const totals: Record<KushiroTotalsKey, KushiroTotals> = {
    pure: emptyTotals(),
    mixed: emptyTotals(),
    none: emptyTotals(),
    all: emptyTotals(),
  };
  const counts: Record<KushiroTotalsKey, number> = { pure: 0, mixed: 0, none: 0, all: 0 };
  const kushiroOnly = emptyTotals();
  const routeRows = new Map<string, KushiroRouteRow>();
  const driverRows = new Map<string, KushiroDriverRow>();
  let leglessOperations = 0;

  for (const operation of operations) {
    const kind = classifyKushiroOperation(operation.legs);
    const km = operation.kmBreakdown;
    const outbound: SideFacts = {
      measuredKm: km.preLoadKm,
      estimatedKm: mapDepots((depot) => haversineKm(DEPOTS[depot], operation.firstLoadPoint)),
    };
    const inbound: SideFacts = {
      measuredKm: km.postUnloadKm,
      estimatedKm: mapDepots((depot) => haversineKm(operation.lastUnloadPoint, DEPOTS[depot])),
    };
    counts[kind] += 1;
    counts.all += 1;
    const driverRow = driverRowOf(driverRows, kind, operation.driverName);
    for (const target of [totals[kind], totals.all, driverRow.totals]) {
      addOperationHead(target, km, outbound);
      addSide(target.inbound, inbound);
      for (const leg of operation.legs) addLeg(target, leg);
    }
    if (kind !== "none") {
      addOperationHead(kushiroOnly, km, outbound);
      addSide(kushiroOnly.inbound, inbound);
      for (const leg of operation.legs.filter(isKushiroLoadingLeg)) addLeg(kushiroOnly, leg);
    }

    const first = operation.legs[0];
    // 便が無い運行は経路に結べない。運行 単位の値もどの経路にも載せない。
    if (first === undefined) {
      leglessOperations += 1;
      continue;
    }
    // 出庫は先頭便の経路、帰庫は最終便の経路。
    addOperationHead(routeRowOf(routeRows, kind, first).totals, km, outbound);
    addSide(
      routeRowOf(routeRows, kind, operation.legs[operation.legs.length - 1]!).totals.inbound,
      inbound,
    );
    for (const leg of operation.legs) addLeg(routeRowOf(routeRows, kind, leg).totals, leg);
  }

  return {
    counts,
    totals,
    kushiroOnly,
    routes: [...routeRows.values()].sort((a, b) => b.totals.salesYen - a.totals.salesYen),
    drivers: [...driverRows.values()].sort((a, b) => b.totals.kushiroLegs - a.totals.kushiroLegs),
    leglessOperations,
  };
}
