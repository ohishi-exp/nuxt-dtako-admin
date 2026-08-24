import { describe, expect, it } from 'vitest'
import {
  buildAllowanceBase,
  nextYm,
  parseUncoveredByDriver,
  serializeUncoveredByDriver,
  sumUncoveredByDriver,
  UNCOVERED_BY_DRIVER_KEY,
  type AllowanceBaseOperation,
} from '~/utils/profit-allowance-base'

/** 乗務員名 → 乗務員CD (帯広5名、2026-07 の実データ)。 */
const CD_BY_NAME = new Map([
  ['中村　一由', '1412'],
  ['柳井　亮祐', '1587'],
  ['西島　健太', '1656'],
  ['佐竹　繁', '1732'],
  ['増地　誠', '1742'],
])

function op(driverName: string, legs: Array<[string, number]>): AllowanceBaseOperation {
  return { driverName, legs: legs.map(([date, allowanceYen]) => ({ date, allowanceYen })) }
}

describe('nextYm', () => {
  it('翌月を返す', () => {
    expect(nextYm('2026-07')).toBe('2026-08')
  })

  it('12 月は年を繰り上げる', () => {
    expect(nextYm('2026-12')).toBe('2027-01')
  })

  it('月が範囲外なら空', () => {
    expect(nextYm('2026-13')).toBe('')
    expect(nextYm('2026-00')).toBe('')
  })

  it('年が数でなければ空', () => {
    expect(nextYm('xxxx-07')).toBe('')
  })

  it('月が数でなければ空 (年だけ読めても倒す)', () => {
    expect(nextYm('2026-xx')).toBe('')
  })

  it('空文字は空', () => {
    expect(nextYm('')).toBe('')
  })
})

describe('sumUncoveredByDriver', () => {
  it('乗務員CD ごとに畳む', () => {
    const legs = [
      { driverName: '中村　一由', allowanceYen: 10000 },
      { driverName: '中村　一由', allowanceYen: 15000 },
      { driverName: '増地　誠', allowanceYen: 9000 },
    ]
    expect(sumUncoveredByDriver(legs, CD_BY_NAME)).toEqual({ 1412: 25000, 1742: 9000 })
  })

  it('前後の空白は落として引く', () => {
    expect(sumUncoveredByDriver([{ driverName: ' 佐竹　繁 ', allowanceYen: 100 }], CD_BY_NAME))
      .toEqual({ 1732: 100 })
  })

  it('CD を引けない乗務員は落とす (名前で持つと拘束サマリと結べない)', () => {
    const legs = [
      { driverName: '知らない人', allowanceYen: 50000 },
      { driverName: '増地　誠', allowanceYen: 9000 },
    ]
    expect(sumUncoveredByDriver(legs, CD_BY_NAME)).toEqual({ 1742: 9000 })
  })

  it('金額の決まらなかった便は数えない (summarizeIchibanLegs と同じ扱い)', () => {
    const legs = [
      { driverName: '増地　誠', allowanceYen: null },
      { driverName: '増地　誠', allowanceYen: 9000 },
    ]
    expect(sumUncoveredByDriver(legs, CD_BY_NAME)).toEqual({ 1742: 9000 })
  })

  it('1 本も無ければ空', () => {
    expect(sumUncoveredByDriver([], CD_BY_NAME)).toEqual({})
  })
})

describe('serializeUncoveredByDriver / parseUncoveredByDriver', () => {
  it('キーは MarginCache と別', () => {
    expect(UNCOVERED_BY_DRIVER_KEY).toBe('dtako:profit:uncovered-by-driver:v1')
  })

  it('往復する', () => {
    const cache = { ym: '2026-07', byDriver: { 1412: 25000, 1587: 82000 } }
    expect(parseUncoveredByDriver(serializeUncoveredByDriver(cache))).toEqual(cache)
  })

  it('空・壊れた JSON は null', () => {
    expect(parseUncoveredByDriver(null)).toBeNull()
    expect(parseUncoveredByDriver(undefined)).toBeNull()
    expect(parseUncoveredByDriver('')).toBeNull()
    expect(parseUncoveredByDriver('{')).toBeNull()
  })

  it('object でなければ null', () => {
    expect(parseUncoveredByDriver('123')).toBeNull()
    expect(parseUncoveredByDriver('null')).toBeNull()
  })

  it('ym が無ければ null', () => {
    expect(parseUncoveredByDriver('{"byDriver":{}}')).toBeNull()
  })

  it('byDriver が無い / object でなければ null', () => {
    expect(parseUncoveredByDriver('{"ym":"2026-07"}')).toBeNull()
    expect(parseUncoveredByDriver('{"ym":"2026-07","byDriver":null}')).toBeNull()
    expect(parseUncoveredByDriver('{"ym":"2026-07","byDriver":5}')).toBeNull()
  })

  it('数でない額は落とす (0 に倒すと「対象外 0 円」と区別が付かない)', () => {
    expect(parseUncoveredByDriver('{"ym":"2026-07","byDriver":{"1412":1,"1587":"x","1656":null}}'))
      .toEqual({ ym: '2026-07', byDriver: { 1412: 1 } })
  })

  it('Infinity も落とす (JSON の 1e999 は Infinity として parse される)', () => {
    expect(parseUncoveredByDriver('{"ym":"2026-07","byDriver":{"1412":1e999,"1587":2}}'))
      .toEqual({ ym: '2026-07', byDriver: { 1587: 2 } })
  })
})

describe('buildAllowanceBase', () => {
  /**
   * 2026-07 / 帯広5名の実データ (本番の localStorage `dtako:margin:cache:v9` を実測)。
   * 手当計 ¥2,499,500 / 翌月日付便 ¥55,000 / 対象外便 ¥319,500 → 実支給 ¥2,764,000。
   */
  const OPERATIONS: AllowanceBaseOperation[] = [
    op('中村　一由', [['2026-07-05', 584000], ['2026-08-01', 17000]]),
    op('柳井　亮祐', [['2026-07-16', 470500], ['2026-08-02', 18000]]),
    op('西島　健太', [['2026-07-10', 339000], ['2026-08-03', 20000]]),
    op('佐竹　繁', [['2026-07-11', 561000]]),
    op('増地　誠', [['2026-07-12', 490000]]),
  ]
  const UNCOVERED = { 1412: 25000, 1587: 82000, 1656: 203500, 1742: 9000 }

  it('対象外便まで揃うと 実支給 ¥2,764,000 を乗務員別に再現する', () => {
    const rows = buildAllowanceBase(OPERATIONS, '2026-07', CD_BY_NAME, UNCOVERED)
    expect(rows.map(r => [r.driverCd, r.baseYen])).toEqual([
      ['1412', 609000],
      ['1587', 552500],
      ['1656', 542500],
      ['1732', 561000],
      ['1742', 499000],
    ])
    expect(rows.reduce((s, r) => s + r.baseYen, 0)).toBe(2764000)
    expect(rows.every(r => r.complete)).toBe(true)
  })

  it('内訳の合計が実測と一致する (手当 2,499,500 / 翌月 55,000 / 対象外 319,500)', () => {
    const rows = buildAllowanceBase(OPERATIONS, '2026-07', CD_BY_NAME, UNCOVERED)
    expect(rows.reduce((s, r) => s + r.operationYen, 0)).toBe(2499500)
    expect(rows.reduce((s, r) => s + r.nextMonthYen, 0)).toBe(55000)
    expect(rows.reduce((s, r) => s + (r.uncoveredYen ?? 0), 0)).toBe(319500)
  })

  it('対象外が 1 本も無い乗務員は 0 と分かっている (complete のまま)', () => {
    const rows = buildAllowanceBase(OPERATIONS, '2026-07', CD_BY_NAME, UNCOVERED)
    const satake = rows.find(r => r.driverCd === '1732')!
    expect(satake.uncoveredYen).toBe(0)
    expect(satake.complete).toBe(true)
  })

  it('対象外が取れていなければ 0 に倒さず complete: false', () => {
    const rows = buildAllowanceBase(OPERATIONS, '2026-07', CD_BY_NAME, null)
    expect(rows.every(r => r.uncoveredYen === null)).toBe(true)
    expect(rows.every(r => !r.complete)).toBe(true)
    // 当月運行の便のみ = 粗利タブの手当 − 翌月日付の便
    expect(rows.reduce((s, r) => s + r.baseYen, 0)).toBe(2444500)
  })

  it('翌月日付の便を母数から引く', () => {
    const rows = buildAllowanceBase([op('中村　一由', [['2026-07-31', 5000], ['2026-08-01', 3000]])], '2026-07', CD_BY_NAME, {})
    expect(rows[0]).toMatchObject({ operationYen: 8000, nextMonthYen: 3000, uncoveredYen: 0, baseYen: 5000 })
  })

  it('月の形が壊れていれば翌月の便は 1 本も当たらない', () => {
    const rows = buildAllowanceBase([op('中村　一由', [['2026-07-31', 5000], ['2026-08-01', 3000]])], '2026-13', CD_BY_NAME, {})
    expect(rows[0]).toMatchObject({ operationYen: 8000, nextMonthYen: 0, baseYen: 8000 })
  })

  it('同じ乗務員の運行を畳む', () => {
    const rows = buildAllowanceBase(
      [op('佐竹　繁', [['2026-07-01', 100]]), op('佐竹　繁', [['2026-07-02', 200]])],
      '2026-07', CD_BY_NAME, {},
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.operationYen).toBe(300)
  })

  it('便が 1 本も無い運行も乗務員としては数える', () => {
    const rows = buildAllowanceBase([op('佐竹　繁', [])], '2026-07', CD_BY_NAME, {})
    expect(rows).toEqual([{
      driverCd: '1732', driverName: '佐竹　繁',
      operationYen: 0, nextMonthYen: 0, uncoveredYen: 0, baseYen: 0, complete: true,
    }])
  })

  it('CD を引けない乗務員は CD 空で残し、末尾に並べる', () => {
    const rows = buildAllowanceBase(
      [op('知らない人', [['2026-07-01', 100]]), op('中村　一由', [['2026-07-01', 200]])],
      '2026-07', CD_BY_NAME, {},
    )
    expect(rows.map(r => r.driverCd)).toEqual(['1412', ''])
  })

  it('CD を引けない乗務員が並ぶときは名前順で安定する (両向きの比較を通す)', () => {
    const rows = buildAllowanceBase(
      [op('CCC', [['2026-07-01', 1]]), op('AAA', [['2026-07-01', 2]]), op('BBB', [['2026-07-01', 3]])],
      '2026-07', CD_BY_NAME, {},
    )
    expect(rows.map(r => r.driverName)).toEqual(['AAA', 'BBB', 'CCC'])
  })

  it('CD が引ける側が先に来る (逆順の入力でも同じ)', () => {
    const rows = buildAllowanceBase(
      [op('中村　一由', [['2026-07-01', 200]]), op('知らない人', [['2026-07-01', 100]])],
      '2026-07', CD_BY_NAME, {},
    )
    expect(rows.map(r => r.driverCd)).toEqual(['1412', ''])
  })

  it('乗務員CD の昇順に並べる', () => {
    const rows = buildAllowanceBase(
      [op('増地　誠', [['2026-07-01', 1]]), op('中村　一由', [['2026-07-01', 1]]), op('佐竹　繁', [['2026-07-01', 1]])],
      '2026-07', CD_BY_NAME, {},
    )
    expect(rows.map(r => r.driverCd)).toEqual(['1412', '1732', '1742'])
  })

  it('運行が 1 本も無ければ空', () => {
    expect(buildAllowanceBase([], '2026-07', CD_BY_NAME, {})).toEqual([])
  })
})
