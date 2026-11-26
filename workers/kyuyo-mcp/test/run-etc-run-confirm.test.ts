import { describe, it, expect, vi } from "vitest";
import { runEtcRunConfirmTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

/**
 * `run_etc_run_confirm` — ETC カード追加登録の確認段を読取日についてやり直す (Refs ohishi-exp/nuxt-dtako-admin#1287)。
 * ★ **write tool**。relay が zip を取り直し、D1 の run_date を書く。comp_id は架空値。
 */

function env(response: unknown = { ok: true, etc_confirm_state: "confirmed" }) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(response))) },
    INTERNAL_SHARED_SECRET: "internal-shared-secret",
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("run_etc_run_confirm (Refs ohishi-exp/nuxt-dtako-admin#1287)", () => {
  it("write tool として scope を要求する", () => {
    expect(runEtcRunConfirmTool.requiresScope).toBe("mcp.write");
  });

  it("reading_date は必須で YYYY-MM-DD だけ、知らない引数は弾く", () => {
    expect(runEtcRunConfirmTool.inputSchema.safeParse({}).success).toBe(false);
    expect(runEtcRunConfirmTool.inputSchema.safeParse({ reading_date: "2026/11/26" }).success).toBe(false);
    expect(runEtcRunConfirmTool.inputSchema.safeParse({ reading_date: "2026-11-26", x: 1 }).success).toBe(false);
    expect(runEtcRunConfirmTool.inputSchema.safeParse({ reading_date: "2026-11-26", comp_id: "c1" }).success).toBe(true);
  });

  it("relay の /kintai-relay/etc-confirm へ読取日と comp_id を送り、応答をそのまま返す", async () => {
    const e = env();
    const out = await runEtcRunConfirmTool.execute(e, { reading_date: "2026-11-26", comp_id: "c1" });
    expect(out).toEqual({ ok: true, etc_confirm_state: "confirmed" });
    const [url, init] = relayOf(e).fetch.mock.calls[0]!;
    expect(url).toBe("https://relay.internal/kintai-relay/etc-confirm");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ reading_date: "2026-11-26", comp_id: "c1" });
  });

  it("comp_id を省けば body に載せない (relay の既定に任せる)", async () => {
    const e = env();
    await runEtcRunConfirmTool.execute(e, { reading_date: "2026-11-26" });
    const [, init] = relayOf(e).fetch.mock.calls[0]!;
    expect(JSON.parse(init.body)).toEqual({ reading_date: "2026-11-26" });
  });

  it("説明が結果の読み口と、取り込みをしないことを書いている", () => {
    expect(runEtcRunConfirmTool.description).toMatch(/alc への取り込みはしない/);
    expect(runEtcRunConfirmTool.description).toMatch(/get_dtako_scrape_progress/);
  });
});
