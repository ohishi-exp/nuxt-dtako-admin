/**
 * 社員マスタ (Refs #367): 給与コード×会社 → 乗務員CD・所属/給与体系履歴の pure ロジック。
 *
 * 保存先は D1 (`employees` / `employee_attrs`、migration 0006)。金額・明細は持たない
 * (識別情報+属性のみ、「支給金額はブラウザから出さない」方針は不変)。R2 突合マスタ
 * (`salary-cd-map`、restraint-wage.ts の normalizeSalaryCdMap) はこのテーブルに吸収する
 * (`cdMapEntriesToEmployees` + `buildEmployeeMasterImportStatements`)。
 *
 * D1 行単位 upsert のため、R2 版マスタ (wage-master 等) が持つ楽観排他
 * (baseVersion) / sessionStorage ドラフト退避は不要 (Refs #367 決定事項、廃止)。
 * PUT は last-write-wins。
 *
 * D1Database への実際の読み書きは DO 側 (dtako-scraper-relay-do.ts) が行う —
 * このファイルは「入力検証・SQL 文組み立て・応答整形」の pure な部分だけを持ち、
 * cloudflare:workers 依存が無いため素の vitest (node 環境) で 100% カバレッジ
 * 計測できる (restraint-wage.ts と同型)。
 */

import { TheearthClientError } from "./theearth-client";

/** マスタ入力の構造不正 (呼び出し側で 400 にマップする)。 */
export class EmployeeMasterError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "EmployeeMasterError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 氏名の突合用正規化 (NFKC + 空白全除去)。
 * app/utils/salary-compare.ts の `normalizeNameKey` と同一規則 — worker から app
 * 側を import できない (Nuxt typecheck が worker 全体を厳格検査してしまう罠、
 * Refs #268) ため実装は 2 箇所になるが、ロジックはどちらもこの規則が正。
 * 変更する時は両方に反映すること。
 */
export function normalizeNameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "");
}

// ---------------------------------------------------------------------------
// PUT body の型と検証
// ---------------------------------------------------------------------------

export interface EmployeeInput {
  company: string;
  payrollCd: string;
  name: string;
  driverCd: string | null;
}

export interface EmployeeAttrInput {
  company: string;
  payrollCd: string;
  /** YYYY-MM-DD */
  effectiveFrom: string;
  branch: string | null;
  payScheme: string | null;
}

export interface EmployeeDeleteKey {
  company: string;
  payrollCd: string;
}

export interface EmployeeAttrDeleteKey {
  company: string;
  payrollCd: string;
  effectiveFrom: string;
}

export interface EmployeeMasterPutBody {
  employees: EmployeeInput[];
  attrs: EmployeeAttrInput[];
  deleteAttrs: EmployeeAttrDeleteKey[];
  deleteEmployees: EmployeeDeleteKey[];
}

function normalizeCompany(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new EmployeeMasterError(`${field} は空でない文字列が必要です`);
  }
  return raw.normalize("NFKC").trim();
}

/** 給与コードの前ゼロ除去 (salaryCdMapKey と同一規則)。 */
function normalizePayrollCd(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    throw new EmployeeMasterError(`${field} は数字の文字列が必要です (${JSON.stringify(raw)})`);
  }
  return String(Number(raw.trim()));
}

function normalizeDriverCd(raw: unknown, field: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string" || !/^\d{1,8}$/.test(raw)) {
    throw new EmployeeMasterError(`${field} は数字 (最大8桁) が必要です (${JSON.stringify(raw)})`);
  }
  return String(Number(raw));
}

function normalizeOptionalText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.normalize("NFKC").trim();
  return trimmed || null;
}

function normalizeEmployeeInput(raw: unknown, index: number): EmployeeInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EmployeeMasterError(`employees[${index}] がオブジェクトではありません`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || !obj.name.trim()) {
    throw new EmployeeMasterError(`employees[${index}].name は空でない文字列が必要です`);
  }
  return {
    company: normalizeCompany(obj.company, `employees[${index}].company`),
    payrollCd: normalizePayrollCd(obj.payrollCd, `employees[${index}].payrollCd`),
    name: obj.name.normalize("NFKC").trim(),
    driverCd: normalizeDriverCd(obj.driverCd, `employees[${index}].driverCd`),
  };
}

function normalizeAttrInput(raw: unknown, index: number): EmployeeAttrInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EmployeeMasterError(`attrs[${index}] がオブジェクトではありません`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.effectiveFrom !== "string" || !DATE_RE.test(obj.effectiveFrom)) {
    throw new EmployeeMasterError(`attrs[${index}].effectiveFrom は YYYY-MM-DD が必要です`);
  }
  return {
    company: normalizeCompany(obj.company, `attrs[${index}].company`),
    payrollCd: normalizePayrollCd(obj.payrollCd, `attrs[${index}].payrollCd`),
    effectiveFrom: obj.effectiveFrom,
    branch: normalizeOptionalText(obj.branch),
    payScheme: normalizeOptionalText(obj.payScheme),
  };
}

function normalizeAttrDeleteKey(raw: unknown, index: number): EmployeeAttrDeleteKey {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EmployeeMasterError(`deleteAttrs[${index}] がオブジェクトではありません`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.effectiveFrom !== "string" || !DATE_RE.test(obj.effectiveFrom)) {
    throw new EmployeeMasterError(`deleteAttrs[${index}].effectiveFrom は YYYY-MM-DD が必要です`);
  }
  return {
    company: normalizeCompany(obj.company, `deleteAttrs[${index}].company`),
    payrollCd: normalizePayrollCd(obj.payrollCd, `deleteAttrs[${index}].payrollCd`),
    effectiveFrom: obj.effectiveFrom,
  };
}

function normalizeDeleteKey(raw: unknown, index: number): EmployeeDeleteKey {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EmployeeMasterError(`deleteEmployees[${index}] がオブジェクトではありません`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    company: normalizeCompany(obj.company, `deleteEmployees[${index}].company`),
    payrollCd: normalizePayrollCd(obj.payrollCd, `deleteEmployees[${index}].payrollCd`),
  };
}

function normalizeArray<T>(raw: unknown, field: string, fn: (item: unknown, i: number) => T): T[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new EmployeeMasterError(`${field} は配列が必要です`);
  return raw.map(fn);
}

/**
 * PUT /restraint-api/employee-master の body を検証・正規化する。
 * 4 フィールドいずれも省略可 (差分だけ送る想定 — 未指定は空配列扱い)。
 */
export function normalizeEmployeeMasterPutBody(raw: unknown): EmployeeMasterPutBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new EmployeeMasterError("employee-master の PUT body は JSON オブジェクトが必要です");
  }
  const obj = raw as Record<string, unknown>;
  return {
    employees: normalizeArray(obj.employees, "employees", normalizeEmployeeInput),
    attrs: normalizeArray(obj.attrs, "attrs", normalizeAttrInput),
    deleteAttrs: normalizeArray(obj.deleteAttrs, "deleteAttrs", normalizeAttrDeleteKey),
    deleteEmployees: normalizeArray(obj.deleteEmployees, "deleteEmployees", normalizeDeleteKey),
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
 * 検証済み PUT body を D1 `batch()` に渡す prepared statement 列に変換する。
 * last-write-wins (楽観排他なし、Refs #367)。
 */
export function buildEmployeeMasterWriteStatements(body: EmployeeMasterPutBody, nowIso: string): D1Statement[] {
  const statements: D1Statement[] = [];
  for (const e of body.employees) {
    statements.push({
      sql: `INSERT INTO employees (company, payroll_cd, name, name_key, driver_cd, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(company, payroll_cd) DO UPDATE SET
              name = excluded.name,
              name_key = excluded.name_key,
              driver_cd = excluded.driver_cd,
              updated_at = excluded.updated_at`,
      params: [e.company, e.payrollCd, e.name, normalizeNameKey(e.name), e.driverCd, nowIso],
    });
  }
  for (const a of body.attrs) {
    statements.push({
      sql: `INSERT INTO employee_attrs (company, payroll_cd, effective_from, branch, pay_scheme)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(company, payroll_cd, effective_from) DO UPDATE SET
              branch = excluded.branch,
              pay_scheme = excluded.pay_scheme`,
      params: [a.company, a.payrollCd, a.effectiveFrom, a.branch, a.payScheme],
    });
  }
  for (const k of body.deleteAttrs) {
    statements.push({
      sql: `DELETE FROM employee_attrs WHERE company = ? AND payroll_cd = ? AND effective_from = ?`,
      params: [k.company, k.payrollCd, k.effectiveFrom],
    });
  }
  for (const k of body.deleteEmployees) {
    statements.push(
      { sql: `DELETE FROM employee_attrs WHERE company = ? AND payroll_cd = ?`, params: [k.company, k.payrollCd] },
      { sql: `DELETE FROM employees WHERE company = ? AND payroll_cd = ?`, params: [k.company, k.payrollCd] },
    );
  }
  return statements;
}

/**
 * R2 突合マスタ取り込み (`POST .../import-cd-map`) 用の書き込み文。冪等
 * (`INSERT OR IGNORE`) — 既存の社員マスタ行は上書きしない (取り込みボタンを
 * 何度押しても安全、Refs #367 API 節)。
 */
export function buildEmployeeMasterImportStatements(employees: EmployeeInput[], nowIso: string): D1Statement[] {
  return employees.map((e) => ({
    sql: `INSERT OR IGNORE INTO employees (company, payroll_cd, name, name_key, driver_cd, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [e.company, e.payrollCd, e.name, normalizeNameKey(e.name), e.driverCd, nowIso],
  }));
}

// ---------------------------------------------------------------------------
// R2 salary-cd-map → employees 行変換 (Refs #367 のマスタ吸収)
// ---------------------------------------------------------------------------

interface ParsedCdMapKey {
  /** 3部キーの会社ラベル。2部キー (旧形式、会社ラベル無し) は null。 */
  company: string | null;
  payrollCd: string;
  nameKey: string;
}

/**
 * "給与コード|氏名" (2部、旧形式) または "会社|給与コード|氏名" (3部) を分解する。
 * restraint-wage.ts の `CD_MAP_KEY_RE` と同じ形式を前提とする。不正な形式は null。
 */
function parseCdMapKey(key: string): ParsedCdMapKey | null {
  const parts = key.split("|");
  if (parts.length === 2) {
    const [payrollCd, nameKey] = parts;
    if (!payrollCd || !/^\d+$/.test(payrollCd) || !nameKey) return null;
    return { company: null, payrollCd, nameKey };
  }
  if (parts.length === 3) {
    const [company, payrollCd, nameKey] = parts;
    if (!company || !payrollCd || !/^\d+$/.test(payrollCd) || !nameKey) return null;
    return { company, payrollCd, nameKey };
  }
  return null;
}

/**
 * salary-cd-map の `entries` (2部/3部キー → 乗務員CD) を employees 行に変換する。
 * 2部キー (会社ラベル無し) は `fallbackCompany` を会社として補う — 呼び出し元
 * (import-cd-map ルート) は R2 (compId 単位) から読んだ 1 会社分の salary-cd-map
 * だけを対象にするため、`fallbackCompany` には取り込み UI で使われている実際の
 * 会社ラベル (「株」「有」等、compId ではない) を渡す責務が呼び出し側にある。
 * 3部キーはキー先頭の会社ラベルをそのまま使い `fallbackCompany` は無視する。
 *
 * salary-cd-map は正規化済み氏名 (空白除去済み) しか保持していない — 原文の氏名
 * は失われているため、変換後の `name` は正規化済み文字列をそのまま使う (取り込み
 * 後、社員マスタタブで手直しできる)。
 */
export function cdMapEntriesToEmployees(entries: Record<string, string>, fallbackCompany: string): EmployeeInput[] {
  const out: EmployeeInput[] = [];
  for (const [key, driverCd] of Object.entries(entries)) {
    const parsed = parseCdMapKey(key);
    if (!parsed) continue;
    const company = parsed.company ?? fallbackCompany;
    if (!company) continue;
    out.push({
      company,
      payrollCd: String(Number(parsed.payrollCd)),
      name: parsed.nameKey,
      driverCd: String(Number(driverCd)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET 応答の組み立て (pure)
// ---------------------------------------------------------------------------

export interface EmployeeAttrRow {
  effectiveFrom: string;
  branch: string | null;
  payScheme: string | null;
}

export interface EmployeeMasterEntry {
  company: string;
  payrollCd: string;
  name: string;
  driverCd: string | null;
  attrs: EmployeeAttrRow[];
}

export interface EmployeeMasterGetResponse {
  employees: EmployeeMasterEntry[];
  migratable: boolean;
}

/** D1 `employees` テーブルの生行 (snake_case、`SELECT *` そのまま)。 */
export interface EmployeeD1Row {
  company: string;
  payroll_cd: string;
  name: string;
  driver_cd: string | null;
}

/** D1 `employee_attrs` テーブルの生行。 */
export interface EmployeeAttrD1Row {
  company: string;
  payroll_cd: string;
  effective_from: string;
  branch: string | null;
  pay_scheme: string | null;
}

/**
 * D1 の生行 (employees + employee_attrs) を GET レスポンス形に組み立てる。
 * 月末解決 (「対象月の末日時点で効いている値」) はフロント側の純関数
 * (app/utils/employee-master.ts, PR-B) が行う — ここでは履歴を effectiveFrom
 * 昇順に並べて返すだけ。
 */
export function buildEmployeeMasterResponse(
  employeeRows: EmployeeD1Row[],
  attrRows: EmployeeAttrD1Row[],
  migratable: boolean,
): EmployeeMasterGetResponse {
  const attrsByKey = new Map<string, EmployeeAttrRow[]>();
  for (const r of attrRows) {
    const key = `${r.company}|${r.payroll_cd}`;
    const list = attrsByKey.get(key) ?? [];
    list.push({ effectiveFrom: r.effective_from, branch: r.branch, payScheme: r.pay_scheme });
    attrsByKey.set(key, list);
  }
  for (const list of attrsByKey.values()) list.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const employees = employeeRows.map((r) => ({
    company: r.company,
    payrollCd: r.payroll_cd,
    name: r.name,
    driverCd: r.driver_cd,
    attrs: attrsByKey.get(`${r.company}|${r.payroll_cd}`) ?? [],
  }));
  return { employees, migratable };
}

// ---------------------------------------------------------------------------
// 月末解決 (「対象月の末日時点で効いている値」、Refs #367)
// ---------------------------------------------------------------------------

const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;

/** "YYYY-MM" の末日を "YYYY-MM-DD" で返す。不正な形式は null。 */
function lastDayOfMonth(yearMonth: string): string | null {
  const m = YEAR_MONTH_RE.exec(yearMonth);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${m[1]}-${m[2]}-${String(day).padStart(2, "0")}`;
}

/**
 * 対象月 (`yearMonth`, "YYYY-MM") の末日時点で効いている属性行を解決する。
 * `effectiveFrom` が月末以下の行のうち最新のものを返す。無ければ (全て月末より
 * 後、または `attrs` が空) null。`yearMonth` が不正な形式の場合も null
 * (fail-soft — 呼び出し側で「未設定」として扱う)。
 */
export function resolveAttrsAt(attrs: EmployeeAttrRow[], yearMonth: string): EmployeeAttrRow | null {
  const monthEnd = lastDayOfMonth(yearMonth);
  if (!monthEnd) return null;
  let resolved: EmployeeAttrRow | null = null;
  for (const a of attrs) {
    if (a.effectiveFrom > monthEnd) continue;
    if (!resolved || a.effectiveFrom > resolved.effectiveFrom) resolved = a;
  }
  return resolved;
}
