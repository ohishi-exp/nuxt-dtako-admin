/**
 * Y時間 シート書き込みの pure ロジック。
 *
 * - テンプレ xlsx (`ArrayBuffer`) と `YTimeRow[]` を受け取り、書き込み済みバイナリを返す。
 * - server route と vitest の両方から呼ばれる (Worker と Node 環境で同じ ExcelJS が動く)。
 *
 * テンプレ要件:
 * - シート名 `Y時間` が存在
 * - 1 行目はヘッダー
 * - 2 行目以降の A 列に対応する年月日 (Excel serial 数値 / Date instance / yyyy/mm/dd 文字列) が入っている
 * - G/H/I 列に `[h]:mm` の number_format が pre-applied (24h 超表示のため)
 *
 * 書き込みは C/F/G/H/I 列のみ。D 列 (法定休日) は要素シート由来で触らない。
 * 数値は `分 / 1440` の fractional-day で書く (テンプレの `[h]:mm` を維持)。
 */

import { Workbook, type Worksheet } from 'exceljs'
import type { YTimeRow } from '~/types'

const SHEET_NAME = 'Y時間'
const COL_NOTE = 3 // C
const COL_PREV_DAY = 6 // F
const COL_START = 7 // G
const COL_END = 8 // H
const COL_REST = 9 // I

export interface WriteOptions {
  /** A 列の検索を打ち切る最大行数。template の物理行数が分からない時の保険 (default 1000) */
  maxScanRows?: number
}

export interface WriteResult {
  bytes: Uint8Array
  /** 書き込めなかった row.date のリスト (テンプレに対応行が無い場合) */
  missingDates: string[]
  /** テンプレ A 列スキャン後の row 番号 index (デバッグ用) */
  dateRowIndexSize: number
}

/**
 * 列 A の 1 セルを `yyyy-mm-dd` 文字列に正規化。
 * Excel serial / Date / 文字列 の 3 形式をサポート。
 *
 * Excel serial date は 1899-12-30 起点 (Excel 1900 leap year bug を補正)。
 */
export function normalizeDateCell(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return formatYmd(value)
  }
  if (typeof value === 'number') {
    // Excel serial → Date
    const epochMs = Date.UTC(1899, 11, 30) // 1899-12-30
    const ms = epochMs + value * 86400 * 1000
    const d = new Date(ms)
    return formatYmd(d)
  }
  if (typeof value === 'string') {
    const s = value.trim()
    // 1) yyyy/mm/dd or yyyy-mm-dd
    const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    if (m) {
      const [, y, mo, da] = m
      return `${y}-${pad(Number(mo))}-${pad(Number(da))}`
    }
  }
  if (typeof value === 'object' && value !== null) {
    // ExcelJS richText / formula 結果
    const obj = value as { result?: unknown; text?: unknown }
    if (obj.result != null) return normalizeDateCell(obj.result)
    if (obj.text != null) return normalizeDateCell(obj.text)
  }
  return null
}

function formatYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

/** ワークシートの A 列を走査して `yyyy-mm-dd` → row 番号の Map を作る */
export function buildDateRowIndex(
  ws: Worksheet,
  maxScanRows = 1000,
): Map<string, number> {
  const idx = new Map<string, number>()
  const lastRow = Math.min(ws.actualRowCount || maxScanRows, maxScanRows)
  for (let r = 2; r <= lastRow; r += 1) {
    const cell = ws.getCell(r, 1)
    const ymd = normalizeDateCell(cell.value)
    if (ymd && !idx.has(ymd)) {
      idx.set(ymd, r)
    }
  }
  return idx
}

/**
 * テンプレに rows を書き込んで bytes を返す。
 *
 * - rows.date が A 列に無い場合は missingDates に積む
 * - C/F/G/H/I のみ書き換え、D は触らない
 * - G/H/I は `分 / 1440` で numeric セルに上書き (template の number_format 維持)
 */
export async function writeYTimeRows(
  templateBytes: ArrayBuffer,
  rows: YTimeRow[],
  opts: WriteOptions = {},
): Promise<WriteResult> {
  const wb = new Workbook()
  await wb.xlsx.load(templateBytes)
  const ws = wb.getWorksheet(SHEET_NAME)
  if (!ws) {
    throw new Error(`sheet "${SHEET_NAME}" not found in template`)
  }

  const idx = buildDateRowIndex(ws, opts.maxScanRows)
  const missingDates: string[] = []

  for (const r of rows) {
    const rowNum = idx.get(r.date)
    if (!rowNum) {
      missingDates.push(r.date)
      continue
    }
    const row = ws.getRow(rowNum)
    if (r.note != null) {
      row.getCell(COL_NOTE).value = r.note
    }
    if (r.previous_day_start) {
      row.getCell(COL_PREV_DAY).value = 1
    }
    row.getCell(COL_START).value = r.start_minutes_of_day / 1440
    row.getCell(COL_END).value = r.end_minutes_from_bucket_date / 1440
    row.getCell(COL_REST).value = r.rest_minutes / 1440
  }

  const out = await wb.xlsx.writeBuffer()
  // ExcelJS returns Buffer (Node) or ArrayBuffer; normalize to Uint8Array.
  const bytes = out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBuffer)
  return { bytes, missingDates, dateRowIndexSize: idx.size }
}

/** ファイル名生成 (driver_cd / 期間ベース) */
export function buildFilename(driverCd: string, from: string, to: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
  return `y_time_${safe(driverCd)}_${from}_${to}.xlsx`
}
