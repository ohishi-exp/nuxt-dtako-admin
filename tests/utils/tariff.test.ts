// 標準的運賃 (告示209号) 計算ロジックのテスト。
// 代表値は官報 (令和6年3月22日 号外第66号) の九州運輸局表からの転記値で固定する。
import { describe, expect, it } from 'vitest'
import {
  addTwoManFee,
  calcDistanceFare,
  calcFuelSurcharge,
  calcLoadingFee,
  calcTimeFare,
  calcWaitingFee,
  distanceBaseFare,
  fuelSurchargeAvgKm,
  fuelSurchargeUpliftPerL,
  getDistanceTable,
  getTimeTable,
  roundUpDistanceKm,
} from '../../app/utils/tariff/calc'
import { KYUSHU_DISTANCE, KYUSHU_TIME } from '../../app/utils/tariff/data/kyushu'
import { VEHICLE_CLASSES } from '../../app/utils/tariff/types'

describe('運賃表データの整合性 (転記ミス検出)', () => {
  it('距離制: 各車種 20 行あり、距離単調増加・車種間単調増加', () => {
    for (const vc of VEHICLE_CLASSES) {
      const rows = KYUSHU_DISTANCE.upTo200km[vc]
      expect(rows).toHaveLength(20)
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i]!).toBeGreaterThan(rows[i - 1]!)
      }
    }
    for (let i = 0; i < 20; i++) {
      expect(KYUSHU_DISTANCE.upTo200km.small_2t[i]!).toBeLessThan(KYUSHU_DISTANCE.upTo200km.medium_4t[i]!)
      expect(KYUSHU_DISTANCE.upTo200km.medium_4t[i]!).toBeLessThan(KYUSHU_DISTANCE.upTo200km.large_10t[i]!)
      expect(KYUSHU_DISTANCE.upTo200km.large_10t[i]!).toBeLessThan(KYUSHU_DISTANCE.upTo200km.trailer_20t[i]!)
    }
  })

  it('時間制: 8h > 4h、加算額は正', () => {
    for (const vc of VEHICLE_CLASSES) {
      expect(KYUSHU_TIME.base8h[vc]).toBeGreaterThan(KYUSHU_TIME.base4h[vc])
      expect(KYUSHU_TIME.perExtra10km[vc]).toBeGreaterThan(0)
      expect(KYUSHU_TIME.perExtraHour[vc]).toBeGreaterThan(0)
    }
  })
})

describe('roundUpDistanceKm (運賃料金適用方 4.(1))', () => {
  it('200km までは 10km 切り上げ', () => {
    expect(roundUpDistanceKm(1)).toBe(10)
    expect(roundUpDistanceKm(10)).toBe(10)
    expect(roundUpDistanceKm(95)).toBe(100)
    expect(roundUpDistanceKm(200)).toBe(200)
  })

  it('200km 超 500km までは 20km 切り上げ', () => {
    expect(roundUpDistanceKm(201)).toBe(220)
    expect(roundUpDistanceKm(250)).toBe(260)
    expect(roundUpDistanceKm(500)).toBe(500)
  })

  it('500km 超は 50km 切り上げ', () => {
    expect(roundUpDistanceKm(501)).toBe(550)
    expect(roundUpDistanceKm(620)).toBe(650)
  })

  it('不正距離は throw', () => {
    expect(() => roundUpDistanceKm(0)).toThrow(/距離が不正/)
    expect(() => roundUpDistanceKm(Number.NaN)).toThrow(/距離が不正/)
  })
})

describe('distanceBaseFare (九州、官報 96 頁の転記値)', () => {
  it('表引き (10〜200km)', () => {
    expect(distanceBaseFare('kyushu', 'small_2t', 10)).toBe(13450)
    expect(distanceBaseFare('kyushu', 'small_2t', 200)).toBe(45990)
    expect(distanceBaseFare('kyushu', 'large_10t', 95)).toBe(45860) // 100km 行
    expect(distanceBaseFare('kyushu', 'trailer_20t', 150)).toBe(78820)
  })

  it('200km 超は 20km 毎加算 (大型 250km → 260km: 73,060 + 3×5,350)', () => {
    expect(distanceBaseFare('kyushu', 'large_10t', 250)).toBe(73060 + 3 * 5350)
    expect(distanceBaseFare('kyushu', 'large_10t', 500)).toBe(73060 + 15 * 5350)
  })

  it('500km 超は 50km 毎加算 (小型 620km → 650km)', () => {
    expect(distanceBaseFare('kyushu', 'small_2t', 620)).toBe(45990 + 15 * 3390 + 3 * 8480)
    expect(distanceBaseFare('kyushu', 'large_10t', 501)).toBe(73060 + 15 * 5350 + 1 * 13380)
  })

  it('未収録ブロックは loud fail', () => {
    expect(() => getDistanceTable('hokkaido')).toThrow(/未収録/)
    expect(() => getTimeTable('kanto')).toThrow(/未収録/)
  })
})

describe('calcDistanceFare (休日 / 深夜・早朝割増 2割)', () => {
  it('割増なし', () => {
    const r = calcDistanceFare({ bureau: 'kyushu', vehicleClass: 'large_10t', distanceKm: 100 })
    expect(r).toEqual({ baseFare: 45860, holidaySurcharge: 0, lateNightSurcharge: 0, total: 45860 })
  })

  it('休日 + 深夜で各 2割', () => {
    const r = calcDistanceFare({
      bureau: 'kyushu',
      vehicleClass: 'large_10t',
      distanceKm: 100,
      holiday: true,
      lateNight: true,
    })
    expect(r.holidaySurcharge).toBe(9172)
    expect(r.lateNightSurcharge).toBe(9172)
    expect(r.total).toBe(45860 + 9172 * 2)
  })
})

describe('calcTimeFare (九州、官報 97〜98 頁の転記値)', () => {
  it('基礎額のみ (基礎走行キロ以内・超過時間なし)', () => {
    expect(calcTimeFare({ bureau: 'kyushu', vehicleClass: 'large_10t', mode: 'h8', distanceKm: 130 })).toBe(53860)
    expect(calcTimeFare({ bureau: 'kyushu', vehicleClass: 'small_2t', mode: 'h8', distanceKm: 100 })).toBe(33770)
    expect(calcTimeFare({ bureau: 'kyushu', vehicleClass: 'trailer_20t', mode: 'h4', distanceKm: 60 })).toBe(41820)
  })

  it('基礎走行キロ超過は 10km 毎加算 (大型 145km → 2 単位)', () => {
    expect(calcTimeFare({ bureau: 'kyushu', vehicleClass: 'large_10t', mode: 'h8', distanceKm: 140 })).toBe(53860 + 630)
    expect(calcTimeFare({ bureau: 'kyushu', vehicleClass: 'large_10t', mode: 'h8', distanceKm: 145 })).toBe(53860 + 2 * 630)
    // 九州の中型加算は 400 円 (他局の 410 円と異なる、官報 98 頁)
    expect(calcTimeFare({ bureau: 'kyushu', vehicleClass: 'medium_4t', mode: 'h8', distanceKm: 131 })).toBe(40740 + 400)
  })

  it('基礎作業時間超過は 1 時間毎加算', () => {
    expect(calcTimeFare({ bureau: 'kyushu', vehicleClass: 'medium_4t', mode: 'h4', distanceKm: 60, extraHours: 1 })).toBe(24440 + 3090)
  })

  it('不正入力は throw', () => {
    expect(() => calcTimeFare({ bureau: 'kyushu', vehicleClass: 'small_2t', mode: 'h8', distanceKm: -1 })).toThrow(/距離が不正/)
    expect(() => calcTimeFare({ bureau: 'kyushu', vehicleClass: 'small_2t', mode: 'h8', distanceKm: 10, extraHours: 1.5 })).toThrow(/超過時間/)
  })
})

describe('燃料サーチャージ (告示 X)', () => {
  it('基準価格 (120円/L) 以下は 0 (廃止条件)', () => {
    expect(fuelSurchargeUpliftPerL(120)).toBe(0)
    expect(fuelSurchargeUpliftPerL(100)).toBe(0)
  })

  it('上昇額は刻み幅の中間値 − 基準価格 (官報 100〜101 頁のテーブルと一致)', () => {
    expect(fuelSurchargeUpliftPerL(121)).toBe(2.5) // 120超〜125
    expect(fuelSurchargeUpliftPerL(125)).toBe(2.5)
    expect(fuelSurchargeUpliftPerL(147)).toBe(27.5) // 145超〜150
    expect(fuelSurchargeUpliftPerL(205)).toBe(82.5) // 200超〜205
    expect(fuelSurchargeUpliftPerL(207)).toBe(87.5) // 205 超も刻み幅 5 円で継続
  })

  it('額 = 距離 ÷ 燃費 × 上昇額、円未満切り上げ (告示 X-5)', () => {
    expect(calcFuelSurcharge({ dieselPriceYenPerL: 147, fuelEfficiencyKmPerL: 3, distanceKm: 300 })).toBe(2750)
    expect(calcFuelSurcharge({ dieselPriceYenPerL: 122, fuelEfficiencyKmPerL: 3, distanceKm: 100 })).toBe(84) // 83.33… → 84
    expect(calcFuelSurcharge({ dieselPriceYenPerL: 120, fuelEfficiencyKmPerL: 3, distanceKm: 300 })).toBe(0)
  })

  it('時間制の平均走行距離 (告示 X-4)', () => {
    expect(fuelSurchargeAvgKm('h8', 'large_10t')).toBe(130)
    expect(fuelSurchargeAvgKm('h8', 'small_2t')).toBe(100)
    expect(fuelSurchargeAvgKm('h4', 'small_2t')).toBe(50)
  })

  it('不正入力は throw', () => {
    expect(() => fuelSurchargeUpliftPerL(-1)).toThrow(/軽油価格が不正/)
    expect(() => calcFuelSurcharge({ dieselPriceYenPerL: 147, fuelEfficiencyKmPerL: 0, distanceKm: 100 })).toThrow(/燃費が不正/)
    expect(() => calcFuelSurcharge({ dieselPriceYenPerL: 147, fuelEfficiencyKmPerL: 3, distanceKm: -1 })).toThrow(/距離が不正/)
  })
})

describe('待機時間料 (告示 V) / 積込料・取卸料 (告示 VI)', () => {
  it('待機 30 分以内は 0、超過は 30 分毎', () => {
    expect(calcWaitingFee('large_10t', 30)).toBe(0)
    expect(calcWaitingFee('large_10t', 31)).toBe(1890)
    expect(calcWaitingFee('large_10t', 90)).toBe(2 * 1890)
    expect(calcWaitingFee('large_10t', 31, true)).toBe(2270) // 2h 超の単価
  })

  it('積込・取卸は 30 分毎 (フォークリフト / 手積み)', () => {
    expect(calcLoadingFee('large_10t', 0, 'forklift')).toBe(0)
    expect(calcLoadingFee('large_10t', 45, 'forklift')).toBe(2 * 2340)
    expect(calcLoadingFee('large_10t', 30, 'manual')).toBe(2260)
    expect(calcLoadingFee('large_10t', 30, 'manual', true)).toBe(2710)
  })

  it('不正入力は throw', () => {
    expect(() => calcWaitingFee('large_10t', -1)).toThrow(/待機時間が不正/)
    expect(() => calcLoadingFee('large_10t', -1, 'manual')).toThrow(/荷役時間が不正/)
  })
})

describe('2マン運行 (交替運転者) — 告示に規定なし、事業者設定額を加算', () => {
  it('未設定 (null) は加算なし、設定時は加算', () => {
    expect(addTwoManFee(50000, null)).toBe(50000)
    expect(addTwoManFee(50000, 12000)).toBe(62000)
  })

  it('負値は throw', () => {
    expect(() => addTwoManFee(50000, -1)).toThrow(/交替運転者配置料が不正/)
  })
})
