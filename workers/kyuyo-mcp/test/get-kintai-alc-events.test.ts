import { describe, it, expect, vi } from "vitest";
import { getKintaiAlcEventsTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

/** 勤怠 Worker の `GET /api/kintai/alc-events` が返す形 (一部)。 */
const SAMPLE = {
  driver: 12,
  from: "2026-06-01 00:00:00",
  to: "2026-06-25 00:00:00",
  alc_only: true,
  shifts: [{ start: "2026-06-02 05:00:00", end: "2026-06-02 08:00:00", minutes: 180 }],
  operations: [],
  events: [],
  borrowed: [],
  warnings: [],
};

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(SAMPLE))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayFetch = (e: Env) => (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch;
const ARGS = { driver: "12", from: "2026-06-01", to: "2026-06-24" };

describe("get_kintai_alc_events (ohishi-exp/rust-ichibanboshi#400)", () => {
  it("**read tool。** scope を要求せず、書き込みの引数を持たない", () => {
    expect((getKintaiAlcEventsTool as { requiresScope?: string }).requiresScope).toBeUndefined();
    expect(Object.keys(getKintaiAlcEventsTool.inputSchema.shape).sort()).toEqual([
      "comp_id",
      "driver",
      "from",
      "to",
    ]);
  });

  it("relay の /kintai-relay/alc-events を GET (body なし) で叩き、応答をそのまま返す", async () => {
    const e = env();
    expect(await getKintaiAlcEventsTool.execute(e, { ...ARGS, comp_id: "75700192" })).toEqual(SAMPLE);
    const [url, init] = relayFetch(e).mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(
      "https://relay.internal/kintai-relay/alc-events?driver=12&from=2026-06-01&to=2026-06-24&comp_id=75700192",
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
  });

  it("comp_id を省くと query に出さない (既定の会社は relay が決める)", async () => {
    const e = env();
    await getKintaiAlcEventsTool.execute(e, ARGS);
    expect(relayFetch(e).mock.calls[0]![0]).toBe(
      "https://relay.internal/kintai-relay/alc-events?driver=12&from=2026-06-01&to=2026-06-24",
    );
  });

  it.each([
    { ...ARGS, driver: "x" },
    { ...ARGS, from: "2026-6-1" },
    { ...ARGS, to: "2026/06/24" },
    { ...ARGS, comp_id: "7570019" },
  ])("引数の形が違えば受けない (%o)", (args) => {
    expect(getKintaiAlcEventsTool.inputSchema.safeParse(args).success).toBe(false);
  });

  it("relay の失敗は本文の先頭を添えて上げる", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 502 })) },
    });
    await expect(getKintaiAlcEventsTool.execute(e, ARGS)).rejects.toThrow(/relay: status 502: nope/);
  });
});
