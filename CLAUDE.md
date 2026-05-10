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
| `NUXT_PUBLIC_REALTIME_BUS_URL` | notify-realtime-bus Worker (`wss://realtime.notify.ippoan.org`)。Y時間 export async job の WS 完了通知用。空文字なら同期 GET にフォールバック |

## R2 binding

- `DTAKO_R2` → `dtako-uploads` バケット — Y時間 テンプレ xlsx の配置先 (`templates/...`)。
  本番 / staging 共用 (read-only)。

## Y時間 エクスポート (`/y-time-export` ページ)

京都ソフト案件などの拘束時間管理 Excel テンプレに、KUDGIVT.csv 由来の日別始業/終業/休憩を
追記してダウンロードする機能。

### アーキテクチャ (2026-05-10 perf 改善後)

```
[browser]
  └─ useYTimeExportJob.start(opts)
       │ 1. POST {NUXT_PUBLIC_API_BASE}/api/dtako/y-time-export/jobs
       │    → 即時 202 { job_id }
       │ 2. wss://{realtimeBusUrl}/subscribe (Sec-WebSocket-Protocol: bearer,<jwt>)
       │    → kind=y_time_export & job_id 一致のメッセージで result 受領
       │
       ▼
       result (YTimeExportResponse JSON, ~288 KB max)
       │
       ▼
[browser] POST /api/y-time-export with `preview` inline
       │
       ▼
[Worker server route /api/y-time-export]
  ├─ R2 binding (DTAKO_R2) でテンプレ xlsx fetch
  ├─ JSZip single-pass row-batch で Y時間 シート書き込み (PR #30 で 150x 高速化)
  └─ xlsx blob 返却
       │
       ▼
[browser] download
```

旧フロー (PR #30 まで) は `POST /api/y-time-export` が backend GET を Worker 内で同期保持していた
ため、13ヶ月レンジで 41-107s かかり Cloudflare proxy timeout や 503 のリスクがあった。

新フローのポイント:
- backend `POST /jobs` は **秒未満で 202 を返す**。HTTP 長時間保持なし
- compute は backend `tokio::spawn` で並列 R2 fetch (`buffer_unordered(16)`) — 5-15s 程度
- result は WebSocket inline payload で直接受け取る (DB 永続化なし、in-memory only)
- `realtimeBusUrl` 未設定 (env 未設定 / 旧 staging) では同期 GET (`/api/dtako/y-time-export`)
  に**自動フォールバック** — 後方互換 (POST /jobs が 503 を返した場合も同様)

### 関連ファイル

| ファイル | 役割 |
|---|---|
| `app/composables/useYTimeExportJob.ts` | WS subscribe + POST /jobs + フォールバック (singleton WS / 複数 job 並走対応) |
| `app/pages/y-time-export.vue` | UI、`yTimeJob.start()` → preview → server route 呼び出し |
| `server/api/y-time-export.post.ts` | R2 テンプレ + JSZip xlsx 生成。body の `preview` があれば backend GET スキップ |
| `app/utils/y-time-xlsx.ts` | JSZip single-pass writer (PR #30) |
| `app/utils/api.ts` | `getYTimePreview()` (旧 sync GET 直叩き、preview ボタン用) |

### realtime-bus Worker 共用

notify-realtime-bus Worker は **nuxt-notify repo** で管理されている (`workers/realtime-bus/src/`)。
nuxt-dtako-admin は新規 deploy せず、同インスタンスを共用する:

- DurableObject は `tenant_id` で scoping、payload 形状は透過 fan-out のため `kind` フィールドで
  channel disambiguate 可能 (redact / y_time_export 等)
- 認証は同 `JWT_SECRET` を共有 (auth-worker 発行 JWT)
- Worker `/broadcast` は `tenant_id` / `document_id` / `status` を必須要求。Y時間 event は
  `document_id` に `job_id` を入れて満たす (frontend は `kind + job_id` で filter)

詳細: `~/rust/rust-alc-api/CLAUDE.md` の "外部 API 連携 (notify-realtime-bus)" 節を参照。

## テスト

- ユニット: `npm test` (Vitest、happy-dom)
- カバレッジ目標: `coverage_100.toml` で管理

## 並行開発 (worktree)

- 必ず `origin/main` ベース worktree を使う
- `/wt-quick` で Cloudflare Quick Tunnel + auth-skip 起動可能
- backend と同期改修する場合は同じ wt-name で揃えると `--incus-backend` が auto-pair する
  (`~/rust/rust-alc-api/CLAUDE.md` の Backend + Frontend 同時改修ワークフロー参照)
