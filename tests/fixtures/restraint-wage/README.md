# restraint-wage 共有 fixture (Refs #268)

「最低賃金チェック」「給与比較」の両タブが**同一の入力データ**から計算することを
テスト構造で保証するための共有 fixture。org 方針は `local-first-testing` skill、
本 repo での計画は `docs/plan-268-wage-tab-separation.md`。

| ファイル | 中身 | 消費者 |
|---|---|---|
| `summaries.json` | 拘束サマリ 4 乗務員 (2026-07 平日20日): 9901 正常 / 9902 時給が最低賃金割れ / 9903 月60h超の残業代割れ / 9904 単価未設定 | golden テスト、(予定) 給与比較テスト、seed:local |
| `wage-master.json` | 単価マスタ (9904 は意図的に未登録) | 同上 |
| `min-wage-master.json` | 最低賃金マスタ (佐賀 956 円、全社共通) | 同上 |
| `golden/wage-rows.json` | `computeWageRow` の出力 golden — **手で編集しない** | `workers/dtako-scraper-relay/test/restraint-wage-golden.test.ts` |

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
