// 標準的運賃 計算ロジック (令和6年国土交通省告示第209号) (Refs #198 Phase 4)
//
// 距離の切り上げ規則は「運賃料金適用方 (参考例)」(国交省 001738345.docx) の
// 運賃計算の方法 4.(1) に従う:
//   - 200km まで: 10km 未満を 10km に切り上げ
//   - 200km 超 500km まで: 20km 未満を 20km に切り上げ
//   - 500km 超: 50km 未満を 50km に切り上げ
// 端数処理 (サーチャージ): 円単位に小数を切り上げ (告示 X-5)。

import type {
  DistanceFareInput,
  DistanceTariffTable,
  FareBreakdown,
  FuelSurchargeInput,
  TimeFareInput,
  TimeTariffTable,
  TransportBureau,
  VehicleClass,
} from './types'
import { TIME_TARIFF_BASE_KM } from './types'
import {
  FUEL_SURCHARGE_AVG_KM,
  FUEL_SURCHARGE_BASE_PRICE,
  FUEL_SURCHARGE_STEP,
  HOLIDAY_SURCHARGE_RATE,
  LATE_NIGHT_SURCHARGE_RATE,
  LOADING_FEE_PER_30MIN,
  LOADING_FEE_PER_30MIN_OVER_2H,
  WAITING_FEE_PER_30MIN,
  WAITING_FEE_PER_30MIN_OVER_2H,
} from './data/common'
import { KYUSHU_DISTANCE, KYUSHU_TIME } from './data/kyushu'

// 収録済みブロック。他局を追加したらここに登録する (まず九州のみ、Refs #198)
const DISTANCE_TABLES: Partial<Record<TransportBureau, DistanceTariffTable>> = {
  kyushu: KYUSHU_DISTANCE,
}
const TIME_TABLES: Partial<Record<TransportBureau, TimeTariffTable>> = {
  kyushu: KYUSHU_TIME,
}

export function getDistanceTable(bureau: TransportBureau): DistanceTariffTable {
  const table = DISTANCE_TABLES[bureau]
  if (!table) throw new Error(`距離制運賃表が未収録です: ${bureau} (収録済み: ${Object.keys(DISTANCE_TABLES).join(', ')})`)
  return table
}

export function getTimeTable(bureau: TransportBureau): TimeTariffTable {
  const table = TIME_TABLES[bureau]
  if (!table) throw new Error(`時間制運賃表が未収録です: ${bureau} (収録済み: ${Object.keys(TIME_TABLES).join(', ')})`)
  return table
}

/** 距離の切り上げ (運賃料金適用方 4.(1)) */
export function roundUpDistanceKm(distanceKm: number): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) {
    throw new Error(`距離が不正です: ${distanceKm}`)
  }
  if (distanceKm <= 200) return Math.ceil(distanceKm / 10) * 10
  if (distanceKm <= 500) return 200 + Math.ceil((distanceKm - 200) / 20) * 20
  return 500 + Math.ceil((distanceKm - 500) / 50) * 50
}

/** 距離制の基準運賃 (割増前)。切り上げ後の距離で表引き + 200km/500km 超は加算 */
export function distanceBaseFare(
  bureau: TransportBureau,
  vehicleClass: VehicleClass,
  distanceKm: number,
): number {
  const table = getDistanceTable(bureau)
  const rounded = roundUpDistanceKm(distanceKm)
  const at200 = table.upTo200km[vehicleClass][19]!

  if (rounded <= 200) {
    return table.upTo200km[vehicleClass][rounded / 10 - 1]!
  }
  if (rounded <= 500) {
    return at200 + ((rounded - 200) / 20) * table.per20kmOver200[vehicleClass]
  }
  // 200→500km の 20km 加算 15 回ぶん + 500km 超の 50km 加算
  return (
    at200
    + 15 * table.per20kmOver200[vehicleClass]
    + ((rounded - 500) / 50) * table.per50kmOver500[vehicleClass]
  )
}

/** 距離制運賃 (休日 / 深夜・早朝割増つき内訳)。割増は該当距離に限る規定のため、全区間該当の前提で 2 割を適用する */
export function calcDistanceFare(input: DistanceFareInput): FareBreakdown {
  const baseFare = distanceBaseFare(input.bureau, input.vehicleClass, input.distanceKm)
  const holidaySurcharge = input.holiday ? Math.round(baseFare * HOLIDAY_SURCHARGE_RATE) : 0
  const lateNightSurcharge = input.lateNight ? Math.round(baseFare * LATE_NIGHT_SURCHARGE_RATE) : 0
  return {
    baseFare,
    holidaySurcharge,
    lateNightSurcharge,
    total: baseFare + holidaySurcharge + lateNightSurcharge,
  }
}

/** 時間制運賃 (基礎額 + 基礎走行キロ超過 10km 毎 + 基礎作業時間超過 1 時間毎) */
export function calcTimeFare(input: TimeFareInput): number {
  const table = getTimeTable(input.bureau)
  const base = input.mode === 'h8' ? table.base8h[input.vehicleClass] : table.base4h[input.vehicleClass]
  const baseKm = TIME_TARIFF_BASE_KM[input.mode][input.vehicleClass]

  if (!Number.isFinite(input.distanceKm) || input.distanceKm < 0) {
    throw new Error(`距離が不正です: ${input.distanceKm}`)
  }
  const extraKm = Math.max(0, input.distanceKm - baseKm)
  const kmSurcharge = Math.ceil(extraKm / 10) * table.perExtra10km[input.vehicleClass]

  const extraHours = input.extraHours ?? 0
  if (!Number.isInteger(extraHours) || extraHours < 0) {
    throw new Error(`超過時間は 0 以上の整数 (時間単位に切り上げ済み) で渡してください: ${extraHours}`)
  }
  const hourSurcharge = extraHours * table.perExtraHour[input.vehicleClass]

  return base + kmSurcharge + hourSurcharge
}

/**
 * 燃料サーチャージ (告示 X)。
 * 軽油価格が基準 (120.00円/L) 以下なら 0 (廃止条件)。
 * 算出上の燃料価格上昇額 = 刻み幅の中間値 − 基準価格 (例: 120超〜125 → 2.50円/L)。
 * サーチャージ額 = 走行距離 ÷ 車両燃費 × 上昇額 (円未満切り上げ、告示 X-5)。
 */
export function fuelSurchargeUpliftPerL(dieselPriceYenPerL: number): number {
  if (!Number.isFinite(dieselPriceYenPerL) || dieselPriceYenPerL < 0) {
    throw new Error(`軽油価格が不正です: ${dieselPriceYenPerL}`)
  }
  if (dieselPriceYenPerL <= FUEL_SURCHARGE_BASE_PRICE) return 0
  const band = Math.ceil((dieselPriceYenPerL - FUEL_SURCHARGE_BASE_PRICE) / FUEL_SURCHARGE_STEP)
  return band * FUEL_SURCHARGE_STEP - FUEL_SURCHARGE_STEP / 2
}

export function calcFuelSurcharge(input: FuelSurchargeInput): number {
  if (!Number.isFinite(input.fuelEfficiencyKmPerL) || input.fuelEfficiencyKmPerL <= 0) {
    throw new Error(`車両燃費が不正です: ${input.fuelEfficiencyKmPerL}`)
  }
  if (!Number.isFinite(input.distanceKm) || input.distanceKm < 0) {
    throw new Error(`距離が不正です: ${input.distanceKm}`)
  }
  const uplift = fuelSurchargeUpliftPerL(input.dieselPriceYenPerL)
  if (uplift === 0) return 0
  return Math.ceil((input.distanceKm / input.fuelEfficiencyKmPerL) * uplift)
}

/** 時間制運賃のサーチャージ用平均走行距離 (告示 X-4) */
export function fuelSurchargeAvgKm(mode: 'h8' | 'h4', vehicleClass: VehicleClass): number {
  return FUEL_SURCHARGE_AVG_KM[mode][vehicleClass]
}

/**
 * 待機時間料 (告示 V)。30分を超える場合において 30分までごとに発生。
 * over2hCombined: 積込料・取卸料の適用時間と併せて 2時間を超える部分の扱いは
 * 呼び出し側で分割して 2 回呼ぶ (このヘルパは単価の切替のみ行う)。
 */
export function calcWaitingFee(
  vehicleClass: VehicleClass,
  minutes: number,
  over2hCombined = false,
): number {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`待機時間が不正です: ${minutes}`)
  }
  if (minutes <= 30) return 0
  const unit = over2hCombined ? WAITING_FEE_PER_30MIN_OVER_2H[vehicleClass] : WAITING_FEE_PER_30MIN[vehicleClass]
  return Math.ceil((minutes - 30) / 30) * unit
}

/** 積込料・取卸料 (告示 VI)。30分までごとに発生 */
export function calcLoadingFee(
  vehicleClass: VehicleClass,
  minutes: number,
  method: 'forklift' | 'manual',
  over2hCombined = false,
): number {
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error(`荷役時間が不正です: ${minutes}`)
  }
  if (minutes === 0) return 0
  const table = over2hCombined ? LOADING_FEE_PER_30MIN_OVER_2H[method] : LOADING_FEE_PER_30MIN[method]
  return Math.ceil(minutes / 30) * table[vehicleClass]
}

/**
 * 2マン運行 (交替運転者) の扱いについて:
 * 令和6年告示第209号には「交替運転者配置料金」は存在しない (官報・通達・解説集・
 * 運賃料金適用方参考例を確認済み、2026-07-10)。各事業者が運賃料金適用方で独自に
 * 設定する領域のため、比較計算では事業者設定額をそのまま加算するヘルパのみ提供する。
 */
export function addTwoManFee(fare: number, operatorTwoManFee: number | null): number {
  if (operatorTwoManFee === null) return fare
  if (!Number.isFinite(operatorTwoManFee) || operatorTwoManFee < 0) {
    throw new Error(`交替運転者配置料が不正です: ${operatorTwoManFee}`)
  }
  return fare + operatorTwoManFee
}
