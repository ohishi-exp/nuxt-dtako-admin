import { describe, it, expect, vi } from "vitest";

import { postScrapeHistory } from "../src/scrape-dispatch";
import type { AlcTenantDataInput } from "../src/alc-tenant-rpc";
import {
  MAX_HISTORY_DATES,
  MAX_HISTORY_MESSAGE,
  SCRAPE_HISTORY_MARKERS,
  buildScrapeHistoryEntries,
  expandScrapeDateRange,
  markHistoryMessage,
  readScrapeHistorySource,
  recordScrapeHistoryLoud,
  resolveHistoryTenantId,
  truncateHistoryMessage,
  type ScrapeHistoryEntry,
} from "../src/scrape-history-record";

describe("expandScrapeDateRange", () => {
  it("1 日 (日次 cron / run_dtako_scrape の実際の呼び方) は 1 件", () => {
    expect(expandScrapeDateRange("2026-08-25", "2026-08-25")).toEqual({
      dates: ["2026-08-25"],
      dropped: 0,
    });
  });

  it("複数日は両端を含めて 1 日ずつ (月またぎも)", () => {
    expect(expandScrapeDateRange("2026-07-30", "2026-08-02")).toEqual({
      dates: ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02"],
      dropped: 0,
    });
  });

  it("上限を超えたら切るが、切った日数を dropped で返す (黙って切らない)", () => {
    const got = expandScrapeDateRange("2026-01-01", "2026-12-31");
    expect(got?.dates).toHaveLength(MAX_HISTORY_DATES);
    expect(got?.dates[0]).toBe("2026-01-01");
    expect(got?.dropped).toBe(365 - MAX_HISTORY_DATES);
  });

  it("日付として読めない範囲は null (空配列と区別する)", () => {
    expect(expandScrapeDateRange("garbage", "2026-08-25")).toBeNull();
    expect(expandScrapeDateRange("2026-08-25", "garbage")).toBeNull();
  });

  it("正規表現は通るが実在しない日も null", () => {
    expect(expandScrapeDateRange("2026-02-30", "2026-03-01")).toBeNull();
    expect(expandScrapeDateRange("2026-01-01", "2026-13-01")).toBeNull();
  });

  it("逆順は null", () => {
    expect(expandScrapeDateRange("2026-08-25", "2026-08-24")).toBeNull();
  });
});

describe("truncateHistoryMessage", () => {
  it("上限以下はそのまま", () => {
    expect(truncateHistoryMessage("短い")).toBe("短い");
    const exact = "x".repeat(MAX_HISTORY_MESSAGE);
    expect(truncateHistoryMessage(exact)).toBe(exact);
  });

  it("超えたら切って、切ったと分かる形にする", () => {
    const got = truncateHistoryMessage("x".repeat(MAX_HISTORY_MESSAGE + 100));
    expect(got).toHaveLength(MAX_HISTORY_MESSAGE);
    expect(got.endsWith("…")).toBe(true);
  });
});

describe("markHistoryMessage / readScrapeHistorySource", () => {
  it("印を付けて、また読める (往復)", () => {
    const cron = markHistoryMessage("cron", "取り込み成功");
    expect(cron).toBe("[無人] 取り込み成功");
    expect(readScrapeHistorySource(cron)).toBe("cron");

    const browser = markHistoryMessage("browser", "取り込み成功");
    expect(browser).toBe("[画面] 取り込み成功");
    expect(readScrapeHistorySource(browser)).toBe("browser");
  });

  it("印を付けた後も上限で切る", () => {
    const got = markHistoryMessage("cron", "x".repeat(MAX_HISTORY_MESSAGE));
    expect(got).toHaveLength(MAX_HISTORY_MESSAGE);
  });

  it("★ 印の無い行は null — 「画面から」と決めつけない", () => {
    // この PR より前に書かれた行には印が無い。browser と読むと過去を書き換えたことになる。
    expect(readScrapeHistorySource("取り込み成功")).toBeNull();
    expect(readScrapeHistorySource(undefined)).toBeNull();
    expect(readScrapeHistorySource(null)).toBeNull();
    expect(readScrapeHistorySource("")).toBeNull();
  });

  it("印は 2 つとも別の文字列 (混同できない)", () => {
    expect(SCRAPE_HISTORY_MARKERS.cron).not.toBe(SCRAPE_HISTORY_MARKERS.browser);
  });
});

describe("buildScrapeHistoryEntries", () => {
  const base = { compId: "75700192", startDate: "2026-08-25", endDate: "2026-08-25" };

  it("[陽性対照] 無人実行の成功が 1 行になり、出自が無人と読める", () => {
    const { entries, dropped } = buildScrapeHistoryEntries({ ...base, outcome: { kind: "success" } });
    expect(dropped).toBe(0);
    expect(entries).toEqual([
      {
        target_date: "2026-08-25",
        comp_id: "75700192",
        status: "success",
        message: "[無人] 取り込み成功",
      },
    ]);
    expect(readScrapeHistorySource(entries[0]!.message)).toBe("cron");
  });

  it("★ 失敗も載る (載せないと落ちた日が履歴から消える = 今と同じ穴)", () => {
    const { entries } = buildScrapeHistoryEntries({
      ...base,
      outcome: { kind: "error", message: "CSV フォームの要素 (id=rdoSelect1) が見つかりません" },
    });
    expect(entries[0]!.status).toBe("error");
    expect(entries[0]!.message).toBe(
      "[無人] CSV フォームの要素 (id=rdoSelect1) が見つかりません",
    );
  });

  it("★ split_failed の status は countSplitFailed が数える値と完全一致する", () => {
    const { entries } = buildScrapeHistoryEntries({
      ...base,
      outcome: { kind: "split_failed", splitFailed: 3 },
    });
    // scrape-dispatch.ts の countSplitFailed は status === "split_failed" で数える。
    expect(entries[0]!.status).toBe("split_failed");
    expect(entries[0]!.message).toContain("CSV 分割が 3 件失敗");
  });

  it("長すぎる失敗本文は切られる (履歴一覧が読めなくなるのを防ぐ)", () => {
    const { entries } = buildScrapeHistoryEntries({
      ...base,
      outcome: { kind: "error", message: "x".repeat(MAX_HISTORY_MESSAGE * 2) },
    });
    expect(entries[0]!.message).toHaveLength(MAX_HISTORY_MESSAGE);
  });

  it("範囲は 1 日 1 行に展開され、全行が同じ結末を持つ", () => {
    const { entries } = buildScrapeHistoryEntries({
      ...base,
      endDate: "2026-08-27",
      outcome: { kind: "success" },
    });
    expect(entries.map((e) => e.target_date)).toEqual([
      "2026-08-25",
      "2026-08-26",
      "2026-08-27",
    ]);
    expect(new Set(entries.map((e) => e.status))).toEqual(new Set(["success"]));
  });

  it("上限を超えた範囲は dropped で報告する", () => {
    const { entries, dropped } = buildScrapeHistoryEntries({
      ...base,
      endDate: "2026-12-31",
      outcome: { kind: "success" },
    });
    expect(entries).toHaveLength(MAX_HISTORY_DATES);
    expect(dropped).toBeGreaterThan(0);
  });

  it("日付が読めなければ行を作らない (嘘の target_date を残さない)", () => {
    expect(
      buildScrapeHistoryEntries({ ...base, startDate: "garbage", outcome: { kind: "success" } }),
    ).toEqual({ entries: [], dropped: 0 });
  });

  it("source を明示すれば画面側からも使える (既定は無人)", () => {
    const { entries } = buildScrapeHistoryEntries({
      ...base,
      outcome: { kind: "success" },
      source: "browser",
    });
    expect(readScrapeHistorySource(entries[0]!.message)).toBe("browser");
  });
});

describe("recordScrapeHistoryLoud", () => {
  const entries: ScrapeHistoryEntry[] = [
    { target_date: "2026-08-25", comp_id: "75700192", status: "success", message: "[無人] 取り込み成功" },
    { target_date: "2026-08-26", comp_id: "75700192", status: "success", message: "[無人] 取り込み成功" },
  ];

  it("[陽性対照] 全部書けたら saved に数え、何も鳴らさない", async () => {
    const send = vi.fn(async () => {});
    const log = vi.fn();
    const report = await recordScrapeHistoryLoud(entries, send, log);
    expect(report).toEqual({ attempted: 2, saved: 2, failed: [] });
    expect(send).toHaveBeenCalledTimes(2);
    expect(log).not.toHaveBeenCalled();
  });

  it("★★ 1 行が落ちても throw せず、残りを最後まで書く (取り込みを巻き添えにしない)", async () => {
    const send = vi.fn(async (e: ScrapeHistoryEntry) => {
      if (e.target_date === "2026-08-25") throw new Error("alc scraper history failed (403)");
    });
    const log = vi.fn();

    // ★ ここが本題 — reject したら runCronDtakoScrape の catch に落ち、
    //   取り込みが成功しているのに state: "failed" で上書きされてしまう。
    const report = await recordScrapeHistoryLoud(entries, send, log);

    expect(report.attempted).toBe(2);
    expect(report.saved).toBe(1); // 落ちた 1 行の後も止まらず書いている
    expect(report.failed).toEqual([
      { target_date: "2026-08-25", error: "alc scraper history failed (403)" },
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("★ 落ちたら loud に鳴らす (画面側の握り潰しと同じことをしない)", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    const log = vi.fn();
    await recordScrapeHistoryLoud(entries, send, log);

    expect(log).toHaveBeenCalledTimes(2);
    const line = JSON.parse(log.mock.calls[0]![0] as string);
    expect(line).toEqual({
      scrape_history: "save_failed",
      comp_id: "75700192",
      target_date: "2026-08-25",
      error: "boom",
    });
  });

  it("全部落ちても throw しない (rejects しないことを直接示す)", async () => {
    const send = vi.fn(async () => {
      throw new Error("boom");
    });
    await expect(recordScrapeHistoryLoud(entries, send, vi.fn())).resolves.toMatchObject({
      attempted: 2,
      saved: 0,
    });
  });

  it("Error でない値が投げられても文字列にして残す", async () => {
    const send = vi.fn(async () => {
      throw "文字列で投げられた";
    });
    const log = vi.fn();
    const report = await recordScrapeHistoryLoud(entries.slice(0, 1), send, log);
    expect(report.failed).toEqual([
      { target_date: "2026-08-25", error: "文字列で投げられた" },
    ]);
  });

  it("行が無ければ何もしない", async () => {
    const send = vi.fn(async () => {});
    const log = vi.fn();
    const report = await recordScrapeHistoryLoud([], send, log);
    expect(report).toEqual({ attempted: 0, saved: 0, failed: [] });
    expect(send).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

/**
 * ★ #931 の本体。**書き先の tenant は「スクレイプ対象の comp」ではなく
 * 「読み手が見る comp (`KINTAI_COMP_ID`)」から引く。**
 *
 * 2 社が**別々の tenant**を持つ `dtako_accounts` を使う — 同じ tenant にすると
 * 直す前のコードでも素通りしてしまい、陰性対照にならない。
 */
describe("resolveHistoryTenantId (Refs #931)", () => {
  const KINTAI_COMP = "27324455";
  const OTHER_COMP = "75700192";
  const KINTAI_TENANT = "tenant-of-27324455";
  const OTHER_TENANT = "tenant-of-75700192";
  const ACCOUNTS = [
    { comp_id: KINTAI_COMP, tenant_id: KINTAI_TENANT, user_name: "u", user_pass: "p" },
    { comp_id: OTHER_COMP, tenant_id: OTHER_TENANT, user_name: "u", user_pass: "p" },
  ];

  it("★ KINTAI_COMP_ID の tenant を返す — スクレイプ対象の comp の tenant ではない", () => {
    const got = resolveHistoryTenantId(ACCOUNTS, KINTAI_COMP);
    expect(got).toBe(KINTAI_TENANT);
    // 直す前は account.tenant_id (= OTHER_TENANT) が渡っていた
    expect(got).not.toBe(OTHER_TENANT);
  });

  it("前後の空白は落とす", () => {
    expect(resolveHistoryTenantId(ACCOUNTS, `  ${KINTAI_COMP}  `)).toBe(KINTAI_TENANT);
  });

  it("★ 引けなければ null (呼び出し側が no_tenant で鳴らす) — 両側を通す", () => {
    expect(resolveHistoryTenantId(ACCOUNTS, undefined)).toBeNull(); // staging (未設定)
    expect(resolveHistoryTenantId(ACCOUNTS, null)).toBeNull();
    expect(resolveHistoryTenantId(ACCOUNTS, "")).toBeNull();
    expect(resolveHistoryTenantId(ACCOUNTS, "   ")).toBeNull();
    expect(resolveHistoryTenantId(ACCOUNTS, "99999999")).toBeNull(); // accounts に無い
    expect(resolveHistoryTenantId(null, KINTAI_COMP)).toBeNull(); // KV が壊れている
  });
});

describe("★ 陰性対照: 別会社の cron 履歴が読み手と同じ tenant へ送られる (Refs #931)", () => {
  const KINTAI_COMP = "27324455";
  const OTHER_COMP = "75700192";
  const KINTAI_TENANT = "tenant-of-27324455";
  const OTHER_TENANT = "tenant-of-75700192";
  const ACCOUNTS = [
    { comp_id: KINTAI_COMP, tenant_id: KINTAI_TENANT },
    { comp_id: OTHER_COMP, tenant_id: OTHER_TENANT },
  ];

  it("RPC に渡る tenantId の実値が KINTAI 側で、行の comp_id は別会社のまま", async () => {
    // 「別会社 (75700192) を無人スクレイプした」状況をそのまま組む。
    const { entries } = buildScrapeHistoryEntries({
      compId: OTHER_COMP,
      startDate: "2026-08-26",
      endDate: "2026-08-26",
      outcome: { kind: "success" },
    });
    const tenantId = resolveHistoryTenantId(ACCOUNTS, KINTAI_COMP);
    expect(tenantId).not.toBeNull();

    const calls: AlcTenantDataInput[] = [];
    const rpc = {
      forwardAlcTenantData: async (input: AlcTenantDataInput) => {
        calls.push(input);
        return { status: 204, body: "", contentType: null };
      },
    };
    const report = await recordScrapeHistoryLoud(
      entries,
      (entry) => postScrapeHistory(entry, tenantId!, rpc),
      () => {},
    );

    expect(report).toEqual({ attempted: 1, saved: 1, failed: [] });
    // ★ ここが陰性対照 — 直す前は OTHER_TENANT が渡っており、
    //   読み手 (KINTAI_TENANT 固定) からは永久に見えなかった。
    expect(calls[0]!.tenantId).toBe(KINTAI_TENANT);
    expect(calls[0]!.tenantId).not.toBe(OTHER_TENANT);
    // 会社の区別は行の comp_id 列が持つ (情報は失われない)
    expect(JSON.parse(calls[0]!.body!).comp_id).toBe(OTHER_COMP);
    expect(JSON.parse(calls[0]!.body!).message).toBe("[無人] 取り込み成功");
  });
});
