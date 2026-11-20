import { afterEach, describe, expect, it, vi } from "vitest";

// do-wage-snapshot-kintai.test.ts と同じ手。`cloudflare:workers` は Workers
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
 * `GET /restraint-api/min-wage-annual-report` の門 (#p414)。`wage-range` と同じ門を通ることを測る:
 *
 * - (a) 給与 allowlist の外は 403 で、D1・勤怠 Worker・給与大臣のどれにも届かない (陰性対照: 200 なら届く)
 * - (b) 通れば給与大臣へは**リクエスト自身の Authorization** を渡し、comp はセッションの値で読む
 * - (c) PDF は driver 必須 (400)・BROWSER が無ければ 503 (どちらも上流を読まない)
 *
 * 名前・金額は架空。
 */
const OWN_COMP = "27324455";
const TENANT = "tenant-x";
const ACCOUNTS = [{ comp_id: OWN_COMP, user_name: "u1", user_pass: "p", tenant_id: TENANT }];

interface Setup {
  kyuyoStatus?: number;
  /** 給与大臣 Worker の応答 status (既定 200)。 */
  kyuyoUpstreamStatus?: number;
  browser?: boolean;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDO(opts: Setup = {}) {
  const d1: string[] = [];
  const kintaiCalls: string[] = [];
  const kyuyoCalls: Array<{ url: string; auth: string | null }> = [];
  const authorizeCalls: string[] = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => {
          d1.push(`${sql.split(" FROM ")[1]!.split(" ")[0]} ${args.join(",")}`);
          if (sql.includes("FROM employees")) {
            return { results: [{ company: "0100", payroll_cd: "0042", name: "架空 太郎", driver_cd: "0912" }] };
          }
          return { results: [{ payroll_company: "0100" }] };
        },
      }),
    }),
  };
  const env = {
    KINTAI: {
      fetch: vi.fn(async (url: string) => {
        kintaiCalls.push(url);
        return Response.json({
          months: [{ ym: "2025-01", saved: true }],
          rows: [{ driver_cd: "0912", driver_name: "架空 太郎", by_month: { "2025-01": { calc_base: 100, calc_overtime: 0, calc_total: 100, paid_base: 90, paid_overtime: 0 } } }],
        });
      }),
    },
    KINTAI_WRITE_TOKEN: "write-token",
    KINTAI_COMP_ID: OWN_COMP,
    AUTH_KYUYO: {
      authorize: async (token: string) => (authorizeCalls.push(token), { status: opts.kyuyoStatus ?? 200, body: "" }),
    },
    ICHIBAN_KYUYO: {
      fetch: vi.fn(async (req: Request) => {
        kyuyoCalls.push({ url: req.url, auth: req.headers.get("authorization") });
        if (opts.kyuyoUpstreamStatus) return new Response("forbidden", { status: opts.kyuyoUpstreamStatus });
        const bonus = req.url.includes("/kyuyo/bonus");
        return Response.json({
          database: "db",
          rows: bonus
            ? [{ employee_code: "0042", employee_code_key: "42", employee_name: "架空 太郎", pay_date: "2025-08-10", payments: { 就労調整金: 4 } }]
            : [],
        });
      }),
    },
    ...(opts.browser ? { BROWSER: {} } : {}),
    DTAKO_DB: db,
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    AUTH_WORKER: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/introspect")) return Response.json({ active: true, tenant_id: TENANT, email: "viewer@example.com" });
        return new Response("nope", { status: 500 });
      }),
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const get = (query: string) =>
    relay.fetch(
      new Request(`https://relay.example/restraint-api/min-wage-annual-report?${query}`, {
        headers: {
          Authorization: "Bearer viewer-jwt",
          "X-Theearth-Comp-Id": OWN_COMP,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
        },
      }) as never,
    );
  return { get, d1, kintaiCalls, kyuyoCalls, authorizeCalls };
}

describe("GET /restraint-api/min-wage-annual-report の門", () => {
  it("★ (a) allowlist の外は 403 で、D1・勤怠 Worker・給与大臣のどれにも届かない", async () => {
    const { get, d1, kintaiCalls, kyuyoCalls, authorizeCalls } = makeDO({ kyuyoStatus: 403 });
    const res = await get("from_year=2025");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "給与の閲覧許可リストに無いアカウントです" });
    // 関門にはリクエスト自身の JWT を渡している
    expect(authorizeCalls).toEqual(["viewer-jwt"]);
    expect(d1).toEqual([]);
    expect(kintaiCalls).toEqual([]);
    expect(kyuyoCalls).toEqual([]);
  });

  it("(a) 陰性対照: allowlist の内なら同じ要求が 200 で、給与大臣にブラウザの Authorization をそのまま渡す", async () => {
    const { get, d1, kintaiCalls, kyuyoCalls } = makeDO();
    const res = await get("from_year=2025&driver=912&source=gcp");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { years: Array<{ rows: Array<{ driverCd: string; adjustment: number; judgement: { status: string } }> }> };
    expect(body.years[0]!.rows).toMatchObject([{ driverCd: "0912", adjustment: 4, shortfall: { shortfall: 10 }, judgement: { status: "short", remaining: 6 } }]);
    // comp はセッションの値 (引数で取らない)
    expect(d1).toEqual([`employees ${OWN_COMP}`, `comp_payroll_map ${OWN_COMP}`]);
    expect(kintaiCalls).toHaveLength(1);
    expect(kintaiCalls[0]).toContain("/api/kintai/wage-range?");
    expect(kintaiCalls[0]).toContain(`comp=${OWN_COMP}`);
    expect(kintaiCalls[0]).toContain("source=gcp");
    expect(kintaiCalls[0]).toContain("from=2025-01&to=2025-12");
    // 賞与 1 社 + 月例 12 か月
    expect(kyuyoCalls).toHaveLength(13);
    expect(kyuyoCalls[0]).toEqual({ url: "https://ichibanboshi-kyuyo/kyuyo/bonus?company=0100&year=2025", auth: "Bearer viewer-jwt" });
    expect(kyuyoCalls.every((c) => c.auth === "Bearer viewer-jwt")).toBe(true);
  });

  it("★ (c) PDF は driver 必須 (400)、BROWSER が無ければ 503。どちらも上流を読まない", async () => {
    const a = makeDO({ browser: true });
    const r1 = await a.get("from_year=2025&format=pdf");
    expect(r1.status).toBe(400);
    expect(await r1.json()).toEqual({ error: "PDF は driver (乗務員CD) の指定が必要です" });
    expect([a.d1, a.kyuyoCalls]).toEqual([[], []]);

    const b = makeDO();
    const r2 = await b.get("from_year=2025&format=pdf&driver=912");
    expect(r2.status).toBe(503);
    expect([b.d1, b.kyuyoCalls]).toEqual([[], []]);
  });

  it("給与大臣が 403 を返したらその status で全体を失敗にし、表を返さない", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { get, kyuyoCalls } = makeDO({ kyuyoUpstreamStatus: 403 });
    const res = await get("from_year=2025");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "最低賃金 年間レポートを作れませんでした: 給与大臣 (bonus) が status 403 を返しました: forbidden" });
    expect(kyuyoCalls).toHaveLength(1);
  });
});
