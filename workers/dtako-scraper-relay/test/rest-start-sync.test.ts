import { describe, expect, it } from "vitest";
import {
  alcEventsRange,
  shiftRests,
  kintaiRows,
  pickRestStartCandidates,
  restStartOverride,
  startOpeFromUnkoNo,
  theearthReportRows,
  theearthRows,
} from "../src/rest-start-sync";
import type { RestraintDayRow, RestraintDriverBlock, RestraintReport } from "../src/theearth-restraint-client";

const HEADER = ["日付", "始業時刻", "終業時刻", "拘束時間小計", "実働時間"];

function day(dayNo: number | null, start: string, subtotal: string, working: number | null, isRestDay = false): RestraintDayRow {
  return {
    date: `6月${dayNo}日`,
    day: dayNo,
    isRestDay,
    startTime: start,
    endTime: "",
    drivingMinutes: null,
    loadingMinutes: null,
    breakMinutes: null,
    restraintMinutes: null,
    restraintCumulativeMinutes: null,
    restMinutes: null,
    workingMinutes: working,
    overtimeMinutes: null,
    nightMinutes: null,
    overtimeNightMinutes: null,
    avgDrivingBeforeMinutes: null,
    avgDrivingAfterMinutes: null,
    notes: [],
    columns: [`6月${dayNo}日`, start, "", subtotal, ""],
  };
}

function block(driverCd: string, days: RestraintDayRow[]): RestraintDriverBlock {
  return {
    branchName: "本社",
    categories: {},
    driverName: "x",
    driverCd,
    header: HEADER,
    days,
    totals: null,
    fiscalCumulativeMinutes: null,
    fiscalLimitHours: null,
  };
}

describe("theearthRows", () => {
  it("拘束は拘束時間小計・始業は行の日の HH:MM。休日・日の無い行・読めない値は落とす", () => {
    const rows = theearthRows(
      block("6", [
        day(17, "11:25", "8:27", 427),
        day(8, "2:29", "6:59", 356),
        day(7, "", "", null, true),
        day(null, "1:00", "1:00", 60),
        day(9, "1:00", "", 60),
        day(10, "x", "1:00", 60),
        day(11, "1:00", "1:00", null),
      ]),
      2026,
      6,
    );
    expect(rows).toEqual([
      { driverCd: "6", start: "2026-06-17 11:25", restraint: 507, working: 427 },
      { driverCd: "6", start: "2026-06-08 02:29", restraint: 419, working: 356 },
    ]);
  });

  it("拘束時間小計の列が無いヘッダなら行を作らない", () => {
    const b = { ...block("6", [day(17, "11:25", "8:27", 427)]), header: ["日付", "始業時刻"] };
    expect(theearthRows(b, 2026, 6)).toEqual([]);
  });

  it("管理表全員ぶん", () => {
    const report = { year: 2026, month: 7, drivers: [block("11", [day(17, "5:17", "12:24", 680)]), block("12", [])] };
    expect(theearthReportRows(report as unknown as RestraintReport)).toEqual([
      { driverCd: "11", start: "2026-07-17 05:17", restraint: 744, working: 680 },
    ]);
  });
});

describe("kintaiRows", () => {
  it("鍵の開始時刻を分まで。拘束・実働が数でない行と、本文の形が違うものは落とす", () => {
    const body = {
      summaries: {
        "6|2026-06-17|2026-06-17 11:25:00": { restraint_minutes: 508, working_minutes: 428 },
        "6|2026-06-18|": { restraint_minutes: 1, working_minutes: 1 },
        "6|2026-06-19|2026-06-19 05:20:00": { restraint_minutes: "x", working_minutes: 1 },
        "6|2026-06-20|2026-06-20 05:20:00": { restraint_minutes: 1 },
        "6|2026-06-21|2026-06-21 05:20:00": null,
      },
    };
    expect(kintaiRows(body)).toEqual([{ driverCd: "6", start: "2026-06-17 11:25", restraint: 508, working: 428 }]);
    expect(kintaiRows({})).toEqual([]);
    expect(kintaiRows(null)).toEqual([]);
    expect(kintaiRows({ summaries: "x" })).toEqual([]);
  });
});

describe("pickRestStartCandidates", () => {
  it("同じ乗務員・同じ始業で、拘束も実働もちょうど +1 分のものだけ (乗務員・始業の順)", () => {
    const t = [
      { driverCd: "11", start: "2026-07-17 05:17", restraint: 744, working: 680 },
      { driverCd: "6", start: "2026-06-17 11:25", restraint: 507, working: 427 },
      { driverCd: "6", start: "2026-06-01 03:56", restraint: 861, working: 747 },
      { driverCd: "6", start: "2026-06-02 03:59", restraint: 704, working: 656 },
      { driverCd: "6", start: "2026-06-03 04:25", restraint: 588, working: 303 },
      { driverCd: "6", start: "2026-06-04 04:03", restraint: 577, working: 469 },
    ];
    const k = [
      { driverCd: "6", start: "2026-06-17 11:25", restraint: 508, working: 428 },
      { driverCd: "11", start: "2026-07-17 05:17", restraint: 745, working: 681 },
      { driverCd: "6", start: "2026-06-01 03:56", restraint: 861, working: 747 }, // 差なし
      { driverCd: "6", start: "2026-06-02 03:59", restraint: 705, working: 656 }, // 実働は同じ
      { driverCd: "6", start: "2026-06-03 04:25", restraint: 590, working: 305 }, // +2
      // 6/4 は勤怠側に無い
    ];
    expect(pickRestStartCandidates(t, k)).toEqual([
      { driverCd: "6", start: "2026-06-17 11:25", theearth: { restraint: 507, working: 427 }, kintai: { restraint: 508, working: 428 } },
      { driverCd: "11", start: "2026-07-17 05:17", theearth: { restraint: 744, working: 680 }, kintai: { restraint: 745, working: 681 } },
    ]);
    // 同じ乗務員の中は始業の順
    const two = pickRestStartCandidates(
      [
        { driverCd: "6", start: "2026-06-20 00:00", restraint: 1, working: 1 },
        { driverCd: "6", start: "2026-06-10 00:00", restraint: 1, working: 1 },
      ],
      [
        { driverCd: "6", start: "2026-06-20 00:00", restraint: 2, working: 2 },
        { driverCd: "6", start: "2026-06-10 00:00", restraint: 2, working: 2 },
      ],
    );
    expect(two.map((c) => c.start)).toEqual(["2026-06-10 00:00", "2026-06-20 00:00"]);
  });
});

describe("shiftRests", () => {
  const UNKO = "2607150330460000000233";
  // 北海 7/17 乗務員 11 の形: 分割休息 16:46:09 と、勤務を締める休息 7/18 02:26:53
  const body = {
    shifts: [
      { start: "2026-07-17 05:17:00", end: "2026-07-18 02:26:00" },
      { start: "2026-07-19 05:20:00" },
    ],
    events: [
      { datetime: "2026-07-18 02:26:53", state: "休息", unko_no: UNKO },
      { datetime: "2026-07-17 16:20:26", state: "運転", unko_no: UNKO },
      { datetime: "2026-07-17 16:46:09", state: "休息", unko_no: UNKO },
      { datetime: "2026-07-17 05:17:00", state: "休息", unko_no: UNKO }, // 始業の分 (勤務の前の休息の続き) は入れない
      { datetime: "2026-07-18 02:27:00", state: "休息", unko_no: UNKO }, // 勤務の終わりの分より後
      { datetime: "2026-07-17 10:00:00", state: "休息", unko_no: null }, // 運行NO が無い
      { state: "休息", unko_no: UNKO }, // 時刻が無い
    ],
  };
  it("始業より後・勤務の終わりの分以前の休息を時刻順に (分割休息も入る)", () => {
    expect(shiftRests(body, "2026-07-17 05:17")).toEqual([
      { restStart: "2026-07-17 16:46:09", unkoNo: UNKO },
      { restStart: "2026-07-18 02:26:53", unkoNo: UNKO },
    ]);
  });
  it("勤務が無い・終わりが無い・本文の形が違えば空", () => {
    expect(shiftRests(body, "2026-07-16 00:00")).toEqual([]);
    expect(shiftRests(body, "2026-07-19 05:20")).toEqual([]);
    expect(shiftRests({}, "2026-07-17 05:17")).toEqual([]);
    expect(shiftRests(null, "2026-07-17 05:17")).toEqual([]);
    expect(shiftRests({ shifts: [{ start: "2026-07-17 05:17:00", end: "2026-07-18 02:26:00" }] }, "2026-07-17 05:17")).toEqual([]);
  });
  it("補正済みの休息は補正後の時刻で勤務の内外を見て、元の時刻を返す (書き直せる)", () => {
    // 北海 10/11 乗務員 9 の形: 補正 08:39:42 → 08:38:54 を書いた後、勤務は 08:38 で終わるが行は 08:39:42 のまま
    const unko = "2610081322520000000250";
    const applied = {
      shifts: [{ start: "2026-10-10 21:01:00", end: "2026-10-11 08:38:00" }],
      events: [
        { datetime: "2026-10-11 08:39:42", state: "休息", unko_no: unko },
        { datetime: "2026-10-11 08:40:00", state: "休息", unko_no: unko }, // 補正の無い行は元の時刻で見る
      ],
      rest_start_overrides: [{ rest_start_at: "2026-10-11 08:39:42", last_move_at: "2026-10-11 08:38:54" }],
    };
    expect(shiftRests(applied, "2026-10-10 21:01")).toEqual([{ restStart: "2026-10-11 08:39:42", unkoNo: unko }]);
  });
});

describe("startOpeFromUnkoNo / restStartOverride / alcEventsRange", () => {
  it("運行NO の先頭 12 桁が出庫", () => {
    expect(startOpeFromUnkoNo("2607150330460000000233")).toBe("2026/07/15 3:30:46");
    expect(startOpeFromUnkoNo("2606171125560000000237")).toBe("2026/06/17 11:25:56");
  });
  it("最後の動きが無い・同じ分なら補正しない", () => {
    const rest = { restStart: "2026-07-17 16:46:09", unkoNo: "2607150330460000000233" };
    expect(restStartOverride("11", rest, "2026-07-17 16:45:46")).toEqual({
      driver_cd: 11,
      rest_start_at: "2026-07-17 16:46:09",
      last_move_at: "2026-07-17 16:45:46",
      unko_no: "2607150330460000000233",
    });
    expect(restStartOverride("11", rest, "2026-07-17 16:46:01")).toBeNull();
    expect(restStartOverride("11", rest, null)).toBeNull();
  });
  it("月の前後 2 日 (年をまたぐ月も)", () => {
    expect(alcEventsRange("2026-06")).toEqual({ from: "2026-05-30", to: "2026-07-02" });
    expect(alcEventsRange("2026-12")).toEqual({ from: "2026-11-29", to: "2027-01-02" });
  });
});
