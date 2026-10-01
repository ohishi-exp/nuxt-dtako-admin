-- 訴訟用の準備ページ (Refs #1133): 出力の版の保存 と 削除した案件の 30 日保管。
--
-- 出力タブは Excel を作って ZIP でダウンロードさせるだけで、どこにも残していなかった。
-- 元データ (デジタコの運行) は取り込み直しで後から変わるので、その時点で出力した
-- Excel そのものを、案件ごと・出力するたびに版として残す。ファイルの実体は R2、
-- ここはその索引。
--
-- あわせて、案件の削除を「削除した案件」の表への移動に変える。30 日のあいだは
-- 元の表へ戻せる (検知結果 0018 と出力の版は消さずに残すので、そのまま戻る)。
-- 30 日を過ぎたものは relay が 案件・検知結果・版・R2 のファイルを消す。
--
-- 0017 (litigation_cases) と 0018 (litigation_check_results) の列は変えない。
-- comp_id を PK 先頭に置くのは 0016〜0018 と同じ (テナント分離)。
--
-- ★ この D1 は 本番 / staging / preview で共用で、R2 の bucket も共用
-- (env を分けているのは R2 のキーの prefix だけ)。版の行に r2_prefix を持たせ、
-- 版とファイルの口は自 env の prefix の行だけを扱う。案件 (下の deleted を含む) は
-- 0017 と同じく env 共用。

-- 削除した案件。列は litigation_cases と同じ + 削除の日時と人。
CREATE TABLE litigation_deleted_cases (
  comp_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  name TEXT NOT NULL,
  from_month TEXT NOT NULL,
  to_month TEXT NOT NULL,
  driver_cds TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT NOT NULL,       -- ISO 8601 (relay が書いた時刻。30 日の起点)
  deleted_by TEXT,                -- viewer の email (無ければ NULL)
  PRIMARY KEY (comp_id, case_id)
);

-- 一覧は「削除の新しい順」、掃除は「30 日より前」を引く
CREATE INDEX idx_litigation_deleted_cases_comp_deleted
  ON litigation_deleted_cases (comp_id, deleted_at);

-- 出力の版。1 回の「ZIP を作る」= 1 行 (上書きしない)。
CREATE TABLE litigation_output_versions (
  comp_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version_id TEXT NOT NULL,       -- relay が採番 ('YYYYMMDDTHHMMSSZ-xxxxxx')
  r2_prefix TEXT NOT NULL,        -- 作った env の RESTRAINT_R2_PREFIX
  created_at TEXT NOT NULL,
  created_by TEXT,                -- viewer の email (無ければ NULL)
  results TEXT NOT NULL,          -- JSON 文字列 (画面が読む形そのまま。relay は解釈しない)
  PRIMARY KEY (comp_id, case_id, version_id)
);

-- 一覧は案件ごとに「作成の新しい順」
CREATE INDEX idx_litigation_output_versions_case_created
  ON litigation_output_versions (comp_id, case_id, created_at);

-- 版のファイル。1 ファイル 1 行 (版の行の JSON 列に持たない — 上げるたびに
-- 読んで書き戻す形だと、並行の上げで更新が失われるため)。
CREATE TABLE litigation_output_files (
  comp_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  storage_name TEXT NOT NULL,     -- 保存用の名前 (ASCII。R2 のキーの末尾)
  label TEXT NOT NULL,            -- 表示名 (日本語可)
  size INTEGER NOT NULL,          -- bytes
  sha256 TEXT NOT NULL,           -- hex
  r2_key TEXT NOT NULL,           -- 上げたときのキー (読み出し・掃除はこれを使う)
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (comp_id, case_id, version_id, storage_name)
);
