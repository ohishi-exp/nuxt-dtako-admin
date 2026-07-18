# nuxt-dtako-admin

dtako (デジタコ運行データ) 管理画面。Nuxt 4 + Cloudflare Workers (Nitro `cloudflare_module`)。backend は **rust-alc-api** を直 fetch (R2 が要る Y時間 export 等のみ Worker server route)。詳細は `nuxt-dtako-admin-map` skill 参照。

## デプロイ / コマンド

- 本番 `dtako.ippoan.org` (`v*` タグ) / staging (`main` push) / preview (main 以外 push)。タグリリース (`/tag-release patch`) で CI 自動デプロイ。
- `npm test` (Vitest、happy-dom)。カバレッジ目標 `coverage_100.toml`。`workers/dtako-scraper-relay/` は別 `vitest.config.ts` (pure ロジックのみ 100% gate)。
- `[vars]`: `NUXT_PUBLIC_API_BASE` / `NUXT_PUBLIC_AUTH_WORKER_URL`。`DTAKO_R2` → `dtako-uploads` (本番/staging 共用 read-only、Y時間 テンプレ配信)。
- `scripts/xref.sh <語>` でコード+skills+docs を横断検索できる。

## 規範 (必ず守る)

- **手動 `wrangler deploy` は禁止** (タグリリースの CI 経由のみ)。
- **開発は必ず `origin/main` ベース worktree**。メイン wt ではソース編集しない。
- **`DTAKO_ACCOUNTS` / `ETC_ACCOUNTS` は秘密 → wrangler.toml / git に置かず** dashboard の plain Environment Variable で投入し **`keep_vars = true` 必須** (無いと deploy 毎に消える)。未設定時は fail-closed で skip。
- **Y時間 は async job 化しない (sync HTTP)** — Cloud Run CPU throttling で `tokio::spawn` が完走しない。
- **ETC 検索は `sokoKbn=0` を明示必須** (無いと明細欠落)。**`riyouMonth{N}` は `now` (JST) 当月のみ明示選択し直す** (ページ既定を信用しない)。
- **cron 式は `wrangler.toml [triggers]` と `src/cron.ts` 定数を必ず一致**させる。
- **named environment 追加時は `[observability]`/`[triggers]`/`keep_vars`/`[[tail_consumers]]` を個別再宣言**必須 (top-level 非継承)。診断ログは Tail Worker 側を見る。
- etc-meisai は Shift_JIS。CSV でない応答は loud fail で R2 `{prefix}-errors/` に原本保存。
