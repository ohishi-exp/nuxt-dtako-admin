import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SALARY_COST_KIND,
  SALARY_FETCH_LIMIT,
  fetchActualWageByDriver,
  fetchSalaryCostRows,
  foldSalaryByDriver,
  splitCostDateRange,
} from '~/utils/profit-actual-wage'
import type { CostRow, CostsDailyApiRow } from '~/utils/margin'

/** 経費 1 行。試験で効く列だけ渡し、残りは既定で埋める。 */
function cost(over: Partial<CostRow> = {}): CostRow {
  return {
    operationDate: '2026-07-25',
    vehicleNumber: '0001',
    vehicleBranch: '06',
    driverCode: '1412',
    costCode: '0801',
    costName: '給料',
    costKind: '08',
    costKindName: '給与(人件費)',
    quantity: 0,
    unitPrice: 0,
    amount: 0,
    dieselTax: 0,
    km: 0,
    isFixed: false,
    rowId: '20260725-0001',
    remarks: '',
    vendorName: '',
    ...over,
  }
}

/** API の応答行 (snake_case)。 */
function apiRow(over: Partial<CostsDailyApiRow> = {}): CostsDailyApiRow {
  return {
    operation_date: '2026-07-25',
    vehicle_number: '0001',
    vehicle_branch: '06',
    driver_code: '1412',
    cost_code: '0801',
    cost_name: '給料',
    cost_kind: '08',
    cost_kind_name: '給与(人件費)',
    quantity: 0,
    unit_price: 0,
    amount: 0,
    diesel_tax: 0,
    km: 0,
    is_fixed: false,
    row_id: '20260725-0001',
    ...over,
  }
}

describe('定数', () => {
  it('経費種別は 08 給与(人件費)、上限は上流の最大 5000', () => {
    expect(SALARY_COST_KIND).toBe('08')
    expect(SALARY_FETCH_LIMIT).toBe(5000)
  })
})

describe('splitCostDateRange', () => {
  it('月を前半・後半に割る (半開区間のまま繋がる)', () => {
    expect(splitCostDateRange('2026-07-01', '2026-08-01')).toEqual({
      first: { from: '2026-07-01', to: '2026-07-16' },
      second: { from: '2026-07-16', to: '2026-08-01' },
    })
  })

  it('2 日あれば 1 日ずつに割れる', () => {
    expect(splitCostDateRange('2026-07-01', '2026-07-03')).toEqual({
      first: { from: '2026-07-01', to: '2026-07-02' },
      second: { from: '2026-07-02', to: '2026-07-03' },
    })
  })

  it('年を跨いでも割れる', () => {
    expect(splitCostDateRange('2026-12-01', '2027-01-01')).toEqual({
      first: { from: '2026-12-01', to: '2026-12-16' },
      second: { from: '2026-12-16', to: '2027-01-01' },
    })
  })

  it('1 日しか無ければ割らない (null)', () => {
    expect(splitCostDateRange('2026-07-01', '2026-07-02')).toBeNull()
  })

  it('区間が空 / 逆順でも割らない', () => {
    expect(splitCostDateRange('2026-07-01', '2026-07-01')).toBeNull()
    expect(splitCostDateRange('2026-08-01', '2026-07-01')).toBeNull()
  })

  it('日付が読めなければ割らない (from 側 / to 側のどちらでも)', () => {
    expect(splitCostDateRange('', '2026-08-01')).toBeNull()
    expect(splitCostDateRange('2026-07-01', 'いつか')).toBeNull()
  })
})

describe('foldSalaryByDriver', () => {
  it('★ 車輌をまたいで分かれた行を乗務員CD で合算する (中村・柳井・西島は 2 行)', () => {
    const rows = [
      cost({ driverCode: '1412', vehicleNumber: '0001', amount: 500000 }),
      cost({ driverCode: '1412', vehicleNumber: '0040', amount: 119000 }),
      cost({ driverCode: '1742', vehicleNumber: '0002', amount: 509000 }),
    ]
    expect(foldSalaryByDriver(rows)).toEqual({ '1412': 619000, '1742': 509000 })
  })

  it('★ 2026-07 の帯広5名で計 ¥2,815,000 (上司向け資料の支給額と一円まで一致)', () => {
    const rows = [
      cost({ driverCode: '1412', amount: 400000 }), cost({ driverCode: '1412', amount: 219000 }),
      cost({ driverCode: '1587', amount: 300000 }), cost({ driverCode: '1587', amount: 262500 }),
      cost({ driverCode: '1656', amount: 300000 }), cost({ driverCode: '1656', amount: 252500 }),
      // 佐竹の ¥572,000 は 07-27 の過払い ¥1,000 込み。**調整しない** (オーナー判断)。
      cost({ driverCode: '1732', amount: 572000 }),
      cost({ driverCode: '1742', amount: 509000 }),
    ]
    const byDriver = foldSalaryByDriver(rows)
    expect(byDriver).toEqual({ '1412': 619000, '1587': 562500, '1656': 552500, '1732': 572000, '1742': 509000 })
    expect(Object.values(byDriver).reduce((s, v) => s + v, 0)).toBe(2815000)
  })

  it('08 以外の経費は数えない', () => {
    const rows = [
      cost({ driverCode: '1412', costKind: '08', amount: 619000 }),
      cost({ driverCode: '1412', costKind: '01', amount: 122950 }),
      cost({ driverCode: '1412', costKind: '11', amount: 50000 }),
    ]
    expect(foldSalaryByDriver(rows)).toEqual({ '1412': 619000 })
  })

  it('★ 乗務員CD が空の行は落とす (乗務員CD を引けない行が拾ってしまうため)', () => {
    const rows = [cost({ driverCode: '', amount: 900000 }), cost({ driverCode: '   ', amount: 900000 })]
    expect(foldSalaryByDriver(rows)).toEqual({})
  })

  it('乗務員CD の前後の空白は落として畳む', () => {
    expect(foldSalaryByDriver([cost({ driverCode: ' 1412 ', amount: 1 })])).toEqual({ '1412': 1 })
  })

  it('軽油引取税も足す (給与は 0 だが 0 でない行を黙って落とさない)', () => {
    expect(foldSalaryByDriver([cost({ amount: 1000, dieselTax: 7 })])).toEqual({ '1412': 1007 })
  })

  it('1 行も無ければ空 (0 の行を作らない)', () => {
    expect(foldSalaryByDriver([])).toEqual({})
  })
})

describe('fetchSalaryCostRows', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('乗務員CD ＋ 経費種別 08 ＋ 上限 5000 で叩く', async () => {
    fetchMock.mockResolvedValue({ source_table: '経費明細', data: [apiRow({ amount: 619000 })] })

    const rows = await fetchSalaryCostRows('1412', '2026-07-01', '2026-08-01')

    expect(fetchMock).toHaveBeenCalledWith('/api/ichiban/api/costs/vehicle-daily', {
      query: { driver: '1412', kind: '08', from: '2026-07-01', to: '2026-08-01', limit: '5000' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.amount).toBe(619000)
    expect(rows[0]!.driverCode).toBe('1412')
  })

  it('★ 上限で切れたら期間を割って引き直す (黙って短い額を出さない)', async () => {
    const full = Array.from({ length: SALARY_FETCH_LIMIT }, (_, i) => apiRow({ row_id: `full-${i}`, amount: 1 }))
    fetchMock
      .mockResolvedValueOnce({ source_table: '経費明細', data: full })
      .mockResolvedValueOnce({ source_table: '経費明細', data: [apiRow({ row_id: 'a', amount: 300000 })] })
      .mockResolvedValueOnce({ source_table: '経費明細', data: [apiRow({ row_id: 'b', amount: 319000 })] })

    const rows = await fetchSalaryCostRows('1412', '2026-07-01', '2026-08-01')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1]![1].query).toMatchObject({ from: '2026-07-01', to: '2026-07-16' })
    expect(fetchMock.mock.calls[2]![1].query).toMatchObject({ from: '2026-07-16', to: '2026-08-01' })
    expect(rows.map(r => r.rowId)).toEqual(['a', 'b'])
    expect(foldSalaryByDriver(rows)).toEqual({ '1412': 619000 })
  })

  it('★ 1 日まで割っても切れるなら投げる (切れた行を落として実支給と名乗らせない)', async () => {
    const full = Array.from({ length: SALARY_FETCH_LIMIT }, (_, i) => apiRow({ row_id: `full-${i}` }))
    fetchMock.mockResolvedValue({ source_table: '経費明細', data: full })

    await expect(fetchSalaryCostRows('1412', '2026-07-01', '2026-07-02'))
      .rejects.toThrow('乗務員 1412 の給与行が上限 5000 件で切れました (2026-07-01〜2026-07-02) — これ以上期間を割れません')
  })
})

describe('fetchActualWageByDriver', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('乗務員ごとに引いて 1 つの表に畳む', async () => {
    fetchMock
      .mockResolvedValueOnce({ source_table: '経費明細', data: [apiRow({ driver_code: '1412', amount: 619000 })] })
      .mockResolvedValueOnce({ source_table: '経費明細', data: [apiRow({ driver_code: '1742', amount: 509000 })] })

    const byDriver = await fetchActualWageByDriver(['1412', '1742'], '2026-07-01', '2026-08-01')

    expect(byDriver).toEqual({ '1412': 619000, '1742': 509000 })
    expect(fetchMock.mock.calls.map(c => c[1].query.driver)).toEqual(['1412', '1742'])
  })

  it('行が 1 本も無い乗務員は鍵を作らない (0 に倒さない)', async () => {
    fetchMock.mockResolvedValue({ source_table: '経費明細', data: [] })

    expect(await fetchActualWageByDriver(['1412'], '2026-07-01', '2026-08-01')).toEqual({})
  })

  it('1 人でも失敗したら投げる (半分だけ埋まった表を実支給と名乗らせない)', async () => {
    fetchMock
      .mockResolvedValueOnce({ source_table: '経費明細', data: [apiRow({ amount: 619000 })] })
      .mockRejectedValueOnce(new Error('502 Bad Gateway'))

    await expect(fetchActualWageByDriver(['1412', '1742'], '2026-07-01', '2026-08-01'))
      .rejects.toThrow('502 Bad Gateway')
  })

  it('乗務員が 1 人も居なければ上流を叩かない', async () => {
    expect(await fetchActualWageByDriver([], '2026-07-01', '2026-08-01')).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
