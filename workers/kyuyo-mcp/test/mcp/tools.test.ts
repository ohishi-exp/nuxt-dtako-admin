import { describe, it, expect } from "vitest";
import {
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

describe("getWageReportTool", () => {
  it("computes a wage row per driver using empty (fallback) masters when none archived", async () => {
    const env = makeEnv({
      "restraint/0100/2026-07/summary/1/latest.json": {
        value: JSON.stringify(summary({ driverCd: "1", days: [day(1), day(2)] })),
      },
    });
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-07" })) as {
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
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-07" })) as {
      warnings: string[];
    };
    expect(res.warnings).toEqual([]);
  });

  it("handles the January → previous-December rollover for prevYm", async () => {
    const env = makeEnv({
      "restraint/0100/2026-01/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
      "restraint/0100/2025-12/summary/1/latest.json": { value: JSON.stringify(summary({ driverCd: "1" })) },
    });
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-01" })) as {
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
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-07" })) as {
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
    const res = (await getWageReportTool.execute(env, { company: "0100", month: "2026-07" })) as {
      rows: unknown[];
    };
    expect(res.rows).toHaveLength(1);
  });
});

describe("ALL_TOOLS", () => {
  it("registers exactly the 4 read-only tools, none requiring a scope", () => {
    expect(ALL_TOOLS.map((t) => t.name).sort()).toEqual(
      ["get_restraint_summary", "get_wage_report", "list_companies", "list_months"].sort(),
    );
    for (const tool of ALL_TOOLS) {
      expect(tool.requiresScope).toBeUndefined();
    }
  });
});
