/**
 * ZIP から 1 ファイルだけを取り出す (Refs ohishi-exp/nuxt-dtako-admin#1287)。
 *
 * dtako の日次 cron が alc へ登録する csvdata.zip から `KUDGSIR.csv` (料金所) を読むために使う。
 *
 * ## なぜ central directory から辿るか
 *
 * `operation-zip.ts` の `listZipEntryNames` は local file header だけを歩くので、
 * データ記述子 (general purpose flag の bit 3) を使う zip ではサイズが 0 になり途中で止まる。
 * ここは末尾の EOCD → central directory からエントリの offset と圧縮サイズを取るので、
 * データ記述子があっても正しく読める。
 *
 * 対応するのは method 0 (stored) と 8 (deflate。`DecompressionStream("deflate-raw")`) だけ。
 * ZIP64 (サイズや offset が 0xFFFFFFFF) と暗号化は扱わず、**黙って空を返さずに throw** する。
 */

export class ZipEntryError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
/** EOCD の後ろに付くコメントの最大長 (u16)。 */
const MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;
const ENCRYPTED_FLAG = 0x01;

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/** central directory のエントリを全部読む。壊れていれば throw。 */
export function readCentralDirectory(buf: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = -1;
  const lowest = Math.max(0, buf.byteLength - EOCD_MIN_SIZE - MAX_COMMENT);
  for (let i = buf.byteLength - EOCD_MIN_SIZE; i >= lowest; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipEntryError("zip の終端 (EOCD) が見つかりません");

  const count = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset === ZIP64_MARKER) throw new ZipEntryError("ZIP64 には対応していません");

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.byteLength || view.getUint32(p, true) !== CENTRAL_SIGNATURE) {
      throw new ZipEntryError("zip の central directory が壊れています");
    }
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    entries.push({
      name: latin1(bytes.subarray(p + 46, p + 46 + nameLen)),
      flags: view.getUint16(p + 8, true),
      method: view.getUint16(p + 10, true),
      compressedSize: view.getUint32(p + 20, true),
      uncompressedSize: view.getUint32(p + 24, true),
      localHeaderOffset: view.getUint32(p + 42, true),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** パスを除いたファイル名 (大文字小文字を問わない) で探す。 */
export function findZipEntry(entries: readonly ZipEntry[], basename: string): ZipEntry | null {
  const want = basename.toLowerCase();
  return entries.find((e) => (e.name.split("/").pop() as string).toLowerCase() === want) ?? null;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 1 エントリを展開する。 */
export async function extractZipEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array> {
  if (entry.flags & ENCRYPTED_FLAG) throw new ZipEntryError(`${entry.name} は暗号化されています`);
  if (entry.compressedSize === ZIP64_MARKER || entry.localHeaderOffset === ZIP64_MARKER) {
    throw new ZipEntryError("ZIP64 には対応していません");
  }
  const view = new DataView(buf);
  const at = entry.localHeaderOffset;
  if (at + 30 > buf.byteLength || view.getUint32(at, true) !== LOCAL_SIGNATURE) {
    throw new ZipEntryError(`${entry.name} の local header が壊れています`);
  }
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const end = start + entry.compressedSize;
  if (end > buf.byteLength) throw new ZipEntryError(`${entry.name} のデータが zip の外にはみ出しています`);
  const data = new Uint8Array(buf, start, entry.compressedSize);
  if (entry.method === 0) return data.slice();
  if (entry.method === 8) return inflateRaw(data);
  throw new ZipEntryError(`${entry.name} の圧縮方式 ${entry.method} には対応していません`);
}

/** zip からファイル名 (パス無し) で 1 つ取り出す。**無ければ null**、壊れていれば throw。 */
export async function readZipFile(buf: ArrayBuffer, basename: string): Promise<Uint8Array | null> {
  const entry = findZipEntry(readCentralDirectory(buf), basename);
  return entry ? extractZipEntry(buf, entry) : null;
}
