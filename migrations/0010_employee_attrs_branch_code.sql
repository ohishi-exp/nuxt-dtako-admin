-- 社員マスタの所属に、給与大臣が持っている所属コード・営業所名・職種名を足す
-- (Refs #409)。
--
-- なぜ: `SHOZOKU` は営業所名 (`NAME1`) と職種名 (`NAME2`) を別々に持っており、
-- 表示名 (`SNAME` = `本社　乗務員`) はその結合済み文字列だった。ところが
-- `/api/kyuyo/employees` が `SNAME` しか返していなかったため、拠点 (最低賃金を
-- 引く単位) を得るのに `SNAME` の全角スペース揺れを正規化して前方一致でまとめる、
-- という推定を挟んでいた (branch-prefecture.ts の suggestBranchGroups)。
-- `NAME1` をそのまま持てばこの推定が要らなくなる。
--
-- 並び順も同じ理由: 「所属順」が営業所名の文字コード順 (`佐賀` U+4F50 <
-- `本社` U+672C) になっていた。`INCODE` を持てば給与大臣の所属順で並べられる。
--
-- 既存行 (2026-07-25 時点で本番 182 件) は 3 列すべて NULL のままになる。
-- 「給与DBから取り込み」を再実行すると同じ `effective_from` の行が UPDATE され
-- 埋まる。埋まるまでは従来どおり `branch` (SNAME) からの前方一致で拠点を引く
-- ため、挙動は壊れない (branch-prefecture.ts の buildBranchGroups が NULL 行を
-- 従来経路へ回す)。
ALTER TABLE employee_attrs ADD COLUMN branch_code INTEGER;
ALTER TABLE employee_attrs ADD COLUMN branch_name TEXT;
ALTER TABLE employee_attrs ADD COLUMN job_name TEXT;
