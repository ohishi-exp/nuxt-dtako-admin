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
 * 「呼び出し側が `org_wide` を渡していない」は捕まらない**
 * (`dtako-scraper-relay-do.ts` は `vitest.config.ts` の allowlist に無く、
 * node vitest では計測できない)。ここで測るのは
 * **「`org_wide` が無い/偽の admin が他社を通せないこと」**と、
 * **「`org_wide: true` だけが全社を通せること」**の 2 点。
 *
 * theearth へは 1 回も繋がない。**`RESTRAINT_DEV_VIEWER_COMP` の開発用短絡も
 * 使わない** — あれは `authorizeRestraintViewer` の先頭で即 return するので
 * `allowedViewerComps` に一度も入らず、**測りたい認可そのものを迂回する**。
 * 代わりに `AUTH_WORKER` binding (introspect) を stub して本物の経路を通す。
 *
 * ★ メールアドレスは**ダミー** (`example.com`)。comp_id は既出の 2 つだけを使い、
 * tenant_id は架空の文字列にする。**この repo は public。**
 */
const VIEWER_EMAIL = "viewer@example.com";

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

/** introspect の `org_wide` として届きうる「true ではないもの」。
 * **どれも全社許可にならないこと。** `"false"` は `Boolean("false") === true`。
 * `MISSING` は**キーごと欠落** (= #1049 以前の古い auth-worker)。 */
const MISSING = Symbol("org_wide キーごと欠落");
const NOT_TRUE: unknown[] = [MISSING, undefined, null, false, "false", "true", 0, 1];

interface CompMapBody {
  comps: Array<{ compId: string }>;
}

function makeDO(opts: { orgWide?: unknown; role?: string } = {}) {
  /** introspect の応答。**role は既定で admin** — 「admin でも通らない」を測るため。 */
  const introspect: Record<string, unknown> = {
    active: true,
    tenant_id: OWN_TENANT,
    role: "role" in opts ? opts.role : "admin",
    email: VIEWER_EMAIL,
  };
  // MISSING のときだけキーごと置かない (undefined を明示的に置くのとは別物)。
  if (opts.orgWide !== MISSING) introspect.org_wide = opts.orgWide;

  const env = {
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
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

/** ループの失敗メッセージ用。`undefined` は JSON.stringify が undefined を返す。 */
function label(v: unknown): string {
  return v === MISSING ? "org_wide キーごと欠落" : String(JSON.stringify(v));
}

describe("viewer 経路の全社許可は introspect の org_wide だけ (Refs #1049)", () => {
  it("★ 陰性対照: org_wide が true でない 8 形すべてで、role が admin でも他社は 401", async () => {
    for (const v of NOT_TRUE) {
      const { compMap } = makeDO({ orgWide: v });
      expect((await compMap(OTHER_COMP)).status, label(v)).toBe(401);
    }
  });

  it("★ 陰性対照: org_wide が無ければ、会社対応表も自 tenant の会社しか返さない", async () => {
    const { compMap } = makeDO({ orgWide: MISSING });
    const res = await compMap(OWN_COMP);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CompMapBody).comps.map((c) => c.compId)).toEqual([OWN_COMP]);
  });

  it('★ 陰性対照: 文字列 "false" でも会社対応表は自 tenant のみ (Boolean("false") は true)', async () => {
    const { compMap } = makeDO({ orgWide: "false" });
    const res = await compMap(OWN_COMP);
    expect(((await res.json()) as CompMapBody).comps.map((c) => c.compId)).toEqual([OWN_COMP]);
  });

  it("org_wide: true なら他社を通せる (role は admin でなくてよい)", async () => {
    const { compMap } = makeDO({ orgWide: true, role: "member" });
    expect((await compMap(OTHER_COMP)).status).toBe(200);
  });

  it("org_wide: true なら会社対応表も全社ぶん見られる", async () => {
    const { compMap } = makeDO({ orgWide: true, role: "member" });
    const res = await compMap(OWN_COMP);
    expect(res.status).toBe(200);
    expect(((await res.json()) as CompMapBody).comps.map((c) => c.compId).sort()).toEqual(
      [OWN_COMP, OTHER_COMP].sort(),
    );
  });

  it("DTAKO_ACCOUNTS に無い会社は org_wide: true でも 401 (ヘッダ偽装対策)", async () => {
    const { compMap } = makeDO({ orgWide: true });
    expect((await compMap("99999999")).status).toBe(401);
  });

  it("org_wide に関わらず自 tenant の会社は従来どおり通る", async () => {
    const { compMap } = makeDO({ orgWide: MISSING });
    expect((await compMap(OWN_COMP)).status).toBe(200);
  });
});
