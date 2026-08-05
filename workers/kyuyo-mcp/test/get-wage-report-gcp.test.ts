/**
 * `get_wage_report` の `source` 引数 (Refs #675)。
 *
 * 既定は **`gcp`** — 最低賃金チェック画面 (`restraint-wage.vue` の
 * `minWageRestraintSource`) の既定と揃える。揃っていないと同じ会社・月・乗務員で
 * MCP と画面が違う数字を返し、MCP を根拠に判断できない (1442 の 2026-06 で
 * 実働 231h58m vs 217h44m の食い違いが出た)。
 *
 * R2 直読み経路 (`source: "current"`) の検証は `test/mcp/tools.test.ts` 側。
 */
import { describe, it, expect, vi } from "vitest";
import { getWageReportTool } from "../src/mcp/tools";
import { createMockR2, type MockR2Entry } from "./helpers/mock-r2";
import type { Env } from "../src/env";
import type {
  RestraintDriverSummary,
  RestraintSummaryDay,
} from "../../dtako-scraper-relay/src/theearth-restraint-client";

const SECRET = "internal-shared-secret";

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
    driverCd: "1442",
    driverName: "試験　太郎",
    branchName: "テスト運輸　本社営業所",
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
    days: [day(1), day(2)],
    ...over,
  };
}

/** 受け側 (`/kintai-relay/day-summaries`) の応答形。キーは `乗務員CD|暦日|開始時刻`。 */
function gcpBody(month: string, driverCd = "1442") {
  return {
    month,
    rows: 1,
    summaries: {
      [`${driverCd}|${month}-01|${month}-01 08:00:00`]: {
        shift_source: "punch",
        restraint_minutes: 720,
        working_minutes: 600,
        break_minutes: 120,
        overtime_minutes: 120,
        night_minutes: 60,
        overtime_night_minutes: 30,
      },
    },
  };
}

const R2_ENTRIES: Record<string, MockR2Entry> = {
  "restraint/0100/2026-06/summary/1442/latest.json": { value: JSON.stringify(summary()) },
  "restraint/0100/2026-05/summary/1442/latest.json": { value: JSON.stringify(summary()) },
};

function env(over: Partial<Record<string, unknown>> = {}, entries = R2_ENTRIES): Env {
  return {
    DTAKO_R2: createMockR2(entries),
    RESTRAINT_R2_PREFIX: "restraint",
    AUTH_WORKER_ORIGIN: "https://auth-staging.ippoan.org",
    SCRAPER_RELAY: {
      fetch: vi.fn(async (url: string, _init?: RequestInit) => {
        const month = new URL(url).searchParams.get("month")!;
        return new Response(JSON.stringify(gcpBody(month)));
      }),
    },
    INTERNAL_SHARED_SECRET: SECRET,
    ...over,
  } as unknown as Env;
}

const relayFetch = (e: Env) => (e.SCRAPER_RELAY as { fetch: ReturnType<typeof vi.fn> }).fetch;

type WageReportResult = {
  month: string;
  restraint_source: string;
  rows: Array<{
    summary: RestraintDriverSummary;
    restraint_missing?: boolean;
    wage: { minutes: Record<string, number> };
  }>;
};

const run = (e: Env, args: { company: string; month: string; source?: "current" | "gcp" }) =>
  getWageReportTool.execute(e, args) as Promise<WageReportResult>;

describe("get_wage_report の source 引数 (Refs #675)", () => {
  it("source を省略すると gcp になる (画面の既定と同じ)", async () => {
    const e = env();
    const res = await run(e, { company: "0100", month: "2026-06" });
    expect(res.restraint_source).toBe("gcp");
    expect(relayFetch(e)).toHaveBeenCalled();
  });

  it("source: 'current' なら relay を一切叩かない (従来どおり R2 直読み)", async () => {
    const e = env();
    const res = await run(e, { company: "0100", month: "2026-06", source: "current" });
    expect(res.restraint_source).toBe("current");
    expect(relayFetch(e)).not.toHaveBeenCalled();
    // 既定経路では欠測フラグを立てない (応答の形を変えない)
    expect(res.rows[0]!.restraint_missing).toBeUndefined();
    // days は落とさない
    expect(res.rows[0]!.summary.days).toHaveLength(2);
  });

  it("**当月と前月の両方**を取りに行く — 片方だけだと跨ぎ週で 2 ソースが混ざる", async () => {
    const e = env();
    await run(e, { company: "0100", month: "2026-06" });
    const months = relayFetch(e).mock.calls.map((c) => new URL(c[0] as string).searchParams.get("month"));
    expect(months.sort()).toEqual(["2026-05", "2026-06"]);
  });

  it("GCP の分数で計算し直す (R2 の日別値では計算しない)", async () => {
    const res = await run(env(), { company: "0100", month: "2026-06" });
    const m = res.rows[0]!.wage.minutes;
    // 1 日ぶん: 実働 600 / 時間外 120 のうち深夜に重なる 30 は overtimeNight へ
    expect(m.overtime).toBe(90);
    expect(m.overtimeNight).toBe(30);
    expect(m.night).toBe(60);
    expect(m.statutory).toBe(600 - 90 - 30);
  });

  it("source: 'gcp' では日別行を落とす (計算は days を使い切った後なので数字は変わらない)", async () => {
    const res = await run(env(), { company: "0100", month: "2026-06" });
    expect(res.rows[0]!.summary.days).toEqual([]);
    // days を落としても賃金は算出されている
    expect(res.rows[0]!.wage.minutes.statutory).toBeGreaterThan(0);
  });

  it("GCP 側にその乗務員の行が無ければ restraint_missing を立てる (0 分ではない)", async () => {
    const e = env({
      SCRAPER_RELAY: {
        // 別人 (9999) の行しか返さない = 1442 は欠測
        fetch: vi.fn(async (url: string) => {
          const month = new URL(url).searchParams.get("month")!;
          return new Response(JSON.stringify(gcpBody(month, "9999")));
        }),
      },
    });
    const res = await run(e, { company: "0100", month: "2026-06" });
    expect(res.rows[0]!.restraint_missing).toBe(true);
  });

  it("relay binding / secret が無ければ fail-closed", async () => {
    await expect(run(env({ SCRAPER_RELAY: undefined }), { company: "0100", month: "2026-06" }))
      .rejects.toThrow(/SCRAPER_RELAY/);
    await expect(run(env({ INTERNAL_SHARED_SECRET: "" }), { company: "0100", month: "2026-06" }))
      .rejects.toThrow(/INTERNAL_SHARED_SECRET/);
  });

  it("relay が非 200 を返したら握り潰さず throw する", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("nope", { status: 502 })) },
    });
    await expect(run(e, { company: "0100", month: "2026-06" })).rejects.toThrow(/502/);
  });

  it("relay の応答が JSON でなければ throw する", async () => {
    const e = env({
      SCRAPER_RELAY: { fetch: vi.fn(async () => new Response("<html>not json</html>")) },
    });
    await expect(run(e, { company: "0100", month: "2026-06" })).rejects.toThrow(/parse failed/);
  });

  it("month が不正なら source に関わらず relay を叩く前に throw する", async () => {
    const e = env();
    await expect(run(e, { company: "0100", month: "2026-13" })).rejects.toThrow();
    expect(relayFetch(e)).not.toHaveBeenCalled();
  });

  it("secret binding が Secrets Store 形 ({get()}) でも解決でき、共有シークレットを載せる", async () => {
    const e = env({ INTERNAL_SHARED_SECRET: { get: async () => SECRET } });
    const res = await run(e, { company: "0100", month: "2026-06" });
    expect(res.restraint_source).toBe("gcp");
    const init = relayFetch(e).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["X-Alc-Proxy-Secret"]).toBe(SECRET);
  });
});
