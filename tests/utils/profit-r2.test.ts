import { describe, it, expect } from 'vitest'
import {
  profitR2Paths,
  segmentId,
  profitYm,
  profitVersionTimestamp,
  appendProfitHistoryJsonl,
  buildProfitSnapshot,
  monthRange,
  summarizeMonthly,
  toSnapshotListItem,
  sortSnapshotListBySavedAtDesc,
  type ProfitSnapshotSlip,
  type ProfitSnapshot,
} from '~/utils/profit-r2'
import type { ScoredVehicleDailySlip, VehicleDailySlip } from '~/utils/ichiban'

describe('profitR2Paths', () => {
  it('ym/vehicleCode/unkoNo/segmentId から latest/version/history のキーを組み立てる', () => {
    const paths = profitR2Paths('2026-06', '8504', 'unko-1', '100-200')
    expect(paths.dir).toBe('profit/2026-06/8504/unko-1/100-200')
    expect(paths.latest).toBe('profit/2026-06/8504/unko-1/100-200/latest.json')
    expect(paths.version('20260621T120000')).toBe('profit/2026-06/8504/unko-1/100-200/v-20260621T120000.json')
    expect(paths.history).toBe('profit/2026-06/8504/unko-1/100-200/history.jsonl')
  })
})

describe('segmentId', () => {
  it('fromTs-toTs をそのまま連結した決定論キーを返す', () => {
    expect(segmentId(100, 200)).toBe('100-200')
    expect(segmentId(100, 200)).toBe(segmentId(100, 200))
  })
})

describe('profitYm', () => {
  it('epoch秒 (JST壁時計) から YYYY-MM を切り出す', () => {
    const fromTs = Date.UTC(2026, 5, 21, 8, 0, 0) / 1000
    expect(profitYm(fromTs)).toBe('2026-06')
  })
})

describe('profitVersionTimestamp', () => {
  it('UTC時刻をJSTのYYYYMMDDTHHmmssに変換する', () => {
    // 2026-06-21 00:00:00 UTC → JST 09:00:00
    expect(profitVersionTimestamp(new Date(Date.UTC(2026, 5, 21, 0, 0, 0)))).toBe('20260621T090000')
  })

  it('日付が繰り上がるケースも正しく変換する', () => {
    // 2026-06-21 20:00:00 UTC → JST 翌日 05:00:00
    expect(profitVersionTimestamp(new Date(Date.UTC(2026, 5, 21, 20, 0, 0)))).toBe('20260622T050000')
  })
})

describe('appendProfitHistoryJsonl', () => {
  it('既存が無ければ1行だけのJSONLを返す', () => {
    expect(appendProfitHistoryJsonl(null, '{"a":1}')).toBe('{"a":1}\n')
  })

  it('既存に1行追記する', () => {
    expect(appendProfitHistoryJsonl('{"a":1}\n', '{"a":2}')).toBe('{"a":1}\n{"a":2}\n')
  })

  it('maxLines を超えたら古い行から切り捨てる', () => {
    const existing = '{"a":1}\n{"a":2}\n'
    expect(appendProfitHistoryJsonl(existing, '{"a":3}', 2)).toBe('{"a":2}\n{"a":3}\n')
  })

  it('既存が空行のみでも壊れない', () => {
    expect(appendProfitHistoryJsonl('\n\n', '{"a":1}')).toBe('{"a":1}\n')
  })
})

function slip(overrides: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-06-21',
    vehicleNumber: '8504',
    customerCode: '000001',
    customerName: '㈱田浦畜産',
    originAreaName: '長崎県長崎市',
    destAreaName: '福岡県北九州市',
    origin: '釧路',
    dest: '福岡県北九州市',
    isSubcontracted: false,
    amount: 65000,
    itemCode: '0001',
    itemName: '冷凍食品',
    quantity: 10.5,
    unitPrice: 6190,
    unit: '個',
    rowId: 'row-1',
    ...overrides,
  }
}

function scored(overrides: Partial<VehicleDailySlip> = {}): ScoredVehicleDailySlip {
  return {
    slip: slip(overrides),
    originMatch: 'exact',
    destMatch: 'exact',
    score: 4,
    suggested: true,
  }
}

describe('buildProfitSnapshot', () => {
  it('確認済み (confirmedRowIds に含まれる) 伝票だけを confirmedSlips に含める', () => {
    const included = scored({ rowId: 'row-1' })
    const excluded = scored({ rowId: 'row-2' })
    const snapshot = buildProfitSnapshot({
      vehicleCode: '8504',
      unkoNo: 'unko-1',
      range: { fromTs: 0, toTs: 3600 },
      location: { originCity: '長崎市', destCity: '北九州市' },
      summary: { distanceKm: 100, durationMin: 480, byCategory: { drive: 300, loading: 60, unloading: 60, rest: 60, idle: 0, other: 0 }, rowCount: 2 },
      scoredSlips: [included, excluded],
      confirmedRowIds: new Set(['row-1']),
      confirmedAmount: 65000,
      efficiency: { yenPerKm: 650, yenPerHourBound: 8125, yenPerHourDrive: 13000 },
      savedAt: '2026-07-19T00:00:00.000Z',
    })

    expect(snapshot.schemaVersion).toBe(1)
    expect(snapshot.ym).toBe('1970-01')
    expect(snapshot.segmentId).toBe('0-3600')
    expect(snapshot.confirmedSlips).toHaveLength(1)
    const confirmedSlip = snapshot.confirmedSlips[0] as ProfitSnapshotSlip
    expect(confirmedSlip.rowId).toBe('row-1')
    expect(confirmedSlip.itemName).toBe('冷凍食品')
    expect(confirmedSlip.quantity).toBe(10.5)
    expect(confirmedSlip.originMatch).toBe('exact')
    expect(snapshot.confirmedAmount).toBe(65000)
    expect(snapshot.savedAt).toBe('2026-07-19T00:00:00.000Z')
  })

  it('location が null なら originCity/destCity を空文字で埋める', () => {
    const snapshot = buildProfitSnapshot({
      vehicleCode: '8504',
      unkoNo: 'unko-1',
      range: { fromTs: 0, toTs: 3600 },
      location: null,
      summary: { distanceKm: 0, durationMin: 0, byCategory: { drive: 0, loading: 0, unloading: 0, rest: 0, idle: 0, other: 0 }, rowCount: 0 },
      scoredSlips: [],
      confirmedRowIds: new Set(),
      confirmedAmount: 0,
      efficiency: { yenPerKm: null, yenPerHourBound: null, yenPerHourDrive: null },
      savedAt: '2026-07-19T00:00:00.000Z',
    })
    expect(snapshot.location).toEqual({ originCity: '', destCity: '' })
    expect(snapshot.confirmedSlips).toEqual([])
  })
})

describe('monthRange', () => {
  it('通常月は同年内の翌月1日を to にする', () => {
    expect(monthRange('2026-06')).toEqual({ from: '2026-06-01', to: '2026-07-01' })
  })

  it('12月は年またぎで翌年1月1日を to にする', () => {
    expect(monthRange('2026-12')).toEqual({ from: '2026-12-01', to: '2027-01-01' })
  })
})

function snapshotSlip(overrides: Partial<ProfitSnapshotSlip> = {}): ProfitSnapshotSlip {
  return {
    rowId: 'row-1',
    saleDate: '2026-06-21',
    customerCode: '000001',
    customerName: '㈱田浦畜産',
    originAreaName: '長崎県長崎市',
    destAreaName: '福岡県北九州市',
    origin: '釧路',
    dest: '福岡県北九州市',
    isSubcontracted: false,
    amount: 65000,
    itemCode: '0001',
    itemName: '冷凍食品',
    quantity: 10.5,
    unitPrice: 6190,
    unit: '個',
    originMatch: 'exact',
    destMatch: 'exact',
    ...overrides,
  }
}

function profitSnapshot(overrides: Partial<ProfitSnapshot> = {}): ProfitSnapshot {
  return {
    schemaVersion: 1,
    vehicleCode: '8504',
    unkoNo: 'unko-1',
    segmentId: '0-3600',
    ym: '2026-06',
    range: { fromTs: 0, toTs: 3600 },
    location: { originCity: '長崎市', destCity: '北九州市' },
    dtakoSummary: { distanceKm: 100, durationMin: 480, byCategory: { drive: 300, loading: 60, unloading: 60, rest: 60, idle: 0, other: 0 }, rowCount: 2 },
    confirmedSlips: [snapshotSlip()],
    confirmedAmount: 65000,
    efficiency: { yenPerKm: 650, yenPerHourBound: 8125, yenPerHourDrive: 13000 },
    savedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  }
}

function ichibanSlip(overrides: Partial<VehicleDailySlip> = {}): VehicleDailySlip {
  return {
    saleDate: '2026-06-21',
    vehicleNumber: '8504',
    customerCode: '000001',
    customerName: '㈱田浦畜産',
    originAreaName: '長崎県長崎市',
    destAreaName: '福岡県北九州市',
    origin: '釧路',
    dest: '福岡県北九州市',
    isSubcontracted: false,
    amount: 65000,
    itemCode: '',
    itemName: '',
    quantity: 0,
    unitPrice: 0,
    unit: '',
    rowId: 'row-1',
    ...overrides,
  }
}

describe('summarizeMonthly', () => {
  it('一番星月計 (全伝票合算) と確認済み合計・差額を計算する', () => {
    const ichibanRows = [ichibanSlip({ amount: 65000 }), ichibanSlip({ rowId: 'row-2', amount: 20000 })]
    const snapshots = [profitSnapshot({ confirmedAmount: 65000 })]
    const result = summarizeMonthly(ichibanRows, snapshots)
    expect(result.ichibanTotal).toBe(85000)
    expect(result.confirmedTotal).toBe(65000)
    expect(result.diff).toBe(20000)
    expect(result.snapshotCount).toBe(1)
  })

  it('両方 exact なら exact に集計する', () => {
    const snapshots = [profitSnapshot({ confirmedSlips: [snapshotSlip({ originMatch: 'exact', destMatch: 'exact' })] })]
    const result = summarizeMonthly([], snapshots)
    expect(result.matchCounts).toEqual({ exact: 1, partial: 0, none: 0 })
  })

  it('片方でも partial なら partial に集計する', () => {
    const snapshots = [profitSnapshot({ confirmedSlips: [snapshotSlip({ originMatch: 'exact', destMatch: 'partial' })] })]
    const result = summarizeMonthly([], snapshots)
    expect(result.matchCounts).toEqual({ exact: 0, partial: 1, none: 0 })
  })

  it('destMatch が none なら none に集計する (originMatch が partial でも none 優先)', () => {
    const snapshots = [profitSnapshot({ confirmedSlips: [snapshotSlip({ originMatch: 'partial', destMatch: 'none' })] })]
    const result = summarizeMonthly([], snapshots)
    expect(result.matchCounts).toEqual({ exact: 0, partial: 0, none: 1 })
  })

  it('originMatch が none なら none に集計する', () => {
    const snapshots = [profitSnapshot({ confirmedSlips: [snapshotSlip({ originMatch: 'none', destMatch: 'exact' })] })]
    const result = summarizeMonthly([], snapshots)
    expect(result.matchCounts).toEqual({ exact: 0, partial: 0, none: 1 })
  })

  it('originMatch が exact でも destMatch が exact でなければ partial (AND の左辺true・右辺false)', () => {
    const snapshots = [profitSnapshot({ confirmedSlips: [snapshotSlip({ originMatch: 'exact', destMatch: 'partial' })] })]
    const result = summarizeMonthly([], snapshots)
    expect(result.matchCounts).toEqual({ exact: 0, partial: 1, none: 0 })
  })

  it('originMatch が exact でなければ destMatch が exact でも partial (AND の左辺false)', () => {
    const snapshots = [profitSnapshot({ confirmedSlips: [snapshotSlip({ originMatch: 'partial', destMatch: 'exact' })] })]
    const result = summarizeMonthly([], snapshots)
    expect(result.matchCounts).toEqual({ exact: 0, partial: 1, none: 0 })
  })

  it('スナップショット・一番星行がどちらも空でも壊れない', () => {
    const result = summarizeMonthly([], [])
    expect(result).toEqual({ ichibanTotal: 0, confirmedTotal: 0, diff: 0, matchCounts: { exact: 0, partial: 0, none: 0 }, snapshotCount: 0 })
  })

  it('複数スナップショット・複数伝票を横断して集計する', () => {
    const snapshots = [
      profitSnapshot({ confirmedAmount: 65000, confirmedSlips: [snapshotSlip({ rowId: 'a', originMatch: 'exact', destMatch: 'exact' })] }),
      profitSnapshot({ confirmedAmount: 20000, confirmedSlips: [snapshotSlip({ rowId: 'b', originMatch: 'none', destMatch: 'none' })] }),
    ]
    const result = summarizeMonthly([ichibanSlip({ amount: 100000 })], snapshots)
    expect(result.confirmedTotal).toBe(85000)
    expect(result.matchCounts).toEqual({ exact: 1, partial: 0, none: 1 })
    expect(result.snapshotCount).toBe(2)
  })
})

describe('toSnapshotListItem', () => {
  it('確認済み伝票から一覧表示用の要約を作る', () => {
    const snapshot = profitSnapshot({
      confirmedSlips: [
        snapshotSlip({ rowId: 'a', saleDate: '2026-06-21', customerName: 'A社', originMatch: 'exact', destMatch: 'exact' }),
        snapshotSlip({ rowId: 'b', saleDate: '2026-06-20', customerName: 'B社', originMatch: 'partial', destMatch: 'exact' }),
      ],
    })
    const item = toSnapshotListItem(snapshot)
    expect(item.vehicleCode).toBe('8504')
    expect(item.unkoNo).toBe('unko-1')
    expect(item.slipCount).toBe(2)
    expect(item.customerNames).toEqual(['A社', 'B社'])
    expect(item.saleDateFrom).toBe('2026-06-20')
    expect(item.saleDateTo).toBe('2026-06-21')
    expect(item.matchCounts).toEqual({ exact: 1, partial: 1, none: 0 })
  })

  it('得意先名の重複は除去する', () => {
    const snapshot = profitSnapshot({
      confirmedSlips: [
        snapshotSlip({ rowId: 'a', customerName: 'A社' }),
        snapshotSlip({ rowId: 'b', customerName: 'A社' }),
      ],
    })
    const item = toSnapshotListItem(snapshot)
    expect(item.customerNames).toEqual(['A社'])
  })

  it('確認済み伝票が0件なら日付・得意先は空になる', () => {
    const snapshot = profitSnapshot({ confirmedSlips: [] })
    const item = toSnapshotListItem(snapshot)
    expect(item.customerNames).toEqual([])
    expect(item.saleDateFrom).toBe('')
    expect(item.saleDateTo).toBe('')
    expect(item.slipCount).toBe(0)
  })

  it('得意先名が空文字の伝票は customerNames から除外する', () => {
    const snapshot = profitSnapshot({ confirmedSlips: [snapshotSlip({ customerName: '' })] })
    const item = toSnapshotListItem(snapshot)
    expect(item.customerNames).toEqual([])
  })
})

describe('sortSnapshotListBySavedAtDesc', () => {
  it('savedAt の新しい順に並べ替える', () => {
    const items = [
      toSnapshotListItem(profitSnapshot({ unkoNo: 'old', savedAt: '2026-07-01T00:00:00.000Z' })),
      toSnapshotListItem(profitSnapshot({ unkoNo: 'new', savedAt: '2026-07-19T00:00:00.000Z' })),
      toSnapshotListItem(profitSnapshot({ unkoNo: 'mid', savedAt: '2026-07-10T00:00:00.000Z' })),
    ]
    const sorted = sortSnapshotListBySavedAtDesc(items)
    expect(sorted.map(i => i.unkoNo)).toEqual(['new', 'mid', 'old'])
  })

  it('元の配列を破壊しない', () => {
    const items = [toSnapshotListItem(profitSnapshot({ unkoNo: 'a' })), toSnapshotListItem(profitSnapshot({ unkoNo: 'b' }))]
    const original = [...items]
    sortSnapshotListBySavedAtDesc(items)
    expect(items).toEqual(original)
  })
})
