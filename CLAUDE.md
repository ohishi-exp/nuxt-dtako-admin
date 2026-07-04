# nuxt-dtako-admin

dtako (デジタコ運行データ) 管理画面。Nuxt 4 + Cloudflare Workers (Nitro `cloudflare_module`)。
backend は **rust-alc-api** (`https://rust-alc-api-...run.app`) を直接 fetch する形が基本だが、
Y時間 export 等 R2 binding が必要な機能は Worker 内 server route に持つ。

## デプロイ

| env | URL | wrangler env |
|---|---|---|
| 本番 | https://dtako.ippoan.org | (default) |
| staging | https://dtako-staging.ippoan.org | `staging` |

タグリリース (`/tag-release patch`) で CI 自動デプロイ。手動 `wrangler deploy` は禁止。

## 環境変数 (`wrangler.toml` `[vars]`)

| key | 用途 |
|---|---|
| `NUXT_PUBLIC_API_BASE` | rust-alc-api Cloud Run URL |
| `NUXT_PUBLIC_AUTH_WORKER_URL` | auth-worker URL (JWT 発行 / refresh) |

## R2 binding

- `DTAKO_R2` → `dtako-uploads` バケット — Y時間 テンプレ xlsx の配置先 (`templates/...`)。
  本番 / staging 共用 (read-only)。

## Y時間 エクスポート (`/y-time-export` ページ)

京都ソフト案件などの拘束時間管理 Excel テンプレに、KUDGIVT.csv 由来の日別始業/終業/休憩を
追記してダウンロードする機能。

### アーキテクチャ

```
[browser]
  │ POST /api/y-time-export
  ▼
[Worker server route /api/y-time-export]
  │ 1. backend (rust-alc-api) GET /api/dtako/y-time-export を auth-worker /alc-proxy
  │    経由で叩く (server/utils/alc-proxy.ts の alcProxyFetch、OIDC mint は auth-worker
  │    に委譲。Cloud Run IAM lockdown 対応、Refs rust-alc-api#434 step 3 方式 B)
  │    └ backend は parallel R2 fetch (buffer_unordered 16) で 5-15s で結果返却
  │ 2. R2 binding (DTAKO_R2) でテンプレ xlsx fetch
  │ 3. JSZip single-pass row-batch で Y時間 シート書き込み (PR #30 で 150x 高速化)
  └ xlsx blob 返却
       │
       ▼
[browser] download
```

### sync HTTP に戻した経緯 (2026-05-10)

一時期 backend の `POST /jobs` + WebSocket 完了通知 (notify-realtime-bus) で async job
化を試みた (PR #340 / #31) が、**Cloud Run の CPU throttling (default ON) により
`tokio::spawn` した background compute が完走せず**、frontend の WS が 120s timeout で
fail することが本番で発覚 → revert。

詳細: `~/rust/rust-alc-api/CLAUDE.md` の "長時間 compute と Cloud Run の罠" を参照。

5-15s の compute は Cloudflare proxy edge timeout (100s) 内に余裕で収まるので、async 化
せず sync HTTP で配信している。

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `app/pages/y-time-export.vue` | UI、`fetch('/api/y-time-export')` で server route 呼び出し |
| `server/api/y-time-export.post.ts` | backend GET → R2 テンプレ → JSZip xlsx 生成 |
| `app/utils/y-time-xlsx.ts` | JSZip single-pass writer (PR #30) |
| `app/utils/api.ts` | `getYTimePreview()` (preview ボタン用、sync GET) |

## NET780 ビューア (`/net780` ページ)

NET780 デジタコの運行単位生データ ZIP (.inf/.spd/.dsd/.gpd/.evd 同梱) を、アップロード
せずブラウザ内で直接パースして確認する機能。フォーマット解読・パースロジックは
`ohishi-exp/net780-wasm` の `core/` (Rust) が SoT。

### アーキテクチャ

```
[browser]
  ZIP ファイルをドラッグ&ドロップ (サーバー送信なし)
  │
  ▼
net780-wasm (ohishi-exp/net780-wasm、core/ + wasm/ の 1 repo workspace)
  │ core/ (net780 crate) が ZIP 展開 (Rust `zip` crate) + .inf/.spd/.dsd/.gpd/.evd パース
  │ wasm/ (net780-wasm crate) が wasm-bindgen でラップして公開
  ▼
{ header, inf, distance_total_m, speed[], gps[], events[], warnings[] }
  │
  ▼
[browser] サマリ / 暦日ごとの速度チャート (クリック/ドラッグでシーク) +
          GPS 軌跡 Google Map (シーク連動マーカー) / GPS 一覧テーブル /
          イベントテーブル 表示
```

- ロジックは Rust (`net780` crate、`ohishi-exp/net780-wasm` の `core/`) 1 箇所にだけ
  実装し、TypeScript 側での再実装 (二重管理) を避ける方針 (`ippoan/fc1200-wasm` と
  同じ考え方)。**旧 `ohishi-exp/dtako-scraper` の `crates/net780` は 2026-07-03 に
  完全移設済み、dtako-scraper 側にはもう存在しない** (net780-wasm#2)。
- `net780-wasm` は独立 repo (`ohishi-exp/net780-wasm`) だが、**`ohishi-exp/dtako_vid_wasm`
  と同じ vendoring 方式**で consume する (sibling checkout ではない、2026-07-03 変更)。
  `wasm-pack build --target web` (net780-wasm リポジトリの `./build.sh`) の出力
  (`wasm/pkg/*`) を `vendor/net780-wasm/` にそのままコミットし、`package.json` は
  `"net780-wasm": "file:./vendor/net780-wasm"` で参照する。
  - **理由**: `net780-wasm` は private repo のため、GitHub Actions CI に private repo
    へのアクセス権限を持たせたくない (`ohishi-exp/net780-wasm` 自体も CI で
    ビルドしない方針、`ohishi-exp/net780-wasm/README.md` 参照)。sibling checkout
    前提だと CI (test job だけでなく **deploy job** も) が実体を得られず、
    `pre_install_script` の空スタブがそのまま staging にデプロイされて
    `mod.default is not a function` 実行時エラーになる事故があった。
  - `net780-wasm` 側で実装を更新した場合は、`./build.sh` を実行して生成された
    `wasm/pkg/*` をこの repo の `vendor/net780-wasm/` に手動で上書きコピーし、PR で
    commit する運用 (= vendored snapshot、自動追従はしない)。
  - **`.gpd` (GPS) の既知の罠**: 実データでは GPS 位置レコード間に未解読の可変長
    ブロックが挟まっており、単純な固定長配列読みだと GPS 点が 0 件になる
    (net780-wasm の `core/src/gpd.rs` で `ff ff` マーカースキャン方式に修正済み、
    2026-07-03)。今後 `.gpd` のパースを触る時はこの構造を前提にすること。

### 速度チャート・GPS 地図の設計 (2026-07-03)

- **暦日 (JST) 単位で表示を分割する** (`buildDailySpeedCharts` / `buildDailyGpsPoints`、
  `app/utils/net780.ts`)。1 ZIP に複数日分の運行データが入ることがあり (紙の運行記録計
  も 1 日 1 行の表示)、1 本の連続チャートにすると日をまたぐ休憩・休息期間 (数時間〜
  半日) を直線で結んでしまい誤解を招く。各日は 0:00〜24:00 の固定範囲で正規化する。
- **record 境界の空白期間で折れ線を分割する** (`SPEED_GAP_THRESHOLD_SECS`、
  `buildSpeedChartData` の `segments`)。.spd は複数レコードの列で、record 境界に
  実際の空白期間 (停車等) があるとそのまま直線で結んでしまい、存在しない緩やかな
  減速/加速のような斜め線に見える不具合があった。
- **間引き (`downsampleSpeed`) は min/max バケット方式**。単純な等間隔インデックス
  抽出だと、急減速や長い停車 (速度 0 の谷) がバケット内に埋もれて間引かれ、実際には
  存在しない斜め線として描画されてしまう。バケットごとに最小値・最大値の 2 点を
  残すことで谷/山を取りこぼさないようにしている。
- **チャートのクリック/ドラッグでシークでき、`Net780Map.vue` (`VidMap.vue` と同じ
  パターン) の GPS マーカーが連動する**。currentTime (UNIX epoch 秒) を暦日ごとに
  保持し、`chartXRatioToTime()` で SVG 上の x 座標比率から絶対時刻に逆変換する。
- **GPS の `(0,0)` プレースホルダー (GPS 未捕捉時) は `buildDailyGpsPoints` で除外**
  する (地図表示のノイズになるため)。
- Google Maps API key の取得は `/vid-check` と同じ `/api/vid-check/map-key`
  endpoint を共用する (CF Secrets Store binding、endpoint 名は歴史的経緯でこの
  ままだが net780 専用に複製していない)。

### CI

- `vendor/net780-wasm/` を repo に commit 済みのため、CI (`test.yml`) に
  net780-wasm 用の `pre_install_script` は不要 (typecheck/test/deploy 全 job で
  素の `npm install` から解決できる)。
- `vitest.config.ts` の `resolve.alias` で `net780-wasm` → `tests/mocks/net780-wasm.ts`
  (モック) に差し替える (wasm バイナリの `fetch()` 初期化が vitest/happy-dom 環境で
  そのまま動かないため、実体があっても test ではモックを使う)。
- `app/types/net780-wasm.d.ts` (旧 CI 用型スタブ) は削除済み。`vendor/net780-wasm/`
  に real `.d.ts` (`declare module` ではない通常の module 宣言) が同梱されている
  ため型解決に追加のスタブは不要。

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `app/pages/net780.vue` | UI (ZIP アップロード + サマリ/暦日ごとの速度チャート+GPS地図/GPS一覧/イベント表示) |
| `app/utils/net780.ts` | `parseNet780Zip()` / `buildDailySpeedCharts()` / `buildDailyGpsPoints()` / `chartXRatioToTime()` 等 |
| `app/components/Net780Map.vue` | GPS 軌跡 Google Map (`VidMap.vue` と同じパターン、シーク連動マーカー) |
| `vendor/net780-wasm/` | `ohishi-exp/net780-wasm` の `wasm-pack build` 出力を vendor したもの |
| `tests/mocks/net780-wasm.ts` | vitest 用モック (`__setMockResult`/`__setMockError`) |

## DVR 動画ビューア (`/dvr-viewer` ページ + `/dvr-api/*`、Refs #90)

**管理者専用ページ** (`/dvr-viewer` 動画 / `/dvr-map` 位置情報・動態履歴)。管理画面
(auth-worker) ログインを**必須**とし (auth.global.ts の publicPaths に入れない =
未ログインは login にリダイレクト)、その上で theearth-np.com の credential でログイン
して自社の DVR ドラレコ動画 (`.vdf`)・車輌現在地・動態履歴を閲覧する二段構え。default
レイアウト (サイドバー) に載る (かつては layout:false の外部利用者向け standalone
だったが、管理者専用に変更、Refs #90)。

### credential pass-through 設計

theearth パスワードは**一切保存しない**。ログイン画面 = theearth へのログインそのもの
(認証を theearth 本体に委譲し、アプリ独自のユーザー DB / パスワード保存を持たない)。
= 「管理画面ログイン (auth-worker) で誰がアクセスしたか」と「theearth credential で
どの会社のデータを見るか」を分離。

```
[browser] /dvr-viewer (auth-worker ログイン必須、default レイアウト)
  │ POST /dvr-api/login (password は body のみ。X-Dvr-Comp-Id / X-Dvr-User-B64
  │ ヘッダで routing、password はヘッダに載せない)
  ▼
[worker/index.ts] /dvr-api/* を SCRAPER_RELAY service binding へ素通し
  ▼
[relay worker index.ts] resolveDvrRouting → idFromName(`dvr-{comp}:{userB64}`)
  │ (theearth アカウント単位で DO を固定 = 同一アカウント複数セッション不可の
  │  theearth 制約を自然に直列化)
  ▼
[DtakoScraperRelayDO /dvr-api/*] theearth にその場でログイン (theearth-client.ts の
  │ cookie jar / VIEWSTATE ロジック再利用)。credential は破棄し、theearth session
  │ cookie + ランダム token (64 hex) だけ DO storage に保持 (TTL 8h)
  ├ GET /dvr-api/notifications — VenusBridge Monitoring_DvrNotification2 (一覧)
  │   各行の FileReceive (`fa-prcs-X-Y`) から receiveState (ready/requestable/
  │   in_progress/error) を解析。3 段フロー: 未受信→[受信]→受信中→再生可能
  ├ GET /dvr-api/masters — Request_NetDvrFuncInitValue (事業所/車輌/乗務員マスタ、
  │   検索フォームのドロップダウン用)
  ├ POST /dvr-api/search — Request_DvrDataList (映像検索)。日時範囲 + 車輌/乗務員/
  │   位置範囲 + 映像種別/走行状態/道路種別の string[10] key (buildDvrSearchKey が
  │   実ページ J-AAV0100 と同じ必須条件を検証)。結果行は通知一覧と同じ receiveState
  │   を持ち、受信/表示フローを共用する
  ├ POST /dvr-api/transfer — Request_DvrFileTransfer_target (車両に映像転送を要求)。
  │   body {serials:[],filenames:[]} なら Request_DvrFileTransfer_MultiTarget
  │   (実ページは車輌絞込検索時の要求に MultiTarget を使うため、検索由来はこちら)
  ├ GET /dvr-api/vehicle-states?branch= — 車輌現在地 (VehicleStateTableForBranchEx、
  │   /dvr-map ページ用)
  ├ GET /dvr-api/log-track?vehicle=&start=&end= — 動態履歴 (F-DOV0010 の 2 段階
  │   postback → VehicleDisp テーブルの span パース。速度・回転数・住所・状態付き。
  │   VehicleStateTable API は速度が全点 0 なので使わない、詳細は theearth-venus skill)
  ├ GET /dvr-api/file — Request_DvrFileDownload でサーバー生成の実相対パスを解決 →
  │   /dvrData/{path} を NET780 マジック検証付きで **ストリーム素通し** (数十 MB を
  │   buffer しない)。決定論パスは組み立て不可 (実データで 404、Refs #90 で cdp 実証)
  └ POST /dvr-api/logout — セッション破棄
[browser] dtako_vid_wasm で decode → VidMap / VidTelemetryChart 再利用 (vid-check の単一ファイル版)
```

- VenusBridge クライアントは `ohishi-exp/nuxt_dtako_logs` の `theearth-venus-client.ts`
  (browser-render-rust#14 実機トレース済み) を relay worker に移植したもの。cookie jar /
  ログインは `theearth-client.ts` を再利用し二重管理しない
- theearth セッション切れは VenusBridge が HTML を返すことで検出し
  (`VenusSessionExpiredError`)、401 → browser 側で再ログインを促す
- token は browser の localStorage に保持 (ブラウザ再起動しても再ログイン不要。パスワードは保存しない)
- 新規 DO クラスは増やしていない (既存 `DtakoScraperRelayDO` にハンドラ追加、migration 不要)

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `app/pages/dvr-viewer.vue` | DVR 通知一覧 + 映像検索 + viewer (wasm decode / VidMap / VidTelemetryChart) |
| `app/pages/dvr-map.vue` | 車輌現在地 + 動態履歴 GPS 軌跡 (theearth VenusMain / F-DOV0010 相当) |
| `app/composables/useDvrSession.ts` | theearth セッション (token/localStorage/ログイン) の 2 ページ共有 |
| `app/components/DvrSessionHeader.vue` | 共通ヘッダー (ページ間ナビ + ログインパネル) |
| `app/components/DvrMap.vue` | 現在地マーカー / 軌跡ポリラインの Google Map |
| `workers/dtako-scraper-relay/src/dvr-session.ts` | セッション pure ロジック (token 生成 / timing-safe 比較 / routing ヘッダ解決、coverage 100% gate) |
| `workers/dtako-scraper-relay/src/theearth-venus-client.ts` | VenusBridge クライアント (通知/検索/マスタ/現在地/軌跡 + `.vdf` ストリーム、coverage 100% gate)。**座標は DDMM 形式 → convertDdmmToDegrees で度に変換** (詳細は theearth-venus skill) |
| `workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts` | `/dvr-api/*` ハンドラ |

## スクレイパ (`/scraper` ページ + `workers/dtako-scraper-relay/`)

dtako 運行ログ (csvdata.zip) の取得トリガー UI。実処理は `nuxt-dtako-admin-scraper-relay`
という別 worker (`DtakoScraperRelayDO`) に service binding で委譲する
(no-traffic release 維持のため、Refs error 10211/10061)。

### 2経路 (`SCRAPER_MODE`)

**結論 (2026-07-03 実機検証で確定): `http` mode は CSV ダウンロード段も含めて
`fetch()` だけで動作する (Chromium 不要)。** 真因は「2段階目 (`btnCsvSvrOutput` の
POST) に日付範囲フィールドを含めていなかった」ことで、これを含めれば実データ入り
ZIP (実測 85KB) が返る。詳細は下の運用手順 3. 内の note を参照。

> 一時期 PR #101 で「`fetch()` では原理的に不可能、`Sec-Fetch-Mode` 等の
> navigation 判定が原因」と誤って結論づけたが、それは 2段階目の日付欠落を見落と
> した誤診だった (実際は fetch でも 22 バイトの空 ZIP = export 0 件が返っていた
> だけで、handler には到達していた)。本 note で訂正。

| mode | 経路 | 備考 |
|---|---|---|
| `vpc-relay` (デフォルト、既存) | browser → DO → Workers VPC binding → Kagoya VPS の dtako-scraper (`/scrape/ws`、chromiumoxide ヘッドレス Chrome) | DO は薄い中継のみ |
| `http` (Refs ohishi-exp/dtako-scraper#22) | browser → DO → DO 自身が `theearth-client.ts` で theearth-np.com に素の `fetch()` でログイン + CSV ダウンロード | Chromium 不要。DO を `comp_id` 単位で `idFromName` するため同一企業への並列リクエストが自然に直列化される |

`workers/dtako-scraper-relay/wrangler.toml` の `[env.staging.vars] SCRAPER_MODE`
は `"http"` に設定済み (staging のみ、本番の top-level `[vars]` には未設定 = 本番は
`vpc-relay` のまま)。`SCRAPER_MODE` 自体は認証情報を含まないため wrangler.toml に
直接コミットしてよい (secret 扱いの `DTAKO_ACCOUNTS` とは異なる)。

有効化の運用手順:

1. `DTAKO_ACCOUNTS` (dtako-scraper の Rust 版 `DTAKO_ACCOUNTS` env と同一 JSON shape:
   `[{comp_id, user_name, user_pass, tenant_id}, ...]`) は **`wrangler.toml` にも
   Secrets Store にも置かず**、Cloudflare dashboard の Worker
   (staging: `nuxt-dtako-admin-scraper-relay-staging`、本番:
   `nuxt-dtako-admin-scraper-relay`) → Settings → Variables and Secrets から
   **plain Environment Variable** (Secret ではなく Variable) として直接追加する。
   値を見ながら設定・確認できることを優先した意図的な選択 (org 標準の Secrets Store
   write-only 運用からの逸脱だが、`wrangler.toml`/git 履歴には平文が残らない)。
   `DtakoScraperRelayDO` の `resolveSecret()` は文字列 binding / Secrets Store
   binding (`.get()`) のどちらでも動く実装のため、この切替に**コード変更は不要**

   > **`keep_vars = true` 必須 (wrangler.toml 実装済み)。** この worker は DO
   > migration を持つため `wrangler versions upload` が使えず、CI
   > (`dtako-scraper-relay-deploy.yml`) は `workers/dtako-scraper-relay/**` を
   > 触る PR が merge されるたびに **classic `wrangler deploy`** を実行する。
   > Wrangler の既定挙動は「config に無い binding は deploy 時に削除」なので、
   > `keep_vars` 無しだと `DTAKO_ACCOUNTS` (dashboard 専用) が **この worker に
   > 触れる PR が merge されるたびに毎回消える** (実害: #83 投入直後から
   > #85/#86/#88/#92 の merge で繰り返し消失し、その都度「comp_id が
   > DTAKO_ACCOUNTS に見つかりません」で再発覚した)。`keep_vars` は top-level
   > only (named environment 配下には書けない) なので wrangler.toml の
   > トップレベルに 1 箇所だけ書けば staging/本番どちらの deploy にも効く。
2. staging (`SCRAPER_MODE=http` 設定済み) で `DTAKO_ACCOUNTS` に1社だけ登録し、
   実際に csvdata.zip がダウンロードできるか確認してから本番へ展開する
   (本番展開時は top-level `[vars]` に `SCRAPER_MODE = "http"` を追加する PR を出す)
3. `theearth-client.ts` の CSV フォーム要素 id (`rdoSelect1`/`rdoDate1`/
   `MainContent_ucStartDate_txtYear` 等) と2段階目ボタン (`btnCsvSvrOutput` /
   `btnCsvOutput`) は theearth-np の実ページ trace (issue #22) に基づく推定。
   サイト仕様が変わった場合は `TheearthClientError` で loud fail するので、
   エラーメッセージを見て `theearth-client.ts` の該当 id を実ページと突き合わせる

   > **真因: CSV ダウンロード段の「空 ZIP (22 バイト)」は、2段階目
   > (`btnCsvSvrOutput` の POST) に日付範囲フィールドを含めていなかったのが原因
   > (実機検証 2026-07-03 で確定、ohishi-exp/dtako-scraper#22)。**
   > このフローは 2段階 postback (`btnCsvSvr` → 確認ページ → `btnCsvSvrOutput`)
   > で、サーバの CSV export ハンドラは **2段階目の POST body からも日付範囲を
   > 読む**。旧実装は 2段階目に hidden field と出力ボタンしか含めておらず日付を
   > 落としていたため「範囲外 = 0 件」の空 ZIP (`PK\x05\x06` の EOCD のみ) が
   > 返っていた。実ブラウザのクリックは確認ページの DOM に日付が残ったまま
   > submit するので成功していた。`downloadCsvZip()` で 2段階目にも日付範囲を
   > 再送するよう修正済み → fetch でも実データ入り ZIP (実測 85KB、`PK\x03\x04`)
   > が返る。
   >
   > 併せて実クライアント JS (`J-NOS3010[GeneralCsv].js` の `DateCheck()`) から
   > 「表示ボタン `btnCsv` の送信は常にキャンセルされ、実際に POST されるのは
   > 隠しボタン `btnCsvSvr`」であることも確認し `CSV_FORM_IDS` を `btnCsvSvr` に
   > 修正済み (旧実装は `btnCsv` で送っていた別バグ)。
   >
   > **hang / セッションロック対策**: サーバの export 生成が遅い (実測 90 秒超)
   > ため 2段階目のみ `DEFAULT_EXPORT_TIMEOUT_MS` (150s)、他は
   > `DEFAULT_REQUEST_TIMEOUT_MS` (30s) の `AbortSignal.timeout` を掛け、固まった
   > リクエストは `TheearthClientError` (タイムアウト) で loud fail させる。
   > **同一 ASP.NET セッションへの並行リクエストはセッションロックで hang/500 する**
   > ので、`http` モードでは DO を `comp_id` 単位で `idFromName` + DO 内の
   > `scrapeQueue` で必ず直列化する (並行 fetch を撃たない)。この直列化は
   > `runHttpScrapeJob` の Promise チェーン + `finally { release() }` で、
   > タイムアウト/失敗時もキューが解放される。

`http` モード完了時、DO は csvdata.zip を `ctx.storage` に一時保存 (TTL 10分、
1回だけ取得可能) し、WS の `result` イベントに `zip_url` (`/scraper-zip/{compId}/
{requestId}`) を載せる。フロントは `buildScraperZipUrl()` で絶対 URL 化して
「zipダウンロード」リンクを表示する (`app/pages/scraper.vue`)。認証は zip URL 自体には
無く、requestId (128bit UUID) を知っていること + 単回性 + 短命 TTL が capability-URL
としての防御 (WS 到達自体は既存の auth-worker introspect で認証済み)。

### rust-alc-api への自動アップロード (`AUTH_WORKER` service binding + alc-internal-proxy)

`http` モードは zip 取得後、`INTERNAL_SHARED_SECRET` が設定されていれば
`./alc-internal-upload.ts` で rust-alc-api に自動アップロードする。

**device pairing は使わない** (当初 PR #86 で device credential 経由アップロード
を実装したが再考して撤回、Refs ohishi-exp/dtako-scraper#22)。この DO はブラウザ
JWT を持たない server-to-server caller で、かつ `comp_id` は複数 tenant に
またがりうる (`DTAKO_ACCOUNTS` は tenant 横断の1つの JSON 配列、
`app/pages/scraper.vue` の `compIdOptions` もハードコードされた全社共通リストで、
ログインしている管理者の tenant とは無関係に任意の comp_id をトリガーできる)。
よって以下のどちらでもなく:

- `device-data-proxy` (device JWT が要る = Worker が device pairing するのは不自然)
- `alc-proxy` (browser JWT の tenant_id を逆引き) — トリガーした管理者の tenant
  と comp_id の tenant が一致するとは限らず、誤 tenant 書き込みの恐れがある

**`alc-internal-proxy` の shared-secret 経路** (email-receiver が
`/api/dtako/tickets` で使うのと同じ、Refs ippoan/rust-alc-api#434 caller #4) を
使う。`AUTH_WORKER` service binding (Worker→Worker in-process fetch、introspect
と共用) 経由で `/alc-internal-proxy/api/upload` を叩き、`X-Alc-Proxy-Secret`
(= `INTERNAL_SHARED_SECRET`) + `X-Tenant-ID` (= `DTAKO_ACCOUNTS` から解決した
**account.tenant_id**、comp_id に紐づく正しい tenant) を渡す。OIDC mint / rust
向け `X-Internal-Shared-Secret` 付与は auth-worker (`alc-internal-proxy.ts`) 側に
集約されている。

進捗は WS の `progress` イベント (`step: "upload"`) で `app/pages/scraper.vue` に
表示される。`INTERNAL_SHARED_SECRET` 未設定の間は自動アップロードをスキップし
zip ダウンロードのみ提供する (fail-closed にはしない、機能低下のみ)。

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `workers/dtako-scraper-relay/src/theearth-client.ts` | ブラウザレス HTTP クライアント (cookie jar / VIEWSTATE 抽出 / 2段階 CSV POST / ZIP magic assert) |
| `workers/dtako-scraper-relay/src/alc-internal-upload.ts` | `AUTH_WORKER` service binding 経由の rust-alc-api 自動アップロード (`/alc-internal-proxy/api/upload`、multipart body 手組み) |
| `workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts` | `DtakoScraperRelayDO`。`SCRAPER_MODE` で vpc-relay / http を分岐、comp_id 単位の直列化キュー、アップロード進捗の WS 配信 |
| `workers/dtako-scraper-relay/src/index.ts` | `comp_id` (http 用) / `session` (vpc-relay 用) で DO へ routing、`/scraper-zip/*` 転送 |
| `worker/index.ts` | app 本体の entry。`/ws/scraper` と `/scraper-zip/*` を SCRAPER_RELAY service binding に転送 |
| `app/utils/api.ts` | `triggerScrapeStream()` / `buildScraperZipUrl()` |

## Cron (VPS / GCE cron の Worker 移行)

dtako (csvdata.zip) と ETC (明細 CSV) の定期取得を VPS / GCE の cron から
`dtako-scraper-relay` worker の **Cron Triggers** に移した
(Refs ohishi-exp/dtako-scraper#22 / ohishi-exp/browser-render-rust#14)。cron 式は
`wrangler.toml` の `[triggers]` と `src/cron.ts` の `DTAKO_CRON` / `ETC_CRON`
定数を必ず一致させる (ズレると scheduled handler が「未知の cron 式」を log して
何もしない)。

| cron (UTC) | JST | 対象 | 移行元 |
|---|---|---|---|
| `0 16 * * *` | 01:00 | dtako 全社 (昨日 1 日分) | VPS cron `dtako-scraper-daily` |
| `0 21,22,23,0 * * *` | 6,7,8,9 時 | ETC 全アカウント | GCE cron `etc-scrape-batch-env` |

- **dtako cron は `SCRAPER_MODE=http` の時だけ実走**する (vpc-relay の間は VPS 側
  cron が現役なので skip)。`DTAKO_ACCOUNTS` の各社について comp_id 単位 DO の
  `/cron/dtako` を叩き、DO 内で `scrapeViaHttp` → alc-internal-proxy アップロード。
- **ETC cron は `ETC_ACCOUNTS` (dashboard の plain Environment Variable、
  `[{user_id, password}, ...]`) の各アカウント**について `etc-{user_id}` DO の
  `/cron/etc` を叩く。DO が `scrapeEtcCsv` (`src/etc-meisai-client.ts`) で
  ブラウザレス login → 検索 → CSV 取得し、**R2 (`DTAKO_R2`) の
  `{ETC_R2_PREFIX}/{user_id}/{YYYY-MM-DD}/{HHMMSS}.csv`** (JST) に保存する
  (本番 `etc/` / staging `etc-staging/` で分離)。credential は cron dispatch に
  載せず DO 側で `ETC_ACCOUNTS` から解決する。
- `ETC_ACCOUNTS` は `DTAKO_ACCOUNTS` と同じく **秘密を含むため wrangler.toml に
  置かず** dashboard の plain var で投入する (`keep_vars = true` で deploy を
  またいで保持、この worker に触れる PR の merge で消えないようにする)。未設定の
  間は ETC cron が skip される (fail-closed、クラッシュしない)。
- ETC の実装は `wrangler deploy --temporary` の egress PoC (issue #14 で
  workerColo=KIX, 全 200 OK 実証済み) を前提に、`fetch()` のみで
  funccode ルーター (`/etc/R`) を叩く。**検索は `sokoKbn=0` (全て) を明示 override
  しないと明細が欠落する** (初期値は「ETC無線走行のみ」= 1、issue #14 最重要 gotcha)。
- etc-meisai は Shift_JIS。応答は `decodeHtml` で charset sniff してデコードし、
  CSV でない応答 (HTML エラーページ) は `EtcMeisaiNotCsvError` で loud fail して
  R2 の `{prefix}-errors/` に原本を残す (「黙って200」対策)。明細 0 件は
  `EtcMeisaiNoUsageError` で正常 skip 扱い。

### 関連ファイル (cron)

| ファイル | 役割 |
|---|---|
| `workers/dtako-scraper-relay/src/cron.ts` | cron dispatch の pure ロジック (アカウントパース / 日付 / R2 key / DO 呼び出し注入)。100% gate |
| `workers/dtako-scraper-relay/src/etc-meisai-client.ts` | etc-meisai.jp ブラウザレス HTTP クライアント (funccode ルーター / form パース / Shift_JIS / CSV assert)。100% gate |
| `workers/dtako-scraper-relay/src/index.ts` | `scheduled()` handler (cron → DO fetch 配線) |
| `workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts` | `/cron/dtako` `/cron/etc` ハンドラ + ETC CSV の R2 保存 |

### ETC の CCoW 内検証 (cookie 委譲、Refs ippoan/cdp-relay#69)

ETC スクレイパーを実 credential で CCoW から検証したいが、**CCoW の egress は
Anthropic egress gateway が TLS を MITM 終端する** (証明書 issuer が
`O=Anthropic, CN=Egress Gateway SDS Issuing CA`) ため、CCoW から login POST すると
credential が gateway 内で平文復号される。これを避けるため、**login は手元ブラウザ、
検索→CSV は CCoW** に分ける:

1. cdp-relay で手元ブラウザを pair し、手元で etc-meisai に login する
2. `browser_cookies(session, ["https://www2.etc-meisai.jp"])` → `cookies_url` (cookie
   生値は context に載らない、`curl -o` で回収)。**ログイン/検索/CSV の実 host は
   `www2.etc-meisai.jp`** (トップページのみ `www.etc-meisai.jp`、実機確認済み — 生 HTML の
   リンク href は絶対 URL で `www2` を指すため、コード側は `page.url` 相対解決のみで host
   を自動追従する。`ETC_BASE_URL` はトップページ GET の 1 箇所にしか使っていない)
3. `browser_eval(session, "location.href")` → login 後 URL (`startUrl`)
4. `npx tsx scripts/verify-etc.ts <cookies_url> <startUrl>` — cookie を jar に注入し
   `scrapeEtcFromCookies` で検索→CSV。credential は CCoW に来ない、cookie だけ。

- `src/etc-meisai-client.ts` の `scrapeEtcFromCookies(cookies, startUrl, ...)` が
  login をスキップして cookie で開始する entry (jar は login と分離済みなので薄い)。
- `scripts/verify-etc.ts` は node/tsx 実行 (bun ではない、下記参照)。cookie value も
  CSV 明細 (個人情報) も出力せず、cookie 名 / 件数 / ヘッダ行 / 成否だけ出す。
- **検証範囲の限界**: この経路は `etcLogin` (funccode/hidden POST) を通らないので
  **login 実装自体は検証されない**。login は本番 cron / devtools 観察で別途検証する。

#### cookie 委譲を CCoW コンテナ (node/curl) から直接試したら実害が出た — 未検証なのは Worker 経路

実機検証 (2026-07-04): 手元ブラウザで login 後の cookie (`JSESSIONID`) を、**CCoW
コンテナ内の node/curl** から `www2.etc-meisai.jp` に送ったところ、サーバーは
そのセッションを認識せずログインフォームを返し、`Set-Cookie` で新規セッションを
発行した。その直後、**手元ブラウザ側の元セッションも無効化され、ユーザーが
再ログインを強いられた** (実害確認済み)。

**ただしこれは「CCoW コンテナから node/curl で fetch した」場合の結果でしかない。**
本来 `browser_cookies` が想定する用途は **Cloudflare Worker (本番の
dtako-scraper-relay 等) が cookie を使って fetch する**構成であり、CCoW の egress
(Anthropic gateway、datacenter IP) と Cloudflare Workers の egress (Workers 固有の
IP レンジ) は別物。IP バインディング (推測、未確定) だったとしても、Worker からの
fetch が同様に弾かれるかは **別途検証が必要**であり、まだ確認していない。

**当面の運用**: 実害が起きた「CCoW コンテナから直接 node/curl で cookie を使う」
検証手段 (`scripts/verify-etc.ts` の直接実行) は、原因が切り分くまで控える。
`scrapeEtcFromCookies` 自体 (本番 DO / Worker 内での使用) を否定するものではない。
ETC の full flow (login 含む) 検証は、`wrangler deploy --temporary`
(`scripts/verify-etc-worker/`、実 CF colo egress、手元発) か手元での直接実行を使う。

### ETC の `wrangler deploy --temporary` 検証 (login 含む full flow、credential は手元のみ)

cookie 委譲 (上記、**現在は禁止**) は login 実装自体を検証しない上に危険。
**login を含めて丸ごと検証**したい時は `scripts/verify-etc-worker/` (本番 relay の
DO/migration とは独立の使い捨て Worker) を `wrangler deploy --temporary` する。
credential は**手元シェルの `--var` としてのみ**渡し、CCoW / 会話には一切乗せない
(`wrangler-deploy-temporary` skill 参照)。

```sh
cd workers/dtako-scraper-relay
git pull   # CCoW で書いた最新コードを取り込む
npx wrangler deploy --temporary --config scripts/verify-etc-worker/wrangler.toml \
  --name verify-etc-<好きな名前> \
  --var ETC_USER:"<実ユーザーID>" --var ETC_PASS:"<実パスワード>"
```

表示された `https://<name>.<random>.workers.dev/verify` を GET すると `scrapeEtcCsv`
(login→検索→CSV を一括実行) の結果 (`{ ok, steps, accountType, filename, bytes, rows,
header }`) が JSON で返る。**CSV 明細本体・credential は返さない**。デプロイ URL 自体は
Cloudflare の JS challenge に守られ `curl` では読めないため、結果を Claude に見せる場合は
cdp-relay の実ブラウザ経由 (`browser_navigate` → `browser_eval("document.body.innerText")`)
で読む。

- `scripts/verify-etc-worker/index.ts` — `/` (health) `/verify` (実行) の薄い Worker。
  `ETC_USER`/`ETC_PASS` 未設定は 400。
- `scripts/verify-etc-worker/tsconfig.json` — 本体 tsconfig (bun 専用 `verify-etc.ts` を
  除外する既存方針) とは別に、`@cloudflare/workers-types` で型検証する専用 tsconfig。
- 60分で自動失効、claim しなければ何も恒久化しない。

#### `verify-etc.ts` は node/tsx で動かす (bun は TLS handshake が通らない、実機確認済み)

`node`/`bun` の組み込み `fetch` (undici) は **`www2.etc-meisai.jp` との TLS
ハンドシェイクで一貫して失敗する** (503 `TLS_error...HANDSHAKE_FAILURE`)。CCoW の
egress gateway が TLS を再終端する際に runtime が送る ClientHello fingerprint が、
向こう側の WAF (Envoy 系、エラーメッセージ形式で確認) に弾かれると見られる。同一
ホストへの `curl` は安定して 200 で通る。よって `scripts/verify-etc.ts` は
**`curl` をサブプロセスで呼ぶ `FetchLike` アダプタ (`curlFetch`)** を実装し、
etc-meisai.jp 向けの fetch だけこれに差し替える (cdp-relay 自体への fetch は通常の
`fetch` のままで良い)。credential/cookie を含み得るヘッダ・body はコマンドライン
引数ではなく **curl config file (`-K`) 経由**で渡す (`ps` 等でプロセス引数を見ても
値が出ない)。本番 Cloudflare Workers の `fetch` は別実装なのでこの問題は起きない
はず (未検証)。

## テスト

- ユニット: `npm test` (Vitest、happy-dom)
- カバレッジ目標: `coverage_100.toml` で管理
- `workers/dtako-scraper-relay/` は親と別の `vitest.config.ts` を持つ (bespoke deploy
  pipeline、pure ロジック [`auth-decision.ts`/`theearth-client.ts`] のみ 100% gate。
  DO/index.ts は cloudflare runtime 依存で node vitest 計測不可)

## 並行開発 (worktree)

- 必ず `origin/main` ベース worktree を使う
- `/wt-quick` で Cloudflare Quick Tunnel + auth-skip 起動可能
- backend と同期改修する場合は同じ wt-name で揃えると `--incus-backend` が auto-pair する
  (`~/rust/rust-alc-api/CLAUDE.md` の Backend + Frontend 同時改修ワークフロー参照)
