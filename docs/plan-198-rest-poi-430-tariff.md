# 実装計画: トラック休憩ポイントマップ + 430拘束チェック + 2マン運行費用見積もり

Refs #198

issue #198 の決定事項 (POI = Overpass + P35 → R2 配信 / 430 = OSRM polyline +
70km/h スライス / 運賃 = 告示 209 号の自作ロジック + 全ト協検算) を前提に、
PR 単位のフェーズに分割する。

## フェーズ分割

### Phase 0 — POI 収集パイプライン PoC (この PR)

- `scripts/poi/` に Overpass + P35 → 正規化 GeoJSON の月次バッチを実装
- 九州圏で実データ検証済み: OSM 296 + P35 141 → 統合後 318 件
  (道の駅 155 / PA 82 / SA 79 / 大型可駐車場 2)
- 詳細は [`scripts/poi/README.md`](../scripts/poi/README.md)

### Phase 1 — R2 配信 + マップ表示 UI

- 生成 GeoJSON を `dtako-uploads` R2 の `poi/<region>.geojson` に配置
  (既存 `DTAKO_R2` binding を read-only のまま流用。Y時間テンプレと同じ
  「CI/手元で put、Worker は配信のみ」の運用)
- `server/api/poi/[region].get.ts` — R2 から GeoJSON を配信 (Cache-Control 付き)
- `app/pages/rest-map.vue` — Google Maps に POI レイヤ表示
  (`dvr-map.vue` / `map-key.get.ts` の既存パターンを流用)。kind 別アイコン +
  属性パネル (24h・シャワー・GS 等) + `metadata.attribution` の帰属表示
- 月次更新は当面手動 (`npm run poi:build` → `wrangler r2 object put`)。
  自動化 (GitHub Actions cron) は運用が回り始めてから

### Phase 2 — OSRM ルーティング統合 + 430 判定

- OSRM を Cloud Run にホスト (`osrm/osrm-backend` コンテナ + 日本 pbf を
  焼いた packaging-only イメージ。rust-flickr / release-wave-gcp と同じ
  Cloud Run 運用規約)。プロファイルはまず標準 car (大型車制約は後続)
- 判定ロジック (front または Worker、pure TS):
  1. OSRM `/route` で polyline + 距離を取得
  2. 70km/h 想定で累積走行時間にスライス
  3. 連続運転 3.5〜4.0h のウィンドウ内で、ルート polyline から半径
     ~3km の休憩候補 POI を空間検索 (in-memory R-tree、`flatbush` 等)
  4. 休憩挿入後にリセットして繰り返し → 全区間クリアで OK 判定
- 分割休憩 (10 分+20 分等) をパターンとして表現できる判定 API 設計にする
- テスト: 判定ロジックは fixture ルートで unit test 100%

### Phase 3 — 全ト協 運賃計算システムの解剖 (要ユーザー協力)

- cdp-relay で手元 Chrome から https://jta.or.jp/member/kaisei_jigyoho/system.html
  の XHR を観察 (会員ログインが必要なため CCoW 単独では不可)
- 利用規約の確認 (検算用途の自動アクセス可否) も同時に行う ★未解決事項
- 成果物: エンドポイント仕様メモ (`docs/jta-tariff-api.md`) + 検算 Worker の設計

### Phase 4 — 標準的運賃テーブルのデータ化 + 計算ロジック

- 令和 6 年 3 月告示 (国交省告示 209 号) の運賃表を構造化データ化
  (距離制 / 時間制 × 運輸局 × 車種、交替運転者配置料金、荷待ち・荷役対価、
  燃料サーチャージ 5 円刻みテーブル)
- **置き場所の提案** (★issue 未解決事項への回答):
  まず本 repo 内の pure TS module (`app/utils/tariff/` + 静的 JSON テーブル)
  で実装する。UI と同じ repo でイテレーションが速く、Worker 完結で
  デプロイも増えない。rust-alc-api 側で必要になった時点で
  「rule of two」に従い crate 化 / lib 抽出を提案する
- テーブルは告示 PDF からの手写しになるため、Phase 5 の全ト協検算で
  ゴールデンテストを組んでから本番に出す

### Phase 5 — 検算 Worker + ゴールデンテスト CI

- 全ト協システムを叩く検算 Worker (本番機能には組み込まない)
- 代表ケース (運輸局 × 車種 × 距離帯のマトリクス) で自作ロジックと突合、
  CI の手動 workflow_dispatch で回す (毎 PR では叩かない — 先方負荷と
  規約への配慮)

### Phase 6 — 見積もり UI

- 車種・運輸局・ルート (Phase 2 の OSRM 結果) → 概算費用
- 2 マン運行の交替運転者配置料金を含む内訳表示

## 未解決事項の扱い

| issue の未解決事項 | 本計画での扱い |
|---|---|
| 全ト協の利用規約確認 | Phase 3 でユーザーと確認 (自動アクセスは検算のみ・低頻度) |
| ODbL 帰属表示 | GeoJSON の `metadata.attribution` に埋め込み済み。Phase 1 の UI がそれを表示 (実装規約化) |
| 運賃ロジックの置き場所 | 本 repo の pure TS + 静的 JSON を提案 (Phase 4 参照)。rust 化は rule of two まで保留 |
| OSRM ホスティング | Cloud Run + packaging-only イメージ (Phase 2)。大型車プロファイルは標準 car で MVP → 後続改善 |

## この PR に含まれないこと

Phase 1 以降は全て別 PR。本 PR は Phase 0 (パイプライン + テスト) と
本計画ドキュメントのみ。
