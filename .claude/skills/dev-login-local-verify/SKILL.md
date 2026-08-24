---
name: dev-login-local-verify
description: ohishi-exp/nuxt-dtako-admin の **front worker + 画面**をローカルの wrangler dev で prod backend に対して起動し、実機で動作確認する手順 (dev-login = ippoan/auth-worker#423 経由)。relay (workers/dtako-scraper-relay) は含まれない — service binding で本番 relay に飛ぶため、relay/migrations の変更は `wrangler dev --local` + seed の別経路が必要 (skill 内に対応表あり)。**このリポジトリの画面・server route・API 呼び出しを変えたら、PR を出す前に必ずここを読んで dev で実際に動かす** — ユーザーの明示方針 (2026-07-25)「バグ早期検知のため dev で試すを優先」。ボタンが disabled のまま/選択肢の value が空で 500 のような、型検査もテストも通るのに実機で壊れる欠陥はこれでしか捕まらない。`setup-dev-env.sh --here --hybrid` で「いま居る worktree のブランチ」を 1 コマンド起動 (編集→反映 0.1秒)。「wrangler dev」「dev-login」「dev token」「__dev/callback」「ローカルでprod確認」「localhost:8787」「issue_dev_login_url」「HMR」「hybrid dev」「実機確認」「dev で試す」「ゾンビ/ポートが塞がる」等のキーワード、またはこのリポジトリを起動して本番相当のデータで確認したいという要求が出たら必ず参照する。env.dev のような named environment を新設・改変する前にも必ず読むこと — 過去に一度、遠回りな設計 (env.dev の書き換え、env.dev-prod の新設検討) を経てから、実は不要だと判明した経緯があるため。
---

# dev-login ローカル実機検証

## いつ使うか: 画面・server route を変えたら毎回 (2026-07-25 方針)

**ユーザーの明示方針: 「バグ早期検知のため dev で試すを優先」。** 型検査・単体テスト・
カバレッジ 100% が全部通っても実機で壊れる欠陥があり、それは dev で動かすまで
見えない。同じ日に 2 件出した:

| 症状 | 検査で捕まらなかった理由 |
|---|---|
| 「給与DBから読み込み」が押せない (disabled のまま) | ボタンの活殺が `compMap` 由来で、給与比較タブだけ `loadCompMap()` を呼んでいなかった。型も通るしテストも無い箇所 (#419) |
| ページが 500 (`A <SelectItem /> must have a value prop that is not an empty string`) | Reka UI の実行時制約。`value: ''` の option は型上は正しい (#420) |

**手順: `--here --hybrid` で自分のブランチを起動 → 触る → 直す → HMR 即反映。**

```bash
bash <skill>/setup-dev-env.sh --here --hybrid    # いま居る worktree = 自分のブランチ
```

### この dev で検証できるのは front worker + 画面だけ (2026-07-25 ユーザー指摘)

**relay (`workers/dtako-scraper-relay`) は含まれない。** `wrangler dev --remote` が
起動するのは front worker で、`/restraint-api/*` は service binding
(`SCRAPER_RELAY`) 経由で**デプロイ済みの本番 relay**に飛ぶ。つまりこの構成で見える
relay の挙動は本番のもので、自分のブランチの relay コードは 1 行も動いていない。

| 変更した場所 | 検証のしかた |
|---|---|
| `app/**` (画面)・`server/**` (front worker の route) | **この skill** — `--here --hybrid` + dev-login。backend は本番 |
| `workers/dtako-scraper-relay/**`・`migrations/**` | **別経路** — relay 単体を `wrangler dev --local`。`--remote` は DO を持つ worker では使えない (`no longer supported for Durable Objects`)。`d1 migrations apply --local` + `npm run seed:local` + 必要なら D1 に行を入れて、`--var RESTRAINT_DEV_VIEWER_COMP:<comp>` で認可を短絡し curl で叩く |
| 両方を変えた PR | 上の 2 つを**別々に**やる。relay を local で立てる時は port が front と衝突する (どちらも既定 8787) ので片方をずらす |

relay 検証の実例 (2026-07-25、#418 の所属コード対応): migration を `--local` に当て、
取り込み済みの行と未取り込みの行を混ぜて D1 に入れ、
`GET /restraint-api/min-wage/branches` と `PUT /restraint-api/employee-master` を
curl して並び順と UPDATE 経路を確認した。**relay を触る変更でこの手順を省くと、
D1 のカラム追加や SQL の間違いが本番デプロイまで見えない。**

`--here` を付けないと **origin/main の検証用 worktree** が立ち、自分の変更は載らない
(2026-07-25 に実害: 入れ子 worktree が main で作られ、front worker が main のビルドを
配信していた。UI だけは並走 nuxt dev が自分のコードを出していたので気付きにくい)。

検証できたら、**何を実際に叩いてどう応答したか**を PR に書く (「型検査が通った」は
実機確認ではない)。ブラウザから API 呼び出しを数えたい時は `window.fetch` を
一時的に包むのが手軽:

```js
window.__calls=[]; const o=window.fetch;
window.fetch=(...a)=>{const u=typeof a[0]==='string'?a[0]:a[0]?.url??''; if(u.includes('/api/kyuyo/')) window.__calls.push(u); return o(...a)}
```

## ゾンビ掃除: kill-dev-zombies.ps1

```bash
powershell -ExecutionPolicy Bypass -File <skill>/kill-dev-zombies.ps1          # 掃除
powershell -ExecutionPolicy Bypass -File <skill>/kill-dev-zombies.ps1 -DryRun  # 何が引っかかるか見る
```

**ポートだけ見ても足りない。** 2026-07-25 実測で、dev ポート 5 つ全部 `free` なのに
`node`/`workerd` が 5 個生きていた — listener を落としても親 wrangler と workerd が
残り、次の起動でポートを奪い返す (これが「Ready と出るのに古いバンドルが応答する」
の正体)。スクリプトは ①ポートの listener → ②`<binary> dev` のコマンドライン一致 +
`workerd.exe` の 2 段で掃除する。

**`node.exe` を名前で殺してはいけない** — MCP サーバー・言語サーバー・npx も同じ
名前で、名前一括 kill で全部落ちた (実害あり)。コマンドラインの緩い部分一致
(`nuxt|wrangler`) も危険: リポジトリ名 `nuxt-dtako-admin` を含む無関係な node
プロセスを巻き込む。**実行ファイル名の直後に `dev`** を条件にする。

## 結論から: named environment を触るな

`wrangler.toml` の **トップレベル (env 指定なし)** の設定が、実はそのまま prod の
全 binding・var (`AUTH_WORKER` service binding、`NUXT_PUBLIC_API_BASE` 等) を
持っている。これは `wrangler deploy` (タグリリース CI 経由) がデプロイする
「本番」そのものの設定だからだ。

dev-login を検証するのに足りないのは **`DEV_LOGIN="true"` という1つの var** だけ
(`server/routes/__dev/callback.get.ts` のガードがこれを見て、無ければ 404 を返す)。
これは wrangler CLI の `--var` フラグで注入できる — `wrangler.toml` に
宣言されていない新規 var でも問題なく渡せる (wrangler の `collectPlainTextVars()`
がそのまま bindings に spread するだけなので)。

つまり **named environment (`env.dev` を書き換える、`env.dev-prod` を新設する等) は
一切不要**。むしろ避けるべき: named environment は top-level の binding/secret/var
を継承しないため、prod と同じ内容を丸ごと複製することになり、二重メンテと
drift の元になる。加えて `DEV_LOGIN=true` を持つ **deploy 可能な environment
定義** が repo に恒久的に残ってしまう (誰かが誤って `wrangler deploy -e dev` 的な
ことをすれば本番にこのガードが露出しかねない) — `--var` 方式ならそもそも
そういう定義が repo に存在しないので、この懸念自体が構造的に消える。

## クイックスタート: setup-dev-env.sh

手順 0〜5 (worktree 作成 → node_modules junction → prebuilt config 生成 →
port 先住チェック → nuxt build → wrangler dev 起動・Ready 待ち) は
同ディレクトリの `setup-dev-env.sh` に自動化済み。repo ルートから:

```bash
bash .claude/skills/dev-login-local-verify/setup-dev-env.sh            # wrangler dev のみ
bash .claude/skills/dev-login-local-verify/setup-dev-env.sh --hybrid   # + nuxt dev (HMR)
```

- node_modules は「実体を持つ worktree」から junction (0秒)。donor が無ければ
  `gh auth token` で GH Packages 認証して npm install に落ちる (gh token に
  `read:packages` scope が必要 — 無ければ `gh auth refresh -s read:packages` を
  一度実行しておく。2026-07-25 に NODE_AUTH_TOKEN 失効の恒久対策として確立)。
- UI をいじる検証は `--hybrid` を推奨 (下の「hybrid dev」節参照)。
- **nuxt build (~90秒) は `.output` が無い初回だけ自動実行**される。hybrid では
  UI は nuxt dev 側が配信するので、wrangler 用の .output は古くても構わない
  (binding 依存 route を動かすためだけに存在する)。server/ 配下や依存
  (auth-client bump 等) を変えた時だけ `--build` を付けて作り直す。

## 手順

0. **起動前に port 8787 の先住プロセスを必ず確認する** (2026-07-24 実害):
   ```powershell
   Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
   ```
   前セッションの wrangler dev (workerd + node ツリー) が残っていると、**新しい
   wrangler dev は「Ready on :8787」と表示するのに実際のリクエストは旧バンドルを
   アップロード済みの古いインスタンスが処理する** (コード修正が反映されない、
   ように見える)。残骸がいたら `Stop-Process` で workerd と親 node を止めてから
   起動する。検証セッションの終わりにも wrangler dev を止めておくこと。
1. **origin/main ベースの worktree で作業する** (CLAUDE.md の規範通り。メイン
   worktree ではソース編集しない)。`git worktree add .claude/worktrees/<name>
   origin/main` 等。
2. `node_modules` が無ければ、他の worktree からジャンクション/シンボリック
   リンクすると npm install の待ち時間を避けられる (Windows なら
   `New-Item -ItemType Junction`)。ソースが違っても node_modules の中身は
   基本同じなので使い回して問題ない。

   **★ 2 つ罠がある。どちらも「コードが壊れている」ように見える。**

   - **worktree は repo の中に置く** (`.claude/worktrees/<name>`)。`/tmp` 等
     repo の外に置くと、symlink 越しの `node_modules` を vite が `/@fs/…` で
     解決できず**テストが全ファイル import に失敗する**
   - **`npm test` の前に `npx nuxt prepare`。** `.nuxt/tsconfig.json` が無いと
     vitest が `Cannot find module './.nuxt/tsconfig.json'` で**全 113 file
     failed / `Tests: no tests`** になる。**`no tests` = 1 本も走っていない**
     ので、テストが落ちているのではなく**環境が立っていない**。数える前に
     `Tests` 行を読むこと (2026-08-24 に 2 回踏んだ)
3. **Nuxt をビルドする**:
   ```bash
   npx nuxt build
   ```
   注意: シェルの cwd が `.output/` 配下にあるとビルドが
   `EBUSY: resource busy or locked, rmdir .output/server/chunks` で落ちる
   (Windows はディレクトリを開いているプロセスがいると削除できない)。
4. **wrangler dev を起動する** — `[build]` (custom build = `npm run build`) を
   除いた派生 config を使うと **起動が 168秒 → 23秒** になる (wrangler は
   positional で entry を渡しても `[build]` を必ず実行するため、config から
   消すのが唯一のスキップ手段。2026-07-24 実測):
   ```bash
   sed '/^\[build\]$/,/^$/d' wrangler.toml > wrangler.prebuilt.toml
   npx wrangler dev -c wrangler.prebuilt.toml --remote --var DEV_LOGIN:true --port 8787
   ```
   - `wrangler.prebuilt.toml` は使い捨て生成物 (コミットしない)。wrangler.toml を
     変えたら sed から再生成する。
   - **ソース (app/server/auth-client) を変えたら手順3の `npx nuxt build` を
     再実行するだけでよい — wrangler dev の再起動は不要**。wrangler は bundle
     入力 (`.output/**`) を watch しており、`.output` の変化を検知して自動で
     再バンドル+再アップロードする (編集から ~20-30秒で反映、2026-07-24 実測)。
     イテレーション = nuxt build (~90秒) + 自動 reload のみ。
   - **reload の反映検知は同ディレクトリの `reload-watch.mjs`** — `.output` の
     nitro.mjs が持つ buildId (build ごとの UUID) と `:8787/login` が実際に配信
     している HTML 内の buildId を突き合わせ、一致した時刻を報告する (ground
     truth。ログの推測より確実):
     ```bash
     node .claude/skills/dev-login-local-verify/reload-watch.mjs <worktreeDir> 8787
     ```
     Claude Code の PostToolUse hook (matcher: `Bash`) に
     `node <このskillディレクトリの絶対パス>/reload-watch.mjs --hook` を登録すると、
     Claude が Bash で `nuxt build` を実行するたび自動で反映待ち → 反映時刻が
     additionalContext として報告される (`nuxt build` 以外のコマンドと
     wrangler dev 不在時は無音でスキップ、timeout 120 推奨)。
   - なお **従来構成 (`[build]` あり) でも hot reload は最初から効いていない**:
     wrangler の custom build 監視は `watch_dir` (既定 `./src`) を見るが、この
     repo に `src/` は無い。つまり従来は変更のたびフル再起動 (168秒) が必要
     だった。vite 級の即時 HMR が欲しくても `nuxt dev` は不可 — `/api/proxy` が
     cloudflare binding (AUTH_WORKER) 依存のためデータ経路が 503 になる。
   - `--remote` は service binding (`AUTH_WORKER` 等) や Secrets Store binding を
     実際にデプロイ済みの prod リソースに解決させるために必須。
   - `-e` オプションは付けない。port は次の MCP tool 呼び出しの `port` 引数と
     一致させること。
5. ログに `[wrangler:info] Ready on http://127.0.0.1:8787` が出れば起動完了。

## dev-login token の発行 (MCP 経由)

`issue_dev_login_url` / `issue_dev_token` は auth-worker 自身の Google IdP 専用
MCP surface (`https://auth.ippoan.org/mcp/google`、ippoan/auth-worker#438) の
tool。claude.ai のカスタムコネクタとしてこの URL を追加し、Google 認可を
済ませておけば呼べる (github flow のセッションでは `email` claim が無く
`google_login_required` で 403 になるので、必ず `/mcp/google` 経由で接続すること)。

- `issue_dev_login_url({ port: 8787 })` → `http://localhost:8787/__dev/callback?code=...`
  (60秒 TTL・単回使用) が返る。**port は手順4で wrangler dev が listen している
  port と一致させる**。このURLをブラウザで開くと cookie (`logi_auth_token_dev`、
  server route 用) がセットされ、`/#token=...` (fragment handoff、SPA の
  `consumeFragment` がクライアント側セッションを確立する) へ 302 → 認証済みで
  アプリに遷移する。
  - **fragment handoff は auth-worker#442 (`@ippoan/auth-client` の
    `buildDevRedirectLocation`) 以降の挙動**。それ以前の auth-client では
    cookie しか出ないため、SPA が未認証判定 → 通常ログイン →
    "Invalid or missing redirect_uri" で必ず失敗する (2026-07-24 に踏んだ)。
    node_modules の auth-client が古い場合は #442 の 4 ファイル
    (`devLogin.mjs` / `devLoginCore.mjs` / `index.mjs` / `index.d.mts`) を
    手で当ててから nuxt build する。
  - ~~URL バーに `#token=...` が残る~~ → **auth-client 0.2.150 (auth-worker#447)
    で解消済み**。真因は「Nuxt の router が起動時に捕捉した hash 込み initialURL を
    復元するナビゲーションが、`consumeFragment` の replaceState を後から上書きする」
    だった。`router.isReady()` は復元ナビより先に解決するためフックにできず
    (auth-worker#446 は効かなかった)、`consumeFragment` 内の最初の
    `router.afterEach` で再除去する方式が正解 (実測タイムラインは
    auth-worker#445 のコメント参照)。0.2.149 以前の node_modules では従来どおり
    hash が残るが cosmetic (セッション確立は正常)。
- `issue_dev_token({})` → curl 等での直接検証用の Bearer JWT (30分 TTL)。

いずれも呼び出し元 (このMCPセッション) の Google アカウントが
`DEV_LOGIN_ALLOWED_SUBJECTS` (auth-worker側 KV) に事前登録されている必要がある
(issue #423 参照)。

### `google_sub_not_cached` で 403 になったら — 登録は消えていない (30日 TTL 切れ)

**これは設定ミスではなく、ほぼ必ず「最後に Google 認可してから 30 日以上経った」だけ。**
`mint` の関門は 3 つあり (`auth-worker/src/lib/dev-login.ts`)、**`google_sub_not_cached`
まで来ている時点で前の 2 つは通過**している:

| 関門 | 落ちたときの error | 通過が意味すること |
|---|---|---|
| `allowlist.includes(payload.sub)` | `not_in_allowlist` | アカウントは **`dev_login_allowed_subjects` に登録済み** |
| `payload.email` の有無 | `google_login_required` | コネクタは既に **`/mcp/google` 経由** (GitHub flow ではない) |
| `MCP_OAUTH_KV.get('google_sub:' + email)` | **`google_sub_not_cached`** | — |

この KV は **Google OAuth の callback でしか書かれず**
(`src/handlers/mcp-auth-callback-google.ts:207-209`)、TTL は 30 日:

```ts
const GOOGLE_SUB_CACHE_TTL_SEC = 60 * 60 * 24 * 30;   // mcp-auth-callback-google.ts:50
```

**直し方は claude.ai のコネクタ設定で `https://auth.ippoan.org/mcp/google` を認可し直すだけ。**
再接続すると callback が走って 30 日ぶん入り直す。**KV への再投入も allowlist の追加も不要。**
「登録が消えた」「設定が壊れた」と誤診して余計な投入をしないこと (2026-08-24 に実際に踏んだ)。

**再連携の直前に起動したセッションでも、そのまま呼べるようになる。**
コネクタを認可し直すと **走行中のセッションにも MCP の一覧が配り直され**、
`issue_dev_login_url` / `issue_dev_token` が途中から現れる (2026-08-24 実測)。
**tool が無いのを見て「このセッションでは無理」と判断してセッションを起こし直さないこと。**
`issue_dev_token({})` を 1 回叩いて 403 が消えたかで判定する。

## hybrid dev: nuxt dev (HMR) + wrangler dev 並走 (2026-07-25 実測で確立)

UI をいじるイテレーションは wrangler dev 単体だと「編集 → `nuxt build` (~90秒) →
自動 reload (~20-30秒)」かかる。**`nuxt dev` を並走させると編集→反映が実測 106ms**
になる (`setup-dev-env.sh --hybrid` が全部やる)。

仕組み: `nuxt dev` 単体が使えなかった理由は `/api/proxy` (server route) が
`AUTH_WORKER` service binding 依存で 503 になるため。nuxt.config.ts の
`nitro.devProxy` に binding 依存経路だけ並走中の wrangler dev へ転送する entry を
足すことで解決する:

```ts
    devProxy: {
      // (既存の /restraint-api, /net780-api は relay worker 用 — 下の注意参照)
      '/api/proxy': { target: 'http://127.0.0.1:8787/api/proxy' },
      '/__dev': { target: 'http://127.0.0.1:8787/__dev' },
    },
```

- `NUXT_PUBLIC_API_BASE` / `NUXT_PUBLIC_AUTH_WORKER_URL` / `NUXT_ALC_API_URL` は
  wrangler.toml の `[vars]` と同値を env で渡して `npx nuxt dev --port 3000`。
- **dev-login は `issue_dev_login_url({ port: 3000 })`** (nuxt dev 側の port)。
  `/__dev/callback` が devProxy 経由で wrangler に届き、cookie は host スコープ
  (port 無関係) なので :3000 でもそのまま有効。fragment handoff → consumeFragment →
  セッション確立まで全経路動作を実機確認済み。
- 初回ページ表示はオンデマンドコンパイル + API 往復でデータ表示に時差が出る (正常)。
  2回目以降・HMR は即時。
- 注意: 既存 devProxy の `/restraint-api`・`/net780-api` は **relay worker
  (dtako-scraper-relay) 用に同じ :8787 を指している**。relay も必要な検証では
  front worker とどちらかの port をずらすこと (hybrid スクリプトは front を 8787
  に置く前提なので、relay 併用時は relay 側を移す)。

## 実行環境の注意

- **`preview_start` (Claude Code の browser pane 起動ツール) はこの用途には使わない
  こと。** プロジェクトルート (このリポジトリの親ディレクトリ) からしかコマンドを
  起動できず、worktree 内の相対パス指定を無視してしまう既知の問題がある。
  `wrangler dev` は Bash ツールで worktree のルートから直接起動し、ブラウザでの
  確認だけ `preview_start` の `{url: "http://localhost:8787/..."}` 指定
  (サーバー起動を伴わない、既存サーバーへの単純なナビゲーション) を使うと安全。
- ビルドは数十秒かかる。ログに `Ready on http://127.0.0.1:8787` が出るまで待つこと。
  出る前に接続を試みると接続拒否になる。
