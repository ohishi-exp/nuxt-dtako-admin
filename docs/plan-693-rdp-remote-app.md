# plan-693 — dtako-admin 内に一番星機の RemoteApp を canvas 描画する (RDP remote app)

Refs #693

dtako-admin の画面内に、一番星機 (`172.18.21.102` / CAPE#01) で publish 済みの **RemoteApp**
を canvas 描画し、クライアントに何も入れずに操作できるようにする。
本書は**方針確定のみ**。実装は後続 PR に分ける。

## 前提 (user 確認済み、2026-08-17)

- 対象機は **`172.18.21.102` (CAPE#01 の SQL Server 機と同一)**。
- **Windows Server で RemoteApp は設定済み**。サーバ側の publish 作業は不要。
  → Win10/11 Pro 向けの `TSAppAllowList` / `fAllowUnlistedRemotePrograms` の非公式手段も、
    「同時 RemoteApp セッション 1 本」の制約も**本件には該当しない**。
- 到達経路は **cloudflared**、描画は **dtako-admin 内の canvas** が理想形。
- Cloudflare Access の browser-based RDP (フルデスクトップ) を併設するかは**保留**。

## 結論 (先に読むところ)

- **描画クライアントは Apache Guacamole 系を採る。** `guacamole-common-js` を dtako-admin の
  ページに埋め込み canvas 描画、後段は `guacamole-lite` (Node) + `guacd`。
  **RemoteApp (RAIL) に対応している既製実装がこれしか無い**ため。
- **`guacd` / bridge は ohishi-data 上の新しい repo に置く。**
  `rust-ichibanboshi` には相乗りさせない。
- **dtako-admin は WebSocket を中継し canvas を描くだけ。** RDP プロトコルは実装しない。
- **`nuxt-ichibanboshi` に lib を作って配布しない** (現時点では。rule of two)。
- **最初にやるのは実装ではなく spike。** `guacd` から `172.18.21.102` の RemoteApp が
  実際に起動できるかを先に確認する (後述の既知不具合があるため)。

## 目標構成

```
ブラウザ (dtako.ippoan.org の canvas ページ)
  │  guacamole-common-js が Guacamole protocol を WebSocket で話す
  ▼
dtako-admin worker  ── /ws/rdp
  │  既存の JWT gate 配下。CF Access service token を付けて中継
  │  (/api/ichiban/* と同じ資格情報の付け方、/ws/scraper と同じ WS 中継の形)
  ▼
Cloudflare Tunnel (ohishi-data の cloudflared、公開ホスト名)
  ▼
ohishi-data (Linux)
  ├─ guacamole-lite (Node)   … WebSocket ⇄ guacd の橋渡し
  └─ guacd (C)               … Guacamole protocol → RDP。FreeRDP を使う
        │  LAN 内なので tunnel を経由しない
        ▼
172.18.21.102:3389 (Windows Server / RemoteApp publish 済み)
```

- **利用者のブラウザは `dtako.ippoan.org` としか喋らない。** 別タブも別ログインも発生しない。
- **`guacd` から対象機へは LAN 直**。cloudflared が要るのは Cloudflare → ohishi-data の 1 区間だけ。
- RemoteApp の指定は guacd の接続パラメータ `remote-app` / `remote-app-dir` / `remote-app-args`。

## なぜこの構成か

### 描画クライアントの選定

| | RAIL (RemoteApp) | canvas 埋め込み | 判定 |
|---|---|---|---|
| **Guacamole** (`guacamole-common-js` + `guacd`) | **○** (`remote-app` パラメータ) | ○ (自前アプリに埋め込み可。tunnel 実装も差し替え可) | **採用** |
| **IronRDP** (Rust + WASM) | **不明 / 記載なし** | ○ | 不採用 |
| **Cloudflare browser-based RDP** | **✕** (URL に RemoteApp を指定する口が無い) | **✕** (`X-Frame-Options: DENY` / `frame-ancestors 'none'` で iframe 不可) | 併設候補 (保留) |

- IronRDP は org のスタックには合う (`fc1200-wasm` / `net780-wasm` / `dtako_vid_wasm` の前例あり) が、
  公式の対応機能一覧に RemoteApp/RAIL が挙がっておらず、
  [discussion #712](https://github.com/Devolutions/IronRDP/discussions/712) でも言及が無い。
  **RAIL が無ければ「RemoteApp を出す」という要件を満たせない**ため採らない。
- Cloudflare の browser-based RDP は実装ゼロで済むが、**RAIL 非対応でフルデスクトップになる**
  うえ、Access が iframe 埋め込みを拒否するため「dtako-admin 内に canvas」を満たせない。
  何も入れられない端末向けの逃げ道としては有用なので、併設は保留のまま残す。

### bridge に `guacamole-lite` を使う理由

本家 `guacamole-client` は Java servlet (Tomcat) だが、
[`guacamole-lite`](https://github.com/vadimpronin/guacamole-lite) は同じ役割を Node で置き換える
ライブラリで、**`guacamole-common-js` (WebSocket) ⇄ `guacd` (TCP)** を中継するだけ。
Tomcat を ohishi-data に持ち込まずに済む。自前で Guacamole protocol を書く必要も無い
(org 規約の lib-first)。

### `rust-ichibanboshi` に相乗りさせない理由

| 理由 | 具体 |
|---|---|
| デプロイのたびにセッションが切れる | `deploy.sh` が musl バイナリを `/opt/ichibanboshi/` に `mv` し、systemd `ichibanboshi-watcher.path` (PathModified) が検知して自動 restart する |
| 可用性が結合する | 売上 / 勤怠 / 給与 API と RDP セッションが同一プロセス寿命を共有する |
| 責務が違う | 本 service は「SQL Server を読んで REST で返す」もの |
| そもそも言語が違う | `guacd` は C、bridge は Node。Rust プロセスに同居させる意味が無い |

### `nuxt-ichibanboshi` に lib を作らない理由

- consumer がまだ dtako-admin 1 個。org 規約の **rule of two** に反する。
- `nuxt-ichibanboshi` はアプリであってライブラリ配布元ではない
  (org の前例は `auth-worker/packages/auth-client` = `@ippoan/auth-client`)。
- 2 個目の consumer が出た時点で、共有すべきは「canvas ページのコンポーネント」だけになる見込み。
  その時に改めて置き場を決めればよい。

## 最大のリスク: guacd の RemoteApp 不具合

**`guacd` を FreeRDP3 でビルドすると RemoteApp が「ログオン成功 → 即切断」になる既知不具合がある。**
FreeRDP2 でビルドすると正常に動く。

- [GUACAMOLE-2072 — RemoteApp disconnects immediately](https://issues.apache.org/jira/browse/GUACAMOLE-2072)
- [FreeRDP#11785 — FreeRDP3 RAIL Issues](https://github.com/FreeRDP/FreeRDP/issues/11785)
- Guacamole 1.5.5 では動作し、1.6.0 で再現するという報告
  ([Apache mail archive](https://lists.apache.org/thread/fyjb2t8obnpq1rggmpsn4bzmcog2x7w1))
- 回避策として報告されているもの: FreeRDP3 系パッケージを外して `freerdp2-dev` を入れ
  `guacamole-server` を再ビルドする / `guacd` に書き込み可能な `HOME` (`/var/lib/guacd`) を与える

**本件の成否はここに懸かっている。**よって最初の作業は実装ではなく spike (PR-1) とする。
spike が通らなければ方式ごと見直す (その場合の代替は「Cloudflare browser-based RDP でフル
デスクトップ」または「`.rdp` 配布 + ローカル mstsc」だが、どちらも canvas 埋め込みは満たせない)。

## 段取り (PR 分割)

### PR-0 — 方針確定 (本 PR)

本ドキュメントのみ。コード変更なし。

### PR-1 — spike: guacd から RemoteApp が起動できるか確認する

**ここが通らなければ以降は着手しない。** dtako-admin のコードは 1 行も書かない。

1. ohishi-data 上で `guacd` を動かす (バージョンと FreeRDP 世代を**明示的に固定**する)
2. `172.18.21.102:3389` へ RDP 接続できることを確認 (まず通常のデスクトップ接続で疎通確認)
3. `remote-app` パラメータで **publish 済みの RemoteApp が起動し、切断されない**ことを確認
4. 結果 (guacd / FreeRDP のバージョン、成否、詰まった点) を #693 に記録

事前に user から必要な情報:

- 対象 RemoteApp の **publish 名** (`||` に続くエイリアス。`remote-app` に渡す値)
- 接続に使う Windows アカウント (共有アカウントか、利用者ごとか)
- RDS がコレクション / 接続ブローカー構成になっているか (単独ホスト直結でよいか)

### PR-2 — bridge (新 repo) を立てる

1. 新 repo を作る (仮称 `ohishi-exp/rdp-bridge`)。`guacamole-lite` + `guacd` の構成
2. ohishi-data に deploy (`rust-ichibanboshi` / `smb-watch` と同じ systemd 運用に揃える)
3. cloudflared に公開ホスト名を追加し、**CF Access で保護**する
   (`rust-ichiban.mtamaramu.com` と同じ service token 方式)
4. **接続パラメータ (ホスト / ポート / `remote-app` / 資格情報) は bridge 側で組み立て、
   ブラウザから受け取らない。** ブラウザが任意の接続先を指定できる作りにしない
5. Windows の資格情報は **CF Secrets Store 経由**で入れる (`secret-inject` skill)。
   会話・log・tool param・plain env に値を出さない

### PR-3 — dtako-admin に canvas ページを足す

1. `/ws/rdp` を worker に足す (既存の `/ws/scraper` と同じ形。`worker/index.ts`)。
   既存の JWT gate 配下に置き、CF Access service token を付けて bridge へ中継
2. `guacamole-common-js` を使う canvas ページを追加
3. 接続先ホスト名は `wrangler.toml` の `[vars]` に置く (コードに埋めない)
4. `npm test` + typecheck green。**dev で実機確認して結果を PR に書く**
   (`dev-login-local-verify` skill、CLAUDE.md の規範)

### PR-4 (保留) — Cloudflare browser-based RDP の併設

何も入れられない端末 / 緊急時の逃げ道として、フルデスクトップの browser-based RDP を
併設するか。**user 判断待ち**。設定作業だけでコードは増えないが、フルデスクトップを
見せてよいかの判断が要る。

## リスク / 制約

| # | 内容 | 影響 | 対応 |
|---|---|---|---|
| 1 | **guacd の RemoteApp 不具合** (FreeRDP3) | 方式そのものが成立しない | PR-1 の spike で最初に潰す。FreeRDP2 ビルドで固定し、**バージョンを pin する** |
| 2 | **SQL Server 機に RDS が同居** | 対話セッションのリソースが DB と競合する。同時利用者が増えると影響が出る | 同時接続数の想定を user と握る。深刻なら RDS を別機に分ける |
| 3 | **Windows 資格情報の置き場** | bridge が RDP 資格情報を持つ = 漏れたら直接侵入される | Secrets Store + `secret-inject`。共有アカウントにするか利用者ごとにするかを PR-1 で決める |
| 4 | **bridge を公開ホスト名に出す** | 保護が甘いと LAN への踏み台になる | CF Access service token 必須。接続先はサーバ側で固定し、ブラウザから指定させない |
| 5 | **ohishi-data の運用負債が増える** | `guacd` (C) + Node プロセスが増える | systemd 運用を既存 (`ichibanboshi`) に揃える。監視と再起動方針を PR-2 で決める |
| 6 | **ohishi-data で docker が使えるか未確認** | `guacd` の配布形態が変わる | PR-1 で確認 (使えなければ距離ビルド or パッケージ導入) |
| 7 | **音声 / 印刷 / クリップボード** | 業務要件次第で詰まる | Guacamole は音声・印刷・ドライブリダイレクトに対応するが、要否と可否を PR-1 で確認 |
| 8 | **接続ブローカー構成だった場合** | 単純な IP:3389 直結では繋がらない | PR-1 で構成を確認 |

## 未確定事項 (誰が何を確認するか)

| 項目 | 確認者 | 影響 |
|---|---|---|
| 対象 RemoteApp の publish 名 | user | `remote-app` に渡す値。PR-1 に必須 |
| 接続に使う Windows アカウントの方針 (共有 / 個人) | user | 資格情報の管理方法 (リスク #3) |
| RDS がコレクション / ブローカー構成か | user | 接続先の指定方法 (リスク #8) |
| 想定同時利用者数 | user | リスク #2 の深刻度 |
| 音声 / ローカル印刷 / ファイル受け渡しの要否 | user | リスク #7 |
| ohishi-data の docker 可否 | Claude (PR-1) | `guacd` の配布形態 |
| bridge の repo 名 / 置き場 | user | PR-2 の前提 |
| 方式 A (フルデスクトップ) の併設可否 | user | PR-4 の要否 |

## 参照

- [Writing your own Guacamole application — Apache Guacamole Manual](https://guacamole.apache.org/doc/gug/writing-you-own-guacamole-app.html)
- [guacamole-lite (Node で guacamole-client を置き換える)](https://github.com/vadimpronin/guacamole-lite)
- [GUACAMOLE-2072 — RemoteApp disconnects immediately](https://issues.apache.org/jira/browse/GUACAMOLE-2072)
- [FreeRDP#11785 — FreeRDP3 RAIL Issues](https://github.com/FreeRDP/FreeRDP/issues/11785)
- [RemoteApp Fails in Guacamole 1.6.0 (Apache mail archive)](https://lists.apache.org/thread/fyjb2t8obnpq1rggmpsn4bzmcog2x7w1)
- [Devolutions/IronRDP — Which features are supported? (#712)](https://github.com/Devolutions/IronRDP/discussions/712)
- [Connect to RDP in a browser — Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/rdp/rdp-browser/)
- [Browser-rendered terminal — Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/browser-rendering/)
