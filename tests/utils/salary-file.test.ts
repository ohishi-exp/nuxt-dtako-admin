/**
 * `app/utils/salary-file.ts` のテスト (Refs #253)。
 *
 * - XLS (Excel 97 / BIFF8) / XLSX はメモリ上で SheetJS write → salaryFileToText の
 *   ラウンドトリップで検証する (実給与データはコミットしない)
 * - テキストは UTF-8 / Shift_JIS のデコードを検証する
 */

import { describe, it, expect } from 'vitest'
import { utils, write } from 'xlsx'
import { decodeCsvBytes, salaryFileToText } from '../../app/utils/salary-file'
import { parseSalaryCsv } from '../../app/utils/salary-compare'

const AOA = [
  ['社員コード', '社員名', '給与・賞与名', '【 支給 】', '基本給', '残業手当', '支給合計額', '【 控除 】'],
  ['1239', '城田　秀幸', '2026年 1月', '', 80938, 161630, 242568, ''],
  ['1240', '山田 太郎', '2026年 2月', '', 70000, 20000, 90000, ''],
]

function workbookBytes(bookType: 'xls' | 'xlsx'): Uint8Array {
  const ws = utils.aoa_to_sheet(AOA)
  const wb = utils.book_new()
  utils.book_append_sheet(wb, ws, 'Sheet1')
  return new Uint8Array(write(wb, { bookType, type: 'array' }) as ArrayBuffer)
}

// '社員コード,給与・賞与名,【 支給 】,基本給,残業手当,支給合計額,【 控除 】\r\n
//  1239,2026年 1月,,80938,161630,242568,\r\n' を Shift_JIS でエンコードしたバイト列
const SJIS_BYTES = new Uint8Array([
  0x8E, 0xD0, 0x88, 0xF5, 0x83, 0x52, 0x81, 0x5B, 0x83, 0x68, 0x2C, 0x8B, 0x8B, 0x97, 0x5E, 0x81,
  0x45, 0x8F, 0xDC, 0x97, 0x5E, 0x96, 0xBC, 0x2C, 0x81, 0x79, 0x20, 0x8E, 0x78, 0x8B, 0x8B, 0x20,
  0x81, 0x7A, 0x2C, 0x8A, 0xEE, 0x96, 0x7B, 0x8B, 0x8B, 0x2C, 0x8E, 0x63, 0x8B, 0xC6, 0x8E, 0xE8,
  0x93, 0x96, 0x2C, 0x8E, 0x78, 0x8B, 0x8B, 0x8D, 0x87, 0x8C, 0x76, 0x8A, 0x7A, 0x2C, 0x81, 0x79,
  0x20, 0x8D, 0x54, 0x8F, 0x9C, 0x20, 0x81, 0x7A, 0x0D, 0x0A, 0x31, 0x32, 0x33, 0x39, 0x2C, 0x32,
  0x30, 0x32, 0x36, 0x94, 0x4E, 0x20, 0x31, 0x8C, 0x8E, 0x2C, 0x2C, 0x38, 0x30, 0x39, 0x33, 0x38,
  0x2C, 0x31, 0x36, 0x31, 0x36, 0x33, 0x30, 0x2C, 0x32, 0x34, 0x32, 0x35, 0x36, 0x38, 0x2C, 0x0D,
  0x0A,
])

describe('decodeCsvBytes', () => {
  it('UTF-8 (BOM つき) をデコードする', () => {
    const text = decodeCsvBytes(new TextEncoder().encode('﻿社員コード,x'))
    expect(text).toBe('社員コード,x')
  })

  it('UTF-8 として不正なバイト列は Shift_JIS でデコードする', () => {
    const text = decodeCsvBytes(SJIS_BYTES)
    expect(text.startsWith('社員コード,給与・賞与名')).toBe(true)
  })
})

describe('salaryFileToText', () => {
  it('XLS (Excel 97 バイナリ) を CSV テキスト化して解析できる', () => {
    const parsed = parseSalaryCsv(salaryFileToText(workbookBytes('xls')))
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[0]!.driverCd).toBe('1239')
    expect(parsed.rows[0]!.month).toBe('2026-01')
    expect(parsed.rows[0]!.amounts).toEqual({ 基本給: 80938, 残業手当: 161630 })
    expect(parsed.rows[0]!.reportedTotal).toBe(242568)
    expect(parsed.rows[1]!.month).toBe('2026-02')
  })

  it('XLSX (ZIP) も CSV テキスト化して解析できる', () => {
    const parsed = parseSalaryCsv(salaryFileToText(workbookBytes('xlsx')))
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.rows[1]!.amounts).toEqual({ 基本給: 70000, 残業手当: 20000 })
  })

  it('テキストファイル (Shift_JIS CSV) はデコードして返す', () => {
    const parsed = parseSalaryCsv(salaryFileToText(SJIS_BYTES))
    expect(parsed.rows).toHaveLength(1)
    expect(parsed.rows[0]!.amounts).toEqual({ 基本給: 80938, 残業手当: 161630 })
  })

  it('UTF-8 テキストもそのまま返す (マジックバイト不一致)', () => {
    const text = salaryFileToText(new TextEncoder().encode('社員コード,x'))
    expect(text).toBe('社員コード,x')
  })
})
