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
  dailyReportEditQuery,
  normalizeVehicleCd,
  dvrMapQuery,
  totalQuantity,
  uploadResultText,
  sha256FromKey,
  describeCsvError,
  createRowsCache,
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
  it('times にある運行は出庫・帰庫を並べ、無い運行といまの値の行は今の形のまま', () => {
    const times = { 2312200733: { departed_at: '2023-12-19 07:33:00', returned_at: '2023-12-21 18:05:00' } }
    expect(dtakoRowOptions({
      9: ['202312201200_10.00'],
      2312200733: ['202312200810_120.00'],
    }, '77', times)).toEqual([
      { value: '77', label: '77 (いまの値・当日の給油に無し)' },
      { value: '9', label: '2023/12/20 12:00 10.00 (9)' },
      { value: '2312200733', label: '給油 2023/12/20 08:10 120.00 ｜ 出庫 23/12/19 07:33 〜 帰庫 23/12/21 18:05 ｜ 2312200733' },
    ])
  })
  it('times が null・undefined なら今の形のまま', () => {
    const plain = [{ value: '1', label: '2023/12/20 08:10 1.00 (1)' }]
    expect(dtakoRowOptions({ 1: ['202312200810_1.00'] }, null, null)).toEqual(plain)
    expect(dtakoRowOptions({ 1: ['202312200810_1.00'] }, null, undefined)).toEqual(plain)
  })
  it('出庫・帰庫の片方が null ならその側は「—」', () => {
    expect(dtakoRowOptions({ 1: ['202312200810_1.00'] }, null, { 1: { departed_at: '2023-12-19 07:33:00', returned_at: null } }))
      .toEqual([{ value: '1', label: '給油 2023/12/20 08:10 1.00 ｜ 出庫 23/12/19 07:33 〜 帰庫 — ｜ 1' }])
    expect(dtakoRowOptions({ 1: ['202312200810_1.00'] }, null, { 1: { departed_at: null, returned_at: '2023-12-21 18:05:00' } }))
      .toEqual([{ value: '1', label: '給油 2023/12/20 08:10 1.00 ｜ 出庫 — 〜 帰庫 23/12/21 18:05 ｜ 1' }])
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
  it('dtako 合計が無い (集計なし) 行は数量が 0 でも強調 (ユーザーの依頼で集計なしは常に強調。CakePHP とは意図して変えた)', () => {
    expect(isDiffHighlighted(row({ qt: 10, dtako_fuel_sum: null }))).toBe(true)
    expect(isDiffHighlighted(row({ qt: 0, dtako_fuel_sum: null }))).toBe(true)
    expect(isDiffHighlighted(row({ qt: null, dtako_fuel_sum: null }))).toBe(true)
    expect(isDiffHighlighted(row())).toBe(true)
  })
})

describe('dailyReportEditQuery', () => {
  const dtako = (over: Partial<NonNullable<FuelIntankRow['dtako_row']>> = {}) => ({
    id: '1', car_cc: null, car_name: null, driver_id: 7, driver_name: '山田 太郎',
    departed_at: '2023-12-31 22:00:00', returned_at: '2024-01-01 06:00:00', ...over,
  })
  it('出庫・帰庫が在れば 出庫日 00:00 〜 帰庫日の翌日 23:59 (月・年をまたぐ)', () => {
    expect(dailyReportEditQuery(row({ dtako_row: dtako() }))).toEqual({
      from: '2023-12-31T00:00', to: '2024-01-02T23:59', driver: '山田 太郎',
    })
  })
  it('出庫・帰庫が無ければ給油日の前日 00:00 〜 翌日 23:59', () => {
    expect(dailyReportEditQuery(row({ datetime: '2024-03-01 08:10:00' }))).toEqual({
      from: '2024-02-29T00:00', to: '2024-03-02T23:59',
    })
    expect(dailyReportEditQuery(row({ dtako_row: dtako({ departed_at: null, returned_at: null, driver_name: null }) })))
      .toEqual({ from: '2023-12-19T00:00', to: '2023-12-21T23:59' })
  })
  it('片方だけ在ればもう片方にも同じ日を使う', () => {
    expect(dailyReportEditQuery(row({ dtako_row: dtako({ returned_at: null }) }))).toMatchObject({
      from: '2023-12-31T00:00', to: '2024-01-01T23:59',
    })
    expect(dailyReportEditQuery(row({ dtako_row: dtako({ departed_at: null }) }))).toMatchObject({
      from: '2024-01-01T00:00', to: '2024-01-02T23:59',
    })
  })
  it('乗務員名が無い・空白だけなら driver を付けない', () => {
    expect(dailyReportEditQuery(row({ dtako_row: dtako({ driver_name: null }) }))).not.toHaveProperty('driver')
    expect(dailyReportEditQuery(row({ dtako_row: dtako({ driver_name: '  ' }) }))).not.toHaveProperty('driver')
  })
  it('車輌CD があれば先頭ゼロを落として vehicleCd に付ける', () => {
    expect(dailyReportEditQuery(row({ dtako_row: dtako(), car: { id: '5', name: '1号車', vehicle_cd: '0000002158' } }))).toEqual({
      from: '2023-12-31T00:00', to: '2024-01-02T23:59', driver: '山田 太郎', vehicleCd: '2158',
    })
  })
  it('車輌CD が無い・読めない・9 桁以上なら vehicleCd を付けない', () => {
    expect(dailyReportEditQuery(row({ car: { id: '5', name: '1号車' } }))).not.toHaveProperty('vehicleCd')
    expect(dailyReportEditQuery(row({ car: { id: '5', name: '1号車', vehicle_cd: null } }))).not.toHaveProperty('vehicleCd')
    expect(dailyReportEditQuery(row({ car: { id: '5', name: '1号車', vehicle_cd: '12a' } }))).not.toHaveProperty('vehicleCd')
    expect(dailyReportEditQuery(row({ car: { id: '5', name: '1号車', vehicle_cd: '123456789' } }))).not.toHaveProperty('vehicleCd')
    expect(dailyReportEditQuery(row({ car: { id: '5', name: '1号車', vehicle_cd: '0012345678' } }))).toMatchObject({ vehicleCd: '12345678' })
  })
})

describe('normalizeVehicleCd', () => {
  it('数字だけなら先頭ゼロを落とす (全部 0 なら "0")', () => {
    expect(normalizeVehicleCd('0000002158')).toBe('2158')
    expect(normalizeVehicleCd('2158')).toBe('2158')
    expect(normalizeVehicleCd('0000')).toBe('0')
  })
  it('空・null・undefined・数字以外を含むなら null', () => {
    expect(normalizeVehicleCd('')).toBeNull()
    expect(normalizeVehicleCd(null)).toBeNull()
    expect(normalizeVehicleCd(undefined)).toBeNull()
    expect(normalizeVehicleCd('12a')).toBeNull()
  })
})

describe('dvrMapQuery', () => {
  it('車輌CD があれば vehicle (先頭ゼロなし) と at (給油日時の YYYY-MM-DDTHH:mm)', () => {
    expect(dvrMapQuery(row({ car: { id: '5', name: '1号車', vehicle_cd: '0000002158' } })))
      .toEqual({ vehicle: '2158', at: '2023-12-20T08:10' })
  })
  it('car・車輌CD が無い・読めなければ null', () => {
    expect(dvrMapQuery(row())).toBeNull()
    expect(dvrMapQuery(row({ car: { id: '5', name: '1号車' } }))).toBeNull()
    expect(dvrMapQuery(row({ car: { id: '5', name: '1号車', vehicle_cd: null } }))).toBeNull()
    expect(dvrMapQuery(row({ car: { id: '5', name: '1号車', vehicle_cd: 'x1' } }))).toBeNull()
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

describe('createRowsCache', () => {
  function counting() {
    const calls: string[] = []
    const load = (key: string) => {
      calls.push(key)
      return key.startsWith('bad') ? Promise.reject(new Error(key)) : Promise.resolve(`rows:${key}:${calls.length}`)
    }
    return { calls, cache: createRowsCache(load) }
  }

  it('覚えた表は読み直さず、force なら読み直す', async () => {
    const { calls, cache } = counting()
    expect(await cache.get('a')).toBe('rows:a:1')
    expect(await cache.get('a')).toBe('rows:a:1')
    expect(await cache.get('a', true)).toBe('rows:a:2')
    expect(await cache.get('a')).toBe('rows:a:2')
    expect(calls).toEqual(['a', 'a'])
  })

  it('読み込み中に同じ key を頼むと同じ読み込みを待つ', async () => {
    const { calls, cache } = counting()
    const [x, y] = await Promise.all([cache.get('a'), cache.get('a')])
    expect(x).toBe(y)
    expect(calls).toEqual(['a'])
  })

  it('失敗は覚えない (次は読み直す)', async () => {
    const { calls, cache } = counting()
    await expect(cache.get('bad')).rejects.toThrow('bad')
    await expect(cache.get('bad')).rejects.toThrow('bad')
    expect(calls).toEqual(['bad', 'bad'])
  })

  it('失敗した古い読み込みが、force で読み直した新しい表を消さない', async () => {
    let reject!: (e: Error) => void
    let n = 0
    const cache = createRowsCache((key: string) => {
      n += 1
      return n === 1 ? new Promise<string>((_, r) => { reject = r }) : Promise.resolve(`${key}:${n}`)
    })
    const first = cache.get('a')
    expect(await cache.get('a', true)).toBe('a:2')
    reject(new Error('late'))
    await expect(first).rejects.toThrow('late')
    expect(await cache.get('a')).toBe('a:2')
    expect(n).toBe(2)
  })

  it('clear で覚えた表を捨てる', async () => {
    const { calls, cache } = counting()
    await cache.get('a')
    cache.clear()
    await cache.get('a')
    expect(calls).toEqual(['a', 'a'])
  })

  it('prefetch は並列数を守って全部読み、失敗を投げない', async () => {
    let running = 0
    let peak = 0
    const calls: string[] = []
    const cache = createRowsCache(async (key: string) => {
      calls.push(key)
      running += 1
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 1))
      running -= 1
      if (key === 'bad') throw new Error(key)
      return key
    })
    await cache.prefetch(['a', 'bad', 'b', 'c'], 2)
    expect(calls.sort()).toEqual(['a', 'b', 'bad', 'c'])
    expect(peak).toBe(2)
    // 読んだものは覚えている
    expect(await cache.get('c')).toBe('c')
    expect(calls).toHaveLength(4)
  })

  it('prefetch の並列数は最低 1', async () => {
    const { calls, cache } = counting()
    await cache.prefetch(['a', 'b'], 0)
    expect(calls).toEqual(['a', 'b'])
  })
})
