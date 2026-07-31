import { describe, it, expect, vi } from "vitest";
import { runKintaiRelayTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ drivers: 0 }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

describe("run_kintai_relay (ohishi-exp/rust-ichibanboshi#205 の 04b)", () => {
  it("**write tool として scope を要求する** — read tool と同じ扱いにしない", () => {
    expect(runKintaiRelayTool.requiresScope).toBe("mcp.write");
  });

  it("month が YYYY-MM でなければ relay を叩かない", async () => {
    const e = env();
    await expect(runKintaiRelayTool.execute(e, { month: "2026-7" })).rejects.toThrow(/YYYY-MM/);
    expect((e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch).not.toHaveBeenCalled();
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runKintaiRelayTool.execute(env({ SCRAPER_RELAY: undefined }), { month: "2026-06" }),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runKintaiRelayTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), { month: "2026-06" }),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("**apply は明示しない限り false** — 既定で 1 件も書かせない", async () => {
    const e = env();
    await runKintaiRelayTool.execute(e, { month: "2026-06" });
    const call = (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls[0]!;
    expect(JSON.parse((call[1] as RequestInit).body as string).apply).toBe(false);

    const e2 = env();
    await runKintaiRelayTool.execute(e2, { month: "2026-06", apply: true });
    const call2 = (e2.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls[0]!;
    expect(JSON.parse((call2[1] as RequestInit).body as string).apply).toBe(true);
  });

  it("proof を付けて relay の /kintai-relay/run を叩き、応答をそのまま返す", async () => {
    const report = { months: ["2026-05", "2026-06"], drivers: 94, daysWritten: 0 };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(report))) },
    });
    const got = await runKintaiRelayTool.execute(e, { month: "2026-06", month_count: 2 });
    expect(got).toEqual(report);
    const call = (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/run");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toMatchObject({
      month: "2026-06",
      month_count: 2,
    });
  });

  it("**month は省略できる** — 窓の既定 (JST 当月 + 前月) は relay 側が決める", async () => {
    const e = env();
    await runKintaiRelayTool.execute(e, {});
    const call = (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch.mock.calls[0]!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.month).toBeUndefined();
    expect(body.apply).toBe(false);
  });

  it("relay の失敗は本文の先頭を添えて上げる", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(runKintaiRelayTool.execute(e, { month: "2026-06" })).rejects.toThrow(
      /relay: status 401: nope/,
    );
  });

  it("JSON でない応答は parse failed で落とす", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(runKintaiRelayTool.execute(e, { month: "2026-06" })).rejects.toThrow(
      /parse failed/,
    );
  });
});
