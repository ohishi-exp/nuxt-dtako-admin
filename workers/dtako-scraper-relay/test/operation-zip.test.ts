import { describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  buildOperationZipPayload,
  listZipEntryNames,
  MAX_OPERATION_ZIP_BYTES,
} from "../src/operation-zip";

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;

/** stored (無圧縮) 前提の local file header + 本体を 1 エントリぶん組み立てる。
 * テスト用の最小限の ZIP モック (central directory / EOCD は付けない — この
 * parser は local file header だけを歩くので不要)。 */
function localFileHeader(name: string, data: Uint8Array, flag = 0): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const header = new Uint8Array(30 + nameBytes.length + data.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
  view.setUint16(4, 20, true); // version needed
  view.setUint16(6, flag, true); // general purpose flag
  view.setUint16(8, 0, true); // method (stored)
  view.setUint16(10, 0, true); // time
  view.setUint16(12, 0, true); // date
  view.setUint32(14, 0, true); // crc32 (未検証なので 0 のまま)
  view.setUint32(18, data.length, true); // compressed size
  view.setUint32(22, data.length, true); // uncompressed size
  view.setUint16(26, nameBytes.length, true);
  view.setUint16(28, 0, true); // extra length
  header.set(nameBytes, 30);
  header.set(data, 30 + nameBytes.length);
  return header;
}

function concatZip(entries: Uint8Array[]): ArrayBuffer {
  const total = entries.reduce((sum, e) => sum + e.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const e of entries) {
    out.set(e, offset);
    offset += e.length;
  }
  return out.buffer;
}

describe("arrayBufferToBase64", () => {
  it("小さい buffer を base64 に変換する", () => {
    const buf = new TextEncoder().encode("hello").buffer as ArrayBuffer;
    expect(arrayBufferToBase64(buf)).toBe(btoa("hello"));
  });

  it("チャンクサイズ (0x8000) を跨ぐ大きな buffer でもスタックを溢れさせない", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 123);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const b64 = arrayBufferToBase64(bytes.buffer);
    // 往復して一致すれば壊れていない
    const decoded = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(bytes);
  });
});

describe("listZipEntryNames", () => {
  it("複数エントリの名前を列挙する", () => {
    const zip = concatZip([
      localFileHeader("KUDGFUL.csv", new TextEncoder().encode("a,b,c\n")),
      localFileHeader("KUDGIVT.csv", new TextEncoder().encode("1,2,3\n")),
      localFileHeader("SokudoData.csv", new Uint8Array(0)),
    ]);
    expect(listZipEntryNames(zip)).toEqual(["KUDGFUL.csv", "KUDGIVT.csv", "SokudoData.csv"]);
  });

  it("30 バイト未満のデータは空配列を返す (ループ自体に入らない)", () => {
    const notZip = new TextEncoder().encode("not a zip file").buffer as ArrayBuffer;
    expect(listZipEntryNames(notZip)).toEqual([]);
  });

  it("30 バイト以上あっても signature が一致しなければ空配列を返す", () => {
    const notZip = new Uint8Array(40).fill(0x41).buffer; // "AAAA..." — magic bytes 不一致
    expect(listZipEntryNames(notZip)).toEqual([]);
  });

  it("空の buffer は空配列を返す", () => {
    expect(listZipEntryNames(new ArrayBuffer(0))).toEqual([]);
  });

  it("maxEntries に達したら打ち切る", () => {
    const zip = concatZip([
      localFileHeader("a.csv", new Uint8Array(0)),
      localFileHeader("b.csv", new Uint8Array(0)),
      localFileHeader("c.csv", new Uint8Array(0)),
    ]);
    expect(listZipEntryNames(zip, 2)).toEqual(["a.csv", "b.csv"]);
  });

  it("データ記述子フラグ (bit3) が立つエントリで打ち切る (サイズを信用できない)", () => {
    const zip = concatZip([
      localFileHeader("a.csv", new TextEncoder().encode("x"), 0x08),
      localFileHeader("b.csv", new Uint8Array(0)),
    ]);
    // a.csv 自体の名前は読めるが、そこから先には安全に進めない
    expect(listZipEntryNames(zip)).toEqual(["a.csv"]);
  });

  it("ファイル名が buffer 末尾を超える (壊れたヘッダ) 場合は打ち切る", () => {
    const full = localFileHeader("truncated-name.csv", new Uint8Array(0));
    const truncated = full.slice(0, 32); // name の途中で切れている
    expect(listZipEntryNames(truncated.buffer)).toEqual([]);
  });

  it("不正な UTF-8 のファイル名は例外を握りつぶして空配列を返す", () => {
    const badName = new Uint8Array([0x80, 0x81]); // 単独継続バイト (不正 UTF-8)
    const header = new Uint8Array(30 + badName.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
    view.setUint32(18, 0, true);
    view.setUint16(26, badName.length, true);
    view.setUint16(28, 0, true);
    header.set(badName, 30);
    expect(listZipEntryNames(header.buffer)).toEqual([]);
  });
});

describe("buildOperationZipPayload", () => {
  it("上限以下なら base64 を返す (omitted: false)", () => {
    const zip = concatZip([localFileHeader("KUDGIVT.csv", new TextEncoder().encode("1,2,3\n"))]);
    const payload = buildOperationZipPayload(zip);
    expect(payload.omitted).toBe(false);
    expect(payload.zipBase64).toBe(arrayBufferToBase64(zip));
    expect(payload.bytes).toBe(zip.byteLength);
    expect(payload.limitBytes).toBe(MAX_OPERATION_ZIP_BYTES);
    expect(payload.entries).toEqual(["KUDGIVT.csv"]);
  });

  it("上限を超えたら zip_base64 を返さず omitted: true にする (黙って切らない)", () => {
    const zip = concatZip([localFileHeader("KUDGIVT.csv", new Uint8Array(50))]);
    const payload = buildOperationZipPayload(zip, 10);
    expect(payload.omitted).toBe(true);
    expect(payload.zipBase64).toBeNull();
    expect(payload.bytes).toBe(zip.byteLength);
    expect(payload.limitBytes).toBe(10);
    // 上限超過でもエントリ名 (軽量な付随情報) は返す
    expect(payload.entries).toEqual(["KUDGIVT.csv"]);
  });
});
