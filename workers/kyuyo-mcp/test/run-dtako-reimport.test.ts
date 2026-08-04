import { describe, it, expect, vi } from "vitest";
import { runDtakoReimportTool } from "../src/mcp/tools";
import { CRON_BATCH_MAX_ITEMS } from "../../dtako-scraper-relay/src/cron-batch";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";
const OPE_NO_22 = "2606050753300000004286";
const START_OPE = "2026/07/07 7:53:30";
const UNKO_NO_23 = "26060507533000000042861";
const OPE_NO_22_B = "2606050753300000004287";
const START_OPE_B = "2026/07/08 8:00:00";
const UNKO_NO_23_B = "26060507533000000042872";

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

  it("**説明で uncertain:true のときは再実行しないことが読める** (push 後に応答不明=二重取り込み事故の歯止め)", () => {
    expect(runDtakoReimportTool.description).toContain("uncertain");
    expect(runDtakoReimportTool.description).toContain("再実行しない");
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

  it("relay が uncertain:true を返した (push 後に応答不明) 場合もそのままエラー文へ透過する", async () => {
    const e = env({
      SCRAPER_RELAY: {
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ error: "応答を確定できませんでした", uncertain: true }), {
              status: 502,
            }),
        ),
      },
    });
    await expect(runDtakoReimportTool.execute(e, baseArgs)).rejects.toThrow(/uncertain.*true/);
  });

  // Refs #633-24
  describe("unko_no の説明 (reset_timecard で意味が変わる、旧説明の訂正)", () => {
    it("**説明が reset_timecard=false/true で場合分けされている**", () => {
      expect(runDtakoReimportTool.description).toContain("reset_timecard=false");
      expect(runDtakoReimportTool.description).toContain("reset_timecard=true");
      expect(runDtakoReimportTool.description).toContain("歯止めと監査ラベル");
    });

    it("**説明で2マンが22桁1本で両方入ることが読める (…1/…2 を2回呼ぶ必要が無い)**", () => {
      expect(runDtakoReimportTool.description).toContain("operations_count: 2");
      expect(runDtakoReimportTool.description).toContain("2回に分けて");
    });
  });

  describe("items (バッチ, Refs #633-24)", () => {
    const itemA = { ope_no_22: OPE_NO_22, start_ope: START_OPE, unko_no: UNKO_NO_23 };
    const itemB = { ope_no_22: OPE_NO_22_B, start_ope: START_OPE_B, unko_no: UNKO_NO_23_B };

    it("**説明で上限件数・items にも unko_no が必須なことが読める**", () => {
      expect(runDtakoReimportTool.description).toContain("items");
      expect(runDtakoReimportTool.description).toContain(String(CRON_BATCH_MAX_ITEMS));
    });

    it("単体フィールドと items のどちらも無いと拒否する", () => {
      expect(runDtakoReimportTool.inputSchema.safeParse({}).success).toBe(false);
    });

    it("items だけでも通る (単体フィールド省略可)", () => {
      expect(runDtakoReimportTool.inputSchema.safeParse({ items: [itemA] }).success).toBe(true);
    });

    it("items の要素にも unko_no が必須 (無いと拒否、reimport と alc-upload の違い)", () => {
      const { unko_no: _unused, ...withoutUnkoNo } = itemA;
      expect(runDtakoReimportTool.inputSchema.safeParse({ items: [withoutUnkoNo] }).success).toBe(false);
    });

    it("items の要素の unko_no も 23 桁のみ通す", () => {
      expect(
        runDtakoReimportTool.inputSchema.safeParse({ items: [{ ...itemA, unko_no: itemA.unko_no.slice(1) }] })
          .success,
      ).toBe(false);
    });

    it(`items は最大 ${CRON_BATCH_MAX_ITEMS} 件まで`, () => {
      const items = Array.from({ length: CRON_BATCH_MAX_ITEMS }, () => itemA);
      expect(runDtakoReimportTool.inputSchema.safeParse({ items }).success).toBe(true);
      expect(runDtakoReimportTool.inputSchema.safeParse({ items: [...items, itemA] }).success).toBe(false);
    });

    it("items を渡すと {comp_id, items:[{ope_no,start_ope,unko_no,reset_timecard}]} 形式で relay へ送る", async () => {
      const e = env();
      await runDtakoReimportTool.execute(e, {
        comp_id: "0100",
        items: [itemA, { ...itemB, reset_timecard: true }],
      });
      const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(body).toEqual({
        comp_id: "0100",
        items: [
          { ope_no: OPE_NO_22, start_ope: START_OPE, unko_no: UNKO_NO_23, reset_timecard: false },
          { ope_no: OPE_NO_22_B, start_ope: START_OPE_B, unko_no: UNKO_NO_23_B, reset_timecard: true },
        ],
      });
    });

    it("items を渡すと単体形式のフィールドは無視される", async () => {
      const e = env();
      await runDtakoReimportTool.execute(e, { ...baseArgs, items: [itemB] });
      const body = JSON.parse((relayOf(e).fetch.mock.calls[0]![1] as RequestInit).body as string);
      expect(body.items).toEqual([
        { ope_no: OPE_NO_22_B, start_ope: START_OPE_B, unko_no: UNKO_NO_23_B, reset_timecard: false },
      ]);
      expect(body.ope_no).toBeUndefined();
    });

    it("バッチ応答 (results[]/truncated/remaining) もそのまま返す", async () => {
      const payload = {
        ok: true,
        comp_id: "0100",
        results: [{ ok: true, result: { unko_no: UNKO_NO_23, bytes: 100 } }],
        success_count: 1,
        failure_count: 0,
        truncated: false,
        remaining: 0,
        theearth_logins: 1,
        theearth_kicked: false,
      };
      const e = env({
        SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(payload))) },
      });
      const got = await runDtakoReimportTool.execute(e, { items: [itemA] });
      expect(got).toEqual(payload);
    });
  });
});
