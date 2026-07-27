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
 * ## 休日 — 夜勤者・事務職・非事務職で扱いが違う (Refs #433)
 *
 * - **承認済み休日出勤** (`holiday_work_approvals` に日付がある) … 職種によらず
 *   通常どおり時間を出す (法定 1.35 / 法定外 1.25)
 * - **夜勤者の未承認の休日打刻** … 自主出勤にも休日出勤にもせず、`holidayKind` を
 *   `weekday` へ落として**通常計上する**。夜勤ローテーションでは日曜も祝日も通常の
 *   勤務日で、曜日が勤務の性質を表さないため。**職種は問わない** (2026-07-26
 *   ユーザー決定 — 同じ日曜夜勤を事務職と作業員で違う単価にしない)
 * - **事務職 (非夜勤) の未承認の休日打刻 = 自主出勤** … `isRestDay: true` + 各時間 0
 *   で出し、実働分は `voluntaryMinutes` に退避する。既存の賃金ロジックに手を入れずに
 *   「残業としてつけない」を実現でき、時間は画面と CSV に残る
 * - **非事務職 (非夜勤) の未承認の休日打刻** … 自主出勤にせず**通常どおり計上する**。
 *   ただし**法定外休日 (祝日・指定休) の割増はつけない** — `holidayKind` を `weekday`
 *   へ落として平日として計算する (2026-07-26 ユーザー決定)。法定休日 (日曜) は
 *   未承認でも 1.35 を付ける (労基法 35 条の休日労働そのものなので)
 *
 * ## 打刻エラー (Refs #433)
 *
 * **事務職 かつ 夜勤者でない かつ 日跨ぎの打刻** は終業の押し忘れとみなし、
 * その日を賃金計算から外して `punchErrorMinutes` に拘束分を退避する
 * (自主出勤と同じ隔離の作法)。時刻は残す — 総務が CakePHP 側で直すための
 * 手掛かりだから。
 *
 * 拘束時間の長さは判定に使わない。実データ (2026-04〜06) では夜勤の 1706/1707 が
 * 19:45→翌00:02 (4.3h) を月 15 回前後打っており、打刻漏れの 1065 は
 * 07:14→翌18:52 (35.6h)。**事務職 + 夜勤者マスタ**の 2 条件で完全に分かれる。
 *
 * 押し忘れた日の終業は**翌日の打刻と組まれる**ため、翌日の行そのものが消える
 * (実データで確認)。「翌日が空欄」も症状なので、画面側でその旨を出す。
 *
 * ## 休暇 (公休・有休等、Refs #433)
 *
 * 上流 (`yhonda-ohishi/nginx#779`) が `leaves: [{detail}]` を返す。`detail` は
 * CakePHP の原文 (公休 / 有休 / 指休 / 欠勤 / 特休 / 前休 / 後休 / 遅刻 / 早退 …)
 * で、**分類はこちら側で行う** (`countLeaves`)。集計軸は CakePHP の PDF
 * (`TimeCardController::createPdf`) と揃えてある — それは給与明細の列
 * (`出勤日数 / 公休日数 / 有休日数 / 欠勤日数 …`) と同じ軸なので突合できる。
 *
 * 打刻の無い休暇日も行として来る (`sessions: []`)。既存の「打刻なし = 休み」の
 * 分岐にそのまま乗るので、時間は 0 のまま区分だけが載る。
 *
 * ## 休日区分の権威 (PR-D で解消済み)
 *
 * 日別の `holidayKind` は CakePHP の判定 (日曜 + 祝日 + 会社指定休) をそのまま運び、
 * `classifyMonth` はそれがある日を**曜日判定より優先**する。これで祝日・指定休の
 * 承認済み休日出勤に法定外休日の 1.25 倍が付く。theearth 由来の日別行には
 * `holidayKind` が無いので、乗務員側の計算は従来どおり wage-config の曜日指定で動く。
 */

import type {
  RestraintDriverSummary,
  RestraintHolidayKind,
  RestraintSummaryDay,
} from "./theearth-restraint-client";
import { TheearthClientError } from "./theearth-client";

/** 入力の構造不正 (呼び出し側で 502 相当にマップする — 上流 JSON が壊れている)。 */
export class TimecardSummaryError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "TimecardSummaryError";
  }
}

/** 休日区分 (CakePHP 側が日曜 / 指定休+祝日 / それ以外で判定して返す)。
 * 実体は `RestraintHolidayKind` — `classifyMonth` が日別行から直接読むため、
 * 型の置き場は共通の `RestraintSummaryDay` 側に移した (Refs #424 PR-D)。 */
export type TimecardHolidayKind = RestraintHolidayKind;

export interface TimecardSession {
  /** "YYYY-MM-DD HH:MM:SS" */
  start: string;
  /** "YYYY-MM-DD HH:MM:SS"。**退社押し忘れ (未終業) は null** — 上流が行ごと捨てると
   * 「打刻の無い休み」と区別できないため、始業だけでも運んでくる (nginx#780)。 */
  end: string | null;
}

/** 休暇 1 件 (`daily_report_other_detail` の `report_type='kyuka'`)。
 * `detail` は CakePHP の原文 (公休 / 有休 / 指休 / 欠勤 / 特休 …)。 */
export interface TimecardLeave {
  detail: string;
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
  /** 中抜けの内訳。中抜けが無い日も要素数 1 で必ず入る (nginx#776)。
   * 休暇だけで打刻の無い日は空配列 (nginx#779)。 */
  sessions: TimecardSession[];
  holiday: TimecardHolidayKind;
  office?: string | null;
  /**
   * その日の休暇 (nginx#779)。**optional** — この項目を返さない上流でも取り込みを
   * 成功させるため (上流と本体のデプロイ順に依存しない)。
   */
  leaves?: TimecardLeave[];
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
  /**
   * 打刻エラー (事務職・非夜勤・日跨ぎ) として**実働の計算に使わなかった**拘束 (分)。
   * 通常日は 0。**この日が打刻エラーか**の判定はこの値が正 (0 より大きいか)。
   *
   * この日は賃金計算から丸ごと外すのではなく、所定労働時間ぶんの勤務として計上する
   * (Refs #468)。値は「本来ならこの拘束だった」という記録で、画面の赤表示と、
   * 打刻を直す手掛かりとして残る。
   */
  punchErrorMinutes: number;
  /** その日の休暇区分 (原文、公休 / 有休 / …)。無ければ空配列。 */
  leaves: string[];
  /**
   * 退社打刻の無い日 (始業だけのセッションがある = 退社押し忘れ、nginx#780)。
   * 実時間は信用できないので、所定労働時間ぶんの勤務として計上する (Refs #468)。
   * 当日 (勤務中) は押し忘れとは言えないのでこのフラグは立たない。
   * optional — 旧サマリ (このフィールド導入前に保存されたもの) には無い。
   */
  missingClockOut?: boolean;
  /**
   * その日の打刻区間 ("YYYY-MM-DD HH:MM:SS"、中抜けがあれば 2 つ以上)。
   *
   * **実働の計算に使ったものと同じ区間**を持つ (無効な打刻を落とし、重なりを併合
   * した後の姿)。退社打刻の無い始業は `end: null` のまま**表示用に残す** (計算には
   * 入らない)。タイムカード表の 出勤1/退社1/出勤2/退社2 はこれをそのまま並べる
   * ので、画面に出る時刻と残業の計算根拠が食い違わない (Refs #424 PR-E)。
   * 打刻の無い日は空配列。
   */
  sessions: TimecardSession[];
}

/**
 * 休暇の日数集計 (Refs #433)。軸は CakePHP の PDF (`TimeCardController::createPdf`)
 * と同じ = 給与明細の列 (`出勤日数 / 公休日数 / 有休日数 / 欠勤日数 …`) と同じ。
 * 半休 (前休・後休) があるので**整数とは限らない**。
 */
export interface TimecardLeaveCounts {
  /** 公休日数 (公休 / 泊休 / 積置泊休 / 指休)。 */
  publicHoliday: number;
  /** 有休日数 (有休 = 1.0、前休 / 後休 / 前休作 / 後休作 = 0.5)。 */
  paidLeave: number;
  /** 欠勤日数。 */
  absence: number;
  /** 特別休暇。 */
  specialLeave: number;
  /** 遅刻回数。 */
  late: number;
  /** 早退回数。 */
  earlyLeave: number;
}

export interface TimecardDriverSummary extends RestraintDriverSummary {
  days: TimecardSummaryDay[];
  /** サマリの出どころ。theearth 由来と混ざった時に見分ける (PR-D)。 */
  source: "timecard";
  /** 自主出勤の月合計 (分)。 */
  voluntaryMinutes: number;
  /** 打刻エラーの日数 (Refs #433)。 */
  punchErrorDays: number;
  /** 打刻エラーとして賃金計算から外した拘束の月合計 (分)。 */
  punchErrorMinutes: number;
  /** 休暇の日数集計。 */
  leaveCounts: TimecardLeaveCounts;
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

/** エポック秒 → "YYYY-MM-DD HH:MM:SS" (`timestampToSeconds` の逆、UTC 解釈で往復する)。 */
export function secondsToTimestamp(seconds: number): string {
  const d = new Date(seconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
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
// 職種・休暇・日跨ぎの判定 (Refs #433)
// ---------------------------------------------------------------------------

/**
 * 事務職か (`employee_attrs.job_name` = `SHOZOKU.NAME2`)。
 *
 * **部分一致にしているのは表記ゆれのため** — 本番の実測値は `一般管理事務` 34 名 と
 * `一般事務管理` 1 名 で、給与大臣側に前後の入れ替わった行が混ざっている。
 * 完全一致のリストにすると 1 名を取りこぼす。
 *
 * **職種が引けない社員 (D1 未取り込み・職種 NULL) は false**。打刻エラーの判定も
 * 自主出勤の隔離も掛からない安全側に倒す — 職種を知らないまま人の勤務を
 * 賃金計算から外すほうが害が大きい。
 */
export function isClericalJob(jobName: string | null | undefined): boolean {
  return typeof jobName === "string" && jobName.includes("事務");
}

/**
 * 日跨ぎの打刻を含むか (始業日と終業日が違うセッションがある)。
 *
 * 比較するのは**併合後の区間**なので、画面に出る 出勤1/退社1 と判定根拠が一致する。
 * 終業の無いセッション (`end: null`) は日跨ぎとは言えないので対象外。
 */
export function hasOvernightSession(sessions: readonly TimecardSession[]): boolean {
  return sessions.some((s) => s.end !== null && s.start.slice(0, 10) !== s.end.slice(0, 10));
}

/** 1 日 1.0 と数える休暇 → 集計軸 (CakePHP の `createPdf` の switch と同じ)。 */
const LEAVE_FULL_DAY: Record<string, keyof TimecardLeaveCounts> = {
  公休: "publicHoliday",
  泊休: "publicHoliday",
  積置泊休: "publicHoliday",
  指休: "publicHoliday",
  有休: "paidLeave",
  欠勤: "absence",
  特休: "specialLeave",
  遅刻: "late",
  早退: "earlyLeave",
};

/** 0.5 日と数える休暇 (半休)。 */
const LEAVE_HALF_DAY = new Set(["前休", "後休", "前休作", "後休作"]);

/** 空の集計。 */
export function emptyLeaveCounts(): TimecardLeaveCounts {
  return { publicHoliday: 0, paidLeave: 0, absence: 0, specialLeave: 0, late: 0, earlyLeave: 0 };
}

/**
 * 休暇区分 (原文) の並びを日数へ集計する。
 *
 * 上の 2 表に載っていない区分 (短時 / 仮乗務 / 有夜勤 / 家畜 …) は**数えない** —
 * CakePHP の PDF でも備考に出るだけでカウントされない。区分そのものは
 * 日別サマリの `leaves` に原文で残るので、画面には出せる。
 */
export function countLeaves(details: readonly string[]): TimecardLeaveCounts {
  const out = emptyLeaveCounts();
  for (const detail of details) {
    const full = LEAVE_FULL_DAY[detail];
    if (full) {
      out[full] += 1;
      continue;
    }
    if (LEAVE_HALF_DAY.has(detail)) out.paidLeave += 0.5;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 日別の変換
// ---------------------------------------------------------------------------

export interface TimecardDayOptions {
  /** その月に効いている所定労働時間 (分)。未設定なら時間外を出さない。 */
  dailyWorkMinutes: number | null;
  /** その日が承認済み休日出勤か。 */
  approved: boolean;
  /** 事務職か (`isClericalJob`)。自主出勤の隔離と打刻エラーの判定はここが true の人だけ。 */
  clerical: boolean;
  /** 夜勤者か (`night_shift_workers`)。true なら日跨ぎを打刻エラーにせず、
   * 未承認の休日打刻も自主出勤にせず平日として通常計上する (職種は問わない)。 */
  nightShift: boolean;
  /**
   * 今日の日付 ("YYYY-MM-DD"、JST)。**当日以降の未終業セッションは勤務中**であって
   * 押し忘れではないので、「退社打刻なし」にしない (nginx#780)。
   * 省略時は全日を過去扱い = 未終業は常に「退社打刻なし」になる。
   */
  today?: string;
}

/** 賃金計算に入れない 1 行 (打刻なし / 自主出勤 / 打刻エラー)。
 *
 * 自主出勤も打刻エラーも賃金計算から外すが**打刻は残す** — 自主出勤は労働時間として
 * 評価されうる時間を画面から消さないため (承認へ昇格すればそのまま休日出勤になる)、
 * 打刻エラーは総務が CakePHP 側で直すための手掛かりを消さないため。 */
function restDay(
  day: number,
  holidayKind: TimecardHolidayKind,
  sessions: TimecardSession[],
  leaves: string[],
  excluded: { voluntaryMinutes?: number, punchErrorMinutes?: number, missingClockOut?: boolean } = {},
): TimecardSummaryDay {
  const out: TimecardSummaryDay = {
    day,
    isRestDay: true,
    restraintMinutes: 0,
    workingMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    overtimeNightMinutes: 0,
    holidayKind,
    voluntaryMinutes: excluded.voluntaryMinutes ?? 0,
    punchErrorMinutes: excluded.punchErrorMinutes ?? 0,
    leaves,
    sessions,
  };
  // false は載せない — 旧サマリ (フィールド導入前) と JSON の形を揃え、
  // R2 の版比較 (sha256) を不要に汚さない
  if (excluded.missingClockOut) out.missingClockOut = true;
  return out;
}

/**
 * 打刻エラーの日を**所定労働時間ぶんの勤務**として計上した 1 行 (Refs #468)。
 *
 * その日の実時間は信用できないが、打刻がある以上**出勤はしている**。丸ごと外すと
 * 出勤日数も実働時間も実態より小さくなり、月給を法定内時間で割る「基礎単価(実績)」が
 * 過大に出る (実例: 山下 1722 の 2026-06 は 6 日欠けて 2,486 円/h ÷ 84h28m — 6 日を
 * 所定で戻すと約 1,585 円/h)。
 *
 * 休日でも `weekday` として計上する — 時間が分からない日に割増の率だけ決めることは
 * できない。割増が要る日は打刻を直して取り込み直せば実測に置き換わる。拘束は所定と
 * 同じ値にする (実際の拘束が分からないので、休憩を引く先が無い)。
 */
function scheduledDay(
  day: number,
  sessions: TimecardSession[],
  leaves: string[],
  dailyWorkMinutes: number,
  excluded: { punchErrorMinutes: number, missingClockOut?: boolean },
): TimecardSummaryDay {
  const out: TimecardSummaryDay = {
    day,
    isRestDay: false,
    restraintMinutes: dailyWorkMinutes,
    workingMinutes: dailyWorkMinutes,
    overtimeMinutes: 0,
    nightMinutes: 0,
    overtimeNightMinutes: 0,
    holidayKind: "weekday",
    voluntaryMinutes: 0,
    punchErrorMinutes: excluded.punchErrorMinutes,
    leaves,
    sessions,
  };
  if (excluded.missingClockOut) out.missingClockOut = true;
  return out;
}

/**
 * 打刻エラーの日に当てる所定労働時間 (分)。当てられない日は `null` = 従来どおり
 * 賃金計算から外す。
 *
 * - 所定が引けない社員 (勤務設定に該当なし) … 埋める値が無い
 * - 事務職 (非夜勤) の未承認の休日打刻 … 自主出勤として賃金計算に入れない (Refs #433)。
 *   打刻エラーが重なっても、承認の無い休日出勤へ賃金を付ける側には倒さない
 */
function scheduledMinutesFor(row: TimecardDailyRow, opts: TimecardDayOptions): number | null {
  if (opts.dailyWorkMinutes === null) return null;
  if (opts.clerical && !opts.nightShift && row.holiday !== "weekday" && !opts.approved) return null;
  return opts.dailyWorkMinutes;
}

/**
 * `daily-json` の 1 行を日別サマリへ畳む。
 *
 * `sessions` が空、または時刻が読めない行は「打刻なし」として休み扱いにする
 * (上流が壊れていても月全体の集計は続ける — loud fail は月単位の warnings で行う)。
 */
export function summarizeTimecardDay(row: TimecardDailyRow, opts: TimecardDayOptions): TimecardSummaryDay {
  const dayNo = dayOfMonth(row.date);
  const leaves = (row.leaves ?? []).map((l) => l.detail);
  const raw: Interval[] = [];
  // 退社打刻の無い始業 (`end: null`、nginx#780)。実働の計算には入れず表示用に残す
  const openStarts: number[] = [];
  for (const s of row.sessions) {
    const from = timestampToSeconds(s.start);
    if (from === null) continue;
    if (s.end === null) {
      openStarts.push(from);
      continue;
    }
    const to = timestampToSeconds(s.end);
    if (to === null || to <= from) continue;
    raw.push({ from, to });
  }
  const punched = mergeIntervals(raw);
  // 表に出す打刻は**併合後の区間**。実働の計算に使うものと同じにして、画面の時刻と
  // 残業の根拠が食い違わないようにする (Refs #424 PR-E)
  const sessions: TimecardSession[] = punched.map(i => ({
    start: secondsToTimestamp(i.from),
    end: secondsToTimestamp(i.to),
  }));
  for (const from of openStarts) sessions.push({ start: secondsToTimestamp(from), end: null });
  // "YYYY-MM-DD HH:MM:SS" は辞書順 = 時刻順。localeCompare は ICU の照合順が
  // 環境で食い違うので使わない (Refs #403)
  sessions.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  // 退社押し忘れ (過去日の未終業始業) — 実時間は信用できないので所定労働時間ぶんの
  // 勤務として計上する (Refs #468、打刻は表示用に残す)。
  // 当日以降の未終業は勤務中であって押し忘れとは言えないので触らない
  if (openStarts.length > 0 && (opts.today === undefined || row.date < opts.today)) {
    const excluded = {
      punchErrorMinutes:
        punched.length > 0 ? toMinutes(punched[punched.length - 1]!.to - punched[0]!.from) : 0,
      missingClockOut: true,
    };
    const scheduled = scheduledMinutesFor(row, opts);
    if (scheduled !== null) return scheduledDay(dayNo, sessions, leaves, scheduled, excluded);
    return restDay(dayNo, row.holiday, sessions, leaves, excluded);
  }
  if (punched.length === 0) return restDay(dayNo, row.holiday, sessions, leaves);

  const span: Interval = { from: punched[0]!.from, to: punched[punched.length - 1]!.to };
  // 実働 = 打刻区間 − 昼休憩。中抜け (打刻の切れ目) は punched に最初から無いので、
  // 「中抜け ∪ 12:00-13:00」の和集合を引いたのと同じ結果になる (二重控除しない)
  const work = subtractIntervals(punched, dailyWindows(span, LUNCH_FROM_HOUR, LUNCH_TO_HOUR));
  const workingMinutes = toMinutes(totalLength(work));
  const restraintMinutes = toMinutes(span.to - span.from);

  // 打刻エラー (事務職・非夜勤の日跨ぎ) は自主出勤より先に判定する — 終業の押し忘れで
  // 拘束が 35 時間に膨らんだ数字は、休日出勤か平日かに関わらず賃金計算に入れられない。
  // 実時間の代わりに所定労働時間を当てる (Refs #468)
  if (opts.clerical && !opts.nightShift && hasOvernightSession(sessions)) {
    const scheduled = scheduledMinutesFor(row, opts);
    if (scheduled !== null) {
      return scheduledDay(dayNo, sessions, leaves, scheduled, { punchErrorMinutes: restraintMinutes });
    }
    return restDay(dayNo, row.holiday, sessions, leaves, { punchErrorMinutes: restraintMinutes });
  }

  // 事務職 (非夜勤) の未承認の休日打刻は自主出勤 — 賃金計算には一切入れず、時間だけ残す
  if (opts.clerical && !opts.nightShift && row.holiday !== "weekday" && !opts.approved) {
    return restDay(dayNo, row.holiday, sessions, leaves, { voluntaryMinutes: workingMinutes });
  }

  // 未承認の休日打刻を平日として計算する = 割増を付けない (classifyMonth は日別行の
  // holidayKind を曜日判定より優先するので、ここで落とせば下流は無変更で済む):
  //
  // - **夜勤者はすべての休日** … 夜勤ローテーションでは日曜も祝日も通常の勤務日で、
  //   曜日は勤務の性質を表さない。**職種は問わない** (2026-07-26 ユーザー決定 —
  //   同じ日曜夜勤を事務職と作業員で違う単価にしない)
  // - **非事務職は法定外休日 (祝日・指定休) のみ** … 法定休日 (日曜) は未承認でも
  //   1.35 のまま (労基法 35 条の休日労働そのものなので)
  const holidayKind: TimecardHolidayKind =
    !opts.approved && (opts.nightShift || (row.holiday === "non_legal" && !opts.clerical))
      ? "weekday"
      : row.holiday;

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
    holidayKind,
    voluntaryMinutes: 0,
    punchErrorMinutes: 0,
    leaves,
    sessions,
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
  /** その社員が事務職か (`isClericalJob(jobName)` の結果)。省略時は全員 false =
   * 自主出勤の隔離も打刻エラーの判定も掛からない (Refs #433)。 */
  isClerical?(driverCd: string): boolean;
  /** その社員が夜勤者か (`buildNightShiftIndex` の集合)。省略時は全員 false。 */
  isNightShift?(driverCd: string): boolean;
  /** 今日の日付 ("YYYY-MM-DD"、JST)。当日以降の未終業を「退社打刻なし」に
   * しないための基準 (nginx#780)。省略時は全日を過去扱い。 */
  today?: string;
}

/** 15 時間 (改善基準の 1 日拘束上限) を分で。 */
const OVER_15H_MINUTES = 15 * 60;

/**
 * 月の日別行を乗務員ごとのサマリへ畳む。
 *
 * 行が無い日は summary に出さない (`classifyMonth` は days に無い日を勤務なしとして
 * 扱うため、埋める必要がない)。`workDays` は実際に勤務した日数 (**打刻エラーの日も
 * 所定労働時間で計上するので含む**、Refs #468)、`restDays` は賃金計算に入らなかった
 * 日数 = 休暇・自主出勤・打刻はあったが実働 0 の日数の合計。打刻エラーの内訳は
 * `punchErrorDays` で別に持つ。
 *
 * 休暇だけで打刻が 1 日も無い社員も summary に出る (nginx#779 で公休の行が来る
 * ようになったため)。勤務 0・休暇日数だけの行になり、給与明細の公休日数と
 * 突合できる。
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
    const day = summarizeTimecardDay(row, {
      dailyWorkMinutes: opts.dailyWorkMinutesFor(driverCd),
      approved,
      clerical: opts.isClerical?.(driverCd) ?? false,
      nightShift: opts.isNightShift?.(driverCd) ?? false,
      today: opts.today,
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
      // 退社打刻なし (missingClockOut) も打刻エラーの一種として数える — 分が 0 でも
      // 実時間が分からない日であることに変わりはない (nginx#780)。所定で計上した日も
      // 含むので、これは「打刻を直すべき日」の数 (Refs #468)
      punchErrorDays: days.filter((d) => d.punchErrorMinutes > 0 || d.missingClockOut === true).length,
      punchErrorMinutes: sum((d) => d.punchErrorMinutes),
      leaveCounts: countLeaves(days.flatMap((d) => d.leaves)),
    });
    const missingDays = days.filter((d) => d.missingClockOut === true);
    if (missingDays.length > 0) {
      // 所定が引けない日だけ従来どおり外れる (`scheduledMinutesFor` が null)。
      // 全部所定で計上できたのか、外した日があるのかで文言を変える (Refs #468)
      const excluded = missingDays.filter((d) => d.isRestDay).length;
      warnings.push(
        `乗務員 ${driverCd} (${entry.name}): 退社打刻の無い日が ${missingDays.length} 日あります`
        + ` (${missingDays.map((d) => d.day).join(", ")} 日) — `
        + (excluded > 0
          ? `うち ${excluded} 日は所定労働時間が引けないため賃金計算から外しています`
          : "時間は所定労働時間で計上しています")
        + "。打刻を直して取り込み直すと実測に置き換わります",
      );
    }
  }
  summaries.sort((a, b) => Number(a.driverCd) - Number(b.driverCd));
  return { summaries, warnings };
}

// ---------------------------------------------------------------------------
// wage-report での合流 (Refs #424 PR-D)
// ---------------------------------------------------------------------------

/** 賃金行の出どころ。 */
export type WageReportSource = "theearth" | "timecard";

export interface MergedSummaryEntry<T> {
  entry: T;
  source: WageReportSource;
}

/**
 * デジタコ (拘束時間 CSV) にしか無い指標。タイムカードは打刻しか持たないので
 * **構造的に出せない** — 重複乗務員でタイムカードを採るとき、この分だけは
 * デジタコ側の値で埋め戻す (改善基準告示の管理項目が丸ごと空欄になるのを防ぐ)。
 *
 * `over15hDays` は入れない — タイムカードが自分の拘束から数えた値を持っており、
 * 同じ行の「拘束合計」と整合する方を残すため。
 */
interface TheearthOnlyMetrics {
  drivingMinutes: number | null;
  loadingMinutes: number | null;
  fiscalCumulativeMinutes: number | null;
  restraintLimitMinutes: number | null;
  excessRestraintMinutes: number | null;
  /** 2 日平均運転 9h 超の回数。運転時間が要るのでタイムカードは常に 0。 */
  avgDriving9hOverCount: number;
}

/** 埋め戻す対象のうち「タイムカードでは null」になる分。 */
const THEEARTH_ONLY_NULLABLE_KEYS = [
  "drivingMinutes",
  "loadingMinutes",
  "fiscalCumulativeMinutes",
  "restraintLimitMinutes",
  "excessRestraintMinutes",
] as const satisfies ReadonlyArray<keyof TheearthOnlyMetrics>;

type MergeableSummary = { driverCd: string } & Partial<TheearthOnlyMetrics>;

/**
 * タイムカード行にデジタコ由来の指標を埋め戻した entry を返す。
 * 埋めるものが無ければ元の entry をそのまま返す (無駄なコピーを作らない)。
 */
function fillTheearthOnlyMetrics<T extends { data: MergeableSummary }>(
  timecardEntry: T,
  theearthEntry: T,
): T {
  const from = theearthEntry.data;
  const to = timecardEntry.data;
  const filled: Partial<TheearthOnlyMetrics> = {};
  for (const key of THEEARTH_ONLY_NULLABLE_KEYS) {
    if (to[key] == null && from[key] != null) filled[key] = from[key];
  }
  // 0 (= 数えられなかった) のときだけデジタコの回数を採る
  if (!to.avgDriving9hOverCount && from.avgDriving9hOverCount) {
    filled.avgDriving9hOverCount = from.avgDriving9hOverCount;
  }
  if (Object.keys(filled).length === 0) return timecardEntry;
  return { ...timecardEntry, data: { ...timecardEntry.data, ...filled } };
}

/**
 * theearth (デジタコ) と timecard (タイムカード) のサマリを 1 本の行列に合流する。
 *
 * **同じ乗務員CD が両方に居たら timecard を採る** — 賃金は打刻を根拠にするため、
 * 拘束/実働/時間外/深夜と勤怠日数はタイムカード側で統一する (2026-07-28 決定)。
 * デジタコにしか無い列 (運転・荷役・年度累計・当月超過・平均運転9h超) だけは
 * `fillTheearthOnlyMetrics` でデジタコ側から埋め戻す。落とした側は warnings に
 * 出す (人によっては両方に痕跡が残りうるので、黙って消さない)。
 *
 * 並びは乗務員CD の数値順。`localeCompare` を使わないのは ICU の照合順が Windows と
 * Linux (CI) で食い違い、決定的な順序という目的自体が壊れるため (Refs #403)。
 */
export function mergeSummarySources<T extends { data: MergeableSummary }>(
  theearth: readonly T[],
  timecard: readonly T[],
): { merged: MergedSummaryEntry<T>[]; warnings: string[] } {
  const theearthByDriver = new Map(theearth.map((s) => [s.data.driverCd, s]));
  const fromTimecard = new Set(timecard.map((s) => s.data.driverCd));
  const duplicated: string[] = [];
  const merged: MergedSummaryEntry<T>[] = timecard.map((entry) => {
    const counterpart = theearthByDriver.get(entry.data.driverCd);
    if (!counterpart) return { entry, source: "timecard" as const };
    duplicated.push(entry.data.driverCd);
    return { entry: fillTheearthOnlyMetrics(entry, counterpart), source: "timecard" as const };
  });
  for (const entry of theearth) {
    if (fromTimecard.has(entry.data.driverCd)) continue;
    merged.push({ entry, source: "theearth" });
  }
  merged.sort((a, b) => Number(a.entry.data.driverCd) - Number(b.entry.data.driverCd));
  const warnings: string[] = [];
  if (duplicated.length > 0) {
    warnings.push(
      `乗務員CD ${duplicated.join(", ")} は デジタコ と タイムカード の両方にサマリがあるため、`
      + `タイムカード側を採用しました `
      + `(運転・荷役・年度累計・当月超過・平均運転9h超 はタイムカードから出せないため`
      + `デジタコ側の値で補っています)`,
    );
  }
  return { merged, warnings };
}

/**
 * タイムカード由来データの R2 キー設計 (`restraintR2Paths` と同型)。
 *
 * theearth 由来 (`restraint/...`) とは**別 prefix に置く** — 同じ月・同じ乗務員CD で
 * 両方が存在しうるので、混ぜると resummarize や版管理が互いを踏む。合流は読み出し側
 * (wage-report) で行う。
 */
export interface KintaiR2Paths {
  /** 生 JSON のディレクトリ (版一覧の list 用)。 */
  rawDir: string;
  /** 上流応答の最新スナップショット。 */
  rawLatest: string;
  /** 上流応答の版 (内容が変わった取得時のみ追加)。 */
  rawVersion(ts: string): string;
  /** 取得ごとの確認履歴 (JSONL)。 */
  rawHistory: string;
  /** 社員別サマリ JSON のディレクトリ。 */
  summaryDir(driverCd: string): string;
  summaryLatest(driverCd: string): string;
  summaryVersion(driverCd: string, ts: string): string;
}

export function kintaiR2Paths(
  prefix: string,
  compId: string,
  year: number,
  month: number,
): KintaiR2Paths {
  const ym = `${year}-${String(month).padStart(2, "0")}`;
  const base = `${prefix}/${compId}/${ym}`;
  const summaryDir = (driverCd: string) => `${base}/summary/${driverCd || "unknown"}`;
  return {
    rawDir: `${base}/raw`,
    rawLatest: `${base}/raw/latest.json`,
    rawVersion: (ts) => `${base}/raw/v-${ts}.json`,
    rawHistory: `${base}/raw/history.jsonl`,
    summaryDir,
    summaryLatest: (driverCd) => `${summaryDir(driverCd)}/latest.json`,
    summaryVersion: (driverCd, ts) => `${summaryDir(driverCd)}/v-${ts}.json`,
  };
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
