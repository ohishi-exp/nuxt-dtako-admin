-- 社員マスタ (Refs #367)。給与コード×会社を主キーに、乗務員CD・所属・給与体系の
-- 適用開始日つき履歴を持つ。識別情報+属性のみを保存し、支給金額・明細は持たない
-- (「金額はブラウザから出さない」方針は不変)。R2 突合マスタ (salary-cd-map) は
-- このテーブルに吸収する (import-cd-map ルート、Refs employee-master.ts)。
--
-- PK は (company, payroll_cd)。lookup 時は name_key 一致を必須にする —
-- 給与コードが退職者から再利用されても旧人物に紐付かない (現行 salary-cd-map の
-- 3部キーと同じ安全性を維持)。
CREATE TABLE IF NOT EXISTS employees (
  -- 会社ラベル (取り込みUIと同じ自由文字列、例 "株"/"有")
  company TEXT NOT NULL,
  -- 給与コード (前ゼロ除去済み)
  payroll_cd TEXT NOT NULL,
  -- 表示用氏名 (原文)
  name TEXT NOT NULL,
  -- 突合用正規化氏名 (NFKC + 空白除去、normalizeNameKey と同一規則)
  name_key TEXT NOT NULL,
  -- 乗務員CD (未確定なら NULL)
  driver_cd TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company, payroll_cd)
);
CREATE INDEX IF NOT EXISTS idx_employees_driver_cd ON employees(driver_cd);

-- 所属・給与体系の履歴 (任意日付から有効)。月の帰属規則は「対象月の末日時点で
-- 効いている値」(effective_from <= 月末の最新行) — 解決は呼び出し側の純関数
-- (resolveAttrsAt) で行う。
CREATE TABLE IF NOT EXISTS employee_attrs (
  company TEXT NOT NULL,
  payroll_cd TEXT NOT NULL,
  -- YYYY-MM-DD
  effective_from TEXT NOT NULL,
  -- 所属
  branch TEXT,
  -- 給与体系
  pay_scheme TEXT,
  PRIMARY KEY (company, payroll_cd, effective_from)
);
