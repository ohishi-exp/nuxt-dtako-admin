# 実装計画: トラック休憩ポイントマップ + 430拘束チェック + 2マン運行費用見積もり

Refs #198

issue #198 の決定事項 (POI = Overpass + P35 → R2 配信 / 430 = OSRM polyline +
70km/h スライス / 運賃 = 告示 209 号の自作ロジック + 全ト協検算) を前提に、
PR 単位のフェーズに分割する。

## 最終ゴール: 実運賃 × 標準的運賃 × 実運行の突合比較

見積もり (これから走るルートの概算) に加えて、**すでに走った運行の検証**が
最終ゴール (2026-07-10 ユーザー指示):

1. **一番星から実運賃を取得** — `ohishi-exp/rust-ichibanboshi` (CAPE#01
   SQL Server の売上データ REST API)。金額は月計テーブル一致ルール
   (自車: `税抜金額 + 税抜割増 + 税抜実費 - 値引`、傭車:
   `税抜傭車金額 + …`、自車/傭車判定は `傭車先C = '000000'`) に従う
2. **標準的運賃 (告示 209 号) を計算** — Phase 4 の自作ロジック。
   「平均的な運賃」との比較軸はこれ (国交省の標準的運賃)
3. **直近の運行 (dtako) から距離等を取得** — rust-alc-api の運行データ
   (走行距離・拘束/運転時間) を標準的運賃の距離制/時間制の入力にする
4. **突合** — 運行 ⇔ 一番星伝票を紐付け、運行ごと (および月次集計) に
   実運賃と標準的運賃の乖離を可視化する

この比較トラックは **OSRM / POI / 430 判定に依存しない** (距離・時間は
実運行の dtako 実績を使う)。したがって最短の critical path は
Phase 4 (運賃テーブル) → Phase 7 (一番星統合) → Phase 8 (突合比較) で、
POI マップ / 430 / 見積もり UI は並行トラックとして進められる。

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

### Phase 7 — 一番星 実運賃取得統合

- `server/api/ichiban/` server route → `rust-ichiban.mtamaramu.com`
  (Cloudflare Tunnel) を CF Access Service Token 付きで叩く
  (`ohishi-exp/nuxt-ichibanboshi` の `/api/sales/*` と同じパターン。
  Service Token は Secrets Store binding で投入、`wrangler secret put` 不使用)
- 取得単位: 期間 × 車番 (または担当者) の売上明細。金額集計は
  rust-ichibanboshi の月計一致ルールに厳密に従う (`金額` カラムは使わない)
- rust-ichibanboshi 側に不足 API があれば先にそちらへ issue を立てて追加

### Phase 8 — dtako 実運行との突合 + 比較ダッシュボード

- 紐付け: dtako 運行 (`unko_no` / 車番 / 運行日) ⇔ 一番星伝票。
  **キーは 車番 + 運行日 + 積地・卸地** (2026-07-10 ユーザー決定。
  同日複数伝票は運行に集約する)。積地・卸地は両システムで地名の表記が
  揃っている保証がないため、NFKC 正規化 + マスタ (地名 → 正規名) の
  突合テーブルを想定し、Phase 8 の最初に実データでマッチ率を検証する。
  精度が足りなければ手動紐付け補助 UI を検討
- 運行ごとに「実運賃 (一番星) / 標準的運賃 (Phase 4、入力は dtako 実績の
  距離・時間) / 乖離率」を算出し、一覧 + 月次集計で可視化
- 分析の観点: 乖離の大きい荷主・路線の抽出 (標準的運賃を下回る運行の検出)
- 置き場所は本 repo (`app/pages/` に比較画面) — dtako 運行データと同じ
  画面系に同居 (2026-07-10 ユーザー決定)

## 未解決事項の扱い

| issue の未解決事項 | 本計画での扱い |
|---|---|
| 全ト協の利用規約確認 | Phase 3 でユーザーと確認 (自動アクセスは検算のみ・低頻度) |
| ODbL 帰属表示 | GeoJSON の `metadata.attribution` に埋め込み済み。Phase 1 の UI がそれを表示 (実装規約化) |
| 運賃ロジックの置き場所 | 本 repo の pure TS + 静的 JSON を提案 (Phase 4 参照)。rust 化は rule of two まで保留 |
| OSRM ホスティング | Cloud Run + packaging-only イメージ (Phase 2)。大型車プロファイルは標準 car で MVP → 後続改善 |
| 運行 ⇔ 一番星伝票の紐付けキー | **決定: 車番 + 運行日 + 積地・卸地** (2026-07-10)。地名表記揺れの正規化を含め Phase 8 冒頭で実データのマッチ率を検証 |
| 比較画面の置き場所 | **決定: 本 repo** (dtako 運行データと同居、2026-07-10) |
| 「平均的な運賃」の定義 | **決定: 国交省の標準的運賃 (告示 209 号)** (2026-07-10) |

## 進捗

- Phase 0 (POI パイプライン PoC): **完了** — PR #218 (2026-07-10 merge)
- Phase 1 以降: 未着手。各フェーズ 1 PR 以上に分割する
