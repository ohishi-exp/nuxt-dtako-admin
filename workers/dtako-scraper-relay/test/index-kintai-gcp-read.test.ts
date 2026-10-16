import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。bare class で
// stub して module を読み込めるようにする (index-etc-run.test.ts と同じ手当て)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { type RelayWorkerEnv } from "../src/index";

const SECRET = "internal-shared-secret";
const COMP_ID = "27324455";

/** 勤怠を読むだけの口 (`/kintai-relay/day-summaries` / `shift-overlaps`) が要る配線だけの env。
 * 上流 (勤怠 Worker `KINTAI`) は `upstream` で差し替える。`AUTH_WORKER` は呼ばれたら `authCalls` に残る
 * (勤怠では呼ばない。Refs ohishi-exp/rust-ichibanboshi#322)。 */
function fakeEnv(upstream: (url: string) => Response) {
  const calls: string[] = [];
  const authCalls: string[] = [];
  const env = {
    INTERNAL_SHARED_SECRET: SECRET,
    KINTAI_COMP_ID: COMP_ID,
    DTAKO_ACCOUNTS: JSON.stringify([{ comp_id: COMP_ID, tenant_id: "tenant" }]),
    KINTAI: {
      fetch: vi.fn(async (url: string) => {
        calls.push(url);
        return upstream(url);
      }),
    },
    AUTH_WORKER: {
      fetch: vi.fn(async (url: string) => {
        authCalls.push(url);
        return Response.json({ via: "auth-worker" });
      }),
    },
  } as unknown as RelayWorkerEnv;
  return { env, calls, authCalls };
}

function get(path: string, headers: Record<string, string> = { "X-Alc-Proxy-Secret": SECRET }) {
  return new Request(`https://relay.internal${path}`, { headers });
}

const OVERLAPS = {
  month: "2026-06",
  items: [
    {
      driver_cd: 1026,
      a_start: "2026-06-24 08:00:00",
      a_end: "2026-06-24 18:00:00",
      b_start: "2026-06-24 10:00:00",
      b_end: "2026-06-24 20:00:00",
    },
  ],
};

describe("GET /kintai-relay/shift-overlaps (Refs #1123)", () => {
  it("secret が不一致 / 無ければ 401 で、上流を叩かない", async () => {
    for (const headers of [{ "X-Alc-Proxy-Secret": "wrong" }, {}] as Record<string, string>[]) {
      const { env, calls } = fakeEnv(() => Response.json(OVERLAPS));
      const res = await worker.fetch(get("/kintai-relay/shift-overlaps?month=2026-06", headers), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      expect(calls).toHaveLength(0);
    }
  });

  it("関門を通れば上流の shift-overlaps を month 付きで読み、応答をそのまま返す", async () => {
    const { env, calls } = fakeEnv(() => Response.json(OVERLAPS));
    const res = await worker.fetch(get("/kintai-relay/shift-overlaps?month=2026-06"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OVERLAPS);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/kintai/shift-overlaps?month=2026-06");
  });

  it("上流が落ちたら 502 (古い値に倒さない)", async () => {
    const { env } = fakeEnv(() => new Response("boom", { status: 500 }));
    const res = await worker.fetch(get("/kintai-relay/shift-overlaps?month=2026-06"), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/shift-overlaps: status 500: boom/);
  });

  it("配線が欠けていれば 503 (上流を叩かない)", async () => {
    const { env, calls } = fakeEnv(() => Response.json(OVERLAPS));
    (env as unknown as Record<string, unknown>).KINTAI_COMP_ID = undefined;
    const res = await worker.fetch(get("/kintai-relay/shift-overlaps?month=2026-06"), env);
    expect(res.status).toBe(503);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /kintai-relay/alc-events (ohishi-exp/rust-ichibanboshi#400)", () => {
  const body = { driver: 12, shifts: [{ start: "2026-06-02 05:00:00", end: "2026-06-02 08:00:00", minutes: 180 }] };

  it("secret が無ければ 401 で、上流を叩かない", async () => {
    const { env, calls } = fakeEnv(() => Response.json(body));
    const res = await worker.fetch(get("/kintai-relay/alc-events?driver=12&from=2026-06-01&to=2026-06-24", {}), env);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("driver・from・to を上流の alc-events に渡し、応答をそのまま返す", async () => {
    const { env, calls } = fakeEnv(() => Response.json(body));
    const res = await worker.fetch(get("/kintai-relay/alc-events?driver=12&from=2026-06-01&to=2026-06-24"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/api/kintai/alc-events?driver=12&from=2026-06-01&to=2026-06-24");
  });

  it.each([
    "/kintai-relay/alc-events?from=2026-06-01&to=2026-06-24",
    "/kintai-relay/alc-events?driver=x&from=2026-06-01&to=2026-06-24",
    "/kintai-relay/alc-events?driver=12&from=2026-6-1&to=2026-06-24",
    "/kintai-relay/alc-events?driver=12&from=2026-06-01",
  ])("引数の形が違えば上流を叩かずに落とす (%s。day-summaries の month と同じく 502)", async (path) => {
    const { env, calls } = fakeEnv(() => Response.json(body));
    const res = await worker.fetch(get(path), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/で指定してください/);
    expect(calls).toHaveLength(0);
  });

  it("上流が落ちたら 502", async () => {
    const { env } = fakeEnv(() => new Response("boom", { status: 500 }));
    const res = await worker.fetch(get("/kintai-relay/alc-events?driver=12&from=2026-06-01&to=2026-06-24"), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/alc-events: status 500: boom/);
  });
});

describe("GET /kintai-relay/day-summaries (関門を shift-overlaps と共有したあとも同じに動く)", () => {
  it("secret が無ければ 401", async () => {
    const { env, calls } = fakeEnv(() => Response.json({ summaries: {} }));
    const res = await worker.fetch(get("/kintai-relay/day-summaries?month=2026-06", {}), env);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("month と driver を上流の day-summaries に渡し、応答をそのまま返す", async () => {
    const body = { summaries: { "1026|2026-06-24|2026-06-24 08:00:00": { restraint_minutes: 844 } } };
    const { env, calls } = fakeEnv(() => Response.json(body));
    const res = await worker.fetch(get("/kintai-relay/day-summaries?month=2026-06&driver=1026"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(calls[0]).toContain("/api/kintai/day-summaries?month=2026-06&driver=1026");
  });
});

describe("勤怠 Worker (KINTAI) だけから読む (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  function withKintai(respond: () => Response) {
    const { env, authCalls } = fakeEnv(respond);
    const kintaiCalls: { url: string; headers: Record<string, string> }[] = [];
    (env as { KINTAI?: unknown }).KINTAI = {
      fetch: vi.fn(async (url: string, init?: RequestInit) => {
        kintaiCalls.push({ url, headers: init?.headers as Record<string, string> });
        return respond();
      }),
    };
    return { env, authCalls, kintaiCalls };
  }

  it("day-summaries・shift-overlaps は Worker に飛び、auth-worker を一度も呼ばない。secret を付けず、会社のテナントだけを名乗る", async () => {
    const { env, authCalls, kintaiCalls } = withKintai(() => Response.json(OVERLAPS));
    expect((await worker.fetch(get("/kintai-relay/day-summaries?month=2026-06"), env)).status).toBe(200);
    const res = await worker.fetch(get("/kintai-relay/shift-overlaps?month=2026-06"), env);
    expect(await res.json()).toEqual(OVERLAPS);
    expect(authCalls).toHaveLength(0);
    expect(kintaiCalls.map((c) => c.url)).toEqual([
      "https://ichibanboshi-kintai/api/kintai/day-summaries?month=2026-06",
      "https://ichibanboshi-kintai/api/kintai/shift-overlaps?month=2026-06",
    ]);
    for (const c of kintaiCalls) expect(c.headers).toEqual({ accept: "application/json", "x-kintai-tenant-id": "tenant" });
  });

  it("KINTAI binding が無ければ 503 で、auth-worker へ倒さない", async () => {
    const { env, authCalls } = fakeEnv(() => Response.json(OVERLAPS));
    (env as { KINTAI?: unknown }).KINTAI = undefined;
    const res = await worker.fetch(get("/kintai-relay/day-summaries?month=2026-06"), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "kintai-relay not configured" });
    expect(authCalls).toHaveLength(0);
  });

  it("KINTAI binding が無くても secret 不一致は 401 (401 が設定の 503 より前)", async () => {
    const { env } = fakeEnv(() => Response.json(OVERLAPS));
    (env as { KINTAI?: unknown }).KINTAI = undefined;
    const res = await worker.fetch(get("/kintai-relay/day-summaries?month=2026-06", { "X-Alc-Proxy-Secret": "wrong" }), env);
    expect(res.status).toBe(401);
  });

  it("Worker の 503 は 502 になり、本文の先頭が error に載る", async () => {
    const { env } = withKintai(
      () => new Response("読み先のテナントが決まりません (KINTAI_TENANT_ID を設定してください)", { status: 503 }),
    );
    const res = await worker.fetch(get("/kintai-relay/day-summaries?month=2026-06"), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe(
      "gcp kintai day-summaries: status 503: 読み先のテナントが決まりません (KINTAI_TENANT_ID を設定してください)",
    );
  });
});
