import { describe, expect, it, vi } from "vitest";

// index.ts は DtakoScraperRelayDO を re-export しており、そちらが module scope で
// "cloudflare:workers" を import する (index-kintai-gcp-read.test.ts と同じ手当て)。
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

import worker, { type RelayWorkerEnv } from "../src/index";

const SECRET = "internal-shared-secret";
const COMP_ID = "90000001";
const TENANT = "tenant-a";
const PATH = "/kintai-relay/y-time-shifts";

/** 新しい口が要る配線だけの env。上流 (auth-worker `/ichibanboshi-proxy`) は `upstream` で差し替える。 */
function fakeEnv(upstream: (month: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const env = {
    INTERNAL_SHARED_SECRET: SECRET,
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: "csecret",
    NUXT_ICHIBAN_API_URL: "https://onprem.invalid",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid",
    KINTAI_COMP_ID: COMP_ID,
    DTAKO_ACCOUNTS: JSON.stringify([{ comp_id: COMP_ID, tenant_id: TENANT }]),
    AUTH_WORKER: {
      fetch: vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        calls.push(url);
        return upstream(new URL(url).searchParams.get("month")!);
      }),
    },
  } as unknown as RelayWorkerEnv;
  return { env, calls };
}

const BODY = { driver_cd: "9001", from: "2026-04-01", to: "2026-04-30", tenant_id: TENANT };

function post(body: unknown = BODY, headers: Record<string, string> = { "X-Alc-Proxy-Secret": SECRET }) {
  return new Request(`https://relay.internal${PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const BREAK = { start: "2026-04-04 02:00:00", end: "2026-04-04 03:00:00", kind: "break_event" };
/** 月ごとの `shift-days` の応答 (架空値)。3 月末に始業して 4 月へまたぐ勤務を含む。 */
const ITEMS: Record<string, unknown[]> = {
  "2026-03": [
    { start_at: "2026-03-30 08:00:00", end_at: "2026-03-30 17:00:00", shift_source: "timecard", summary: null, non_working: null, parts: [] },
    { start_at: "2026-03-31 21:00:00", end_at: "2026-04-01 06:30:00", shift_source: "rest", summary: null, non_working: [], parts: [] },
  ],
  "2026-04": [
    { start_at: "2026-04-03 22:10:00", end_at: "2026-04-04 09:05:00", shift_source: "timecard", summary: null, non_working: [BREAK], parts: [] },
  ],
};
const shiftDays = (month: string) => Response.json({ month, driver_cd: 9001, items: ITEMS[month] ?? [] });

describe("POST /kintai-relay/y-time-shifts (Refs #1133 c1133-40)", () => {
  it("関門を通れば前月と期間の月の shift-days を読み、勤務を束ねて返す。tenant_id は relay が引いた値", async () => {
    const { env, calls } = fakeEnv(shiftDays);
    const res = await worker.fetch(post(), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      tenant_id: TENANT,
      shifts: [
        { start: "2026-03-31 21:00:00", end: "2026-04-01 06:30:00", non_working: [], note: null },
        { start: "2026-04-03 22:10:00", end: "2026-04-04 09:05:00", non_working: [BREAK], note: null },
      ],
      missing_months: [],
    });
    expect(calls.map((u) => new URL(u).pathname + new URL(u).search)).toEqual([
      "/ichibanboshi-proxy/api/kintai/shift-days?month=2026-03&driver=9001",
      "/ichibanboshi-proxy/api/kintai/shift-days?month=2026-04&driver=9001",
    ]);
  });

  it("応答の tenant_id は body の写しではない: KV の tenant が変われば応答も変わり、body の値は 403 になる", async () => {
    const { env, calls } = fakeEnv(shiftDays);
    (env as unknown as Record<string, unknown>).DTAKO_ACCOUNTS = JSON.stringify([
      { comp_id: COMP_ID, tenant_id: "tenant-b" },
    ]);
    const denied = await worker.fetch(post(), env);
    expect(denied.status).toBe(403);
    expect(calls).toHaveLength(0);
    const res = await worker.fetch(post({ ...BODY, tenant_id: "tenant-b" }), env);
    expect(((await res.json()) as { tenant_id: string }).tenant_id).toBe("tenant-b");
  });

  it("勤務が 1 本も無い月は missing_months に入る (前月は数えない)", async () => {
    const { env } = fakeEnv((month) => Response.json({ month, items: [] }));
    const res = await worker.fetch(post({ ...BODY, to: "2026-05-31" }), env);
    expect(await res.json()).toEqual({ tenant_id: TENANT, shifts: [], missing_months: ["2026-04", "2026-05"] });
  });

  it("body の tenant_id が relay の tenant と違えば 403 kintai_out_of_scope で、上流を読まない", async () => {
    const { env, calls } = fakeEnv(shiftDays);
    const res = await worker.fetch(post({ ...BODY, tenant_id: "tenant-b" }), env);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "kintai_out_of_scope" });
    expect(calls).toHaveLength(0);
  });

  it("secret が不一致 / 無ければ 401 で、上流を読まない", async () => {
    for (const headers of [{ "X-Alc-Proxy-Secret": "wrong" }, {}] as Record<string, string>[]) {
      const { env, calls } = fakeEnv(shiftDays);
      const res = await worker.fetch(post(BODY, headers), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
      expect(calls).toHaveLength(0);
    }
  });

  it("KINTAI_COMP_ID が空 + 正しい secret → 503 で reason: kintai_comp_id_unset", async () => {
    for (const compId of [undefined, "", "  "]) {
      const { env, calls } = fakeEnv(shiftDays);
      (env as unknown as Record<string, unknown>).KINTAI_COMP_ID = compId;
      const res = await worker.fetch(post(), env);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "kintai-relay not configured", reason: "kintai_comp_id_unset" });
      expect(calls).toHaveLength(0);
    }
  });

  it("secret が違う + KINTAI_COMP_ID が空 → 401 で、reason を返さない", async () => {
    for (const headers of [{ "X-Alc-Proxy-Secret": "wrong" }, {}] as Record<string, string>[]) {
      const { env } = fakeEnv(shiftDays);
      (env as unknown as Record<string, unknown>).KINTAI_COMP_ID = undefined;
      const res = await worker.fetch(post(BODY, headers), env);
      expect(res.status).toBe(401);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "Unauthorized" });
      expect(text).not.toContain("reason");
      expect(text).not.toContain("kintai_comp_id_unset");
    }
  });

  it.each([
    "NUXT_ICHIBAN_API_URL",
    "NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID",
    "ICHIBAN_CF_ACCESS_CLIENT_SECRET",
    "AUTH_WORKER",
  ])("別の設定 (%s) が空 + 正しい secret → 503 で reason なし", async (key) => {
    const { env } = fakeEnv(shiftDays);
    (env as unknown as Record<string, unknown>)[key] = undefined;
    const res = await worker.fetch(post(), env);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(JSON.stringify({ error: "kintai-relay not configured" }));
  });

  it("共有 secret を解決できなければ 503 で reason なし (KINTAI_COMP_ID も空でも)", async () => {
    const { env } = fakeEnv(shiftDays);
    (env as unknown as Record<string, unknown>).INTERNAL_SHARED_SECRET = undefined;
    (env as unknown as Record<string, unknown>).KINTAI_COMP_ID = undefined;
    const res = await worker.fetch(post(BODY, {}), env);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe(JSON.stringify({ error: "kintai-relay not configured" }));
  });

  it("tenant を KV から引けなければ既存と同じ 503", async () => {
    const { env, calls } = fakeEnv(shiftDays);
    (env as unknown as Record<string, unknown>).DTAKO_ACCOUNTS = "not json";
    const res = await worker.fetch(post(), env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "tenant not resolved from dtako_accounts" });
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["JSON でない body", "not json"],
    ["driver_cd が数字でない", { ...BODY, driver_cd: "x" }],
    ["from が to より後", { ...BODY, from: "2026-05-01" }],
    ["tenant_id が無い (403 ではなく 400)", { driver_cd: "9001", from: "2026-04-01", to: "2026-04-30" }],
  ])("検証の破れは 400 で、上流を読まない: %s", async (_label, body) => {
    const { env, calls } = fakeEnv(shiftDays);
    const res = await worker.fetch(post(body), env);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("1 つの月の読み出しが失敗したら 502 (読めた月だけで返さない)", async () => {
    const { env } = fakeEnv((month) => (month === "2026-03" ? new Response("boom", { status: 500 }) : shiftDays(month)));
    const res = await worker.fetch(post(), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/shift-days 2026-03: status 500: boom/);
  });

  it("形の合わない応答は 502 (黙って空にしない)", async () => {
    const { env } = fakeEnv((month) => Response.json({ month, items: [{ start_at: "2026-04-03 22:10:00" }] }));
    const res = await worker.fetch(post(), env);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/応答の形が合いません/);
  });

  it("並列で読む: 最初の応答が返る前に、全部の月の読み出しが始まっている", async () => {
    // 解決を手で遅らせる stub (同期の stub は直列でも通るので使わない)
    const release: (() => void)[] = [];
    const { env, calls } = fakeEnv(
      (month) => new Promise<Response>((resolve) => release.push(() => resolve(shiftDays(month)))),
    );
    const pending = worker.fetch(post({ ...BODY, to: "2026-06-30" }), env);
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    expect(release).toHaveLength(4);
    expect(calls.map((u) => new URL(u).searchParams.get("month"))).toEqual(["2026-03", "2026-04", "2026-05", "2026-06"]);
    for (const go of release) go();
    expect((await pending).status).toBe(200);
  });

  it("GET では届かない (書けない口と同じ振り分けに落ちる)", async () => {
    const { env, calls } = fakeEnv(shiftDays);
    const res = await worker.fetch(new Request(`https://relay.internal${PATH}`, { headers: { "X-Alc-Proxy-Secret": SECRET } }), env);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe("既存の 2 つの口も同じ関門の順序になる (関門を 1 つにした結果、Refs #1133 c1133-40)", () => {
  const get = (path: string, headers: Record<string, string>) =>
    new Request(`https://relay.internal${path}`, { headers });

  it.each(["/kintai-relay/day-summaries?month=2026-06", "/kintai-relay/shift-overlaps?month=2026-06"])(
    "%s: KINTAI_COMP_ID が空でも、正しい secret には 503 を reason なしで返す (本文の形は変えない)",
    async (path) => {
      const { env } = fakeEnv(shiftDays);
      (env as unknown as Record<string, unknown>).KINTAI_COMP_ID = undefined;
      const res = await worker.fetch(get(path, { "X-Alc-Proxy-Secret": SECRET }), env);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe(JSON.stringify({ error: "kintai-relay not configured" }));
    },
  );

  it.each(["/kintai-relay/day-summaries?month=2026-06", "/kintai-relay/shift-overlaps?month=2026-06"])(
    "%s: 設定が欠けていて secret も違う呼び出しは 401 (設定の様子を教えない)",
    async (path) => {
      const { env } = fakeEnv(shiftDays);
      (env as unknown as Record<string, unknown>).KINTAI_COMP_ID = undefined;
      const res = await worker.fetch(get(path, { "X-Alc-Proxy-Secret": "wrong" }), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    },
  );
});
