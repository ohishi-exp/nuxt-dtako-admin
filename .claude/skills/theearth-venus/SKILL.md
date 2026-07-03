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

### DVR 通知一覧: `Monitoring_DvrNotification2`

- body: `{ sort: ",,0,100" }` (形式 `fieldName,dir,pageIndex,pageSize`)
- **`d` は `["<件数>", "<行配列を JSON エンコードした文字列>"]` の 2 要素配列**。
  `d` を直接行配列とみなすと件数文字列 `"4"` に `in` 演算子を当てて
  `TypeError: Cannot use 'in' operator ... in 4` で落ちる。**`d[1]` を再 `JSON.parse`** する。
- 行フィールドは **PascalCase**: `VehicleCD`(数値) / `VehicleName` / `SerialNo` /
  `FileName`(.vdf 付) / `FilePath`(通常空) / `EventType` / `DvrDatetime` / `DriverName` /
  `Latitude` / `Longitude` / `FileReceive` / `FileDownload` / `RunState` / `Speed` 等。
- **緯度経度は度 × 1e6 の整数** (例 `36339272` = `36.339272`)。`|値|>180` なら 1e6 で割る。

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
`Request_DvrFileDelete` / `VehicleStateTableForBranchEx` (現在地、フィールド名は推測)。

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
