import { describe, it, expect, vi } from "vitest";
import { getDtakoScrapeStatusTool, runDtakoScrapeTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ dispatched: [] }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("run_dtako_scrape (ohishi-exp/rust-ichibanboshi#205 の 42)", () => {
  it("**write tool として scope を要求する** — 本番の R2 / DB を書き換えうる", () => {
    expect(runDtakoScrapeTool.requiresScope).toBe("mcp.write");
  });

  it("**説明で「受理しただけ」と「読取日を渡せ」が読める**", () => {
    expect(runDtakoScrapeTool.description).toContain("【書き込み】");
    expect(runDtakoScrapeTool.description).toContain("結果はまだ出ていない");
    expect(runDtakoScrapeTool.description).toContain("get_dtako_scrape_status");
    expect(runDtakoScrapeTool.description).toContain("勤務日ではなく読取日");
  });

  it("**dates は必須で、既定値が無い** (schema が空配列も弾く)", () => {
    expect(runDtakoScrapeTool.inputSchema.safeParse({}).success).toBe(false);
    expect(runDtakoScrapeTool.inputSchema.safeParse({ dates: [] }).success).toBe(false);
    expect(runDtakoScrapeTool.inputSchema.safeParse({ dates: ["2026-6-3"] }).success).toBe(false);
    expect(runDtakoScrapeTool.inputSchema.safeParse({ dates: ["2026-06-03"] }).success).toBe(true);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    const args = { dates: ["2026-06-03"] };
    await expect(
      runDtakoScrapeTool.execute(env({ SCRAPER_RELAY: undefined }), args),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runDtakoScrapeTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), args),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/scrape を叩き、応答をそのまま返す", async () => {
    const accepted = {
      comp_id: "0100",
      note: "**受理しただけで、まだ結果は出ていません。**",
      accepted_dates: ["2026-06-03"],
      truncated_dates: [],
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(accepted), { status: 202 })) },
    });
    const got = await runDtakoScrapeTool.execute(e, { dates: ["2026-06-03"], comp_id: "0100" });
    expect(got).toEqual(accepted);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/scrape");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({
      dates: ["2026-06-03"],
      comp_id: "0100",
    });
  });

  it("comp_id を省略すると relay の既定に委ねる (こちらで埋めない)", async () => {
    const e = env();
    await runDtakoScrapeTool.execute(e, { dates: ["2026-06-03"] });
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.comp_id).toBeUndefined();
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(runDtakoScrapeTool.execute(bad, { dates: ["2026-06-03"] })).rejects.toThrow(
      /relay: status 401: nope/,
    );
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(runDtakoScrapeTool.execute(html, { dates: ["2026-06-03"] })).rejects.toThrow(
      /parse failed/,
    );
  });
});

describe("get_dtako_scrape_status", () => {
  it("**read tool** — scope を要求しない", () => {
    expect((getDtakoScrapeStatusTool as { requiresScope?: string }).requiresScope).toBeUndefined();
  });

  it("**split_failed が十分条件でないことが説明から読める**", () => {
    expect(getDtakoScrapeStatusTool.description).toContain("十分条件ではない");
    expect(getDtakoScrapeStatusTool.description).toContain("unsplit_total");
    // **null は「残っていない」ではなく「見ていない」**
    expect(getDtakoScrapeStatusTool.description).toContain("見ていない");
  });

  // **「履歴に無い」は「実行されていない」ではない** (Refs #958)。#946 で無人実行も
  // ここに載るようになったが書き込みは best-effort で、#946 より前の分は載っていない。
  it("**説明で「載っていない = 実行されていない」ではないことが読める** (Refs #958)", () => {
    const d = getDtakoScrapeStatusTool.description;
    expect(d).toContain("実行されていない」の根拠にしない");
    expect(d).toContain("best-effort");
    expect(d).toContain("#946 より前の無人実行はそもそも載っていない");
    // fold の情報はこちらには 1 件も載らない — 探す先を名指しする
    expect(d).toContain("fold_* は get_dtako_scrape_progress 側だけが持つ");
  });

  it("limit を省略すると relay の既定に委ねる", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ history: [] }))) },
    });
    await getDtakoScrapeStatusTool.execute(e, {});
    expect(relayOf(e).fetch.mock.calls[0]![0]).toBe(
      "https://relay.internal/kintai-relay/scrape-history",
    );
  });

  it("limit を渡すと query に載り、応答をそのまま返す", async () => {
    const body = { limit: 5, split_failed: 1, unsplit_total: null, history: [{ status: "split_failed" }] };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(body))) },
    });
    const got = await getDtakoScrapeStatusTool.execute(e, { limit: 5 });
    expect(got).toEqual(body);
    expect(relayOf(e).fetch.mock.calls[0]![0]).toBe(
      "https://relay.internal/kintai-relay/scrape-history?limit=5",
    );
  });

  it("**date_from / date_to を渡すと unsplit_total を数えに行く**", async () => {
    const body = { split_failed: 0, unsplit_total: 0, unsplit: [], history: [] };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(body))) },
    });
    const got = await getDtakoScrapeStatusTool.execute(e, {
      date_from: "2026-06-03",
      date_to: "2026-07-01",
    });
    expect(got).toEqual(body);
    expect(relayOf(e).fetch.mock.calls[0]![0]).toBe(
      "https://relay.internal/kintai-relay/scrape-history?date_from=2026-06-03&date_to=2026-07-01",
    );
  });

  it("日付の形が違えば schema が弾く", () => {
    expect(getDtakoScrapeStatusTool.inputSchema.safeParse({ date_from: "2026-6-3" }).success).toBe(
      false,
    );
    expect(
      getDtakoScrapeStatusTool.inputSchema.safeParse({
        date_from: "2026-06-03",
        date_to: "2026-07-01",
      }).success,
    ).toBe(true);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      getDtakoScrapeStatusTool.execute(env({ SCRAPER_RELAY: undefined }), {}),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      getDtakoScrapeStatusTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), {}),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 502 })) },
    });
    await expect(getDtakoScrapeStatusTool.execute(bad, {})).rejects.toThrow(/relay: status 502/);
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(getDtakoScrapeStatusTool.execute(html, {})).rejects.toThrow(/parse failed/);
  });
});
