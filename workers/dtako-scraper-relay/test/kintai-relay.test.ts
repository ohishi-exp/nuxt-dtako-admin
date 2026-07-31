import { describe, it, expect, vi, afterEach } from "vitest";
import {
  relayKintaiPage,
  tenantForCompId,
  buildDeps,
  KintaiRelayError,
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

const DRIVERS = "/api/kintai/timecard/drivers";
const SIGNATURES = "/api/kintai/timecard/signatures";
const DIFF = "/api/kintai/timecard/diff";
const TIMECARD = "/api/kintai/timecard";

describe("relayKintaiPage (ohishi-exp/rust-ichibanboshi#205 の 04b)", () => {
  it("month が YYYY-MM でなければ 1 回も叩かない", async () => {
    const { deps: d, calls } = deps({});
    await expect(relayKintaiPage(d, { month: "2026-7" })).rejects.toBeInstanceOf(KintaiRelayError);
    expect(calls).toHaveLength(0);
  });

  it("乗務員が居なければ署名も引かない", async () => {
    const { deps: d, calls } = deps({
      onprem: { [DRIVERS]: { drivers: [], next_after_driver_cd: null } },
    });
    const r = await relayKintaiPage(d, { month: MONTH });
    expect(r.drivers).toBe(0);
    expect(r.nextAfterDriverCd).toBeNull();
    expect(calls.filter((c) => c.side === "gcp")).toHaveLength(0);
  });

  it("応答に drivers が無くても落ちない (空として扱う)", async () => {
    const { deps: d } = deps({ onprem: { [DRIVERS]: {} } });
    const r = await relayKintaiPage(d, { month: MONTH });
    expect(r.drivers).toBe(0);
    expect(r.nextAfterDriverCd).toBeNull();
  });

  it("**署名 → 差分 → 反映** を順に回し、件数を積む", async () => {
    const batch = { month: MONTH, driver_cd: 1130, days: {}, delete_dates: [] };
    const { deps: d, calls } = deps({
      onprem: {
        [DRIVERS]: { drivers: [1130], next_after_driver_cd: 1130 },
        [DIFF]: { batches: [batch], unknown_states: ["謎"] },
      },
      gcp: {
        [SIGNATURES]: { signatures: { "2026-07-01": SIG } },
        [TIMECARD]: { days_written: 2, days_deleted: 1, misplaced: 0, unknown_states: ["別の謎"] },
      },
    });
    const r = await relayKintaiPage(d, { month: MONTH, apply: true });

    expect(r.drivers).toBe(1);
    expect(r.batchesSent).toBe(1);
    expect(r.daysWritten).toBe(2);
    expect(r.daysDeleted).toBe(1);
    expect(r.misplaced).toBe(0);
    expect(r.nextAfterDriverCd).toBe(1130);
    // **両側の unknown_states がまとまる**
    expect(r.unknownStates).toEqual(["別の謎", "謎"]);

    // 引いた署名をそのまま diff に渡している (ここで計算しない)
    const diffCall = calls.find((c) => c.path === DIFF)!;
    expect(JSON.parse(diffCall.body!)).toEqual({
      month: MONTH,
      remote: { "1130": { "2026-07-01": SIG } },
    });
  });

  it("**apply が無ければ GCP へ 1 件も渡さない** (数えるだけ)", async () => {
    const batch = { month: MONTH, driver_cd: 1130, days: {}, delete_dates: [] };
    const { deps: d, calls } = deps({
      onprem: {
        [DRIVERS]: { drivers: [1130], next_after_driver_cd: null },
        [DIFF]: { batches: [batch] },
      },
      gcp: { [SIGNATURES]: { signatures: {} } },
    });
    const r = await relayKintaiPage(d, { month: MONTH });
    expect(r.batchesSent).toBe(1);
    expect(r.daysWritten).toBe(0);
    expect(calls.filter((c) => c.path === TIMECARD)).toHaveLength(0);
  });

  it("差分が無ければ何も渡らない (batches が欠けていても同じ)", async () => {
    const { deps: d, calls } = deps({
      onprem: {
        [DRIVERS]: { drivers: [1130], next_after_driver_cd: null },
        [DIFF]: {},
      },
      gcp: { [SIGNATURES]: {} },
    });
    const r = await relayKintaiPage(d, { month: MONTH, apply: true });
    expect(r.batchesSent).toBe(0);
    expect(r.unknownStates).toEqual([]);
    expect(calls.filter((c) => c.path === TIMECARD)).toHaveLength(0);
  });

  it("相手が返した件数が欠けていても 0 として積む", async () => {
    const batch = { month: MONTH, driver_cd: 1130, days: {}, delete_dates: [] };
    const { deps: d } = deps({
      onprem: {
        [DRIVERS]: { drivers: [1130], next_after_driver_cd: null },
        [DIFF]: { batches: [batch] },
      },
      gcp: { [SIGNATURES]: { signatures: {} }, [TIMECARD]: {} },
    });
    const r = await relayKintaiPage(d, { month: MONTH, apply: true });
    expect(r).toMatchObject({ daysWritten: 0, daysDeleted: 0, misplaced: 0 });
  });

  it("ページングの指定は query に乗る", async () => {
    const { deps: d, calls } = deps({
      onprem: { [DRIVERS]: { drivers: [], next_after_driver_cd: null } },
    });
    await relayKintaiPage(d, { month: MONTH, afterDriverCd: 1200, maxDrivers: 5 });
    expect(calls[0]!.path).toContain("after_driver_cd=1200");
    expect(calls[0]!.path).toContain("max_drivers=5");
  });

  it("**どちら側が落ちたか**を本文の先頭付きで返す", async () => {
    const fail = () => new Response("boom detail", { status: 502 });
    const onpremDown = deps({ onprem: { [DRIVERS]: fail } });
    await expect(relayKintaiPage(onpremDown.deps, { month: MONTH })).rejects.toThrow(
      /onprem drivers: status 502: boom detail/,
    );

    const gcpDown = deps({
      onprem: { [DRIVERS]: { drivers: [1130], next_after_driver_cd: null } },
      gcp: { [SIGNATURES]: fail },
    });
    await expect(relayKintaiPage(gcpDown.deps, { month: MONTH })).rejects.toThrow(
      /gcp signatures \(driver 1130\): status 502/,
    );

    const diffDown = deps({
      onprem: { [DRIVERS]: { drivers: [1130], next_after_driver_cd: null }, [DIFF]: fail },
      gcp: { [SIGNATURES]: {} },
    });
    await expect(relayKintaiPage(diffDown.deps, { month: MONTH })).rejects.toThrow(
      /onprem diff: status 502/,
    );

    const applyDown = deps({
      onprem: {
        [DRIVERS]: { drivers: [1130], next_after_driver_cd: null },
        [DIFF]: { batches: [{}] },
      },
      gcp: { [SIGNATURES]: {}, [TIMECARD]: fail },
    });
    await expect(
      relayKintaiPage(applyDown.deps, { month: MONTH, apply: true }),
    ).rejects.toThrow(/gcp timecard: status 502/);
  });

  it("**各レグの所要時間を返す。** オンプレの自己申告も拾う", async () => {
    const batch = { month: MONTH, driver_cd: 1130, days: {}, delete_dates: [] };
    const { deps: d } = deps({
      onprem: {
        // オンプレが自己申告した DB 時間。relay 側の計測との差が Tunnel の往復
        [DRIVERS]: { drivers: [1130], next_after_driver_cd: null, elapsed_ms: 12 },
        [DIFF]: { batches: [batch], elapsed_ms: 34 },
      },
      gcp: { [SIGNATURES]: { signatures: {} }, [TIMECARD]: {} },
    });
    const r = await relayKintaiPage(d, { month: MONTH, apply: true });

    expect(r.timings.onpremDriversMs).toBe(12);
    expect(r.timings.onpremDiffMs).toBe(34);
    for (const k of ["totalMs", "driversMs", "signaturesMs", "diffMs", "applyMs"] as const) {
      expect(typeof r.timings[k]).toBe("number");
      expect(r.timings[k]).toBeGreaterThanOrEqual(0);
    }
  });

  it("**古い版のオンプレが相手なら自己申告は null。** 数でない値も拾わない", async () => {
    const { deps: d } = deps({
      // elapsed_ms を返さない版 / 文字列で返す版のどちらも null に倒す
      onprem: { [DRIVERS]: { drivers: [], next_after_driver_cd: null, elapsed_ms: "12" } },
    });
    const r = await relayKintaiPage(d, { month: MONTH });
    expect(r.timings.onpremDriversMs).toBeNull();
    expect(r.timings.onpremDiffMs).toBeNull();
    // 乗務員が居なければ 2 以降は走らないので 0 のまま
    expect(r.timings.signaturesMs).toBe(0);
    expect(r.timings.diffMs).toBe(0);
    expect(r.timings.applyMs).toBe(0);
    expect(typeof r.timings.totalMs).toBe("number");
  });

  it("JSON でない応答は parse failed で落とす (HTML のログイン画面等)", async () => {
    const { deps: d } = deps({
      onprem: { [DRIVERS]: () => new Response("<html>login</html>", { status: 200 }) },
    });
    await expect(relayKintaiPage(d, { month: MONTH })).rejects.toThrow(/parse failed/);
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
