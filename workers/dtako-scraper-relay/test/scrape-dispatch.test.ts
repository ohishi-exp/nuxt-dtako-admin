import { describe, it, expect, vi } from "vitest";
import {
  countSplitFailed,
  dateRangeOf,
  dispatchScrapeDates,
  fetchScrapeHistory,
  postScrapeHistory,
  fetchUnsplit,
  isValidDate,
  MAX_SCRAPE_DATES,
  planScrapeDispatch,
  scrapeJobKey,
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
  it("★ device-data-proxy に Bearer で引く (alc-internal-proxy では 403 だった、Refs #933)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([{ target_date: "2026-06-03", status: "success" }]), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const out = await fetchScrapeHistory({ accessToken: "jwt-abc", limit: 20 }, fetchImpl);
    expect(out).toEqual([{ target_date: "2026-06-03", status: "success" }]);
    expect(calls[0]!.url).toBe(
      "https://auth-worker.internal/device-data-proxy/api/scraper/history?limit=20",
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-abc");
    // tenant は auth-worker が device record から注入する。送ると詐称できると誤読させる。
    expect(headers["X-Tenant-ID"]).toBeUndefined();
    expect(headers["X-Alc-Proxy-Secret"]).toBeUndefined();
  });

  it("★ もう alc-internal-proxy は叩かない (403 の経路へ戻らないことを固定する)", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;
    await fetchScrapeHistory({ accessToken: "jwt", limit: 1 }, fetchImpl);
    expect(calls[0]).not.toContain("/alc-internal-proxy/");
  });

  it("非 2xx / 非 JSON は握り潰さず原因を throw する", async () => {
    const bad = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch;
    await expect(fetchScrapeHistory({ accessToken: "jwt", limit: 1 }, bad)).rejects.toThrow(
      "alc scraper history failed (502)",
    );

    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(fetchScrapeHistory({ accessToken: "jwt", limit: 1 }, html)).rejects.toThrow(
      "parse failed",
    );
  });
});

describe("postScrapeHistory", () => {
  it("★ 無人実行の 1 行を書く — 同じ path なので読みと同じ allowlist で通る (Refs #931)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const entry = { target_date: "2026-08-25", comp_id: "75700192", status: "success" };
    await postScrapeHistory(entry, "jwt-abc", fetchImpl);

    expect(calls[0]!.url).toBe(
      "https://auth-worker.internal/device-data-proxy/api/scraper/history",
    );
    expect(calls[0]!.init?.method).toBe("POST");
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-abc");
    expect(JSON.parse(calls[0]!.init?.body as string)).toEqual(entry);
  });

  it("非 2xx は status と本文抜粋つきで throw する (呼び手が loud に鳴らせるように)", async () => {
    const bad = (async () => new Response('{"error":"forbidden"}', { status: 403 })) as unknown as typeof fetch;
    await expect(postScrapeHistory({}, "jwt", bad)).rejects.toThrow(
      /alc scraper history save failed \(403\).*forbidden/,
    );
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

describe("fetchUnsplit", () => {
  it("**unsplit / unsplit_total だけを取り出す** (items は 1,100 件超あるので捨てる)", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({
          period: {},
          items: Array.from({ length: 1130 }, (_, i) => ({ unko_no: String(i) })),
          unsplit: [{ unko_no: "U1", driver_cd: "1107", reading_date: "2026-06-11" }],
          unsplit_total: 3,
          warnings: [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const got = await fetchUnsplit(
      { accessToken: "jwt-abc", dateFrom: "2026-06-03", dateTo: "2026-07-01" },
      fetchImpl,
    );
    expect(got.unsplit_total).toBe(3);
    expect(got.unsplit).toHaveLength(1);
    expect(got).not.toHaveProperty("items");
    expect(calls[0]!.url).toBe(
      "https://auth-worker.internal/device-data-proxy/api/dtako/events/etags?date_from=2026-06-03&date_to=2026-07-01",
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    // Refs #933: 旧経路 (alc-internal-proxy) は tenant 経路なので 403 だった。
    expect(headers.Authorization).toBe("Bearer jwt-abc");
    expect(headers["X-Alc-Proxy-Secret"]).toBeUndefined();
    expect(headers["X-Tenant-ID"]).toBeUndefined();
  });

  it("欠けたフィールドは 0 / 空に倒すが、**上流の失敗は握り潰さない**", async () => {
    const empty = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    const got = await fetchUnsplit(
      { accessToken: "jwt", dateFrom: "2026-06-03", dateTo: "2026-06-04" },
      empty,
    );
    expect(got).toEqual({ unsplit: [], unsplit_total: 0 });

    const nulled = (async () => new Response("null", { status: 200 })) as unknown as typeof fetch;
    expect(
      await fetchUnsplit(
        { accessToken: "jwt", dateFrom: "2026-06-03", dateTo: "2026-06-04" },
        nulled,
      ),
    ).toEqual({ unsplit: [], unsplit_total: 0 });

    // 期間の上限 (alc 側 40 日) 超過はここに落ちる
    const bad = (async () =>
      new Response("range too wide", { status: 400 })) as unknown as typeof fetch;
    await expect(
      fetchUnsplit(
        { accessToken: "jwt", dateFrom: "2026-01-01", dateTo: "2026-12-31" },
        bad,
      ),
    ).rejects.toThrow("alc etags failed (400): range too wide");

    const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchUnsplit(
        { accessToken: "jwt", dateFrom: "2026-06-03", dateTo: "2026-06-04" },
        html,
      ),
    ).rejects.toThrow("alc etags parse failed");
  });
});

describe("dateRangeOf", () => {
  it("最小と最大を返す (飛びがあっても両端)", () => {
    expect(dateRangeOf(["2026-06-11", "2026-06-03", "2026-07-01"])).toEqual({
      from: "2026-06-03",
      to: "2026-07-01",
    });
  });

  it("読めない日付だけ / 空なら null (0 に化かさない)", () => {
    expect(dateRangeOf([])).toBeNull();
    expect(dateRangeOf(["nope", "2026-02-30"])).toBeNull();
  });
});

describe("scrapeJobKey", () => {
  it("同じ日付なら 1 日ぶんとして返す", () => {
    expect(scrapeJobKey("2026-06-03", "2026-06-03")).toBe("2026-06-03");
  });

  it("範囲なら両端を区別できる形で返す", () => {
    expect(scrapeJobKey("2026-06-03", "2026-06-05")).toBe("2026-06-03..2026-06-05");
  });
});
