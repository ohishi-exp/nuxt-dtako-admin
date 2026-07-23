/**
 * `app/utils/employee-master.ts` のテスト (Refs #367)。
 */

import { describe, it, expect } from 'vitest'
import {
  buildCdMapEntries,
  findUnregistered,
  resolveAttrsAt,
  splitCdMapKey,
  type EmployeeMasterEntry,
} from '../../app/utils/employee-master'
import type { SalaryCsvRow } from '../../app/utils/salary-compare'

function entry(over: Partial<EmployeeMasterEntry> = {}): EmployeeMasterEntry {
  return { company: '株', payrollCd: '7', name: '山田太郎', driverCd: '99', attrs: [], ...over }
}

function csvRow(over: Partial<SalaryCsvRow> = {}): SalaryCsvRow {
  return {
    driverCd: '007',
    cdKey: '7',
    company: '株',
    driverName: '山田太郎',
    month: '2026-07',
    amounts: {},
    reportedTotal: null,
    rates: { base: null, overtime: null },
    ...over,
  }
}

describe('resolveAttrsAt', () => {
  const e = entry({
    attrs: [
      { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
      { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
    ],
  })

  it('対象月の末日時点で最新の行を返す', () => {
    expect(resolveAttrsAt(e, '2025-06')).toEqual(e.attrs[0])
    expect(resolveAttrsAt(e, '2026-12')).toEqual(e.attrs[1])
  })

  it('全て未来なら null', () => {
    expect(resolveAttrsAt(entry({ attrs: [{ effectiveFrom: '2026-04-01', branch: null, payScheme: null }] }), '2025-01')).toBeNull()
  })

  it('attrs が空なら null', () => {
    expect(resolveAttrsAt(entry({ attrs: [] }), '2026-01')).toBeNull()
  })

  it('yearMonth が不正な形式・範囲外なら null', () => {
    expect(resolveAttrsAt(e, '2026-1')).toBeNull()
    expect(resolveAttrsAt(e, '2026-13')).toBeNull()
  })

  it('未整列でも有効な最新行を正しく選ぶ', () => {
    const unsorted = entry({
      attrs: [
        { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
        { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
      ],
    })
    expect(resolveAttrsAt(unsorted, '2026-12')).toEqual(unsorted.attrs[0])
  })
})

describe('buildCdMapEntries', () => {
  it('driverCd がある行だけ SalaryCdMap 形に変換する', () => {
    const out = buildCdMapEntries([
      entry({ company: '株', payrollCd: '7', name: '山田太郎', driverCd: '99' }),
      entry({ company: '有', payrollCd: '1', name: '鈴木花子', driverCd: null }),
    ])
    expect(out.entries).toEqual({ '株|7|山田太郎': '99' })
  })

  it('空配列は空の entries', () => {
    expect(buildCdMapEntries([])).toEqual({ entries: {} })
  })
})

describe('splitCdMapKey', () => {
  it('3部キーを company/payrollCd/name に分解する', () => {
    expect(splitCdMapKey('株|7|山田太郎')).toEqual({ company: '株', payrollCd: '7', name: '山田太郎' })
  })

  it('氏名に | を含む3部超キーは company を先頭、残りを氏名として結合する', () => {
    expect(splitCdMapKey('株|7|山田|太郎')).toEqual({ company: '株', payrollCd: '7', name: '山田|太郎' })
  })

  it('2部キー (旧形式、会社ラベル無し) は company を空文字にする', () => {
    expect(splitCdMapKey('7|山田太郎')).toEqual({ company: '', payrollCd: '7', name: '山田太郎' })
  })

  it('1部しかない不正な形式でも欠けたフィールドは空文字にする', () => {
    expect(splitCdMapKey('7')).toEqual({ company: '', payrollCd: '7', name: '' })
  })
})

describe('findUnregistered', () => {
  it('社員マスタに (company, payrollCd) が無い CSV 行を列挙する', () => {
    const out = findUnregistered(
      [csvRow({ company: '株', cdKey: '7', driverName: '山田太郎' }), csvRow({ company: '有', cdKey: '1', driverName: '鈴木花子' })],
      [entry({ company: '株', payrollCd: '7' })],
    )
    expect(out).toEqual([{ company: '有', payrollCd: '1', name: '鈴木花子' }])
  })

  it('既に登録済み (driverCd 未設定でも company+payrollCd が一致) なら除外する', () => {
    const out = findUnregistered(
      [csvRow({ company: '株', cdKey: '7' })],
      [entry({ company: '株', payrollCd: '7', driverCd: null })],
    )
    expect(out).toEqual([])
  })

  it('同じ (company, payrollCd) の重複行は1件にまとめる', () => {
    const out = findUnregistered(
      [csvRow({ company: '株', cdKey: '7', driverName: '山田太郎' }), csvRow({ company: '株', cdKey: '7', driverName: '山田太郎' })],
      [],
    )
    expect(out).toEqual([{ company: '株', payrollCd: '7', name: '山田太郎' }])
  })

  it('CSV 行が無ければ空配列', () => {
    expect(findUnregistered([], [])).toEqual([])
  })

  it('company が未設定 (空文字) の行は除外する (D1 の PK は company 非空必須)', () => {
    expect(findUnregistered([csvRow({ company: '', cdKey: '7', driverName: '山田太郎' })], [])).toEqual([])
  })
})
