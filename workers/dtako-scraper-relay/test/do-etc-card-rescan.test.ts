import { afterEach, describe, expect, it, vi } from "vitest";

// do-etc-card-register.test.ts と同じ手。`cloudflare:workers` を素のクラスで差し替える。
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

/** theearth へは 1 回も出さない。`scrapeViaHttp` だけ差し替える (他の export は原本)。 */
const { scrapeViaHttp } = vi.hoisted(() => ({ scrapeViaHttp: vi.fn() }));
vi.mock("../src/theearth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/theearth-client")>()),
  scrapeViaHttp,
}));

/** **alc へ上げないこと**を固定するため、upload の関数を見張る。 */
const { uploadDtakoZipViaAlcInternalProxy } = vi.hoisted(() => ({ uploadDtakoZipViaAlcInternalProxy: vi.fn() }));
vi.mock("../src/alc-internal-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/alc-internal-upload")>()),
  uploadDtakoZipViaAlcInternalProxy,
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { PromiseQueue } from "../src/promise-queue";
import { SELECT_RESCAN_TARGET_SQL } from "../src/etc-card-register-run";

/**
 * 「走行日を探し直す」の DO 配線 (Refs #1287)。判定は etc-card-register-run.test.ts の
 * `rescanRunsForRow` が持つので、ここは: 関門 (400 / MODE=off / DTAKO_DB / comp_id) → 202 で受けて
 * キューに積む / theearth の資格情報で読取日の範囲を取る / **alc へは上げない** / ログ 1 行。
 * **番号はすべて架空値。**
 */
type Priv = {
  fetch(req: Request): Promise<Response>;
  env: Record<string, unknown>;
  ctx: { waitUntil(p: Promise<unknown>): void; storage: { get(k: string): Promise<unknown> } };
  scrapeQueue: PromiseQueue;
  runEtcCardRescan: (account: unknown, id: number) => Promise<void>;
};

const CARD = "0000111122223333";
const ACCOUNTS = JSON.stringify([{ comp_id: "c1", user_name: "u1", user_pass: "p1", tenant_id: "tenant-a" }]);

function fakeD1(target: unknown[], waiting: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  return {
    calls,
    db: {
      prepare: (sql: string) => ({
        bind: (...params: unknown[]) => ({
          all: async () => {
            calls.push({ sql, params });
            return { results: sql === SELECT_RESCAN_TARGET_SQL ? target : waiting };
          },
          run: async () => {
            calls.push({ sql, params });
            return {};
          },
        }),
      }),
    },
  };
}

/** method 0 (stored) だけの最小の zip。CRC は読まないので 0。 */
function storedZip(name: string, data: Uint8Array): ArrayBuffer {
  const n = new TextEncoder().encode(name);
  const lh = new DataView(new ArrayBuffer(30));
  lh.setUint32(0, 0x04034b50, true);
  lh.setUint32(18, data.length, true);
  lh.setUint32(22, data.length, true);
  lh.setUint16(26, n.length, true);
  const ch = new DataView(new ArrayBuffer(46));
  ch.setUint32(0, 0x02014b50, true);
  ch.setUint32(20, data.length, true);
  ch.setUint32(24, data.length, true);
  ch.setUint16(28, n.length, true);
  const cdOffset = 30 + n.length + data.length;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, 1, true);
  eocd.setUint16(10, 1, true);
  eocd.setUint32(12, 46 + n.length, true);
  eocd.setUint32(16, cdOffset, true);
  const parts = [new Uint8Array(lh.buffer), n, data, new Uint8Array(ch.buffer), n, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(parts.reduce((k, p) => k + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out.buffer;
}

function makeDo(env: Record<string, unknown> = {}) {
  const d = Object.create(DtakoScraperRelayDO.prototype) as Priv;
  const waits: Promise<unknown>[] = [];
  d.ctx = { waitUntil: (p) => waits.push(p), storage: { get: async () => undefined } };
  d.env = { DTAKO_ACCOUNTS: ACCOUNTS, DTAKO_DB: fakeD1([], []).db, ...env };
  d.scrapeQueue = new PromiseQueue();
  return { d, waits };
}

const post = (body: unknown) =>
  new Request("https://relay.internal/internal/etc-card-rescan", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  scrapeViaHttp.mockReset();
  uploadDtakoZipViaAlcInternalProxy.mockReset();
});

describe("/internal/etc-card-rescan (関門)", () => {
  it.each([
    ["JSON でない", "nope", 400],
    ["id 無し", { comp_id: "c1" }, 400],
    ["id が 0", { id: 0, comp_id: "c1" }, 400],
    ["comp_id 無し", { id: 1 }, 503],
    ["comp_id が DTAKO_ACCOUNTS に無い", { id: 1, comp_id: "nobody" }, 503],
  ])("%s は %i で積まない", async (_l, body, status) => {
    const { d, waits } = makeDo();
    d.runEtcCardRescan = vi.fn();
    expect((await d.fetch(post(body))).status).toBe(status);
    expect(waits).toEqual([]);
    expect(d.runEtcCardRescan).not.toHaveBeenCalled();
  });

  it("ETC_CARD_REGISTER_MODE=off (staging / preview) は 503 で積まない", async () => {
    const { d, waits } = makeDo({ ETC_CARD_REGISTER_MODE: "off" });
    d.runEtcCardRescan = vi.fn();
    const res = await d.fetch(post({ id: 1, comp_id: "c1" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "この環境では ETC カード追加登録を止めています (ETC_CARD_REGISTER_MODE=off)" });
    expect(waits).toEqual([]);
  });

  it("DTAKO_DB が無ければ 503", async () => {
    const { d } = makeDo({ DTAKO_DB: undefined });
    expect((await d.fetch(post({ id: 1, comp_id: "c1" }))).status).toBe(503);
  });

  it("202 で受け、同じキューで comp_id のアカウントで回す。throw してもキューを止めず console.error", async () => {
    const { d, waits } = makeDo();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    d.runEtcCardRescan = vi.fn(async () => {
      throw new Error("boom");
    });
    const res = await d.fetch(post({ id: 7, comp_id: "c1" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, id: 7, comp_id: "c1" });
    await Promise.all(waits);
    expect(d.runEtcCardRescan).toHaveBeenCalledWith(
      { comp_id: "c1", user_name: "u1", user_pass: "p1", tenant_id: "tenant-a" },
      7,
    );
    expect(err.mock.calls.flat().join("\n")).toContain("etc-card-rescan");
  });
});

describe("runEtcCardRescan (配線)", () => {
  const CSV = new TextEncoder().encode("運行NO,車輌CD,終了日時,ETC利用\r\nU1,10001234,2026/11/20 01:00:00,1\r\n");
  const TARGET = { id: 7, card_number: CARD, registration_date: "2026-11-17", received_at: "2026-11-01T00:00:00.000Z", tenant_id: "tenant-a" };
  const WAITING = [{ id: 7, card_number: CARD, plate4: "1234", run_date: null, registration_date: "2026-11-17", received_at: "2026-11-01T00:00:00.000Z" }];

  it("theearth の資格情報で読取日の範囲を取り、KUDGSIR.csv から run_date を書く。alc へは上げない。ログ 1 行 (カードは末尾 5 桁)", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    scrapeViaHttp
      .mockResolvedValueOnce(storedZip("KUDGSIR.csv", CSV))
      .mockResolvedValueOnce(storedZip("KUDGURI.csv", CSV));
    const { db, calls } = fakeD1([TARGET], WAITING);
    const { d, waits } = makeDo({ DTAKO_DB: db, AUTH_WORKER: { fetch: vi.fn() } });
    expect((await d.fetch(post({ id: 7, comp_id: "c1" }))).status).toBe(202);
    await Promise.all(waits);

    expect(scrapeViaHttp.mock.calls.map((c) => c[0])).toEqual([
      { compId: "c1", userName: "u1", userPass: "p1", startDate: "2026-11-17", endDate: "2026-11-23" },
      { compId: "c1", userName: "u1", userPass: "p1", startDate: "2026-11-24", endDate: "2026-11-26" },
    ]);
    // 進捗のコールバックは渡すが何もしない
    (scrapeViaHttp.mock.calls[0]![1] as (s: string) => void)("login");
    expect(uploadDtakoZipViaAlcInternalProxy).not.toHaveBeenCalled();
    const update = calls.find((c) => c.sql.startsWith("UPDATE"))!;
    expect(update.params.slice(0, 2)).toEqual(["2026-11-20", "U1"]);
    expect(update.params.at(-1)).toBe(7);

    const lines = log.mock.calls.flat().map(String).filter((l) => l.includes("etc-card-rescan"));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      cron: "etc-card-rescan",
      comp_id: "c1",
      id: 7,
      status: "done",
      card: "*23333",
      days: 10,
      run_date: "2026-11-20",
      chunks: [
        { range: "2026-11-17..2026-11-23", status: "confirmed", results: [{ kind: "found", run_date: "2026-11-20" }] },
        { range: "2026-11-24..2026-11-26", status: "no_kudgsir" },
      ],
    });
    expect(lines[0]).not.toContain(CARD);
  });

  it("区間の失敗はログに理由を残す (200 字まで)。行が無ければ not_found の 1 行", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    scrapeViaHttp.mockRejectedValue(new Error("x".repeat(500)));
    const { d, waits } = makeDo({ DTAKO_DB: fakeD1([{ ...TARGET, registration_date: "2026-11-26" }], []).db });
    await d.fetch(post({ id: 7, comp_id: "c1" }));
    await Promise.all(waits);
    const done = JSON.parse(log.mock.calls.flat().map(String).find((l) => l.includes("etc-card-rescan"))!);
    expect(done.chunks).toEqual([{ range: "2026-11-26..2026-11-26", status: "error", error: "x".repeat(200) }]);
    expect(done.run_date).toBeNull();

    log.mockClear();
    const none = makeDo({ DTAKO_DB: fakeD1([], []).db });
    await none.d.fetch(post({ id: 7, comp_id: "c1" }));
    await Promise.all(none.waits);
    expect(log.mock.calls.flat().map(String).filter((l) => l.includes("etc-card-rescan"))).toEqual([
      JSON.stringify({ cron: "etc-card-rescan", comp_id: "c1", id: 7, status: "not_found" }),
    ]);
    expect(uploadDtakoZipViaAlcInternalProxy).not.toHaveBeenCalled();
  });
});
