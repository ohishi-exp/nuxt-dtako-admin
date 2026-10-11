import { describe, it, expect, vi } from "vitest";
import { runKintaiRestraintResummarizeTool } from "../src/mcp/tools";
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
const baseArgs = { month: "2026-06" };

describe("run_kintai_restraint_resummarize (Refs ohishi-exp/rust-ichibanboshi#322)", () => {
  it("**write tool として scope を要求する**", () => {
    expect(runKintaiRestraintResummarizeTool.requiresScope).toBe("mcp.write");
  });

  it("説明に「theearth に触らない」「勤怠 Worker の D1 に書く」「viewer 側のキャッシュは消さない」が読める", () => {
    const d = runKintaiRestraintResummarizeTool.description;
    expect(d).toContain("R2 に保存済みの生 CSV から再計算し、theearth には触らない");
    expect(d).toContain("勤怠 Worker の D1。");
    expect(d).not.toContain("オンプレ版");
    expect(d).toContain("scraper-comp-{comp}");
    expect(d).toContain("viewer 側の DO が持つ上流キャッシュ");
    expect(d).toContain("/kintai-relay/");
  });

  it("month は必須 (YYYY-MM のみ通す)、comp_id は任意、未知の引数は弾く", () => {
    const s = runKintaiRestraintResummarizeTool.inputSchema;
    expect(s.safeParse(baseArgs).success).toBe(true);
    expect(s.safeParse({}).success).toBe(false);
    expect(s.safeParse({ month: "2026-6" }).success).toBe(false);
    expect(s.safeParse({ ...baseArgs, comp_id: "27324455" }).success).toBe(true);
    expect(s.safeParse({ ...baseArgs, extra: 1 }).success).toBe(false);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runKintaiRestraintResummarizeTool.execute(env({ SCRAPER_RELAY: undefined }), baseArgs),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runKintaiRestraintResummarizeTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), baseArgs),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/restraint-resummarize を叩き、応答 (restraint_push 込み) をそのまま返す", async () => {
    const payload = {
      month: "2026-06",
      csv_processed: 1,
      summaries_written: 2,
      summaries_new_version: 0,
      errors: [],
      restraint_push: { onprem: { outcome: "done", puts: 1 }, kintai: { outcome: "done", puts: 1 } },
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await runKintaiRestraintResummarizeTool.execute(e, { ...baseArgs, comp_id: "27324455" });
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/restraint-resummarize");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({ month: "2026-06", comp_id: "27324455" });
  });

  it("restraint_push に onprem キーが無い (勤怠 Worker だけの) 応答もそのまま返す", async () => {
    const payload = {
      month: "2026-06",
      csv_processed: 1,
      summaries_written: 2,
      summaries_new_version: 0,
      errors: [],
      restraint_push: { kintai: { outcome: "done", puts: 1 } },
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await runKintaiRestraintResummarizeTool.execute(e, baseArgs);
    expect(got).toEqual(payload);
  });

  it("comp_id を省略すると relay の既定に委ねる (こちらで埋めない)", async () => {
    const e = env();
    await runKintaiRestraintResummarizeTool.execute(e, baseArgs);
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.comp_id).toBeUndefined();
  });

  it("relay の失敗は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(runKintaiRestraintResummarizeTool.execute(bad, baseArgs)).rejects.toThrow(
      /relay: status 401: nope/,
    );
  });
});
