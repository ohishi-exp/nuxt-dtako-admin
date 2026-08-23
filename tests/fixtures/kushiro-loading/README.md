# kushiro-loading 共有 fixture (Refs #760 の 33)

釧路営業所 (暫定) 試算の中核 util (`app/utils/kushiro-loading-legs.ts`) の入力。
**後続 PR で kyuyo-mcp 側の双子実装が同じ fixture を読んで bit 一致を検証する**ため、
入力は静的 JSON が正 (`tests/fixtures/restraint-wage/` と同じ流儀)。

| ファイル | 中身 | 消費者 |
|---|---|---|
| `operations-2026-07.json` | 運行 91 本 / 便 284 本。`app/utils/margin.ts` の `OperationMargin` / `LegMargin` の部分型 + 積地・卸地の GPS 2 点 (`KushiroOperationInput`) | `tests/utils/kushiro-loading-legs.test.ts`、kyuyo-mcp の双子実装 (予定) |
| `deadhead-idle-2026-07.json` | 同じ 91 運行の `preLoadKm`/`postUnloadKm`/`preLoadSec`/`postUnloadSec` (`allowance-idle.ts` の `OperationIdle` の部分型)。**回送の平均速度を実測から出す**ための入力 | 同上 |
| `measured-2026-07.json` | **オーナーが本番 2026-07 で実測した集計** (2026-08-23 報告)。回帰の的。手で書いた唯一のファイル | 同上 |
| `golden/summary-2026-07.json` | `summarizeKushiroLoading` + `depotShiftDiff` + `deadheadSpeedKmh` の出力 golden — **手で編集しない** | 同上 |

## この fixture の性格 (必ず読むこと)

**便・運行の中身は合成**で、本番 DB の写しではない (この作業では本番に触れない)。
そのかわり **`measured-2026-07.json` の実測集計にぴったり戻るよう組んである** —
運行 91 / 便 284 / 釧路積み便 169 / pure 38 / mixed 34 / 売上 ¥10,260,265 /
手当 ¥2,499,500 / 売上走行 29,081.3km / 回送 28,748.1km、および釧路積みだけの
38 運行の km 内訳 (`preLoadKm` 4,938.5 / `haulKm` 10,950.6 / `betweenKm` 7,421.5 /
`postUnloadKm` 1,038.3 / `otherKm` 1,055.1)。乗務員別の釧路積み便数
(中村 71 / 柳井 36 / 増地 23 / 佐竹 21 / 西島 18) も実測どおり。

**座標と住所は実在のもの** — 積地は釧路西港の 3 社 (中部飼料 / 釧路飼料 / 道東飼料)、
卸地は十勝の実在地 (上士幌・士幌・帯広川西・音更・幕別・豊頃・浦幌)、非釧路の積地は
士幌・広尾。だから**回送距離の推定と、推定 ÷ 実測 の比 (較正) は地理的に本物**で、
「営業所を釧路へ移すと出庫が消えて帰庫が同じだけ増える」という入れ替えを、この
fixture で数字として確認できる。

**運行あたりの細部 (1 本 1 本の売上・便間距離) は合成の配分**なので、個別の運行を
「実際にこう走った」と読まないこと。テストが固定しているのは**集計値と入れ替えの構造**。

意図的に仕込んである欠測:

- 積地の GPS が取れない運行 1 本 / 卸地の GPS が取れない運行 1 本
  (**推定を 0km に倒さず「欠測」として数える**ことの検証)
- `preLoadSec` が読めない運行 2 本 / `postUnloadSec` が読めない運行 1 本
  (**km と秒を片側だけ足して速度を壊さない**ことの検証)

## golden の再生成 (意図したロジック変更のとき)

```sh
UPDATE_GOLDEN=1 npx vitest run tests/utils/kushiro-loading-legs.test.ts
```

再生成した diff は PR で「何が・なぜ変わったか」を説明してレビューする。
テストを通すためだけの無説明上書きはしない。

## 入力を変えるとき

`measured-2026-07.json` は**オーナーの実測**なので、実測をやり直したとき以外は動かさない。
`operations-2026-07.json` を触るなら、`measured-2026-07.json` に戻ることを
テスト (`共有 fixture が本番実測の集計に戻る`) で必ず確かめる — 集計器を通さない
裏取り (fixture から直接数える) も同じテストに入っている。
