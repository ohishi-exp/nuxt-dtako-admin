// 標準的運賃 (令和6年国土交通省告示第209号) の型定義 (Refs #198 Phase 4)
//
// 一次資料: 官報 令和6年3月22日 (号外第66号) 92〜102 頁
// https://www.mlit.go.jp/jidosha/content/001732621.pdf
//
// 数値は必ず官報からの転記とし、推測で埋めない。転記した表は
// tests/utils/tariff.test.ts の代表値テストで固定する。

/** 車種 4 区分 (告示 I 距離制運賃表の列) */
export type VehicleClass = 'small_2t' | 'medium_4t' | 'large_10t' | 'trailer_20t'

export const VEHICLE_CLASSES: VehicleClass[] = ['small_2t', 'medium_4t', 'large_10t', 'trailer_20t']

export const VEHICLE_CLASS_LABELS: Record<VehicleClass, string> = {
  small_2t: '小型車 (2tクラス)',
  medium_4t: '中型車 (4tクラス)',
  large_10t: '大型車 (10tクラス)',
  trailer_20t: 'トレーラー (20tクラス)',
}

/** 運輸局ブロック (沖縄は総合事務局。表構造が異なるため注意) */
export type TransportBureau =
  | 'hokkaido' | 'tohoku' | 'kanto' | 'hokuriku_shinetsu' | 'chubu'
  | 'kinki' | 'chugoku' | 'shikoku' | 'kyushu' | 'okinawa'

/**
 * 距離制運賃表 (告示 I)。
 * 10〜200km は 10km 刻みの表引き、200km 超は加算額方式。
 * (沖縄は 5km 行 + 200km 超 10km 毎加算の別構造なので本型では表現しない)
 */
export interface DistanceTariffTable {
  bureau: TransportBureau
  /** index 0 = 10km, 1 = 20km, …, 19 = 200km */
  upTo200km: Record<VehicleClass, number[]>
  /** 200km を超えて 500km まで 20km を増すごとに加算する金額 */
  per20kmOver200: Record<VehicleClass, number>
  /** 500km を超えて 50km を増すごとに加算する金額 */
  per50kmOver500: Record<VehicleClass, number>
}

/**
 * 時間制運賃表 (告示 II)。
 * 基礎額 (8時間制/4時間制) + 基礎走行キロ超過 10km 毎加算 + 基礎作業時間超過 1時間毎加算。
 */
export interface TimeTariffTable {
  bureau: TransportBureau
  /** 8時間制 基礎額 (基礎走行キロ: 小型車 100km / 小型車以外 130km) */
  base8h: Record<VehicleClass, number>
  /** 4時間制 基礎額 (基礎走行キロ: 小型車 50km / 小型車以外 60km) */
  base4h: Record<VehicleClass, number>
  /** 基礎走行キロを超える場合、10km を増すごとに加算 */
  perExtra10km: Record<VehicleClass, number>
  /** 基礎作業時間を超える場合、1時間を増すごとに加算 */
  perExtraHour: Record<VehicleClass, number>
}

/** 時間制の基礎走行キロ (km)。告示 II 種別欄 */
export const TIME_TARIFF_BASE_KM = {
  h8: { small_2t: 100, medium_4t: 130, large_10t: 130, trailer_20t: 130 },
  h4: { small_2t: 50, medium_4t: 60, large_10t: 60, trailer_20t: 60 },
} as const

/** 運賃計算の入力 (距離制) */
export interface DistanceFareInput {
  bureau: TransportBureau
  vehicleClass: VehicleClass
  /** 実走行距離 (km)。告示適用方の切り上げ規則を calc 側で適用する */
  distanceKm: number
  /** 休日割増 (日曜祝日に運送した距離に限る) を全区間に適用するか */
  holiday?: boolean
  /** 深夜・早朝割増 (22時〜5時に運送した距離に限る) を全区間に適用するか */
  lateNight?: boolean
}

/** 運賃計算の入力 (時間制) */
export interface TimeFareInput {
  bureau: TransportBureau
  vehicleClass: VehicleClass
  mode: 'h8' | 'h4'
  /** 実走行距離 (km) */
  distanceKm: number
  /** 基礎作業時間を超えた時間 (h、切り上げ済みの整数) */
  extraHours?: number
}

/** 燃料サーチャージ計算の入力 (告示 X) */
export interface FuelSurchargeInput {
  /** 調達している軽油価格 (円/L) */
  dieselPriceYenPerL: number
  /** 車両燃費 (km/L)。告示 X-3 では各事業者設定 (○○km/L) */
  fuelEfficiencyKmPerL: number
  /** 走行距離 (km)。時間制の場合は告示 X-4 の平均走行距離を使う */
  distanceKm: number
}

/** 計算結果の内訳 */
export interface FareBreakdown {
  /** 割増前の基準運賃 */
  baseFare: number
  /** 休日割増 (2割) */
  holidaySurcharge: number
  /** 深夜・早朝割増 (2割) */
  lateNightSurcharge: number
  /** 合計 (= baseFare + 割増) */
  total: number
}
