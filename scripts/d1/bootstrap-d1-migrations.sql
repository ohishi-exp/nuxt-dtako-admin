-- D1 migration 記帳テーブルのバックフィル (一度きり・冪等、Refs #367)。
--
-- 経緯: 本番 D1 (`dtako-admin-uploads-catalog`) は wrangler の migration 機構を
-- 使わず手作業で作られてきた (#301 の「手動適用」運用)。そのため記帳テーブル
-- `d1_migrations` が存在せず、`wrangler d1 migrations apply --remote` を CI で
-- 回すと 0001 から再実行され、**0003 の `ALTER TABLE ... ADD COLUMN comp_id` が
-- "duplicate column name" で落ちる** (本番には comp_id / operation_count とも
-- 既に存在する — 2026-07-25 に実 DB を確認済み)。
--
-- そこで 0001〜0005 を「適用済み」として記帳だけ行い、0006 以降を
-- `d1 migrations apply` に任せる。既存テーブルのスキーマ・データには一切触れない。
-- `INSERT OR IGNORE` なので 2 回目以降は no-op (CI が毎回実行しても安全)。
--
-- テーブル定義は wrangler が自前で作るものと同一 (ローカル D1 の sqlite_master
-- から写した実物)。列名・型がズレると apply 側が別テーブルを作ってしまうため、
-- wrangler を上げた時はここも突き合わせること。
CREATE TABLE IF NOT EXISTS d1_migrations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);

-- name は migration の**ファイル名そのもの** (wrangler の記帳形式)。
INSERT OR IGNORE INTO d1_migrations (name) VALUES
  ('0001_create_dtako_uploads.sql'),
  ('0002_add_operation_no_unique_index.sql'),
  ('0003_add_comp_id.sql'),
  ('0004_add_operation_count.sql'),
  ('0005_create_kyuyo_companies.sql');
