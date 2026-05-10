/**
 * Y時間 シート書き込みの pure ロジック (JSZip + 直接 XML 書き換え方式)。
 *
 * - テンプレ xlsx (`ArrayBuffer`) と `YTimeRow[]` を受け取り、書き込み済みバイナリを返す。
 * - server route と vitest の両方から呼ばれる (Worker と Node 環境で同じ jszip が動く)。
 *
 * ## なぜ JSZip 直接書き換えか
 *
 * 旧実装は ExcelJS で全 sheet を JS オブジェクトに parse → 書き換え → 全 sheet 再 serialize
 * していた。この **再 serialize が Excel の厳密な OOXML 期待と微妙にズレる** ため、触っ
 * ていない sheet (要素 / X時間 / 他多数) まで「修復されたレコード」警告対象になっていた。
 *
 * 本実装は JSZip で xlsx zip を unzip → **対象 sheet xml の対象セル文字列だけ置換** →
 * re-zip する。他 sheet xml / styles.xml / sharedStrings.xml は byte 一致で残るので、
 * Excel の警告 trigger 範囲が劇的に縮む (POC 検証で 0 件達成)。
 *
 * テンプレ要件:
 * - シート名 `Y時間` が存在
 * - A 列に Excel serial の日付値 (`<v>45397</v>` 等) が入っている
 *   - formula 駆動 (`<f>要素!F3</f><v>44986</v>`) でも cached `<v>` を読むので OK
 *   - プレーン (`<c r="A2" s="2"><v>45383</v></c>`) も OK
 *
 * 書き込み列:
 * - C: 備考 (inline string)
 * - F: 前日 flag (1)
 * - G: 始業時刻 (fractional-day)
 * - H: 終業時刻 (fractional-day, 24h+ も許容)
 * - I-O: 休憩 7 セル split (fractional-day、0 のときはテンプレ既存値を尊重)
 * - D/E (法定休日 / 所定労働時間 数式)、P-X (集計数式) は**触らない**
 */

import JSZip from 'jszip'
import type { YTimeRow } from '~/types'

const SHEET_NAME = 'Y時間'

const COL_NOTE = 'C' // 備考
// テンプレ数式 (AB7=IF(F7=1,0,G7), AC7=IF(F7=1,H7,...)) より:
// F=前日 flag、G=始業、H=終業
const COL_PREV_DAY = 'F'
const COL_START = 'G'
const COL_END = 'H'
// I-O: 休憩時間 7 セル split (前日5-22 / 前日22-0 / 当日0-5 / 当日5-22 / 当日22-0 / 翌日0-5 / 翌日5-22)
const COL_REST_PREV_5_22 = 'I'
const COL_REST_PREV_22_0 = 'J'
const COL_REST_TODAY_0_5 = 'K'
const COL_REST_TODAY_5_22 = 'L'
const COL_REST_TODAY_22_0 = 'M'
const COL_REST_NEXT_0_5 = 'N'
const COL_REST_NEXT_5_22 = 'O'

/** clearPeriod でクリアする列。F-O = 前日 flag + 始業/終業 + 休憩 7 セル */
const CLEAR_COLS: readonly string[] = [
  COL_PREV_DAY, COL_START, COL_END,
  COL_REST_PREV_5_22, COL_REST_PREV_22_0,
  COL_REST_TODAY_0_5, COL_REST_TODAY_5_22, COL_REST_TODAY_22_0,
  COL_REST_NEXT_0_5, COL_REST_NEXT_5_22,
]

export interface WriteOptions {
  /** A 列の検索を打ち切る最大行数 (default 5000)。本番テンプレは 2106 行なので余裕の値 */
  maxScanRows?: number
  /**
   * 指定した期間内 (inclusive) の row の F-O 列を書き込み前にクリアする。
   * テンプレに残った前回出力データを除去するため。
   *
   * - `from` / `to` は `yyyy-mm-dd`
   * - C 列 (備考)、D/E 列 (数式)、P-X 列 (集計数式) は触らない
   * - 期間外の row は触らない
   * - `from > to` (逆順) や該当 row なしの場合は no-op
   */
  clearPeriod?: { from: string; to: string }
}

export interface WriteResult {
  bytes: Uint8Array
  /** 書き込めなかった row.date のリスト (テンプレに対応行が無い場合) */
  missingDates: string[]
  /** テンプレ A 列スキャン後の row 番号 index size (デバッグ用) */
  dateRowIndexSize: number
}

/**
 * テンプレに rows を書き込んで bytes を返す。
 *
 * - rows.date が A 列に無い場合は missingDates に積む
 * - C/F/G/H/I-O のみ書き換え、D/E/P-X (formula 列) は触らない
 * - G/H/I-O は `分 / 1440` で numeric セルに上書き (template の number_format 維持)
 * - C は inline string で書き込み (sharedStrings.xml を触らない)
 */
export async function writeYTimeRows(
  templateBytes: ArrayBuffer,
  rows: YTimeRow[],
  opts: WriteOptions = {},
): Promise<WriteResult> {
  const zip = await JSZip.loadAsync(templateBytes)

  const sheetPath = await resolveSheetPath(zip, SHEET_NAME)
  if (!sheetPath) {
    throw new Error(`sheet "${SHEET_NAME}" not found in template`)
  }

  const sheetEntry = zip.file(sheetPath)
  if (!sheetEntry) {
    throw new Error(`sheet xml not found at ${sheetPath}`)
  }
  let xml = await sheetEntry.async('string')

  const idx = buildDateRowIndex(xml, opts.maxScanRows)
  const missingDates: string[] = []

  // 期間内 F-O をクリア (rows ループの前に行う)
  xml = clearPeriodInXml(xml, idx, opts.clearPeriod)

  for (const r of rows) {
    const rowNum = idx.get(r.date)
    if (!rowNum) {
      missingDates.push(r.date)
      continue
    }
    xml = writeRowInXml(xml, rowNum, r)
  }

  zip.file(sheetPath, xml)

  // F-O 入力値を書き換えても、Excel は cached `<v>` 値が一致する限り P-X 等の数式を
  // 再計算しない (キャッシュを信用してしまう)。`<calcPr fullCalcOnLoad="1"/>` を立てる
  // と「開いた瞬間に全式を再計算する」モードになる → F2+Enter 不要。
  await ensureFullCalcOnLoad(zip)

  const out = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })

  // 型ナローイング (SharedArrayBuffer 由来でない純粋な ArrayBuffer Uint8Array にする)
  const buf = new ArrayBuffer(out.byteLength)
  new Uint8Array(buf).set(out)
  return {
    bytes: new Uint8Array(buf),
    missingDates,
    dateRowIndexSize: idx.size,
  }
}

/**
 * workbook.xml + workbook.xml.rels を引いてシート名 → sheet xml の path を解決する。
 *
 * - `<sheet name="Y時間" r:id="rIdN"/>` から rId を引き
 * - `<Relationship Id="rIdN" Target="worksheets/sheet5.xml"/>` から path を組み立てる
 */
async function resolveSheetPath(
  zip: JSZip,
  sheetName: string,
): Promise<string | null> {
  const wbEntry = zip.file('xl/workbook.xml')
  if (!wbEntry) return null
  const wbXml = await wbEntry.async('string')

  const sheetRe = new RegExp(
    `<sheet[^>]*\\bname="${escapeForRegex(escapeXml(sheetName))}"[^>]*\\br:id="([^"]+)"`,
  )
  const sheetMatch = sheetRe.exec(wbXml)
  if (!sheetMatch || !sheetMatch[1]) return null
  const rid = sheetMatch[1]

  const relsEntry = zip.file('xl/_rels/workbook.xml.rels')
  if (!relsEntry) return null
  const relsXml = await relsEntry.async('string')
  const relRe = new RegExp(
    `<Relationship[^>]*\\bId="${escapeForRegex(rid)}"[^>]*\\bTarget="([^"]+)"`,
  )
  const relMatch = relRe.exec(relsXml)
  if (!relMatch || !relMatch[1]) return null
  const target = relMatch[1].replace(/^\//, '')
  return target.startsWith('xl/') ? target : `xl/${target}`
}

/**
 * sheet xml の A 列を走査して `yyyy-mm-dd` → row 番号 Map を作る。
 *
 * `<c r="A{N}" ...><v>{serial}</v></c>` のキャッシュ済み serial 値を使うため、
 * formula 駆動 (`<f>要素!F3</f><v>44986</v>`) のテンプレでも動く。
 */
export function buildDateRowIndex(
  xml: string,
  maxScanRows = 5000,
): Map<string, number> {
  const idx = new Map<string, number>()
  const aCellRe = /<c r="A(\d+)"[^>]*>[\s\S]*?<v>([^<]+)<\/v>[\s\S]*?<\/c>/g
  for (const m of xml.matchAll(aCellRe)) {
    const rowStr = m[1]
    const rawV = m[2]
    if (!rowStr || rawV == null) continue
    const rowNum = parseInt(rowStr, 10)
    if (rowNum < 2 || rowNum > maxScanRows) continue
    const v = rawV.trim()
    if (!v) continue
    const ymd = parseDateValue(v)
    if (ymd && !idx.has(ymd)) {
      idx.set(ymd, rowNum)
    }
  }
  return idx
}

/**
 * セル `<v>` の中身を `yyyy-mm-dd` に正規化。
 *
 * - 数値文字列なら Excel serial → 日付
 * - `yyyy-mm-dd` / `yyyy/mm/dd` 形式の文字列ならそのまま
 */
function parseDateValue(v: string): string | null {
  // Excel serial (数値)
  const num = parseFloat(v)
  if (!Number.isNaN(num) && /^-?\d+(\.\d+)?$/.test(v)) {
    return excelSerialToYmd(num)
  }
  // 文字列 (yyyy-mm-dd / yyyy/mm/dd)
  const m = v.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
  if (m) {
    const [, y, mo, da] = m
    return `${y}-${pad(Number(mo))}-${pad(Number(da))}`
  }
  return null
}

function excelSerialToYmd(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null
  const epochMs = Date.UTC(1899, 11, 30) // 1899-12-30 (Excel 1900 epoch + leap year bug 補正)
  const ms = epochMs + serial * 86400 * 1000
  const d = new Date(ms)
  return formatYmd(d)
}

function formatYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPE[c] ?? c)
}

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 期間内 row の F-O 列をクリア。
 * yyyy-mm-dd の文字列比較は暦順と一致するので、from/to は文字列で安全に比較できる。
 */
function clearPeriodInXml(
  xml: string,
  idx: Map<string, number>,
  clearPeriod: { from: string; to: string } | undefined,
): string {
  if (!clearPeriod) return xml
  const { from, to } = clearPeriod
  for (const [date, rowNum] of idx.entries()) {
    if (date < from || date > to) continue
    for (const col of CLEAR_COLS) {
      xml = clearCellValue(xml, col, rowNum)
    }
  }
  return xml
}

/**
 * 既存セルから value 部分を消して self-closing にする。style (`s="N"`) は保持。
 *
 * - `<c r="F7" s="103"><v>1</v></c>` → `<c r="F7" s="103"/>`
 * - `<c r="F7" s="103"/>` (元から空) → no-op
 * - 不在 → no-op
 *
 * 正規表現の `[^>/]*` で `/` を排除して self-closing パターン (`/>`) を誤マッチしない。
 * Excel の cell 属性値に `/` が現れることはまず無い (style index は数値、type は短い文字列)。
 */
function clearCellValue(xml: string, col: string, rowNum: number): string {
  const cellRef = `${col}${rowNum}`
  const re = new RegExp(`<c r="${cellRef}"([^>/]*)>[\\s\\S]*?<\\/c>`)
  return xml.replace(re, (_full, attrs: string) => {
    return `<c r="${cellRef}"${attrs}/>`
  })
}

/** 1 行分の rows データを書き込み */
function writeRowInXml(xml: string, rowNum: number, r: YTimeRow): string {
  if (r.note != null) {
    xml = setCellInlineString(xml, COL_NOTE, rowNum, r.note)
  }
  if (r.previous_day_start) {
    xml = setCellNumber(xml, COL_PREV_DAY, rowNum, 1)
  }
  xml = setCellNumber(xml, COL_START, rowNum, r.start_minutes_of_day / 1440)
  xml = setCellNumber(xml, COL_END, rowNum, r.end_minutes_from_bucket_date / 1440)
  // 休憩 7 セル: 0 ならテンプレ既存値を尊重 (clearPeriod 後は self-closing になっているはず)
  xml = writeRest(xml, COL_REST_PREV_5_22, rowNum, r.rest_prev_5_22)
  xml = writeRest(xml, COL_REST_PREV_22_0, rowNum, r.rest_prev_22_0)
  xml = writeRest(xml, COL_REST_TODAY_0_5, rowNum, r.rest_today_0_5)
  xml = writeRest(xml, COL_REST_TODAY_5_22, rowNum, r.rest_today_5_22)
  xml = writeRest(xml, COL_REST_TODAY_22_0, rowNum, r.rest_today_22_0)
  xml = writeRest(xml, COL_REST_NEXT_0_5, rowNum, r.rest_next_0_5)
  xml = writeRest(xml, COL_REST_NEXT_5_22, rowNum, r.rest_next_5_22)
  return xml
}

function writeRest(
  xml: string,
  col: string,
  rowNum: number,
  minutes: number,
): string {
  if (minutes <= 0) return xml
  return setCellNumber(xml, col, rowNum, minutes / 1440)
}

/**
 * セルに数値を書き込む。既存セルがあれば値だけ置換 (style 保持)、なければ列順序を
 * 維持して新規挿入。
 */
function setCellNumber(
  xml: string,
  col: string,
  rowNum: number,
  num: number,
): string {
  return setCell(xml, col, rowNum, (style) => {
    return `<c r="${col}${rowNum}"${style}><v>${num}</v></c>`
  })
}

/**
 * セルに inline string を書き込む。既存セルがあれば値置換 (style 保持)、なければ
 * 列順序を維持して新規挿入。
 */
function setCellInlineString(
  xml: string,
  col: string,
  rowNum: number,
  str: string,
): string {
  const escaped = escapeXml(str)
  return setCell(xml, col, rowNum, (style) => {
    // t="inlineStr" を必ず付ける (style に既に t="..." が混じっていないこと前提)
    return `<c r="${col}${rowNum}"${style} t="inlineStr"><is><t>${escaped}</t></is></c>`
  })
}

/**
 * セルの存在を判定し、buildCell の結果で置換 or 新規挿入。
 *
 * - 既存 self-closing `<c r="X{N}" s="N"/>` → そのまま置換 (style 引き継ぎ)
 * - 既存 with content `<c r="X{N}" s="N">...</c>` → 置換 (style 引き継ぎ、t="..." は除去)
 * - 不在 → row 内のセル列を sort して新規挿入
 */
function setCell(
  xml: string,
  col: string,
  rowNum: number,
  buildCell: (preservedStyleAttr: string) => string,
): string {
  const cellRef = `${col}${rowNum}`

  // 1. 既存セル (self-closing) を先に試す: <c r="X{N}" attrs/>
  //    with-content regex `[^>]*?>` は `/` も食って self-closing と誤マッチするので、
  //    self-closing を先に消費する必要がある。
  const selfClosingRe = new RegExp(`<c r="${cellRef}"([^>]*?)\\/>`)
  const selfClosingMatch = selfClosingRe.exec(xml)
  if (selfClosingMatch) {
    const style = preserveStyleAttr(selfClosingMatch[1] ?? '')
    return xml.replace(selfClosingRe, buildCell(style))
  }

  // 2. 既存セル (with content): <c r="X{N}" attrs>...</c>
  const withContentRe = new RegExp(
    `<c r="${cellRef}"([^>]*?)>[\\s\\S]*?<\\/c>`,
  )
  const withContentMatch = withContentRe.exec(xml)
  if (withContentMatch) {
    const style = preserveStyleAttr(withContentMatch[1] ?? '')
    return xml.replace(withContentRe, buildCell(style))
  }

  // 3. 不在 → row 内に挿入
  return insertCellInRow(xml, col, rowNum, buildCell(''))
}

/** attrs から `s="N"` だけ抽出して " s=\"N\"" の形で返す。t="..." 等他の attr は除去 */
function preserveStyleAttr(attrs: string): string {
  const m = /\bs="(\d+)"/.exec(attrs)
  return m ? ` s="${m[1]}"` : ''
}

/** row の中にセルを列順序で挿入 (既存セルとの順序維持) */
function insertCellInRow(
  xml: string,
  col: string,
  rowNum: number,
  cellXml: string,
): string {
  const rowRe = new RegExp(`<row r="${rowNum}"([^>]*)>([\\s\\S]*?)<\\/row>`)
  return xml.replace(rowRe, (_full, rowAttrs: string, rowInner: string) => {
    const cellRe = /<c r="([A-Z]+)\d+"[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g
    type Cell = { col: string; xml: string }
    const cells: Cell[] = []
    for (const m of rowInner.matchAll(cellRe)) {
      const c = m[1]
      if (!c) continue
      cells.push({ col: c, xml: m[0] })
    }
    cells.push({ col, xml: cellXml })
    cells.sort((a, b) => compareColLetters(a.col, b.col))
    const newInner = cells.map((c) => c.xml).join('')
    return `<row r="${rowNum}"${rowAttrs}>${newInner}</row>`
  })
}

/**
 * `xl/workbook.xml` の `<calcPr ...>` に `fullCalcOnLoad="1"` を立てる (なければ追加)。
 *
 * 入力値だけ書き換えても、Excel が cached `<v>` を信用して P-X 数式を再計算しない問題を
 * 回避する。このフラグが立っていると、Excel はファイルを開いた瞬間に全式を再評価する。
 *
 * - `<calcPr ... fullCalcOnLoad="1"/>` → 既に立っている、no-op
 * - `<calcPr ... fullCalcOnLoad="0"/>` → "1" に書き換え
 * - `<calcPr ... />` (フラグ無し) → 末尾に ` fullCalcOnLoad="1"` を追加
 * - `<calcPr>` ブロック自体が無い → `</workbook>` 直前に新規追加
 */
async function ensureFullCalcOnLoad(zip: JSZip): Promise<void> {
  const wbEntry = zip.file('xl/workbook.xml')
  if (!wbEntry) return
  const wbXml = await wbEntry.async('string')
  let patched = wbXml
  if (/\bfullCalcOnLoad=/.test(wbXml)) {
    patched = wbXml.replace(/\bfullCalcOnLoad="[01]"/, 'fullCalcOnLoad="1"')
  } else if (/<calcPr\b[^>]*\/>/.test(wbXml)) {
    patched = wbXml.replace(/<calcPr\b([^>]*)\/>/, '<calcPr$1 fullCalcOnLoad="1"/>')
  } else if (/<calcPr\b[^>]*>/.test(wbXml)) {
    patched = wbXml.replace(/<calcPr\b([^>]*)>/, '<calcPr$1 fullCalcOnLoad="1">')
  } else {
    patched = wbXml.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>')
  }
  if (patched !== wbXml) {
    zip.file('xl/workbook.xml', patched)
  }
}

/** 列文字 (A, B, ..., Z, AA, AB, ...) の順序比較 */
function compareColLetters(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length
  return a < b ? -1 : a > b ? 1 : 0
}

/** ファイル名生成 (driver_cd / 期間ベース) */
export function buildFilename(driverCd: string, from: string, to: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_')
  return `y_time_${safe(driverCd)}_${from}_${to}.xlsx`
}

/**
 * 列 A の 1 セルを `yyyy-mm-dd` 文字列に正規化 (旧 ExcelJS 実装からの compat 用)。
 * Excel serial / Date / 文字列 の 3 形式をサポート。
 */
export function normalizeDateCell(value: unknown): string | null {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return formatYmd(value)
  }
  if (typeof value === 'number') {
    return excelSerialToYmd(value)
  }
  if (typeof value === 'string') {
    const s = value.trim()
    const m = s.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/)
    if (m) {
      const [, y, mo, da] = m
      return `${y}-${pad(Number(mo))}-${pad(Number(da))}`
    }
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as { result?: unknown; text?: unknown }
    if (obj.result != null) return normalizeDateCell(obj.result)
    if (obj.text != null) return normalizeDateCell(obj.text)
  }
  return null
}
