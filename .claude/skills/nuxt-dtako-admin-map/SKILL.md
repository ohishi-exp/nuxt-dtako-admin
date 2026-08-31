---
name: nuxt-dtako-admin-map
generated-from: nuxt-dtako-admin:2b9f72a885a55d6c5f3e9ad73912a04ed7738baa
paths: [app/, server/]
description: ippoan/nuxt-dtako-admin (dtako デジタコ運行データ管理画面、Nuxt 4 + Cloudflare Workers) の構造ナビゲーション。rust-alc-api を直 fetch する frontend と、R2 binding が要る Y時間 Excel export、ブラウザ内完結の NET780 ビューア (net780-wasm 経由) の server route / page 配置、一番星 (rust-ichibanboshi) の売上と便を突き合わせる粗利・運行手当の区画を 1 枚にまとめる。トリガー:「dtako」「nuxt-dtako-admin」「Y時間 export」「y-time-export」「vehicle-settings」「DTAKO_R2」「運行データ」「dtako.ippoan.org」「net780」「NET780」「net780-wasm」「remote-app」「RemoteApp」「IronRDP」「RDP」「rdp.ippoan.org」「Cloudflare Access」「粗利」「margin」「profit」「運行手当」「allowance」「一番星」「ichiban」「突合」「reconcileVehicles」「ProfitPanel」「スナップショット」「ProfitSnapshot」「force-match」「強制突合」「マッチ率」「売上」「取引先」「便」「運転日報明細」等。**この repo で PR を出す/レビューする前にも読む** —「PR の基準」「レビュー基準」「カバレッジ 100%」「検証手順」「実測値」「差分レビュー」でも発動。
---

# nuxt-dtako-admin-map — ippoan/nuxt-dtako-admin 構造ナビゲーション

dtako (デジタコ運行データ) 管理画面。Nuxt 4 + Nitro `cloudflare_module`。backend は
**rust-alc-api** を直 fetch するのが基本。R2 binding が要る機能 (Y時間 export) だけ Worker
の `server/api` route に置く。

> 細部は repo 側が正。ここは索引。`generated-from` が現在の tree-sha とズレたら
> session-start-skill-coverage hook が再生成を促す。

## 区画

| 区画 | 主要ファイル | 役割 |
|---|---|---|
| **pages (運行系)** | `app/pages/{index,upload,scraper,net780}.vue` `operations/{index,[unko_no]}.vue` | 運行一覧 / アップロード / スクレイパ / NET780 生データビューア / 運行詳細 |
| **pages (時間集計)** | `app/pages/{daily-hours/index,restraint-compare,restraint-report,restraint-fetch,y-time-export}.vue` | 日別時間 / 拘束時間 比較・レポート / 拘束CSV取得 (theearth F-ERS2010、下記) / Y時間 export UI |
| **pages (粗利・突合)** | `app/pages/profit/{margin,allowance,monthly,compare}.vue` | 粗利 (売上−手当−経費) / 運行手当 / **保存済み検証一覧** (`monthly.vue`、過去の確認記録のアーカイブ。月次マッチ率の比較は #859 で廃止) / 類似運行検索。**一番星の売上と便の突合はここが本体** (下記) |
| **pages (車両設定)** | `app/pages/vehicle-settings/{index,diff,history,unconfirmed}.vue` | デジタコ車両設定の閲覧・差分・履歴・未確認 |
| **pages (管理/認証)** | `app/pages/{members,api-tokens,event-classifications,login}.vue` `auth/callback.vue` `ichiban-health.vue` | メンバ / API トークン / イベント分類 / login / 一番星ヘルスチェック (`/ichiban-health` — rust-ichibanboshi の既存 API と給与読み取り API を一括疎通確認、pure ロジックは `app/utils/ichiban-health.ts`、Refs #369) |
| **pages (社内リモート)** | `app/pages/remote-app.vue` | ブラウザ内 RemoteApp ビューア (IronRDP/WASM、Refs #693)。**中継は Cloudflare Access が守る公開ホスト名へ直結** — Worker はデータ経路に居ない (下記) |
| **pages (DVR)** | `app/pages/dvr-viewer.vue` `dvr-map.vue` | DVR 動画・位置情報ビューア (Refs #90)。**管理者専用** — auth-worker ログインを**必須**とし (`auth.global.ts` の publicPaths は `/login` `/auth/callback` だけ)、**その上で** theearth credential pass-through で DVR データを取る二段構え。default レイアウト (サイドバー) に載る。**「外部利用者向け・publicPaths・`layout: false`」は #90 以前の姿で、いまは違う** (下記の節が正)。`/dvr-api/*` は worker/index.ts → SCRAPER_RELAY service binding → `workers/dtako-scraper-relay` の DO (`theearth-session.ts` / `theearth-venus-client.ts`) |
| **components** | `app/components/Event*.vue` `VehicleSettings*.vue` `CsvDataTable.vue` `DriverSearchSelect.vue` `ProfitPanel.vue` `AllowanceOperationModal.vue` | イベント表 / 車両設定 表示・diff / CSV テーブル / 運行詳細の収支パネル (検証スナップショット、下記) / 運行手当タブの運行モーダル |
| **server/api (proxy)** | `server/api/proxy/[...path].ts` `server/utils/alc-proxy.ts` | `/api/proxy/*` → auth-worker `/alc-proxy/*` (introspect / ACL / OIDC mint / identity 注入を集約) → rust-alc-api `/api/*` (createAuthWorkerProxyHandler、#434 step 3 方式 B)。consumer は AUTH_WORKER service binding に X-Alc-Proxy-Secret + browser JWT を thin-forward するだけ。`alc-proxy.ts` の `alcProxyFetch` は R2 が要る route が同じ `/alc-proxy` 経由で backend を叩き Response を受け取るヘルパ (lockdown 後も OIDC 不要で通る。旧 `identity.ts` の直叩き+resolveIdentityHeaders を置換、#434 caller #2) |
| **server/api (ichiban/kyuyo proxy)** | `server/api/ichiban/[...path].get.ts` `server/api/kyuyo/[...path].get.ts` `server/utils/ichiban-upstream.ts` | rust-ichibanboshi への thin proxy (CF Access Service Token 付与、#330/#369)。kyuyo 側は upstream パスを `api/kyuyo/` 配下に固定し、ブラウザの `Authorization: Bearer <JWT>` を素通し転送 — 給与の認可は upstream の introspect + email allowlist (rust-ichibanboshi#82) が担う。**#988 で認可が入った (機構は route で違う)**: ichiban は `requireAuth` (上流へ渡す身元をそもそも持たないため)、kyuyo GET/POST は `resolveBrowserAuthorization` が `null` なら 401 (fail closed。認可の正本は上流のまま)。**#1015 で ichiban は upstream path も固定** — `ICHIBAN_PROXY_ALLOWED_PATHS` の**完全一致 6 件**だけを中継し、外れは 403 (kyuyo の `api/kyuyo/` 前置き固定とは別物。あちらは上流委任なので「外れ」の概念が無い)。**front に `/api/ichiban/**` の呼び出しを足すときは allowlist にも足す** |
| **server/api (粗利/検証スナップショット)** | `server/api/profit/{snapshot.get,snapshot.post,snapshot.delete,snapshots.get,monthly.get,margin-summary.post}.ts` `server/utils/profit-r2-io.ts` | `PROFIT_R2` への検証スナップショット read/write/list と車輌×月サマリ、**粗利の集計そのものの版管理保存** (Refs #826)。R2 binding が要るので Worker 側 (pure は `app/utils/{profit-r2,margin-r2}.ts`) |
| **server/api (kyuyo-master)** | `server/api/kyuyo-master/{companies.get,refresh.post,refresh-full.post}.ts` `server/utils/kyuyo-master-db.ts` | D1 `kyuyo_companies` (migration 0005、会社×年度リスト・金額なし) の読み/差分更新 (rust `/api/kyuyo/databases` 高速一覧)/フル更新 (会社名+権限、遅い)。消費者は `/kyuyo-fetch` ページ (#369 PR-B1)。取得済み明細は sessionStorage (タブ限り、別ユーザー検知で purge、pure ロジックは `app/utils/kyuyo-fetch.ts`) |
| **server/api (Y時間)** | `server/api/y-time-export.post.ts` `y-time-template.{get,put}.ts` | backend GET→R2 テンプレ→ExcelJS xlsx 生成 (R2 が要るので Worker 側)。backend GET は `alcProxyFetch` で /alc-proxy 経由 |
| **server/api (車両設定)** | `server/api/vehicle-settings/{extract.post,history.get,object.get,unconfirmed.get}.ts` | 車両設定 抽出・履歴・取得。unconfirmed は backend `/api/vehicles` を `alcProxyFetch` (/alc-proxy 経由) で叩く (**`/api/dtako/vehicles` ではない** — 下の gotcha 参照。Refs #1033) |
| **utils** | `app/utils/{api,event-data-table,y-time-xlsx,vehicle-settings-*,net780}.ts` | API ラッパ / 表整形 / JSZip writer / 車両設定 cfg・diff・labels / net780-wasm ラッパー |
| **utils (粗利・突合)** | `app/utils/{allowance-*,margin*,profit-*,ichiban,operation-leg-sales}.ts` | 便の切り出し・手当・突合・粗利・賃金構成の pure ロジック (下記に主要 3 本) |
| **middleware** | `app/middleware/auth.global.ts` | 全 page の JWT gate |
| **assets** | `app/assets/css/main.css` | Tailwind/Nuxt UI entry。印刷はダークモードでもライト配色に固定 (dark variant を `@media not print` に限定 + Nuxt UI `--ui-*` 変数の print 上書き。後者は @nuxt/ui 更新時に追従が必要)。`<main>` の bg-gray-50 も印刷では白固定 |

## NET780 ビューア (`/net780`、Refs dtako-scraper#18)

NET780 生データ ZIP をサーバー送信せずブラウザ内で直接パースする機能。パースロジックの
SoT は `ohishi-exp/dtako-scraper` の `crates/net780` (Rust)。ブラウザからは
`ohishi-exp/net780-wasm` (独立 repo、`ippoan/fc1200-wasm` と同じ「wasm-pack build →
consumer が file: 参照」規約) を経由して呼ぶ。`package.json` の
`"net780-wasm": "file:../net780-wasm/pkg"` は sibling checkout 前提。CI は
`pre_install_script` で `../net780-wasm/pkg/package.json` の最小スタブを作り、
vitest は `resolve.alias` で `tests/mocks/net780-wasm.ts` に差し替える (実 wasm 不要)。

## entrypoint

- nuxt.config: `nitro.preset = cloudflare_module`、`@ippoan/auth-client` を vite optimizeDeps exclude、`allowedHosts: ['.trycloudflare.com']` (/wt-quick 用)。
- wrangler.toml: top-level=prod (`dtako-admin`, dtako.ippoan.org) / `[env.staging]`=staging。`compatibility_flags=["nodejs_compat"]` は ExcelJS の node:stream/buffer 用。
- R2: `DTAKO_R2` → `dtako-uploads`。prod/staging **共用 read-only** (テンプレ配信のみ)。
- vars: `NUXT_PUBLIC_API_BASE` (rust-alc-api Cloud Run)、`NUXT_PUBLIC_AUTH_WORKER_URL` (auth-worker)。

## gotcha (CLAUDE.md 由来)

- **手動 `wrangler deploy` 禁止**。`/tag-release patch` のタグリリースで CI 自動デプロイ。
- **Y時間 は sync HTTP で配信 (async job 化しない)**。一時期 backend `POST /jobs` + WS 完了通知 (notify-realtime-bus) で async 化を試みたが、**Cloud Run の CPU throttling で `tokio::spawn` の background compute が完走せず** frontend WS が 120s timeout → revert。5-15s compute は CF edge timeout (100s) 内に収まる。
- Y時間 xlsx は JSZip single-pass row-batch writer (`y-time-xlsx.ts`, PR #30 で 150x 高速化)。
- 開発は必ず `origin/main` ベース worktree。メイン wt では build しない (hook がソース編集を禁止)。
- **上流 (rust-alc-api) の車輛マスタは `GET /api/vehicles`。`/api/dtako/vehicles` は存在しない** (Refs #1033)。**`dtako/` は nest ではなく各モジュールが route 文字列に直書き**していて (`nest("/api/dtako` は 0 件)、`alc-dtako` crate の 37 route のうち接頭辞つきは `/dtako/events`・`/dtako/events/etags`・`/dtako/tickets*`・`/dtako/y-time-export` の 4 系統だけ。`vehicles`・`operations`・`drivers`・`work-times` 等は接頭辞なしで `/api` 直下。**`/api/dtako/**` が居ないわけではないので「dtako を消す」を一般則にしないこと。**`unconfirmed.get.ts` が最初から後者を指していて **本番が 404 だった**。**この repo のテストは `alcProxyFetch` を mock するので「path が上流に在る」ことは検査していない** — 上流の path を変える/消す変更は緑のまま通る。

## CCoW / CI から見た立ち位置

- consumer 側。`@ippoan/auth-client` (`dev` dist-tag、createAuthWorkerProxyHandler/server を取るため) で JWT 発行/refresh。**rust-alc-api 直叩きはやめ `/api/proxy` 経由**にした (#434 step 3 方式 B)。proxy は AUTH_WORKER service binding に thin-forward し、auth-worker `/alc-proxy/*` が X-Alc-Proxy-Secret を constant-time 検証 → introspect / ACL / OIDC mint / X-Tenant-ID + X-User-* 注入を集約する (rust-alc-api#441 で backend は JWT 検証を撤去し注入 identity を信頼)。`api.ts` の route 文字列は不変 (proxy の pathPrefix='/' で `/api/proxy/api/*` → backend `/api/*`)。integration test (api.test.ts) は backend を直叩きするため tenantIdGetter (X-Tenant-ID) を引き続き使う。
- test.yml は `use_auth_client_dev: true` で PR 時に `@ippoan/auth-client@dev` を overlay install (createAuthWorkerProxyHandler 取得)。
- `/wt-quick` で Cloudflare Quick Tunnel + auth-skip 起動可。backend 同期改修は同 wt-name で `--incus-backend` auto-pair。

## 関連 skill

- `auth-worker-map` — JWT 発行元 (`@ippoan/auth-client` の認証先)
- `nuxt-vitest` — composable/utils のテスト (`coverage_100.toml` で 100% 管理)
- `cross-repo-symbol-index` `ippoan-infra-map` — 横断 symbol / 基盤地図
- `theearth-venus` — theearth-np.com 実機知見。コード⇔doc は双方向アンカー規約
  (コード側は節見出し名まで、doc 側は各節冒頭に `consumer:` 行) で対応させている。
  概念語 (読取日/運行日等) → 実フィールド名の対応表と、横断検索用 `scripts/xref.sh`
  も同 skill の「検索の入口」節を参照。

## ★ PR の基準 (この repo で PR を出す前に必ず読む)

この節は**監督役 (親) の引き継ぎ文に置いていたものを repo に移したもの** (Refs #760)。
引き継ぎ文に置いている限り交代のたびに抜け落ちる、とオーナーから指摘があったため
(2026-08-25)。**子タスクにもここを読ませること。**

### (1) PR を作る前に満たっていること (子に渡す検証)

```bash
ln -sfn <メイン clone>/node_modules node_modules   # 0 秒
npx nuxt prepare          # ★ 先にこれ。無いと vitest が全ファイル import に失敗する
npx nuxt typecheck        # エラー 0
npm test                  # 0 failed
npm run test:coverage && node scripts/check_coverage_100.mjs   # all 100%
```

- **★ 基準値 (テスト本数・分岐数) は `origin/main` で毎回自分で測る。**
  issue や過去の PR に書いてある本数は古い (実害が出ている)。
- **★ 親も独立に同じ検証を回し、子の報告と数字が一致することを確かめる。**
  やらないと子の緑を信じるだけになる。
- 詳細は `nuxt-vitest` skill、実機確認は `dev-login-local-verify` skill。

### (2) カバレッジ 100% gate と分岐 (方針改定 2026-08-31、Refs #1069)

- **UI ページ (.vue) を `coverage_100.toml` に新規登録しない。** gate は pure ロジック
  (app/utils / server / relay) だけ。ページを 100% にすると本番コードの改変
  (`:disabled` 重複ガード / 型都合の `??` / 死に関数) が必ず要る。
  既存登録の components は据え置き (外す判断は別 issue)。
- **テストは「値を検査する」ものだけ足す。** 行カバレッジを目的にテストを書かない。
  カバレッジ 100% は値を検査していない (`it.skip` にしても数字が動かない実測あり)。
- **BR() のような分岐数の手書き注記をコード・toml に書かない。** 手書きの数値主張は
  必ず腐る (1 日で 3 件の実測)。分岐の検証が要るときだけ instrumented コピーで測り、
  **結果は PR 本文に測定条件つきで書く** (ファイルには残さない)。
- 死に分岐はテストで埋めない。「いまのデータで通らない」/「いまの呼び方では通らない」/
  「構造上あり得ない」の 3 段で判定し、構造上ならコードを直す。

### (3) 実機確認

- **画面・server route を変えたら dev で測る** (CLAUDE.md の規範)。
  `dev-login-local-verify` skill の `setup-dev-env.sh` で起動する。**`--build` が要るかは
  `--hybrid` かどうかで変わる** (hybrid なら UI は nuxt dev が配信するので `server/` や
  依存を変えた時だけ。hybrid 無しなら `.output` が UI そのものなので `app/` の .vue・
  画面の文言を変えたら必須)。判断はスクリプト冒頭のコメントが正 (Refs #864)。
  **付け忘れると古いバンドルを配信したまま測ってしまう。**
- **dev は立つが、環境によってはブラウザ目視ができない** (Linux 実機が LAN 上にあり
  Windows の Chrome から `localhost` に届かない構成)。測れるのは 型検査 / テスト /
  カバレッジ / **server route の応答** / **配信される JS chunk の中身**まで。
  **測れた範囲と測れなかった範囲を報告に必ず明記する。**
- **目視は「マージ後・本番・親」。**`Release Wave … completed successfully` が合図。
  **preview は別レルムなので見ない。**

### (4) 数字 (不変条件)

- **2026-07 の不変条件が動かないことを実測で示す**
  (運行 91 本 / 走行 57,829.4km / 売上 ¥10,260,265 / 手当 ¥2,499,500 / 粗利 ¥4,467,597)。
- **読むだけの変更なら「実行される JS の diff が削除行のみ」等、動かないことの積極的な証明**を出す。

### (5) ★ 実測値には測定条件を必ず添える

#858 で 3 者が同じコードについて 3 通りの数字を出した。原因は全部「入力の取り方」で
**どれも間違っていない**。しかし条件を書かずに残したので、PR 本文・issue・コードのコメントに
誤った値が入り、因果の推論まで狂った (memory `measurement-needs-its-conditions`
`pin-the-measurement-condition`)。

- **母集団を書く** — 「候補一覧」と「確定済み明細」は別物。後者は人が既に選んだ後なので
  よく一致する。**結論が変わる。**
- **入力の取り方を書く** (「選択区間をその便だけにした」等)。
- **測定の限界も書く。**
- **間違えた数字は、間違えた理由ごと 1 か所残す** (消すと同じ失敗が繰り返せる)。

### (6) PR 本文に必ず入れるもの

1. **何を・なぜ** (why が無いと次の人が読めない)
2. **触っていないもの** (禁止事項を守った証拠)
3. **検証** ((1)(2)(3)(4) の実測値、測定条件つき)
4. **★ 測れなかった範囲** (正直に。「ブラウザ目視は未実施」等)
5. **数字** (1 円も動かないこと、または動く理由)
6. **画面を変えたなら「人が何を読むか」** — 下記 (7)

### (7) ★★ この repo で最も多い欠陥の型 — 「出ているものが別の意味に読める」

v0.0.531→v0.0.541 の 11 本のうち **6 本がこの型**だった。

- 注記の穴 / 「読まなかった」と「読めなかった」が同じ見た目 / 比べる相手がいないのに空 /
  動いていないのに「¥0 動いた」/ 超えていないのに「赤字 −0%」/ `¥-0`
- **#851**: #849 で**触っていないファイルの文言が嘘になった**。差分レビューでは見つからず、
  **本番の画面を開いて初めて出た** (memory `diff-review-misses-untouched-text`)。
- **#854**: 「結ぶと戻せない」を直したら**符号を変えて「外すと戻せない」が残った**。
- **#861**: バッジの「完全一致」が **partial+partial でも出ていた** (保存済み一覧とは別の意味だった)。

**レビューの手順に入れること:**

- **その機能を説明している定数・doc コメントを `git grep` で先に洗う** —
  「◯◯は別物です」「◯◯には乗りません」の類は、**その関係を変えた瞬間に嘘になる**。
- **定数名も直す** (中身から語が消えるのに名前だけ残ると、次の人が同じ誤解をする)。
- **その語を固定していたテストは「今の嘘」を固定している。**書き換えになるのが正しい。
- **逆方向の誤読も同時に潰す** (「効くようになった」だけ書くと
  「押したのに変わらない = 効いていない」を踏む)。
- **黙って落とさず数えて画面に言わせる** (読めなかった件数、判定できなかった件数)。

### (8) 親 (監督役) の作法

- **PR は親が作る。子に `gh pr create` を打たせない。**
- **★ PR を作る前に必ず差分をレビューする。**CI は PR 作成で 1 回だけ回り、緑なら即マージされる。
  前任は差分レビューで 3 件止めた (どれもテストが緑のまま通る欠陥)。
- **★ draft を栓に使わない (却下済み)。**この org の Auto Merge job は draft だと CI が赤くなり、
  `ready_for_review` が trigger に無いので ready に戻しても再発火しない。
- **マージは GitHub の auto-merge ではなく CI の `ci / Auto Merge / Auto Merge` job**。
  `autoMergeRequest = null` は正常 (memory `merge-is-ci-job-not-github-automerge`)。
  この job が待つ間、CI の running↔queued の往復が何度も届く — 失敗ではない。
- **`PR Limit Check` の fail は「衝突する open PR がある」の意味。**衝突が解けても CI は
  自動で回り直さない — 親が `gh run rerun <id> --failed` を打つ。
- **子の archive は親が打つ。**基準 4 点 (PR MERGED / remote branch 削除 / 申し送り消化 /
  本番確認) を裏取りしてから。**`archive_session` は worktree を畳まない** —
  親が `git worktree remove` + `git branch -D` で掃除する。
  **畳んでよいかを子やユーザーに聞かない** (`task-split` skill に明記)。
- **★★ 子のブランチが増えたら、まず行き違いを疑う。**指示はキューで届くので
  子の push と親の指示は普通に交差する (memory `propose-before-push-off-plan`)。
  **責めてから確かめる順序にしない。**

## CLAUDE.md から移設 (2026-07-06)

dtako (デジタコ運行データ) 管理画面。Nuxt 4 + Cloudflare Workers (Nitro `cloudflare_module`)。
backend は **rust-alc-api** (`https://rust-alc-api-...run.app`) を直接 fetch する形が基本だが、
Y時間 export 等 R2 binding が必要な機能は Worker 内 server route に持つ。

## デプロイ

| env | URL | wrangler env | 更新タイミング |
|---|---|---|---|
| 本番 | https://dtako.ippoan.org | (default) | `v*` タグ push |
| staging | https://dtako-staging.ippoan.org | `staging` | `main` への push |
| preview | https://dtako-preview.ippoan.org | `preview` | main 以外の任意 branch への push のたび (test/typecheck 無し・deploy のみの軽量パイプライン、`.github/workflows/preview-deploy.yml`、create-preview skill) |

タグリリース (`/tag-release patch`) で CI 自動デプロイ。手動 `wrangler deploy` は禁止。

**preview は UI 変更の見た目確認が主目的** (backend の rust-alc-api / auth-worker
は staging をそのまま再利用)。ただし `workers/dtako-scraper-relay` (DO worker)
だけは**専用の preview worker** (`nuxt-dtako-admin-scraper-relay-preview`) を持つ
(Refs #134、ETC scraping の実機診断イテレーションを共有 staging を汚さずに
高速に回すため)。`.github/workflows/dtako-scraper-relay-preview-deploy.yml` が
`workers/dtako-scraper-relay/**` への push (main 以外、PR 不要) のたびに
`wrangler deploy --env preview` する。app 本体の `[env.preview]` の
`SCRAPER_RELAY` service binding もこの preview worker を指す。

**preview の scraper-relay に ETC_ACCOUNTS / DTAKO_ACCOUNTS を投入する**:
これらは `keep_vars = true` で deploy を跨いで保持される dashboard の plain
Environment Variable であり、wrangler.toml には無い (git 履歴に平文を残さない
ため)。新規 worker (`nuxt-dtako-admin-scraper-relay-preview`) は初回 deploy 時点
ではこれらが未設定なので、Cloudflare dashboard → Workers & Pages →
`nuxt-dtako-admin-scraper-relay-preview` → Settings → Variables and Secrets
から staging と同じ値を手動で追加すること (未設定の間は ETC/dtako scraping が
「ETC_ACCOUNTS が未設定です」等で fail-closed する、クラッシュはしない)。

## 環境変数 (`wrangler.toml` `[vars]`)

| key | 用途 |
|---|---|
| `NUXT_PUBLIC_API_BASE` | rust-alc-api Cloud Run URL |
| `NUXT_PUBLIC_AUTH_WORKER_URL` | auth-worker URL (JWT 発行 / refresh) |

## R2 binding

- `DTAKO_R2` → `dtako-uploads` バケット — Y時間 テンプレ xlsx の配置先 (`templates/...`)。
  本番 / staging 共用 (read-only)。
- `PROFIT_R2` → `dtako-ichiban-verify` バケット (staging / preview は `dtako-ichiban-verify-staging`) —
  一番星マッチ率の**検証スナップショット** (`profit/{ym}/{車輌CD}/{運行NO}/{segmentId}/`) と、
  **粗利の集計そのものの版** (`profit/{ym}/margin-summary/`、Refs #826)。下記の粗利区画。

## D1 binding と migration (Refs #367)

- `DTAKO_DB` → `dtako-admin-uploads-catalog` (`81dd4136-…`)。**app 本体と
  `workers/dtako-scraper-relay` の両 worker・全 env が同じ database_id** を指す
  (staging / preview / 本番で DB は 1 つ)。新規 env を足しても binding 宣言は
  済んでいるので wrangler.toml の変更は要らない (Refs #299)

| テーブル | 由来 | 正 (source of truth) |
|---|---|---|
| `dtako_uploads` | 0001〜0004 | **R2 が正**、D1 は再構築可能な検索インデックス |
| `kyuyo_companies` | 0005 (#369) | D1 (会社×年度リスト、金額は持たない) |
| `employees` / `employee_attrs` | 0006 (#367)、0010 で所属コード/営業所名/職種名 (#409) | **D1 が正** (唯一の保存場所。識別情報+属性のみ、金額は持たない) |

- migration は repo 直下の **共有 `migrations/`** (relay の wrangler.toml が
  `migrations_dir = "../../migrations"` で参照)
- **適用は CI が行う — 手動適用は禁止** (CLAUDE.md の規範)。
  `dtako-scraper-relay-deploy.yml` が `pull_request` 以外 (main push / tag /
  workflow_dispatch) で `wrangler d1 migrations apply --remote` を deploy 前に
  実行する。PR では実行しない (未レビューのスキーマ変更を共有 DB に当てない)
- **`scripts/d1/bootstrap-d1-migrations.sql`** (冪等): 本番 D1 は元々手作業運用で
  wrangler の記帳テーブル `d1_migrations` が無かった。そのまま apply すると 0001 から
  再実行され **0003 の `ALTER TABLE ADD COLUMN comp_id` が duplicate column で落ちる**
  ため、0001〜0005 を `INSERT OR IGNORE` で記帳してから apply する。
  2026-07-25 の main push run で本番適用完了 (0001〜0005 = 記帳、0006 = 実適用)
- **罠**: この repo は auto-tag で merge 直後に本番まで出る。**スキーマ依存のコードと
  migration を別 PR に割ると、migration 適用前にコードが本番へ出る** — 実際 #367 の
  PR-B/PR-C が本番 D1 に `employees` が無い状態で 2 日間動き、給与比較・月次集計タブが
  502 になっていた (2026-07-23〜25)。migration を含む PR を先に merge すること

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
- **通信断 (`0xB8`) 〜 通信復帰 (`0xB9`) 区間の GPS 点も `buildDailyGpsPoints` で除外
  する** (実データ検証: トンネル区間等で測位が収束せず海上・市街地外へ直線的に
  飛ぶ異常座標 79 点中 78 点が通信断区間内の記録だった、Refs 実機調査 2026-07-18)。
  区間抽出は `extractCommOutageRanges()`。対応する `0xB9` が無い場合は記録終端まで
  通信断継続とみなし `end: Infinity` にする。
- **通信断イベントと無関係に発生する GPS ジャンプは `filterImplausibleGpsJumps()`
  (速度ベース) で除外する** (Refs 実機調査 2026-07-19)。イベントコード
  (`0x11`/`0x21` 作業状態 ON/OFF 等) の時間窓との相関を試したが運行ごとに一致率が
  低く実効性が無かった (0x11/0x21 前後 120 秒除外でもジャンプ 14 件中 12 件残存)。
  直前の「採用済み」点との実装速度が `MAX_PLAUSIBLE_SPEED_KMH` (150km/h) を超え、
  かつ `MIN_JUMP_DIST_KM` (0.3km) 以上移動していたら物理的にありえないジャンプと
  みなしてその点を除外する。
  - **既知の罠 (単純な「採用済み点」比較だけでは不十分)**: 異常座標が同じ場所に
    数十分単位で長時間留まり続けるケースがあり、経過時間が伸びるほど同じ距離でも
    計算上の速度が下がっていくため、いずれ閾値を下回って誤って採用されてしまう
    (採用された瞬間にその点が新しい基準点になり、以降の異常クラスタも道連れで
    誤採用され続ける)。「ジャンプ件数が 0 になった」という検証だけでは検出できない
    (フィルタ後の隣接点同士の速度はどのみち閾値以下になるため) — 座標そのものが
    妥当な範囲に収まっているかを別途確認する必要がある。対策: 直前の「生」の点との
    距離も追跡するヒステリシス方式にした。直前の生点が異常判定されていて、かつ
    現在の点がその生点から `MIN_JUMP_DIST_KM` 未満しか離れていない (= 同じ異常
    クラスタに留まっている) 場合は、基準点との計算上の速度に関わらず異常判定を
    継続する。クラスタから実際に離れるまでは採用を再開しない。
  - 実データ 2 運行 (07-03/07-04・07-17/07-18) で異常座標が完全に (0 件まで)
    除去されることを確認済み。`buildDailyGpsPoints` は通信断除外のあとにこの
    フィルタを適用する (主防御線)。
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
| `app/components/Net780OperationSummary.vue` | `/operations/{unko_no}` の NET780 タブ本体。D1 (`dtako_uploads`) を運行No で引き、サマリ + 暦日ごとの速度チャート+GPS地図を埋め込み表示する (`net780/index.vue` の dailyViews ロジックを移植、2026-07-19) |
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
  │ POST /dvr-api/login (password は body のみ。X-Theearth-Comp-Id /
  │ X-Theearth-User-B64 ヘッダで routing、password はヘッダに載せない。worker は
  │ 旧 X-Dvr-* / X-Report-* も受理 = デプロイ順 skew 対応、Refs #233)
  ▼
[worker/index.ts] /dvr-api/* を SCRAPER_RELAY service binding へ素通し
  ▼
[relay worker index.ts] resolveTheearthRouting → idFromName(`theearth-{comp}:{userB64}`)
  │ (theearth アカウント単位で DO を固定 = 同一アカウント複数セッション不可の
  │  theearth 制約を自然に直列化。/daily-report-api/* も同じ DO・同じセッション
  │  レコードを共有する — 分離すると互いに kick し合う、Refs #233)
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
| `app/composables/useTheearthSession.ts` | theearth セッション (token/localStorage/ログイン)。dvr 系 + daily-report-edit の全ページで単一セッションを共有 (Refs #233)。`useDvrSession` / `useDailyReportSession` は apiPrefix だけ違う薄いラッパー |
| `app/components/TheearthSessionHeader.vue` | 共通ヘッダー (ログインバッジ/パネル)。dvr 系 + daily-report-edit で共用 |
| `app/components/DvrMap.vue` | 現在地マーカー / 軌跡ポリラインの Google Map |
| `workers/dtako-scraper-relay/src/theearth-session.ts` | セッション pure ロジック (token 生成 / timing-safe 比較 / routing ヘッダ解決 (新旧ヘッダ)、coverage 100% gate) |
| `workers/dtako-scraper-relay/src/theearth-venus-client.ts` | VenusBridge クライアント (通知/検索/マスタ/現在地/軌跡 + `.vdf` ストリーム、coverage 100% gate)。**座標は DDMM 形式 → convertDdmmToDegrees で度に変換** (詳細は theearth-venus skill) |
| `workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts` | `/dvr-api/*` ハンドラ |

## 拘束時間管理表 CSV 取得 (`/restraint-fetch` ページ + `/restraint-api/*`、Refs #241)

theearth (web地球号) の **F-ERS2010[RestraintDataReport] (乗務員拘束時間管理表)** から
対象乗務員 (複数) × 対象年月 (範囲) の CSV を **1 名 × 1 月ずつ逐次** 取得し、
パース済みサマリを集計表示するページ。全乗務員一括 export は重い (実測 112 名
378KB / 数十秒) ため乗務員CD を列挙して回すのが既定の使い方。

- credential pass-through / theearth セッション共有は /dvr-viewer・/daily-report-edit と
  同一 (`useRestraintSession` = `useTheearthSession('/restraint-api')`、同一 DO
  `theearth-{comp}:{userB64}`、Refs #233)
- worker 側は `workers/dtako-scraper-relay/src/theearth-restraint-client.ts` (pure、
  100% gate)。**年は [4桁西暦, 令和2桁] を順に試すフォールバック** (企業の和暦/西暦
  設定で解釈がぶれる — 検証企業は 4 桁西暦のみ成功、別企業は `08`=令和 表示。
  `chkUseEra` checked なら令和を先に)。「該当データがありません」HTML (UTF-8) と
  CSV (Shift_JIS) の判別・デコード分岐が要 (詳細は theearth-venus skill の F-ERS2010 節)
- DO routes: `/restraint-api/login|logout` (共通 theearth login)、
  `GET /restraint-api/report?year=&month=&driverFrom=&driverTo=` (パース済み JSON、
  no_data フラグ)、`GET /restraint-api/csv?...` (生 Shift_JIS CSV 素通し)
- **R2 アーカイブ (DTAKO_R2、`RESTRAINT_R2_PREFIX`)**: 取得成功時に生 CSV
  (`{prefix}/{comp}/{YYYY-MM}/csv/{range}/`) と乗務員別サマリ JSON
  (`.../summary/{乗務員CD}/`) を waitUntil でバージョン管理保存。`latest` は
  `sha256`/`fetchedAt`/`lastVerifiedAt` (**いつの時点まで同じ値だったか**) を
  customMetadata に持ち、内容が変わった時だけ `v-{ts}` 版を追加。置き換えられた
  旧版は後継版の出現から 7 日で自動削除 (`pickSupersededVersionKeys`)。
  `csv/{range}/history.jsonl` に取得のたび 1 行追記 (`new-version`/`unchanged`/
  `no-data`) — **unchanged (変わっていなかった) と no-data (途中入社・休職・未集計)
  も確認結果として時系列で残る**。乗務員単体取得の no-data は summary 側にも
  `{noData:true}` マーカーを置く
- **CSV は theearth 側で集計済みの月しか出ない** (未集計月は該当データなし)。集計
  実行 (F-ERS2012) の自動化は未実装 — 必要なら theearth 画面から手動で 集計 を回す

| ファイル | 役割 |
|---|---|
| `app/pages/restraint-fetch.vue` | 取得条件 (年月範囲 + 乗務員CD 複数) / 逐次取得進捗 / 乗務員別合計・明細・日別詳細 / 集計CSV・生CSV ダウンロード |
| `app/composables/useRestraintSession.ts` | `/restraint-api` prefix の thin ラッパー |
| `workers/dtako-scraper-relay/src/theearth-restraint-client.ts` | F-ERS2010 クライアント + CSV パーサ + サマリ集計 (pure、100% gate) |

## 拘束×賃金 (`/restraint-wage` ページ + `/restraint-api/wage-*`・`archive/*`、Refs #244)

R2 アーカイブ (上記 /restraint-fetch) の summary を素材に、theearth に触らず賃金計算・
印刷・アーカイブ閲覧を行う。⓪アーカイブ閲覧 (生CSV/版/確認履歴) ①月次集計・印刷
(theearth プレビュー形式 + 給与様式の法定区分列、**時間給内訳は展開トグル**、
`@media print` A4横) ②最低賃金チェック (換算時給 vs 県別最低賃金)
③単価マスタ (適用開始日つき履歴、一括変更、CSV 1行=1履歴 upsert)
④給与比較 (給与明細 CSV をブラウザ内のみで解析し wage-report と突合 —
**基礎単価(実績) = 割増基礎算入計÷法定内時間 と 残業(基礎単価) 理論値の
労基法37条主判定 + 残業(最低賃金) の絶対下限併記**、Refs #278)
⑤支給項目区分 (**割増基礎 (37条) × 最低賃金 (4条3項) の 2 軸 5 区分**:
base/overtime/minwage-only/premium-base-only/excluded、旧 base/overtime 保存値は
後方互換。集計意味論は `app/utils/salary-compare.ts` の `SALARY_CATEGORY_FLAGS`)
⑥社員マスタ (D1、下記) ⑦勤務設定 (D1、下記)。

- 決定事項: 法定休日=日曜・法定外休日=土曜既定 (wage-config で変更可)、
  **週40h は日曜起算で「週の終端が属する月」に計上、月初跨ぎ週は前月 summary の
  days を含めて計算** (前月アーカイブが無い月は warning + 当月分のみで近似)。
  「休出」列は保留。実給与 CSV 比較は形式確定後 (Refs #244)
- 計算 pure module: `workers/dtako-scraper-relay/src/restraint-wage.ts` (100% gate) —
  単価/最低賃金の適用開始日 lookup・法定区分分類・週40h・金額 (円未満四捨五入)、
  最低賃金ベース残業代 (月60h超 1.5 倍の時間外軸 + 深夜軸 0.25 の独立加算、
  `computeMinWageOvertimePay`/`splitMinWageOvertimePay`、Refs #268)。
  summary v2 (theearth-restraint-client.ts) が日別データ + 派生指標
  (当月超過/15h超過日数/平均運転9h超過回数、上限は CSV 注記パース) を供給する
- 共有 fixture + golden: `tests/fixtures/restraint-wage/` (入力 4 乗務員シナリオ +
  `golden/wage-rows.json`)。golden は
  `workers/dtako-scraper-relay/test/restraint-wage-golden.test.ts` が突合、再生成は
  `UPDATE_GOLDEN=1` (作法は fixture README)。最低賃金チェック/給与比較の両タブの
  テストが同一 fixture を使う (org 方針: `local-first-testing` skill、計画:
  `docs/plan-268-wage-tab-separation.md`)
- **最低賃金チェックの並びと右端の突合ブロック** (ユーザー決定 2026-07-30、
  `groupMinWageRows`/`minWageCompareRow` = `app/utils/restraint-wage-view.ts`):
  並びは **会社コード → 職員区分 (事務員 → 作業員 → 整備 → 乗務員 → その他) →
  営業所 → 乗務員CD**。職員区分の判定はタイムカード表と共有
  (`timecardJobGroup`、`kosoku-daily.ts`)。**営業所の順は「その営業所が持つ最小の
  所属コード」** — 所属 (`SHOZOKU`) は営業所 × 職種の組で 1 営業所が職種ごとに
  別 INCODE を持つため、コードを行の第 1 キーにすると同じ営業所が区分の中で割れる
  (2026-04 本番で 0200 の乗務員が 本社 → 諸富 → 大阪 → 本社 → 北九州 → 大阪)。
  表の右端は **計算 / 給与 / 差 (給与 − 計算) の 3 列で、各セルを 上段 基本給 →
  中段 残業代合計 → 下段 合計 の 3 段に積む** (ユーザー決定 2026-07-30。横 8 列に開くと
  17 列で紙にも画面にも収まらず、金額を列にした版から縦横を入れ替えた — 同じ金額どうしが
  横に並ぶので差を目で追える)。基本給は左の内訳列と右で
  2 回出る (左は時間の内訳、右は突合)。差は片方が欠けたら 0 ではなく null (「-」)。
  **ヘッダーは `th` に `sticky` を付けて常時表示** (Refs #570) — `tr`/`thead` に付けても
  `border-collapse` の表では効かない。表側を `max-h` + `overflow-auto` にする必要もある
  (`overflow-x-auto` だけだと縦も暗黙にスクロール容器になりページスクロールでは固定されない)。
  給与の列はホバーで支給項目の内訳を出す (`fmtItemsTitle`)。
  **印刷は分類ごとに改ページ** (`.minwage-section` = 1 tbody = 1 分類に `break-before: page`、
  先頭だけ `:first-of-type` で除外して白紙を出さない。Refs #572)。
  **法定外休日 (祝日・会社指定休の出勤) の列は該当者が居る月だけ出す** (Refs #566) —
  差分列の検算は 9 区分すべてを引くので、0 以外は日別データの不整合を指す
- **単価マスタタブの「乗務員を追加」** (Refs #568): 一覧は R2 の単価マスタから作るので
  履歴が 1 件も無い人は行が無く、単価を登録する口が無かった。候補は**社員マスタの乗務員CD +
  読み込み済み賃金集計の乗務員**を混ぜる (警告に出る人は社員マスタに乗務員CD が無いことが
  ある。集計の追加 fetch はしない)。他の編集と同じくローカル追加 → 「保存」で確定
- マスタは R2 `restraint/{compId}/{wage-master|min-wage|wage-config}/latest.json`
  (putVersionedR2 の版管理を再利用 — 一括変更 = PUT 1 回 = 1 版)
- DO routes: `GET/PUT /restraint-api/{wage-master|min-wage|wage-config}`、
  `POST wage-master/csv` (upsert 取込)、`GET archive/{summaries|csv-list|csv|history}`、
  `GET wage-report?month=` (前月 tail 込みの計算行)、社員マスタ (下記) は
  `GET/PUT /restraint-api/employee-master`、勤務設定 (下記) は
  `GET/PUT /restraint-api/{work-schedule|holiday-work}`

### 勤務設定 (D1、所定労働時間 + 休日出勤の承認、Refs #424 PR-C)

タイムカード (社内 CakePHP `yhonda-ohishi/nginx`) 由来の勤務を法定区分へ振り分ける
ための入力。**デジタコ (theearth) 由来の乗務員には効かない** — 時間外は拘束時間 CSV
がそのまま持っているため。pure module は
`workers/dtako-scraper-relay/src/work-schedule.ts` (100% gate)。

- **所定労働時間** (`work_schedules`、migration 0011): 実働がこれを超えた分が時間外。
  スコープ列 `branch_code`/`job_name` で所属×職種ごとに上書きできるが、運用はまず
  **全社既定 1 行**だけ (ユーザー判断「基本会社でいい、今後必要なら拡張」)。列を最初
  から持たせているので拡張時に migration が要らない。
  解決は `resolveWorkScheduleAt` — 適用開始日が月末以前の行のうち**具体度が最優先**
  (拠点+職種 > 拠点 > 職種 > 全社既定)、同じ具体度なら適用開始日が新しい行。
  **具体度を日付より先に見る**のは、全社既定を後から更新した時に拠点別の設定が
  消える事故を防ぐため
- **休憩は持たない**: 事務員は昼休憩で打刻を切っているので、休憩は打刻の中抜けギャップ
  と 12:00-13:00 の**和集合**から出す (和集合なのは中抜けが昼を跨ぐと二重控除になる
  ため)。固定値マスタは実データ検証の結果**不要と判断して落とした**
- **休日出勤の承認** (`holiday_work_approvals`、migration 0012): 休日の打刻のうち
  **この表に載っている日だけ**が割増賃金の対象 (= 休日出勤)。載っていない日は
  **自主出勤**として賃金計算から外すが**時間は記録・表示する** — 後から日付を足せば
  昇格する (実態が指揮命令下なら労働時間と評価されうるため「消さない」設計)。
  突合キーは `driver_cd` (= 乗務員CD = 一番星社員C = CakePHP `drivers.id`)
- **タイムカード → サマリの変換** (`workers/dtako-scraper-relay/src/timecard-summary.ts`、100% gate、Refs #424 PR-B): 日別 JSON を `RestraintDriverSummary` 互換に畳むので `computeWageRow`/`classifyMonth`/`compareSalaryMonth` は無変更で事務員を計算できる。実働 = 打刻 − (中抜け ∪ 12:00-13:00)、時間外 = 実働 − 所定 (終わり側から取り深夜帯と重ねる)、自主出勤は `isRestDay: true` + 各時間 0 + `voluntaryMinutes`。**時刻は秒で保持して最後に分へ丸める** — 先に分へ丸めると上流の `restraint_minutes` と 1 分ずれる。fixture は実機応答 (`tests/fixtures/restraint-wage/timecard-daily-2026-06.json`) + golden
- **重複乗務員は timecard が勝つ** (`mergeSummarySources`、2026-07-28 決定): 同じ乗務員CD が
  デジタコとタイムカードの両方に居たら**タイムカード側を採用**する — 賃金は打刻を根拠に
  するため、拘束/実働/時間外/深夜と勤怠日数はそちらで統一する。ただし**タイムカードから
  構造的に出せない列** (運転・荷役・年度累計・当月超過・平均運転9h超) だけはデジタコ側の
  値で埋め戻す (`fillTheearthOnlyMetrics`) — 改善基準告示の管理項目が丸ごと空欄になるのを
  防ぐため。`over15hDays` は埋め戻さない (タイムカードが自分の拘束から数えた値を持ち、
  同じ行の「拘束合計」と整合する方を残す)。落とした側は warning に出す
- **取り込み** (`POST /restraint-api/kintai/fetch?month=`、Refs #424 PR-A): rust-ichibanboshi の
  `/api/kintai/daily` を CF Access Service Token で叩き、**上流応答を解釈せず生のまま**
  `kintai/{compId}/{ym}/raw/` へ versioned 保存 (theearth の `restraint/` とは別 prefix —
  同じ月・同じ乗務員CD で両方存在しうるため)。併せて所定マスタ・休日出勤の承認・社員の
  スコープを D1 から引いて `summarizeTimecardMonth` を回し、社員別サマリも保存する。
  `GET /restraint-api/kintai/archive?month=` で版一覧と確認履歴を見る。**冪等** —
  内容が同じなら版は増えず `summaries_updated: 0` になる
- **ドライバーの拘束・深夜** (`GET /restraint-api/kintai/kosoku-daily?month=`、Refs #472 PR-A):
  rust-ichibanboshi の `/api/kintai/kosoku-daily` (打刻基準の日別サマリ、`driver` 省略で
  全乗務員 = rust-ichibanboshi#125) を**中継するだけ**。応答は `{month, drivers:[{driver, days}]}`。
  **R2 に置かない** — 生イベントからいつでも作り直せる派生値で、原本は社内 MariaDB 側にある。
  ドライバーは打刻を持たないため `/kintai/fetch` の経路には出てこない (タイムカード表が
  事務員しか出ていなかった原因)。**この拘束は現行の拘束時間管理表 (theearth 由来) と
  一致しない** — あちらは運行 (デジタコ)、こちらは打刻で測るため、打刻のある乗務員では
  拘束が増える (実測: 乗務員 1029 で +1,097 分)
- **Secrets Store binding は解決できないと `get()` が throw する** — 宣言はあるが entry が
  無い/改名された時に素通しすると生のスタック付き 500 になる。try/catch で「未設定」と
  同じ 503 に倒すこと (2026-07-26 に dev で実際に踏んだ)
- **NULL をスコープの「全体」に使わない**: SQLite (D1) の UNIQUE/PK は NULL 同士を
  異なる値として扱うため、NULL を PK に含めると `ON CONFLICT DO UPDATE` が一致せず
  同じ行が二重に入る。番兵値 (`branch_code = -1` / `job_name = ''`) を使い、
  アプリ側の型は `number | null` / `string | null` のまま SQL 境界で変換する

### 社員マスタ (D1、給与コード×会社 → 乗務員CD、Refs #367)

給与コード↔乗務員CD の突合を D1 (`employees`/`employee_attrs`、migration 0006) で
持つ。旧 R2 版 (`salary-cd-map`、楽観排他 baseVersion + sessionStorage ドラフト
退避) から置き換え — D1 行単位 upsert (last-write-wins) のため排他制御・ドラフト
復元は不要になった。突合ロジック本体 (`compareSalaryMonth`/`suggestCdMapEntries`、
`app/utils/salary-compare.ts`) への入口は変えていない — `app/utils/employee-master.ts` の
`buildCdMapEntries()` で従来の `SalaryCdMap` 形へ変換して橋渡しする
(worker 側の同名ロジックは import 不可のため実装が2箇所になる、Refs #268 の教訓)。
`compareSalaryMonth` の内部は N:1 の合算のため #403 で変更した (下記)。

- **R2 `salary-cd-map` 経路は撤去済み** (2026-07-25): ルート
  `GET/PUT /restraint-api/salary-cd-map`・移行用 `POST .../import-cd-map`・
  `migratable` フラグ・`normalizeSalaryCdMap` はいずれも無い。本番移行の完了
  (27324455 = 183 名 / 75700192 = R2 マスタ無し ⇒ `migratable` が両社 false) を
  確認したうえで落とした。**社員の登録経路は「給与DBから取り込み」と
  「未登録 N 名をマスタへ登録」の 2 本だけ** — 復活させないこと
- **「未登録 N 名をマスタへ登録」** ボタン (`findUnregistered`): 給与明細 CSV に
  現れたが社員マスタに (会社, 給与コード) が無い行を一括登録する。送るのは
  コード・氏名・会社のみ (乗務員CD 突合・金額は一切送信しない)
#### 突合キーの会社部分は「給与大臣の会社コード」(Refs #405)

`employees.company` / `employee_attrs.company` が保持するのは **給与大臣の会社コード
(`0100`/`0200`/`0300`/`0400`)** であって会社名ではない (migration 0009 で CONAME1 から
置換)。理由は 2 つ:

- 会社ラベルは自由文字列で**表記揺れがキー分裂を生む** (#367 の留意点そのもの)
- **`/api/kyuyo/payroll` は CONAME1 を返さない** ため、給与比較の DB 直読み (#369)
  から会社ラベルを引き当てられなかった。会社コードなら payroll 応答の `company` を
  そのまま突合キーに使える

会社名 (CONAME1) は **`comp_payroll_map.payroll_company_name` に表示専用**で持ち、
`GET /restraint-api/comp-map` が `payrollCompanyName` として返す。画面表示は
`payrollCompanyLabel()` (`app/utils/dtako-comps.ts`) が `0100 (有限会社 大石運輸)`
形式に整える — **名前が無くてもコードだけで機能は成立する**(突合はコードで行う)。

`planPayrollDbImport` は `res.company` (コード) を company に入れる。
`salaryCdMapKey` / `buildCdMapEntries` / `compareSalaryMonth` は**無変更** — キーに
入る文字列が変わるだけ。

会社名の書き戻しは `PUT /restraint-api/employee-master` の**任意フィールド**
`payrollCompanyName: {payrollCompany, name}` で行う (給与DB取り込みの後に「保存」を
押した時だけ載る)。対応表に無い会社なら 0 行更新で無害 — 会社の追加自体は
`comp_payroll_map` の管理作業であってこの経路では作らない。

**給与明細 CSV 取り込みの会社入力も選択式**にした (自由入力を廃止)。会社は突合キーの
一部なので、手入力を許すと表記揺れでキーが分裂する。選択肢は comp-map 由来で、
「(会社未設定)」も選べる — 1 社しか扱わない運用では会社無しでも旧 2 部キーで突合できる。

- **会社 (comp) スコープ** (migration 0007): `employees`/`employee_attrs` は
  `comp_id` を PK に含み、DO は必ずセッションの `record.compId` で絞る。dtako
  テナントは複数ある (27324455 = 給与DB 0100/0200/0300、75700192 = 0400)。
  一方、**社員マスタタブだけは会社横断で表示・編集できる** (管理者が両社を見る、
  会社リストは `app/utils/dtako-comps.ts` = scraper.vue と共有)。保存は会社ごとに
  PUT を分ける — worker はセッションの会社IDでしか書かないため。触れる会社の
  判定は `allowedViewerComps` (DTAKO_ACCOUNTS 逆引き) が正で、フロントの
  リストは表示順とラベルだけ。dtako の 2 社は別 tenant (27324455 と 75700192) で、
  グループ管理者が両方を 1 画面で見る要件がある (2026-07-25)。
  **★ 全社を見られるのは introspect の `org_wide` が `true` の viewer だけ
  (Refs #1049)。`role: admin` は見ない** — 以前は role だけで全社許可にしていたが、
  「dtako の admin は 1 人だけ」という前提が崩れた (管理者ロールのアカウントが
  複数になった) ため。**role との AND にもしない** (role が変わった時に黙って
  権限が消えるため)。`org_wide` が true でも DTAKO_ACCOUNTS に無い会社は不可
  (ヘッダ偽装対策)。**全社許可は `allowedViewerComps` と `compIdsInSameTenant`
  (comp-map) の 2 か所にある** — 片方だけ絞ると素通りする。
  **★ 受け取り側の fail-closed はこの repo の責任** — 古い auth-worker は
  `org_wide` を返さない (additive)。`isAllCompsViewer` は**真の boolean の `true`
  だけ**を通す (`undefined` / `null` / `1` / **文字列 `"false"`** はすべて false。
  `Boolean(x)` で受けると `"false"` が true になる)

### ★★ テナント越えの正本は auth-worker。**この repo に allowlist を作らない**

**実測 (2026-08-29): dtako の 3 repo に `USER_ACL` / `DEVELOPER_EMAILS` /
`bypass_emails` の言及が 0 件。** 知識が `ippoan/auth-worker` にしか無いので、
**dtako 側だけを見ていると構造的に見えない。だから #1004 と #1049 で 2 回、
「この repo に allowlist を新設する」案が再発明された** (#1049 は実装まで進んで
差し戻し)。**「新しく allowlist を足す」案が出たら、まずここを読むこと。**

| 口 (auth-worker) | 使うか | 中身 |
| --- | --- | --- |
| **`USER_ACL[org]`** | **★ これだけが正本** | `checkOrgAccess` が `TENANT_ACL` と **OR** 合成する側。**tenant が一致しなくてもその人だから通す** = 「テナント境界を越えてよい」そのもの。`/auth/introspect` が `org_wide` (boolean) として返す (ippoan/auth-worker#497) |
| `DEVELOPER_EMAILS` | **使わない** | `admin-html.ts` / `device-setup.ts` に直書き (2 ファイルで重複)。**UI の出し分け専用で認可ではない**と実装に明記がある。**取り違え注意** |
| `APP_TENANT_ACL.bypass_emails` | 使わない | per-app の開発者バックドア。**secret が空だと誰も通らず、本番で全員締め出し**になりうる |

**★ 「ACL 判定を通過したか」から導出しないこと。** 通過は **tenant 一致でも真**に
なるので測りたいものと違ううえ、`checkAppTenant` は **malformed JSON で fail-open**、
`classifyOrigin` は部分一致で**未分類なら無条件 pass**。⇒ 設定ミスのときに
「全社を見てよい」が真に倒れる。判定は **`USER_ACL` に literal に載っているか**だけ
(auth-worker の `isOrgWideUser` がそれ。`matchesOrgAllowlist` は tenant を先に見て
早期 return するので、**両方に載っている人**の email 一致が観測されず流用できない)
- **給与DBからの取り込み** (Refs #367): 社員マスタタブの「給与DBから取り込み」は
  rust-ichibanboshi の identity-only API (`GET /api/kyuyo/employees`、
  ohishi-exp/rust-ichibanboshi#92) を叩き、社員番号・氏名・所属・給与体系だけを
  取る (**金額は API の応答にも含まれない**)。会社ラベルは `KYCOMSTD.CONAME1`。
  dtako 会社ID → 給与大臣の会社コードの対応は D1 `comp_payroll_map`
  (migration 0008) が正で、`GET /restraint-api/comp-map` が**同じ tenant の会社
  だけ**返す。取り込みロジックは `planPayrollDbImport` (pure): 旧ラベル
  ("有"/"株") の行は乗務員CD突合を引き継いで統合、所属/給与体系は取り込む月の
  初日を適用開始日にし**月末時点で同値なら履歴を増やさない** (同値判定は保存側と
  同じ NFKC 正規化を通す — 通さないと全角スペース差で毎回偽差分が出る)。
  所属は表示名 (`SNAME`) に加えて**所属コード (`INCODE`) / 営業所名 (`NAME1`) /
  職種名 (`NAME2`)** も取り込む (rust-ichibanboshi#98、Refs #409)。3 列は任意扱い —
  古い API 版が返さなくても取り込みは落とさず、拠点は表示名から引く
- **社員マスタタブ** (単価マスタの隣、⑥): 一覧 + 氏名/乗務員CD の手直し + 所属・
  給与体系の**適用開始日つき履歴** (`employee_attrs`) の追加/履歴モーダル削除 +
  社員行の削除。単価マスタと同じ作法で**ローカル編集 → 「保存」で確定** (PUT に
  `employees`/`attrs`/`deleteAttrs`/`deleteEmployees` を同送 — worker は
  upsert→削除の順に実行するので同キーは削除が勝つ)
- **月次集計 CSV の `所属(マスタ)`・`給与体系` 列**: 乗務員CD で逆引き
  (`buildDriverAttrIndex`) → **対象月の末日時点**で効いている行 (`resolveAttrsAt`)。
  未突合・未設定は空欄。dtako 由来の `事業所` 列は別ソースなので残す。月次タブでも
  社員マスタを load する (CSV 列が空になるのを避ける)

### 最低賃金は都道府県別 — 拠点は給与大臣の営業所名が正 (Refs #409)

最低賃金は**就業地の都道府県**で決まる。本番の拠点は長崎・佐賀・福岡・大阪・北海道・
広島に散り、令和7年度で最大 147 円開くので全社共通 1 本 (#253) では判定が成立しない。

- **原資**: 厚労省に公式 API は無い (提供は PDF/Excel/HTML のみ)。
  `POST /restraint-api/min-wage/import-mhlw` が `saiteichingin.mhlw.go.jp` の HTML
  テーブルを取り込む (pure パーサ = `min-wage-import.ts`、貼り付けフォールバックあり)
- **拠点 → 都道府県**は R2 `min-wage` の `branchToPrefecture`。**県は推定しない** —
  「本社」が長崎県であるように拠点名から県は決まらないので、必ず画面で選ばせ、
  未設定は未設定のまま警告する (誤った県で判定するより判定しないほうを選ぶ)
- **拠点の正は `employee_attrs.branch_name` (`SHOZOKU.NAME1`)、並びは
  `branch_code` (`SHOZOKU.INCODE`)** (migration 0010)。給与大臣は営業所名と職種名を
  別列で持ち、`SNAME` (`本社　乗務員`) はその結合済み文字列なので割り直す必要が無い。
  以前は `SNAME` を正規化して前方一致でまとめ、並びも営業所名の**文字コード順**
  (`佐賀` U+4F50 < `本社` U+672C) だった
- **表示名からの推定は残してある** (`suggestBranchGroups`、`branch-prefecture.ts`) —
  営業所名を持たない行 (再取り込み前・theearth 事業所名の旧キー) 用。
  `buildBranchGroups` が「営業所名がある行はそのまま / 無い行だけ推定」に振り分ける。
  `resolveBranchPrefecture` の**前方一致自体も残す** (職種が増えても再設定が要らない)
- DO routes: `GET /restraint-api/min-wage/branches` (拠点候補 + 現在の県 + 人数、
  所属コード順)、`POST /restraint-api/min-wage/apply-to-wage-master` (単価マスタへの
  一括設定 = 「単価マスタ = 最低賃金」運用 (#282) の出口。プレビュー→確定の 2 段、
  適用開始日は**厚労省の発効日**で県ごとに違う)
> **上流 kosoku-daily の 時間外深夜 は 時間外 の内数** (Refs #564)。上流
> (rust-ichibanboshi `src/kosoku.rs`) は法定時間外の 1 分を `overtime_minutes` に足し、
> その分が深夜ならさらに `overtime_night_minutes` にも足す。こちら側の型
> (relay `KosokuCalendarPart` / front `KosokuDay`) は **`toPart` /
> `toKosokuDay`・`toKosokuParts` で引いて排他**にしてから持つ — `RestraintSummaryDay` と
> `classifyMonth` が「実働 = 法定内 + 時間外 + 時間外深夜」を前提にしており、内数のまま
> 流すと法定内が二重に引かれ、時間外深夜が 1.25 と 1.5 の両方で払われる。時間外の合計が
> 要る所は `overtimeMinutes + overtimeNightMinutes` で足す。**保存済みサマリを直すには
> 月ごとに「タイムカードを取り込み」が必要**。

- 乗務員 → 拠点は `branchByDriverCdAt` (月末時点の所属)。theearth の事業所名
  (`大石運輸倉庫㈱　本社営業所`) は拠点キーと噛み合わないのでフォールバック扱い

### 給与明細の取得元は 2 つ (貼り付け / 給与DB 直読み、Refs #369)

給与比較タブは**貼り付け CSV と給与DB 直読みを併存**させる (取得元をユーザーが選べる
状態を保つ、#369 決定 4)。`salaryParsed` が両方の `ParsedSalaryCsv` を
`mergeParsedSalaryCsv` で束ねるので、突合・比較計算 (`compareSalaryMonth`) は
どちらから来たかを知らない。

- **給与DB 直読み**: `GET /api/kyuyo/payroll?company=&month=` (rust-ichibanboshi)。
  変換は `payrollToParsedSalary` (`app/utils/kyuyo-fetch.ts`、pure)
- **`payments` だけを使う** — API は `payments`/`deductions` を分けて返す
  (rust-ichibanboshi#94)。以前の `amounts` は支給と控除が混在しており、そのまま
  流すと健康保険料・所得税が支給項目として集計され支給合計が過大になった
- **月は `pay_date` から採る** (支給月)。給与比較は「勤務月の翌月に支給」で突合する
  ため、賃金期間 (`month` パラメータ = 勤務月) ではなく支給日が正しい
- **会社は給与大臣の会社コード** (`payroll.company` をそのまま)。社員マスタの突合キーと
  同じ体系なので変換不要 (Refs #405)
- 単価は `base_rate`/`overtime_rate` (`MEISAI=1` 項目由来、÷100 済み)
- **sessionStorage は `/kyuyo-fetch` と共有**する (`kyuyo-payroll:{会社}:{月}`) —
  一度取れば両画面で使い回せ、キャッシュが二重にならない。1 社 10〜20 秒かかるのは
  給与大臣 PC が古く AUTO_CLOSE で都度 DB を開くためで異常ではない。サーバー側
  `KyuyoLimiter` が同時 1 本なので**直列**で回す
- **アーカイブがある会社はボタン無しで自動表示** (`autoLoadArchivedPayroll`、
  2026-07-28 要望): `GET /api/kyuyo/synced-months` が返す (会社, 勤務月) の組
  (= rust-ichibanboshi の derived store にある = SQLite だけで返せる) と、既に
  sessionStorage にある組だけを、月を選んだ時点で勝手に読む。**OHKEN を開かない組に
  限る**のが肝 — アーカイブが無い会社まで自動で取りに行くと 1 社 10〜20 秒の待ちと
  `KyuyoLimiter` のロックを画面遷移のたびに踏む。無い会社は従来どおりボタンの担当。
  `synced-months` は**会社込みで持つ** (月タブのバッジは会社不問だが、自動読みの
  判定には会社が要る)

### 1 人 = 複数の給与社員CD (N:1、Refs #403)

**乗務員CD (= `employees.driver_cd`) は一番星 `[社員ﾏｽﾀ].社員C` と同一番号体系**で、
非乗務員 (役員・事務員・作業員) にも番号がある (本番実測: 石坂彰 給与1767 →
乗務員CD 1729 = 社員C 1729)。そのため**同一人物が複数の給与会社から支給される**
N:1 が現実に存在する (本番で 5 件、うち社員C 1619 鵜瀬裕一は乗務員)。

- **`buildDriverAttrIndex` は 1 人 → 属性の配列を返す** (`DriverAttrEntry[]`、
  **会社ラベル昇順**)。以前は先勝ちで 1 件に潰していたが、渡される配列は D1 の
  `SELECT` 順 (`ORDER BY` なし) なのでどの会社の値が残るか**不定**だった。
  CSV セルへの落とし込みは `joinDriverAttr(entries, 'branch'|'payScheme')` —
  ` / ` 連結・**同値は 1 つに畳む**ので単一会社の出力は従来と同じ
- **`compareSalaryMonth` は氏名一致の複数会社行を合算する** (`mergeSalaryCsvRows`)。
  支給項目は項目名ごとに合算、`reportedTotal` は全行が値を持つ時だけ合算、
  **単価 (`rates`) は全行同値の時だけ採用** (異なれば null =「単価なし」。按分計算は
  しない)。合算行は `SalaryComparisonRow.mergedFrom` に内訳を持ち、画面に
  「N 社合算」バッジが出る
- **`conflicts` は「氏名不一致」だけ**に用途を限定した (同名別人・登録ミスの疑い)。
  以前は複数会社が同じ乗務員CDに解決されるだけで隔離し、`rows`/`csvOnly` の
  両方から落としていたため**乗務員が最低賃金チェックから消えていた**
- **列は増やしていない** — 社員C 専用列 (`person_cd`) は作らず `driver_cd` を全社員に
  流用する (#403 で案 A 採用、migration なし)。社員マスタタブの列見出しは「社員CD」
  (月次集計・給与比較の「乗務員CD」は dtako 乗務員の意味なのでそのまま)

#### 「一番星から突合」(社員マスタタブ)

未突合行の社員CD を一番星社員ﾏｽﾀから氏名で埋める (`planIchibanMatch`、pure)。
読み取りは `GET /api/employees` (rust-ichibanboshi #74、社員C/社員N/社員R のみ =
**金額は応答に含まれない**)。

- **fetch パスは `/api/ichiban/api/employees`** — proxy の base に `/api` が
  含まれないので**二重に書く**。`/api/ichiban/health` だけは rust 側が root
  ルートなので例外
- **列一覧を `/api/ichiban/api/schema/columns?table=…` で見る手順は、もう通らない**
  (#1015)。この proxy が中継する path は `ICHIBAN_PROXY_ALLOWED_PATHS`
  (`server/utils/ichiban-upstream.ts`) の**完全一致 6 件**に固定してあり、外れは 403。
  列の顔ぶれは **`GET /api/ichiban/api/employees` の応答そのもの**を見るか、上流
  (`ohishi-exp/rust-ichibanboshi`) の該当ハンドラを読む
- **氏名が一意な行だけ**自動で埋める。同名複数・一番星に無しは画面に一覧表示して
  手入力に回す。**既に社員CD が入っている行は上書きしない**
- **番号帯で一番星の行を落としてはいけない** — 9000 番台は拠点 (`9101` 佐賀(営)、
  `9107` 帯広(営)、`9109` 釧路営業所)・法人 (`9102` 佐賀大石、`9997` 大石畜産)・
  集計枠 (`9998` フリー、`9999` 収支用) と**実在社員 (`9001` 加納和広北海大運)** の
  混成。落とすのは `×` 始まりの無効行だけで、**`×` は社員N と社員R で付き方が
  揃っていない** (`9903` は社員N が `×松江隆` で社員R は `松江隆`) ので両方見る
- 一番星社員ﾏｽﾀに**給与コード列は無い**ため突合鍵は氏名だけ。NFKC は異体字を
  統合しないので `鵜瀬/鵜瀨`・`入口六冶/六治` は取りこぼす — **手入力で運用する**
  方針 (#403、件数が増えたら `normalizeNameKey` に対応表を入れる)

| ファイル | 役割 |
|---|---|
| `app/utils/kyuyo-fetch.ts` | 給与DB取得の pure ロジック + `payrollToParsedSalary` (給与比較への変換、100% gate) |
| `app/utils/employee-master.ts` | 型 + `buildCdMapEntries`/`findUnregistered`/`resolveAttrsAt`/`splitCdMapKey` + タブ用 `upsertAttrRow`/`removeAttrRow`/`collectAttrRows`/`buildDriverAttrIndex`/`joinDriverAttr`/`normalizeDriverCdKey`/`sortEmployeeEntries` + 取り込み `planPayrollDbImport`/`planIchibanMatch` + `normalizePayKubun` (pure、100% gate) |
| `workers/dtako-scraper-relay/src/employee-master.ts` | PUT検証・D1文組み立て・月末解決 + `payKubunByDriverCdAt` (pure、100% gate) |

**給与区分 (`pay_kubun`、migration 0013、Refs #429)**: 社員属性が持つ
`SHAIN3.KKUBUN` = **1=月給 / 2=日給 / 3=時給 / 4=その他**。給与比較の「基本給(計算)」が
単価の掛け方を決めるのに使う。**`pay_scheme` (「体系N」= `SHOZOKU.TAIKEI`) とは別物**で、
体系は部署に紐づく軸なので給与区分の判定には使えない — 同じ体系の乗務員でも月給/日給/
時給が混在し、事務員の体系にも時給者がいる (実機調査で確認)。`wage-report` の各行に
`pay_kubun` として載り、社員マスタに無ければ null (= 不明)。

- 対象月は「年セレクタ + 月タブ」(`GET archive/months` でアーカイブ存在月を列挙、
  無い月は薄表示)。サマリ再計算は単月/全月一括 (`POST archive/resummarize?month=`、
  R2 の生 CSV から再計算 — theearth 非依存、**CSV の lastVerifiedAt/確認履歴は
  更新しない**)。一括印刷は月範囲 × 乗務員CD範囲 → 月毎改ページの印刷プレビュー
- 月タブの「高速表示可」バッジ (emerald ドット、Refs #460) は **2 段階** (Refs #543
  followup、案A 2026-07-29): フル = 拘束サマリ同期済み + relay の kintai 上流キャッシュ
  (DO SQLite `upstream_cache`、daily+kosoku 両方) 有り / 弱 (opacity-50) = 同期済みのみ。
  `archive/months` の `kintai_cached_months` が供給元 (`UPSTREAM_CACHE` フラグ off の
  relay は空配列、旧 relay はフィールド無し → front はフル表示に fallback)。判定 pure は
  `fastBadgeState` (`app/utils/restraint-wage-view.ts`)。キャッシュ有りでも上流の版 (etag)
  が動けば miss になるため「速いことが多い」目安表示
- **空状態は必ず言い切る** (Refs #554)。給与比較タブの「比較結果」カードは**常設**で、
  `salaryStatus` computed が `loading-payroll` / `no-payroll` / `no-pay-month` /
  `loading-report` / `no-report` / `ready` を出し分ける。月次集計カードも初回
  (`report === null && loadingReport`) にスピナーを出す — 以前はどちらも
  「カードが無い / 中身が空」で、読み込み中と未取り込みの区別が画面から付かず
  「給与比較が出ない」という報告になった。「読み込み中」と「取り込まれていない」の
  取り違えを防ぐ門が `compMapLoaded` / `kyuyoSyncedLoaded` (会社と給与アーカイブ一覧が
  解決するまでは「無い」と判定しない)
- **このページは theearth を使わない** (Refs #554)。`authHeaders()` は**常に viewer 経路
  (auth-worker JWT)**。theearth セッション必須なのは `login`/`logout`/`report`/`csv` の
  4 経路だけ (`isR2OnlyRestraintPath`) で、このページはどれも呼ばない。以前は theearth
  セッションがあるとそちらを優先しており、**relay が introspect を通らず email が
  届かなかった** — 上流キャッシュを人単位に分けるのにそれが要る
- **kintai 上流キャッシュは email 単位の DO** (`kintai-cache-{sha256(email)}`、Refs #554)。
  経路の DO (`theearth-{会社}:{ユーザー}`) は theearth アカウント単位で、共有アカウント
  運用だと「誰のキャッシュか」が定まらない。中身は月単位の上流データで theearth とは
  無関係なので、認可済みの email で分ける (DO 名に生 email は入れない)。口は
  `UpstreamCacheClient` で、キャッシュ DO 内は `LocalUpstreamCache`、経路 DO 側は
  remote client (`/internal/kintai-cache/*` へ stub fetch)
- **手動 warm** `POST /restraint-api/kintai/warm?month=` (Refs #554)。上流
  (rust-ichibanboshi) をデプロイすると版 (etag) が動いて全月 miss になるため、開く前に
  押しておける口。1 リクエスト 1 ヶ月で、front が**順番に**叩く (並列は上流の kosoku
  同時実行キャップ rust-ichibanboshi#188 と競合する)。cron にしないのはキャッシュが
  人単位で「誰の DO を温めるか」が決められないため
- **`X-Upstream-Cache: hit|miss|live` はヘッダで返す** (Refs #554)。front は miss の時だけ
  「上流の版が変わったため取り直しました」を出す。**本文に入れてはいけない** — hit/miss で
  本文が変わると弱 ETag も動き、#543 PR-5 の 304 が効かなくなる。304 応答にも載せる
  (ブラウザは 304 のヘッダを保存済み応答へマージするため)

| ファイル | 役割 |
|---|---|
| `app/pages/restraint-wage.vue` | 9 タブ UI + 年月タブ + 一括再計算/一括印刷 + 印刷 CSS |
| `app/components/RestraintWageMonthlyTable.vue` | 月次テーブル (単月表示と一括印刷で共用) |
| `app/components/TimecardTable.vue` | タイムカード表 1 人分 (既存 PDF 準拠の列 + 拘束/実働、日曜網掛け、印刷は 3 人横並び)。**拘束は常時表示** — 実働だけだと休憩が引かれているか読めないため (2026-07-28)。休憩・時間外・時間外深夜・深夜は `detailed` (1 人表示) のときだけ |
| `app/utils/timecard-view.ts` | 日別サマリ → タイムカード表の行 + 勤務区分の日数 (pure、100% gate) |
| `app/utils/kosoku-daily.ts` | **ドライバー**の打刻基準日別サマリの受け取り (`GET /restraint-api/kintai/kosoku-daily` → 乗務員CD 引き、pure、100% gate、Refs #472)。ドライバーは打刻を持たないので wage-report の `source === 'timecard'` に出てこない — タイムカード表にドライバーを出すための別経路。**タイムカード表の並び順もここ** (`groupTimecardSheetsByCompany` / `timecardJobGroup`): 給与大臣の会社コード昇順で区切り、中は 事務 → 作業 → 整備 → 乗務 → その他 → 乗務員CD 順 (2026-07-28)。職種は `employee_attrs.job_name` (`SHOZOKU.NAME2`) の**部分一致**で振り分ける — 実測値に `一般事務管理` `作業員点呼者` `乗務員(トレーラ-)` のような表記ゆれがある |
| `app/utils/restraint-wage-view.ts` | 共有型 + WAGE_COLUMNS + 表示ヘルパ |
| `app/utils/salary-compare.ts` | 給与明細 CSV 解析 + 5 区分集計 + 突合 + 37条チェック + `computeSysBase` (給与区分で単価の掛け方を分岐) (pure) |
| `workers/dtako-scraper-relay/src/restraint-wage.ts` | 賃金計算 pure (100% gate) |
| `workers/dtako-scraper-relay/src/theearth-restraint-client.ts` | summary v2 (日別 + 派生指標) |

## 粗利・一番星突合 (`/profit/*`、Refs #330 / #760 / #820)

一番星 (rust-ichibanboshi) の**運転日報明細**を売上として、デジタコの便に突き合わせる区画。
デジタコに積載量が無いので、売上は一番星から取るしかない。

| ページ | 役割 |
|---|---|
| `app/pages/profit/margin.vue` | **粗利 (売上 − 手当 − 経費)**。乗務員別の賃金構成・取引先別・経路・印刷まで全部ここ (Refs #760) |
| `app/pages/profit/allowance.vue` | **運行手当** (デジタコ → 給与)。乗務員 → 運行 → 便 の 3 段。強制突合 (下記) を人が操作するのもここ |
| `app/pages/profit/monthly.vue` | **保存済み検証一覧** (過去に人が確認して保存した**検証スナップショット**のアーカイブ。マッチレベルは保存時に焼き込んだ値)。**車輌×月のマッチ率サマリ (一番星側月計との差額) は #859 で廃止** — 分子だけ凍結し分母が増え続ける誤診を生むため。突合の現況は粗利タブ |
| `app/pages/profit/compare.vue` | 類似運行検索。**一番星をインデックスに使う** (伝票で車番×日を確定してから dtako 運行を引く) |
| `app/pages/operations/[unko_no].vue` | 運行詳細。便ごとの「粗利タブの計上額」を**映すだけ** + `ProfitPanel` + 「伝票から区間を提案」 + **ヘッダの「経路地図」= 粗利タブと同じ `OperationRouteMap` をモーダルで開く** (Refs #873。イベントCSV を使い回すので追加 fetch なし) + NET780 タブの**生データ zip ダウンロード** (R2 の原本をそのまま) |

### ★ 突合は 2 系統ある — 混ぜない (#820 の事故の核心)

同じ運行に**違う伝票・違う金額**を出し得る。**新しい 3 つ目を作らないこと。**

1. **`reconcileVehicles` (`app/utils/allowance-ichiban.ts`) — 粗利タブの月次突合。これが正。**
   **乗務員CD 単位でグループ化するのが既定** (乗務員CD が引けないときだけ車番単位)。
   グループぶんの明細を先に当て、余った便だけ受け皿の車番 (`POOL_VEHICLE = '0001'`) で拾い直す。
   **明細のプールを順に消費する** (`pool = res.poolLeftovers`) ので同じ明細が 2 台に二重計上されない。日付は ±`DATE_SLACK` 日まで許容し、同日同卸地に便が
   複数あれば件数で機械分割する (`split`)。**この金額が粗利・乗務員別・取引先別・印刷に乗る。**
   呼び元は `profit/margin.vue` と `profit/allowance.vue` の 2 つだけ
2. **`ProfitPanel.vue` + `scoreVehicleDailySlips` (`app/utils/ichiban.ts`) — 検証スナップショット。**
   **常に車番のみ・受け皿なし・明細の一意性なし**で候補を出し、人がチェックした伝票を R2 に残す。
   `confirmedAmount` の消費者は **`/profit/monthly` の保存済み一覧の表示だけ** (マッチ率表示は #859 で廃止) — 粗利にも印刷にも波及しない

**「1 車輌・1 月に絞って 1 を回し直す」は不可** (プールの消費順序が変わって粗利タブと違う額が出る)。
運行詳細は突合を 1 行もやらず、粗利タブが別キーに書いた要約 (`app/utils/operation-leg-sales.ts`) を
読むだけにしてある。**2 つ並べるときはラベルを必ず分ける** — 「粗利タブの計上額」と「検証スナップショット」。
一本化の計画は issue #820 (PR-1 = #821 完了)。

> `proposeFromSlips` (`operations/[unko_no].vue`) は**どちらでもない** — 伝票の積地・卸地から
> イベント行の区間を当てる**提案**で、突合結果ではない。既知の穴は issue #822。

### 人が確定する場所も 2 か所

| 何 | どこ | 効く先 |
|---|---|---|
| **強制突合** (降しイベントが無い便に人が明細を結ぶ) | `dtako:allowance:force-match:v1` (localStorage、`app/utils/allowance-force-match.ts`) | **1 にしか効かない。** 運行手当タブで結び、粗利タブが読む |
| **検証スナップショット** (`ProfitSnapshot`) | R2 `profit/{ym}/{車輌CD}/{運行NO}/{segmentId}/latest.json` (+ `v-{ts}.json` / `history.jsonl`) | **2 にしか効かない** |

R2 スナップショットを force-match へ自動移植してはいけない (2 は車番のみ・プールなしで確定して
いるので、1 が別の便に割り当て済みの明細を指しうる = 二重計上)。

### ★ 粗利の集計そのものの版管理 (`margin-summary`、Refs #826)

**人が確定する場所ではない。確定ボタンは無い。** 粗利タブが**再計算するたび**に、いま画面に
出ている集計 (`MarginCache` + `summarizeMargins` の `totals`) を
`POST /api/profit/margin-summary` へ送り、R2 `profit/{ym}/margin-summary/` に
`latest.json` + `v-{ts}.json` + `history.jsonl` で残す。作法は検証スナップショットと同じ
(`putVersionedProfit` の sha256 差分検知)。**内容が同じなら版は増えない**ので、R2 の容量は
「**中身が**変わった回数」ぶんしか伸びない — **「数字が変わった回数」ではない**。形式 2 は
`schemaVersion` と端末の設定の指紋 (`fuelRateOverrides` / `runCostShareMode`) もハッシュ対象
なので、**数字が 1 円も動かなくても版は増える** (本番 2026-07 で 4 項目とも同額の版が 2 本
並んだ実測あり、Refs #886 / #891)。

- **1 (`reconcileVehicles`) の出力を残すだけ。突合は 1 行もやり直さない** — 数字を作り直すと
  画面と版で額が食い違う
- **`codeVersion`** (`v0.0.517` / `unknown`) を `customMetadata` に刻む。**同じ入力でも
  ロジックが変われば数字は動く**ため。ビルド時定数は `nuxt.config.ts` の
  `runtimeConfig.public.codeVersion` (`GITHUB_REF_TYPE === 'tag'` のときだけ値が入る)。
  数字が動かないまま版だけ上がった回は `lastVerifiedCodeVersion` に入り、
  **「その数字を作った版」(`codeVersion`) は上書きしない**
- **localStorage の `dtako:margin:cache:v9` は残す** — R2 が落ちても画面は死なない。
  画面は「追えるのは R2 の版、端末のキャッシュは表示を速くするための写し」と断る
- **保存の成否は必ず画面に出す** (投げっぱなしにしない・だが致命傷にもしない)。
  新しい版なら**版の名前** (`v-20260824T102030`)、増えなかった回は**どの版から
  変わっていないか**、失敗なら「端末のキャッシュだけ」と**失敗と分かる色**で。
  `console.error` だけで済ませると、**履歴に穴が空いたことに誰も気づけない**
- **版の一覧は画面に出ている** (Refs #833)。粗利タブの保存の注記の隣に、`GET /api/profit/
  margin-snapshots?ym=` が返す版を**新しい順**で出す。金額まで出るのは**新しい方から
  `MARGIN_VERSION_BODY_LIMIT` (20) 本**で、それより古いのはラベル (時刻) だけ —
  **省いたことは画面が言う** (黙って切ると「全部出ている」と誤読される)。**「読まなかった」と
  「読めなかった」は別勘定** (`totalsState` / `omitted` と `unreadable`) — 混ぜると異常が正常に
  見える。**金額は 0 に倒さない**。pure は
  `app/utils/margin-versions.ts`。**`history.jsonl` は版の一覧に使わない**
  (行数上限で落ちる / `changed:false` の回も 1 行使う / `versionKey` を持たない)
- **選んだ 2 版の差分も画面に出ている** (Refs #834)。一覧のすぐ下で 旧/新 を選び、
  `GET /api/profit/margin-snapshot?ym=&version=` で**2 版の本文を画面が取って**
  `app/utils/margin-diff.ts` を呼ぶ (**差分のロジックを server route に置かない**)。
  出すのは ① `totals` の 4 項目 ② 運行 (`unkoNo`) の 追加/削除/変更 ③ 開いた運行の便。
  **★ 運行 1 本の `marginYen` は出さない** — この画面は保存された値を引き算するだけで
  粗利を計算し直さないため。**形式 2 の版は `buildOperationMargins` の `overrides`
  (燃費の上書き) と `runCostShareMode` を指紋として持つ** (Refs #886) が、**形式 1 の版には
  無く、そちらは版から運行 1 本の粗利を永久に厳密に再現できない**。運行単位は**生の入力値**
  (`salesYen`/`allowanceYen`/`totalKm`/便数) まで、月全体は保存された実測値で見せる。
  **★ 便は `seq` のまま** — 便数が違えば便ごとの数値は出さず「便数が X → Y」だけ
  (`date`+`originCity`+`destCity` で寄せると往復や同一区間で別の便を誤って対応付ける)。
  **★ `schemaVersion` が違えば比べない**。**★ 版そのものが端末の設定で増えることがある**
  (`marginSummaryHashInput` は `totals` を含み、燃費の上書きは `totals` を動かす) ので、
  粗利が動いた回は**その旨を画面で断る**。
  **★ 根本の解 (版に入力の指紋を残す) は #886 で入った** — `MARGIN_SUMMARY_SCHEMA_VERSION`
  が `2` になり、`fuelRateOverrides` (燃費の上書き) と `runCostShareMode` (運行経費の配分の比)
  が版の本文と `marginSummaryHashInput` の両方に入る。**指紋が付くのはこれから保存される版だけ**
  で、**形式 1 の既存の版には遡って付かない** (端末の localStorage にしか無い値なので原理的に不可)。
  ⇒ **形式 1 と形式 2 は差分にできない** (`schemaVersion` 不一致で `schema-mismatch`)。
  **`margin-diff.ts` はまだ指紋を突き合わせていない** — 差の理由まで言うのは別 PR。
  **副作用が 1 つある**: 配分の比だけを変えて集計し直すと、`totals` は 1 円も動かないのに
  版が 1 本増える (便の内訳は実際に変わっているので、それが正しい)
- **★ 差分の「動いた」は「画面に出る精度」で決める** (Refs #838)。保存された
  `totals.marginYen` は按分が割り算を含むぶん `4467597.000000001` のような浮動小数の尾を持つ
  (**それ自体は正常**。本番 v0.0.526 で実測)。厳密比較 (`delta !== 0`) のままだと
  **合計の足し順が変わるだけのリファクタ**で `9.31e-10` の差が「動いた」になり、表示は円に
  丸まるので**「粗利: ¥0」**と出る。`marginDiffDisplayDelta(unit, before, after)` が
  **単位ごとに丸めてから引く**。
  **★ 3 つの単位を 1 つの丸め方でまとめない** — `yen` は `Math.round`、`km` は
  `Math.round(v*10)/10` (画面の `km()` と同じ)、`count` は**何もしない** (整数しか取らない)。
  距離に金額と同じ `Math.round` を当てると**0.4km の実変化が消える**。
  **★ 「丸めてから引く」であって「差を丸める」ではない** — 後者だと `before=100.4` (画面 `¥100`)
  / `after=100.6` (画面 `¥101`) が `Math.round(0.2)=0` で「動いていない」になり、
  **画面に出ている 2 つの数字は 1 円違うのに差分は動いていないと言う**食い違いが起きる。
  **`before` / `after` は生値のまま返す** (丸めた値に差し替えると検算できない)。
  **★ `marginSummaryHashInput` の丸めは別勘定で、まだ直していない** — 同じ尾の違いで
  **版そのものも 1 本増える** (`totals` をハッシュ対象に含めるため)。ここを安易に丸めると
  **版の本文 (`totals` の生値) とハッシュの対象が食い違い**、「本文は違うのに同じ版」が
  生まれるので、直すなら**別 issue で**。#886 で足した指紋は逆に**本文とハッシュの両方に
  入れてある** — 片方だけに入れると、まさにこの食い違いが起きるため。
- **★ 積み上げ棒の「赤字」も同じ精度で決める** (Refs #840。#838 と**まったく同じ型**)。
  `shareBarOf` (`margin.ts`) / `driverShareBarOf` (`margin-driver-share.ts`) の `costSum` は
  **費用 4 区分をその場で足し直したもの**、比べる相手の売上から出る粗利は
  **運行 1 本ずつ足し込んだもの** — **同じ量を別の足し順で出した 2 つ**なので double では
  一致しない。生の `costSum > salesYen` だと**粗利ちょうど 0 の行**で尾だけの超過を拾い、
  `overflowPct` が `1.1e-14` になって画面の `pct1()` が `0%` に丸め、
  **「赤字 −0%」が赤で出る** (「費用が売上を超えた分」と言っているのに**超えた額は ¥0**)。
  **`costExceedsSalesAtYen(costSum, salesYen)` (`margin.ts` から export) で円に丸めてから比べる。**
  **★ 判定は 1 つの関数に集める** — 取引先別と乗務員別で同じ 1 行が重複していたので、
  片方だけ直すと挙動が割れる。**`margin-diff.ts` は差分専用なので import しない**
  (`marginDiffDisplayDelta` は「単位ごと」の丸めを持つ差分の道具で、棒は円しか要らない)。
  **★ 金額には当てない** — 丸めるのは**比較の 2 値だけ**で、`segments[].yen` にも粗利にも
  1 円も効かない。
  **★ 判定は「厳しくなる」方向にしか動かない (緩む方向ではない — 向きを間違えないこと)。**
  `Math.round` は単調非減少なので `a ≤ b ⟹ round(a) ≤ round(b)`、その対偶が
  `round(a) > round(b) ⟹ a > b` — **丸めた判定は生の判定の部分集合**で、**赤字を新たに出さない**。
  だから `overflow` が true の回は必ず `costSum > salesYen` で、
  `scale` / `overflowPct` の式は**現状のまま**でよい (`overflow` が false → `scale = 1` /
  `overflowPct = 0`)。**逆に true → false に転ぶ行はある** — 転ぶのは**超過が ¥1 未満**の行だけ
  なので `1 − scale < 1 ÷ costSum`、**棒の幅の差は全区分の合計でも `100 ÷ costSum` %pt 未満**
  (売上 ¥100,000 の行で幅 1000px の棒の 0.005px 未満。尾だけの回なら 15 桁目 = `1e-13` px 未満。実測)。
- **★ 同じ欠陥の 2 つ目の出口が `margin.vue` の `yen()` にあった — `¥-0`** (Refs #840)。
  `marginYen = grossMarginYen ?? (salesYen − costSum)` は**どちらの辺も足し順の違う和**なので、
  粗利ちょうど 0 の行では `-4.66e-10` のような**尾つきの負**になる (**それ自体は正常**)。
  `yen()` は `Math.round(v).toLocaleString()` で、**`Math.round` は `-0.5 < v ≤ 0` で `-0` を返し、
  `(-0).toLocaleString()` は `"-0"`** — だから積み上げ棒の title と表の粗利に **`¥-0`** と出ていた。
  **`Math.round(v) + 0` で `+0` に寄せる** (`-0 + 0` は IEEE 754 で `+0`)。
  **★ この癖は `toLocaleString` にしか無い** — テンプレートリテラルの `${-0}` は `"0"` なので、
  隣の `km()` / `pct()` / `pct1()` は無傷 (実測)。**変わるのは `-0.5 < v ≤ 0` の回だけ**で、
  `-0.6` は `Math.round` が `-1` を返すので `¥-1` のまま (本当に −1 円の行は消えない)。
  **`app/pages/operations/[unko_no].vue` の `yen()` も同じ形**だが、#840 の範囲外なので触っていない。

### 保存先 (localStorage キー)

| キー | 中身 | 定義 |
|---|---|---|
| `dtako:margin:cache:v9` | 粗利の集計キャッシュ。**明細は持たない** (量が桁違い、合計だけ畳む) | `app/utils/margin.ts` |
| `dtako:margin:leg-points:v1` | 便の積地・卸地の座標 | `app/utils/margin-rebuild-input.ts` |
| `dtako:profit:uncovered-by-driver:v1` | 乗務員CD → 粗利対象外の便の手当 (旅費の母数) | `app/utils/profit-allowance-base.ts` |
| `dtako:operations:leg-sales:v1` | 便ごとの売上要約 (運行詳細が読むためだけ、Refs #820) | `app/utils/operation-leg-sales.ts` |
| `dtako:allowance:force-match:v1` | 強制突合 (上記) | `app/utils/allowance-force-match.ts` |

`dtako:allowance:{cache,excluded,provisional,pdf,pdf-overpaid,last-search,driver-cds}` / `dtako:margin:{fuel-rate,routeMapLayers,runCostShareMode}` も同じ流儀。
**キーは形を変えるときに番号を上げる** (`MarginCache` の形は変えず別キーを足すのが作法 — 片方が壊れても
もう片方は動く)。**localStorage なので他端末からは空に見える** — 画面でその旨を断ること。

### API

| 口 | 用途 |
|---|---|
| `GET/POST/DELETE /api/profit/snapshot` | 検証スナップショット 1 件の read/write/delete (`PROFIT_R2`、`savedAt` はサーバーが埋める) |
| `POST /api/profit/margin-summary` | **粗利の集計そのもの**の版管理保存 (上記、`savedAt` はサーバー / `codeVersion` は画面が名乗り サーバーが正規化) |
| `GET /api/profit/snapshots?ym=&vehicle=&limit=` | スナップショット一覧 (`SnapshotListItem`) |
| `GET /api/profit/margin-snapshots?ym=` | **粗利の集計の版**の一覧 (`v-*.json` だけ・新しい順。金額は新しい方 20 本ぶんだけ・`head()` は叩かない) |
| `GET /api/profit/margin-snapshot?ym=&version=` | **粗利の集計の版 1 本の本文** (差分ビューが 2 回叩く。**差分のロジックは持たない**。キーはクエリで受けず `marginR2Paths` で組み直す) |
| `GET /api/ichiban/api/sales/vehicle-daily` | 一番星 売上明細 (proxy 経由、client 側も `api/` を含めて呼ぶ) |
| `GET /api/ichiban/api/costs/vehicle-daily` | 一番星 経費明細 (給与・燃料等)。**`limit` 未指定だと上流が 500 件で切る** |

R2 binding は `PROFIT_R2` → `dtako-ichiban-verify` (staging/preview は `-staging`)。

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

   > **`DTAKO_ACCOUNTS` は KV (`dtako-relay-config` の `dtako_accounts`) が正**
   > (Refs #367)。dashboard の plain 変数は `keep_vars = true` があっても本番から
   > 消えた実績があり (2026-07-25)、消えると `viewerCompIdsForTenant` が
   > fail-closed になって **/restraint-api/* が全会社 401** (画面には
   > 「セッションが無効か期限切れです」としか出ない) + dtako cron も skip する。
   > 解決順は KV → 従来 binding のフォールバック (`resolveDtakoAccountsRaw`)、
   > 空なら DO が `dtako_accounts: "missing"` を console.error する。
   > **投入は 1 回だけで CI は書かない** — CI は存在検証で deploy を落とす。
   >
   > **D1 migration (`migrations/`) もこの workflow が適用する** — 詳細は上の
   > 「D1 binding と migration」節 (trigger paths に `migrations/**` /
   > `scripts/d1/**` を含む、Refs #367)。
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

### 取り込みのあとに CSV 分割をやり直す (Refs ohishi-exp/rust-ichibanboshi#205 の 40)

**取り込みが成功しても CSV 分割が失敗すると、その運行は静かに消える。** alc の
`dtako_operations.has_kudgivt` は「この運行の CSV が R2 に split 済みか」を表す列で、
**読み取り側 3 クエリが全部 `has_kudgivt = TRUE` で絞っている**
(`crates/alc-dtako/src/repo/dtako_y_time_export.rs` の `list_operations` /
`list_drivers_with_operations` / `list_operations_for_drivers`。`GET
/api/dtako/events/etags` だけでなく `GET /api/dtako/events` も同じ repo)。一方
`process_zip` は運行行を作り直すが `insert_operation` の列に `has_kudgivt` が無いので
**アップロードのたびに `DEFAULT FALSE` に戻る**。TRUE に戻すのは split の成功だけ。
⇒ split が失敗すると**入力からも欠け検知の母集団からも同時に消える**
(2026-07-31 に実際に発生: 乗務員 1652 の運行 `2607011001540000003510` が残り、
alc の運行数が 1130 → 1129 に減った)。

- alc は取り込み自体は成功させたまま失敗件数を `POST /api/upload` 応答の
  **`split_failed`** に載せる (ippoan/rust-alc-api#586)。relay は
  `parseAlcUploadResponse` で拾い、**WS `result` の構造化フィールド**
  (`upload_id` / `operations_count` / `split_failed`) として front に渡す。
  `status` は `success` のまま — 取り込みと分割は**別建て**で見せる
- `app/pages/scraper.vue` が `split_failed > 0` を見て
  **`POST /api/proxy/api/split-csv/{upload_id}` を自動で叩き直す**。この口は
  **冪等** (R2 から ZIP を取り直して同じ key に PUT 上書き)、**件数上限なし**、
  **呼び手のテナントで絞られない** (tenant は upload レコードから引く =
  `repo/dtako_upload.rs` の `get_upload_tenant_and_key` が `WHERE id = $1` のみ)
- **`split-csv-all` は自動には使わない** — テナント絞り
  (`list_uploads_needing_split(tenant_id)`) なので `全企業` スクレイプの片方
  (別 tenant) を掃えず、かつ **1 回 50 件で切る** (`SPLIT_CSV_ALL_LIMIT`)。
  `/scraper` の「未分割をまとめて分割」ボタン (手動) から呼び、`done` の
  `candidates / success / failed / **skipped**` をそのまま画面に出す
- **relay DO からは分割を呼べない** — auth-worker `/alc-internal-proxy` の path
  allowlist (`classifyInternalPath`) に `/api/upload` はあるが `/api/split-csv/*`
  は無い (403)。よって **cron 実行分は自動リトライされない** — cron は
  `split_failed > 0` を `console.error` で鳴らすだけなので、**診断は Tail Worker の
  Observability を見て、復旧は管理画面から**行う
- **`split_failed === 0` は「分割済み」の十分条件ではない**。alc の
  `update_has_kudgivt` が当たらなかった unko_no は `tracing::warn!` されるだけで
  `Ok(0)` が返る (R2 側は trim しない生文字列 / DB 側は trim 済みのキーずれ)。
  よって `/scraper` は**取り込みの後に必ず答え合わせをする** —
  `GET /api/dtako/events/etags` (`getDtakoEventsEtags`) の **`unsplit_total`**
  (= `has_kudgivt = FALSE` の実数、rust-alc-api#587) を取り、0 でなければ赤字で出す。
  2026-07-31 に消えた 1 件に気づけたのはこの値であって `split_failed` ではなかった。
  期間上限は alc 側 `MAX_RANGE_DAYS_ETAGS` = **40 日** (超えたら問い合わせず、
  「省略した」と画面に出す)。**この数はログイン中のテナントぶんだけ**なので、
  0 件表示にも必ずその但し書きを付ける (`formatUnsplitTotal`)
- ⚠️ **自動リトライは「`split-csv/{id}` が呼び手のテナントで絞られない」ことに
  依存している。** dtako の 2 社は別テナントで、`全企業` スクレイプはログイン中の
  管理者と無関係な comp も回すため。**将来 alc がこの口をテナント絞りにしたら、
  別テナントぶんの自動リトライは黙って効かなくなる** — その時は relay DO 側から
  内部経路で呼ぶ等に作り替えること (#205 監督が別途起票予定、2026-07-31)

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `workers/dtako-scraper-relay/src/theearth-client.ts` | ブラウザレス HTTP クライアント (cookie jar / VIEWSTATE 抽出 / 2段階 CSV POST / ZIP magic assert) |
| `workers/dtako-scraper-relay/src/alc-internal-upload.ts` | `AUTH_WORKER` service binding 経由の rust-alc-api 自動アップロード (`/alc-internal-proxy/api/upload`、multipart body 手組み) |
| `workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts` | `DtakoScraperRelayDO`。`SCRAPER_MODE` で vpc-relay / http を分岐、comp_id 単位の直列化キュー、アップロード進捗の WS 配信 |
| `workers/dtako-scraper-relay/src/index.ts` | `comp_id` (http 用) / `session` (vpc-relay 用) で DO へ routing、`/scraper-zip/*` 転送 |
| `worker/index.ts` | app 本体の entry。`/ws/scraper` と `/scraper-zip/*` を SCRAPER_RELAY service binding に転送 |
| `app/utils/api.ts` | `triggerScrapeStream()` / `buildScraperZipUrl()` |

## RemoteApp ビューア (`/remote-app`、Refs #693)

社内 RDS の RemoteApp をブラウザの中で描画する。RDP を喋るのは WASM
(`@devolutions/iron-remote-desktop{,-rdp}`)、その先は**オンプレの中継**
(`ohishi-exp/rust-ichibanboshi` の `src/bin/rdp_relay.rs`) が RDS との TLS を張る。

```
ブラウザ ──wss──> rdp.ippoan.org (Cloudflare Access)
                 → localTunnel → 中継 (Cf-Access-Jwt-Assertion を JWKS 検証)
                 → RDS:3389
```

**Worker は経路に居ない。** 旧 `/ws/rdp` (app worker → service binding → relay worker →
Workers VPC binding) は #705 で撤去済み。中継が `--auth cf-access` で動く以上、Worker 経由では
`Cf-Access-Jwt-Assertion` を付けられず 401 になるため、残しても切り戻し先にならない
(戻すなら中継を `--auth vpc` にする側の判断が先)。

### `new WebSocket()` は 302 を辿れない — 接続前に Access の cookie を確保する

cookie (`CF_Authorization`) が無いまま `wss://…/rdp` を開くと、Access のリダイレクトを
WebSocket が処理できず**理由の分からない接続失敗**になる。`app/utils/rdp-access.ts` が:

1. `/rdp` へ WebSocket を 1 本張って `open` が来るかで cookie の有無を測る
   (**`fetch` では測れない** — 中継の `/health` は CORS ヘッダを持たず、Access も
   preflight を 403 で落とすので、認証済みでも cross-origin fetch は失敗しうる。
   「失敗 = 未ログイン」と読めない)
2. 無ければ `/health` を**別窓で開いて** Access を通し (auth-worker の OIDC surface が
   既存 `logi_auth_token` セッションで無言に通す)、1 秒間隔で測り直す
3. 通ったら窓を閉じて本接続

`window.open` は**クリック直後**にしか通らない (transient activation) ので、`connect()` の
先頭で await する。probe の制限時間を 4 秒に抑えてあるのはこのため。

**中継のログに `WARN 中継セッション異常終了: ハンドシェイク前に切断された` が毎回出るのは
この probe の跡**で、障害ではない。

### 配置先ごとの値は画面に持たない (`/defaults`)

宛先・ドメイン・RemoteApp のエイリアスは**中継の `/defaults`** が配る (権威は中継の
`--allow` と site の env `/etc/ichibanboshi/rdp-relay.env`)。画面に入力欄は無い —
打てるようにすると中継の allowlist とズレて「許可されていない宛先」で黙って閉じられる。
**返ってきた値は空も含めて丸ごと採る** (欄が無い以上「空のときだけ入れる」だと、env で
`||ALIAS` を消してフルデスクトップに戻しても localStorage の古い値が生き続ける)。
読めなければ前回値 (localStorage) で繋ぎ、それも無ければ
「中継から接続先を取得できませんでした (/defaults)」で止める。

パスワードは**このアプリが持たない** — 接続が通った時点で Credential Management API に
預け、保存するかは利用者が決める (`app/utils/browser-credentials.ts`)。SPA は submit しても
遷移しないので、ブラウザ任せでは保存が提案されない。入力欄の `name`/`id` も保存と
autofill の手がかりとして要る。

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `app/pages/remote-app.vue` | 画面。入力欄は ユーザー名 / パスワード だけ |
| `app/utils/rdp-access.ts` | URL 組み立て / cookie の疎通確認 / ログイン窓 / `/defaults` 読み取り (`coverage_100.toml` 登録済み) |
| `app/utils/browser-credentials.ts` | パスワードマネージャへの受け渡し |
| `wrangler.toml` `[vars]` | `NUXT_PUBLIC_RDP_RELAY_URL = "wss://rdp.ippoan.org"` (全 env 共通。`runtimeConfig.public.rdpRelayUrl`) |
| `vendor/iron-remote-desktop-rdp/` | WASM クライアント (vendoring) |

中継側 (bin / systemd / env / Access アプリ) は `rust-ichibanboshi-map` skill を見る。


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
- **`riyouMonth{N}` (利用月選択) checkbox はページ既定のチェック状態を信用せず、
  `now` (JST) から計算した今月の value (`YYYYMM`) だけを明示選択し直す**
  (2026-07-04 実害確認、2 段階で修正)。検索条件フォームの「全選択」相当ロジック
  (`submitSearch()`) は元々全 checkbox を無差別に選択しており、カード選択等とは
  別に **利用月ごとの checkbox (`riyouMonth1`/`riyouMonth2`/...)** も無差別選択の
  対象に含めてしまい、1回のスクレイプで数ヶ月〜1年超分の明細が一括取得される
  実害があった (25/04〜26/06 の 14 ヶ月分が 1 CSV に混入)。
  1回目の修正 (「全選択」の対象から riyouMonth を除外し、ページ既定のチェック
  状態だけで送る) は **不十分だった** — ページ既定でチェックされているのは
  「検索対象月 (直近月)」ではなく、実機では 2025/4 のような古い/未確定分が
  デフォルトでチェックされていることが確認され、deploy 後の再検証でも古い
  データが返り続けた。最終的に、ページの初期状態に依存せず
  `RIYOU_MONTH_CHECKBOX_PATTERN` (`/^riyouMonth\d+$/`) に一致する checkbox は
  一旦 `form.fields` から削除してから、`now` (JST) の年月 (`YYYYMM`) と value が
  一致する checkbox だけを明示的に選択し直す方式に変更した (`submitSearch()` に
  `now: Date` を必須引数で追加、`scrapeEtcCsv`/`scrapeEtcFromCookies` からも
  貫通)。実際の checkbox 構造 (name/value/ページ既定チェック状態) は
  Cloudflare Workers Observability に出る診断 log (`etc_debug: "riyouMonth"`)
  で都度確認できる。
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
| `workers/dtako-scraper-relay-tail/src/index.ts` | Tail Worker。producer の `ctx.waitUntil()` 内ログを転写 (下記 gotcha 参照) |

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

**追記 (2026-07-04、下の節で検証済み)**: `wrangler deploy --temporary` の temp
worker (Cloudflare Workers egress) から cookie 委譲を実行したところ、**セッション
拒否は再現せず** login をスキップして検索ページ遷移まで到達した。「IP バインディング
でセッション拒否される」という推測は誤りで、**原因は CCoW コンテナの node/curl
client 固有のもの** (TLS fingerprint 等、`verify-etc.ts` の node/bun fetch TLS
handshake 失敗と同系統の可能性) だったと考えられる。cookie 委譲自体は禁止する
理由が無く、Worker 経由なら安全に使える。詳細は次節。

### ETC の cookie 委譲 + `wrangler deploy --temporary` 検証 — Worker egress では成功、原因は node/curl (client) 固有と確定 (2026-07-04)

上の「CCoW コンテナ (node/curl) から直接試したら実害が出た」節の**核心的な追加検証結果**。
`scripts/verify-etc-worker/` を **credential 前提から cookie 受け取り前提に書き換え**、
実際に cdp-relay 経由で cookie 委譲 + temp worker 検証を最後まで実行した:

1. cdp-relay `browser_cookies(session, ["https://www2.etc-meisai.jp"])` → `cookies_url`
2. `wrangler deploy --temporary` した `verify-etc-cookie-test` (この worker、credential
   不要・`--var` 無し) の `POST /verify` に `{cookies, startUrl}` を送る
3. worker が **Cloudflare Workers 自身の egress** で `scrapeEtcFromCookies` を実行

**結果: login をスキップしてセッションが認識され、検索ページ遷移まで到達した**
(`steps: ["login", "search"]`)。CCoW node/curl で起きた「サーバーがセッションを
認識せずログインフォームに戻す」現象は **Worker egress からは再現しなかった**。
これにより「IP バインディングでセッション拒否される」という推測は **client
(CCoW コンテナの node/curl 固有の何か — TLS fingerprint 等) が原因であり、
Cloudflare Workers からの fetch は正常に cookie セッションを引き継げる」ことが
実証された。cookie 委譲自体は禁止する理由が無く、**Worker 経由なら安全に使える**。

最終的に到達したエラーは全く別種 (`「検索条件の指定」リンクが見つかりません`、
`navigateToSearchPage` 内) — 起点ページ (`funccode=1013000000&nextfunc=1013000000`)
の HTML 構造がコードの想定 (`検索条件`/`利用明細検索` を含むリンクテキスト) と
一致しない、page-parsing 側の実装課題。セッション拒否ではなく、cookie 委譲の
安全性とは独立した別 issue として今後対応する。

#### 検証手順 (再現用)

`scripts/verify-etc-worker/index.ts` は credential ではなく **cookie を POST body で
受け取る**設計 (`--var` 不要、`wrangler.toml` にも書かない):

```sh
cd workers/dtako-scraper-relay
npx wrangler deploy --temporary --config scripts/verify-etc-worker/wrangler.toml \
  --name verify-etc-<好きな名前>
```

- `GET  /`       … health
- `POST /verify` … body (JSON) `{ cookies: EtcCookie[], startUrl: string }`、
  または form-urlencoded (`payload=<同 JSON を文字列化したもの>`)

**JS challenge の突破は「form POST (top-level navigation)」でしか成立しない**
(重要、実機確認済み):

- `curl` / ブラウザの `fetch()` (XHR) は POST でも **workers.dev の Cloudflare
  bot 対策 (JS challenge) に阻まれ 403** (temp worker の workers.dev サブドメインは
  claim されるまで managed challenge の対象)
- 実ブラウザの **top-level navigation (GET でも form POST でも)** は challenge を
  自動突破する (`cf_clearance` cookie が発行され、以後の同オリジンアクセスに効く)
- よって「cookie 委譲」自体の cookie 値も、**ブラウザの JS 実行内で完結させ、
  Claude の tool call param には一切載せない**手順を踏む:
  1. `browser_navigate(session, "https://cdp-relay.ippoan.org/")` などで
     cdp-relay と同一オリジンのページを開く (cdp-relay の `/shot/{session}/{id}`
     に直接 `browser_navigate` すると `Content-Disposition` でファイル DL 扱いに
     なり画面遷移しない点に注意 — 必ず別ページを経由してから同一オリジン `fetch()`
     で `/shot/...` を叩く)
  2. `browser_cookies` で新規 `cookies_url` を発行 (**cookies_url は 1 回読むと
     消費される** — curl で一度 GET したものを後でブラウザからも読もうとすると
     空/別内容になる。ブラウザで消費する分は curl で先読みしないこと)
  3. `browser_eval` で同一オリジン `fetch("/shot/{session}/{id}")` → cookies 取得
     → `<form method=POST action="https://<worker>.workers.dev/verify">` を
     動的に組み立て `hidden` field `payload` に `JSON.stringify({cookies, startUrl})`
     を積んで `form.submit()` (= navigation)。この eval 式自体には cookie 値を
     一切埋め込まない (ページ内で取得した値をそのまま使うだけ)
  4. 結果は `POST /verify` 遷移後のページとして返る。`browser_eval(session,
     "document.body.innerText")` で読む (curl では challenge に阻まれ読めない)

- `scripts/verify-etc-worker/index.ts` — `/` (health) `/verify` (JSON body または
  form-urlencoded `payload` を受理) の薄い Worker。
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

### staging の Workers Logs (console.log) が全く出ない — `[env.staging.observability]` 未宣言が原因 (2026-07-04)

`workers/dtako-scraper-relay/wrangler.toml` は top-level に `[observability]
enabled = true` を持つが、**named environment (`env.staging`) は top-level
`[observability]` を継承しない** (`keep_vars`/`[env.staging.triggers]` と同種の
wrangler の罠)。これが無いと staging では `console.log()` が一切キャプチャされず
(Workers Logs 機能自体が無効)、Cloudflare dashboard の Observability には
request/websocket のライフサイクルイベント (自動計装、`[observability]` 設定と
無関係に常時出る) だけが見え、コード内の診断 log (例: ETC の `riyouMonth` 診断ログ)
は永久に見えない。`[env.staging.observability] enabled = true` を明示的に追加して
解消した。**named environment を追加する時は `[observability]`/`[triggers]`/
`keep_vars` 系の top-level singular block を全て個別に再宣言する必要がある**
(wrangler は配列 binding だけでなく単一 block も継承しない)。

### `ctx.waitUntil()` 内のログは Workers Logs に出ない — Tail Worker (`dtako-scraper-relay-tail`) で拾う (2026-07-04)

上の `[env.staging.observability]` 修正を deploy して実機で ETC スクレイプを
再実行しても、`riyouMonth` 診断ログは依然として Cloudflare Observability に
一切出なかった (API (`cf_logging` MCP) で生データを直接確認しても同様)。

原因は `[observability] enabled = true` とは別の話で、**ETC スクレイプの実処理が
`ctx.waitUntil()` で継続するバックグラウンド処理 (`executeEtcScrapeAll` →
`performEtcScrape` → `submitSearch`) の中にある**こと。Cloudflare 公式ドキュメント
(Context (ctx) API) も「`waitUntil()` でログや例外を出す場合は Tail Worker を
使うこと」を明示的に推奨しており、通常の Workers Logs は `waitUntil()` 内のログを
確実には拾わない。

対策として **`workers/dtako-scraper-relay-tail/`** という薄い Tail Worker を新設し、
producer 側 (`workers/dtako-scraper-relay/wrangler.toml`) の `[[tail_consumers]]`
(本番) / `[[env.staging.tail_consumers]]` (staging、top-level を継承しないので
個別宣言必須、上の gotcha と同型) から参照する。Tail Worker は producer から届く
`TraceItem[]` の `logs`/`exceptions` をそのまま自分自身の `console.log`/
`console.error` に転写するだけ (加工・保存なし)。Tail Worker 自身の `tail()` は
`waitUntil()` に埋もれない通常の invocation なので、ここで出した console.log は
Tail Worker 自身 (`nuxt-dtako-admin-scraper-relay-tail[-staging]`) の Workers Logs
に確実に記録される。**診断ログを見る時は producer ではなく Tail Worker 側の
Observability を見ること。**

### `ctx.waitUntil()` の二重ネストは内側の完了を保証しない — NET780 D1 upsert が消える実害 (2026-07-19)

NET780 保存 (`saveNet780ToR2`、Refs #299) は `handleNet780Download` から
`this.ctx.waitUntil(this.saveNet780ToR2(...))` として呼ばれる非同期処理だが、
その内部でさらに D1 書き込み (`upsertNet780Catalog`) を
`this.ctx.waitUntil(this.upsertNet780Catalog(...))` と**二重にネストして**
waitUntil していた。実機検証で、R2 書き込み (`await` で直列化済み) は毎回
成功するのに **D1 (`dtako_uploads`) には対象 operation_no の行が一切作られない**
という実害が発生した (`/operations/{unko_no}` の NET780 タブが保存後もずっと
「まだアーカイブされていません」のまま)。

外側の `saveNet780ToR2` の Promise が resolve した時点で、内側の
`upsertNet780Catalog` の waitUntil 登録がまだ完了保証されないタイミング競合が
原因と見られる (確証は D1 に直接クエリして「R2 にはあるが D1 に無い」不整合を
確認した実機観測ベース)。**同一 event context 内で `waitUntil` の中からさらに
`waitUntil` を呼ぶ場合、内側の完了を外側の Promise が待つとは限らない** —
内側の非同期処理を確実に完了させたいなら `await` で直列化し、外側の
`waitUntil` 1 箇所だけに任せること。`upsertNet780Catalog` 自体は内部で
try/catch して呼び出し元に例外を伝播させない (best-effort) ので、
`await this.upsertNet780Catalog(...)` に変えても失敗時の応答への影響は無い。

### H3 (Nitro) ハンドラで生の ArrayBuffer を return すると `{}` (2 バイト) にシリアライズされる — `Buffer.from()` でラップ必須 (2026-07-19)

`server/api/net780/by-operation.get.ts` (D1/R2 に直接アクセスして NET780 ZIP を
返す Nitro route、上の D1 upsert 修正の直後に実機検証中に発覚) が
`return await obj.arrayBuffer()` としていたところ、実際のレスポンスが
ちょうど2バイトの `{}` になり、フロント側の net780-wasm が
`"Corrupted zip"` エラーで落ちた。H3 のハンドラが返した値がバイナリ
(Buffer/ReadableStream) と認識されないと、デフォルトの JSON serializer に
渡り `ArrayBuffer` はプレーンオブジェクトとして `JSON.stringify` され
`{}` になる (TypedArray/ArrayBuffer の既知の挙動)。**Nitro route から
バイナリ応答を返す時は必ず `Buffer.from(arrayBuffer)` でラップすること** —
`Content-Type` ヘッダを正しく設定していても、body 自体が JSON
シリアライズされる問題は防げない。同種のパターンを他の Nitro route
(`y-time-export.post.ts` 等) に書く時も要注意。

## テスト

- ユニット: `npm test` (Vitest、happy-dom)
- カバレッジ目標: `coverage_100.toml` で管理
- `workers/dtako-scraper-relay/` は親と別の `vitest.config.ts` を持つ (bespoke deploy
  pipeline、pure ロジック [`auth-decision.ts`/`theearth-client.ts`] のみ 100% gate。
  DO/index.ts は cloudflare runtime 依存で node vitest 計測不可)

## CI の npm cache (2026-07-04 汚染事故と修正)

`test.yml` / `preview-deploy.yml` の npm install が毎回フルダウンロードで
遅かった原因は、`ippoan/cap-catalog#5` (ts/js extractor) が未実装で npm
install を一切行わないにもかかわらず `cap-catalog-extract.yml` が同じ
lockfile hash ベースの `cache: npm` key を持っていたこと。npm install しない
job が真っ先に完走してほぼ空の cache (~682B) を save し続け、フル install
する test.yml / preview-deploy.yml 側は常にこの毒キャッシュを踏んでいた
(cache hit するが中身が空、Refs #134)。

- 汚染源自体は `ippoan/ci-workflows#152` で修正済み (ts/js extractor path
  から `cache: npm` を除去)。
- 既存の毒キャッシュは `actions/cache` が「hit した run は再保存しない」
  仕様のため lockfile が変わるまで居座る。`cache_dependency_path` に
  workflow ファイル自身も含めて hash を強制的に変える cache-busting を
  `test.yml` / `preview-deploy.yml` 両方に適用済み (#154)。
- 効果: `npm install` が preview deploy で 24s → 15s に短縮 (実測)。

同種の cache 汚染は `catalog-extract.yml` を ts/js で使う他 repo でも
起きていた可能性がある (`ci-workflows#152` 適用で今後は防止される)。

### node_modules cache (ci-workflows#154/#155)

npm cache (tarball) とは別に、`frontend-ci.yml` 側に node_modules ディレクトリ
そのものの cache (`actions/cache/restore` + `save`、key prefix `nm-frontend-ci-`)
が追加された (ippoan/ci-workflows#154)。

- 当初実装は restore/save 両方で `hashFiles()` を都度評価しており、
  `install_command: 'npm install'` の caller では install 中に
  `package-lock.json` が書き換わって restore 時と save 時で hash が食い違い、
  save した key を次回 restore で永久に引けないバグがあった
  (ippoan/ci-workflows#155 で修正: hash は checkout 直後・install 前の
  `Compute node_modules cache key` step で 1 点計算し、restore/save が同じ
  output を参照する)。
- **この repo の `cache_dependency_path` は `.github/workflows/test.yml`
  自身を含む**ため、test.yml を編集する PR は node_modules cache key も
  自分で busting する (毒 cache 対策 #134 の副作用)。cache の挙動検証を
  するときは test.yml 以外のファイルで commit を作ること。
- 修正後の実測 (2026-07-06, PR #160): 同一 PR の run 1 で miss + save
  (126.7MB、並列 3 job 中 1 job が save、他は reserve 競合で fail するが無害)、
  run 2 で restore/save 同一 key の hit を確認。`npm install` は
  15.5〜16.8s (miss) → 7.5〜9.5s (hit) に短縮。draft PR での検証は
  PR self-warm のみ — main warm (新規 PR の初回 run から hit) は merge 後の
  main push run が save して初めて効く。

## 並行開発 (worktree)

- 必ず `origin/main` ベース worktree を使う
- `/wt-quick` で Cloudflare Quick Tunnel + auth-skip 起動可能
- backend と同期改修する場合は同じ wt-name で揃えると `--incus-backend` が auto-pair する
  (`~/rust/rust-alc-api/CLAUDE.md` の Backend + Frontend 同時改修ワークフロー参照)
