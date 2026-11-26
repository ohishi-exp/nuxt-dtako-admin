-- ETC カード行の「登録日」(Refs #1287)。
--
-- relay (workers/dtako-scraper-relay) が走行日 (run_date) を探すときの下限に使う。
-- この日より前の走行は、そのカードの利用日にしない (カードを受け取る前の走行 = 古いカードで
-- 走った分を、新しいカードの利用日として etc-meisai.jp に登録しないため)。
-- YYYY-MM-DD (JST の日付) or NULL。NULL のときの下限は、その行の scan の
-- etc_card_scans.received_at (UTC の ISO8601) を JST の日付にしたもの (発行明細書に発行日が
-- 書かれていないので、受けた日で代える)。既存の行は NULL のまま。
-- 画面 (`PATCH /api/etc-cards/[id]/registration-date`) が書く。
ALTER TABLE etc_card_registrations ADD COLUMN registration_date TEXT;
