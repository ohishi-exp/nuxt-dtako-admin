# plan-693 — dtako-admin から一番星機の Windows アプリをブラウザで操作する (RDP remote app)

Refs #693

dtako-admin の画面から、一番星の SQL Server 機 (`172.18.21.102` / CAPE#01) 上の Windows
アプリを、クライアントに何も入れずに操作できるようにする。本書は**方針確定のみ**で、
CF / Windows の設定と実装は後続 PR に分ける。

## 結論 (先に読むところ)

- **RDP の中継は自作しない。** Cloudflare Access の browser-based RDP (2025-09-22 GA) に乗る。
- **dtako-admin は「起動リンクを置くページ」だけ持つ。** RDP プロトコルの実装を repo に入れない。
- **`rust-ichibanboshi` に中継を相乗りさせない。別 repo も立てない。**
- **`nuxt-ichibanboshi` に lib を作って配布しない** (現時点では)。
- **RemoteApp (RAIL) によるシームレス表示は方式 A では取れない。** 代わりに Windows 側で
  専用アカウントの起動プログラムを対象アプリに固定し、「タブにそのアプリだけが出る」状態を作る。
  ローカルデスクトップへのウィンドウ統合が業務上必須と判明した場合のみ、後述の方式 C を併設する。

## 元の問い への回答

> rust-ichibanboshi で中継するか、nuxt-ichibanboshi で lib つくって配布するほうがいいか

**どちらも採らない。** 中継役は Cloudflare が既に提供しており、自作する部分が残らないため。

### rust-ichibanboshi に相乗りさせない理由

| 理由 | 具体 |
|---|---|
| デプロイのたびにセッションが切れる | `deploy.sh` が musl バイナリを `/opt/ichibanboshi/` に `mv` し、systemd `ichibanboshi-watcher.path` (PathModified) が検知して自動 restart する。RDP セッションを抱えたプロセスがこれに巻き込まれる |
| 可用性が結合する | 売上 API (`/api/sales/*`) / 勤怠 (`/api/kintai/*`) / 給与 (`/api/kyuyo/*`) と RDP 中継が同一プロセス寿命を共有する。片方の不具合が全部を落とす |
| 責務が違う | 本 service は「SQL Server を読んで REST で返す」もの。長寿命の双方向ストリーム中継は設計思想が別 |
| coverage 100% gate を巻き込む | `coverage_100.toml` の登録簿運用に、テストしにくい I/O 中継コードが混ざる |

仮に自作する場合でも、**rust-ichibanboshi ではなく ohishi-data 上の別 unit** にすべき。
ただし下記の通り自作自体を採らない。

### nuxt-ichibanboshi に lib を作らない理由

- consumer がまだ dtako-admin 1 個。org 規約の **rule of two** (2 個目が出た時点で抽出) に反する。
- 方式 A ではフロント側の実装が**接続 URL の組み立てとリンク描画だけ**で、lib 化する中身が無い。
- そもそも lib の置き場としても不適切 (`nuxt-ichibanboshi` はアプリであってライブラリ配布元ではない。
  org の前例は `auth-worker/packages/auth-client` = `@ippoan/auth-client`)。

将来 nuxt-ichibanboshi 側にも同じ導線が必要になったら、その時点で共有先を決めればよい。
現状の実装量なら、両方に数行ずつ書くほうが安い。

## 方式の比較

| | A: Cloudflare Access browser-based RDP | B: 自前中継 (Guacamole / IronRDP) | C: `.rdp` 配布 + ローカル mstsc |
|---|---|---|---|
| ブラウザ内描画 | ○ | ○ | ✕ (ローカルアプリで開く) |
| 真の RemoteApp (RAIL) | **✕** | Guacamole なら ○ / IronRDP は不明 | **○** (mstsc がネイティブ対応) |
| クライアント導入 | 不要 | 不要 | 到達性の手当てが必要 (WARP / `cloudflared access rdp` / Tailscale) |
| 実装量 | **ほぼゼロ** (設定作業のみ) | 大 (中継 + 認可 + 運用) | 小 (`.rdp` 生成のみ) |
| 認証 | CF Access (Google IdP) + Windows 資格情報 | 自前で作る | CF Access / Tailscale に委譲 |
| 監査ログ | CF 側に残る | 自前 | Tunnel 側のみ |
| 運用負債 | CF 依存 | **高い** (下記) | 低い |

### B を採らない具体的な理由

- **Guacamole**: `remote-app` / `remote-app-dir` / `remote-app-args` で本物の RAIL に対応するが、
  **1.6.0 で RemoteApp が「ログオン成功 → 即切断」になる既知不具合**がある
  ([GUACAMOLE-2072](https://issues.apache.org/jira/browse/GUACAMOLE-2072) /
  [FreeRDP#11785](https://github.com/FreeRDP/FreeRDP/issues/11785))。原因は guacd を FreeRDP3 で
  ビルドした場合で、回避には **FreeRDP2 で guacamole-server を再ビルド**する必要がある。
  自前ビルドの Java/Tomcat + C デーモンを ohishi-data で維持するのは、得られるものに対して重い。
- **IronRDP (Rust + WASM)**: org の技術スタックには合う (既に `fc1200-wasm` / `net780-wasm` /
  `dtako_vid_wasm` の前例がある) が、**web client の RAIL 対応が確認できない**。キーボード/
  マウス/クリップボード/CLIPRDR ファイル転送は謳われているが RemoteApp の記載が無い。
  結局 RAIL が無ければ A と同じ制約になり、実装量だけ増える。

### 「A + 単一アプリ」をどう成立させるか

Cloudflare の browser-based RDP の接続先は
`https://<app-domain>/rdp/<vnet-id>/<target-ip>/<port>` という URL 形式で、
**RemoteApp を指定するパラメータが無い**。よって RAIL は使えない。

一方、**ブラウザタブに描画している時点で RAIL 本来の価値 (ローカルデスクトップへの
ウィンドウ統合) は最初から得られない**。タブがすなわちウィンドウなので、
「タブの中に対象アプリだけが表示される」なら要件は満たせる。

実現は Windows 側で完結する:

1. RDP 専用のローカルアカウントを作る (一番星の日常業務アカウントと分ける)
2. そのアカウントの**セッション起動プログラムを対象アプリに固定**する
   (RDP セッションの初期プログラム指定、または当該ユーザーの `Shell` を対象 exe にする)
3. 結果、CF 経由でログインすると explorer デスクトップは出ず、対象アプリだけが立ち上がる

この設定は**方式 C にもそのまま流用できる** (`TSAppAllowList` の登録が RemoteApp 公開の前提)
ため、後で C を併設することになっても無駄にならない。

### 方式 C を将来併設する場合の前提 (調査済み)

Win10/11 Pro は **Windows Server / RDS 役割 / RDS CAL 無しで RemoteApp をホストできる**:

- GPO 「未一覧のプログラムのリモート起動を許可する」を有効化
  (= `HKLM\...\Terminal Server\fAllowUnlistedRemotePrograms` = 1)、もしくは
- `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Terminal Server\TSAppAllowList\Applications`
  にアプリごとのキーを作って公開対象を限定する

ただし **同時 RemoteApp セッションは 1 本のみ** (複数化には RDP Wrapper 等の非公式手段が要る)。
出典: [woshub: Configuring RemoteApps Hosted on Windows 10/11](https://woshub.com/run-remoteapps-desktop-windows/)

## 構成 (方式 A)

```
ブラウザ (社内/社外どこでも)
  │  ① dtako.ippoan.org の起動ページでリンクを押す (別タブ)
  ▼
https://<rdp-app-domain>/rdp/<vnet-id>/172.18.21.102/3389
  │  ② Cloudflare Access で Google IdP ログイン (Allow policy)
  │  ③ Cloudflare がブラウザ⇔RDP を終端・描画
  ▼
Cloudflare Tunnel (ohishi-data の cloudflared、private network route)
  │  ④ 172.18.21.102/32 へ
  ▼
172.18.21.102 (Windows / CAPE#01)
  └─ 専用アカウントでログオン → 対象アプリのみ起動
```

- **cloudflared は既存のものを使う** (ohishi-data で `rust-ichiban.mtamaramu.com` を出している
  tunnel)。新規 tunnel は建てない。private network route (`172.18.21.102/32`) を追加する。
- **Access アプリは専用の公開ホスト名で新設**する。既存の一番星 API 用アプリに相乗りさせない
  (RDP は public hostname 必須、かつ policy 要件が違うため)。
- dtako-admin 側は**リンクだけ**。RDP のバイト列は dtako-admin worker を一切通らない。

## 段取り (PR 分割)

### PR-0 — 方針確定 (本 PR)

本ドキュメントのみ。コード変更なし。

### PR-1 — 疎通 (CF / Windows 設定、コード変更なし)

先に**確認**すること (これが取れないと以降の設計が変わる):

- `172.18.21.102` の Windows エディションとビルド (Win10/11 Pro か Server 2016〜2025 か)
- ブラウザで動かしたいアプリの実体 (exe の絶対パス)
- 現在そのマシンにコンソールで誰かが常時ログインしているか

作業:

1. 既存 cloudflared に `172.18.21.102/32` の private network route を追加
2. Access for Infrastructure に target を登録
3. 公開ホスト名の DNS レコードを作成
4. Access self-hosted アプリを作り、browser-based RDP (RDP) を有効化。target criteria と
   port 3389 を指定
5. policy は **Allow のみ** (browser-rendered では **Bypass / Service Auth が使えない**)
6. Windows 側: RDP のセキュリティ層を **Negotiate または SSL** にする (legacy RDP だと接続不可)
7. ブラウザから直接 URL で接続できることを確認し、結果を #693 に記録

成果物はドキュメント (`docs/` に手順と検証記録) のみ。

### PR-2 — 単一アプリ化 + dtako-admin 起動導線

1. RDP 専用ローカルアカウントを作り、起動プログラムを対象アプリに固定
2. dtako-admin に起動ページを追加 (既存の `auth.global.ts` JWT gate 配下)
3. 接続先 (`app-domain` / `vnet-id` / target IP / port) は `wrangler.toml` の `[vars]` に置く。
   秘密ではないのでハードコードも secret も不要だが、**コードには埋めない**
4. `npm test` + typecheck green、dev で実機確認して PR に結果を書く
   (`dev-login-local-verify` skill、CLAUDE.md の規範)

### PR-3 (条件付き) — 方式 C の併設

PR-2 の運用で「ローカルデスクトップにウィンドウ統合されないと困る」と判明した場合のみ。
`TSAppAllowList` を登録し、dtako-admin から `remoteapplicationmode:i:1` を含む `.rdp` を
配布する。各クライアントの到達性の手当て (WARP / `cloudflared access rdp` / Tailscale) が別途必要。

## リスク / 制約 (先に握っておくこと)

| # | 内容 | 影響 | 対応 |
|---|---|---|---|
| 1 | **同時セッション 1 本** (Win10/11 Pro の場合) | ブラウザから RDP した瞬間、そのマシンのコンソールセッションが切断される。一番星の日常業務と衝突する | PR-1 で SKU と常時ログインの有無を確認。衝突するなら**踏み台の Windows を別に立てる**案に切り替える |
| 2 | **DB サーバへの対話ログイン** | SQL Server 稼働機にユーザーセッションを載せることになる。リソース競合と事故リスク | 同上。踏み台分離を第一候補として検討する |
| 3 | **二重ログイン** | dtako-admin の JWT ログインとは別に CF Access (Google) のログインが要る | 仕様として受け入れる。起動ページに明記する |
| 4 | **iframe 埋め込み不可** | Cloudflare Access は `X-Frame-Options: DENY` / `frame-ancestors 'none'` を返すため、dtako-admin 内に埋め込めない | 別タブ起動を前提に UI を作る |
| 5 | **音声なし** | RDP 越しの音声再生・マイクは非対応 | 対象アプリが音を使わないことを確認 |
| 6 | **クリップボード 500KB / テキストのみ** | 画像のクリップボード転送は不可 | 大量データの受け渡しはファイル転送 (beta) か既存の R2/API 経路で |
| 7 | **ローカル印刷は PDF のみ** | 帳票をローカルプリンタへ直接印刷する業務があると詰まる | PR-1 で業務要件を確認 |
| 8 | **転送量課金** | Zero Trust の無料枠はデータ転送 10GB。RDP は画面転送でデータ量が出る | 実測して超過見込みなら有料プラン ($7/user/月) を検討。**PR-1 で 1 セッションあたりの転送量を実測する** |
| 9 | **CF への依存** | 中継を Cloudflare に委ねる = 障害時に手段が無くなる | 緊急時の代替として方式 C の手順を文書に残す (PR-1 の成果物) |
| 10 | Entra 参加機の NLA | Entra 参加アカウントは PKU2U 非対応のため NLA 無効化が必要 | 該当しない想定だが PR-1 で確認。無効化してもセキュリティ層は TLS のままにする |

## 未確定事項 (誰が何を確認するか)

| 項目 | 確認者 | 判断への影響 |
|---|---|---|
| `172.18.21.102` の Windows SKU / ビルド | user (実機) | RemoteApp 可否・同時セッション数・踏み台要否 |
| 対象アプリの exe 絶対パス | user | 起動プログラム固定の設定値 |
| コンソールに常時ログインしているか | user | リスク #1/#2 の深刻度 |
| ローカルプリンタ印刷の要否 | user | リスク #7、方式 C 併設の要否 |
| ローカルデスクトップ統合が必須か | user (PR-2 運用後) | 方式 C (PR-3) の要否 |
| Zero Trust プラン / 転送量 | Claude (PR-1 で実測) | コスト |

## 参照

- [Connect to RDP in a browser — Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/rdp/rdp-browser/)
- [Browser-based RDP GA (2025-09-22)](https://developers.cloudflare.com/changelog/post/2025-09-22-browser-based-rdp-ga/)
- [Browser-rendered terminal — Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/non-http/browser-rendering/)
- [Configuring RemoteApps Hosted on Windows 10/11 (without Windows Server)](https://woshub.com/run-remoteapps-desktop-windows/)
- [GUACAMOLE-2072 — RemoteApp disconnects immediately](https://issues.apache.org/jira/browse/GUACAMOLE-2072)
- [FreeRDP#11785 — FreeRDP3 RAIL Issues](https://github.com/FreeRDP/FreeRDP/issues/11785)
- [Devolutions/IronRDP web-client](https://github.com/Devolutions/IronRDP/tree/master/web-client)
