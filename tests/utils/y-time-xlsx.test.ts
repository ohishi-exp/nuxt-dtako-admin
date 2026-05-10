/**
 * Pure logic tests for `app/utils/y-time-xlsx.ts`.
 *
 * - `normalizeDateCell` の Excel serial / Date / 文字列 サポート
 * - `buildDateRowIndex` がテンプレ A 列を読み取って Map を返す
 * - `writeYTimeRows` が C/F/G/H/I 列を書き込み、24h+ 表記が numeric として保存される
 * - 数式 (M 列) が overwrite で破壊されないこと (round-trip)
 * - `clearPeriod` option で期間内 F-O を null クリアし、C/D/E と P-X (formula) を保護する
 */

import { describe, it, expect, beforeAll } from 'vitest'
import { Workbook } from 'exceljs'
import type ExcelJSNs from 'exceljs'
import JSZip from 'jszip'
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
 * JSZip でテンプレ xlsx から指定 sheet の xml 文字列を取り出す test ヘルパー。
 * fixture は単一 sheet (Y時間 = sheet1.xml) なので path 解決を簡略化。
 */
async function loadSheetXml(bytes: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes)
  const entry = zip.file('xl/worksheets/sheet1.xml')
  if (!entry) throw new Error('sheet1.xml missing')
  return entry.async('string')
}

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

/** 7-cell rest split で全部 0 (= writeRest が skip) のオブジェクトを返す。 */
function zeroRest(): Pick<
  YTimeRow,
  | 'rest_prev_5_22'
  | 'rest_prev_22_0'
  | 'rest_today_0_5'
  | 'rest_today_5_22'
  | 'rest_today_22_0'
  | 'rest_next_0_5'
  | 'rest_next_5_22'
> {
  return {
    rest_prev_5_22: 0,
    rest_prev_22_0: 0,
    rest_today_0_5: 0,
    rest_today_5_22: 0,
    rest_today_22_0: 0,
    rest_next_0_5: 0,
    rest_next_5_22: 0,
  }
}

/**
 * 既存テンプレを in-memory ロードし、`fill` で任意のセルを焼いた "汚れたテンプレ"
 * バイナリを返す。fixture 本体は変更しない。
 */
async function makeTemplateWithCells(
  fill: (ws: ExcelJSNs.Worksheet) => void,
): Promise<ArrayBuffer> {
  const wb = new Workbook()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ExcelJS Buffer typing clash
  await wb.xlsx.load(Buffer.from(new Uint8Array(templateBytes)) as any)
  const ws = wb.getWorksheet('Y時間')!
  fill(ws)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- writeBuffer return type varies
  const out = (await wb.xlsx.writeBuffer()) as any
  const u8 = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer)
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
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
    const xml = await loadSheetXml(templateBytes)
    const idx = buildDateRowIndex(xml)
    // Fixture has 30 days starting 2024-04-01 → rows 2..31
    expect(idx.size).toBe(30)
    expect(idx.get('2024-04-01')).toBe(2)
    expect(idx.get('2024-04-15')).toBe(16)
    expect(idx.get('2024-04-30')).toBe(31)
  })

  it('respects maxScanRows cap', async () => {
    const xml = await loadSheetXml(templateBytes)
    const idx = buildDateRowIndex(xml, 5)
    // Only rows 2..5 scanned → 4 entries
    expect(idx.size).toBe(4)
  })

  it('parses string-formatted dates in <v> (yyyy-mm-dd / yyyy/mm/dd)', () => {
    const xml = [
      '<sheetData>',
      '<row r="2"><c r="A2"><v>2024-04-15</v></c></row>',
      '<row r="3"><c r="A3"><v>2024/04/16</v></c></row>',
      '<row r="4"><c r="A4"><v>not-a-date</v></c></row>',
      '<row r="5"><c r="A5"><v></v></c></row>',
      '</sheetData>',
    ].join('')
    const idx = buildDateRowIndex(xml)
    expect(idx.get('2024-04-15')).toBe(2)
    expect(idx.get('2024-04-16')).toBe(3)
    // 不正な値の row はスキップ
    expect(idx.size).toBe(2)
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
        ...zeroRest(),
        rest_prev_5_22: 60, // I 列 (前日 5-22) に 60 分
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
        ...zeroRest(),
        rest_prev_22_0: 30, // J 列 (前日 22-0) に 30 分
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
        ...zeroRest(),
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
    // 全 rest=0 (writeRest skip) なので M 列 (col 13 = rest_today_22_0) の数式は触られない
    const rows: YTimeRow[] = [
      {
        date: '2024-04-15',
        previous_day_start: false,
        start_minutes_of_day: 8 * 60,
        end_minutes_from_bucket_date: 17 * 60,
        ...zeroRest(),
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
        ...zeroRest(),
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

describe('writeYTimeRows clearPeriod option', () => {
  it('no-op when clearPeriod is undefined (テンプレ既存 F-O が残る)', async () => {
    // 4/15 (row 16) の F に 1 を焼いた汚れテンプレを作る
    const dirty = await makeTemplateWithCells((ws) => {
      ws.getRow(16).getCell(6).value = 1
    })
    // clearPeriod 未指定 + rows 空 → 既存値が触られないこと
    const result = await writeYTimeRows(dirty, [])
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    expect(ws.getRow(16).getCell(6).value).toBe(1)
  })

  it('clears F-O cells within the period (期間外は残る)', async () => {
    // 4/05 (row 6), 4/15 (row 16), 4/25 (row 26) の F-O に値を焼く
    const dirty = await makeTemplateWithCells((ws) => {
      for (const r of [6, 16, 26]) {
        const row = ws.getRow(r)
        row.getCell(6).value = 1 // F
        row.getCell(7).value = 9 / 24 // G 9:00
        row.getCell(8).value = 18 / 24 // H 18:00
        row.getCell(9).value = 30 / 1440 // I 30 min
        row.getCell(15).value = 15 / 1440 // O 15 min
      }
    })
    const result = await writeYTimeRows(dirty, [], {
      clearPeriod: { from: '2024-04-10', to: '2024-04-20' },
    })
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!

    // 4/15 (期間内) → F-O すべて空
    const inside = ws.getRow(16)
    for (let c = 6; c <= 15; c += 1) {
      expect(inside.getCell(c).value).toBeFalsy()
    }
    // 4/05 (期間外) → 残る
    expect(ws.getRow(6).getCell(6).value).toBe(1)
    expect(asFractionalDay(ws.getRow(6).getCell(9).value)).toBeCloseTo(30 / 1440, 6)
    // 4/25 (期間外) → 残る
    expect(ws.getRow(26).getCell(6).value).toBe(1)
    expect(asFractionalDay(ws.getRow(26).getCell(15).value)).toBeCloseTo(15 / 1440, 6)
  })

  it('clearPeriod then write overrides stale data (本質バグ回帰テスト)', async () => {
    // 4/15 (row 16) の I=30min, O=15min を焼く。rows は rest=0 なので writeRest が
    // skip → clearPeriod が無いと旧値が残る。clearPeriod がそれを潰すことを確認。
    const dirty = await makeTemplateWithCells((ws) => {
      const row = ws.getRow(16)
      row.getCell(6).value = 1 // F
      row.getCell(9).value = 30 / 1440 // I 30 min (stale)
      row.getCell(15).value = 15 / 1440 // O 15 min (stale)
    })
    const result = await writeYTimeRows(
      dirty,
      [
        {
          date: '2024-04-15',
          previous_day_start: false,
          start_minutes_of_day: 8 * 60,
          end_minutes_from_bucket_date: 17 * 60,
          ...zeroRest(),
          note: null,
        },
      ],
      { clearPeriod: { from: '2024-04-10', to: '2024-04-20' } },
    )
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    const row = ws.getRow(16)

    // G/H は新値で上書き
    expect(asFractionalDay(row.getCell(7).value)).toBeCloseTo((8 * 60) / 1440, 6)
    expect(asFractionalDay(row.getCell(8).value)).toBeCloseTo((17 * 60) / 1440, 6)
    // 旧 F=1 がクリアされている
    expect(row.getCell(6).value).toBeFalsy()
    // 旧 I (30 min) と O (15 min) がクリアされている
    expect(row.getCell(9).value).toBeFalsy()
    expect(row.getCell(15).value).toBeFalsy()
  })

  it('preserves columns outside F-O range (C / D / E / P / Q)', async () => {
    // C/D/E と P/Q (= col 16, 17) に値・数式を焼く。clearPeriod で全期間 clear 指定でも、
    // 範囲外 (col 6-15 の外) の列は触らないこと。
    const dirty = await makeTemplateWithCells((ws) => {
      const row = ws.getRow(16)
      row.getCell(3).value = '既存メモ' // C
      row.getCell(4).value = 99 // D
      row.getCell(5).value = 88 // E
      // P/Q に formula を焼く (集計数式の代理: 実テンプレでは P-X が SUM 等を持つ)
      row.getCell(16).value = { formula: 'H16+I16', result: 0 } as ExcelJSNs.CellFormulaValue
      row.getCell(17).value = { formula: 'G16*2', result: 0 } as ExcelJSNs.CellFormulaValue
    })
    const result = await writeYTimeRows(dirty, [], {
      clearPeriod: { from: '2024-04-01', to: '2024-04-30' },
    })
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    const row = ws.getRow(16)

    expect(row.getCell(3).value).toBe('既存メモ') // C 残る
    expect(row.getCell(4).value).toBe(99) // D 残る
    expect(row.getCell(5).value).toBe(88) // E 残る
    // P/Q: formula が `{ formula, result, ... }` 形で残ること
    const p = row.getCell(16).value
    const q = row.getCell(17).value
    expect((p as { formula?: string }).formula).toBe('H16+I16')
    expect((q as { formula?: string }).formula).toBe('G16*2')
  })

  it('replaces self-closing existing cell (clearPeriod → re-write F)', async () => {
    // 1) F16=1 を焼く (with-content)
    const dirty = await makeTemplateWithCells((ws) => {
      ws.getRow(16).getCell(6).value = 1
    })
    // 2) clearPeriod で F16 を self-closing 化
    // 3) writeRow で previous_day_start=true → F16=1 を再書き込み
    //    setCell が self-closing を見つけて preserveStyleAttr 経路を通る
    const result = await writeYTimeRows(
      dirty,
      [
        {
          date: '2024-04-15',
          previous_day_start: true,
          start_minutes_of_day: 8 * 60,
          end_minutes_from_bucket_date: 17 * 60,
          ...zeroRest(),
          note: null,
        },
      ],
      { clearPeriod: { from: '2024-04-10', to: '2024-04-20' } },
    )
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    expect(ws.getRow(16).getCell(6).value).toBe(1) // F=1 再書き込み
  })

  it('replaces existing cell preserving style attribute', async () => {
    // 4/15 の G/H に値 + style を焼く (writeRowInXml で既存セル置換パスを通す)
    const dirty = await makeTemplateWithCells((ws) => {
      ws.getRow(16).getCell(7).value = 9 / 24 // G 9:00 (with auto style)
      ws.getRow(16).getCell(8).value = 18 / 24 // H 18:00
    })
    const result = await writeYTimeRows(dirty, [
      {
        date: '2024-04-15',
        previous_day_start: false,
        start_minutes_of_day: 8 * 60,
        end_minutes_from_bucket_date: 17 * 60,
        ...zeroRest(),
        note: null,
      },
    ])
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    // G/H が新値 (8:00 / 17:00) に上書きされている
    expect(asFractionalDay(ws.getRow(16).getCell(7).value)).toBeCloseTo((8 * 60) / 1440, 6)
    expect(asFractionalDay(ws.getRow(16).getCell(8).value)).toBeCloseTo((17 * 60) / 1440, 6)
  })

  it('escapes XML special chars in note (& < > " \')', async () => {
    const result = await writeYTimeRows(templateBytes, [
      {
        date: '2024-04-15',
        previous_day_start: false,
        start_minutes_of_day: 8 * 60,
        end_minutes_from_bucket_date: 17 * 60,
        ...zeroRest(),
        note: 'A & B <c> "d" \'e\'',
      },
    ])
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    expect(ws.getRow(16).getCell(3).value).toBe('A & B <c> "d" \'e\'')
  })

  it('inclusive boundary at from and to (両端を clear)', async () => {
    // 4/01 (row 2、from ちょうど) と 4/30 (row 31、to ちょうど) の F に 1 焼く。
    // clearPeriod={from:4/01, to:4/30} で両方クリアされること (`<=` の確認)。
    const dirty = await makeTemplateWithCells((ws) => {
      ws.getRow(2).getCell(6).value = 1 // 4/01
      ws.getRow(31).getCell(6).value = 1 // 4/30
    })
    const result = await writeYTimeRows(dirty, [], {
      clearPeriod: { from: '2024-04-01', to: '2024-04-30' },
    })
    const wb = new Workbook()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await wb.xlsx.load(Buffer.from(result.bytes) as any)
    const ws = wb.getWorksheet('Y時間')!
    expect(ws.getRow(2).getCell(6).value).toBeFalsy() // from 境界
    expect(ws.getRow(31).getCell(6).value).toBeFalsy() // to 境界
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
