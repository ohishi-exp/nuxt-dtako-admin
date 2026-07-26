-- 社員マスタに入社日・退社日を足す (Refs #445)。
--
-- 出勤日数を「月日数 − 公休 − 有休 − 欠勤」で逆算していたため、途中入社・途中退職の
-- 人が**在籍していない日まで出勤に数えられていた** (#442 のタイムカード表、#443 の
-- 期間サマリー)。在籍日数を出せるように給与大臣から取り込む。
--
-- 出どころは `SHAIN2.DAYNYU` / `SHAIN2.DAYTAI` (rust-ichibanboshi#105)。**`SHAIN1`
-- ではない**。在籍中の `DAYTAI` は NULL でなく `1970-01-02` (センチネル) なので、
-- rust 側で null に正規化してから来る。
--
-- 所属や給与体系と違って**時点で切らない** — 入社日は 1 人 1 つで、履歴を持つ
-- 意味が無い (employee_attrs ではなく employees に置く理由)。
-- 未取り込みの社員は NULL のままで、画面は在籍日数を出さず従来の計算に落とす。
ALTER TABLE employees ADD COLUMN hire_date TEXT;
ALTER TABLE employees ADD COLUMN retire_date TEXT;
