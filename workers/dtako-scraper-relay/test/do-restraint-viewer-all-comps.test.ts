import { describe, expect, it, vi } from "vitest";

// do-scrape-alert.test.ts / do-cron-history-tenant.test.ts と同じ手。
// `cloudflare:workers` は Workers ランタイムでしか解決できないので、DurableObject を
// 素のクラスで差し替えて dtako-scraper-relay-do.ts を node vitest から読み込む。
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
 * ★ #1049 の**配線**に対する対照。
 *
 * `restraint-viewer-auth.ts` は 100% gate に載っているが、**gate が緑でも
 * 「呼び出し側が email を渡していない」は捕まらない**
 * (`dtako-scraper-relay-do.ts` は `vitest.config.ts` の allowlist に無く、
 * node vitest では計測できない)。ここで測るのは
 * **「allowlist 外の admin が他社を通せないこと」**と、
 * **「allowlist に載った email だけが全社を通せること」**の 2 点だけ。
 *
 * theearth へは 1 回も繋がない (viewer 経路は auth-worker introspect だけを使う)。
 *
 * ★ メールアドレスは**全部ダミー** (`example.com`)。この repo は public で、
 * 実際に許可するアカウントは Cloudflare dashboard の plain 変数にしか無い。
 * comp_id は既出の 2 つだけを使い、tenant_id は架空の文字列にする。
 */
const ALLOWED_EMAIL = "viewer@example.com";
const OTHER_EMAIL = "someone-else@example.com";
const ALLOWLIST = JSON.stringify([ALLOWED_EMAIL]);

/** 自 tenant 側の会社。 */
const OWN_COMP = "27324455";
/** 別 tenant の会社 (ここが通ってしまうのが #1049 の穴)。 */
const OTHER_COMP = "75700192";
const OWN_TENANT = "tenant-of-own-comp";

const ACCOUNTS = [
  { comp_id: OWN_COMP, user_name: "u1", user_pass: "p", tenant_id: OWN_TENANT },
  { comp_id: OTHER_COMP, user_name: "u2", user_pass: "p", tenant_id: "tenant-of-other-comp" },
];

/** D1 `comp_payroll_map` の最小行 (会社名は架空)。 */
const COMP_MAP_ROWS = [
  {
    comp_id: OWN_COMP,
    comp_label: "会社A",
    payroll_company: "0100",
    legacy_label: null,
    payroll_company_name: "会社A給与",
    sort_order: 1,
  },
  {
    comp_id: OTHER_COMP,
    comp_label: "会社B",
    payroll_company: "0400",
    legacy_label: null,
    payroll_company_name: "会社B給与",
    sort_order: 1,
  },
];

interface CompMapBody {
  comps: Array<{ compId: string }>;
}

function makeDO(opts: { allowlist?: string; email?: string; role?: string } = {}) {
  /** introspect の応答。**role は既定で admin** — 「admin でも通らない」を測るため。 */
  const introspect = {
    active: true,
    tenant_id: OWN_TENANT,
    role: "role" in opts ? opts.role : "admin",
    email: "email" in opts ? opts.email : ALLOWED_EMAIL,
  };
  const env = {
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    ALL_COMPS_VIEWER_EMAILS: opts.allowlist,
    AUTH_WORKER: {
      fetch: async () => new Response(JSON.stringify(introspect), { status: 200 }),
    },
    DTAKO_DB: {
      prepare: () => ({
        all: async () => ({ results: COMP_MAP_ROWS }),
      }),
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    storage: {
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
    },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  /** `/restraint-api/comp-map` を viewer 経路 (Bearer JWT) で叩く。 */
  const compMap = (compId: string) =>
    relay.fetch(
      new Request("https://relay.example/restraint-api/comp-map", {
        headers: {
          Authorization: "Bearer dummy-jwt",
          "X-Theearth-Comp-Id": compId,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
        },
      }) as never,
    );
  return { compMap };
}

describe("viewer 経路の全社許可は ALL_COMPS_VIEWER_EMAILS だけ (Refs #1049)", () => {
  it("★ 陰性対照: allowlist 未設定なら、role が admin でも他社は 401", async () => {
    const { compMap } = makeDO({ allowlist: undefined });
    expect((await compMap(OTHER_COMP)).status).toBe(401);
  });

  it("★ 陰性対照: allowlist 未設定なら、会社対応表も自 tenant の会社しか返さない", async () => {
    const { compMap } = makeDO({ allowlist: undefined });
    const res = await compMap(OWN_COMP);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CompMapBody).comps.map((c) => c.compId)).toEqual([OWN_COMP]);
  });

  it("★ 陰性対照: 壊れた設定 (不正 JSON / 配列でない / 空配列) でも他社は 401", async () => {
    for (const allowlist of ["not json", '{"emails":["viewer@example.com"]}', "[]"]) {
      const { compMap } = makeDO({ allowlist });
      expect((await compMap(OTHER_COMP)).status, allowlist).toBe(401);
    }
  });

  it("★ 陰性対照: allowlist に載っていない email は、role が admin でも他社は 401", async () => {
    const { compMap } = makeDO({ allowlist: ALLOWLIST, email: OTHER_EMAIL });
    expect((await compMap(OTHER_COMP)).status).toBe(401);
  });

  it("★ 陰性対照: introspect が email を返さないと他社は 401", async () => {
    const { compMap } = makeDO({ allowlist: ALLOWLIST, email: undefined });
    expect((await compMap(OTHER_COMP)).status).toBe(401);
  });

  it("allowlist に載っている email は他社を通せる (role は admin でなくてよい)", async () => {
    const { compMap } = makeDO({ allowlist: ALLOWLIST, role: "member" });
    expect((await compMap(OTHER_COMP)).status).toBe(200);
  });

  it("allowlist に載っている email は会社対応表も全社ぶん見られる", async () => {
    const { compMap } = makeDO({ allowlist: ALLOWLIST, role: "member" });
    const res = await compMap(OWN_COMP);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CompMapBody).comps.map((c) => c.compId).sort()).toEqual(
      [OWN_COMP, OTHER_COMP].sort(),
    );
  });

  it("大文字小文字・前後空白が違う email でも通る", async () => {
    const { compMap } = makeDO({
      allowlist: JSON.stringify([" VIEWER@Example.COM "]),
      email: "Viewer@Example.com",
      role: "member",
    });
    expect((await compMap(OTHER_COMP)).status).toBe(200);
  });

  it("DTAKO_ACCOUNTS に無い会社は allowlist に載っていても 401 (ヘッダ偽装対策)", async () => {
    const { compMap } = makeDO({ allowlist: ALLOWLIST });
    expect((await compMap("99999999")).status).toBe(401);
  });
});
