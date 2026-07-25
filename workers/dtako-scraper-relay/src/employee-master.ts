/**
 * 社員マスタ (Refs #367): 給与コード×会社 → 乗務員CD・所属/給与体系履歴の pure ロジック。
 *
 * 保存先は D1 (`employees` / `employee_attrs`、migration 0006)。金額・明細は持たない
 * (識別情報+属性のみ、「支給金額はブラウザから出さない」方針は不変)。R2 突合マスタ
 * (`salary-cd-map`) はこのテーブルへ吸収済みで、移行経路は本番確認後に撤去した
 * (2026-07-25)。
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
 *
 * 全文が `comp_id` (dtako テナント) を含む — 社員マスタはテナント跨ぎで
 * 見えてはいけない (migration 0007、Refs #367)。呼び出し側は必ず
 * セッションの compId を渡すこと (クライアント入力を信用しない)。
 */
export function buildEmployeeMasterWriteStatements(
  body: EmployeeMasterPutBody,
  nowIso: string,
  compId: string,
): D1Statement[] {
  const statements: D1Statement[] = [];
  for (const e of body.employees) {
    statements.push({
      sql: `INSERT INTO employees (comp_id, company, payroll_cd, name, name_key, driver_cd, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(comp_id, company, payroll_cd) DO UPDATE SET
              name = excluded.name,
              name_key = excluded.name_key,
              driver_cd = excluded.driver_cd,
              updated_at = excluded.updated_at`,
      params: [compId, e.company, e.payrollCd, e.name, normalizeNameKey(e.name), e.driverCd, nowIso],
    });
  }
  for (const a of body.attrs) {
    statements.push({
      sql: `INSERT INTO employee_attrs (comp_id, company, payroll_cd, effective_from, branch, pay_scheme)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(comp_id, company, payroll_cd, effective_from) DO UPDATE SET
              branch = excluded.branch,
              pay_scheme = excluded.pay_scheme`,
      params: [compId, a.company, a.payrollCd, a.effectiveFrom, a.branch, a.payScheme],
    });
  }
  for (const k of body.deleteAttrs) {
    statements.push({
      sql: `DELETE FROM employee_attrs WHERE comp_id = ? AND company = ? AND payroll_cd = ? AND effective_from = ?`,
      params: [compId, k.company, k.payrollCd, k.effectiveFrom],
    });
  }
  for (const k of body.deleteEmployees) {
    statements.push(
      {
        sql: `DELETE FROM employee_attrs WHERE comp_id = ? AND company = ? AND payroll_cd = ?`,
        params: [compId, k.company, k.payrollCd],
      },
      {
        sql: `DELETE FROM employees WHERE comp_id = ? AND company = ? AND payroll_cd = ?`,
        params: [compId, k.company, k.payrollCd],
      },
    );
  }
  return statements;
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
  return { employees };
}

// ---------------------------------------------------------------------------
// 会社対応表 (dtako 会社ID ↔ 給与大臣の会社コード、migration 0008)
// ---------------------------------------------------------------------------

/** D1 `comp_payroll_map` の生行。 */
export interface CompPayrollMapD1Row {
  comp_id: string;
  comp_label: string;
  payroll_company: string;
  legacy_label: string | null;
  /** 給与DB の会社名 (KYCOMSTD.CONAME1)。**表示専用** — 突合キーには使わない
   * (Refs #405。突合は会社コードで行う)。未取り込みなら null。 */
  payroll_company_name: string | null;
  sort_order: number;
}

export interface CompPayrollEntry {
  /** 給与大臣の会社コード 4 桁。 */
  payrollCompany: string;
  /** 移行前の会社ラベル ("有"/"株")。統合済み・不要なら null。 */
  legacyLabel: string | null;
  /** 給与DB の会社名 (CONAME1)。**表示専用** (Refs #405)。 */
  payrollCompanyName: string | null;
}

export interface CompMapEntry {
  compId: string;
  compLabel: string;
  payrollCompanies: CompPayrollEntry[];
}

/**
 * `comp_payroll_map` の生行を会社単位に畳んで応答形にする。
 *
 * `allowed` (呼び出し元と同じ tenant の comp 集合) に無い会社は落とす —
 * 会社名や会社IDを別テナントに見せないため (Refs #367)。並びは comp_id 昇順 →
 * `sort_order` 昇順 → 会社コード昇順で安定させる。
 */
export function buildCompMapResponse(rows: CompPayrollMapD1Row[], allowed: Set<string>): CompMapEntry[] {
  const byComp = new Map<string, CompMapEntry>();
  const sorted = [...rows].sort(
    (a, b) =>
      a.comp_id.localeCompare(b.comp_id) ||
      a.sort_order - b.sort_order ||
      a.payroll_company.localeCompare(b.payroll_company),
  );
  for (const r of sorted) {
    if (!allowed.has(r.comp_id)) continue;
    const entry = byComp.get(r.comp_id) ?? { compId: r.comp_id, compLabel: r.comp_label, payrollCompanies: [] };
    entry.payrollCompanies.push({
      payrollCompany: r.payroll_company,
      legacyLabel: r.legacy_label,
      payrollCompanyName: r.payroll_company_name,
    });
    byComp.set(r.comp_id, entry);
  }
  return [...byComp.values()];
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
