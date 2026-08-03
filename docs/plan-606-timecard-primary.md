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

## 設計 (決定 1〜4)

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
4. **検証 (突合) タブを `archive` タブに置く。** 「theearth vs 打刻」の突合は現状どの
   タブにも無い (既存の `timecard-compare` は「打刻 vs 社内の紙タイムカード」で別物)。
   **突合の相手は live-build の値であって、押された写しではない。**

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
| E | (B マージ後に起票) | 検証 (突合) タブ = archive タブ拡張 |
