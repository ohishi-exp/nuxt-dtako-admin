/**
 * 運行 1 件ぶんの csvdata.zip を relay の応答 (JSON) に載せる形へ変換する
 * (Refs ohishi-exp/rust-ichibanboshi#274、#205 の 59)。
 *
 * zip の取得自体 (自前ログイン + `downloadOperationCsvZip`) は
 * `dtako-scraper-relay-do.ts` 側にある — ここは cloudflare:workers に依存しない
 * 純ロジック (base64 化・上限判定・ZIP 内ファイル名の列挙) だけを持ち、素の
 * vitest で 100% カバレッジを取れるようにする。
 *
 * ## 上限 1MB (親指示 2026-08-01)
 *
 * MCP tool の戻り値は `JSON.stringify` で text content に包まれる一本道
 * (kyuyo-mcp/src/mcp/server.ts の `ok()`) — base64 は生バイトの約 1.33 倍に
 * 膨らむため、大きすぎる応答は呼び出し元 (Claude) の文脈に入らずファイル送りに
 * なる (`get_kintai_day_summaries` で実際に踏んだ、2026-08-01)。単一運行の
 * zip は実測 8.7KB (親確認、Refs #274) なので、1MB でも 115 倍の余裕がある。
 * **単一運行でこれを超えたら、それ自体が「指定(opeNo/startOpe) が違う」信号**
 * (月まるごと取れてしまった等)。
 *
 * **黙って切らない。** 上限超過時は zip_base64 を欠落させた「壊れた zip」を
 * 返すのではなく、`omitted: true` + 実サイズを明示して呼び出し元に伝える。
 */

/** 単一運行 zip の応答サイズ上限 (bytes)。実測の 115 倍の余裕 (親指示 2026-08-01)。 */
export const MAX_OPERATION_ZIP_BYTES = 1_000_000;

/** base64 変換時のチャンクサイズ。`String.fromCharCode(...bytes)` を丸ごと
 * spread すると大きな buffer でスタックを溢れさせるため、固定チャンクで刻む。 */
const BASE64_CHUNK_SIZE = 0x8000;

/** ArrayBuffer を base64 文字列に変換する。 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
/** general purpose bit flag のビット3 — データ記述子 (サイズが header 後に付く)。
 * 立っていると local file header の compressedSize が 0 で信用できず、次の
 * エントリへ安全に読み飛ばせない。 */
const DATA_DESCRIPTOR_FLAG = 0x08;

/**
 * ZIP の local file header (`PK\x03\x04`) だけを歩いて中のファイル名を列挙する
 * (展開はしない)。取り込み側 (`autoload`) が探す `KUDGFRY/KUDGFUL/KUDGIVT/
 * KUDGURI/SokudoData` のどれが入っているかを、取り込む前に見えるようにする
 * (Refs #274 — 親の実測では `KUDGFRY` が無く `KUDGSIR` だったことがある)。
 *
 * **失敗しても呼び出し元 (zip 本体の取得) を失敗させない** — 中身は付随情報
 * なので、パースできなければ空配列を返すだけにする (throw しない)。
 *
 * `maxEntries` はテスト容易性のための引数 (既定は実運用で十分な上限)。
 */
export function listZipEntryNames(buf: ArrayBuffer, maxEntries = 500): string[] {
  try {
    const bytes = new Uint8Array(buf);
    const view = new DataView(buf);
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
    const names: string[] = [];
    let offset = 0;
    while (offset + 30 <= bytes.length && names.length < maxEntries) {
      if (view.getUint32(offset, true) !== LOCAL_FILE_HEADER_SIGNATURE) break;
      const generalPurposeFlag = view.getUint16(offset + 6, true);
      const compressedSize = view.getUint32(offset + 18, true);
      const nameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);
      const nameStart = offset + 30;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > bytes.length) break;
      names.push(decoder.decode(bytes.subarray(nameStart, nameEnd)));
      if ((generalPurposeFlag & DATA_DESCRIPTOR_FLAG) !== 0) break;
      offset = nameEnd + extraLen + compressedSize;
    }
    return names;
  } catch {
    return [];
  }
}

export interface OperationZipPayload {
  /** 生の zip サイズ (bytes)。omitted でも入る — 「どれだけ超えたか」が分かる。 */
  bytes: number;
  /** base64 (RFC 4648)。上限超過時は null (**壊れた zip を返さない**)。 */
  zipBase64: string | null;
  /** true なら上限超過で zip_base64 を返していない。 */
  omitted: boolean;
  limitBytes: number;
  /** zip 内のファイル名一覧 (展開しない列挙、失敗時は空配列)。 */
  entries: string[];
}

/** 取得済みの zip (ArrayBuffer) を応答用の形へ変換する。 */
export function buildOperationZipPayload(
  buf: ArrayBuffer,
  limitBytes: number = MAX_OPERATION_ZIP_BYTES,
): OperationZipPayload {
  const entries = listZipEntryNames(buf);
  if (buf.byteLength > limitBytes) {
    return { bytes: buf.byteLength, zipBase64: null, omitted: true, limitBytes, entries };
  }
  return { bytes: buf.byteLength, zipBase64: arrayBufferToBase64(buf), omitted: false, limitBytes, entries };
}
