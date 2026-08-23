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
  kmMismatch,
  summarizeMargins,
  emptyMarginTotals,
  groupMarginsByDriver,
  marginCsvLines,
  marginLegCsvLines,
  splitFuelYen,
  noMarginReason,
  summarizeNoMarginReasons,
  buildUncoveredLegs,
  summarizeUncoveredLegs,
  parseMarginCache,
  serializeMarginCache,
  EXCLUDED_KINDS,
  LABOR_KINDS,
  FUEL_KIND,
  ADBLUE_KIND,
  FUEL_RATE_KEY,
  MARGIN_CACHE_KEY,
  operationDirectCostTitle,
  driverDirectCostTitle,
  NO_DIRECT_COST_TITLE,
  DIRECT_COST_TITLE_TOP,
  type CostRow,
  type CostsDailyApiRow,
  type MarginOperationInput,
  type MarginLegInput,
  type OperationMargin,
  type UncoveredDriverInput,
} from '~/utils/margin'
import {
  applyCarryOver,
  buildMonthlyAllowance,
  type AllowanceReportRow,
  type OperationAllowance,
} from '~/utils/allowance-report'
import { extractAllowanceLegs, extractCarryInUnloads, allowanceForLegs } from '~/utils/allowance-trips'
import { forcedLeg } from '~/utils/allowance-force-match'
import type { VehicleDailySlip } from '~/utils/ichiban'

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
    remarks: '',
    vendorName: '',
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
    // 運行一覧の 総走行距離。**`totalKm` と一致するのが正常**で、ずれたら画面が注意を出す。
    listedTotalKm: 100,
    // 走行km の内訳 (足すと totalKm)。**按分には効かない**が型で必須。
    kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 },
    salesYen: 50000,
    allowanceYen: 8000,
    legs: [],
    ...over,
  }
}

/** 便 1 本ぶんの入力 (Refs #760 の 13)。 */
function leg(over: Partial<MarginLegInput> = {}): MarginLegInput {
  return {
    seq: 1,
    date: '2026-07-01',
    originCity: '北海道釧路市',
    destCity: '浦幌町',
    salesYen: 20000,
    allowanceYen: 3000,
    haulKm: 40,
    deadheadKm: 15,
    ...over,
  }
}

/** デジタコ由来の便 1 本 (`buildMonthlyAllowance` が返す形)。 */
function reportRow(over: Partial<AllowanceReportRow> = {}): AllowanceReportRow {
  return {
    unkoNo: '2607011000000000001109',
    date: '2026-07-01',
    driverName: '佐竹 繁',
    vehicleName: '1109',
    seq: 1,
    fromTs: null,
    originCity: '北海道釧路市',
    destCity: '浦幌町',
    viaCities: '',
    masterDest: '浦幌',
    allowanceYen: 9000,
    status: 'ok',
    destSource: 'event',
    ...over,
  }
}

/** 一番星の運転日報明細 1 行 (2026-07 の車番 0040 の実データの形)。 */
function slip(over: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-07-18',
    vehicleNumber: '0040',
    customerCode: '015204',
    customerName: '大　石　畜　産',
    originAreaName: '北海道釧路市',
    destAreaName: '北海道浦幌町',
    origin: '釧路',
    dest: '浦幌',
    isSubcontracted: false,
    amount: 34403,
    itemCode: '1516',
    itemName: '大石後期',
    quantity: 12.51,
    unitPrice: 2750,
    unit: 'ｔ',
    rowId: '20260718-1',
    requestKind: '0',
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
      remarks: 'ﾀｲﾔ 4本',
      vendor_name: 'トーヨータイヤ',
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
      remarks: 'ﾀｲﾔ 4本',
      vendorName: 'トーヨータイヤ',
    })
  })

  it('remarks / vendor_name が無い行 (rust-ichibanboshi#306 より前の binary) は空文字にする', () => {
    const row: CostsDailyApiRow = {
      operation_date: '2026-07-05',
      vehicle_number: '1109',
      vehicle_branch: '01',
      driver_code: '0123',
      cost_code: '0621',
      cost_name: '軽油費',
      cost_kind: '01',
      cost_kind_name: '燃料ｵｲﾙ代',
      quantity: 1,
      unit_price: 1,
      amount: 1,
      diesel_tax: 0,
      km: 0,
      is_fixed: false,
      row_id: '20260705-1001',
    }
    const mapped = mapCostApiRow(row)
    expect(mapped.remarks).toBe('')
    expect(mapped.vendorName).toBe('')
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
    expect(res.operations[0]!.costsMissing).toBe(true)
    expect(res.ratesByVehicle.get('1109')).toEqual(emptyFuelRate())
  })

  it('**経費を 1 件も持っていない車輌は、燃費を上書きしても粗利を出さない**', () => {
    // 経費 0 円のまま粗利を出すと「売上そのまま」が粗利に見える = いちばん悪い壊れ方。
    const res = buildOperationMargins(
      [op({ totalKm: 100, salesYen: 50000 })],
      [],
      { 1109: { yenPerLiter: 130, kmPerLiter: 4 } },
    )
    const m = res.operations[0]!
    expect(m.fuelYen).toBe((100 / 4) * 130)   // 燃料代そのものは出る
    expect(m.costsMissing).toBe(true)
    expect(m.marginYen).toBeNull()            // **粗利は出さない**
    expect(noMarginReason(m)).toBe('この車輌・この月の経費を 1 件も引けていません')
  })

  it('燃料しか無い車輌は「経費は来ている」ので粗利を出す', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100, salesYen: 50000, allowanceYen: 8000 })],
      [cost({ costKind: '01', quantity: 20, amount: 2400 })],
      {},
    )
    const m = res.operations[0]!
    expect(m.costsMissing).toBe(false)
    // 単価 2400÷20 = 120 円/L、燃費 100÷20 = 5 km/L → 燃料 100÷5×120 = ¥2,400
    expect(m.marginYen).toBe(50000 - 8000 - 2400)
    expect(noMarginReason(m)).toBe('')
  })

  it('他の車輌の経費しか無ければ、その車輌は経費なし扱い', () => {
    const res = buildOperationMargins(
      [op({ vehicleCode: '1109', totalKm: 100 })],
      [cost({ costKind: '04', vehicleNumber: '9999', amount: 1000 })],
      { 1109: { yenPerLiter: 130, kmPerLiter: 4 } },
    )
    expect(res.operations[0]!.costsMissing).toBe(true)
    expect(res.operations[0]!.marginYen).toBeNull()
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
    listedTotalKm: 100,
    // 走行km の内訳 (足すと totalKm)。**按分には効かない**が型で必須。
    kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 },
    vehicleTotalKm: 500,
    salesYen: 50000,
    allowanceYen: 8000,
    fuelYen: 2400,
    // 燃料代の内訳 (売上走行 60km / 走行 100km → 1440 : 960)。**和は fuelYen。**
    fuelHaulYen: 1440,
    fuelDeadheadYen: 960,
    directCostYen: 1000,
    allocatedCostYen: 600,
    marginYen: 38000,
    laborYen: 30000,
    fuelRate: { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 32.1 },
    costsMissing: false,
    legs: [],
  }

  it('空なら 0 だけ', () => {
    expect(summarizeMargins([])).toEqual(emptyMarginTotals())
  })

  it('本数・走行・売上・手当・人件費はぜんぶ数え、粗利の内訳は出せた運行だけ', () => {
    const totals = summarizeMargins([
      base,
      { ...base, unkoNo: 'B', fuelYen: null, fuelHaulYen: null, fuelDeadheadYen: null, marginYen: null, salesYen: 20000 },
    ])
    // --- ぜんぶ ---
    expect(totals.operations).toBe(2)
    expect(totals.totalKm).toBe(200)
    expect(totals.salesYen).toBe(70000)
    expect(totals.allowanceYen).toBe(16000)
    expect(totals.laborYen).toBe(60000)
    // --- 粗利を出せた運行ぶんだけ ---
    expect(totals.marginOperations).toBe(1)
    expect(totals.marginSalesYen).toBe(50000)
    expect(totals.marginAllowanceYen).toBe(8000)
    expect(totals.fuelYen).toBe(2400)
    expect(totals.directCostYen).toBe(1000)
    expect(totals.allocatedCostYen).toBe(600)
    expect(totals.marginYen).toBe(38000)
    // --- 出せなかったぶん ---
    expect(totals.noMarginOperations).toBe(1)
    expect(totals.noMarginSalesYen).toBe(20000)
  })

  it('**粗利の内訳は引き算がぴったり合う** (人が検算できないと信用されない)', () => {
    const totals = summarizeMargins([
      base,
      { ...base, unkoNo: 'B', salesYen: 30000, allowanceYen: 5000, fuelYen: 1200, fuelHaulYen: 720, fuelDeadheadYen: 480, directCostYen: 400, allocatedCostYen: 300, marginYen: 23100 },
      { ...base, unkoNo: 'C', fuelYen: null, fuelHaulYen: null, fuelDeadheadYen: null, marginYen: null, salesYen: 20000 },
    ])
    expect(
      totals.marginSalesYen - totals.marginAllowanceYen - totals.fuelYen
      - totals.directCostYen - totals.allocatedCostYen,
    ).toBe(totals.marginYen)
  })
})

describe('groupMarginsByDriver', () => {
  const base: OperationMargin = {
    unkoNo: 'A',
    date: '2026-07-01',
    driverName: '安藤',
    vehicleCode: '1109',
    totalKm: 100,
    listedTotalKm: 100,
    // 走行km の内訳 (足すと totalKm)。**按分には効かない**が型で必須。
    kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 },
    vehicleTotalKm: 100,
    salesYen: 10000,
    allowanceYen: 1000,
    fuelYen: 500,
    fuelHaulYen: 300,
    fuelDeadheadYen: 200,
    directCostYen: 0,
    allocatedCostYen: 0,
    marginYen: 8500,
    laborYen: 0,
    fuelRate: emptyFuelRate(),
    costsMissing: false,
    legs: [],
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
    listedTotalKm: 100,
    // 走行km の内訳 (足すと totalKm)。**按分には効かない**が型で必須。
    kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 },
    vehicleTotalKm: 500,
    salesYen: 50000,
    allowanceYen: 8000,
    fuelYen: 2400.6,
    fuelHaulYen: 1440.36,
    fuelDeadheadYen: 960.24,
    directCostYen: 1000,
    allocatedCostYen: 600,
    marginYen: 38000,
    laborYen: 30000,
    fuelRate: { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 32.1 },
    costsMissing: false,
    legs: [],
  }

  it('ヘッダと 1 行を出し、引用符をエスケープする', () => {
    const lines = marginCsvLines([base])
    expect(lines[0]!.startsWith('"運行NO","日付"')).toBe(true)
    expect(lines[1]!.startsWith('"A""1","2026-07-01"')).toBe(true)
    expect(lines[1]).toContain('"2401"')
    expect(lines[1]).toContain('"76%"')
  })

  it('粗利が出せない運行は金額も率も空にする', () => {
    const lines = marginCsvLines([{ ...base, fuelYen: null, fuelHaulYen: null, fuelDeadheadYen: null, marginYen: null }])
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
    uncovered: null,
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

  it('粗利の対象外の便の合計も読み戻せる', () => {
    const withUncovered = { ...cache, uncovered: { trips: 36, salesYen: 1649681, allowanceYen: 413000 } }
    expect(parseMarginCache(serializeMarginCache(withUncovered))!.uncovered)
      .toEqual({ trips: 36, salesYen: 1649681, allowanceYen: 413000 })
  })

  it('対象外の欄が無い / null なら null (欄の欠けを 0 便と読ませない)', () => {
    expect(parseMarginCache('{"ym":"2026-07","operations":[],"costs":[]}')!.uncovered).toBeNull()
    expect(parseMarginCache('{"ym":"2026-07","operations":[],"costs":[],"uncovered":null}')!.uncovered).toBeNull()
  })
})


describe('noMarginReason', () => {
  const base = {
    marginYen: null as number | null,
    costsMissing: false,
    fuelRate: { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 0 },
  }

  it('粗利が出ていれば空文字', () => {
    expect(noMarginReason({ ...base, marginYen: 1000 })).toBe('')
  })

  it('経費が 1 件も無いのが最優先の理由', () => {
    expect(noMarginReason({ ...base, costsMissing: true }))
      .toBe('この車輌・この月の経費を 1 件も引けていません')
  })

  it('給油実績が無ければそう言う', () => {
    expect(noMarginReason({ ...base, fuelRate: emptyFuelRate() }))
      .toBe('この月・この車輌に燃料 (01) の給油実績がありません')
  })

  it('給油はあるが走行距離が 0 のときは別の理由', () => {
    expect(noMarginReason({ ...base, fuelRate: { yenPerLiter: 120, kmPerLiter: null, dieselTaxPerLiter: 0 } }))
      .toBe('走行距離が 0 で燃費が出せません')
  })
})

// --- 実データ回帰 (2026-07 の一番星、親が実測した値) ---
// **行ごとの単価は月平均と一致しない** (給油日で単価が動く) ので、
// `Σ金額 ÷ Σ数量` でしか出せない。ここが回帰したら気づけるように実数を置く。

describe('deriveFuelRate — 2026-07 の実データ', () => {
  it('車0016: 4395.0L / ¥540,343 → 122.94 円/L (行単価 133.74 とは一致しない)', () => {
    // 実データは 23 件だが、単価は Σ で決まるので 2 行に畳んで同じ Σ を作る。
    const rate = deriveFuelRate([
      cost({ costKind: '01', vehicleNumber: '0016', quantity: 4000, unitPrice: 133.74, amount: 491840, dieselTax: 0 }),
      cost({ costKind: '01', vehicleNumber: '0016', quantity: 395, unitPrice: 130.44, amount: 48503, dieselTax: 0 }),
      // **アドブルー (15) は 220.0 L あるが分母に入れない** (軽油ではない)。
      cost({ costKind: '15', vehicleNumber: '0016', quantity: 220, amount: 19360, dieselTax: 0 }),
      // 給与・修繕・保険は数量を持たないが、混ざらないことを確かめる。
      cost({ costKind: '08', vehicleNumber: '0016', amount: 572000, isFixed: true }),
      cost({ costKind: '03', vehicleNumber: '0016', amount: 41900 }),
      cost({ costKind: '14', vehicleNumber: '0016', amount: 7090, isFixed: true }),
    ], 4500)
    expect(rate.yenPerLiter).toBeCloseTo(122.94, 2)
    // **行単価のどちらとも一致しない** — これが Σ で出す理由。
    expect(rate.yenPerLiter).not.toBe(133.74)
    expect(rate.yenPerLiter).not.toBe(130.44)
    // 分母がアドブルーを含んでいたら 4615L になり 0.97 km/L になる。
    expect(rate.kmPerLiter).toBeCloseTo(4500 / 4395, 5)
    // **軽油引取税は 1 件も入っていない** (この帳簿では別立て計上なし)。
    expect(rate.dieselTaxPerLiter).toBe(0)
  })

  it('燃費は 1〜5 km/L に収まる (帯広5台の当たり)', () => {
    // 車0016 は 4395.0L。月 15,000km 走れば 3.4 km/L。
    const rate = deriveFuelRate([
      cost({ costKind: '01', vehicleNumber: '0016', quantity: 4395, amount: 540343 }),
    ], 15000)
    expect(rate.kmPerLiter!).toBeGreaterThan(1)
    expect(rate.kmPerLiter!).toBeLessThan(5)
    expect(rate.yenPerLiter!).toBeGreaterThan(100)
    expect(rate.yenPerLiter!).toBeLessThan(150)
  })
})


describe('summarizeNoMarginReasons', () => {
  const base: OperationMargin = {
    unkoNo: 'A',
    date: '2026-07-01',
    driverName: '佐竹 繁',
    vehicleCode: '1109',
    totalKm: 100,
    listedTotalKm: 100,
    // 走行km の内訳 (足すと totalKm)。**按分には効かない**が型で必須。
    kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 },
    vehicleTotalKm: 100,
    salesYen: 10000,
    allowanceYen: 0,
    fuelYen: 500,
    fuelHaulYen: 300,
    fuelDeadheadYen: 200,
    directCostYen: 0,
    allocatedCostYen: 0,
    marginYen: 9500,
    laborYen: 0,
    fuelRate: { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 0 },
    costsMissing: false,
    legs: [],
  }

  it('粗利が出ている運行しか無ければ空', () => {
    expect(summarizeNoMarginReasons([base])).toEqual([])
  })

  it('理由ごとに件数と売上をまとめる (初出順)', () => {
    const groups = summarizeNoMarginReasons([
      base,
      { ...base, unkoNo: 'B', marginYen: null, costsMissing: true, salesYen: 20000 },
      { ...base, unkoNo: 'C', marginYen: null, fuelRate: emptyFuelRate(), salesYen: 5000 },
      { ...base, unkoNo: 'D', marginYen: null, costsMissing: true, salesYen: 1000 },
    ])
    expect(groups).toEqual([
      { reason: 'この車輌・この月の経費を 1 件も引けていません', operations: 2, salesYen: 21000 },
      { reason: 'この月・この車輌に燃料 (01) の給油実績がありません', operations: 1, salesYen: 5000 },
    ])
  })
})

describe('buildUncoveredLegs / summarizeUncoveredLegs', () => {
  /** 乗務員 1 人ぶんの材料 (`reconcileVehicles` に渡したものと同じ形)。 */
  function driver(over: Partial<UncoveredDriverInput> = {}): UncoveredDriverInput {
    return { driverName: '柳井 亮祐', rows: [], slips: [], ...over }
  }

  it('デジタコ便に当たらなかった明細から便を起こし、件数・売上・手当を数える', () => {
    const legs = buildUncoveredLegs(
      [driver({ slips: [slip(), slip({ rowId: '20260718-2', amount: 10000 })] })],
      [],
      '2026-07',
      {},
    )
    // 同じ日・同じ積地なので 1 便に畳まれる (12.51t + 12.51t は 15t 超なので 2 便)
    expect(legs).toHaveLength(2)
    expect(summarizeUncoveredLegs(legs)).toEqual({ trips: 2, salesYen: 44403, allowanceYen: 18000 })
  })

  it('デジタコ便に当たった明細は数えない (粗利に載っているぶん)', () => {
    const legs = buildUncoveredLegs(
      [driver({ slips: [slip()] })],
      [{ slips: [slip()] }],
      '2026-07',
      {},
    )
    expect(legs).toEqual([])
    expect(summarizeUncoveredLegs(legs)).toBeNull()
  })

  it('デジタコ便がある 日付|積地 の明細は起こさない (複数卸しの片割れ)', () => {
    const legs = buildUncoveredLegs(
      [driver({
        // 便の積地 (`北海道釧路市`) は明細の積地 `釧路` と同じ日・同じ場所
        rows: [reportRow({ date: '2026-07-18', originCity: '北海道釧路市' })],
        slips: [slip()],
      })],
      [],
      '2026-07',
      {},
    )
    expect(legs).toEqual([])
  })

  it('請求のみ (請求K=1) からは便を起こさない (走っていない請求行)', () => {
    const legs = buildUncoveredLegs(
      [driver({ slips: [slip({ requestKind: '1' })] })],
      [],
      '2026-07',
      {},
    )
    expect(legs).toEqual([])
    expect(summarizeUncoveredLegs(legs)).toBeNull()
  })

  it('1 便も無ければ null (0 件の枠を常に出さないため)', () => {
    expect(summarizeUncoveredLegs([])).toBeNull()
    expect(summarizeUncoveredLegs(buildUncoveredLegs([], [], '2026-07', {}))).toBeNull()
  })

  it('乗務員が複数でもまとめて数える', () => {
    const legs = buildUncoveredLegs([
      driver({ slips: [slip()] }),
      driver({ driverName: '中村 秀一', slips: [slip({ rowId: '20260719-1', saleDate: '2026-07-19' })] }),
    ], [], '2026-07', {})
    expect(legs.map(l => l.driverName)).toEqual(['柳井 亮祐', '中村 秀一'])
    expect(summarizeUncoveredLegs(legs)).toEqual({ trips: 2, salesYen: 68806, allowanceYen: 18000 })
  })

  it('金額が決まらない便は手当に足さない (推測で額を作らない)', () => {
    const legs = buildUncoveredLegs(
      [driver({ slips: [slip({ dest: '無い地名', destAreaName: '北海道' })] })],
      [],
      '2026-07',
      {},
    )
    expect(legs[0]!.allowanceYen).toBeNull()
    expect(summarizeUncoveredLegs(legs)).toEqual({ trips: 1, salesYen: 34403, allowanceYen: 0 })
  })

  it('対象外の便があってもなくても、粗利の計算は 1 円も変わらない', () => {
    const operations = [op()]
    const costs = [cost({ costKind: '04', amount: 1000 }), cost({ costKind: FUEL_KIND, quantity: 100, amount: 12000, rowId: 'fuel' })]
    const before = summarizeMargins(buildOperationMargins(operations, costs, {}).operations)

    const legs = buildUncoveredLegs([driver({ slips: [slip()] })], [], '2026-07', {})
    const uncovered = summarizeUncoveredLegs(legs)
    // 対象外の便には売上も手当もある — **それでも粗利の合計は動かない**
    expect(uncovered!.salesYen).toBe(34403)
    expect(uncovered!.allowanceYen).toBe(9000)

    const after = summarizeMargins(buildOperationMargins(operations, costs, {}).operations)
    expect(after).toEqual(before)
    expect(after.salesYen).toBe(50000)
    expect(after.allowanceYen).toBe(8000)
    expect(after.marginYen).toBe(50000 - 8000 - 1000 - 100 * (12000 / 100) / (100 / 100))
  })
})

/**
 * 走行km の内訳 (Refs #760 の 5)。
 *
 * **按分の式は 1 ミリも変えない** — 分子は今までどおり `totalKm`。内訳は
 * 「その分子の中身」を画面と CSV に出すためだけに運ぶ。
 */
describe('走行km の内訳 (kmBreakdown)', () => {
  const base: OperationMargin = {
    unkoNo: 'A',
    date: '2026-07-01',
    driverName: '佐竹 繁',
    vehicleCode: '1109',
    totalKm: 100,
    listedTotalKm: 100,
    kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 },
    vehicleTotalKm: 500,
    salesYen: 50000,
    allowanceYen: 8000,
    fuelYen: 2400,
    // 燃料代の内訳 (売上走行 60km / 走行 100km → 1440 : 960)。**和は fuelYen。**
    fuelHaulYen: 1440,
    fuelDeadheadYen: 960,
    directCostYen: 1000,
    allocatedCostYen: 600,
    marginYen: 38000,
    laborYen: 30000,
    fuelRate: { yenPerLiter: 120, kmPerLiter: 5, dieselTaxPerLiter: 32.1 },
    costsMissing: false,
    legs: [],
  }

  it('入力の内訳をそのまま運行の粗利に運ぶ (按分の分子は totalKm のまま)', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100, kmBreakdown: { preLoadKm: 3, haulKm: 60, betweenKm: 30, postUnloadKm: 5, otherKm: 2 } })],
      [cost({ amount: 1000 })],
      {},
    )
    expect(res.operations[0]!.kmBreakdown).toEqual({ preLoadKm: 3, haulKm: 60, betweenKm: 30, postUnloadKm: 5, otherKm: 2 })
    // 分子・分母は内訳を足したものではなく `totalKm` のまま
    expect(res.operations[0]!.totalKm).toBe(100)
    expect(res.operations[0]!.vehicleTotalKm).toBe(100)
  })

  it('合計は **ぜんぶ** 側 — 粗利を出せなかった運行の内訳も足す', () => {
    const totals = summarizeMargins([
      base,
      // 粗利を出せない運行 (燃費が出せない)。走行と内訳は数えるが経費は数えない
      {
        ...base,
        unkoNo: 'B',
        fuelYen: null,
        fuelHaulYen: null,
        fuelDeadheadYen: null,
        marginYen: null,
        kmBreakdown: { preLoadKm: 1, haulKm: 2, betweenKm: 3, postUnloadKm: 4, otherKm: 5 },
        totalKm: 15,
      },
    ])
    expect(totals.totalKm).toBe(115)
    expect(totals.preLoadKm).toBe(11)
    expect(totals.haulKm).toBe(62)
    expect(totals.betweenKm).toBe(28)
    expect(totals.postUnloadKm).toBe(9)
    expect(totals.otherKm).toBe(5)
    // 粗利の内訳は今までどおり「出せた運行ぶんだけ」
    expect(totals.marginOperations).toBe(1)
  })

  it('emptyMarginTotals は内訳も 0 で始まる', () => {
    const empty = emptyMarginTotals()
    expect(empty.preLoadKm).toBe(0)
    expect(empty.haulKm).toBe(0)
    expect(empty.betweenKm).toBe(0)
    expect(empty.postUnloadKm).toBe(0)
    expect(empty.otherKm).toBe(0)
  })

  it('CSV は 走行km の直後に内訳 5 列を整数で出す', () => {
    const lines = marginCsvLines([{ ...base, kmBreakdown: { preLoadKm: 10.4, haulKm: 60.5, betweenKm: 25, postUnloadKm: 4.1, otherKm: 0 } }])
    const header = lines[0]!.split(',').map(v => v.replace(/"/g, ''))
    const row = lines[1]!.split(',').map(v => v.replace(/"/g, ''))
    const at = header.indexOf('走行km')
    expect(header.slice(at, at + 7)).toEqual([
      '走行km', '始業→積みkm', '売上走行km', '便間km', '降し→終業km', '分類不能km', '月・車輌の走行km',
    ])
    // 小数は整数に丸める (画面と同じ粒度)。0.5 は JS の丸めで 1 に上がる
    expect(row.slice(at, at + 7)).toEqual(['100', '10', '61', '25', '4', '0', '500'])
  })

  it('キャッシュのキーは v6 — 備考・支払先の無い旧キャッシュ (v5) を読ませない', () => {
    // 形を変えたら番号を上げる規約。**上げ忘れると `kmBreakdown`/`legs`/`remarks` が
    // 無い行を画面が読む** (#760 の 4 が v2、7 が v4、13 が v5。経費の行に
    // `remarks`/`vendorName` を足した版は v6、#760 の 14)。
    expect(MARGIN_CACHE_KEY).toBe('dtako:margin:cache:v6')
  })
})

describe('推定卸地の引き継ぎ (carryIn) — 粗利タブが運行手当タブと同じ手当を出す', () => {
  // **粗利タブは `carryIn` をイベントCSV から取っていなかった** (Refs #760 の 6)。
  // `resolveOperation` が `{ cities: [], toTs: null }` を入れたままだったので、
  // 後段の `applyCarryOver` が常に空を見て 1 便も引き継げず、2026-07 / 帯広5台で
  // 10 運行・手当 ¥89,000・売上 ¥268,484 が運行手当タブとの差になっていた。
  // ここは**両タブが通る pure な経路そのもの**を、CSV から便を起こすところから
  // 固定する (画面側は `carryIn:` の 1 行を足すだけになる)。
  const HEADERS = ['イベント名', '開始日時', '終了日時', '開始市町村名', '終了市町村名']

  /** イベントCSV の 1 行。列は HEADERS の順。 */
  function ev(name: string, startCity = '', endCity = '', start = '2026/7/6 4:20:0', end = '2026/7/6 6:0:0') {
    return [name, start, end, startCity, endCity]
  }

  // 実データ (2026-07 / 帯広800か1109) の形。運行 A の最終便は 07-07 に積んで
  // **降しが 1 つも無いまま帰庫**しており、その卸地は次の運行 B の先頭の降し
  // (07-08 4:40 士幌町) にある。
  const csvA = {
    headers: HEADERS,
    rows: [
      ev('運行開始', '音更町', '', '2026/7/6 4:18:0', '2026/7/6 4:18:0'),
      ev('積み', '釧路市', '', '2026/7/6 9:31:0', '2026/7/6 10:17:0'),
      ev('降し', '', '浦幌町', '2026/7/6 13:0:0', '2026/7/6 14:0:0'),
      ev('積み', '釧路市', '', '2026/7/7 15:21:0', '2026/7/7 16:0:0'),
      ev('運行終了', '音更町', '', '2026/7/7 20:0:0', '2026/7/7 20:0:0'),
    ],
  }
  const csvB = {
    headers: HEADERS,
    rows: [
      ev('運行開始', '音更町', '', '2026/7/8 4:19:0', '2026/7/8 4:19:0'),
      ev('降し', '', '士幌町', '2026/7/8 4:40:0', '2026/7/8 5:20:0'),
      ev('積み', '釧路市', '', '2026/7/8 9:0:0', '2026/7/8 9:40:0'),
      ev('降し', '', '浦幌町', '2026/7/8 13:0:0', '2026/7/8 14:0:0'),
    ],
  }

  /**
   * 運行 1 本。**`withCarryIn: false` が #760 の 6 以前の粗利タブ** —
   * `carryIn` を CSV から取らず空のまま渡していた。`true` が運行手当タブと同じ。
   */
  function operation(
    unkoNo: string,
    readingDate: string,
    csv: { headers: string[], rows: string[][] },
    withCarryIn: boolean,
  ): OperationAllowance {
    return {
      unkoNo,
      readingDate,
      operationDate: null,
      driverName: '中村 秀一',
      vehicleName: '帯広800か1109',
      legs: allowanceForLegs(extractAllowanceLegs(csv.headers, csv.rows)),
      carryIn: withCarryIn ? extractCarryInUnloads(csv.headers, csv.rows) : { cities: [], toTs: null },
      error: null,
    }
  }

  function monthlyOf(withCarryIn: boolean) {
    return buildMonthlyAllowance(applyCarryOver([
      operation('26070604185900000011091', '2026-07-07', csvA, withCarryIn),
      operation('26070804190900000011091', '2026-07-08', csvB, withCarryIn),
    ]), '2026-07')
  }

  it('carryIn を CSV から取れば、積み残しの便に卸地と手当が付く', () => {
    const m = monthlyOf(true)
    const carriedRow = m.drivers[0]!.operations[0]!.rows[1]!
    expect(carriedRow).toMatchObject({
      date: '2026-07-07', originCity: '釧路市', destCity: '士幌町',
      masterDest: '溝口', allowanceYen: 9000, destSource: 'carried',
    })
    expect(m).toMatchObject({ trips: 3, totalYen: 27000, irregularTrips: 0, carriedTrips: 1 })
  })

  it('carryIn が空のままだと 1 便丸ごと落ちる (#760 の 6 以前の粗利タブ)', () => {
    const m = monthlyOf(false)
    expect(m.drivers[0]!.operations[0]!.rows[1]).toMatchObject({
      destCity: '', masterDest: '', allowanceYen: null, destSource: 'event',
    })
    // 便は残るが手当が付かない = 運行手当タブとの差になる ¥9,000
    expect(m).toMatchObject({ trips: 2, totalYen: 18000, irregularTrips: 1, carriedTrips: 0 })
  })

  it('粗利タブが運行 1 本ぶんに畳む手当も、引き継ぎのぶんだけ増える', () => {
    // `margin.vue` が `MarginOperationInput.allowanceYen` に入れるのと同じ畳み方。
    const fold = (withCarryIn: boolean) => monthlyOf(withCarryIn).drivers
      .flatMap(d => d.operations.map(o => [
        o.unkoNo,
        o.rows.reduce((sum, r) => sum + (r.allowanceYen ?? 0), 0),
      ]))
    expect(fold(true)).toEqual([['26070604185900000011091', 18000], ['26070804190900000011091', 9000]])
    expect(fold(false)).toEqual([['26070604185900000011091', 9000], ['26070804190900000011091', 9000]])
  })
})

describe('強制突合を重ねた便は粗利の対象外から外れる', () => {
  // **粗利タブは `forcedLegs` を読んでいなかった** (Refs #760 の 6)。人が一番星の明細を
  // 結んだ便は売上も手当も付かず、その明細は「デジタコ便に当たっていない」ままなので、
  // **粗利にも載らないのに対象外にも数えられていた**。粗利タブは `applyForcedSales` で
  // その明細を `matched` にしてから `buildUncoveredLegs` に渡す。
  function driver(over: Partial<UncoveredDriverInput> = {}): UncoveredDriverInput {
    return { driverName: '柳井 亮祐', rows: [], slips: [], ...over }
  }

  /** 人が便に結んだ明細 (2026-07-15 の柳井の 1 件と同じ ¥21,750)。 */
  const bound = slip({ rowId: '20260718-9', amount: 21750, quantity: 7.5 })
  /** どこにも結ばれていない明細。**こちらは対象外のまま残らないといけない。** */
  const loose = slip({ rowId: '20260718-8' })

  it('forced の slips が matched に入ると、その便だけ対象外から減る', () => {
    const forced = forcedLeg({ originCity: '北海道釧路市' }, [bound], {})
    expect(forced.slips.map(s => s.rowId)).toEqual(['20260718-9'])

    const before = buildUncoveredLegs([driver({ slips: [bound, loose] })], [], '2026-07', {})
    expect(summarizeUncoveredLegs(before)).toEqual({ trips: 2, salesYen: 56153, allowanceYen: 18000 })

    // `applyForcedSales` が `byLeg` に入れる形 (`status: 'matched'`, `slips: forced.slips`)
    const after = buildUncoveredLegs([driver({ slips: [bound, loose] })], [{ slips: forced.slips }], '2026-07', {})
    expect(after).toHaveLength(1)
    // 結んだ明細だけが消え、結んでいない明細は対象外に残る
    expect(summarizeUncoveredLegs(after)).toEqual({ trips: 1, salesYen: 34403, allowanceYen: 9000 })
  })

  it('結んだ明細を matched に入れ忘れると、同じ売上が粗利と対象外の両方に出る', () => {
    const forced = forcedLeg({ originCity: '北海道釧路市' }, [bound], {})
    // 粗利側には `forced.salesYen` が乗る
    expect(forced.salesYen).toBe(21750)
    // 上書きを渡さないと、その ¥21,750 が対象外にも数えられたまま
    const legs = buildUncoveredLegs([driver({ slips: [bound] })], [], '2026-07', {})
    expect(summarizeUncoveredLegs(legs)!.salesYen).toBe(21750)
  })
})

/**
 * **走行km と 運行一覧の 総走行距離 のずれ検出** (Refs #760 の 7)。
 *
 * `extractOperationIdle` の `totalKm` (タイムライン行だけの Σ区間距離) は KUDGURI の
 * `総走行距離` = 運行一覧 API の `total_distance` と一致するのが正常 (2026-07 帯広5台
 * 90 運行で全件一致)。ずれるのは**イベント名の仕分けが実データに追いついていない**とき
 * なので、按分の値は変えずに画面へ注意だけ出す。
 */
describe('kmMismatch — CSV の走行km と 運行一覧の 総走行距離 の突き合わせ', () => {
  it('一致していればずれ無し', () => {
    expect(kmMismatch({ totalKm: 12442, listedTotalKm: 12442 })).toBe(false)
  })

  it('0.1km 以上ずれたら検出する (未知のイベント名で数え落とした疑い)', () => {
    // 重ね掛け行を足していた頃の値 (23,014 vs 12,442) はもちろん検出される
    expect(kmMismatch({ totalKm: 23014, listedTotalKm: 12442 })).toBe(true)
    // **境目ちょうど (0.1) は書かない** — `100.1 - 100` は浮動小数で
    // 0.09999999999999432 になり、閾値の意図ではなく丸めを試すテストになる
    expect(kmMismatch({ totalKm: 100, listedTotalKm: 100.5 })).toBe(true)
    // 向きは問わない (数え過ぎも数え落としも同じ注意)
    expect(kmMismatch({ totalKm: 100.5, listedTotalKm: 100 })).toBe(true)
  })

  it('0.1km 未満の丸め差は注意にしない (KUDGURI との実測差は 0.05km 以内)', () => {
    expect(kmMismatch({ totalKm: 100.05, listedTotalKm: 100 })).toBe(false)
    expect(kmMismatch({ totalKm: 100, listedTotalKm: 100.05 })).toBe(false)
  })

  it('運行一覧に 総走行距離 が無ければ比べない (ずれではなく比較相手が無い)', () => {
    expect(kmMismatch({ totalKm: 12442, listedTotalKm: null })).toBe(false)
    expect(kmMismatch({ totalKm: 0, listedTotalKm: null })).toBe(false)
  })

  it('buildOperationMargins は listedTotalKm をそのまま運ぶ (按分には効かない)', () => {
    const res = buildOperationMargins(
      [
        op({ unkoNo: 'A', totalKm: 100, listedTotalKm: 100 }),
        op({ unkoNo: 'B', date: '2026-07-02', totalKm: 200, listedTotalKm: null }),
      ],
      [],
      {},
    )
    expect(res.operations[0]!.listedTotalKm).toBe(100)
    expect(res.operations[1]!.listedTotalKm).toBeNull()
    // 按分の分母は `totalKm` の和のまま (`listedTotalKm` は 1 ミリも効かない)
    expect(res.operations[0]!.vehicleTotalKm).toBe(300)
    expect(kmMismatch(res.operations[0]!)).toBe(false)
    expect(kmMismatch(res.operations[1]!)).toBe(false)
  })
})

/**
 * 燃料代を **売上走行**と**回送**に分ける (Refs #760 の 8)。
 *
 * オーナー指示: 「リース・保険・通信・車輌修繕は固定費だから総走行距離で割りたい。
 * 按分経費は主に燃費のはずで、売上前後の移動にかかる経費を載せたい」。
 *
 * **粗利は 1 円も動かさない。** 引くのは分ける前の `fuelYen` のままで、
 * 分けた 2 つは見せるためだけ。だから**このブロックのテストが全部通っても、
 * 既存の粗利のテストの期待値は 1 つも動かない**ことが不変の証拠になる。
 */
describe('燃料代の分割 (売上走行 / 回送)', () => {
  it('売上走行km の比で割り、和は必ず元の燃料代に戻る', () => {
    const km = { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 }
    const split = splitFuelYen(2400, km)
    expect(split.haul).toBe(1440)
    expect(split.deadhead).toBe(960)
    expect(split.haul! + split.deadhead!).toBe(2400)
  })

  it('回送は 引き算で出す — 割り切れなくても和が 1 円もずれない', () => {
    // 3 で割り切れない比 (haul 1 / 和 3)。比から 2 つとも計算すると和がずれる。
    const km = { preLoadKm: 1, haulKm: 1, betweenKm: 1, postUnloadKm: 0, otherKm: 0 }
    const split = splitFuelYen(1000, km)
    expect(split.haul! + split.deadhead!).toBe(1000)
  })

  it('燃料代が null なら 2 つとも null', () => {
    const km = { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 }
    expect(splitFuelYen(null, km)).toEqual({ haul: null, deadhead: null })
  })

  it('内訳の和が 0 なら 2 つとも null (黙って全部を売上走行に倒さない)', () => {
    // `区間距離` の列が無い CSV。呼び出し側が totalKm に 運行一覧の総走行距離を入れる
    // ので、**走っているのに内訳だけ 0** という運行が実在する。
    const zero = { preLoadKm: 0, haulKm: 0, betweenKm: 0, postUnloadKm: 0, otherKm: 0 }
    expect(splitFuelYen(2400, zero)).toEqual({ haul: null, deadhead: null })
  })

  it('分類不能 (otherKm) は回送に入る — 売上が立っていないので', () => {
    const km = { preLoadKm: 0, haulKm: 50, betweenKm: 0, postUnloadKm: 0, otherKm: 50 }
    const split = splitFuelYen(1000, km)
    expect(split.haul).toBe(500)
    expect(split.deadhead).toBe(500)
  })

  it('buildOperationMargins は運行ごとに分け、粗利は分ける前の燃料代で出す', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100, kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 } })],
      [cost({ costKind: '01', quantity: 20, amount: 2400 })],
      {},
    )
    const m = res.operations[0]!
    // 単価 120 円/L・燃費 5 km/L → 100km で 2400 円
    expect(m.fuelYen).toBe(2400)
    expect(m.fuelHaulYen).toBe(1440)
    expect(m.fuelDeadheadYen).toBe(960)
    // **不変条件**: 分けた 2 つの和は元の燃料代
    expect(m.fuelHaulYen! + m.fuelDeadheadYen!).toBe(m.fuelYen)
    // **粗利は分ける前の燃料代で出す** (回送ぶんを二重に引かない)
    expect(m.marginYen).toBe(50000 - 8000 - 2400 - 0 - 0)
  })

  it('内訳の和が 0 で走行距離がある運行は分けられない (null) が、燃料代と粗利は出る', () => {
    const zero = { preLoadKm: 0, haulKm: 0, betweenKm: 0, postUnloadKm: 0, otherKm: 0 }
    const res = buildOperationMargins(
      [op({ totalKm: 100, kmBreakdown: zero })],
      [cost({ costKind: '01', quantity: 20, amount: 2400 })],
      {},
    )
    const m = res.operations[0]!
    expect(m.fuelYen).toBe(2400)
    expect(m.fuelHaulYen).toBeNull()
    expect(m.fuelDeadheadYen).toBeNull()
    expect(m.marginYen).toBe(50000 - 8000 - 2400)
  })

  it('燃料代が出せない運行は 2 つとも null', () => {
    // 給油実績が無い → 単価が出せない
    const res = buildOperationMargins([op({ totalKm: 100 })], [cost({ costKind: '04', amount: 1000 })], {})
    const m = res.operations[0]!
    expect(m.fuelYen).toBeNull()
    expect(m.fuelHaulYen).toBeNull()
    expect(m.fuelDeadheadYen).toBeNull()
  })

  it('合計は 売上走行 + 回送 + 未分割 === 燃料代 (不変条件)', () => {
    const zero = { preLoadKm: 0, haulKm: 0, betweenKm: 0, postUnloadKm: 0, otherKm: 0 }
    const res = buildOperationMargins(
      [
        // 分けられる運行
        op({ unkoNo: 'A', totalKm: 100, kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 } }),
        // 内訳が無い運行 (`total_distance` の受け皿で来たもの)
        op({ unkoNo: 'B', date: '2026-07-02', totalKm: 100, kmBreakdown: zero }),
      ],
      [cost({ costKind: '01', quantity: 40, amount: 4800 })],
      {},
    )
    const totals = summarizeMargins(res.operations)
    expect(totals.fuelYen).toBe(4800)
    expect(totals.fuelHaulYen).toBe(1440)
    expect(totals.fuelDeadheadYen).toBe(960)
    // **未分割を 0 に倒さない。** 倒すと 2 列の和が燃料代に足りない理由が消える
    expect(totals.fuelUnsplitYen).toBe(2400)
    expect(totals.fuelHaulYen + totals.fuelDeadheadYen + totals.fuelUnsplitYen).toBe(totals.fuelYen)
  })

  it('emptyMarginTotals は分割の 3 つも 0 で始まる', () => {
    const empty = emptyMarginTotals()
    expect(empty.fuelHaulYen).toBe(0)
    expect(empty.fuelDeadheadYen).toBe(0)
    expect(empty.fuelUnsplitYen).toBe(0)
  })

  it('CSV は 燃料代 の直後に 売上走行 / 回送 の 2 列を出し、按分経費 は 固定費按分 に改名', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100, kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 } })],
      [cost({ costKind: '01', quantity: 20, amount: 2400 }), cost({ costKind: '13', amount: 1000, isFixed: true })],
      {},
    )
    const lines = marginCsvLines(res.operations)
    const header = lines[0]!.split(',').map(v => v.replace(/"/g, ''))
    const row = lines[1]!.split(',').map(v => v.replace(/"/g, ''))
    const at = header.indexOf('燃料代')
    expect(header.slice(at, at + 5)).toEqual([
      '燃料代', '燃料代(売上走行)', '燃料代(回送=按分)', '直課経費', '固定費按分',
    ])
    expect(row.slice(at, at + 5)).toEqual(['2400', '1440', '960', '0', '1000'])
    // **「按分経費」は消える** — 中身が固定費の按分だと分かる名前にした
    expect(header).not.toContain('按分経費')
  })

  it('CSV は 分けられない運行の 2 列を空にする (0 と書かない)', () => {
    const zero = { preLoadKm: 0, haulKm: 0, betweenKm: 0, postUnloadKm: 0, otherKm: 0 }
    const res = buildOperationMargins(
      [op({ totalKm: 100, kmBreakdown: zero })],
      [cost({ costKind: '01', quantity: 20, amount: 2400 })],
      {},
    )
    const lines = marginCsvLines(res.operations)
    const header = lines[0]!.split(',').map(v => v.replace(/"/g, ''))
    const row = lines[1]!.split(',').map(v => v.replace(/"/g, ''))
    const at = header.indexOf('燃料代')
    expect(row.slice(at, at + 3)).toEqual(['2400', '', ''])
  })
})

/**
 * **固定費按分の中身**を画面に出せる形で返す (Refs #760 の 8)。
 *
 * 実例 (2026-07 / 車1109) は 固定費 3 行 + **運行の無い日の車輌修繕費** 1 行。
 * 性質が違う 2 つが同じ額に畳まれているので、`isFixed` で区別できないと
 * 「固定費按分」という名前そのものが嘘になる。
 */
describe('固定費按分の中身 (fixedPoolByVehicle)', () => {
  it('固定費と、運行の無い日の変動費を、車輌ごとに両方持つ', () => {
    const res = buildOperationMargins(
      [op({ date: '2026-07-01', totalKm: 100 })],
      [
        // 固定費 (リース) — 日が運行に当たっていても按分に回る
        cost({ costKind: '13', costKindName: 'リース･償却費', costName: 'リース料', operationDate: '2026-07-01', amount: 70000, isFixed: true }),
        // **運行の無い日の変動費** — 直課できないので按分に回る (実例 07-24 の車輌修繕)
        cost({ costKind: '05', costKindName: '車輌修繕費', costName: '車輌修繕', operationDate: '2026-07-24', amount: 97195, isFixed: false }),
        // 日・車輌が当たる変動費 → 直課。**pool には入らない**
        cost({ costKind: '04', costKindName: '通行料', operationDate: '2026-07-01', amount: 3000 }),
      ],
      {},
    )
    const rows = res.fixedPoolByVehicle.get('1109')!
    expect(rows).toEqual([
      { date: '2026-07-01', costKindName: 'リース･償却費', costName: 'リース料', yen: 70000, isFixed: true },
      { date: '2026-07-24', costKindName: '車輌修繕費', costName: '車輌修繕', yen: 97195, isFixed: false },
    ])
    // 直課した通行料は入っていない (按分に回っていないので)
    expect(rows.map(r => r.costKindName)).not.toContain('通行料')
    // 額は今までどおり — 行の一覧を返しても按分の計算は 1 ミリも変えていない
    expect(res.operations[0]!.allocatedCostYen).toBe(167195)
    expect(res.operations[0]!.directCostYen).toBe(3000)
  })

  it('軽油引取税を足した実額で持つ (画面の額と食い違わせない)', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100 })],
      [cost({ costKind: '13', amount: 1000, dieselTax: 200, isFixed: true })],
      {},
    )
    expect(res.fixedPoolByVehicle.get('1109')![0]!.yen).toBe(1200)
  })

  it('按分に回った経費が無い車輌は空 (キーそのものが無い)', () => {
    const res = buildOperationMargins(
      [op({ date: '2026-07-01', totalKm: 100 })],
      [cost({ costKind: '04', operationDate: '2026-07-01', amount: 3000 })],
      {},
    )
    expect(res.fixedPoolByVehicle.get('1109')).toBeUndefined()
  })

  it('配れなかった経費も残る (どの運行にも当たらない車輌のぶん)', () => {
    // **`dropped` に落ちたぶんも「按分に回した」ことは同じ。** 一覧から消すと
    // 「配れなかった経費が ¥X あります」の中身が画面から辿れなくなる。
    const res = buildOperationMargins(
      [op({ vehicleCode: '1109' })],
      [cost({ costKind: '13', vehicleNumber: '9999', amount: 1000, isFixed: true })],
      {},
    )
    expect(res.unallocatedCostYen).toBe(1000)
    expect(res.fixedPoolByVehicle.get('9999')).toHaveLength(1)
  })
})

/**
 * 直課経費の中身 (Refs #760 の 14)。
 *
 * `fixedPoolByVehicle` (#770) の直課版。**按分・粗利の計算には 1 円も効かない** —
 * 画面の title に「何を直課したか」を列挙するためだけに持ち回る。
 */
describe('直課経費の中身 (directRowsByUnko)', () => {
  /** 2026-07 の実例 (車輌1420 07-13 / 車輌1109 07-15) の形。 */
  const repair = (over: Partial<CostRow> = {}) => cost({
    costKind: '05', costKindName: '車輌修繕費(変動)', costName: '一般修理費',
    operationDate: '2026-07-13', vehicleNumber: '1420', amount: 206060,
    remarks: 'ﾄﾞｰｼﾞﾝｸﾞﾕﾆｯﾄ交換', vendorName: '三菱ふそう', ...over,
  })

  it('直課した行だけを運行NO ごとに持つ (固定費・運行の無い日の行は入らない)', () => {
    const res = buildOperationMargins(
      [op({ unkoNo: 'A', date: '2026-07-13', vehicleCode: '1420', totalKm: 100 })],
      [
        repair(),
        repair({ costName: '一般修理費', amount: 12000, remarks: 'ﾊｰﾈｽ配線修理' }),
        // 固定費 → 按分に回る。直課の一覧には入らない
        cost({ costKind: '13', costKindName: 'リース･償却費', operationDate: '2026-07-13', vehicleNumber: '1420', amount: 70000, isFixed: true }),
        // 運行の無い日の変動費 → 按分に回る
        repair({ operationDate: '2026-07-24', amount: 97195 }),
        // 別の車輌 → 当たらない
        repair({ vehicleNumber: '1109', amount: 5000 }),
      ],
      {},
    )
    expect(res.directRowsByUnko.get('A')).toEqual([
      { date: '2026-07-13', costKindName: '車輌修繕費(変動)', costName: '一般修理費', yen: 206060, remarks: 'ﾄﾞｰｼﾞﾝｸﾞﾕﾆｯﾄ交換', vendorName: '三菱ふそう' },
      { date: '2026-07-13', costKindName: '車輌修繕費(変動)', costName: '一般修理費', yen: 12000, remarks: 'ﾊｰﾈｽ配線修理', vendorName: '三菱ふそう' },
    ])
    // 額は今までどおり (一覧を返しても直課の計算は 1 ミリも変えていない)
    expect(res.operations[0]!.directCostYen).toBe(218060)
    // 按分に回った側は fixedPoolByVehicle に (こちらに remarks は要らない)
    expect(res.fixedPoolByVehicle.get('1420')!.map(r => r.yen)).toEqual([70000, 97195])
  })

  it('同じ日・同じ車輌に運行が 2 本あれば、行の yen はその運行に乗ったぶん (距離比で割った後)', () => {
    const res = buildOperationMargins(
      [op({ unkoNo: 'A', totalKm: 300 }), op({ unkoNo: 'B', totalKm: 100 })],
      [cost({ costKind: '04', costName: '通行料', amount: 4000 })],
      {},
    )
    expect(res.directRowsByUnko.get('A')![0]!.yen).toBe(3000)
    expect(res.directRowsByUnko.get('B')![0]!.yen).toBe(1000)
    // 行の額の和 = directCostYen
    expect(res.operations[0]!.directCostYen).toBe(3000)
    expect(res.operations[1]!.directCostYen).toBe(1000)
  })

  it('軽油引取税を足した実額で持つ', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100 })],
      [cost({ costKind: '04', amount: 1000, dieselTax: 200 })],
      {},
    )
    expect(res.directRowsByUnko.get('2607011000000000001109')![0]!.yen).toBe(1200)
  })

  it('直課した行が無い運行はキーそのものが無い', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100 })],
      [cost({ costKind: '13', amount: 1000, isFixed: true })],
      {},
    )
    expect(res.directRowsByUnko.get('2607011000000000001109')).toBeUndefined()
  })

  it('人件費 (08/11) の直課は入らない (粗利の経費だけ)', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100 })],
      [cost({ costKind: '08', costKindName: '給与', amount: 300000 })],
      {},
    )
    expect(res.directRowsByUnko.size).toBe(0)
  })

  describe('運行行の title (operationDirectCostTitle)', () => {
    const m = (over: Partial<OperationMargin> = {}): OperationMargin => ({
      ...buildOperationMargins([op({ unkoNo: 'A', date: '2026-07-13', vehicleCode: '1420' })], [cost()], {}).operations[0]!,
      ...over,
    })

    it('頭に運行と基準、以下 1 行ずつ「経費名 金額 備考 (支払先)」', () => {
      const res = buildOperationMargins(
        [op({ unkoNo: 'A', date: '2026-07-13', vehicleCode: '1420', totalKm: 100 })],
        [repair(), repair({ amount: 12000, remarks: 'ﾊｰﾈｽ配線修理' })],
        {},
      )
      expect(operationDirectCostTitle(res.operations[0]!, res.directRowsByUnko)).toBe(
        '直課経費の中身 — 運行 2026-07-13 車輌1420 (日・車輌が一致した変動費)\n'
        + '一般修理費 ¥206,060 ﾄﾞｰｼﾞﾝｸﾞﾕﾆｯﾄ交換 (三菱ふそう)\n'
        + '一般修理費 ¥12,000 ﾊｰﾈｽ配線修理 (三菱ふそう)',
      )
    })

    it('備考が空なら省く、支払先が空なら括弧ごと省く', () => {
      const byUnko = new Map([['A', [
        { date: '2026-07-15', costKindName: '車輌修繕費', costName: 'ﾀｲﾔ･ﾊﾞｯﾃﾘｰ', yen: 129600, remarks: 'ﾀｲﾔ 4本', vendorName: 'トーヨータイヤ' },
        { date: '2026-07-15', costKindName: '車輌修繕費', costName: 'ﾀｲﾔ･ﾊﾞｯﾃﾘｰ', yen: 68200, remarks: 'ﾀｲﾔ 2本', vendorName: '' },
        { date: '2026-07-15', costKindName: '通行料', costName: '通行料', yen: 3000, remarks: '', vendorName: 'NEXCO' },
        { date: '2026-07-15', costKindName: '通行料', costName: '通行料', yen: 2000.4, remarks: '', vendorName: '' },
      ]]])
      expect(operationDirectCostTitle(m({ unkoNo: 'A', date: '2026-07-15', vehicleCode: '1109' }), byUnko).split('\n')).toEqual([
        '直課経費の中身 — 運行 2026-07-15 車輌1109 (日・車輌が一致した変動費)',
        'ﾀｲﾔ･ﾊﾞｯﾃﾘｰ ¥129,600 ﾀｲﾔ 4本 (トーヨータイヤ)',
        'ﾀｲﾔ･ﾊﾞｯﾃﾘｰ ¥68,200 ﾀｲﾔ 2本',
        '通行料 ¥3,000 (NEXCO)',
        '通行料 ¥2,000',
      ])
    })

    it('直課した行が無ければ「直課経費なし」', () => {
      expect(operationDirectCostTitle(m({ unkoNo: 'Z' }), new Map())).toBe('直課経費なし')
      expect(NO_DIRECT_COST_TITLE).toBe('直課経費なし')
    })
  })

  describe('乗務員行の title (driverDirectCostTitle)', () => {
    it('頭に乗務員と運行数、種別ごとの合計と件数 (種別名は cost_kind_name そのまま)、金額の大きい順の行 (日付付き)', () => {
      const res = buildOperationMargins(
        [
          op({ unkoNo: 'A', date: '2026-07-13', vehicleCode: '1420', driverName: '西島', totalKm: 100 }),
          op({ unkoNo: 'B', date: '2026-07-15', vehicleCode: '1420', driverName: '西島', totalKm: 100 }),
        ],
        [
          repair(),
          cost({ costKind: '04', costKindName: '通行料', costName: '通行料', operationDate: '2026-07-15', vehicleNumber: '1420', amount: 3000 }),
          repair({ amount: 12000, remarks: 'ﾊｰﾈｽ配線修理' }),
        ],
        {},
      )
      const [d] = groupMarginsByDriver(res.operations)
      expect(driverDirectCostTitle(d!, res.directRowsByUnko).split('\n')).toEqual([
        '直課経費の中身 — 西島 の 2 運行ぶん',
        // **「(変動)」は後付けしない** — 経費種別ﾏｽﾀの名前が既に「車輌修繕費(変動)」
        '車輌修繕費(変動) ¥218,060 (2 件)',
        '通行料 ¥3,000 (1 件)',
        '07-13 一般修理費 ¥206,060 ﾄﾞｰｼﾞﾝｸﾞﾕﾆｯﾄ交換 (三菱ふそう)',
        '07-13 一般修理費 ¥12,000 ﾊｰﾈｽ配線修理 (三菱ふそう)',
        '07-15 通行料 ¥3,000',
      ])
    })

    it('11 行目以降は「…他 N 行」に畳む (上位 10 行は金額の大きい順)', () => {
      // 通行料 ¥100〜¥1,300 の 13 行 (順番はわざと昇順で入れる → title は降順)
      const rows = Array.from({ length: 13 }, (_, i) => cost({
        costKind: '04', costKindName: '通行料', costName: '通行料', amount: (i + 1) * 100, rowId: `r${i}`,
      }))
      const res = buildOperationMargins([op({ unkoNo: 'A', totalKm: 100 })], rows, {})
      const [d] = groupMarginsByDriver(res.operations)
      const lines = driverDirectCostTitle(d!, res.directRowsByUnko).split('\n')
      expect(DIRECT_COST_TITLE_TOP).toBe(10)
      expect(lines).toHaveLength(1 + 1 + 10 + 1)
      expect(lines[0]).toBe('直課経費の中身 — 佐竹 繁 の 1 運行ぶん')
      expect(lines[1]).toBe('通行料 ¥9,100 (13 件)')
      expect(lines[2]).toBe('07-01 通行料 ¥1,300')
      expect(lines[11]).toBe('07-01 通行料 ¥400')
      expect(lines[12]).toBe('…他 3 行')
    })

    it('ちょうど 10 行なら「…他」は出さない', () => {
      const rows = Array.from({ length: 10 }, (_, i) => cost({ costKind: '04', amount: (i + 1) * 100, rowId: `r${i}` }))
      const res = buildOperationMargins([op({ unkoNo: 'A', totalKm: 100 })], rows, {})
      const [d] = groupMarginsByDriver(res.operations)
      const lines = driverDirectCostTitle(d!, res.directRowsByUnko).split('\n')
      expect(lines).toHaveLength(12)
      expect(lines[11]).toBe('07-01 軽油費 ¥100')
    })

    it('直課した行が無ければ「直課経費なし」', () => {
      const res = buildOperationMargins([op({ totalKm: 100 })], [cost({ costKind: '13', isFixed: true })], {})
      const [d] = groupMarginsByDriver(res.operations)
      expect(driverDirectCostTitle(d!, res.directRowsByUnko)).toBe('直課経費なし')
    })
  })
})

/**
 * 便ごとの粗利 (Refs #760 の 13)。
 *
 * **運行の粗利には 1 円も効かない** — 便の段はこの入力から独立に出す
 * (直課経費・固定費按分は便に割らず、運行の段に残す)。
 */
describe('便ごとの粗利 (legs)', () => {
  it('便ごとの燃料代・収支を計算する (運行と同じ単価・燃費)', () => {
    const res = buildOperationMargins(
      [op({
        totalKm: 100,
        legs: [leg({ seq: 1, haulKm: 40, deadheadKm: 20, salesYen: 20000, allowanceYen: 3000 })],
      })],
      // 単価 2400÷20 = 120 円/L、燃費 100÷20 = 5 km/L (運行と同じ経費から出す)
      [cost({ costKind: FUEL_KIND, quantity: 20, amount: 2400 })],
      {},
    )
    const l = res.operations[0]!.legs[0]!
    expect(l.seq).toBe(1)
    // 40÷5×120 = 960 / 20÷5×120 = 480
    expect(l.fuelHaulYen).toBe(960)
    expect(l.fuelDeadheadYen).toBe(480)
    expect(l.marginYen).toBe(20000 - 3000 - 960 - 480)
  })

  it('**不変条件** 便が揃っている運行では Σ便の回送燃料 が運行の回送燃料と 1 円未満で一致する', () => {
    const res = buildOperationMargins(
      [op({
        totalKm: 100,
        // preLoad10 + between25 + postUnload5 = 40 (回送) / haul60 (売上走行)
        kmBreakdown: { preLoadKm: 10, haulKm: 60, betweenKm: 25, postUnloadKm: 5, otherKm: 0 },
        legs: [
          // 1 便目: 積前 (10) ぶんの回送
          leg({ seq: 1, haulKm: 30, deadheadKm: 10 }),
          // 2 便目 (最後): 便間 + 降後 (25+5=30) ぶんの回送
          leg({ seq: 2, haulKm: 30, deadheadKm: 30 }),
        ],
      })],
      [cost({ costKind: FUEL_KIND, quantity: 20, amount: 2400 })],
      {},
    )
    const m = res.operations[0]!
    const legSum = m.legs.reduce((sum, l) => sum + (l.fuelDeadheadYen ?? 0), 0)
    expect(Math.abs(legSum - m.fuelDeadheadYen!)).toBeLessThan(1)
    // 便の合計 haulKm/deadheadKm も運行の内訳に一致する (このテストの前提)
    expect(m.legs.reduce((sum, l) => sum + l.haulKm, 0)).toBe(m.kmBreakdown.haulKm)
  })

  it('FuelRate が出せない (燃料の給油実績が無い) 運行は便の燃料も収支も null', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100, legs: [leg()] })],
      [], // 経費 0 件 → 燃費が出せない
      {},
    )
    const l = res.operations[0]!.legs[0]!
    expect(l.fuelHaulYen).toBeNull()
    expect(l.fuelDeadheadYen).toBeNull()
    expect(l.marginYen).toBeNull()
  })

  it('便の無い運行 (legs: []) は legs が空配列のまま', () => {
    const res = buildOperationMargins([op({ totalKm: 100, legs: [] })], [], {})
    expect(res.operations[0]!.legs).toEqual([])
  })

  it('marginLegCsvLines は便ごとに 1 行、運行の CSV とは別の列を出す', () => {
    const res = buildOperationMargins(
      [op({
        unkoNo: 'A"1',
        totalKm: 100,
        legs: [leg({
          seq: 1, date: '2026-07-01', originCity: '北海道釧路市', destCity: '浦幌町',
          haulKm: 40.5, deadheadKm: 20.4, salesYen: 20000, allowanceYen: 3000,
        })],
      })],
      [cost({ costKind: FUEL_KIND, quantity: 20, amount: 2400 })],
      {},
    )
    const lines = marginLegCsvLines(res.operations)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe([
      '運行NO', '日付', '乗務員', '車輌C', '便', '積地', '卸地',
      '売上走行km', '回送km', '売上', '手当', '燃料代(売上走行)', '回送燃料', '便の収支',
    ].map(v => `"${v}"`).join(','))
    // 引用符のエスケープは運行の CSV と同じ流儀 (運行NO に " が入る → "" にエスケープ)。
    // 40.5÷5×120=972 (売上走行) / 20.4÷5×120=489.6→490 (回送) /
    // 20000−3000−972−489.6=15538.4→15538 (丸め前の値で計算する便の収支)
    expect(lines[1]).toBe([
      '"A""1"', '"2026-07-01"', '"佐竹 繁"', '"1109"', '"1"', '"北海道釧路市"', '"浦幌町"',
      '"41"', '"20"', '"20000"', '"3000"', '"972"', '"490"', '"15538"',
    ].join(','))
  })

  it('便が無い運行は marginLegCsvLines に 1 行も出ない (ヘッダだけ)', () => {
    const res = buildOperationMargins([op({ totalKm: 100, legs: [] })], [], {})
    expect(marginLegCsvLines(res.operations)).toHaveLength(1)
  })

  it('FuelRate が出せない便は marginLegCsvLines の燃料・収支の列を空にする', () => {
    const res = buildOperationMargins(
      [op({ totalKm: 100, legs: [leg({ haulKm: 40, deadheadKm: 20 })] })],
      [], // 経費 0 件 → 燃費が出せない
      {},
    )
    const row = marginLegCsvLines(res.operations)[1]!
    expect(row).toBe([
      '"2607011000000000001109"', '"2026-07-01"', '"佐竹 繁"', '"1109"', '"1"',
      '"北海道釧路市"', '"浦幌町"', '"40"', '"20"', '"20000"', '"3000"', '""', '""', '""',
    ].join(','))
  })
})
