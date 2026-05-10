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
  │ 1. backend (rust-alc-api) GET /api/dtako/y-time-export を JWT forward で叩く
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

## テスト

- ユニット: `npm test` (Vitest、happy-dom)
- カバレッジ目標: `coverage_100.toml` で管理

## 並行開発 (worktree)

- 必ず `origin/main` ベース worktree を使う
- `/wt-quick` で Cloudflare Quick Tunnel + auth-skip 起動可能
- backend と同期改修する場合は同じ wt-name で揃えると `--incus-backend` が auto-pair する
  (`~/rust/rust-alc-api/CLAUDE.md` の Backend + Frontend 同時改修ワークフロー参照)
