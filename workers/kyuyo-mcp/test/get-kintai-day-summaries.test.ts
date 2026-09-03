import { describe, it, expect, vi } from "vitest";
import { getKintaiDaySummariesTool } from "../src/mcp/tools";
import type { Env } from "../src/env";

const SECRET = "internal-shared-secret";

/** 受け側が返す形 — キーは `乗務員CD|暦日|開始時刻`、値は shift_source + 分数。 */
const SAMPLE = {
  month: "2026-06",
  rows: 1,
  summaries: {
    "1130|2026-06-01|2026-06-01 08:00:00": {
      shift_source: "punch",
      restraint_minutes: 720,
      working_minutes: 600,
      night_minutes: 0,
    },
  },
};

function env(over: Partial<Record<string, unknown>> = {}) {
  return {
    SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(SAMPLE))) },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayFetch = (e: Env) => (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch;

describe("get_kintai_day_summaries (ohishi-exp/rust-ichibanboshi#205 の 23)", () => {
  it("**read tool。** scope を要求しない (既存の read 系と揃える)", () => {
    expect(
      (getKintaiDaySummariesTool as { requiresScope?: string }).requiresScope,
    ).toBeUndefined();
  });

  it("**書き込みの引数を持たない** — apply 相当が無い", () => {
    const keys = Object.keys(getKintaiDaySummariesTool.inputSchema.shape);
    expect(keys.sort()).toEqual(["driver", "month"]);
  });

  it("month が YYYY-MM でなければ relay を叩かない", async () => {
    const e = env();
    await expect(getKintaiDaySummariesTool.execute(e, { month: "2026-7" })).rejects.toThrow(
      /YYYY-MM/,
    );
    expect(relayFetch(e)).not.toHaveBeenCalled();
  });

  it("binding / secret が無ければ fail-closed", async () => {
    await expect(
      getKintaiDaySummariesTool.execute(env({ SCRAPER_RELAY: undefined }), { month: "2026-06" }),
    ).rejects.toThrow(/SCRAPER_RELAY/);
    await expect(
      getKintaiDaySummariesTool.execute(env({ INTERNAL_SHARED_SECRET: "" }), {
        month: "2026-06",
      }),
    ).rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("proof を付けて relay の /kintai-relay/day-summaries を GET し、応答をそのまま返す", async () => {
    const e = env();
    const got = await getKintaiDaySummariesTool.execute(e, {
      month: "2026-06",
      driver: "1130",
    });
    // **reshape しない** — 突合スクリプトが基準 JSON とそのまま比較できることが目的
    expect(got).toEqual(SAMPLE);

    const call = relayFetch(e).mock.calls[0]!;
    const url = new URL(call[0] as string);
    expect(url.pathname).toBe("/kintai-relay/day-summaries");
    expect(url.searchParams.get("month")).toBe("2026-06");
    expect(url.searchParams.get("driver")).toBe("1130");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
    // **GET で body も無い** — この経路は 1 行も書けない。
    // #1102 で callRelay に寄せるまでは method 未指定 (fetch 既定の GET) だった。
    // 送出は同じだが、**「書けない」の担保は method が空欄なことではなく GET であること**
    // なので、明示された値でそのまま検査する。
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("driver を省いたら query に出さない (`driver=` は受け側が 400 にする)", async () => {
    const e = env();
    await getKintaiDaySummariesTool.execute(e, { month: "2026-06" });
    const url = new URL(relayFetch(e).mock.calls[0]![0] as string);
    expect(url.searchParams.has("driver")).toBe(false);
  });

  it("0 件の月もそのまま通す (空と「口が無い」を混ぜない)", async () => {
    const empty = { month: "2026-06", rows: 0, summaries: {} };
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response(JSON.stringify(empty))) },
    });
    expect(await getKintaiDaySummariesTool.execute(e, { month: "2026-06" })).toEqual(empty);
  });

  it("relay の失敗は本文の先頭を添えて上げる", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 401 })) },
    });
    await expect(getKintaiDaySummariesTool.execute(e, { month: "2026-06" })).rejects.toThrow(
      /relay: status 401: nope/,
    );
  });

  it("JSON でない応答は parse failed で落とす", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>", { status: 200 })) },
    });
    await expect(getKintaiDaySummariesTool.execute(e, { month: "2026-06" })).rejects.toThrow(
      /parse failed/,
    );
  });
});
