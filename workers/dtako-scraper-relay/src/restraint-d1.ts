// 拘束サマリの D1 写し (Refs #452 PR-A)。
//
// wage-report の R2 GET fan-out (約300本) を無くすため、summary latest.json と
// 同内容を D1 (restraint_driver_month + restraint_daily) にも書く。R2 は原本
// (CSV・版・履歴) の保管庫として残し、D1 は常に「latest の写し」に保つ —
// putVersionedR2 の結果 (sha256 / fetchedAt / lastVerifiedAt) をそのまま反映する。
//
// このモジュールは pure (cloudflare 非依存): 変換とステートメント構築だけを持ち、
// 実行 (db.batch) は DO 側。round-trip (summary → 行 → summary) が恒等であることを
// テストで固定し、読み取り切替 (PR-C) 時の欠損を防ぐ。

import type {
  RestraintDriverSummary,
  RestraintHolidayKind,
  RestraintSummaryDay,
} from "./theearth-restraint-client";
import type {
  TimecardDriverSummary,
  TimecardLeaveCounts,
  TimecardSession,
  TimecardSummaryDay,
  WageReportSource,
} from "./timecard-summary";

export interface D1Statement {
  sql: string;
  params: Array<string | number | null>;
}

/** R2 latest との同期メタ (putVersionedR2 の customMetadata と同値)。 */
export interface RestraintSummaryMeta {
  sha256: string;
  fetchedAt: string;
  lastVerifiedAt: string;
}

/** 書き込み 1 件 — サマリ本体 or noData マーカー (Refs #241)。 */
export type RestraintD1Entry =
  | { kind: "summary"; summary: RestraintDriverSummary; meta: RestraintSummaryMeta }
  | { kind: "no-data"; driverCd: string; meta: RestraintSummaryMeta };

// ---------------------------------------------------------------------------
// 書き込み: サマリ → ステートメント
// ---------------------------------------------------------------------------

const MONTH_COLUMNS = [
  "comp_id",
  "source",
  "driver_cd",
  "ym",
  "no_data",
  "driver_name",
  "branch_name",
  "work_days",
  "rest_days",
  "restraint_minutes",
  "driving_minutes",
  "loading_minutes",
  "break_minutes",
  "working_minutes",
  "overtime_minutes",
  "night_minutes",
  "overtime_night_minutes",
  "max_daily_restraint_minutes",
  "fiscal_cumulative_minutes",
  "restraint_limit_minutes",
  "excess_restraint_minutes",
  "over15h_days",
  "avg_driving_9h_over_count",
  "voluntary_minutes",
  "punch_error_days",
  "punch_error_minutes",
  "leave_counts",
  "sha256",
  "fetched_at",
  "last_verified_at",
] as const;

const DAILY_COLUMNS = [
  "comp_id",
  "source",
  "driver_cd",
  "ym",
  "day",
  "is_rest_day",
  "restraint_minutes",
  "working_minutes",
  "overtime_minutes",
  "night_minutes",
  "overtime_night_minutes",
  "holiday_kind",
  "voluntary_minutes",
  "punch_error_minutes",
  "leaves",
  "sessions",
] as const;

/** 1 INSERT に載せる日別行の上限。D1 の bind パラメータ上限 (100/statement) に
 * 対し 16 列 × 6 行 = 96 で収める。 */
const DAILY_ROWS_PER_INSERT = 6;

/** timecard 由来のサマリか (source が唯一の判定元 — 保存側の呼び出しが決める)。 */
function isTimecardSummary(
  source: WageReportSource,
  summary: RestraintDriverSummary,
): summary is TimecardDriverSummary {
  return source === "timecard";
}

function monthUpsertStatement(
  compId: string,
  source: WageReportSource,
  ym: string,
  entry: RestraintD1Entry,
): D1Statement {
  const meta = entry.meta;
  let params: Array<string | number | null>;
  if (entry.kind === "no-data") {
    params = [
      compId,
      source,
      entry.driverCd,
      ym,
      1,
      "",
      "",
      ...Array<null>(16).fill(null),
      null,
      meta.sha256,
      meta.fetchedAt,
      meta.lastVerifiedAt,
    ];
  } else {
    const s = entry.summary;
    const tc = isTimecardSummary(source, s) ? s : null;
    params = [
      compId,
      source,
      s.driverCd,
      ym,
      0,
      s.driverName,
      s.branchName,
      s.workDays,
      s.restDays,
      s.restraintMinutes,
      s.drivingMinutes,
      s.loadingMinutes,
      s.breakMinutes,
      s.workingMinutes,
      s.overtimeMinutes,
      s.nightMinutes,
      s.overtimeNightMinutes,
      s.maxDailyRestraintMinutes,
      s.fiscalCumulativeMinutes,
      s.restraintLimitMinutes,
      s.excessRestraintMinutes,
      s.over15hDays,
      s.avgDriving9hOverCount,
      tc ? tc.voluntaryMinutes : null,
      tc ? tc.punchErrorDays : null,
      tc ? tc.punchErrorMinutes : null,
      tc ? JSON.stringify(tc.leaveCounts) : null,
      meta.sha256,
      meta.fetchedAt,
      meta.lastVerifiedAt,
    ];
  }
  const updates = MONTH_COLUMNS.slice(4)
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  return {
    sql: `INSERT INTO restraint_driver_month (${MONTH_COLUMNS.join(", ")})
          VALUES (${MONTH_COLUMNS.map(() => "?").join(", ")})
          ON CONFLICT (comp_id, source, driver_cd, ym) DO UPDATE SET ${updates}`,
    params,
  };
}

function dailyRowParams(
  compId: string,
  source: WageReportSource,
  driverCd: string,
  ym: string,
  day: RestraintSummaryDay,
  timecard: boolean,
): Array<string | number | null> {
  const tc = timecard ? (day as TimecardSummaryDay) : null;
  return [
    compId,
    source,
    driverCd,
    ym,
    day.day,
    day.isRestDay ? 1 : 0,
    day.restraintMinutes,
    day.workingMinutes,
    day.overtimeMinutes,
    day.nightMinutes,
    day.overtimeNightMinutes,
    day.holidayKind ?? null,
    tc ? tc.voluntaryMinutes : null,
    tc ? tc.punchErrorMinutes : null,
    tc ? JSON.stringify(tc.leaves) : null,
    tc ? JSON.stringify(tc.sessions) : null,
  ];
}

/**
 * サマリ (or noData マーカー) 一式を D1 へ upsert するステートメント列を作る。
 *
 * 日別行は DELETE → INSERT の総入れ替え — 再取り込みで日数が減った時に古い行が
 * 残らないようにする (R2 latest の上書きと同じ意味論)。noData マーカーも日別行を
 * 消す (在籍しなくなった月の残骸を持ち越さない)。実行側は返り値をそのまま
 * db.batch に渡すこと (batch はトランザクション — 中途半端な状態を残さない)。
 */
export function buildRestraintD1Statements(
  compId: string,
  source: WageReportSource,
  ym: string,
  entries: RestraintD1Entry[],
): D1Statement[] {
  const statements: D1Statement[] = [];
  for (const entry of entries) {
    const driverCd = entry.kind === "no-data" ? entry.driverCd : entry.summary.driverCd;
    statements.push({
      sql: `DELETE FROM restraint_daily WHERE comp_id = ? AND source = ? AND driver_cd = ? AND ym = ?`,
      params: [compId, source, driverCd, ym],
    });
    statements.push(monthUpsertStatement(compId, source, ym, entry));
    if (entry.kind === "no-data") continue;
    const timecard = isTimecardSummary(source, entry.summary);
    const days = entry.summary.days;
    for (let i = 0; i < days.length; i += DAILY_ROWS_PER_INSERT) {
      const chunk = days.slice(i, i + DAILY_ROWS_PER_INSERT);
      const placeholders = chunk
        .map(() => `(${DAILY_COLUMNS.map(() => "?").join(", ")})`)
        .join(", ");
      statements.push({
        sql: `INSERT INTO restraint_daily (${DAILY_COLUMNS.join(", ")}) VALUES ${placeholders}`,
        params: chunk.flatMap((day) => dailyRowParams(compId, source, driverCd, ym, day, timecard)),
      });
    }
  }
  return statements;
}

// ---------------------------------------------------------------------------
// 読み取り: 行 → サマリ (PR-C の読み取り切替で使う。PR-A では round-trip の証明)
// ---------------------------------------------------------------------------

/** restraint_driver_month の SELECT 行 (snake_case、D1 の素の結果)。 */
export interface RestraintMonthD1Row {
  comp_id: string;
  source: string;
  driver_cd: string;
  ym: string;
  no_data: number;
  driver_name: string;
  branch_name: string;
  work_days: number | null;
  rest_days: number | null;
  restraint_minutes: number | null;
  driving_minutes: number | null;
  loading_minutes: number | null;
  break_minutes: number | null;
  working_minutes: number | null;
  overtime_minutes: number | null;
  night_minutes: number | null;
  overtime_night_minutes: number | null;
  max_daily_restraint_minutes: number | null;
  fiscal_cumulative_minutes: number | null;
  restraint_limit_minutes: number | null;
  excess_restraint_minutes: number | null;
  over15h_days: number | null;
  avg_driving_9h_over_count: number | null;
  voluntary_minutes: number | null;
  punch_error_days: number | null;
  punch_error_minutes: number | null;
  leave_counts: string | null;
  sha256: string | null;
  fetched_at: string | null;
  last_verified_at: string | null;
}

/** restraint_daily の SELECT 行。 */
export interface RestraintDailyD1Row {
  driver_cd: string;
  day: number;
  is_rest_day: number;
  restraint_minutes: number | null;
  working_minutes: number | null;
  overtime_minutes: number | null;
  night_minutes: number | null;
  overtime_night_minutes: number | null;
  holiday_kind: string | null;
  voluntary_minutes: number | null;
  punch_error_minutes: number | null;
  leaves: string | null;
  sessions: string | null;
}

/** 読み取り結果 1 件 — loadMonthSummaries の要素 or noData マーカー。 */
export type RestraintD1Loaded =
  | { noData: true; driverCd: string }
  | {
      noData: false;
      data: RestraintDriverSummary;
      fetchedAt: string | null;
      lastVerifiedAt: string | null;
    };

function dayFromRow(row: RestraintDailyD1Row, timecard: boolean): RestraintSummaryDay {
  const day: RestraintSummaryDay = {
    day: row.day,
    isRestDay: row.is_rest_day !== 0,
    restraintMinutes: row.restraint_minutes,
    workingMinutes: row.working_minutes,
    overtimeMinutes: row.overtime_minutes,
    nightMinutes: row.night_minutes,
    overtimeNightMinutes: row.overtime_night_minutes,
  };
  if (row.holiday_kind !== null) day.holidayKind = row.holiday_kind as RestraintHolidayKind;
  if (!timecard) return day;
  const tc = day as TimecardSummaryDay;
  tc.voluntaryMinutes = row.voluntary_minutes ?? 0;
  tc.punchErrorMinutes = row.punch_error_minutes ?? 0;
  tc.leaves = row.leaves !== null ? (JSON.parse(row.leaves) as string[]) : [];
  tc.sessions = row.sessions !== null ? (JSON.parse(row.sessions) as TimecardSession[]) : [];
  return tc;
}

/**
 * D1 の行から summary を復元する。`dayRows` は同じ (comp, source, driver, ym) の
 * 日別行のみを渡すこと (day 順は問わない — ここで整列する)。
 *
 * round-trip (buildRestraintD1Statements で書いた行 → この関数) が元のサマリと
 * 深い等価になることをテストで固定している。数値カラムの `?? 0` は timecard 由来
 * では起き得ない防御 (書き込み側が必ず数値を入れる) だが、手作業の行にも耐える。
 */
export function restraintSummaryFromD1Rows(
  month: RestraintMonthD1Row,
  dayRows: RestraintDailyD1Row[],
): RestraintD1Loaded {
  if (month.no_data !== 0) return { noData: true, driverCd: month.driver_cd };
  const timecard = month.source === "timecard";
  const days = [...dayRows]
    .sort((a, b) => a.day - b.day)
    .map((row) => dayFromRow(row, timecard));
  const base: RestraintDriverSummary = {
    driverCd: month.driver_cd,
    driverName: month.driver_name,
    branchName: month.branch_name,
    workDays: month.work_days ?? 0,
    restDays: month.rest_days ?? 0,
    restraintMinutes: month.restraint_minutes,
    drivingMinutes: month.driving_minutes,
    loadingMinutes: month.loading_minutes,
    breakMinutes: month.break_minutes,
    workingMinutes: month.working_minutes,
    overtimeMinutes: month.overtime_minutes,
    nightMinutes: month.night_minutes,
    overtimeNightMinutes: month.overtime_night_minutes,
    maxDailyRestraintMinutes: month.max_daily_restraint_minutes,
    fiscalCumulativeMinutes: month.fiscal_cumulative_minutes,
    restraintLimitMinutes: month.restraint_limit_minutes,
    excessRestraintMinutes: month.excess_restraint_minutes,
    over15hDays: month.over15h_days ?? 0,
    avgDriving9hOverCount: month.avg_driving_9h_over_count ?? 0,
    days,
  };
  if (!timecard) {
    return { noData: false, data: base, fetchedAt: month.fetched_at, lastVerifiedAt: month.last_verified_at };
  }
  const data: TimecardDriverSummary = {
    ...base,
    days: days as TimecardSummaryDay[],
    source: "timecard",
    voluntaryMinutes: month.voluntary_minutes ?? 0,
    punchErrorDays: month.punch_error_days ?? 0,
    punchErrorMinutes: month.punch_error_minutes ?? 0,
    leaveCounts:
      month.leave_counts !== null
        ? (JSON.parse(month.leave_counts) as TimecardLeaveCounts)
        : { publicHoliday: 0, paidLeave: 0, absence: 0, specialLeave: 0, late: 0, earlyLeave: 0 },
  };
  return { noData: false, data, fetchedAt: month.fetched_at, lastVerifiedAt: month.last_verified_at };
}
