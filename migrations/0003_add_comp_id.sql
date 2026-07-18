-- NET780 は theearth の compId (会社) 単位でセッション/R2 prefix を分けているが、
-- dtako_uploads にはテナント列が無く、検索APIがそのまま compId 横断で結果を
-- 返してしまう (Refs #299)。comp_id を追加し、検索は必ずこれで絞り込む。
-- vehicle-settings は theearth 由来ではないため comp_id は NULL のまま。
ALTER TABLE dtako_uploads ADD COLUMN comp_id TEXT;

CREATE INDEX IF NOT EXISTS idx_dtako_uploads_comp_vehicle_name
  ON dtako_uploads (dataset, comp_id, vehicle_name);

CREATE INDEX IF NOT EXISTS idx_dtako_uploads_comp_driver
  ON dtako_uploads (dataset, comp_id, driver_cd1);
