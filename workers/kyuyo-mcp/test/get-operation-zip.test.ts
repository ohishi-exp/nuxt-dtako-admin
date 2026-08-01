import { describe, it, expect, vi } from "vitest";
import { getOperationZipTool } from "../src/mcp/tools";
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

describe("get_operation_zip (Refs ohishi-exp/rust-ichibanboshi#274, #205 の 59)", () => {
  it("**read tool** — scope を要求しない (取り込みはしない)", () => {
    expect((getOperationZipTool as { requiresScope?: string }).requiresScope).toBeUndefined();
  });

  it("**説明で「取り込みはしない」「上限超過で omitted」が読める**", () => {
    expect(getOperationZipTool.description).toContain("取り込み");
    expect(getOperationZipTool.description).toContain("omitted");
    expect(getOperationZipTool.description).toContain("entries");
  });

  it("ope_no_22 は 22 桁のみ通す (23 桁 unko_no はここで弾く)", () => {
    expect(getOperationZipTool.inputSchema.safeParse({ ope_no_22: OPE_NO_22, start_ope: START_OPE }).success).toBe(
      true,
    );
    expect(
      getOperationZipTool.inputSchema.safeParse({ ope_no_22: `${OPE_NO_22}9`, start_ope: START_OPE }).success,
    ).toBe(false); // 23 桁
    expect(
      getOperationZipTool.inputSchema.safeParse({ ope_no_22: OPE_NO_22.slice(1), start_ope: START_OPE }).success,
    ).toBe(false); // 21 桁
  });

  it("start_ope の形式が違えば schema が弾く", () => {
    expect(
      getOperationZipTool.inputSchema.safeParse({ ope_no_22: OPE_NO_22, start_ope: "2026-07-07 07:53:30" }).success,
    ).toBe(false);
    expect(
      getOperationZipTool.inputSchema.safeParse({ ope_no_22: OPE_NO_22, start_ope: "2026/07/07 07:53:30" }).success,
    ).toBe(true); // 0埋めありも許容 (\d{1,2})
  });

  it("binding / secret が無ければ fail-closed", async () => {
    const args = { ope_no_22: OPE_NO_22, start_ope: START_OPE };
    await expect(
      getOperationZipTool.execute(env({ SCRAPER_RELAY: undefined }), args),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      getOperationZipTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), args),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/operation-zip を叩き、応答をそのまま返す", async () => {
    const payload = {
      ok: true,
      comp_id: "0100",
      ope_no: OPE_NO_22,
      start_ope: START_OPE,
      bytes: 8712,
      zip_base64: "UEsDBA==",
      omitted: false,
      limit_bytes: 1_000_000,
      entries: ["KUDGFUL.csv", "KUDGIVT.csv", "KUDGSIR.csv", "KUDGURI.csv", "SokudoData.csv"],
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
    });
    const got = await getOperationZipTool.execute(e, {
      ope_no_22: OPE_NO_22,
      start_ope: START_OPE,
      comp_id: "0100",
    });
    expect(got).toEqual(payload);
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/operation-zip");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    expect(JSON.parse(init.body as string)).toEqual({
      ope_no: OPE_NO_22,
      start_ope: START_OPE,
      comp_id: "0100",
    });
  });

  it("comp_id を省略すると relay の既定に委ねる (こちらで埋めない)", async () => {
    const e = env();
    await getOperationZipTool.execute(e, { ope_no_22: OPE_NO_22, start_ope: START_OPE });
    const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.comp_id).toBeUndefined();
  });

  it("上限超過 (omitted: true) の応答もそのまま返す (黙って切らない)", async () => {
    const omitted = {
      ok: true,
      comp_id: "0100",
      ope_no: OPE_NO_22,
      start_ope: START_OPE,
      bytes: 5_000_000,
      zip_base64: null,
      omitted: true,
      limit_bytes: 1_000_000,
      entries: ["KUDGFUL.csv"],
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(omitted))) },
    });
    const got = await getOperationZipTool.execute(e, { ope_no_22: OPE_NO_22, start_ope: START_OPE });
    expect(got).toEqual(omitted);
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(
      getOperationZipTool.execute(bad, { ope_no_22: OPE_NO_22, start_ope: START_OPE }),
    ).rejects.toThrow(/relay: status 401: nope/);
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(
      getOperationZipTool.execute(html, { ope_no_22: OPE_NO_22, start_ope: START_OPE }),
    ).rejects.toThrow(/parse failed/);
  });
});
