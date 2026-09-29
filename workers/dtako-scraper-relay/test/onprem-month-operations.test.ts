import { describe, expect, it } from 'vitest'
import { pickOnpremMonthOperations, unkoNoMonthPrefix } from '../src/onprem-month-operations'

describe('unkoNoMonthPrefix', () => {
  it('YYYY-MM を運行NO の先頭 4 桁 (YYMM) にする。形が違えば null', () => {
    expect(unkoNoMonthPrefix('2023-06')).toBe('2306')
    expect(unkoNoMonthPrefix('2023-13')).toBeNull()
    expect(unkoNoMonthPrefix('23-06')).toBeNull()
  })
})

describe('pickOnpremMonthOperations', () => {
  it('★ 対象月に始まった運行だけを 22 桁にして返す (前月から続く運行・翌月 1 日の運行は落とす)', () => {
    const r = pickOnpremMonthOperations({
      total: 6,
      items: [
        { unko_no: '23060609551300000040101' },
        { unko_no: '23061307524700000038342' },
        { unko_no: '23061307524700000038341' }, // 2 名乗務の相方 — 22 桁で 1 つ
        { unko_no: '23052912291300000040101' }, // 5/29 出発で 6 月にかかる
        { unko_no: '23070100000000000040101' }, // 翌月 1 日
        { unko_no: '2306290650220000004010' }, // 22 桁の実物もある
      ],
    }, '2023-06')
    expect(r).toEqual({
      opeNos: ['2306060955130000004010', '2306130752470000003834', '2306290650220000004010'],
      truncated: false,
    })
  })

  it('形の崩れた行は落とし、上流の上限で切れていたら truncated', () => {
    const r = pickOnpremMonthOperations({ total: 9, items: [null, { unko_no: 1 }, { unko_no: '2306x' }, { unko_no: '23060609551300000040101' }] }, '2023-06')
    expect(r).toEqual({ opeNos: ['2306060955130000004010'], truncated: true })
    expect(pickOnpremMonthOperations(null, '2023-06')).toEqual({ opeNos: [], truncated: false })
    expect(pickOnpremMonthOperations({ items: [{ unko_no: '23060609551300000040101' }] }, 'bad').opeNos).toEqual([])
  })
})
