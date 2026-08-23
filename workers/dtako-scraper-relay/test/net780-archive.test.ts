import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NET780_DOWNLOAD_MAX_ATTEMPTS,
  describeNet780NotFound,
  retryNet780Download,
  NET780_ARCHIVE_NARROW_WINDOW_DAYS,
  NET780_ARCHIVE_WINDOW_DAYS,
  addDaysIso,
  buildNet780ArchiveSearchParams,
  deriveNet780ArchiveSearchKey,
  isNet780CatalogRowUsable,
  net780ArchiveSearchPlan,
  net780DownloadTargetFromRow,
  parseNet780ArchiveRequest,
  pickNet780RowForOperation,
  isNet780SearchCapped,
  summarizeNet780ArchiveBatch,
  type Net780ArchiveItem,
  type Net780ArchiveResult,
} from "../src/net780-archive";
import { validateNet780SearchParams, type Net780Row } from "../src/theearth-net780-client";
import { runBatchSequential } from "../src/cron-batch";
import { VenusSessionExpiredError } from "../src/theearth-venus-client";
import { TheearthClientError } from "../src/theearth-client";

// 運行NO = 開始日時12桁 + 車輌CD10桁 (theearth-venus skill の実測例 `2607041256390000006572` と同型)
const OPE_A = "2607060931000000001109";
const START_A = "2026/07/06 9:31:00";
const OPE_B = "2607011200000000001109";
const START_B = "2026/07/01 12:00:00";

function row(over: Partial<Net780Row> & { operationNo: string }): Net780Row {
  return {
    startDateTime: "2026/07/06 9:31:00",
    operationDate: "26/07/06",
    vehicleName: "帯広100あ1109",
    branchName: null,
    driverCd1: "1412",
    driverName1: "中村",
    driverName2: null,
    cityName: null,
    ...over,
  };
}

describe("parseNet780ArchiveRequest", () => {
  it("comp_id と items (配列) が揃えば items を返す", () => {
    const parsed = parseNet780ArchiveRequest({
      comp_id: "0100",
      items: [
        { ope_no: OPE_A, start_ope: START_A },
        { ope_no: OPE_B, start_ope: START_B },
      ],
    });
    expect(parsed).toEqual({
      compId: "0100",
      items: [
        { opeNo: OPE_A, startOpe: START_A },
        { opeNo: OPE_B, startOpe: START_B },
      ],
    });
  });

  it("comp_id が無い / 文字列でない と 'comp_id / items が必要です'", () => {
    expect(parseNet780ArchiveRequest({ items: [{ ope_no: OPE_A, start_ope: START_A }] })).toEqual({
      error: "comp_id / items が必要です",
    });
    expect(parseNet780ArchiveRequest({ comp_id: 100, items: [] })).toEqual({ error: "comp_id / items が必要です" });
  });

  it("items が配列でない (欠落 / object) と 'comp_id / items が必要です' — 単体形式は受けない", () => {
    expect(parseNet780ArchiveRequest({ comp_id: "0100" })).toEqual({ error: "comp_id / items が必要です" });
    expect(parseNet780ArchiveRequest({ comp_id: "0100", items: { ope_no: OPE_A, start_ope: START_A } })).toEqual({
      error: "comp_id / items が必要です",
    });
  });

  it("items が空配列なら 1 件以上を要求する (ログインだけして何もしない呼び出しを作らない)", () => {
    expect(parseNet780ArchiveRequest({ comp_id: "0100", items: [] })).toEqual({ error: "items は 1 件以上必要です" });
  });

  it("ope_no は 22 桁の数値でなければ index 付きで拒否する (23桁 / 欠落 / 非文字列)", () => {
    expect(parseNet780ArchiveRequest({ comp_id: "0100", items: [{ ope_no: `${OPE_A}1`, start_ope: START_A }] })).toEqual(
      { error: `items[0]: ope_no は22桁の数値で指定してください (受領値: ${OPE_A}1)` },
    );
    expect(
      parseNet780ArchiveRequest({
        comp_id: "0100",
        items: [{ ope_no: OPE_A, start_ope: START_A }, { start_ope: START_B }],
      }),
    ).toEqual({ error: "items[1]: ope_no は22桁の数値で指定してください (受領値: )" });
    expect(parseNet780ArchiveRequest({ comp_id: "0100", items: [{ ope_no: 2607060931000000001109, start_ope: START_A }] })).toEqual(
      { error: "items[0]: ope_no は22桁の数値で指定してください (受領値: )" },
    );
  });

  it("start_ope は 'YYYY/MM/DD H:mm:ss' (時は 0 埋め無しも可) でなければ拒否する", () => {
    expect(parseNet780ArchiveRequest({ comp_id: "0100", items: [{ ope_no: OPE_A, start_ope: "2026-07-06 09:31:00" }] })).toEqual(
      { error: 'items[0]: start_ope は "YYYY/MM/DD H:mm:ss" 形式で指定してください (受領値: 2026-07-06 09:31:00)' },
    );
    expect(parseNet780ArchiveRequest({ comp_id: "0100", items: [{ ope_no: OPE_A, start_ope: 123 }] })).toEqual({
      error: 'items[0]: start_ope は "YYYY/MM/DD H:mm:ss" 形式で指定してください (受領値: )',
    });
    // 0 埋めあり (`09:31:00`) も 0 埋めなし (`9:31:00`) も通る
    expect(parseNet780ArchiveRequest({ comp_id: "0100", items: [{ ope_no: OPE_A, start_ope: "2026/07/06 09:31:00" }] })).toEqual({
      compId: "0100",
      items: [{ opeNo: OPE_A, startOpe: "2026/07/06 09:31:00" }],
    });
  });

  it("items の null 要素は空オブジェクト扱いで ope_no 欠落として拒否する (例外にしない)", () => {
    expect(parseNet780ArchiveRequest({ comp_id: "0100", items: [null] })).toEqual({
      error: "items[0]: ope_no は22桁の数値で指定してください (受領値: )",
    });
  });
});

describe("deriveNet780ArchiveSearchKey", () => {
  it("運行NO の 13〜22 桁目から先頭 0 を落とした車輌CD と、start_ope の日付を返す", () => {
    expect(deriveNet780ArchiveSearchKey({ opeNo: OPE_A, startOpe: START_A })).toEqual({
      vehicleCd: "1109",
      startDate: "2026-07-06",
    });
    // theearth-venus skill の実測例: 運行NO …0000006572 の車輌CD は 6572
    expect(deriveNet780ArchiveSearchKey({ opeNo: "2607041256390000006572", startOpe: "2026/07/04 12:56:39" })).toEqual({
      vehicleCd: "6572",
      startDate: "2026-07-04",
    });
  });

  it("日付は start_ope を正とする (運行NO の先頭 12 桁ではない)", () => {
    expect(deriveNet780ArchiveSearchKey({ opeNo: OPE_A, startOpe: "2026/08/01 0:00:00" })?.startDate).toBe("2026-08-01");
  });

  it("車輌CD が 0 だけ (車輌CD 無し) / 8 桁超 なら null (検索できない)", () => {
    expect(deriveNet780ArchiveSearchKey({ opeNo: "2607060931000000000000", startOpe: START_A })).toBeNull();
    expect(deriveNet780ArchiveSearchKey({ opeNo: "2607060931000123456789", startOpe: START_A })).toBeNull();
  });

  it("導いたキーで組んだ検索条件は searchNet780 の検証を通る", () => {
    const key = deriveNet780ArchiveSearchKey({ opeNo: OPE_A, startOpe: START_A })!;
    for (const params of net780ArchiveSearchPlan(key)) {
      expect(() => validateNet780SearchParams(params)).not.toThrow();
    }
  });
});

describe("addDaysIso", () => {
  it("暦日を加算する (月末・年末またぎ・うるう日)", () => {
    expect(addDaysIso("2026-07-06", 0)).toBe("2026-07-06");
    expect(addDaysIso("2026-07-30", 2)).toBe("2026-08-01");
    expect(addDaysIso("2026-12-25", 14)).toBe("2027-01-08");
    expect(addDaysIso("2028-02-28", 1)).toBe("2028-02-29");
  });
});

describe("buildNet780ArchiveSearchParams / net780ArchiveSearchPlan", () => {
  const key = { vehicleCd: "1109", startDate: "2026-07-06" };

  it("読取日 range は [開始日, 開始日+窓] で、車輌CD は from/to 同値", () => {
    expect(buildNet780ArchiveSearchParams(key, 3)).toEqual({
      operationDateFrom: "2026-07-06",
      operationDateTo: "2026-07-09",
      vehicleCdFrom: "1109",
      vehicleCdTo: "1109",
    });
  });

  it("plan は 狭い窓 → 広い窓 の順 (親指示: 多数派を先に拾い theearth 往復と上限到達を減らす)、窓の日数は定数どおり", () => {
    const plan = net780ArchiveSearchPlan(key);
    expect(plan.map((p) => p.operationDateTo)).toEqual([
      addDaysIso(key.startDate, NET780_ARCHIVE_NARROW_WINDOW_DAYS),
      addDaysIso(key.startDate, NET780_ARCHIVE_WINDOW_DAYS),
    ]);
    expect(NET780_ARCHIVE_WINDOW_DAYS).toBeGreaterThan(NET780_ARCHIVE_NARROW_WINDOW_DAYS);
    for (const p of plan) {
      expect(p.operationDateFrom).toBe(key.startDate);
      expect(p.vehicleCdFrom).toBe("1109");
      expect(p.vehicleCdTo).toBe("1109");
    }
  });
});

describe("isNet780SearchCapped", () => {
  it("一覧が上限に達していれば true (取りこぼしの可能性)、未満なら false (全件見えている)", () => {
    expect(isNet780SearchCapped(30, 30)).toBe(true);
    expect(isNet780SearchCapped(31, 30)).toBe(true);
    expect(isNet780SearchCapped(29, 30)).toBe(false);
    expect(isNet780SearchCapped(0, 30)).toBe(false);
  });
});

describe("describeNet780NotFound", () => {
  const key = { vehicleCd: "1109", startDate: "2026-07-06" };
  const params = buildNet780ArchiveSearchParams(key, 2);

  it("上限未満なら「該当なし」と件数", () => {
    expect(describeNet780NotFound(key, params, 4, 30)).toBe(
      "読取日 2026-07-06〜2026-07-08 / 車輌CD 1109 の一覧 (4 件) に該当する運行がありません",
    );
  });

  it("上限に達していたら取りこぼしの可能性を明記する", () => {
    expect(describeNet780NotFound(key, params, 30, 30)).toBe(
      "読取日 2026-07-06〜2026-07-08 / 車輌CD 1109 の一覧が上限 30 件に達しており、取りこぼしの可能性があります (NET780 が無いとは限りません)",
    );
  });
});

describe("retryNet780Download", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("成功すれば 1 回で返す (opts 省略)", async () => {
    let calls = 0;
    const out = await retryNet780Download(async () => {
      calls += 1;
      return "zip";
    });
    expect(out).toBe("zip");
    expect(calls).toBe(1);
  });

  it("TheearthClientError は間隔 1000*n ms で maxAttempts 回まで試し、最後の例外を投げる", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await expect(
      retryNet780Download(
        async () => {
          calls += 1;
          throw new TheearthClientError(`HTTP 503 (${calls})`);
        },
        { sleep: async (ms) => void sleeps.push(ms) },
      ),
    ).rejects.toThrow(`HTTP 503 (${NET780_DOWNLOAD_MAX_ATTEMPTS})`);
    expect(calls).toBe(NET780_DOWNLOAD_MAX_ATTEMPTS);
    expect(sleeps).toEqual(Array.from({ length: NET780_DOWNLOAD_MAX_ATTEMPTS - 1 }, (_, i) => 1000 * (i + 1)));
  });

  it("途中で成功すればそこで返す", async () => {
    let calls = 0;
    const out = await retryNet780Download(
      async () => {
        calls += 1;
        if (calls < 2) throw new TheearthClientError("HTTP 503");
        return calls;
      },
      { sleep: async () => {} },
    );
    expect(out).toBe(2);
  });

  it("session 切れは再試行しない (即座に投げる)", async () => {
    let calls = 0;
    await expect(
      retryNet780Download(
        async () => {
          calls += 1;
          throw new VenusSessionExpiredError("expired");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(VenusSessionExpiredError);
    expect(calls).toBe(1);
  });

  it("theearth 由来でない例外は再試行しない", async () => {
    let calls = 0;
    await expect(
      retryNet780Download(
        async () => {
          calls += 1;
          throw new TypeError("boom");
        },
        { sleep: async () => {} },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });

  it("sleep 省略時は実時間で 1000*n ms 待つ (fake timers で確認)", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = retryNet780Download(async () => {
      calls += 1;
      if (calls < 2) throw new TheearthClientError("HTTP 503");
      return "zip";
    });
    // 1 回目失敗 → 1000ms 待ち。999ms では 2 回目はまだ走らない
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("zip");
    expect(calls).toBe(2);
  });

  it("maxAttempts を上書きできる (1 なら再試行しない、sleep 省略でも sleep は呼ばれない)", async () => {
    let calls = 0;
    await expect(
      retryNet780Download(
        async () => {
          calls += 1;
          throw new TheearthClientError("HTTP 503");
        },
        { maxAttempts: 1 },
      ),
    ).rejects.toThrow("HTTP 503");
    expect(calls).toBe(1);
  });
});

describe("pickNet780RowForOperation", () => {
  it("operationNo が一致する行を返す (他の行が先にあっても)", () => {
    const rows = [row({ operationNo: OPE_B }), row({ operationNo: OPE_A, startDateTime: "2026/07/06 9:31:00" })];
    expect(pickNet780RowForOperation(rows, OPE_A)).toBe(rows[1]);
  });

  it("無ければ null (空配列 / 不一致)", () => {
    expect(pickNet780RowForOperation([], OPE_A)).toBeNull();
    expect(pickNet780RowForOperation([row({ operationNo: OPE_B })], OPE_A)).toBeNull();
  });
});

describe("net780DownloadTargetFromRow", () => {
  it("一覧の行の値 (startDateTime 含む) をそのまま target にする", () => {
    const r = row({ operationNo: OPE_A, startDateTime: "2026/07/06 9:31:05" });
    expect(net780DownloadTargetFromRow(r)).toEqual({
      operationNo: OPE_A,
      startDateTime: "2026/07/06 9:31:05",
      vehicleName: "帯広100あ1109",
      driverCd1: "1412",
      driverName1: "中村",
      operationDate: "26/07/06",
    });
  });
});

describe("isNet780CatalogRowUsable", () => {
  it("operation_count === 1 の行だけ already 扱い (by-operation が 200 を返す条件と同じ)", () => {
    expect(isNet780CatalogRowUsable({ operation_count: 1 })).toBe(true);
    expect(isNet780CatalogRowUsable({ operation_count: 2 })).toBe(false);
    expect(isNet780CatalogRowUsable({ operation_count: null })).toBe(false);
    expect(isNet780CatalogRowUsable(null)).toBe(false);
    expect(isNet780CatalogRowUsable(undefined)).toBe(false);
  });
});

describe("summarizeNet780ArchiveBatch", () => {
  const items: Net780ArchiveItem[] = [
    { opeNo: OPE_A, startOpe: START_A },
    { opeNo: OPE_B, startOpe: START_B },
    { opeNo: "2607021200000000001109", startOpe: "2026/07/02 12:00:00" },
    { opeNo: "2607031200000000001109", startOpe: "2026/07/03 12:00:00" },
  ];

  it("archived/already を success、not_found/error を failure に数え、例外は error 行にする", async () => {
    const batch = await runBatchSequential<Net780ArchiveItem, Net780ArchiveResult>(items, async (item, i) => {
      if (i === 0) return { ope_no: item.opeNo, status: "archived", bytes: 1234 };
      if (i === 1) return { ope_no: item.opeNo, status: "already" };
      if (i === 2) return { ope_no: item.opeNo, status: "not_found", message: "一覧に無い" };
      throw new Error("R2 put failed");
    });
    const summary = summarizeNet780ArchiveBatch(items, batch);
    expect(summary).toEqual({
      results: [
        { ope_no: OPE_A, status: "archived", bytes: 1234 },
        { ope_no: OPE_B, status: "already" },
        { ope_no: items[2].opeNo, status: "not_found", message: "一覧に無い" },
        { ope_no: items[3].opeNo, status: "error", message: "R2 put failed" },
      ],
      success_count: 2,
      failure_count: 2,
      truncated: false,
      remaining: 0,
    });
  });

  it("session 切れで打ち切られたら truncated + remaining を引き継ぎ、results.length + remaining === items.length", async () => {
    const batch = await runBatchSequential<Net780ArchiveItem, Net780ArchiveResult>(items, async (item, i) => {
      if (i === 1) throw new VenusSessionExpiredError("ログイン画面が返されました");
      return { ope_no: item.opeNo, status: "archived", bytes: 10 };
    });
    const summary = summarizeNet780ArchiveBatch(items, batch);
    expect(summary.truncated).toBe(true);
    expect(summary.remaining).toBe(items.length - 2);
    expect(summary.results.length + summary.remaining).toBe(items.length);
    expect(summary.results[1]).toEqual({ ope_no: OPE_B, status: "error", message: "ログイン画面が返されました" });
    expect(summary.success_count).toBe(1);
    expect(summary.failure_count).toBe(1);
  });

  it("空のバッチは 0/0", () => {
    expect(summarizeNet780ArchiveBatch([], { results: [], truncated: false, remaining: 0 })).toEqual({
      results: [],
      success_count: 0,
      failure_count: 0,
      truncated: false,
      remaining: 0,
    });
  });
});
