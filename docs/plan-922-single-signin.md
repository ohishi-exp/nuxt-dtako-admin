# #922 サインインを 1 回にする — 設計 (実装前・判断待ち)

**base**: `origin/main` = `09d7a3354806a571a2d18f16c12bb12d02546d73` (着手時 HEAD 同一)
**測定日時**: 2026-08-26 04:33〜04:35Z / **測定手段**: 無認証 `curl` (Access の 302 と login ページ)、`auth.ippoan.org` の公開 OIDC endpoint、この repo と `ippoan/auth-worker@bd42b6f` の実読
**Cloudflare の設定は 1 つも変更していない** (読むだけ)。資格情報の入力・OAuth の承認も行っていない。

---

## ★ 結論を先に — 案 3 (SSO) は**既に本番で稼働している**

issue #922 が「未着手の 3 案」として並べた案 3 は、**もう入っています。**

```
$ curl -sS -D- https://dtako.ippoan.org/            # → 302 Access
$ curl -sS "<その Location>"                        # Access の login ページ
  → https://auth.ippoan.org/oidc/authorize
      ?client_id=cf-access&domain=cf-access
      &redirect_uri=https%3A%2F%2Fmtamaramu.cloudflareaccess.com%2Fcdn-cgi%2Faccess%2Fcallback
      &response_type=code&scope=openid+email+profile
    state の中: "idpId":"<Access の IdP の UUID>"
```

**`dtako.ippoan.org` の Access が使っている唯一の IdP は Google ではなく `auth.ippoan.org` 自身**です。
`rdp.ippoan.org` の login ページを同じ手順で取ると、**`idpId` が 1 文字違わず一致します** —
2 つのアプリが**同一の OIDC IdP を共有**しています。

> `idpId` / `aud` の実値は**この doc には書きません**。無認証 curl で誰でも取れる値ですが、
> **この repo は public** なので commit すると grep できる形で残ります。**主張はこの値に
> 依存していません** — 要点は「両ホストの `idpId` が一致する」ことだけで、値そのものではない。
> 確かめたい人は上の 2 コマンドを `dtako.ippoan.org` と `rdp.ippoan.org` に対して回して
> `idpId` を突き合わせてください (ログイン不要)。

surface も生きています (無認証で読める口だけで確認):

```
$ curl -sS https://auth.ippoan.org/oidc/.well-known/openid-configuration   # HTTP 200
  issuer=https://auth.ippoan.org/oidc  id_token_signing_alg=["ES256"]
  claims_supported=[... "email","tenant_id","role","org_slug"]
$ curl -sS https://auth.ippoan.org/oidc/.well-known/jwks.json              # HTTP 200
  keys=[{kty:EC, crv:P-256, alg:ES256, use:sig, kid:<thumbprint>}]  ← 実鍵 1 本
```

`auth-worker/docs/access-oidc.md` は、この surface を**まさに #922 の問題のために**作ったと書いています:

> Access の IdP を Google 等の外部にすると利用者は「触ったことのない別の認証系」でログインすることになる。auth-worker 自身を Access の IdP にすれば、Access のリダイレクトは既存の `logi_auth_token` セッションで無言に通り、**追加ログインがゼロ**になる。

**⇒ issue 本文の「Access は Google、アプリも Google、2 つの独立した認証系が直列」という前提は、いま現在は成り立っていません。** issue 本文の実測は 2026-08-25 (`09f6d55`) 時点のもので、親が「今日 01:53Z に `auto_redirect_to_identity` が更新されている」と観測したのと同じ**設定変更の波**の中にあります。**設計の出発点をここに置き直してください。**

---

## 現在の実際の経路 (実測 + コード実読)

```
① 何も cookie が無いブラウザ → https://dtako.ippoan.org/restraint-wage
② Access 302 → mtamaramu.cloudflareaccess.com/cdn-cgi/access/login/dtako.ippoan.org
   auto_redirect_to_identity=true・IdP 1 つ ⇒ 選択画面を出さずそのまま ③ へ
③ https://auth.ippoan.org/oidc/authorize?client_id=cf-access&...
   → oidc-authorize.ts: logi_auth_token cookie を検証 → **無い**
   → 302 https://auth.ippoan.org/login?redirect_uri=<③の URL 丸ごと>
④ auth-worker /login   ← ★ 画面 1 枚目 (Google / LINE / LINE WORKS の選択)
⑤ /oauth/google/redirect → accounts.google.com  ← ★ 画面 2 枚目
   google-redirect.ts:41 が **prompt=select_account を常時付ける** ⇒ Google のセッションが
   生きていてもアカウント選択画面が必ず出る
⑥ /oauth/google/callback → Set-Cookie: logi_auth_token=<JWT>; Domain=.ippoan.org;
     Path=/; Max-Age=86400; Secure; SameSite=Lax        (cookies.ts:setAuthCookie)
   → ③ の authorize URL へ戻る
⑦ /oidc/authorize: 今度は cookie がある → code 発行 → Access callback
   → CF_Authorization 発行 → ① の URL へ戻る
⑧ dtako.ippoan.org のアプリ起動
   app/plugins/auth.client.ts → recoverFromCookie()
   → document.cookie の logi_auth_token を読み、exp を見て authState を復元
   → app/middleware/auth.global.ts の isAuthenticated が true ⇒ **/login に飛ばない**
```

**⑧ が成立するなら、Google が出るのは 1 回だけです。** ただし利用者が押す**選択画面は 2 枚** (④ の provider chooser と ⑤ の Google account chooser) 残ります。**「2 回ログインさせられた」という体感の残りは、いま現在はここだと考えられます。**

### ⑧ を私は測っていません (測れません)

⑧ の確認には**実際に Google でログインする**必要があり、資格情報の入力・OAuth の承認は私が代行してはいけない操作です。**⑧ はコード実読からの推論**で、根拠は 3 点:

| 根拠 | 場所 |
| --- | --- |
| cookie は `Domain=.ippoan.org` で発行される (= `dtako.ippoan.org` に届く) | `auth-worker/src/lib/cookies.ts` `setAuthCookie` |
| `/oidc/authorize` は cookie 検証で短絡する (= 追加ログインゼロの分岐点) | `auth-worker/src/handlers/oidc-authorize.ts` `identityFromSession` |
| アプリ起動時に `document.cookie` から復元する | `app/plugins/auth.client.ts` → `packages/auth-client/src/useAuth.ts:214 recoverFromCookie` |

**ユーザーが 30 秒で確定できます** (私に代わってこれだけ測ってほしい):

1. `dtako.ippoan.org` と `auth.ippoan.org` の cookie を消したシークレットウィンドウで `https://dtako.ippoan.org/restraint-wage` を開く
2. **Google のアカウント選択が何回出たか**を数える
3. 着地後に DevTools → Application → Cookies → `https://dtako.ippoan.org` に **`logi_auth_token` が居るか**を見る

`logi_auth_token` が居て Google が 1 回なら **⑧ は成立していて、残件は ④⑤ の画面 2 枚だけ**です。
Google が 2 回出たなら ⑧ が壊れており、そのときは「アプリが cookie を読めていない」= 別の欠陥なので、この設計とは別に切り分けが要ります。

---

## 1. 無認証で露出する route の棚卸し

**`server/` に blanket な認証はありません。**`app/middleware/auth.global.ts` は **Nuxt の route middleware = ページ用**で、`/api/*` には一切効きません。`server/middleware/` は存在せず、認証は route ごとに手で書かれています。

**server route 33 本 (`server/api/**` 32 + `server/routes/__dev/callback` 1) の内訳**:

| 段 | 本数 | 認可の実体 |
| --- | --- | --- |
| A. `requireAuth` (auth-worker ログイン必須) | 6 → **10** | Nitro で 401 |
| B. 上流に browser JWT を渡し**上流が弾く** | 7 | rust-ichibanboshi / auth-worker `/alc-proxy` |
| C. machine shared secret | 1 | `X-Internal-Shared-Secret` constant-time |
| **D. 認可が 1 つも無い** | 18 → **14** | **Access だけが前段** |
| E. 本番では 404 | 1 | `DEV_LOGIN !== 'true'` |

> **2026-08-27 追記 (#988 の 1 本目、`origin/main` = 94b72f2 基点)。**
> **D のうち書き込み 4 本に A 段の `requireAuth` を入れました** — 下表の ✍ 行 4 つ
> (`margin-summary` / `snapshot.delete` / `vehicle-settings/extract` /
> `y-time-template.put`)。**読み取り 14 本は手つかず**で、別 PR に残っています。
> 数字は着手時に `origin/main` で数え直したもの (33 本の総数は当時から変わっていません)。

### D の 18 本 (Access を外すと**そのまま公開される**)

**✍ の 4 本は #988 の 1 本目で塞ぎました** (`requireAuth` = A 段に移動)。残るのは読み取り 14 本。

| route | 中身 | 書き込み |
| --- | --- | --- |
| **`GET /api/ichiban/**`** | **CF Access Service Token を付けて `rust-ichiban.mtamaramu.com` へ丸ごと転送する thin proxy。呼び出し元の身元を一切見ない** | — |
| `GET /api/profit/snapshots` / `snapshot` / `margin-snapshots` / `margin-snapshot` / `operation-leg-sales` | `PROFIT_R2` の粗利・検証スナップショット (売上・原価・粗利の実額) | — |
| `POST /api/profit/margin-summary` | 同 R2 に**版を書く** | ✍✍ **→ #988 で塞いだ** |
| `DELETE /api/profit/snapshot` | 同 R2 の `latest.json` を**消す** | ✍✍ **→ #988 で塞いだ** |
| `GET /api/net780/by-operation` | `DTAKO_DB` + `DTAKO_R2` の NET780 生データ ZIP | — |
| `POST /api/vehicle-settings/extract` | `DTAKO_R2` + `DTAKO_DB` に**書く** | ✍✍ **→ #988 で塞いだ** |
| `GET /api/vehicle-settings/history` / `object` | 車輌設定 dump の一覧・実体 | — |
| `GET /api/kyuyo-master/companies` | `DTAKO_DB` の給与会社マスタ一覧 | — |
| `GET /api/y-time-template` | R2 テンプレ xlsx | — |
| `PUT /api/y-time-template` | R2 テンプレ xlsx を**上書き** | ✍✍ **→ #988 で塞いだ** |
| `GET /api/vid-check/map-key` | **Google Maps API key を平文で返す** (referrer 制限あり) | — |
| `GET /api/poi/:region` | R2 の POI geojson | — |
| `GET /api/tariff/fare` | 告示209号の公開運賃表 (実害なし) | — |

**いちばん重いのは `/api/ichiban/**` です。**これは classic な confused deputy で、Access を外すと**インターネットの誰でも、この worker を踏み台にして CF Access の裏の一番星 API を叩けます**。`X-Alc-Proxy-Secret` も browser JWT も見ておらず、付けるのは Service Token だけです。
唯一の緩和は「上流の rust-ichibanboshi 自身が `Authorization` を見て弾く口があるかどうか」ですが、**それは上流の実装依存で、この repo からは保証できません** (兄弟タスク #951「実支給額が tenant 全員に開いている経路を塞ぐ」が隣接しています)。

**書き込み 4 本 (`margin-summary` / `snapshot.delete` / `vehicle-settings/extract` / `y-time-template.put`) は、無認証のまま公開すると「粗利の版を第三者が消せる／捏造できる」**という形になります。金額そのものではありませんが、**金額の証跡**です。

**⇒ この 4 本は #988 の 1 本目で `requireAuth` を入れ、A 段に移りました** (2026-08-27)。
**読み取り 14 本は未着手**です — 書き込みと読み取りを 1 つの PR に混ぜると、壊れたときの
切り分けができなくなるので分けました。

### ★ C 段 (machine shared secret) も「限られた caller だけ」ではない

上表の C 段 (`GET /api/tariff/dtako-operations` の `X-Internal-Shared-Secret`)、および
`/kintai-relay/*` の `X-Alc-Proxy-Secret` は、**同じ `INTERNAL_SHARED_SECRET` の集合**です。

- **`INTERNAL_SHARED_SECRET` は 3 つの Rust binary に build-time で焼かれている** (兄弟タスク
  c482 の実測。本設計では未検証・引用)。⇒ 「この secret を持つのは worker だけ」という
  前提は成り立ちません
- `ippoan/auth-worker#482` (実読ベース、OPEN): **その secret 1 つで `POST /device/pair-internal`
  から任意 tenant の device JWT を mint でき、`/alc-proxy` がそれを browser JWT と同じ鍵で
  受け付ける** (`aud` も `role` も見ない)

**本設計の D 18 本とは別経路**ですが、向きは同じです — **「前段が守っているつもり」で
アプリ側に認可を書いていない箇所が、この repo にも上流にもある。**⇒ §5 の service token を
配る判断は、**D の 18 本だけでなく #482 の状況も見てから**にしてください。

### worker/index.ts が Nitro を迂回させる 7 prefix

`worker/index.ts` は以下を Nitro に渡さず `SCRAPER_RELAY` へ素通しします。**Nitro の認証は一切通りません。**

| prefix | 認可 |
| --- | --- |
| `/ws/scraper` | auth-worker introspect (`token` query) ✅ |
| `/restraint-api/*` | theearth セッション **または** auth-worker introspect + tenant→comp 逆引き ✅ (`restraint-viewer-auth.ts`) |
| `/dvr-api/*`・`/daily-report-api/*`・`/net780-api/*` | **theearth のランダム bearer token** (login で発行)。`…/login` **だけ**は無認証 |
| `/kintai-relay/*` | `X-Alc-Proxy-Secret` constant-time ✅ |
| `/scraper-zip/{compId}/{requestId}` | **認可なし・capability URL** (`requestId` を知っていれば取れる、1 回限り) |

**`POST /dvr-api/login` は無認証で theearth に資格情報を投げられる口**です。Access を外すと、**dtako.ippoan.org が theearth のパスワード試行台になります。**

### staging / preview も測った

```
dtako-staging.ippoan.org /api/poi/kanto → 302 Access (aud=<staging 固有>)
dtako-preview.ippoan.org /api/poi/kanto → 302 Access (aud=<preview 固有>)
# 本番 dtako.ippoan.org の aud とも、この 2 つ同士も、すべて別の値だった
```

**3 ホストとも Access の裏で、しかも別々の Access アプリ**です (aud が全部違う)。
**preview / staging は `DTAKO_R2` と `DTAKO_DB` を本番と共用**しています (`wrangler.toml`)。⇒ **本番の Access だけ外しても、D の 18 本のうち R2/D1 系は staging/preview 経由でも同じデータに届く**ので、**Access を外す判断は 3 アプリまとめてしか意味がありません**。逆に「1 つだけ外して様子を見る」も成立しません (穴が開くのはデータ側なので)。

---

## 2. `Cf-Access-Jwt-Assertion` はアプリまで届いているか

**この repo は受け取っていません** (`Cf-Access-Jwt-Assertion` / `CF_Authorization` を読むコードは `server/` にも `worker/` にも **0 件**)。auth-worker 側にも受け口はありません (後述)。

**「Access が origin に付けているか」は私は測れません** — 測るには Access を通った先で header を反射する口が要り、それは実装になります。ただし**同一アカウント内に、届いている前提で動いている実物があります**:

> 中継は公開ホスト名で出ていて、前段の Access が利用者を認証する。中継自身も `Cf-Access-Jwt-Assertion` を **JWKS で検証する**ので、cookie が無ければ 401 で閉じる。 — `app/utils/rdp-access.ts`

`rdp.ippoan.org` (同じ Access チーム・**同じ idpId**) はこのヘッダを本番で検証しています。⇒ **Access がこのアカウントで origin にヘッダを渡していること自体は成立している**と見てよいです。ただし rdp の origin は Cloudflare Tunnel の先のオンプレ中継で、**Worker が origin のとき (= dtako) も同じか**は別問題として残ります (**未測定**)。

**決めるための最小の測り方** (実装が要るので、やるなら別 PR): `server/api/__probe.get.ts` を 1 本足して `getHeader(event,'cf-access-jwt-assertion')` の**有無だけ** (値は返さない) を返す。1 回測って消す。

---

## 3. auth-worker 側に Access JWT を受ける口はあるか

**「Access の JWT を受ける口」は無く、代わりに「Access に identity を渡す口」があります。**方向が逆で、そちらの方が上等です。

`ippoan/auth-worker@bd42b6f` の実読:

| endpoint | 役割 |
| --- | --- |
| `GET /oidc/.well-known/openid-configuration` | discovery |
| `GET /oidc/authorize` | **`logi_auth_token` があればその場で code を返す** = 追加ログインゼロの分岐点 |
| `POST /oidc/token` | code → `id_token` (ES256) |
| `GET /oidc/.well-known/jwks.json` | 公開鍵 |
| `GET /oidc/userinfo` | access_token → identity |

- 鍵: `ACCESS_OIDC_SIGNING_KEY` (Secrets Store、ES256 私有 JWK 配列、kid は RFC 7638 thumbprint 導出)
- client: `ACCESS_OIDC_CLIENTS` (静的レジストリ、`client_id`/`client_secret`/`redirect_uris` 完全一致)
- `id_token` の custom claim: `tenant_id` / `role` / `org_slug` ⇒ **Access のポリシーで「この tenant の admin だけ」が書けます**
- 既存の HS256 系 (`JWT_SECRET` / `MCP_JWT_SECRET`) には触れていない別 surface

**そして 1 節のとおり、`dtako.ippoan.org` の Access はもうこの client (`client_id=cf-access`) を使っています。**

⇒ **案 2 (Access JWT をアプリの identity に引き当てる) は、作る意味がありません。**案 2 は「Access の identity をアプリへ下ろす」ですが、いま流れているのは逆向き (「アプリの identity を Access へ上げる」) で、**同じ 1 つの identity を 2 回名乗り直す必要が消えている**からです。案 2 を今から足すと、identity の正本が 2 つになります。

---

## 4. `prompt=select_account` の影響範囲

**issue 本文の「既定オフ」は誤りです。実装は常時 ON で、切る手段がありません。**

```ts
// auth-worker/src/handlers/google-redirect.ts:41
googleAuthUrl.searchParams.set("prompt", "select_account");
```

**変更点は 1 行 1 箇所。ただしそこへ来る経路が 3 本あり、全 consumer に効きます。**

| 呼び出し元 | 意味 |
| --- | --- |
| `src/handlers/login-page.ts:45` | auth-worker `/login` の Google ボタン ⇒ **全 consumer の通常ログイン** |
| `packages/auth-client/src/useAuth.ts:290,310,370` | consumer が `/login` を飛ばして直接 Google へ行く経路 |
| `src/lib/join-html.ts:42` | 組織 join フロー (`join_org` 付き) |

**consumer の実測** (`gh search code`、2026-08-26):
`@ippoan/auth-client` を持つ **product アプリ 9 本** — `ippoan/alc-app` / `ci-dashboard` / `nuxt-egov` / `nuxt-items` / `nuxt-notify` / `nuxt-pwa-carins` / `nuxt-trouble` / `ohishi-exp/nuxt_dtako_logs` / **`ohishi-exp/nuxt-dtako-admin` (これ)** (+ `ci-workflows` / `claude-*` はツール側)。

**巻き込まない経路**: `ghapi-redirect.ts` は `prompt=consent` を別途持ち (refresh_token 取得用)、`egov-redirect.ts` は呼び出し側の `prompt` を透過するだけ。**どちらもこの 1 行とは無関係**です。

**外すと何が変わるか**: Google のセッションが**ちょうど 1 つ**なら選択画面が消えて即通る。**複数ログインしていれば Google はどのみち選択画面を出します。**⇒ 「必ず速くなる」ではなく「**単一アカウントの人だけ** 1 枚減る」。

**外すと何を失うか**: 共用 PC で「前の人の Google に黙って乗る」が起きます。`select_account` はそれを防いでいます。**⇒ セキュリティのトレードオフであり、私や親が決めることではありません。**

**中間案** (どちらも 1 行 + テスト): (a) `join_org` があるときだけ `select_account` を残す (join は「どのアカウントで参加するか」が本題なので理にかなう)。(b) `?prompt=` を query で透過させ、consumer ごとに選べるようにする (`egov-redirect.ts` と同じ作法、既に前例がある)。

---

## 5. agent / CI から本番を目視できない問題

**どの案でも「自動で解決」はしません。効くのは Access の service token です。**

| 案 | agent/CI から本番が見えるか |
| --- | --- |
| 案 1 (Access 撤去) | 見える。**ただし世界中からも見える** — 1 節の D 18 本がそのまま公開になる |
| 案 2 (Access JWT → アプリ identity) | **変わらない。**Access の 302 は前段のままで、curl も `wrangler dev --remote` も 302 |
| 案 3 (現状) | **変わらない。**ただし ↓ で外せる |

**外し方**: Access アプリのポリシーに **service token を含む include** を足し、agent/CI は `CF-Access-Client-Id` / `CF-Access-Client-Secret` の 2 ヘッダを付けて叩く。**パスワード入力も OAuth 承認も要りません** — agent がやってはいけない操作を 1 つも踏まずに本番の HTTP を測れます。
この repo は**同じ仕組みを既に使っています** (`server/utils/ichiban-upstream.ts` が一番星の Access を Service Token で通っている)。3 ホストの meta JWT にも `service_token_status:false` が出ており、**Access 側が service token を評価する口はある**ことが読めます (今は提示していないので false)。

**★ ただし順番が逆になってはいけません。**
service token は Access を丸ごと通ります。⇒ **1 節の D 18 本と `/dvr-api/login` に認可が入るまで、service token を配ってはいけません。**入れた瞬間、その token は「本番の粗利スナップショットを消せる token」「一番星を叩ける token」になります。
**⇒ Q5 の解決は Q1 の完了が前提**、という依存が本設計のいちばん重要な線です。
**さらに §1 の C 段の注も併せて見てください** — 機械経路の shared secret は既に広く配られており
(`INTERNAL_SHARED_SECRET` は 3 つの Rust binary に焼かれている / `ippoan/auth-worker#482`)、
**「secret を持つ caller は限られている」という前提でもう 1 枚数えるのは危険**です。

現状の代替 (memory に既にある): `dev worker + binding だけ remote` / ログイン済みタブから同一オリジンで測る。**これらは Q1 が終わるまでの間、引き続き正しい経路です。**

---

## `ippoan/auth-worker` #416〜#420 (HttpOnly 化) との衝突

**衝突します。放置すると #922 の症状が戻ります。**

いまの単一サインインは、⑧ の `recoverFromCookie()` = **`document.cookie` で `logi_auth_token` を読めること**に乗っています。#420 が `HttpOnly` を付けた瞬間、この復元は**必ず空振り**します。

tracking はそれを認識しています:

- **#419**「`recoverFromCookie` を no-op 化し、認証判定を `GET /session/whoami` (credentials 付き fetch) へ寄せる」
- **#418** が `/session/whoami` / `/session/renew` を新設する

**したがって「壊れる」のではなく「置き換わる」設計になっています。**ただし本設計から見て**名指しで確認すべきリスクが 1 つ**あります:

> **`/session/whoami` は consumer から見て cross-origin です** (`dtako.ippoan.org` → `auth.ippoan.org`)。`credentials: 'include'` の fetch を通すには `Access-Control-Allow-Origin` に**具体的な origin** (`*` 不可) と `Access-Control-Allow-Credentials: true` が要ります。#418 の本文は `/session/renew` の **CSRF 対策としての Origin 検証**には触れていますが、**`/session/whoami` の CORS 応答**には触れていません。

**ここが抜けたまま #420 が入ると、全 consumer で cookie 復元が落ち、Access を通った直後のアプリが必ず自前ログインへ飛びます** — つまり **#922 の「2 回ログイン」が全社的に再発します**。⇒ **#419/#418 の受け入れ条件に「Access 経由で着地した consumer が追加ログインなしで認証される」を明記すべき**です。

**衝突しない部分**: `/oidc/authorize` は cookie を**サーバー側で**読みます (`getAuthCookies(request)`)。**HttpOnly の影響を受けません。**⇒ **Access → auth-worker の 1 段目は HttpOnly 化後も無傷**です。壊れうるのは 2 段目 (アプリ側の復元) だけ。

---

## 3 案の比較と推奨

| | 案 1 Access 撤去 | 案 2 Access JWT → アプリ identity | 案 3 IdP を auth-worker に揃える |
| --- | --- | --- | --- |
| 状態 | 未実施 | 未実施 | **★ 実施済み・稼働中 (実測)** |
| ログイン回数 | 1 回 | 1 回 | 1 回 (残るのは**選択画面 2 枚**) |
| 変更範囲 | Cloudflare + **この repo に認可を 18 本 + relay** | Cloudflare + auth-worker + この repo | **追加ゼロ** |
| 剥がす防御 | **edge を 1 枚まるごと** | なし | なし |
| agent/CI 可視化 | 解決 (代償: 世界にも可視) | 解決しない | service token で解決 (**Q1 完了が前提**) |
| #416〜#420 との相性 | 無関係 | identity 正本が 2 つになる | 1 段目は無傷・2 段目は #419 の置換に依存 |

### 推奨

**新しい案を採らないこと。**案 1 も案 2 も**採らない**のを推します。

1. **まず ⑧ を実測して「残りは何枚か」を確定する** (上の 30 秒手順)。ここが未確定のまま次を作ると、直っているものを直しに行きます。
2. **⑧ が成立していたら、残件は摩擦だけ**なので、着手順は
   **(a) `prompt=select_account` の扱いを決める** (§4、**ユーザー判断**) →
   **(b) `/login` に「有効な `logi_auth_token` があれば provider chooser を出さずに素通しする」短絡を足す** (④ の 1 枚が消える。`/oidc/authorize` に既にある `identityFromSession` を再利用するだけで、**auth-worker 内の 1 handler で閉じます**)。
3. **並行して、Access に依存しない認可を D の 18 本 + `/dvr-api/login` に入れる** — これは**単一サインインとは独立に、それ自体が必要**です。いまは「Access が偶然守っている」だけで、設計として意図された防御ではありません (`y-time-template.put` の JSDoc は「管理者専用画面 (要 JWT) で叩く想定」と書いていたのに、**その JWT を検証するコードがありませんでした**)。**A 段の `requireAuth` が既に確立している型なので、同じ 2 行を足すだけです。**
   **→ 書き込み 4 本は #988 の 1 本目で完了 (2026-08-27)。読み取り 14 本と `/dvr-api/login` は未着手。**
4. **3 が終わってから、Access に service token を足して agent/CI の目視を解決する** (§5)。

### 案 1 を採る場合の必要条件 (両論として残す)

**「採らない」は推奨であって決定ではありません。**採る場合、実行前に**全部**満たす必要があります:

- D の 18 本すべてに認可が入っている (**特に `/api/ichiban/**` の confused deputy**)
  — **書き込み 4 本は #988 の 1 本目で完了。残りは読み取り 14 本。**
- `POST /dvr-api/login` が塞がれている (theearth のパスワード試行台にしない)
- `/scraper-zip/{requestId}` の `requestId` のエントロピーが測られている
- **`dtako-staging` / `dtako-preview` も同時に判断されている** — 3 ホストは別 Access アプリだが
  **`DTAKO_R2` / `DTAKO_DB` は共用**。**穴が開くのはホストではなくデータ側**なので、
  「本番だけ外して様子を見る」は成立しない
- §1 C 段の注 (機械経路の secret が広く配られている) を踏まえた再評価

**逆に上を全部満たした時点で、案 1 の唯一の実利 (agent/CI の可視化) は 4 の service token で
代替できます。**⇒ **edge を剥がす理由自体が消えます。**それでも剥がすかは**ユーザーの判断**です。

---

## 測れなかったこと (と、その理由)

| 項目 | 理由 | 誰なら測れるか |
| --- | --- | --- |
| ⑧ (Access 通過後にアプリが自前ログインへ飛ばないか) | **ログインが要る。**資格情報の入力・OAuth 承認は代行してはいけない操作 | **ユーザー** (§「⑧ を私は測っていません」の 3 手順) |
| `Cf-Access-Jwt-Assertion` が Worker origin に届くか | 反射する口が無く、作るのは実装 | 一時 probe route を 1 本 (別 PR) |
| Access アプリの `policies` の中身 (`require`/`exclude`/`path` スコープ)、`allowed_idps` の中身、service token の有無 | **このセッションに Cloudflare の read tool が生えていません** (`ToolSearch` で access / zero trust / protect_hostname を引いて 0 件)。login ページから逆算できたのは「IdP が auth-worker OIDC 1 本」までで、**`everyone`/`allow` は親の実測を引用** | ユーザー / Cloudflare read tool を持つセッション |
| `ACCESS_OIDC_CLIENTS` の中身 (登録済み client の一覧) | Secrets Store の値。読めない (読むべきでもない) | ユーザー |
| 上流 rust-ichibanboshi が `Authorization` 無しの `/api/**` を弾くか (= `/api/ichiban/**` の緩和が効くか) | 別 repo・別ホスト、Access の裏 | 兄弟 #951 / 上流を読めるセッション |
| `/scraper-zip/{requestId}` の `requestId` の推測困難性 | 生成箇所は読めたが、エントロピーの実測はしていない | — (次に触るとき) |

---

## ★ ユーザーが決めること (実装側では決められません)

1. **`prompt=select_account` を外すか** — 共用 PC で「前の人の Google に黙って乗る」を許容するかどうかの判断です。**全 consumer 9 アプリに効きます。**中間案 (join のときだけ残す / query で透過) もあります (§4)。
2. **D の 18 本に「どの粒度の」認可を入れるか** — `requireAuth` (ログインしていれば誰でも) で足りるのか、粗利スナップショットのような**金額の証跡**には tenant / role / email まで要るのか。**`restraint-viewer-auth.ts` が「金額を誰が見てよいか — 軸が 2 本ある」として #556 に残している未決とほぼ同じ論点**で、そちらと揃えるべきです。
3. **agent/CI 用の Access service token を発行するか** — 発行するなら**上の 2 が終わってから**です (§5)。発行は Cloudflare の操作なので、いずれにせよユーザーの手になります。
4. **`/dvr-api/login` (theearth への無認証パスワード試行台) を塞ぐか** — Access を残す限り顕在化しませんが、**Access を外す議論を続けるなら前提条件**です。
5. **案 1 (Access 撤去) を検討対象として残すか** — 本設計は**残さない**ことを推しますが、edge を剥がす判断はユーザーのものです。
