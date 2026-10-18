import { describe, it, expect } from 'vitest'
import type { FuelCard, FuelIntankRow, FuelStart } from '~/types'
import {
  START_CARD, manualCardItems, slipNumParent, buildManualBody, describeManualError,
  canRecheck, manualRows, lastInsertedText, rowCardLabel, type ManualInput,
} from '~/utils/fuel-manual'

const STARTS: FuelStart[] = [
  { datetime: '2024-10-01 06:58:00', fuel_card_id: 9999, slip_num: 12 },
  { datetime: '2024-09-01 06:58:00', fuel_card_id: 9999, slip_num: 30 },
  { datetime: '2024-08-01 06:58:00', fuel_card_id: 9999, slip_num: 3 },
]

function row(over: Partial<FuelIntankRow>): FuelIntankRow {
  return {
    datetime: '2024-10-02 08:00:00', fuel_card_id: 40, slip_num: 13, slip_num_parent: 12,
    quantity: 12345, qt: 123.45, type: 'fuel', detail: null,
    dtako_row_id: '24100206000000000351001', manual: null, id_st: '2024-10-02 08:00:00;40',
    ...over,
  }
}

function input(over: Partial<ManualInput>): ManualInput {
  return { slipNum: '13', datetimeLocal: '2024-10-02T08:00', card: '40', quantity: '123.45', ...over }
}

describe('manualCardItems', () => {
  it('先頭に start 行、続けて card を id 順・4 桁 0 埋めで。車両名が無い・空なら id だけ', () => {
    const cards: FuelCard[] = [
      { id: 57, car_id: '1', end_datetime: null, car: { id: '1', name: '車A' } },
      { id: 4, car_id: null, end_datetime: null, car: null },
      { id: 12, car_id: '2', end_datetime: null, car: { id: '2', name: '' } },
    ]
    expect(manualCardItems(cards)).toEqual([
      { label: 'start 行 (カード無し)', value: START_CARD },
      { label: '0004', value: '4' },
      { label: '0012', value: '12' },
      { label: '0057 車A', value: '57' },
    ])
    // 渡した配列は並べ替えない
    expect(cards.map(c => c.id)).toEqual([57, 4, 12])
  })
})

describe('slipNumParent', () => {
  it('start の slip_num の最大値 (並び順に依らない)', () => {
    expect(slipNumParent(STARTS)).toBe(30)
  })
  it('start が無ければ undefined', () => {
    expect(slipNumParent([])).toBeUndefined()
  })
})

describe('buildManualBody', () => {
  it('fuel 行: datetime-local を秒付きに、card と数量を数値に、slip_num_parent は start の最大値', () => {
    expect(buildManualBody(input({}), STARTS)).toEqual({
      ok: true,
      body: { datetime: '2024-10-02 08:00:00', slip_num: 13, fuel_card_id: 40, quantity_decimal: 123.45, slip_num_parent: 30 },
    })
  })
  it('fuel 行で start が 0 件なら slip_num_parent を送らない', () => {
    expect(buildManualBody(input({}), [])).toEqual({
      ok: true,
      body: { datetime: '2024-10-02 08:00:00', slip_num: 13, fuel_card_id: 40, quantity_decimal: 123.45 },
    })
  })
  it('start 行: fuel_card_id・数量・slip_num_parent を送らない (数量の欄に何があっても)', () => {
    expect(buildManualBody(input({ card: START_CARD, quantity: 'abc' }), STARTS)).toEqual({
      ok: true,
      body: { datetime: '2024-10-02 08:00:00', slip_num: 13 },
    })
  })
  it('伝票番号・数量の前後の空白は落とす。数量は 0 も整数も通る', () => {
    const r = buildManualBody(input({ slipNum: ' 7 ', quantity: ' 0 ' }), [])
    expect(r).toEqual({ ok: true, body: { datetime: '2024-10-02 08:00:00', slip_num: 7, fuel_card_id: 40, quantity_decimal: 0 } })
  })
  it('★ 数量は数値でも受ける (UInput type=number は数値を emit する)。小数 3 桁・指数表記の数値は落とす', () => {
    expect(buildManualBody(input({ quantity: 12.34 }), [])).toEqual({
      ok: true, body: { datetime: '2024-10-02 08:00:00', slip_num: 13, fuel_card_id: 40, quantity_decimal: 12.34 },
    })
    expect(buildManualBody(input({ quantity: 12.345 }), []).ok).toBe(false)
    expect(buildManualBody(input({ quantity: 1e21 }), []).ok).toBe(false)
  })
  it('数量は 999999.99 まで通り、1000000 は落ちる', () => {
    expect(buildManualBody(input({ quantity: '999999.99' }), []).ok).toBe(true)
    expect(buildManualBody(input({ quantity: '1000000' }), [])).toEqual({
      ok: false, error: '数量 (L) を 0 以上 1000000 未満・小数 2 桁までで入れてください',
    })
  })
  it.each([
    ['伝票番号が空', { slipNum: '' }, '伝票番号を 0 以上の整数で入れてください'],
    ['伝票番号が小数', { slipNum: '1.5' }, '伝票番号を 0 以上の整数で入れてください'],
    ['伝票番号が負', { slipNum: '-1' }, '伝票番号を 0 以上の整数で入れてください'],
    ['日時が空', { datetimeLocal: '' }, '日時を入れてください'],
    ['日時が読めない', { datetimeLocal: '2024-10-02' }, '日時を入れてください'],
    ['カード未選択', { card: undefined }, 'カードを選んでください (start 行ならカード無しを選ぶ)'],
    ['数量が空', { quantity: '' }, '数量 (L) を 0 以上 1000000 未満・小数 2 桁までで入れてください'],
    ['数量が小数 3 桁', { quantity: '1.234' }, '数量 (L) を 0 以上 1000000 未満・小数 2 桁までで入れてください'],
    ['数量が負', { quantity: '-1' }, '数量 (L) を 0 以上 1000000 未満・小数 2 桁までで入れてください'],
  ] as [string, Partial<ManualInput>, string][])('%s → 欄の文', (_n, over, error) => {
    expect(buildManualBody(input(over), STARTS)).toEqual({ ok: false, error })
  })
})

describe('describeManualError', () => {
  it.each([
    ['API エラー (409): {"ok":false,"error":"not_manual"}', 'CSV から取り込んだ行は手入力で上書きできません'],
    ['API エラー (404): {"ok":false,"error":"not_found"}', 'その行は見つかりませんでした (削除されたかもしれません。一覧を読み直してください)'],
    ['API エラー (400): {"ok":false,"error":"datetime"}', '日時が読めません'],
    ['API エラー (400): {"ok":false,"error":"slip_num"}', '伝票番号は 0 以上の整数で入れてください'],
    ['API エラー (400): {"ok":false,"error":"fuel_card_id"}', 'そのカードの番号は使えません (0 と 9999 は不可)'],
    ['API エラー (400): {"ok":false,"error":"quantity_decimal"}', '数量 (L) は 0 以上 1000000 未満で入れてください'],
    ['API エラー (400): {"ok":false,"error":"slip_num_parent"}', 'start の伝票番号 (slip_num_parent) が読めません'],
    ['API エラー (400): {"ok":false,"error":"unknown_field"}', '画面が送った本文を上流が受け付けませんでした (画面の不具合です)'],
    ['API エラー (400): {"ok":false,"error":"invalid_json"}', '画面が送った本文を上流が受け付けませんでした (画面の不具合です)'],
  ])('%s → 項目の文', (message, text) => {
    expect(describeManualError(message)).toBe(text)
  })
  it.each([
    ['対応の無い code', 'API エラー (400): {"ok":false,"error":"x"}'],
    ['error が文字列でない', 'API エラー (400): {"ok":false,"error":1}'],
    ['本文が JSON でない', 'API エラー (400): {nope}'],
    ['対象外の status (500)', 'API エラー (500): {"ok":false,"error":"internal"}'],
    ['本文が無い', 'API エラー (409): Conflict'],
    ['Object の組み込みの名前を code として読まない', 'API エラー (400): {"ok":false,"error":"toString"}'],
  ])('%s → null', (_n, message) => {
    expect(describeManualError(message)).toBeNull()
  })
})

describe('canRecheck', () => {
  it('dtako_row_id が空 (null・空文字) の fuel 行だけ', () => {
    expect(canRecheck(row({ dtako_row_id: null }))).toBe(true)
    expect(canRecheck(row({ dtako_row_id: '' }))).toBe(true)
    expect(canRecheck(row({}))).toBe(false)
  })
  it('start 行 (card 9999) は dtako_row_id が空でも出さない', () => {
    expect(canRecheck(row({ fuel_card_id: 9999, dtako_row_id: null, type: 'start' }))).toBe(false)
  })
})

describe('manualRows', () => {
  it('manual が true の行だけ (null・false は外す)', () => {
    const rows = [row({ manual: true, slip_num: 1 }), row({ manual: null, slip_num: 2 }), row({ manual: false, slip_num: 3 })]
    expect(manualRows(rows).map(r => r.slip_num)).toEqual([1])
  })
})

describe('rowCardLabel', () => {
  it('card は 4 桁 0 埋め、start 行 (9999) は (start)', () => {
    expect(rowCardLabel(40)).toBe('0040')
    expect(rowCardLabel(12345)).toBe('12345')
    expect(rowCardLabel(9999)).toBe('(start)')
  })
})

describe('lastInsertedText', () => {
  it('fuel 行は card、start 行は「start 行」、slip_num が null なら (なし)', () => {
    expect(lastInsertedText({ datetime: '2024-10-02 08:00:00', fuel_card_id: 57, slip_num: 5 }))
      .toBe('24/10/02 08:00 / card 57 / 伝票番号 5')
    expect(lastInsertedText({ datetime: '2024-10-01 06:58:00', fuel_card_id: 9999, slip_num: null }))
      .toBe('24/10/01 06:58 / start 行 / 伝票番号 (なし)')
  })
  it('行が無ければ null', () => {
    expect(lastInsertedText(null)).toBeNull()
  })
})
