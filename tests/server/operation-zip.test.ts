import { describe, expect, it } from 'vitest'

import { START_OPE_RE, UNKO_NO_RE, opeNo22FromUnkoNo, startOpeFromUnkoNo } from '../../server/utils/operation-zip'

// 実運行 (中村 2026-07-06)。先頭 12 桁 `260706041859` が出庫日時、次の 10 桁が車輌CD。
const UNKO_22 = '2607060418590000001109'

describe('opeNo22FromUnkoNo', () => {
  it('22 桁はそのまま返す', () => {
    expect(opeNo22FromUnkoNo(UNKO_22)).toBe(UNKO_22)
  })

  it('23 桁は末尾 1 桁 (対象乗務員CD) を落として 22 桁にする', () => {
    expect(opeNo22FromUnkoNo(`${UNKO_22}1`)).toBe(UNKO_22)
  })

  it('桁数違い・数字以外は null', () => {
    expect(opeNo22FromUnkoNo(`${UNKO_22}12`)).toBeNull()
    expect(opeNo22FromUnkoNo(UNKO_22.slice(0, 21))).toBeNull()
    expect(opeNo22FromUnkoNo('')).toBeNull()
    expect(opeNo22FromUnkoNo(`${UNKO_22.slice(0, 21)}x`)).toBeNull()
  })
})

describe('startOpeFromUnkoNo', () => {
  it('先頭 12 桁から `YYYY/MM/DD H:mm:ss` を組む (2000 年代決め打ち)', () => {
    expect(startOpeFromUnkoNo(UNKO_22)).toBe('2026/07/06 4:18:59')
  })

  it('時は 0 埋めしない — 分・秒は 0 埋めのまま', () => {
    // 04:05:06 → `4:5:6` ではなく `4:05:06`
    const startOpe = startOpeFromUnkoNo(`260706040506${UNKO_22.slice(12)}`)
    expect(startOpe).toBe('2026/07/06 4:05:06')
    expect(START_OPE_RE.test(startOpe!)).toBe(true)
  })

  it('10 時以降は 2 桁のまま出る', () => {
    expect(startOpeFromUnkoNo(`260706231859${UNKO_22.slice(12)}`)).toBe('2026/07/06 23:18:59')
  })

  it('23 桁でも 22 桁と同じ出庫日時になる', () => {
    expect(startOpeFromUnkoNo(`${UNKO_22}2`)).toBe(startOpeFromUnkoNo(UNKO_22))
  })

  it('運行NO の形式が違えば null', () => {
    expect(startOpeFromUnkoNo('26070604185900000011091234')).toBeNull()
  })

  it('月日時分秒が範囲外なら null (relay に投げない)', () => {
    const tail = UNKO_22.slice(12)
    expect(startOpeFromUnkoNo(`260006041859${tail}`)).toBeNull() // 月 00
    expect(startOpeFromUnkoNo(`261306041859${tail}`)).toBeNull() // 月 13
    expect(startOpeFromUnkoNo(`260700041859${tail}`)).toBeNull() // 日 00
    expect(startOpeFromUnkoNo(`260732041859${tail}`)).toBeNull() // 日 32
    expect(startOpeFromUnkoNo(`260706241859${tail}`)).toBeNull() // 時 24
    expect(startOpeFromUnkoNo(`260706046059${tail}`)).toBeNull() // 分 60
    expect(startOpeFromUnkoNo(`260706041860${tail}`)).toBeNull() // 秒 60
  })

  it('境界値 (月 01/12・日 01/31・時 00/23・分秒 00/59) は通る', () => {
    const tail = UNKO_22.slice(12)
    expect(startOpeFromUnkoNo(`260101000000${tail}`)).toBe('2026/01/01 0:00:00')
    expect(startOpeFromUnkoNo(`261231235959${tail}`)).toBe('2026/12/31 23:59:59')
  })
})

describe('正規表現', () => {
  it('UNKO_NO_RE は 22/23 桁の数字だけ通す', () => {
    expect(UNKO_NO_RE.test(UNKO_22)).toBe(true)
    expect(UNKO_NO_RE.test(`${UNKO_22}1`)).toBe(true)
    expect(UNKO_NO_RE.test(`${UNKO_22}12`)).toBe(false)
  })

  it('START_OPE_RE は 0 埋めした時も (relay 側が受ける形として) 通す', () => {
    expect(START_OPE_RE.test('2026/07/06 04:18:59')).toBe(true)
    expect(START_OPE_RE.test('2026-07-06 4:18:59')).toBe(false)
    expect(START_OPE_RE.test('2026/07/06 4:18')).toBe(false)
  })
})
