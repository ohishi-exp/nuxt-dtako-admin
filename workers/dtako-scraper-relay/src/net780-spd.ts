/**
 * NET780 (3要素解析データ) の `.spd` (速度) から「休息の直前に車が最後に動いた時刻」を出す pure ロジック
 * (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * theearth の拘束時間管理表は、休息の直前の運転を休息ボタンの時刻ではなく、速度データで最後に車が動いた時刻で
 * 終える (実測 2026-10-17、北海大運: 6/17 乗務員 6 は 19:52:59 / ボタン 19:53:00、7/17 乗務員 11 は 16:45:46 /
 * 16:46:09)。勤怠 Worker は速度データを持たないので、relay がここで出した時刻を
 * `PUT /api/kintai/rest-start-overrides` で渡す。
 *
 * ## `.spd` の形 (実データで読んだもの)
 *
 * - 先頭は運行の見出し (`.evd` と同じ)。偏差 24〜29 / 30〜35 が出庫・帰庫の BCD (`YY MM DD hh mm ss`)
 * - 以降は区切り `ff ff` + u32 LE の時刻 (日本時間の壁時計をそのまま UNIX 秒にした値) + u16 LE の初速 + u8 + 速度の
 *   増減の列。増減は 1 バイトで 0.5 秒ごと、`0x7f` が 0 (前の値からの差 = バイト − 0x7f)。単位は 0.1 km/h
 * - 増減の列の中の `0xff` は値の無いサンプル (時刻は 1 つぶん進むが、速度は変えない・動いたとはみなさない)
 *
 * net780 crate (ohishi-exp/dtako-scraper `crates/net780/src/spd.rs`) と同じ読み方を、往復の要る最小限だけ写す。
 */

/** 速度のサンプル間隔 (秒)。 */
export const SPD_SAMPLE_SECONDS = 0.5;

export class Net780SpdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Net780SpdError";
  }
}

/** BCD 1 バイト → 数。 */
function bcd(b: number): number {
  return (b >> 4) * 10 + (b & 0x0f);
}

/** 見出しの BCD (`YY MM DD hh mm ss`) → 壁時計の UNIX 秒。 */
function bcdAt(u: Uint8Array, off: number): number {
  const [y, mo, d, h, mi, s] = Array.from(u.subarray(off, off + 6), bcd);
  return Date.UTC(2000 + y, mo - 1, d, h, mi, s) / 1000;
}

/** 速度の 1 区切り。`t0` は壁時計の UNIX 秒、`speeds[i]` は `t0 + i * 0.5` 秒の速度 (0.1 km/h、値の無いサンプルは `null`)。 */
export interface SpdBlock {
  t0: number;
  speeds: (number | null)[];
}

/** `.spd` を区切りの列に。区切りの時刻は見出しの出庫〜帰庫 (前後 1 日の余裕) の中のものだけを区切りとみなす。 */
export function parseSpd(spd: Uint8Array): SpdBlock[] {
  if (spd.length < 36) throw new Net780SpdError(".spd が短すぎます");
  const view = new DataView(spd.buffer, spd.byteOffset, spd.byteLength);
  const lo = bcdAt(spd, 24) - 86400;
  const hi = bcdAt(spd, 30) + 86400;
  const starts: number[] = [];
  for (let i = 38; i + 7 <= spd.length; i++) {
    if (spd[i - 2] !== 0xff || spd[i - 1] !== 0xff) continue;
    const t = view.getUint32(i, true);
    if (t >= lo && t <= hi) starts.push(i);
  }
  return starts.map((i, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] - 2 : spd.length;
    let speed = view.getUint16(i + 4, true);
    const speeds: (number | null)[] = [];
    for (let j = i + 7; j < end; j++) {
      if (spd[j] === 0xff) {
        speeds.push(null);
        continue;
      }
      speed += spd[j] - 0x7f;
      speeds.push(speed);
    }
    return { t0: view.getUint32(i, true), speeds };
  });
}

/** `YYYY-MM-DD HH:MM:SS` (JST の壁時計) ↔ 壁時計の UNIX 秒。 */
export function wallSeconds(at: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(at);
  if (!m) throw new Net780SpdError(`時刻は YYYY-MM-DD HH:MM:SS です: ${at}`);
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
}

export function wallString(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * `restStart` (休息の開始、壁時計の UNIX 秒) 以前で、速度が 0 でなかった最後のサンプルの時刻 (秒未満は切り捨て)。
 * `restStart` の `lookbackSeconds` 前までに動きが無ければ `null` (休息の直前は止まっていた)。
 */
export function lastMovementBefore(blocks: SpdBlock[], restStart: number, lookbackSeconds = 3600): number | null {
  let last: number | null = null;
  for (const b of blocks) {
    b.speeds.forEach((v, i) => {
      const t = b.t0 + i * SPD_SAMPLE_SECONDS;
      if (v !== null && v > 0 && t <= restStart && t >= restStart - lookbackSeconds && (last === null || t > last)) last = t;
    });
  }
  return last === null ? null : Math.floor(last);
}

/** NET780 の zip (1 運行ぶん、`{車輌CD}/{運行}/…` の入れ子) から `.spd` を取り出す。stored / deflate だけ読む。 */
export async function spdFromZip(buf: ArrayBuffer): Promise<Uint8Array> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Net780SpdError("NET780 の zip の末尾を読めません");
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    const method = view.getUint16(pos + 10, true);
    const csize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const skip = 46 + nameLen + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += skip;
    if (!name.toLowerCase().endsWith(".spd")) continue;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (method === 0) return data;
    if (method !== 8) throw new Net780SpdError(`NET780 の zip の圧縮方式 ${method} は未対応です`);
    const out = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer();
    return new Uint8Array(out);
  }
  throw new Net780SpdError("NET780 の zip に .spd がありません");
}
