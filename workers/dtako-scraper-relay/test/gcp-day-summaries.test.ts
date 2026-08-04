import { describe, it, expect } from "vitest";
import {
  gcpPartsFor,
  overlayGcpDayTimes,
  parseGcpDaySummaries,
  type GcpDayPart,
} from "../src/gcp-day-summaries";
import type { RestraintDriverSummary, RestraintSummaryDay } from "../src/theearth-restraint-client";

/** GCP `day_summaries` の 1 行 (`kintai-diff.test.ts` の GCP_VALUE と同じ列)。 */
function gcpValue(over: Record<string, unknown> = {}) {
  return {
    shift_source: "dtako",
    restraint_minutes: 720,
    working_minutes: 600,
    break_minutes: 120,
    rest_minus_minutes: 0,
    statutory_minutes: 480,
    within_statutory_overtime_minutes: 0,
    overtime_minutes: 120,
    legal_holiday_minutes: 0,
    night_minutes: 30,
    overtime_night_minutes: 20,
    legal_holiday_night_minutes: 10,
    ...over,
  };
}

function summary(over: Partial<RestraintDriverSummary> = {}): RestraintDriverSummary {
  return {
    driverCd: "1078",
    driverName: "テスト 乗務員",
    branchName: "本社",
    workDays: 1,
    restDays: 0,
    restraintMinutes: 999,
    drivingMinutes: 400,
    loadingMinutes: 50,
    breakMinutes: 60,
    workingMinutes: 888,
    overtimeMinutes: 111,
    nightMinutes: 22,
    overtimeNightMinutes: 11,
    maxDailyRestraintMinutes: 999,
    fiscalCumulativeMinutes: 12345,
    restraintLimitMinutes: null,
    excessRestraintMinutes: null,
    over15hDays: 3,
    avgDriving9hOverCount: 2,
    days: [],
    ...over,
  };
}

function day(over: Partial<RestraintSummaryDay> = {}): RestraintSummaryDay {
  return {
    day: 1,
    isRestDay: false,
    restraintMinutes: 100,
    workingMinutes: 90,
    overtimeMinutes: 10,
    nightMinutes: 5,
    overtimeNightMinutes: 1,
    ...over,
  };
}

describe("parseGcpDaySummaries", () => {
  it("`乗務員CD|暦日|開始時刻` を 乗務員CD → 暦日 に畳み、内数の時間外深夜を時間外から引く", () => {
    const out = parseGcpDaySummaries({
      month: "2026-06",
      summaries: { "1078|2026-06-01|2026-06-01 08:00:00": gcpValue() },
    });
    expect(out.get("1078")!.get("2026-06-01")).toEqual({
      restraintMinutes: 720,
      workingMinutes: 600,
      breakMinutes: 120,
      // 120 − 20 (内数の時間外深夜)
      overtimeMinutes: 100,
      // 30 + 10 (法定休日深夜も足す)
      nightMinutes: 40,
      overtimeNightMinutes: 20,
    } satisfies GcpDayPart);
  });

  it("同じ暦日に複数の勤務があれば足し合わせる", () => {
    const out = parseGcpDaySummaries({
      summaries: {
        "1078|2026-06-01|2026-06-01 02:00:00": gcpValue({ restraint_minutes: 100, break_minutes: 10 }),
        "1078|2026-06-01|2026-06-01 14:00:00": gcpValue({ restraint_minutes: 200, break_minutes: 20 }),
      },
    });
    const part = out.get("1078")!.get("2026-06-01")!;
    expect(part.restraintMinutes).toBe(300);
    expect(part.breakMinutes).toBe(30);
    expect(part.workingMinutes).toBe(1200);
    expect(part.overtimeMinutes).toBe(200);
    expect(part.nightMinutes).toBe(80);
    expect(part.overtimeNightMinutes).toBe(40);
  });

  it("乗務員CD は数値正規化する (先頭 0 付きも同じ人に畳む)", () => {
    const out = parseGcpDaySummaries({
      summaries: {
        "01078|2026-06-01|2026-06-01 08:00:00": gcpValue({ restraint_minutes: 60 }),
        "1078|2026-06-02|2026-06-02 08:00:00": gcpValue({ restraint_minutes: 90 }),
      },
    });
    expect([...out.keys()]).toEqual(["1078"]);
    expect(out.get("1078")!.size).toBe(2);
  });

  it("上流が壊れた値 (内数 > 全体、数値でない) を返しても 0 未満にしない", () => {
    const out = parseGcpDaySummaries({
      summaries: {
        "1078|2026-06-01|2026-06-01 08:00:00": gcpValue({
          overtime_minutes: 10,
          overtime_night_minutes: 60,
          restraint_minutes: "720",
          working_minutes: Number.NaN,
        }),
      },
    });
    const part = out.get("1078")!.get("2026-06-01")!;
    expect(part.overtimeMinutes).toBe(0);
    expect(part.restraintMinutes).toBe(0);
    expect(part.workingMinutes).toBe(0);
  });

  it("読めない body / summaries は空 Map", () => {
    expect(parseGcpDaySummaries(null).size).toBe(0);
    expect(parseGcpDaySummaries("nope").size).toBe(0);
    expect(parseGcpDaySummaries({}).size).toBe(0);
    expect(parseGcpDaySummaries({ summaries: null }).size).toBe(0);
    expect(parseGcpDaySummaries({ summaries: "nope" }).size).toBe(0);
    expect(parseGcpDaySummaries({ summaries: [] }).size).toBe(0);
  });

  it("値が object でない / 暦日が YYYY-MM-DD でない / 乗務員CD が数値でない・0 の行は捨てる", () => {
    const out = parseGcpDaySummaries({
      summaries: {
        "1078|2026-06-01|2026-06-01 08:00:00": null,
        "1078|2026-06-01|2026-06-01 09:00:00": "nope",
        nokey: gcpValue(),
        "1078|20260601|2026-06-01 08:00:00": gcpValue(),
        "abc|2026-06-01|2026-06-01 08:00:00": gcpValue(),
        "0|2026-06-01|2026-06-01 08:00:00": gcpValue(),
      },
    });
    expect(out.size).toBe(0);
  });
});

describe("gcpPartsFor", () => {
  const byDriver = new Map([["1078", new Map<string, GcpDayPart>()]]);

  it("両側を数値正規化して引く", () => {
    expect(gcpPartsFor(byDriver, "01078")).toBe(byDriver.get("1078"));
  });

  it("居ない乗務員 / 数値でない乗務員CD は null", () => {
    expect(gcpPartsFor(byDriver, "1079")).toBeNull();
    expect(gcpPartsFor(byDriver, "abc")).toBeNull();
  });
});

describe("overlayGcpDayTimes", () => {
  const parts = new Map<string, GcpDayPart>([
    // 2026-06-01 は月曜、2026-06-07 は日曜
    ["2026-06-01", { restraintMinutes: 960, workingMinutes: 800, breakMinutes: 160, overtimeMinutes: 300, nightMinutes: 40, overtimeNightMinutes: 20 }],
    ["2026-06-07", { restraintMinutes: 300, workingMinutes: 240, breakMinutes: 60, overtimeMinutes: 0, nightMinutes: 0, overtimeNightMinutes: 0 }],
    // 対象月の外 (前月から跨いだ勤務) は無視される
    ["2026-05-31", { restraintMinutes: 999, workingMinutes: 999, breakMinutes: 999, overtimeMinutes: 999, nightMinutes: 999, overtimeNightMinutes: 999 }],
  ]);

  it("既存の日は時間だけ差し替え、無い日は行を足す (日曜だけ法定休日)", () => {
    const res = overlayGcpDayTimes(
      summary({ days: [day({ day: 1, holidayKind: "non_legal" }), day({ day: 2 })] }),
      parts,
      "2026-06",
    );
    expect(res.missing).toBe(false);
    expect(res.summary.days).toEqual([
      // 休日区分は元のまま (GCP は持たない)。勤務があるので isRestDay は false
      { day: 1, isRestDay: false, holidayKind: "non_legal", restraintMinutes: 960, workingMinutes: 800, overtimeMinutes: 300, nightMinutes: 40, overtimeNightMinutes: 20 },
      // GCP に勤務が無い日は 0 分。isRestDay は元の判定のまま
      { day: 2, isRestDay: false, restraintMinutes: 0, workingMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, overtimeNightMinutes: 0 },
      { day: 7, isRestDay: false, holidayKind: "legal", restraintMinutes: 300, workingMinutes: 240, overtimeMinutes: 0, nightMinutes: 0, overtimeNightMinutes: 0 },
    ]);
  });

  it("元の日別行に無い平日は holidayKind: weekday で足す", () => {
    const res = overlayGcpDayTimes(summary(), parts, "2026-06");
    expect(res.summary.days.map((d) => [d.day, d.holidayKind])).toEqual([[1, "weekday"], [7, "legal"]]);
  });

  it("GCP に勤務がある日は休み判定を上書きする", () => {
    const res = overlayGcpDayTimes(summary({ days: [day({ day: 1, isRestDay: true })] }), parts, "2026-06");
    expect(res.summary.days[0]!.isRestDay).toBe(false);
  });

  it("月合計を GCP の暦日から数え直す (対象月の外は入れない)", () => {
    const res = overlayGcpDayTimes(summary(), parts, "2026-06");
    expect(res.summary).toMatchObject({
      restraintMinutes: 1260,
      workingMinutes: 1040,
      breakMinutes: 220,
      overtimeMinutes: 300,
      nightMinutes: 40,
      overtimeNightMinutes: 20,
      maxDailyRestraintMinutes: 960,
      over15hDays: 1,
      excessRestraintMinutes: null,
    });
  });

  it("拘束上限が引けている月は超過分も数え直す", () => {
    const res = overlayGcpDayTimes(summary({ restraintLimitMinutes: 1000 }), parts, "2026-06");
    expect(res.summary.excessRestraintMinutes).toBe(260);
  });

  it("デジタコ側にしか無い項目 (運転・荷役・年度累計・平均運転9h超) は残す", () => {
    const res = overlayGcpDayTimes(summary(), parts, "2026-06");
    expect(res.summary).toMatchObject({
      drivingMinutes: 400,
      loadingMinutes: 50,
      fiscalCumulativeMinutes: 12345,
      avgDriving9hOverCount: 2,
      workDays: 1,
      restDays: 0,
    });
  });

  it("GCP に行が無い乗務員は 0 分ではなく欠測にする (最低賃金割れの判定を回さない)", () => {
    for (const p of [null, new Map<string, GcpDayPart>(), parts]) {
      const res = overlayGcpDayTimes(summary({ days: [day()] }), p, "2026-07");
      expect(res.missing).toBe(true);
      expect(res.summary).toMatchObject({
        restraintMinutes: null,
        workingMinutes: null,
        breakMinutes: null,
        overtimeMinutes: null,
        nightMinutes: null,
        overtimeNightMinutes: null,
        maxDailyRestraintMinutes: null,
        excessRestraintMinutes: null,
        over15hDays: 0,
        days: [],
      });
    }
  });
});
