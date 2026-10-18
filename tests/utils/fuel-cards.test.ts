import { describe, it, expect } from 'vitest'
import type { FuelCard } from '~/types'
import { carOptions, toDatetimeLocal, fromDatetimeLocal, cardPatch } from '~/utils/fuel-cards'

describe('carOptions', () => {
  it('名前と id を出し、名前が無ければ id だけ', () => {
    expect(carOptions([{ id: '307200', name: '車A' }, { id: '9', name: null }])).toEqual([
      { label: '車A (307200)', value: '307200' },
      { label: '9', value: '9' },
    ])
  })
  it('★ 名前が空文字の車両も id だけ (本番の cars に `{"id":"000100","name":""}` がある)', () => {
    expect(carOptions([{ id: '000100', name: '' }])).toEqual([{ label: '000100', value: '000100' }])
  })
})

describe('toDatetimeLocal', () => {
  it('API の日時を datetime-local の値にする', () => {
    expect(toDatetimeLocal('2024-03-31 23:59:00')).toBe('2024-03-31T23:59')
  })
  it('null・読めない形は空', () => {
    expect(toDatetimeLocal(null)).toBe('')
    expect(toDatetimeLocal('2024-03-31')).toBe('')
  })
})

describe('fromDatetimeLocal', () => {
  it('datetime-local の値を API の日時にする (秒は 00、あればそのまま)', () => {
    expect(fromDatetimeLocal('2024-03-31T23:59')).toBe('2024-03-31 23:59:00')
    expect(fromDatetimeLocal('2024-03-31T23:59:30')).toBe('2024-03-31 23:59:30')
  })
  it('空は null (解除)、読めない形は undefined (送らない)', () => {
    expect(fromDatetimeLocal('')).toBeNull()
    expect(fromDatetimeLocal('2024/03/31')).toBeUndefined()
  })
})

describe('cardPatch', () => {
  const card: FuelCard = { id: 1, car_id: '329000', end_datetime: null, car: { id: '329000', name: '車A' } }
  it('何も変わっていなければ null', () => {
    expect(cardPatch(card, '329000', '')).toBeNull()
  })
  it('車両だけ変えたら car_id だけ', () => {
    expect(cardPatch(card, '000100', '')).toEqual({ car_id: '000100' })
  })
  it('車両が未選択 (undefined) なら車両は送らない', () => {
    expect(cardPatch(card, undefined, '2024-03-31T23:59')).toEqual({ end_datetime: '2024-03-31 23:59:00' })
  })
  it('終了日時を空にすると null (解除) を送る', () => {
    expect(cardPatch({ ...card, end_datetime: '2024-03-31 23:59:00' }, '329000', '')).toEqual({ end_datetime: null })
  })
  it('終了日時が読めない形なら送らない', () => {
    expect(cardPatch(card, '329000', '2024/03/31')).toBeNull()
  })
  it('両方変えたら両方', () => {
    expect(cardPatch(card, '000100', '2024-03-31T23:59')).toEqual({ car_id: '000100', end_datetime: '2024-03-31 23:59:00' })
  })
})
