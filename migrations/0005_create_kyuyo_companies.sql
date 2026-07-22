-- 給与大臣 (OHKEN) の会社×年度リスト (Refs #369)。
-- 識別情報のみ — 金額は D1 に入れない (#367 と同方針)。
-- 更新は /api/kyuyo-master/refresh (差分、rust の /api/kyuyo/databases 由来) と
-- /api/kyuyo-master/refresh-full (会社名+権限チェック込み、/api/kyuyo/companies 由来)。
CREATE TABLE IF NOT EXISTS kyuyo_companies (
  -- 会社コード 4 桁 (例 '0100')
  company TEXT PRIMARY KEY,
  -- KYCOMSTD 由来の会社名 (フル更新でのみ埋まる)
  name TEXT NOT NULL DEFAULT '',
  -- アクセス可能年度 (西暦) の JSON 配列 (例 '[2012,2013]')
  years TEXT NOT NULL DEFAULT '[]',
  -- 最終更新 (ISO8601)
  updated_at TEXT NOT NULL DEFAULT ''
);
