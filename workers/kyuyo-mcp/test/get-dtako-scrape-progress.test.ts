import { describe, it, expect, vi } from "vitest";
import { getDtakoScrapeProgressTool } from "../src/mcp/tools";
import { FOLD_STATES } from "../../dtako-scraper-relay/src/scrape-queue";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify({ comps: [] }))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayOf = (e: Env) => e.SCRAPER_RELAY as unknown as { fetch: ReturnType<typeof vi.fn> };

describe("get_dtako_scrape_progress (ohishi-exp/rust-ichibanboshi#205 の 43)", () => {
  it("**read tool** — scope を要求しない", () => {
    expect((getDtakoScrapeProgressTool as { requiresScope?: string }).requiresScope).toBeUndefined();
  });

  it("**説明で scrape_history との違いと state の種類が読める**", () => {
    expect(getDtakoScrapeProgressTool.description).toContain("get_dtako_scrape_status とは別物");
    expect(getDtakoScrapeProgressTool.description).toContain("pending/running/done/failed");
    expect(getDtakoScrapeProgressTool.description).toContain("黙って消えない");
    expect(getDtakoScrapeProgressTool.description).toContain("comp_id ごとの instance");
  });

  // **応答に載るのに説明に無い**フィールドを潰す (Refs #958)。#945 は fold_pages /
  // fold_drivers_written を「今回の途中経過」と読んで誤診した — 説明にそう書いていな
  // かったので、読み手には気づく手段が無かった。
  it("**説明で fold_* の意味と「別の試行の値が残り得る」ことが読める** (Refs #958)", () => {
    const d = getDtakoScrapeProgressTool.description;
    // 値そのものと、「失敗ではない」区別が読めること
    expect(d).toContain("skipped_out_of_scope");
    expect(d).toContain("not_configured");
    expect(d).toContain("設定の穴");
    expect(d).toContain("fold_skip_reason");
    // 取り込みの成否と fold の成否を混ぜない (両方向)
    expect(d).toContain("fold_* は state を一切動かさない");
    // ★ 部分 spread なので、patch に含まれないフィールドは前の試行のまま残る
    expect(d).toContain("fold_* には別の試行の値が残り得る");
    expect(d).toContain("前回の試行の終端値");
    // #944 以降の入口クリアは**過去の記録には及ばない**
    expect(d).toContain("それ以前に書かれた記録には残ったまま");
  });

  // **列挙は腐る** — 状態が増えたときに説明だけが古いまま残らないよう、正 (relay の
  // FOLD_STATES) を回して 1 つでも書き漏れたら落とす。件数を数字で書き写さないのも
  // 同じ理由 (数字だけの注記は静かに腐る)。
  it("**fold_state の値を 1 つも書き漏らさない** (Refs #958)", () => {
    const d = getDtakoScrapeProgressTool.description;
    const missing = FOLD_STATES.filter((state) => !d.includes(state));
    expect(missing).toEqual([]);
    // 「9 値」と書いてあるので、正の件数が動いたらここも落ちる
    expect(d).toContain(`fold_state の ${FOLD_STATES.length} 値`);
  });

  // **#942 以前に書かれた記録が今も現存する** (Refs #959)。記録は書き換えない判断な
  // ので、読み手が「done なのに error」を正しく読めるかは説明文だけが担保する。
  it("**説明で done + pre_upload + error が混ざることが読める** (Refs #959)", () => {
    const d = getDtakoScrapeProgressTool.description;
    expect(d).toContain('state: "done" なのに phase: "pre_upload" と error を抱えた記録が混ざる');
    expect(d).toContain("#942 以前に書かれた記録");
    expect(d).toContain("どちらが真かは記録からは決まらない");
  });

  it("comp_id は任意", () => {
    expect(getDtakoScrapeProgressTool.inputSchema.safeParse({}).success).toBe(true);
    expect(getDtakoScrapeProgressTool.inputSchema.safeParse({ comp_id: "27324455" }).success).toBe(
      true,
    );
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      getDtakoScrapeProgressTool.execute(env({ SCRAPER_RELAY: undefined }), {}),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      getDtakoScrapeProgressTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), {}),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("comp_id を省略すると query 無しで relay の /kintai-relay/scrape-progress を叩く", async () => {
    const e = env();
    await getDtakoScrapeProgressTool.execute(e, {});
    const call = relayOf(e).fetch.mock.calls[0]!;
    expect(call[0]).toBe("https://relay.internal/kintai-relay/scrape-progress");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
  });

  it("comp_id を渡すと query に載り、応答をそのまま返す", async () => {
    const body = {
      comps: [
        {
          comp_id: "27324455",
          queue: [{ date: "2026-06-03", state: "done", split_failed: 0 }],
          pending: 0,
          running: 0,
          done: 1,
          failed: 0,
          max_records: 200,
        },
      ],
    };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(body))) },
    });
    const got = await getDtakoScrapeProgressTool.execute(e, { comp_id: "27324455" });
    expect(got).toEqual(body);
    expect(relayOf(e).fetch.mock.calls[0]![0]).toBe(
      "https://relay.internal/kintai-relay/scrape-progress?comp_id=27324455",
    );
  });

  it("relay の失敗と非 JSON は握り潰さない", async () => {
    const bad = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(getDtakoScrapeProgressTool.execute(bad, {})).rejects.toThrow(
      /relay: status 401: nope/,
    );
    const html = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(getDtakoScrapeProgressTool.execute(html, {})).rejects.toThrow(/parse failed/);
  });
});
