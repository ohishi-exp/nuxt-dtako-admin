# nuxt-dtako-admin

dtako (デジタコ運行データ) 管理画面。Nuxt 4 + Cloudflare Workers (Nitro `cloudflare_module`)。backend は **rust-alc-api** を直 fetch (R2 が要る Y時間 export 等のみ Worker server route)。詳細は `nuxt-dtako-admin-map` skill 参照。

## デプロイ / コマンド

- 本番 `dtako.ippoan.org` (`v*` タグ) / staging (`main` push) / preview (main 以外 push)。タグリリース (`/tag-release patch`) で CI 自動デプロイ。
- `npm test` (Vitest、happy-dom)。カバレッジ目標 `coverage_100.toml` (UI ページは登録しない。方針は同ファイル冒頭)。`workers/dtako-scraper-relay/` は別 `vitest.config.ts` (pure ロジックのみ 100% gate)。
- `[vars]`: `NUXT_PUBLIC_API_BASE` / `NUXT_PUBLIC_AUTH_WORKER_URL`。`DTAKO_R2` → `dtako-uploads` (本番/staging 共用 read-only、Y時間 テンプレ配信)。
- `scripts/xref.sh <語>` でコード+skills+docs を横断検索できる。

## 規範 (必ず守る)

- **画面/server route を変えたら PR 前に dev で実機確認**、結果を PR に書く (型検査もテストも通るのに実機で壊れる欠陥を #419/#420 で 2 件取り逃した)。**dev は front のみ** — relay/`migrations/` は別経路。手順は `dev-login-local-verify` skill。
- **手動 `wrangler deploy` / 手動 D1 migration 適用は禁止** (どちらも CI 経由。詳細は map skill)。
- **開発は必ず `origin/main` ベース worktree**。メイン wt ではソース編集しない。
- **`DTAKO_ACCOUNTS` は relay の KV が正・投入は 1 回だけ** (CI もデプロイも書き換えない)。`ETC_ACCOUNTS` は dashboard の plain 変数 + `keep_vars = true`。いずれも未設定時は fail-closed。
- **Y時間 は async job 化しない (sync HTTP)** — Cloud Run CPU throttling で `tokio::spawn` が完走しない。
- **ETC 検索は `sokoKbn=0` を明示必須** (無いと明細欠落)。**`riyouMonth{N}` は `now` (JST) 当月のみ明示選択し直す** (ページ既定を信用しない)。
- **cron 式は `wrangler.toml [triggers]` と `src/cron.ts` 定数を必ず一致**させる。
- **named environment 追加時は `[observability]`/`[triggers]`/`keep_vars`/`[[tail_consumers]]` を個別再宣言**必須 (top-level 非継承)。診断ログは Tail Worker 側を見る。
- etc-meisai は Shift_JIS。CSV でない応答は loud fail で R2 `{prefix}-errors/` に原本保存。
