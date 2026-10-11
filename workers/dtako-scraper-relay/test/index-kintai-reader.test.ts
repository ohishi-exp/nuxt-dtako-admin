import { afterEach, describe, expect, it, vi } from "vitest";

// index-kintai-gcp-read.test.ts と同じ手当て (index.ts が DO を re-export するため)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { type RelayWorkerEnv } from "../src/index";

/**
 * `/kintai-relay/*` の機械経路 (run・recalc・GCP 読み 3 口) のオンプレ側の読み先 (Refs ohishi-exp/rust-ichibanboshi#322)。
 *
 * - 勤怠 Worker の binding があれば、オンプレを読むための CF Access が未設定でも止めない (`kintaiReader`)
 * - binding も CF Access も無ければ今と同じ 503
 * - 呼び手の `X-Alc-Proxy-Secret` の照合と `INTERNAL_SHARED_SECRET` の必須は binding があっても残る
 */
const SECRET = "internal-shared-secret";
const COMP_ID = "27324455";

interface Setup {
  kintaiBinding?: boolean;
  cfAccess?: boolean;
  sharedSecret?: boolean;
}

function fakeEnv(opts: Setup = {}) {
  const authWorker: string[] = [];
  const kintai: { url: string; headers: Record<string, string> }[] = [];
  const onprem: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      onprem.push(String(input));
      return Response.json({ drivers: [], events: [] });
    }),
  );
  const env = {
    ...(opts.sharedSecret === false ? {} : { INTERNAL_SHARED_SECRET: SECRET }),
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
              kintai.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
              return Response.json({ month: "2026-06", drivers: [], events: [], summaries: {}, items: [] });
            }),
          },
        }),
    KINTAI_COMP_ID: COMP_ID,
    DTAKO_ACCOUNTS: JSON.stringify([{ comp_id: COMP_ID, tenant_id: "tenant" }]),
    AUTH_WORKER: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        authWorker.push(String(input));
        return Response.json({ drivers_written: 0, fold: {}, stale: {} });
      }),
    },
  } as unknown as RelayWorkerEnv;
  return { env, authWorker, kintai, onprem };
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

describe("/kintai-relay/* のオンプレ側の読み先 (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  it.each(ROUTES)("%s: binding があれば CF Access が未設定でも 200", async (_label, request) => {
    const { env, onprem } = fakeEnv({ cfAccess: false });
    const res = await worker.fetch(request(), env);
    expect(res.status).toBe(200);
    expect(onprem).toEqual([]);
  });

  it.each(ROUTES)("%s: binding も CF Access も無ければ今と同じ 503", async (_label, request) => {
    const { env, authWorker, onprem } = fakeEnv({ kintaiBinding: false, cfAccess: false });
    const res = await worker.fetch(request(), env);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe("kintai-relay not configured");
    expect(authWorker).toEqual([]);
    expect(onprem).toEqual([]);
  });

  it.each(ROUTES)("%s: binding があっても X-Alc-Proxy-Secret が違えば 401", async (_label, request) => {
    const { env, authWorker, kintai } = fakeEnv({ cfAccess: false });
    const res = await worker.fetch(request("wrong"), env);
    expect(res.status).toBe(401);
    expect(authWorker).toEqual([]);
    expect(kintai).toEqual([]);
  });

  it.each(ROUTES)("%s: binding があっても INTERNAL_SHARED_SECRET が無ければ 503", async (_label, request) => {
    const { env, kintai } = fakeEnv({ cfAccess: false, sharedSecret: false });
    const res = await worker.fetch(request(""), env);
    expect(res.status).toBe(503);
    expect(kintai).toEqual([]);
  });

  it("run の打刻 (timecard/events) は本番の設定で Worker に飛び、CF Access・secret を付けない", async () => {
    const { env, kintai, onprem } = fakeEnv();
    const res = await worker.fetch(ROUTES[0]![1](), env);
    expect(res.status).toBe(200);
    expect(onprem).toEqual([]);
    expect(kintai.map((c) => c.url)).toEqual(["https://ichibanboshi-kintai/api/kintai/timecard/events?months=2026-06"]);
    expect(kintai[0]!.headers).toEqual({ accept: "application/json" });
  });

  it("binding が無ければ run の打刻は今のまま CF Access 付きでオンプレを読む", async () => {
    const { env, kintai, onprem } = fakeEnv({ kintaiBinding: false });
    const res = await worker.fetch(ROUTES[0]![1](), env);
    expect(res.status).toBe(200);
    expect(kintai).toEqual([]);
    expect(onprem).toEqual(["https://ichiban.invalid/api/kintai/timecard/events?months=2026-06"]);
  });
});
