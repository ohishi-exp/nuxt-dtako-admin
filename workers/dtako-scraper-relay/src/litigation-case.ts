/**
 * 訴訟用の準備ページ (Refs #1133) — 案件 (期間 × 乗務員の組) の保存の pure ロジック
 * (migration 0017 `litigation_cases`)。
 *
 * 「何月から何月まで・どの乗務員の勤務を記録するか」を画面で選び、案件として
 * 保存して開き直せるようにする土台の PR (#c1133-1)。Y時間 Excel 出力・エラー
 * 検知・変更記録のタブは後続 PR が別に足す — ここは保存/一覧/削除だけを持つ。
 *
 * D1Database への実際の読み書きは DO 側 (dtako-scraper-relay-do.ts) が行う —
 * このファイルは「入力検証・SQL 文組み立て・応答整形」の pure な部分だけを持ち、
 * cloudflare:workers 依存が無いため素の vitest (node 環境) で 100% カバレッジ
 * 計測できる (work-schedule.ts / employee-master.ts と同型)。
 */

import { TheearthClientError } from "./theearth-client";

/** 入力の構造不正 (呼び出し側で 400 にマップする)。 */
export class LitigationCaseError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "LitigationCaseError";
  }
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DRIVER_CD_RE = /^\d{1,8}$/;

/** 案件名の上限文字数。 */
export const LITIGATION_CASE_NAME_MAX_LENGTH = 100;
/** 期間の上限 (月数、両端含む)。 */
export const LITIGATION_CASE_MAX_MONTHS = 60;
/** 乗務員の上限件数。 */
export const LITIGATION_CASE_MAX_DRIVERS = 50;

export interface LitigationCaseInput {
  name: string;
  /** YYYY-MM (fromMonth <= toMonth に正規化済み)。 */
  fromMonth: string;
  /** YYYY-MM */
  toMonth: string;
  /** 乗務員CD (前ゼロ除去済み・重複除去済み・入力順を保つ)。 */
  driverCds: string[];
  memo: string;
}

export interface LitigationCaseRecord extends LitigationCaseInput {
  caseId: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** D1 の生の行。 */
export interface LitigationCaseD1Row {
  case_id: string;
  name: string;
  from_month: string;
  to_month: string;
  driver_cds: string; // JSON 配列の文字列
  memo: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface D1Statement {
  sql: string;
  params: unknown[];
}

// ---------------------------------------------------------------------------
// 入力の検証・正規化
// ---------------------------------------------------------------------------

function asObject(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LitigationCaseError(`${field} がオブジェクトではありません`);
  }
  return raw as Record<string, unknown>;
}

function normalizeName(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new LitigationCaseError("name は文字列が必要です");
  }
  const trimmed = raw.normalize("NFKC").trim();
  if (trimmed.length < 1 || trimmed.length > LITIGATION_CASE_NAME_MAX_LENGTH) {
    throw new LitigationCaseError(`name は1〜${LITIGATION_CASE_NAME_MAX_LENGTH}文字が必要です`);
  }
  return trimmed;
}

function normalizeMonth(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !MONTH_RE.test(raw)) {
    throw new LitigationCaseError(`${field} は YYYY-MM が必要です (${JSON.stringify(raw)})`);
  }
  return raw;
}

/** "YYYY-MM" を通し月数へ変換する (順序比較・月数計算のため)。 */
function monthIndex(ym: string): number {
  const [y, m] = ym.split("-").map(Number);
  return y! * 12 + (m! - 1);
}

/** 乗務員CD (前ゼロ除去)。work-schedule.ts の normalizeDriverCd と同一規則。 */
function normalizeDriverCd(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !DRIVER_CD_RE.test(raw.trim())) {
    throw new LitigationCaseError(`${field} は数字 (最大8桁) が必要です (${JSON.stringify(raw)})`);
  }
  return String(Number(raw.trim()));
}

function normalizeDriverCds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new LitigationCaseError("driverCds は配列が必要です");
  }
  const out: string[] = [];
  const seen = new Set<string>();
  raw.forEach((v, i) => {
    const cd = normalizeDriverCd(v, `driverCds[${i}]`);
    if (seen.has(cd)) return; // 重複除去 (入力順は保つ)
    seen.add(cd);
    out.push(cd);
  });
  if (out.length < 1 || out.length > LITIGATION_CASE_MAX_DRIVERS) {
    throw new LitigationCaseError(`driverCds は1〜${LITIGATION_CASE_MAX_DRIVERS}件が必要です (実際: ${out.length}件)`);
  }
  return out;
}

function normalizeMemo(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.normalize("NFKC").trim();
}

/**
 * 案件の入力を検証・正規化する。`fromMonth`/`toMonth` が逆順で来ても
 * 昇順へ入れ替える (画面は入れ替え済みで送るが、防御的に relay 側でも保証する)。
 * 期間は両端含めて `LITIGATION_CASE_MAX_MONTHS` か月まで。
 */
export function normalizeLitigationCaseInput(raw: unknown): LitigationCaseInput {
  const obj = asObject(raw, "案件の入力");
  const name = normalizeName(obj.name);
  const monthA = normalizeMonth(obj.fromMonth, "fromMonth");
  const monthB = normalizeMonth(obj.toMonth, "toMonth");
  const [fromMonth, toMonth] = monthA <= monthB ? [monthA, monthB] : [monthB, monthA];
  const span = monthIndex(toMonth) - monthIndex(fromMonth) + 1;
  if (span > LITIGATION_CASE_MAX_MONTHS) {
    throw new LitigationCaseError(`期間は${LITIGATION_CASE_MAX_MONTHS}か月以内にしてください (指定: ${span}か月)`);
  }
  const driverCds = normalizeDriverCds(obj.driverCds);
  const memo = normalizeMemo(obj.memo);
  return { name, fromMonth, toMonth, driverCds, memo };
}

/** PUT body の任意 `caseId` (指定時は既存案件の更新)。文字列でなければ無視 (=新規)。 */
export function extractCaseId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const v = (raw as Record<string, unknown>).caseId;
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

// ---------------------------------------------------------------------------
// D1 文の組み立て (pure — 実行は DO 側で db.prepare(sql).bind(...params))
// ---------------------------------------------------------------------------

/**
 * 案件 1 件の upsert 文。`caseId` が既存なら内容を更新 (`created_by`/`created_at` は
 * 上書きしない — ON CONFLICT の SET に含めていないため元の値が残る)、
 * 無ければ新規作成する。comp_id は呼び出し側が必ずセッションの compId を渡すこと
 * (body の値を信用しない)。
 */
export function buildLitigationCaseUpsertStatement(
  input: LitigationCaseInput,
  caseId: string,
  compId: string,
  createdBy: string | null,
  nowIso: string,
): D1Statement {
  return {
    sql: `INSERT INTO litigation_cases
            (comp_id, case_id, name, from_month, to_month, driver_cds, memo, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(comp_id, case_id) DO UPDATE SET
            name = excluded.name,
            from_month = excluded.from_month,
            to_month = excluded.to_month,
            driver_cds = excluded.driver_cds,
            memo = excluded.memo,
            updated_at = excluded.updated_at`,
    params: [
      compId,
      caseId,
      input.name,
      input.fromMonth,
      input.toMonth,
      JSON.stringify(input.driverCds),
      input.memo,
      createdBy,
      nowIso,
      nowIso,
    ],
  };
}

/** 案件一覧 (更新日時の新しい順)。 */
export function buildLitigationCaseListStatement(compId: string): D1Statement {
  return {
    sql: `SELECT case_id, name, from_month, to_month, driver_cds, memo, created_by, created_at, updated_at
          FROM litigation_cases WHERE comp_id = ? ORDER BY updated_at DESC`,
    params: [compId],
  };
}

/** 案件 1 件の取得 (存在確認・詳細表示用)。 */
export function buildLitigationCaseGetStatement(compId: string, caseId: string): D1Statement {
  return {
    sql: `SELECT case_id, name, from_month, to_month, driver_cds, memo, created_by, created_at, updated_at
          FROM litigation_cases WHERE comp_id = ? AND case_id = ?`,
    params: [compId, caseId],
  };
}

/** 案件 1 件の削除。 */
export function buildLitigationCaseDeleteStatement(compId: string, caseId: string): D1Statement {
  return {
    sql: `DELETE FROM litigation_cases WHERE comp_id = ? AND case_id = ?`,
    params: [compId, caseId],
  };
}

// ---------------------------------------------------------------------------
// GET 応答の組み立て (pure)
// ---------------------------------------------------------------------------

/**
 * D1 の生の行をアプリ用の形へ変換する。`driver_cds` の JSON parse に失敗した行は
 * 空配列に倒す (fail-soft — 手で D1 を触った等の想定外入力で一覧全体を壊さない)。
 */
export function parseLitigationCaseRow(row: LitigationCaseD1Row): LitigationCaseRecord {
  let driverCds: string[];
  try {
    const parsed = JSON.parse(row.driver_cds);
    driverCds = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    driverCds = [];
  }
  return {
    caseId: row.case_id,
    name: row.name,
    fromMonth: row.from_month,
    toMonth: row.to_month,
    driverCds,
    memo: row.memo,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 案件一覧の応答 (更新日時の新しい順。SQL の ORDER BY 済みだが並びを固定する)。 */
export function buildLitigationCaseListResponse(rows: LitigationCaseD1Row[]): LitigationCaseRecord[] {
  return rows.map(parseLitigationCaseRow).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}
