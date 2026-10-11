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
 * `POST /restraint-api/wage-snapshot` の書き先の振り分け (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * `kintaiWriteDeps` (kintai-relay.ts) は 100% gate に載る pure ロジックだが、DO が「どの条件で
 * Worker へ回すか」「関門 (kyuyoAccessGate) を Worker の経路でも先に通すか」は gate では捕まらない。
 * ここで測るのは:
 *
 * - (a) 本番設定 (KINTAI あり・comp = KINTAI_COMP_ID・token あり) → Worker だけを呼び、AUTH_WORKER の上流は呼ばない
 * - (b) KINTAI 無し・comp 違い・token が読めない → 今の経路 (auth-worker の /ichibanboshi-proxy) のまま
 * - (c) allowlist の外は 403 で、Worker にも auth-worker の上流にも届かない
 */
const OWN_COMP = "27324455";
const OTHER_COMP_SAME_TENANT = "75700192";
const TENANT = "tenant-of-both-comps";
const WRITE_TOKEN = "dummy-write-token";
const SAVED = { saved: 3, skipped_unchanged: false };

const ACCOUNTS = [
  { comp_id: OWN_COMP, user_name: "u1", user_pass: "p", tenant_id: TENANT },
  { comp_id: OTHER_COMP_SAME_TENANT, user_name: "u2", user_pass: "p", tenant_id: TENANT },
];

interface Setup {
  /** 勤怠 Worker の binding を置くか (既定 true)。 */
  kintai?: boolean;
  /** `KINTAI_WRITE_TOKEN` の binding (既定 = Secrets Store 形で WRITE_TOKEN)。 */
  writeToken?: unknown;
  /** kyuyo の allowlist の判定 (既定 200)。 */
  kyuyoStatus?: number;
  /** 勤怠 Worker の応答 (既定 SAVED)。 */
  kintaiResponse?: () => Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function makeDO(opts: Setup = {}) {
  const upstreamCalls: { url: string; headers: Record<string, string> }[] = [];
  const kintaiCalls: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const env = {
    ...(opts.kintai === false
      ? {}
      : {
          KINTAI: {
            fetch: vi.fn(async (url: string, init?: RequestInit) => {
              kintaiCalls.push({
                url,
                headers: init?.headers as Record<string, string>,
                body: JSON.parse(String(init?.body)),
              });
              return opts.kintaiResponse ? opts.kintaiResponse() : Response.json(SAVED);
            }),
          },
        }),
    KINTAI_WRITE_TOKEN: "writeToken" in opts ? opts.writeToken : { get: async () => WRITE_TOKEN },
    AUTH_KYUYO: { authorize: async () => ({ status: opts.kyuyoStatus ?? 200, body: "" }) },
    DTAKO_CONFIG_KV: { get: async () => JSON.stringify(ACCOUNTS) },
    INTERNAL_SHARED_SECRET: "shared-secret",
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: "csecret",
    NUXT_ICHIBAN_API_URL: "https://ichiban.invalid",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid",
    KINTAI_COMP_ID: OWN_COMP,
    AUTH_WORKER: {
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/introspect")) {
          return Response.json({ active: true, tenant_id: TENANT, email: "viewer@example.com" });
        }
        upstreamCalls.push({ url, headers: init?.headers as Record<string, string> });
        return Response.json(SAVED);
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
  const post = (compId = OWN_COMP) =>
    relay.fetch(
      new Request("https://relay.example/restraint-api/wage-snapshot", {
        method: "POST",
        headers: {
          Authorization: "Bearer dummy-jwt",
          "X-Theearth-Comp-Id": compId,
          // base64url("viewer")
          "X-Theearth-User-B64": "dmlld2Vy",
          "content-type": "application/json",
        },
        body: JSON.stringify({ comp_id: "他社のID", month: "2026-06", rows: [] }),
      }) as never,
    );
  return { post, upstreamCalls, kintaiCalls };
}

describe("POST /restraint-api/wage-snapshot の書き先 (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  it("(a) 本番設定なら勤怠 Worker へ書き、auth-worker の上流は呼ばない。ヘッダーは content-type と token だけ", async () => {
    const { post, upstreamCalls, kintaiCalls } = makeDO();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAVED);
    expect(upstreamCalls).toEqual([]);
    expect(kintaiCalls).toHaveLength(1);
    expect(kintaiCalls[0]!.url).toBe("https://ichibanboshi-kintai/api/kintai/wage-snapshot");
    expect(kintaiCalls[0]!.headers).toEqual({
      "content-type": "application/json",
      "X-Kintai-Write-Token": WRITE_TOKEN,
    });
    // comp_id は呼び出し元の値を捨てて認可済みの値で上書きする (経路 A と同じ)
    expect(kintaiCalls[0]!.body).toEqual({ comp_id: OWN_COMP, month: "2026-06", rows: [] });
  });

  it("(a) token は素の文字列の binding でも読める", async () => {
    const { post, upstreamCalls, kintaiCalls } = makeDO({ writeToken: WRITE_TOKEN });
    expect((await post()).status).toBe(200);
    expect(upstreamCalls).toEqual([]);
    expect(kintaiCalls[0]!.headers["X-Kintai-Write-Token"]).toBe(WRITE_TOKEN);
  });

  /** 経路 A (auth-worker → /ichibanboshi-proxy) に送られたことを確かめる。 */
  function expectRouteA(upstreamCalls: { url: string; headers: Record<string, string> }[]) {
    expect(upstreamCalls.map((c) => c.url)).toEqual([
      "https://auth-worker.internal/ichibanboshi-proxy/api/kintai/wage-snapshot",
    ]);
    expect(upstreamCalls[0]!.headers["X-Tenant-ID"]).toBe(TENANT);
    expect(upstreamCalls[0]!.headers["X-Kintai-Write-Token"]).toBeUndefined();
  }

  it("★ (b) KINTAI が無ければ今の経路 A のまま", async () => {
    const { post, upstreamCalls } = makeDO({ kintai: false });
    expect((await post()).status).toBe(200);
    expectRouteA(upstreamCalls);
  });

  it("★ (b) comp が KINTAI_COMP_ID と違えば今の経路 A のまま (Worker の固定テナントに他社を書かない)", async () => {
    const { post, upstreamCalls, kintaiCalls } = makeDO();
    expect((await post(OTHER_COMP_SAME_TENANT)).status).toBe(200);
    expect(kintaiCalls).toEqual([]);
    expectRouteA(upstreamCalls);
  });

  it("★ (b) token の binding が無ければ今の経路 A のまま (token 無しで Worker に送って 403 にしない)", async () => {
    const { post, upstreamCalls, kintaiCalls } = makeDO({ writeToken: undefined });
    expect((await post()).status).toBe(200);
    expect(kintaiCalls).toEqual([]);
    expectRouteA(upstreamCalls);
  });

  it("★ (b) token が読めない (get が throw) なら経路 A に倒し、ログは wage_snapshot のキーで token を出さない", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    const { post, upstreamCalls, kintaiCalls } = makeDO({
      writeToken: {
        get: async () => {
          throw new Error("secrets store unavailable");
        },
      },
    });
    expect((await post()).status).toBe(200);
    expect(kintaiCalls).toEqual([]);
    expectRouteA(upstreamCalls);
    const logged = errors.find((e) => e.includes("secret-error"))!;
    expect(JSON.parse(logged)).toEqual({ wage_snapshot: "secret-error", error: "Error: secrets store unavailable" });
    expect(errors.join("\n")).not.toContain("restraint_push");
  });

  it("★ (c) allowlist の外は 403 で、Worker にも auth-worker の上流にも届かない", async () => {
    const { post, upstreamCalls, kintaiCalls } = makeDO({ kyuyoStatus: 403 });
    const res = await post();
    expect(res.status).toBe(403);
    expect(kintaiCalls).toEqual([]);
    expect(upstreamCalls).toEqual([]);
  });

  it("Worker の 403 は今の非 2xx と同じく 502 で、本文の先頭を error に載せる", async () => {
    const { post } = makeDO({
      kintaiResponse: () =>
        new Response("書き込みの口には正しい X-Kintai-Write-Token が要ります", { status: 403 }),
    });
    const res = await post();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("賃金スナップショットの保存に失敗しました");
    expect(body.error).toContain("403");
    expect(body.error).not.toContain(WRITE_TOKEN);
  });
});
