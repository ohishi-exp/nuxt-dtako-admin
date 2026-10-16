import { describe, it, expect, vi } from "vitest";
import { runTheearthRestraintCalcTool } from "../src/mcp/tools";
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

describe("run_theearth_restraint_calc", () => {
  it("**write tool として scope を要求する**", () => {
    expect(runTheearthRestraintCalcTool.requiresScope).toBe("mcp.write");
  });

  it("説明に「CSV は最後に集計した結果しか返さない」「拘束時間管理表を書き換える」「並列に呼ばない」が読める", () => {
    const d = runTheearthRestraintCalcTool.description;
    expect(d).toContain("F-ERS2012");
    expect(d).toContain("theearth が最後に集計した結果しか返さない");
    expect(d).toContain("theearth の拘束時間管理表を書き換える");
    expect(d).toContain("並列に呼ばない");
  });

  it("comp_id (8 桁) と month (YYYY-MM) は必須、未知の引数は弾く", () => {
    const s = runTheearthRestraintCalcTool.inputSchema;
    expect(s.safeParse(baseArgs).success).toBe(true);
    expect(s.safeParse({ month: "2026-07" }).success).toBe(false);
    expect(s.safeParse({ ...baseArgs, extra: 1 }).success).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runTheearthRestraintCalcTool.execute(env({ SCRAPER_RELAY: undefined }), baseArgs),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runTheearthRestraintCalcTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), baseArgs),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/theearth-restraint-calc を叩き、応答をそのまま返す", async () => {
    const payload = {
      comp_id: "75700192",
      month: "2026-07",
      calculated: [{ branch: "本社", drivers: 13, uncalculated_before: ["18"] }],
      no_data: false,
      drivers: 12,
      theearth_logins: 1,
      theearth_kicked: false,
    };
    const e = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) } });
    expect(await runTheearthRestraintCalcTool.execute(e, baseArgs)).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/theearth-restraint-calc");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ month: "2026-07", comp_id: "75700192" });
  });
});
