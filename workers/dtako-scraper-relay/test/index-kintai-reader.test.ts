import { afterEach, describe, expect, it, vi } from "vitest";

// index-kintai-gcp-read.test.ts と同じ手当て (index.ts が DO を re-export するため)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { type RelayWorkerEnv } from "../src/index";

/**
 * `/kintai-relay/*` の機械経路 (run・recalc・勤怠の読み 3 口) の送り先 (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * - 勤怠 Worker の binding だけへ送る。素の fetch (旧オンプレ版) と auth-worker は呼ばない
 * - binding が無ければ 503
 * - 呼び手の `X-Alc-Proxy-Secret` の照合と `INTERNAL_SHARED_SECRET` の必須は binding があっても残る
 */
const SECRET = "internal-shared-secret";
const COMP_ID = "27324455";

interface Setup {
  kintaiBinding?: boolean;
  sharedSecret?: boolean;
  /** `KINTAI_WRITE_TOKEN` の binding (既定は本番の形の文字列)。 */
  writeToken?: unknown;
  /** AUTH_WORKER を置くか (既定 true)。 */
  authWorker?: boolean;
}

function fakeEnv(opts: Setup = {}) {
  const authWorker: string[] = [];
  const kintai: { url: string; method: string; headers: Record<string, string> }[] = [];
  /** 素の fetch (旧オンプレ版の経路)。勤怠では 1 回も呼ばない。 */
  const bare: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      bare.push(String(input));
      return Response.json({ drivers: [], events: [] });
    }),
  );
  const env = {
    ...(opts.sharedSecret === false ? {} : { INTERNAL_SHARED_SECRET: SECRET }),
    ...(opts.kintaiBinding === false
      ? {}
      : {
          KINTAI: {
            fetch: vi.fn(async (url: string, init?: RequestInit) => {
              kintai.push({
                url,
                method: init?.method ?? "GET",
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
              });
              return Response.json({ month: "2026-06", drivers: [], events: [], summaries: {}, items: [] });
            }),
          },
        }),
    KINTAI_COMP_ID: COMP_ID,
    KINTAI_WRITE_TOKEN: "writeToken" in opts ? opts.writeToken : "write-token",
    DTAKO_ACCOUNTS: JSON.stringify([{ comp_id: COMP_ID, tenant_id: "tenant" }]),
    ...(opts.authWorker === false
      ? {}
      : {
          AUTH_WORKER: {
            fetch: vi.fn(async (input: RequestInfo | URL) => {
              authWorker.push(String(input));
              return Response.json({ drivers_written: 0, fold: {}, stale: {} });
            }),
          },
        }),
  } as unknown as RelayWorkerEnv;
  return { env, authWorker, kintai, bare };
}

const post = (path: string, body: unknown, secret = SECRET) =>
  new Request(`https://relay.internal${path}`, {
    method: "POST",
    headers: { "X-Alc-Proxy-Secret": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (path: string, secret = SECRET) =>
  new Request(`https://relay.internal${path}`, { headers: { "X-Alc-Proxy-Secret": secret } });

type Case = [label: string, request: (secret?: string) => Request];
const ROUTES: Case[] = [
  ["POST /kintai-relay/run", (s) => post("/kintai-relay/run", { month: "2026-06", month_count: 1 }, s)],
  ["POST /kintai-relay/recalc", (s) => post("/kintai-relay/recalc", { month: "2026-06" }, s)],
  ["GET /kintai-relay/day-summaries", (s) => get("/kintai-relay/day-summaries?month=2026-06", s)],
  ["GET /kintai-relay/shift-overlaps", (s) => get("/kintai-relay/shift-overlaps?month=2026-06", s)],
  [
    "POST /kintai-relay/y-time-shifts",
    (s) => post("/kintai-relay/y-time-shifts", { driver_cd: "9001", from: "2026-06-01", to: "2026-06-30", tenant_id: "tenant" }, s),
  ],
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/kintai-relay/* の送り先は勤怠 Worker だけ (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  it.each(ROUTES)("%s: binding があれば 200 で、素の fetch も auth-worker も呼ばない", async (_label, request) => {
    const { env, bare, authWorker } = fakeEnv();
    const res = await worker.fetch(request(), env);
    expect(res.status).toBe(200);
    expect(bare).toEqual([]);
    expect(authWorker).toEqual([]);
  });

  it.each(ROUTES)("%s: binding が無ければ 503", async (_label, request) => {
    const { env, authWorker, bare } = fakeEnv({ kintaiBinding: false });
    const res = await worker.fetch(request(), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("kintai-relay not configured");
    expect(authWorker).toEqual([]);
    expect(bare).toEqual([]);
  });

  it.each(ROUTES)("%s: binding があっても X-Alc-Proxy-Secret が違えば 401", async (_label, request) => {
    const { env, authWorker, kintai } = fakeEnv();
    const res = await worker.fetch(request("wrong"), env);
    expect(res.status).toBe(401);
    expect(authWorker).toEqual([]);
    expect(kintai).toEqual([]);
  });

  it.each(ROUTES)("%s: binding があっても INTERNAL_SHARED_SECRET が無ければ 503", async (_label, request) => {
    const { env, kintai } = fakeEnv({ sharedSecret: false });
    const res = await worker.fetch(request(""), env);
    expect(res.status).toBe(503);
    expect(kintai).toEqual([]);
  });

  it("run の打刻 (timecard/events) は本番の設定で Worker に飛び、secret を付けない (window は token だけ)", async () => {
    const { env, kintai, bare, authWorker } = fakeEnv();
    const res = await worker.fetch(ROUTES[0]![1](), env);
    expect(res.status).toBe(200);
    expect(bare).toEqual([]);
    expect(authWorker).toEqual([]);
    expect(kintai.map((c) => c.url)).toEqual([
      "https://ichibanboshi-kintai/api/kintai/timecard/events?months=2026-06",
      "https://ichibanboshi-kintai/api/kintai/timecard/window",
    ]);
    expect(kintai[0]!.headers).toEqual({ accept: "application/json", "x-kintai-tenant-id": "tenant" });
    expect(kintai[1]!.headers).toEqual({
      "content-type": "application/json",
      "x-kintai-write-token": "write-token",
      "x-kintai-tenant-id": "tenant",
    });
  });
});

describe("/kintai-relay/run・/kintai-relay/recalc は勤怠 Worker だけ (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  const recalc = (apply: boolean) => post("/kintai-relay/recalc", { month: "2026-06", apply });
  const run = () => post("/kintai-relay/run", { month: "2026-06", month_count: 1, apply: true });
  const sent = (kintai: { url: string; method: string; headers: Record<string, string> }[]) =>
    kintai
      .filter((c) => !new URL(c.url).pathname.endsWith("/timecard/events"))
      .map((c) => [new URL(c.url).pathname, c.method, c.headers["x-kintai-write-token"] ?? null]);

  it("本番の設定: recalc の preview は token なし、apply と run の window は token 付きで Worker。auth-worker は 0 回", async () => {
    const { env, kintai, authWorker } = fakeEnv();
    expect((await worker.fetch(recalc(false), env)).status).toBe(200);
    expect((await worker.fetch(recalc(true), env)).status).toBe(200);
    expect((await worker.fetch(run(), env)).status).toBe(200);
    expect(sent(kintai)).toEqual([
      ["/api/kintai/recalc", "GET", null],
      ["/api/kintai/recalc", "POST", "write-token"],
      ["/api/kintai/timecard/window", "POST", "write-token"],
    ]);
    expect(authWorker).toEqual([]);
  });

  it("AUTH_WORKER が無くても動く (呼び手の proof の INTERNAL_SHARED_SECRET は要る)", async () => {
    const { env, kintai } = fakeEnv({ authWorker: false });
    expect((await worker.fetch(recalc(true), env)).status).toBe(200);
    expect((await worker.fetch(run(), env)).status).toBe(200);
    expect(sent(kintai).map((c) => c[0])).toEqual(["/api/kintai/recalc", "/api/kintai/timecard/window"]);
  });

  it("binding が無ければ recalc (preview・apply) も run も 503。auth-worker に送らない", async () => {
    const { env, authWorker } = fakeEnv({ kintaiBinding: false });
    for (const req of [recalc(false), recalc(true), run()]) {
      const res = await worker.fetch(req, env);
      expect(res.status).toBe(503);
      expect(((await res.json()) as { error: string }).error).toBe("kintai-relay not configured");
    }
    expect(authWorker).toEqual([]);
  });

  it("token が無ければ apply と run は 503、recalc の preview は Worker。auth-worker は 0 回", async () => {
    const { env, kintai, authWorker } = fakeEnv({ writeToken: undefined });
    expect((await worker.fetch(recalc(false), env)).status).toBe(200);
    const apply = await worker.fetch(recalc(true), env);
    expect(apply.status).toBe(503);
    expect(((await apply.json()) as { error: string }).error).toBe("KINTAI_WRITE_TOKEN が読めません: /api/kintai/recalc");
    expect((await worker.fetch(run(), env)).status).toBe(503);
    expect(sent(kintai)).toEqual([["/api/kintai/recalc", "GET", null]]);
    expect(authWorker).toEqual([]);
  });

  it("token の読みで投げたら console.error に残し、apply は 503", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, authWorker } = fakeEnv({
      writeToken: {
        get: async () => {
          throw new Error("secrets store down");
        },
      },
    });
    expect((await worker.fetch(recalc(true), env)).status).toBe(503);
    expect(authWorker).toEqual([]);
    expect(errors.mock.calls.some(([l]) => String(l).includes("kintai_recalc") && String(l).includes("secrets store down"))).toBe(true);
    errors.mockRestore();
  });

  it("上流 (Worker) の失敗は今どおり 502", async () => {
    const { env } = fakeEnv();
    (env.KINTAI as { fetch: ReturnType<typeof vi.fn> }).fetch.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    expect((await worker.fetch(recalc(false), env)).status).toBe(502);
  });
});
