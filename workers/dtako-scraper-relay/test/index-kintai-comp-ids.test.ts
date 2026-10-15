import { afterEach, describe, expect, it, vi } from "vitest";

// index-kintai-gcp-read.test.ts と同じ手当て (index.ts が DO を re-export するため)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { type RelayWorkerEnv } from "../src/index";

/**
 * 機械用の口 (`/kintai-relay/recalc`・`day-summaries`・`shift-overlaps`) の任意の `comp_id`。
 *
 * - 省略 (空文字を含む) は `KINTAI_COMP_ID`
 * - 指定は `KINTAI_COMP_ID` / `KINTAI_COMP_IDS` の集合に入っているときだけ。外なら 400 で勤怠 Worker を呼ばない
 * - 勤怠 Worker へ名乗るテナントは会社から引いた値 (呼び手に名乗らせない)
 * - secret の照合は `comp_id` の照合より先 (secret を通していない呼び手に 400 と 401 の差を見せない)
 * - `run` (打刻の窓) と `y-time-shifts` は `comp_id` を受けず、`KINTAI_COMP_ID` の 1 社のまま
 */
const SECRET = "internal-shared-secret";
const OWN = "27324455";
const OTHER = "75700192";
/** 架空のテナント。 */
const OWN_TENANT = "tenant-own";
const OTHER_TENANT = "tenant-other";

interface Setup {
  /** `KINTAI_COMP_IDS`。未指定なら宣言しない。 */
  comps?: string;
  /** `dtako_accounts`。未指定なら 2 社ともテナントあり。 */
  accounts?: unknown[];
}

function fakeEnv(opts: Setup = {}) {
  const kintai: { path: string; method: string; tenant: string | null }[] = [];
  const env = {
    INTERNAL_SHARED_SECRET: SECRET,
    KINTAI_COMP_ID: OWN,
    ...(opts.comps !== undefined ? { KINTAI_COMP_IDS: opts.comps } : {}),
    KINTAI_WRITE_TOKEN: "write-token",
    DTAKO_ACCOUNTS: JSON.stringify(
      opts.accounts ?? [
        { comp_id: OWN, tenant_id: OWN_TENANT },
        { comp_id: OTHER, tenant_id: OTHER_TENANT },
      ],
    ),
    KINTAI: {
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        kintai.push({
          path: new URL(url).pathname,
          method: init?.method ?? "GET",
          tenant: new Headers(init?.headers).get("X-Kintai-Tenant-Id"),
        });
        return Response.json({ month: "2026-06", drivers: [], events: [], summaries: {}, items: [] });
      }),
    },
  } as unknown as RelayWorkerEnv;
  return { env, kintai };
}

const post = (path: string, body: unknown, secret = SECRET) =>
  new Request(`https://relay.internal${path}`, {
    method: "POST",
    headers: { "X-Alc-Proxy-Secret": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string, secret = SECRET) =>
  new Request(`https://relay.internal${path}`, { headers: { "X-Alc-Proxy-Secret": secret } });

/** `comp_id` を渡す 3 口。`compId` が `undefined` なら付けない。 */
type Route = [label: string, request: (compId: unknown, secret?: string) => Request, workerPath: string];
const ROUTES: Route[] = [
  [
    "POST /kintai-relay/recalc",
    (compId, s) => post("/kintai-relay/recalc", { month: "2026-06", ...(compId === undefined ? {} : { comp_id: compId }) }, s),
    "/api/kintai/recalc",
  ],
  [
    "GET /kintai-relay/day-summaries",
    (compId, s) => get(`/kintai-relay/day-summaries?month=2026-06${compId === undefined ? "" : `&comp_id=${compId}`}`, s),
    "/api/kintai/day-summaries",
  ],
  [
    "GET /kintai-relay/shift-overlaps",
    (compId, s) => get(`/kintai-relay/shift-overlaps?month=2026-06${compId === undefined ? "" : `&comp_id=${compId}`}`, s),
    "/api/kintai/shift-overlaps",
  ],
];

const NOT_ALLOWED = "comp_id は勤怠の対象会社 (KINTAI_COMP_ID / KINTAI_COMP_IDS) の中からだけ指定できます";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("機械用の口の comp_id", () => {
  it.each(ROUTES)("%s: 省略は KINTAI_COMP_ID の会社のテナントで読む", async (_l, request, workerPath) => {
    const { env, kintai } = fakeEnv({ comps: OTHER });
    const res = await worker.fetch(request(undefined), env);
    expect(res.status).toBe(200);
    expect(kintai).toEqual([{ path: workerPath, method: "GET", tenant: OWN_TENANT }]);
  });

  it.each(ROUTES)("%s: 空文字の comp_id も省略と同じ", async (_l, request) => {
    const { env, kintai } = fakeEnv();
    expect((await worker.fetch(request(""), env)).status).toBe(200);
    expect(kintai.map((c) => c.tenant)).toEqual([OWN_TENANT]);
  });

  it.each(ROUTES)("%s: KINTAI_COMP_ID を明示しても通る", async (_l, request) => {
    const { env, kintai } = fakeEnv();
    expect((await worker.fetch(request(OWN), env)).status).toBe(200);
    expect(kintai.map((c) => c.tenant)).toEqual([OWN_TENANT]);
  });

  it.each(ROUTES)("★ %s: KINTAI_COMP_IDS の会社は、その会社のテナントで読む", async (_l, request, workerPath) => {
    const { env, kintai } = fakeEnv({ comps: ` ${OTHER} ,` });
    const res = await worker.fetch(request(OTHER), env);
    expect(res.status).toBe(200);
    expect(kintai).toEqual([{ path: workerPath, method: "GET", tenant: OTHER_TENANT }]);
  });

  const outside: Array<[label: string, setup: Setup, compId: unknown]> = [
    ["KINTAI_COMP_IDS 未宣言", {}, OTHER],
    ["KINTAI_COMP_IDS が空", { comps: "" }, OTHER],
    ["KINTAI_COMP_IDS に別の会社", { comps: "11112222" }, OTHER],
  ];
  describe.each(outside)("★ 集合の外 (%s)", (_label, setup, compId) => {
    it.each(ROUTES)("%s は 400 で、勤怠 Worker を呼ばない", async (_l, request) => {
      const { env, kintai } = fakeEnv(setup);
      const res = await worker.fetch(request(compId), env);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(NOT_ALLOWED);
      expect(kintai).toEqual([]);
    });
  });

  it("recalc: 数値の comp_id は 400 (文字列だけ受ける)", async () => {
    const { env, kintai } = fakeEnv({ comps: OTHER });
    const res = await worker.fetch(ROUTES[0]![1](Number(OTHER)), env);
    expect(res.status).toBe(400);
    expect(kintai).toEqual([]);
  });

  it.each(ROUTES)("%s: secret が違えば comp_id が集合の外でも 401 (400 より先)", async (_l, request) => {
    const { env, kintai } = fakeEnv();
    const res = await worker.fetch(request(OTHER, "wrong"), env);
    expect(res.status).toBe(401);
    expect(kintai).toEqual([]);
  });

  it.each(ROUTES)("%s: 集合の会社でもテナントが引けなければ 503 で、勤怠 Worker を呼ばない", async (_l, request) => {
    const { env, kintai } = fakeEnv({ comps: OTHER, accounts: [{ comp_id: OWN, tenant_id: OWN_TENANT }] });
    const res = await worker.fetch(request(OTHER), env);
    expect(res.status).toBe(503);
    expect(kintai).toEqual([]);
  });

  it("★ recalc の apply は KINTAI_COMP_IDS の会社でも token 付きで、その会社のテナントへ書く", async () => {
    const { env, kintai } = fakeEnv({ comps: OTHER });
    const res = await worker.fetch(post("/kintai-relay/recalc", { month: "2026-06", apply: true, comp_id: OTHER }), env);
    expect(res.status).toBe(200);
    expect(kintai).toEqual([{ path: "/api/kintai/recalc", method: "POST", tenant: OTHER_TENANT }]);
  });

  it("run は comp_id を受けず、KINTAI_COMP_IDS があっても KINTAI_COMP_ID の会社で運ぶ", async () => {
    const { env, kintai } = fakeEnv({ comps: OTHER });
    const res = await worker.fetch(post("/kintai-relay/run", { month: "2026-06", month_count: 1, comp_id: OTHER }), env);
    expect(res.status).toBe(200);
    expect(kintai.map((c) => c.tenant)).toEqual([OWN_TENANT, OWN_TENANT]);
  });

  it("y-time-shifts は KINTAI_COMP_IDS があっても KINTAI_COMP_ID の会社のテナントで読む", async () => {
    const { env, kintai } = fakeEnv({ comps: OTHER });
    const res = await worker.fetch(
      post(`/kintai-relay/y-time-shifts?comp_id=${OTHER}`, {
        driver_cd: "9001",
        from: "2026-06-01",
        to: "2026-06-30",
        tenant_id: OWN_TENANT,
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(kintai.length).toBeGreaterThan(0);
    expect(kintai.every((c) => c.tenant === OWN_TENANT)).toBe(true);
  });
});
