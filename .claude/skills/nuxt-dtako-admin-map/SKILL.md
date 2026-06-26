---
name: nuxt-dtako-admin-map
generated-from: nuxt-dtako-admin:106669aaa25ddb157c02da465d3d5757a7863b6e
paths: [app/, server/]
description: ippoan/nuxt-dtako-admin (dtako デジタコ運行データ管理画面、Nuxt 4 + Cloudflare Workers) の構造ナビゲーション。rust-alc-api を直 fetch する frontend と、R2 binding が要る Y時間 Excel export の server route 配置を 1 枚にまとめる。トリガー:「dtako」「nuxt-dtako-admin」「Y時間 export」「y-time-export」「vehicle-settings」「DTAKO_R2」「運行データ」「dtako.ippoan.org」等。
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
| **pages (運行系)** | `app/pages/{index,upload,scraper}.vue` `operations/{index,[unko_no]}.vue` | 運行一覧 / アップロード / スクレイパ / 運行詳細 |
| **pages (時間集計)** | `app/pages/{daily-hours/index,restraint-compare,restraint-report,y-time-export}.vue` | 日別時間 / 拘束時間 比較・レポート / Y時間 export UI |
| **pages (車両設定)** | `app/pages/vehicle-settings/{index,diff,history,unconfirmed}.vue` | デジタコ車両設定の閲覧・差分・履歴・未確認 |
| **pages (管理/認証)** | `app/pages/{members,api-tokens,event-classifications,login}.vue` `auth/callback.vue` | メンバ / API トークン / イベント分類 / login |
| **components** | `app/components/Event*.vue` `VehicleSettings*.vue` `CsvDataTable.vue` `DriverSearchSelect.vue` | イベント表 / 車両設定 表示・diff / CSV テーブル |
| **server/api (proxy)** | `server/api/proxy/[...path].ts` `server/utils/identity.ts` | `/api/proxy/*` → introspect 検証 → identity 注入 → rust-alc-api `/api/*` (createIdentityProxyHandler、#434 step 2)。identity.ts は R2 が要る route 用の introspect+注入ヘルパ |
| **server/api (Y時間)** | `server/api/y-time-export.post.ts` `y-time-template.{get,put}.ts` | backend GET→R2 テンプレ→ExcelJS xlsx 生成 (R2 が要るので Worker 側)。backend GET は resolveIdentityHeaders で introspect 注入 |
| **server/api (車両設定)** | `server/api/vehicle-settings/{extract.post,history.get,object.get,unconfirmed.get}.ts` | 車両設定 抽出・履歴・取得。unconfirmed は backend `/api/dtako/vehicles` を introspect 注入で叩く |
| **utils** | `app/utils/{api,event-data-table,y-time-xlsx,vehicle-settings-*}.ts` | API ラッパ / 表整形 / JSZip writer / 車両設定 cfg・diff・labels |
| **middleware** | `app/middleware/auth.global.ts` | 全 page の JWT gate |

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

## CCoW / CI から見た立ち位置

- consumer 側。`@ippoan/auth-client` (`dev` dist-tag、createIdentityProxyHandler/server を取るため) で JWT 発行/refresh。**rust-alc-api 直叩きはやめ `/api/proxy` 経由**にした (#434 step 2)。proxy が auth-worker introspect で検証し X-Tenant-ID + X-User-* を注入する (rust-alc-api#441 で backend は JWT 検証を撤去し注入 identity を信頼)。`api.ts` の route 文字列は不変 (proxy の pathPrefix='/' で `/api/proxy/api/*` → backend `/api/*`)。integration test (api.test.ts) は backend を直叩きするため tenantIdGetter (X-Tenant-ID) を引き続き使う。
- test.yml は `use_auth_client_dev: true` で PR 時に `@ippoan/auth-client@dev` を overlay install (createIdentityProxyHandler 取得)。
- `/wt-quick` で Cloudflare Quick Tunnel + auth-skip 起動可。backend 同期改修は同 wt-name で `--incus-backend` auto-pair。

## 関連 skill

- `auth-worker-map` — JWT 発行元 (`@ippoan/auth-client` の認証先)
- `nuxt-vitest` — composable/utils のテスト (`coverage_100.toml` で 100% 管理)
- `cross-repo-symbol-index` `ippoan-infra-map` — 横断 symbol / 基盤地図
