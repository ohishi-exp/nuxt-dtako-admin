import { describe, expect, it } from 'vitest'
import {
  extractZipEntry,
  findZipEntry,
  readCentralDirectory,
  readZipFile,
  ZipEntryError,
  type ZipEntry,
} from '../src/zip-entry'

/** fixture の zip はここで組み立てる (実データは入れない)。CRC は読まないので 0 のまま。 */
interface Part {
  name: string
  data: Uint8Array
  method: 0 | 8
  /** bit 3 (データ記述子): local header のサイズを 0 にする */
  descriptor?: boolean
  flags?: number
  /** central に書く圧縮サイズを差し替える (壊れた zip 用) */
  csize?: number
  offset?: number
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

function buildZip(parts: (Part & { stored: Uint8Array })[], comment = ''): ArrayBuffer {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const p of parts) {
    const name = enc.encode(p.name)
    const flags = (p.flags ?? 0) | (p.descriptor ? 0x08 : 0)
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true)
    lh.setUint16(6, flags, true)
    lh.setUint16(8, p.method, true)
    lh.setUint32(18, p.descriptor ? 0 : p.stored.length, true)
    lh.setUint32(22, p.descriptor ? 0 : p.data.length, true)
    lh.setUint16(26, name.length, true)
    const local = [new Uint8Array(lh.buffer), name, p.stored]
    if (p.descriptor) {
      const dd = new DataView(new ArrayBuffer(16))
      dd.setUint32(0, 0x08074b50, true)
      dd.setUint32(8, p.stored.length, true)
      dd.setUint32(12, p.data.length, true)
      local.push(new Uint8Array(dd.buffer))
    }
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true)
    ch.setUint16(8, flags, true)
    ch.setUint16(10, p.method, true)
    ch.setUint32(20, p.csize ?? p.stored.length, true)
    ch.setUint32(24, p.data.length, true)
    ch.setUint16(28, name.length, true)
    ch.setUint32(42, p.offset ?? offset, true)
    central.push(new Uint8Array(ch.buffer), name)
    for (const c of local) {
      chunks.push(c)
      offset += c.length
    }
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const commentBytes = enc.encode(comment)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, parts.length, true)
  eocd.setUint16(10, parts.length, true)
  eocd.setUint32(12, cdSize, true)
  eocd.setUint32(16, offset, true)
  eocd.setUint16(20, commentBytes.length, true)
  const all = [...chunks, ...central, new Uint8Array(eocd.buffer), commentBytes]
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of all) {
    out.set(c, at)
    at += c.length
  }
  return out.buffer
}

async function part(p: Part): Promise<Part & { stored: Uint8Array }> {
  return { ...p, stored: p.method === 8 ? await deflateRaw(p.data) : p.data }
}

const TEXT = new TextEncoder().encode('運行NO,車輌CD\r\n0001,10001234\r\n'.repeat(20))

describe('readZipFile', () => {
  it('deflate (データ記述子あり) と stored の両方を、パス・大文字小文字を問わず取り出す', async () => {
    const zip = buildZip([
      await part({ name: 'KUDGURI.csv', data: new TextEncoder().encode('x'), method: 0 }),
      await part({ name: 'csv/kudgsir.CSV', data: TEXT, method: 8, descriptor: true }),
    ], 'comment')
    expect(await readZipFile(zip, 'KUDGSIR.csv')).toEqual(TEXT)
    expect(new TextDecoder().decode((await readZipFile(zip, 'kudguri.csv'))!)).toBe('x')
  })

  it('無ければ null', async () => {
    const zip = buildZip([await part({ name: 'KUDGURI.csv', data: TEXT, method: 0 })])
    expect(await readZipFile(zip, 'KUDGSIR.csv')).toBeNull()
  })

  it('central directory を読む (中身は展開しない)', async () => {
    const zip = buildZip([await part({ name: 'a.csv', data: TEXT, method: 8 })])
    const [e] = readCentralDirectory(zip)
    expect(e).toMatchObject({ name: 'a.csv', method: 8, flags: 0, uncompressedSize: TEXT.length, localHeaderOffset: 0 })
    expect(findZipEntry([e], 'b.csv')).toBeNull()
  })
})

describe('壊れた zip は throw (黙って null にしない)', () => {
  it('EOCD が無い (短すぎる・署名が無い)', () => {
    expect(() => readCentralDirectory(new Uint8Array(10).buffer)).toThrow(ZipEntryError)
    expect(() => readCentralDirectory(new Uint8Array(100).buffer)).toThrow('EOCD')
  })

  it('central directory の offset が ZIP64 / 壊れている', async () => {
    const zip = buildZip([await part({ name: 'a.csv', data: TEXT, method: 0 })])
    const v = new DataView(zip)
    const eocd = zip.byteLength - 22
    v.setUint32(eocd + 16, 0xffffffff, true)
    expect(() => readCentralDirectory(zip)).toThrow('ZIP64')
    v.setUint32(eocd + 16, 0, true) // local header を指す = central の署名でない
    expect(() => readCentralDirectory(zip)).toThrow('central directory')
    v.setUint32(eocd + 16, zip.byteLength - 10, true) // 末尾近く = 46 バイト読めない
    expect(() => readCentralDirectory(zip)).toThrow('central directory')
  })

  const entry = (over: Partial<ZipEntry>): ZipEntry => ({
    name: 'a.csv', method: 0, flags: 0, compressedSize: 1, uncompressedSize: 1, localHeaderOffset: 0, ...over,
  })

  it.each([
    [{ flags: 1 }, '暗号化'],
    [{ compressedSize: 0xffffffff }, 'ZIP64'],
    [{ localHeaderOffset: 0xffffffff }, 'ZIP64'],
    [{ localHeaderOffset: 5 }, 'local header'],
    [{ localHeaderOffset: 1_000_000 }, 'local header'],
    [{ compressedSize: 1_000_000 }, 'はみ出し'],
    [{ method: 12 }, '圧縮方式 12'],
  ])('%o → %s', async (over, msg) => {
    const zip = buildZip([await part({ name: 'a.csv', data: TEXT, method: 0 })])
    await expect(extractZipEntry(zip, entry(over))).rejects.toThrow(msg)
  })
})
