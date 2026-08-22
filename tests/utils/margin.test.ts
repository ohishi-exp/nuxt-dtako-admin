import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mapCostApiRow,
  fetchVehicleCosts,
  monthCostRange,
  costYen,
  deriveFuelRate,
  emptyFuelRate,
  fuelYenFor,
  parseFuelRates,
  serializeFuelRates,
  setFuelRate,
  effectiveFuelRate,
  buildOperationMargins,
  marginRate,
  summarizeMargins,
  emptyMarginTotals,
  groupMarginsByDriver,
  marginCsvLines,
  parseMarginCache,
  serializeMarginCache,
  EXCLUDED_KINDS,
  LABOR_KINDS,
  FUEL_KIND,
  ADBLUE_KIND,
  FUEL_RATE_KEY,
  type CostRow,
  type CostsDailyApiRow,
  type MarginOperationInput,
  type OperationMargin,
} from '~/utils/margin'

function cost(over: Partial<CostRow> = {}): CostRow {
  return {
    operationDate: '2026-07-01',
    vehicleNumber: '1109',
    vehicleBranch: '01',
    driverCode: '0123',
    costCode: '0621',
    costName: '軽油費',
    costKind: '04',
    costKindName: '通行料',
    quantity: 0,
    unitPrice: 0,
    amount: 1000,
    dieselTax: 0,
    km: 0,
    isFixed: false,
    rowId: '20260701-1',
    ...over,
  }
}

function op(over: Partial<MarginOperationInput> = {}): MarginOperationInput {
  return {
    unkoNo: '2607011000000000001109',
    date: '2026-07-01',
    driverName: '佐竹 繁',
    vehicleCode: '1109',
    totalKm: 100,
    salesYen: 50000,
    allowanceYen: 8000,
    ...over,
  }
}

describe('mapCostApiRow', () => {
  it('snake_case の API 行を camelCase にする', () => {
    const row: CostsDailyApiRow = {
      operation_date: '2026-07-05',
      vehicle_number: '1109',
      vehicle_branch: '01',
      driver_code: '0123',
      cost_code: '0621',
      cost_name: '軽油費',
      cost_kind: '01',
      cost_kind_name: '燃料ｵｲﾙ代',
      quantity: 300.5,
      unit_price: 120.5,
      amount: 36210,
      diesel_tax: 9646,
      km: 12345.6,
      is_fixed: false,
      row_id: '20260705-1001',
    }
    expect(mapCostApiRow(row)).toEqual({
      operationDate: '2026-07-05',
      vehicleNumber: '1109',
      vehicleBranch: '01',
      driverCode: '0123',
      costCode: '0621',
      costName: '軽油費',
      costKind: '01',
      costKindName: '燃料ｵｲﾙ代',
      quantity: 300.5,
      unitPrice: 120.5,
      amount: 36210,
      dieselTax: 9646,
      km: 12345.6,
      isFixed: false,
      rowId: '20260705-1001',
    })
  })
})

describe('fetchVehicleCosts', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('/api/ichiban/api/costs/vehicle-daily を limit 5000 で叩く', async () => {
    fetchMock.mockResolvedValue({
      source_table: '経費明細 + 経費ﾏｽﾀ + 経費種別ﾏｽﾀ',
      data: [{
        operation_date: '2026-07-05',
        vehicle_number: '1109',
        vehicle_branch: '01',
        driver_code: '0123',
        cost_code: '0641',
        cost_name: '高速代',
        cost_kind: '04',
        cost_kind_name: '通行料',
        quantity: 1,
        unit_price: 3200,
        amount: 3200,
        diesel_tax: 0,
        km: 0,
        is_fixed: false,
        row_id: '20260705-2001',
      }],
    })

    const rows = await fetchVehicleCosts('1109', '2026-07-01', '2026-08-01')

    expect(fetchMock).toHaveBeenCalledWith('/api/ichiban/api/costs/vehicle-daily', {
      query: { vehicle: '1109', from: '2026-07-01', to: '2026-08-01', limit: '5000' },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.costKind).toBe('04')
    expect(rows[0]!.rowId).toBe('20260705-2001')
  })
})

describe('monthCostRange', () => {
  it('月ちょうどの半開区間を返す', () => {
    expect(monthCostRange('2026-07')).toEqual({ from: '2026-07-01', to: '2026-08-01' })
  })

  it('12 月は翌年 1 月 1 日で閉じる', () => {
    expect(monthCostRange('2026-12')).toEqual({ from: '2026-12-01', to: '2027-01-01' })
  })
})

describe('costYen', () => {
  it('税抜金額に軽油引取税を足す', () => {
    expect(costYen(cost({ amount: 36210, dieselTax: 9646 }))).toBe(45856)
  })

  it('軽油引取税が 0 なら税抜金額そのまま', () => {
    expect(costYen(cost({ amount: 3200, dieselTax: 0 }))).toBe(3200)
  })
})

describe('経費種別の定数', () => {
  it('粗利に入れないのは 燃料・人件費・賞与・アドブルー', () => {
    expect(EXCLUDED_KINDS).toEqual(['01', '08', '11', '15'])
    expect(LABOR_KINDS).toEqual(['08', '11'])
    expect(FUEL_KIND).toBe('01')
    expect(ADBLUE_KIND).toBe('15')
  })

  it('localStorage のキーは版番号付き', () => {
    expect(FUEL_RATE_KEY).toBe('dtako:margin:fuel-rate:v1')
  })
})

describe('deriveFuelRate', () => {
  it('燃料 (01) だけを数え、他の種別は無視する', () => {
    const rate = deriveFuelRate([
      cost({ costKind: '01', quantity: 100, amount: 12000, dieselTax: 3210 }),
      cost({ costKind: '04', quantity: 999, amount: 999999, dieselTax: 999 }),
    ], 500)
    expect(rate.yenPerLiter).toBe(120)
    expect(rate.kmPerLiter).toBe(5)
    expect(rate.dieselTaxPerLiter).toBe(32.1)
  })

  it('給油量が 0 なら単価も燃費も出せない', () => {
    expect(deriveFuelRate([cost({ costKind: '01', quantity: 0, amount: 12000 })], 500))
      .toEqual(emptyFuelRate())
  })

  it('燃料の行が 1 つも無ければ出せない', () => {
    expect(deriveFuelRate([cost({ costKind: '04' })], 500)).toEqual(emptyFuelRate())
  })

  it('走行距離が 0 なら燃費だけ null (単価は残す)', () => {
    const rate = deriveFuelRate([cost({ costKind: '01', quantity: 100, amount: 12000 })], 0)
    expect(rate.yenPerLiter).toBe(120)
    expect(rate.kmPerLiter).toBeNull()
  })
})

describe('fuelYenFor', () => {
  it('距離 ÷ 燃費 × 単価', () => {
    expect(fuelYenFor(500, { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 32.1 })).toBe(12000)
  })

  it('単価が出せなければ null', () => {
    expect(fuelYenFor(500, { yenPerLiter: null, kmPerLiter: 5, dieselTaxPerLiter: null })).toBeNull()
  })

  it('燃費が出せなければ null', () => {
    expect(fuelYenFor(500, { yenPerLiter: 120, kmPerLiter: null, dieselTaxPerLiter: null })).toBeNull()
  })
})

describe('parseFuelRates', () => {
  it('null / 空文字は空', () => {
    expect(parseFuelRates(null)).toEqual({})
    expect(parseFuelRates('')).toEqual({})
    expect(parseFuelRates(undefined)).toEqual({})
  })

  it('壊れた JSON は空 (投げない)', () => {
    expect(parseFuelRates('{')).toEqual({})
  })

  it('オブジェクトでなければ空', () => {
    expect(parseFuelRates('42')).toEqual({})
  })

  it('null は空', () => {
    expect(parseFuelRates('null')).toEqual({})
  })

  it('片方だけ入っていても読む', () => {
    expect(parseFuelRates('{"1109":{"yenPerLiter":130,"kmPerLiter":null}}'))
      .toEqual({ 1109: { yenPerLiter: 130, kmPerLiter: null } })
  })

  it('両方入っていれば両方読む', () => {
    expect(parseFuelRates('{"1109":{"yenPerLiter":130,"kmPerLiter":4.2}}'))
      .toEqual({ 1109: { yenPerLiter: 130, kmPerLiter: 4.2 } })
  })

  it('値がオブジェクトでない車輌は捨てる', () => {
    expect(parseFuelRates('{"1109":130}')).toEqual({})
  })

  it('値が null の車輌は捨てる', () => {
    expect(parseFuelRates('{"1109":null}')).toEqual({})
  })

  it('両方とも使えない値なら車輌ごと捨てる', () => {
    expect(parseFuelRates('{"1109":{"yenPerLiter":"130","kmPerLiter":0}}')).toEqual({})
  })

  it('数でない / NaN / 0 以下 はどれも入っていない扱い', () => {
    expect(parseFuelRates('{"a":{"yenPerLiter":"x","kmPerLiter":5}}').a)
      .toEqual({ yenPerLiter: null, kmPerLiter: 5 })
    // JSON に NaN は書けないので Infinity 相当を JSON.parse を通さずに確かめる
    expect(parseFuelRates(JSON.stringify({ b: { yenPerLiter: 1e999, kmPerLiter: 5 } })).b)
      .toEqual({ yenPerLiter: null, kmPerLiter: 5 })
    expect(parseFuelRates('{"c":{"yenPerLiter":-1,"kmPerLiter":5}}').c)
      .toEqual({ yenPerLiter: null, kmPerLiter: 5 })
  })

  it('serializeFuelRates と往復できる', () => {
    const map = { 1109: { yenPerLiter: 130, kmPerLiter: 4.2 } }
    expect(parseFuelRates(serializeFuelRates(map))).toEqual(map)
  })
})

describe('setFuelRate', () => {
  it('車輌C が空なら何もしない', () => {
    const map = { 1109: { yenPerLiter: 130, kmPerLiter: null } }
    expect(setFuelRate(map, '', 'yenPerLiter', 140)).toBe(map)
  })

  it('未設定の車輌に入れられる', () => {
    expect(setFuelRate({}, '1109', 'yenPerLiter', 130))
      .toEqual({ 1109: { yenPerLiter: 130, kmPerLiter: null } })
  })

  it('既にある車輌のもう片方だけを入れ替える', () => {
    expect(setFuelRate({ 1109: { yenPerLiter: 130, kmPerLiter: null } }, '1109', 'kmPerLiter', 4.2))
      .toEqual({ 1109: { yenPerLiter: 130, kmPerLiter: 4.2 } })
  })

  it('0 以下は「消す」扱い。両方消えたら車輌ごと落とす', () => {
    expect(setFuelRate({ 1109: { yenPerLiter: 130, kmPerLiter: null } }, '1109', 'yenPerLiter', 0))
      .toEqual({})
  })

  it('片方が残るなら車輌は残る', () => {
    expect(setFuelRate({ 1109: { yenPerLiter: 130, kmPerLiter: 4.2 } }, '1109', 'yenPerLiter', 0))
      .toEqual({ 1109: { yenPerLiter: null, kmPerLiter: 4.2 } })
  })

  it('元の map を書き換えない', () => {
    const map = { 1109: { yenPerLiter: 130, kmPerLiter: null } }
    setFuelRate(map, '1109', 'kmPerLiter', 4.2)
    expect(map).toEqual({ 1109: { yenPerLiter: 130, kmPerLiter: null } })
  })
})

describe('effectiveFuelRate', () => {
  const derived = { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 32.1 }

  it('上書きが無ければ実績そのまま', () => {
    expect(effectiveFuelRate(derived, undefined)).toEqual(derived)
  })

  it('上書きがあればそちらを使う', () => {
    expect(effectiveFuelRate(derived, { yenPerLiter: 130, kmPerLiter: 4.2 }))
      .toEqual({ yenPerLiter: 130, kmPerLiter: 4.2, dieselTaxPerLiter: 32.1 })
  })

  it('上書きが片方だけなら、もう片方は実績のまま', () => {
    expect(effectiveFuelRate(derived, { yenPerLiter: null, kmPerLiter: null })).toEqual(derived)
  })
})

describe('buildOperationMargins', () => {
  it('日・車輌が一致する変動費は直課、固定費は距離比で按分する', () => {
    const ops = [
      op({ unkoNo: 'A', date: '2026-07-01', totalKm: 300, salesYen: 50000, allowanceYen: 8000 }),
      op({ unkoNo: 'B', date: '2026-07-02', totalKm: 200, salesYen: 40000, allowanceYen: 7000 }),
    ]
    const costs = [
      // 燃費・単価のもと (粗利の経費には入らない)
      cost({ costKind: '01', quantity: 100, amount: 12000, dieselTax: 0 }),
      // 変動費・日が一致 → A に直課
      cost({ costKind: '04', operationDate: '2026-07-01', amount: 3000 }),
      // 固定費 → 距離比 (300:200) で按分
      cost({ costKind: '13', operationDate: '2026-07-01', amount: 5000, isFixed: true }),
    ]
    const res = buildOperationMargins(ops, costs, {})

    expect(res.kmByVehicle.get('1109')).toBe(500)
    expect(res.ratesByVehicle.get('1109')).toEqual({ yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 0 })

    const [a, b] = res.operations as [OperationMargin, OperationMargin]
    expect(a.vehicleTotalKm).toBe(500)
    expect(a.directCostYen).toBe(3000)
    expect(a.allocatedCostYen).toBe(3000)
    expect(a.fuelYen).toBe(7200)
    expect(a.marginYen).toBe(50000 - 8000 - 7200 - 3000 - 3000)
    expect(b.directCostYen).toBe(0)
    expect(b.allocatedCostYen).toBe(2000)
    expect(b.fuelYen).toBe(4800)
    expect(b.marginYen).toBe(40000 - 7000 - 4800 - 0 - 2000)
    expect(res.unallocatedCostYen).toBe(0)
  })

  it('日・車輌が運行に当たらない変動費は按分に回す', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100 })],
      [cost({ costKind: '04', operationDate: '2026-07-31', amount: 1000 })],
      {},
    )
    expect(res.operations[0]!.directCostYen).toBe(0)
    expect(res.operations[0]!.allocatedCostYen).toBe(1000)
  })

  it('同じ日・同じ車輌に運行が 2 本あれば直課も距離比で割る', () => {
    const res = buildOperationMargins(
      [op({ unkoNo: 'A', totalKm: 300 }), op({ unkoNo: 'B', totalKm: 100 })],
      [cost({ costKind: '04', amount: 4000 })],
      {},
    )
    expect(res.operations[0]!.directCostYen).toBe(3000)
    expect(res.operations[1]!.directCostYen).toBe(1000)
  })

  it('当たった運行の距離が 0 なら直課せず按分に回す', () => {
    const res = buildOperationMargins(
      [op({ unkoNo: 'A', totalKm: 0 }), op({ unkoNo: 'B', date: '2026-07-02', totalKm: 500 })],
      [cost({ costKind: '04', operationDate: '2026-07-01', amount: 1000 })],
      {},
    )
    expect(res.operations[0]!.directCostYen).toBe(0)
    expect(res.operations[0]!.allocatedCostYen).toBe(0)
    expect(res.operations[1]!.allocatedCostYen).toBe(1000)
  })

  it('その車輌の運行を 1 本も持っていない経費は配らず数える', () => {
    const res = buildOperationMargins(
      [op({ vehicleCode: '1109' })],
      [cost({ costKind: '04', vehicleNumber: '9999', amount: 1000 })],
      {},
    )
    expect(res.operations[0]!.allocatedCostYen).toBe(0)
    expect(res.unallocatedCostYen).toBe(1000)
  })

  it('車輌の走行距離が 0 なら按分せず数える (0 除算を粗利に混ぜない)', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 0 })],
      [cost({ costKind: '13', amount: 1000, isFixed: true })],
      {},
    )
    expect(res.operations[0]!.allocatedCostYen).toBe(0)
    expect(res.unallocatedCostYen).toBe(1000)
  })

  it('同じ車輌の按分ぶんは足し合わせてから配る', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100 })],
      [
        cost({ costKind: '13', amount: 1000, isFixed: true }),
        cost({ costKind: '14', amount: 2000, isFixed: true }),
      ],
      {},
    )
    expect(res.operations[0]!.allocatedCostYen).toBe(3000)
  })

  it('人件費 (08/11) は粗利に入れず、別枠で数える', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100, salesYen: 50000, allowanceYen: 8000 })],
      [
        cost({ costKind: '01', quantity: 10, amount: 1200 }),
        cost({ costKind: '08', amount: 300000, isFixed: true }),
        cost({ costKind: '11', amount: 50000, isFixed: true }),
      ],
      {},
    )
    const m = res.operations[0]!
    expect(m.directCostYen).toBe(0)
    expect(m.allocatedCostYen).toBe(0)
    expect(m.laborYen).toBe(350000)
    expect(res.ichibanLaborYen).toBe(350000)
    expect(m.marginYen).toBe(50000 - 8000 - 1200)
  })

  it('人件費も配れなければ数える', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 0 })],
      [cost({ costKind: '08', amount: 300000, isFixed: true })],
      {},
    )
    expect(res.operations[0]!.laborYen).toBe(0)
    expect(res.unallocatedLaborYen).toBe(300000)
  })

  it('人件費は日・車輌が一致すれば直課される', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100 })],
      [cost({ costKind: '08', amount: 30000, isFixed: false })],
      {},
    )
    expect(res.operations[0]!.laborYen).toBe(30000)
  })

  it('燃料系 (01 + 15) は粗利に入れず参考として数える', () => {
    const res = buildOperationMargins(
      [op()],
      [
        cost({ costKind: '01', quantity: 10, amount: 1200, dieselTax: 321 }),
        cost({ costKind: '15', amount: 2000 }),
        cost({ costKind: '04', amount: 500 }),
      ],
      {},
    )
    expect(res.ichibanFuelYen).toBe(1200 + 321 + 2000)
    expect(res.operations[0]!.directCostYen).toBe(500)
  })

  it('燃費が出せない車輌は燃料代も粗利も null', () => {
    const res = buildOperationMargins([op({ totalKm: 100 })], [], {})
    expect(res.operations[0]!.fuelYen).toBeNull()
    expect(res.operations[0]!.marginYen).toBeNull()
    expect(res.ratesByVehicle.get('1109')).toEqual(emptyFuelRate())
  })

  it('上書きがあれば実績より優先し、実績も残す', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100 })],
      [cost({ costKind: '01', quantity: 20, amount: 2400 })],
      { 1109: { yenPerLiter: 130, kmPerLiter: 4 } },
    )
    expect(res.derivedByVehicle.get('1109')!.yenPerLiter).toBe(120)
    expect(res.derivedByVehicle.get('1109')!.kmPerLiter).toBe(5)
    expect(res.ratesByVehicle.get('1109')!.kmPerLiter).toBe(4)
    expect(res.operations[0]!.fuelYen).toBe((100 / 4) * 130)
  })

  it('車輌が違う経費は燃費の計算に混ざらない', () => {
    const res = buildOperationMargins(
      [op({ vehicleCode: '1109', totalKm: 100 })],
      [
        cost({ costKind: '01', vehicleNumber: '1109', quantity: 20, amount: 2400 }),
        cost({ costKind: '01', vehicleNumber: '9999', quantity: 1000, amount: 999999 }),
      ],
      {},
    )
    expect(res.ratesByVehicle.get('1109')!.yenPerLiter).toBe(120)
  })

  it('運行が 1 本も無ければ空を返す', () => {
    const res = buildOperationMargins([], [cost({ costKind: '04', amount: 1000 })], {})
    expect(res.operations).toEqual([])
    expect(res.unallocatedCostYen).toBe(1000)
  })
})

describe('marginRate', () => {
  it('粗利 ÷ 売上', () => {
    expect(marginRate({ salesYen: 50000, marginYen: 5000 })).toBe(0.1)
  })

  it('粗利が出せなければ null', () => {
    expect(marginRate({ salesYen: 50000, marginYen: null })).toBeNull()
  })

  it('売上 0 なら null', () => {
    expect(marginRate({ salesYen: 0, marginYen: 5000 })).toBeNull()
  })
})

describe('summarizeMargins', () => {
  const base: OperationMargin = {
    unkoNo: 'A',
    date: '2026-07-01',
    driverName: '佐竹 繁',
    vehicleCode: '1109',
    totalKm: 100,
    vehicleTotalKm: 500,
    salesYen: 50000,
    allowanceYen: 8000,
    fuelYen: 2400,
    directCostYen: 1000,
    allocatedCostYen: 600,
    marginYen: 38000,
    laborYen: 30000,
    fuelRate: { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 32.1 },
  }

  it('空なら 0 だけ', () => {
    expect(summarizeMargins([])).toEqual(emptyMarginTotals())
  })

  it('燃費が出せた運行だけ粗利に足す', () => {
    const totals = summarizeMargins([
      base,
      { ...base, unkoNo: 'B', fuelYen: null, marginYen: null, salesYen: 20000 },
    ])
    expect(totals.operations).toBe(2)
    expect(totals.salesYen).toBe(70000)
    expect(totals.allowanceYen).toBe(16000)
    expect(totals.totalKm).toBe(200)
    expect(totals.fuelYen).toBe(2400)
    expect(totals.directCostYen).toBe(2000)
    expect(totals.allocatedCostYen).toBe(1200)
    expect(totals.laborYen).toBe(60000)
    expect(totals.marginYen).toBe(50000 - 8000 - 2400 - 1000 - 600)
    expect(totals.unknownFuelOperations).toBe(1)
    expect(totals.unknownFuelSalesYen).toBe(20000)
  })
})

describe('groupMarginsByDriver', () => {
  const base: OperationMargin = {
    unkoNo: 'A',
    date: '2026-07-01',
    driverName: '安藤',
    vehicleCode: '1109',
    totalKm: 100,
    vehicleTotalKm: 100,
    salesYen: 10000,
    allowanceYen: 1000,
    fuelYen: 500,
    directCostYen: 0,
    allocatedCostYen: 0,
    marginYen: 8500,
    laborYen: 0,
    fuelRate: emptyFuelRate(),
  }

  it('乗務員ごとに畳んで名前順に並べる', () => {
    // **3 人以上を、既に逆順ではない並びで渡す。** 2 人だと比較が 1 回しか
    // 起きず、並べ替えの「入れ替える / 入れ替えない」の片側しか通らない。
    // 逆順で渡した場合も同じで、毎回入れ替わる側しか通らない。
    const groups = groupMarginsByDriver([
      base,
      { ...base, unkoNo: 'B', driverName: '西島' },
      { ...base, unkoNo: 'C', driverName: '柳井' },
      { ...base, unkoNo: 'D', driverName: '西島' },
    ])
    expect(groups.map(g => g.driverName)).toEqual(['安藤', '柳井', '西島'])
    expect(groups[2]!.operations).toHaveLength(2)
    expect(groups[2]!.totals.salesYen).toBe(20000)
  })
})

describe('marginCsvLines', () => {
  const base: OperationMargin = {
    unkoNo: 'A"1',
    date: '2026-07-01',
    driverName: '佐竹 繁',
    vehicleCode: '1109',
    totalKm: 100,
    vehicleTotalKm: 500,
    salesYen: 50000,
    allowanceYen: 8000,
    fuelYen: 2400.6,
    directCostYen: 1000,
    allocatedCostYen: 600,
    marginYen: 38000,
    laborYen: 30000,
    fuelRate: { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 32.1 },
  }

  it('ヘッダと 1 行を出し、引用符をエスケープする', () => {
    const lines = marginCsvLines([base])
    expect(lines[0]!.startsWith('"運行NO","日付"')).toBe(true)
    expect(lines[1]!.startsWith('"A""1","2026-07-01"')).toBe(true)
    expect(lines[1]).toContain('"2401"')
    expect(lines[1]).toContain('"76%"')
  })

  it('粗利が出せない運行は金額も率も空にする', () => {
    const lines = marginCsvLines([{ ...base, fuelYen: null, marginYen: null }])
    expect(lines[1]!.endsWith('"120","5"')).toBe(true)
    expect(lines[1]).toContain('"","1000"')
  })
})

describe('parseMarginCache', () => {
  const cache = {
    ym: '2026-07',
    savedAt: '2026-08-22T00:00:00.000Z',
    operations: [op()],
    costs: [cost()],
  }

  it('保存したものを読み戻せる', () => {
    expect(parseMarginCache(serializeMarginCache(cache))).toEqual(cache)
  })

  it('null / 空文字は null', () => {
    expect(parseMarginCache(null)).toBeNull()
    expect(parseMarginCache('')).toBeNull()
  })

  it('壊れた JSON は null (投げない)', () => {
    expect(parseMarginCache('{')).toBeNull()
  })

  it('オブジェクトでなければ null', () => {
    expect(parseMarginCache('42')).toBeNull()
  })

  it('null は null', () => {
    expect(parseMarginCache('null')).toBeNull()
  })

  it('月が無い / 配列でない形は null', () => {
    expect(parseMarginCache('{"operations":[],"costs":[]}')).toBeNull()
    expect(parseMarginCache('{"ym":"2026-07","operations":{},"costs":[]}')).toBeNull()
    expect(parseMarginCache('{"ym":"2026-07","operations":[],"costs":{}}')).toBeNull()
  })

  it('保存時刻が壊れていても空文字にして読む', () => {
    expect(parseMarginCache('{"ym":"2026-07","operations":[],"costs":[]}')!.savedAt).toBe('')
  })
})
