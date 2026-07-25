-- 所定労働時間マスタ (Refs #424 PR-C)。
--
-- タイムカード由来の勤務 (本社事務員等) で「残業かどうか」を判定するための所定
-- 労働時間。デジタコ (theearth) 由来の乗務員は時間外を CSV がそのまま持っている
-- ので対象外 — このマスタが効くのは timecard 由来の summary だけ。
--
-- **休憩は持たない**: 実データ検証 (2026-07-26) で事務員は昼休憩で打刻を切って
-- いることが分かったため、休憩は打刻 (sessions) の中抜けギャップと 12:00-13:00
-- の和集合から算出する。固定値マスタは不要になった。
--
-- スコープ: `branch_code` / `job_name` で所属×職種ごとに上書きできる。運用上は
-- まず全社既定 1 行だけを入れる (ユーザー判断「基本会社でいい、今後必要なら拡張」)
-- が、列を最初から持たせておけば所属×職種へ広げる時に migration が要らない。
--
-- **NULL をスコープの「全体」に使わない**: SQLite (D1) の UNIQUE / PRIMARY KEY は
-- NULL 同士を「異なる値」として扱うため、NULL を PK に含めると
-- `ON CONFLICT(...) DO UPDATE` が一致せず、同じ全社既定行が upsert のたびに
-- 二重に入る。番兵値を使う:
--   branch_code = -1 → 全拠点
--   job_name    = '' → 全職種
-- (アプリ側の型は `number | null` / `string | null` のままで、SQL 境界で変換する)
CREATE TABLE IF NOT EXISTS work_schedules (
  -- dtako テナント (社員マスタと同じくテナント跨ぎで見せない、Refs #367)
  comp_id TEXT NOT NULL,
  -- 適用開始日 (YYYY-MM-DD)。月の帰属は「対象月の末日時点で効いている行」
  effective_from TEXT NOT NULL,
  -- スコープ (-1 = 全拠点)。employee_attrs.branch_code (SHOZOKU.INCODE) と同じ体系
  branch_code INTEGER NOT NULL DEFAULT -1,
  -- スコープ ('' = 全職種)。employee_attrs.job_name (SHOZOKU.NAME2) と同じ体系
  job_name TEXT NOT NULL DEFAULT '',
  -- 1 日の所定労働時間 (分)。これを超えた分が時間外
  daily_work_minutes INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (comp_id, effective_from, branch_code, job_name)
);
