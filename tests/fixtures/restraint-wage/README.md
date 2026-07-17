# restraint-wage 共有 fixture (Refs #268)

「最低賃金チェック」「給与比較」の両タブが**同一の入力データ**から計算することを
テスト構造で保証するための共有 fixture。org 方針は `local-first-testing` skill、
本 repo での計画は `docs/plan-268-wage-tab-separation.md`。

| ファイル | 中身 | 消費者 |
|---|---|---|
| `summaries.json` | 拘束サマリ 4 乗務員 (2026-07 平日20日): 9901 正常 / 9902 時給が最低賃金割れ / 9903 月60h超の残業代割れ / 9904 単価未設定 | golden テスト、給与比較テスト、`npm run seed:local` |
| `wage-master.json` | 単価マスタ (9904 は意図的に未登録) | 同上 |
| `min-wage-master.json` | 最低賃金マスタ (全社共通 956 円 — #267 以降の UI と同じ全社共通 1 本履歴の形) | 同上 |
| `salary-2026-07.csv` | 給与明細 CSV (同 4 乗務員 + 給与のみの 9999)。dev では給与比較タブの「デモ明細を読み込み」でワンクリック取込。9901 は golden の理論値どおり支払済み (基礎単価(実績) 221,200÷158h=1,400 円 = 単価マスタと一致、残業手当 39,200 = 37条理論値どおり) / 9902 は基礎単価(実績) 900 円 < 最低賃金 / 9903 は残業代が基礎単価・最低賃金の両理論値割れ / 9904 は【 補助 】単価なし。通勤手当 (excluded)・住宅手当 (minwage-only) 列は 5 区分の推定・集計の検証用 (Refs #278) | `tests/utils/salary-compare-fixture.test.ts` |
| `golden/wage-rows.json` | `computeWageRow` の出力 golden — **手で編集しない** | `workers/dtako-scraper-relay/test/restraint-wage-golden.test.ts`、給与比較テスト (wage-report 側の入力として) |

## golden の再生成 (意図したロジック変更のとき)

```sh
cd workers/dtako-scraper-relay
UPDATE_GOLDEN=1 npx vitest run test/restraint-wage-golden.test.ts
```

再生成した diff は PR で「何が・なぜ変わったか」を説明してレビューする。
テストを通すためだけの無説明上書きはしない。

## 入力を変えるとき

入力 fixture (summaries/wage-master/min-wage-master) は静的 JSON が正。
シナリオを追加したら README のシナリオ表と golden を同 PR で更新する。
元データの由来: `app/pages/restraint-wage.vue` の DEV PREVIEW ブロック
(PR-D で削除予定) のテストケースを移設したもの。
