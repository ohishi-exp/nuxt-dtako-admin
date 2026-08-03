import { describe, it, expect, vi } from "vitest";
import { runKintaiRestraintSyncTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };
const baseArgs = { month: "2026-07" };

describe("run_kintai_restraint_sync (Refs #606-6)", () => {
  it("**write tool として scope を要求する** — read tool と同じ扱いにしない", () => {
    expect(runKintaiRestraintSyncTool.requiresScope).toBe("mcp.write");
  });

  it("**説明で /restraint-api/* ではなく /kintai-relay/* を叩くことが読める**", () => {
    expect(runKintaiRestraintSyncTool.description).toContain("/kintai-relay/");
    expect(runKintaiRestraintSyncTool.description).not.toContain("/restraint-api/kintai/fetch");
  });

  it("month は必須 (YYYY-MM のみ通す)", () => {
    expect(runKintaiRestraintSyncTool.inputSchema.safeParse(baseArgs).success).toBe(true);
    expect(runKintaiRestraintSyncTool.inputSchema.safeParse({}).success).toBe(false);
    expect(
      runKintaiRestraintSyncTool.inputSchema.safeParse({ month: "2026-7" }).success,
    ).toBe(false);
    expect(
      runKintaiRestraintSyncTool.inputSchema.safeParse({ month: "2026-13" }).success,
    ).toBe(true); // 桁の regex のみ。月の範囲チェックは受け側 (relay) の責務
  });

  it("comp_id は省略できる", () => {
    expect(
      runKintaiRestraintSyncTool.inputSchema.safeParse({ ...baseArgs, comp_id: "27324455" }).success,
    ).toBe(true);
  });

  it("未知の引数は弾く (strict)", () => {
    expect(
      runKintaiRestraintSyncTool.inputSchema.safeParse({ ...baseArgs, extra: 1 }).success,
    ).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runKintaiRestraintSyncTool.execute(env({ SCRAPER_RELAY: undefined }), baseArgs),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runKintaiRestraintSyncTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), baseArgs),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/restraint-sync を叩き、応答をそのまま返す", async () => {
    const payload = { month: "2026-07", rows: 12, drivers: 3, summaries_updated: 3, fetched_at: "x" };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await runKintaiRestraintSyncTool.execute(e, { ...baseArgs, comp_id: "27324455" });
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/restraint-sync");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ month: "2026-07", comp_id: "27324455" });
  });

  it("comp_id を省略すると relay の既定に委ねる (こちらで埋めない)", async () => {
    const e = env();
    await runKintaiRestraintSyncTool.execute(e, baseArgs);
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.comp_id).toBeUndefined();
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(runKintaiRestraintSyncTool.execute(bad, baseArgs)).rejects.toThrow(
      /relay: status 401: nope/,
    );
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(runKintaiRestraintSyncTool.execute(html, baseArgs)).rejects.toThrow(/parse failed/);
  });
});
