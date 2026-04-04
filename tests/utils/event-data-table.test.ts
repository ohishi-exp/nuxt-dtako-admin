import { describe, it, expect } from 'vitest'
import {
  colIndex,
  formatTime,
  formatDuration,
  formatCell,
  columnAlignClass,
  eventColorClass,
  eventRowClass,
  toLatLng,
  getGpsForCell,
  isLocationColumn,
  groupByCrewRole,
  filterRows,
  getDisplayColumns,
} from '~/utils/event-data-table'

describe('colIndex', () => {
  it('returns index of matching header', () => {
    expect(colIndex(['A', 'B', 'C'], 'B')).toBe(1)
  })
  it('returns -1 for missing header', () => {
    expect(colIndex(['A', 'B'], 'Z')).toBe(-1)
  })
})

describe('formatTime', () => {
  it('formats date/time string', () => {
    expect(formatTime('2026/03/07 8:16:22')).toBe('03/07 8:16:22')
  })
  it('returns empty for empty string', () => {
    expect(formatTime('')).toBe('')
  })
  it('returns original if no space', () => {
    expect(formatTime('notime')).toBe('notime')
  })
  it('returns original if date has less than 3 parts', () => {
    expect(formatTime('03-07 8:16:22')).toBe('03-07 8:16:22')
  })
})

describe('formatDuration', () => {
  it('formats minutes only', () => {
    expect(formatDuration('30')).toBe('30分')
  })
  it('formats hours and minutes', () => {
    expect(formatDuration('125')).toBe('2時間5分')
  })
  it('formats exact hour (0 minutes)', () => {
    expect(formatDuration('60')).toBe('1時間0分')
  })
  it('returns empty for empty string', () => {
    expect(formatDuration('')).toBe('')
  })
  it('returns original for NaN', () => {
    expect(formatDuration('abc')).toBe('abc')
  })
})

describe('formatCell', () => {
  it('formats start datetime', () => {
    expect(formatCell('開始日時', '2026/03/07 8:00:00')).toBe('03/07 8:00:00')
  })
  it('formats end datetime', () => {
    expect(formatCell('終了日時', '2026/03/07 9:00:00')).toBe('03/07 9:00:00')
  })
  it('formats duration', () => {
    expect(formatCell('区間時間', '90')).toBe('1時間30分')
  })
  it('returns value for distance', () => {
    expect(formatCell('区間距離', '15.3')).toBe('15.3')
  })
  it('returns empty for empty distance', () => {
    expect(formatCell('区間距離', '')).toBe('')
  })
  it('returns value as-is for other headers', () => {
    expect(formatCell('イベント名', '休憩')).toBe('休憩')
  })
})

describe('columnAlignClass', () => {
  it('returns text-center for イベントCD', () => {
    expect(columnAlignClass('イベントCD')).toBe('text-center')
  })
  it('returns text-center for イベント名', () => {
    expect(columnAlignClass('イベント名')).toBe('text-center')
  })
  it('returns text-right for 区間時間', () => {
    expect(columnAlignClass('区間時間')).toBe('text-right')
  })
  it('returns text-right for 区間距離', () => {
    expect(columnAlignClass('区間距離')).toBe('text-right')
  })
  it('returns text-left for other headers', () => {
    expect(columnAlignClass('開始日時')).toBe('text-left')
  })
})

describe('eventColorClass', () => {
  const headers = ['イベント名']

  it('returns purple for 休息', () => {
    expect(eventColorClass(headers, ['休息'])).toContain('text-purple')
  })
  it('returns teal for 休憩', () => {
    expect(eventColorClass(headers, ['休憩'])).toContain('text-teal')
  })
  it('returns green for 積み', () => {
    expect(eventColorClass(headers, ['積み'])).toContain('text-green')
  })
  it('returns yellow for 降し', () => {
    expect(eventColorClass(headers, ['降し'])).toContain('text-yellow')
  })
  it('returns empty for unknown event', () => {
    expect(eventColorClass(headers, ['不明'])).toBe('')
  })
  it('returns empty when header missing', () => {
    expect(eventColorClass(['他'], ['休息'])).toBe('')
  })
  it('trims whitespace', () => {
    expect(eventColorClass(headers, [' 休息 '])).toContain('text-purple')
  })
  it('handles undefined row value', () => {
    expect(eventColorClass(headers, [])).toBe('')
  })
})

describe('eventRowClass', () => {
  const headers = ['イベント名']

  it('returns green bg for 積み', () => {
    expect(eventRowClass(headers, ['積み'])).toContain('bg-green')
  })
  it('returns yellow bg for 降し', () => {
    expect(eventRowClass(headers, ['降し'])).toContain('bg-yellow')
  })
  it('returns purple bg for 休息', () => {
    expect(eventRowClass(headers, ['休息'])).toContain('bg-purple')
  })
  it('returns empty for unmatched event', () => {
    expect(eventRowClass(headers, ['休憩'])).toBe('')
  })
  it('returns empty when header missing', () => {
    expect(eventRowClass(['他'], ['積み'])).toBe('')
  })
  it('handles undefined row value via ?? fallback', () => {
    expect(eventRowClass(['イベント名'], [])).toBe('')
  })
})

describe('toLatLng', () => {
  it('converts degree-minute format', () => {
    const result = toLatLng('32534932')
    expect(result).toBeCloseTo(32 + 53.4932 / 60, 4)
  })
  it('returns null for empty string', () => {
    expect(toLatLng('')).toBeNull()
  })
  it('returns null for 0', () => {
    expect(toLatLng('0')).toBeNull()
  })
  it('returns null for NaN', () => {
    expect(toLatLng('abc')).toBeNull()
  })
})

describe('getGpsForCell', () => {
  const headers = ['開始市町村名', '終了市町村名', '開始GPS緯度', '開始GPS経度', '開始GPS有効', '終了GPS緯度', '終了GPS経度', '終了GPS有効']

  it('returns lat/lng for start location', () => {
    const row = ['東京', '大阪', '35412345', '139412345', '1', '34412345', '135412345', '1']
    const result = getGpsForCell(headers, row, '開始市町村名')
    expect(result).not.toBeNull()
    expect(result!.lat).toBeCloseTo(35 + 41.2345 / 60, 4)
    expect(result!.lng).toBeCloseTo(139 + 41.2345 / 60, 4)
  })

  it('returns lat/lng for end location', () => {
    const row = ['東京', '大阪', '35412345', '139412345', '1', '34412345', '135412345', '1']
    const result = getGpsForCell(headers, row, '終了市町村名')
    expect(result).not.toBeNull()
    expect(result!.lat).toBeCloseTo(34 + 41.2345 / 60, 4)
  })

  it('returns null when GPS valid flag is 0', () => {
    const row = ['東京', '大阪', '35412345', '139412345', '0', '34412345', '135412345', '1']
    expect(getGpsForCell(headers, row, '開始市町村名')).toBeNull()
  })

  it('returns null when GPS columns missing', () => {
    expect(getGpsForCell(['名前'], ['東京'], '開始市町村名')).toBeNull()
  })

  it('returns null when lat is 0', () => {
    const row = ['東京', '大阪', '0', '139412345', '1', '0', '0', '1']
    expect(getGpsForCell(headers, row, '開始市町村名')).toBeNull()
  })

  it('returns null when lng is 0', () => {
    const row = ['東京', '大阪', '35412345', '0', '1', '0', '0', '1']
    expect(getGpsForCell(headers, row, '開始市町村名')).toBeNull()
  })

  it('handles undefined lat/lng row values via ?? fallback', () => {
    const h = ['開始市町村名', '開始GPS緯度', '開始GPS経度']
    const row: string[] = ['東京']  // lat and lng indices exist but row is short
    expect(getGpsForCell(h, row, '開始市町村名')).toBeNull()
  })

  it('works when GPS valid column is missing (no valid check)', () => {
    const headersNoValid = ['開始市町村名', '開始GPS緯度', '開始GPS経度']
    const row = ['東京', '35412345', '139412345']
    const result = getGpsForCell(headersNoValid, row, '開始市町村名')
    expect(result).not.toBeNull()
  })
})

describe('isLocationColumn', () => {
  it('returns true for 開始市町村名', () => {
    expect(isLocationColumn('開始市町村名')).toBe(true)
  })
  it('returns true for 終了市町村名', () => {
    expect(isLocationColumn('終了市町村名')).toBe(true)
  })
  it('returns false for other columns', () => {
    expect(isLocationColumn('イベント名')).toBe(false)
  })
})

describe('groupByCrewRole', () => {
  it('returns empty for empty data', () => {
    expect(groupByCrewRole([], [])).toEqual([])
    expect(groupByCrewRole(['A'], [])).toEqual([])
  })

  it('returns single group when no role column', () => {
    const headers = ['乗務員名１', '乗務員CD1', '事業所名', '車輌名']
    const rows = [['太郎', 'D001', '東京営業所', 'トラックA']]
    const result = groupByCrewRole(headers, rows)
    expect(result).toHaveLength(1)
    expect(result[0]!.label).toBe('乗務員')
    expect(result[0]!.driverName).toBe('太郎')
    expect(result[0]!.driverCd).toBe('D001')
    expect(result[0]!.officeName).toBe('東京営業所')
    expect(result[0]!.vehicleName).toBe('トラックA')
    expect(result[0]!.rows).toBe(rows)
  })

  it('returns single group with empty first row fallback', () => {
    const headers = ['乗務員名１']
    const rows = [['太郎']]
    const result = groupByCrewRole(headers, rows)
    expect(result[0]!.driverCd).toBe('')
    expect(result[0]!.officeName).toBe('')
    expect(result[0]!.vehicleName).toBe('')
  })

  it('handles missing column values in no-role-column mode via ?? fallback', () => {
    // All column indices are -1 except headers length > 0
    const headers = ['不要列']
    const rows = [['値']]
    const result = groupByCrewRole(headers, rows)
    expect(result[0]!.driverName).toBe('')
    expect(result[0]!.driverCd).toBe('')
    expect(result[0]!.officeName).toBe('')
    expect(result[0]!.vehicleName).toBe('')
  })

  it('groups by crew role', () => {
    const headers = ['対象乗務員区分', '乗務員名１', '乗務員CD1', '事業所名', '車輌名']
    const rows = [
      ['1', '太郎', 'D001', '東京', 'A'],
      ['2', '花子', 'D002', '大阪', 'B'],
      ['1', '太郎', 'D001', '東京', 'A'],
    ]
    const result = groupByCrewRole(headers, rows)
    expect(result).toHaveLength(2)
    expect(result[0]!.label).toBe('1番乗務員')
    expect(result[0]!.rows).toHaveLength(2)
    expect(result[1]!.label).toBe('2番乗務員')
    expect(result[1]!.rows).toHaveLength(1)
  })

  it('sorts groups by role', () => {
    const headers = ['対象乗務員区分', '乗務員名１', '乗務員CD1', '事業所名', '車輌名']
    const rows = [
      ['2', '花子', 'D002', '大阪', 'B'],
      ['1', '太郎', 'D001', '東京', 'A'],
    ]
    const result = groupByCrewRole(headers, rows)
    expect(result[0]!.crewRole).toBe('1')
    expect(result[1]!.crewRole).toBe('2')
  })

  it('defaults missing role to 1', () => {
    const headers = ['対象乗務員区分', '乗務員名１', '乗務員CD1', '事業所名', '車輌名']
    const rows: string[][] = [[undefined as unknown as string, '太郎', 'D001', '東京', 'A']]
    const result = groupByCrewRole(headers, rows)
    expect(result[0]!.crewRole).toBe('1')
  })

  it('handles undefined values in role-grouped rows via ?? fallback', () => {
    const headers = ['対象乗務員区分']
    const rows: string[][] = [['1']]  // only role column, no name/cd/office/vehicle
    const result = groupByCrewRole(headers, rows)
    expect(result[0]!.driverName).toBe('')
    expect(result[0]!.driverCd).toBe('')
    expect(result[0]!.officeName).toBe('')
    expect(result[0]!.vehicleName).toBe('')
  })
})

describe('filterRows', () => {
  it('returns all rows when eventNameIdx is -1', () => {
    const rows = [['a'], ['b']]
    expect(filterRows(rows, -1, false)).toBe(rows)
  })

  it('excludes drive events when showDrive=false', () => {
    const rows = [['休憩'], ['一般道空車'], ['積み'], ['アイドリング']]
    const result = filterRows(rows, 0, false)
    expect(result).toHaveLength(2)
    expect(result[0]![0]).toBe('休憩')
    expect(result[1]![0]).toBe('積み')
  })

  it('shows only drive events when showDrive=true', () => {
    const rows = [['休憩'], ['一般道空車'], ['積み'], ['高速道']]
    const result = filterRows(rows, 0, true)
    expect(result).toHaveLength(2)
    expect(result[0]![0]).toBe('一般道空車')
    expect(result[1]![0]).toBe('高速道')
  })

  it('handles undefined row value', () => {
    const rows: string[][] = [[undefined as unknown as string]]
    const result = filterRows(rows, 0, false)
    expect(result).toHaveLength(1)
  })

  it('trims whitespace in event name', () => {
    const rows = [[' 一般道空車 ']]
    expect(filterRows(rows, 0, true)).toHaveLength(1)
    expect(filterRows(rows, 0, false)).toHaveLength(0)
  })
})

describe('getDisplayColumns', () => {
  it('returns columns matching eventHeaders', () => {
    const headers = ['開始日時', '終了日時', '不要列', 'イベントCD', 'イベント名']
    const result = getDisplayColumns(headers)
    expect(result).toHaveLength(4)
    expect(result[0]).toEqual({ header: '開始日時', index: 0 })
    expect(result[1]).toEqual({ header: '終了日時', index: 1 })
    expect(result[2]).toEqual({ header: 'イベントCD', index: 3 })
    expect(result[3]).toEqual({ header: 'イベント名', index: 4 })
  })

  it('returns empty for no matching headers', () => {
    expect(getDisplayColumns(['不要A', '不要B'])).toEqual([])
  })
})

