-- インタンク燃料確認 (/fuel/intank) の「直近 30 start の誤差一覧」で、人が「無視」にした給油行。
--
-- 給油行 (fuel_intank) は社内 MariaDB にあり、この D1 からは触れない。ここは
-- 「どの行を一覧に出さないか」だけを全員で共有するための印で、給油行の主キー
-- (datetime, fuel_card_id) をそのまま持つ。行が消えても印は残るが、一覧に出ないだけで害は無い。
--
-- tenant_id を PK 先頭に置く (0016〜0019 と同じくテナント分離)。
CREATE TABLE IF NOT EXISTS fuel_intank_ignores (
  tenant_id TEXT NOT NULL,
  -- 給油行の datetime (`YYYY-MM-DD HH:MM:SS`、rust-fuel-worker の応答のまま)
  datetime TEXT NOT NULL,
  fuel_card_id INTEGER NOT NULL,
  -- 無視にした人 (ログインの email) と日時 (ISO 8601)
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, datetime, fuel_card_id)
);
