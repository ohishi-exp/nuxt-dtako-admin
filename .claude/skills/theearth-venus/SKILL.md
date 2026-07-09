---
name: theearth-venus
description: theearth-np.com (web地球号、動態管理システム、ASP.NET WebForms + WCF VenusBridgeService) をブラウザレス fetch で叩く時の実機確定知見。ログイン (VIEWSTATE/ENCRYPTED・セッション重複=強制ログイン)、VenusBridge の応答形 ([件数, 行JSON文字列] の 2 要素配列)、DVR 動画の 2 段ダウンロード (Request_DvrFileDownload → /dvrData/{返却パス}) と車両→受信→再生可能の 3 段フロー、受信状態コード (fa-prcs-X-Y)、cdp での実機検証手順を 1 枚にまとめる。nuxt-dtako-admin の /dvr-viewer + workers/dtako-scraper-relay と ohishi-exp/dtako-scraper / nuxt_dtako_logs / browser-render-rust が同じ theearth を相手にする時に参照。トリガー:「theearth」「web地球号」「VenusBridge」「DVR」「ドラレコ」「.vdf」「Monitoring_DvrNotification2」「Request_DvrFileDownload」「Request_DvrFileTransfer」「viewstate MAC」「__VIEWSTATEENCRYPTED」「強制ログイン」「txtOverlapSessionID」「dvrData」「fa-prcs」「NET780」等。
---

# theearth-venus — theearth-np.com ブラウザレス攻略メモ (実機確定)

theearth-np.com (「web地球号」動態管理システム、ASP.NET WebForms + WCF `.svc`) を
Chromium なしの素の `fetch()` で叩くための確定知識。すべて 2026-07 に **cdp で実ページを
トレース + 実 API を叩いて確認済み** (Refs ohishi-exp/nuxt-dtako-admin#90)。

consumer 実装: `nuxt-dtako-admin/workers/dtako-scraper-relay/src/theearth-client.ts`
(ログイン + CSV) と `theearth-venus-client.ts` (VenusBridge + DVR)。姉妹実装:
`ohishi-exp/dtako-scraper` (Rust)、`ippoan/nuxt_dtako_logs`、`browser-render-rust`。

## 前提 (cookie jar / redirect)

- `fetch` に cookie jar が無いので自前実装 (`redirect:"manual"` で各ホップの
  `Set-Cookie` を収集 → 次リクエストに `Cookie` 付与)。Workers/undici は
  `headers.getSetCookie()` を持つ。
- ASP.NET の **ClientID (`id`) と POST name (`ctl00$MainContent$...`) は別物**。
  `id` をハードコードし、`name`/`value` は毎回ページから読む (仕様変更に強い)。
- 「黙って200」禁止: 想定要素が無い / マジック不一致は必ず throw。HTML エラーページを
  ZIP や動画として下流に流さない。

## ログイン (`/F-OES1010[Login].aspx?mode=timeout`)

POST フィールド: hidden 群 + `txtID2`=会社ID / `txtID1`=ユーザーID / `txtPass`=パスワード
+ `btnLogin`。**成功時は 302 redirect** が多い。

### 罠1: `__VIEWSTATEENCRYPTED` を必ず含める

ログインページは viewstate 暗号化が有効。hidden の **`__VIEWSTATEENCRYPTED` (値は空)** を
POST に含めないと ASP.NET が **HTTP 500「viewstate MAC の検証が失敗しました」** を返し、
**誰がログインしても 100% 失敗**する。`__VIEWSTATE` / `__VIEWSTATEGENERATOR` /
`__EVENTVALIDATION` と並べて必ず送る。CSV 経路 (`SCRAPER_MODE=http`) にも効く。

### 罠2: セッション重複 = 強制ログイン (再ログインで毎回通る道)

theearth は**同一アカウントの同時ログインを許さない**。前回セッションが生きていると、
ログイン POST の応答が「指定されたアカウントは既に使用されています。強制的にログインを
行いますか?」の重複プロンプトになる (`txtOverlapSessionID` にサーバーが session ID を
焼き込む)。ここで送る強制ログイン POST は、**実ブラウザのフォーム送信と同じく全部** 要る:

- hidden 群 + **credential (`txtID2`/`txtID1`/`txtPass`) + `txtOverlapSessionID` の焼込値**
  + `btnForced` (value は実ページで `"hide"`)
- `btnLogin`/`btnCancel` は押下 submit ではないので**送らない**

credential か overlap ID を落とすと拒否され「強制ログインに失敗しました」で必ず詰まる。

### 罠2b: ライセンス数超過 (`LicenceOverDialog`) は別経路、自動 kick 実装済み (2026-07-08 cdp-pair 実機確定)

「所属事業所からの接続がライセンス数を超えています」の startup script は
`LicenceOverDialog(message, info1, info2, btnName)` で、罠2 (`OverlapDialog`) とは別関数・
別フロー。ブラウザ操作では `OpenLicenceOver(info1, info2)` が
`F-OSS1010[LoginUserList].aspx?Target1=<info1>&Target2=<info2>` を別ウィンドウで開き、
一覧から選んだ行の session ID が `window.opener.ReturnLicenceOver({returnNo})` で戻り、
`txtOverlapSessionID = returnNo` を焼いてから `btnForced` を click する。

- `info1` = ログイン中セッションの内部 ID の CSV、`info2` = 対応するユーザー名の CSV。
  **`info1[i]` と `info2[i]` は常に同一セッションを指す (positional pairing)**。
- `F-OSS1010[LoginUserList].aspx` を実際に Target1/Target2 付きで GET して確認した結果、
  グリッドの**表示順は info1/info2 の並びと一致しない** (ログイン ID 昇順に並び替わる) が、
  返る `returnNo` は選択行の生 session ID そのもの。つまり **このページを一切開かなくても、
  info1 の要素をそのまま `txtOverlapSessionID` に書けば `ReturnLicenceOver` と同じ強制ログイン
  ができる** — ポップアップ経由は不要。
- `workers/dtako-scraper-relay/src/theearth-client.ts` の `login()` はこれを実装済み:
  `detectLicenceOver()` で `info1`/`info2` を解析し、**`info1[0]` (= 一覧の先頭 = 最初に
  ログインしたセッション) を kick して強制ログインする**。解析できない (サイト仕様変更等)
  場合のみ安全側の loud fail に倒す。
- kick したかどうか (`kicked`) と kick 対象ユーザー名 (`kickedUserName`、判明時のみ) は
  `LoginResult` として `login()` の戻り値に載り、`/dvr-api/login` `/daily-report-api/login`
  の JSON レスポンス (`kicked` / `kicked_user_name`) → `useTheearthSession.ts` の
  `lastLoginKick` → `DvrSessionHeader.vue` / `DailyReportSessionHeader.vue` の通知バナーまで
  一気通貫で表示される。

### F-GOS0030 の「車輌」絞込 (`txtSVehicle`/`txtEVehicle`) で F-DES1010 を車番検索する (2026-07-08 実機確定)

日報一覧 (F-DES1010) の車番検索はサーバー側絞込で実現できる。ただし**適用フローが
3 段階**で、1 つでも欠けると「保存は成功するのに一覧は絞り込まれない」状態になる
(最初の検証で誤って「効かない」と結論しかけた罠):

**効くフロー** (実測: 6572 指定で全行が車輌CD 6572 のみになった):

1. F-DES1010 を GET して **full form を確保** (btnUpdate postback 用)
2. F-GOS0030 を GET → full form + `txtSVehicle`/`txtEVehicle` (車輌CD range、8桁数値)
   を差し替えて **`btnOK` (適用) を押下 submit として POST**。応答の startup script
   `Return(val)` が成功マーカー (実ブラウザでは `window.opener.ReturnDisplayConfig(val)`
   → 親の `$('#btnUpdate').click()` が走る、`J-DES1010[OperationEdit].js` 実機取得済み)
3. **F-DES1010 の `btnUpdate` (`ctl00$MainContent$btnUpdate`、「更新」) を step 1 の
   full form で postback** — **この応答で初めて一覧が絞り込まれる**

**ハマりどころ (すべて実機で「効かない/壊れる」を確認済み)**:

- `lnkSaveCategory` (絞込条件保存) の `__EVENTTARGET` postback だけでは**一覧に反映
  されない** (設定の保存のみ。F-GOS0030 再 GET では値が見えるので「効いた」と誤認しやすい)
- `btnOK` 適用後でも **plain GET では絞込が消える** — btnUpdate postback の応答にしか
  反映されない。全ページ収集 (harvest) は btnUpdate 応答を 1 ページ目として開始する
  必要がある (`theearth-report-client.ts` の `harvestDailyReport` の `initialHtml`)
- btnUpdate を hidden だけの**部分 POST で送ると `ddlRowCount` (1ページ表示件数) が
  既定の 10 に落ちて残留する** (実機で 30→10 に化けて要復旧だった)。ASP.NET の select は
  POST に含めないと既定値扱いになるため、**full form 直列化 (`serializeFormFields`) が必須**
- この設定は theearth アカウント単位で共有される (同一アカウントを複数の担当者が共有
  している運用実績あり)。検索後は **`btnOK` で元値を適用し直して必ず復元**する
  (`withVehicleNarrow` が finally 相当で書き戻し、復元失敗は主エラーとして loud fail)
- 2 ページ目以降のページャ postback で絞込が維持されるかは**未検証** (実データが 1 ページ
  に収まった)。worker 実装は返す直前に車輌CD range で防御的にフィルタして混入を塞いでいる

Worker 実装: `workers/dtako-scraper-relay/src/theearth-report-client.ts` の
`withVehicleNarrow()` (`/daily-report-api/list?vehicleFrom=&vehicleTo=` から使用)。

### 状態判定

- ログインフォームは `txtOverlapSessionID`/`btnForced` を **value 無し hidden で常時含む**。
  文字列存在で overlap 判定すると認証失敗の再表示でも誤発動する →
  **`txtOverlapSessionID` の value が非空の時だけ**強制ログインに入る。
- 認証失敗 = 200 でログインページ再表示 (`txtPass` あり)。成功マーカー
  `Button1st_2`/`Button1st_7` は管理者アカウント trace 由来なので、ログインフォームでない
  未知の 200 ページは寛容に成功扱い (後続 API が実質の検証)。

## VenusBridge (`/Bridge/B-GOS0010[VenusBridgeService].svc/{Method}`)

WCF AJAX。`POST {svc}/{Method}` に JSON body → `{"d": ...}` を返す。**必ず content-type が
json であること + `d` の存在を検証** (ログイン切れは 200 空 body / HTML を返す →
`VenusSessionExpiredError` にして 401 で再ログインを促す)。

**セッション無効化は HTTP 500 でも現れる** (2026-07-03 staging 実機): 別の場所で同一
アカウントがログインする (theearth は単一セッション制) と、既存 cookie での VenusBridge
呼び出しは HTML ではなく **HTTP 500** を返す。500 も `VenusSessionExpiredError` → 401
にマップして再ログインを促すこと (502 に潰すと利用者が回復手段に辿りつけない)。

**ログイン直後から即叩ける・ページ遷移不要 (VenusBridge はセッション単位、2026-07-06 実機確定)**:
VenusBridge メソッドも aspx の plain GET も、**ログイン直後 (メインメニュー到達直後、対象
ページに一切遷移していない状態) から即座に 200 が返る**。「動態管理画面を開いてから」等の warm-up
は不要 — セッション cookie が有効なら**どのページに居るかに関係なく**叩ける (= ページ単位でなく
セッション単位のスコープ)。メインメニューのまま実測で確認済み:
`VehicleStateTableForBranchEx("00000000","0")` → `array[197]` (全事業所現在地) /
`Request_NetDvrFuncInitValue({})` → `array[6]` (マスタ) /
`Monitoring_DvrNotification2({sort:",,0,100"})` → `[件数, JSON文字列]` /
`Request_ScoreCalcuType({})` → JSON、いずれも遷移なしで 200。
Worker (`theearth-client`) は **login → 遷移せず即 VenusBridge POST / config GET** でよい。

### DVR 通知一覧: `Monitoring_DvrNotification2`

- body: `{ sort: ",,0,100" }` (形式 `fieldName,dir,pageIndex,pageSize`)
- **`d` は `["<件数>", "<行配列を JSON エンコードした文字列>"]` の 2 要素配列**。
  `d` を直接行配列とみなすと件数文字列 `"4"` に `in` 演算子を当てて
  `TypeError: Cannot use 'in' operator ... in 4` で落ちる。**`d[1]` を再 `JSON.parse`** する。
- 行フィールドは **PascalCase**: `VehicleCD`(数値) / `VehicleName` / `SerialNo` /
  `FileName`(.vdf 付) / `FilePath`(通常空) / `EventType` / `DvrDatetime` / `DriverName` /
  `Latitude` / `Longitude` / `FileReceive` / `FileDownload` / `RunState` / `Speed` 等。
- **緯度経度は NMEA 由来の DDMM 形式整数** (度×1e6 + 分×1e4 + 分小数×1e4。
  例 `32478749` = 32°47.8749' = 32.7981°)。実ページは `ConvertLatLngDDMMtoDD`
  (J-GOS0100[MapEvent].js) で度に変換して地図に描く。**「1e6 で割って度」は誤り**
  (初期実装がこれで数 km ずれていた)。DVR 行 / 現在地 / 動態履歴すべて同形式。
  0 は GPS 未捕捉。consumer 実装は `theearth-venus-client.ts` の `convertDdmmToDegrees`。

## DVR 動画ダウンロード (2 段) — 決定論パスは組み立てられない

実ページ `Scripts/J-AAV0100[NetDvrFunction].js` の `dvrFileDownload()` が真実:

```
1. VenusBridgeService.Request_DvrFileDownload({key1: SerialNo, key2: FileName})
   → d = [code, url, filename, key, err]
      code>0 なら url = サーバー生成の相対パス
      例: "27324455/4/4228/{dir}\\{file}.vdf"  ← 末尾は Windows 区切り '\'
2. GET /dvrData/{url}   (url の '\' は '/' に正規化。path traversal は弾く)
   → 200 / application/octet-stream / 先頭マジック "NET780" (0x4E 45 54 37 38 30)
```

**`/dvrData/{comp}/{support}/{vehicle}/{fn}/{fn}.vdf` を通知行から組み立てる決定論パス仮説は
実データで 404**。必ず `Request_DvrFileDownload` に url を解決させる。`FilePath` 列は空。
`.vdf` は数十 MB になるので DO/メモリに載せず **stream 素通し** (マジック検証は status
commit 前に済ませて loud fail 可能に)。

## 車両 → 受信 → 再生可能 の 3 段フロー

映像は最初は車両 (車載機) にしかない。通知はイベント alert が先に届くだけ。`FileReceive`
セルの class `fa-prcs-X-Y` が状態機械:

| コード | 意味 | 状態 |
|---|---|---|
| `0-0` | ［映像ファイル要求］ | requestable (未受信 → 受信要求できる) |
| `1-0` / `1-3` | 要求中 / 運行開始後に要求 | in_progress |
| `2-0` | アップロード中 (車両→サーバー) | in_progress |
| **`3-0`** | **［映像再生］** | **ready (ダウンロード/再生可)** |
| `1-1`/`1-2`/`2-1`/`3-1`/`3-2` | 未検出/タイムアウト/中断/破損 | error |

- **受信 (1 段目)**: grid_type 1 は `Request_DvrFileTransfer_target({key1: SerialNo,
  key2: FileName})` で車両に転送を要求。**非同期** (車両が後でアップロード) なので即応答を
  返し、完了は一覧再読込で `receiveState` が `in_progress`→`ready` に変わるのを見る。
  (grid_type 2 = 車輌絞込は `Request_DvrFileTransfer2(k1,k2,search_key,cb)` /
  `_MultiTarget`。応答先頭要素が結果コード、>0 で受理)
- **ダウンロード (`ready` のみ)**: 上記 2 段。未受信で `Request_DvrFileDownload` を呼ぶと
  `code<=0` が返る → 「受信してから」を促すエラーにする。

その他の VenusBridge メソッド (JS で確認、未実装): `Request_DvrDataPlayback`
(serialNo, fileName, vehicleCD — サイト内蔵プレイヤー用。.vdf を落として wasm decode
する我々のフローでは不要) / `Request_DvrFileList` / `Request_DvrFileProtection` /
`Request_DvrFileDelete`。

## 現在地 / 動態履歴 (2026-07-03 実機確定、/dvr-map)

いずれも `d` は **`VehicleSetStateData` の素オブジェクト配列** (通知一覧の
`[件数, JSON文字列]` 形式ではない)。GPS は DDMM 形式、0 = 未捕捉。

- **現在地** (VenusMain 位置情報): `VehicleStateTableForBranchEx(strBranchCD,
  strScrapCarDisp)`。strBranchCD は事業所 code ("00000001"、**"00000000" = 全事業所**)、
  strScrapCarDisp は廃車表示フラグ (通常 "0")。実フィールド: `VehicleCD`/`VehicleName`/
  `BranchName`/`DriverName`/`GPSLatitude`/`GPSLongitude`/`DataDateTime`("MM/DD HH:mm")/
  `ComuDateTime`/`Speed`/`Revo`/`GPSDirection`(進行方向)/`CurrentWorkName` 等 —
  nuxt_dtako_logs の推測実装 (`LAT_FIELD_CANDIDATES`) はこれで確定できる。
  - **地図マーカー** (実ページ `CreateCarMarkerAndLabel`、J-GOS0100): 車番 =
    `VehicleIconLabelForVehicle` / 日時 = `VehicleIconLabelForDatetime` / 乗務員 =
    `VehicleIconLabelForDriver` の 3 行ラベル + `GPSDirection` で回転する方向矢印。
    アイコン本体は状態色別 (`CarMarkerImages[imageIndex]`)。consumer (`DvrMap.vue`) は
    ラベルは確実に取れる `VehicleName`/`DriverName`/`DataDateTime` を使い、矢印は
    `GPSDirection` を度として `transform:rotate()` で回している。
  - **`GPSDirection` は度 (0〜360、北 0 時計回り、小数あり)** で実機確定 (2026-07-03、
    全事業所 153 台で dirMin=0 / dirMax=345.3)。**停車中 (Speed=0) は 0 になりがち**
    (方向不定)。度なので `rotate(${dir}deg)` でそのまま使える (方位や 0-255 ではない)。
- **動態履歴** (F-DOV0010): `VehicleStateTable(VehicleCD, dtmST, dtmED)` API は
  **GPS 軌跡しか返さず速度・回転数が全点 0** (2026-07-03 実機確認)。速度・回転数・住所・
  走行状態・乗務員は **2 段階 postback で返る HTML の `VehicleDisp` テーブルにしか
  無い**ので、API ではなく postback + span パースで取る (`getVehicleLogTrack` を
  この方式に置換済み):
  1. `GET /WebVenus/F-DOV0010[LogDataDisp].aspx` (パスは `/WebVenus/` 必須、無いと 404)
     → hidden (__VIEWSTATE 等)
  2. `btnBranch=絞込` (ddlBranch=00000000) postback → **ddlVehicle に全車輌がロード**
     される (初期 GET ページは車輌が空で、ここを飛ばして直接 btnDataDisp すると
     **event validation で HTTP 500**「無効なポストバックまたはコールバック引数」)
  3. `btnDataDisp=動態履歴` (txtVehicleCD=CD, ddlVehicle=**10桁ゼロ埋め**, txtStartDate/
     txtEndDate="YYYY/MM/DD") postback → `VehicleDisp` テーブル
  - 各 postback は**直前応答の hidden** を使う (event validation を通すため)。ボタン
    value は日本語だがページが UTF-8 なので `URLSearchParams` でそのまま送れる。
  - セル: `<span id="lstVehicle_lbl<Field>_<row>">値</span>`。フィールド:
    `lblSpeed`(km/h) / `lblRevo`(rpm) / `lblGPSLatitude`・`lblGPSLongitude`(DDMM) /
    `lblDataDateTime`・`lblComuDateTime`("MM/DD HH:mm") / `lblAllState`(運転/停車) /
    `lblState2`(高速/一般) / `lblAddressDispC`(住所) / `lblDriverName`("(CD)氏名") /
    `lblReciveTypeName`(動態/イベント)。行 index は `lblGPSLatitude` の id 列挙で確定。

## 映像検索: `Request_DvrDataList` (2026-07-03 実機確定、Refs #90 映像検索)

映像検索画面 (F-AAV0001 の 映像→映像検索、実装は J-AAV0100 の `igButton_dvrdata_click`)
が使うメソッド。body は `{ key: string[10] }`:

| idx | 内容 | 形式 |
|---|---|---|
| 0 | 開始日時 | `"YYYY/MM/DD HH:mm"` |
| 1 | 終了日時 | 開始 + 範囲[分] (同形式) |
| 2 | 車輌CD | カンマ区切り可、未指定は `""` |
| 3 | 乗務員CD | 同上 |
| 4 | 緯度 | **度×3600 の秒単位整数** (S は負)。未指定は `""` |
| 5 | 経度 | 同 (W は負) |
| 6 | 位置範囲 [m] | 未指定でも常に送る (既定 `"300"`) |
| 7 | 映像種別 | `"警告,警告,常時,緊急"` の 4 フラグ (**先頭 2 つは同値**) |
| 8 | 走行状態 | `"走行,停車"` |
| 9 | 道路種別 | `"一般,高速,専用"` |

実測例: `["2026/07/03 18:06","2026/07/03 18:36","2131","","","","300","1,1,1,1","1,1","1,1,1"]`

- サーバー側必須条件 (実ページの validation): 車輌/乗務員/位置範囲のいずれか 1 つ +
  各チェック群 (種別/走行/道路) それぞれ最低 1 つ。
- 応答は通知一覧と同じ `d = ["<件数>", "<行JSON文字列>"]`。行は通知一覧のフィールドに
  加えて `DataType`(映像種別) / `RunState`(走行/停車) / `RoadType`(一般/高速/専用) /
  `PlaceName` / `Speed` / `Revo` / `RowIndex` / `DriverCD` / `DataTypeCD`。
  `FileReceive` は同じ `fa-prcs-X-Y` class 文字列なので受信状態パースを共用できる。
- `Refresh_DvrDataList(key)` — 同じ key での再読込 (実ページは interval poll に使用)。
  `d[0] == "-1"` は取得失敗。
- **検索結果グリッドからの転送要求**は `Request_DvrFileTransfer_MultiTarget(key1, key2)`
  (key1=SerialNo CSV / key2=FileName CSV、「選択行要求」ボタン相当)。実ページは
  **車輌絞込検索時 (`vehicleNarrowFlag`) は単一行でも MultiTarget**、絞込なしは
  `_target` を使う。
- ダウンロードは通知一覧と完全に同一 (`Request_DvrFileDownload` → `/dvrData/{path}`)。

## フォーム用マスタ: `Request_NetDvrFuncInitValue` (実機確定)

body `{}` → `d` は 6 要素 `[事業所JSON, 車輌JSON, 乗務員JSON, 通知件数, 通知行JSON, 設定]`。
事業所は `[{code:"00000001", name}]`、車輌/乗務員は `[{code:数値, link:"事業所code", name}]`
(いずれも **JSON エンコードされた文字列**、再 parse が必要)。検索フォームの車輌/乗務員
ドロップダウン (事業所 link で絞込) がこれで作れる。

## 運行データ編集・再集計・連動・日報 (F-DES/F-NRS 系、2026-07 実機確定)

運行データの編集〜システム連動系は **全て ASP.NET WebForms の postback** で、
VenusBridge (`.svc`) ではない。関連ページ:

| ページ | aspx | 役割 |
|---|---|---|
| 運行データ入力 (一覧) | `F-DES1010[OperationEdit]` | 運行一覧 + 編集制御解除 |
| 運行データ修正 | `F-DES1011[OperationRevise]` | 乗務員/車両/日時/距離の主要フィールド修正 |
| 経費入力 | `F-DES1012[OperationExpenseEdit]` | 給油/高速/フェリー/その他経費 + 評価点再集計 |
| 作業入力 | `F-DES1013[OperationWorkEdit]` | 作業行編集 + 作業時間再集計 + システム連動開始 |
| 運転日報 | `F-NRS1010[DailyOperationReport]` | 作業時間の一括取得元 (下記) |
| 表示条件指定 | `F-GOS0030[DataDisplayConfig]` | 日報の並び順/絞込設定 (別ウィンドウ) |

### F-DES1010 [運行データ入力(一覧)] の実グリッド構造 (2026-07-08 cdp-pair 実機確定)

**日報編集の一覧はここを使う** (F-NRS1010 ではない — 当初 F-NRS1010 を「日報一覧」として
実装したが誤りだった。F-NRS1010 は「作業時間の一括取得元」という別用途で、編集画面への
導線 (OpeNo/StartOpe) を持たない。F-DES1010 は行ごとに編集/削除/明細ボタンを持ち、
OpeNo + StartDateTime が編集画面遷移にそのまま使える形で埋め込まれている)。

title = 「運行データ入力」。行 id は `MainContent_lstOperation_<Field>_<row>`
(**`T1_` 接頭辞は無い**、F-NRS1010 と紛らわしいので注意):

| Field | 内容 | 実測値の例 |
|---|---|---|
| `lblOperationNo` | **運行No (キー、22桁)** | `2607041256390000006572` |
| `lblStartDateTime` | **編集画面遷移の StartOpe そのもの** (`YYYY/MM/DD H:mm:ss`、**時は1桁のこともある** `2026/07/07 1:03:16`、ゼロ埋めされない) | |
| `lblExclusionFlag` | 排他ロック中フラグ (`"1"`=ロック中、行が赤字表示) | `"0"` |
| `lblOperationDate` | 運行日 (`YY/MM/DD`、2桁年) | `26/07/04` |
| `lblBranchCD` / `lblDisplayName` | 事業所CD / 事業所名 | `8` / `佐賀大石運輸㈱` |
| `lblVehicleCD` / `lblVehicleName` | 車輌CD / 車輌名 | `6572` / `佐賀100あ6572` |
| `lblDriverCD1` / `lblDriverName1` | 乗務員CD1 / 乗務員名1 | `1405` / `松尾　等` |
| `lblWorkStartDateTime` / `lblWorkEndDateTime` | 出社日時 / **退社日時 (=読取日、`MM/DD HH:mm`)** | `07/04 12:56` / `07/08 10:57` |
| `lblOperationStartDateTime` / `lblOperationEndDateTime` | 出庫日時 / 帰庫日時 (`MM/DD HH:mm`) | |
| `lblTotalRunningDist` | 総走行距離 | `1890.2` |
| `lblSalesFlag` / `lblExpenseFlag` | 売上 / 経費 入力状況 (`"未"`/`"済"`) | `未` |

F-NRS1010 に書いた「作業1〜5時間・距離・燃料の詳細」フィールドはこのページには**存在しない**
(F-NRS1010 固有)。

**編集アイコンの実体** (`J-DES1010[OperationEdit].js` 実機取得済み、`btnClick()` の中身):
- 鉛筆アイコン `imgEditButton` (`title="運行データの修正を行います。"`) → `CreateOperation(pass)`
  → `window.open("F-DES1011[OperationRevise].aspx?" + pass)` (別窓)
- クリップボードアイコン `imgDetailsButton` (`title="運行明細の入力を行います。"`) →
  `ExpenseEdit(pass)` → `window.open("F-DES1013[OperationWorkEdit].aspx?" + pass)` (別窓)。
  **F-DES1012 への導線はここに無い** — 実 UI は F-DES1013 を開いてから、その画面内の
  `btnExpense` ボタンで F-DES1012 へ遷移する想定 (F-DES1010 から直接は行かない)。
  Worker 実装は URL 直接遷移 (下記) で F-DES1010/F-DES1013 を経由せず F-DES1012 に直接
  GET できるので、この経路を辿る必要は無い。
- どちらも `pass = "OpeNo=" + lblOperationNo + "&StartOpe=" + lblStartDateTime` を組み立てる
  (**URL 直接遷移の OpeNo/StartOpe の値の出どころはこの2フィールドで確定**)。
- `_msgOtherEdit = "他ユーザー編集中のため処理を中止しました。"` (`ExclusionFlag` チェック時に
  表示、theearth-report-client.ts の `assertNoOtherEditConflict` の判定文言と一致確認済み)。

**ページャは「最初」「最後」だけ `<input type="submit">` (`__doPostBack` ではない)**:
```html
<span id="MainContent_dpOperation">
  <input type="submit" name="ctl00$MainContent$dpOperation$ctl00$ctl00" value="最初"
         disabled="disabled" class="aspNetDisabled Buttonglay">  <!-- 1ページ目は disabled -->
  <span class="gCurrentPage">1</span>
  <a href="javascript:__doPostBack('ctl00$MainContent$dpOperation$ctl01$ctl01','')">2</a>
  <a href="javascript:__doPostBack('ctl00$MainContent$dpOperation$ctl01$ctl02','')">3</a>
  ...
  <a href="javascript:__doPostBack('ctl00$MainContent$dpOperation$ctl01$ctl05','')">...</a>
  <input type="submit" name="ctl00$MainContent$dpOperation$ctl02$ctl00" value="最後"
         class="Buttonglay">
</span>
```
数字ページ・「...」は想定どおり `<a href="javascript:__doPostBack(target,'')">`。
**「最初」「最後」だけ通常の ASP.NET Button (`<input type="submit" name=… value=…>`)** —
`__doPostBack` 経路のリンク走査だけでは見つからない。POST body に `name=value` を含める
通常の postback (`btnScore` 等と同じパターン) で送る必要がある。ページ移動すると
`class="gCurrentPage"` の数字が現在ページに更新され、「最初」の `disabled` も動的に
切り替わる (1ページ目のみ disabled、実機確認済み)。

**絞込条件はページ上部に既定値が効いている** (`絞込条件[読取日]:26/04/08〜` のように
表示される、実機確認)。クエリパラメータなしの単純 GET でこの既定フィルタが適用された
状態のグリッドが返る (直近3ヶ月程度と見られるがサーバー側の既定値でありクエリでの
明示指定は今回未検証)。**要求した `from` がこの既定下限より古い場合、取りこぼしても
気づけない** (サーバー側で既に絞られているため) — 既定の下限より広い範囲が必要なら
表示条件指定 (F-GOS0030 相当の機構がこのページにもあるかは未検証) を確認すること。

### URL 直接遷移 (F-DES1011/1012/1013 共通、2026-07-08 実機確定)

3 画面とも `?OpeNo=<22桁>&StartOpe=<YYYY/MM/DD HH:mm:ss>` の URL パラメータで**直接編集
画面に入れる** (F-DES1010 の行クリック postback = `RowsClick` + hidden `#btnRowClick.click()`
を経由しなくてよい)。code-behind が URL パラメータから運行を解決して viewstate に読み込む。

- **StartOpe は URL エスケープ**: `2026/07/07 18:31:06` → `2026/07/07%2018:31:06`
- Worker からのアクセスがシンプル: `GET /F-DES1013[OperationWorkEdit].aspx?OpeNo=…&StartOpe=…`
  → `__VIEWSTATE`/`__EVENTVALIDATION`/`__VIEWSTATEGENERATOR` を hidden から抜き出し、
  編集した値と `btnRegist1` / `btnScore` を postback する
- **F-DES1010 の行クリック実装**は参考: `RowsClick(this)` (J-DES1010) が
  `#txtOperationNo`/`#txtStartDateTime`/`#txtCurrentID`/`#txtIndex` に値をセットしてから
  hidden `#btnRowClick.click()` を発火 → postback で code-behind が編集画面へ遷移。
  Worker からは URL パラメータ経路の方が hidden-click を模倣しなくて済む分ラク
- **排他ロックの挙動は未検証** (実装時に staging で確認、詰まったら F-DES1010 の
  `btnInitialize` = `ctl00$MainContent$btnInitialize` postback で全解放)

### F-DES1013 [作業入力] の編集フォーム (2026-07-08 実機確定)

`__VIEWSTATE` = 124KB (大)。title = 「作業入力」(空白パディング多数)。

**運行情報 (`txt*`)**:
- 出庫/帰庫日時: `txtOperationStartDateTime` / `txtOperationEndDateTime` (`YYYY/MM/DD HH:mm:ss`)
- 出庫/帰庫地点: `txtOperationStart{Place,City}{CD,Name}` / `txtOperationEnd{Place,City}{CD,Name}`
- 行先/到着: `txtDest{Place,City}{CD,Name}` / `txtArrivalDateTime` / `txtArrivalDateTimeEdit`
- コース: `txtCourse_1..3`

**作業行 `lstWork` (ctrl0..N 繰り返し)** — 「作業部分の変更」のメイン target:
| name (`lstWork$ctrl<i>$<field>`) | 意味 |
|---|---|
| `itxtStartDateTime` / `intxtStartDateTime` | 開始日時 (表示 / 内部) |
| `itxtEndDateTime` / `intxtEndDateTime` | 終了日時 |
| `iddlEventName` (select) | 作業種別 (積み/降ろし/休憩/待機 等、options は業務マスタ由来) |
| `itxtDriverType` | 運転者区分 |
| `itxt{Start,End}{Place,City}{CD,Name}` | 出発/到着地点 |

**主要ボタン**:
- **`btnRegist1`** = 通常保存 postback (name `btnRegist1`)
- **`btnScore`** = **作業時間再集計** (name `btnScore`、onclick 空 = 純 postback)
- **`btnLinkSys`** = システム連動開始 (初期 disabled、再集計成功後 enable = **再集計が連動の前提**)
- **`btnState`/`btnExpense`/`btnSales`/`btnRemarks`** = 別画面遷移 postback (onclick に `notUpdate()`
  + `WebForm_DoPostBackWithOptions` を含む、= 未保存警告後の遷移)
- **`btnPro`/`btnNext`** = 前後運行への遷移 (ButtonGreen)
- **`btnClose`** = `WinClose()` (別ウィンドウなので閉じるだけ)
- **`btnMultiManEdit`** = 交代データ修正 (`ShowMultiManEdit()`)

### F-DES1012 [運行経費入力] の編集フォーム (2026-07-08 実機確定)

`__VIEWSTATE` = 17KB。title = 「運行経費入力」。**4 つの経費リスト**を持つ:

- **`lstFuel`** = 給油行 ★ 「給油データの登録」のメイン target
- `lstTollRoad` = 高速道 (通行料)
- `lstFerry` = フェリー料金
- `lstOther` = その他経費

**`lstFuel` の給油行フィールド** (name = `lstFuel$ctrl<i>$<field>`):
| フィールド | maxLen | 意味 |
|---|---|---|
| `itxtOperationNo` | — | 運行No (hidden 相当) |
| `itxtSubNo` | — | サブNo |
| `itxtSupplyCategory` | 4 | 給油点検分類 (例: 1=主燃料) |
| `itxtSupplyStation` | 4 | 給油点検区分 (例: 1=自社) |
| `itxtSupplyType` | 4 | 給油点検種別 (例: 軽油) |
| `itxtDateTime` | 14 | 日時 |
| `itxtQuantuty` | 7 | 数量 (**原文スペルミス** "Quantity"→"Quantuty"。誤字をそのまま送る) |

分類/区分/種別の 3 つは **CD (4桁) だけ送る**。名前は表示専用 (UI 側で解決)。

**主要ボタン** (F-DES1013 と共通、`btnScore` のラベルだけ違う):
- **`btnScore`** = **「評価点再集計」** (F-DES1013 では「作業時間再集計」、**物理的に同一 button**)
  → **給油だけ編集 → `btnScore` は評価点だけ再計算、作業時間 (DriverState1〜5Min) は変わらない**。
  作業時間まで再集計するには F-DES1013 に遷移して `btnScore` を追加で押す必要あり
- **`btnExpenceEditSetting`** = 給油行 1 件モーダルの登録 (**原文スペル "Expence"**)
- **`btnLinkSys`** = システム連動開始 (disabled 初期状態)
- **`btnLinkSysEx`** = 連動ファイル作成 (className: none = 非表示)
- **`btnWork`/`btnState`/`btnSales`/`btnRemarks`** = 別画面遷移 postback

### F-DES1011 [運行データ修正] (2026-07-08 実機確定)

`__VIEWSTATE` = 5.7KB (シンプル)。title = 「運行データ修正」。**主に乗務員変更用のシンプル画面**。

**編集フィールド**:
- **`txtDriver1`** = 乗務員CD (maxLength=8) ★ 「乗務員登録」のメイン target
- `txtVehicle` = 車両CD / `txtBranch` = 事業所CD
- 時刻系 UserControl (年/月/日/時/分の 5 input セット):
  - `ucStartWork_*` = 出社日時 / `ucEndWork_*` = 退社日時
  - `ucStartOpe_*` = 出庫日時 / `ucEndOpe_*` = 帰庫日時
  - `ucOpeDate_*` = 運行日
- 距離: `txtStartOdo` / `txtEndOdo` / `txtDist` / `txtHaul`(積載) / `txtEway`(高速) / `txtBway`(バイパス)

**ボタン**:
- **`btnReg`** = 登録 postback (name `btnReg`、className `ButtonBlue`、onclick 空)
- **`btnCancel`** = `WinClose()` (別窓なので閉じるだけ)

**注意**: URL 直接 GET だと初期値が空。code-behind が JS `PageLoad` (J-DES1011) で埋める設計。
Worker 実装は「PageLoad を再現するのではなく、実ブラウザと同じ手順を fetch で回す」形が確実
(GET → hidden とフォームフィールドの初期値を viewstate から読む → 差分だけ変更 → postback)。

### 編集 → 再集計 → zip DL の主要フロー (2026-07-08 実機確定)

「日報編集」のメインユースケース:

1. **一覧**: F-NRS1010 全ページ収集 (期間フィルタ、退社日時 desc 検証)
2. **編集**: 対象運行を選択 → F-DES1013 (作業行) / F-DES1012 (給油) / F-DES1011 (乗務員) の
   いずれかに URL パラメータで直接遷移 → フィールドを変更 → 保存 postback (`btnRegist1` /
   `btnExpenceEditSetting` / `btnReg`)
3. **再集計** (作業/経費のみ): 保存直後の viewstate で `btnScore` postback
   - F-DES1013 の `btnScore` = 作業時間再集計 (DriverState1〜5Min が更新)
   - F-DES1012 の `btnScore` = 評価点再集計 (作業時間は変わらない)
   - **同じ運行を作業と経費の両方で編集した場合、両方の再集計を回す**
4. **zip DL**: 期間を指定して `F-NOS3010[GeneralCsv]` の CSV export
   (`theearth-client.ts` の `downloadCsvZip` 経路を再利用) で csvdata.zip をダウンロード。
   編集は theearth 側 DB に反映されるため、csvdata.zip も編集後の値が入る
5. **後始末**: 詰まったら F-DES1010 の `btnInitialize` で残留ロックを全強制解放

### F-NOS3010 の「運行データ選択」モード = 単一運行だけの csvdata.zip (2026-07-09 cdp-pair 実機確定、Refs #203)

`F-NOS3010[GeneralCsv].aspx` (連動データダウンロード) は日付範囲指定のほかに
**運行単位の選択 export** を持つ (`ctl00$MainContent$SelectM` radio:
`rdoSelect0`=運行データ選択 (ページ既定) / `rdoSelect1`=日付範囲指定)。

- **行クリック (`RowsClick`) は CSS 非表示の text input に値を入れるだけ** (F-DES1010 の
  行選択と同型):
  - `ctl00$MainContent$ucDataSelect$txtOperationNo` = 22桁 OpeNo
  - `ctl00$MainContent$ucDataSelect$txtStartDateTime` = `2026/07/09 5:40:08` 形式
  - `txtCurrentID` / `txtIndex` はハイライト復元用 (サーバは見ない)
- **`_Multi = 1` (複数選択可)**: Ctrl+クリックで両フィールドに**カンマ連結**追記
  (`MultiSelect` JS)。全選択/選択解除ボタン (`btnSelectAll`/`btnDeselect`) もある
- 可視「ダウンロード」`btnCsv` の onclick は `DateCheck() { $('#btnCsvSvr').click(); return false; }`
  — **日付範囲モードと同一の 2 段階 postback** (`btnCsvSvr` → 確認ページ → `btnCsvSvrOutput`)
- **一覧のグリッド表示・ソート・ページ位置は不要**: fresh GET から上記 2 フィールドへ
  直接値を書いて stage 1 を POST すれば良い (別運行 2 件で実機確認。unlock #187 と同じ教訓
  「行選択 UI の再現は不要、hidden field 直書きで足りる」)
- **stage 2 の罠 (実測)**: 確認ページへの再 POST に `ddlSystem` (連動出力形式 select) 等の
  フィールドを落とすと **22 バイトの空 ZIP (`PK\x05\x06` EOCD のみ) が 200 で返る**。
  日付範囲モードの「stage 2 で日付欠落 → 空 ZIP」と同じ罠の選択モード版。curated な
  フィールドリストではなく **`serializeFormFields` で確認ページの全 input+select を丸ごと
  再送**すること (`theearth-report-client.ts` の `downloadOperationCsvZip` が実装)
- 成功応答: `application/octet-stream` + `content-disposition: attachment; filename=csvdata.zip`、
  `PK\x03\x04` (実測 4〜6KB/運行、`KUDGIVT/KUDGURI/SokudoData(/KUDGFUL/KUDGSIR).csv` —
  同梱 CSV はその運行に存在するデータ種別によって増減する)

### 「編集日時」タイムスタンプはどこにも無い (確定)

`GetOperationData(OpeNo, Year)` が返す `OperationDataMember` (全115フィールド、実取得)
にも一覧グリッド行にも、**「いつ編集したか」を記録する列は存在しない**。あるのは
状態フラグのみ:

- `EditFlag_WorkEvent / _Sales / _Fuel / _Highway / _Ferry / _Other / _RoadEvent`
  (カテゴリ別に「手編集された」boolean)
- `LinkSysFlag` (システム連動待ちフラグ)、`ScoreCalcuType` (評価点計算タイプ)

→ 「◯日以降に編集された」では**絞れない**。日時が要るなら退社日時 (=読取日、下記) を使う。

### 排他ロック (ExclusionFlag) — 揮発、日時を持たない

- `GetOperationData(OpeNo, Year)` = 編集開始 → **その行に排他ロック** (`ExclusionFlag=1`、
  一覧で赤表示)。`GetOperationData_Cancel(OpeNo, Year)` = 解放。
- `btnInitialize` (編集制御解除、`ctl00$MainContent$btnInitialize` postback) = 残留ロックを
  **全強制解放**。
- ロックは編集セッション中だけの揮発値で **ロック取得日時は露出しない** → 履歴代わりに
  ならない。一括処理では「開始でロック取得→必ず Cancel で解放、詰まったら btnInitialize」
  の後始末が要る (残すと `_msgOtherEdit`「他ユーザー編集中のため処理を中止しました」で弾かれる)。

### 作業時間再集計 → システム連動開始 の連鎖 (実機で観測)

- **作業時間再集計 = `btnScore`** (name も `btnScore`、onclick 空 = 純 postback)。
  クライアント JS も VenusBridge も噛まず **サーバー code-behind が再計算**。
  **経費画面 (F-DES1012) では同一 `btnScore` が「評価点再集計」ラベル**で出る (同じ物理ボタン)。
- 再集計成功 → モーダル **「再集計が終了しました。」** → **システム連動開始 `btnLinkSys` が
  disabled→enabled** に変わる (class `aspNetDisabled ButtonCrimson`→`ButtonCrimson`、
  サーバー再描画で決定。クライアント enable ではない)。= **再集計が連動の前提** (順序依存)。
- `btnLinkSys` (システム連動開始) / `btnLinkSysEx` (連動ファイル作成) も postback。
- `VenusBridgeService.ReCalculateOperation(operationNo, DbYear, calcHaul)` は VenusBridge に
  **存在するが UI ボタンはこれを使っていない** (両者が同一処理かは未検証)。一括 API 化を
  狙うならこれだが、`btnScore` postback と等価かは要確認。**連動 (LinkSys) は API 無し = postback のみ**。

### 運転日報 F-NRS1010 = 作業時間の一括取得元

指定期間の全運行を 1 つの HTML グリッドで返す **サーバー描画レポート** (JSON/CSV/VenusBridge
なし、CSV/印刷ボタンも無い)。行 id は `MainContent_T1_lstOperation_lbl<Field>_<row>`:

| Field | 内容 |
|---|---|
| `lblOperationNo` | **運行No (キー、22桁)** |
| `lblStartDateTime` | 出庫 (full year `YYYY/MM/DD H:mm:ss`) |
| `lblWorkStartDateTime` / `lblWorkEndDateTime` | 出社 / **退社 (=読取日、`MM/DD HH:mm`)** |
| `lblOperationStartDateTime` / `lblOperationEndDateTime` | 出庫 / 帰庫 |
| `lblDriverState1Min`〜`lblDriverState5Min` | **作業1〜5時間** (再集計で変わる本体、`H:mm`) |
| `lblTotalRunningDist` / `lblStartOdometer` / `lblEndOdometer` / `lblNwayRunningDist`(一般道) / `lblEwayRunningDist`(高速) / `lblBwayRunningDist`(バイパス) / `lblIntankFuel1`(自社) / `lblSSFuel1`(他社) | 距離・燃料 |

- **並びは退社日時 (=読取日) の降順** (出庫日時順ではない。出庫 06/28 で退社 07/06 の長距離運行が
  上位に来る、実測確認)。**退社日時 = 読取日** なので from-to は退社日時で判定でき、降順ゆえ
  **from 未満に落ちた時点で打ち切り可 (最後まで回さなくてよい)**。
- **フィルタは `表示条件` = [読取日] range** (編集日ではない)。表示件数 `ddlRowCount` は最大30
  (全件オプション無し)。
- 「合計時間」列は無い → 判定には **拘束時間 = 退社−出社** または **作業時間合計 = 作業1〜5の和**
  を算出。現在値スナップショットなので「再集計で変わったか」は before/after diff で見る。

### 日報グリッドを JS で一括収集する (ページャ駆動)

グリッドは **UpdatePanel (`MainContent_T1_upOperation`) 内の AJAX 部分ポストバック**。
`Sys.WebForms.PageRequestManager.getInstance()` の `add_endRequest` で完了待ちしつつ
`__doPostBack(target,'')` でページ送りすれば **画面遷移なしに全ページを 1 回の JS 実行で収集**
できる (deploy 不要)。要点:

- ページャ (`[id*=dpOperation]`) は `最初` / 数字ウィンドウ(1-5) / `...`(次ブロック) / `最後`。
  **ページ番号は絶対でなくウィンドウ相対** (`ctl01$ctlNN`) なので、数字 `<a>` のテキストで
  「現在ページ+1」を辿る (窓境界では `...` にフォールバック)。現在ページは `.gCurrentPage`。
- **開始前に「最初」へ戻す** (前回のページ位置が残るため。戻さないと途中ページから始まり
  取りこぼす)。
- 退社日時降順を利用し、あるページの最小退社日時 < from になったら break (早期打ち切り)。
- 退社は `MM/DD HH:mm` (年なし) → 同行 `lblStartDateTime` の年を基準に、退社月<出庫月なら +1年で
  年跨ぎ補正。

**早期打ち切りの前提 = 「読取日(退社日時)降順」は他ユーザーが変えうる (取得前に必ず確認)**:
並び順は F-GOS0030 の保存型設定 (`ddlOrder0`/`rdoDwOrder0`) で、**別ユーザーが優先項目保存で
昇順や別キーに変更できる**。降順を盲信して早期打ち切りすると、順序が崩れていた時に**黙って
取りこぼす** (「黙って200」と同じ罠)。対策の二段構え:

1. **取得前チェック**: F-GOS0030 を読んで `ddlOrder0==='ReadNo' && rdoDwOrder0.checked` を確認
   (違えば「読取日降順に直してから」を促す)。または、
2. **ランタイム検証 (推奨、config 非依存)**: ページを進めながら各行の退社日時が**単調非増加**か
   検査し、**増加 (=降順でない) を検出したら早期打ち切りを無効化して全ページ走査に fallback**
   (または loud fail)。他人が設定を変えても取りこぼさない。config を信じず実データで守るのが堅い。

### 表示条件指定 (F-GOS0030[DataDisplayConfig]) — 絞込 + ソート優先設定 (実機確定)

`btnConfig1`「表示条件指定」の onclick は `DataDisplayConfig()` = **`window.open` で別ウィンドウ**
で開く。cdp 拡張は元タブに attach しているので **新ウィンドウを開いた瞬間に
`extension_not_connected` になる** → 拡張 popup で新タブを選び直して再接続、または **元タブを
`F-GOS0030[DataDisplayConfig].aspx` へ直 navigate** して読み取り検査する (dialog opener 依存の
`適用` を押さない限り読取りは可能)。

保存は UserConfig 系 VenusBridge ではなく **WebForms postback** (`lnkSaveCategory`「絞込条件保存」/
`lnkPrio`「優先項目保存」/ `btnOK`「適用」= `OKClick()` / `lnkReset`「絞込解除」)。

**日付フィルタ (いつからいつまで)**: 日付種別 `select` (`ddlSortDay1`/`ddlSortDay2`、options
`OperationDate:運行日 / ReadNo:読取日 / OperationStartDateTime:出庫日 / OperationEndDateTime:帰庫日`)
+ 年月日 from〜to の 2 行。**読取日 を選べば読取日 range で server 側フィルタ**できる。

**ソート優先設定 (4段)**: `ddlOrder0`〜`ddlOrder3` (キー、options は ReadNo / 各種日時 /
距離 / 燃料 …約60項目) + 各段の `rdoUpOrder{N}`(昇順)/`rdoDwOrder{N}`(降順) ラジオ (`rdo{N}`)。
**実機の既定値 = 1番目 `ReadNo`(読取日) 降順、2番目 `OperationDate`(運行日) 降順** — これが
日報 F-NRS1010 が **読取日(=退社日時 `WorkEndDateTime`)降順**で並ぶ根拠。ソートキー options に
`WorkEndDateTime:退社日時` も `ReadNo:読取日` もあり、両者は同義 (退社日時=読取日)。既に降順
設定済みなので、降順前提の from-未満 早期打ち切りハーベスタがそのまま使える。

**Worker からのソート確認は plain GET で足りる (2026-07-06 実機確定)**: `window.open` は
ブラウザ UI の都合で、**Worker (素の fetch) には無関係**。`DataDisplayConfig()` は
`DialogArgs=""` = パラメータ無しで開くので、Worker が **`GET /F-GOS0030[DataDisplayConfig].aspx`
(認証 cookie 付き)** した URL と同一。ソート設定は **VenusBridge でなくサーバーが初期 HTML に
焼き込んで返す** (J-GOS0030 は VenusBridge を呼ばない) ので、生 GET の HTML を DOM パースして
`select[id$=ddlOrder0]` の selected value === `ReadNo` かつ `input[id$=rdoDwOrder0]` が checked
(降順) を確認するだけ。**ユーザー単位のサーバー保存値で、呼び出し元ページ・別窓に依存しない**
(メインメニューからの GET でも一覧/日報からの GET でも同一結果を実測、113,900 byte)。
セッション切れは `redirected===true` (finalUrl が `F-OES1010[Login]`) で機械検知 → 再ログイン。
他ユーザーが並び順を変える可能性があるので **harvest 前に必ずこの GET で確認** (or 日報グリッドの
退社日時列で単調非増加をランタイム検証) してから早期打ち切りに入る。

## cdp での実機検証手順 (このメモの作り方)

deploy/staging ループ (1 周 5〜10 分) を避け、cdp-pair で手元ブラウザに合流して 30 秒で回す:

1. `/cdp-pair` で pairing → theearth にログイン済みタブに接続 (`browser_eval` が生きればOK)。
2. `browser_eval` で **同一オリジン** から `fetch()` する (cross-origin は CORS で `Failed to
   fetch`。theearth を叩くならタブを theearth に置く)。パスワードは eval の戻り値に
   **出さない** (ページ内で組み立てて fetch、返すのは status/構造だけ)。
3. 応答の生構造 (`d` の型・要素・フィールド名・スケール) を JSON.stringify で観測。
4. ロジックは実ページ JS (`Scripts/J-*.js`) を fetch して読むのが最短 (関数本体・
   VenusBridge メソッド名・URL 組み立てが全部載っている)。
5. **副作用のある操作 (転送要求 `Request_DvrFileTransfer*`、削除等) は test-fire しない**。
   JS から署名だけ確定する。読み取り (Download URL 解決・一覧) は実際に叩いて確認してよい。

> セッションはすぐ切れる (空 200 が返り出したらタイムアウト)。切れたら再ログインしてもらう。

---

_共通の CCoW / cdp 運用は `cdp-pair` / `bun-browser-verify` skill、repo 構造は
`nuxt-dtako-admin-map` を参照。_
