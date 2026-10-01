/**
 * 訴訟用の準備ページ (Refs #1133) — 削除した案件の 30 日保管 と 出力の版の保存の
 * pure ロジック (migration 0019)。
 *
 * - **案件の削除は「削除した案件」の表 (`litigation_deleted_cases`) への移動**。
 *   検知結果 (0018) と出力の版は消さずに残すので、30 日のあいだは復活するとそのまま戻る。
 *   30 日を過ぎたものは、案件の一覧を読んだときの掃除が消す。
 * - `litigation_cases` の表と、その SQL の組み立て (litigation-case.ts) は変えない。
 *
 * litigation-case.ts / litigation-check.ts と同じく、D1 / R2 への実際の読み書きは DO 側
 * (dtako-scraper-relay-do.ts)。ここは入力の検証・SQL 文の組み立て・応答の整形だけを持つ。
 *
 * ★ D1 は 本番 / staging / preview で共用。案件 (cases / deleted) は元から env 共用なので、
 * 削除・復活は全 env に効く。
 */

import type { D1Statement, LitigationCaseD1Row, LitigationCaseRecord } from "./litigation-case";
import { buildLitigationCaseDeleteStatement, parseLitigationCaseRow } from "./litigation-case";
import { buildLitigationCheckDeleteStatement } from "./litigation-check";

// ---------------------------------------------------------------------------
// 役割 (admin / payroll) を見る口
// ---------------------------------------------------------------------------

/** 役割が無いときの 403 の文言。口の用途に依らない文にする (8 口で共用)。 */
export const LITIGATION_ADMIN_FORBIDDEN = "この操作は admin / payroll のみ実行できます";

/** 役割を見る口 (method, pathname)。DO はこれに当たる request を、保存済み theearth
 * セッションの読み出しより前で分ける (保存済みセッション由来の record は role を持たない)。 */
const LITIGATION_ADMIN_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ["DELETE", "/restraint-api/litigation-cases"],
  ["GET", "/restraint-api/litigation-cases/deleted"],
  ["POST", "/restraint-api/litigation-cases/restore"],
];

export function isLitigationAdminRoute(method: string, pathname: string): boolean {
  return LITIGATION_ADMIN_ROUTES.some(([m, p]) => m === method && p === pathname);
}

// ---------------------------------------------------------------------------
// 30 日の期限
// ---------------------------------------------------------------------------

/** 削除した案件を残す日数。 */
export const LITIGATION_DELETED_RETENTION_DAYS = 30;
/** 1 回の掃除で消す案件の上限 (案件の一覧の応答の裏で走るので小さく切る)。 */
export const LITIGATION_SWEEP_MAX_CASES = 20;

/**
 * 期限の境目 (現在時刻の 30 日前) の ISO 8601。`deleted_at` がこれ**より前**なら期限切れ、
 * **これ以降** (ちょうど 30 日を含む) は残す。`deleted_at` も `toISOString()` の形なので
 * 文字列の大小がそのまま時刻の前後になる。
 */
export function litigationDeletedCutoffIso(nowMs: number): string {
  return new Date(nowMs - LITIGATION_DELETED_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// 案件の削除・復活 (D1 文の組み立て。実行は DO 側で db.batch)
// ---------------------------------------------------------------------------

const CASE_COLUMNS = "case_id, name, from_month, to_month, driver_cds, memo, created_by, created_at, updated_at";

/** 削除した案件の D1 の生の行。 */
export interface LitigationDeletedCaseD1Row extends LitigationCaseD1Row {
  deleted_at: string;
  deleted_by: string | null;
}

/** 削除した案件の一覧の 1 件。 */
export interface LitigationDeletedCaseRecord {
  case: LitigationCaseRecord;
  deletedAt: string;
  deletedBy: string | null;
}

/**
 * 案件の削除 = 「削除した案件」の表へ写してから cases の行を消す (2 文を 1 batch で)。
 * `INSERT OR REPLACE` なので、同じ case_id の古い deleted の行が残っていても落ちない。
 * cases に無い case_id は 0 行の移動 (冪等)。検知結果と出力の版には触らない。
 */
export function buildLitigationCaseMoveToDeletedStatements(
  compId: string,
  caseId: string,
  deletedAtIso: string,
  deletedBy: string | null,
): D1Statement[] {
  return [
    {
      sql: `INSERT OR REPLACE INTO litigation_deleted_cases
              (comp_id, ${CASE_COLUMNS}, deleted_at, deleted_by)
            SELECT comp_id, ${CASE_COLUMNS}, ?, ?
            FROM litigation_cases WHERE comp_id = ? AND case_id = ?`,
      params: [deletedAtIso, deletedBy, compId, caseId],
    },
    buildLitigationCaseDeleteStatement(compId, caseId),
  ];
}

/** 削除した案件の一覧 (削除の新しい順)。期限切れは出さない。 */
export function buildLitigationDeletedCaseListStatement(compId: string, cutoffIso: string): D1Statement {
  return {
    sql: `SELECT ${CASE_COLUMNS}, deleted_at, deleted_by
          FROM litigation_deleted_cases
          WHERE comp_id = ? AND deleted_at >= ? ORDER BY deleted_at DESC`,
    params: [compId, cutoffIso],
  };
}

/** 削除した案件 1 件 (復活の前の存在確認)。期限切れは引かない。 */
export function buildLitigationDeletedCaseGetStatement(compId: string, caseId: string, cutoffIso: string): D1Statement {
  return {
    sql: `SELECT ${CASE_COLUMNS}, deleted_at, deleted_by
          FROM litigation_deleted_cases
          WHERE comp_id = ? AND case_id = ? AND deleted_at >= ?`,
    params: [compId, caseId, cutoffIso],
  };
}

/**
 * 復活 = cases へ戻してから deleted の行を消す (2 文を 1 batch で)。列はそのまま戻す
 * (`updated_at` も削除前の値)。cases に同じ case_id が在ると 1 文目が PK で落ちて
 * batch ごと巻き戻る — 呼び出し側は先に存在を見て 409 にする (上書きしない)。
 */
export function buildLitigationCaseRestoreStatements(compId: string, caseId: string, cutoffIso: string): D1Statement[] {
  return [
    {
      sql: `INSERT INTO litigation_cases (comp_id, ${CASE_COLUMNS})
            SELECT comp_id, ${CASE_COLUMNS}
            FROM litigation_deleted_cases
            WHERE comp_id = ? AND case_id = ? AND deleted_at >= ?`,
      params: [compId, caseId, cutoffIso],
    },
    {
      sql: `DELETE FROM litigation_deleted_cases WHERE comp_id = ? AND case_id = ? AND deleted_at >= ?`,
      params: [compId, caseId, cutoffIso],
    },
  ];
}

/** 掃除の対象 = 期限を過ぎた、削除した案件 (古い順に {@link LITIGATION_SWEEP_MAX_CASES} 件まで)。
 * 同じ case_id が cases に在るものは外す — 案件の PUT が 404 を返す前のコードが動く env
 * (D1 は env 共用) で作り直された案件の検知結果を、古い deleted の行を理由に消さないため。 */
export function buildLitigationExpiredCaseListStatement(compId: string, cutoffIso: string): D1Statement {
  return {
    sql: `SELECT d.case_id FROM litigation_deleted_cases d
          WHERE d.comp_id = ? AND d.deleted_at < ?
            AND NOT EXISTS (SELECT 1 FROM litigation_cases c
                            WHERE c.comp_id = d.comp_id AND c.case_id = d.case_id)
          ORDER BY d.deleted_at LIMIT ${LITIGATION_SWEEP_MAX_CASES}`,
    params: [compId, cutoffIso],
  };
}

/** 期限を過ぎた案件 1 件の掃除 = 検知結果と deleted の行を消す (2 文を 1 batch で)。
 * deleted の側にも期限の条件を付ける (列挙の後に別の削除で入れ替わった行を消さない)。 */
export function buildLitigationExpiredCasePurgeStatements(compId: string, caseId: string, cutoffIso: string): D1Statement[] {
  return [
    buildLitigationCheckDeleteStatement(compId, caseId),
    {
      sql: `DELETE FROM litigation_deleted_cases WHERE comp_id = ? AND case_id = ? AND deleted_at < ?`,
      params: [compId, caseId, cutoffIso],
    },
  ];
}

/** 削除した案件の一覧の応答 (SQL の ORDER BY 済みの並びのまま)。 */
export function buildLitigationDeletedCaseListResponse(rows: LitigationDeletedCaseD1Row[]): LitigationDeletedCaseRecord[] {
  return rows.map((row) => ({
    case: parseLitigationCaseRow(row),
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  }));
}
