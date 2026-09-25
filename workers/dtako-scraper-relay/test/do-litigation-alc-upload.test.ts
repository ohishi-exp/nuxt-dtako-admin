import { describe, expect, it, vi } from "vitest";

// do-restraint-viewer-all-comps.test.ts と同じ手。`cloudflare:workers` は Workers
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
 * `POST /restraint-api/litigation/alc-upload-driver` (Refs #1133 c1133-5) の**配線**。
 *
 * `canRunLitigationUpload` は 100% gate に載っているが、**呼び出し側が
 * 「保存済み theearth セッションを使わずに introspect を通す」「role を渡す」
 * 「comp を record から取る」かは gate では捕まらない** (`dtako-scraper-relay-do.ts` は
 * allowlist の外)。ここで測るのは:
 *
 * - (a) role admin / payroll で DO 内部 `/cron/dtako/alc-upload-driver` へ
 *       `comp_id = record.compId` で転送し、応答をそのまま返す
 * - (b) body に別の comp_id を入れても record.compId が使われる
 * - (c) role viewer / undefined は 403 で転送しない
 * - (d) 保存済み theearth セッションがあっても introspect を通して role を見る
 *
 * theearth へは 1 回も繋がない (転送先の DO を stub する)。メール・tenant は架空。
 */
const OWN_COMP = "27324455";
const OTHER_COMP = "75700192";
const OWN_TENANT = "tenant-of-own-comp";
const TOKEN = "dummy-jwt";

const ACCOUNTS = [
  { comp_id: OWN_COMP, user_name: "u1", user_pass: "p", tenant_id: OWN_TENANT },
  { comp_id: OTHER_COMP, user_name: "u2", user_pass: "p", tenant_id: "tenant-of-other-comp" },
];

const MISSING = Symbol("role キーごと欠落");

interface Setup {
  role?: unknown;
  active?: boolean;
  /** 保存済み theearth セッション (routing と token が一致する有効なもの) を置くか */
  storedSession?: boolean;
  devViewerComp?: string;
  /** 転送先が返す応答 */
  upstream?: () => Response;
}

function makeDO(opts: Setup = {}) {
  const introspect: Record<string, unknown> = {
    active: opts.active ?? true,
    tenant_id: OWN_TENANT,
    email: "viewer@example.com",
  };
  if (opts.role !== MISSING) introspect.role = "role" in opts ? opts.role : "admin";

  const introspectCalls: unknown[] = [];
  const forwarded: { name: string; url: string; body: unknown }[] = [];
  const env = {
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    ...(opts.devViewerComp ? { RESTRAINT_DEV_VIEWER_COMP: opts.devViewerComp } : {}),
    AUTH_WORKER: {
      fetch: async (req: Request) => {
        introspectCalls.push(req.url);
        return new Response(JSON.stringify(introspect), { status: 200 });
      },
    },
    RELAY: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (url: string, init: RequestInit) => {
          forwarded.push({ name: id.name, url, body: JSON.parse(String(init.body)) });
          return opts.upstream
            ? opts.upstream()
            : Response.json({ ok: true, operations_count: 7 }, { status: 200 });
        },
      }),
    },
  };
  const stored = opts.storedSession
    ? {
        token: TOKEN,
        compId: OWN_COMP,
        userName: "viewer",
        cookies: [],
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600_000,
      }
    : undefined;
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: {
      get: async () => stored,
      put: async () => {},
      delete: async () => {},
    },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const post = (body: unknown, compId = OWN_COMP, token: string | null = TOKEN) =>
    relay.fetch(
      new Request("https://relay.example/restraint-api/litigation/alc-upload-driver", {
        method: "POST",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "X-Theearth-Comp-Id": compId,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
          "content-type": "application/json",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }) as never,
    );
  return { post, introspectCalls, forwarded };
}

const BODY = { driver_cd: "1078", from: "2025-01-01", to: "2025-01-31" };

describe("POST /restraint-api/litigation/alc-upload-driver (Refs #1133 c1133-5)", () => {
  it("(a) role admin なら scraper-comp-{record.compId} の内部口へ comp_id = record.compId で転送する", async () => {
    const { post, forwarded } = makeDO({ role: "admin" });
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, operations_count: 7 });
    expect(forwarded).toEqual([
      {
        name: `scraper-comp-${OWN_COMP}`,
        url: "https://relay.internal/cron/dtako/alc-upload-driver",
        body: { ...BODY, comp_id: OWN_COMP },
      },
    ]);
  });

  it("(a) payroll も通る", async () => {
    const { post, forwarded } = makeDO({ role: "payroll" });
    expect((await post(BODY)).status).toBe(200);
    expect(forwarded).toHaveLength(1);
  });

  it("(a) 転送先の応答 (502 の空 ZIP 等) は status も本文もそのまま返す", async () => {
    const err = { error: "取得したデータが空の ZIP です (22 bytes) — …" };
    const { post } = makeDO({ upstream: () => Response.json(err, { status: 502 }) });
    const res = await post(BODY);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual(err);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("★ (b) body に別の comp_id を入れても record.compId が使われる (body の他のキーも渡さない)", async () => {
    const { post, forwarded } = makeDO();
    await post({ ...BODY, comp_id: OTHER_COMP, extra: "x" });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]!.name).toBe(`scraper-comp-${OWN_COMP}`);
    expect(forwarded[0]!.body).toEqual({ ...BODY, comp_id: OWN_COMP });
  });

  it("★ (c) role viewer / undefined / 型崩れは 403 で転送しない", async () => {
    for (const role of ["viewer", "member", undefined, MISSING, null, 1]) {
      const { post, forwarded } = makeDO({ role });
      const res = await post(BODY);
      expect(res.status, String(role === MISSING ? "欠落" : JSON.stringify(role))).toBe(403);
      expect(forwarded).toHaveLength(0);
    }
  });

  it("★ (d) 保存済み theearth セッションがあっても introspect を通して role を見る", async () => {
    // 陰性: 保存済みセッションは有効だが introspect の role が viewer → 403
    const denied = makeDO({ storedSession: true, role: "viewer" });
    expect((await denied.post(BODY)).status).toBe(403);
    expect(denied.introspectCalls).toHaveLength(1);
    expect(denied.forwarded).toHaveLength(0);
    // 陽性対照: 同じ保存済みセッションで introspect が admin → 転送される
    const allowed = makeDO({ storedSession: true, role: "admin" });
    expect((await allowed.post(BODY)).status).toBe(200);
    expect(allowed.introspectCalls).toHaveLength(1);
    expect(allowed.forwarded).toHaveLength(1);
  });

  it("(d) 保存済みセッションがあっても introspect が不成立なら 401 (保存済みに倒れない)", async () => {
    const { post, forwarded } = makeDO({ storedSession: true, active: false });
    expect((await post(BODY)).status).toBe(401);
    expect(forwarded).toHaveLength(0);
  });

  it("Bearer 無し・自 tenant 外の会社は 401", async () => {
    const noToken = makeDO();
    expect((await noToken.post(BODY, OWN_COMP, null)).status).toBe(401);
    const other = makeDO();
    expect((await other.post(BODY, OTHER_COMP)).status).toBe(401);
    expect(noToken.forwarded.length + other.forwarded.length).toBe(0);
  });

  it("dev の短絡 (RESTRAINT_DEV_VIEWER_COMP) は role を持たないので 403", async () => {
    const { post, forwarded, introspectCalls } = makeDO({ devViewerComp: OWN_COMP });
    expect((await post(BODY)).status).toBe(403);
    expect(forwarded).toHaveLength(0);
    expect(introspectCalls).toHaveLength(0);
  });

  it("JSON でない body は 400 (転送しない)", async () => {
    const { post, forwarded } = makeDO();
    expect((await post("not json")).status).toBe(400);
    expect(forwarded).toHaveLength(0);
  });
});
