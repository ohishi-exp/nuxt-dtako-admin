import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getDtakoScrapeStatusTool,
  getKosokuEventsTool,
  getIchibanCostsTool,
  getIchibanSalesTool,
  getRestDiffTool,
  runDtakoScrapeTool,
  getTimecardDiffTool,
  listCompaniesTool,
  listMonthsTool,
  getWageReportTool,
  getRestraintSummaryTool,
  ALL_TOOLS,
} from "../../src/mcp/tools";
import { createMockR2, type MockR2Entry } from "../helpers/mock-r2";
import type { Env } from "../../src/env";
import type { RestraintDriverSummary, RestraintSummaryDay } from "../../../dtako-scraper-relay/src/theearth-restraint-client";

function day(d: number, over: Partial<RestraintSummaryDay> = {}): RestraintSummaryDay {
  return {
    day: d,
    isRestDay: false,
    restraintMinutes: null,
    workingMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    overtimeNightMinutes: 0,
    ...over,
  };
}

function summary(over: Partial<RestraintDriverSummary> = {}): RestraintDriverSummary {
  return {
    driverCd: "9901",
    driverName: "試験　太郎",
    branchName: "テスト運輸　第一営業所",
    workDays: 0,
    restDays: 0,
    restraintMinutes: null,
    drivingMinutes: null,
    loadingMinutes: null,
    breakMinutes: null,
    workingMinutes: null,
    overtimeMinutes: null,
    nightMinutes: null,
    overtimeNightMinutes: null,
    maxDailyRestraintMinutes: null,
    fiscalCumulativeMinutes: null,
    restraintLimitMinutes: null,
    excessRestraintMinutes: null,
    over15hDays: 0,
    avgDriving9hOverCount: 0,
    days: [],
    ...over,
  };
}

function makeEnv(entries: Record<string, MockR2Entry>): Env {
  return {
    DTAKO_R2: createMockR2(entries),
    RESTRAINT_R2_PREFIX: "restraint",
    AUTH_WORKER_ORIGIN: "https://auth-staging.ippoan.org",
    AUTH_WORKER: { fetch: async () => new Response(null, { status: 501 }) } as unknown as Fetcher,
  };
}

function makeEnvNoPrefix(entries: Record<string, MockR2Entry>): Env {
  return {
    DTAKO_R2: createMockR2(entries),
    AUTH_WORKER_ORIGIN: "https://auth-staging.ippoan.org",
  } as Env;
}

describe("r2Prefix fallback", () => {
  it("defaults to 'restraint' when RESTRAINT_R2_PREFIX is unset", async () => {
    const env = makeEnvNoPrefix({ "restraint/0100/2026-07/summary/1/latest.json": { value: "{}" } });
    const res = (await listMonthsTool.execute(env, { company: "0100" })) as { months: string[] };
    expect(res.months).toEqual(["2026-07"]);
  });
});

describe("listCompaniesTool", () => {
  it("returns numeric company codes found under the prefix", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": { value: "{}" },
      "restraint/0200/2026-07/summary/1/latest.json": { value: "{}" },
      "restraint/wage-master/latest.json": { value: "{}" }, // 非 company prefix (数字でない) は除外
    });
    const res = (await listCompaniesTool.execute(env)) as { companies: string[] };
    expect(res.companies).toEqual(["0100", "0200"]);
  });

  it("returns company codes whose digit count differs from the 4-digit 給与 code (デジタコ compId は1対多で桁数不定、実例: 8桁)", async () => {
    const env = makeEnv({
      "restraint/27324455/2026-07/summary/1/latest.json": { value: "{}" },
    });
    const res = (await listCompaniesTool.execute(env)) as { companies: string[] };
    expect(res.companies).toEqual(["27324455"]);
  });

  it("returns an empty list when nothing is archived", async () => {
    const env = makeEnv({});
    const res = (await listCompaniesTool.execute(env)) as { companies: string[] };
    expect(res.companies).toEqual([]);
  });
});

describe("listMonthsTool", () => {
  it("returns YYYY-MM months for the company, sorted descending", async () => {
    const env = makeEnv({
      "restraint/0100/2026-06/summary/1/latest.json": { value: "{}" },
      "restraint/0100/2026-07/summary/1/latest.json": { value: "{}" },
      "restraint/0100/wage-master/latest.json": { value: "{}" }, // month 形式でないので除外
      "restraint/0200/2026-07/summary/1/latest.json": { value: "{}" }, // 別会社は含めない
    });
    const res = (await listMonthsTool.execute(env, { company: "0100" })) as { months: string[] };
    expect(res.months).toEqual(["2026-07", "2026-06"]);
  });

  it("works for a non-4-digit (8桁) company code", async () => {
    const env = makeEnv({
      "restraint/27324455/2026-06/summary/1/latest.json": { value: "{}" },
    });
    const res = (await listMonthsTool.execute(env, { company: "27324455" })) as { months: string[] };
    expect(res.months).toEqual(["2026-06"]);
  });
});

describe("getRestraintSummaryTool", () => {
  it("returns all driver summaries for a company/month", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": {
        value: JSON.stringify(summary({ driverCd: "1", driverName: "A" })),
        customMetadata: { fetchedAt: "2026-07-20T00:00:00Z" },
      },
      "restraint/0100/2026-07/summary/2/latest.json": {
        value: JSON.stringify(summary({ driverCd: "2", driverName: "B" })),
      },
    });
    const res = (await getRestraintSummaryTool.execute(env, { company: "0100", month: "2026-07" })) as {
      rows: Array<{ data: RestraintDriverSummary }>;
    };
    expect(res.rows.map((r) => r.data.driverCd)).toEqual(["1", "2"]);
  });

  it("filters to a single driver when `driver` is given", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
      "restraint/0100/2026-07/summary/2/latest.json": { value: JSON.stringify(summary({ driverCd: "2" })) },
    });
    const res = (await getRestraintSummaryTool.execute(env, {
      company: "0100",
      month: "2026-07",
      driver: "2",
    })) as { rows: Array<{ data: RestraintDriverSummary }> };
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.data.driverCd).toBe("2");
  });

  it("puts noData drivers into no_data_drivers, not rows", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
      "restraint/0100/2026-07/summary/9/latest.json": {
        value: JSON.stringify({ noData: true, driverCd: "9" }),
      },
    });
    const res = (await getRestraintSummaryTool.execute(env, { company: "0100", month: "2026-07" })) as {
      rows: unknown[];
      no_data_drivers: string[];
    };
    expect(res.rows).toHaveLength(1);
    expect(res.no_data_drivers).toEqual(["9"]);
  });

  it("records an empty string when a noData entry has no string driverCd", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/9/latest.json": { value: JSON.stringify({ noData: true }) },
    });
    const res = (await getRestraintSummaryTool.execute(env, { company: "0100", month: "2026-07" })) as {
      no_data_drivers: string[];
    };
    expect(res.no_data_drivers).toEqual([""]);
  });

  it("defensively fills days:[] for a v1 summary archive that has no days field", async () => {
    const { days, ...v1Summary } = summary({ driverCd: "1" });
    void days;
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": { value: JSON.stringify(v1Summary) },
    });
    const res = (await getRestraintSummaryTool.execute(env, { company: "0100", month: "2026-07" })) as {
      rows: Array<{ data: RestraintDriverSummary }>;
    };
    expect(res.rows[0]!.data.days).toEqual([]);
  });

  it("skips a latest.json entry that fails to parse (deleted/corrupt between list and get)", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
      "restraint/0100/2026-07/summary/2/latest.json": { value: "{not valid json" },
    });
    const res = (await getRestraintSummaryTool.execute(env, { company: "0100", month: "2026-07" })) as {
      rows: Array<{ data: RestraintDriverSummary }>;
    };
    expect(res.rows.map((r) => r.data.driverCd)).toEqual(["1"]);
  });

  it("returns empty rows for a month with no archive", async () => {
    const env = makeEnv({});
    const res = (await getRestraintSummaryTool.execute(env, { company: "0100", month: "2026-07" })) as {
      rows: unknown[];
    };
    expect(res.rows).toEqual([]);
  });
});

// `source: "current"` を明示しているのは、この describe が **R2 直読み + 計算**の
// 経路を検証しているため。既定は画面と揃えた `gcp` (Refs #675) で、そちらは relay を
// 叩くので `test/get-wage-report-gcp.test.ts` で別に検証する。
describe("getWageReportTool", () => {
  it("computes a wage row per driver using empty (fallback) masters when none archived", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": {
        value: JSON.stringify(summary({ driverCd: "1", days: [day(1), day(2)] })),
      },
    });
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-07", source: "current" })) as {
      month: string;
      rows: Array<{ summary: RestraintDriverSummary; wage: unknown }>;
      warnings: string[];
    };
    expect(res.month).toBe("2026-07");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.summary.driverCd).toBe("1");
    expect(res.rows[0]!.wage).toBeTruthy();
    // 前月 summary が無いので警告が出る
    expect(res.warnings.some((w) => w.includes("前月"))).toBe(true);
  });

  it("does not warn when previous month has an archive too", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
      "restraint/0100/2026-06/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
    });
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-07", source: "current" })) as {
      warnings: string[];
    };
    expect(res.warnings).toEqual([]);
  });

  it("handles the January → previous-December rollover for prevYm", async () => {
    const env = makeEnv({
      "restraint/0100/2026-01/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
      "restraint/0100/2025-12/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
    });
    const res = (await getWageReportTool.execute(env, {
      company: "0100",
      month: "2026-01",
      source: "current",
    })) as {
      warnings: string[];
    };
    expect(res.warnings).toEqual([]);
  });

  it("throws for a malformed month", async () => {
    const env = makeEnv({});
    await expect(getWageReportTool.execute(env, { company: "0100", month: "not-a-month" })).rejects.toThrow();
  });

  it("throws for a month with an out-of-range month number (regex passes, range check fails)", async () => {
    const env = makeEnv({});
    await expect(getWageReportTool.execute(env, { company: "0100", month: "2026-13" })).rejects.toThrow();
  });

  it("falls back to defaults when a wage-master JSON is unparsable", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
      "restraint/0100/wage-master/latest.json": { value: "{not json" },
    });
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-07", source: "current" })) as {
      rows: unknown[];
    };
    expect(res.rows).toHaveLength(1);
  });

  it("falls back to defaults when a wage-master JSON parses but fails normalize() validation", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
      // 構文的には valid JSON だが normalizeWageMaster が期待する {drivers:{...}} 形ではない
      "restraint/0100/wage-master/latest.json": { value: JSON.stringify({ drivers: "not-an-object" }) },
    });
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-07", source: "current" })) as {
      rows: unknown[];
    };
    expect(res.rows).toHaveLength(1);
  });
});

// ===== get_kosoku_events ======================================================
//
// 他 tool と違い R2 ではなく上流 (rust-ichibanboshi) を fetch するので、
// global fetch を差し替えて検証する。主眼は「握り潰さないこと」— 未設定・接続不能・
// 非 2xx・非 JSON がそれぞれ原因の分かるメッセージで表に出ること。

/** CF Access token が揃った env (上流 fetch が成立する状態)。 */
function kosokuEnv(over: Partial<Env> = {}): Env {
  return {
    DTAKO_R2: createMockR2({}),
    AUTH_WORKER_ORIGIN: "https://auth-staging.ippoan.org",
    NUXT_ICHIBAN_API_URL: "https://rust-ichiban.example.com",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid.access",
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: { get: async () => "csecret" },
    ...over,
  } as Env;
}

const EVENT_ROW = {
  datetime: "2026-06-01 06:22:03",
  end_datetime: null,
  driver_id: 1051,
  source: "timecard",
  state: "始業",
  unko_no: null,
  vehicle: null,
};

describe("get_kosoku_events", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("relays upstream rows and sends the CF Access service token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ rows: [EVENT_ROW] }), { status: 200 });
    });

    const res = (await getKosokuEventsTool.execute(kosokuEnv(), {
      driver: "1051",
      month: "2026-06",
    })) as { month: string; driver: string; rows: unknown[] };

    expect(res).toEqual({ month: "2026-06", driver: "1051", rows: [EVENT_ROW] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "https://rust-ichiban.example.com/api/kintai/events?month=2026-06&driver=1051",
    );
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers["CF-Access-Client-Id"]).toBe("cid.access");
    expect(headers["CF-Access-Client-Secret"]).toBe("csecret");
  });

  it("normalizes a trailing slash on the API URL and accepts a plain string secret", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    });

    await getKosokuEventsTool.execute(
      kosokuEnv({
        NUXT_ICHIBAN_API_URL: "https://rust-ichiban.example.com//",
        // dashboard の plain 変数 / ローカル dev では文字列で来る
        ICHIBAN_CF_ACCESS_CLIENT_SECRET: "plain-secret",
      }),
      { driver: "1051", month: "2026-06" },
    );

    expect(calls[0]).toBe(
      "https://rust-ichiban.example.com/api/kintai/events?month=2026-06&driver=1051",
    );
  });

  it("returns an empty array when upstream omits rows", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = (await getKosokuEventsTool.execute(kosokuEnv(), {
      driver: "1051",
      month: "2026-06",
    })) as { rows: unknown[] };
    expect(res.rows).toEqual([]);
  });

  it("rejects an out-of-range month before touching upstream", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      getKosokuEventsTool.execute(kosokuEnv(), { driver: "1051", month: "2026-13" }),
    ).rejects.toThrow("YYYY-MM");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails loudly when the upstream binding set is incomplete", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const cases: Partial<Env>[] = [
      { NUXT_ICHIBAN_API_URL: "" },
      { NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "" },
      { ICHIBAN_CF_ACCESS_CLIENT_SECRET: undefined },
    ];
    for (const over of cases) {
      await expect(
        getKosokuEventsTool.execute(kosokuEnv(over), { driver: "1051", month: "2026-06" }),
      ).rejects.toThrow("未設定");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats an unresolvable Secrets Store binding as unset instead of a raw crash", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      getKosokuEventsTool.execute(
        kosokuEnv({
          ICHIBAN_CF_ACCESS_CLIENT_SECRET: {
            get: async () => {
              throw new Error("secret not found");
            },
          },
        }),
        { driver: "1051", month: "2026-06" },
      ),
    ).rejects.toThrow("未設定");
    expect(errors.mock.calls[0]![0]).toContain("secret-error");
  });

  it("surfaces a connection failure with its cause", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("Network connection lost");
    });
    await expect(
      getKosokuEventsTool.execute(kosokuEnv(), { driver: "1051", month: "2026-06" }),
    ).rejects.toThrow("rust-ichibanboshi へ接続できません: Network connection lost");
  });

  it("surfaces a non-Error rejection too", async () => {
    vi.stubGlobal("fetch", async () => {
      throw "boom";
    });
    await expect(
      getKosokuEventsTool.execute(kosokuEnv(), { driver: "1051", month: "2026-06" }),
    ).rejects.toThrow("boom");
  });

  it("surfaces the upstream status and body on a non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("MariaDB query failed: connect", { status: 502 }),
    );
    await expect(
      getKosokuEventsTool.execute(kosokuEnv(), { driver: "1051", month: "2026-06" }),
    ).rejects.toThrow("rust-ichibanboshi が 502 を返しました: MariaDB query failed: connect");
  });

  it("surfaces a non-JSON body (CF Access login HTML) instead of a parse crash", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("<!DOCTYPE html><html>Access denied</html>", { status: 200 }),
    );
    await expect(
      getKosokuEventsTool.execute(kosokuEnv(), { driver: "1051", month: "2026-06" }),
    ).rejects.toThrow("応答が JSON ではありません");
  });
});

// ===== get_rest_diff ==========================================================
//
// `fetchIchibanJson` の失敗系は get_kosoku_events で見ているので、ここは
// **乗務員を省略できること**と URL の形、そして上流の応答を解釈せずそのまま
// 返すことに絞る (Refs ohishi-exp/rust-ichibanboshi#205 の 41)。

const REST_DIFF_BODY = {
  month: "2026-06",
  driver: null,
  from: "2026-06-01 00:00:00",
  to: "2026-07-02 00:00:00",
  total: 1,
  items: [
    {
      unko_no: "26061409573000000034471",
      driver_cds: [1445],
      run_date: "2026-06-14",
      dtako_rest_rows: 5,
      dtako_events_rest_intervals: 1,
      dtako_only: ["2026-06-18 07:50:36"],
      dtako_events_only: ["2026-06-19 13:22:00"],
    },
  ],
  by_driver: { "1445": 1 },
  scanned_unko: 1,
  skipped_rows: 0,
  max_items: 500,
};

describe("get_rest_diff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("乗務員を省略すると全乗務員ぶんを 1 回で引く", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(REST_DIFF_BODY), { status: 200 });
    });

    const res = await getRestDiffTool.execute(kosokuEnv(), { month: "2026-06" });

    // 上流の応答を**解釈せずそのまま**返す (by_driver も総数のまま届く)
    expect(res).toEqual(REST_DIFF_BODY);
    expect(calls).toEqual([
      "https://rust-ichiban.example.com/api/kintai/rest-diff?month=2026-06",
    ]);
  });

  it("乗務員を指定すれば query に載る", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(REST_DIFF_BODY), { status: 200 });
    });

    await getRestDiffTool.execute(kosokuEnv(), { month: "2026-06", driver: "1445" });

    expect(calls[0]).toBe(
      "https://rust-ichiban.example.com/api/kintai/rest-diff?month=2026-06&driver=1445",
    );
  });

  it("範囲外の月は上流を叩く前に落とす", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(getRestDiffTool.execute(kosokuEnv(), { month: "2026-13" })).rejects.toThrow(
      "YYYY-MM",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ===== get_timecard_diff =====================================================
//
// 上流を 3 本 (pdf-json / kosoku-daily 当月 / kosoku-daily 前月) 叩くので、
// URL ごとに応答を出し分ける stub を置く。fetchIchibanJson 側の失敗系は
// get_kosoku_events で見ているので、ここは突合の入出力に絞る。

/** kosoku-daily の 1 日 (突合が見るのは restraint_minutes だけ)。 */
function kosokuDay(date: string, restraint: number, parts: unknown[] = []) {
  return {
    date,
    restraint_minutes: restraint,
    working_minutes: restraint,
    overtime_minutes: 0,
    night_minutes: 0,
    overtime_night_minutes: 0,
    parts,
  };
}

const PDF_JSON = {
  month: "2026-04",
  drivers: [
    {
      driver_id: 1021,
      name: "テスト 乗務員",
      days: [
        { day: 1, kosoku_minutes: 570, kosoku_by_type: { デジタコ: 570 } }, // 一致
        { day: 3, kosoku_minutes: 600, kosoku_by_type: { デジタコ: 600 } }, // 30 分差
        { day: 6, kosoku_minutes: -30, kosoku_by_type: { TC_DC: -30 } }, // 負
      ],
      totals: { shukkin: 3 },
    },
    {
      driver_id: 1030,
      name: "一致する人",
      days: [{ day: 1, kosoku_minutes: 480, kosoku_by_type: { デジタコ: 480 } }],
      totals: {},
    },
  ],
};

const KOSOKU_CURRENT = {
  month: "2026-04",
  drivers: [
    {
      driver: 1021,
      days: [kosokuDay("2026-04-01", 570), kosokuDay("2026-04-03", 570), kosokuDay("2026-04-06", 0)],
    },
    { driver: 1030, days: [kosokuDay("2026-04-01", 480)] },
  ],
};

/** 前月から跨いだ勤務。1021 は当月へ内訳で落ちる (= 当月分に足される)。 */
const KOSOKU_PREV = {
  month: "2026-03",
  drivers: [
    {
      driver: 1021,
      days: [
        {
          ...kosokuDay("2026-03-31", 600, [
            { date: "2026-03-31", restraint_minutes: 480 },
            { date: "2026-04-01", restraint_minutes: 120 },
          ]),
        },
      ],
    },
  ],
};

/** URL で応答を切り替える fetch stub。 */
function stubIchiban(over: { prev?: unknown; cur?: unknown } = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    if (url.includes("/api/kintai/pdf-json")) {
      return new Response(JSON.stringify(PDF_JSON), { status: 200 });
    }
    if (url.includes("month=2026-03")) {
      return new Response(JSON.stringify(over.prev ?? { month: "2026-03", drivers: [] }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify(over.cur ?? KOSOKU_CURRENT), { status: 200 });
  });
  return calls;
}

type DiffResult = {
  month: string;
  driver: string | null;
  onlyAnomalies: boolean;
  drivers: number;
  results: Array<{
    driverCd: string;
    name: string;
    mismatchCount: number;
    days: Array<{
      date: string;
      status: string;
      diffMinutes: number | null;
      cause?: string;
      anomalies: unknown[];
    }>;
    anomalies: Array<{ kind: string }>;
    totals: { nginxMinutes: number; oursMinutes: number; diffMinutes: number };
  }>;
};

describe("get_timecard_diff", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("takes the 3 upstream calls it needs (pdf-json + kosoku-daily 当月/前月)", async () => {
    const calls = stubIchiban();
    await getTimecardDiffTool.execute(kosokuEnv(), { month: "2026-04", driver: "1021" });
    expect(calls.sort()).toEqual([
      // 突合は view=compare で取る (応答 1.73 MB → 256 KB、rust-ichibanboshi#157)
      "https://rust-ichiban.example.com/api/kintai/kosoku-daily?month=2026-03&view=compare",
      "https://rust-ichiban.example.com/api/kintai/kosoku-daily?month=2026-04&view=compare",
      "https://rust-ichiban.example.com/api/kintai/pdf-json?month=2026-04&driver=1021",
    ]);
  });

  it("1 vs 1: 既定では見るべき日だけを返す", async () => {
    stubIchiban();
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
    })) as DiffResult;

    expect(res.month).toBe("2026-04");
    expect(res.driver).toBe("1021");
    expect(res.onlyAnomalies).toBe(true);
    expect(res.drivers).toBe(1);
    const r = res.results[0]!;
    expect(r.name).toBe("テスト 乗務員");
    // 4/1 は一致なので落ち、30 分差の 4/3 と負の 4/6 だけ残る
    expect(r.days.map((d) => [d.date, d.status, d.diffMinutes])).toEqual([
      ["2026-04-03", "mismatch", 30],
      ["2026-04-06", "mismatch", -30],
    ]);
    expect(r.anomalies.map((a) => a.kind)).toEqual(["negative-kosoku", "negative-kosoku-type"]);
  });

  it("only_anomalies=false なら全暦日を返す", async () => {
    stubIchiban();
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
      only_anomalies: false,
    })) as DiffResult;
    expect(res.onlyAnomalies).toBe(false);
    expect(res.results[0]!.days).toHaveLength(30);
  });

  it("driver 省略で全乗務員、差分も異常も無い人は落ちる", async () => {
    stubIchiban();
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), { month: "2026-04" })) as DiffResult;
    expect(res.driver).toBeNull();
    // 1030 は完全一致なので落ちる
    expect(res.results.map((r) => r.driverCd)).toEqual(["1021"]);
    expect(res.drivers).toBe(1);
  });

  it("driver 省略 + only_anomalies=false なら一致した人も返る", async () => {
    stubIchiban();
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      only_anomalies: false,
    })) as DiffResult;
    expect(res.results.map((r) => r.driverCd)).toEqual(["1021", "1030"]);
  });

  it("前月から跨いだ勤務を当月に足す (取らないと月初が過少になる)", async () => {
    stubIchiban({ prev: KOSOKU_PREV });
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
      only_anomalies: false,
    })) as DiffResult;
    const apr1 = res.results[0]!.days.find((d) => d.date === "2026-04-01")!;
    // 当月 570 + 前月から跨いだ 120 = 690 (nginx は 570 なので差が出る)
    expect(apr1.status).toBe("mismatch");
    expect(apr1.diffMinutes).toBe(-120);
  });

  it("tolerance_minutes を渡すと許容内に倒れる", async () => {
    stubIchiban();
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
      tolerance_minutes: 60,
    })) as DiffResult;
    // 30 分差が許容内になり、負の 4/6 だけが残る (異常は差分と独立に出る)
    expect(res.results[0]!.days.map((d) => d.date)).toEqual(["2026-04-06"]);
  });

  it("紙の再現値との差 (paper_drift_by_date) が cause rounding として効く", async () => {
    // 4/3 は nginx 600 / ours 570 (差 +30)。当月応答の drift -30 (= ours - paper) が
    // あれば丸め方式の差として説明が付く (Refs ohishi-exp/rust-ichibanboshi#179)
    stubIchiban({
      cur: {
        ...KOSOKU_CURRENT,
        drivers: [
          { ...KOSOKU_CURRENT.drivers[0]!, paper_drift_by_date: { "2026-04-03": -30 } },
          KOSOKU_CURRENT.drivers[1]!,
        ],
      },
    });
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
    })) as DiffResult;
    const apr3 = res.results[0]!.days.find((d) => d.date === "2026-04-03")!;
    expect(apr3.cause).toBe("rounding");
  });

  it("フェリー控除の日別マップ (ferry_minus_by_date) が cause ferry として効く", async () => {
    // 4/3 は nginx 600 / ours 570 (差 +30)... ではなく、勤務に貼れない控除の形:
    // 差 -30 をマップの 30 が説明する (rust#181)
    stubIchiban({
      cur: {
        ...KOSOKU_CURRENT,
        drivers: [
          {
            driver: 1021,
            days: [kosokuDay("2026-04-01", 570), kosokuDay("2026-04-03", 630), kosokuDay("2026-04-06", 0)],
            ferry_minus_by_date: { "2026-04-03": 30 },
          },
          KOSOKU_CURRENT.drivers[1]!,
        ],
      },
    });
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
    })) as DiffResult;
    const apr3 = res.results[0]!.days.find((d) => d.date === "2026-04-03")!;
    expect(apr3.cause).toBe("ferry");
  });

  it("nginx に居ない乗務員も返す", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/api/kintai/pdf-json")) {
        return new Response(JSON.stringify({ month: "2026-04", drivers: [] }), { status: 200 });
      }
      if (url.includes("month=2026-03")) {
        return new Response(JSON.stringify({ drivers: [] }), { status: 200 });
      }
      return new Response(JSON.stringify(KOSOKU_CURRENT), { status: 200 });
    });
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), { month: "2026-04" })) as DiffResult;
    expect(res.results.map((r) => r.driverCd)).toEqual(["1021", "1030"]);
    expect(res.results[0]!.days.every((d) => d.status === "ours-only")).toBe(true);
  });

  it("どちらにも居ない乗務員を指定しても空で返す (1 名指定は必ず 1 件返す)", async () => {
    stubIchiban();
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "9999",
    })) as DiffResult;
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.driverCd).toBe("9999");
    expect(res.results[0]!.name).toBe("");
    expect(res.results[0]!.days).toEqual([]);
    expect(res.results[0]!.mismatchCount).toBe(0);
  });

  it("nginx が 200 で返すエラーを握り潰さない (差なしに見えてしまう)", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/api/kintai/pdf-json")) {
        return new Response(
          JSON.stringify({ error: "KyuyoKisoDate に 2026-04 の基礎日数が登録されていません" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ drivers: [] }), { status: 200 });
    });
    await expect(
      getTimecardDiffTool.execute(kosokuEnv(), { month: "2026-04", driver: "1021" }),
    ).rejects.toThrow("基礎日数が登録されていません");
  });

  it("月の書式が通っても範囲外なら上流を叩かない", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      getTimecardDiffTool.execute(kosokuEnv(), { month: "2026-13" }),
    ).rejects.toThrow("YYYY-MM");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── ours_unreadable (Refs #960) ────────────────────────────────────────────
  // オンプレ `kosoku-daily` は driver 指定の有無で形が変わる。どちらでもない形を
  // 空 Map で返すと「こちら側 0 分」と見分けが付かず、紙の値がまるごと差に化ける。

  it("陰性対照: 正常な全乗務員形では ours_unreadable が false で note も空", async () => {
    stubIchiban();
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
    })) as DiffResult & { ours_unreadable: boolean, note: string };
    expect(res.ours_unreadable).toBe(false);
    expect(res.note).toBe("");
    // 中身も従来どおり (差が出る 2 日だけ残る)
    expect(res.results[0]!.days.map((d) => d.date)).toEqual(["2026-04-03", "2026-04-06"]);
  });

  it("陰性対照: 単一乗務員形 (drivers が無く days がトップレベル) も読めた扱い", async () => {
    stubIchiban({
      cur: { month: "2026-04", driver: 1021, days: KOSOKU_CURRENT.drivers[0]!.days },
    });
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
    })) as DiffResult & { ours_unreadable: boolean, note: string };
    expect(res.ours_unreadable).toBe(false);
    expect(res.note).toBe("");
    expect(res.results[0]!.days.map((d) => d.date)).toEqual(["2026-04-03", "2026-04-06"]);
  });

  it("★ どちらの形でもなければ ours_unreadable を立て、note で 0 分を信じさせない", async () => {
    // `drivers` が配列でなく `days` も無い = 上流の応答の形が変わった状態
    stubIchiban({ cur: { month: "2026-04", results: [] } });
    const res = (await getTimecardDiffTool.execute(kosokuEnv(), {
      month: "2026-04",
      driver: "1021",
    })) as DiffResult & { ours_unreadable: boolean, note: string };
    expect(res.ours_unreadable).toBe(true);
    expect(res.note).toContain("ours_unreadable: true");
    // 「取れなかった」と混ぜない — 取り込み直しでは直らないと書いてあること
    expect(res.note).toContain("取り込み直しでは直らない");
    // こちら側が全部 0 分になっているので、紙の値がまるごと差として出ている
    expect(res.results[0]!.days.every((d) => d.status === "nginx-only")).toBe(true);
  });
});

// ===== get_timecard_diff (mode=summary) ======================================

/** こちらにしか居ない乗務員 (`ours-only`) を 1 名混ぜた kosoku-daily。 */
const KOSOKU_WITH_OURS_ONLY = {
  month: "2026-04",
  drivers: [
    ...KOSOKU_CURRENT.drivers,
    { driver: 1211, days: [kosokuDay("2026-04-01", 673), kosokuDay("2026-04-02", 851)] },
  ],
};

/** 給与比較アーカイブ (R2) に 1211 の営業所だけ置いた環境。 */
function summaryModeEnv(entries?: Record<string, MockR2Entry>): Env {
  return kosokuEnv({
    DTAKO_R2: createMockR2(
      entries ?? {
        "restraint/27324455/2026-04/summary/1211/latest.json": {
          value: JSON.stringify(
            summary({
              driverCd: "1211",
              driverName: "薮田　高敏",
              branchName: "大石運輸倉庫㈱　大阪営業所",
            }),
          ),
        },
      },
    ),
  });
}

type DiffSummaryResult = {
  mode: string;
  drivers: number;
  ours_only_by_branch: Array<{ branchName: string | null; drivers: number; days: number }>;
  results: Array<{
    driverCd: string;
    name: string;
    oursName: string | null;
    branchName: string | null;
    statusDays: Record<string, number>;
    diffRange: { min: number; max: number } | null;
    days?: unknown;
  }>;
};

describe("get_timecard_diff (mode=summary)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("日別を落として乗務員ごとに 1 行にする", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv(), {
      month: "2026-04",
      mode: "summary",
    })) as DiffSummaryResult;
    expect(res.mode).toBe("summary");
    // 1030 は完全一致なので only_anomalies (既定 true) で落ちる
    expect(res.results.map((r) => r.driverCd)).toEqual(["1021", "1211"]);
    for (const row of res.results) expect(row.days).toBeUndefined();
    // 1021 は 4/3 が +30 (nginx 600 / ours 570)、4/6 が -30 (nginx -30 / ours 0)
    expect(res.results[0]?.statusDays.mismatch).toBe(2);
    expect(res.results[0]?.diffRange).toEqual({ min: -30, max: 30 });
  });

  it("nginx に居ない乗務員の氏名・営業所をこちら側のアーカイブから補う", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv(), {
      month: "2026-04",
      mode: "summary",
    })) as DiffSummaryResult;
    const oursOnly = res.results.find((r) => r.driverCd === "1211");
    // 突合の name は nginx 由来なので空。誰なのかは oursName でしか分からない
    expect(oursOnly?.name).toBe("");
    expect(oursOnly?.oursName).toBe("薮田　高敏");
    expect(oursOnly?.branchName).toBe("大石運輸倉庫㈱　大阪営業所");
    expect(oursOnly?.statusDays["ours-only"]).toBe(2);
  });

  it("ours-only の日数を営業所ごとに数える (日数の多い順)", async () => {
    stubIchiban({
      cur: {
        month: "2026-04",
        drivers: [
          ...KOSOKU_WITH_OURS_ONLY.drivers,
          // 別営業所で 1 日だけ。日数の多い大阪より後ろに来る
          { driver: 1300, days: [kosokuDay("2026-04-01", 500)] },
        ],
      },
    });
    const env = summaryModeEnv({
      "restraint/27324455/2026-04/summary/1211/latest.json": {
        value: JSON.stringify(
          summary({
            driverCd: "1211",
            driverName: "薮田　高敏",
            branchName: "大石運輸倉庫㈱　大阪営業所",
          }),
        ),
      },
      "restraint/27324455/2026-04/summary/1300/latest.json": {
        value: JSON.stringify(
          summary({ driverCd: "1300", driverName: "別所　一", branchName: "テスト運輸　第二営業所" }),
        ),
      },
      // 乗務員CD が数字でない行はスキップする (アーカイブ側の事故に引きずられない)
      "restraint/27324455/2026-04/summary/x/latest.json": {
        value: JSON.stringify(summary({ driverCd: "abc" })),
      },
    });
    const res = (await getTimecardDiffTool.execute(env, {
      month: "2026-04",
      mode: "summary",
    })) as DiffSummaryResult;
    expect(res.ours_only_by_branch).toEqual([
      { branchName: "大石運輸倉庫㈱　大阪営業所", drivers: 1, days: 2 },
      { branchName: "テスト運輸　第二営業所", drivers: 1, days: 1 },
    ]);
  });

  it("アーカイブに居ない乗務員は branchName が null になるだけで結果は返る", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv({}), {
      month: "2026-04",
      mode: "summary",
    })) as DiffSummaryResult;
    const oursOnly = res.results.find((r) => r.driverCd === "1211");
    expect(oursOnly?.branchName).toBeNull();
    expect(oursOnly?.oursName).toBeNull();
    expect(res.ours_only_by_branch).toEqual([{ branchName: null, drivers: 1, days: 2 }]);
  });

  it("R2 が読めなくても突合は返す (営業所は諦める)", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const broken = kosokuEnv({
      DTAKO_R2: {
        list: async () => {
          throw new Error("R2 down");
        },
      } as unknown as R2Bucket,
    });
    const res = (await getTimecardDiffTool.execute(broken, {
      month: "2026-04",
      mode: "summary",
    })) as DiffSummaryResult;
    expect(res.results.map((r) => r.driverCd)).toEqual(["1021", "1211"]);
    expect(res.results.every((r) => r.branchName === null)).toBe(true);
  });

  it("driver 指定でも summary で返せる", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv(), {
      month: "2026-04",
      driver: "1211",
      mode: "summary",
    })) as DiffSummaryResult;
    expect(res.drivers).toBe(1);
    expect(res.results[0]?.branchName).toBe("大石運輸倉庫㈱　大阪営業所");
  });

  it("totals は絞り込む前の全乗務員で数える", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv(), {
      month: "2026-04",
      mode: "summary",
      limit: 1,
    })) as unknown as {
      drivers: number;
      omitted: number;
      totals: { drivers: number; unknown_days: number };
      results: unknown[];
    };
    // 返すのは 1 名でも、drivers / totals は 2 名ぶんのまま
    expect(res.results).toHaveLength(1);
    expect(res.omitted).toBe(1);
    expect(res.drivers).toBe(2);
    expect(res.totals.drivers).toBe(2);
    expect(res.totals.unknown_days).toBeGreaterThan(0);
  });

  it("未説明の多い順に返す", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv(), {
      month: "2026-04",
      mode: "summary",
      limit: 1,
    })) as unknown as { results: Array<{ driverCd: string; unknownCount: number }> };
    // 1021 は 4/3 (+30) と 4/6 (-30) が未説明。1211 は ours-only だけなので 0
    expect(res.results[0]?.driverCd).toBe("1021");
    expect(res.results[0]?.unknownCount).toBe(2);
  });

  it("未説明の日数が同じなら残差の大きい方を先に返す", async () => {
    // どちらも未説明 1 日だが、1030 は +300、1021 は +100
    stubIchiban({
      cur: {
        month: "2026-04",
        drivers: [
          { driver: 1021, days: [kosokuDay("2026-04-01", 470)] },
          { driver: 1030, days: [kosokuDay("2026-04-01", 180)] },
        ],
      },
    });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv({}), {
      month: "2026-04",
      mode: "summary",
      limit: 2,
    })) as unknown as { results: Array<{ driverCd: string; unknownCount: number }> };
    expect(res.results.map((r) => r.unknownCount)).toEqual([1, 1]);
    expect(res.results.map((r) => r.driverCd)).toEqual(["1030", "1021"]);
  });

  it("limit 省略なら 20 名まで", async () => {
    const many = {
      month: "2026-04",
      drivers: Array.from({ length: 25 }, (_, i) => ({
        driver: 2000 + i,
        days: [kosokuDay("2026-04-01", 500 + i)],
      })),
    };
    stubIchiban({ cur: many });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv({}), {
      month: "2026-04",
      mode: "summary",
    })) as unknown as { drivers: number; omitted: number; results: unknown[] };
    expect(res.results).toHaveLength(20);
    expect(res.omitted).toBe(res.drivers - 20);
  });

  it("mode 省略なら従来どおり日別を返す", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv(), {
      month: "2026-04",
    })) as unknown as { mode: string; results: Array<{ days: unknown[] }> };
    expect(res.mode).toBe("days");
    expect(Array.isArray(res.results[0]?.days)).toBe(true);
  });

  // summary は「未説明の多い順」に並べるので、こちら側が丸ごと 0 分だと**一覧の
  // 先頭が総入れ替わる**。日別モードだけに注記を出すと、この画面で嘘になる (#960)
  it("★ summary モードにも ours_unreadable と note が載る", async () => {
    stubIchiban({ cur: { month: "2026-04", results: [] } });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv(), {
      month: "2026-04",
      mode: "summary",
    })) as unknown as { ours_unreadable: boolean, note: string };
    expect(res.ours_unreadable).toBe(true);
    expect(res.note).toContain("ours_unreadable: true");
  });

  it("陰性対照: summary モードの正常系は ours_unreadable が false で note も空", async () => {
    stubIchiban({ cur: KOSOKU_WITH_OURS_ONLY });
    const res = (await getTimecardDiffTool.execute(summaryModeEnv(), {
      month: "2026-04",
      mode: "summary",
    })) as unknown as { ours_unreadable: boolean, note: string, results: unknown[] };
    expect(res.ours_unreadable).toBe(false);
    expect(res.note).toBe("");
    expect(res.results).toHaveLength(2);
  });
});


// ===== get_ichiban_costs / get_ichiban_sales =================================
//
// `fetchIchibanJson` の失敗系 (未設定・接続不能・非 2xx・非 JSON) は
// get_kosoku_events で見ているので、ここは **この 2 本に固有のもの**に絞る:
// 引数の必須判定・クエリの組み立て・集計・行の pass-through。

/** 上流 (rust-ichibanboshi) の応答を返す fetch を立て、叩かれた URL を集める。 */
function stubIchibanJson(body: unknown, status = 200): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  });
  return urls;
}

const COST_ROW = {
  operation_date: "2026-07-03",
  vehicle_number: "1420",
  vehicle_branch: "01",
  driver_code: "1656",
  cost_code: "0301",
  cost_name: "修理代",
  cost_kind: "03",
  cost_kind_name: "車輌修繕費(変動)",
  quantity: 1,
  unit_price: 240060,
  amount: 240060,
  diesel_tax: 0,
  km: 0,
  is_fixed: false,
  row_id: "20260703-000123",
  // 上流 (#760-11) がこれから足す列。pass-through なのでそのまま出るはず
  remarks: "西島 パンク修理",
};

const FUEL_ROW = {
  ...COST_ROW,
  operation_date: "2026-07-05",
  cost_code: "0101",
  cost_name: "軽油",
  cost_kind: "01",
  cost_kind_name: "燃料ｵｲﾙ代",
  quantity: 300,
  unit_price: 110,
  amount: 33000,
  diesel_tax: 9660,
  is_fixed: false,
  row_id: "20260705-000456",
  remarks: "",
};

const FIXED_ROW = {
  ...COST_ROW,
  operation_date: "2026-07-05",
  cost_code: "0901",
  cost_name: "保険料",
  cost_kind: "09",
  cost_kind_name: "保険料",
  quantity: 1,
  unit_price: 12000,
  amount: 12000,
  diesel_tax: 0,
  is_fixed: true,
  row_id: "20260705-000789",
  remarks: "",
};

describe("get_ichiban_costs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires vehicle or driver before touching upstream", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      getIchibanCostsTool.execute(kosokuEnv(), { from: "2026-07-01", to: "2026-08-01" }),
    ).rejects.toThrow("どちらかは必須");
    // kind だけでは通さない (上流は許すが、全社ぶんは重い)
    await expect(
      getIchibanCostsTool.execute(kosokuEnv(), {
        from: "2026-07-01",
        to: "2026-08-01",
        kind: "03",
      }),
    ).rejects.toThrow("どちらかは必須");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("builds the query with only the filters that were given (vehicle)", async () => {
    const urls = stubIchibanJson({ source_table: "経費明細", data: [] });
    await getIchibanCostsTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      vehicle: "1420",
    });
    expect(urls[0]).toBe(
      "https://rust-ichiban.example.com/api/costs/vehicle-daily" +
        "?from=2026-07-01&to=2026-08-01&vehicle=1420",
    );
  });

  it("builds the query with driver and kind when those are given", async () => {
    const urls = stubIchibanJson({ source_table: "経費明細", data: [] });
    await getIchibanCostsTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      driver: "1656",
      kind: "03",
    });
    expect(urls[0]).toBe(
      "https://rust-ichiban.example.com/api/costs/vehicle-daily" +
        "?from=2026-07-01&to=2026-08-01&driver=1656&kind=03",
    );
  });

  it("passes rows through untouched and aggregates by kind and by date", async () => {
    stubIchibanJson({
      source_table: "経費明細 + 経費ﾏｽﾀ + 経費種別ﾏｽﾀ",
      data: [COST_ROW, FUEL_ROW, FIXED_ROW],
    });
    const res = (await getIchibanCostsTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      vehicle: "1420",
    })) as {
      source_table: unknown;
      vehicle: string | null;
      driver: string | null;
      kind: string | null;
      rows: unknown[];
      summary: {
        rows: number;
        total_amount: number;
        total_diesel_tax: number;
        fixed_amount: number;
        by_kind: unknown[];
        by_date: unknown[];
        truncated: boolean;
      };
    };

    expect(res.source_table).toBe("経費明細 + 経費ﾏｽﾀ + 経費種別ﾏｽﾀ");
    expect(res.vehicle).toBe("1420");
    expect(res.driver).toBeNull();
    expect(res.kind).toBeNull();
    // **pass-through**: 上流が足した列 (remarks) を落とさない
    expect(res.rows).toEqual([COST_ROW, FUEL_ROW, FIXED_ROW]);
    expect(res.summary.rows).toBe(3);
    expect(res.summary.total_amount).toBe(240060 + 33000 + 12000);
    expect(res.summary.total_diesel_tax).toBe(9660);
    expect(res.summary.fixed_amount).toBe(12000);
    expect(res.summary.truncated).toBe(false);
    // 区分コード昇順
    expect(res.summary.by_kind).toEqual([
      { cost_kind: "01", cost_kind_name: "燃料ｵｲﾙ代", amount: 33000, diesel_tax: 9660, rows: 1 },
      {
        cost_kind: "03",
        cost_kind_name: "車輌修繕費(変動)",
        amount: 240060,
        diesel_tax: 0,
        rows: 1,
      },
      { cost_kind: "09", cost_kind_name: "保険料", amount: 12000, diesel_tax: 0, rows: 1 },
    ]);
    // 日付昇順、同じ日は畳む
    expect(res.summary.by_date).toEqual([
      { date: "2026-07-03", amount: 240060, diesel_tax: 0, rows: 1 },
      { date: "2026-07-05", amount: 45000, diesel_tax: 9660, rows: 2 },
    ]);
  });

  it("survives rows that are not objects or miss fields instead of returning NaN", async () => {
    stubIchibanJson({
      // source_table が無い応答 (形が変わっても集計は続ける)
      data: [null, "oops", { amount: "1000", cost_kind: 3, is_fixed: "1" }],
    });
    const res = (await getIchibanCostsTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      driver: "1656",
    })) as {
      source_table: unknown;
      summary: { total_amount: number; fixed_amount: number; by_kind: unknown[] };
    };
    expect(res.source_table).toBeNull();
    expect(res.summary.total_amount).toBe(0);
    // is_fixed は bool の true だけを固定費に数える ("1" は数えない)
    expect(res.summary.fixed_amount).toBe(0);
    // 型違い・欠けはすべて空キーに畳まれる (3 行が 1 区分)
    expect(res.summary.by_kind).toEqual([
      { cost_kind: "", cost_kind_name: "", amount: 0, diesel_tax: 0, rows: 3 },
    ]);
  });

  it("returns empty aggregates when upstream data is not an array", async () => {
    stubIchibanJson({ source_table: "経費明細", data: { unexpected: true } });
    const res = (await getIchibanCostsTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      vehicle: "1420",
    })) as { rows: unknown[]; summary: { rows: number; by_kind: unknown[]; by_date: unknown[] } };
    expect(res.rows).toEqual([]);
    expect(res.summary).toMatchObject({ rows: 0, by_kind: [], by_date: [] });
  });

  it("flags truncation when upstream returns its default limit (500 rows)", async () => {
    stubIchibanJson({
      source_table: "経費明細",
      data: Array.from({ length: 500 }, (_, i) => ({ ...COST_ROW, row_id: `20260703-${i}` })),
    });
    const res = (await getIchibanCostsTool.execute(kosokuEnv(), {
      from: "2026-01-01",
      to: "2026-08-01",
      vehicle: "1420",
    })) as { summary: { rows: number; truncated: boolean } };
    expect(res.summary).toMatchObject({ rows: 500, truncated: true });
  });

  it("surfaces an upstream failure (non-2xx) as a throw", async () => {
    stubIchibanJson({ error: "bad request" }, 400);
    await expect(
      getIchibanCostsTool.execute(kosokuEnv(), {
        from: "2026-07-01",
        to: "2026-08-01",
        vehicle: "1420",
      }),
    ).rejects.toThrow("rust-ichibanboshi が 400 を返しました");
  });
});

const SALE_ROW = {
  sale_date: "2026-07-03",
  vehicle_number: "1420",
  vehicle_branch: "01",
  customer_code: "001234",
  customer_name: "テスト商事",
  origin_area_name: "釧路",
  dest_area_name: "帯広",
  origin: "釧路港",
  dest: "駒場",
  is_subcontracted: false,
  amount: 43750,
  item_code: "01",
  item_name: "飼料",
  quantity: 12.5,
  unit_price: 3500,
  unit: "t",
  row_id: "20260703-000001",
  driver_code: "1656",
  driver_name: "西島　太郎",
  request_kind: "0",
};

describe("get_ichiban_sales", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("requires vehicle or driver before touching upstream", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      getIchibanSalesTool.execute(kosokuEnv(), { from: "2026-07-01", to: "2026-08-01" }),
    ).rejects.toThrow("どちらかは必須");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("builds the query with only the filters that were given (vehicle)", async () => {
    const urls = stubIchibanJson({ source_table: "運行日報明細", data: [] });
    await getIchibanSalesTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      vehicle: "1420",
    });
    expect(urls[0]).toBe(
      "https://rust-ichiban.example.com/api/sales/vehicle-daily" +
        "?from=2026-07-01&to=2026-08-01&vehicle=1420",
    );
  });

  it("builds the query with driver when that is given", async () => {
    const urls = stubIchibanJson({ source_table: "運行日報明細", data: [] });
    await getIchibanSalesTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      driver: "1656",
    });
    expect(urls[0]).toBe(
      "https://rust-ichiban.example.com/api/sales/vehicle-daily" +
        "?from=2026-07-01&to=2026-08-01&driver=1656",
    );
  });

  it("passes rows through and aggregates by date and by request kind", async () => {
    stubIchibanJson({
      source_table: "運行日報明細",
      data: [
        SALE_ROW,
        { ...SALE_ROW, row_id: "20260703-000002", amount: 21750, request_kind: "2" },
        { ...SALE_ROW, sale_date: "2026-07-04", row_id: "20260704-000001", amount: 22000 },
      ],
    });
    const res = (await getIchibanSalesTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      driver: "1656",
    })) as {
      vehicle: string | null;
      driver: string | null;
      rows: unknown[];
      summary: {
        rows: number;
        total_amount: number;
        by_date: unknown[];
        by_request_kind: unknown[];
        truncated: boolean;
      };
    };

    expect(res.vehicle).toBeNull();
    expect(res.driver).toBe("1656");
    expect(res.rows).toHaveLength(3);
    expect(res.rows[0]).toEqual(SALE_ROW);
    expect(res.summary.rows).toBe(3);
    expect(res.summary.total_amount).toBe(43750 + 21750 + 22000);
    expect(res.summary.truncated).toBe(false);
    expect(res.summary.by_date).toEqual([
      { date: "2026-07-03", amount: 65500, rows: 2 },
      { date: "2026-07-04", amount: 22000, rows: 1 },
    ]);
    expect(res.summary.by_request_kind).toEqual([
      { request_kind: "0", amount: 65750, rows: 2 },
      { request_kind: "2", amount: 21750, rows: 1 },
    ]);
  });

  it("omits by_request_kind when no row carries 請求K", async () => {
    // source_table も無い応答 (形が変わっても集計は続ける)
    stubIchibanJson({
      // 上流から request_kind が消えた / 空文字の行しか無い場合
      data: [{ sale_date: "2026-07-03", amount: 1000 }, null],
    });
    const res = (await getIchibanSalesTool.execute(kosokuEnv(), {
      from: "2026-07-01",
      to: "2026-08-01",
      vehicle: "1420",
    })) as { source_table: unknown; summary: Record<string, unknown> };
    expect(res.source_table).toBeNull();
    expect(res.summary.by_request_kind).toBeUndefined();
    expect(res.summary.total_amount).toBe(1000);
    expect(res.summary.by_date).toEqual([
      { date: "", amount: 0, rows: 1 },
      { date: "2026-07-03", amount: 1000, rows: 1 },
    ]);
  });

  it("flags truncation when upstream returns its default limit (500 rows)", async () => {
    stubIchibanJson({
      source_table: "運行日報明細",
      data: Array.from({ length: 500 }, (_, i) => ({ ...SALE_ROW, row_id: `x-${i}` })),
    });
    const res = (await getIchibanSalesTool.execute(kosokuEnv(), {
      from: "2026-01-01",
      to: "2026-08-01",
      driver: "1656",
    })) as { summary: { truncated: boolean } };
    expect(res.summary.truncated).toBe(true);
  });

  it("surfaces a non-JSON upstream body as a throw", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("<!DOCTYPE html><html>Access denied</html>", { status: 200 }),
    );
    await expect(
      getIchibanSalesTool.execute(kosokuEnv(), {
        from: "2026-07-01",
        to: "2026-08-01",
        vehicle: "1420",
      }),
    ).rejects.toThrow("応答が JSON ではありません");
  });
});

describe("ALL_TOOLS", () => {
  /** 読むだけの tool。scope を要求しない (binding_jwt が valid なら誰でも呼べる)。 */
  const READ_ONLY = [
    // 畳んだ結果を読むだけ (Refs ohishi-exp/rust-ichibanboshi#205 の 23)。受け側に
    // POST が無く、この tool にも apply 相当の引数が無いので write 側に置かない
    "get_kintai_day_summaries",
    // オンプレ (kosoku-daily) と GCP (day_summaries) の突合。GET 2 本を叩くだけで
    // 1 バイトも書かない (Refs ohishi-exp/rust-ichibanboshi#205 の 50)
    "get_kintai_diff",
    "get_kosoku_events",
    // 一番星の経費/売上明細を読むだけ (Refs #760 の 12)。上流は GET のみ
    "get_ichiban_costs",
    "get_ichiban_sales",
    // 釧路営業所 (暫定) の試算 (Refs #760 の 34)。**pure な計算 + R2 の最低賃金マスタと
    // 一番星の売上を読むだけ**で、上流に POST を 1 本も投げない
    "get_kushiro_branch_estimate",
    // 休息のずれの診断 (Refs ohishi-exp/rust-ichibanboshi#205 の 41)。
    // 上流に GET しか無く、判定にも入らない素の観測なので read-only
    "get_dtako_scrape_status",
    // `/cron/dtako` (無人実行) の進捗を DO から直接見るだけ (Refs #205-43)
    "get_dtako_scrape_progress",
    "get_operation_zip",
    "get_rest_diff",
    "get_restraint_summary",
    "get_timecard_diff",
    "get_wage_report",
    "list_companies",
    "list_months",
  ];
  /** 書きうる tool。**scope を要求する** (Refs ohishi-exp/rust-ichibanboshi#205 の 04b / 10)。 */
  const WRITE = {
    run_kintai_relay: "mcp.write",
    run_kintai_recalc: "mcp.write",
    // 拘束サマリの R2 アーカイブ (kintai/ prefix) を書き換えうる (Refs #606-6)
    run_kintai_restraint_sync: "mcp.write",
    // 本番の R2 / DB を書き換えうる (Refs ohishi-exp/rust-ichibanboshi#205 の 42)
    run_dtako_scrape: "mcp.write",
    // dtako_events (と reset_timecard=true なら time_card_dtako) を書き換えうる
    // 取り込み (Refs ohishi-exp/rust-ichibanboshi#280、#205 の 67)
    run_dtako_reimport: "mcp.write",
    // alc (R2 CSV) を書き換えうるアップロード。オンプレは触らない (Refs #633-9)
    run_dtako_alc_upload: "mcp.write",
  } as const;

  it("read-only tool と write tool を取り違えない", () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(
      [...READ_ONLY, ...Object.keys(WRITE)].sort(),
    );
    for (const tool of ALL_TOOLS) {
      if (READ_ONLY.includes(tool.name)) {
        expect(tool.requiresScope, tool.name).toBeUndefined();
        continue;
      }
      // **新しい tool を read-only 側に足したら、ここで気付く**
      expect(tool.requiresScope, tool.name).toBe(WRITE[tool.name as keyof typeof WRITE]);
    }
  });
});
