import { describe, it, expect, vi, afterEach } from "vitest";
import {
  relayKintaiWindow,
  windowMonths,
  jstMonth,
  tenantForCompId,
  buildDeps,
  KintaiRelayError,
  MAX_MONTH_COUNT,
  type KintaiRelayDeps,
} from "../src/kintai-relay";

const MONTH = "2026-07";
const SIG = "a".repeat(64);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** オンプレ / GCP の応答を path で引く stub。呼ばれた順に記録する。 */
function deps(handlers: {
  onprem?: Record<string, unknown | ((init?: RequestInit) => Response)>;
  gcp?: Record<string, unknown | ((init?: RequestInit) => Response)>;
}) {
  const calls: { side: "onprem" | "gcp"; path: string; body?: string }[] = [];
  const pick = (side: "onprem" | "gcp", table: Record<string, unknown> | undefined) => {
    return async (path: string, init?: RequestInit) => {
      calls.push({ side, path, body: init?.body as string | undefined });
      const key = path.split("?")[0]!;
      const hit = table?.[key];
      if (hit === undefined) return new Response("no stub", { status: 404 });
      if (typeof hit === "function") return (hit as (i?: RequestInit) => Response)(init);
      return json(hit);
    };
  };
  const d: KintaiRelayDeps = {
    onprem: pick("onprem", handlers.onprem),
    gcp: pick("gcp", handlers.gcp),
  };
  return { deps: d, calls };
}

const EVENTS = "/api/kintai/timecard/events";
const WINDOW = "/api/kintai/timecard/window";

/** 2026-06-15 12:00 JST。窓の既定を確かめるための固定時刻。 */
const NOW = Date.UTC(2026, 5, 15, 3, 0, 0);

function punch(driver: number, at: string, state: string) {
  return { datetime: at, driver_id: driver, source: "timecard", state };
}

describe("relayKintaiWindow (ohishi-exp/rust-ichibanboshi#205 の 04b)", () => {
  it("**窓の既定は当月 + 前月** — 始業/終業 の後追い修正を拾う幅", () => {
    expect(windowMonths("2026-06", 2)).toEqual(["2026-05", "2026-06"]);
    // 年をまたいでも畳める
    expect(windowMonths("2026-01", 3)).toEqual(["2025-11", "2025-12", "2026-01"]);
    expect(windowMonths("2026-06", 1)).toEqual(["2026-06"]);
  });

  it("当月は **JST** で切る (UTC のままだと月初/月末が 1 日ずれる)", () => {
    // 2026-06-30 21:00 UTC = 2026-07-01 06:00 JST
    expect(jstMonth(Date.UTC(2026, 5, 30, 21, 0, 0))).toBe("2026-07");
    expect(jstMonth(Date.UTC(2026, 5, 30, 14, 0, 0))).toBe("2026-06");
  });

  it("**month も now も無ければ実時刻の当月**を使う (既定で呼べる)", async () => {
    const { deps: d } = deps({
      onprem: { [EVENTS]: { drivers: [], events: [] } },
      gcp: { [WINDOW]: {} },
    });
    const r = await relayKintaiWindow(d, {});
    expect(r.months).toHaveLength(2);
    for (const m of r.months) expect(m).toMatch(/^\d{4}-\d{2}$/);
    expect(r.months[1]).toBe(jstMonth(Date.now()));
  });

  it("month / month_count が壊れていれば 1 回も叩かない", async () => {
    const { deps: d, calls } = deps({});
    await expect(relayKintaiWindow(d, { month: "2026-7" })).rejects.toBeInstanceOf(
      KintaiRelayError,
    );
    await expect(relayKintaiWindow(d, { month: "2026-06", monthCount: 0 })).rejects.toThrow(
      /month_count/,
    );
    await expect(
      relayKintaiWindow(d, { month: "2026-06", monthCount: MAX_MONTH_COUNT + 1 }),
    ).rejects.toThrow(/month_count/);
    await expect(relayKintaiWindow(d, { month: "2026-06", monthCount: 1.5 })).rejects.toThrow(
      /month_count/,
    );
    expect(calls).toHaveLength(0);
  });

  it("**1 往復ずつで運びきる。** 続きの位置は無い", async () => {
    const { deps: d, calls } = deps({
      onprem: {
        [EVENTS]: {
          months: ["2026-05", "2026-06"],
          drivers: [1130, 1200],
          events: [punch(1130, "2026-06-01 08:00:00", "始業")],
          elapsed_ms: 140,
        },
      },
      gcp: {
        [WINDOW]: {
          drivers_written: 1,
          days_written: 1,
          days_deleted: 0,
          misplaced: 0,
          unknown_states: ["謎"],
          dry_run: true,
          elapsed_ms: 55,
        },
      },
    });
    const r = await relayKintaiWindow(d, { now: NOW });

    expect(r.months).toEqual(["2026-05", "2026-06"]);
    expect(r.drivers).toBe(2);
    expect(r.events).toBe(1);
    expect(r.daysWritten).toBe(1);
    expect(r.unknownStates).toEqual(["謎"]);
    // オンプレ 1 回 + GCP 1 回だけ
    expect(calls).toHaveLength(2);
    expect(calls[0]!.path).toContain("months=2026-05%2C2026-06");

    // 窓と乗務員をそのまま渡している (ここで突き合わせない)
    const sent = JSON.parse(calls[1]!.body!);
    expect(sent.months).toEqual(["2026-05", "2026-06"]);
    expect(sent.drivers).toEqual([1130, 1200]);
    expect(sent.events).toHaveLength(1);
  });

  it("**apply が無ければ dry_run を立てて渡す** — 受け側に 1 行も書かせない", async () => {
    const { deps: d, calls } = deps({
      onprem: { [EVENTS]: { drivers: [1130], events: [] } },
      gcp: { [WINDOW]: { dry_run: true } },
    });
    const r = await relayKintaiWindow(d, { month: "2026-06" });
    expect(JSON.parse(calls[1]!.body!).dry_run).toBe(true);
    expect(r.dryRun).toBe(true);

    const applied = deps({
      onprem: { [EVENTS]: { drivers: [1130], events: [] } },
      gcp: { [WINDOW]: { dry_run: false } },
    });
    const r2 = await relayKintaiWindow(applied.deps, { month: "2026-06", apply: true });
    expect(JSON.parse(applied.calls[1]!.body!).dry_run).toBe(false);
    expect(r2.dryRun).toBe(false);
  });

  it("応答が欠けていても 0 として積む (drivers / events も同じ)", async () => {
    const { deps: d } = deps({ onprem: { [EVENTS]: {} }, gcp: { [WINDOW]: {} } });
    const r = await relayKintaiWindow(d, { month: "2026-06" });
    expect(r).toMatchObject({
      drivers: 0,
      events: 0,
      driversWritten: 0,
      daysWritten: 0,
      daysDeleted: 0,
      misplaced: 0,
      dryRun: false,
    });
    expect(r.unknownStates).toEqual([]);
  });

  it("**各レグの所要時間を返す。** 相手の自己申告も拾う", async () => {
    const { deps: d } = deps({
      onprem: { [EVENTS]: { drivers: [], events: [], elapsed_ms: 140 } },
      gcp: { [WINDOW]: { elapsed_ms: 55 } },
    });
    const r = await relayKintaiWindow(d, { month: "2026-06" });
    expect(r.timings.onpremEventsMs).toBe(140);
    expect(r.timings.gcpApplyMs).toBe(55);
    for (const k of ["totalMs", "eventsMs", "applyMs"] as const) {
      expect(typeof r.timings[k]).toBe("number");
      expect(r.timings[k]).toBeGreaterThanOrEqual(0);
    }
  });

  it("古い版が相手なら自己申告は null (数でない値も拾わない)", async () => {
    const { deps: d } = deps({
      onprem: { [EVENTS]: { drivers: [], events: [], elapsed_ms: "140" } },
      gcp: { [WINDOW]: {} },
    });
    const r = await relayKintaiWindow(d, { month: "2026-06" });
    expect(r.timings.onpremEventsMs).toBeNull();
    expect(r.timings.gcpApplyMs).toBeNull();
  });

  it("**どちら側が落ちたか**を本文の先頭付きで返す", async () => {
    const fail = () => new Response("boom detail", { status: 502 });
    const onpremDown = deps({ onprem: { [EVENTS]: fail } });
    await expect(relayKintaiWindow(onpremDown.deps, { month: "2026-06" })).rejects.toThrow(
      /onprem events: status 502: boom detail/,
    );

    const gcpDown = deps({
      onprem: { [EVENTS]: { drivers: [], events: [] } },
      gcp: { [WINDOW]: fail },
    });
    await expect(relayKintaiWindow(gcpDown.deps, { month: "2026-06" })).rejects.toThrow(
      /gcp timecard window: status 502/,
    );
  });

  it("JSON でない応答は parse failed で落とす (HTML のログイン画面等)", async () => {
    const { deps: d } = deps({
      onprem: { [EVENTS]: () => new Response("<html>login</html>", { status: 200 }) },
    });
    await expect(relayKintaiWindow(d, { month: "2026-06" })).rejects.toThrow(/parse failed/);
  });
});

describe("tenantForCompId", () => {
  const accounts = [
    { comp_id: "1", user_name: "u", user_pass: "p", tenant_id: "tenant-a" },
    { comp_id: "2", user_name: "u", user_pass: "p", tenant_id: "  tenant-b  " },
    { comp_id: "3", user_name: "u", user_pass: "p", tenant_id: "   " },
    { comp_id: "4", user_name: "u", user_pass: "p" },
    // comp_id ごと欠けている行 (KV の手編集で起こりうる)
    { user_name: "u", user_pass: "p", tenant_id: "tenant-orphan" },
    "not an object",
    null,
  ];

  it("comp_id で引ける (前後の空白は落とす)", () => {
    expect(tenantForCompId(accounts, "1")).toBe("tenant-a");
    expect(tenantForCompId(accounts, "2")).toBe("tenant-b");
  });

  it("**tenant が無ければ null。** 既定へ落とさない", () => {
    expect(tenantForCompId(accounts, "3")).toBeNull();
    expect(tenantForCompId(accounts, "4")).toBeNull();
    expect(tenantForCompId(accounts, "999")).toBeNull();
    // **空の comp_id では引けない** — comp_id を持たない壊れた行を拾わせない
    expect(tenantForCompId(accounts, "")).toBeNull();
    // comp_id が数値でも引ける (KV は手編集なので型が揺れる)
    expect(tenantForCompId([{ comp_id: 7, tenant_id: "t7" }], "7")).toBe("t7");
    expect(tenantForCompId(null, "1")).toBeNull();
    expect(tenantForCompId({ comp_id: "1" }, "1")).toBeNull();
  });
});

describe("buildDeps", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function opts(over: Partial<Parameters<typeof buildDeps>[0]> = {}) {
    return {
      ichibanOrigin: "https://rust-ichiban.example/",
      cfAccessClientId: "cid",
      cfAccessClientSecret: "csec",
      authWorker: { fetch: vi.fn(async () => json({})) },
      proxySecret: "proxy-secret",
      tenantId: "tenant-a",
      ...over,
    };
  }

  it("オンプレへは CF Access Service Token を付ける (末尾スラッシュは二重にしない)", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
      seen.push({ url: String(url), init: init as RequestInit });
      return json({});
    }) as unknown as typeof fetch;

    const o = opts();
    await buildDeps(o).onprem("/api/kintai/timecard/drivers");
    expect(seen[0]!.url).toBe("https://rust-ichiban.example/api/kintai/timecard/drivers");
    const h = seen[0]!.init!.headers as Record<string, string>;
    expect(h["CF-Access-Client-Id"]).toBe("cid");
    expect(h["CF-Access-Client-Secret"]).toBe("csec");
  });

  it("GCP へは auth-worker の /ichibanboshi-proxy 経由。**SA key は持たない**", async () => {
    const o = opts();
    await buildDeps(o).gcp("/api/kintai/timecard", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const call = vi.mocked(o.authWorker.fetch).mock.calls[0]!;
    expect(call[0]).toBe(
      "https://auth-worker.internal/ichibanboshi-proxy/api/kintai/timecard",
    );
    const h = (call[1] as RequestInit).headers as Record<string, string>;
    expect(h["X-Alc-Proxy-Secret"]).toBe("proxy-secret");
    expect(h["X-Tenant-ID"]).toBe("tenant-a");
    expect(h["content-type"]).toBe("application/json");
    expect((call[1] as RequestInit).method).toBe("POST");
  });
});
