import { afterEach, describe, expect, it, vi } from "vitest";

// do-cron-dvr.test.ts と同じ手。`cloudflare:workers` を素のクラスで差し替えて DO を読み込む。
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

/**
 * DVR 動画ビューアの「表示」(`GET /dvr-api/file`) の**配線**の対照。
 *
 * 10 分おきの DVR cron が R2 に置いた `.vdf` があれば theearth に行かずにそれを返し、
 * 無い・読めない時だけ従来どおり theearth から取る。ここで測るのは DO にしか無い 3 つ:
 *
 * 1. R2 を読むテナントが **セッションの comp_id を DTAKO_ACCOUNTS で引いた `tenant_id`** であること
 *    (cron が書いた key と同じテナント。別の値にすると他社の映像を読める)
 * 2. R2 にあれば **theearth を 1 度も叩かない**こと (theearth が固まっていても出る)
 * 3. R2 に無い・読めない・会社が DTAKO_ACCOUNTS に無い時は **theearth へ落ちる**こと
 *
 * `dtako-scraper-relay-do.ts` は 100% gate の対象外なので、カバレッジの緑はこの 3 点の根拠にならない。
 */

(globalThis as unknown as { WebSocketRequestResponsePair: unknown }).WebSocketRequestResponsePair =
  class {
    constructor(_req: string, _res: string) {}
  };

const COMP_ID = "27324455";
const TENANT_ID = "tenant-of-27324455"; // 架空の値
const OTHER_TENANT = "tenant-of-99999999";
const ACCOUNTS = [
  { comp_id: COMP_ID, tenant_id: TENANT_ID, user_name: "u", user_pass: "p" },
  { comp_id: "99999999", tenant_id: OTHER_TENANT, user_name: "u2", user_pass: "p2" },
];

const R2_BYTES = new Uint8Array([0x4e, 0x45, 0x54, 0x37, 0x38, 0x30, 0xaa]);
const THEEARTH_BYTES = new Uint8Array([0x4e, 0x45, 0x54, 0x37, 0x38, 0x30, 0xbb]);

function record(compId: string) {
  return {
    token: "t",
    compId,
    userName: "viewer",
    cookies: [["ASP.NET_SessionId", "s1"]] as Array<[string, string]>,
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
  };
}

/** theearth (VenusBridge → /dvrData) を答える。呼ばれた URL を記録する。 */
function stubTheearth(): string[] {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("Request_DvrFileDownload")) {
      return new Response(JSON.stringify({ d: [1, "gen\\out.vdf", "out.vdf"] }), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    if (url.includes("/dvrData/")) return new Response(THEEARTH_BYTES, { status: 200 });
    throw new Error(`unexpected theearth call: ${url}`);
  });
  return calls;
}

interface AlcCall {
  url: string;
  headers: Record<string, string>;
}

function makeDO(alcResponse: () => Response) {
  const alcCalls: AlcCall[] = [];
  const env = {
    DTAKO_CONFIG_KV: {
      get: async (key: string) => (key === "dtako_accounts" ? JSON.stringify(ACCOUNTS) : null),
    },
    INTERNAL_SHARED_SECRET: "shared-1",
    AUTH_WORKER: {
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        alcCalls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
        return alcResponse();
      },
    },
  };
  const ctx = {
    setWebSocketAutoResponse: () => {},
    waitUntil: () => {},
    storage: { get: async () => undefined, put: async () => {}, delete: async () => {} },
  };
  const relay = new DtakoScraperRelayDO(ctx as never, env as never);
  const handle = (
    relay as unknown as {
      handleDvrFile(rec: ReturnType<typeof record>, url: URL): Promise<Response>;
    }
  ).handleDvrFile.bind(relay);
  const get = (compId: string) =>
    handle(record(compId), new URL("https://relay/dvr-api/file?serial=SER-1&filename=F1.vdf"));
  return { alcCalls, get };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DtakoScraperRelayDO#handleDvrFile", () => {
  it("★ R2 にあれば theearth を叩かずに返す。読むテナントは DTAKO_ACCOUNTS の tenant_id", async () => {
    const theearthCalls = stubTheearth();
    const { alcCalls, get } = makeDO(() => new Response(R2_BYTES, { status: 200 }));

    const res = await get(COMP_ID);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-dvr-source")).toBe("r2");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(R2_BYTES);
    expect(theearthCalls).toEqual([]);
    expect(alcCalls).toHaveLength(1);
    const url = new URL(alcCalls[0]!.url);
    expect(url.pathname).toBe("/alc-internal-proxy/api/dvr/file");
    expect(url.searchParams.get("serial_no")).toBe("SER-1");
    expect(url.searchParams.get("file_name")).toBe("F1.vdf");
    expect(alcCalls[0]!.headers["X-Alc-Proxy-Secret"]).toBe("shared-1");
    expect(alcCalls[0]!.headers["X-Tenant-ID"]).toBe(TENANT_ID);
    expect(alcCalls[0]!.headers["X-Tenant-ID"]).not.toBe(OTHER_TENANT);
  });

  it.each([
    ["まだ置いていない (404)", () => new Response(null, { status: 404 })],
    ["読めない (502)", () => new Response("", { status: 502 })],
    ["NET780 でない中身", () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7]), { status: 200 })],
  ])("R2 が %s なら theearth から取る", async (_label, alcResponse) => {
    const theearthCalls = stubTheearth();
    const { alcCalls, get } = makeDO(alcResponse);

    const res = await get(COMP_ID);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-dvr-source")).toBe("theearth");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(THEEARTH_BYTES);
    expect(alcCalls).toHaveLength(1);
    expect(theearthCalls.some((u) => u.includes("Request_DvrFileDownload"))).toBe(true);
    expect(theearthCalls.some((u) => u.includes("/dvrData/gen/out.vdf"))).toBe(true);
  });

  it("会社が DTAKO_ACCOUNTS に無ければ R2 を見ずに theearth から取る", async () => {
    const theearthCalls = stubTheearth();
    const { alcCalls, get } = makeDO(() => new Response(R2_BYTES, { status: 200 }));

    const res = await get("12345678");

    expect(res.headers.get("x-dvr-source")).toBe("theearth");
    expect(alcCalls).toEqual([]);
    expect(theearthCalls.length).toBeGreaterThan(0);
  });
});
