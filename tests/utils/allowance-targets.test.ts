import { describe, it, expect } from 'vitest'
import {
  normalizeDriverName,
  parseTargets,
  serializeTargets,
  toggleTarget,
  matchesTargets,
  filterByTargets,
  driverCandidates,
} from '~/utils/allowance-targets'

describe('normalizeDriverName', () => {
  it('全角スペースを倒して連続空白を 1 つに潰す', () => {
    expect(normalizeDriverName('中村　　一由')).toBe('中村 一由')
    expect(normalizeDriverName('  柳井 亮祐 ')).toBe('柳井 亮祐')
  })

  it('null / undefined は空文字', () => {
    expect(normalizeDriverName(null)).toBe('')
    expect(normalizeDriverName(undefined)).toBe('')
  })
})

describe('parseTargets', () => {
  it('保存済みの配列を正規化・重複排除・昇順で返す', () => {
    expect(parseTargets('["柳井 亮祐","中村　一由","中村 一由"]')).toEqual(['中村 一由', '柳井 亮祐'])
  })

  it('未保存・空・壊れた値・配列でない値は対象なしにする', () => {
    expect(parseTargets(null)).toEqual([])
    expect(parseTargets('')).toEqual([])
    expect(parseTargets('{壊れた')).toEqual([])
    expect(parseTargets('{"a":1}')).toEqual([])
  })

  it('文字列でない要素と空文字は落とす', () => {
    expect(parseTargets('[1,null,"","  ","中村 一由"]')).toEqual(['中村 一由'])
  })
})

describe('serializeTargets', () => {
  it('正規化した配列を JSON にする', () => {
    expect(serializeTargets(['柳井 亮祐', '中村　一由'])).toBe('["中村 一由","柳井 亮祐"]')
  })
})

describe('toggleTarget', () => {
  it('入っていなければ足し、入っていれば外す', () => {
    expect(toggleTarget([], '中村 一由')).toEqual(['中村 一由'])
    expect(toggleTarget(['中村 一由', '柳井 亮祐'], '中村 一由')).toEqual(['柳井 亮祐'])
  })

  it('表記ゆれを吸収して同じものとして扱う', () => {
    expect(toggleTarget(['中村 一由'], '中村　一由')).toEqual([])
  })

  it('空の名前は何もしない', () => {
    expect(toggleTarget(['中村 一由'], '   ')).toEqual(['中村 一由'])
  })
})

describe('matchesTargets', () => {
  it('対象が空なら全員が対象', () => {
    expect(matchesTargets([], '誰でも')).toBe(true)
    expect(matchesTargets([], null)).toBe(true)
  })

  it('対象に入っているかで判定する', () => {
    expect(matchesTargets(['中村 一由'], '中村　一由')).toBe(true)
    expect(matchesTargets(['中村 一由'], '柳井 亮祐')).toBe(false)
    expect(matchesTargets(['中村 一由'], null)).toBe(false)
  })
})

describe('filterByTargets', () => {
  const ops = [
    { driver_name: '中村　一由', unko_no: 'A' },
    { driver_name: '柳井 亮祐', unko_no: 'B' },
    { driver_name: null, unko_no: 'C' },
  ]

  it('対象の運行だけ残す', () => {
    expect(filterByTargets(ops, ['中村 一由']).map(o => o.unko_no)).toEqual(['A'])
  })

  it('対象が空なら全部残す', () => {
    expect(filterByTargets(ops, [])).toHaveLength(3)
  })
})

describe('driverCandidates', () => {
  it('重複を畳んで昇順で返し、名前の無い運行は落とす', () => {
    expect(driverCandidates([
      { driver_name: '柳井 亮祐' },
      { driver_name: '中村　一由' },
      { driver_name: '中村 一由' },
      { driver_name: null },
      { driver_name: '  ' },
    ])).toEqual(['中村 一由', '柳井 亮祐'])
  })
})
