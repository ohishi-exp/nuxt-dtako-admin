/**
 * GCP 側で畳んだ日別サマリ (`kintai.day_summaries`) を賃金計算の素材に写す
 * (最低賃金チェックの「拘束時間ソース」切り替え用)。
 *
 * ## 位置づけ
 *
 * `wage-report` の既定 (= 従来の唯一の経路) は **theearth の拘束時間管理表 CSV** と
 * **オンプレ `kosoku-daily` (打刻 + 休息、MariaDB 直読み)** の合流で、GCP は 1 行も
 * 混ざらない。この module はその**時間だけ**を GCP 由来に差し替えるためのもので、
 * 既定の経路には一切触らない。
 *
 * ## 何を差し替え、何を差し替えないか
 *
 * 差し替えるのは**時間**だけ。休暇・休日区分 (`holidayKind`)・打刻エラー・自主出勤は
 * 元の日別行から引き継ぐ — GCP `day_summaries` はそれらを持たないため。
 * `applyKosokuTimes` (2026-07-28、オンプレ側で同じことをしている) と同じ作法。
 *
 * 運転・荷役・年度累計・平均運転9h超過はデジタコ (theearth) 側にしか無いので**そのまま
 * 残す** — `fillTheearthOnlyMetrics` と同じ扱い。
 *
 * ## ★ GCP には暦日按分の内訳 (`parts`) が無い
 *
 * オンプレ `kosoku-daily` は日跨ぎ勤務を `parts` で暦日に割り直せるが、
 * `day_summaries` は**勤務を始業日へ丸ごと寄せたまま**返す (キーが
 * `乗務員CD|暦日|開始時刻` = 始業ベース)。つまり GCP を選ぶと**日跨ぎ勤務の拘束は
 * 始業日に全部乗る**。月合計はどちらでも変わらないが、月境界を跨ぐ勤務のぶんだけ
 * 月合計もずれる。**「GCP の日別値がオンプレとずれている」を全部データの差と
 * 読まないこと** — この構造差が先に効く。
 *
 * ## `overtime_night_minutes` は `overtime_minutes` の内数なので引く
 *
 * `kosoku-daily.ts` の `toPart` と**同じ理由・同じ式**。日別行 (`RestraintSummaryDay`)
 * は「実働 = 法定内 + 時間外 + 時間外深夜」が成り立つ排他の契約なので、内数のまま流すと
 * 時間外深夜が 1.25 と 1.5 の両方で払われる (Refs #564)。列名は両受け口で一致している
 * (`kintai-diff.ts` の `KINTAI_DIFF_MINUTE_FIELDS`) ので、変換もここで揃える。
 */

import type { RestraintDriverSummary, RestraintSummaryDay } from "./theearth-restraint-client";

/** 暦日 1 日ぶんの時間 (分)。`KosokuCalendarPart` の GCP 版 (差の説明用の実額は無い)。 */
export interface GcpDayPart {
  restraintMinutes: number;
  workingMinutes: number;
  breakMinutes: number;
  /** 法定時間外のうち**深夜に重ならない分** (`overtimeNightMinutes` と排他)。 */
  overtimeMinutes: number;
  /** 深夜 (所定内・法定内残業ぶん + 法定休日ぶん)。時間外深夜とは排他。 */
  nightMinutes: number;
  /** 時間外に重なる深夜。`overtimeMinutes` とは排他。 */
  overtimeNightMinutes: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * `{summaries: {"乗務員CD|暦日|開始時刻": {...}}}` を **乗務員CD → 暦日 → 時間** に直す。
 *
 * - 乗務員CD は `String(Number(...))` で正規化する (`parseKosokuDaily` と同じ規則)
 * - 暦日が `YYYY-MM-DD` でないキーは捨てる (置き場が無い)
 * - 乗務員CD 0 は捨てる (社員マスタに居ない番号が実測で返る)
 * - **同じ暦日に複数の勤務があれば足し合わせる** (キーは開始時刻まで含むので複数来る)
 */
export function parseGcpDaySummaries(body: unknown): Map<string, Map<string, GcpDayPart>> {
  const out = new Map<string, Map<string, GcpDayPart>>();
  if (typeof body !== "object" || body === null) return out;
  const summaries = (body as { summaries?: unknown }).summaries;
  if (typeof summaries !== "object" || summaries === null || Array.isArray(summaries)) return out;
  for (const [key, raw] of Object.entries(summaries as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const [driver, date] = key.split("|");
    if (typeof date !== "string" || !DATE_RE.test(date)) continue;
    const cd = Number(driver);
    if (!Number.isFinite(cd) || cd === 0) continue;
    const r = raw as Record<string, unknown>;
    const overtimeNightMinutes = num(r.overtime_night_minutes);
    const part: GcpDayPart = {
      restraintMinutes: num(r.restraint_minutes),
      workingMinutes: num(r.working_minutes),
      breakMinutes: num(r.break_minutes),
      // `Math.max` は上流が壊れた値を返した時の防御 (構成上 内数 ≤ 全体 は保証される)
      overtimeMinutes: Math.max(0, num(r.overtime_minutes) - overtimeNightMinutes),
      nightMinutes: num(r.night_minutes) + num(r.legal_holiday_night_minutes),
      overtimeNightMinutes,
    };
    const driverCd = String(cd);
    let byDate = out.get(driverCd);
    if (!byDate) {
      byDate = new Map<string, GcpDayPart>();
      out.set(driverCd, byDate);
    }
    const cur = byDate.get(date);
    if (!cur) {
      byDate.set(date, part);
      continue;
    }
    cur.restraintMinutes += part.restraintMinutes;
    cur.workingMinutes += part.workingMinutes;
    cur.breakMinutes += part.breakMinutes;
    cur.overtimeMinutes += part.overtimeMinutes;
    cur.nightMinutes += part.nightMinutes;
    cur.overtimeNightMinutes += part.overtimeNightMinutes;
  }
  return out;
}

/** サマリ側の乗務員CD で GCP 側を引く (両側とも `String(Number(...))` に揃える)。 */
export function gcpPartsFor(
  byDriver: ReadonlyMap<string, Map<string, GcpDayPart>>,
  driverCd: string,
): ReadonlyMap<string, GcpDayPart> | null {
  const cd = Number(driverCd);
  if (!Number.isFinite(cd)) return null;
  return byDriver.get(String(cd)) ?? null;
}

/** `YYYY-MM-DD` が日曜か。UTC で作るのは JST 変換で日付がずれないようにするため。 */
function isSunday(date: string): boolean {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
}

/** 時間だけを空にしたサマリ (GCP にその乗務員の行が無い月)。 */
function blankTimes(summary: RestraintDriverSummary): RestraintDriverSummary {
  return {
    ...summary,
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
  };
}

export interface GcpOverlayResult {
  summary: RestraintDriverSummary;
  /** GCP 側にこの乗務員 × この月の行が 1 つも無かった (= 欠測)。 */
  missing: boolean;
}

/**
 * サマリの**時間を GCP `day_summaries` 由来に差し替える**。
 *
 * - GCP に勤務がある暦日 … 時間を差し替え、勤務日 (`isRestDay: false`) にする
 * - GCP に勤務が無い暦日 … 時間は 0。**`isRestDay` は元の判定のまま**にする
 *   (打刻はあるのに GCP が勤務を組めていない日を「休み」に見せないため)
 * - 元の日別行に無い暦日 … 行を足す。**`holidayKind` は日曜だけ `legal`** —
 *   祝日・会社指定休の判定は打刻側の行にしかなく、GCP からは引けない
 *
 * **`missing: true` の行は 0 分ではなく `null` (欠測) にする** (ユーザー決定 2026-08-04)。
 * 0 分に倒すと `computeWageRow` が「拘束 0 の月」として最低賃金割れの判定を回してしまう。
 *
 * 出勤日数 (`workDays`/`restDays`) は差し替えない — GCP には休暇区分が無く、
 * 打刻由来の `restDays` (賃金計算に入らなかった日数) とは意味が違うため。
 */
export function overlayGcpDayTimes(
  summary: RestraintDriverSummary,
  parts: ReadonlyMap<string, GcpDayPart> | null,
  ym: string,
): GcpOverlayResult {
  const inMonth = new Map<number, GcpDayPart>();
  for (const [date, p] of parts ?? []) {
    if (date.slice(0, 7) !== ym) continue;
    inMonth.set(Number(date.slice(8, 10)), p);
  }
  if (inMonth.size === 0) return { summary: blankTimes(summary), missing: true };

  const days: RestraintSummaryDay[] = summary.days.map((d) => {
    const p = inMonth.get(d.day);
    return {
      ...d,
      isRestDay: p ? false : d.isRestDay,
      restraintMinutes: p?.restraintMinutes ?? 0,
      workingMinutes: p?.workingMinutes ?? 0,
      overtimeMinutes: p?.overtimeMinutes ?? 0,
      nightMinutes: p?.nightMinutes ?? 0,
      overtimeNightMinutes: p?.overtimeNightMinutes ?? 0,
    };
  });
  const seen = new Set(summary.days.map((d) => d.day));
  for (const [day, p] of inMonth) {
    if (seen.has(day)) continue;
    days.push({
      day,
      isRestDay: false,
      restraintMinutes: p.restraintMinutes,
      workingMinutes: p.workingMinutes,
      overtimeMinutes: p.overtimeMinutes,
      nightMinutes: p.nightMinutes,
      overtimeNightMinutes: p.overtimeNightMinutes,
      holidayKind: isSunday(`${ym}-${String(day).padStart(2, "0")}`) ? "legal" : "weekday",
    });
  }
  days.sort((a, b) => a.day - b.day);

  // 集計は `inMonth` (= GCP が返した暦日) から出す。GCP に勤務が無い暦日は上で 0 分に
  // 倒しているので、日別行から数え直しても同じ値になる
  const monthParts = [...inMonth.values()];
  const sum = (pick: (p: GcpDayPart) => number): number =>
    monthParts.reduce((acc, p) => acc + pick(p), 0);
  const dailyRestraints = monthParts.map((p) => p.restraintMinutes);
  const restraintMinutes = sum((p) => p.restraintMinutes);
  return {
    summary: {
      ...summary,
      restraintMinutes,
      workingMinutes: sum((p) => p.workingMinutes),
      breakMinutes: sum((p) => p.breakMinutes),
      overtimeMinutes: sum((p) => p.overtimeMinutes),
      nightMinutes: sum((p) => p.nightMinutes),
      overtimeNightMinutes: sum((p) => p.overtimeNightMinutes),
      maxDailyRestraintMinutes: Math.max(...dailyRestraints),
      over15hDays: dailyRestraints.filter((v) => v > 15 * 60).length,
      excessRestraintMinutes:
        summary.restraintLimitMinutes !== null
          ? Math.max(0, restraintMinutes - summary.restraintLimitMinutes)
          : null,
      days,
    },
    missing: false,
  };
}
