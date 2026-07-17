# 拘束×賃金: 最低賃金チェック/給与比較の責務分離 + ローカルテスト基盤 — 計画 (Refs #268)

対象: `app/pages/restraint-wage.vue` の「最低賃金チェック」「給与比較」タブ、
`workers/dtako-scraper-relay/src/restraint-wage.ts` (計算ロジック)、
`app/utils/salary-compare.ts` (給与明細 CSV 解析)。

## 決定事項 (2026-07-17 合意)

### 1. タブの責務分離 — 単価マスタを使うのは最低賃金チェックだけ

| タブ | 入力 | 比較対象 | 用途 |
|---|---|---|---|
| **最低賃金チェック** | 単価マスタ (乗務員別時給) × デジタコ拘束時間 | 最低賃金マスタ | レート設定の**事前チェック** (基本給・残業代の理論値が最低賃金を下回らないか) |
| **給与比較** | 給与明細 CSV の実支給額 (単価・基本給は明細側の値) | 最低賃金理論値 | 実際の支払い実績の検証。**単価マスタは参照しない** |

- 計算ロジック (`computeWageRow` / `computeMinWageOvertimePay` / `computeWageAmounts`) は
  **変更しない**。呼び出し側で入力ソース (単価マスタ vs 給与明細) を分けるだけ。
  テストが計算ロジックの検証を兼ねる。
- テストデータは両タブで**同一の fixture** を使う。同じ入力 (拘束サマリ + 給与明細 CSV +
  マスタ類) から 2 つのタブがそれぞれの観点で計算することを、テスト構造自体で保証する。

### 2. worktree `restraint-wage-min-overtime` の未コミット分の取捨

| 変更 | 判定 |
|---|---|
| `computeMinWageOvertimePay` の時間外軸/深夜軸の独立加算修正 | **活かす** |
| 残業の「残業 (時間外+週40超過)」「深夜残業」2列分離 | **活かす** |
| 最低賃金チェックの「実績」→「単価マスタ換算」ラベル修正・注記 | **活かす** |
| 最低賃金チェックの「基本給(法定内)」「深夜(通常)」列追加 | **活かす** |
| **給与比較タブの基本給/残業代を CSV【補助】単価基準→単価マスタ基準に統一** | **破棄** — 本計画の責務分離と逆方向。給与比較は明細基準に戻す |
| 給与比較タブの「残業(最低賃金)」列追加 | **活かす** (明細実績 vs 最低賃金理論値の直接比較は責務に合致) |
| ページ内 DEV PREVIEW ブロック (mock データ生成) | **fixture へ移設して削除** (下記) |

#268 記載の未対応問題 (`sysTotal` の深夜(通常)漏れ、単価マスタ/最低賃金マスタの
UI 関係整理) も本計画の PR 系列で対応する。

### 3. ローカルテスト基盤 — 3層構成

org 共通方針 (ippoan/claude-md#102) の本 repo での実装。

**Layer 1 — 共有 fixture + golden テスト (vitest)**

- `tests/fixtures/restraint-wage/` に**入力だけ**を静的ファイルで置く:
  拘束サマリ JSON / 単価マスタ JSON / 最低賃金マスタ JSON / 給与明細 CSV。
  DEV PREVIEW 内のテストケース (正常・時給が最低賃金割れ・月60h超残業代割れ 等) を移設。
- 期待値は手計算せず、**本物の計算関数を通した出力を golden JSON としてコミット**
  (既存 `tests/utils/tariff-golden.test.ts` と同パターン)。ロジック変更は golden の
  diff として PR に現れる。
- 最低賃金チェック側テストと給与比較側テスト (`salary-compare` は現状テスト未整備) が
  同一 fixture を import する。

**Layer 2 — ローカル mock 環境 (wrangler dev local + seed)**

- `wrangler dev` ローカルモードは R2/DO を `.wrangler/state` に永続化する
  (miniflare の sqlite バックエンド)。本番と同じ R2 JSON 形状のまま使うので、
  独自 mock DB スキーマ・変換層は作らない。
- `npm run seed:local` (scripts/) が Layer 1 と同一の fixture をローカル R2 に PUT する。
  Nuxt dev をローカル worker に向けてブラウザで目視確認。

**Layer 3 — フロー**

fixture 変更 → vitest (unit/golden) green → seed してローカル目視 → PR。
CI は既存 vitest がそのまま golden を検証する。

## PR 分割案

1. **PR-A (このPR)**: 本計画文書
2. **PR-B**: Layer 1 — fixture 移設 + golden テスト (最低賃金チェック側)。
   worktree の「活かす」分の計算修正もここで commit に載せる
3. **PR-C**: 給与比較の責務分離 (明細基準へ戻す + 単価マスタ非参照化) +
   同一 fixture での給与比較側テスト + `sysTotal` 深夜漏れ修正
4. **PR-D**: Layer 2 — seed スクリプト + launch.json + DEV PREVIEW ブロック削除
5. **PR-E**: 単価マスタ/最低賃金マスタの UI 関係整理 (#268 問題2)

## 参考

- #268 (本 issue) / #267 (最低賃金マスタの単価マスタタブ統合) / #244-246 (賃金計算系譜)
- org 方針: ippoan/claude-md#102
