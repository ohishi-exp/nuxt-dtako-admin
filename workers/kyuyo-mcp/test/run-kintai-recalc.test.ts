import { describe, it, expect, vi } from "vitest";
import { runKintaiRecalcTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ drivers: [] }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

describe("run_kintai_recalc (ohishi-exp/rust-ichibanboshi#205 の 10)", () => {
  it("**write tool として scope を要求する** — read tool と同じ扱いにしない", () => {
    expect(runKintaiRecalcTool.requiresScope).toBe("mcp.write");
  });

  it("month が YYYY-MM でなければ relay を叩かない", async () => {
    const e = env();
    await expect(runKintaiRecalcTool.execute(e, { month: "2026-7" })).rejects.toThrow(/YYYY-MM/);
    expect((e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runKintaiRecalcTool.execute(env({ SCRAPER_RELAY: undefined }), { month: "2026-06" }),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runKintaiRecalcTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), { month: "2026-06" }),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("**apply は明示しない限り false** — 既定で 1 件も書かせない", async () => {
    const e = env();
    await runKintaiRecalcTool.execute(e, { month: "2026-06" });
    const call = (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls[0]!;
    expect(JSON.parse((call[1] as RequestInit).body as string).apply).toBe(false);

    const e2 = env();
    await runKintaiRecalcTool.execute(e2, { month: "2026-06", apply: true });
    const call2 = (e2.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls[0]!;
    expect(JSON.parse((call2[1] as RequestInit).body as string).apply).toBe(true);
  });

  it("proof を付けて relay の /kintai-relay/recalc を叩き、応答をそのまま返す", async () => {
    const report = { month: "2026-06", apply: false, drivers: [1130], next_after_driver_cd: null };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(report))) },
    });
    const got = await runKintaiRecalcTool.execute(e, {
      month: "2026-06",
      after_driver_cd: 1000,
      max_drivers: 10,
      stale_only: true,
    });
    expect(got).toEqual(report);
    const call = (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/recalc");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toMatchObject({
      month: "2026-06",
      after_driver_cd: 1000,
      max_drivers: 10,
      stale_only: true,
    });
  });

  it("**month は省略できる** — 当月は relay 側が決める", async () => {
    const e = env();
    await runKintaiRecalcTool.execute(e, {});
    const call = (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls[0]!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.month).toBeUndefined();
    expect(body.apply).toBe(false);
  });

  it("relay の失敗は本文の先頭を添えて上げる", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(runKintaiRecalcTool.execute(e, { month: "2026-06" })).rejects.toThrow(
      /relay: status 401: nope/,
    );
  });

  it("JSON でない応答は parse failed で落とす", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(runKintaiRecalcTool.execute(e, { month: "2026-06" })).rejects.toThrow(
      /parse failed/,
    );
  });
});
