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
  getDisplayColumns,
  parseEventDatetimeToTs,
  selectedRowsTimeRange,
  selectedRowsLocationRange,
  isOverspeedEventName,
  classifyEventName,
  filterRowsByCategory,
  countRowsByCategory,
  classifyTimeCategory,
  summarizeSelectedRows,
  proposeEventRowRange,
  rowIndicesInTimeRange,
  eventHeaders,
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

describe('classifyEventName', () => {
  it('走行 (一般道/専用道/高速道の実移動) を drive に分類する', () => {
    expect(classifyEventName('一般道空車')).toBe('drive')
    expect(classifyEventName('一般道実車')).toBe('drive')
    expect(classifyEventName('専用道')).toBe('drive')
    expect(classifyEventName('高速道')).toBe('drive')
  })

  it('アイドリングは走行と別の idle に分類する', () => {
    expect(classifyEventName('アイドリング')).toBe('idle')
  })

  it('「○○速度オーバー」は overspeed に分類する (走行イベントより優先)', () => {
    expect(classifyEventName('一般道速度オーバー')).toBe('overspeed')
    expect(classifyEventName('高速道速度オーバー')).toBe('overspeed')
  })

  it('それ以外は event に分類する', () => {
    expect(classifyEventName('休憩')).toBe('event')
    expect(classifyEventName('積み')).toBe('event')
    expect(classifyEventName('未知のイベント')).toBe('event')
  })

  it('前後の空白は無視する', () => {
    expect(classifyEventName(' 一般道空車 ')).toBe('drive')
  })
})

describe('filterRowsByCategory', () => {
  it('returns all rows when eventNameIdx is -1', () => {
    const rows = [['a'], ['b']]
    expect(filterRowsByCategory(rows, -1, 'event')).toBe(rows)
  })

  it('event カテゴリ: 走行・アイドリング・速度超過以外を返す', () => {
    const rows = [['休憩'], ['一般道空車'], ['積み'], ['アイドリング'], ['一般道速度オーバー']]
    const result = filterRowsByCategory(rows, 0, 'event')
    expect(result).toHaveLength(2)
    expect(result[0]![0]).toBe('休憩')
    expect(result[1]![0]).toBe('積み')
  })

  it('drive カテゴリ: 走行のみ返す (アイドリング・速度超過は含まない)', () => {
    const rows = [['休憩'], ['一般道空車'], ['積み'], ['高速道'], ['アイドリング'], ['一般道速度オーバー']]
    const result = filterRowsByCategory(rows, 0, 'drive')
    expect(result).toHaveLength(2)
    expect(result[0]![0]).toBe('一般道空車')
    expect(result[1]![0]).toBe('高速道')
  })

  it('idle カテゴリ: アイドリングのみ返す', () => {
    const rows = [['一般道空車'], ['アイドリング'], ['休憩']]
    expect(filterRowsByCategory(rows, 0, 'idle')).toEqual([['アイドリング']])
  })

  it('overspeed カテゴリ: 「○○速度オーバー」のみ返す', () => {
    const rows = [['一般道空車'], ['一般道速度オーバー'], ['高速道速度オーバー'], ['休憩']]
    expect(filterRowsByCategory(rows, 0, 'overspeed')).toEqual([['一般道速度オーバー'], ['高速道速度オーバー']])
  })

  it('handles undefined row value', () => {
    const rows: string[][] = [[undefined as unknown as string]]
    const result = filterRowsByCategory(rows, 0, 'event')
    expect(result).toHaveLength(1)
  })

  it('trims whitespace in event name', () => {
    const rows = [[' 一般道空車 ']]
    expect(filterRowsByCategory(rows, 0, 'drive')).toHaveLength(1)
    expect(filterRowsByCategory(rows, 0, 'event')).toHaveLength(0)
  })
})

describe('countRowsByCategory', () => {
  it('eventNameIdx が -1 なら 0 を返す', () => {
    expect(countRowsByCategory([['一般道空車']], -1, 'drive')).toBe(0)
  })

  it('カテゴリごとの件数を数える', () => {
    const rows = [['休憩'], ['一般道空車'], ['高速道'], ['アイドリング'], ['一般道速度オーバー'], ['高速道速度オーバー']]
    expect(countRowsByCategory(rows, 0, 'event')).toBe(1)
    expect(countRowsByCategory(rows, 0, 'drive')).toBe(2)
    expect(countRowsByCategory(rows, 0, 'idle')).toBe(1)
    expect(countRowsByCategory(rows, 0, 'overspeed')).toBe(2)
  })

  it('セル値が undefined の行は event として数える', () => {
    expect(countRowsByCategory([[]], 0, 'event')).toBe(1)
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

describe('parseEventDatetimeToTs', () => {
  it('ゼロ埋めされた日時を net780 の ts 規約 (Date.UTC、TZシフトなし) で epoch 化する', () => {
    expect(parseEventDatetimeToTs('2026/07/03 08:15:00')).toBe(Date.UTC(2026, 6, 3, 8, 15, 0) / 1000)
  })

  it('ゼロ埋めされていない時刻部分も許容する (実データ例)', () => {
    expect(parseEventDatetimeToTs('2026/03/07 8:16:22')).toBe(Date.UTC(2026, 2, 7, 8, 16, 22) / 1000)
  })

  it('空文字列は null を返す', () => {
    expect(parseEventDatetimeToTs('')).toBeNull()
  })

  it('区切りが不正な文字列は null を返す', () => {
    expect(parseEventDatetimeToTs('2026-07-03 08:15:00')).toBeNull()
  })

  it('前後の空白は許容する', () => {
    expect(parseEventDatetimeToTs(' 2026/07/03 08:15:00 ')).toBe(Date.UTC(2026, 6, 3, 8, 15, 0) / 1000)
  })
})

describe('selectedRowsTimeRange', () => {
  const headers = ['開始日時', '終了日時', 'イベント名']
  const rows = [
    ['2026/07/03 08:00:00', '2026/07/03 08:10:00', 'A'],
    ['2026/07/03 09:00:00', '2026/07/03 09:30:00', 'B'],
    ['2026/07/03 07:00:00', '2026/07/03 07:05:00', 'C'],
  ]

  it('選択行の開始日時の最小・終了日時の最大を返す', () => {
    const range = selectedRowsTimeRange(headers, rows, [0, 1])
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/03 08:00:00'),
      toTs: parseEventDatetimeToTs('2026/07/03 09:30:00'),
    })
  })

  it('3行選択すると全体の最小〜最大になる', () => {
    const range = selectedRowsTimeRange(headers, rows, [0, 1, 2])
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/03 07:00:00'),
      toTs: parseEventDatetimeToTs('2026/07/03 09:30:00'),
    })
  })

  it('選択が空なら null を返す', () => {
    expect(selectedRowsTimeRange(headers, rows, [])).toBeNull()
  })

  it('開始日時/終了日時列が無ければ null を返す', () => {
    expect(selectedRowsTimeRange(['イベント名'], [['A']], [0])).toBeNull()
  })

  it('存在しない index はスキップする', () => {
    const range = selectedRowsTimeRange(headers, rows, [0, 99])
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/03 08:00:00'),
      toTs: parseEventDatetimeToTs('2026/07/03 08:10:00'),
    })
  })

  it('パース失敗行のみ選択されている場合は null を返す', () => {
    const badRows = [['invalid', 'invalid', 'A']]
    expect(selectedRowsTimeRange(headers, badRows, [0])).toBeNull()
  })

  it('パース失敗行と正常行が混在する場合は正常行だけで算出する', () => {
    const mixedRows = [
      ['invalid', 'invalid', 'A'],
      ['2026/07/03 08:00:00', '2026/07/03 08:10:00', 'B'],
    ]
    const range = selectedRowsTimeRange(headers, mixedRows, [0, 1])
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/03 08:00:00'),
      toTs: parseEventDatetimeToTs('2026/07/03 08:10:00'),
    })
  })

  it('開始日時列が欠けている行 (undefined セル) はフォールバックしつつスキップされる', () => {
    // ヘッダー数より短い行 → row[startIdx]/row[endIdx] が undefined → `?? ''` フォールバック
    const shortRows = [[], ['2026/07/03 08:00:00', '2026/07/03 08:10:00', 'B']]
    const range = selectedRowsTimeRange(headers, shortRows, [0, 1])
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/03 08:00:00'),
      toTs: parseEventDatetimeToTs('2026/07/03 08:10:00'),
    })
  })

  it('終了日時だけパース成功する行では fromTs が null のまま toTs を採用する', () => {
    const endOnlyRows = [['invalid', '2026/07/03 08:10:00', 'B']]
    const range = selectedRowsTimeRange(headers, endOnlyRows, [0])
    const toTs = parseEventDatetimeToTs('2026/07/03 08:10:00')
    expect(range).toEqual({ fromTs: toTs, toTs })
  })

  it('開始日時だけパース成功する行では toTs が null のまま fromTs を採用する', () => {
    const startOnlyRows = [['2026/07/03 08:00:00', 'invalid', 'B']]
    const range = selectedRowsTimeRange(headers, startOnlyRows, [0])
    const fromTs = parseEventDatetimeToTs('2026/07/03 08:00:00')
    expect(range).toEqual({ fromTs, toTs: fromTs })
  })

  it('終了日時が開始日時より前 (異常データ) の場合は fromTs/toTs を入れ替えて正規化する', () => {
    const invertedRows = [['2026/07/03 09:00:00', '2026/07/03 08:00:00', 'B']]
    const range = selectedRowsTimeRange(headers, invertedRows, [0])
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/03 08:00:00'),
      toTs: parseEventDatetimeToTs('2026/07/03 09:00:00'),
    })
  })
})

describe('selectedRowsLocationRange', () => {
  const headers = ['開始日時', '終了日時', 'イベント名', '開始市町村名', '終了市町村名']
  const rows = [
    ['2026/07/03 08:00:00', '2026/07/03 08:10:00', 'A', '長崎市', '諫早市'],
    ['2026/07/03 09:00:00', '2026/07/03 09:30:00', 'B', '諫早市', '福岡市'],
    ['2026/07/03 07:00:00', '2026/07/03 07:05:00', 'C', '佐世保市', '長崎市'],
  ]

  it('最も早い開始日時の行の開始市町村名・最も遅い終了日時の行の終了市町村名を返す', () => {
    const result = selectedRowsLocationRange(headers, rows, [0, 1, 2])
    // 最小開始 = index2 (07:00 佐世保市→長崎市)、最大終了 = index1 (09:30 諫早市→福岡市)
    expect(result).toEqual({ originCity: '佐世保市', destCity: '福岡市' })
  })

  it('1行だけ選択した場合はその行の開始・終了市町村名になる', () => {
    expect(selectedRowsLocationRange(headers, rows, [0])).toEqual({ originCity: '長崎市', destCity: '諫早市' })
  })

  it('選択が空なら null を返す', () => {
    expect(selectedRowsLocationRange(headers, rows, [])).toBeNull()
  })

  it('開始日時/終了日時列が無ければ null を返す', () => {
    expect(selectedRowsLocationRange(['イベント名'], [['A']], [0])).toBeNull()
  })

  it('市町村名列が無ければ空文字を返す (日時列はあるので range 自体は算出される)', () => {
    const headersNoCity = ['開始日時', '終了日時', 'イベント名']
    const rowsNoCity = [['2026/07/03 08:00:00', '2026/07/03 08:10:00', 'A']]
    expect(selectedRowsLocationRange(headersNoCity, rowsNoCity, [0])).toEqual({ originCity: '', destCity: '' })
  })

  it('市町村名セルが undefined (行が短い) 場合は空文字にフォールバックする', () => {
    const shortRow = ['2026/07/03 08:00:00', '2026/07/03 08:10:00']
    expect(selectedRowsLocationRange(headers, [shortRow], [0])).toEqual({ originCity: '', destCity: '' })
  })

  it('開始日時/終了日時セル自体が undefined (行が空) の場合も ?? \'\' フォールバックしパース失敗として扱う', () => {
    expect(selectedRowsLocationRange(headers, [[]], [0])).toBeNull()
  })

  it('パース失敗行のみ選択されている場合は null を返す', () => {
    const badRows = [['invalid', 'invalid', 'A', '長崎市', '諫早市']]
    expect(selectedRowsLocationRange(headers, badRows, [0])).toBeNull()
  })

  it('存在しない index はスキップする', () => {
    const result = selectedRowsLocationRange(headers, rows, [0, 99])
    expect(result).toEqual({ originCity: '長崎市', destCity: '諫早市' })
  })
})

describe('isOverspeedEventName', () => {
  it('道路種別+「速度オーバー」の実データ名を検出する', () => {
    expect(isOverspeedEventName('一般道速度オーバー')).toBe(true)
    expect(isOverspeedEventName('専用道速度オーバー')).toBe(true)
    expect(isOverspeedEventName('高速道速度オーバー')).toBe(true)
  })

  it('前後の空白は無視する', () => {
    expect(isOverspeedEventName(' 一般道速度オーバー ')).toBe(true)
  })

  it('接尾辞として一致しない (前方一致のみ等) 場合は false', () => {
    expect(isOverspeedEventName('速度オーバー注意')).toBe(false)
    expect(isOverspeedEventName('一般道空車')).toBe(false)
    expect(isOverspeedEventName('')).toBe(false)
  })
})

describe('classifyTimeCategory', () => {
  it('走行系イベント名は drive に分類する', () => {
    expect(classifyTimeCategory('一般道空車')).toBe('drive')
    expect(classifyTimeCategory('一般道実車')).toBe('drive')
    expect(classifyTimeCategory('専用道')).toBe('drive')
    expect(classifyTimeCategory('高速道')).toBe('drive')
  })
  it('積みは loading に分類する', () => {
    expect(classifyTimeCategory('積み')).toBe('loading')
  })
  it('降しは unloading に分類する', () => {
    expect(classifyTimeCategory('降し')).toBe('unloading')
  })
  it('休憩・休息はどちらも rest に分類する', () => {
    expect(classifyTimeCategory('休憩')).toBe('rest')
    expect(classifyTimeCategory('休息')).toBe('rest')
  })
  it('アイドリングは idle に分類する', () => {
    expect(classifyTimeCategory('アイドリング')).toBe('idle')
  })
  it('上記以外は other に分類する', () => {
    expect(classifyTimeCategory('一般道速度オーバー')).toBe('other')
    expect(classifyTimeCategory('未知イベント')).toBe('other')
  })
  it('前後の空白は無視する', () => {
    expect(classifyTimeCategory(' 積み ')).toBe('loading')
  })
})

describe('summarizeSelectedRows', () => {
  const headers = ['開始日時', '終了日時', 'イベント名', '区間時間', '区間距離']

  function row(name: string, durationMin: string, distanceKm: string): string[] {
    return ['2026/07/03 08:00:00', '2026/07/03 08:30:00', name, durationMin, distanceKm]
  }

  it('区間距離・区間時間を合算する', () => {
    const rows = [row('一般道実車', '30', '12.5'), row('積み', '10', '0')]
    const result = summarizeSelectedRows(headers, rows, [0, 1])
    expect(result.distanceKm).toBeCloseTo(12.5)
    expect(result.durationMin).toBe(40)
    expect(result.rowCount).toBe(2)
  })

  it('区分別の時間内訳を集計する (運転/積み/降し/休憩・休息/アイドリング)', () => {
    const rows = [
      row('一般道実車', '20', '5'),
      row('積み', '10', '0'),
      row('降し', '15', '0'),
      row('休憩', '30', '0'),
      row('休息', '480', '0'),
      row('アイドリング', '5', '0'),
    ]
    const result = summarizeSelectedRows(headers, rows, [0, 1, 2, 3, 4, 5])
    expect(result.byCategory).toEqual({
      drive: 20,
      loading: 10,
      unloading: 15,
      rest: 510,
      idle: 5,
      other: 0,
    })
  })

  it('区間距離が空文字/不正な行はスキップして距離に加算しない (時間は加算する)', () => {
    const rows = [row('休憩', '30', ''), row('積み', '10', 'N/A')]
    const result = summarizeSelectedRows(headers, rows, [0, 1])
    expect(result.distanceKm).toBe(0)
    expect(result.durationMin).toBe(40)
  })

  it('区間時間が空文字/不正な行は時間・時間内訳に加算しない (距離は加算する)', () => {
    const rows = [row('一般道実車', '', '5.5'), row('積み', 'abc', '1')]
    const result = summarizeSelectedRows(headers, rows, [0, 1])
    expect(result.durationMin).toBe(0)
    expect(result.byCategory.drive).toBe(0)
    expect(result.distanceKm).toBeCloseTo(6.5)
  })

  it('存在しない index はスキップし rowCount に含めない', () => {
    const rows = [row('積み', '10', '1')]
    const result = summarizeSelectedRows(headers, rows, [0, 5])
    expect(result.rowCount).toBe(1)
  })

  it('選択が空なら全て 0 を返す', () => {
    const result = summarizeSelectedRows(headers, [row('積み', '10', '1')], [])
    expect(result).toEqual({
      distanceKm: 0,
      durationMin: 0,
      byCategory: { drive: 0, loading: 0, unloading: 0, rest: 0, idle: 0, other: 0 },
      rowCount: 0,
    })
  })

  it('区間距離/区間時間の列が無いヘッダーでは加算せず rowCount のみ数える', () => {
    const headersNoCols = ['開始日時', '終了日時', 'イベント名']
    const rows = [['2026/07/03 08:00:00', '2026/07/03 08:30:00', '積み']]
    const result = summarizeSelectedRows(headersNoCols, rows, [0])
    expect(result.distanceKm).toBe(0)
    expect(result.durationMin).toBe(0)
    expect(result.rowCount).toBe(1)
  })

  it('イベント名列が無いヘッダーでも区間時間は other として集計する', () => {
    const headersNoName = ['開始日時', '終了日時', '区間時間', '区間距離']
    const rows = [['2026/07/03 08:00:00', '2026/07/03 08:30:00', '30', '5']]
    const result = summarizeSelectedRows(headersNoName, rows, [0])
    expect(result.durationMin).toBe(30)
    expect(result.byCategory.other).toBe(30)
  })

  it('区間時間セルが undefined (行が短い) の場合は距離だけ加算する (?? \'\' フォールバック)', () => {
    const rowWithHoleAtDuration: string[] = ['2026/07/03 08:00:00', '2026/07/03 08:30:00', '積み', undefined as unknown as string, '5']
    const result = summarizeSelectedRows(headers, [rowWithHoleAtDuration], [0])
    expect(result.durationMin).toBe(0)
    expect(result.distanceKm).toBe(5)
  })

  it('イベント名セルが undefined でも (区間時間は有効) other として集計する (?? \'\' フォールバック)', () => {
    // headers 上は「イベント名」列があるが、そのセルだけ undefined な行 (欠損データ想定)。
    // 区間時間セル (index 3) は有効なので durationMin には加算される。
    const rowWithHoleAtName: string[] = ['2026/07/03 08:00:00', '2026/07/03 08:30:00', undefined as unknown as string, '15']
    const result = summarizeSelectedRows(headers, [rowWithHoleAtName], [0])
    expect(result.durationMin).toBe(15)
    expect(result.byCategory.other).toBe(15)
  })
})

describe('proposeEventRowRange', () => {
  function row(start: string, end: string, name: string, startCity: string, endCity: string): string[] {
    return [start, end, '999', name, '30', '5', startCity, endCity]
  }

  const rows = [
    row('2026/07/01 08:45:20', '2026/07/01 09:20:49', '運転', '北海道河東郡上士幌町', '北海道河東郡上士幌町'),
    row('2026/07/01 09:20:49', '2026/07/01 11:02:54', '運転', '北海道河東郡上士幌町', '北海道釧路市西港2'),
    row('2026/07/01 11:02:54', '2026/07/01 11:38:18', '積み', '北海道釧路市西港2', '北海道釧路市西港2'),
    row('2026/07/01 11:38:18', '2026/07/01 12:46:17', '運転', '北海道釧路市西港1', '北海道川上郡標茶町多和'),
    row('2026/07/01 12:46:17', '2026/07/01 13:32:53', '降し', '北海道川上郡標茶町多和', '北海道川上郡標茶町多和'),
  ]

  it('積み(開始市町村名が一致)〜降し(終了市町村名が一致)の時刻レンジを返す', () => {
    const range = proposeEventRowRange(eventHeaders, rows, '釧路市西港', '標茶町多和')
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/01 11:02:54'),
      toTs: parseEventDatetimeToTs('2026/07/01 13:32:53'),
    })
  })

  it('一致する積みが無ければ null', () => {
    expect(proposeEventRowRange(eventHeaders, rows, '存在しない地名', '標茶町多和')).toBeNull()
  })

  it('積みは一致するが後続に一致する降しが無ければ null', () => {
    expect(proposeEventRowRange(eventHeaders, rows, '釧路市西港', '存在しない地名')).toBeNull()
  })

  it('積地・卸地のどちらかが空文字なら null (判定不能)', () => {
    expect(proposeEventRowRange(eventHeaders, rows, '', '標茶町多和')).toBeNull()
    expect(proposeEventRowRange(eventHeaders, rows, '釧路市西港', '')).toBeNull()
  })

  it('必要な列 (開始市町村名/終了市町村名等) が無いヘッダーでは null', () => {
    const headersNoCity = ['開始日時', '終了日時', 'イベントCD', 'イベント名', '区間時間', '区間距離']
    expect(proposeEventRowRange(headersNoCity, rows, '釧路市西港', '標茶町多和')).toBeNull()
  })

  it('日時がパースできない行がヒットしても null (積み側)', () => {
    const badRows = [row('invalid', '2026/07/01 11:38:18', '積み', '釧路市西港', '釧路市西港')]
    expect(proposeEventRowRange(eventHeaders, badRows, '釧路市西港', '釧路市西港')).toBeNull()
  })

  it('積みは正常だが降しの終了日時がパースできなければ null', () => {
    const badRows = [
      row('2026/07/01 11:02:54', '2026/07/01 11:38:18', '積み', '釧路市西港', '釧路市西港'),
      row('2026/07/01 11:38:18', 'invalid', '降し', '釧路市西港', '釧路市西港'),
    ]
    expect(proposeEventRowRange(eventHeaders, badRows, '釧路市西港', '釧路市西港')).toBeNull()
  })

  it('積み探索中にイベント名/開始市町村名列が無い (行が短い) 行があってもスキップして継続する (?? \'\' フォールバック)', () => {
    // イベント名列 (index 3) すら無い行 → line 438 の `?? ''` を経由して 'other' 扱いになりスキップ
    const holeMissingName = ['2026/07/01 10:00:00', '2026/07/01 10:10:00', '999']
    // イベント名はあるが開始市町村名列 (index 6) が無い行 → line 439 の `?? ''` を経由してスキップ
    const holeMissingStartCity = ['2026/07/01 10:10:00', '2026/07/01 10:20:00', '999', '積み']
    const range = proposeEventRowRange(eventHeaders, [holeMissingName, holeMissingStartCity, ...rows], '釧路市西港', '標茶町多和')
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/01 11:02:54'),
      toTs: parseEventDatetimeToTs('2026/07/01 13:32:53'),
    })
  })

  it('降し探索中にイベント名/終了市町村名列が無い行があってもスキップして継続する (?? \'\' フォールバック)', () => {
    const loadRow = row('2026/07/01 11:02:54', '2026/07/01 11:38:18', '積み', '北海道釧路市西港2', '北海道釧路市西港2')
    const holeMissingName = ['2026/07/01 11:38:18', '2026/07/01 12:00:00', '999']
    const holeMissingEndCity = ['2026/07/01 12:00:00', '2026/07/01 12:30:00', '999', '降し']
    const unloadRow = row('2026/07/01 12:30:00', '2026/07/01 13:00:00', '降し', '北海道川上郡標茶町多和', '北海道川上郡標茶町多和')
    const range = proposeEventRowRange(
      eventHeaders,
      [loadRow, holeMissingName, holeMissingEndCity, unloadRow],
      '釧路市西港',
      '標茶町多和',
    )
    expect(range).toEqual({
      fromTs: parseEventDatetimeToTs('2026/07/01 11:02:54'),
      toTs: parseEventDatetimeToTs('2026/07/01 13:00:00'),
    })
  })

  it('マッチした積み行の開始日時セルが undefined でも安全に処理し null を返す (?? \'\' フォールバック)', () => {
    const loadRowNoDate: string[] = [undefined as unknown as string, '2026/07/01 11:38:18', '999', '積み', '30', '5', '北海道釧路市西港2', '北海道釧路市西港2']
    const unloadRow = row('2026/07/01 11:38:18', '2026/07/01 12:46:17', '降し', '北海道川上郡標茶町多和', '北海道川上郡標茶町多和')
    expect(proposeEventRowRange(eventHeaders, [loadRowNoDate, unloadRow], '釧路市西港', '標茶町多和')).toBeNull()
  })

  it('マッチした降し行の終了日時セルが undefined でも安全に処理し null を返す (?? \'\' フォールバック)', () => {
    const loadRow = row('2026/07/01 11:02:54', '2026/07/01 11:38:18', '積み', '北海道釧路市西港2', '北海道釧路市西港2')
    const unloadRowNoDate: string[] = ['2026/07/01 11:38:18', undefined as unknown as string, '999', '降し', '30', '5', '北海道川上郡標茶町多和', '北海道川上郡標茶町多和']
    expect(proposeEventRowRange(eventHeaders, [loadRow, unloadRowNoDate], '釧路市西港', '標茶町多和')).toBeNull()
  })
})

describe('rowIndicesInTimeRange', () => {
  const headers = ['開始日時', '終了日時']
  const rows = [
    ['2026/07/01 08:00:00', '2026/07/01 08:30:00'],
    ['2026/07/01 09:00:00', '2026/07/01 09:30:00'],
    ['2026/07/01 10:00:00', '2026/07/01 10:30:00'],
  ]

  it('開始日時が範囲内 (両端含む)、かつ終了日時も範囲内の行の index を返す', () => {
    const from = parseEventDatetimeToTs('2026/07/01 09:00:00')!
    const to = parseEventDatetimeToTs('2026/07/01 10:30:00')!
    expect(rowIndicesInTimeRange(headers, rows, from, to)).toEqual([1, 2])
  })

  it('開始日時は範囲内でも終了日時が toTs を超える行は除外する (提案区間直後の復路等が丸ごと積算されるのを防ぐ、実運用回帰)', () => {
    const from = parseEventDatetimeToTs('2026/07/01 09:00:00')!
    const to = parseEventDatetimeToTs('2026/07/01 10:00:00')!
    expect(rowIndicesInTimeRange(headers, rows, from, to)).toEqual([1])
  })

  it('終了日時列が無いヘッダーでは開始日時のみで判定する (フォールバック)', () => {
    const startOnlyHeaders = ['開始日時']
    const startOnlyRows = [['2026/07/01 09:00:00'], ['2026/07/01 10:00:00']]
    const from = parseEventDatetimeToTs('2026/07/01 09:00:00')!
    const to = parseEventDatetimeToTs('2026/07/01 10:00:00')!
    expect(rowIndicesInTimeRange(startOnlyHeaders, startOnlyRows, from, to)).toEqual([0, 1])
  })

  it('範囲より前の行は含めない', () => {
    const from = parseEventDatetimeToTs('2026/07/01 09:00:00')!
    const to = parseEventDatetimeToTs('2026/07/01 09:30:00')!
    expect(rowIndicesInTimeRange(headers, rows, from, to)).toEqual([1])
  })

  it('範囲より後の行は含めない', () => {
    const from = parseEventDatetimeToTs('2026/07/01 08:00:00')!
    const to = parseEventDatetimeToTs('2026/07/01 09:30:00')!
    expect(rowIndicesInTimeRange(headers, rows, from, to)).toEqual([0, 1])
  })

  it('開始日時列が無いヘッダーでは空配列', () => {
    expect(rowIndicesInTimeRange(['終了日時'], rows, 0, 9999999999)).toEqual([])
  })

  it('日時がパースできない行はスキップする', () => {
    const badRows = [['invalid', '2026/07/01 08:30:00']]
    expect(rowIndicesInTimeRange(headers, badRows, 0, 9999999999)).toEqual([])
  })

  it('開始日時セルが undefined (行が短い) 行はスキップする (?? \'\' フォールバック)', () => {
    const shortRow: string[] = []
    expect(rowIndicesInTimeRange(headers, [shortRow], 0, 9999999999)).toEqual([])
  })
})

