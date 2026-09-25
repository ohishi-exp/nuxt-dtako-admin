import { describe, expect, it, vi } from "vitest";

// do-litigation-alc-upload.test.ts と同じ手。`cloudflare:workers` は Workers
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
 * `GET /restraint-api/kintai/change-log` (Refs #1133 c1133-6) の**配線**。
 *
 * `relayKintaiChangeLog` (kintai-relay.ts) は 100% gate に載っている pure ロジックだが、
 * 呼び出し側 (`dtako-scraper-relay-do.ts`) が「record.compId を KINTAI_COMP_ID と
 * 直接突き合わせる」「driver/from/to を検証してから渡す」かは gate では捕まらない
 * (このファイルは allowlist の外)。ここで測るのは:
 *
 * - (a) record.compId === KINTAI_COMP_ID なら ichibanboshi へ中継し応答をそのまま返す
 * - (b) 別の compId (同じ tenant で viewer 認可自体は通る) は 403 で中継しない
 * - (c) KINTAI_COMP_ID 未設定は 403 (viewer 認可が通る compId でも)
 * - (d) driver / from / to の不正は 400 (中継しない)
 *
 * ichibanboshi へは実際には繋がない (AUTH_WORKER.fetch を stub する)。
 */
const OWN_COMP = "27324455";
const OTHER_COMP_SAME_TENANT = "75700192";
const TENANT = "tenant-of-both-comps";
const TOKEN = "dummy-jwt";

const ACCOUNTS = [
  { comp_id: OWN_COMP, user_name: "u1", user_pass: "p", tenant_id: TENANT },
  { comp_id: OTHER_COMP_SAME_TENANT, user_name: "u2", user_pass: "p", tenant_id: TENANT },
];

const SAMPLE_LOG = {
  driver: "1078",
  from: "2026-06-01",
  to: "2026-06-30",
  recording_since: "2026-09-25",
  changes: [],
};

interface Setup {
  /** 未指定なら OWN_COMP と同じ値 (= 対象会社) */
  kintaiCompId?: string | undefined;
  upstream?: () => Response;
}

function makeDO(opts: Setup = {}) {
  const introspectCalls: string[] = [];
  const gcpCalls: string[] = [];
  const env = {
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
          introspectCalls.push(url);
          return Response.json({ active: true, tenant_id: TENANT, email: "viewer@example.com" });
        }
        gcpCalls.push(url);
        return opts.upstream ? opts.upstream() : Response.json(SAMPLE_LOG);
      }),
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: {
      // 保存済み theearth セッションは無し — viewer (auth-worker JWT) 経路のみ試す
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
    },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const get = (query: string, compId = OWN_COMP, token: string | null = TOKEN) =>
    relay.fetch(
      new Request(`https://relay.example/restraint-api/kintai/change-log${query}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Theearth-Comp-Id": compId,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
        },
      }) as never,
    );
  return { get, introspectCalls, gcpCalls };
}

const OK_QUERY = "?driver=1078&from=2026-06-01&to=2026-06-30";

describe("GET /restraint-api/kintai/change-log (Refs #1133 c1133-6)", () => {
  it("(a) record.compId === KINTAI_COMP_ID なら ichibanboshi へ中継し、応答をそのまま返す", async () => {
    const { get, gcpCalls } = makeDO();
    const res = await get(OK_QUERY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE_LOG);
    expect(gcpCalls).toHaveLength(1);
    expect(gcpCalls[0]).toContain("/ichibanboshi-proxy/api/kintai/change-log");
    expect(gcpCalls[0]).toContain("driver=1078");
    expect(gcpCalls[0]).toContain("from=2026-06-01");
    expect(gcpCalls[0]).toContain("to=2026-06-30");
  });

  it("★ (b) viewer 認可自体は通る別会社 (同じ tenant) は 403 で中継しない", async () => {
    const { get, gcpCalls } = makeDO();
    const res = await get(OK_QUERY, OTHER_COMP_SAME_TENANT);
    expect(res.status).toBe(403);
    expect(gcpCalls).toHaveLength(0);
  });

  it("★ (c) KINTAI_COMP_ID 未設定は 403 (viewer 認可が通る会社でも中継しない)", async () => {
    const { get, gcpCalls } = makeDO({ kintaiCompId: undefined });
    const res = await get(OK_QUERY);
    expect(res.status).toBe(403);
    expect(gcpCalls).toHaveLength(0);
  });

  it("★ (c) KINTAI_COMP_ID が空文字も対象外と同じ扱い (403)", async () => {
    const { get, gcpCalls } = makeDO({ kintaiCompId: "" });
    const res = await get(OK_QUERY);
    expect(res.status).toBe(403);
    expect(gcpCalls).toHaveLength(0);
  });

  it("★ (d) driver が数字でなければ 400 (中継しない)", async () => {
    const { get, gcpCalls } = makeDO();
    const res = await get("?driver=D1&from=2026-06-01&to=2026-06-30");
    expect(res.status).toBe(400);
    expect(gcpCalls).toHaveLength(0);
  });

  it("★ (d) from/to が YYYY-MM-DD でなければ 400 (中継しない)", async () => {
    const { get, gcpCalls } = makeDO();
    const res = await get("?driver=1078&from=2026-6-1&to=2026-06-30");
    expect(res.status).toBe(400);
    expect(gcpCalls).toHaveLength(0);
  });

  it("★ (d) from が to より後ろなら 400 (中継しない)", async () => {
    const { get, gcpCalls } = makeDO();
    const res = await get("?driver=1078&from=2026-06-30&to=2026-06-01");
    expect(res.status).toBe(400);
    expect(gcpCalls).toHaveLength(0);
  });

  it("★ (d) from〜to が 400 日を超えたら 400 (中継せず落ちる — relayKintaiChangeLog の検証)", async () => {
    const { get, gcpCalls } = makeDO();
    const res = await get("?driver=1078&from=2025-01-01&to=2026-02-05");
    expect(res.status).toBe(400);
    expect(gcpCalls).toHaveLength(0);
  });

  it("上流が落ちたら 502", async () => {
    const { get } = makeDO({ upstream: () => new Response("boom", { status: 500 }) });
    const res = await get(OK_QUERY);
    expect(res.status).toBe(502);
  });

  it("Bearer 無し・自 tenant 外の会社は 401 (KINTAI_COMP_ID チェックより前で落ちる)", async () => {
    const noToken = makeDO();
    expect((await noToken.get(OK_QUERY, OWN_COMP, null)).status).toBe(401);
    const otherTenant = makeDO();
    expect((await otherTenant.get(OK_QUERY, "9999999")).status).toBe(401);
  });
});
