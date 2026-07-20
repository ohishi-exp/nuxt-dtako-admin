import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mapVehicleDailyApiRow,
  vehicleDailyDateRange,
  normalizeLocationName,
  matchLocationLevel,
  scoreVehicleDailySlips,
  calcProfitEfficiency,
  fetchVehicleDailySlips,
  searchVehicleDailySlips,
  type VehicleDailyApiRow,
  type VehicleDailySlip,
} from '~/utils/ichiban'

describe('mapVehicleDailyApiRow', () => {
  it('snake_case の API 行を camelCase に変換する', () => {
    const row: VehicleDailyApiRow = {
      sale_date: '2026-06-21',
      vehicle_number: '8504',
      customer_code: '000001',
      customer_name: '㈱田浦畜産',
      origin_area_name: '長崎県',
      dest_area_name: '神奈川県横浜市',
      origin: '釧路',
      dest: '福岡県北九州市',
      is_subcontracted: false,
      amount: 65000,
      item_code: '0001',
      item_name: '冷凍食品',
      quantity: 10.5,
      unit_price: 6190.47,
      unit: '個',
      row_id: '20260621-1001',
    }
    expect(mapVehicleDailyApiRow(row)).toEqual({
      saleDate: '2026-06-21',
      vehicleNumber: '8504',
      customerCode: '000001',
      customerName: '㈱田浦畜産',
      originAreaName: '長崎県',
      destAreaName: '神奈川県横浜市',
      origin: '釧路',
      dest: '福岡県北九州市',
      isSubcontracted: false,
      amount: 65000,
      itemCode: '0001',
      itemName: '冷凍食品',
      quantity: 10.5,
      unitPrice: 6190.47,
      unit: '個',
      rowId: '20260621-1001',
    })
  })

  it('品名/数量/単価/単位が応答に無い場合 (rust-ichibanboshi#78 未デプロイ) は既定値で埋める', () => {
    const row: VehicleDailyApiRow = {
      sale_date: '2026-06-20',
      vehicle_number: '8504',
      customer_code: '000002',
      customer_name: '',
      origin_area_name: '',
      dest_area_name: '',
      origin: '',
      dest: '',
      is_subcontracted: true,
      amount: 40000,
      row_id: '20260620-1002',
    }
    const slip = mapVehicleDailyApiRow(row)
    expect(slip.itemCode).toBe('')
    expect(slip.itemName).toBe('')
    expect(slip.quantity).toBe(0)
    expect(slip.unitPrice).toBe(0)
    expect(slip.unit).toBe('')
  })
})

describe('vehicleDailyDateRange', () => {
  it('from は開始日、to は終了日の翌日 (半開区間)', () => {
    const fromTs = Date.UTC(2026, 5, 21, 8, 0, 0) / 1000
    const toTs = Date.UTC(2026, 5, 21, 18, 0, 0) / 1000
    expect(vehicleDailyDateRange(fromTs, toTs)).toEqual({ from: '2026-06-21', to: '2026-06-22' })
  })

  it('複数日にまたがる選択でも to は最終日の翌日になる', () => {
    const fromTs = Date.UTC(2026, 5, 30, 22, 0, 0) / 1000
    const toTs = Date.UTC(2026, 6, 1, 3, 0, 0) / 1000
    expect(vehicleDailyDateRange(fromTs, toTs)).toEqual({ from: '2026-06-30', to: '2026-07-02' })
  })

  it('年またぎでも正しく繰り上がる', () => {
    const fromTs = Date.UTC(2026, 11, 31, 22, 0, 0) / 1000
    const toTs = fromTs
    expect(vehicleDailyDateRange(fromTs, toTs)).toEqual({ from: '2026-12-31', to: '2027-01-01' })
  })
})

describe('normalizeLocationName', () => {
  it('前後の空白を除去する', () => {
    expect(normalizeLocationName(' 北九州市 ')).toBe('北九州市')
  })
  it('全角英数を NFKC で半角化する (将来の混在データ対策)', () => {
    expect(normalizeLocationName('ＡＢＣ')).toBe('ABC')
  })
  it('null/undefined は空文字扱い (API がフィールド未提供の場合にクラッシュしない、実際に発生した回帰)', () => {
    expect(normalizeLocationName(undefined)).toBe('')
    expect(normalizeLocationName(null)).toBe('')
  })
})

describe('matchLocationLevel', () => {
  it('正規化後に完全一致すれば exact', () => {
    expect(matchLocationLevel('北九州市', '北九州市')).toBe('exact')
  })
  it('前後空白違いでも exact (normalize 後比較)', () => {
    expect(matchLocationLevel(' 北九州市 ', '北九州市')).toBe('exact')
  })
  it('dtako 側が一番星側の部分文字列なら partial', () => {
    expect(matchLocationLevel('北九州市', '福岡県北九州市')).toBe('partial')
  })
  it('一番星側が dtako 側の部分文字列でも partial (逆方向)', () => {
    expect(matchLocationLevel('福岡県北九州市', '北九州市')).toBe('partial')
  })
  it('どちらとも無関係なら none', () => {
    expect(matchLocationLevel('札幌市', '福岡県北九州市')).toBe('none')
  })
  it('どちらかが空文字なら none (判定不能)', () => {
    expect(matchLocationLevel('', '福岡県北九州市')).toBe('none')
    expect(matchLocationLevel('北九州市', '')).toBe('none')
  })
  it('一番星側が undefined (API にフィールドが無い) でも none で判定不能扱いになりクラッシュしない', () => {
    expect(matchLocationLevel('北九州市', undefined)).toBe('none')
  })

  it('dtako 側が郡を含むフル表記でも一番星側の郡省略表記と partial 一致する (Refs #348)', () => {
    expect(matchLocationLevel('北海道川上郡標茶町多和星空の黒牛加工・直売所', '北海道標茶町')).toBe('partial')
  })
  it('郡除去の対象は複数の市町村パターンで機能する (中部飼料/大石畜産の実データ、Refs #348)', () => {
    expect(matchLocationLevel('北海道河東郡士幌町中士幌', '北海道士幌町')).toBe('partial')
    expect(matchLocationLevel('北海道河東郡上士幌町上士幌東２線', '北海道上士幌町')).toBe('partial')
  })
  it('郡を含まない市 (政令市等) の突合は郡除去の影響を受けない', () => {
    expect(matchLocationLevel('北海道釧路市西港２-101-1', '北海道釧路市')).toBe('partial')
    expect(matchLocationLevel('福岡県北九州市', '北九州市')).toBe('partial')
  })
})

describe('scoreVehicleDailySlips', () => {
  function slip(overrides: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
    return {
      saleDate: '2026-06-21',
      vehicleNumber: '8504',
      customerCode: '000001',
      customerName: 'テスト得意先',
      originAreaName: '',
      destAreaName: '',
      origin: '',
      dest: '',
      isSubcontracted: false,
      amount: 10000,
      itemCode: '',
      itemName: '',
      quantity: 0,
      unitPrice: 0,
      unit: '',
      rowId: 'row-1',
      ...overrides,
    }
  }

  it('積地・卸地とも一致する伝票が最上位 (score降順) にソートされる', () => {
    const noMatch = slip({ rowId: 'no-match', originAreaName: '東京都', destAreaName: '大阪府' })
    const bothMatch = slip({ rowId: 'both-match', originAreaName: '長崎県', destAreaName: '福岡県北九州市' })
    const partialMatch = slip({ rowId: 'partial', originAreaName: '長崎県', destAreaName: '' })

    const result = scoreVehicleDailySlips('長崎県', '北九州市', [noMatch, bothMatch, partialMatch])

    expect(result[0]!.slip.rowId).toBe('both-match')
    // origin: '長崎県' 完全一致(exact=2)、dest: '北九州市'⊂'福岡県北九州市'(partial=1) → 計3
    expect(result[0]!.score).toBe(3)
    expect(result[0]!.suggested).toBe(true)
  })

  it('origin_area_name が空なら origin (発地N) にフォールバックする', () => {
    const s = slip({ originAreaName: '', origin: '釧路', destAreaName: '福岡県北九州市' })
    const [scored] = scoreVehicleDailySlips('釧路', '北九州市', [s])
    expect(scored!.originMatch).toBe('exact')
    expect(scored!.destMatch).toBe('partial')
    expect(scored!.suggested).toBe(true)
  })

  it('片方だけ一致では suggested は false', () => {
    const s = slip({ originAreaName: '長崎県', destAreaName: '東京都' })
    const [scored] = scoreVehicleDailySlips('長崎県', '北九州市', [s])
    expect(scored!.destMatch).toBe('none')
    expect(scored!.suggested).toBe(false)
  })

  it('dtako 側の地名が空文字なら常に none 判定 (何も一致させない)', () => {
    const s = slip({ originAreaName: '長崎県', destAreaName: '福岡県北九州市' })
    const [scored] = scoreVehicleDailySlips('', '', [s])
    expect(scored!.score).toBe(0)
    expect(scored!.suggested).toBe(false)
  })
})

describe('calcProfitEfficiency', () => {
  it('距離・時間が正であれば効率指標を計算する', () => {
    const result = calcProfitEfficiency(65000, 100, 480, 300)
    expect(result.yenPerKm).toBeCloseTo(650)
    expect(result.yenPerHourBound).toBeCloseTo(65000 / 8)
    expect(result.yenPerHourDrive).toBeCloseTo(65000 / 5)
  })

  it('距離が 0 なら yenPerKm は null (ゼロ除算ガード)', () => {
    expect(calcProfitEfficiency(65000, 0, 480, 300).yenPerKm).toBeNull()
  })

  it('拘束時間が 0 なら yenPerHourBound は null', () => {
    expect(calcProfitEfficiency(65000, 100, 0, 300).yenPerHourBound).toBeNull()
  })

  it('運転時間が 0 なら yenPerHourDrive は null', () => {
    expect(calcProfitEfficiency(65000, 100, 480, 0).yenPerHourDrive).toBeNull()
  })
})

describe('fetchVehicleDailySlips', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('/api/ichiban/api/sales/vehicle-daily を叩き camelCase の配列を返す', async () => {
    fetchMock.mockResolvedValue({
      source_table: '運転日報明細',
      data: [{
        sale_date: '2026-06-21',
        vehicle_number: '8504',
        customer_code: '000001',
        customer_name: '㈱田浦畜産',
        origin_area_name: '長崎県',
        dest_area_name: '福岡県',
        origin: '釧路',
        dest: '福岡県北九州市',
        is_subcontracted: false,
        amount: 65000,
        row_id: '20260621-1001',
      }],
    })

    const result = await fetchVehicleDailySlips('8504', '2026-06-01', '2026-07-01')

    expect(fetchMock).toHaveBeenCalledWith('/api/ichiban/api/sales/vehicle-daily', {
      query: { vehicle: '8504', from: '2026-06-01', to: '2026-07-01' },
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.vehicleNumber).toBe('8504')
    expect(result[0]!.rowId).toBe('20260621-1001')
  })
})

describe('searchVehicleDailySlips', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('vehicle を指定せず customer/origin/dest だけでも検索できる (Refs #330 PR5)', async () => {
    fetchMock.mockResolvedValue({ source_table: '運転日報明細', data: [] })

    await searchVehicleDailySlips({
      from: '2026-06-01',
      to: '2026-07-01',
      customer: '000001',
      origin: '長崎',
    })

    expect(fetchMock).toHaveBeenCalledWith('/api/ichiban/api/sales/vehicle-daily', {
      query: {
        from: '2026-06-01',
        to: '2026-07-01',
        customer: '000001',
        origin: '長崎',
      },
    })
  })

  it('複数車輌の伝票を camelCase にマップして返す', async () => {
    fetchMock.mockResolvedValue({
      source_table: '運転日報明細',
      data: [
        {
          sale_date: '2026-06-21',
          vehicle_number: '8504',
          customer_code: '000001',
          customer_name: '㈱田浦畜産',
          origin_area_name: '長崎県',
          dest_area_name: '福岡県',
          origin: '',
          dest: '',
          is_subcontracted: false,
          amount: 65000,
          row_id: '20260621-1001',
        },
        {
          sale_date: '2026-06-22',
          vehicle_number: '9012',
          customer_code: '000001',
          customer_name: '㈱田浦畜産',
          origin_area_name: '長崎県佐世保市',
          dest_area_name: '東京都',
          origin: '',
          dest: '',
          is_subcontracted: false,
          amount: 80000,
          row_id: '20260622-1003',
        },
      ],
    })

    const result = await searchVehicleDailySlips({ from: '2026-06-01', to: '2026-07-01', customer: '000001' })

    expect(result).toHaveLength(2)
    expect(result.map(s => s.vehicleNumber)).toEqual(['8504', '9012'])
  })
})
