# plan-693 — dtako-admin 内に一番星機の RemoteApp を表示する (RDP remote app)

Refs #693

dtako-admin の画面内に、一番星機 (`172.18.21.102` / CAPE#01) で publish 済みの **RemoteApp**
を表示し、クライアントに何も入れずに操作できるようにする。
本書は**方針確定のみ**。実装は後続 PR に分ける。

## 前提 (user 確認済み、2026-08-17)

- 対象機は **`172.18.21.102` (CAPE#01 の SQL Server 機と同一)**。
- **Windows Server で RemoteApp は publish 済み**。サーバ側の publish 作業は不要。
  → Win10/11 Pro 向けの `TSAppAllowList` / `fAllowUnlistedRemotePrograms` の非公式手段も、
    「同時 RemoteApp セッション 1 本」の制約も**本件には該当しない**。
- **RDS の CAL は「ユーザー CAL」で設定済み**。
- 到達経路は **cloudflared**、描画は **dtako-admin 内に埋め込む**のが理想形。
- Cloudflare Access の browser-based RDP (フルデスクトップ) を併設するかは**保留**。

## 結論 (先に読むところ)

**RemoteApp には Microsoft 純正のブラウザクライアント (RD Web Client / HTML5) が存在する。**
これが使える構成なら、自前の中継を持たずに済むので最優先で評価する。
ただし**「RemoteApp が publish されている」＝「RD Web Client が使える」ではない** — RD Web Access /
RD 接続ブローカーの役割と公的証明書が要るため、現構成次第で難易度が大きく変わる。

したがって方針は**分岐付き**で確定する。

1. **まず RDS の配置を確認する** (下記「最初にやること」)。役割・証明書・サーバ世代。
2. **RD Web Client が使える構成なら、それを第一候補**にする (方式 D)。
3. **dtako-admin への埋め込み (iframe) が通るかを実測**する。ここが本件の要求の核心。
4. **埋め込めない、または RD Web Client が使えないなら Guacamole** (方式 B) に進む。

いずれの分岐でも**変わらない**決定:

- **`rust-ichibanboshi` に中継を相乗りさせない。**
- **`nuxt-ichibanboshi` に lib を作って配布しない** (現時点では。rule of two)。
- **dtako-admin に RDP プロトコルを実装しない。**

## 方式の比較

| | D: RD Web Client (MS 純正) | B: Guacamole | A: CF browser-based RDP | C: `.rdp` + ローカル mstsc |
|---|---|---|---|---|
| RemoteApp (RAIL) | **○** (純正。publish 済みのものがそのまま出る) | ○ (`remote-app` パラメータ) | **✕** (URL に指定する口が無い) | ○ |
| ブラウザ内表示 | ○ | ○ | ○ | ✕ |
| dtako-admin への埋め込み | **未検証** (後述) | ○ (`guacamole-common-js` は埋め込み前提の設計) | ✕ (`X-Frame-Options: DENY`) | ✕ |
| 自前で持つ中継 | **無し** | guacd (C) + bridge (Node) | 無し | 無し |
| 前提条件 | RD Web Access + 接続ブローカー + 公的証明書 + ユーザー CAL | ohishi-data に常駐プロセス | CF Tunnel + Access | 各クライアントの到達性 |
| 主なリスク | 現構成が要件を満たすか不明 / 埋め込み可否不明 | FreeRDP3 の RAIL 不具合 | RemoteApp を使えない | 端末ごとの手当て |

## 方式 D — RD Web Client (第一候補)

`Install-RDWebClientPackage` 系で RD Web Access に HTML5 クライアントを載せると、
`https://<FQDN>/RDWeb/webclient/index.html` から publish 済み RemoteApp をブラウザで起動できる。
`Set-RDWebClientDeploymentSetting -Name "LaunchResourceInBrowser" $true` で
「`.rdp` をダウンロードさせず必ずブラウザ内で起動する」に固定できる。

### 前提条件 (MS 公式)

| 条件 | 状態 |
|---|---|
| RD ゲートウェイ + RD 接続ブローカー + RD Web アクセス (Windows Server 2016 / 2019) | **未確認** |
| **ユーザー CAL** (デバイス CAL だと全ライセンスを消費してしまう) | **✅ 設定済み** |
| RD ゲートウェイに KB4025334 | 未確認 |
| **RD ゲートウェイと RD Web アクセスに公的に信頼された証明書** | **未確認** |
| 接続先が Windows 10 以降 / Windows Server 2016 以降 | 満たす見込み |

Windows Server 2019 なら **RD ゲートウェイ無しで接続する手順が公式に用意されている**
(証明書をポート 3392 にバインドし、`HKLM\SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp`
の `WebSocketURI` を `https://+:3392/rdp/` にする)。ゲートウェイを立てたくない場合の逃げ道になる。
ただし RD Web アクセスと接続ブローカーは必要で、証明書は SAN=FQDN / CN=SAN の公的証明書が要る。

### 注意: 紛らわしいサポート終了告知

**2026-03-27 で "Remote Desktop web client" のサポート終了**という告知があるが、これは
**Azure Virtual Desktop / Windows 365 などパブリッククラウド向け**の話で、Windows App への
移行を促すもの。**オンプレの従来型 RDS 配置向け HTML5 web client は対象外**
(2025-06 の v2.1.65.0 まで更新継続)。混同しないこと。

### 埋め込み (iframe) の可否 — ここが未検証

「dtako-admin 内に埋め込む」という要求に対し、RD Web Client を iframe に入れられるかは
**現時点で確証が無い**。

- 「埋め込めない」という報告は存在するが、根拠として挙がっているエラーは
  `redirect_in_iframe: Code flow is not supported inside an iframe ... MSAL.js` で、
  これは **Entra ID 認証を使う AVD 版の話**。**オンプレ RDS 版は MSAL を使わない**ため、
  そのまま当てはまるとは限らない。
- MS 公式ドキュメントに iframe 埋め込みの可否についての記述は無い。

→ **推測で決めず、PR-1 で実際に iframe に入れて確かめる。** 通れば方式 D で完結し、
Guacamole は不要になる。通らなければ方式 B に進む。

## 方式 B — Guacamole (方式 D が駄目な場合)

```
ブラウザ (dtako.ippoan.org、guacamole-common-js)
  ⇅ WebSocket
dtako-admin worker (/ws/rdp、既存 JWT gate + CF Access service token)
  ⇅ cloudflared
ohishi-data: guacamole-lite (Node) → guacd (C) ──LAN直──→ 172.18.21.102:3389 (RemoteApp)
```

- RemoteApp の指定は guacd の接続パラメータ `remote-app` / `remote-app-dir` / `remote-app-args`。
- bridge は [`guacamole-lite`](https://github.com/vadimpronin/guacamole-lite) (Node) を使い、
  本家の Java servlet (Tomcat) を ohishi-data に持ち込まない。
- `guacamole-common-js` は自前アプリへの埋め込みを前提にした設計なので、
  **埋め込み要求に対しては方式 D より確実**。

### 方式 B 最大のリスク

**`guacd` を FreeRDP3 でビルドすると RemoteApp が「ログオン成功 → 即切断」になる既知不具合がある。**
FreeRDP2 でビルドすると正常に動く。

- [GUACAMOLE-2072](https://issues.apache.org/jira/browse/GUACAMOLE-2072) /
  [FreeRDP#11785](https://github.com/FreeRDP/FreeRDP/issues/11785)
- Guacamole 1.5.5 では動作し 1.6.0 で再現するという報告
  ([Apache mail archive](https://lists.apache.org/thread/fyjb2t8obnpq1rggmpsn4bzmcog2x7w1))
- 回避策の報告: FreeRDP3 系を外し `freerdp2-dev` で `guacamole-server` を再ビルド /
  `guacd` に書き込み可能な `HOME` (`/var/lib/guacd`) を与える

方式 B に進む場合は、**これを最初の spike で潰す** (bridge の repo を作る前に確認する)。

## 検討したが採らない案

### `rust-ichibanboshi` に中継を相乗りさせる

| 理由 | 具体 |
|---|---|
| デプロイのたびにセッションが切れる | `deploy.sh` が musl バイナリを `/opt/ichibanboshi/` に `mv` し、systemd `ichibanboshi-watcher.path` (PathModified) が検知して自動 restart する |
| 可用性が結合する | 売上 / 勤怠 / 給与 API と RDP セッションが同一プロセス寿命を共有する |
| 責務が違う | 本 service は「SQL Server を読んで REST で返す」もの |
| 言語も違う | `guacd` は C、bridge は Node。Rust プロセスに同居させる意味が無い |

### `nuxt-ichibanboshi` に lib を作って配布する

- consumer がまだ dtako-admin 1 個。org 規約の **rule of two** に反する。
- `nuxt-ichibanboshi` はアプリであってライブラリ配布元ではない
  (org の前例は `auth-worker/packages/auth-client` = `@ippoan/auth-client`)。
- 方式 D なら共有すべきものが「リンク or iframe」しか無く、lib 化する中身が無い。

### IronRDP (Rust + WASM) で自作

org のスタックには合う (`fc1200-wasm` / `net780-wasm` / `dtako_vid_wasm` の前例あり) が、
公式の対応機能一覧に RemoteApp/RAIL の記載が無く
([discussion #712](https://github.com/Devolutions/IronRDP/discussions/712))、
**RAIL が無ければ要件を満たせない**ため採らない。

### Cloudflare Access browser-based RDP

実装ゼロで済むが、**RAIL 非対応でフルデスクトップになる**うえ、Access が
`X-Frame-Options: DENY` / `frame-ancestors 'none'` を返すため埋め込めない。
何も入れられない端末向けの逃げ道として、併設は**保留**のまま残す (PR-4)。

## 最初にやること (user 確認 — これが取れないと先に進めない)

`172.18.21.102` で以下を確認する。

**1. RDS の役割構成** — サーバーマネージャー → リモート デスクトップ サービス → 展開の概要。
   「RD 接続ブローカー」「RD Web アクセス」「RD ゲートウェイ」のどれが配置済みか。

**2. Windows Server の世代** — 2016 / 2019 / 2022 / 2025。
   (2019 ならゲートウェイ無しで web client を動かす公式手順が使える)

**3. 証明書** — 展開のプロパティ → 証明書。RD Web アクセス / RD ゲートウェイ /
   RD 接続ブローカーに**公的に信頼された証明書**が入っているか (自己署名では不可)。

**4. RD Web Client が既に入っているか** — 管理者 PowerShell で:

```powershell
Get-Module -ListAvailable RDWebClientManagement
Get-RDWebClientDeploymentSetting -Name LaunchResourceInBrowser
```

   あるいはブラウザで `https://<サーバの FQDN>/RDWeb/webclient/index.html` を開いてみる。

**5. 対象 RemoteApp の publish 名** — 展開したコレクションの RemoteApp 一覧に出る名前。
   (方式 B に進む場合、`remote-app` に渡す値になる)

## 段取り (PR 分割)

### PR-0 — 方針確定 (本 PR)

本ドキュメントのみ。コード変更なし。

### PR-1 — 方式 D の可否判定 (dtako-admin のコードは書かない)

1. 上記「最初にやること」の 1〜5 を確認し、結果を #693 に記録
2. RD Web Client が未導入で前提を満たすなら導入する
   (`Install-RDWebClientPackage` → `Import-RDWebClientBrokerCert` → `Publish-RDWebClientPackage`)
3. `LaunchResourceInBrowser $true` で「必ずブラウザ内起動」に固定
4. **RemoteApp がブラウザで起動することを確認**
5. cloudflared で公開し、**dtako-admin から iframe に入るかを実測**
   (`X-Frame-Options` / CSP / cookie の SameSite / 認証の挙動を見る)
6. 判定を #693 に記録 — **通れば方式 D、通らなければ方式 B へ**

### PR-2 (方式 D の場合) — dtako-admin に組み込み

1. 埋め込みページを追加 (既存の JWT gate 配下)
2. 公開ホスト名を `wrangler.toml` の `[vars]` に置く (コードに埋めない)
3. `npm test` + typecheck green。**dev で実機確認して結果を PR に書く**
   (`dev-login-local-verify` skill、CLAUDE.md の規範)

### PR-2' (方式 B の場合) — guacd spike → bridge → 組み込み

1. **spike**: ohishi-data で `guacd` を立て、`remote-app` で RemoteApp が起動し切断されないか確認。
   guacd / FreeRDP のバージョンを明示的に固定し、結果を #693 に記録。
   **通らなければここで方式ごと見直す**
2. bridge の新 repo (`guacamole-lite` + `guacd`) を立て ohishi-data に deploy。
   cloudflared の公開ホスト名を CF Access で保護 (`rust-ichiban.mtamaramu.com` と同じ service token 方式)
3. dtako-admin に `/ws/rdp` (既存 `/ws/scraper` と同じ形) と canvas ページを追加

### PR-4 (保留) — CF browser-based RDP の併設

何も入れられない端末 / 緊急時の逃げ道として、フルデスクトップの browser-based RDP を
併設するか。**user 判断待ち**。

## リスク / 制約

| # | 内容 | 影響 | 対応 |
|---|---|---|---|
| 1 | **RDS が RD Web アクセス / 接続ブローカーを持たない可能性** | 方式 D の前提が崩れ、役割追加という別プロジェクトになる | PR-1 で最初に確認。追加コストが大きければ方式 B |
| 2 | **公的証明書が無い可能性** | 方式 D は自己署名では動かない | PR-1 で確認。取得コストを見積もる |
| 3 | **RD Web Client が iframe に入らない可能性** | 「dtako-admin 内に埋め込む」要求を満たせない | PR-1 で実測。駄目なら方式 B (埋め込み前提の設計) |
| 4 | **guacd の RemoteApp 不具合** (方式 B 選択時) | 方式 B が成立しない | spike で最初に潰す。FreeRDP2 ビルドで固定しバージョンを pin |
| 5 | **SQL Server 機に RDS が同居** | 対話セッションのリソースが DB と競合する | 同時利用者数の想定を握る。深刻なら RDS を別機に分ける |
| 6 | **Windows 資格情報の置き場** (方式 B 選択時) | bridge が RDP 資格情報を持つ | Secrets Store + `secret-inject`。方式 D なら利用者が web client に直接入力するので不要 |
| 7 | **中継を公開ホスト名に出す** | 保護が甘いと LAN への踏み台になる | CF Access で保護。接続先はサーバ側で固定しブラウザから指定させない |
| 8 | **音声 / 印刷 / ファイル受け渡し** | 業務要件次第で詰まる | 要否と可否を PR-1 で確認 |

## 未確定事項

| 項目 | 確認者 | 影響 |
|---|---|---|
| RDS の役割構成 (ブローカー / Web アクセス / ゲートウェイ) | user | 方式 D の可否 |
| Windows Server の世代 | user | ゲートウェイ無し手順が使えるか |
| 公的証明書の有無 | user | 方式 D の可否 |
| RD Web Client の導入状況 | user | PR-1 の作業量 |
| 対象 RemoteApp の publish 名 | user | 方式 B に進む場合に必須 |
| RD Web Client の iframe 埋め込み可否 | Claude (PR-1 で実測) | 方式 D か B かの最終判定 |
| 想定同時利用者数 / 音声・印刷・ファイルの要否 | user | リスク #5 / #8 |
| 方式 A (フルデスクトップ) の併設可否 | user | PR-4 の要否 |

## 実機検証ログ (2026-08-17)

対象機 `172.18.21.102` = `OHISHI-SRV.OHISHI.LOCAL` で実施。

### 確定した構成

| 項目 | 実測値 |
|---|---|
| OS | **Windows Server 2016 Standard** (10.0.14393)、HPE ProLiant ML30 Gen10 |
| ドメイン | `OHISHI.LOCAL` のメンバーサーバー (DC は `OHSV03.ohishi.local`) |
| 展開済み RDS 役割 | RD 接続ブローカー / RD セッション ホスト / RD Web アクセス (すべて同一機) |
| RD ゲートウェイ | 当初**未配置**。Windows 機能としては導入済みだが**展開への登録は未完** (後述) |
| RD ライセンス | 展開には未登録。**GPO で指定**されている (後述) |
| CAL | **ユーザー CAL** (`LicensingMode = 4`)、`LicenseServers = localhost` |
| 適用 GPO | `Default Domain Policy` と `ローカル グループ ポリシー` の 2 つのみ |
| 証明書 | 展開に**未設定だった**ため、検証用に自己署名証明書を作成し 3 役割に割り当て |

### 到達点 — 方式 D は原理的に成立することを実機で確認

1. `Install-RDWebClientPackage` → `Import-RDWebClientBrokerCert` → `Publish-RDWebClientPackage`
   で **RD Web Client の publish に成功**
2. `https://ohishi-srv.ohishi.local/RDWeb/webclient/index.html` に**ログインできた**
3. **publish 済み RemoteApp の一覧がブラウザに表示された** — `一番星 運送業システムVer.7`、
   `大蔵大臣 NXVer4Su...`、`cmd`、`CutStudio`、`Power Automate`、`Power BI Desktop`、
   `querySession` の 7 つ
4. アプリ起動時に「リモート PC への接続が失われました」で切断 →
   **MS が「一覧は見えるが接続できない場合は RD ゲートウェイを見よ」として挙げている症状**

つまり残件は RD ゲートウェイのみ。**publish・認証・一覧表示までは動作済み**。

### 詰まっている点 — `Add-RDServer` が「検証を実行しています」でハングする

RD ゲートウェイを展開に登録する `Add-RDServer -Role RDS-GATEWAY` が完了しない。

切り分け済み (すべて**シロ**):

| 候補 | 結果 |
|---|---|
| TLS 1.0 無効化 (Server 2016 の RDS + WID を壊す既知問題) | ✕ 該当せず。`RDMS` は `Running` |
| WinHTTP プロキシ | ✕ 「直接アクセス (プロキシ サーバーなし)」 |
| WinRM 不通 | ✕ `Test-WSMan` が正常応答 |
| 再起動保留 | ✕ `RebootPending` は `False` |
| Windows Update 待ち | ✕ `wuauserv` は正常 |

途中で `TSGateway` サービスが `StopPending` でハングする事象が発生 (後に `Running` に復帰)。

**残る最有力候補は GPO**。MS の
[Unable to Install RDS Deployment or Add RDS Roles](https://learn.microsoft.com/en-us/troubleshoot/windows-server/remote/unable-to-install-rds-deployment-or-add-rds-roles)
が「展開変更を失敗させる」として名指ししているポリシーの筆頭が
**「使用するリモート デスクトップ ライセンス サーバーを指定する」**で、本機にこれが当たっている。
推奨手順は「一時的に外して実行し、終わったら戻す」。

**業務時間外に実施する** (user 判断)。外している間、新規 RDS 接続がライセンス設定を見失うため。
`Default Domain Policy` 由来かローカル GPO 由来かは要確認 (ドメイン由来なら影響範囲が全マシンに及ぶ)。

### 副次的に判明した、設計に効く事実

- **`fDisableCdm = 1`** — クライアントのドライブ リダイレクトが**無効**。
  RemoteApp とローカル PC 間で**ファイルのやり取りができない**。ブラウザ経由でも同じ制約。
  業務でファイル受け渡しが必要なら別途対処が要る。
- **`cmd` が RemoteApp として publish されている** — コマンドプロンプトが誰でも開ける状態。
  社内 LAN 限定の現状では実害は小さいが、**dtako-admin から使える = 実質的に外に出す**ことになるため、
  公開前に publish 対象と RemoteApp ごとのユーザー割り当てを見直すこと。
- **`.local` ドメインのため公的証明書が取れない**。外部公開時は Cloudflare Tunnel で
  外向きの名前を与え、TLS を Cloudflare 側で終端する設計が必要。
- ESENT 490 (`SystemIdentity.mdb` へのアクセス拒否) が頻出するが、これは
  **RD ゲートウェイが Network Service で動くことによる既知の権限問題**で動作には影響しない。
  `icacls "C:\Windows\System32\LogFiles\Sum" /grant "NETWORK SERVICE:(OI)(CI)M"` で解消する。

### 次にやること

1. 「使用するリモート デスクトップ ライセンス サーバーを指定する」の Winning GPO を特定する
2. **業務時間外**に、当該ポリシーを一時解除して `Add-RDServer -Role RDS-GATEWAY` を完了させ、
   `Set-RDDeploymentGatewayConfiguration -GatewayMode Custom` と
   `Set-RDCertificate -Role RDGateway` まで実施し、**ポリシーを必ず復元する**
3. ブラウザ側 PC に自己署名証明書を「信頼されたルート証明機関」として導入し、
   **RemoteApp がブラウザ内で起動するところまで**確認する
4. そこまで通ったら、**dtako-admin への iframe 埋め込みを実測**して方式 D / B の最終判定を行う

`Add-RDServer` がどうしても通らない場合の回避策として、展開への登録を行わず
`Set-RDDeploymentGatewayConfiguration -GatewayMode Custom` で外部ゲートウェイとして指定し、
接続承認ポリシー (CAP) / リソース承認ポリシー (RAP) を RD ゲートウェイ マネージャーから
手動作成する道がある (自動作成される分を手で作る手間と引き換えにハングを回避できる)。

## 参照

- [Set up Remote Desktop web client for users — Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remote-desktop-web-client-admin)
- [Remote Desktop web client — what's new](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/web-client-whats-new)
- [Embedding remote desktop web client in IFrame (Microsoft Tech Community)](https://techcommunity.microsoft.com/t5/azure-virtual-desktop/embedding-remote-desktop-web-client-in-iframe/td-p/2957905)
- [Writing your own Guacamole application — Apache Guacamole Manual](https://guacamole.apache.org/doc/gug/writing-you-own-guacamole-app.html)
- [guacamole-lite (Node で guacamole-client を置き換える)](https://github.com/vadimpronin/guacamole-lite)
- [GUACAMOLE-2072 — RemoteApp disconnects immediately](https://issues.apache.org/jira/browse/GUACAMOLE-2072)
- [FreeRDP#11785 — FreeRDP3 RAIL Issues](https://github.com/FreeRDP/FreeRDP/issues/11785)
- [Devolutions/IronRDP — Which features are supported? (#712)](https://github.com/Devolutions/IronRDP/discussions/712)
- [Connect to RDP in a browser — Cloudflare One docs](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/use-cases/rdp/rdp-browser/)
