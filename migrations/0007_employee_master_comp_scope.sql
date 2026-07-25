-- 社員マスタを dtako テナント (comp_id) スコープにする (Refs #367)。
--
-- 0006 の employees / employee_attrs は comp_id を持たず、DO も
-- `SELECT ... FROM employees` を無条件で返していた。dtako テナントは実際には
-- 複数あり (27324455 = 給与DB 0100/0200/0300、75700192 = 0400)、このままだと
-- 一方のセッションから他方の社員の識別情報 (会社・給与コード・氏名・乗務員CD)
-- が読めてしまう。PK に comp_id を含めてテナント間で完全に分離する。
--
-- SQLite は PK の変更ができないためテーブルを作り直す。既存行は全て
-- comp_id = '27324455' 由来 (R2 `restraint/27324455/salary-cd-map` からの
-- import-cd-map で投入された 88 件、2026-07-25) なのでその値で backfill する。
CREATE TABLE IF NOT EXISTS employees_v2 (
  comp_id TEXT NOT NULL,
  company TEXT NOT NULL,
  payroll_cd TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  driver_cd TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (comp_id, company, payroll_cd)
);
INSERT OR IGNORE INTO employees_v2 (comp_id, company, payroll_cd, name, name_key, driver_cd, updated_at)
  SELECT '27324455', company, payroll_cd, name, name_key, driver_cd, updated_at FROM employees;
DROP TABLE employees;
ALTER TABLE employees_v2 RENAME TO employees;
-- 乗務員CD 逆引き (月次 CSV の 所属/給与体系 列) は comp 内で引く
CREATE INDEX IF NOT EXISTS idx_employees_comp_driver_cd ON employees(comp_id, driver_cd);

CREATE TABLE IF NOT EXISTS employee_attrs_v2 (
  comp_id TEXT NOT NULL,
  company TEXT NOT NULL,
  payroll_cd TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  branch TEXT,
  pay_scheme TEXT,
  PRIMARY KEY (comp_id, company, payroll_cd, effective_from)
);
INSERT OR IGNORE INTO employee_attrs_v2 (comp_id, company, payroll_cd, effective_from, branch, pay_scheme)
  SELECT '27324455', company, payroll_cd, effective_from, branch, pay_scheme FROM employee_attrs;
DROP TABLE employee_attrs;
ALTER TABLE employee_attrs_v2 RENAME TO employee_attrs;
