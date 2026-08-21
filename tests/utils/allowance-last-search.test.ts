import { describe, it, expect } from 'vitest'
import {
  parseLastSearch,
  serializeLastSearch,
} from '~/utils/allowance-last-search'

describe('parseLastSearch / serializeLastSearch', () => {
  it('保存した条件をそのまま読み戻す', () => {
    const search = { ym: '2026-07', vehicle: '1109' }
    expect(parseLastSearch(serializeLastSearch(search))).toEqual(search)
  })

  it('車輌CD の前後の空白は落とす (保存でも読み込みでも)', () => {
    expect(serializeLastSearch({ ym: '2026-07', vehicle: ' 1109 ' }))
      .toBe(JSON.stringify({ ym: '2026-07', vehicle: '1109' }))
    expect(parseLastSearch(JSON.stringify({ ym: '2026-07', vehicle: ' 1109 ' })))
      .toEqual({ ym: '2026-07', vehicle: '1109' })
  })

  it('車輌CD が無い / 文字列でなければ空文字にする', () => {
    expect(parseLastSearch(JSON.stringify({ ym: '2026-07' })))
      .toEqual({ ym: '2026-07', vehicle: '' })
    expect(parseLastSearch(JSON.stringify({ ym: '2026-07', vehicle: 1109 })))
      .toEqual({ ym: '2026-07', vehicle: '' })
  })

  it('未設定・壊れた値は「無かった」として扱う (投げない)', () => {
    expect(parseLastSearch(null)).toBeNull()
    expect(parseLastSearch(undefined)).toBeNull()
    expect(parseLastSearch('')).toBeNull()
    expect(parseLastSearch('{')).toBeNull()
    expect(parseLastSearch('42')).toBeNull()
    expect(parseLastSearch('null')).toBeNull()
    expect(parseLastSearch('["2026-07"]')).toBeNull()
  })

  it('月が `YYYY-MM` でなければ捨てる', () => {
    expect(parseLastSearch(JSON.stringify({ ym: '', vehicle: '' }))).toBeNull()
    expect(parseLastSearch(JSON.stringify({ ym: '2026-7', vehicle: '' }))).toBeNull()
    expect(parseLastSearch(JSON.stringify({ ym: '2026-07-01', vehicle: '' }))).toBeNull()
    expect(parseLastSearch(JSON.stringify({ ym: 202607, vehicle: '' }))).toBeNull()
  })

  it('存在しない月 (00 / 13) は捨てる — 復元しても 0 件にしかならない', () => {
    expect(parseLastSearch(JSON.stringify({ ym: '2026-00', vehicle: '' }))).toBeNull()
    expect(parseLastSearch(JSON.stringify({ ym: '2026-13', vehicle: '' }))).toBeNull()
    expect(parseLastSearch(JSON.stringify({ ym: '2026-12', vehicle: '' })))
      .toEqual({ ym: '2026-12', vehicle: '' })
  })
})
