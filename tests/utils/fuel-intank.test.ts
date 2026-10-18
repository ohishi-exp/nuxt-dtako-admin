import { describe, it, expect } from 'vitest'
import type { FuelIntankRow } from '~/types'
import {
  startLabel,
  formatShortDatetime,
  formatQuantity,
  parseFuelArrayEntry,
  dtakoRowOptions,
  quantityDiff,
  isDiffHighlighted,
  totalQuantity,
  uploadResultText,
  sha256FromKey,
  describeCsvError,
} from '~/utils/fuel-intank'

function row(over: Partial<FuelIntankRow> = {}): FuelIntankRow {
  return {
    datetime: '2023-12-20 08:10:00',
    fuel_card_id: 12,
    slip_num: 101,
    slip_num_parent: 100,
    quantity: 12345,
    qt: 123.45,
    type: 'fuel',
    detail: null,
    dtako_row_id: null,
    manual: false,
    id_st: '2023-12-20 08:10:00;12',
    ...over,
  }
}

describe('startLabel', () => {
  it('slip_num と yyMMdd_HHmmss (CakePHP の srch_data_list と同じ形)', () => {
    expect(startLabel({ datetime: '2023-12-20 07:33:05', fuel_card_id: 9999, slip_num: 100 })).toBe('100 231220_073305')
  })
  it('読めない日時は原文のまま', () => {
    expect(startLabel({ datetime: '2023/12/20', fuel_card_id: 9999, slip_num: 7 })).toBe('7 2023/12/20')
  })
})

describe('formatShortDatetime', () => {
  it('yy/MM/dd HH:mm', () => {
    expect(formatShortDatetime('2023-12-20 07:33:05')).toBe('23/12/20 07:33')
  })
  it('null・空は空、読めない形は原文', () => {
    expect(formatShortDatetime(null)).toBe('')
    expect(formatShortDatetime(undefined)).toBe('')
    expect(formatShortDatetime('')).toBe('')
    expect(formatShortDatetime('x')).toBe('x')
  })
})

describe('formatQuantity', () => {
  it('小数 2 桁・3 桁ごとに ,', () => {
    expect(formatQuantity(1234.5)).toBe('1,234.50')
    expect(formatQuantity(0)).toBe('0.00')
    expect(formatQuantity(-3.456)).toBe('-3.46')
  })
  it('★ 2 桁で 0 になる負の値に - を付けない', () => {
    expect(formatQuantity(-0.001)).toBe('0.00')
    expect(formatQuantity(-0)).toBe('0.00')
  })
})

describe('parseFuelArrayEntry', () => {
  it('yyyyMMddHHmm_数量 を日時と数量に分ける (, を外す)', () => {
    expect(parseFuelArrayEntry('202312200810_1,234.50')).toEqual({ datetime: '2023/12/20 08:10', quantity: 1234.5 })
  })
  it('Rust 側の 3 桁表示と整数も読む', () => {
    expect(parseFuelArrayEntry('202312200810_12.345')).toEqual({ datetime: '2023/12/20 08:10', quantity: 12.345 })
    expect(parseFuelArrayEntry('202312200810_80')).toEqual({ datetime: '2023/12/20 08:10', quantity: 80 })
  })
  it('形が違えば null', () => {
    expect(parseFuelArrayEntry('20231220_1.00')).toBeNull()
    expect(parseFuelArrayEntry('202312200810-1.00')).toBeNull()
    expect(parseFuelArrayEntry('202312200810_abc')).toBeNull()
  })
})

describe('dtakoRowOptions', () => {
  it('運行ごとの給油を 1 件ずつ選択肢にする (同じ運行の給油は同じ value)', () => {
    expect(dtakoRowOptions({
      '2312200733': ['202312200810_120.00', '202312201530_40.5'],
      '': ['202312201200_10.00'],
    })).toEqual([
      { value: '2312200733', label: '2023/12/20 08:10 120.00 (2312200733)' },
      { value: '2312200733', label: '2023/12/20 15:30 40.50 (2312200733)' },
      { value: '', label: '2023/12/20 12:00 10.00 (運行なし)' },
    ])
  })
  it('読めない項目は原文を出す', () => {
    expect(dtakoRowOptions({ 9: ['??'] })).toEqual([{ value: '9', label: '?? (9)' }])
  })
  it('null・undefined は空', () => {
    expect(dtakoRowOptions(null)).toEqual([])
    expect(dtakoRowOptions(undefined)).toEqual([])
  })
  it('★ いまの値が選択肢に無ければ先頭に足す (無いと別の項目を選んだ見た目になる)', () => {
    expect(dtakoRowOptions({ 1: ['202312200810_1.00'] }, '77')).toEqual([
      { value: '77', label: '77 (いまの値・当日の給油に無し)' },
      { value: '1', label: '2023/12/20 08:10 1.00 (1)' },
    ])
    expect(dtakoRowOptions(null, '77')).toEqual([{ value: '77', label: '77 (いまの値・当日の給油に無し)' }])
  })
  it('いまの値が選択肢に在る・null なら足さない', () => {
    expect(dtakoRowOptions({ 1: ['202312200810_1.00'] }, '1')).toHaveLength(1)
    expect(dtakoRowOptions({ 1: ['202312200810_1.00'] }, null)).toHaveLength(1)
  })
})

describe('quantityDiff / isDiffHighlighted', () => {
  it('数量 − dtako 合計 を小数 2 桁に丸める (浮動小数の尾で 0 が崩れない)', () => {
    expect(quantityDiff(row({ qt: 0.3, dtako_fuel_sum: 0.1 + 0.2 }))).toBe(0)
    expect(quantityDiff(row({ qt: 123.45, dtako_fuel_sum: 120 }))).toBe(3.45)
    expect(quantityDiff(row({ qt: null, dtako_fuel_sum: 5 }))).toBe(-5)
  })
  it('dtako 合計が無ければ null', () => {
    expect(quantityDiff(row({ dtako_fuel_sum: null }))).toBeNull()
    expect(quantityDiff(row())).toBeNull()
  })
  it('差異が 0 でなければ強調、0 なら強調しない', () => {
    expect(isDiffHighlighted(row({ qt: 10, dtako_fuel_sum: 10 }))).toBe(false)
    expect(isDiffHighlighted(row({ qt: 10, dtako_fuel_sum: 9.99 }))).toBe(true)
  })
  it('dtako 合計が無い行は数量が 0 でない限り強調 (CakePHP の Qt - null と同じ)', () => {
    expect(isDiffHighlighted(row({ qt: 10, dtako_fuel_sum: null }))).toBe(true)
    expect(isDiffHighlighted(row({ qt: 0, dtako_fuel_sum: null }))).toBe(false)
    expect(isDiffHighlighted(row({ qt: null, dtako_fuel_sum: null }))).toBe(false)
  })
})

describe('totalQuantity', () => {
  it('数量の合計 (null は 0)、小数 2 桁に丸める', () => {
    expect(totalQuantity([row({ qt: 0.1 }), row({ qt: 0.2 }), row({ qt: null })])).toBe(0.3)
    expect(totalQuantity([])).toBe(0)
  })
})

describe('uploadResultText', () => {
  it('追加 N 件 / 既存 M 件', () => {
    expect(uploadResultText({ inserted: 3, skipped: 0 })).toBe('追加 3 件 / 既存 0 件')
  })
})

describe('sha256FromKey', () => {
  const sha = '0123456789abcdef'.repeat(4)
  it('utran/<sha256>.csv から sha256 を取る', () => {
    expect(sha256FromKey(`utran/${sha}.csv`)).toBe(sha)
  })
  it('形が違えば null', () => {
    expect(sha256FromKey(`other/${sha}.csv`)).toBeNull()
    expect(sha256FromKey('utran/abc.csv')).toBeNull()
    expect(sha256FromKey(`utran/${sha.toUpperCase()}.csv`)).toBeNull()
  })
})

describe('describeCsvError', () => {
  it('400 の CSV の誤りは何行目の何が悪いかを言う', () => {
    expect(describeCsvError('API エラー (400): {"ok":false,"error":"csv","line":3,"reason":"列が足りません"}'))
      .toBe('CSV の 3 行目が読めません: 列が足りません')
  })
  it('line・reason が無ければ不明と言う', () => {
    expect(describeCsvError('API エラー (400): {"error":"csv"}')).toBe('CSV の 行不明が読めません: 理由不明')
  })
  it('CSV の誤りでなければ null (呼び手が汎用の文にする)', () => {
    expect(describeCsvError('API エラー (400): {"error":"empty_body"}')).toBeNull()
    expect(describeCsvError('API エラー (503): {"ok":false,"stage":"r2"}')).toBeNull()
    expect(describeCsvError('API エラー (400): {壊れた')).toBeNull()
    expect(describeCsvError('API エラー (400): {"error":csv}')).toBeNull()
    expect(describeCsvError('Failed to fetch')).toBeNull()
  })
})
