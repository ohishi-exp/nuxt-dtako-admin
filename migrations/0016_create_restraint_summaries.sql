-- 拘束サマリの D1 化 (Refs #452 PR-A)。
--
-- wage-report は従来、乗務員ごとの summary latest.json を R2 から 1 つずつ読んで
-- いた (GET 数 = 3 + 2×(theearth 人数 + タイムカード人数) ≈ 300本、単独実行でも
-- 4.9〜7.3 秒)。速度に加えて Workers の subrequest 上限 (有料 1000/request) にも
-- R2 呼び出しが算入されるため、増員でいずれ月表示が 500 になる。
--
-- 本 migration はサマリの写しを D1 に持たせる (PR-A では書き込みのみ。読み取りの
-- 切替は PR-C)。**R2 は原本 (CSV・版・履歴・customMetadata) の保管庫として残す** —
-- 監査証跡なので消さない。D1 側は常に「R2 の latest と同内容」の写しであり、
-- putVersionedR2 の結果 (changed / sha256 / fetchedAt) をそのまま反映する。
--
-- 分割:
-- - restraint_driver_month — 乗務員 × 月の属性・月計・取得時刻。noData マーカー
--   (「該当データがありません」の確認記録、Refs #241) も no_data=1 で同居する
-- - restraint_daily — 日別行 (賃金計算・週40h・法定区分分類の素材)。
--   timecard 固有の leaves / sessions は JSON TEXT (theearth 由来は NULL)
--
-- source は 'theearth' (デジタコ) | 'timecard' (タイムカード CakePHP)。同一
-- 乗務員CD が両方に居る月もある (wage-report 側が theearth 優先で合流する) ため
-- PK に source を含む。

CREATE TABLE restraint_driver_month (
  comp_id TEXT NOT NULL,
  source TEXT NOT NULL,               -- 'theearth' | 'timecard'
  driver_cd TEXT NOT NULL,
  ym TEXT NOT NULL,                   -- 'YYYY-MM'
  no_data INTEGER NOT NULL DEFAULT 0, -- 1 = 「該当データがありません」マーカー
  driver_name TEXT NOT NULL DEFAULT '',
  branch_name TEXT NOT NULL DEFAULT '',
  work_days INTEGER,
  rest_days INTEGER,
  restraint_minutes INTEGER,
  driving_minutes INTEGER,
  loading_minutes INTEGER,
  break_minutes INTEGER,
  working_minutes INTEGER,
  overtime_minutes INTEGER,
  night_minutes INTEGER,
  overtime_night_minutes INTEGER,
  max_daily_restraint_minutes INTEGER,
  fiscal_cumulative_minutes INTEGER,
  restraint_limit_minutes INTEGER,
  excess_restraint_minutes INTEGER,
  over15h_days INTEGER,
  avg_driving_9h_over_count INTEGER,
  -- timecard 固有 (theearth 由来は NULL)
  voluntary_minutes INTEGER,
  punch_error_days INTEGER,
  punch_error_minutes INTEGER,
  leave_counts TEXT,                  -- JSON (TimecardLeaveCounts)
  -- R2 latest との同期メタ (putVersionedR2 の customMetadata と同値)
  sha256 TEXT,
  fetched_at TEXT,
  last_verified_at TEXT,
  PRIMARY KEY (comp_id, source, driver_cd, ym)
);

-- wage-report は「comp × 月」で当月+前月をまとめて引く
CREATE INDEX idx_restraint_driver_month_comp_ym
  ON restraint_driver_month (comp_id, ym);

CREATE TABLE restraint_daily (
  comp_id TEXT NOT NULL,
  source TEXT NOT NULL,
  driver_cd TEXT NOT NULL,
  ym TEXT NOT NULL,
  day INTEGER NOT NULL,               -- 1-31
  is_rest_day INTEGER NOT NULL,       -- 0 | 1
  restraint_minutes INTEGER,
  working_minutes INTEGER,
  overtime_minutes INTEGER,
  night_minutes INTEGER,
  overtime_night_minutes INTEGER,
  holiday_kind TEXT,                  -- 'legal' | 'non_legal' | 'weekday' (timecard 由来のみ)
  -- timecard 固有 (theearth 由来は NULL)
  voluntary_minutes INTEGER,
  punch_error_minutes INTEGER,
  leaves TEXT,                        -- JSON string[] (休暇区分の原文)
  sessions TEXT,                      -- JSON TimecardSession[] (打刻区間)
  PRIMARY KEY (comp_id, source, driver_cd, ym, day)
);

CREATE INDEX idx_restraint_daily_comp_ym
  ON restraint_daily (comp_id, ym);
