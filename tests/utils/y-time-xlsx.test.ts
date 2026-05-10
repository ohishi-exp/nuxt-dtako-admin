/**
 * Pure logic tests for `app/utils/y-time-xlsx.ts`.
 *
 * - `normalizeDateCell` の Excel serial / Date / 文字列 サポート
 * - `buildDateRowIndex` がテンプレ A 列を読み取って Map を返す
 * - `writeYTimeRows` が C/F/G/H/I 列を書き込み、24h+ 表記が numeric として保存される
 * - 数式 (M 列) が overwrite で破壊されないこと (round-trip)
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Workbook } from 'exceljs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  normalizeDateCell,
  buildDateRowIndex,
  writeYTimeRows,
  buildFilename,
} from '../../app/utils/y-time-xlsx'
import type { YTimeRow } from '../../app/types'

const FIXTURE_PATH = resolve(__dirname, '../fixtures/y-time-template-minimal.xlsx')

let templateBytes: ArrayBuffer

beforeAll(() => {
  const buf = readFileSync(FIXTURE_PATH)
  // Buffer → ArrayBuffer (slice で view ではなく独立コピー)
  templateBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
})

/**
 * ExcelJS は `[h]:mm` numFmt のセルを読み戻す時に **Date instance** に変換する
 * (Excel 1900 epoch を起点とした OADate 表現を Date に変換)。
 *
 * 元の fractional-day 値を取り出すには:
 *   ms_since_excel_epoch / 86400000
 * で割り戻す。
 */
function asFractionalDay(value: unknown): number {
  if (typeof value === 'number') return value
  if (value instanceof Date) {
    // Excel epoch (ExcelJS): 1899-12-30 00:00:00 UTC
    const epochMs = Date.UTC(1899, 11, 30)
    return (value.getTime() - epochMs) / 86400000
  }
  throw new Error(`expected number or Date, got ${typeof value}: ${String(value)}`)
}

describe('normalizeDateCell', () => {
  it('parses Date instance', () => {
    expect(normalizeDateCell(new Date(Date.UTC(2024, 3, 15)))).toBe('2024-04-15')
  })

  it('parses Excel serial number (1899-12-30 epoch)', () => {
    // Excel serial 45397 = 2024-04-15 (per LibreOffice / Excel both)
    expect(normalizeDateCell(45397)).toBe('2024-04-15')
  })

  it('parses yyyy/mm/dd string', () => {
    expect(normalizeDateCell('2024/04/15')).toBe('2024-04-15')
    expect(normalizeDateCell('2024/4/15')).toBe('2024-04-15')
  })

  it('parses yyyy-mm-dd string', () => {
    expect(normalizeDateCell('2024-04-15')).toBe('2024-04-15')
  })

  it('returns null for unsupported input', () => {
    expect(normalizeDateCell(null)).toBeNull()
    expect(normalizeDateCell(undefined)).toBeNull()
    expect(normalizeDateCell('')).toBeNull()
    expect(normalizeDateCell({})).toBeNull()
    expect(normalizeDateCell('not a date')).toBeNull()
  })

  it('unwraps formula result', () => {
    expect(normalizeDateCell({ result: '2024/04/15' })).toBe('2024-04-15')
  })

  it('unwraps richText / text wrapper', () => {
    expect(normalizeDateCell({ text: '2024-04-15' })).toBe('2024-04-15')
  })
})

describe('buildDateRowIndex', () => {
  it('builds map of yyyy-mm-dd → row from fixture', async () => {
    const wb = new Workbook()
    await wb.xlsx.load(templateBytes)
    const ws = wb.getWorksheet('Y時間')!
    const idx = buildDateRowIndex(ws)
    // Fixture has 30 days starting 2024-04-01 → rows 2..31
    expect(idx.size).toBe(30)
    expect(idx.get('2024-04-01')).toBe(2)
    expect(idx.get('2024-04-15')).toBe(16)
    expect(idx.get('2024-04-30')).toBe(31)
  })

  it('respects maxScanRows cap', async () => {
    const wb = new Workbook()
    await wb.xlsx.load(templateBytes)
    const ws = wb.getWorksheet('Y時間')!
    const idx = buildDateRowIndex(ws, 5)
    // Only rows 2..5 scanned → 4 entries
    expect(idx.size).toBe(4)
  })
})

describe('writeYTimeRows', () => {
  it('writes C/F/G/H/I cells with numeric fractional-day encoding', async () => {
    const rows: YTimeRow[] = [
      {
        date: '2024-04-15',
        previous_day_start: false,
        start_minutes_of_day: 8 * 60 + 30, // 8:30
        end_minutes_from_bucket_date: 17 * 60, // 17:00
        rest_minutes: 60,
        note: '通常勤務',
      },
    ]
    const result = await writeYTimeRows(templateBytes, rows)
    expect(result.missingDates).toEqual([])
    expect(result.dateRowIndexSize).toBe(30)

    // Round-trip: reload and verify
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExcelJS's Buffer typing clashes with Node 20+ Buffer<ArrayBuffer> shape
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    const row16 = ws.getRow(16) // 2024-04-15

    expect(row16.getCell(3).value).toBe('通常勤務') // C
    expect(row16.getCell(6).value).toBeFalsy() // F は previous_day_start=false なので空
    expect(asFractionalDay(row16.getCell(7).value)).toBeCloseTo((8 * 60 + 30) / 1440, 6) // G
    expect(asFractionalDay(row16.getCell(8).value)).toBeCloseTo((17 * 60) / 1440, 6) // H
    expect(asFractionalDay(row16.getCell(9).value)).toBeCloseTo(60 / 1440, 6) // I
  })

  it('writes F=1 for previous_day_start segment with 24h+ end value', async () => {
    const rows: YTimeRow[] = [
      {
        date: '2024-04-16',
        previous_day_start: true,
        start_minutes_of_day: 22 * 60 + 30, // 22:30 (前日)
        end_minutes_from_bucket_date: 9 * 60 + 30, // 9:30 (当日)
        rest_minutes: 30,
        note: null,
      },
    ]
    const result = await writeYTimeRows(templateBytes, rows)
    expect(result.missingDates).toEqual([])

    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExcelJS's Buffer typing clashes with Node 20+ Buffer<ArrayBuffer> shape
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    const row17 = ws.getRow(17) // 2024-04-16

    expect(row17.getCell(6).value).toBe(1) // F=1
    expect(asFractionalDay(row17.getCell(7).value)).toBeCloseTo((22 * 60 + 30) / 1440, 6)
    expect(asFractionalDay(row17.getCell(8).value)).toBeCloseTo((9 * 60 + 30) / 1440, 6)
  })

  it('writes 24h+ end value as fractional day > 1', async () => {
    // 4/15 22:30 → 4/16 06:00、bucket=4/15 (1暦日2始業ではない場合)
    const rows: YTimeRow[] = [
      {
        date: '2024-04-15',
        previous_day_start: false,
        start_minutes_of_day: 22 * 60 + 30, // 22:30
        end_minutes_from_bucket_date: 30 * 60, // 30:00 (翌 6:00)
        rest_minutes: 0,
        note: null,
      },
    ]
    const result = await writeYTimeRows(templateBytes, rows)
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExcelJS's Buffer typing clashes with Node 20+ Buffer<ArrayBuffer> shape
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    const row16 = ws.getRow(16)
    // H = 30/24 = 1.25 (24h越え: fractional-day > 1)
    const h = asFractionalDay(row16.getCell(8).value)
    expect(h).toBeCloseTo(1.25, 6)
    expect(h).toBeGreaterThan(1.0)
  })

  it('preserves M column formula after overwrite (round-trip)', async () => {
    const rows: YTimeRow[] = [
      {
        date: '2024-04-15',
        previous_day_start: false,
        start_minutes_of_day: 8 * 60,
        end_minutes_from_bucket_date: 17 * 60,
        rest_minutes: 60,
        note: null,
      },
    ]
    const result = await writeYTimeRows(templateBytes, rows)
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExcelJS's Buffer typing clashes with Node 20+ Buffer<ArrayBuffer> shape
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    const row16 = ws.getRow(16)
    const m = row16.getCell(13).value
    // ExcelJS は formula を `{ formula: 'H16-G16-I16', result?: ... }` 形式で保持する
    expect(m).toBeTypeOf('object')
    expect((m as { formula?: string }).formula).toBe('H16-G16-I16')
  })

  it('reports missingDates when row.date not in template', async () => {
    const rows: YTimeRow[] = [
      {
        date: '2099-12-31',
        previous_day_start: false,
        start_minutes_of_day: 0,
        end_minutes_from_bucket_date: 0,
        rest_minutes: 0,
        note: null,
      },
    ]
    const result = await writeYTimeRows(templateBytes, rows)
    expect(result.missingDates).toEqual(['2099-12-31'])
  })

  it('throws when sheet "Y時間" missing', async () => {
    const wb = new Workbook()
    wb.addWorksheet('Other')
    // ExcelJS の writeBuffer 戻り値の型は環境差で `Buffer | Uint8Array | ArrayBuffer` になりうる。
    // ランタイム的にはどれも Uint8Array 互換なので、ここでは `as Uint8Array` 経由で
    // ArrayBuffer を取り出す。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = (await wb.xlsx.writeBuffer()) as any
    const u8 = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer)
    const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer

    await expect(writeYTimeRows(buf, [])).rejects.toThrow(/Y時間/)
  })

  it('handles empty rows array (returns template unchanged)', async () => {
    const result = await writeYTimeRows(templateBytes, [])
    expect(result.missingDates).toEqual([])
    expect(result.bytes.byteLength).toBeGreaterThan(0)
  })
})

describe('buildFilename', () => {
  it('produces a clean filename', () => {
    expect(buildFilename('D001', '2024-04-01', '2024-04-30'))
      .toBe('y_time_D001_2024-04-01_2024-04-30.xlsx')
  })

  it('sanitizes driver_cd of unsafe chars', () => {
    expect(buildFilename('D/001 ?', '2024-04-01', '2024-04-30'))
      .toBe('y_time_D_001___2024-04-01_2024-04-30.xlsx')
  })
})
