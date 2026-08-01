import { describe, it, expect, vi } from "vitest";
import {
  countSplitFailed,
  dispatchScrapeDates,
  fetchScrapeHistory,
  isValidDate,
  MAX_SCRAPE_DATES,
  planScrapeDispatch,
} from "../src/scrape-dispatch";

describe("planScrapeDispatch", () => {
  it("昇順・重複無しに畳む", () => {
    const plan = planScrapeDispatch(["2026-06-05", "2026-06-03", "2026-06-05"]);
    expect(plan.dates).toEqual(["2026-06-03", "2026-06-05"]);
    expect(plan.truncated).toEqual([]);
    expect(plan.invalid).toEqual([]);
  });

  it("**上限を超えたぶんは黙って切らず truncated に残す**", () => {
    const many = Array.from({ length: MAX_SCRAPE_DATES + 3 }, (_, i) =>
      `2026-06-${String(i + 1).padStart(2, "0")}`,
    );
    const plan = planScrapeDispatch(many);
    expect(plan.dates).toHaveLength(MAX_SCRAPE_DATES);
    expect(plan.truncated).toHaveLength(3);
    // 切ったぶんを足せば元に戻る (取りこぼしが無い)
    expect([...plan.dates, ...plan.truncated]).toEqual(many);
  });

  it("読めない日付は invalid に原文で残す (黙って捨てない)", () => {
    const plan = planScrapeDispatch(["2026-06-03", "2026-6-3", "2026-02-30", "", 20260603, null]);
    expect(plan.dates).toEqual(["2026-06-03"]);
    expect(plan.invalid).toEqual(["2026-6-3", "2026-02-30", "", "20260603", "null"]);
  });
});

describe("isValidDate", () => {
  it("実在しない日付を弾く", () => {
    expect(isValidDate("2026-06-03")).toBe(true);
    expect(isValidDate("2026-02-30")).toBe(false);
    expect(isValidDate("2026-13-01")).toBe(false);
    expect(isValidDate("nope")).toBe(false);
    expect(isValidDate(42)).toBe(false);
  });
});

describe("dispatchScrapeDates", () => {
  it("**1 日 1 回**で /cron/dtako へ配る (範囲に広げない)", async () => {
    const calls: { key: string; path: string; body: unknown }[] = [];
    const out = await dispatchScrapeDates("0100", ["2026-06-03", "2026-06-11"], async (key, path, body) => {
      calls.push({ key, path, body });
      return { ok: true, status: 202, text: '{"accepted":true}' };
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.key).toBe("scraper-comp-0100");
    expect(calls[0]!.path).toBe("/cron/dtako");
    // 連続していない日を範囲で括らない (要らない日の has_kudgivt を落とさない)
    expect(calls[0]!.body).toEqual({
      comp_id: "0100",
      start_date: "2026-06-03",
      end_date: "2026-06-03",
    });
    expect(calls[1]!.body).toEqual({
      comp_id: "0100",
      start_date: "2026-06-11",
      end_date: "2026-06-11",
    });
    expect(out.every((d) => d.accepted)).toBe(true);
  });

  it("**1 日が落ちても他は走る**。落ちた日は accepted: false で返る", async () => {
    const out = await dispatchScrapeDates("0100", ["2026-06-03", "2026-06-04"], async (_k, _p, body) => {
      if ((body as { start_date: string }).start_date === "2026-06-03") {
        throw new Error("DO unreachable");
      }
      return { ok: true, status: 202, text: "ok" };
    });
    expect(out[0]).toEqual({
      date: "2026-06-03",
      accepted: false,
      status: 0,
      detail: "DO unreachable",
    });
    expect(out[1]!.accepted).toBe(true);
  });

  it("非 Error の throw も原因を落とさない", async () => {
    const out = await dispatchScrapeDates("0100", ["2026-06-03"], async () => {
      throw "boom";
    });
    expect(out[0]!.detail).toBe("boom");
  });

  it("非 2xx は accepted: false", async () => {
    const out = await dispatchScrapeDates("0100", ["2026-06-03"], async () => ({
      ok: false,
      status: 500,
      text: "comp_id=0100 が DTAKO_ACCOUNTS に見つかりません",
    }));
    expect(out[0]!.accepted).toBe(false);
    expect(out[0]!.status).toBe(500);
    expect(out[0]!.detail).toContain("DTAKO_ACCOUNTS");
  });
});

describe("fetchScrapeHistory", () => {
  it("alc-internal-proxy に consumer proof と tenant を付けて引く", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([{ target_date: "2026-06-03", status: "success" }]), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const out = await fetchScrapeHistory(
      { sharedSecret: "s3cret", tenantId: "11111111-2222-3333-4444-555555555555", limit: 20 },
      fetchImpl,
    );
    expect(out).toEqual([{ target_date: "2026-06-03", status: "success" }]);
    expect(calls[0]!.url).toBe(
      "https://auth-worker.internal/alc-internal-proxy/api/scraper/history?limit=20",
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["X-Alc-Proxy-Secret"]).toBe("s3cret");
    expect(headers["X-Tenant-ID"]).toBe("11111111-2222-3333-4444-555555555555");
  });

  it("非 2xx / 非 JSON は握り潰さず原因を throw する", async () => {
    const bad = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    await expect(
      fetchScrapeHistory({ sharedSecret: "s", tenantId: "t", limit: 1 }, bad),
    ).rejects.toThrow("alc scraper history failed (502)");

    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchScrapeHistory({ sharedSecret: "s", tenantId: "t", limit: 1 }, html),
    ).rejects.toThrow("parse failed");
  });
});

describe("countSplitFailed", () => {
  it("status が split_failed の行だけ数える", () => {
    expect(
      countSplitFailed([
        { status: "success" },
        { status: "split_failed" },
        { status: "split_failed" },
        null,
        "nope",
      ]),
    ).toBe(2);
  });

  it("配列でなければ 0 (推測しない)", () => {
    expect(countSplitFailed(null)).toBe(0);
    expect(countSplitFailed({ history: [] })).toBe(0);
  });
});
