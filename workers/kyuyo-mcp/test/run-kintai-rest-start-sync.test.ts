import { describe, it, expect, vi } from "vitest";
import { runKintaiRestStartSyncTool } from "../src/mcp/tools";
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
const baseArgs = { comp_id: "75700192", month: "2026-07" };

describe("run_kintai_rest_start_sync", () => {
  it("**write tool として scope を要求する**", () => {
    expect(runKintaiRestStartSyncTool.requiresScope).toBe("mcp.write");
  });

  it("説明に「最後に車が動いた時刻」「既定は書かない」「人のセッションを蹴りうる」が読める", () => {
    const d = runKintaiRestStartSyncTool.description;
    expect(d).toContain("速度データで最後に車が動いた時刻");
    expect(d).toContain("既定は書かない");
    expect(d).toContain("人のセッションを蹴りうる");
    expect(d).toContain("/kintai-relay/");
  });

  it("comp_id (8 桁) と month (YYYY-MM) は必須、apply は boolean、未知の引数は弾く", () => {
    const s = runKintaiRestStartSyncTool.inputSchema;
    expect(s.safeParse(baseArgs).success).toBe(true);
    expect(s.safeParse({ ...baseArgs, apply: true }).success).toBe(true);
    expect(s.safeParse({ ...baseArgs, apply: "yes" }).success).toBe(false);
    expect(s.safeParse({ month: "2026-07" }).success).toBe(false);
    expect(s.safeParse({ ...baseArgs, month: "2026-7" }).success).toBe(false);
    expect(s.safeParse({ ...baseArgs, extra: 1 }).success).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(runKintaiRestStartSyncTool.execute(env({ SCRAPER_RELAY: undefined }), baseArgs)).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(runKintaiRestStartSyncTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), baseArgs)).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("relay の /kintai-relay/rest-start-sync を叩く (apply は省略で false)", async () => {
    const payload = { candidates: 1, overrides: [], written: null };
    const e = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) } });
    expect(await runKintaiRestStartSyncTool.execute(e, baseArgs)).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/rest-start-sync");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ month: "2026-07", comp_id: "75700192", apply: false });
    await runKintaiRestStartSyncTool.execute(e, { ...baseArgs, apply: true });
    expect(JSON.parse((relayOf(e).fetch.mock.calls[1]![1] as RequestInit).body as string).apply).toBe(true);
  });
});
