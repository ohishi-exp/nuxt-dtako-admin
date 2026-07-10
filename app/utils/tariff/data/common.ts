// 標準的運賃の全国共通項目 (令和6年国土交通省告示第209号 IV〜X)
//
// SOURCE: 官報 令和6年3月22日 (号外第66号) 98〜102頁
//         https://www.mlit.go.jp/jidosha/content/001732621.pdf
// 転記は官報 PDF から確認済み (2026-07-10)。
//
// 注意: 「交替運転者配置料金 (2マン運行)」は本告示に存在しない (官報・通達・
// 解説集・運賃料金適用方参考例の全てを確認、2026-07-10)。issue #198 の当初想定と
// 異なるため、2マン費用は事業者設定のパラメータとして calc 側で受ける。

import type { VehicleClass } from '../types'

/** 休日割増 (日曜祝日に運送した距離に限る)。告示 IV */
export const HOLIDAY_SURCHARGE_RATE = 0.2

/** 深夜・早朝割増 (午後10時から午前5時までに運送した距離に限る)。告示 IV */
export const LATE_NIGHT_SURCHARGE_RATE = 0.2

/** 特殊車両割増 (告示 IV)。rate は「○割」を小数で表現。appliesTo は対象車種 */
export const SPECIAL_VEHICLE_SURCHARGES = {
  refrigerated: { label: '冷蔵車・冷凍車', rate: 0.2, appliesTo: ['small_2t', 'medium_4t', 'large_10t', 'trailer_20t'] },
  marine_container: { label: '海上コンテナ輸送車', rate: 0.4, appliesTo: ['trailer_20t'] },
  cement_bulk: { label: 'セメントバルク車', rate: 0.2, appliesTo: ['large_10t', 'trailer_20t'] },
  dump: { label: 'ダンプ車', rate: 0.2, appliesTo: ['large_10t'] },
  concrete_mixer: { label: 'コンクリートミキサー車', rate: 0.2, appliesTo: ['large_10t'] },
  tank_petroleum: { label: 'タンク車 (石油製品輸送車)', rate: 0.3, appliesTo: ['large_10t', 'trailer_20t'] },
  tank_chemical: { label: 'タンク車 (化成品輸送車)', rate: 0.4, appliesTo: ['large_10t', 'trailer_20t'] },
  tank_high_pressure_gas: { label: 'タンク車 (高圧ガス輸送車)', rate: 0.5, appliesTo: ['large_10t', 'trailer_20t'] },
} as const satisfies Record<string, { label: string, rate: number, appliesTo: readonly VehicleClass[] }>

/**
 * 待機時間料 (告示 V)。30分を超える場合において 30分までごとに発生する金額。
 * combinedOver2h は積込料・取卸料の適用時間と併せて 2時間を超える場合の単価。
 */
export const WAITING_FEE_PER_30MIN: Record<VehicleClass, number> = {
  small_2t: 1680, medium_4t: 1760, large_10t: 1890, trailer_20t: 2220,
}
export const WAITING_FEE_PER_30MIN_OVER_2H: Record<VehicleClass, number> = {
  small_2t: 2010, medium_4t: 2110, large_10t: 2270, trailer_20t: 2670,
}

/** 積込料・取卸料 (告示 VI)。30分までごとに発生する金額 */
export const LOADING_FEE_PER_30MIN = {
  /** フォークリフト又はトラック搭載型クレーンを使用した場合 */
  forklift: { small_2t: 2080, medium_4t: 2180, large_10t: 2340, trailer_20t: 2750 },
  /** 手積みの場合 */
  manual: { small_2t: 2000, medium_4t: 2100, large_10t: 2260, trailer_20t: 2650 },
} as const satisfies Record<string, Record<VehicleClass, number>>

/** 積込料・取卸料 — 待機時間料の適用時間と併せて 2時間を超える場合 (告示 VI) */
export const LOADING_FEE_PER_30MIN_OVER_2H = {
  forklift: { small_2t: 2490, medium_4t: 2610, large_10t: 2810, trailer_20t: 3300 },
  manual: { small_2t: 2400, medium_4t: 2520, large_10t: 2710, trailer_20t: 3180 },
} as const satisfies Record<string, Record<VehicleClass, number>>

/** 利用運送手数料 (告示 VII): 運賃の 10% を当該運賃とは別に収受 */
export const FORWARDING_COMMISSION_RATE = 0.1

/** 燃料サーチャージ (告示 X): 基準価格 120.00円/L、改定の刻み幅 5.00円/L */
export const FUEL_SURCHARGE_BASE_PRICE = 120.0
export const FUEL_SURCHARGE_STEP = 5.0

/**
 * 時間制運賃の場合のサーチャージ額算出のための平均走行距離 (km)。告示 X-4
 */
export const FUEL_SURCHARGE_AVG_KM = {
  h8: { small_2t: 100, medium_4t: 130, large_10t: 130, trailer_20t: 130 },
  h4: { small_2t: 50, medium_4t: 60, large_10t: 60, trailer_20t: 60 },
} as const satisfies Record<string, Record<VehicleClass, number>>
