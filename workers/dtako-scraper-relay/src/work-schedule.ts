/**
 * 勤務設定マスタの pure ロジック — 所定労働時間 (`work_schedules`)、承認済み休日出勤
 * (`holiday_work_approvals`)、夜勤者 (`night_shift_workers`)
 * (Refs #424 PR-C / #433 PR-A、migration 0011/0012/0014)。
 *
 * いずれもタイムカード (社内 CakePHP) 由来の勤務を法定区分へ振り分けるための入力:
 *
 * - **所定労働時間** … 実働がこれを超えた分が時間外。デジタコ (theearth) 由来の
 *   乗務員は CSV が時間外をそのまま持っているので対象外 — 効くのは timecard 由来
 *   の summary だけ。
 * - **休日出勤の承認** … 休日に打刻がある日のうち、この表に載っている日だけが
 *   割増賃金の対象 (休日出勤)。載っていない日は「自主出勤」として賃金計算から
 *   外す (時間は記録・表示する)。
 * - **夜勤者** … 日跨ぎ打刻を打刻エラーとみなす判定からの除外リスト。事務職の
 *   日跨ぎは通常「終業の押し忘れ」だが、夜勤者は正常に日をまたぐ。
 *
 * **休憩の所定値は持たない**: 事務員は昼休憩で打刻を切っていることが実データで
 * 分かったため、休憩は打刻 (sessions) の中抜けギャップと 12:00-13:00 の和集合から
 * 算出する (PR-B の責務)。
 *
 * D1Database への実際の読み書きは DO 側 (dtako-scraper-relay-do.ts) が行う —
 * このファイルは「入力検証・SQL 文組み立て・応答整形・解決規則」の pure な部分
 * だけを持ち、cloudflare:workers 依存が無いため素の vitest (node 環境) で 100%
 * カバレッジ計測できる (employee-master.ts と同型)。
 */

import { lastDayOfMonth } from "./employee-master";
import { TheearthClientError } from "./theearth-client";

/** マスタ入力の構造不正 (呼び出し側で 400 にマップする)。 */
export class WorkScheduleError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "WorkScheduleError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * スコープの「全体」を表す番兵値。
 *
 * **NULL を使わない**: SQLite (D1) の UNIQUE / PRIMARY KEY は NULL 同士を
 * 「異なる値」として扱うため、NULL を PK に含めると `ON CONFLICT DO UPDATE` が
 * 一致せず、同じ全社既定行が upsert のたびに二重に入る (migration 0011 の注記)。
 * アプリ側の型は `number | null` / `string | null` のままにして、SQL 境界だけで
 * この番兵値に変換する。
 */
export const ALL_BRANCHES = -1;
export const ALL_JOBS = "";

// ---------------------------------------------------------------------------
// 所定労働時間マスタ
// ---------------------------------------------------------------------------

export interface WorkScheduleInput {
  /** YYYY-MM-DD */
  effectiveFrom: string;
  /** 所属コード (`SHOZOKU.INCODE`)。null = 全拠点。 */
  branchCode: number | null;
  /** 職種名 (`SHOZOKU.NAME2`)。null = 全職種。 */
  jobName: string | null;
  /** 1 日の所定労働時間 (分)。 */
  dailyWorkMinutes: number;
}

export interface WorkScheduleDeleteKey {
  effectiveFrom: string;
  branchCode: number | null;
  jobName: string | null;
}

export interface WorkSchedulePutBody {
  schedules: WorkScheduleInput[];
  deleteSchedules: WorkScheduleDeleteKey[];
}

/** D1 から読んだ所定 1 行 (番兵値は復元済み)。 */
export interface WorkScheduleRow extends WorkScheduleInput {}

/** D1 の生の行。 */
export interface WorkScheduleD1Row {
  effective_from: string;
  branch_code: number;
  job_name: string;
  daily_work_minutes: number;
}

// ---------------------------------------------------------------------------
// 休日出勤の承認簿
// ---------------------------------------------------------------------------

export interface HolidayWorkInput {
  driverCd: string;
  /** YYYY-MM-DD (始業日基準)。 */
  workDate: string;
  reason: string | null;
}

export interface HolidayWorkDeleteKey {
  driverCd: string;
  workDate: string;
}

export interface HolidayWorkPutBody {
  approvals: HolidayWorkInput[];
  deleteApprovals: HolidayWorkDeleteKey[];
}

export interface HolidayWorkD1Row {
  driver_cd: string;
  work_date: string;
  reason: string | null;
}

// ---------------------------------------------------------------------------
// 夜勤者マスタ (Refs #433 PR-A)
// ---------------------------------------------------------------------------

export interface NightShiftInput {
  driverCd: string;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  /** この日から夜勤者か。false = 解除 (行を消さずに履歴で終わらせる)。 */
  isNight: boolean;
}

export interface NightShiftDeleteKey {
  driverCd: string;
  effectiveFrom: string;
}

export interface NightShiftPutBody {
  workers: NightShiftInput[];
  deleteWorkers: NightShiftDeleteKey[];
}

export interface NightShiftD1Row {
  driver_cd: string;
  effective_from: string;
  is_night: number;
}

export interface NightShiftEntry extends NightShiftInput {}

// ---------------------------------------------------------------------------
// 入力の検証・正規化
// ---------------------------------------------------------------------------

function normalizeDate(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !DATE_RE.test(raw)) {
    throw new WorkScheduleError(`${field} は YYYY-MM-DD が必要です`);
  }
  return raw;
}

/** 乗務員CD (前ゼロ除去)。employee-master の normalizeDriverCd と同一規則。 */
function normalizeDriverCd(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !/^\d{1,8}$/.test(raw.trim())) {
    throw new WorkScheduleError(`${field} は数字 (最大8桁) が必要です (${JSON.stringify(raw)})`);
  }
  return String(Number(raw.trim()));
}

/**
 * スコープの所属コード。**null / 未指定 = 全拠点**。
 * employee_attrs.branch_code と同じく 0 以下は「未設定」なので全拠点へ倒す。
 */
function normalizeScopeBranchCode(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) return null;
  return raw;
}

/** スコープの職種名。**null / 空文字 = 全職種**。 */
function normalizeScopeJobName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.normalize("NFKC").trim();
  return trimmed || null;
}

/** 所定労働時間 (分)。1 日を超える値・非整数は受けない。 */
function normalizeDailyWorkMinutes(raw: unknown, field: string): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > 24 * 60) {
    throw new WorkScheduleError(`${field} は 1〜1440 の整数 (分) が必要です (${JSON.stringify(raw)})`);
  }
  return raw;
}

function normalizeOptionalText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.normalize("NFKC").trim();
  return trimmed || null;
}

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkScheduleError(`${field} がオブジェクトではありません`);
  }
  return raw as Record<string, unknown>;
}

function normalizeArray<T>(raw: unknown, field: string, fn: (item: unknown, i: number) => T): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new WorkScheduleError(`${field} は配列が必要です`);
  return raw.map(fn);
}

function normalizeScheduleInput(raw: unknown, index: number): WorkScheduleInput {
  const obj = asObject(raw, `schedules[${index}]`);
  return {
    effectiveFrom: normalizeDate(obj.effectiveFrom, `schedules[${index}].effectiveFrom`),
    branchCode: normalizeScopeBranchCode(obj.branchCode),
    jobName: normalizeScopeJobName(obj.jobName),
    dailyWorkMinutes: normalizeDailyWorkMinutes(obj.dailyWorkMinutes, `schedules[${index}].dailyWorkMinutes`),
  };
}

function normalizeScheduleDeleteKey(raw: unknown, index: number): WorkScheduleDeleteKey {
  const obj = asObject(raw, `deleteSchedules[${index}]`);
  return {
    effectiveFrom: normalizeDate(obj.effectiveFrom, `deleteSchedules[${index}].effectiveFrom`),
    branchCode: normalizeScopeBranchCode(obj.branchCode),
    jobName: normalizeScopeJobName(obj.jobName),
  };
}

/** PUT /restraint-api/work-schedule の body を検証・正規化する (差分送信、未指定は空配列)。 */
export function normalizeWorkSchedulePutBody(raw: unknown): WorkSchedulePutBody {
  const obj = asObject(raw, "work-schedule の PUT body");
  return {
    schedules: normalizeArray(obj.schedules, "schedules", normalizeScheduleInput),
    deleteSchedules: normalizeArray(obj.deleteSchedules, "deleteSchedules", normalizeScheduleDeleteKey),
  };
}

function normalizeHolidayWorkInput(raw: unknown, index: number): HolidayWorkInput {
  const obj = asObject(raw, `approvals[${index}]`);
  return {
    driverCd: normalizeDriverCd(obj.driverCd, `approvals[${index}].driverCd`),
    workDate: normalizeDate(obj.workDate, `approvals[${index}].workDate`),
    reason: normalizeOptionalText(obj.reason),
  };
}

function normalizeHolidayWorkDeleteKey(raw: unknown, index: number): HolidayWorkDeleteKey {
  const obj = asObject(raw, `deleteApprovals[${index}]`);
  return {
    driverCd: normalizeDriverCd(obj.driverCd, `deleteApprovals[${index}].driverCd`),
    workDate: normalizeDate(obj.workDate, `deleteApprovals[${index}].workDate`),
  };
}

/** PUT /restraint-api/holiday-work の body を検証・正規化する (差分送信、未指定は空配列)。 */
export function normalizeHolidayWorkPutBody(raw: unknown): HolidayWorkPutBody {
  const obj = asObject(raw, "holiday-work の PUT body");
  return {
    approvals: normalizeArray(obj.approvals, "approvals", normalizeHolidayWorkInput),
    deleteApprovals: normalizeArray(obj.deleteApprovals, "deleteApprovals", normalizeHolidayWorkDeleteKey),
  };
}

function normalizeNightShiftInput(raw: unknown, index: number): NightShiftInput {
  const obj = asObject(raw, `workers[${index}]`);
  if (typeof obj.isNight !== "boolean") {
    throw new WorkScheduleError(`workers[${index}].isNight は true / false が必要です`);
  }
  return {
    driverCd: normalizeDriverCd(obj.driverCd, `workers[${index}].driverCd`),
    effectiveFrom: normalizeDate(obj.effectiveFrom, `workers[${index}].effectiveFrom`),
    isNight: obj.isNight,
  };
}

function normalizeNightShiftDeleteKey(raw: unknown, index: number): NightShiftDeleteKey {
  const obj = asObject(raw, `deleteWorkers[${index}]`);
  return {
    driverCd: normalizeDriverCd(obj.driverCd, `deleteWorkers[${index}].driverCd`),
    effectiveFrom: normalizeDate(obj.effectiveFrom, `deleteWorkers[${index}].effectiveFrom`),
  };
}

/** PUT /restraint-api/night-shift の body を検証・正規化する (差分送信、未指定は空配列)。 */
export function normalizeNightShiftPutBody(raw: unknown): NightShiftPutBody {
  const obj = asObject(raw, "night-shift の PUT body");
  return {
    workers: normalizeArray(obj.workers, "workers", normalizeNightShiftInput),
    deleteWorkers: normalizeArray(obj.deleteWorkers, "deleteWorkers", normalizeNightShiftDeleteKey),
  };
}

// ---------------------------------------------------------------------------
// D1 書き込み文の組み立て (pure — 実行は DO 側で db.prepare(sql).bind(...params))
// ---------------------------------------------------------------------------

export interface D1Statement {
  sql: string;
  params: unknown[];
}

/**
 * 所定マスタの差分 upsert/削除を prepared statement 列に変換する。
 * last-write-wins (楽観排他なし — D1 行単位 upsert のため不要、employee-master と同型)。
 *
 * 全文が `comp_id` を含む — 呼び出し側は必ずセッションの compId を渡すこと
 * (クライアント入力を信用しない)。
 */
export function buildWorkScheduleWriteStatements(
  body: WorkSchedulePutBody,
  nowIso: string,
  compId: string,
): D1Statement[] {
  const statements: D1Statement[] = [];
  for (const s of body.schedules) {
    statements.push({
      sql: `INSERT INTO work_schedules
              (comp_id, effective_from, branch_code, job_name, daily_work_minutes, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(comp_id, effective_from, branch_code, job_name) DO UPDATE SET
              daily_work_minutes = excluded.daily_work_minutes,
              updated_at = excluded.updated_at`,
      params: [
        compId,
        s.effectiveFrom,
        s.branchCode ?? ALL_BRANCHES,
        s.jobName ?? ALL_JOBS,
        s.dailyWorkMinutes,
        nowIso,
      ],
    });
  }
  for (const k of body.deleteSchedules) {
    statements.push({
      sql: `DELETE FROM work_schedules
            WHERE comp_id = ? AND effective_from = ? AND branch_code = ? AND job_name = ?`,
      params: [compId, k.effectiveFrom, k.branchCode ?? ALL_BRANCHES, k.jobName ?? ALL_JOBS],
    });
  }
  return statements;
}

/** 休日出勤の承認簿の差分 upsert/削除。 */
export function buildHolidayWorkWriteStatements(
  body: HolidayWorkPutBody,
  nowIso: string,
  compId: string,
): D1Statement[] {
  const statements: D1Statement[] = [];
  for (const a of body.approvals) {
    statements.push({
      sql: `INSERT INTO holiday_work_approvals (comp_id, driver_cd, work_date, reason, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(comp_id, driver_cd, work_date) DO UPDATE SET
              reason = excluded.reason`,
      params: [compId, a.driverCd, a.workDate, a.reason, nowIso],
    });
  }
  for (const k of body.deleteApprovals) {
    statements.push({
      sql: `DELETE FROM holiday_work_approvals WHERE comp_id = ? AND driver_cd = ? AND work_date = ?`,
      params: [compId, k.driverCd, k.workDate],
    });
  }
  return statements;
}

/** 夜勤者マスタの差分 upsert/削除。 */
export function buildNightShiftWriteStatements(
  body: NightShiftPutBody,
  nowIso: string,
  compId: string,
): D1Statement[] {
  const statements: D1Statement[] = [];
  for (const w of body.workers) {
    statements.push({
      sql: `INSERT INTO night_shift_workers (comp_id, driver_cd, effective_from, is_night, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(comp_id, driver_cd, effective_from) DO UPDATE SET
              is_night = excluded.is_night,
              updated_at = excluded.updated_at`,
      params: [compId, w.driverCd, w.effectiveFrom, w.isNight ? 1 : 0, nowIso],
    });
  }
  for (const k of body.deleteWorkers) {
    statements.push({
      sql: `DELETE FROM night_shift_workers WHERE comp_id = ? AND driver_cd = ? AND effective_from = ?`,
      params: [compId, k.driverCd, k.effectiveFrom],
    });
  }
  return statements;
}

// ---------------------------------------------------------------------------
// GET 応答の組み立て (pure)
// ---------------------------------------------------------------------------

/** D1 の番兵値 (-1 / '') を null へ戻して、適用開始日の降順に並べる。 */
export function buildWorkScheduleResponse(rows: WorkScheduleD1Row[]): WorkScheduleRow[] {
  return rows
    .map((r) => ({
      effectiveFrom: r.effective_from,
      branchCode: r.branch_code === ALL_BRANCHES ? null : r.branch_code,
      jobName: r.job_name === ALL_JOBS ? null : r.job_name,
      dailyWorkMinutes: r.daily_work_minutes,
    }))
    .sort(compareScheduleRows);
}

/** 表示順: 適用開始日の降順 → スコープの具体的な順 (拠点・職種つきが先)。 */
function compareScheduleRows(a: WorkScheduleRow, b: WorkScheduleRow): number {
  if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
  const d = scopeSpecificity(b) - scopeSpecificity(a);
  if (d !== 0) return d;
  return (a.branchCode ?? 0) - (b.branchCode ?? 0);
}

/**
 * スコープの具体度。**拠点のほうが職種より優先**する (拠点=2, 職種=1)。
 * 拠点は所在地に紐づく実体で、職種は拠点をまたいで同名が現れるため。
 */
function scopeSpecificity(row: { branchCode: number | null; jobName: string | null }): number {
  return (row.branchCode === null ? 0 : 2) + (row.jobName === null ? 0 : 1);
}

export interface HolidayWorkEntry {
  driverCd: string;
  workDate: string;
  reason: string | null;
}

/** 承認簿を 乗務員CD → 日付 の昇順で返す。 */
export function buildHolidayWorkResponse(rows: HolidayWorkD1Row[]): HolidayWorkEntry[] {
  return rows
    .map((r) => ({ driverCd: r.driver_cd, workDate: r.work_date, reason: r.reason }))
    .sort((a, b) => {
      // 乗務員CD は数値として比べる — localeCompare は ICU の照合順が Windows と
      // Linux(CI) で食い違うことがあり、決定的な順序という目的自体が壊れる
      // (会社ラベルの並べ替えで実際に踏んだ、Refs #403)
      const d = Number(a.driverCd) - Number(b.driverCd);
      if (d !== 0) return d;
      return a.workDate < b.workDate ? -1 : a.workDate > b.workDate ? 1 : 0;
    });
}

/** 夜勤者マスタを 乗務員CD → 適用開始日 の昇順で返す (履歴なので古い順に読ませる)。 */
export function buildNightShiftResponse(rows: NightShiftD1Row[]): NightShiftEntry[] {
  return rows
    .map((r) => ({
      driverCd: r.driver_cd,
      effectiveFrom: r.effective_from,
      // D1 は 0/1 の INTEGER。真偽の判定を呼び出し側に散らさず、ここで boolean に畳む
      isNight: r.is_night !== 0,
    }))
    .sort((a, b) => {
      const d = Number(a.driverCd) - Number(b.driverCd);
      if (d !== 0) return d;
      return a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0;
    });
}

// ---------------------------------------------------------------------------
// 解決規則
// ---------------------------------------------------------------------------

/**
 * 対象月 (`yearMonth`, "YYYY-MM") の末日時点で、その社員 (所属×職種) に効いている
 * 所定労働時間を解決する。employee_attrs の `resolveAttrsAt` と同じ「月末時点」規則
 * に、スコープの具体度を重ねたもの。
 *
 * 選び方:
 * 1. `effectiveFrom` が月末より後の行は捨てる
 * 2. スコープが噛み合わない行 (拠点/職種が指定されていて対象と違う) は捨てる
 * 3. 残りのうち**具体度が最も高い**行を採る (拠点+職種 > 拠点 > 職種 > 全社既定)
 * 4. 具体度が同じなら `effectiveFrom` が最新のものを採る
 *
 * 具体度を先に見るのは、「全社既定を後から更新したら拠点別の設定が消える」事故を
 * 防ぐため — 拠点別に明示した設定は、より新しい全社既定より優先されるべき。
 *
 * 該当が無ければ null (呼び出し側で「所定未設定」として扱う)。`yearMonth` が
 * 不正な形式の場合も null (fail-soft)。
 */
export function resolveWorkScheduleAt(
  rows: WorkScheduleRow[],
  yearMonth: string,
  branchCode: number | null,
  jobName: string | null,
): WorkScheduleRow | null {
  const monthEnd = lastDayOfMonth(yearMonth);
  if (!monthEnd) return null;
  let best: WorkScheduleRow | null = null;
  let bestScore = -1;
  // 「勝っている方」を score と effectiveFrom の 2 変数で持つ (best の null 判定に
  // 頼らない — bestScore が -1 の間は必ず best も null なので、複合条件に
  // best !== null を混ぜると到達不能な分岐になり branch 100% が達成できない)
  let bestFrom = "";
  for (const row of rows) {
    if (row.effectiveFrom > monthEnd) continue;
    if (row.branchCode !== null && row.branchCode !== branchCode) continue;
    if (row.jobName !== null && row.jobName !== jobName) continue;
    const score = scopeSpecificity(row);
    if (score < bestScore) continue;
    if (score === bestScore && row.effectiveFrom <= bestFrom) continue;
    best = row;
    bestScore = score;
    bestFrom = row.effectiveFrom;
  }
  return best;
}

/** 乗務員CD → 所定マスタのスコープ (対象月末時点の所属コード・職種名)。 */
export interface WorkScheduleScope {
  branchCode: number | null;
  jobName: string | null;
}

/**
 * 社員マスタから「乗務員CD → 対象月末時点のスコープ」を引ける Map を作る
 * (`branchByDriverCdAt` と同型。所定マスタの解決に食わせる)。
 *
 * 属性履歴の解決は呼び出し側の `resolveAttrsAt` を注入する — このモジュールを
 * employee-master へ依存させないため (テストも注入で完結する)。
 */
export function scopeByDriverCdAt<A extends { effectiveFrom: string }>(
  employees: readonly { driverCd: string | null; attrs: A[] }[],
  yearMonth: string,
  resolveAt: (attrs: A[], ym: string) => { branchCode?: number | null; jobName?: string | null } | null,
): Map<string, WorkScheduleScope> {
  const out = new Map<string, WorkScheduleScope>();
  for (const e of employees) {
    if (!e.driverCd) continue;
    const attr = resolveAt(e.attrs, yearMonth);
    out.set(e.driverCd, {
      branchCode: attr?.branchCode ?? null,
      jobName: attr?.jobName ?? null,
    });
  }
  return out;
}

/** 承認済み休日出勤の判定用インデックス (`{driverCd}|{workDate}` の集合)。 */
export function buildHolidayWorkIndex(entries: HolidayWorkEntry[]): Set<string> {
  return new Set(entries.map((e) => `${e.driverCd}|${e.workDate}`));
}

/** その社員のその日が「承認済み休日出勤」か。 */
export function isHolidayWorkApproved(index: Set<string>, driverCd: string, workDate: string): boolean {
  return index.has(`${driverCd}|${workDate}`);
}

/**
 * 対象月 (`yearMonth`, "YYYY-MM") の末日時点で夜勤者である乗務員CD の集合を作る
 * (Refs #433 PR-A)。
 *
 * 乗務員CD ごとに「適用開始日が月末以前の行のうち最も新しいもの」を採り、その
 * `isNight` が true の人だけを入れる。**履歴を辿るのは過去月の再取り込みのため** —
 * 夜勤担当が替わった時に行を消してしまうと、当時は正常だった日跨ぎ打刻が一斉に
 * 打刻エラーになる。解除は `isNight: false` の行を後ろに足して表現する。
 *
 * `yearMonth` が不正な形式なら空集合 (fail-soft = 誰も夜勤者でない = 日跨ぎが
 * すべてエラー候補になる)。呼び出し側は必ず月を検証してから渡すこと。
 */
export function buildNightShiftIndex(
  entries: readonly NightShiftEntry[],
  yearMonth: string,
): Set<string> {
  const out = new Set<string>();
  const monthEnd = lastDayOfMonth(yearMonth);
  if (!monthEnd) return out;
  const latest = new Map<string, NightShiftEntry>();
  for (const e of entries) {
    if (e.effectiveFrom > monthEnd) continue;
    const cur = latest.get(e.driverCd);
    if (cur && cur.effectiveFrom >= e.effectiveFrom) continue;
    latest.set(e.driverCd, e);
  }
  for (const [driverCd, e] of latest) {
    if (e.isNight) out.add(driverCd);
  }
  return out;
}
