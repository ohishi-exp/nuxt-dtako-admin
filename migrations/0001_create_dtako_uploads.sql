-- dtako_uploads: NET780 / vehicle-settings 共通のアップロードデータ検索カタログ。
-- R2 (DTAKO_R2) が本体データの正 (source of truth)、D1 はあくまで再構築可能な
-- 検索インデックス (車番・乗務員CD横断検索、運行Noでの `/operations/{unko_no}` 連携用)。
-- Refs #299

CREATE TABLE IF NOT EXISTS dtako_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL CHECK (dataset IN ('net780', 'vehicle_settings')),
  schema_version TEXT NOT NULL DEFAULT '1',
  vehicle_cd TEXT,
  vehicle_name TEXT,
  driver_cd1 TEXT,
  driver_name1 TEXT,
  operation_no TEXT,
  start_datetime TEXT,
  dump_dir TEXT,
  r2_key TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 同一データセット内で r2_key は一意 (再アップロード/再取得時は upsert)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_dtako_uploads_dataset_r2_key
  ON dtako_uploads (dataset, r2_key);

-- 車番検索。
CREATE INDEX IF NOT EXISTS idx_dtako_uploads_vehicle
  ON dtako_uploads (dataset, vehicle_cd);

-- 乗務員CD検索。
CREATE INDEX IF NOT EXISTS idx_dtako_uploads_driver
  ON dtako_uploads (dataset, driver_cd1);

-- 車番×乗務員CD複合検索。
CREATE INDEX IF NOT EXISTS idx_dtako_uploads_vehicle_driver
  ON dtako_uploads (dataset, vehicle_cd, driver_cd1);

-- 運行No経由の /operations/{unko_no} 連携 (主に NET780)。
CREATE INDEX IF NOT EXISTS idx_dtako_uploads_operation
  ON dtako_uploads (operation_no);
