import { afterEach, describe, expect, it, vi } from "vitest";

// do-kintai-change-log.test.ts と同じ手。`cloudflare:workers` は Workers
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

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * 1 社ぶんの勤怠しか持たない口を `KINTAI_COMP_ID` の会社だけに通す (Refs #1133 c1133-8)。
 *
 * 入口の viewer 認可は「閲覧者がその会社を見てよいか」しか見ないので、同じ tenant の
 * 別会社 (75700192) は認可を**通る**。その上で、取得先が会社を受け取らない口
 * (`KINTAI_SINGLE_COMP_PATHS`) と wage-report の打刻系だけを止めることを測る:
 *
 * - (a) 集合の 16 口 — 不一致・未設定・空は 403、上流 (ichiban / auth-worker) と R2 を 1 回も呼ばない
 * - (b) 一致なら 403 にならず上流まで届く (代表 2 口)
 * - (c) 集合外 (`/kintai/alc-upload` / `/wage-snapshot`) は不一致でも 403 にならない (陰性対照)
 * - (d) wage-report — `source=gcp` は 403、既定は 200 のまま打刻の live-build だけを止める
 */
const OWN_COMP = "27324455";
const OTHER_COMP_SAME_TENANT = "75700192";
const TENANT = "tenant-of-both-comps";
const FORBIDDEN = "この会社では使えません (勤怠の記録は KINTAI_COMP_ID の1社分だけを持っています)";

const ACCOUNTS = [
  { comp_id: OWN_COMP, user_name: "u1", user_pass: "p", tenant_id: TENANT },
  { comp_id: OTHER_COMP_SAME_TENANT, user_name: "u2", user_pass: "p", tenant_id: TENANT },
];

/** `dispatchRestraintApi` と同じ method で叩く (判定は method を見ないが、判定を
 * 外した時にハンドラまで届いて 403 以外になることを陰性対照で確かめるため)。 */
const SINGLE_COMP_ROUTES: Array<[method: "GET" | "POST", path: string]> = [
  ["GET", "/restraint-api/kintai/diff"],
  ["GET", "/restraint-api/kintai/stale-months"],
  ["GET", "/restraint-api/kintai/unko-gaps"],
  ["GET", "/restraint-api/kintai/change-log"],
  ["POST", "/restraint-api/kintai/refresh/timecard"],
  ["POST", "/restraint-api/kintai/refresh/fold"],
  ["POST", "/restraint-api/kintai/fetch"],
  ["GET", "/restraint-api/kintai/pdf-json"],
  ["GET", "/restraint-api/timecard-compare"],
  ["GET", "/restraint-api/kintai/kosoku-daily"],
  ["POST", "/restraint-api/kintai/warm"],
  ["POST", "/restraint-api/kintai/refresh/mysql"],
  ["GET", "/restraint-api/kintai/day-events-lookup"],
  ["GET", "/restraint-api/kintai/day-operations"],
  ["GET", "/restraint-api/kintai/archive"],
  ["GET", "/restraint-api/kintai/diff-cache"],
];

/** R2 の全メソッドの呼び出しを数える (どのキーも未投入)。 */
function countingR2() {
  const calls: string[] = [];
  const r2 = {
    get: async (key: string) => (calls.push(`get ${key}`), null),
    head: async (key: string) => (calls.push(`head ${key}`), null),
    put: async (key: string) => {
      calls.push(`put ${key}`);
    },
    delete: async (key: string) => {
      calls.push(`delete ${key}`);
    },
    list: async ({ prefix }: { prefix: string }) => (
      calls.push(`list ${prefix}`), { objects: [] as Array<{ key: string }>, truncated: false as const }
    ),
  };
  return { r2, calls };
}

interface Setup {
  /** 未指定なら OWN_COMP (= 対象会社)。`undefined` を明示すると未設定。 */
  kintaiCompId?: string | undefined;
}

function makeDO(opts: Setup = {}) {
  const { r2, calls: r2Calls } = countingR2();
  /** auth-worker のうち introspect 以外 (= `/ichibanboshi-proxy` 等の上流)。 */
  const authWorkerUpstream: string[] = [];
  /** global fetch (= ichiban へ直、オンプレ系)。 */
  const ichibanCalls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      ichibanCalls.push(url);
      return new Response("nope", { status: 502 });
    }),
  );
  const env = {
    DTAKO_R2: r2,
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: "csecret",
    NUXT_ICHIBAN_API_URL: "https://ichiban.invalid",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid",
    ...("kintaiCompId" in opts ? { KINTAI_COMP_ID: opts.kintaiCompId } : { KINTAI_COMP_ID: OWN_COMP }),
    AUTH_WORKER: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/introspect")) {
          return Response.json({ active: true, tenant_id: TENANT, email: "viewer@example.com" });
        }
        authWorkerUpstream.push(url);
        return Response.json({ months: [], summaries: {} });
      }),
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: {
      // 保存済み theearth セッションは無し — viewer (auth-worker JWT) 経路のみ
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
    },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const call = (method: string, pathAndQuery: string, compId: string) =>
    relay.fetch(
      new Request(`https://relay.example${pathAndQuery}`, {
        method,
        headers: {
          Authorization: "Bearer dummy-jwt",
          "X-Theearth-Comp-Id": compId,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: "{}" } : {}),
      }) as never,
    );
  return { call, r2Calls, authWorkerUpstream, ichibanCalls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("KINTAI_SINGLE_COMP_PATHS (Refs #1133 c1133-8)", () => {
  const cases: Array<[label: string, setup: Setup, compId: string]> = [
    ["KINTAI_COMP_ID と不一致", {}, OTHER_COMP_SAME_TENANT],
    ["KINTAI_COMP_ID 未設定", { kintaiCompId: undefined }, OWN_COMP],
    ["KINTAI_COMP_ID が空", { kintaiCompId: "" }, OWN_COMP],
  ];
  describe.each(cases)("★ (a) %s", (_label, setup, compId) => {
    it.each(SINGLE_COMP_ROUTES)("%s %s は 403、上流と R2 を 1 回も呼ばない", async (method, path) => {
      const { call, r2Calls, authWorkerUpstream, ichibanCalls } = makeDO(setup);
      const res = await call(method, `${path}?month=2026-06`, compId);
      expect(res.status).toBe(403);
      // KINTAI_COMP_ID の値や fold 向けの文言 (judgeFoldScope の detail) は返さない
      expect(await res.json()).toEqual({ error: FORBIDDEN });
      expect(authWorkerUpstream).toEqual([]);
      expect(ichibanCalls).toEqual([]);
      expect(r2Calls).toEqual([]);
    });
  });

  it("(b) 一致なら /kintai/stale-months は GCP (auth-worker 経由) まで届く", async () => {
    const { call, authWorkerUpstream } = makeDO();
    const res = await call("GET", "/restraint-api/kintai/stale-months", OWN_COMP);
    expect(res.status).not.toBe(403);
    expect(authWorkerUpstream.some((u) => u.includes("/ichibanboshi-proxy/"))).toBe(true);
  });

  it("(b) 一致なら /kintai/kosoku-daily はオンプレ (ichiban) まで届く", async () => {
    const { call, ichibanCalls } = makeDO();
    const res = await call("GET", "/restraint-api/kintai/kosoku-daily?month=2026-06", OWN_COMP);
    expect(res.status).not.toBe(403);
    expect(ichibanCalls.some((u) => u.includes("/api/kintai/kosoku-daily"))).toBe(true);
  });

  it.each([
    ["POST", "/restraint-api/kintai/alc-upload"],
    ["POST", "/restraint-api/wage-snapshot"],
  ])("★ (c) 集合外の %s %s は不一致でも止めない (陰性対照)", async (method, path) => {
    const { call } = makeDO();
    const res = await call(method, path, OTHER_COMP_SAME_TENANT);
    expect(res.status).not.toBe(403);
    expect(((await res.json()) as { error?: string }).error).not.toBe(FORBIDDEN);
  });
});

describe("GET /restraint-api/wage-report の打刻系 (Refs #1133 c1133-8)", () => {
  /** `buildKintaiSummariesLive` が叩く打刻の口 (オンプレ)。 */
  const liveBuildCalls = (ichibanCalls: string[]) =>
    ichibanCalls.filter((u) => u.includes("/api/kintai/daily") || u.includes("/api/kintai/kosoku-daily"));
  const NOT_CONFIGURED_WARNING = "KINTAI_COMP_ID が未設定のため打刻の行を組んでいません";

  it("★ 不一致 + source=gcp は 403 (他社の分数で計算した値を出さない)", async () => {
    const { call, authWorkerUpstream, ichibanCalls } = makeDO();
    const res = await call("GET", "/restraint-api/wage-report?month=2026-06&source=gcp", OTHER_COMP_SAME_TENANT);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: FORBIDDEN });
    expect(authWorkerUpstream).toEqual([]);
    expect(ichibanCalls).toEqual([]);
  });

  it("★ 不一致 + 既定は 200、打刻の live-build を呼ばず warning も出さない (打刻を持たないのが正常)", async () => {
    const { call, ichibanCalls } = makeDO();
    const res = await call("GET", "/restraint-api/wage-report?month=2026-06", OTHER_COMP_SAME_TENANT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[]; timecard_kosoku: unknown };
    expect(liveBuildCalls(ichibanCalls)).toEqual([]);
    // theearth 側 (wage-source、会社ごとに絞れている) は従来どおり取りに行く
    expect(ichibanCalls.some((u) => u.includes(`/api/restraint/wage-source?comp=${OTHER_COMP_SAME_TENANT}`))).toBe(
      true,
    );
    expect(body.warnings.some((w) => w.includes("live-build"))).toBe(false);
    expect(body.warnings).not.toContain(NOT_CONFIGURED_WARNING);
    expect(body.timecard_kosoku).toBeNull();
  });

  it("★ 未設定 + 既定は 200、live-build を呼ばず warning を残す (対象外に丸めない、#944)", async () => {
    const { call, ichibanCalls } = makeDO({ kintaiCompId: undefined });
    const res = await call("GET", "/restraint-api/wage-report?month=2026-06", OWN_COMP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(liveBuildCalls(ichibanCalls)).toEqual([]);
    expect(body.warnings).toContain(NOT_CONFIGURED_WARNING);
  });

  it("未設定 + source=gcp も 403", async () => {
    const { call } = makeDO({ kintaiCompId: undefined });
    const res = await call("GET", "/restraint-api/wage-report?month=2026-06&source=gcp", OWN_COMP);
    expect(res.status).toBe(403);
  });

  it("一致 + 既定は従来どおり打刻の live-build を呼ぶ", async () => {
    const { call, ichibanCalls } = makeDO();
    const res = await call("GET", "/restraint-api/wage-report?month=2026-06", OWN_COMP);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };
    expect(liveBuildCalls(ichibanCalls).length).toBeGreaterThan(0);
    expect(body.warnings).not.toContain(NOT_CONFIGURED_WARNING);
  });
});
