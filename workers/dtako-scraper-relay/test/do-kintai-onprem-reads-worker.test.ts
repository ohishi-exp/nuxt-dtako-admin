import { afterEach, describe, expect, it, vi } from "vitest";

// do-kintai-comp-scope.test.ts と同じ手。`cloudflare:workers` は Workers
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
import type { KintaiReader } from "../src/kintai-relay";

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

/**
 * DO がオンプレに直接読んでいた勤怠の読みの読み先 (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * - 本番の設定 (`KINTAI` binding + 会社が `KINTAI_COMP_ID`) では、どの口も勤怠 Worker を読み、
 *   オンプレ (`NUXT_ICHIBAN_API_URL`) の `/api/kintai/*` を 1 本も呼ばない
 * - Worker への要求に CF Access・secret のヘッダーが無い。CF Access が未設定でも Worker から読める
 * - binding が無ければ同じ口が今のまま (CF Access 付きでオンプレを読む)
 * - memo のキーは読み先付きで、取り込み後の無効化はどちらの読み先の memo も落とす
 *
 * 会社違いの DO の口は `KINTAI_SINGLE_COMP_PATHS` が入口で 403 にする (do-kintai-comp-scope.test.ts)。
 * 会社違いの振り分けそのものは `kintaiReader` の単体テスト (kintai-relay.test.ts) が測る。
 */
const COMP = "27324455";
const TENANT = "tenant-of-comp";
const YM = "2026-06";
const ACCOUNTS = [{ comp_id: COMP, user_name: "u1", user_pass: "p", tenant_id: TENANT }];

/** 読み先 (Worker / オンプレ) が path ごとに返す応答。どちらも同じ形を返す。 */
function reply(url: string): Response {
  const path = new URL(url).pathname;
  if (path === "/api/kintai/daily") return Response.json({ rows: [] });
  if (path === "/api/kintai/kosoku-daily") return Response.json({ month: YM, drivers: [] });
  if (path === "/api/kintai/version") return Response.json({ month: YM, etag: "e1" });
  if (path === "/api/kintai/rest-diff") return Response.json({ items: [] });
  if (path === "/api/kintai/day-events") return Response.json({ operations: [], events: [] });
  if (path === "/api/kintai/reading-dates") return Response.json({ items: [] });
  if (path === "/api/kintai/pdf-json") return Response.json({ month: YM, drivers: [] });
  if (path === "/api/kintai/timecard/events") return Response.json({ drivers: [], events: [] });
  if (path === "/api/kintai/day-summaries") return Response.json({ month: YM, items: [] });
  if (path === "/api/restraint/synced-months") return Response.json({ entries: [] });
  if (path === "/api/restraint/wage-source") return Response.json({});
  return Response.json({});
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

function headersOf(init?: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init?.headers).entries());
}

interface Setup {
  /** 勤怠 Worker の binding を置くか (既定 true = 本番の形)。 */
  kintaiBinding?: boolean;
  /** オンプレ版の CF Access の設定を置くか (既定 true)。 */
  cfAccess?: boolean;
}

function makeDO(opts: Setup = {}) {
  /** global fetch (= オンプレ直)。 */
  const onprem: Call[] = [];
  /** 勤怠 Worker の binding。 */
  const kintai: Call[] = [];
  /** auth-worker のうち introspect 以外。 */
  const authWorker: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      onprem.push({ url, headers: headersOf(init) });
      return reply(url);
    }),
  );
  /** キャッシュ DO (`UPSTREAM_CACHE=on` のときの remote client)。行は無く、put は格納する。 */
  const cacheStub = {
    fetch: async (url: string) => {
      if (url.endsWith("/put")) return Response.json({ stored: true });
      if (url.endsWith("/months")) return Response.json({ months: [] });
      return new Response(null, { status: 204 });
    },
  };
  const env = {
    DTAKO_R2: {
      get: async () => null,
      head: async () => null,
      put: async () => {},
      delete: async () => {},
      list: async () => ({ objects: [], truncated: false }),
    },
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    KINTAI_COMP_ID: COMP,
    UPSTREAM_CACHE: "on",
    RELAY: { idFromName: () => "id", get: () => cacheStub },
    ...(opts.cfAccess === false
      ? {}
      : {
          ICHIBAN_CF_ACCESS_CLIENT_SECRET: "csecret",
          NUXT_ICHIBAN_API_URL: "https://ichiban.invalid",
          NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid",
        }),
    ...(opts.kintaiBinding === false
      ? {}
      : {
          KINTAI: {
            fetch: vi.fn(async (url: string, init?: RequestInit) => {
              kintai.push({ url, headers: headersOf(init) });
              return reply(url);
            }),
          },
        }),
    AUTH_WORKER: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/introspect")) {
          return Response.json({ active: true, tenant_id: TENANT, email: "viewer@example.com" });
        }
        authWorker.push(url);
        return Response.json({ months: [], summaries: {}, items: [] });
      }),
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const call = (method: "GET" | "POST", pathAndQuery: string, body?: unknown) =>
    relay.fetch(
      new Request(`https://relay.example${pathAndQuery}`, {
        method,
        headers: {
          Authorization: "Bearer dummy-jwt",
          "X-Theearth-Comp-Id": COMP,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
      }) as never,
    );
  return { relay, call, onprem, kintai, authWorker };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** `/api/kintai/*` の読み (path + 並べ替えたクエリ)。重複は畳んで並べる。 */
function kintaiReads(calls: Call[]): string[] {
  const set = new Set<string>();
  for (const c of calls) {
    const u = new URL(c.url);
    if (!u.pathname.startsWith("/api/kintai/")) continue;
    u.searchParams.sort();
    set.add(`${u.pathname}${u.search}`);
  }
  return [...set].sort();
}

const OPE_NO = "2606010500000000004219";
const UNKO_NO = `${OPE_NO}1`;

/** DO の口と、そこから読む勤怠の口 (オンプレ版と Worker の両方にある口)。 */
const ROUTES: Array<[label: string, method: "GET" | "POST", path: string, body: unknown, reads: string[]]> = [
  [
    "取り込み (kintai/fetch): version (取り込み前の版)・daily (refresh=1)・kosoku-daily 2 か月",
    "POST",
    `/restraint-api/kintai/fetch?month=${YM}`,
    undefined,
    [
      "/api/kintai/daily?month=2026-06&refresh=1",
      "/api/kintai/kosoku-daily?month=2026-05&view=timecard",
      "/api/kintai/kosoku-daily?month=2026-06&view=timecard",
      "/api/kintai/version?month=2026-06",
    ],
  ],
  [
    "kosoku-daily の中継 (view=timecard)",
    "GET",
    `/restraint-api/kintai/kosoku-daily?month=${YM}`,
    undefined,
    ["/api/kintai/kosoku-daily?month=2026-06&view=timecard", "/api/kintai/version?month=2026-06"],
  ],
  [
    "手動 warm: daily・kosoku-daily (version 付き)",
    "POST",
    `/restraint-api/kintai/warm?month=${YM}`,
    undefined,
    [
      "/api/kintai/daily?month=2026-06",
      "/api/kintai/kosoku-daily?month=2026-06&view=timecard",
      "/api/kintai/version?month=2026-06",
    ],
  ],
  [
    "突合 (kintai/diff): kosoku-daily の全項目版",
    "GET",
    `/restraint-api/kintai/diff?month=${YM}`,
    undefined,
    ["/api/kintai/day-summaries?month=2026-06", "/api/kintai/kosoku-daily?month=2026-06"],
  ],
  [
    "取り直し ① の保証の判定 (rest-diff)",
    "POST",
    "/restraint-api/kintai/refresh/mysql",
    { unko_no: UNKO_NO, driver_cd: "4219", month: YM },
    ["/api/kintai/rest-diff?driver=4219&month=2026-06"],
  ],
  [
    "取り直し (打刻): timecard/events (buildDeps の onprem)",
    "POST",
    `/restraint-api/kintai/refresh/timecard?month=${YM}`,
    undefined,
    ["/api/kintai/timecard/events?months=2026-05%2C2026-06"],
  ],
  [
    "day-events-lookup",
    "GET",
    `/restraint-api/kintai/day-events-lookup?driver_cd=4219&ope_no=${OPE_NO}`,
    undefined,
    ["/api/kintai/day-events?date=2026-06-01&driver=4219"],
  ],
  [
    "day-operations",
    "GET",
    "/restraint-api/kintai/day-operations?driver_cd=4219&date=2026-06-01",
    undefined,
    ["/api/kintai/day-events?date=2026-06-01&driver=4219"],
  ],
  [
    "onprem-month-operations (reading-dates)",
    "GET",
    `/restraint-api/kintai/onprem-month-operations?driver_cd=4219&month=${YM}`,
    undefined,
    ["/api/kintai/reading-dates?driver=4219&month=2026-06"],
  ],
  ["pdf-json", "GET", `/restraint-api/kintai/pdf-json?month=${YM}&driver=4219`, undefined, [
    "/api/kintai/pdf-json?driver=4219&month=2026-06",
  ]],
  [
    "timecard-compare: pdf-json・kosoku-daily (view=compare) 2 か月",
    "GET",
    `/restraint-api/timecard-compare?month=${YM}`,
    undefined,
    [
      "/api/kintai/kosoku-daily?month=2026-05&view=compare",
      "/api/kintai/kosoku-daily?month=2026-06&view=compare",
      "/api/kintai/pdf-json?month=2026-06",
    ],
  ],
  [
    "wage-report の打刻の live-build: daily・kosoku-daily 2 か月 (version 付き)",
    "GET",
    `/restraint-api/wage-report?month=${YM}`,
    undefined,
    [
      "/api/kintai/daily?month=2026-05",
      "/api/kintai/daily?month=2026-06",
      "/api/kintai/kosoku-daily?month=2026-05&view=timecard",
      "/api/kintai/kosoku-daily?month=2026-06&view=timecard",
      "/api/kintai/version?month=2026-05",
      "/api/kintai/version?month=2026-06",
    ],
  ],
];

const CF_HEADERS = ["cf-access-client-id", "cf-access-client-secret"];
const SECRET_HEADERS = [...CF_HEADERS, "x-alc-proxy-secret", "x-kintai-write-token"];

describe("DO の勤怠の読み → 勤怠 Worker (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  describe.each([
    ["本番の設定 (KINTAI あり・CF Access あり)", {}],
    ["binding はあるが CF Access が未設定", { cfAccess: false }],
  ] as const)("%s", (_label, setup) => {
    it.each(ROUTES)("%s は Worker を読み、オンプレの /api/kintai/* を呼ばない", async (_l, method, path, body, reads) => {
      const { call, onprem, kintai } = makeDO(setup);
      const res = await call(method, path, body);
      expect(res.status).toBeLessThan(500);
      expect(kintaiReads(onprem)).toEqual([]);
      expect(kintaiReads(kintai)).toEqual(reads);
      // Worker への要求に CF Access・secret のヘッダーが無い
      for (const c of kintai) {
        for (const h of SECRET_HEADERS) expect(c.headers).not.toHaveProperty(h);
        expect(c.url.startsWith("https://ichibanboshi-kintai/")).toBe(true);
      }
    });
  });

  it.each(ROUTES)("KINTAI が無ければ %s は今のまま CF Access 付きでオンプレを読む", async (_l, method, path, body, reads) => {
    const { call, onprem, kintai } = makeDO({ kintaiBinding: false });
    const res = await call(method, path, body);
    expect(res.status).toBeLessThan(500);
    expect(kintai).toEqual([]);
    // diff の GCP (day-summaries) は binding が無いと auth-worker 経由 (オンプレではない)
    expect(kintaiReads(onprem)).toEqual(reads.filter((r) => !r.startsWith("/api/kintai/day-summaries")));
    for (const c of onprem.filter((x) => new URL(x.url).pathname.startsWith("/api/kintai/"))) {
      expect(c.url.startsWith("https://ichiban.invalid/api/kintai/")).toBe(true);
      expect(c.headers["cf-access-client-id"]).toBe("cid");
      expect(c.headers["cf-access-client-secret"]).toBe("csecret");
    }
  });

  it("binding も CF Access も無ければ今と同じ 503 (オンプレの取得先が未設定)", async () => {
    const { call, onprem } = makeDO({ kintaiBinding: false, cfAccess: false });
    const res = await call("GET", `/restraint-api/kintai/kosoku-daily?month=${YM}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "勤怠の取得先 (NUXT_ICHIBAN_*) が未設定です" });
    expect(onprem).toEqual([]);
  });

  it("wage-report の拘束サマリの読み (wage-source・synced-months) も Worker", async () => {
    const { call, onprem, kintai } = makeDO({ cfAccess: false });
    await call("GET", `/restraint-api/wage-report?month=${YM}`);
    expect(onprem.filter((c) => new URL(c.url).pathname.startsWith("/api/restraint/"))).toEqual([]);
    expect(kintai.some((c) => new URL(c.url).pathname === "/api/restraint/wage-source")).toBe(true);
  });
});

describe("取り込み後の畳み直し (runFoldMonths) の配線 (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  type Priv = {
    runFoldMonths(account: unknown, jobKey: string, months: string[]): Promise<string | null>;
    recordFold(jobKey: string, patch: Record<string, unknown>): Promise<void>;
  };
  function fold(setup: Setup, sharedSecret = true) {
    const made = makeDO(setup);
    const priv = made.relay as unknown as Priv;
    if (!sharedSecret) (made.relay as unknown as { env: Record<string, unknown> }).env.INTERNAL_SHARED_SECRET = "";
    const states: Array<Record<string, unknown>> = [];
    vi.spyOn(priv, "recordFold").mockImplementation(async (_k, patch) => {
      states.push(patch);
    });
    const run = () => priv.runFoldMonths({ comp_id: COMP, tenant_id: TENANT }, "job", [YM]);
    return { run, states };
  }

  it("binding があれば CF Access が未設定でも not_configured にならず畳み直しまで進む", async () => {
    const { run, states } = fold({ cfAccess: false });
    await run();
    expect(states.map((s) => s.fold_state)).not.toContain("not_configured");
    expect(states[0]!.fold_state).toBe("running");
  });

  it("binding も CF Access も無ければ今と同じ not_configured", async () => {
    const { run, states } = fold({ kintaiBinding: false, cfAccess: false });
    expect(await run()).not.toBeNull();
    expect(states.at(-1)!.fold_state).toBe("not_configured");
  });

  it("INTERNAL_SHARED_SECRET が無ければ binding があっても not_configured (GCP 側の担保は残す)", async () => {
    const { run, states } = fold({}, false);
    expect(await run()).not.toBeNull();
    expect(states.at(-1)!.fold_state).toBe("not_configured");
  });
});

describe("memo のキーは読み先付き・無効化は両方を落とす (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  type Priv = {
    fetchKosokuRaw(reader: KintaiReader, ym: string): Promise<unknown>;
    fetchKosokuRawFull(reader: KintaiReader, ym: string): Promise<unknown>;
    fetchKintaiVersion(reader: KintaiReader, ym: string): Promise<string | null>;
    memoKintaiUpstream<T>(key: string, load: () => Promise<T>): Promise<T>;
    invalidateKintaiUpstreamCache(months: string[], reason: string): Promise<void>;
  };
  function readerOf(route: "worker" | "onprem") {
    const read = vi.fn(async (path: string) => reply(`https://x${path}`));
    return { reader: { route, read } as KintaiReader, read };
  }

  it("同じ月でも読み先が違えば別の memo (Worker の etag とオンプレの本文を混ぜない)", async () => {
    const priv = makeDO().relay as unknown as Priv;
    const w = readerOf("worker");
    const o = readerOf("onprem");
    await priv.fetchKintaiVersion(w.reader, YM);
    await priv.fetchKintaiVersion(o.reader, YM);
    await priv.fetchKintaiVersion(w.reader, YM);
    expect(w.read).toHaveBeenCalledTimes(1);
    expect(o.read).toHaveBeenCalledTimes(1);
  });

  it("取り込み後の無効化は daily・kosoku-raw・kosoku-raw-full・kintai-version を両方の読み先で落とす", async () => {
    // 無効化は未計測のまま暖まった memo を CacheKind によらず全部消す。
    // 陰性対照: 無効化の前は 2 回目が memo から返る (read が増えない)
    const priv = makeDO().relay as unknown as Priv;
    for (const route of ["worker", "onprem"] as const) {
      const r = readerOf(route);
      const daily = vi.fn(async () => "d");
      const warm = async () => {
        await priv.fetchKosokuRaw(r.reader, YM);
        await priv.fetchKosokuRawFull(r.reader, YM);
        await priv.fetchKintaiVersion(r.reader, YM);
        await priv.memoKintaiUpstream(`daily:${route}:${YM}`, daily);
      };
      await warm();
      await warm();
      expect(r.read).toHaveBeenCalledTimes(3);
      expect(daily).toHaveBeenCalledTimes(1);
      await priv.invalidateKintaiUpstreamCache([YM], "test");
      await warm();
      expect(r.read).toHaveBeenCalledTimes(6);
      expect(daily).toHaveBeenCalledTimes(2);
    }
  });
});
