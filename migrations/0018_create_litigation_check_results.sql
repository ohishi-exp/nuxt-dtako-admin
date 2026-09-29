-- 訴訟用の準備ページ「エラー」タブの検知結果の保存 (Refs #1133)。
--
-- 検知 (alc の運行 / 勤怠に無い運行 / 最低賃金の不変条件) は 1 案件で 10〜40 分かかる
-- (最低賃金の不変条件が 1 か月 15〜64 秒) のに、結果が画面のメモリにしか無く、
-- 開き直すたびにやり直しになっていた。取れた結果を案件ごとに残し、開いたら前回の
-- 結果を出す・取れていないものだけ続きから回せるようにする。
--
-- 1 行 = 案件 × 検知の種類 × 乗務員 × 月。payload は画面が読む形そのままの JSON 文字列
-- (中身の検証は画面側が防御的に読む — relay は大きさと鍵の形だけを見る)。
-- 案件の削除時は relay が同じ comp_id/case_id の行も消す (D1 は FK の CASCADE を使わない)。

CREATE TABLE litigation_check_results (
  comp_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- 'alcOps' | 'unkoGaps' | 'wageReport'
  item_key TEXT NOT NULL,         -- '乗務員CD|YYYY-MM'
  payload TEXT NOT NULL,          -- JSON 文字列
  checked_at TEXT NOT NULL,       -- ISO 8601 (relay が書いた時刻)
  PRIMARY KEY (comp_id, case_id, kind, item_key)
);
