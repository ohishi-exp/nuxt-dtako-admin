# 拘束×賃金: 拘束時間の正を打刻基準 (timecard) にする — 計画 (Refs #606)

## 背景と、調査で判明した訂正 4 点

1. **「正を打刻基準にする」は大部分すでに実装済み。** `mergeSummarySources`
   (`workers/dtako-scraper-relay/src/timecard-summary.ts:945`、2026-07-28 決定) が
   乗務員CD 単位で timecard を優先する。画面に source フィルタが無いのは
   「theearth のまま」ではなく**サーバ側で解決済み**だから。さらに
   `buildKintaiSummariesLive` が wage-report のたびにその場で打刻+kosoku-daily から
   組み直す (2026-07-28「R2 やめろ」決定)。source をクエリで指定する経路は存在せず、
   選択は **live-build 優先 → 乗務員単位の勝敗** の 2 段階でサーバ側完結。
2. **ichiban に押された timecard 写しは化石。** push は全月 `2026-07-27T02:1x`、
   kosoku-daily 統一の決定は `2026-07-28` (1 日後)。しかも**無人の再 push 経路が無い**
   (cron にも MCP にも `/restraint-api/kintai/fetch` を叩く口が無く、人が画面の
   取り込みボタンを押した時だけ写る)。⇒ 永久に 07-28 以前のロジックのまま。
   現行経路での実測 (2026-08-03):

   | 例 | 化石 (push 07-27) | 現行 live (kosoku-daily) | theearth | 現行の差 |
   |---|---|---|---|---|
   | 1069 / 2026-02 | 29,580分 (493.0h)、9日1セッション | 10,709分 (178.5h)、24h超 0 件 | 9,170分 | +1,539分 |
   | 1107 / 2026-01 | 16,426分 | 16,417分 | 14,620分 | +1,797分 |
   | 1672 / 2026-03 | 0分 (days 空) | 20,311分 (32日) | 20,372分 | −61分 |

   ⇒ 「複数日1セッション」「月まるごと欠落」は**化石側の症状で現行では解消済み**。
   現行に残るのは月あたり **+1,500〜1,800分の系統差**で、これは
   `app/utils/kosoku-daily.ts:12-14` が実測付きで記録している**設計どおりの差**
   (打刻で測ると拘束が増える)。
3. **theearth は「検証用」ではなく供給源でもある。** `drivingMinutes` (運転) /
   `loadingMinutes` (荷役) / `fiscalCumulativeMinutes` (年度累計) /
   `restraintLimitMinutes` (拘束上限) / `excessRestraintMinutes` (当月超過) /
   `avgDriving9hOverCount` の **6 指標は timecard 側で構造的に 100% null/0**。
   今 空欄でないのは `fillTheearthOnlyMetrics` が theearth から埋め戻しているから。
   運転・荷役は「打刻」が原理的に持てない情報で、出せるのはデジタコ運行データ (三源目) だけ。
4. **カバレッジ差は事業所で分かれる。** theearth のみ 40名 / timecard のみ 24名 が
   6 ヶ月固定。theearth のみ = 本社以外の営業所の専業ドライバー、timecard のみ = 本社系。
   原因は**不明** (D1 のスコープ設定が疑わしいが確定できず)。

## 設計 (決定 1〜5)

1. **表示は live-build 一本化し、化石を読む経路を塞ぐ。** `loadWageReportSource` が
   ichiban の `current_timecard`/`prev_timecard` を読むフォールバックを外す。
   live-build 失敗時は timecard 行を**出さない** (古い値を静かに出すより欠ける方が安全)。
   theearth 側のフォールバックは現状維持。push 自体は突合用に残すが
   「押された写しは表示に使わないスナップショット」とコード上明示する。
2. **無人同期を足す。** kyuyo-mcp に `run_restraint_kintai_sync { company, month }` を
   追加し、cron でも前月+当月を定期同期する。化石を生んだ原因がこれの不在。
3. **theearth-only 6 指標は「theearth 由来」と明示して残す。三源目は今回作らない**
   (デジタコ運行からの算出は rust-alc-api 側の新規実装が要るので別 issue)。
   ⇒ これが「**CSV 読み取りは検証用に残す**」の技術的な意味づけ:
   theearth は **検証用 かつ 6 指標の唯一の供給源**。
4. **社内 nginx の紙タイムカードとの照合を専用タブにして見える化する。** 照合そのものは
   既に実装済み — `GET /restraint-api/timecard-compare` (Refs #492 PR-B)。**relay 側は
   月 × 全乗務員に既に対応している** (`driver` は省略可、`tolerance` / `only_anomalies`
   パラメータあり、乗務員別サマリ型もある。
   `workers/dtako-scraper-relay/src/timecard-compare.ts:978-1010` 付近)。**ところが画面は
   「乗務員CD で 1 人に絞れている時だけ」に制限している** (`app/pages/restraint-wage.vue:849-851`
   の `compareDriverCd`)。しかも `timecard` タブの中に埋まっていて、**月全体で「誰のどこが
   変か」を見る手段が無い**。比較対象は**拘束時間だけ** (残業は定義が別物なので比較しない)。
   判定は relay 側で済ませてあり、画面は表示だけ — この方針は維持する。
   - **専用タブを新設**し、月 × 全乗務員の一覧 (差の大きい順 / `only_anomalies` で異常のみ)
     を出す。1 人の日別へはそこからドリルダウンする
   - **front のみで完結する** — relay 側は既に対応済みなので API 追加は不要
   - 現在 `timecard` タブにある 1 vs 1 の突合 UI は、新タブへ移すか残すかを実装時に判断する
5. **theearth vs 打刻の突合を `archive` タブに置く (決定 4 より後、優先度は下)。**
   「theearth vs 打刻」の突合は現状どのタブにも無い (既存の `timecard-compare` は
   「打刻 vs 社内の紙タイムカード」で別物)。**突合の相手は live-build の値であって、
   押された写しではない。** 紙タイムカードとの照合 (決定4) の方が、実際の運用で先に
   見たい差である (ユーザー判断 2026-08-03)。

## 非スコープ (別 issue)

6 指標のデジタコ運行 (三源目) 化 / カバレッジ差の原因究明 / D1 写しの読み取り切替 /
timecard 版 resummarize / `ichiban_months` バッジが timecard を見ていない件。

## PR 分割表

| PR | 分岐 | 内容 |
|---|---|---|
| A | #606-4 | 本計画文書 (このPR) |
| B | #606-5 | 表示の live-build 一本化 + 化石フォールバック除去 |
| C | #606-6 | 無人同期 (kyuyo-mcp tool + cron) |
| D | #606-7 | theearth 由来 6 指標の明示 |
| E | #606-8 | 紙タイムカード照合タブ (新設、front のみ) |
| F | (後日) | theearth vs 打刻の突合 = archive タブ拡張 |
