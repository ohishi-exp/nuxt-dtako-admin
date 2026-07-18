-- NET780 は zipKey (内容ハッシュ) を dedup 保存するため、同一 zipKey を複数の
-- operationNo が指すことも起こりうる (別運行でも偶然同一内容、等)。カタログ行の
-- 自然な一意性は r2_key ではなく operation_no 側にあるため、専用の partial
-- unique index を追加する (vehicle-settings は operation_no を持たないため
-- 既存の (dataset, r2_key) 側で一意性を担保、Refs #299)。
CREATE UNIQUE INDEX IF NOT EXISTS idx_dtako_uploads_dataset_operation_no
  ON dtako_uploads (dataset, operation_no)
  WHERE operation_no IS NOT NULL;
