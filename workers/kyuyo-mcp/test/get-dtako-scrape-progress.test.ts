import { describe, it, expect, vi } from "vitest";
import { getDtakoScrapeProgressTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ comps: [] }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("get_dtako_scrape_progress (ohishi-exp/rust-ichibanboshi#205 の 43)", () => {
  it("**read tool** — scope を要求しない", () => {
    expect((getDtakoScrapeProgressTool as { requiresScope?: string }).requiresScope).toBeUndefined();
  });

  it("**説明で scrape_history との違いと state の種類が読める**", () => {
    expect(getDtakoScrapeProgressTool.description).toContain("get_dtako_scrape_status とは別物");
    expect(getDtakoScrapeProgressTool.description).toContain("pending/running/done/failed");
    expect(getDtakoScrapeProgressTool.description).toContain("黙って消えない");
    expect(getDtakoScrapeProgressTool.description).toContain("comp_id ごとの instance");
  });

  it("comp_id は任意", () => {
    expect(getDtakoScrapeProgressTool.inputSchema.safeParse({}).success).toBe(true);
    expect(getDtakoScrapeProgressTool.inputSchema.safeParse({ comp_id: "27324455" }).success).toBe(
      true,
    );
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      getDtakoScrapeProgressTool.execute(env({ SCRAPER_RELAY: undefined }), {}),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      getDtakoScrapeProgressTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), {}),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("comp_id を省略すると query 無しで relay の /kintai-relay/scrape-progress を叩く", async () => {
    const e = env();
    await getDtakoScrapeProgressTool.execute(e, {});
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/scrape-progress");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
  });

  it("comp_id を渡すと query に載り、応答をそのまま返す", async () => {
    const body = {
      comps: [
        {
          comp_id: "27324455",
          queue: [{ date: "2026-06-03", state: "done", split_failed: 0 }],
          pending: 0,
          running: 0,
          done: 1,
          failed: 0,
          max_records: 200,
        },
      ],
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(body))) },
    });
    const got = await getDtakoScrapeProgressTool.execute(e, { comp_id: "27324455" });
    expect(got).toEqual(body);
    expect(relayOf(e).fetch.mock.calls[0]![0]).toBe(
      "https://relay.internal/kintai-relay/scrape-progress?comp_id=27324455",
    );
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(getDtakoScrapeProgressTool.execute(bad, {})).rejects.toThrow(
      /relay: status 401: nope/,
    );
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(getDtakoScrapeProgressTool.execute(html, {})).rejects.toThrow(/parse failed/);
  });
});
