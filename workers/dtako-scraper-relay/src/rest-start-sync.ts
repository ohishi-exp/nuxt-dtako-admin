/**
 * `POST /kintai-relay/rest-start-sync` (休息の開始の補正、Refs ohishi-exp/rust-ichibanboshi#322) の pure ロジック。
 *
 * theearth の拘束時間管理表は、休息の直前の運転を休息ボタンの時刻ではなく、車載器の速度データ (NET780 の `.spd`) で
 * 最後に車が動いた時刻で終える。最後の動きとボタンが同じ分に収まらないときだけ、勤怠 Worker の拘束・実働が管理表より
 * 1 分長くなる。そこで:
 *
 * 1. 管理表の日別の行 (拘束時間小計・実働) と勤怠 Worker の `day_summaries` を、乗務員 + 始業 (分まで) で突き合わせ、
 *    **拘束も実働もちょうど +1 分**の勤務だけを候補にする ([`pickRestStartCandidates`])
 * 2. 候補の勤務を締める alc の `休息` の行を、勤怠 Worker の alc-events から探す ([`closingRest`])
 * 3. その運行の NET780 zip の `.spd` で最後の動きを出し (`net780-spd.ts`)、休息の開始と分が違えば補正にする
 *    ([`restStartOverride`])
 *
 * DO (`/cron/rest-start-sync`) が theearth のログイン・NET780 のアーカイブ・勤怠 Worker への PUT と畳み直しを持つ。
 */
import type { RestraintDriverBlock, RestraintReport } from "./theearth-restraint-client";

/** 突き合わせの 1 行 (どちらの側も同じ形)。`start` は JST の `YYYY-MM-DD HH:MM`。 */
export interface RestStartRow {
  driverCd: string;
  start: string;
  restraint: number;
  working: number;
}

/** `H:MM` → 分。空・読めない値は `null`。 */
function hm(s: string | undefined): number | null {
  const m = /^(\d+):(\d{2})$/.exec((s ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * 管理表 1 人ぶんの日別の行。拘束は **拘束時間小計** (重複を含まない、勤怠 Worker の拘束と同じ軸)。始業の日は
 * 行の `day` (管理表の行は始業の日に並ぶ)。休日・始業の無い行・小計か実働が読めない行は落とす。
 */
export function theearthRows(block: RestraintDriverBlock, year: number, month: number): RestStartRow[] {
  const sub = block.header.indexOf("拘束時間小計");
  const out: RestStartRow[] = [];
  for (const d of block.days) {
    const start = hm(d.startTime);
    const restraint = hm(d.columns[sub]);
    if (d.isRestDay || d.day === null || start === null || restraint === null || d.workingMinutes === null) continue;
    const date = `${year}-${pad2(month)}-${pad2(d.day)}`;
    out.push({
      driverCd: block.driverCd,
      start: `${date} ${pad2(Math.floor(start / 60))}:${pad2(start % 60)}`,
      restraint,
      working: d.workingMinutes,
    });
  }
  return out;
}

/** 管理表全員ぶん ([`theearthRows`] を全乗務員で)。 */
export function theearthReportRows(report: RestraintReport): RestStartRow[] {
  return report.drivers.flatMap((b) => theearthRows(b, report.year, report.month));
}

/**
 * 勤怠 Worker の `GET /api/kintai/day-summaries` の本文 (`summaries` の鍵は `乗務員CD|暦日|開始時刻`) → 行。
 * 鍵の開始時刻 (`YYYY-MM-DD HH:MM:SS`) を分まで使う。拘束・実働が数でない行は落とす。
 */
export function kintaiRows(body: unknown): RestStartRow[] {
  const summaries = (body as { summaries?: Record<string, { restraint_minutes?: unknown; working_minutes?: unknown }> })
    ?.summaries;
  if (!summaries || typeof summaries !== "object") return [];
  const out: RestStartRow[] = [];
  for (const [key, v] of Object.entries(summaries)) {
    const [driverCd, , start] = key.split("|");
    if (!start || typeof v?.restraint_minutes !== "number" || typeof v?.working_minutes !== "number") continue;
    out.push({ driverCd, start: start.slice(0, 16), restraint: v.restraint_minutes, working: v.working_minutes });
  }
  return out;
}

/** 候補 (勤怠 Worker が拘束も実働もちょうど 1 分長い勤務)。 */
export interface RestStartCandidate {
  driverCd: string;
  /** 始業 (JST の `YYYY-MM-DD HH:MM`) */
  start: string;
  theearth: { restraint: number; working: number };
  kintai: { restraint: number; working: number };
}

/** 乗務員 + 始業 (分まで) で突き合わせ、勤怠 Worker が拘束も実働も +1 分の勤務だけを返す (乗務員・始業の順)。 */
export function pickRestStartCandidates(theearth: RestStartRow[], kintai: RestStartRow[]): RestStartCandidate[] {
  const byKey = new Map(kintai.map((r) => [`${r.driverCd}|${r.start}`, r]));
  const out: RestStartCandidate[] = [];
  for (const t of theearth) {
    const k = byKey.get(`${t.driverCd}|${t.start}`);
    if (!k || k.restraint - t.restraint !== 1 || k.working - t.working !== 1) continue;
    out.push({
      driverCd: t.driverCd,
      start: t.start,
      theearth: { restraint: t.restraint, working: t.working },
      kintai: { restraint: k.restraint, working: k.working },
    });
  }
  return out.sort((a, b) => Number(a.driverCd) - Number(b.driverCd) || a.start.localeCompare(b.start));
}

/** 勤務を締める休息。`restStart` は alc の行の開始 (JST の `YYYY-MM-DD HH:MM:SS`)。 */
export interface ClosingRest {
  restStart: string;
  unkoNo: string;
}

interface AlcEventsBody {
  shifts?: { start?: string; end?: string }[];
  events?: { datetime?: string; state?: string; unko_no?: string | null }[];
}

/**
 * 勤怠 Worker の `GET /api/kintai/alc-events` の本文から、始業が `start` (分まで) の勤務を締める `休息` の行。
 * 勤務の終わり (分) と開始が同じ分の `休息` の行で、始業より後のもの。見つからなければ `null`
 * (勤務が休息で締まっていない = 24 時間の日締めや運行終了で終わる勤務は補正の対象外)。
 */
export function closingRest(body: unknown, start: string): ClosingRest | null {
  const b = body as AlcEventsBody;
  const shift = (b?.shifts ?? []).find((s) => s.start?.slice(0, 16) === start);
  const end = shift?.end?.slice(0, 16);
  if (!end) return null;
  const rest = (b.events ?? []).find(
    (e) => e.state === "休息" && e.datetime?.slice(0, 16) === end && e.datetime > start && /^\d{22}$/.test(e.unko_no ?? ""),
  );
  return rest ? { restStart: rest.datetime!, unkoNo: rest.unko_no! } : null;
}

/** 運行NO (22 桁、先頭 12 桁が出庫の `YYMMDDhhmmss`) → NET780 の検索の `start_ope` (`YYYY/MM/DD H:mm:ss`)。 */
export function startOpeFromUnkoNo(unkoNo: string): string {
  // 運行NO は呼び手 ([`closingRest`]) が 22 桁の数字だと確かめている
  const [yy, mo, dd, hh, mi, ss] = unkoNo.slice(0, 12).match(/\d{2}/g)!;
  return `20${yy}/${mo}/${dd} ${Number(hh)}:${mi}:${ss}`;
}

/** 勤怠 Worker の `PUT /api/kintai/rest-start-overrides` の 1 件。 */
export interface RestStartOverrideItem {
  driver_cd: number;
  rest_start_at: string;
  last_move_at: string;
  unko_no: string;
}

/**
 * 補正の 1 件。最後の動きが無い (休息の前 1 時間に動いていない) か、休息の開始と同じ分なら `null`
 * (勤怠 Worker の値は変わらないので書かない)。
 */
export function restStartOverride(
  driverCd: string,
  rest: ClosingRest,
  lastMove: string | null,
): RestStartOverrideItem | null {
  if (lastMove === null || lastMove.slice(0, 16) === rest.restStart.slice(0, 16)) return null;
  return { driver_cd: Number(driverCd), rest_start_at: rest.restStart, last_move_at: lastMove, unko_no: rest.unkoNo };
}

/**
 * 候補の乗務員の alc-events を読む範囲 (月の前後 2 日。`YYYY-MM-DD`、`to` の日を含む)。勤務は渡した範囲の行だけで
 * 組まれる (24 時間の日締めの鎖は読み始めで切れる) ので、1 日だけでなく月ごと読む。月初の勤務は fold (月初の遡り)
 * と組み方が違いうるが、そのときは始業が合わず候補から外れるだけ ([`closingRest`] が `null`)。
 */
export function alcEventsRange(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number);
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { from: day(Date.UTC(y, m - 1, 1) - 2 * 86400000), to: day(Date.UTC(y, m, 2)) };
}
