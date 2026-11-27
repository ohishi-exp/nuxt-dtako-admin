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

/** theearth へは 1 回も出さない。ログインと運行 1 件の zip だけ差し替える (他の export は原本)。 */
const { login } = vi.hoisted(() => ({ login: vi.fn() }));
vi.mock("../src/theearth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/theearth-client")>()),
  login,
}));
const { downloadOperationCsvZip, releaseLoadedOperation, recalculateWorkUnattended } = vi.hoisted(() => ({
  downloadOperationCsvZip: vi.fn(),
  releaseLoadedOperation: vi.fn(),
  recalculateWorkUnattended: vi.fn(),
}));
vi.mock("../src/theearth-report-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/theearth-report-client")>()),
  downloadOperationCsvZip,
  releaseLoadedOperation,
  recalculateWorkUnattended,
}));

/** **alc へ上げないこと**を固定するため、upload の関数を見張る。 */
const { uploadDtakoZipViaAlcInternalProxy } = vi.hoisted(() => ({ uploadDtakoZipViaAlcInternalProxy: vi.fn() }));
vi.mock("../src/alc-internal-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/alc-internal-upload")>()),
  uploadDtakoZipViaAlcInternalProxy,
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { PromiseQueue } from "../src/promise-queue";
import { RESCAN_ALARM_BUDGET_MS, SELECT_RESCAN_TARGET_SQL } from "../src/etc-card-register-run";
import { SCRAPE_QUEUE_KEY, SCRAPE_RUNNING_KEY, type QueuedEtcCardRescanItem, type QueuedScrapeItem } from "../src/scrape-queue";

/** `ctx.storage` の最小 fake (キューと alarm を本物の流れで通すため)。 */
class MemStorage {
  map = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(k: string): Promise<T | undefined> {
    return this.map.get(k) as T | undefined;
  }
  async put(k: string, v: unknown): Promise<void> {
    this.map.set(k, structuredClone(v));
  }
  async delete(k: string): Promise<boolean> {
    return this.map.delete(k);
  }
  async list<T>(o?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map([...this.map].filter(([k]) => !o?.prefix || k.startsWith(o.prefix))) as Map<string, T>;
  }
  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }
  async setAlarm(t: number | Date): Promise<void> {
    this.alarmAt = typeof t === "number" ? t : t.getTime();
  }
  queue(): QueuedScrapeItem[] {
    return (this.map.get(SCRAPE_QUEUE_KEY) as QueuedScrapeItem[] | undefined) ?? [];
  }
}

/** キューが空になるまで alarm を回す (本番では alarm が `setAlarm(now)` で自分を起こし直す)。 */
async function drain(d: Priv): Promise<number> {
  let n = 0;
  while (d.ctx.storage.queue().length > 0 && n < 10) {
    await d.alarm();
    n++;
  }
  return n;
}

/** D1 の行に書いた「最後の誤り」の文だけ。 */
const notes = (calls: { sql: string; params: unknown[] }[]) =>
  calls.filter((c) => c.sql.includes("SET last_error = ?, updated_at = ? WHERE id = ? AND status = 'waiting_run'")).map((c) => c.params[0]);

/**
 * 「走行日を探し直す」の DO 配線 (Refs #1287)。判定は etc-card-register-run.test.ts の
 * `rescanRunsForRow` が持つので、ここは: 関門 (400 / MODE=off / DTAKO_DB / comp_id) → 202 で受けて
 * キューに積む / alc の一覧を共有秘密 + 行の tenant で GET / 運行 1 件の zip をログイン 1 回で取る /
 * **alc へは上げない** / ログ 1 行。
 * **番号はすべて架空値。**
 */
type Priv = {
  fetch(req: Request): Promise<Response>;
  alarm(): Promise<void>;
  env: Record<string, unknown>;
  ctx: { waitUntil(p: Promise<unknown>): void; storage: MemStorage };
  scrapeQueue: PromiseQueue;
  runEtcCardRescan: (account: unknown, item: QueuedEtcCardRescanItem) => Promise<void>;
  runDtakoAlcUploadJob: (account: unknown, input: { opeNo: string; startOpe: string }, secret: string) => Promise<Response>;
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
  d.ctx = { waitUntil: (p) => waits.push(p), storage: new MemStorage() };
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
  login.mockReset();
  downloadOperationCsvZip.mockReset();
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
    expect(d.ctx.storage.queue()).toEqual([]);
    expect(d.runEtcCardRescan).not.toHaveBeenCalled();
  });

  it("ETC_CARD_REGISTER_MODE=off (staging / preview) は 503 で積まない", async () => {
    const { d, waits } = makeDo({ ETC_CARD_REGISTER_MODE: "off" });
    d.runEtcCardRescan = vi.fn();
    const res = await d.fetch(post({ id: 1, comp_id: "c1" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "この環境では ETC カード追加登録を止めています (ETC_CARD_REGISTER_MODE=off)" });
    expect(waits).toEqual([]);
    expect(d.ctx.storage.queue()).toEqual([]);
  });

  it("DTAKO_DB が無ければ 503", async () => {
    const { d } = makeDo({ DTAKO_DB: undefined });
    expect((await d.fetch(post({ id: 1, comp_id: "c1" }))).status).toBe(503);
  });

  it("★ 202 で受けて storage のキューに積み (waitUntil には載せない)、行に「探し直し中」を書く。実行は alarm", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-27T03:04:00Z"), toFake: ["Date"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = fakeD1([], []);
    const { d, waits } = makeDo({ DTAKO_DB: db });
    d.runEtcCardRescan = vi.fn(async () => {
      throw new Error("boom");
    });
    const res = await d.fetch(post({ id: 7, comp_id: "c1" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, id: 7, comp_id: "c1" });
    expect(waits).toEqual([]);
    expect(d.runEtcCardRescan).not.toHaveBeenCalled();
    const item = { kind: "etc_card_rescan", jobKey: "etc-card-rescan:7", compId: "c1", rescanId: 7, acceptedAt: "2026-11-27T03:04:00.000Z" };
    expect(d.ctx.storage.queue()).toEqual([item]);
    expect(d.ctx.storage.alarmAt).toBe(Date.now());
    expect(notes(calls)).toEqual(["走行日を探し直し中 (11-27 12:04 受付)。数分後に再読み込みしてください"]);

    // alarm が拾って comp_id のアカウントで回す。throw してもキューを止めず、ログと行に残す
    expect(await drain(d)).toBe(1);
    expect(d.runEtcCardRescan).toHaveBeenCalledWith({ comp_id: "c1", user_name: "u1", user_pass: "p1", tenant_id: "tenant-a" }, item);
    expect(err.mock.calls.flat().join("\n")).toContain('"status":"error"');
    expect(notes(calls).at(-1)).toBe("走行日の探し直し (11-27 12:04): 失敗しました: boom");
    expect(await d.ctx.storage.get(SCRAPE_RUNNING_KEY)).toBeUndefined();
  });

  it("★ 走行中に DO が死んだ探し直しは、次の alarm で行に「中断しました」を書く (積み直さない)", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-27T03:10:00Z"), toFake: ["Date"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, calls } = fakeD1([], []);
    const { d } = makeDo({ DTAKO_DB: db });
    d.runEtcCardRescan = vi.fn();
    await d.ctx.storage.put(SCRAPE_RUNNING_KEY, {
      kind: "etc_card_rescan",
      jobKey: "etc-card-rescan:3",
      compId: "c1",
      rescanId: 3,
      acceptedAt: "2026-11-27T03:00:00.000Z",
    });
    await d.alarm();
    expect(d.runEtcCardRescan).not.toHaveBeenCalled();
    expect(d.ctx.storage.queue()).toEqual([]);
    expect(calls.find((c) => c.sql.includes("last_error"))!.params).toEqual([
      "走行日の探し直し (11-27 12:10): 中断しました (relay の再起動。11-27 12:00 受付分)。もう一度「走行日を探し直す」を押してください",
      "2026-11-27T03:10:00.000Z",
      3,
    ]);

    // DTAKO_DB が無ければ書かない (落ちない)
    const bare = makeDo({ DTAKO_DB: undefined });
    await bare.d.ctx.storage.put(SCRAPE_RUNNING_KEY, { kind: "etc_card_rescan", jobKey: "etc-card-rescan:3", compId: "c1", rescanId: 3, acceptedAt: "2026-11-27T03:00:00.000Z" });
    await expect(bare.d.alarm()).resolves.toBeUndefined();
  });

  it("drain 時にアカウント / DTAKO_DB が引けなければ error (行に書けるときは書く)。行への書き込みが落ちてもログだけで止まらない", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const item = { kind: "etc_card_rescan", jobKey: "etc-card-rescan:7", compId: "gone", rescanId: 7, acceptedAt: "2026-11-27T03:00:00.000Z" };
    const { db, calls } = fakeD1([], []);
    const a = makeDo({ DTAKO_DB: db });
    await a.d.ctx.storage.put(SCRAPE_QUEUE_KEY, [item]);
    await a.d.alarm();
    expect(notes(calls)[0]).toContain("失敗しました: comp_id=gone が DTAKO_ACCOUNTS に見つかりません");

    const b = makeDo({ DTAKO_DB: undefined });
    await b.d.ctx.storage.put(SCRAPE_QUEUE_KEY, [{ ...item, compId: "c1" }]);
    await b.d.alarm();
    expect(err.mock.calls.flat().join("\n")).toContain("DTAKO_DB が未設定です");

    const broken = {
      prepare: () => ({
        bind: () => ({
          all: async () => ({ results: [] }),
          run: async () => {
            throw new Error("d1 down");
          },
        }),
      }),
    };
    const c = makeDo({ DTAKO_DB: broken });
    c.d.runEtcCardRescan = vi.fn();
    expect((await c.d.fetch(post({ id: 7, comp_id: "c1" }))).status).toBe(202);
    expect(err.mock.calls.flat().join("\n")).toContain('"status":"note_failed"');
    expect(c.d.ctx.storage.queue()).toHaveLength(1);
  });
});

describe("runEtcCardRescan (配線)", () => {
  const UNKO = "2611200534040000001234";
  const CSV = new TextEncoder().encode(`運行NO,車輌CD,終了日時,ETC利用\r\n${UNKO},10001234,2026/11/20 06:00:00,1\r\n`);
  const TARGET = { id: 7, card_number: CARD, plate4: "1234", registration_date: "2026-11-17", received_at: "2026-11-01T00:00:00.000Z", tenant_id: "tenant-a" };
  const WAITING = [{ id: 7, card_number: CARD, plate4: "1234", run_date: null, registration_date: "2026-11-17", received_at: "2026-11-01T00:00:00.000Z" }];
  const LIST = { total: 2, operations: [{ unko_no: "2611250900000010001234", vehicle_cd: "10001234" }, { unko_no: UNKO, vehicle_cd: "10001234" }] };

  function authWorker(list: unknown = LIST, status = 200) {
    return { fetch: vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(list), { status })) };
  }

  it("alc の一覧を共有秘密 + 行の tenant で GET し、運行 1 件の zip をログイン 1 回で取って run_date を書く。alc へは上げない。ログ 1 行", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    login.mockResolvedValue({ kicked: false });
    downloadOperationCsvZip
      .mockResolvedValueOnce(storedZip("KUDGURI.csv", CSV)) // 新しい方: KUDGSIR 無し
      .mockResolvedValueOnce(storedZip("KUDGSIR.csv", CSV));
    const { db, calls } = fakeD1([TARGET], WAITING);
    const auth = authWorker();
    const { d } = makeDo({ DTAKO_DB: db, AUTH_WORKER: auth, INTERNAL_SHARED_SECRET: "sec" });
    expect((await d.fetch(post({ id: 7, comp_id: "c1" }))).status).toBe(202);
    expect(await drain(d)).toBe(1);

    expect(auth.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = auth.fetch.mock.calls[0]!;
    expect(url).toContain("/alc-internal-proxy/api/internal/operations?date_from=2026-11-17&date_to=2026-11-26&page=1&per_page=200");
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ "X-Alc-Proxy-Secret": "sec", "X-Tenant-ID": "tenant-a" });
    expect(login).toHaveBeenCalledTimes(1);
    expect(downloadOperationCsvZip.mock.calls.map((c) => c[1])).toEqual([
      { opeNo: "2611250900000010001234", startOpe: "2026/11/25 9:00:00" },
      { opeNo: UNKO, startOpe: "2026/11/20 5:34:04" },
    ]);
    expect(uploadDtakoZipViaAlcInternalProxy).not.toHaveBeenCalled();
    const update = calls.find((c) => c.sql.startsWith("UPDATE etc_card_registrations SET run_date"))!;
    expect(update.params.slice(0, 2)).toEqual(["2026-11-20", UNKO]);
    expect(update.params.at(-1)).toBe(7);

    expect(notes(calls)).toEqual([
      "走行日を探し直し中 (11-26 09:00 受付)。数分後に再読み込みしてください",
      "走行日の探し直し (11-26 09:00): 走行日 2026-11-20 を見つけました",
    ]);
    const lines = log.mock.calls.flat().map(String).filter((l) => l.includes('"cron":"etc-card-rescan"'));
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual({ cron: "etc-card-rescan", comp_id: "c1", id: 7, status: "queued" });
    lines.shift();
    expect(JSON.parse(lines[0]!)).toEqual({
      cron: "etc-card-rescan",
      comp_id: "c1",
      id: 7,
      status: "done",
      card: "*23333",
      range: "2026-11-17..2026-11-26",
      operations: 2,
      fetched: 1,
      skipped: 1,
      failed: 0,
      truncated: false,
      kind: "found",
      run_date: "2026-11-20",
      theearth_logins: 1,
    });
    expect(lines[0]).not.toContain(CARD);
  });

  it("陽性対照: 同じ見張りの下で、取り込み (alc-upload) の配線なら upload が呼ばれる", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    login.mockResolvedValue({ kicked: false });
    downloadOperationCsvZip.mockResolvedValue(storedZip("KUDGSIR.csv", CSV));
    uploadDtakoZipViaAlcInternalProxy.mockResolvedValue({ ok: true });
    const { d } = makeDo({ AUTH_WORKER: authWorker() });
    await d.runDtakoAlcUploadJob(
      { comp_id: "c1", user_name: "u1", user_pass: "p1", tenant_id: "tenant-a" },
      { opeNo: UNKO, startOpe: "2026/11/20 5:34:04" },
      "sec",
    );
    expect(uploadDtakoZipViaAlcInternalProxy).toHaveBeenCalled();
  });

  it("zip の失敗はログに理由を残す (200 字まで)。行が無ければ not_found の 1 行。共有秘密が無ければ error", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    login.mockResolvedValue({ kicked: false });
    downloadOperationCsvZip.mockRejectedValue(new Error("x".repeat(500)));
    const { d } = makeDo({ DTAKO_DB: fakeD1([TARGET], WAITING).db, AUTH_WORKER: authWorker(), INTERNAL_SHARED_SECRET: "sec" });
    await d.fetch(post({ id: 7, comp_id: "c1" }));
    await drain(d);
    const done = JSON.parse(log.mock.calls.flat().map(String).find((l) => l.includes('"status":"done"'))!);
    expect(done).toMatchObject({ failed: 2, fetched: 0, kind: "none", run_date: null });
    expect(done.first_error).toHaveLength(200);

    log.mockClear();
    const none = makeDo({ DTAKO_DB: fakeD1([], []).db, AUTH_WORKER: authWorker(), INTERNAL_SHARED_SECRET: "sec" });
    await none.d.fetch(post({ id: 7, comp_id: "c1" }));
    await drain(none.d);
    expect(log.mock.calls.flat().map(String).filter((l) => l.includes('"cron":"etc-card-rescan"') && !l.includes("queued"))).toEqual([
      JSON.stringify({ cron: "etc-card-rescan", comp_id: "c1", id: 7, status: "not_found" }),
    ]);

    const noSecret = makeDo({ DTAKO_DB: fakeD1([TARGET], WAITING).db, AUTH_WORKER: authWorker() });
    await noSecret.d.fetch(post({ id: 7, comp_id: "c1" }));
    await drain(noSecret.d);
    expect(err.mock.calls.flat().join("\n")).toContain("INTERNAL_SHARED_SECRET が未設定です");
    expect(uploadDtakoZipViaAlcInternalProxy).not.toHaveBeenCalled();
  });

  it("★ alarm 1 回の時間を使い切ったら途中経過ごと積み直し、次の alarm で続きから (一覧は引き直さない・ログインは回ごと)", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-26T00:00:00Z"), toFake: ["Date"] });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    login.mockResolvedValue({ kicked: false });
    // 1 件目の zip で時間を使い切る
    downloadOperationCsvZip
      .mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + RESCAN_ALARM_BUDGET_MS);
        return storedZip("KUDGURI.csv", CSV);
      })
      .mockResolvedValueOnce(storedZip("KUDGSIR.csv", CSV));
    const { db, calls } = fakeD1([TARGET], WAITING);
    const auth = authWorker();
    const { d } = makeDo({ DTAKO_DB: db, AUTH_WORKER: auth, INTERNAL_SHARED_SECRET: "sec" });
    await d.fetch(post({ id: 7, comp_id: "c1" }));

    await d.alarm();
    expect(downloadOperationCsvZip).toHaveBeenCalledTimes(1);
    const [again] = d.ctx.storage.queue() as QueuedEtcCardRescanItem[];
    expect(again!.progress).toMatchObject({ next: 1, skipped: 1, unkoNos: ["2611250900000010001234", UNKO] });
    expect(d.ctx.storage.alarmAt).not.toBeNull();
    expect(notes(calls).at(-1)).toBe("走行日を探し直し中 (11-26 09:05 時点で 1/2 運行まで見ました)。数分後に再読み込みしてください");
    expect(log.mock.calls.flat().map(String)).toContain(
      JSON.stringify({ cron: "etc-card-rescan", comp_id: "c1", id: 7, status: "paused", next: 1, of: 2 }),
    );

    expect(await drain(d)).toBe(1);
    expect(auth.fetch).toHaveBeenCalledTimes(1);
    expect(downloadOperationCsvZip.mock.calls.map((c) => c[1])).toEqual([
      { opeNo: "2611250900000010001234", startOpe: "2026/11/25 9:00:00" },
      { opeNo: UNKO, startOpe: "2026/11/20 5:34:04" },
    ]);
    expect(notes(calls).at(-1)).toBe("走行日の探し直し (11-26 09:05): 走行日 2026-11-20 を見つけました");
    expect(d.ctx.storage.queue()).toEqual([]);
  });
});
