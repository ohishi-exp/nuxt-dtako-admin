-- 複合機でスキャンした「ETC コーポレートカード発行明細書」(Refs #1287)。
--
-- etc_card_scans: 受けた PDF そのもの (sha256 で冪等)。front には書き込める R2 が無い
--   (DTAKO_R2 は read-only) ので BLOB で持つ。D1 の行上限 2MB に収めるため、受け口
--   (`server/routes/dav/[...path].ts`) が 1.5MB 超を 413 で拒否する。
--   OCR に失敗しても行は残し (`ocr_status='failed'`)、画面の「再 OCR」でやり直す。
-- etc_card_registrations: 明細書の 1 行 = カード 1 枚。front が OCR の結果から作り、
--   relay (workers/dtako-scraper-relay) が走行日の照合と etc-meisai.jp への登録で
--   status / run_date / unko_no / attempts / last_error を書く。**列名は relay と共有**。
--   4 項目 (card_number / plate4 / obu_number / kubun) のどれかが NULL → needs_review、
--   揃えば waiting_run。
CREATE TABLE etc_card_scans (
  sha256 TEXT PRIMARY KEY,
  pdf BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  received_at TEXT NOT NULL,      -- ISO8601 (UTC)
  ocr_status TEXT NOT NULL,       -- 'ok' | 'failed'
  ocr_error TEXT,
  row_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE etc_card_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_sha256 TEXT NOT NULL,
  kubun TEXT,                     -- '新規' | '追加' | '再発行' | NULL
  card_number TEXT,               -- 数字 16 桁 or NULL
  vehicle_number TEXT,            -- 原文
  plate4 TEXT,                    -- ナンバー下4桁 (先頭 0 なし) or NULL
  obu_number TEXT,                -- 数字 19 桁 or NULL
  status TEXT NOT NULL,           -- 'needs_review' | 'waiting_run' | 'dry_run_ok' | 'registered' | 'failed'
  run_date TEXT,                  -- YYYY-MM-DD (relay が書く。走行の終了日時の日付)
  unko_no TEXT,                   -- relay が書く
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_etc_card_registrations_card ON etc_card_registrations(card_number) WHERE card_number IS NOT NULL;
CREATE INDEX idx_etc_card_registrations_status ON etc_card_registrations(status);
