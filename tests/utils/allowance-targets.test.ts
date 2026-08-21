import { describe, it, expect } from 'vitest'
import {
  isDriverCd,
  normalizeDriverCd,
  parseTargets,
  serializeTargets,
  toggleTarget,
  driverLabel,
} from '~/utils/allowance-targets'

describe('normalizeDriverCd', () => {
  it('前後の空白を落とす', () => {
    expect(normalizeDriverCd(' 1412 ')).toBe('1412')
  })

  it('null / undefined は空文字', () => {
    expect(normalizeDriverCd(null)).toBe('')
    expect(normalizeDriverCd(undefined)).toBe('')
  })
})

describe('isDriverCd', () => {
  it('CD らしい文字列だけ通す', () => {
    expect(isDriverCd('1412')).toBe(true)
    expect(isDriverCd('A-12_3')).toBe(true)
  })

  it('氏名は弾く (旧版が氏名を保存していたため)', () => {
    expect(isDriverCd('中村 一由')).toBe(false)
    expect(isDriverCd('中村　一由')).toBe(false)
    expect(isDriverCd('')).toBe(false)
  })
})

describe('parseTargets', () => {
  it('保存済みの配列を重複排除・昇順で返す', () => {
    expect(parseTargets('["1732","1412"," 1412 "]')).toEqual(['1412', '1732'])
  })

  it('未保存・空・壊れた値・配列でない値は対象なしにする', () => {
    expect(parseTargets(null)).toEqual([])
    expect(parseTargets('')).toEqual([])
    expect(parseTargets('{壊れた')).toEqual([])
    expect(parseTargets('{"a":1}')).toEqual([])
  })

  it('文字列でない要素・空文字・氏名は落とす', () => {
    expect(parseTargets('[1,null,""," ","中村 一由","1412"]')).toEqual(['1412'])
  })

  it('氏名で保存していた旧版の値はまるごと落ちる', () => {
    expect(parseTargets('["中村 一由","佐竹 繁","増地 誠"]')).toEqual([])
  })
})

describe('serializeTargets', () => {
  it('正規化した配列を JSON にする', () => {
    expect(serializeTargets(['1732', ' 1412 '])).toBe('["1412","1732"]')
  })
})

describe('toggleTarget', () => {
  it('入っていなければ足し、入っていれば外す', () => {
    expect(toggleTarget([], '1412')).toEqual(['1412'])
    expect(toggleTarget(['1412', '1732'], '1412')).toEqual(['1732'])
  })

  it('空白は吸収して同じものとして扱う', () => {
    expect(toggleTarget(['1412'], ' 1412 ')).toEqual([])
  })

  it('空の CD・氏名は何もしない', () => {
    expect(toggleTarget(['1412'], '   ')).toEqual(['1412'])
    expect(toggleTarget(['1412'], '中村 一由')).toEqual(['1412'])
  })
})

describe('driverLabel', () => {
  const drivers = [{ driver_cd: '1412', driver_name: '中村　一由' }]

  it('乗務員マスタから CD と氏名を並べる', () => {
    expect(driverLabel(drivers, '1412')).toBe('1412 中村　一由')
    expect(driverLabel(drivers, ' 1412 ')).toBe('1412 中村　一由')
  })

  it('マスタに無い CD は CD だけ返す', () => {
    expect(driverLabel(drivers, '9999')).toBe('9999')
  })
})
