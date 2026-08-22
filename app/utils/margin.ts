/**
 * 粗利 = 売上 − 手当 − 経費 (pure)。
 *
 * 売上 (一番星の運転日報明細) と手当 (料金・給与マスタ) は運行手当タブで揃った
 * (2026-07 / 帯広5台で手当表PDF 313 便と突合し、差は PDF 側の誤り 1 件のみ)。
 * **残っていたのは経費**で、rust-ichibanboshi#305 が `経費明細` を読む口を足したので、
 * ここで運行 1 本ごとの粗利まで持っていく (Refs #760)。
 *
 * ## オーナー決定 (この 4 つは動かさない)
 *
 * 1. **燃料代は一番星から取らない。`走行距離 ÷ 燃費 × 単価` で出す**
 *    (「走行距離 × 燃費 × 単価」と言われたが、燃費は km/L なので割る側)
 * 2. **運行に直接紐づかない経費の按分は走行距離の比**
 * 3. **`08 給与(人件費)` と `11 賞与・調整金` は粗利に入れない** — 運行手当と二重に
 *    なる。別枠で「一番星の人件費」と「運行手当」を並べて出し、どちらが正しいかは
 *    人が判断する
 * 4. 粗利は運行手当タブの中の節ではなく**独立したタブ**
 *
 * ## 燃費と単価は一番星の燃料実績から出す (既定値)
 *
 * ```
 * 単価 (円/L) = Σ amount(経費種別C=01) ÷ Σ quantity(同)
 * 燃費 (km/L) = Σ totalKm(その車輌の運行) ÷ Σ quantity(同)
 * ```
 *
 * **給油日と運行日はずれる**ので単月では燃費が振れる。だから既定値は実績、
 * **確定値は人が入れる** (`FUEL_RATE_KEY` の上書き、`allowance-provisional.ts` と
 * 同じ localStorage 方式)。**分母が 0 の車輌は燃料代を出さない (`null`)** —
 * 0 で割った値を粗利に混ぜるくらいなら「出せない」と書く方がいい。
 *
 * **軽油引取税は単価に入れていない** (オーナーの式が `Σ amount` なので従う)。
 * 軽油は本体が非課税でこの税だけ別立てなので、実際に払っている 円/L は
 * `yenPerLiter + dieselTaxPerLiter`。**画面には両方出して、上書き欄で寄せられる**
 * ようにしてある (黙って片方だけ見せない)。
 */

import { buildIchibanLegs, summarizeIchibanLegs, type IchibanLeg } from './allowance-ichiban-legs'
import { transportSlips } from './allowance-relay'
import { addressToCity, cityToPlace } from './allowance-trips'
import type { AllowanceReportRow } from './allowance-report'
import type { LegReconcile } from './allowance-ichiban'
import type { ProvisionalMap } from './allowance-provisional'
import type { VehicleDailySlip } from './ichiban'

// --- 経費明細 (rust-ichibanboshi `/api/costs/vehicle-daily`) ---

/** API の応答行 (snake_case)。rust-ichibanboshi#305 の `CostsDailyRow` と 1 対 1。 */
export interface CostsDailyApiRow {
  operation_date: string
  vehicle_number: string
  vehicle_branch: string
  driver_code: string
  cost_code: string
  cost_name: string
  cost_kind: string
  cost_kind_name: string
  quantity: number
  unit_price: number
  amount: number
  diesel_tax: number
  km: number
  is_fixed: boolean
  row_id: string
}

/** 経費 1 行 (API の camelCase 版)。 */
export interface CostRow {
  /** `運行年月日` (`YYYY-MM-DD`)。**走った日**なので運行に直課する鍵に使える。 */
  operationDate: string
  /** `車輌C` (車番)。 */
  vehicleNumber: string
  /** `車輌H` (枝番)。表示だけに使う (突合の鍵は `vehicleNumber`)。 */
  vehicleBranch: string
  driverCode: string
  costCode: string
  costName: string
  /** `経費種別C` (`"01"`〜`"15"`)。 */
  costKind: string
  costKindName: string
  quantity: number
  unitPrice: number
  /** **税抜金額。** `軽油引取税` は含まれない (`dieselTax` が別立て)。 */
  amount: number
  /** `軽油引取税`。`amount` に含まれない。 */
  dieselTax: number
  km: number
  /** `固定経費K`。**月極めの固定費**は運行に直課せず距離比で按分する。 */
  isFixed: boolean
  rowId: string
}

export function mapCostApiRow(row: CostsDailyApiRow): CostRow {
  return {
    operationDate: row.operation_date,
    vehicleNumber: row.vehicle_number,
    vehicleBranch: row.vehicle_branch,
    driverCode: row.driver_code,
    costCode: row.cost_code,
    costName: row.cost_name,
    costKind: row.cost_kind,
    costKindName: row.cost_kind_name,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    amount: row.amount,
    dieselTax: row.diesel_tax,
    km: row.km,
    isFixed: row.is_fixed,
    rowId: row.row_id,
  }
}

/**
 * 経費明細を車輌 1 台ぶん引く (`/api/ichiban/*` proxy 経由)。
 *
 * **`vehicle`/`driver`/`kind` の最低 1 つが必須** (無いと upstream が 400)。
 * ここは車輌で引く — 按分の分母が「月・その車輌の Σ走行距離」なので、
 * 車輌ごとに閉じて引く方が画面の検算とそのまま対応する。
 *
 * `limit` は上限の 5000。既定の 500 だと月 1 台でも足りなくなりうる
 * (給油だけで月 30 行、そこに通行料が便ごとに乗る)。
 */
export async function fetchVehicleCosts(
  vehicle: string,
  from: string,
  to: string,
): Promise<CostRow[]> {
  const res = await $fetch<{ source_table: string, data: CostsDailyApiRow[] }>(
    '/api/ichiban/api/costs/vehicle-daily',
    { query: { vehicle, from, to, limit: '5000' } },
  )
  return res.data.map(mapCostApiRow)
}

/**
 * 経費を引く期間 (`from` 以上 `to` 未満)。**月ちょうどで閉じる。**
 *
 * 一番星の売上 (`slipDateRange`) は便の日付が ±1 日ずれるので前後に広げているが、
 * 経費は `運行年月日` そのもので、按分の分母 (月・車輌の Σ走行距離) も月で閉じて
 * 数える。ここだけ広げると**分子の外にある経費が分母に乗る**。
 */
export function monthCostRange(ym: string): { from: string, to: string } {
  const [year, month] = ym.split('-').map(Number) as [number, number]
  const next = new Date(Date.UTC(year, month, 1))
  const mm = String(next.getUTCMonth() + 1).padStart(2, '0')
  return { from: `${ym}-01`, to: `${next.getUTCFullYear()}-${mm}-01` }
}

// --- 経費種別 ---

/** `01 燃料ｵｲﾙ代`。**単価と燃費の出どころ**であり、粗利の経費には足さない。 */
export const FUEL_KIND = '01'

/** `15 アドブルー`。燃料系なので粗利には入れず、参考に燃料と並べて出す。 */
export const ADBLUE_KIND = '15'

/**
 * 粗利に入れない区分。**燃料は距離から出し、人件費は手当と二重になる。**
 *
 * - `01` 燃料ｵｲﾙ代 / `15` アドブルー … 燃料系。走行距離から出す (オーナー決定 1)
 * - `08` 給与(人件費) / `11` 賞与・調整金 … 運行手当と二重 (オーナー決定 3)
 */
export const EXCLUDED_KINDS: string[] = ['01', '08', '11', '15']

/** 人件費として**別枠で**見せる区分。粗利には入れない。 */
export const LABOR_KINDS: string[] = ['08', '11']

/**
 * 経費 1 行の実額。**`軽油引取税` を足す。**
 *
 * `amount` は税抜金額で、軽油引取税はそこに含まれない別立ての実費。燃料以外の行は
 * ふつう 0 なので足しても変わらないが、0 でない行が来たときに黙って落とさない。
 */
export function costYen(row: CostRow): number {
  return row.amount + row.dieselTax
}

// --- 燃費と単価 ---

export interface FuelRate {
  /** 円/L。出せなければ null。**軽油引取税は含まない** (`dieselTaxPerLiter` が別)。 */
  yenPerLiter: number | null
  /** km/L。出せなければ null。 */
  kmPerLiter: number | null
  /**
   * 軽油引取税 (円/L)。**参考表示専用で燃料代の計算には入っていない。**
   *
   * **2026-07 の実データでは全社 1,427 件すべて `diesel_tax = 0`** で、税抜でも税込でも
   * 単価は 122.95 円/L と 1 円も変わらなかった (帯広5台の実測)。つまりこの帳簿では
   * 軽油引取税は**別立てで計上されていない** (`amount` に含まれているか、そもそも無い)。
   * **0 が異常ではない。** ここを足す式に変えると、将来 `diesel_tax` が入り始めた
   * 瞬間に二重計上になる。**0 と表示され続けること自体が「別立てで来ていない」証拠**
   * なので、消さずに出す。
   */
  dieselTaxPerLiter: number | null
}

/** どれも出せない状態。**0 ではなく null** — 「0 円/L」と「出せない」は別物。 */
export function emptyFuelRate(): FuelRate {
  return { yenPerLiter: null, kmPerLiter: null, dieselTaxPerLiter: null }
}

/**
 * 車輌の月次実績から燃費と単価を出す。**分母 0 は null。**
 *
 * `costs` はその車輌・その月の経費明細、`totalKm` はその車輌・その月の運行の
 * 走行距離の合計 (`extractOperationIdle` の `totalKm` を足したもの)。
 *
 * 給油量 (`Σ quantity`) が 0 なら単価も燃費も出せない。走行距離が 0 なら燃費だけ
 * 出せない (単価は給油実績から出るので残す) — **0 km/L を返して燃料代を ∞ に
 * しない**ため。
 *
 * **分母に入れるのは `01 燃料ｵｲﾙ代` だけ。** `15 アドブルー` にも数量 (L) が入って
 * いる (2026-07 の車0016 で 220.0 L) が、軽油ではないので分母に足すと km/L が狂う。
 *
 * **行ごとの単価 (`unit_price`) は使えない。** 2026-07 の実データで行単価は
 * `133.74` (885 件) と `130.44` (542 件) の 2 種類しかなく、月平均 121.83 円/L は
 * **そのどちらとも一致しない**。`Σ金額 ÷ Σ数量` でしか出せない。
 */
export function deriveFuelRate(costs: CostRow[], totalKm: number): FuelRate {
  let liters = 0
  let yen = 0
  let tax = 0
  for (const row of costs) {
    if (row.costKind !== FUEL_KIND) continue
    liters += row.quantity
    yen += row.amount
    tax += row.dieselTax
  }
  if (liters <= 0) return emptyFuelRate()
  return {
    yenPerLiter: yen / liters,
    kmPerLiter: totalKm > 0 ? totalKm / liters : null,
    dieselTaxPerLiter: tax / liters,
  }
}

/**
 * 走行距離ぶんの燃料代。**燃費か単価が出せなければ null。**
 *
 * `FuelRate` の 2 つの数は**正か null** (`deriveFuelRate` と `parseFuelRates` の
 * どちらもそう作る) ので、ここで 0 除算の心当てをしない。
 */
export function fuelYenFor(km: number, rate: FuelRate): number | null {
  if (rate.yenPerLiter === null || rate.kmPerLiter === null) return null
  return (km / rate.kmPerLiter) * rate.yenPerLiter
}

// --- 燃費・単価の上書き (localStorage) ---

/** localStorage のキー。**形を変えるときは番号を上げる。** */
export const FUEL_RATE_KEY = 'dtako:margin:fuel-rate:v1'

/** 人が入れた確定値。**片方だけ入れられる** (入れなかった方は実績のまま)。 */
export interface FuelRateOverride {
  yenPerLiter: number | null
  kmPerLiter: number | null
}

/** 車輌C → 上書き。 */
export type FuelRateMap = Record<string, FuelRateOverride>

/** 上書きに使える値だけ通す。**正の有限数以外は「入っていない」扱い。** */
function positiveOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value
}

/**
 * 保存済みの上書きを読む。**壊れていても投げない** — 空として扱う。
 *
 * 配列や空キーをわざわざ弾いていないのは、どちらもここでは無害だから
 * (配列は添字が車輌C として引かれることが無く、空キーも同じ)。
 */
export function parseFuelRates(raw: string | null | undefined): FuelRateMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const out: FuelRateMap = {}
  for (const [vehicle, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Record<string, unknown>
    const yenPerLiter = positiveOrNull(entry.yenPerLiter)
    const kmPerLiter = positiveOrNull(entry.kmPerLiter)
    if (yenPerLiter === null && kmPerLiter === null) continue
    out[vehicle] = { yenPerLiter, kmPerLiter }
  }
  return out
}

export function serializeFuelRates(map: FuelRateMap): string {
  return JSON.stringify(map)
}

/**
 * 上書きを入れる。**正の数でなければ「消す」扱い** (入力欄を空にしたら実績に戻る、
 * が素直な操作なので)。両方消えた車輌はキーごと落とす。
 */
export function setFuelRate(
  map: FuelRateMap,
  vehicle: string,
  field: 'yenPerLiter' | 'kmPerLiter',
  value: number,
): FuelRateMap {
  if (!vehicle) return map
  const next = { ...map }
  const current = next[vehicle] ?? { yenPerLiter: null, kmPerLiter: null }
  const entry: FuelRateOverride = { ...current, [field]: positiveOrNull(value) }
  if (entry.yenPerLiter === null && entry.kmPerLiter === null) delete next[vehicle]
  else next[vehicle] = entry
  return next
}

/**
 * 実績に上書きを重ねた、**実際に使う燃費と単価**。
 *
 * 軽油引取税は上書きできない (参考表示専用なので、人が入れる場所を作ると
 * 「入れた値が粗利に効く」と誤解される)。
 */
export function effectiveFuelRate(derived: FuelRate, override: FuelRateOverride | undefined): FuelRate {
  return {
    yenPerLiter: override?.yenPerLiter ?? derived.yenPerLiter,
    kmPerLiter: override?.kmPerLiter ?? derived.kmPerLiter,
    dieselTaxPerLiter: derived.dieselTaxPerLiter,
  }
}

// --- 運行ごとの粗利 ---

/**
 * 走行距離の内訳 (`extractOperationIdle` の同名フィールドをそのまま運ぶ)。
 *
 * **按分の分子 (`totalKm`) の中身**。5 つを足すと `totalKm` になる (浮動小数の
 * 丸め誤差ぶんだけずれることはある — グループを変えて足し直しているため)。
 * **按分には使わない** — 分子は今までどおり `totalKm` で、これは人が読むためだけ。
 */
export interface KmBreakdown {
  /** 始業 → 最初の積み。 */
  preLoadKm: number
  /** 積み → その便の最後の降し = **売上が立つ走行**。 */
  haulKm: number
  /** 降し → 次の積み (便間の回送)。 */
  betweenKm: number
  /** 最後の降し → 終業。 */
  postUnloadKm: number
  /** 分類不能 (降しが記録されていない便 / 積みが 1 行も無い運行)。 */
  otherKm: number
}

/** 粗利を出す 1 運行ぶんの入力。売上・手当・距離は呼び出し側が既に持っている。 */
export interface MarginOperationInput {
  unkoNo: string
  /** 運行の日付 (`YYYY-MM-DD`)。**経費を直課する鍵**なので `経費明細.運行年月日` と同じ形。 */
  date: string
  driverName: string
  /** `車輌C` (4桁)。運行NO から取ったもの (`vehicleCodeFromUnkoNo`)。 */
  vehicleCode: string
  /** その運行の走行距離 (`extractOperationIdle` の `totalKm`)。 */
  totalKm: number
  /** `totalKm` の内訳。**按分には効かない** (画面と CSV に出すだけ)。 */
  kmBreakdown: KmBreakdown
  salesYen: number
  allowanceYen: number
}

/** 運行 1 本の粗利。 */
export interface OperationMargin {
  unkoNo: string
  date: string
  driverName: string
  vehicleCode: string
  /** **按分の分子。** 画面に出して人が検算できるようにする。 */
  totalKm: number
  /**
   * **分子の中身。** 本番実測では `totalKm` の過半が非売上走行 (便間が最大) なので、
   * 分子を人が読めるように内訳を持ち回る (Refs #760)。**按分の式には入らない。**
   */
  kmBreakdown: KmBreakdown
  /** **按分の分母。** その月・その車輌の運行の走行距離の合計。 */
  vehicleTotalKm: number
  salesYen: number
  allowanceYen: number
  /** 燃料代。`FuelRate` が出せなければ null。 */
  fuelYen: number | null
  /** 直課できた経費 (日・車輌が一致する変動費)。 */
  directCostYen: number
  /** 距離比で按分した経費 (固定費 + 直課できなかったぶん)。 */
  allocatedCostYen: number
  /** 売上 − 手当 − 燃料 − 直課 − 按分。`fuelYen` が null なら null。 */
  marginYen: number | null
  /** 参考表示。**粗利には入れない** (運行手当と二重になるため)。 */
  laborYen: number
  /** その運行に使った燃費・単価 (上書き後)。画面の欄に出す。 */
  fuelRate: FuelRate
  /**
   * **その車輌・その月の経費を 1 件も持っていない。** このとき `marginYen` は `null`。
   *
   * 経費が 1 件も無いのは普通に起こる (一番星が引けなかった / その月その車輌に計上が
   * 無い)。**経費 0 円として粗利を出すと「売上そのまま」が粗利に見える** —
   * いちばん悪い壊れ方なので、燃費・単価を人が上書きして燃料代が出せるときでも
   * 粗利は出さない。
   */
  costsMissing: boolean
}

/** 粗利の式。**1 か所にだけ置く** — 合計と行で式が分かれると静かにずれる。 */
function marginOf(
  salesYen: number,
  allowanceYen: number,
  fuelYen: number,
  directCostYen: number,
  allocatedCostYen: number,
): number {
  return salesYen - allowanceYen - fuelYen - directCostYen - allocatedCostYen
}

/** 経費の一群を運行へ配った結果 (添字は渡した運行と同じ)。 */
interface Spread {
  /** 日・車輌が一致する変動費として直課した額。 */
  direct: number[]
  /** 距離比で按分した額。 */
  allocated: number[]
  /** **どの運行にも配れなかった額。** 黙って消さずに数える。 */
  dropped: number
}

/**
 * 経費を運行へ配る。
 *
 * - **`is_fixed` でない経費で、日 (`運行年月日`) と車輌が運行と一致するものは直課**。
 *   同じ日・同じ車輌に運行が 2 本あれば、その中で走行距離の比に割る
 *   (同じ経費を 2 本に丸ごと乗せない)
 * - **`is_fixed` の経費**と、**日・車輌が運行に一致しない経費**は按分に回す。
 *   分母はその月・その車輌の運行の走行距離の合計、分子はその運行の走行距離
 * - **分母が 0 / その車輌の運行が 1 本も無いなら按分しない。** 0 除算を粗利に
 *   混ぜるくらいなら「配れなかった額」として画面に出す
 */
function spreadCosts(
  ops: MarginOperationInput[],
  rows: CostRow[],
  opsByVehicle: Map<string, number[]>,
): Spread {
  const direct = ops.map(() => 0)
  const allocated = ops.map(() => 0)
  let dropped = 0

  const byDayVehicle = new Map<string, number[]>()
  ops.forEach((op, i) => {
    const key = `${op.date}|${op.vehicleCode}`
    const list = byDayVehicle.get(key) ?? []
    list.push(i)
    byDayVehicle.set(key, list)
  })

  /** 按分に回す額 (車輌C → 円)。直課できなかったものが溜まる。 */
  const pool = new Map<string, number>()
  for (const row of rows) {
    const yen = costYen(row)
    const hits = row.isFixed ? [] : (byDayVehicle.get(`${row.operationDate}|${row.vehicleNumber}`) ?? [])
    const hitKm = hits.reduce((sum, i) => sum + ops[i]!.totalKm, 0)
    if (hits.length > 0 && hitKm > 0) {
      for (const i of hits) direct[i]! += yen * (ops[i]!.totalKm / hitKm)
      continue
    }
    pool.set(row.vehicleNumber, (pool.get(row.vehicleNumber) ?? 0) + yen)
  }

  for (const [vehicle, yen] of pool) {
    const idx = opsByVehicle.get(vehicle)
    if (idx === undefined) {
      // その車輌の運行を 1 本も持っていない。配る先が無い。
      dropped += yen
      continue
    }
    const denom = idx.reduce((sum, i) => sum + ops[i]!.totalKm, 0)
    if (denom <= 0) {
      // 距離が 1 km も取れていない車輌。**0 で割らない。**
      dropped += yen
      continue
    }
    for (const i of idx) allocated[i]! += yen * (ops[i]!.totalKm / denom)
  }

  return { direct, allocated, dropped }
}

export interface MarginResult {
  /** 運行ごとの粗利 (渡した順のまま)。 */
  operations: OperationMargin[]
  /** 車輌C → 実際に使った燃費・単価 (上書き後)。画面の欄に出す。 */
  ratesByVehicle: Map<string, FuelRate>
  /** 車輌C → 実績から出した燃費・単価 (上書き前)。「既定値は実績」を見せるため。 */
  derivedByVehicle: Map<string, FuelRate>
  /** 車輌C → 月の走行距離合計 (= **按分の分母**)。 */
  kmByVehicle: Map<string, number>
  /** どの運行にも配れなかった経費 (円)。**粗利から抜けているぶん。** */
  unallocatedCostYen: number
  /** どの運行にも配れなかった人件費 (円)。 */
  unallocatedLaborYen: number
  /** 一番星の人件費 (`08`+`11`) の月合計。**粗利には入れない**、手当と並べて見せる。 */
  ichibanLaborYen: number
  /** 一番星の燃料系 (`01`+`15`) の月合計。**粗利には入れない**、参考に並べる。 */
  ichibanFuelYen: number
}

/**
 * 運行ごとの粗利を出す。
 *
 * `costs` は対象月・対象車輌の経費明細をぜんぶ (種別で絞らずに) 渡す —
 * どれを粗利に入れるかの判断はここが持つ。
 */
export function buildOperationMargins(
  ops: MarginOperationInput[],
  costs: CostRow[],
  overrides: FuelRateMap,
): MarginResult {
  const opsByVehicle = new Map<string, number[]>()
  ops.forEach((op, i) => {
    const list = opsByVehicle.get(op.vehicleCode) ?? []
    list.push(i)
    opsByVehicle.set(op.vehicleCode, list)
  })

  const kmByVehicle = new Map<string, number>()
  const derivedByVehicle = new Map<string, FuelRate>()
  const ratesByVehicle = new Map<string, FuelRate>()
  for (const [vehicle, idx] of opsByVehicle) {
    const km = idx.reduce((sum, i) => sum + ops[i]!.totalKm, 0)
    kmByVehicle.set(vehicle, km)
    const derived = deriveFuelRate(costs.filter(row => row.vehicleNumber === vehicle), km)
    derivedByVehicle.set(vehicle, derived)
    ratesByVehicle.set(vehicle, effectiveFuelRate(derived, overrides[vehicle]))
  }

  // **その車輌の経費を 1 件も持っていないか。** 種別で絞る**前**に数える —
  // 燃料しか無い車輌も「経費は来ている」ので、粗利を出さない理由にはならない。
  const costCountByVehicle = new Map<string, number>()
  for (const row of costs) {
    costCountByVehicle.set(row.vehicleNumber, (costCountByVehicle.get(row.vehicleNumber) ?? 0) + 1)
  }

  const costRows = costs.filter(row => !EXCLUDED_KINDS.includes(row.costKind))
  const laborRows = costs.filter(row => LABOR_KINDS.includes(row.costKind))
  const spreadCost = spreadCosts(ops, costRows, opsByVehicle)
  const spreadLabor = spreadCosts(ops, laborRows, opsByVehicle)

  const operations = ops.map((op, i) => {
    // **`!` で取り出す。** `ratesByVehicle`/`kmByVehicle` は `opsByVehicle` から
    // 作っていて、その `opsByVehicle` は `ops` から作っている。取り出せない車輌は
    // 構造上ありえないので、`??` の受け皿を置くと通らない枝が残る。
    const fuelRate = ratesByVehicle.get(op.vehicleCode)!
    const fuelYen = fuelYenFor(op.totalKm, fuelRate)
    const directCostYen = spreadCost.direct[i]!
    const allocatedCostYen = spreadCost.allocated[i]!
    const costsMissing = (costCountByVehicle.get(op.vehicleCode) ?? 0) === 0
    return {
      unkoNo: op.unkoNo,
      date: op.date,
      driverName: op.driverName,
      vehicleCode: op.vehicleCode,
      totalKm: op.totalKm,
      kmBreakdown: op.kmBreakdown,
      vehicleTotalKm: kmByVehicle.get(op.vehicleCode)!,
      salesYen: op.salesYen,
      allowanceYen: op.allowanceYen,
      fuelYen,
      directCostYen,
      allocatedCostYen,
      // **燃費が出せない運行と、経費を 1 件も持っていない運行は粗利を出さない。**
      marginYen: fuelYen === null || costsMissing
        ? null
        : marginOf(op.salesYen, op.allowanceYen, fuelYen, directCostYen, allocatedCostYen),
      laborYen: spreadLabor.direct[i]! + spreadLabor.allocated[i]!,
      fuelRate,
      costsMissing,
    }
  })

  return {
    operations,
    ratesByVehicle,
    derivedByVehicle,
    kmByVehicle,
    unallocatedCostYen: spreadCost.dropped,
    unallocatedLaborYen: spreadLabor.dropped,
    ichibanLaborYen: laborRows.reduce((sum, row) => sum + costYen(row), 0),
    ichibanFuelYen: costs
      .filter(row => row.costKind === FUEL_KIND || row.costKind === ADBLUE_KIND)
      .reduce((sum, row) => sum + costYen(row), 0),
  }
}

/**
 * **粗利を出せない理由。** 出せていれば空文字。
 *
 * 画面と CSV で語彙を分けないよう 1 か所に置く。**「経費が来ていない」と
 * 「燃費が出せない」は直し方が正反対** — 前者は一番星側 (計上・API) の話で、
 * 後者はこの画面の上書き欄に人が入れれば済む。
 */
export function noMarginReason(m: Pick<OperationMargin, 'marginYen' | 'costsMissing' | 'fuelRate'>): string {
  if (m.marginYen !== null) return ''
  if (m.costsMissing) return 'この車輌・この月の経費を 1 件も引けていません'
  if (m.fuelRate.yenPerLiter === null) return 'この月・この車輌に燃料 (01) の給油実績がありません'
  return '走行距離が 0 で燃費が出せません'
}

/** 理由ごとの「粗利を出せなかった運行」。 */
export interface NoMarginGroup {
  reason: string
  operations: number
  /** その運行たちの売上。**粗利の内訳に入っていない額**。 */
  salesYen: number
}

/**
 * 粗利を出せなかった運行を**理由ごとに数える**。
 *
 * **理由を運行の行に埋めるだけでは足りない。** 乗務員の段が畳まれていると、
 * 人は運行を開かずに合計だけを見て「なぜ `-` なのか」を確かめない。月の合計の
 * すぐ横に理由と件数を出す。
 *
 * 並べ替えない — 渡された運行の順がそのまま理由の初出順になり、決まった順になる
 * (`localeCompare` を避けるための文字列比較も要らない)。
 */
export function summarizeNoMarginReasons(margins: OperationMargin[]): NoMarginGroup[] {
  const byReason = new Map<string, NoMarginGroup>()
  for (const m of margins) {
    const reason = noMarginReason(m)
    if (reason === '') continue
    const hit = byReason.get(reason) ?? { reason, operations: 0, salesYen: 0 }
    hit.operations += 1
    hit.salesYen += m.salesYen
    byReason.set(reason, hit)
  }
  return [...byReason.values()]
}

/** 粗利率 = 粗利 ÷ 売上。**売上 0 と粗利不明はどちらも null** (画面では `-`)。 */
export function marginRate(m: Pick<OperationMargin, 'salesYen' | 'marginYen'>): number | null {
  if (m.marginYen === null || m.salesYen === 0) return null
  return m.marginYen / m.salesYen
}

/**
 * 月 / 乗務員の合計。
 *
 * **2 段に分かれている。** 上 4 つは**渡した運行ぜんぶ**、`margin*` から下は
 * **粗利を出せた運行ぶんだけ**。混ぜると
 * 「売上 − 手当 − 経費 が画面の粗利と合わない」という、人が検算した瞬間に
 * 信用を失う表になる (粗利を出せない運行の売上だけが合計に混ざるため)。
 *
 * 下の 6 つは
 * `marginSalesYen − marginAllowanceYen − fuelYen − directCostYen − allocatedCostYen
 *  === marginYen` が**必ず成り立つ**。
 */
export interface MarginTotals {
  /** 運行の本数 (**ぜんぶ**)。 */
  operations: number
  /** 走行距離の合計 (**ぜんぶ**)。 */
  totalKm: number
  // 走行距離の内訳の合計 (**ぜんぶ** — `totalKm` と同じで粗利の可否では欠かさない)。
  /** 始業 → 最初の積み の合計。 */
  preLoadKm: number
  /** 売上が立つ走行 (積み → 降し) の合計。 */
  haulKm: number
  /** 便間 (降し → 次の積み) の合計。 */
  betweenKm: number
  /** 最後の降し → 終業 の合計。 */
  postUnloadKm: number
  /** 分類不能な走行の合計。 */
  otherKm: number
  /** 売上の合計 (**ぜんぶ**)。 */
  salesYen: number
  /** 手当の合計 (**ぜんぶ**)。人件費の別枠比較に使うので、粗利の可否で欠かさない。 */
  allowanceYen: number
  /** 一番星の人件費 (**ぜんぶ**)。参考表示で、粗利には入れない。 */
  laborYen: number

  /** 粗利を出せた運行の本数。 */
  marginOperations: number
  /** 粗利を出せた運行ぶんの売上。**粗利率の分母。** */
  marginSalesYen: number
  /** 粗利を出せた運行ぶんの手当。 */
  marginAllowanceYen: number
  /** 粗利を出せた運行ぶんの燃料代。 */
  fuelYen: number
  /** 粗利を出せた運行ぶんの直課経費。 */
  directCostYen: number
  /** 粗利を出せた運行ぶんの按分経費。 */
  allocatedCostYen: number
  /** 粗利。上の 5 つから引き算で出る。 */
  marginYen: number

  /**
   * **粗利を出せなかった運行の本数** (燃費が出せない / その車輌の経費が 1 件も無い)。
   * **黙って 0 円に倒さない。**
   */
  noMarginOperations: number
  /** その運行たちの売上。**粗利の合計に入っていない売上**がいくらかを出す。 */
  noMarginSalesYen: number
}

export function emptyMarginTotals(): MarginTotals {
  return {
    operations: 0,
    totalKm: 0,
    preLoadKm: 0,
    haulKm: 0,
    betweenKm: 0,
    postUnloadKm: 0,
    otherKm: 0,
    salesYen: 0,
    allowanceYen: 0,
    laborYen: 0,
    marginOperations: 0,
    marginSalesYen: 0,
    marginAllowanceYen: 0,
    fuelYen: 0,
    directCostYen: 0,
    allocatedCostYen: 0,
    marginYen: 0,
    noMarginOperations: 0,
    noMarginSalesYen: 0,
  }
}

/**
 * 運行の粗利を合計する。
 *
 * **粗利が出せない運行は粗利の内訳に入れない** — 燃料 0 円・経費 0 円として足すと、
 * その車輌だけ粗利が良く見える。運行の本数・走行距離・売上・手当・人件費は
 * **ぜんぶ**数えたうえで、「粗利を出せなかった運行が何本・売上いくら」を併記する。
 */
export function summarizeMargins(margins: OperationMargin[]): MarginTotals {
  const totals = emptyMarginTotals()
  for (const m of margins) {
    totals.operations += 1
    totals.totalKm += m.totalKm
    // 内訳も `totalKm` と同じ扱い — 粗利を出せない運行のぶんも数える。
    totals.preLoadKm += m.kmBreakdown.preLoadKm
    totals.haulKm += m.kmBreakdown.haulKm
    totals.betweenKm += m.kmBreakdown.betweenKm
    totals.postUnloadKm += m.kmBreakdown.postUnloadKm
    totals.otherKm += m.kmBreakdown.otherKm
    totals.salesYen += m.salesYen
    totals.allowanceYen += m.allowanceYen
    totals.laborYen += m.laborYen
    const fuelYen = m.fuelYen
    const marginYen = m.marginYen
    if (fuelYen === null || marginYen === null) {
      totals.noMarginOperations += 1
      totals.noMarginSalesYen += m.salesYen
      continue
    }
    // **経費も粗利を出せた運行ぶんだけ足す。** ここで全運行ぶんを足すと
    // 「売上 − 手当 − 経費」が画面の粗利と合わなくなる。
    totals.marginOperations += 1
    totals.marginSalesYen += m.salesYen
    totals.marginAllowanceYen += m.allowanceYen
    totals.directCostYen += m.directCostYen
    totals.allocatedCostYen += m.allocatedCostYen
    totals.fuelYen += fuelYen
    totals.marginYen += marginYen
  }
  return totals
}

/** 乗務員ごとにまとめる (画面の 乗務員 → 運行 の 2 段)。 */
export interface DriverMargin {
  driverName: string
  operations: OperationMargin[]
  totals: MarginTotals
}

/**
 * 乗務員 → 運行 に畳む。並びは**乗務員名の文字列順** —
 * `localeCompare` は使わない (ICU の照合順が環境で入れ替わり CI だけ落ちる)。
 * 画面側が乗務員CD 順に並べ直す。
 */
export function groupMarginsByDriver(margins: OperationMargin[]): DriverMargin[] {
  const byDriver = new Map<string, OperationMargin[]>()
  for (const m of margins) {
    const list = byDriver.get(m.driverName) ?? []
    list.push(m)
    byDriver.set(m.driverName, list)
  }
  return [...byDriver.entries()]
    .map(([driverName, operations]) => ({ driverName, operations, totals: summarizeMargins(operations) }))
    .sort((a, b) => (a.driverName > b.driverName ? 1 : -1))
}

// --- CSV ---

const CSV_HEADER = [
  '運行NO', '日付', '乗務員', '車輌C', '走行km',
  '始業→積みkm', '売上走行km', '便間km', '降し→終業km', '分類不能km',
  '月・車輌の走行km', '売上', '手当',
  '燃料代', '直課経費', '按分経費', '粗利', '粗利率', '粗利が出せない理由',
  '一番星の人件費(参考)', '単価(円/L)', '燃費(km/L)',
]

/** 運行 1 行ずつの粗利 CSV。値にカンマが入りうるので必ず引用する。 */
export function marginCsvLines(margins: OperationMargin[]): string[] {
  const quote = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const rate = (v: number | null) => (v === null ? '' : `${Math.round(v * 1000) / 10}%`)
  const round = (v: number | null) => (v === null ? '' : Math.round(v))
  return [
    CSV_HEADER.map(quote).join(','),
    ...margins.map(m => [
      m.unkoNo, m.date, m.driverName, m.vehicleCode, m.totalKm,
      round(m.kmBreakdown.preLoadKm), round(m.kmBreakdown.haulKm), round(m.kmBreakdown.betweenKm),
      round(m.kmBreakdown.postUnloadKm), round(m.kmBreakdown.otherKm),
      m.vehicleTotalKm,
      m.salesYen, m.allowanceYen, round(m.fuelYen), round(m.directCostYen),
      round(m.allocatedCostYen), round(m.marginYen), rate(marginRate(m)), noMarginReason(m),
      round(m.laborYen), round(m.fuelRate.yenPerLiter), round(m.fuelRate.kmPerLiter),
    ].map(quote).join(',')),
  ]
}

// --- 粗利の対象外 (一番星から起こした便) ---

/**
 * 一番星から便を起こすための、乗務員 1 人ぶんの材料。
 *
 * **`reconcileVehicles` に渡したものと同じ**を渡す。売上の突合と別々の入力から
 * 起こすと、どちらかだけが直ったときに静かにずれる。
 */
export interface UncoveredDriverInput {
  driverName: string
  /** その乗務員の便 (デジタコ由来)。 */
  rows: AllowanceReportRow[]
  /** その乗務員の一番星の明細。 */
  slips: VehicleDailySlip[]
}

/**
 * **粗利の対象外になっている便**を一番星の明細から起こす。
 *
 * 粗利は**運行を単位**にしている (走行距離が無いと燃料代も按分も出せない) ので、
 * **デジタコに運行が 1 件も無い日の便は丸ごと落ちる** — デジタコ非搭載の車番
 * (`0001`) や、その日その乗務員の運行が alc に無い車番 (`0040`) で走った日。
 * 2026-07 / 帯広5台の実測で、運行手当タブとの差は売上 ¥1,649,681・手当 ¥413,000
 * (36 便) あった。**除外そのものは正しい。落ちていると画面が言わないのが問題**で、
 * ここはその額を数えて見せるためだけにある。**粗利の計算には 1 円も入れない。**
 *
 * 組み立ては運行手当タブ (`app/pages/profit/allowance.vue` の `ichibanLegs`) と
 * 同じ: **請求のみ (`請求K=1`) は落とし**、**デジタコ便に当たった明細 (`matched`) は
 * 除き**、**デジタコ便がある `日付|積地` も避ける**
 * (その積地に残った明細は複数卸しの片割れ)。**3 つのどれを落としても数が水増しされる。**
 */
export function buildUncoveredLegs(
  drivers: UncoveredDriverInput[],
  matched: Pick<LegReconcile, 'slips'>[],
  ym: string,
  provisional: ProvisionalMap,
): IchibanLeg[] {
  // **デジタコ便に当たった明細だけを除く。** 日単位で避けると、一部だけ取れている日の
  // 起こし損ねた便が永久に埋まらない。
  const used = new Set<string>()
  for (const hit of matched) {
    for (const slip of hit.slips) used.add(slip.rowId)
  }
  const legs: IchibanLeg[] = []
  for (const d of drivers) {
    const coveredOrigins = new Set(d.rows.map(r => `${r.date}|${cityToPlace(addressToCity(r.originCity))}`))
    // **請求のみ (`請求K=1`) からは便を起こさない。** 走っていない請求行なので、
    // 便にすると存在しない仕事の売上と手当を「対象外」として数えてしまう。
    legs.push(...buildIchibanLegs(d.driverName, transportSlips(d.slips), used, coveredOrigins, ym, provisional))
  }
  return legs
}

/** 粗利の対象外になっている便の合計。**粗利の内訳とは足し合わせない額。** */
export interface UncoveredTotals {
  /** 便数 (運行ではない — 運行が無いからここに落ちている)。 */
  trips: number
  salesYen: number
  /** 確定 + 暫定。金額が決まらなかった便は 0 として数えない。 */
  allowanceYen: number
}

/**
 * 対象外の便を数える。**1 便も無ければ `null`** — 呼び出し側が**枠ごと出さない**ため。
 *
 * 「0 便 売上 ¥0」の行を常に出すと、**対象外が有る月と無い月の見分けが付かなくなる**
 * (人は 0 の行を読み飛ばす)。出ているときだけ意味がある枠にする。
 */
export function summarizeUncoveredLegs(legs: IchibanLeg[]): UncoveredTotals | null {
  if (legs.length === 0) return null
  const totals = summarizeIchibanLegs(legs)
  return { trips: totals.trips, salesYen: totals.salesYen, allowanceYen: totals.allowanceYen }
}

// --- 直前の集計のキャッシュ (localStorage) ---

/**
 * localStorage のキー。**形を変えるときは番号を上げる。**
 *
 * `v2` で**粗利の対象外の便の合計**を足した。`v1` を読めるようにしなかったのは、
 * 欄が無いキャッシュを「対象外 0 便」と読ませると、**この画面で直したかった誤解が
 * キャッシュ経路だけに残る**ため。読めない古いキャッシュは無かったことになり、
 * 一度 **集計** を押せば埋まる。
 *
 * `v3` で**走行km の内訳** (`kmBreakdown`) を足した。同じ理由で `v2` も読ませない —
 * 内訳の無い運行を画面が読むと、**内訳の欄で必ず落ちる** (必須フィールドなので
 * `undefined.preLoadKm` になる)。
 */
export const MARGIN_CACHE_KEY = 'dtako:margin:cache:v3'

/**
 * 直前の集計。**運行手当タブのキャッシュとはキーを分ける** — あちらは便と明細を
 * 生のまま持っていて、こちらは粗利の入力 (運行 1 本 = 1 行 + 経費) に畳んだ形。
 * 同じキーに 2 つの形を書くと、片方が相手のキャッシュを壊す。
 */
export interface MarginCache {
  ym: string
  /** ISO 文字列。画面に「いつ保存したか」を出す。 */
  savedAt: string
  operations: MarginOperationInput[]
  costs: CostRow[]
  /**
   * 粗利の対象外になっている便の合計。**1 便も無ければ null。**
   *
   * 便の元になる一番星の明細はキャッシュに持っていない (量が桁違い) ので、
   * **合計だけを畳んで持つ。** これが無いと、キャッシュから出したときだけ
   * 「対象外」の枠が消えて、また売上が合わない画面に戻る。
   */
  uncovered: UncoveredTotals | null
}

/**
 * 保存済みの集計を読む。**壊れていても投げない** — 無かったことにする。
 *
 * **最新かどうかは保証しない。** 保存後に取り込み直しがあれば古いままなので、
 * 「キャッシュから出している」ことを画面に出すのは呼び出し側の責務。
 */
export function parseMarginCache(raw: string | null | undefined): MarginCache | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const cache = parsed as Partial<MarginCache>
  if (typeof cache.ym !== 'string' || !Array.isArray(cache.operations) || !Array.isArray(cache.costs)) return null
  return {
    ym: cache.ym,
    savedAt: typeof cache.savedAt === 'string' ? cache.savedAt : '',
    operations: cache.operations,
    costs: cache.costs,
    // **null と「入っていない」を同じに倒す。** 対象外が 0 便の月は `null` で保存する。
    uncovered: typeof cache.uncovered === 'object' && cache.uncovered !== null ? cache.uncovered : null,
  }
}

export function serializeMarginCache(cache: MarginCache): string {
  return JSON.stringify(cache)
}
