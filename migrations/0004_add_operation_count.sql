-- NET780 の operation_count (その zipKey に含まれる運行数) を D1 カタログにも
-- 持たせる。r2-view (DO 側) は operationCount > 1 の archive を安全に個別
-- 抽出できないため拒否しているが、by-operation.get.ts (Nitro、/operations
-- タブ用) には同じガードが無く、複数運行まとめてアーカイブされた旧データを
-- 誤って返し parse エラーになる実害が出た (2026-07-18)。この列を追加して
-- 同じ安全策を Nitro 側にも適用する。既存行は NULL (=不明、旧データとして
-- 安全側に倒し「表示不可」扱いにする)。
ALTER TABLE dtako_uploads ADD COLUMN operation_count INTEGER;
