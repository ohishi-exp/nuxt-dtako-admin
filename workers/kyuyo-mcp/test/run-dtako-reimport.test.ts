import { describe, it, expect, vi } from "vitest";
import { runDtakoReimportTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";
const OPE_NO_22 = "2606050753300000004286";
const START_OPE = "2026/07/07 7:53:30";
const UNKO_NO_23 = "26060507533000000042861";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };
const baseArgs = { ope_no_22: OPE_NO_22, start_ope: START_OPE, unko_no: UNKO_NO_23 };

describe("run_dtako_reimport (Refs ohishi-exp/rust-ichibanboshi#280, #205 の 67)", () => {
  it("**write tool として scope を要求する** — read tool と同じ扱いにしない (受け入れ条件7)", () => {
    expect(runDtakoReimportTool.requiresScope).toBe("mcp.write");
  });

  it("**説明で base64 を書き写さないこと・http_status が成否の証明にならないこと・reset_timecard 既定 false が読める**", () => {
    expect(runDtakoReimportTool.description).toContain("base64");
    expect(runDtakoReimportTool.description).toContain("http_status");
    expect(runDtakoReimportTool.description).toContain("既定は false");
    expect(runDtakoReimportTool.description).toContain("entries");
  });

  it("unko_no は23桁のみ通す (22桁の ope_no_22 と桁数が違う)", () => {
    expect(runDtakoReimportTool.inputSchema.safeParse(baseArgs).success).toBe(true);
    expect(
      runDtakoReimportTool.inputSchema.safeParse({ ...baseArgs, unko_no: UNKO_NO_23.slice(1) }).success,
    ).toBe(false); // 22桁
    expect(
      runDtakoReimportTool.inputSchema.safeParse({ ...baseArgs, unko_no: `${UNKO_NO_23}9` }).success,
    ).toBe(false); // 24桁
    expect(
      runDtakoReimportTool.inputSchema.safeParse({ ...baseArgs, unko_no: `${UNKO_NO_23.slice(0, 22)}a` })
        .success,
    ).toBe(false); // 非数字混じり
  });

  it("ope_no_22 / start_ope の形式チェックは get_operation_zip と同じ regex を使う", () => {
    expect(
      runDtakoReimportTool.inputSchema.safeParse({ ...baseArgs, ope_no_22: `${OPE_NO_22}9` }).success,
    ).toBe(false); // 23桁 (unko_no と混同していない)
    expect(
      runDtakoReimportTool.inputSchema.safeParse({ ...baseArgs, start_ope: "2026-07-07 07:53:30" }).success,
    ).toBe(false);
  });

  it("reset_timecard / comp_id は省略できる", () => {
    expect(runDtakoReimportTool.inputSchema.safeParse(baseArgs).success).toBe(true);
    expect(
      runDtakoReimportTool.inputSchema.safeParse({ ...baseArgs, reset_timecard: true, comp_id: "0100" })
        .success,
    ).toBe(true);
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      runDtakoReimportTool.execute(env({ SCRAPER_RELAY: undefined }), baseArgs),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      runDtakoReimportTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), baseArgs),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/dtako-reimport を叩き、応答をそのまま返す", async () => {
    const payload = {
      ope_no: OPE_NO_22,
      start_ope: START_OPE,
      unko_no: UNKO_NO_23,
      bytes: 8712,
      entries: ["KUDGFUL.csv", "KUDGIVT.csv"],
      http_status: 200,
      autoload: { http_status: 200, http_ok: true, location: null, response_excerpt: "ok" },
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await runDtakoReimportTool.execute(e, { ...baseArgs, comp_id: "0100" });
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/dtako-reimport");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({
      ope_no: OPE_NO_22,
      start_ope: START_OPE,
      unko_no: UNKO_NO_23,
      reset_timecard: false,
      comp_id: "0100",
    });
  });

  it("reset_timecard を明示的に渡すと body へそのまま乗る", async () => {
    const e = env();
    await runDtakoReimportTool.execute(e, { ...baseArgs, reset_timecard: true });
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.reset_timecard).toBe(true);
  });

  it("reset_timecard 省略時は false を明示する (既定で③まで実行しない)", async () => {
    const e = env();
    await runDtakoReimportTool.execute(e, baseArgs);
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.reset_timecard).toBe(false);
  });

  it("comp_id を省略すると relay の既定に委ねる (こちらで埋めない)", async () => {
    const e = env();
    await runDtakoReimportTool.execute(e, baseArgs);
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.comp_id).toBeUndefined();
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(runDtakoReimportTool.execute(bad, baseArgs)).rejects.toThrow(/relay: status 401: nope/);
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(runDtakoReimportTool.execute(html, baseArgs)).rejects.toThrow(/parse failed/);
  });
});
