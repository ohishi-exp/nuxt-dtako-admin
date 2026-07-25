# nuxt-dtako-admin

dtako (デジタコ運行データ) 管理画面。Nuxt 4 + Cloudflare Workers (Nitro `cloudflare_module`)。backend は **rust-alc-api** を直 fetch (R2 が要る Y時間 export 等のみ Worker server route)。詳細は `nuxt-dtako-admin-map` skill 参照。

## デプロイ / コマンド

- 本番 `dtako.ippoan.org` (`v*` タグ) / staging (`main` push) / preview (main 以外 push)。タグリリース (`/tag-release patch`) で CI 自動デプロイ。
- `npm test` (Vitest、happy-dom)。カバレッジ目標 `coverage_100.toml`。`workers/dtako-scraper-relay/` は別 `vitest.config.ts` (pure ロジックのみ 100% gate)。
- `[vars]`: `NUXT_PUBLIC_API_BASE` / `NUXT_PUBLIC_AUTH_WORKER_URL`。`DTAKO_R2` → `dtako-uploads` (本番/staging 共用 read-only、Y時間 テンプレ配信)。
- `scripts/xref.sh <語>` でコード+skills+docs を横断検索できる。

## 規範 (必ず守る)

- **画面 / server route を変えたら PR 前に dev で実機確認する** (バグ早期検知、2026-07-25 方針)。
  `bash .claude/skills/dev-login-local-verify/setup-dev-env.sh --here --hybrid` で
  自分のブランチが本番 backend に対して立つ。**型検査もテストも通るのに実機で壊れる**
  欠陥 (ボタンが disabled のまま / `SelectItem` の value 空で 500) を同じ日に 2 件
  取り逃している (#419 / #420)。PR には「何を叩いてどう応答したか」を書く。
  **この dev は front worker + 画面だけ** — relay (`workers/dtako-scraper-relay`) は
  service binding で本番に飛ぶので、relay / `migrations/` の変更は
  `wrangler dev --local` + `d1 migrations apply --local` + `npm run seed:local` の
  別経路で確認する (`--remote` は DO を持つ worker では使えない)。
- **手動 `wrangler deploy` は禁止** (タグリリースの CI 経由のみ)。
- **D1 migration も手動適用は禁止** — `migrations/` に追加すれば main merge 時に
  `dtako-scraper-relay-deploy.yml` が `d1 migrations apply --remote` で適用する
  (記帳は `d1_migrations`。本番は手作業運用だったため `scripts/d1/bootstrap-d1-migrations.sql` で 0001〜0005 を記帳済み扱いにしている)。
- **開発は必ず `origin/main` ベース worktree**。メイン wt ではソース編集しない。
- **`DTAKO_ACCOUNTS` は relay の KV (`dtako-relay-config` の `dtako_accounts`) が正**
  — dashboard の plain 変数は `keep_vars` があっても本番から消え、viewer 認可が
  全社 401 になった (2026-07-25)。**投入は 1 回だけ・CI もデプロイも書き換えない**
  (毎回投入するなら消える変数と同じ)。CI は存在検証で落とすだけ。
  `ETC_ACCOUNTS` は従来どおり dashboard の plain Environment Variable + `keep_vars = true`。
  いずれも未設定時は fail-closed。
- **Y時間 は async job 化しない (sync HTTP)** — Cloud Run CPU throttling で `tokio::spawn` が完走しない。
- **ETC 検索は `sokoKbn=0` を明示必須** (無いと明細欠落)。**`riyouMonth{N}` は `now` (JST) 当月のみ明示選択し直す** (ページ既定を信用しない)。
- **cron 式は `wrangler.toml [triggers]` と `src/cron.ts` 定数を必ず一致**させる。
- **named environment 追加時は `[observability]`/`[triggers]`/`keep_vars`/`[[tail_consumers]]` を個別再宣言**必須 (top-level 非継承)。診断ログは Tail Worker 側を見る。
- etc-meisai は Shift_JIS。CSV でない応答は loud fail で R2 `{prefix}-errors/` に原本保存。
