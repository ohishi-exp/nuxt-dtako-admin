/**
 * 訴訟用の準備ページ (Refs #1133) — 削除した案件の 30 日保管 と 出力の版の保存の
 * pure ロジック (migration 0019)。
 *
 * - **案件の削除は「削除した案件」の表 (`litigation_deleted_cases`) への移動**。
 *   検知結果 (0018) と出力の版は消さずに残すので、30 日のあいだは復活するとそのまま戻る。
 *   30 日を過ぎたものは、案件の一覧を読んだときの掃除が消す。
 * - `litigation_cases` の表と、その SQL の組み立て (litigation-case.ts) は変えない。
 * - **出力の版**: 出力タブで作った Excel そのものを、案件ごと・出力するたびに残す
 *   (元データは取り込み直しで後から変わるため)。1 回の出力 = 1 版で上書きしない。
 *   ファイルの実体は R2、索引が D1。案件を削除しないかぎり版に期限は無い。
 *   既存の版つき保存 (`putVersionedR2`) は使わない — あちらは「内容が同じなら版を増やさない・
 *   版キーが `v-`・7 日で消える」で、要件が逆。
 *
 * litigation-case.ts / litigation-check.ts と同じく、D1 / R2 への実際の読み書きは DO 側
 * (dtako-scraper-relay-do.ts)。ここは入力の検証・SQL 文の組み立て・応答の整形だけを持つ。
 *
 * ★ D1 と R2 の bucket は 本番 / staging / preview で共用。案件 (cases / deleted) は元から
 * env 共用なので、削除・復活は全 env に効く。**版とファイルの口は、版の行の `r2_prefix`
 * (作った env の `RESTRAINT_R2_PREFIX`) が自 env のものだけを読む・書く** — 他 env の版は
 * 一覧に出ず、ファイルも取れない。掃除だけは全 prefix の版を対象にする (案件が env 共用で、
 * 保存してあるキーで消すので孤児を作らない)。
 */

import type { D1Statement, LitigationCaseD1Row, LitigationCaseRecord } from "./litigation-case";
import { buildLitigationCaseDeleteStatement, LitigationCaseError, parseLitigationCaseRow } from "./litigation-case";
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
  ["POST", "/restraint-api/litigation-outputs"],
  ["GET", "/restraint-api/litigation-outputs"],
  ["PUT", "/restraint-api/litigation-outputs/file"],
  ["GET", "/restraint-api/litigation-outputs/file"],
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
/** 1 回の掃除で消す版の上限 (1 版 = R2 の delete 1 回 + D1 の batch 1 回)。 */
export const LITIGATION_SWEEP_MAX_VERSIONS = 3;

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

/** 掃除の対象 = 期限を過ぎた、削除した案件のうち**版が 1 つも残っていないもの**
 * (古い順に {@link LITIGATION_SWEEP_MAX_CASES} 件まで)。版が残る案件は、版の掃除
 * ({@link buildLitigationExpiredVersionListStatement}) が済むまで deleted の行を残す
 * — 行を先に消すと、残った版が掃除の対象から外れて R2 に孤児が残る。
 * 同じ case_id が cases に在るものは外す — 案件の PUT が 404 を返す前のコードが動く env
 * (D1 は env 共用) で作り直された案件の検知結果を、古い deleted の行を理由に消さないため。 */
export function buildLitigationExpiredCaseListStatement(compId: string, cutoffIso: string): D1Statement {
  return {
    sql: `SELECT d.case_id FROM litigation_deleted_cases d
          WHERE d.comp_id = ? AND d.deleted_at < ?
            AND NOT EXISTS (SELECT 1 FROM litigation_cases c
                            WHERE c.comp_id = d.comp_id AND c.case_id = d.case_id)
            AND NOT EXISTS (SELECT 1 FROM litigation_output_versions v
                            WHERE v.comp_id = d.comp_id AND v.case_id = d.case_id)
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

// ---------------------------------------------------------------------------
// 出力の版 — 入力の検証
// ---------------------------------------------------------------------------

/** 1 版のファイル数の上限 (案件の上限 = 乗務員 50 名 × 60 か月 の区切りに、変更記録の CSV を足しても収まる)。 */
export const LITIGATION_OUTPUT_MAX_FILES = 300;
/** 1 ファイルの上限 (bytes)。Y時間 の Excel は 1 冊 約 4MB。 */
export const LITIGATION_OUTPUT_MAX_FILE_BYTES = 20 * 1024 * 1024;
/** 版の `results` (JSON 文字列) の上限。 */
export const LITIGATION_OUTPUT_MAX_RESULTS_CHARS = 500_000;
/** 版の一覧で返す件数 (新しい順)。 */
export const LITIGATION_OUTPUT_LIST_LIMIT = 50;
/** 表示名の上限文字数。 */
export const LITIGATION_OUTPUT_LABEL_MAX_LENGTH = 200;

const OUTPUT_CASE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const OUTPUT_VERSION_ID_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9a-z]{6}$/;
const OUTPUT_FILE_NAME_RE = /^[A-Za-z0-9._-]{1,120}$/;
const OUTPUT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
};
const VERSION_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

/**
 * 出力の口が受ける case_id。**R2 のキーの要素に使う**ので形を見る (既存の案件は
 * `crypto.randomUUID()` なので通る)。形に合わない case_id の案件は、出力を保存できないだけ。
 * 案件の PUT / DELETE / 復活には掛けない (あちらは bind の引数にしか使わない)。
 */
export function normalizeLitigationOutputCaseId(raw: unknown): string {
  if (typeof raw !== "string" || !OUTPUT_CASE_ID_RE.test(raw)) {
    throw new LitigationCaseError("case_id は英数字・_・- の 1〜64 文字が必要です");
  }
  return raw;
}

/** 版の ID を採番する: 時刻 (UTC、秒まで) + 乱数 6 文字。`random` は 6 bytes 以上を渡すこと。 */
export function buildLitigationOutputVersionId(now: Date, random: Uint8Array): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = Array.from(random.subarray(0, 6), (b) => VERSION_ID_ALPHABET[b % VERSION_ID_ALPHABET.length]).join("");
  return `${stamp}-${suffix}`;
}

export function normalizeLitigationOutputVersionId(raw: unknown): string {
  if (typeof raw !== "string" || !OUTPUT_VERSION_ID_RE.test(raw)) {
    throw new LitigationCaseError("version_id が不正です");
  }
  return raw;
}

function outputFileExtension(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1).toLowerCase();
}

/** 保存用のファイル名 (R2 のキーの末尾・ダウンロード時の名前)。ASCII のみ、拡張子は xlsx / csv。 */
export function normalizeLitigationOutputFileName(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !OUTPUT_FILE_NAME_RE.test(raw) ||
    raw.includes("..") ||
    !raw.includes(".") ||
    !(outputFileExtension(raw) in OUTPUT_CONTENT_TYPES)
  ) {
    throw new LitigationCaseError("name は英数字・.・_・- の 1〜120 文字で、拡張子は .xlsx / .csv が必要です");
  }
  return raw;
}

/** 表示名 (日本語可)。省略・空は保存用の名前を使う。 */
export function normalizeLitigationOutputLabel(raw: unknown, fallbackName: string): string {
  if (raw === null || raw === undefined || raw === "") return fallbackName;
  if (typeof raw !== "string" || raw.length > LITIGATION_OUTPUT_LABEL_MAX_LENGTH || CONTROL_CHAR_RE.test(raw)) {
    throw new LitigationCaseError(`label は制御文字なしの ${LITIGATION_OUTPUT_LABEL_MAX_LENGTH} 文字までが必要です`);
  }
  return raw;
}

/** 検証済みの保存用の名前の content-type (拡張子で 2 種)。 */
export function litigationOutputContentType(name: string): string {
  return OUTPUT_CONTENT_TYPES[outputFileExtension(name)]!;
}

/**
 * R2 のキー: `{prefix}/{comp}/litigation/{case_id}/{version_id}/{保存用の名前}`。
 *
 * **組んだキーが `/csv/` を含まず、`v-` で始まる要素を持たないことをここで確かめる** —
 * 同じ bucket・同じ prefix の下に、役割の制限が無い CSV ダウンロードの口
 * (`/restraint-api/archive/csv`: `/csv/` を含み `.csv` で終わるキーを素通しする) と、
 * 7 日 prune (`{dir}/v-*` を消す) が居る。どちらにも当たらないことを、case_id が
 * `csv` や `v-…` の案件も含めて構造で担保する (当たるキーは組まずに 400)。
 */
export function buildLitigationOutputR2Key(
  prefix: string,
  compId: string,
  caseId: string,
  versionId: string,
  name: string,
): string {
  const key = `${prefix}/${compId}/litigation/${caseId}/${versionId}/${name}`;
  if (key.includes("/csv/") || key.includes("..") || key.split("/").some((part) => part.startsWith("v-"))) {
    throw new LitigationCaseError("この case_id / name では出力を保存できません");
  }
  return key;
}

/** `POST /restraint-api/litigation-outputs` の body。`results` は中身を解釈せず JSON 文字列で持つ。 */
export function normalizeLitigationOutputCreate(raw: unknown): { caseId: string; results: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LitigationCaseError("body はオブジェクトで指定してください");
  }
  const r = raw as Record<string, unknown>;
  const caseId = normalizeLitigationOutputCaseId(r.caseId);
  if (r.results === undefined) throw new LitigationCaseError("results が必要です");
  const results = JSON.stringify(r.results);
  if (results.length > LITIGATION_OUTPUT_MAX_RESULTS_CHARS) {
    throw new LitigationCaseError("results が大きすぎます");
  }
  return { caseId, results };
}

/**
 * `content-length` が 1 ファイルの上限を超えているか (body を読む前の 413 用)。
 * ヘッダが無い・数字でないときは false — 実際に読んだ長さでもう一度見る
 * ({@link isLitigationOutputTooLarge})。
 */
export function litigationOutputDeclaredTooLarge(contentLength: string | null): boolean {
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return false;
  return isLitigationOutputTooLarge(Number(contentLength.trim()));
}

export function isLitigationOutputTooLarge(bytes: number): boolean {
  return bytes > LITIGATION_OUTPUT_MAX_FILE_BYTES;
}

// ---------------------------------------------------------------------------
// 出力の版 — D1 文の組み立て
// ---------------------------------------------------------------------------

export interface LitigationOutputVersionD1Row {
  version_id: string;
  created_at: string;
  created_by: string | null;
  /** 1 件の取得のときだけ引く (一覧は引かない) */
  results?: string;
}

export interface LitigationOutputFileD1Row {
  version_id: string;
  storage_name: string;
  label: string;
  size: number;
  sha256: string;
  r2_key: string;
  uploaded_at: string;
}

const FILE_COLUMNS = "version_id, storage_name, label, size, sha256, r2_key, uploaded_at";

/** 版の行を作る。comp・r2_prefix・created_by は呼び出し側が record / env から渡す (body の値を信用しない)。 */
export function buildLitigationOutputVersionInsertStatement(v: {
  compId: string;
  caseId: string;
  versionId: string;
  r2Prefix: string;
  createdAt: string;
  createdBy: string | null;
  results: string;
}): D1Statement {
  return {
    sql: `INSERT INTO litigation_output_versions
            (comp_id, case_id, version_id, r2_prefix, created_at, created_by, results)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [v.compId, v.caseId, v.versionId, v.r2Prefix, v.createdAt, v.createdBy, v.results],
  };
}

/** 案件の版の一覧 (自 env の prefix のものだけ、新しい順に {@link LITIGATION_OUTPUT_LIST_LIMIT} 件)。 */
export function buildLitigationOutputVersionListStatement(compId: string, caseId: string, r2Prefix: string): D1Statement {
  return {
    sql: `SELECT version_id, created_at, created_by FROM litigation_output_versions
          WHERE comp_id = ? AND case_id = ? AND r2_prefix = ?
          ORDER BY created_at DESC, version_id DESC LIMIT ${LITIGATION_OUTPUT_LIST_LIMIT}`,
    params: [compId, caseId, r2Prefix],
  };
}

/** 版 1 件 (results つき)。自 env の prefix のものだけ。 */
export function buildLitigationOutputVersionGetStatement(
  compId: string,
  caseId: string,
  versionId: string,
  r2Prefix: string,
): D1Statement {
  return {
    sql: `SELECT version_id, created_at, created_by, results FROM litigation_output_versions
          WHERE comp_id = ? AND case_id = ? AND version_id = ? AND r2_prefix = ?`,
    params: [compId, caseId, versionId, r2Prefix],
  };
}

/** 版の一覧 ({@link buildLitigationOutputVersionListStatement} と同じ集合) に付くファイルの行。 */
export function buildLitigationOutputFileListStatement(compId: string, caseId: string, r2Prefix: string): D1Statement {
  return {
    sql: `SELECT ${FILE_COLUMNS} FROM litigation_output_files
          WHERE comp_id = ? AND case_id = ? AND version_id IN (
            SELECT version_id FROM litigation_output_versions
            WHERE comp_id = ? AND case_id = ? AND r2_prefix = ?
            ORDER BY created_at DESC, version_id DESC LIMIT ${LITIGATION_OUTPUT_LIST_LIMIT})
          ORDER BY version_id, storage_name`,
    params: [compId, caseId, compId, caseId, r2Prefix],
  };
}

/** 版 1 件のファイルの行。**prefix では絞らない** — 呼び出し側が先に版の行 (prefix つき) を
 * 引いてから使うか、掃除 (全 prefix が対象) で使う。 */
export function buildLitigationOutputVersionFileListStatement(compId: string, caseId: string, versionId: string): D1Statement {
  return {
    sql: `SELECT ${FILE_COLUMNS} FROM litigation_output_files
          WHERE comp_id = ? AND case_id = ? AND version_id = ? ORDER BY storage_name`,
    params: [compId, caseId, versionId],
  };
}

/** その版の「この名前以外」のファイル数 (同名の上書きは上限に数えない)。 */
export function buildLitigationOutputFileCountStatement(
  compId: string,
  caseId: string,
  versionId: string,
  exceptName: string,
): D1Statement {
  return {
    sql: `SELECT COUNT(*) AS n FROM litigation_output_files
          WHERE comp_id = ? AND case_id = ? AND version_id = ? AND storage_name <> ?`,
    params: [compId, caseId, versionId, exceptName],
  };
}

/** ファイル 1 行の upsert (同名は上書き)。1 ファイル 1 行なので、並行の上げで互いを消さない。 */
export function buildLitigationOutputFileUpsertStatement(f: {
  compId: string;
  caseId: string;
  versionId: string;
  name: string;
  label: string;
  size: number;
  sha256: string;
  r2Key: string;
  uploadedAt: string;
}): D1Statement {
  return {
    sql: `INSERT INTO litigation_output_files
            (comp_id, case_id, version_id, storage_name, label, size, sha256, r2_key, uploaded_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(comp_id, case_id, version_id, storage_name) DO UPDATE SET
            label = excluded.label,
            size = excluded.size,
            sha256 = excluded.sha256,
            r2_key = excluded.r2_key,
            uploaded_at = excluded.uploaded_at`,
    params: [f.compId, f.caseId, f.versionId, f.name, f.label, f.size, f.sha256, f.r2Key, f.uploadedAt],
  };
}

/** ファイル 1 行。**版が自 env の prefix のときだけ**引ける (他 env の版のファイルは 404 になる)。 */
export function buildLitigationOutputFileGetStatement(
  compId: string,
  caseId: string,
  versionId: string,
  name: string,
  r2Prefix: string,
): D1Statement {
  return {
    sql: `SELECT f.version_id, f.storage_name, f.label, f.size, f.sha256, f.r2_key, f.uploaded_at
          FROM litigation_output_files f
          JOIN litigation_output_versions v
            ON v.comp_id = f.comp_id AND v.case_id = f.case_id AND v.version_id = f.version_id
          WHERE f.comp_id = ? AND f.case_id = ? AND f.version_id = ? AND f.storage_name = ?
            AND v.r2_prefix = ?`,
    params: [compId, caseId, versionId, name, r2Prefix],
  };
}

/**
 * 掃除の対象 = 期限を過ぎた「削除した案件」の版 (古い順に {@link LITIGATION_SWEEP_MAX_VERSIONS} つまで)。
 * **全 prefix が対象** (module docs)。同じ case_id が cases に在る案件の版は外す
 * ({@link buildLitigationExpiredCaseListStatement} と同じ理由)。
 */
export function buildLitigationExpiredVersionListStatement(compId: string, cutoffIso: string): D1Statement {
  return {
    sql: `SELECT v.case_id, v.version_id FROM litigation_output_versions v
          JOIN litigation_deleted_cases d ON d.comp_id = v.comp_id AND d.case_id = v.case_id
          WHERE v.comp_id = ? AND d.deleted_at < ?
            AND NOT EXISTS (SELECT 1 FROM litigation_cases c
                            WHERE c.comp_id = v.comp_id AND c.case_id = v.case_id)
          ORDER BY d.deleted_at, v.case_id, v.version_id LIMIT ${LITIGATION_SWEEP_MAX_VERSIONS}`,
    params: [compId, cutoffIso],
  };
}

/** 版 1 つの掃除 = ファイルの行と版の行を消す (2 文を 1 batch で)。R2 の削除が済んでから呼ぶ。 */
export function buildLitigationOutputVersionPurgeStatements(compId: string, caseId: string, versionId: string): D1Statement[] {
  const where = "WHERE comp_id = ? AND case_id = ? AND version_id = ?";
  return [
    { sql: `DELETE FROM litigation_output_files ${where}`, params: [compId, caseId, versionId] },
    { sql: `DELETE FROM litigation_output_versions ${where}`, params: [compId, caseId, versionId] },
  ];
}

// ---------------------------------------------------------------------------
// 出力の版 — 応答の整形
// ---------------------------------------------------------------------------

export interface LitigationOutputFileRecord {
  name: string;
  label: string;
  size: number;
  sha256: string;
  uploadedAt: string;
}

export interface LitigationOutputVersionRecord {
  versionId: string;
  createdAt: string;
  createdBy: string | null;
  files: LitigationOutputFileRecord[];
}

function toFileRecord(row: LitigationOutputFileD1Row): LitigationOutputFileRecord {
  return { name: row.storage_name, label: row.label, size: row.size, sha256: row.sha256, uploadedAt: row.uploaded_at };
}

function toVersionRecord(
  version: LitigationOutputVersionD1Row,
  files: LitigationOutputFileD1Row[],
): LitigationOutputVersionRecord {
  return {
    versionId: version.version_id,
    createdAt: version.created_at,
    createdBy: version.created_by,
    files: files.filter((f) => f.version_id === version.version_id).map(toFileRecord),
  };
}

/** 版の一覧の応答 (SQL の並びのまま。**results は含めない** — R2 のキーも出さない)。 */
export function buildLitigationOutputVersionListResponse(
  versions: LitigationOutputVersionD1Row[],
  files: LitigationOutputFileD1Row[],
): LitigationOutputVersionRecord[] {
  return versions.map((v) => toVersionRecord(v, files));
}

/** 版 1 件の応答 (results つき)。results が JSON として読めない行は null に倒す (fail-soft)。 */
export function buildLitigationOutputVersionResponse(
  version: LitigationOutputVersionD1Row,
  files: LitigationOutputFileD1Row[],
): LitigationOutputVersionRecord & { results: unknown } {
  let results: unknown = null;
  try {
    results = JSON.parse(version.results ?? "null");
  } catch {
    results = null;
  }
  return { ...toVersionRecord(version, files), results };
}
