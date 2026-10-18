import { describe, it, expect } from 'vitest'
import { carOptions, toDatetimeLocal, fromDatetimeLocal } from '~/utils/fuel-cards'

describe('carOptions', () => {
  it('名前と id を出し、名前が無ければ id だけ', () => {
    expect(carOptions([{ id: '307200', name: '車A' }, { id: '9', name: null }])).toEqual([
      { label: '車A (307200)', value: '307200' },
      { label: '9', value: '9' },
    ])
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
