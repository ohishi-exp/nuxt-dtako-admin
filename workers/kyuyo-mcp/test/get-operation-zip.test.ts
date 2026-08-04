import { describe, it, expect, vi } from "vitest";
import { getOperationZipTool } from "../src/mcp/tools";
import { CRON_BATCH_MAX_ITEMS } from "../../dtako-scraper-relay/src/cron-batch";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";
const OPE_NO_22 = "2606050753300000004286";
const START_OPE = "2026/07/07 7:53:30";
const OPE_NO_22_B = "2606050753300000004287";
const START_OPE_B = "2026/07/08 8:00:00";

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

  // Refs #633-24: items (バッチ) 対応。単体形式は上のテストで固定済み (regression)。
  describe("recalculate (単体形式)", () => {
    it("**説明で既定 false / 書き込みになることが読める**", () => {
      expect(getOperationZipTool.description).toContain("recalculate");
      expect(getOperationZipTool.description).toContain("既定は読むだけ");
    });

    it("省略時は relay へ recalculate を送らない (既定 false は relay 側の契約)", async () => {
      const e = env();
      await getOperationZipTool.execute(e, { ope_no_22: OPE_NO_22, start_ope: START_OPE });
      const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.recalculate).toBeUndefined();
    });

    it("true を渡すと body にそのまま乗る", async () => {
      const e = env();
      await getOperationZipTool.execute(e, { ope_no_22: OPE_NO_22, start_ope: START_OPE, recalculate: true });
      const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.recalculate).toBe(true);
    });
  });

  describe("items (バッチ, Refs #633-24)", () => {
    it("**説明で上限件数・zip_base64 が返らないことが読める**", () => {
      expect(getOperationZipTool.description).toContain("items");
      expect(getOperationZipTool.description).toContain(String(CRON_BATCH_MAX_ITEMS));
      expect(getOperationZipTool.description).toContain("zip_base64 は返らない");
    });

    it("ope_no_22/start_ope と items のどちらも無いと拒否する", () => {
      expect(getOperationZipTool.inputSchema.safeParse({}).success).toBe(false);
    });

    it("items だけでも通る (単体フィールド省略可)", () => {
      expect(
        getOperationZipTool.inputSchema.safeParse({
          items: [{ ope_no_22: OPE_NO_22, start_ope: START_OPE }],
        }).success,
      ).toBe(true);
    });

    it(`items は最大 ${CRON_BATCH_MAX_ITEMS} 件まで — schema レベルでも超過を弾く`, () => {
      const items = Array.from({ length: CRON_BATCH_MAX_ITEMS }, () => ({
        ope_no_22: OPE_NO_22,
        start_ope: START_OPE,
      }));
      expect(getOperationZipTool.inputSchema.safeParse({ items }).success).toBe(true);
      expect(
        getOperationZipTool.inputSchema.safeParse({ items: [...items, { ope_no_22: OPE_NO_22, start_ope: START_OPE }] })
          .success,
      ).toBe(false);
    });

    it("items が空配列だと拒否する (min 1)", () => {
      expect(getOperationZipTool.inputSchema.safeParse({ items: [] }).success).toBe(false);
    });

    it("items の要素は ope_no_22/start_ope の形式チェックを受ける", () => {
      expect(
        getOperationZipTool.inputSchema.safeParse({ items: [{ ope_no_22: "bad", start_ope: START_OPE }] }).success,
      ).toBe(false);
    });

    it("items を渡すと {comp_id, items:[{ope_no,start_ope,recalculate}]} 形式で relay へ送る", async () => {
      const e = env();
      await getOperationZipTool.execute(e, {
        comp_id: "0100",
        items: [
          { ope_no_22: OPE_NO_22, start_ope: START_OPE },
          { ope_no_22: OPE_NO_22_B, start_ope: START_OPE_B, recalculate: true },
        ],
      });
      const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(body).toEqual({
        comp_id: "0100",
        items: [
          { ope_no: OPE_NO_22, start_ope: START_OPE, recalculate: false },
          { ope_no: OPE_NO_22_B, start_ope: START_OPE_B, recalculate: true },
        ],
      });
    });

    it("items を渡すと単体形式の ope_no_22/start_ope/recalculate は無視される", async () => {
      const e = env();
      await getOperationZipTool.execute(e, {
        ope_no_22: OPE_NO_22,
        start_ope: START_OPE,
        recalculate: true,
        items: [{ ope_no_22: OPE_NO_22_B, start_ope: START_OPE_B }],
      });
      const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.items).toEqual([{ ope_no: OPE_NO_22_B, start_ope: START_OPE_B, recalculate: false }]);
      expect(body.ope_no).toBeUndefined();
    });

    it("バッチ応答 (results[]/truncated/remaining) もそのまま返す", async () => {
      const payload = {
        ok: true,
        comp_id: "0100",
        results: [
          { ok: true, result: { ope_no: OPE_NO_22, bytes: 100, omitted: false, entries: ["KUDGURI.csv"] } },
          { ok: false, error: "seq expired" },
        ],
        success_count: 1,
        failure_count: 1,
        truncated: true,
        remaining: 3,
        theearth_logins: 1,
        theearth_kicked: false,
      };
      const e = env({
        SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
      });
      const got = await getOperationZipTool.execute(e, {
        items: [{ ope_no_22: OPE_NO_22, start_ope: START_OPE }],
      });
      expect(got).toEqual(payload);
    });
  });
});
