import { describe, it, expect } from 'vitest'
import {
  OVERPAID_KEY,
  overpaidKey,
  overpaidKeyText,
  parseOverpaid,
  serializeOverpaid,
  toggleOverpaid,
  isOverpaid,
  staleOverpaidKeys,
  type OverpaidTarget,
} from '~/utils/allowance-pdf-overpaid'

/** 実データの当該便 (`2026-07-27 佐竹 繁` の 2 便目、PDF `広尾〜士幌 ¥9,000`)。 */
const target = (over: Partial<OverpaidTarget> = {}): OverpaidTarget => ({
  driverName: '佐竹繁',
  pdfDate: '2026-07-27',
  pdfSeq: 2,
  pdfRoute: '広尾|松山/士幌',
  pdfYen: 9000,
  ...over,
})

describe('OVERPAID_KEY', () => {
  it('localStorage のキーは版番号付き', () => {
    expect(OVERPAID_KEY).toBe('dtako:allowance:pdf-overpaid:v1')
  })
})

describe('overpaidKey', () => {
  it('氏名・日付・その日の何便目か で便を指す', () => {
    expect(overpaidKey(target())).toBe('佐竹繁|2026-07-27|2')
  })

  it('同じ日に同じ経路が 2 便あっても別のキーになる', () => {
    // 実例 `2026-07-03 中村 一由` の 釧路〜標茶 ×2。経路と金額を鍵にすると畳まれる。
    const a = target({ driverName: '中村一由', pdfDate: '2026-07-03', pdfSeq: 2, pdfRoute: '釧路|標茶', pdfYen: 8000 })
    const b = { ...a, pdfSeq: 3 }
    expect(overpaidKey(a)).not.toBe(overpaidKey(b))
  })
})

describe('overpaidKeyText', () => {
  it('キーを読み下す', () => {
    expect(overpaidKeyText('佐竹繁|2026-07-27|2')).toBe('佐竹繁 2026-07-27 2便目')
  })

  it('壊れたキーでも落ちない', () => {
    expect(overpaidKeyText('')).toBe('  便目')
  })
})

describe('parseOverpaid', () => {
  it('保存した形をそのまま読む', () => {
    const map = toggleOverpaid({}, target())
    expect(parseOverpaid(serializeOverpaid(map))).toEqual(map)
  })

  it('空・壊れた JSON・配列・null は空として扱う', () => {
    expect(parseOverpaid(null)).toEqual({})
    expect(parseOverpaid(undefined)).toEqual({})
    expect(parseOverpaid('')).toEqual({})
    expect(parseOverpaid('{')).toEqual({})
    expect(parseOverpaid('[]')).toEqual({})
    expect(parseOverpaid('null')).toEqual({})
    expect(parseOverpaid('"x"')).toEqual({})
  })

  it('空キー・中身が object でない印は捨てる', () => {
    const raw = JSON.stringify({
      '': { pdfRoute: '広尾|富士', pdfYen: 8000 },
      a: 1,
      b: null,
      c: ['広尾|富士', 8000],
    })
    expect(parseOverpaid(raw)).toEqual({})
  })

  it('経路が文字列でない・金額が整数でない印は捨てる (給与に混ざる数字なので緩めない)', () => {
    const raw = JSON.stringify({
      a: { pdfRoute: 1, pdfYen: 9000 },
      b: { pdfRoute: '広尾|松山/士幌', pdfYen: '9000' },
      c: { pdfRoute: '広尾|松山/士幌', pdfYen: 9000.5 },
      d: { pdfRoute: '広尾|松山/士幌', pdfYen: 9000 },
    })
    expect(parseOverpaid(raw)).toEqual({ d: { pdfRoute: '広尾|松山/士幌', pdfYen: 9000 } })
  })
})

describe('toggleOverpaid', () => {
  it('印を付ける / 外すを同じ関数で往復する', () => {
    const on = toggleOverpaid({}, target())
    expect(on).toEqual({ '佐竹繁|2026-07-27|2': { pdfRoute: '広尾|松山/士幌', pdfYen: 9000 } })
    expect(toggleOverpaid(on, target())).toEqual({})
  })

  it('元の map を書き換えない', () => {
    const before = {}
    toggleOverpaid(before, target())
    expect(before).toEqual({})
  })

  it('PDF に金額が無い便には付けない (差が出ていないので過払いではない)', () => {
    expect(toggleOverpaid({}, target({ pdfYen: null }))).toEqual({})
  })

  it('金額が無くても、既に付いている印は外せる', () => {
    const on = toggleOverpaid({}, target())
    expect(toggleOverpaid(on, target({ pdfYen: null }))).toEqual({})
  })
})

describe('isOverpaid', () => {
  it('印が付いていれば true', () => {
    expect(isOverpaid(toggleOverpaid({}, target()), target())).toBe(true)
  })

  it('印が無ければ false', () => {
    expect(isOverpaid({}, target())).toBe(false)
  })

  it('キーが合っても経路・金額が違えば当てない (CSV を起こし直して便番号がずれた場合)', () => {
    const on = toggleOverpaid({}, target())
    expect(isOverpaid(on, target({ pdfRoute: '広尾|富士' }))).toBe(false)
    expect(isOverpaid(on, target({ pdfYen: 8000 }))).toBe(false)
  })
})

describe('staleOverpaidKeys', () => {
  it('中身が食い違う印だけを返す', () => {
    const on = toggleOverpaid({}, target())
    expect(staleOverpaidKeys(on, [target({ pdfRoute: '広尾|富士' })])).toEqual(['佐竹繁|2026-07-27|2'])
  })

  it('当たっている印は返さない', () => {
    const on = toggleOverpaid({}, target())
    expect(staleOverpaidKeys(on, [target()])).toEqual([])
  })

  it('別の月を見ているだけの印は stale にしない', () => {
    // キー自体が現れないので、月を切り替えるたびに前の月の印が全部出るのは誤り。
    const on = toggleOverpaid({}, target())
    expect(staleOverpaidKeys(on, [target({ pdfDate: '2026-08-27' })])).toEqual([])
    expect(staleOverpaidKeys(on, [])).toEqual([])
  })
})
