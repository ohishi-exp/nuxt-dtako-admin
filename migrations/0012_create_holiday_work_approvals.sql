-- 承認済み休日出勤の登録簿 (Refs #424 PR-C)。
--
-- 休日 (法定休日=日曜 / 法定外休日=指定休・祝日) に打刻がある日は、**この表に
-- 載っている日だけ**が「休日出勤」として割増賃金の計算対象になる。載っていない
-- 休日の打刻は「自主出勤」として賃金計算から外す (時間は記録・表示する)。
--
-- 休日出勤は運用上ほとんど発生しない前提のため、日付を明示登録する方式にした
-- (曜日ルールや一括フラグではなく 1 日 1 行)。事後に承認する運用も、この表に
-- 日付を足すだけで「自主出勤 → 休日出勤」へ昇格できる。
--
-- 突合キーは `driver_cd` (= 乗務員CD = 一番星 社員C = CakePHP drivers.id、
-- 全社員に振られた同一番号体系、Refs #403)。給与コード×会社ではない —
-- 勤務実績側は人単位で引くため。
CREATE TABLE IF NOT EXISTS holiday_work_approvals (
  -- dtako テナント (テナント跨ぎで見せない、Refs #367)
  comp_id TEXT NOT NULL,
  driver_cd TEXT NOT NULL,
  -- 出勤日 (YYYY-MM-DD、始業日基準 — 日跨ぎ勤務は始業日に寄せた行と対応する)
  work_date TEXT NOT NULL,
  -- 承認理由・備考 (任意)
  reason TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comp_id, driver_cd, work_date)
);

-- 月次の一覧 (対象月の承認を全件引く) 用
CREATE INDEX IF NOT EXISTS idx_holiday_work_comp_date
  ON holiday_work_approvals(comp_id, work_date);
