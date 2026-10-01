import { describe, it, expect } from "vitest";
import {
  gcpOnlyBaseSummaries,
  gcpPartsFor,
  overlayGcpDayTimes,
  parseGcpDaySummaries,
  parseGcpShiftDays,
  parseGcpShiftOverlaps,
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
      withinStatutoryOvertimeMinutes: 0,
    } satisfies GcpDayPart);
  });

  it("法内残業 (within_statutory_overtime_minutes) を読む — 1 勤務はそのまま、同じ暦日の 2 勤務は足す", () => {
    const out = parseGcpDaySummaries({
      summaries: {
        "1078|2026-06-01|2026-06-01 08:00:00": gcpValue({ within_statutory_overtime_minutes: 30 }),
        "1078|2026-06-02|2026-06-02 02:00:00": gcpValue({ within_statutory_overtime_minutes: 30 }),
        "1078|2026-06-02|2026-06-02 14:00:00": gcpValue({ within_statutory_overtime_minutes: 15 }),
      },
    });
    expect(out.get("1078")!.get("2026-06-01")!.withinStatutoryOvertimeMinutes).toBe(30);
    expect(out.get("1078")!.get("2026-06-02")!.withinStatutoryOvertimeMinutes).toBe(45);
  });

  it("法内残業の欄が無い・数でない勤務は 0 ではなく欠測 (null)。同じ暦日に 1 つでも在ればその日は欠測", () => {
    const { within_statutory_overtime_minutes: _dropped, ...withoutField } = gcpValue();
    const out = parseGcpDaySummaries({
      summaries: {
        "1078|2026-06-01|2026-06-01 08:00:00": withoutField,
        "1078|2026-06-02|2026-06-02 08:00:00": gcpValue({ within_statutory_overtime_minutes: "30" }),
        "1078|2026-06-03|2026-06-03 08:00:00": gcpValue({ within_statutory_overtime_minutes: Number.NaN }),
        // 先の勤務が欠測・後の勤務が数
        "1078|2026-06-04|2026-06-04 02:00:00": withoutField,
        "1078|2026-06-04|2026-06-04 14:00:00": gcpValue({ within_statutory_overtime_minutes: 15 }),
        // 先の勤務が数・後の勤務が欠測
        "1078|2026-06-05|2026-06-05 02:00:00": gcpValue({ within_statutory_overtime_minutes: 15 }),
        "1078|2026-06-05|2026-06-05 14:00:00": withoutField,
      },
    });
    const byDate = out.get("1078")!;
    for (const date of ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"]) {
      expect(byDate.get(date)!.withinStatutoryOvertimeMinutes, date).toBeNull();
    }
    // ほかの時間は今までどおり足される (欠測にするのは法内残業だけ)
    expect(byDate.get("2026-06-04")!.workingMinutes).toBe(1200);
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
    ["2026-06-01", { restraintMinutes: 960, workingMinutes: 800, breakMinutes: 160, overtimeMinutes: 300, nightMinutes: 40, overtimeNightMinutes: 20, withinStatutoryOvertimeMinutes: 30 }],
    ["2026-06-07", { restraintMinutes: 300, workingMinutes: 240, breakMinutes: 60, overtimeMinutes: 0, nightMinutes: 0, overtimeNightMinutes: 0, withinStatutoryOvertimeMinutes: 15 }],
    // 対象月の外 (前月から跨いだ勤務) は無視される
    ["2026-05-31", { restraintMinutes: 999, workingMinutes: 999, breakMinutes: 999, overtimeMinutes: 999, nightMinutes: 999, overtimeNightMinutes: 999, withinStatutoryOvertimeMinutes: 999 }],
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
      { day: 1, isRestDay: false, holidayKind: "non_legal", restraintMinutes: 960, workingMinutes: 800, overtimeMinutes: 300, nightMinutes: 40, overtimeNightMinutes: 20, withinStatutoryOvertimeMinutes: 30 },
      // GCP に勤務が無い日は 0 分。isRestDay は元の判定のまま
      { day: 2, isRestDay: false, restraintMinutes: 0, workingMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, overtimeNightMinutes: 0, withinStatutoryOvertimeMinutes: 0 },
      { day: 7, isRestDay: false, holidayKind: "legal", restraintMinutes: 300, workingMinutes: 240, overtimeMinutes: 0, nightMinutes: 0, overtimeNightMinutes: 0, withinStatutoryOvertimeMinutes: 15 },
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

  it("同じ暦日の行が複数あっても GCP 値は 1 回しか割り当てない (日別合計 = 月合計を保つ、Refs #667)", () => {
    // 乗務員CD 1718 / 2026-06 実測: summary.days に同じ暦日 (06-25) が 2 行あり、
    // どちらにも GCP 値を割り当てると日別合計が月合計を超えて「差分」が赤字になった。
    const res = overlayGcpDayTimes(
      summary({ days: [day({ day: 1 }), day({ day: 1, isRestDay: true })] }),
      parts,
      "2026-06",
    );
    expect(res.summary.days).toEqual([
      // 1 行目 (先勝ち) だけが GCP 値を受け取る
      { day: 1, isRestDay: false, restraintMinutes: 960, workingMinutes: 800, overtimeMinutes: 300, nightMinutes: 40, overtimeNightMinutes: 20, withinStatutoryOvertimeMinutes: 30 },
      // 2 行目 (同じ暦日) は「GCP に勤務が無い日」と同じ扱い: 0 分・isRestDay は元のまま
      { day: 1, isRestDay: true, restraintMinutes: 0, workingMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, overtimeNightMinutes: 0, withinStatutoryOvertimeMinutes: 0 },
      { day: 7, isRestDay: false, holidayKind: "legal", restraintMinutes: 300, workingMinutes: 240, overtimeMinutes: 0, nightMinutes: 0, overtimeNightMinutes: 0, withinStatutoryOvertimeMinutes: 15 },
    ]);
    // 不変条件: 日別行の合計 = 月合計 (二重計上されていない)
    const dailySum = (pick: (d: (typeof res.summary.days)[number]) => number | null) =>
      res.summary.days.reduce((acc, d) => acc + (pick(d) ?? 0), 0);
    expect(dailySum((d) => d.workingMinutes)).toBe(res.summary.workingMinutes);
    expect(dailySum((d) => d.restraintMinutes)).toBe(res.summary.restraintMinutes);
    expect(dailySum((d) => d.overtimeMinutes)).toBe(res.summary.overtimeMinutes);
  });

  it("法内残業の欠測 (null) は、既存の行の写しにも新しく足す行にも null のまま載る (0 にしない)", () => {
    const missingParts = new Map<string, GcpDayPart>([
      ["2026-06-01", { ...parts.get("2026-06-01")!, withinStatutoryOvertimeMinutes: null }],
      ["2026-06-02", { ...parts.get("2026-06-01")!, withinStatutoryOvertimeMinutes: null }],
    ]);
    const res = overlayGcpDayTimes(summary({ days: [day({ day: 1 })] }), missingParts, "2026-06");
    expect(res.summary.days.map((d) => [d.day, d.withinStatutoryOvertimeMinutes])).toEqual([
      [1, null],
      [2, null],
    ]);
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

describe("parseGcpShiftOverlaps (勤務の時間帯の重なり、Refs #1123)", () => {
  it("重なり 1 組を 乗務員CD → 組 に直す", () => {
    const out = parseGcpShiftOverlaps({
      month: "2026-06",
      items: [
        {
          driver_cd: 1026,
          a_start: "2026-06-24 08:00:00",
          a_end: "2026-06-24 18:00:00",
          b_start: "2026-06-24 10:00:00",
          b_end: "2026-06-24 20:00:00",
        },
      ],
    });
    expect([...out.entries()]).toEqual([
      [
        "1026",
        [
          {
            aStart: "2026-06-24 08:00:00",
            aEnd: "2026-06-24 18:00:00",
            bStart: "2026-06-24 10:00:00",
            bEnd: "2026-06-24 20:00:00",
          },
        ],
      ],
    ]);
  });

  it("乗務員CD \"01026\" と 1026 は同じ乗務員にまとめ、b の開始 → a の開始の順に並べ直す", () => {
    const pair = (a: string, b: string) => ({
      a_start: `2026-06-${a}:00`,
      a_end: "2026-06-30 00:00:00",
      b_start: `2026-06-${b}:00`,
      b_end: "2026-06-30 01:00:00",
    });
    const out = parseGcpShiftOverlaps({
      items: [
        { driver_cd: "01026", ...pair("20 09:00", "25 10:00") },
        { driver_cd: 1026, ...pair("21 09:00", "24 10:00") },
        { driver_cd: 1026, ...pair("20 09:00", "24 10:00") },
      ],
    });
    expect([...out.keys()]).toEqual(["1026"]);
    expect(out.get("1026")!.map((o) => [o.aStart.slice(8, 16), o.bStart.slice(8, 16)])).toEqual([
      ["20 09:00", "24 10:00"],
      ["21 09:00", "24 10:00"],
      ["20 09:00", "25 10:00"],
    ]);
  });

  it("読めない行は捨て、形の違う応答は空にする", () => {
    for (const body of [null, "x", {}, { items: "x" }, { items: {} }]) {
      expect(parseGcpShiftOverlaps(body).size).toBe(0);
    }
    const ok = {
      a_start: "2026-06-24 08:00:00",
      a_end: "2026-06-24 18:00:00",
      b_start: "2026-06-24 10:00:00",
      b_end: "2026-06-24 20:00:00",
    };
    const out = parseGcpShiftOverlaps({
      items: [
        null,
        "nope",
        { ...ok, driver_cd: 1026, a_start: "2026-06-24T08:00:00" },
        { ...ok, driver_cd: 1026, a_end: "2026-06-24 18:00" },
        { ...ok, driver_cd: 1026, b_start: null },
        { ...ok, driver_cd: 1026, b_end: undefined },
        { ...ok, driver_cd: "abc" },
        { ...ok, driver_cd: 0 },
        { ...ok, driver_cd: true },
        { ...ok, driver_cd: null },
        { ...ok, driver_cd: 1248 },
      ],
    });
    expect([...out.keys()]).toEqual(["1248"]);
    expect(out.get("1248")).toHaveLength(1);
  });
});

describe("gcpOnlyBaseSummaries (元行が無く GCP にだけ勤務がある乗務員の空の元行)", () => {
  // ★ この repo は public。乗務員CD はプレースホルダ
  const parts = parseGcpDaySummaries({
    summaries: {
      "9999|2026-07-06|05:00": gcpValue(),
      "9999|2026-07-07|05:00": gcpValue(),
      "9998|2026-07-06|05:00": gcpValue(),
      // 前月の勤務だけの乗務員 (当月は 0 日)
      "9997|2026-06-30|05:00": gcpValue(),
    },
  });

  it("★ 合流後のサマリに居ない乗務員だけを返す (居る乗務員は返さない = 陰性対照)", () => {
    const out = gcpOnlyBaseSummaries(parts, "2026-07", ["9998"], new Map());
    expect(out.map((s) => s.driverCd)).toEqual(["9999"]);
  });

  it("当月に勤務が無い乗務員は返さない", () => {
    expect(gcpOnlyBaseSummaries(parts, "2026-07", [], new Map()).map((s) => s.driverCd)).toEqual(["9998", "9999"]);
  });

  it("乗務員CD は数値で揃えて比べる (前ゼロ付きの既存行とも一致)", () => {
    expect(gcpOnlyBaseSummaries(parts, "2026-07", ["09999", "9998"], new Map())).toEqual([]);
  });

  it("氏名は社員マスタ、無ければ空。workDays は当月の勤務日数で、時間は空 (overlay で入れる)", () => {
    const [s9998, s9999] = gcpOnlyBaseSummaries(parts, "2026-07", [], new Map([["9999", "テスト 太郎"]]));
    expect(s9999).toMatchObject({ driverCd: "9999", driverName: "テスト 太郎", workDays: 2, restDays: 0, restraintMinutes: null, days: [] });
    expect(s9998).toMatchObject({ driverCd: "9998", driverName: "", workDays: 1 });
  });

  it("★ overlayGcpDayTimes を掛けると GCP の時間で埋まる (欠測にならない)", () => {
    const [base] = gcpOnlyBaseSummaries(parts, "2026-07", ["9998"], new Map());
    const { summary, missing } = overlayGcpDayTimes(base!, gcpPartsFor(parts, "9999"), "2026-07");
    expect(missing).toBe(false);
    expect(summary.restraintMinutes).toBe(1440);
    expect(summary.days.map((d) => d.day)).toEqual([6, 7]);
  });
});

describe("parseGcpShiftDays (勤務ごとの始業・終業・実働でない区間、Refs #1133 c1133-40)", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    start_at: "2026-04-03 22:10:00",
    end_at: "2026-04-04 09:05:00",
    shift_source: "timecard",
    summary: { restraint_minutes: 655, working_minutes: 595 },
    non_working: [{ start: "2026-04-04 02:00:00", end: "2026-04-04 03:00:00", kind: "break_event" }],
    parts: [{ date: "2026-04-03", restraint_minutes: 110 }],
    ...over,
  });
  const body = (...items: unknown[]) => ({ month: "2026-04", driver_cd: 9001, items });

  it("始業・終業・実働でない区間を応答の値のまま取り出す (kind も落とさない)", () => {
    expect(parseGcpShiftDays(body(item()))).toEqual([
      {
        start: "2026-04-03 22:10:00",
        end: "2026-04-04 09:05:00",
        nonWorking: [{ start: "2026-04-04 02:00:00", end: "2026-04-04 03:00:00", kind: "break_event" }],
      },
    ]);
  });

  it("non_working の [] (区間なし) と null (まだ畳み直していない) を区別して残す", () => {
    const got = parseGcpShiftDays(
      body(item({ non_working: [] }), item({ start_at: "2026-04-05 08:00:00", end_at: "2026-04-05 17:00:00", non_working: null })),
    );
    expect(got?.map((s) => s.nonWorking)).toEqual([[], null]);
  });

  it("上流の並びのまま返す (並べ替えない)。items が空なら空の配列", () => {
    const later = item({ start_at: "2026-04-09 08:00:00", end_at: "2026-04-09 17:00:00" });
    expect(parseGcpShiftDays(body(later, item()))?.map((s) => s.start)).toEqual([
      "2026-04-09 08:00:00",
      "2026-04-03 22:10:00",
    ]);
    expect(parseGcpShiftDays(body())).toEqual([]);
  });

  it.each([
    ["応答が object でない", "boom"],
    ["応答が null", null],
    ["items が無い", { month: "2026-04" }],
    ["items が配列でない", { items: {} }],
    ["要素が object でない", body("x")],
    ["要素が null", body(null)],
    ["start_at が無い", body(item({ start_at: undefined }))],
    ["start_at の形が違う", body(item({ start_at: "2026-04-03T22:10:00" }))],
    ["end_at が文字列でない", body(item({ end_at: 5 }))],
    ["end_at の形が違う", body(item({ end_at: "2026-04-04" }))],
    ["non_working が無い (null でも配列でもない)", body(item({ non_working: undefined }))],
    ["non_working が配列でない", body(item({ non_working: "none" }))],
    ["non_working の要素が object でない", body(item({ non_working: ["x"] }))],
    ["non_working の要素が null", body(item({ non_working: [null] }))],
    ["non_working の要素の start が無い", body(item({ non_working: [{ end: "2026-04-04 03:00:00" }] }))],
    ["non_working の要素の end の形が違う", body(item({ non_working: [{ start: "2026-04-04 02:00:00", end: "03:00" }] }))],
  ])("形の合わない応答は null (行を捨てて続けない): %s", (_label, raw) => {
    expect(parseGcpShiftDays(raw)).toBeNull();
  });

  it("形の合わない勤務が 1 本でも在れば、ほかが正しくても null", () => {
    expect(parseGcpShiftDays(body(item(), item({ end_at: "" })))).toBeNull();
  });
});
