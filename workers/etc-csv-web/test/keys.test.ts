import { describe, expect, it } from 'vitest'
import {
  ETC_CSV_DATE_PATTERN,
  ETC_CSV_KEY_PATTERN,
  filenameFromKey,
  parseEtcCsvKey,
  resolveR2Prefix,
  userDatesPrefix,
  userDayPrefix,
} from '../src/keys'

describe('parseEtcCsvKey', () => {
  it('分解できる', () => {
    expect(parseEtcCsvKey('etc/u1/2026-09-01/060005.csv')).toEqual({
      prefix: 'etc',
      userId: 'u1',
      date: '2026-09-01',
      time: '060005',
    })
    expect(parseEtcCsvKey('etc-staging/u_1-2/2026-09-01/235959.csv')?.prefix).toBe('etc-staging')
    expect(parseEtcCsvKey('etc-preview/u/2026-09-01/000000.csv')?.prefix).toBe('etc-preview')
  })

  // 陰性対照: 不正な鍵は 1 つも通らない。
  it.each([
    ['他 prefix', 'restraint/u1/2026-09-01/060005.csv'],
    ['prefix なし', 'u1/2026-09-01/060005.csv'],
    ['path traversal', 'etc/../restraint/u1/2026-09-01/060005.csv'],
    ['user_id に /', 'etc/a/b/2026-09-01/060005.csv'],
    ['user_id に記号', 'etc/u"1/2026-09-01/060005.csv'],
    ['日付の形が違う', 'etc/u1/2026-9-1/060005.csv'],
    ['時刻の桁が違う', 'etc/u1/2026-09-01/06005.csv'],
    ['拡張子が違う', 'etc/u1/2026-09-01/060005.txt'],
    ['末尾に追記', 'etc/u1/2026-09-01/060005.csv/x'],
    ['改行で header injection', 'etc/u1/2026-09-01/060005.csv\n'],
    ['空文字', ''],
  ])('%s は通らない', (_label, key) => {
    expect(ETC_CSV_KEY_PATTERN.test(key)).toBe(false)
    expect(parseEtcCsvKey(key)).toBeNull()
  })
})

describe('filenameFromKey', () => {
  it('prefix を落として _ で繋ぐ', () => {
    expect(filenameFromKey('etc/u1/2026-09-01/060005.csv')).toBe('u1_2026-09-01_060005.csv')
  })
})

describe('resolveR2Prefix', () => {
  it('既定は etc、既知の値は前後空白を落として通す', () => {
    expect(resolveR2Prefix(undefined)).toBe('etc')
    expect(resolveR2Prefix('etc')).toBe('etc')
    expect(resolveR2Prefix('  etc-staging  ')).toBe('etc-staging')
    expect(resolveR2Prefix('etc-preview')).toBe('etc-preview')
  })

  // 陰性対照: 未知の prefix を env に入れても汎用 lister にはならない。
  it.each(['restraint', '', 'etc/', '../etc', 'ETC'])('%o は null (fail-closed)', (raw) => {
    expect(resolveR2Prefix(raw)).toBeNull()
  })
})

describe('prefix 組み立て', () => {
  it('日付一覧 / 当日一覧', () => {
    expect(userDatesPrefix('etc', 'u1')).toBe('etc/u1/')
    expect(userDayPrefix('etc', 'u1', '2026-09-01')).toBe('etc/u1/2026-09-01/')
  })
})

describe('ETC_CSV_DATE_PATTERN', () => {
  it('YYYY-MM-DD だけ', () => {
    expect(ETC_CSV_DATE_PATTERN.test('2026-09-01')).toBe(true)
    expect(ETC_CSV_DATE_PATTERN.test('2026-9-1')).toBe(false)
    expect(ETC_CSV_DATE_PATTERN.test('2026-09-01/x')).toBe(false)
  })
})
