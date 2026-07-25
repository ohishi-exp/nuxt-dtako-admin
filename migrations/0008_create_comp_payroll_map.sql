-- dtako 会社ID (comp_id) ↔ 給与大臣の会社コードの対応 (Refs #367)。
--
-- 社員マスタを給与DB (rust-ichibanboshi `GET /api/kyuyo/employees`) から取り込む時に
-- 「どの dtako 会社の社員マスタへ、どの給与DB会社から取るか」を決めるための表。
-- フロントに直書きすると会社が増えるたびにデプロイが要るので D1 に置く
-- (KV でも良かったが DTAKO_DB は既に binding 済みで wrangler.toml 変更が不要)。
--
-- `legacy_label` は R2 突合マスタ由来の旧会社ラベル ("有"/"株")。給与DB取り込み時に
-- 「旧ラベルの行を CONAME1 ラベルへ統合する」ための一度きりの移行情報で、
-- 統合が済んだら NULL にしてよい (残っていても冪等)。
CREATE TABLE IF NOT EXISTS comp_payroll_map (
  -- dtako の会社ID (X-Theearth-Comp-Id、employees.comp_id と同じ値)
  comp_id TEXT NOT NULL,
  -- 画面表示用の dtako 会社名
  comp_label TEXT NOT NULL,
  -- 給与大臣の会社コード 4 桁 (rust の ALLOWED_COMPANIES)
  payroll_company TEXT NOT NULL,
  -- 移行前の会社ラベル ("有"/"株"、無ければ NULL)
  legacy_label TEXT,
  -- 表示順 (同一 comp 内)
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (comp_id, payroll_company)
);

-- 実データ (2026-07-25 時点、ユーザー確認済み):
--   27324455 大石運輸倉庫 → 0100 / 0200 / 0300
--   75700192 北海大運     → 0400
-- 会社名 (CONAME1) は給与DB側から取るのでここには持たない。
INSERT OR IGNORE INTO comp_payroll_map (comp_id, comp_label, payroll_company, legacy_label, sort_order) VALUES
  ('27324455', '大石運輸倉庫', '0100', '有', 1),
  ('27324455', '大石運輸倉庫', '0200', '株', 2),
  ('27324455', '大石運輸倉庫', '0300', NULL, 3),
  ('75700192', '北海大運', '0400', NULL, 1);
