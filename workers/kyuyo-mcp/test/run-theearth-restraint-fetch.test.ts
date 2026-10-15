import { describe, it, expect, vi } from "vitest";
import { runTheearthRestraintFetchTool } from "../src/mcp/tools";
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
const baseArgs = { comp_id: "00000002", month: "2026-08" };

describe("run_theearth_restraint_fetch", () => {
  it("**write tool として scope を要求する**", () => {
    expect(runTheearthRestraintFetchTool.requiresScope).toBe("mcp.write");
  });

  it("説明に「無人ログイン」「人のセッションを蹴りうる」「no_data は失敗ではない」が読める", () => {
    const d = runTheearthRestraintFetchTool.description;
    expect(d).toContain("DTAKO_ACCOUNTS の資格情報で自前ログイン");
    expect(d).toContain("人のセッションを蹴りうる");
    expect(d).toContain("`no_data: true` は失敗ではない");
    expect(d).toContain("/kintai-relay/");
  });

  it("comp_id (8 桁) と month (YYYY-MM) は必須、未知の引数は弾く", () => {
    const s = runTheearthRestraintFetchTool.inputSchema;
    expect(s.safeParse(baseArgs).success).toBe(true);
    expect(s.safeParse({ month: "2026-08" }).success).toBe(false);
    expect(s.safeParse({ comp_id: "00000002" }).success).toBe(false);
    expect(s.safeParse({ ...baseArgs, comp_id: "123" }).success).toBe(false);
    expect(s.safeParse({ ...baseArgs, month: "2026-8" }).success).toBe(false);
    expect(s.safeParse({ ...baseArgs, extra: 1 }).success).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runTheearthRestraintFetchTool.execute(env({ SCRAPER_RELAY: undefined }), baseArgs),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runTheearthRestraintFetchTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), baseArgs),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/theearth-restraint-run を叩き、応答をそのまま返す", async () => {
    const payload = { comp_id: "00000002", month: "2026-08", no_data: false, drivers: 13, theearth_logins: 1, theearth_kicked: false };
    const e = env({ SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) } });
    expect(await runTheearthRestraintFetchTool.execute(e, baseArgs)).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/theearth-restraint-run");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ month: "2026-08", comp_id: "00000002" });
  });
});
