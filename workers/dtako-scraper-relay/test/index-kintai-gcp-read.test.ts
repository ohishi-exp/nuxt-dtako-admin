import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (node vitest では解決できない)。bare class で
// stub して module を読み込めるようにする (index-etc-run.test.ts と同じ手当て)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { type RelayWorkerEnv } from "../src/index";

const SECRET = "internal-shared-secret";
const COMP_ID = "27324455";

/** GCP 読み取りの口 (`/kintai-relay/day-summaries` / `shift-overlaps`) が要る配線だけの env。
 * 上流 (auth-worker `/ichibanboshi-proxy`) は `upstream` で差し替える。 */
function fakeEnv(upstream: (url: string) => Response) {
  const calls: string[] = [];
  const env = {
    INTERNAL_SHARED_SECRET: SECRET,
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: "csecret",
    NUXT_ICHIBAN_API_URL: "https://ichiban.invalid",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid",
    KINTAI_COMP_ID: COMP_ID,
    DTAKO_ACCOUNTS: JSON.stringify([{ comp_id: COMP_ID, tenant_id: "tenant" }]),
    AUTH_WORKER: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        return upstream(url);
      }),
    },
  } as unknown as RelayWorkerEnv;
  return { env, calls };
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
