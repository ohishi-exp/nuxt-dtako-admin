-- 夜勤者マスタ (Refs #433 PR-A)。
--
-- タイムカードの「日跨ぎ打刻」を打刻エラーとして検出するための除外リスト。
-- 事務職の打刻が翌日にまたがっていたら通常は打刻漏れ (終業を押し忘れて翌日の
-- 打刻と組まれる) だが、**夜勤者は正常に日をまたぐ**。実データ (2026-04〜06) では
-- 1706 / 1707 が 19:45→翌 00:02 を月 15 回前後打っており、これを毎回エラーに
-- してしまうと機能が使い物にならない。
--
-- 判定の全体像 (PR-B):
--   エラー = 事務職 かつ 夜勤者でない かつ session が日跨ぎ
-- 拘束時間の長さは判定に使わない — 夜勤 (4.3h) と打刻漏れ (35.6h) は
-- この 3 条件だけで完全に分かれることを実データで確認している。
--
-- 突合キーは `driver_cd` (= 乗務員CD = 一番星 社員C = CakePHP drivers.id、
-- Refs #403)。給与コード×会社ではない — 勤務実績側は人単位で引くため
-- (holiday_work_approvals と同じ理由)。
--
-- **行を消さずに履歴で on/off する**: 夜勤担当が替わった時に行を削除すると
-- 「いつまで夜勤だったか」が失われ、過去月を再取り込みすると当時は正常だった
-- 打刻が一斉にエラーになる。`is_night` を 0 にした行を後ろに足すことで、
-- 過去月の再計算が当時の姿を再現する (employee_attrs の適用開始日つき履歴と
-- 同じ考え方)。月の帰属も他のマスタと揃えて「対象月の末日時点で効いている行」。
--
-- NULL を含む列は PK に入れていない — SQLite (D1) の PK は NULL 同士を「異なる値」
-- として扱うため、NULL を PK に含めると `ON CONFLICT DO UPDATE` が一致せず同じ行が
-- 二重に入る (migration 0011 の注記)。
CREATE TABLE IF NOT EXISTS night_shift_workers (
  -- dtako テナント (テナント跨ぎで見せない、Refs #367)
  comp_id TEXT NOT NULL,
  driver_cd TEXT NOT NULL,
  -- 適用開始日 (YYYY-MM-DD)
  effective_from TEXT NOT NULL,
  -- 1 = この日から夜勤者 / 0 = この日から夜勤者でない (解除)
  is_night INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (comp_id, driver_cd, effective_from)
);
