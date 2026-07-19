import { describe, it, expect } from 'vitest'
import {
  groupSlipsByVehicleDate,
  operationSearchDateRange,
  pickOperationForDate,
  buildCompareRowView,
  defaultCompareDateRange,
  compareRowsToCsvLines,
  type CompareRow,
  type CompareRowView,
} from '~/utils/profit-compare'
import type { VehicleDailySlip } from '~/utils/ichiban'
import type { OperationListItem } from '~/types'

function slip(overrides: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-06-21',
    vehicleNumber: '8504',
    customerCode: '000001',
    customerName: '㈱田浦畜産',
    originAreaName: '長崎県',
    destAreaName: '福岡県北九州市',
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

function operation(overrides: Partial<OperationListItem> = {}): OperationListItem {
  return {
    id: 'op-1',
    unko_no: '2607030428090000001109',
    crew_role: 1,
    reading_date: '2026-06-21',
    operation_date: '2026-06-21',
    driver_name: '山田太郎',
    vehicle_name: '8504号車',
    total_distance: 120.5,
    safety_score: 90,
    economy_score: 80,
    total_score: 85,
    has_kudgivt: true,
    ...overrides,
  }
}

describe('groupSlipsByVehicleDate', () => {
  it('同一車輌・同一売上年月日の伝票を1グループに集約し金額を合算する', () => {
    const a = slip({ rowId: 'a', amount: 30000 })
    const b = slip({ rowId: 'b', amount: 15000 })
    const groups = groupSlipsByVehicleDate([a, b])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.amount).toBe(45000)
    expect(groups[0]!.rowIds).toEqual(['a', 'b'])
  })

  it('車輌または売上年月日が異なれば別グループになる', () => {
    const a = slip({ rowId: 'a', vehicleNumber: '8504' })
    const b = slip({ rowId: 'b', vehicleNumber: '9012' })
    const c = slip({ rowId: 'c', saleDate: '2026-06-22' })
    const groups = groupSlipsByVehicleDate([a, b, c])
    expect(groups).toHaveLength(3)
  })

  it('originAreaName/destAreaName が空なら origin/dest (自由入力) にフォールバックする', () => {
    const s = slip({ originAreaName: '', destAreaName: '', origin: '釧路', dest: '博多' })
    const [group] = groupSlipsByVehicleDate([s])
    expect(group!.originLabel).toBe('釧路')
    expect(group!.destLabel).toBe('博多')
  })

  it('空配列なら空配列を返す', () => {
    expect(groupSlipsByVehicleDate([])).toEqual([])
  })
})

describe('operationSearchDateRange', () => {
  it('前後1日ずつ広げた範囲を返す (reading_date とのズレ吸収)', () => {
    expect(operationSearchDateRange('2026-06-21')).toEqual({
      date_from: '2026-06-20',
      date_to: '2026-06-22',
    })
  })

  it('月またぎでも正しく繰り上がる', () => {
    expect(operationSearchDateRange('2026-06-30')).toEqual({
      date_from: '2026-06-29',
      date_to: '2026-07-01',
    })
  })

  it('年またぎでも正しく繰り上がる', () => {
    expect(operationSearchDateRange('2026-12-31')).toEqual({
      date_from: '2026-12-30',
      date_to: '2027-01-01',
    })
  })
})

describe('pickOperationForDate', () => {
  it('operation_date が saleDate と一致する運行を選ぶ', () => {
    const target = operation({ operation_date: '2026-06-21' })
    const other = operation({ id: 'op-2', operation_date: '2026-06-20' })
    expect(pickOperationForDate([other, target], '2026-06-21')).toBe(target)
  })

  it('operation_date が null なら reading_date にフォールバックする', () => {
    const target = operation({ operation_date: null, reading_date: '2026-06-21' })
    expect(pickOperationForDate([target], '2026-06-21')).toBe(target)
  })

  it('一致する運行が無ければ null', () => {
    const other = operation({ operation_date: '2026-06-20' })
    expect(pickOperationForDate([other], '2026-06-21')).toBeNull()
  })

  it('空配列なら null', () => {
    expect(pickOperationForDate([], '2026-06-21')).toBeNull()
  })
})

describe('buildCompareRowView', () => {
  it('運行・CSV集計が揃っていれば距離・時間・効率指標を全て埋める', () => {
    const row: CompareRow = {
      group: {
        vehicleNumber: '8504',
        saleDate: '2026-06-21',
        customerName: '㈱田浦畜産',
        originLabel: '長崎県',
        destLabel: '福岡県北九州市',
        amount: 65000,
        rowIds: ['row-1'],
      },
      operation: operation(),
      segment: {
        distanceKm: 100,
        durationMin: 480,
        byCategory: { drive: 300, loading: 60, unloading: 60, rest: 60, idle: 0, other: 0 },
        rowCount: 10,
      },
    }
    const view = buildCompareRowView(row)
    expect(view.unkoNo).toBe('2607030428090000001109')
    expect(view.driverName).toBe('山田太郎')
    expect(view.distanceKm).toBe(100)
    expect(view.boundMin).toBe(480)
    expect(view.driveMin).toBe(300)
    expect(view.efficiency.yenPerKm).toBeCloseTo(650)
    expect(view.efficiency.yenPerHourBound).toBeCloseTo(65000 / 8)
    expect(view.efficiency.yenPerHourDrive).toBeCloseTo(65000 / 5)
  })

  it('運行が見つからなければ距離・時間・乗務員が全て null/未確定になる (ゼロ除算ガードで効率指標も null)', () => {
    const row: CompareRow = {
      group: {
        vehicleNumber: '8504',
        saleDate: '2026-06-21',
        customerName: '㈱田浦畜産',
        originLabel: '長崎県',
        destLabel: '福岡県北九州市',
        amount: 65000,
        rowIds: ['row-1'],
      },
      operation: null,
      segment: null,
    }
    const view = buildCompareRowView(row)
    expect(view.unkoNo).toBeNull()
    expect(view.driverName).toBeNull()
    expect(view.distanceKm).toBeNull()
    expect(view.boundMin).toBeNull()
    expect(view.driveMin).toBeNull()
    expect(view.efficiency.yenPerKm).toBeNull()
    expect(view.efficiency.yenPerHourBound).toBeNull()
    expect(view.efficiency.yenPerHourDrive).toBeNull()
  })

  it('運行はあるが CSV 集計が無ければ距離・時間は null のまま', () => {
    const row: CompareRow = {
      group: {
        vehicleNumber: '8504',
        saleDate: '2026-06-21',
        customerName: '㈱田浦畜産',
        originLabel: '長崎県',
        destLabel: '福岡県北九州市',
        amount: 65000,
        rowIds: ['row-1'],
      },
      operation: operation(),
      segment: null,
    }
    const view = buildCompareRowView(row)
    expect(view.unkoNo).toBe('2607030428090000001109')
    expect(view.distanceKm).toBeNull()
  })
})

describe('defaultCompareDateRange', () => {
  it('from は30日前、to は当日の翌日 (半開区間で当日分まで含む)', () => {
    const now = Date.UTC(2026, 6, 20, 12, 0, 0) / 1000
    expect(defaultCompareDateRange(now)).toEqual({ from: '2026-06-20', to: '2026-07-21' })
  })
})

describe('compareRowsToCsvLines', () => {
  function view(overrides: Partial<CompareRowView> = {}): CompareRowView {
    return {
      vehicleNumber: '8504',
      saleDate: '2026-06-21',
      customerName: '㈱田浦畜産',
      originLabel: '長崎県',
      destLabel: '福岡県北九州市',
      amount: 65000,
      unkoNo: '2607030428090000001109',
      driverName: '山田太郎',
      distanceKm: 100,
      boundMin: 480,
      driveMin: 300,
      efficiency: { yenPerKm: 650, yenPerHourBound: 8125, yenPerHourDrive: 13000 },
      ...overrides,
    }
  }

  it('ヘッダー行 + データ行を CSV 形式 (カンマ区切り) で返す', () => {
    const lines = compareRowsToCsvLines([view()])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('日付')
    expect(lines[1]).toContain('8504')
    expect(lines[1]).toContain('2607030428090000001109')
  })

  it('カンマ・ダブルクォートを含む値はダブルクォートで囲みエスケープする', () => {
    const lines = compareRowsToCsvLines([view({ customerName: '㈱田浦, "畜産"' })])
    expect(lines[1]).toContain('"㈱田浦, ""畜産"""')
  })

  it('null 項目 (未確定の距離・時間・効率指標) は空文字になる', () => {
    const lines = compareRowsToCsvLines([view({
      distanceKm: null,
      boundMin: null,
      driveMin: null,
      unkoNo: null,
      driverName: null,
      efficiency: { yenPerKm: null, yenPerHourBound: null, yenPerHourDrive: null },
    })])
    const cols = lines[1]!.split(',')
    // 日付,車輌,乗務員,得意先,積地,卸地,売上,距離,拘束,運転,円/km,円/h拘束,円/h運転,運行番号
    expect(cols[2]).toBe('') // 乗務員
    expect(cols[7]).toBe('') // 距離
    expect(cols[13]).toBe('') // 運行番号
  })

  it('空配列でもヘッダー行のみ返す', () => {
    expect(compareRowsToCsvLines([])).toHaveLength(1)
  })
})
