# POI 収集パイプライン (トラック休憩ポイント)

Refs [#198](https://github.com/ohishi-exp/nuxt-dtako-admin/issues/198)

道の駅 / SA・PA / 大型可駐車場を OpenStreetMap (Overpass API) と
国土数値情報 道の駅データ (P35) から収集し、正規化 GeoJSON を生成する月次バッチ。
生成物は R2 (`dtako-uploads` の `poi/` prefix) に配置して front に配信する
(PostGIS は使わない。設計方針は issue #198)。

## 使い方

```sh
# 1. P35 (道の駅) データを取得 (zip に GeoJSON が同梱されている)
curl -sSLO https://nlftp.mlit.go.jp/ksj/gml/data/P35/P35-18/P35-18_GML.zip
unzip P35-18_GML.zip

# 2. パイプライン実行 (Overpass は公開ミラーをラウンドロビンして自動リトライ)
npm run poi:build -- --region kyushu \
  --p35 P35-18_GML/P35-18_Roadside_Station.geojson \
  --out poi-kyushu.geojson

# Overpass 応答をキャッシュして再実行する場合
node scripts/poi/build-poi.ts --region kyushu --overpass-json cached.json ...

# 3. R2 へ配置
npx wrangler r2 object put dtako-uploads/poi/kyushu.geojson --file=poi-kyushu.geojson --remote
```

## データソースと帰属表示

| ソース | 内容 | ライセンス |
|---|---|---|
| Overpass API (OSM) | SA / PA / 休憩所 / 大型可駐車場 (`highway=rest_area\|services`, `amenity=parking`+`hgv`) | ODbL — UI に **© OpenStreetMap contributors** の帰属表示必須 |
| 国土数値情報 P35 | 道の駅 (名称・所在地・設備 18 種) | 国土数値情報ダウンロードサービス利用約款 — 出典明示 |

帰属文字列は出力 GeoJSON の `metadata.attribution` に入っているので、
マップ UI はこれをそのまま表示すること。

## 正規化スキーマ

`types.ts` の `PoiFeature` を参照。`kind` は
`michi_no_eki` / `sa` / `pa` / `truck_parking` の 4 値。
設備フラグ (`open24h` / `shower` / `fuel` / …) は **不明を null** で表現する
(false = 「無いことが確認済み」と区別する)。

## 実装メモ (九州圏 PoC の実測)

- 日本の OSM は PA も 道の駅 も `highway=services` でタグ付けされていることが
  多い (九州圏: services 200 件中に「鞍手PA」等が多数)。タグだけでは
  SA/PA/道の駅 を区別できないため **名称ベースで分類** し、判定不能時のみ
  タグにフォールバックする (`normalize.ts` の `osmKind`)。
- 同一施設の重複 (OSM node/way 二重登録、P35×OSM) は `dedupe.ts` で統合。
  P35 を代表レコードとし、OSM 側の属性で null を埋める。
  `truck_parking` は道の駅隣接の別駐車場でありうるため名前一致時のみ統合。
- 公開 Overpass インスタンスは混雑しやすい (2026-07-10 実測: 本家 busy /
  kumi ミラー timeout あり)。`overpass.ts` はエンドポイントをラウンドロビン
  して最大 9 回リトライする。
- 九州圏実測: OSM 296 + P35 141 → 統合後 318 件
  (道の駅 155 / PA 82 / SA 79 / 大型可駐車場 2)。
  P35 141 件のうち 108 件が OSM とマージ、33 件は P35 のみ。
  OSM のみの道の駅 14 件は P35-18 (2019-01-01 基準) 以降の新設駅を含む。

## 既知の限界 (follow-up 候補)

- P35-18 は 2019 年基準日。以降の新設道の駅は OSM 側にしか出ない
  (より新しい年度版が公開されたら URL を差し替える)。
- トラックステーションは OSM に安定したタグが無く未収集。
- `hgvCapacity` (大型マス台数) は九州圏の OSM にデータが無く全件 null。
  NEXCO 公開データ等での補完は後続 issue で検討。
