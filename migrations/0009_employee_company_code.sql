-- 社員マスタの突合キーの会社部分を、自由文字列の会社ラベル (KYCOMSTD.CONAME1) から
-- 給与大臣の会社コード (0100/0200/0300/0400) へ変える (Refs #405)。
--
-- なぜ: `company` は PK の一部なのに自由文字列で、表記揺れがキー分裂を生む
-- (#367 の留意点)。さらに `/api/kyuyo/payroll` は CONAME1 を返さないため、
-- 給与比較の DB 直読み (#369 PR-B2) が会社ラベルを引き当てられなかった。
-- 会社コードなら payroll 応答の `company` をそのまま突合キーに使える。
--
-- 会社名は表示専用として `comp_payroll_map.payroll_company_name` に持つ
-- (突合には使わない — 給与DB側で会社名が変わっても突合は壊れない)。

-- 1) 表示名の置き場を用意する。値は「給与DBから取り込み」時に CONAME1 を書き戻す。
ALTER TABLE comp_payroll_map ADD COLUMN payroll_company_name TEXT;

-- 2026-07-25 時点の実測値をシードしておく (取り込みのたびに上書きされる)。
UPDATE comp_payroll_map SET payroll_company_name = '有限会社　大石運輸'
  WHERE comp_id = '27324455' AND payroll_company = '0100';
UPDATE comp_payroll_map SET payroll_company_name = '大石運輸倉庫株式会社'
  WHERE comp_id = '27324455' AND payroll_company = '0200';
UPDATE comp_payroll_map SET payroll_company_name = '佐賀大石運輸株式会社'
  WHERE comp_id = '27324455' AND payroll_company = '0300';

-- 2) 既存行の company を CONAME1 → 会社コードへ置換する。
--
-- 対応は 1) でシードした payroll_company_name との一致で引く — ハードコードした
-- 会社コードを書かないことで、会社が増えても同じ規則で追随できる。
-- comp_id ごとに引くので、別 comp に同名の会社があっても混ざらない。
--
-- PK は (comp_id, company, payroll_cd)。同一 comp 内で company が別コードへ
-- 1 対 1 に移るだけなので衝突しない (CONAME1 とコードは別集合)。
UPDATE employees
SET company = (
  SELECT m.payroll_company FROM comp_payroll_map m
  WHERE m.comp_id = employees.comp_id AND m.payroll_company_name = employees.company
)
WHERE EXISTS (
  SELECT 1 FROM comp_payroll_map m
  WHERE m.comp_id = employees.comp_id AND m.payroll_company_name = employees.company
);

UPDATE employee_attrs
SET company = (
  SELECT m.payroll_company FROM comp_payroll_map m
  WHERE m.comp_id = employee_attrs.comp_id AND m.payroll_company_name = employee_attrs.company
)
WHERE EXISTS (
  SELECT 1 FROM comp_payroll_map m
  WHERE m.comp_id = employee_attrs.comp_id AND m.payroll_company_name = employee_attrs.company
);
