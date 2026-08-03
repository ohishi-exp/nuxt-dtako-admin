import { describe, it, expect, vi } from "vitest";
import { runDtakoAlcUploadTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";
const OPE_NO_22 = "2606050753300000004286";
const START_OPE = "2026/07/07 7:53:30";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };
const baseArgs = { ope_no_22: OPE_NO_22, start_ope: START_OPE };

describe("run_dtako_alc_upload (Refs #633-9)", () => {
  it("**write tool として scope を要求する** — read tool と同じ扱いにしない (受け入れ条件4)", () => {
    expect(runDtakoAlcUploadTool.requiresScope).toBe("mcp.write");
  });

  it("**説明に run_dtako_reimport との違い (unko_no 無し・reset_timecard 無し) が読める**", () => {
    expect(runDtakoAlcUploadTool.description).toContain("unko_no は渡さない");
    expect(runDtakoAlcUploadTool.description).toContain("reset_timecard も無い");
  });

  it("**説明に preview 無し・get_operation_zip を先に呼ぶことが読める**", () => {
    expect(runDtakoAlcUploadTool.description).toContain("preview は無い");
    expect(runDtakoAlcUploadTool.description).toContain("get_operation_zip");
  });

  it("**説明に split_confirmed が常に false であることが読める**", () => {
    expect(runDtakoAlcUploadTool.description).toContain("split_confirmed");
    expect(runDtakoAlcUploadTool.description).toContain("split_failed: 0");
  });

  it("**説明に has_kudgivt が DEFAULT FALSE に戻ることが読める**", () => {
    expect(runDtakoAlcUploadTool.description).toContain("has_kudgivt");
    expect(runDtakoAlcUploadTool.description).toContain("DEFAULT FALSE");
  });

  it("**説明に並列に叩かない注意が読める**", () => {
    expect(runDtakoAlcUploadTool.description).toContain("並列");
  });

  it("inputSchema は unko_no / reset_timecard を持たない (strict なので余計なキーは弾く)", () => {
    expect(runDtakoAlcUploadTool.inputSchema.safeParse(baseArgs).success).toBe(true);
    expect(
      runDtakoAlcUploadTool.inputSchema.safeParse({
        ...baseArgs,
        unko_no: "26060507533000000042861",
      }).success,
    ).toBe(false);
    expect(
      runDtakoAlcUploadTool.inputSchema.safeParse({ ...baseArgs, reset_timecard: true }).success,
    ).toBe(false);
  });

  it("ope_no_22 / start_ope の形式チェックは get_operation_zip と同じ regex を使う", () => {
    expect(
      runDtakoAlcUploadTool.inputSchema.safeParse({ ...baseArgs, ope_no_22: `${OPE_NO_22}9` })
        .success,
    ).toBe(false); // 23桁
    expect(
      runDtakoAlcUploadTool.inputSchema.safeParse({
        ...baseArgs,
        start_ope: "2026-07-07 07:53:30",
      }).success,
    ).toBe(false);
  });

  it("comp_id は省略できる", () => {
    expect(runDtakoAlcUploadTool.inputSchema.safeParse(baseArgs).success).toBe(true);
    expect(
      runDtakoAlcUploadTool.inputSchema.safeParse({ ...baseArgs, comp_id: "0100" }).success,
    ).toBe(true);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runDtakoAlcUploadTool.execute(env({ SCRAPER_RELAY: undefined }), baseArgs),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runDtakoAlcUploadTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), baseArgs),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("relay の /kintai-relay/dtako-alc-upload を叩き、応答をそのまま返す。body に unko_no / reset_timecard を含めない", async () => {
    const payload = {
      ope_no: OPE_NO_22,
      start_ope: START_OPE,
      bytes: 8712,
      entries: ["KUDGURI.csv", "KUDGIVT.csv"],
      upload_id: "abc123",
      operations_count: 1,
      split_failed: 0,
      split_confirmed: false,
      notes: { has_kudgivt: "...", split: "...", preview: "..." },
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await runDtakoAlcUploadTool.execute(e, { ...baseArgs, comp_id: "0100" });
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/dtako-alc-upload");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ ope_no: OPE_NO_22, start_ope: START_OPE, comp_id: "0100" });
    expect(body).not.toHaveProperty("unko_no");
    expect(body).not.toHaveProperty("reset_timecard");
  });

  it("comp_id を省略すると relay の既定に委ねる (こちらで埋めない)", async () => {
    const e = env();
    await runDtakoAlcUploadTool.execute(e, baseArgs);
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.comp_id).toBeUndefined();
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(runDtakoAlcUploadTool.execute(bad, baseArgs)).rejects.toThrow(
      /relay: status 401: nope/,
    );
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(runDtakoAlcUploadTool.execute(html, baseArgs)).rejects.toThrow(/parse failed/);
  });
});
