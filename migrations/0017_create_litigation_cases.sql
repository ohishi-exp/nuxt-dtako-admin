-- 訴訟用の準備ページ (Refs #1133) の案件保存。
--
-- ohishi-exp/nuxt-dtako-admin#1133: 訴訟に備えて「何月から何月まで・どの乗務員の
-- 勤務を記録するか」を画面で選び、案件として保存して開き直せるようにする。
-- 本 migration はその保存先だけを作る — Y時間 Excel 出力・エラー検知・変更記録は
-- 後続 PR (#c1133-2 / -5 / -6) が別テーブル/別 route で足す。
--
-- 型は 0016 (restraint_driver_month 等) に倣い comp_id を PK 先頭に置く
-- (社員マスタ・所定労働時間マスタと同じテナント分離。NULL をスコープの全体には
-- 使わない — work_schedules の番兵値の注記と同じ理由でここでは該当しないが、
-- NULL を PK に入れないという原則自体は踏襲する)。
--
-- driver_cds は乗務員CDの JSON 配列文字列 (例 '["1194","1523"]')。件数は
-- 1〜50 件・重複除去済みであることをアプリ側 (litigation-case.ts) が保証する —
-- D1 に正規化テーブルを分けるほどの検索要件が今のところ無いため。

CREATE TABLE litigation_cases (
  comp_id TEXT NOT NULL,
  case_id TEXT NOT NULL,          -- crypto.randomUUID()
  name TEXT NOT NULL,
  from_month TEXT NOT NULL,       -- 'YYYY-MM' (昇順に正規化済み)
  to_month TEXT NOT NULL,         -- 'YYYY-MM'
  driver_cds TEXT NOT NULL,       -- JSON 配列の文字列
  memo TEXT NOT NULL DEFAULT '',
  created_by TEXT,                -- viewer の email (無ければ NULL)
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (comp_id, case_id)
);

-- 一覧は「更新日時の新しい順」で出す (画面の一覧表示に合わせる)
CREATE INDEX idx_litigation_cases_comp_updated
  ON litigation_cases (comp_id, updated_at);
