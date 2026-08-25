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
 * 5. (2026-08-22) **「リース・保険・通信・車輌修繕は固定費だから総走行距離で割る。
 *    按分経費は主に燃費のはずで、売上前後の移動にかかる経費を載せたい」** —
 *    2 の距離按分は**「固定費按分」と名前を改め**、オーナーの言う「按分経費」は
 *    **回送 (売上が立たない移動) の燃料**として燃料代を割って見せる (`splitFuelYen`)。
 *    **粗利の額は 1 円も動かさない。分け方と見せ方だけを変える**
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
import type { AllowanceReportRow, CrossMonthLegs } from './allowance-report'
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
  /**
   * 備考 (rust-ichibanboshi#306 で追加)。**古い binary は返さない**ので optional —
   * `vendor_code` / `vendor_branch` / `entered_date` も同時に増えたが、画面で使うのは
   * `remarks` と `vendor_name` だけなのでここには 2 つだけ置く。
   */
  remarks?: string
  /** 未払先名 (支払先)。`remarks` と同じく rust-ichibanboshi#306。 */
  vendor_name?: string
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
  /**
   * 備考 (`remarks`)。実例は `ﾄﾞｰｼﾞﾝｸﾞﾕﾆｯﾄ交換` / `ﾀｲﾔ 4本`。**API に無ければ空文字**
   * (計算には使わない。直課経費の中身を title に出すためだけ。Refs #760 の 14)。
   */
  remarks: string
  /** 未払先名 (`vendor_name`)。実例は `三菱ふそう` / `トーヨータイヤ`。無ければ空文字。 */
  vendorName: string
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
    // **無ければ空文字に倒す。** 古い binary (#306 より前) や、この 2 列を返さない
    // 呼び出し元から来た行でも落ちないように。
    remarks: row.remarks ?? '',
    vendorName: row.vendor_name ?? '',
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

/**
 * 燃料代を **売上走行ぶん**と**回送ぶん**に割る (Refs #760 の 8)。
 *
 * オーナーの言う「按分経費 = 売上前後の移動にかかる経費」は、実体としては
 * **売上が立たない走行 (始業→積み・便間・降し→終業・分類不能) の燃料**。固定費
 * (リース・保険・通信・車輌修繕) の距離按分とは性質が違うので、同じ「按分経費」の
 * 欄に混ぜず、燃料代の方を 2 つに割って見せる。
 *
 * - `haul` = 燃料代 × 売上走行km ÷ **内訳の和**
 * - `deadhead` = 燃料代 − `haul` (**引き算で出す** — `haul + deadhead === fuelYen` が
 *   丸め誤差なしで必ず成り立つ)
 *
 * **分母は `totalKm` ではなく内訳 5 つの和。** 2 つは同じ値になるはず (`KmBreakdown`
 * の doc) だが、グループを変えて足し直しているぶんの丸め誤差があり、和を使えば
 * 比が 1 を超えない。
 *
 * **和が 0 なら両方 `null`。** `区間距離` の列が無い CSV では呼び出し側が `totalKm` に
 * 運行一覧の `total_distance` を入れる (内訳は 0 のまま) ので、**分けられない運行**が
 * 実在する。**黙って全部を売上走行に倒さない** — 回送が 0 km の運行に見えてしまう。
 */
export function splitFuelYen(
  fuelYen: number | null,
  km: KmBreakdown,
): { haul: number | null, deadhead: number | null } {
  const sum = km.preLoadKm + km.haulKm + km.betweenKm + km.postUnloadKm + km.otherKm
  if (fuelYen === null || sum <= 0) return { haul: null, deadhead: null }
  const haul = fuelYen * (km.haulKm / sum)
  return { haul, deadhead: fuelYen - haul }
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
 * **経費の按分には使わない** — 分子は今までどおり `totalKm`。
 *
 * ただし **`haulKm` だけは燃料代の分割に効く** (`splitFuelYen`。Refs #760 の 8) —
 * 燃料代を「売上走行ぶん」と「回送ぶん」に割るときの比。**粗利の額は動かない**
 * (引くのは分ける前の `fuelYen` のまま)。
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

/**
 * 便 1 本ぶんの粗利の入力 (Refs #760 の 13)。運行の売上・手当と同じ基準
 * (除外した便・対象月外の便は入れない) で、`rowsByUnko` が持つ便と 1 対 1。
 */
export interface MarginLegInput {
  /** `AllowanceReportRow.seq` (1 始まり、積みの順番 = `legKm` の index + 1)。 */
  seq: number
  date: string
  originCity: string
  destCity: string
  salesYen: number
  allowanceYen: number
  /** その便の売上走行km (`legKmDetail[seq-1].haulKm`)。 */
  haulKm: number
  /**
   * その便の回送km (`approachKm + tailKm + otherKm`)。**その便へ向かう移動**
   * (1 便目は積前、2 便目以降は直前の便間) に、最後の便だけ帰庫ぶんが乗る。
   */
  deadheadKm: number
  /**
   * その便の売上時間 (`legKmDetail[seq-1].haulSec`、秒)。**読めなければ null**
   * (0 に倒さない — 拘束時間比の配分をその運行だけ km 比に落とす判断に使う)。
   */
  haulSec: number | null
  /**
   * その便の回送時間 (`approachSec + tailSec`、秒)。どちらか読めなければ null。
   *
   * **`otherSec` は無い** — 降しの無い便の時間は `haulSec` が null になる形で既に
   * 「読めない」と表現されている。
   */
  deadheadSec: number | null
  /**
   * その便の売上に当たった一番星の明細の取引先 (Refs #760 の 15)。**`customersOfSlips`
   * で畳んだもの**で、`Σ yen === salesYen` (明細の `amount` を取引先で束ねただけ)。
   * 当たっていない便は `[]`。**運行の粗利にも便の収支にも 1 円も効かない** —
   * 取引先別の集計 (`summarizeByCustomerRoute`) の鍵にするだけ。
   */
  customers: LegCustomerShare[]
}

/** 便 1 本に当たった取引先 1 つぶん (`MarginLegInput.customers` の要素)。 */
export interface LegCustomerShare {
  /** `取引先C`。 */
  code: string
  /** 取引先名 (最初に見た明細のもの)。 */
  name: string
  /** その取引先の明細の `amount` の和 (円)。**便の売上のうちこの取引先ぶん。** */
  yen: number
}

/**
 * 便に当たった明細を取引先で畳む (Refs #760 の 15)。順は明細の初出順。
 *
 * **名前は最初に見たもの**を使う — 同じ `customerCode` で名前の表記が揺れても
 * 1 行にまとめる (鍵は `code`)。`amount` が 0 の明細も「当たった」ので落とさない。
 */
export function customersOfSlips(slips: Pick<VehicleDailySlip, 'customerCode' | 'customerName' | 'amount'>[]): LegCustomerShare[] {
  const byCode = new Map<string, LegCustomerShare>()
  for (const slip of slips) {
    const hit = byCode.get(slip.customerCode) ?? { code: slip.customerCode, name: slip.customerName, yen: 0 }
    hit.yen += slip.amount
    byCode.set(slip.customerCode, hit)
  }
  return [...byCode.values()]
}

/** 粗利を出す 1 運行ぶんの入力。売上・手当・距離は呼び出し側が既に持っている。 */
export interface MarginOperationInput {
  unkoNo: string
  /** 運行の日付 (`YYYY-MM-DD`)。**経費を直課する鍵**なので `経費明細.運行年月日` と同じ形。 */
  date: string
  driverName: string
  /** `車輌C` (4桁)。運行NO から取ったもの (`vehicleCodeFromUnkoNo`)。 */
  vehicleCode: string
  /**
   * その運行の走行距離 (`extractOperationIdle` の `totalKm` = タイムライン行だけの
   * Σ区間距離。重ね掛け行は入れない)。**`区間距離` の列が無い CSV では運行一覧の
   * `total_distance` を入れる** (呼び出し側の受け皿)。
   */
  totalKm: number
  /**
   * 運行一覧 (KUDGURI) の `総走行距離`。**按分には使わない** — `totalKm` と突き合わせて
   * 「区間距離の数え方が合っていない (未知のイベント名の疑い)」を画面で出すためだけ。
   * 運行一覧に無ければ null。
   */
  listedTotalKm: number | null
  /** `totalKm` の内訳。**按分には効かない** (画面と CSV に出すだけ)。 */
  kmBreakdown: KmBreakdown
  salesYen: number
  allowanceYen: number
  /**
   * 便ごとの入力 (Refs #760 の 13)。**運行の粗利には 1 円も効かない** — 便の段は
   * この入力から独立に出す (運行の燃料・按分の式は #770 のまま動かさない)。
   */
  legs: MarginLegInput[]
}

/** 運行 1 本の粗利。 */
export interface OperationMargin {
  unkoNo: string
  date: string
  driverName: string
  vehicleCode: string
  /** **按分の分子。** 画面に出して人が検算できるようにする。 */
  totalKm: number
  /** 運行一覧の `総走行距離`。`totalKm` との突き合わせ用 (`kmMismatch`)。 */
  listedTotalKm: number | null
  /**
   * **分子の中身。** 本番実測では `totalKm` の過半が非売上走行 (便間が最大) なので、
   * 分子を人が読めるように内訳を持ち回る (Refs #760)。**経費の按分の式には入らない**
   * (`haulKm` は燃料代の分割にだけ効く。`splitFuelYen`)。
   */
  kmBreakdown: KmBreakdown
  /** **按分の分母。** その月・その車輌の運行の走行距離の合計。 */
  vehicleTotalKm: number
  salesYen: number
  allowanceYen: number
  /** 燃料代。`FuelRate` が出せなければ null。**下の 2 つの和** (分けられれば)。 */
  fuelYen: number | null
  /**
   * **売上走行 (積み→降し) ぶんの燃料代。** `fuelYen × 売上走行km ÷ 内訳の和`。
   *
   * `fuelYen` が null のとき、および**内訳の和が 0 の運行** (`区間距離` の列が無い
   * CSV) は `null`。粗利には効かない (`fuelYen` を引いているだけ)。
   */
  fuelHaulYen: number | null
  /**
   * **回送 (始業→積み・便間・降し→終業・分類不能) ぶんの燃料代** = `fuelYen − fuelHaulYen`。
   *
   * オーナーの言う「売上前後の移動にかかる経費」。`fuelHaulYen` と同時に null になる。
   */
  fuelDeadheadYen: number | null
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
  /**
   * **拘束時間比を選んだのに、この運行だけ走行km比で配った** (Refs #760 の 22)。
   *
   * 便の秒 (`haulSec`/`deadheadSec`) が 1 便でも読めない運行と、秒の和が 0 の運行が
   * これになる。**黙って 0 円を配らない** — 落としたことを画面に出すためのフラグ。
   * 走行km比・便数比を選んでいるときは常に `false`。
   */
  runCostShareFallback: boolean
  /**
   * 便ごとの粗利 (Refs #760 の 13)。**運行の `fuelYen`/`marginYen` には 1 円も
   * 効かない** — 直課経費・固定費按分は便に割らず、運行の段に残す (便の収支は
   * 「売上 − 手当 − 燃料」であって粗利ではない)。便が揃っている運行では
   * `Σ fuelDeadheadYen ≈ 運行の fuelDeadheadYen` (丸めの範囲)。**除外・対象月外で
   * 便が欠ける運行や、便の無い運行では一致しない** — 正常。
   */
  legs: LegMargin[]
}

/** 便 1 本ぶんの粗利 (`OperationMargin.legs` の要素)。 */
export interface LegMargin {
  seq: number
  date: string
  originCity: string
  destCity: string
  salesYen: number
  allowanceYen: number
  haulKm: number
  deadheadKm: number
  /** 売上走行ぶんの燃料代 = `haulKm ÷ kmPerLiter × yenPerLiter`。`FuelRate` が無ければ null。 */
  fuelHaulYen: number | null
  /** 回送 (その便へ向かう移動) ぶんの燃料代。`fuelHaulYen` と同時に null になる。 */
  fuelDeadheadYen: number | null
  /**
   * その便の収支 = 売上 − 手当 − 燃料 (売上走行 + 回送)。**粗利ではない** —
   * 直課経費・固定費按分は便に割らず運行の段に残す。`FuelRate` が無ければ null。
   */
  marginYen: number | null
  /** 便の売上に当たった取引先 (`MarginLegInput.customers` をそのまま運ぶ)。 */
  customers: LegCustomerShare[]
  /**
   * **運行の経費 (直課 + 固定費按分) のうち、この便に配った額** (Refs #760 の 15)
   * = `(directCostYen + allocatedCostYen) × この便の重み`。**重みは `RunCostShareMode`
   * で切り替わる** (走行km比 / 便数比 / 拘束時間比。Refs #760 の 22) が、どのモードでも
   * **Σ (運行の全便) = 運行の経費**は変わらない (配れる運行なら重みの和が 1)。
   *
   * 走行km比で分母 (便の走行km の和) が 0 なら 0 — **配れない運行の経費は便に載らない**
   * (`summarizeByCustomerRoute` の検算で差として見える。黙って全便に均等には割らない)。
   * **便の無い運行の経費も便に載らない** (`noLegOperations` に残す)。
   * `marginYen` (収支) とは違って**運行の `marginYen` が null でも 0 ではなく額を持つ**
   * (経費は配れる。粗利が出せないのは燃料の側の事情)。
   */
  runCostShareYen: number
  /**
   * **便の粗利** = `marginYen − runCostShareYen`。**運行の粗利が出せない運行
   * (`OperationMargin.marginYen === null`) の便は null** — 燃費が出せない運行は
   * `marginYen` も null だが、**経費を 1 件も持たない運行 (`costsMissing`) は便の収支が
   * 出ていても粗利は出さない** (運行の段と同じ判断。売上そのままが粗利に見えるため)。
   *
   * 不変条件: 便が揃っている運行で `Σ grossMarginYen ≈ 運行の marginYen` (|差| < 1 円)。
   */
  grossMarginYen: number | null
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

/**
 * 按分に回した経費 1 行 (**画面で中身を見せるためだけ**。計算には使わない)。
 *
 * 「固定費按分」の欄に何が入っているのかが分からないと、人は数字を信用できない。
 * 実例 (2026-07 / 車1109) は **固定費 ¥79,690 (リース・任意保険・デジタコ通信費) +
 * 07-24 の車輌修繕費 ¥97,195** で、後者は `isFixed=false` の変動費が
 * **その日に運行が無かったので直課できず按分に回った**もの。**性質が違う 2 つが
 * 同じ額に畳まれている**ので、`isFixed` で区別できる形で持ち回る。
 */
export interface FixedPoolRow {
  /** `運行年月日`。固定費は月初などの計上日で、直課できなかった変動費は走った日。 */
  date: string
  costKindName: string
  costName: string
  /** 実額 (`costYen` = 税抜金額 + 軽油引取税)。 */
  yen: number
  /** `true` = 月極めの固定費 / `false` = 直課できなかった変動費。 */
  isFixed: boolean
}

/**
 * 運行に直課した経費 1 行 (**画面で中身を見せるためだけ**。計算には使わない。Refs #760 の 14)。
 *
 * `FixedPoolRow` の直課版。実例 (2026-07 / 車輌1420 07-13) は
 * **一般修理費 ¥206,060 `ﾄﾞｰｼﾞﾝｸﾞﾕﾆｯﾄ交換` (三菱ふそう)** で、備考と支払先が無いと
 * 「修繕費 20 万」が何の修理だったのか画面から辿れない。
 */
export interface DirectCostRow {
  /** `運行年月日` (= 直課した運行の日)。 */
  date: string
  costKindName: string
  costName: string
  /**
   * **その運行に乗った額** (`costYen` = 税抜金額 + 軽油引取税)。同じ日・同じ車輌に
   * 運行が 2 本あって距離比で割ったときは、**割った後の額** (行の全額ではない)。
   */
  yen: number
  /** 備考。無ければ空文字。 */
  remarks: string
  /** 未払先名。無ければ空文字。 */
  vendorName: string
}

/** 経費の一群を運行へ配った結果 (添字は渡した運行と同じ)。 */
interface Spread {
  /** 日・車輌が一致する変動費として直課した額。 */
  direct: number[]
  /** 距離比で按分した額。 */
  allocated: number[]
  /** **どの運行にも配れなかった額。** 黙って消さずに数える。 */
  dropped: number
  /**
   * 車輌C → 按分に回した行の一覧。**`pool` と 1 対 1** (配れずに `dropped` へ
   * 落ちたぶんも残る — 「按分に回した」ことは同じで、見せる先が無いだけ)。
   */
  poolRows: Map<string, FixedPoolRow[]>
  /** 運行NO → 直課した行の一覧。**`direct` と 1 対 1** (額の和が `direct[i]`)。 */
  directRows: Map<string, DirectCostRow[]>
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
  /** 同じものの**行の一覧**。額は `pool` が正で、こちらは画面に中身を出すため。 */
  const poolRows = new Map<string, FixedPoolRow[]>()
  /** 直課した行の一覧 (運行NO 別)。額は `direct` が正で、こちらは画面に中身を出すため。 */
  const directRows = new Map<string, DirectCostRow[]>()
  for (const row of rows) {
    const yen = costYen(row)
    const hits = row.isFixed ? [] : (byDayVehicle.get(`${row.operationDate}|${row.vehicleNumber}`) ?? [])
    const hitKm = hits.reduce((sum, i) => sum + ops[i]!.totalKm, 0)
    if (hits.length > 0 && hitKm > 0) {
      for (const i of hits) {
        // **同じ式のまま。** 行に残す額も、`direct` に足す額と同じ値 (按分後)。
        const share = yen * (ops[i]!.totalKm / hitKm)
        direct[i]! += share
        const list = directRows.get(ops[i]!.unkoNo) ?? []
        list.push({
          date: row.operationDate,
          costKindName: row.costKindName,
          costName: row.costName,
          yen: share,
          remarks: row.remarks,
          vendorName: row.vendorName,
        })
        directRows.set(ops[i]!.unkoNo, list)
      }
      continue
    }
    pool.set(row.vehicleNumber, (pool.get(row.vehicleNumber) ?? 0) + yen)
    const list = poolRows.get(row.vehicleNumber) ?? []
    list.push({ date: row.operationDate, costKindName: row.costKindName, costName: row.costName, yen, isFixed: row.isFixed })
    poolRows.set(row.vehicleNumber, list)
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

  return { direct, allocated, dropped, poolRows, directRows }
}

export interface MarginResult {
  /** 運行ごとの粗利 (渡した順のまま)。 */
  operations: OperationMargin[]
  /**
   * **拘束時間比を選んだのに走行km比で配った運行の数** (Refs #760 の 22)。
   * 走行km比・便数比では常に 0。画面に注記を出すためだけの値。
   */
  runCostShareFallbackOperations: number
  /** 車輌C → 実際に使った燃費・単価 (上書き後)。画面の欄に出す。 */
  ratesByVehicle: Map<string, FuelRate>
  /** 車輌C → 実績から出した燃費・単価 (上書き前)。「既定値は実績」を見せるため。 */
  derivedByVehicle: Map<string, FuelRate>
  /** 車輌C → 月の走行距離合計 (= **按分の分母**)。 */
  kmByVehicle: Map<string, number>
  /**
   * 車輌C → **固定費按分の中身** (按分に回した経費の行)。
   *
   * 額は `allocatedCostYen` が正で、これは画面の title に列挙するためだけ。
   * **人件費 (`08`/`11`) は入らない** — 粗利の経費だけを配った側の pool。
   */
  fixedPoolByVehicle: Map<string, FixedPoolRow[]>
  /**
   * 運行NO → **直課経費の中身** (日・車輌が一致して直課した変動費の行)。
   *
   * 額は `directCostYen` が正で、これは画面の title に列挙するためだけ
   * (`fixedPoolByVehicle` と同じ方式。Refs #760 の 14)。**人件費は入らない。**
   * 直課した行が 1 本も無い運行はキーそのものが無い。
   */
  directRowsByUnko: Map<string, DirectCostRow[]>
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
 * **運行経費 (直課 + 固定費按分) を便に配る比** (Refs #760 の 22)。
 *
 * 走行km比だと**短距離便がほとんど固定費を負担しない** (2026-07 帯広 5 台の実測で、
 * 粗利率 55% 以上の短距離経路は配分が売上の 1%、他は 11%)。按分の方法で粗利率の
 * 見え方がどれだけ変わるかを人が確かめられるように、比を切り替えられるようにする。
 *
 * **どのモードでも運行の段 (`marginYen` 等) は 1 円も動かない** — 配り方を変えるのは
 * 便の `runCostShareYen` と、そこから出る取引先 × 経路の粗利だけ。
 */
export type RunCostShareMode = 'km' | 'legs' | 'time'

/** 画面の select と CSV のファイル名に使う名前。 */
export const RUN_COST_SHARE_MODE_LABELS: Record<RunCostShareMode, string> = {
  km: '走行km比',
  legs: '便数比',
  time: '拘束時間比',
}

/** `RunCostShareMode` の既定 (今までの挙動)。 */
export const DEFAULT_RUN_COST_SHARE_MODE: RunCostShareMode = 'km'

/**
 * 保存してある配分モードを読む (localStorage)。**知らない値・空は既定 (走行km比)**。
 *
 * 落ちない — 読めない値で画面が出なくなるより、既定に戻る方がまし。
 */
export function parseRunCostShareMode(raw: string | null | undefined): RunCostShareMode {
  return raw === 'legs' || raw === 'time' ? raw : DEFAULT_RUN_COST_SHARE_MODE
}

/** 便 1 本ぶんの拘束秒 = 売上時間 + 回送時間。どちらか読めなければ null。 */
function legSecOf(leg: MarginLegInput): number | null {
  return leg.haulSec === null || leg.deadheadSec === null ? null : leg.haulSec + leg.deadheadSec
}

/** 便の走行km (売上走行 + 回送) の比。**和が 0 の運行は配らない (全部 0)** — #770 からの挙動。 */
function kmShareWeights(legs: MarginLegInput[]): number[] {
  const total = legs.reduce((sum, leg) => sum + leg.haulKm + leg.deadheadKm, 0)
  return legs.map(leg => (total > 0 ? (leg.haulKm + leg.deadheadKm) / total : 0))
}

/**
 * 運行の経費を便に配る重み (`Σ = 1`。配れない運行だけ全部 0)。
 *
 * - `km` — 便の走行km (売上走行 + 回送) の比。**分母 0 の運行は配らない** (据え置き)
 * - `legs` — 便数の比 (`1 ÷ 便数`)。距離も時間も見ない
 * - `time` — 便の拘束時間 (売上時間 + 回送時間) の比。**1 便でも秒が読めない運行と、
 *   秒の和が 0 の運行は走行km比に落とす** (`fallback`)。0 円を黙って配らない
 *
 * **便の無い運行はどのモードでも配る先が無い** ので `fallback` にも数えない
 * (数えると「拘束時間が取れない運行」の件数に、時間と関係のない運行が混ざる)。
 */
function legShareWeights(legs: MarginLegInput[], mode: RunCostShareMode): { weights: number[], fallback: boolean } {
  if (legs.length === 0) return { weights: [], fallback: false }
  if (mode === 'legs') return { weights: legs.map(() => 1 / legs.length), fallback: false }
  if (mode === 'time') {
    const secs = legs.map(legSecOf)
    const total = secs.reduce((sum: number, sec) => sum + (sec ?? 0), 0)
    if (!secs.includes(null) && total > 0) return { weights: secs.map(sec => sec! / total), fallback: false }
    return { weights: kmShareWeights(legs), fallback: true }
  }
  return { weights: kmShareWeights(legs), fallback: false }
}

/**
 * 便ごとの粗利を出す (Refs #760 の 13)。**運行と同じ `fuelRate` (単価・燃費)** を使う —
 * 便だけ別の単価で出すと、Σ便の燃料代が運行の燃料代からずれる理由が「便が違う単価を
 * 使っているから」になり、検算できなくなる。
 *
 * 直課経費・固定費按分は便に割らない (運行の段に残す)。**`marginYen` は粗利ではなく
 * 「売上 − 手当 − 燃料」の収支**。
 *
 * ただし取引先別の集計 (Refs #760 の 15) のために、**運行の経費 (直課 + 固定費按分)
 * を `mode` の比で便に配った `runCostShareYen`** と、それを収支から引いた
 * **`grossMarginYen` (便の粗利)** も持たせる。`runCostYen` は運行の
 * `directCostYen + allocatedCostYen`、`opMarginYen` は運行の `marginYen`
 * (null なら便の粗利も null)。**運行の段の数字には 1 円も効かない。**
 *
 * `mode` は既定が今までどおり走行km比 (Refs #760 の 22)。**拘束時間比を選んでも秒が
 * 読めない運行は走行km比に落とし**、落としたことを `runCostShareFallback` で返す。
 */
function buildLegMargins(
  legs: MarginLegInput[],
  fuelRate: FuelRate,
  runCostYen: number,
  opMarginYen: number | null,
  mode: RunCostShareMode = 'km',
): { legs: LegMargin[], runCostShareFallback: boolean } {
  const share = legShareWeights(legs, mode)
  const built = legs.map((leg, i) => {
    const fuelHaulYen = fuelYenFor(leg.haulKm, fuelRate)
    const fuelDeadheadYen = fuelYenFor(leg.deadheadKm, fuelRate)
    // **燃料代が出せなければ収支も出さない。** `fuelHaulYen`/`fuelDeadheadYen` は
    // 同じ `fuelRate` から出るので同時に null になる — `fuelYenFor` が null を返すのは
    // `rate` の 2 つのどちらかが null のときだけで、**km には依らない**。だから
    // `fuelDeadheadYen === null` を別に見ない (見ると通らない枝が残る。Refs #842)。
    const marginYen = fuelHaulYen === null
      ? null
      : leg.salesYen - leg.allowanceYen - fuelHaulYen - fuelDeadheadYen!
    // **重みの和が 1 なので Σ = 運行の経費。** どのモードでも同じ (配れない運行は全部 0)。
    // 重み 0 は `runCostYen * 0` にしない — 経費が負の運行で `-0` になり、画面に
    // 「¥-0」と出る (`Math.round(-0).toLocaleString()`)。
    const weight = share.weights[i]!
    const runCostShareYen = weight === 0 ? 0 : runCostYen * weight
    return {
      seq: leg.seq,
      date: leg.date,
      originCity: leg.originCity,
      destCity: leg.destCity,
      salesYen: leg.salesYen,
      allowanceYen: leg.allowanceYen,
      haulKm: leg.haulKm,
      deadheadKm: leg.deadheadKm,
      fuelHaulYen,
      fuelDeadheadYen,
      marginYen,
      customers: leg.customers,
      runCostShareYen,
      // **運行の粗利が null なら便の粗利も null。** 運行の `marginYen` が非 null なら
      // `fuelRate` は出せている (= 便の `marginYen` も非 null) ので、ここで便の
      // `marginYen` の null を別に見る必要は無い (見ると通らない枝が残る)。
      grossMarginYen: opMarginYen === null ? null : marginYen! - runCostShareYen,
    }
  })
  return { legs: built, runCostShareFallback: share.fallback }
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
  runCostShareMode: RunCostShareMode = 'km',
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
    // **粗利は `fuelYen` から出す。** 分けた 2 つは見せるためだけで、和は `fuelYen`
    // に一致する (分けられない運行は両方 null)。
    const fuelSplit = splitFuelYen(fuelYen, op.kmBreakdown)
    const directCostYen = spreadCost.direct[i]!
    const allocatedCostYen = spreadCost.allocated[i]!
    const costsMissing = (costCountByVehicle.get(op.vehicleCode) ?? 0) === 0
    // **燃費が出せない運行と、経費を 1 件も持っていない運行は粗利を出さない。**
    const marginYen = fuelYen === null || costsMissing
      ? null
      : marginOf(op.salesYen, op.allowanceYen, fuelYen, directCostYen, allocatedCostYen)
    // 便には運行の経費 (直課 + 固定費按分) を `runCostShareMode` の比で配る
    // (Refs #760 の 15・22)。**運行の段の数字には 1 円も効かない。**
    const legShare = buildLegMargins(op.legs, fuelRate, directCostYen + allocatedCostYen, marginYen, runCostShareMode)
    return {
      unkoNo: op.unkoNo,
      date: op.date,
      driverName: op.driverName,
      vehicleCode: op.vehicleCode,
      totalKm: op.totalKm,
      listedTotalKm: op.listedTotalKm,
      kmBreakdown: op.kmBreakdown,
      vehicleTotalKm: kmByVehicle.get(op.vehicleCode)!,
      salesYen: op.salesYen,
      allowanceYen: op.allowanceYen,
      fuelYen,
      fuelHaulYen: fuelSplit.haul,
      fuelDeadheadYen: fuelSplit.deadhead,
      directCostYen,
      allocatedCostYen,
      marginYen,
      laborYen: spreadLabor.direct[i]! + spreadLabor.allocated[i]!,
      fuelRate,
      costsMissing,
      runCostShareFallback: legShare.runCostShareFallback,
      legs: legShare.legs,
    }
  })

  return {
    operations,
    runCostShareFallbackOperations: operations.filter(m => m.runCostShareFallback).length,
    ratesByVehicle,
    derivedByVehicle,
    kmByVehicle,
    fixedPoolByVehicle: spreadCost.poolRows,
    directRowsByUnko: spreadCost.directRows,
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
/**
 * CSV から数えた走行距離 (`totalKm`) と運行一覧の `総走行距離` (`listedTotalKm`) の
 * ずれを **0.1km 以上**で検出する。
 *
 * 2 つは同じ値になるはず (`DISTANCE_EVENT_NAMES` の和 = KUDGURI。90 運行で全件一致)。
 * ずれるのは**区間距離の数え方が合っていない** (新しいイベント名が増えて「数えない」
 * 側に落ちた等) ときなので、画面に注意を出す。**運行一覧に値が無ければ比べない** (null)。
 *
 * **`区間距離` の列が無い CSV は呼び出し側が `totalKm` に `total_distance` を入れる**
 * (ずれ 0 になる) ので、ここで「列が無い」を区別する必要は無い。
 */
export function kmMismatch(m: Pick<OperationMargin, 'totalKm' | 'listedTotalKm'>): boolean {
  return m.listedTotalKm !== null && Math.abs(m.totalKm - m.listedTotalKm) >= 0.1
}

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
 *  === marginYen` が**必ず成り立つ**。燃料代の分割 (`fuelHaulYen` /
 * `fuelDeadheadYen` / `fuelUnsplitYen`) も `fuelYen` の内訳なので、
 * **3 つの和 === `fuelYen`** が成り立つ (Refs #760 の 8)。
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
  /** 粗利を出せた運行ぶんの燃料代。**下の 3 つの和** (不変条件)。 */
  fuelYen: number
  /** そのうち**売上走行 (積み→降し) ぶん**。 */
  fuelHaulYen: number
  /** そのうち**回送ぶん** (始業→積み・便間・降し→終業・分類不能)。 */
  fuelDeadheadYen: number
  /**
   * **売上走行と回送に分けられなかった運行の燃料代。**
   *
   * `区間距離` の列が無い CSV で来た運行 (内訳の和が 0)。**0 に倒さず数える** —
   * 足し忘れると `fuelHaulYen + fuelDeadheadYen` が `fuelYen` より小さくなり、
   * 画面の引き算が合わなくなる。
   */
  fuelUnsplitYen: number
  /** 粗利を出せた運行ぶんの直課経費。 */
  directCostYen: number
  /** 粗利を出せた運行ぶんの**固定費按分** (固定費 + 直課できなかった経費の距離按分)。 */
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
    fuelHaulYen: 0,
    fuelDeadheadYen: 0,
    fuelUnsplitYen: 0,
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
    // **分けられた運行だけ 2 つに足し、分けられない運行は `fuelUnsplitYen` へ。**
    // `fuelYen === fuelHaulYen + fuelDeadheadYen + fuelUnsplitYen` を保つ。
    const haul = m.fuelHaulYen
    if (haul === null) totals.fuelUnsplitYen += fuelYen
    else {
      totals.fuelHaulYen += haul
      // `fuelHaulYen` が非 null なら `fuelDeadheadYen` も非 null (`splitFuelYen` が
      // 同時に決める)。受け皿を置くと通らない枝が残る。
      totals.fuelDeadheadYen += m.fuelDeadheadYen!
    }
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

// --- 直課経費の中身 (title) ---

/**
 * title 用の金額表記。画面のセル (`margin.vue` の `yen`) と同じ丸めと桁区切り。
 * **`+ 0` で `-0` を `+0` に畳む** (Refs #843)。直課の 1 行は
 * `costYen(row) * (totalKm / hitKm)` の**按分後の端数つき**で、経費は負になり得る
 * (上の `buildLegMargins` が `runCostYen * 0` を避けているのと同じ事情) ため、
 * ちょうど 0 の行が `-4.66e-10` のような**尾つきの負**になる。`Math.round` はそれを
 * `-0` にし、`(-0).toLocaleString()` が **`"-0"`** を出すので title に `¥-0` と載っていた。
 * `-0.6` は `¥-1` のまま (本当に負の経費は負のまま出る)。
 */
function titleYen(v: number): string {
  return `¥${(Math.round(v) + 0).toLocaleString()}`
}

/**
 * 直課した 1 行の見せ方: `一般修理費 ¥206,060 ﾄﾞｰｼﾞﾝｸﾞﾕﾆｯﾄ交換 (三菱ふそう)`。
 * **備考が空なら省く、支払先が空なら括弧ごと省く** (空の括弧を出さない)。
 */
function directRowLabel(r: DirectCostRow): string {
  return `${r.costName} ${titleYen(r.yen)}`
    + (r.remarks ? ` ${r.remarks}` : '')
    + (r.vendorName ? ` (${r.vendorName})` : '')
}

/** 直課した行が 1 本も無いときの title。 */
export const NO_DIRECT_COST_TITLE = '直課経費なし'

/** 乗務員行の title に列挙する上位の行数 (金額の大きい順)。残りは「…他 N 行」に畳む。 */
export const DIRECT_COST_TITLE_TOP = 10

/**
 * **運行行**の直課経費セルの title (Refs #760 の 14)。
 *
 * 頭に「どの運行に、どういう基準で乗せたか」を書いて、固定費按分と取り違えないようにする。
 * 行は直課した順 (= 経費明細の順) のまま。
 */
export function operationDirectCostTitle(m: OperationMargin, byUnko: Map<string, DirectCostRow[]>): string {
  const rows = byUnko.get(m.unkoNo) ?? []
  if (rows.length === 0) return NO_DIRECT_COST_TITLE
  return `直課経費の中身 — 運行 ${m.date} 車輌${m.vehicleCode} (日・車輌が一致した変動費)\n`
    + rows.map(directRowLabel).join('\n')
}

/**
 * **乗務員行**の直課経費セルの title (Refs #760 の 14)。
 *
 * 運行が十数本あると行が多すぎて読めないので、**経費種別ごとの合計と件数**を先に出し、
 * そのあと**金額の大きい順に上位 `DIRECT_COST_TITLE_TOP` 行**だけ (日付付きで) 並べる。
 * 種別も金額の大きい順。同額は元の順 (sort は安定)。
 */
export function driverDirectCostTitle(d: DriverMargin, byUnko: Map<string, DirectCostRow[]>): string {
  const rows = d.operations.flatMap(m => byUnko.get(m.unkoNo) ?? [])
  if (rows.length === 0) return NO_DIRECT_COST_TITLE
  const byKind = new Map<string, { yen: number, count: number }>()
  for (const r of rows) {
    const entry = byKind.get(r.costKindName) ?? { yen: 0, count: 0 }
    entry.yen += r.yen
    entry.count += 1
    byKind.set(r.costKindName, entry)
  }
  const kinds = [...byKind.entries()]
    .sort((a, b) => b[1].yen - a[1].yen)
    // `cost_kind_name` をそのまま出す。実値は **既に「車輌修繕費(変動)」の形** (経費種別ﾏｽﾀ)
    // なので、ここで「(変動)」を後付けすると二重になる。
    .map(([kind, e]) => `${kind} ${titleYen(e.yen)} (${e.count} 件)`)
  const sorted = [...rows].sort((a, b) => b.yen - a.yen)
  const top = sorted.slice(0, DIRECT_COST_TITLE_TOP).map(r => `${r.date.slice(5)} ${directRowLabel(r)}`)
  const rest = sorted.length - top.length
  const lines = [`直課経費の中身 — ${d.driverName} の ${d.operations.length} 運行ぶん`, ...kinds, ...top]
  if (rest > 0) lines.push(`…他 ${rest} 行`)
  return lines.join('\n')
}

// --- CSV ---

const CSV_HEADER = [
  '運行NO', '日付', '乗務員', '車輌C', '走行km',
  '始業→積みkm', '売上走行km', '便間km', '降し→終業km', '分類不能km',
  '月・車輌の走行km', '売上', '手当',
  '燃料代', '燃料代(売上走行)', '燃料代(回送=按分)',
  '直課経費', '固定費按分', '粗利', '粗利率', '粗利が出せない理由',
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
      m.salesYen, m.allowanceYen,
      round(m.fuelYen), round(m.fuelHaulYen), round(m.fuelDeadheadYen), round(m.directCostYen),
      round(m.allocatedCostYen), round(m.marginYen), rate(marginRate(m)), noMarginReason(m),
      round(m.laborYen), round(m.fuelRate.yenPerLiter), round(m.fuelRate.kmPerLiter),
    ].map(quote).join(',')),
  ]
}

const LEG_CSV_HEADER = [
  '運行NO', '日付', '乗務員', '車輌C', '便', '積地', '卸地',
  '売上走行km', '回送km', '売上', '手当', '燃料代(売上走行)', '回送燃料', '便の収支',
]

/**
 * 便 1 行ずつの粗利 CSV (Refs #760 の 13)。**運行の CSV とは別の関数** — 運行の
 * `marginCsvLines` はここでは触らない。値にカンマが入りうるので必ず引用する。
 */
export function marginLegCsvLines(margins: OperationMargin[]): string[] {
  const quote = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const round = (v: number | null) => (v === null ? '' : Math.round(v))
  return [
    LEG_CSV_HEADER.map(quote).join(','),
    ...margins.flatMap(m => m.legs.map(leg => [
      m.unkoNo, leg.date, m.driverName, m.vehicleCode, leg.seq, leg.originCity, leg.destCity,
      round(leg.haulKm), round(leg.deadheadKm), leg.salesYen, leg.allowanceYen,
      round(leg.fuelHaulYen), round(leg.fuelDeadheadYen), round(leg.marginYen),
    ].map(quote).join(','))),
  ]
}

// --- 取引先別 × 経路別 (Refs #760 の 15) ---

/** 一番星の明細が 1 件も当たっていない便を束ねる取引先の名前。`code` は空文字。 */
export const NO_CUSTOMER_NAME = '(突合なし)'

/** 積地・卸地が空の便の経路の端。 */
export const UNKNOWN_PLACE = '(不明)'

/**
 * 経路の端の正規化。**運行手当タブの「広尾 → 富士」と同じ語彙**
 * (`cityToPlace(addressToCity(city))` = 手当マスタの引き方)。空なら `(不明)`。
 */
export function routePlace(city: string): string {
  const place = cityToPlace(addressToCity(city))
  return place === '' ? UNKNOWN_PLACE : place
}

/**
 * 取引先の行・経路の行に共通の列。
 *
 * **2 段に分かれている** (`MarginTotals` と同じ流儀)。`legs` 〜 `deadheadKm` は
 * **束ねた便ぜんぶ**、`fuelHaulYen` 〜 `grossMarginYen` は**粗利を出せた便ぶんだけ**
 * (`LegMargin.grossMarginYen` が null の便 = 運行の粗利が出せない便は入れない)。
 * 混ぜると「売上 − 手当 − 燃料 − 経費配分 が粗利と合わない」行になる。
 *
 * **2 取引先に当たった便は売上の比で割って両方に足す** (便数だけは両方に 1 ずつ)。
 */
export interface CustomerRouteTotals {
  /** 便数 (**ぜんぶ**)。2 取引先に当たった便はどちらにも 1 と数える。 */
  legs: number
  /** そのうち粗利を出せなかった便の数 (運行の粗利が null)。下 4 列に入っていない便。 */
  unsplitLegs: number
  salesYen: number
  allowanceYen: number
  haulKm: number
  deadheadKm: number
  /** 売上走行ぶんの燃料代 (粗利を出せた便ぶん)。 */
  fuelHaulYen: number
  /** 回送ぶんの燃料代 (粗利を出せた便ぶん)。 */
  fuelDeadheadYen: number
  /** 運行の経費 (直課 + 固定費按分) のうち便に配られた額 (粗利を出せた便ぶん)。 */
  runCostShareYen: number
  /**
   * 粗利 = Σ `LegMargin.grossMarginYen` (null の便を除く)。**1 便も出せなければ null**
   * (0 にすると「粗利 0 円」と読める。出せない便の数は `unsplitLegs`)。
   */
  grossMarginYen: number | null
}

/**
 * その行に入っている便 1 本の**居場所** (Refs #760 の 19)。行の数字には効かない —
 * 画面が「この経路の便を全部重ねた地図」を描くときに、どの運行のイベントCSV を引いて
 * どの便を残すかを知るためだけに持つ。
 *
 * **2 取引先に当たった便は両方の取引先 (と経路) に入る** (`legs` の数え方と同じ)。
 * CSV (`customerRouteCsvLines`) には出さない。
 */
export interface LegRef {
  unkoNo: string
  /** `LegMargin.seq` (1 始まり)。`OperationRoute.segments[].legSeq` と同じ番号。 */
  seq: number
}

/** 経路 1 本 (積地 → 卸地) の行。 */
export interface RouteSummary extends CustomerRouteTotals {
  /** 積地 (`routePlace(originCity)`)。 */
  from: string
  /** 卸地 (`routePlace(destCity)`)。 */
  to: string
  /** この経路に入っている便 (行の数字には効かない。地図用)。 */
  legRefs: LegRef[]
}

/** 取引先 1 つの行。`routes` は売上の降順。 */
export interface CustomerSummary extends CustomerRouteTotals {
  code: string
  name: string
  routes: RouteSummary[]
  /** この取引先に入っている便 (全経路ぶん。行の数字には効かない。地図用)。 */
  legRefs: LegRef[]
}

/**
 * **便の無い運行**の合計。便が無いので取引先にも経路にも結べない — 別に出して、
 * 取引先別の粗利と足せば粗利タブの粗利に戻るようにする。
 *
 * `operations` / `salesYen` / `allowanceYen` は**ぜんぶ**、`fuelYen` 〜 `marginYen` は
 * **粗利を出せた運行ぶんだけ** (`MarginTotals` と同じ 2 段)。
 */
export interface NoLegOperationTotals {
  operations: number
  salesYen: number
  allowanceYen: number
  fuelYen: number
  directCostYen: number
  allocatedCostYen: number
  marginYen: number
}

export interface CustomerRouteSummary {
  /** 取引先 (売上の降順)。 */
  customers: CustomerSummary[]
  noLegOperations: NoLegOperationTotals
  /**
   * **粗利が出せない便** (運行の粗利が null) の数と売上。取引先の行の `legs`/`salesYen`
   * には入っているが、`grossMarginYen` には入っていない。2 取引先の便も 1 と数える。
   */
  unsplitLegs: { legs: number, salesYen: number }
  /** 粗利タブの粗利 (`summarizeMargins(margins).marginYen`)。検算の右辺。 */
  totalMarginYen: number
  /**
   * 検算の差 = `totalMarginYen − (Σ取引先.grossMarginYen + noLegOperations.marginYen)`。
   * **全便が揃っている月は 0** (|差| < 1 円)。便の走行km が取れていない運行
   * (`区間距離` の列が無い CSV で便の km が 0) があると、運行の燃料と Σ便の燃料が
   * ずれるぶんだけ差が出る — 画面は amber で出す。
   */
  diffYen: number
}

function emptyCustomerRouteTotals(): CustomerRouteTotals {
  return {
    legs: 0,
    unsplitLegs: 0,
    salesYen: 0,
    allowanceYen: 0,
    haulKm: 0,
    deadheadKm: 0,
    fuelHaulYen: 0,
    fuelDeadheadYen: 0,
    runCostShareYen: 0,
    grossMarginYen: null,
  }
}

/**
 * 便の取引先と、その便の額をどの比で分けるか。
 *
 * - 当たっていない便 (`customers` が空) は `(突合なし)` に全額
 * - 通常は 1 取引先で比 1
 * - 2 取引先以上は `yen` の比。**`yen` の和が 0 なら等分** (当たった明細が全部 0 円 —
 *   実データでは見ていないが、0 で割って NaN を粗利に混ぜない)
 */
function customerWeights(customers: LegCustomerShare[]): { code: string, name: string, weight: number }[] {
  if (customers.length === 0) return [{ code: '', name: NO_CUSTOMER_NAME, weight: 1 }]
  const total = customers.reduce((sum, c) => sum + c.yen, 0)
  return customers.map(c => ({
    code: c.code,
    name: c.name,
    weight: total > 0 ? c.yen / total : 1 / customers.length,
  }))
}

/** 便 1 本を比 `weight` で行に足す。 */
function addLegTo(t: CustomerRouteTotals, l: LegMargin, weight: number): void {
  t.legs += 1
  t.salesYen += l.salesYen * weight
  t.allowanceYen += l.allowanceYen * weight
  t.haulKm += l.haulKm * weight
  t.deadheadKm += l.deadheadKm * weight
  if (l.grossMarginYen === null) {
    t.unsplitLegs += 1
    return
  }
  // `grossMarginYen` が非 null なら燃料代も非 null (`buildLegMargins` の仕様)。
  t.fuelHaulYen += l.fuelHaulYen! * weight
  t.fuelDeadheadYen += l.fuelDeadheadYen! * weight
  t.runCostShareYen += l.runCostShareYen * weight
  t.grossMarginYen = (t.grossMarginYen ?? 0) + l.grossMarginYen * weight
}

/**
 * 便を**一番星の取引先**で束ね、取引先の中を**経路 (積地 → 卸地)** で束ねる (Refs #760 の 15)。
 *
 * オーナー: 「取引先毎の利益率の集計 + 運行経路毎の集計。同じ取引先でも何個か組み合わせで
 * 経路ができているはずで、どこから出発・どこで終了で経費・粗利が変わるはず」。
 *
 * - 取引先 = 便の売上に当たった明細の `取引先C` (`LegMargin.customers`)。当たっていない
 *   便は `(突合なし)`。2 取引先に当たった便は売上の比で分ける
 * - 経路 = `routePlace(originCity) → routePlace(destCity)` (手当マスタと同じ正規化)
 * - 便の粗利 = 収支 − 運行の経費の配分 (`LegMargin.grossMarginYen`)
 * - **便の無い運行**は取引先に結べないので `noLegOperations` に別に出す
 * - **検算**: `Σ取引先.grossMarginYen + noLegOperations.marginYen === summarizeMargins(margins).marginYen`
 *   (`diffYen` が 0。全便が揃っている月)
 *
 * 取引先も経路も**売上の降順**。同額は初出順 (sort は安定)。
 */
export function summarizeByCustomerRoute(margins: OperationMargin[]): CustomerRouteSummary {
  const customers = new Map<string, CustomerSummary & { routeMap: Map<string, RouteSummary> }>()
  const noLegOperations: NoLegOperationTotals = {
    operations: 0, salesYen: 0, allowanceYen: 0, fuelYen: 0, directCostYen: 0, allocatedCostYen: 0, marginYen: 0,
  }
  const unsplitLegs = { legs: 0, salesYen: 0 }

  for (const m of margins) {
    if (m.legs.length === 0) {
      noLegOperations.operations += 1
      noLegOperations.salesYen += m.salesYen
      noLegOperations.allowanceYen += m.allowanceYen
      // 経費・粗利は**粗利を出せた運行ぶんだけ** (`summarizeMargins` と同じ)。
      if (m.marginYen !== null) {
        noLegOperations.fuelYen += m.fuelYen!
        noLegOperations.directCostYen += m.directCostYen
        noLegOperations.allocatedCostYen += m.allocatedCostYen
        noLegOperations.marginYen += m.marginYen
      }
      continue
    }
    for (const l of m.legs) {
      if (l.grossMarginYen === null) {
        unsplitLegs.legs += 1
        unsplitLegs.salesYen += l.salesYen
      }
      const from = routePlace(l.originCity)
      const to = routePlace(l.destCity)
      for (const w of customerWeights(l.customers)) {
        const customer = customers.get(w.code)
          ?? { ...emptyCustomerRouteTotals(), code: w.code, name: w.name, routes: [], legRefs: [], routeMap: new Map<string, RouteSummary>() }
        customers.set(w.code, customer)
        addLegTo(customer, l, w.weight)
        const routeKey = `${from}|${to}`
        const route = customer.routeMap.get(routeKey) ?? { ...emptyCustomerRouteTotals(), from, to, legRefs: [] }
        customer.routeMap.set(routeKey, route)
        addLegTo(route, l, w.weight)
        // 地図用の居場所 (Refs #760 の 19)。`addLegTo` は額を足す係なので、こちらは分けて持つ。
        customer.legRefs.push({ unkoNo: m.unkoNo, seq: l.seq })
        route.legRefs.push({ unkoNo: m.unkoNo, seq: l.seq })
      }
    }
  }

  const sorted = [...customers.values()]
    .map(({ routeMap, ...c }) => ({
      ...c,
      routes: [...routeMap.values()].sort((a, b) => b.salesYen - a.salesYen),
    }))
    .sort((a, b) => b.salesYen - a.salesYen)
  const grossSum = sorted.reduce((sum, c) => sum + (c.grossMarginYen ?? 0), 0)
  const totalMarginYen = summarizeMargins(margins).marginYen
  return {
    customers: sorted,
    noLegOperations,
    unsplitLegs,
    totalMarginYen,
    diffYen: totalMarginYen - (grossSum + noLegOperations.marginYen),
  }
}

/**
 * 取引先 × 経路 CSV の見出し。**`mode` は「運行経費の配分」の列名にだけ効く** —
 * 列の数も並びも変わらない (Refs #760 の 22)。
 *
 * ファイルを開いた人が「どの比で配った数字か」を CSV 単体で判別できるようにする
 * (ファイル名だけだと、開いた後・コピーした後に分からなくなる)。
 */
export function customerRouteCsvHeader(mode: RunCostShareMode = 'km'): string[] {
  return [
    '取引先C', '取引先', '積地', '卸地', '便数', '売上走行km', '回送km',
    '売上', '手当', '燃料代(売上走行)', '回送燃料',
    `運行経費の配分(${RUN_COST_SHARE_MODE_LABELS[mode]})`, '粗利', '粗利率',
    '売上/売上走行km',
  ]
}

/**
 * **売上の距離あたり単価** (円 / 売上走行km、Refs #760 の 20)。丸めない。
 *
 * 便の単価は距離に比例していないので、**短距離便ほど 1km あたりの売上が高く、粗利率も高い**
 * (2026-07 帯広 5 台: 士幌 → 清水 38km で ¥924/km・粗利率 66.7%、対して 200km 級は
 * ¥120〜170/km)。粗利率の高低がどこから来ているかを、表の 1 列で見えるようにするための値。
 *
 * `haulKm <= 0` は割れないので `null` (回送だけの行・便の km が取れていない CSV)。
 */
export function salesPerHaulKm(salesYen: number, haulKm: number): number | null {
  if (haulKm <= 0) return null
  return salesYen / haulKm
}

/** 粗利率 (%) の色分けの境目。**以上**が緑。 */
export const MARGIN_RATE_HIGH = 55

/** 粗利率 (%) の色分けの境目。**未満**が赤。 */
export const MARGIN_RATE_LOW = 30

/**
 * 粗利率の色分け (Refs #760 の 20)。**単位は % で受ける** — `marginRate` は比 (0.55) を
 * 返すので、呼び出し側で 100 倍すること。
 *
 * `null` (粗利が出せない / 売上 0) は色を付けない。
 */
export function marginRateTone(rate: number | null): 'high' | 'low' | null {
  if (rate === null) return null
  if (rate >= MARGIN_RATE_HIGH) return 'high'
  if (rate < MARGIN_RATE_LOW) return 'low'
  return null
}

/**
 * 取引先 × 経路 の CSV (Refs #760 の 15)。**1 行 = 取引先 1 つ × 経路 1 本** (取引先の
 * 小計行は出さない — 表計算で取引先C でまとめれば出る)。値にカンマが入りうるので必ず引用する。
 *
 * `mode` は**見出しの列名にだけ**出る (`customerRouteCsvHeader`)。値は既に配分済みの
 * `runCostShareYen` を書くだけなので、ここで比を計算し直すことはない。
 */
export function customerRouteCsvLines(summary: CustomerRouteSummary, mode: RunCostShareMode = 'km'): string[] {
  const quote = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const rate = (v: number | null) => (v === null ? '' : `${Math.round(v * 1000) / 10}%`)
  const round = (v: number | null) => (v === null ? '' : Math.round(v))
  return [
    customerRouteCsvHeader(mode).map(quote).join(','),
    ...summary.customers.flatMap(c => c.routes.map(r => [
      c.code, c.name, r.from, r.to, r.legs, round(r.haulKm), round(r.deadheadKm),
      round(r.salesYen), round(r.allowanceYen), round(r.fuelHaulYen), round(r.fuelDeadheadYen),
      round(r.runCostShareYen), round(r.grossMarginYen),
      rate(marginRate({ salesYen: r.salesYen, marginYen: r.grossMarginYen })),
      round(salesPerHaulKm(r.salesYen, r.haulKm)),
    ].map(quote).join(','))),
  ]
}

// --- 売上の内訳 (取引先ごとの 100% 積み上げ棒、Refs #760 の 17) ---

/** 棒の区分。表の列 (手当 / 燃料代(売上走行) / 回送燃料 / 運行経費の配分 / 粗利) と同じ 5 つ。 */
export type ShareSegmentKey = 'allowance' | 'fuelHaul' | 'fuelDeadhead' | 'runCost' | 'margin'

/** 画面の凡例・title に使う区分名。順序は棒の左から右。 */
export const SHARE_SEGMENT_LABELS: { key: ShareSegmentKey, label: string }[] = [
  { key: 'allowance', label: '手当' },
  { key: 'fuelHaul', label: '燃料代(売上走行)' },
  { key: 'fuelDeadhead', label: '回送燃料' },
  { key: 'runCost', label: '運行経費の配分' },
  { key: 'margin', label: '粗利' },
]

export interface ShareSegment {
  key: ShareSegmentKey
  yen: number
  /** `yen ÷ 売上 × 100`。**丸めない** (表示側で小数 1 桁)。費用超過の行は縮めた後の値。 */
  pct: number
}

/** 棒 1 本 (合計 / 取引先 / 経路)。`segments` は `SHARE_SEGMENT_LABELS` の順。 */
export interface ShareBar {
  /** 合計は `total`、取引先は `code` (表と同じ。`(突合なし)` は `''`)、経路は `code|積地|卸地`。 */
  key: string
  label: string
  legs: number
  salesYen: number
  segments: ShareSegment[]
  /**
   * 費用 4 区分の和が売上を超えた行 (粗利 < 0) の超過分 `(Σ費用 − 売上) ÷ 売上 × 100`。
   * 棒は 100 に縮めてあるので、画面はこれを「赤字 −x%」で添える。超えていなければ 0。
   */
  overflowPct: number
  /** 粗利が出せない便の数 (`CustomerRouteTotals.unsplitLegs`)。> 0 の行は棒が 100% に届かない。 */
  unsplitLegs: number
  /** 取引先の棒だけ持つ。経路ごとの棒 (売上の降順、売上 0 の経路は除く)。 */
  routes?: ShareBar[]
}

export interface CustomerShareBars {
  /** 先頭は「合計」、続けて取引先 (表と同じ順 = 売上の降順)。売上 0 の行は入らない。 */
  bars: ShareBar[]
  /** 売上 0 の行 (取引先 + 経路) で棒にしなかった数。 */
  skipped: number
}

/**
 * ★ **費用が売上を超えたか (= 赤字か) を「画面に出る円の精度」で決める** (Refs #840)。
 *
 * `costSum` は**費用 4 区分をその場で足し直したもの**、比べる相手の `salesYen` から出る粗利は
 * **運行 1 本ずつ `売上 − 手当 − 燃料 − 直課 − 按分` を足し込んだもの** —
 * **同じ量を別の足し順で出した 2 つ**なので、double では一致しない (`margin-driver-share.ts`
 * の doc が `marginSalesYen − marginAllowanceYen − fuelYen − directCostYen − allocatedCostYen
 * === marginYen` と恒等式を明記しているとおり)。生のまま `costSum > salesYen` で比べると、
 * **粗利がちょうど 0 の行**で尾だけの超過を拾って画面が**「赤字 −0%」を赤で出す** (実測:
 * 売上 ¥261,000 に対し 4 区分の和 `261000.00000000003`、`overflowPct` は `1.1e-14` で
 * 画面の `pct1()` が `0%` に丸める)。**「超えた」と赤で言っているのに超えた額は ¥0**。
 *
 * だから**両方を円に丸めてから比べる** — #838 の `marginDiffDisplayDelta` と同じ
 * 「**単位ごとに画面に出る精度へ丸めてから比べる**」考え方で、丸め方は画面の `yen()` の
 * `Math.round` をそのまま写す。**赤字のバッジが出るのは、画面に出ている 2 つの円が
 * 実際に違うときだけ**になる。
 *
 * **許容誤差 (`> salesYen + 1e-6` のような定数) にはしない。**「いくつ未満なら同じか」を
 * 画面と切れた定数で決めることになるため。
 *
 * ★ **判定は厳しくなる方向にしか動かない。** `Math.round` は単調非減少なので
 * `a ≤ b ⟹ round(a) ≤ round(b)`、その対偶が `round(a) > round(b) ⟹ a > b` —
 * つまり**新しい判定は古い判定の部分集合**で、**赤字と言う回は減る方向にしか動かない**
 * (尾だけの超過をやめるのが目的なので、それでよい。実測: 生 true → 丸め false は起きるが、
 * その逆は 0 件)。だから `overflow` が true の回は
 * 必ず `costSum > t.salesYen` で、`scale = salesYen ÷ costSum` は (0,1)、`overflowPct` は正 —
 * **`scale` / `overflowPct` の式はそのままでよい。**
 *
 * 逆に **true → false に転ぶ行はある** (生では超過があった行)。そこでは `scale` が
 * `salesYen ÷ costSum` から厳密な `1` に変わるが、転ぶのは**超過が ¥1 未満のときだけ**なので
 * `1 − scale = 超過 ÷ costSum < 1 ÷ costSum`。**棒の幅の差は全区分の合計でも
 * `100 ÷ costSum` %ポイント未満** (売上 ¥100,000 の行なら 0.001%pt 未満 = 幅 1000px の棒で
 * 0.01px 未満。実測)。
 *
 * **金額そのものには当てない。** 丸めるのは**比較の 2 値だけ**で、`segments[].yen` にも
 * `overflowPct` の分子にも、粗利にも 1 円も効かない。
 */
export function costExceedsSalesAtYen(costSum: number, salesYen: number): boolean {
  return Math.round(costSum) > Math.round(salesYen)
}

/**
 * 1 行を棒にする。売上 0 以下は棒にしない (null)。
 *
 * - 粗利 segment の `yen` = `grossMarginYen ?? (売上 − 4 区分の和)` (全便の粗利が出せない行は
 *   残りを粗利と見る — その行は `unsplitLegs` が付くので画面で `*` が出る)
 * - **4 区分の和が売上を超えた** 行 (`costExceedsSalesAtYen` — **円に丸めてから比べる**。Refs #840)
 *   は、粗利の pct を 0 にし、4 区分の pct を `salesYen ÷ costSum` で縮めて合計 100 にする
 *   (棒をはみ出させない)。超過分は `overflowPct`
 * - 粗利を出せない便 (`unsplitLegs > 0`) が混ざる行は、その便の売上ぶんだけ棒が 100% に届かない
 *   (4 区分にも粗利にも入っていない売上なので、どの色にも塗らない)。粗利が負でも和が売上を
 *   超えていなければ縮めない — 粗利の pct だけ 0 に止める
 */
function shareBarOf(key: string, label: string, t: CustomerRouteTotals): ShareBar | null {
  if (t.salesYen <= 0) return null
  const costs: { key: ShareSegmentKey, yen: number }[] = [
    { key: 'allowance', yen: t.allowanceYen },
    { key: 'fuelHaul', yen: t.fuelHaulYen },
    { key: 'fuelDeadhead', yen: t.fuelDeadheadYen },
    { key: 'runCost', yen: t.runCostShareYen },
  ]
  const costSum = costs.reduce((sum, c) => sum + c.yen, 0)
  const marginYen = t.grossMarginYen ?? (t.salesYen - costSum)
  const overflow = costExceedsSalesAtYen(costSum, t.salesYen)
  const scale = overflow ? t.salesYen / costSum : 1
  return {
    key,
    label,
    legs: t.legs,
    salesYen: t.salesYen,
    segments: [
      ...costs.map(c => ({ key: c.key, yen: c.yen, pct: (c.yen * 100 * scale) / t.salesYen })),
      // ★ `marginYen` を `-0` 対策で潰さない (Refs #840)。粗利ちょうど 0 の行の値は
      // `-4.66e-10` のような**尾つきの負**で、**`-0` ではない** (`Object.is(marginYen, -0)` は
      // false。実測)。画面の `¥-0` は**表示側の `Math.round` が `-0` を作る**ことで出るので、
      // `margin.vue` の `yen()` で `+ 0` して寄せてある。ここで潰すと**額そのものが動く**うえ、
      // **表の粗利の列 (同じ値を `yen()` に渡す) には `¥-0` が残る**ので直ったことにならない。
      // `:918` の `weight === 0 ? 0 : …` は**値が本当に `-0` になる**別の話 (あちらは正しい)。
      { key: 'margin', yen: marginYen, pct: (Math.max(0, marginYen) * 100) / t.salesYen },
    ],
    overflowPct: overflow ? ((costSum - t.salesYen) * 100) / t.salesYen : 0,
    unsplitLegs: t.unsplitLegs,
  }
}

/**
 * 取引先別の表の下に出す **売上 = 100% の横積み上げ棒** (Refs #760 の 17)。
 *
 * オーナー (2026-08-23): 「この下に 100% 割合グラフを追加」 — 取引先ごとに売上に対する
 * 手当 / 燃料代(売上走行) / 回送燃料 / 運行経費の配分 / 粗利 の構成比を並べ、取引先間の違い
 * (手当率が高い / 回送が重い / 配分が重い) を一目で比べる。
 *
 * - 先頭の 1 本は**合計** (全取引先の Σ。`grossMarginYen` の null は 0 として足す)。続けて
 *   `summary.customers` を表と同じ順 (売上の降順) で 1 本ずつ。取引先の棒は `routes` に経路の棒を持つ
 * - **売上 0 以下の行は棒にしない** (`(突合なし)` 売上 ¥0 など。0 で割らない) → `skipped` に数える
 *   (取引先が棒にならなければその経路は数えない — どのみち出ない)。合計には入れる (売上 0 でも費用は乗っている)
 * - pct は丸めない。縮め方・超過分・粗利が出せない便の扱いは `shareBarOf` のとおり
 *
 * 表の数字・検算・CSV は触らない (表示専用)。
 */
export function customerShareBars(summary: CustomerRouteSummary): CustomerShareBars {
  let skipped = 0
  const total = emptyCustomerRouteTotals()
  const bars: ShareBar[] = []
  for (const c of summary.customers) {
    total.legs += c.legs
    total.unsplitLegs += c.unsplitLegs
    total.salesYen += c.salesYen
    total.allowanceYen += c.allowanceYen
    total.haulKm += c.haulKm
    total.deadheadKm += c.deadheadKm
    total.fuelHaulYen += c.fuelHaulYen
    total.fuelDeadheadYen += c.fuelDeadheadYen
    total.runCostShareYen += c.runCostShareYen
    total.grossMarginYen = (total.grossMarginYen ?? 0) + (c.grossMarginYen ?? 0)
    const bar = shareBarOf(c.code, c.name, c)
    if (bar === null) {
      skipped += 1
      continue
    }
    bar.routes = []
    for (const r of c.routes) {
      const rb = shareBarOf(`${c.code}|${r.from}|${r.to}`, `${r.from} → ${r.to}`, r)
      if (rb === null) {
        skipped += 1
        continue
      }
      bar.routes.push(rb)
    }
    bars.push(bar)
  }
  const totalBar = shareBarOf('total', '合計', total)
  return { bars: totalBar === null ? bars : [totalBar, ...bars], skipped }
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
 *
 * `v4` で**走行距離の数え方**を変え (重ね掛け行を足さない。Refs #760 の 7)、運行一覧の
 * `総走行距離` (`listedTotalKm`) を足した。`v3` を読ませないのは、**二重計上された
 * `totalKm` がキャッシュ経路だけに残る**ため (燃費が 1.8 倍に見える古い値を、
 * 「キャッシュから」の注意書きだけで出し続けることになる)。
 *
 * `v5` で**便ごとの入力** (`MarginOperationInput.legs`) を足した (Refs #760 の 13)。
 * `v4` を読ませないのは、**便の段の欄が無いキャッシュを読むと便が 1 本も出ない**
 * (`legs: undefined` を空配列にできず、画面の新しい段だけ永久に空くため)。
 *
 * `v6` で `costs` の行に **`remarks` / `vendorName`** を足した (Refs #760 の 14)。
 * `v5` を読ませないのは、**備考・支払先の無い行を読むと直課経費の title に
 * `undefined` が混ざる**ため (取り込み直せば付く)。
 *
 * `v7` で便に **`customers`** (売上に当たった一番星の取引先) を足した (Refs #760 の 15)。
 * `v6` を読ませないのは、**取引先の無い便を読むと取引先別の集計が全便 `(突合なし)`
 * になる** (`customers: undefined` で `customerWeights` が落ちる) ため。
 *
 * `v8` で**月の切り方を運行の開始日に変えた** (Refs #760 の 16)。`v7` を読ませないのは、
 * **便の積み日で切った古い集計**がキャッシュ経路だけに残るため — 月跨ぎの運行が
 * 翌月便ぶんの燃料だけを抱えたままになり、取引先別の検算がその運行のぶんだけ
 * 合わない画面に戻る (`crossMonth` の注記も出ない)。
 *
 * `v9` で便に**拘束秒** (`haulSec`/`deadheadSec`) を足した (Refs #760 の 22)。
 * `v8` を読ませないのは、**秒の無い便を読むと拘束時間比が全運行フォールバックになり**、
 * 走行km比と同じ数字が「拘束時間比」の名前で出てしまうため (キャッシュ経路だけ
 * 切り替えが効かない画面に戻る)。**キャッシュを読む側にバージョン判定は無い** —
 * 形が変わったらこのキーを上げる、が唯一の作法。
 */
export const MARGIN_CACHE_KEY = 'dtako:margin:cache:v9'

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
  /**
   * 運行が月を跨いだぶんの注記 (Refs #760 の 16)。**`uncovered` と同じ理由で持つ** —
   * これが無いと、キャッシュから出したときだけ「月の切り方」の注記が消えて、
   * 運行手当タブとの差を読めない画面に戻る。**古いキャッシュには無い**ので null 可。
   */
  crossMonth: CrossMonthLegs | null
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
    crossMonth: typeof cache.crossMonth === 'object' && cache.crossMonth !== null ? cache.crossMonth : null,
  }
}

export function serializeMarginCache(cache: MarginCache): string {
  return JSON.stringify(cache)
}
