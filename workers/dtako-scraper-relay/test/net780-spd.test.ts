import { describe, expect, it } from "vitest";
import {
  Net780SpdError,
  lastMovementBefore,
  parseSpd,
  spdFromZip,
  wallSeconds,
  wallString,
} from "../src/net780-spd";

/** 2 桁の BCD。 */
const bcd = (n: number) => ((Math.floor(n / 10) << 4) | n % 10);

/** 見出し (偏差 24〜35 に出庫・帰庫の BCD)。残りは 0。 */
function header(start: string, end: string): number[] {
  const h = new Array(256).fill(0);
  const put = (off: number, at: string) => {
    const [d, t] = at.split(" ");
    const [y, mo, da] = d.split("-").map(Number);
    const [hh, mi, ss] = t.split(":").map(Number);
    [y - 2000, mo, da, hh, mi, ss].forEach((v, i) => (h[off + i] = bcd(v)));
  };
  put(24, start);
  put(30, end);
  return h;
}

/** 区切り 1 つ: `ff ff` + u32 時刻 + u16 初速 + u8 + 増減 (0x7f が 0)。 */
function block(at: string, init: number, deltas: number[]): number[] {
  const t = wallSeconds(at);
  return [0xff, 0xff, t & 0xff, (t >> 8) & 0xff, (t >> 16) & 0xff, (t >>> 24) & 0xff, init & 0xff, init >> 8, 0, ...deltas];
}

const spd = (...parts: number[][]) => new Uint8Array(parts.flat());
const H = header("2026-07-15 03:30:46", "2026-07-18 13:13:44");

describe("parseSpd / lastMovementBefore", () => {
  it("北海 7/17 乗務員 11 の形: 最後の動き 16:45:46 (休息 16:46:09)", () => {
    // 16:45:03 から 0.5 秒刻み。初速 2.1 → 86 個目 (43 秒後 = 16:45:46) まで動き、あとは 0
    const deltas = [0x7f, ...new Array(86).fill(0x7f), 0x7f - 21, ...new Array(8).fill(0x7f)];
    const blocks = parseSpd(spd(H, block("2026-07-17 16:45:03", 21, deltas)));
    expect(blocks).toHaveLength(1);
    expect(blocks[0].t0).toBe(wallSeconds("2026-07-17 16:45:03"));
    expect(blocks[0].speeds.slice(0, 2)).toEqual([21, 21]);
    const last = lastMovementBefore(blocks, wallSeconds("2026-07-17 16:46:09"));
    expect(wallString(last!)).toBe("2026-07-17 16:45:46");
  });

  it("0.5 秒は切り捨て・休息の後と 1 時間より前の動きは見ない・0xff は値の無いサンプル", () => {
    const blocks = parseSpd(
      spd(
        H,
        block("2026-07-17 15:00:00", 10, [0x7f]), // 1 時間より前
        block("2026-07-17 16:00:00", 10, [0x7f, 0xff, 0x7f, 0x7f - 10]), // 16:00:00, (null), 16:00:01, 16:00:01.5 は 0
        block("2026-07-17 16:30:00", 10, [0x7f]), // 休息の後
      ),
    );
    expect(blocks.map((b) => b.speeds)).toEqual([[10], [10, null, 10, 0], [10]]);
    expect(wallString(lastMovementBefore(blocks, wallSeconds("2026-07-17 16:10:00"))!)).toBe("2026-07-17 16:00:01");
    // 休息の直前 1 時間に動きが無ければ null
    expect(lastMovementBefore(blocks, wallSeconds("2026-07-17 18:00:00"), 600)).toBeNull();
  });

  it("出庫〜帰庫の前後 1 日の外の時刻は区切りとみなさない", () => {
    const blocks = parseSpd(spd(H, block("2026-07-17 16:00:00", 10, [0x7f]), block("2026-08-30 00:00:00", 5, [0x7f])));
    expect(blocks).toHaveLength(1);
    // 外の区切りの中身は前の区切りの続き (ff ff 以降も値として読む)
    expect(blocks[0].speeds.length).toBeGreaterThan(1);
  });

  it("短すぎる .spd は失敗", () => {
    expect(() => parseSpd(new Uint8Array(10))).toThrow(Net780SpdError);
  });
});

describe("wallSeconds", () => {
  it("書式違いは失敗", () => {
    expect(() => wallSeconds("2026/07/17 16:46:09")).toThrow("時刻は YYYY-MM-DD HH:MM:SS です");
  });
});

/** 最小の zip (stored または deflate) を組む。 */
async function zip(entries: { name: string; data: Uint8Array; deflate?: boolean; method?: number }[]): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const locals: number[] = [];
  const central: number[] = [];
  const u16 = (n: number) => [n & 0xff, n >> 8];
  const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
  for (const e of entries) {
    let body = e.data;
    if (e.deflate) {
      body = new Uint8Array(await new Response(new Blob([e.data]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    }
    const method = e.method ?? (e.deflate ? 8 : 0);
    const name = enc.encode(e.name);
    const offset = locals.length;
    locals.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method), ...u32(0), ...u32(0), ...u32(body.length), ...u32(e.data.length), ...u16(name.length), ...u16(0), ...name, ...body);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method), ...u32(0), ...u32(0), ...u32(body.length), ...u32(e.data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
  }
  const eocd = [...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(locals.length), ...u16(0)];
  return new Uint8Array([...locals, ...central, ...eocd]).buffer;
}

describe("spdFromZip", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  it("入れ子のフォルダの .spd を stored / deflate で取り出す", async () => {
    const stored = await zip([{ name: "233/x/a.evd", data: new Uint8Array([9]) }, { name: "233/x/a.SPD", data }]);
    expect(await spdFromZip(stored)).toEqual(data);
    const deflated = await zip([{ name: "233/x/a.spd", data, deflate: true }]);
    expect(await spdFromZip(deflated)).toEqual(data);
  });

  it(".spd が無い・未対応の圧縮・zip でないものは失敗", async () => {
    await expect(spdFromZip(await zip([{ name: "a.evd", data }]))).rejects.toThrow(".spd がありません");
    await expect(spdFromZip(await zip([{ name: "a.spd", data, method: 12 }]))).rejects.toThrow("圧縮方式 12 は未対応です");
    await expect(spdFromZip(new Uint8Array(30).buffer)).rejects.toThrow("末尾を読めません");
  });
});
