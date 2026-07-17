/**
 * 給与明細ファイル (XLS / XLSX / CSV / TSV) をブラウザ内でテキスト化する (Refs #253)。
 *
 * 給与システムの出力は Excel 97 バイナリ (.XLS) なので、SheetJS (xlsx) で
 * 先頭シートを CSV テキストに変換してから parseSalaryCsv に渡す。
 * テキストファイルは UTF-8 → 失敗時 Shift_JIS の順でデコードする。
 * ファイル内容はメモリ上でのみ扱い、サーバーへは送信・保存しない。
 */

import { read, utils } from 'xlsx'

/** Compound File Binary (Excel 97 .xls) のマジックバイト。 */
const CFB_MAGIC = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]
/** ZIP (xlsx) のマジックバイト。 */
const ZIP_MAGIC = [0x50, 0x4B, 0x03, 0x04]

function hasMagic(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b)
}

/** テキスト (CSV/TSV) バイト列を UTF-8 → 失敗時 Shift_JIS でデコードする。 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  catch {
    return new TextDecoder('shift_jis').decode(bytes)
  }
}

/**
 * ファイルのバイト列を給与明細テキスト (CSV) にする。
 * 拡張子ではなくマジックバイトで Excel / テキストを判定する。
 */
export function salaryFileToText(bytes: Uint8Array): string {
  if (hasMagic(bytes, CFB_MAGIC) || hasMagic(bytes, ZIP_MAGIC)) {
    const wb = read(bytes, { type: 'array' })
    // read() が成功した workbook は必ず 1 枚以上のシートを持つ
    const sheetName = wb.SheetNames[0]!
    return utils.sheet_to_csv(wb.Sheets[sheetName]!, { blankrows: false })
  }
  return decodeCsvBytes(bytes)
}
