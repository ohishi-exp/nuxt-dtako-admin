import { afterEach, describe, expect, it, vi } from "vitest";

// do-scrape-alert.test.ts と同じ手 (cloudflare:workers を素のクラスに差し替えて DO を node で読む)。
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

const { scrapeViaHttp } = vi.hoisted(() => ({ scrapeViaHttp: vi.fn() }));
vi.mock("../src/theearth-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/theearth-client")>()),
  scrapeViaHttp,
}));

/** 運行 1 件 / バッチの「zip 取得 → alc 投入」本体。theearth へは繋がない。 */
const { runDtakoAlcUpload } = vi.hoisted(() => ({ runDtakoAlcUpload: vi.fn() }));
vi.mock("../src/dtako-alc-upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/dtako-alc-upload")>()),
  runDtakoAlcUpload,
}));

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import { DtakoAlcUploadError } from "../src/dtako-alc-upload";
import { RECALC_PENDING_PATH } from "../src/alc-internal-upload";
import { SCRAPE_JOB_KEY_PREFIX } from "../src/scrape-queue";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/** 架空の値 (本番の tenant ではない)。この repo は public。 */
const ACCOUNT = { comp_id: "27324455", tenant_id: "tenant-of-27324455", user_name: "u", user_pass: "p" };
const RANGE = { startDate: "2026-08-28", endDate: "2026-08-28" };
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer;

interface Opts {
  uploadStatus?: number;
  pendingStatus?: number;
  pendingBody?: unknown;
}

function makeDO(opts: Opts = {}) {
  /** AUTH_WORKER を通った順 + fold が呼ばれた順。 */
  const order: string[] = [];
  const pendingHeaders: Array<Record<string, string>> = [];
  const env = {
    DTAKO_CONFIG_KV: { get: async () => null },
    INTERNAL_SHARED_SECRET: "shared-secret",
    AUTH_WORKER: {
      fetch: async (url: string, init?: RequestInit) => {
        if (url.includes(RECALC_PENDING_PATH)) {
          order.push("pending");
          pendingHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
          return new Response(
            JSON.stringify(opts.pendingBody ?? { processed: 2, failed: 0, remaining: 0 }),
            { status: opts.pendingStatus ?? 200 },
          );
        }
        order.push("upload");
        return new Response(JSON.stringify({ upload_id: "u1", split_failed: 0 }), {
          status: opts.uploadStatus ?? 200,
        });
      },
    },
  };
  const stored = new Map<string, unknown>();
  const waits: Promise<unknown>[] = [];
  const ctx = {
    setWebSocketAutoResponse: () => {},
    waitUntil: (p: Promise<unknown>) => {
      waits.push(p);
    },
    storage: {
      get: async (key: string) => stored.get(key),
      put: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
      delete: async () => {},
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const priv = relay as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  const spyable = relay as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
  vi.spyOn(spyable, "foldAfterIngest").mockImplementation(async () => {
    order.push("fold");
  });
  vi.spyOn(spyable, "resolveAccount").mockResolvedValue(ACCOUNT);
  return { order, pendingHeaders, stored, waits, priv };
}

function quiet() {
  const logs: string[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void logs.push(String(l))),
    vi.spyOn(console, "error").mockImplementation((l: unknown) => void logs.push(String(l))),
  ];
  return { logs, restore: () => spies.forEach((s) => s.mockRestore()) };
}

afterEach(() => {
  scrapeViaHttp.mockReset();
  runDtakoAlcUpload.mockReset();
  vi.restoreAllMocks();
});

describe("取り込みの一区切りで要再計算を流す (Refs ippoan/alc-dtako-worker#23)", () => {
  describe("毎晩の cron (runCronDtakoScrape)", () => {
    it("★ upload → pending → fold の順に 1 回ずつ。internal proxy のヘッダー付き", async () => {
      const { order, pendingHeaders, stored, priv } = makeDO();
      scrapeViaHttp.mockResolvedValue(ZIP);
      const q = quiet();
      await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-1");
      q.restore();

      expect(order).toEqual(["upload", "pending", "fold"]);
      expect(pendingHeaders[0]).toMatchObject({
        "x-alc-proxy-secret": "shared-secret",
        "x-tenant-id": ACCOUNT.tenant_id,
      });
      expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-1")).toMatchObject({ state: "done" });
    });

    it("★ pending が失敗しても取り込みは done のまま、fold も走る (識別子はログに出ない)", async () => {
      const { order, stored, priv } = makeDO({ pendingStatus: 502 });
      scrapeViaHttp.mockResolvedValue(ZIP);
      const q = quiet();
      await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-2");
      q.restore();

      expect(order).toEqual(["upload", "pending", "fold"]);
      expect(stored.get(SCRAPE_JOB_KEY_PREFIX + "job-2")).toMatchObject({ state: "done" });
      const line = q.logs.find((l) => l.includes('"recalculate_pending"'));
      expect(JSON.parse(line!)).toMatchObject({ recalculate_pending: "error", error: { kind: "http" } });
    });

    it("★ upload が失敗したら pending も fold も呼ばない", async () => {
      const { order, priv } = makeDO({ uploadStatus: 500 });
      scrapeViaHttp.mockResolvedValue(ZIP);
      const q = quiet();
      await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-3");
      q.restore();

      expect(order).toEqual(["upload"]);
    });

    it("★ スクレイプが失敗したら upload も pending も呼ばない", async () => {
      const { order, priv } = makeDO();
      scrapeViaHttp.mockRejectedValue(new Error("取れません"));
      const q = quiet();
      await priv.runCronDtakoScrape(ACCOUNT, RANGE, "job-4");
      q.restore();

      expect(order).toEqual([]);
    });
  });

  describe("画面からの WS 取り直し (executeScrape)", () => {
    const params = { compId: ACCOUNT.comp_id, ...RANGE };
    const server = { send: () => {}, close: () => {} };

    it("★ upload → pending → fold の順 (応答は待たせず waitUntil の中で直列)", async () => {
      const { order, waits, priv } = makeDO();
      scrapeViaHttp.mockResolvedValue(ZIP);
      const q = quiet();
      await priv.executeScrape(server, params);
      await Promise.all(waits);
      q.restore();

      expect(order).toEqual(["upload", "pending", "fold"]);
    });

    it("★ upload が失敗したら pending は呼ばない (fold は従来どおり)", async () => {
      const { order, waits, priv } = makeDO({ uploadStatus: 500 });
      scrapeViaHttp.mockResolvedValue(ZIP);
      const q = quiet();
      await priv.executeScrape(server, params);
      await Promise.all(waits);
      q.restore();

      expect(order).toEqual(["upload", "fold"]);
    });
  });

  describe("バッチ (runDtakoAlcUploadBatch)", () => {
    const items = [
      { opeNo: "1".repeat(22), startOpe: "2026/08/01 1:00:00" },
      { opeNo: "2".repeat(22), startOpe: "2026/08/02 1:00:00" },
      { opeNo: "3".repeat(22), startOpe: "2026/08/03 1:00:00" },
    ];
    const report = { upload_id: "u", split_failed: 0, recalculate: { ok: true }, bytes: 4 };

    it("★ item ごとではなくループの後に 1 回だけ", async () => {
      const { order, priv } = makeDO();
      const seen: number[] = [];
      runDtakoAlcUpload.mockImplementation(async () => {
        seen.push(order.filter((o) => o === "pending").length);
        return report;
      });
      const q = quiet();
      const res = (await priv.runDtakoAlcUploadBatch(ACCOUNT, items, "shared-secret")) as Response;
      q.restore();

      expect(runDtakoAlcUpload).toHaveBeenCalledTimes(3);
      expect(seen).toEqual([0, 0, 0]); // 途中では 1 回も呼ばれていない
      expect(order).toEqual(["pending"]);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.recalculate_pending).toMatchObject({ processed: 2, remaining: 0, error: null });
      expect(body.success_count).toBe(3);
    });

    it("★ 1 件も成功しなかったら呼ばない (応答は null)", async () => {
      const { order, priv } = makeDO();
      runDtakoAlcUpload.mockRejectedValue(new DtakoAlcUploadError("alc への投入に失敗しました"));
      const q = quiet();
      const res = (await priv.runDtakoAlcUploadBatch(ACCOUNT, items, "shared-secret")) as Response;
      q.restore();

      expect(order).toEqual([]);
      expect(((await res.json()) as Record<string, unknown>).recalculate_pending).toBeNull();
    });

    it("★ 1 件でも成功していれば、他が失敗でも 1 回呼ぶ", async () => {
      const { order, priv } = makeDO();
      runDtakoAlcUpload
        .mockRejectedValueOnce(new DtakoAlcUploadError("x"))
        .mockResolvedValueOnce(report)
        .mockRejectedValueOnce(new DtakoAlcUploadError("y"));
      const q = quiet();
      await priv.runDtakoAlcUploadBatch(ACCOUNT, items, "shared-secret");
      q.restore();

      expect(order).toEqual(["pending"]);
    });
  });

  describe("運行 1 件 (runDtakoAlcUploadJob)", () => {
    const input = { opeNo: "1".repeat(22), startOpe: "2026/08/01 1:00:00" };

    it("★ 取り込み後に 1 回呼び、応答に件数を足す (既存の形は壊さない)", async () => {
      const { order, priv } = makeDO();
      runDtakoAlcUpload.mockResolvedValue({ upload_id: "u", split_failed: 0, recalculate: { ok: true }, bytes: 4 });
      const q = quiet();
      const res = (await priv.runDtakoAlcUploadJob(ACCOUNT, input, "shared-secret")) as Response;
      q.restore();

      expect(order).toEqual(["pending"]);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ upload_id: "u", split_failed: 0, theearth_logins: 0 });
      expect(body.recalculate_pending).toMatchObject({ processed: 2, rounds: 1 });
    });

    it("★ 取り込みが失敗したら呼ばない", async () => {
      const { order, priv } = makeDO();
      runDtakoAlcUpload.mockRejectedValue(new DtakoAlcUploadError("alc への投入に失敗しました"));
      const q = quiet();
      const res = (await priv.runDtakoAlcUploadJob(ACCOUNT, input, "shared-secret")) as Response;
      q.restore();

      expect(res.status).toBe(502);
      expect(order).toEqual([]);
    });
  });

  describe("乗務員 × 期間 (runDtakoDriverRangeUploadJob)", () => {
    const input = { driverCd: "1234", startDate: "2026-08-01", endDate: "2026-08-31" };

    it("★ 取り込み後に 1 回呼ぶ。応答は足すだけ", async () => {
      const { order, priv } = makeDO();
      scrapeViaHttp.mockResolvedValue(ZIP);
      const q = quiet();
      const res = (await priv.runDtakoDriverRangeUploadJob(ACCOUNT, input, "shared-secret")) as Response;
      q.restore();

      expect(order).toEqual(["upload", "pending"]);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, upload_id: "u1", split_confirmed: false });
      expect(body.recalculate_pending).toMatchObject({ processed: 2 });
    });

    it("★ 取り込みが失敗したら呼ばない", async () => {
      const { order, priv } = makeDO({ uploadStatus: 500 });
      scrapeViaHttp.mockResolvedValue(ZIP);
      const q = quiet();
      const res = (await priv.runDtakoDriverRangeUploadJob(ACCOUNT, input, "shared-secret")) as Response;
      q.restore();

      expect(res.status).toBe(502);
      expect(order).toEqual(["upload"]);
    });
  });
});
