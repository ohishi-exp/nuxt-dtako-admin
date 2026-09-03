# etc-csv-web

R2 (`dtako-uploads`) に溜まった **ETC 明細 CSV を読み取り専用で配る** Worker (Refs #1103)。

`workers/dtako-scraper-relay/` の cron が毎日 JST 6/7/8/9 時に etc-meisai から取得し、
`etc/{user_id}/{YYYY-MM-DD}/{HHMMSS}.csv` へ保存している CSV を、
オンプレの社内 Web アプリの取り込み画面がブラウザから読めるようにするためのもの。
(取り込みの POST 自体は認証 + CSRF 必須でブラウザからしか行えないため、
**「CSV をどこから取ってくるか」だけを差し替える**という位置づけ。)

## ★ セキュリティ上の性質 — 先に読むこと

**この worker は無認証の公開 ETC 明細配信である。CORS は認可ではない。**
`Origin` ヘッダを送らない client (curl 等) は素通りで読める。守っているのは
「どの画面が読めるか」であって「誰が読めるか」ではない。

受け側の認証を置かないのは計画上の明示的な決定 (オーナー判断 2026-09-03)。
置き換え対象だった旧サービス (停止済みの外部 VPS 上の gRPC) は
`CorsLayer::new().allow_origin(Any)` で、セッション一覧 / ファイル一覧 / download の
いずれにも受け側の認証が 0 件だった。オリジン 1 件限定 + `user_id` allowlist は
それより厳格である。

**ただしこの比較は口ごとにしか言えない。** 新しい口を足すときは、その口について
改めて旧構成と比較すること。

実効的な絞りは 2 つだけ:

| 仕掛け | 何を防ぐか | 未設定のとき |
|---|---|---|
| 許可 `user_id` (完全一致) | 他アカウントの明細の総当たり | **全部 404** |
| 許可オリジン (完全一致) | 別サイトのページからのブラウザ読み出し | **CORS ヘッダを付けない** |

どちらも **KV (`AUTH_CONFIG`) が正**で、無ければ dashboard の plain 変数
(`ETC_CSV_ALLOWED_USER_IDS` / `ETC_CSV_ALLOWED_ORIGIN`) にフォールバックする。

どちらも fail-closed。前方一致・後方一致・ワイルドカード・正規表現は使っていない。

## 口 (すべて GET。書き込みの口は無い)

```
GET /list?user_id=<id>                  → { user_id, dates: ["YYYY-MM-DD", ...] }
GET /list?user_id=<id>&date=YYYY-MM-DD  → { user_id, date, objects: [{key, size, uploaded}] }
GET /download?key=<r2 key>              → CSV 本体 (text/csv; charset=shift_jis)
OPTIONS                                 → 204 (preflight)
```

- GET / OPTIONS 以外はすべて **405**。
- 鍵は `{ETC_R2_PREFIX}/{user_id}/{YYYY-MM-DD}/{HHMMSS}.csv` の形だけを受け付ける。
  **汎用の R2 lister ではない** — 任意の prefix を外から渡す口は無く、
  `ETC_R2_PREFIX` も `etc` / `etc-staging` / `etc-preview` 以外なら 503 で止まる。
- **CSV は Shift_JIS のまま返す** (etc-meisai の CSV は Shift_JIS。UTF-8 に変換しない)。

## 開発

```bash
npm ci
npx tsc --noEmit
npx vitest run --coverage   # src/** が 100% gate
```

**手動 `wrangler deploy` は禁止** (この repo の規範)。deploy は
`.github/workflows/etc-csv-web-deploy.yml` の CI 経由のみ。

## ★ deploy しただけでは動かない — 人がやること

CI が deploy しても、以下が未了だと **fail-closed で全部 404 / CORS 無し**のままになる。
**値はこの repo に書かない** (public repo)。

1. **allowlist 2 つを KV に投入する。** 正は KV (`AUTH_CONFIG` binding、auth-worker と
   同じ namespace を read-only で借りている)。dashboard の plain 変数は KV 未投入の
   あいだの fallback でしかない (plain は `keep_vars` があっても deploy で消えた実害が
   ある — `wrangler.toml` の注記)。**投入は最初の 1 回だけ。CI も deploy も書き換えない。**

   | KV キー | 中身 |
   |---|---|
   | `etc-csv:allowed-origin` | 取り込み画面の **オリジン 1 件** (`https://<host>`、末尾 `/` 無し) |
   | `etc-csv:allowed-user-ids` | 配信を許す `user_id` の**カンマ区切り** |

   キー名が `<scope>:<name>` なのは auth-worker の既存規約 (`origins:prod` / `app-orgs`)
   に揃えたもの。`etc-csv:allowed-user-ids` に載せる `user_id` は、relay の
   `ETC_ACCOUNTS` が使っているものと同じ (= R2 の `etc/{user_id}/` のディレクトリ名)。

   `<namespace-id>` は `wrangler.toml` の `[[kv_namespaces]]` の `id`、
   `<...>` は実際の値に置き換えること (**値はこの repo に書かない**)。

   ```bash
   npx wrangler kv key put --remote --namespace-id <namespace-id> 'etc-csv:allowed-origin' '<オリジン>'
   ```

   ```bash
   npx wrangler kv key put --remote --namespace-id <namespace-id> 'etc-csv:allowed-user-ids' '<id1,id2>'
   ```

   **⚠ この namespace は auth-worker と共用で、OAuth の refresh token や device 系の
   キーが同居している。** 投入するのは上の 2 キーだけにし、**`kv key list` で中身を
   一覧しない** (画面共有・ログに他人の材料が出る)。確認は名指しで:

   ```bash
   npx wrangler kv key get --remote --namespace-id <namespace-id> 'etc-csv:allowed-origin'
   ```

   **worker 側に cache は無い。毎回 KV を読む**ので、投入も取り下げも
   **`kv key put` / `kv key delete` がそのまま効く** (残るのは KV 自体の伝播だけ)。
   auth-worker が `origins:wt` を `readKeyNoCache` で読んでいるのと同じ分類 —
   受け側の認証が無いこの worker では、取り下げが遅れるのは受け入れられないため。

   **これは「手動 `wrangler deploy` 禁止」には当たらない** — deploy ではなく設定値の
   投入で、`DTAKO_ACCOUNTS` / `ETC_ACCOUNTS` と同じく**値の持ち主を人にしておく**ため
   (CI に投入させると、値の持ち主がパイプラインになってしまう)。

2. **入口の custom domain を dashboard で 1 回 attach する。**
   **ホスト名は public repo に書かない**ので `wrangler.toml` にも無い (Refs #1103) —
   この worker は受け側の認証を持たないため、宛先を公開しないこと自体が担保の一部。
   Workers & Pages → この worker → Settings → Domains & Routes → Custom domain。
   zone に既存の DNS レコードがあると衝突するので、そこも合わせて確認する。
   **一度 attach すれば CI の再 deploy では外れない** — config に `[[routes]]` が
   無いとき wrangler は routes / custom domains のどちらの API も呼ばない
   (根拠は `wrangler.toml` の注記)。付けるホスト名の条件は次項。

3. **Cloudflare Access の配下に入っていないことを確認する。**
   ホスト名は `*-dev` / `*-staging` / `*-preview` / `preview-*` のいずれにも
   一致させていない (一致すると Access のワイルドカードアプリに巻き込まれ、
   ブラウザからの cross-origin fetch が preflight 403 で落ちる)。
   **Access のアプリを新設しないこと** — この worker はブラウザの
   cross-origin fetch で読まれる前提なので、Access を被せると必ず壊れる。

4. 1〜3 が済んだら、取り込み画面側の差し替え (別 repo) を進める。

## 参照

- 鍵を生成している側: `workers/dtako-scraper-relay/src/cron.ts` の `etcCsvKey()`
- 同じ CSV を返す admin 画面側の route (**認証あり**):
  `server/api/etc-csv/download.get.ts`
  — `ETC_CSV_KEY_PATTERN` はそちらの写しで、`test/key-pattern-parity.test.ts` が
  literal 一致を検査している。**変えるときは必ず両方を同時に変えること。**
