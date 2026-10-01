/**
 * 訴訟用の準備ページ「エラー」タブの検知結果の保存 (migration 0018
 * `litigation_check_results`、Refs #1133) の pure ロジック。
 *
 * 検知は 1 案件で 10〜40 分かかるのに結果が画面のメモリにしか無く、開き直すたびに
 * やり直しだった。取れた結果を案件 × 検知の種類 × 乗務員 × 月の 1 行ずつ残す。
 *
 * **payload の中身は検証しない** — 画面が読む形 (`LitigationFetched<…>` 等) そのままで、
 * 画面側が防御的に読む。relay は鍵の形・件数・大きさだけを見る (litigation-case.ts と
 * 同じく、D1 への実際の読み書きは DO 側。ここは入力検証と SQL 文の組み立てだけ)。
 */

import type { D1Statement } from "./litigation-case";
import { LitigationCaseError } from "./litigation-case";

/** 検知の種類 (画面の `errAlcOps` / `errUnkoGaps` / `errWageReports` に対応)。 */
export const LITIGATION_CHECK_KINDS = ["alcOps", "unkoGaps", "wageReport"] as const;
export type LitigationCheckKind = (typeof LITIGATION_CHECK_KINDS)[number];

/** 1 回の PUT で書ける件数 (画面は 1 ステップぶん = 最大で区切り 1 つの月数 × 乗務員数を送る)。 */
export const LITIGATION_CHECK_MAX_ITEMS = 100;
/** payload 1 件の上限 (JSON 文字列の長さ)。勤怠に無い運行の一覧でも数 KB に収まる。 */
export const LITIGATION_CHECK_MAX_PAYLOAD_CHARS = 32_000;

const ITEM_KEY_RE = /^\d{1,8}\|\d{4}-(0[1-9]|1[0-2])$/;

export interface LitigationCheckItem {
  kind: LitigationCheckKind;
  key: string;
  /** JSON 文字列 (保存する形) */
  payload: string;
}

export interface LitigationCheckPutInput {
  caseId: string;
  items: LitigationCheckItem[];
}

/** D1 の生の行。 */
export interface LitigationCheckD1Row {
  kind: string;
  item_key: string;
  payload: string;
  checked_at: string;
}

/** GET の応答 1 件。 */
export interface LitigationCheckRecord {
  kind: LitigationCheckKind;
  key: string;
  payload: unknown;
  checkedAt: string;
}

function isKind(v: unknown): v is LitigationCheckKind {
  return typeof v === "string" && (LITIGATION_CHECK_KINDS as readonly string[]).includes(v);
}

/** PUT body を検証する。構造不正は `LitigationCaseError` (呼び出し側で 400)。 */
export function normalizeLitigationCheckPut(raw: unknown): LitigationCheckPutInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LitigationCaseError("body はオブジェクトで指定してください");
  }
  const r = raw as Record<string, unknown>;
  const caseId = typeof r.caseId === "string" ? r.caseId.trim() : "";
  if (!caseId) throw new LitigationCaseError("caseId が必要です");
  if (!Array.isArray(r.items) || r.items.length === 0) {
    throw new LitigationCaseError("items は 1 件以上の配列で指定してください");
  }
  if (r.items.length > LITIGATION_CHECK_MAX_ITEMS) {
    throw new LitigationCaseError(`items は ${LITIGATION_CHECK_MAX_ITEMS} 件までです`);
  }
  const items = r.items.map((it, i): LitigationCheckItem => {
    const o = (it ?? {}) as Record<string, unknown>;
    if (!isKind(o.kind)) throw new LitigationCaseError(`items[${i}].kind が不正です`);
    if (typeof o.key !== "string" || !ITEM_KEY_RE.test(o.key)) {
      throw new LitigationCaseError(`items[${i}].key は 乗務員CD|YYYY-MM で指定してください`);
    }
    if (o.payload === undefined) throw new LitigationCaseError(`items[${i}].payload が必要です`);
    const payload = JSON.stringify(o.payload);
    if (payload.length > LITIGATION_CHECK_MAX_PAYLOAD_CHARS) {
      throw new LitigationCaseError(`items[${i}].payload が大きすぎます`);
    }
    return { kind: o.kind, key: o.key, payload };
  });
  return { caseId, items };
}

/** 1 件の upsert 文。comp_id は呼び出し側がセッションの compId を渡すこと (body の値を信用しない)。 */
export function buildLitigationCheckUpsertStatement(
  compId: string,
  caseId: string,
  item: LitigationCheckItem,
  nowIso: string,
): D1Statement {
  return {
    sql: `INSERT INTO litigation_check_results (comp_id, case_id, kind, item_key, payload, checked_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(comp_id, case_id, kind, item_key) DO UPDATE SET
            payload = excluded.payload,
            checked_at = excluded.checked_at`,
    params: [compId, caseId, item.kind, item.key, item.payload, nowIso],
  };
}

/** 案件 1 件ぶんの保存済み結果。 */
export function buildLitigationCheckListStatement(compId: string, caseId: string): D1Statement {
  return {
    sql: `SELECT kind, item_key, payload, checked_at FROM litigation_check_results
          WHERE comp_id = ? AND case_id = ?`,
    params: [compId, caseId],
  };
}

/** 案件ぶんを全部消す。案件の削除では消さない (復活で戻すため) — 削除から 30 日を過ぎた
 * 案件の掃除 (litigation-output.ts) だけが使う。 */
export function buildLitigationCheckDeleteStatement(compId: string, caseId: string): D1Statement {
  return {
    sql: `DELETE FROM litigation_check_results WHERE comp_id = ? AND case_id = ?`,
    params: [compId, caseId],
  };
}

/**
 * D1 の行を応答の形にする。種類が不明な行・payload が JSON でない行は落とす
 * (fail-soft — 手で D1 を触った等で一覧全体を壊さない。画面では「未実行」に戻るだけ)。
 */
export function buildLitigationCheckListResponse(rows: LitigationCheckD1Row[]): LitigationCheckRecord[] {
  const out: LitigationCheckRecord[] = [];
  for (const row of rows) {
    if (!isKind(row.kind)) continue;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    out.push({ kind: row.kind, key: row.item_key, payload, checkedAt: row.checked_at });
  }
  return out;
}
