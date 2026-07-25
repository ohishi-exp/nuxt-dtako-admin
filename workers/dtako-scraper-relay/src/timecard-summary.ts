/**
 * タイムカード日別 JSON → `RestraintDriverSummary` 互換サマリへの変換 (Refs #424 PR-B)。
 *
 * 供給元は社内 CakePHP (`yhonda-ohishi/nginx` の `GET /time-card/daily-json?month=`)。
 * 出力を theearth (デジタコ) 由来のサマリと**同じ形**に畳むことで、`computeWageRow` /
 * `classifyMonth` / `compareSalaryMonth` を一切変更せずに事務員を賃金計算へ載せる。
 * 新しいロジックはこのファイル 1 箇所に閉じる。
 *
 * ## 実働と休憩
 *
 * タイムカードに休憩の打刻状態は無い。代わりに**事務員は昼休憩で打刻を切っている**
 * (実データで確認) ため、休憩は打刻から導出する:
 *
 * ```
 * 除外分 = (中抜けギャップ ∪ 12:00-13:00) ∩ 拘束区間
 * 実働   = 拘束 − 除外分
 * ```
 *
 * **和集合**なのが要点 — 中抜けが昼をまたぐ日に「中抜け + 60 分」と足すと、同じ時間を
 * 二重に休憩として引いてしまう。所定休憩の固定値マスタは持たない (この式で足りる)。
 *
 * ## 時間外と深夜
 *
 * 時間外 = 実働 − 所定労働時間 (`work_schedules`、`resolveWorkScheduleAt` で解決)。
 * その日の**実働の終わり側から**時間外分を取り、深夜帯 (22:00-05:00) と重なる分を
 * 時間外深夜に回す。`classifyMonth` の契約に合わせ、深夜 (通常) と時間外深夜は
 * **排他** (`statutory = 実働 − 時間外 − 時間外深夜`) にする。
 *
 * ## 休日
 *
 * - **承認済み休日出勤** (`holiday_work_approvals` に日付がある) … 通常どおり時間を出す
 * - **自主出勤** (休日の打刻だが承認が無い) … `isRestDay: true` + 各時間 0 で出し、
 *   実働分は `voluntaryMinutes` に退避する。既存の賃金ロジックに手を入れずに
 *   「残業としてつけない」を実現でき、時間は画面と CSV に残る
 *
 * ## 既知の限界 (PR-D で解消する)
 *
 * `classifyMonth` の法定外休日は **wage-config の曜日指定** (既定は空) で判定するため、
 * **祝日・会社指定休の承認済み休日出勤は今のところ平日として計算される** (1.25 倍が
 * 付かない)。日別に `holidayKind` を持たせてあるので、PR-D で `classifyMonth` 側が
 * これを見るようにすれば解消する。該当日があれば `warnings` に出す。
 */

import type { RestraintDriverSummary, RestraintSummaryDay } from "./theearth-restraint-client";
import { TheearthClientError } from "./theearth-client";

/** 入力の構造不正 (呼び出し側で 502 相当にマップする — 上流 JSON が壊れている)。 */
export class TimecardSummaryError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "TimecardSummaryError";
  }
}

/** 休日区分 (CakePHP 側が日曜 / 指定休+祝日 / それ以外で判定して返す)。 */
export type TimecardHolidayKind = "legal" | "non_legal" | "weekday";

export interface TimecardSession {
  /** "YYYY-MM-DD HH:MM:SS" */
  start: string;
  /** "YYYY-MM-DD HH:MM:SS" */
  end: string;
}

/** `daily-json` の 1 行 (1 社員 × 1 日、日跨ぎは始業日に寄せてある)。 */
export interface TimecardDailyRow {
  driver_id: number | string;
  name: string;
  /** "YYYY-MM-DD" (始業日) */
  date: string;
  start: string | null;
  end: string | null;
  restraint_minutes: number;
  /** 中抜けの内訳。中抜けが無い日も要素数 1 で必ず入る (nginx#776)。 */
  sessions: TimecardSession[];
  holiday: TimecardHolidayKind;
  office?: string | null;
}

/** 日別サマリ。`RestraintSummaryDay` の上に timecard 固有の 3 項目を足す
 * (theearth 由来のサマリには無い = optional 扱いで下流は読み飛ばせる)。
 *
 * 時間の各項目は `RestraintSummaryDay` では `number | null` (theearth CSV に
 * 欠損がありうるため) だが、**タイムカード由来では必ず数値**なので narrow する。
 * これで集計側の `?? 0` フォールバックが不要になり、到達しない分岐が消える。 */
export interface TimecardSummaryDay extends RestraintSummaryDay {
  restraintMinutes: number;
  workingMinutes: number;
  overtimeMinutes: number;
  nightMinutes: number;
  overtimeNightMinutes: number;
  holidayKind: TimecardHolidayKind;
  /** 自主出勤として賃金計算から外した実働 (分)。通常日は 0。 */
  voluntaryMinutes: number;
  /** その日の打刻セッション数 (中抜けがあれば 2 以上)。 */
  sessionCount: number;
}

export interface TimecardDriverSummary extends RestraintDriverSummary {
  days: TimecardSummaryDay[];
  /** サマリの出どころ。theearth 由来と混ざった時に見分ける (PR-D)。 */
  source: "timecard";
  /** 自主出勤の月合計 (分)。 */
  voluntaryMinutes: number;
}

export interface TimecardSummaryResult {
  summaries: TimecardDriverSummary[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 時刻・区間のユーティリティ
// ---------------------------------------------------------------------------

/** 半開区間 [from, to)。単位は**秒** (エポックからの秒数)。 */
interface Interval {
  from: number;
  to: number;
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "YYYY-MM-DD HH:MM:SS" → エポックからの**秒**。UTC で解釈する — 値は差分にしか
 * 使わないので実際のタイムゾーンは影響しない (ローカル解釈にすると CI と実機で
 * DST・TZ 差が出る)。
 *
 * **秒で保持して最後に分へ丸める**のが要点。先に各打刻を分へ丸めてから引くと
 * 上流 (CakePHP) と 1 分ずれる — 例: 07:44:15 → 16:49:11 は実際 544分56秒で、
 * 秒で引いてから切り捨てれば 544 だが、分に丸めてから引くと 545 になる。
 * 上流の `restraint_minutes` は前者なので合わせる。
 */
export function timestampToSeconds(ts: string): number | null {
  const m = TS_RE.exec(ts);
  if (!m) return null;
  return (
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? "0")) / 1000
  );
}

const SECONDS_PER_DAY = 24 * 60 * 60;

/** 秒 → 分 (切り捨て)。出力の直前でだけ使う。 */
function toMinutes(seconds: number): number {
  return Math.floor(seconds / 60);
}

/** 区間列の合計長。 */
export function totalLength(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + Math.max(0, i.to - i.from), 0);
}

/** 区間列を昇順に正規化し、重なりを併合する (和集合)。 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals.filter((i) => i.to > i.from).sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const cur of sorted) {
    const last = out[out.length - 1];
    if (last && cur.from <= last.to) {
      last.to = Math.max(last.to, cur.to);
      continue;
    }
    out.push({ ...cur });
  }
  return out;
}

/** `base` から `cut` を差し引く (どちらも併合済みである必要はない)。 */
export function subtractIntervals(base: Interval[], cut: Interval[]): Interval[] {
  const cuts = mergeIntervals(cut);
  let out = mergeIntervals(base);
  for (const c of cuts) {
    const next: Interval[] = [];
    for (const b of out) {
      if (c.to <= b.from || c.from >= b.to) {
        next.push(b);
        continue;
      }
      if (b.from < c.from) next.push({ from: b.from, to: c.from });
      if (c.to < b.to) next.push({ from: c.to, to: b.to });
    }
    out = next;
  }
  return out;
}

/** 2 つの区間列の重なりの合計長。 */
export function overlapLength(a: Interval[], b: Interval[]): number {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  let sum = 0;
  for (const l of left) {
    for (const r of right) {
      const from = Math.max(l.from, r.from);
      const to = Math.min(l.to, r.to);
      if (to > from) sum += to - from;
    }
  }
  return sum;
}

/**
 * 区間列の**終わり側**から `length` (秒) だけ切り出す。
 * 時間外は「その日の勤務の終わりに発生した」とみなす慣行に従う
 * (どこが時間外かは打刻からは決まらないため、深夜帯との重なりを出すための仮定)。
 */
export function trailingSlice(intervals: Interval[], length: number): Interval[] {
  if (length <= 0) return [];
  const merged = mergeIntervals(intervals);
  const out: Interval[] = [];
  let remain = length;
  for (let i = merged.length - 1; i >= 0 && remain > 0; i--) {
    const seg = merged[i]!;
    const len = seg.to - seg.from;
    if (len <= remain) {
      out.unshift({ ...seg });
      remain -= len;
      continue;
    }
    out.unshift({ from: seg.to - remain, to: seg.to });
    remain = 0;
  }
  return out;
}

/** `span` が跨ぐ各暦日の [hourFrom, hourTo) を並べる (日跨ぎ勤務に対応)。 */
function dailyWindows(span: Interval, hourFrom: number, hourTo: number): Interval[] {
  const out: Interval[] = [];
  const firstDay = Math.floor(span.from / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  const lastDay = Math.floor((span.to - 1) / SECONDS_PER_DAY) * SECONDS_PER_DAY;
  // 前日ぶんも見る — 深夜帯 (22:00-05:00) は日を跨ぐため、前日 22:00 開始の窓が
  // 当日 05:00 まで伸びて span の頭に重なりうる
  for (let day = firstDay - SECONDS_PER_DAY; day <= lastDay; day += SECONDS_PER_DAY) {
    out.push({ from: day + hourFrom * 3600, to: day + hourTo * 3600 });
  }
  return out;
}

/** 昼休憩の窓 (12:00-13:00)。打刻を切っていない日でもここは休憩として引く。 */
export const LUNCH_FROM_HOUR = 12;
export const LUNCH_TO_HOUR = 13;
/** 深夜帯 (22:00 - 翌 05:00)。 */
export const NIGHT_FROM_HOUR = 22;
export const NIGHT_TO_HOUR = 29; // 翌 05:00

// ---------------------------------------------------------------------------
// 日別の変換
// ---------------------------------------------------------------------------

export interface TimecardDayOptions {
  /** その月に効いている所定労働時間 (分)。未設定なら時間外を出さない。 */
  dailyWorkMinutes: number | null;
  /** その日が承認済み休日出勤か。 */
  approved: boolean;
}

/** 打刻の無い日 / 自主出勤の日に使う「休み」の 1 行。 */
function restDay(day: number, holidayKind: TimecardHolidayKind, voluntaryMinutes: number, sessionCount: number): TimecardSummaryDay {
  return {
    day,
    isRestDay: true,
    restraintMinutes: 0,
    workingMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    overtimeNightMinutes: 0,
    holidayKind,
    voluntaryMinutes,
    sessionCount,
  };
}

/**
 * `daily-json` の 1 行を日別サマリへ畳む。
 *
 * `sessions` が空、または時刻が読めない行は「打刻なし」として休み扱いにする
 * (上流が壊れていても月全体の集計は続ける — loud fail は月単位の warnings で行う)。
 */
export function summarizeTimecardDay(row: TimecardDailyRow, opts: TimecardDayOptions): TimecardSummaryDay {
  const dayNo = dayOfMonth(row.date);
  const raw: Interval[] = [];
  for (const s of row.sessions) {
    const from = timestampToSeconds(s.start);
    const to = timestampToSeconds(s.end);
    if (from === null || to === null || to <= from) continue;
    raw.push({ from, to });
  }
  const punched = mergeIntervals(raw);
  if (punched.length === 0) return restDay(dayNo, row.holiday, 0, 0);

  const span: Interval = { from: punched[0]!.from, to: punched[punched.length - 1]!.to };
  // 実働 = 打刻区間 − 昼休憩。中抜け (打刻の切れ目) は punched に最初から無いので、
  // 「中抜け ∪ 12:00-13:00」の和集合を引いたのと同じ結果になる (二重控除しない)
  const work = subtractIntervals(punched, dailyWindows(span, LUNCH_FROM_HOUR, LUNCH_TO_HOUR));
  const workingMinutes = toMinutes(totalLength(work));
  const restraintMinutes = toMinutes(span.to - span.from);

  // 休日の打刻で承認が無いものは自主出勤 — 賃金計算には一切入れず、時間だけ残す
  if (row.holiday !== "weekday" && !opts.approved) {
    return restDay(dayNo, row.holiday, workingMinutes, punched.length);
  }

  const nightWindows = dailyWindows(span, NIGHT_FROM_HOUR, NIGHT_TO_HOUR);

  // 分は「丸めた実働」から導出する — 秒のまま個別に丸めると
  // 実働 = 法定内 + 時間外 + 時間外深夜 の恒等式が 1 分ずれることがあり、
  // classifyMonth の statutory (= 実働 − 時間外 − 時間外深夜) が狂う
  const overtimeTotal =
    opts.dailyWorkMinutes === null ? 0 : Math.max(0, workingMinutes - opts.dailyWorkMinutes);
  const overtimeNightMinutes = Math.min(
    overtimeTotal,
    toMinutes(overlapLength(trailingSlice(work, overtimeTotal * 60), nightWindows)),
  );
  const nightTotal = toMinutes(overlapLength(work, nightWindows));

  return {
    day: dayNo,
    isRestDay: false,
    restraintMinutes,
    workingMinutes,
    // 深夜 (通常) と時間外深夜は排他 (classifyMonth の契約: statutory =
    // 実働 − 時間外 − 時間外深夜、nightTotal = night + overtimeNight)
    overtimeMinutes: overtimeTotal - overtimeNightMinutes,
    nightMinutes: Math.max(0, nightTotal - overtimeNightMinutes),
    overtimeNightMinutes,
    holidayKind: row.holiday,
    voluntaryMinutes: 0,
    sessionCount: punched.length,
  };
}

/** "YYYY-MM-DD" の日 (1-31)。読めない形式は 0 (呼び出し側が warnings で拾う)。 */
function dayOfMonth(date: string): number {
  const m = DATE_RE.exec(date);
  return m ? Number(m[3]) : 0;
}

// ---------------------------------------------------------------------------
// 月次の変換
// ---------------------------------------------------------------------------

export interface TimecardMonthOptions {
  /** "YYYY-MM" */
  yearMonth: string;
  /** 乗務員CD → その月の所定労働時間 (分)。未設定の人は時間外を出さない。 */
  dailyWorkMinutesFor(driverCd: string): number | null;
  /** `{driverCd}|{YYYY-MM-DD}` の集合 (buildHolidayWorkIndex の出力)。 */
  approvedHolidayWork: Set<string>;
}

/** 15 時間 (改善基準の 1 日拘束上限) を分で。 */
const OVER_15H_MINUTES = 15 * 60;

/**
 * 月の日別行を乗務員ごとのサマリへ畳む。
 *
 * 行が無い日は summary に出さない (`classifyMonth` は days に無い日を勤務なしとして
 * 扱うため、埋める必要がない)。`workDays` は実際に勤務した日数、`restDays` は
 * 自主出勤として外した日数 + 打刻はあったが実働 0 の日数。
 */
export function summarizeTimecardMonth(
  rows: TimecardDailyRow[],
  opts: TimecardMonthOptions,
): TimecardSummaryResult {
  const warnings: string[] = [];
  const byDriver = new Map<string, { name: string; office: string; days: TimecardSummaryDay[] }>();

  for (const row of rows) {
    const driverCd = String(Number(row.driver_id));
    if (!Number.isFinite(Number(row.driver_id))) {
      warnings.push(`driver_id が数値ではない行を無視しました (${JSON.stringify(row.driver_id)})`);
      continue;
    }
    if (dayOfMonth(row.date) === 0) {
      warnings.push(`date が YYYY-MM-DD でない行を無視しました (乗務員 ${driverCd}: ${JSON.stringify(row.date)})`);
      continue;
    }
    const approved = opts.approvedHolidayWork.has(`${driverCd}|${row.date}`);
    if (row.holiday === "non_legal" && approved) {
      warnings.push(
        `${row.date} の乗務員 ${driverCd} は法定外休日 (指定休・祝日) の承認済み休日出勤ですが、`
        + `法定外休日の割増は wage-config の曜日指定でしか効かないため平日として計算されます`,
      );
    }
    const day = summarizeTimecardDay(row, {
      dailyWorkMinutes: opts.dailyWorkMinutesFor(driverCd),
      approved,
    });
    let entry = byDriver.get(driverCd);
    if (!entry) {
      entry = { name: row.name, office: row.office ?? "", days: [] };
      byDriver.set(driverCd, entry);
    }
    entry.days.push(day);
  }

  const summaries: TimecardDriverSummary[] = [];
  for (const [driverCd, entry] of byDriver) {
    const days = [...entry.days].sort((a, b) => a.day - b.day);
    const worked = days.filter((d) => !d.isRestDay);
    const sum = (pick: (d: TimecardSummaryDay) => number) => days.reduce((s, d) => s + pick(d), 0);
    const restraintTotals = worked.map((d) => d.restraintMinutes);
    summaries.push({
      driverCd,
      driverName: entry.name,
      branchName: entry.office,
      workDays: worked.length,
      restDays: days.length - worked.length,
      restraintMinutes: sum((d) => d.restraintMinutes),
      drivingMinutes: null,
      loadingMinutes: null,
      // 休憩 = 拘束 − 実働 (中抜け + 昼休憩)。タイムカードには休憩の打刻が無いので
      // これが唯一の出どころ
      breakMinutes: sum((d) => d.restraintMinutes - d.workingMinutes),
      workingMinutes: sum((d) => d.workingMinutes),
      overtimeMinutes: sum((d) => d.overtimeMinutes),
      nightMinutes: sum((d) => d.nightMinutes),
      overtimeNightMinutes: sum((d) => d.overtimeNightMinutes),
      maxDailyRestraintMinutes: restraintTotals.length ? Math.max(...restraintTotals) : null,
      // デジタコ由来の指標はタイムカードからは出せない
      fiscalCumulativeMinutes: null,
      restraintLimitMinutes: null,
      excessRestraintMinutes: null,
      over15hDays: worked.filter((d) => d.restraintMinutes > OVER_15H_MINUTES).length,
      avgDriving9hOverCount: 0,
      days,
      source: "timecard",
      voluntaryMinutes: sum((d) => d.voluntaryMinutes),
    });
  }
  summaries.sort((a, b) => Number(a.driverCd) - Number(b.driverCd));
  return { summaries, warnings };
}

/** R2 保存 body (決定論 JSON、theearth 側 `stableSummaryBody` と同じ作法)。 */
export function stableTimecardSummaryBody(
  compId: string,
  year: number,
  month: number,
  summary: TimecardDriverSummary,
): string {
  return JSON.stringify({ compId, year, month, ...summary });
}
