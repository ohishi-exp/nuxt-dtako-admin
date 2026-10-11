import { afterEach, describe, expect, it, vi } from "vitest";

// do-restraint-push-kintai.test.ts と同じ手。`cloudflare:workers` は Workers
// ランタイムでしか解決できないので、DurableObject を素のクラスで差し替える。
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

import { DtakoScraperRelayDO } from "../src/dtako-scraper-relay-do";
import type { WageSourceMonthWire } from "../src/restraint-wage-source";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * 拘束サマリの読み 2 本 (`synced-months`・`wage-source`) の読み先 (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * - `KINTAI` binding があれば勤怠 Worker の D1 を読み、素の `fetch` (旧オンプレ版の宛先) は呼ばない
 * - 拘束サマリは `comp` を鍵に持つので、会社が `KINTAI_COMP_ID` と違っても・未設定でも Worker を読む
 * - Worker への要求にはヘッダー・secret を付けない
 * - binding が無ければ読まない (synced-months は空、wage-source は全部 R2)
 * - wage-source の `synced_at = null` の月は R2 へ落ちる
 */
const COMP = "27324455";
const OTHER_COMP = "75700192";
const YM = "2026-06";
const PREV_YM = "2026-05";

const SYNCED_MONTHS = {
  entries: [
    { source: "theearth", month: "2026-05", synced_at: "s", row_count: 1 },
    { source: "theearth", month: "2026-06", synced_at: "s", row_count: 1 },
    { source: "timecard", month: "2026-06", synced_at: "s", row_count: 1 },
  ],
};

function month(syncedAt: string | null, driverCd = "9901"): WageSourceMonthWire {
  return {
    summaries:
      syncedAt === null
        ? []
        : [{ driver_cd: driverCd, summary: { driverCd, days: [] }, fetched_at: "f", last_verified_at: "l" }],
    no_data_drivers: [],
    synced_at: syncedAt,
  };
}

function wageSource(current: WageSourceMonthWire, prev: WageSourceMonthWire) {
  return {
    month: YM,
    prev_month: PREV_YM,
    current_theearth: current,
    current_timecard: month(null),
    prev_theearth: prev,
    prev_timecard: month(null),
  };
}

interface Call {
  url: string;
  init?: RequestInit;
}

interface Setup {
  /** 勤怠 Worker の binding を置くか (既定 true = 本番の形)。 */
  kintaiBinding?: boolean;
  /** `KINTAI_COMP_ID` (既定 COMP)。 */
  kintaiCompId?: string | undefined;
  /** 読み先が返す応答 (path で振り分け)。 */
  reply?: (url: string) => Response;
}

const defaultReply = (url: string) =>
  url.includes("/api/restraint/synced-months")
    ? Response.json(SYNCED_MONTHS)
    : Response.json(wageSource(month("s", "9901"), month("s", "9902")));

function makeDO(opts: Setup = {}) {
  const globalFetchCalls: Call[] = [];
  const kintaiCalls: Call[] = [];
  const reply = opts.reply ?? defaultReply;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      globalFetchCalls.push({ url, init });
      return reply(url);
    }),
  );
  const env = {
    ...(opts.kintaiBinding === false
      ? {}
      : {
          KINTAI: {
            fetch: vi.fn(async (url: string, init?: RequestInit) => {
              kintaiCalls.push({ url, init });
              return reply(url);
            }),
          },
        }),
    ...("kintaiCompId" in opts ? { KINTAI_COMP_ID: opts.kintaiCompId } : { KINTAI_COMP_ID: COMP }),
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const priv = relay as unknown as {
    listIchibanSyncedMonths(c: string): Promise<{ theearth: string[]; timecard: string[] }>;
    loadWageReportSource(...args: unknown[]): Promise<{
      current: { summaries: Array<{ data: { driverCd: string } }> };
      prev: { summaries: Array<{ data: { driverCd: string } }> };
    }>;
    loadMonthSummaries(...args: unknown[]): Promise<unknown>;
  };
  /** R2 から読んだ印 (driverCd = "r2:<月>")。呼ばれた月も控える。 */
  const r2Months: string[] = [];
  vi.spyOn(priv, "loadMonthSummaries").mockImplementation(async (...args: unknown[]) => {
    const ym = String(args[2]);
    r2Months.push(ym);
    return { summaries: [{ data: { driverCd: `r2:${ym}` } }], noDataDrivers: [] };
  });
  const syncedMonths = (compId = COMP) => priv.listIchibanSyncedMonths(compId);
  // skipTimecard = true (打刻の live-build は呼ばない。この PR の対象は theearth 側の読みだけ)
  const wage = (compId = COMP) =>
    priv.loadWageReportSource({}, compId, YM, PREV_YM, null, undefined, undefined, false, true);
  return { syncedMonths, wage, globalFetchCalls, kintaiCalls, r2Months };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const EXPECTED_SYNCED = { theearth: ["2026-06", "2026-05"], timecard: ["2026-06"] };

describe("拘束サマリの読み先 (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  it("★ 本番設定では synced-months を勤怠 Worker から読み、素の fetch を呼ばない。ヘッダーを付けない", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { syncedMonths, globalFetchCalls, kintaiCalls } = makeDO();
    expect(await syncedMonths()).toEqual(EXPECTED_SYNCED);
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls).toHaveLength(1);
    const url = new URL(kintaiCalls[0]!.url);
    expect(url.pathname).toBe("/api/restraint/synced-months");
    expect(url.searchParams.get("comp")).toBe(COMP);
    // ヘッダーそのものを渡さない (secret も載らない)
    expect(kintaiCalls[0]!.init).toBeUndefined();
  });

  it("★ 本番設定では wage-source を勤怠 Worker から読み、素の fetch を呼ばない。ヘッダーを付けない", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { wage, globalFetchCalls, kintaiCalls, r2Months } = makeDO();
    const got = await wage();
    expect(got.current.summaries.map((s) => s.data.driverCd)).toEqual(["9901"]);
    expect(got.prev.summaries.map((s) => s.data.driverCd)).toEqual(["9902"]);
    expect(r2Months).toEqual([]);
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls).toHaveLength(1);
    const url = new URL(kintaiCalls[0]!.url);
    expect(url.pathname).toBe("/api/restraint/wage-source");
    expect(url.searchParams.get("comp")).toBe(COMP);
    expect(url.searchParams.get("month")).toBe(YM);
    expect(kintaiCalls[0]!.init).toBeUndefined();
  });

  it.each([
    ["読む会社が KINTAI_COMP_ID と違う", {}, OTHER_COMP],
    ["KINTAI_COMP_ID が未設定", { kintaiCompId: undefined }, COMP],
  ] as const)("★ %s ときも 2 本とも勤怠 Worker から読む (拘束サマリは会社で絞らない)", async (_label, over, compId) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { syncedMonths, wage, globalFetchCalls, kintaiCalls, r2Months } = makeDO(over);
    expect(await syncedMonths(compId)).toEqual(EXPECTED_SYNCED);
    const got = await wage(compId);
    expect(got.current.summaries.map((s) => s.data.driverCd)).toEqual(["9901"]);
    expect(r2Months).toEqual([]);
    expect(globalFetchCalls).toHaveLength(0);
    expect(kintaiCalls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/restraint/synced-months",
      "/api/restraint/wage-source",
    ]);
    expect(kintaiCalls.map((c) => new URL(c.url).searchParams.get("comp"))).toEqual([compId, compId]);
  });

  it("★ binding が無い (staging・preview) なら読まない (synced-months は空、wage-source は全部 R2)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { syncedMonths, wage, globalFetchCalls, r2Months } = makeDO({ kintaiBinding: false });
    expect(await syncedMonths()).toEqual({ theearth: [], timecard: [] });
    await wage();
    expect(globalFetchCalls).toHaveLength(0);
    expect(r2Months.sort()).toEqual([PREV_YM, YM]);
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"restraint_synced_months":"skipped-not-configured"'))).toBe(true);
    expect(lines.some((l) => l.includes('"wage_report_source":"r2-not-configured"'))).toBe(true);
  });

  it("★ Worker の wage-source が synced_at = null の月は、その月だけ R2 へ落ちる (応答の扱いは変えない)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { wage, kintaiCalls, r2Months } = makeDO({
      reply: () => Response.json(wageSource(month("s", "9901"), month(null))),
    });
    const got = await wage();
    expect(kintaiCalls).toHaveLength(1);
    expect(got.current.summaries.map((s) => s.data.driverCd)).toEqual(["9901"]);
    expect(got.prev.summaries.map((s) => s.data.driverCd)).toEqual([`r2:${PREV_YM}`]);
    expect(r2Months).toEqual([PREV_YM]);
  });

  it("Worker が失敗を返すと今までどおり (synced-months は空、wage-source は全部 R2)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { syncedMonths, wage, globalFetchCalls, r2Months } = makeDO({
      reply: () => new Response("拘束サマリの D1 の読み書きに失敗しました: batch", { status: 502 }),
    });
    expect(await syncedMonths()).toEqual({ theearth: [], timecard: [] });
    await wage();
    expect(globalFetchCalls).toHaveLength(0);
    expect(r2Months.sort()).toEqual([PREV_YM, YM]);
    const lines = error.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('"restraint_synced_months":"upstream-error"'))).toBe(true);
    expect(lines.some((l) => l.includes('"wage_report_source":"upstream-error"'))).toBe(true);
  });
});
