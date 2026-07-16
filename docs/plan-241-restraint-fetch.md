# 拘束時間管理表 (F-ERS2010) CSV 一括取得・集計 — scrape 計画 (Refs #241)

対象: https://theearth-np.com/F-ERS2010[RestraintDataReport].aspx (乗務員拘束時間管理表)
目的: 対象ドライバー複数 × 指定期間 (年月範囲) の CSV をダウンロードして集計する。

## 実機調査結果 (2026-07-16、実ブラウザ + DOM 検査 + CSV 実ダウンロード)

1. **CSV 出力は 1 回の WebForms postback** (`ctl00$btnOutputCsv`)。onclick は
   `txtRenge()` のクライアント検証のみで、F-NOS3010 (csvdata.zip) のような
   2 段階 postback・確認ページは無い。
2. **年フィールド (`ucMonthDate_txtYear`) は maxLength=2 だが POST は 4 桁西暦が通る**。
   - 2 桁 ("25"=西暦のつもり / "7"=令和のつもり) はどちらも「該当データがありません」
     になった (企業の和暦/西暦設定に依存して解釈がぶれると推定)。
   - 検証した企業では 4 桁西暦 ("2025"/"2026") が常に成功。ただし**別の企業アカウント
     では年入力が "08" (= 令和8年) 表示になる** (和暦設定の企業が存在する) ため、
     **実装は [4桁西暦, 令和2桁ゼロ埋め] を順に試し、「該当データがありません」なら
     フォールバック**する (`restraintYearCandidates`。ページの `chkUseEra` checked を
     和暦 hint として試行順を逆にする)。
3. **乗務員は `txtStartDriver`〜`txtEndDriver` の CD range**。両方空 = 全乗務員
   (実測 112 名分 378KB、生成数十秒)。全員一括は重いので **1 名 × 1 月ずつ逐次取得**
   が既定 (ユーザー要件)。
4. **データ無しは HTTP 200 の HTML** (`DispMsg('該当データがありません。')`)。
   未集計の年月・その月に在籍しない乗務員CD がすべてこれになる。
   HTML は UTF-8、CSV は Shift_JIS — デコードを分けないとマーカー判定が壊れる。
5. **CSV は theearth 側で「集計」(btnCalc → F-ERS2012) 済みの月しか出ない**。
   実測: 2026-06 は全乗務員分が出るが、検証に使った乗務員CD はその月に不在で該当なし。
   同乗務員の 2025-04 は 4 桁西暦指定で取得成功 (手動ダウンロードと同一バイト数)。

## 実装 (このPR)

```
[browser] /restraint-fetch (auth-worker ログイン + theearth credential pass-through)
   │ 乗務員CD 複数 × 年月範囲 → 1 名 × 1 月ずつ逐次 GET
   ▼
[worker/index.ts] /restraint-api/* → SCRAPER_RELAY service binding
   ▼
[relay index.ts] resolveTheearthRouting → DO `theearth-{comp}:{userB64}` (dvr/日報と共有)
   ▼
[DtakoScraperRelayDO]
   ├ POST /restraint-api/login|logout — 共通 theearth ログイン (セッション共有、Refs #233)
   ├ GET /restraint-api/report?year=&month=&driverFrom=&driverTo=
   │    downloadRestraintCsv → parseRestraintCsv → summaries (JSON)。該当なしは {no_data:true}
   └ GET /restraint-api/csv?... — 生 Shift_JIS CSV 素通し (該当なしは 404)
```

- `theearth-restraint-client.ts` (pure、coverage 100% gate):
  GET → full-form 直列化 (`serializeFormFields`、出力基準 radio 等の現在値を維持) →
  年月 (4 桁西暦)・乗務員 range を上書き → `btnOutputCsv` POST。
  応答は content-type で分岐: HTML (UTF-8) → ログイン画面 / 該当なし / 想定外 (loud fail)、
  それ以外 → Shift_JIS デコードして 1 行目マジック `拘束時間管理表` を検証。
- パーサ: 乗務員ブロック (事業所 / 氏名+CD / 日別 24 列 / 合計 / 年度累計) を構造化。
  合計行の月間拘束時間は「拘束時間小計」列 (実 CSV 確定)。`H:mm` → 分。
- フロント `/restraint-fetch`: 逐次取得の進捗表示、乗務員別期間合計・月別明細・
  日別詳細、集計 CSV (UTF-8 BOM) / 生 CSV (Shift_JIS) ダウンロード。

### R2 アーカイブ (バージョン管理、DTAKO_R2 / `RESTRAINT_R2_PREFIX`)

取得成功時に waitUntil で保存する (保存失敗は応答を落とさず console.error)。
取得パターン (乗務員別×1年分 / 全員×1ヶ月 等) に依らないよう、生 CSV は取得単位・
サマリは乗務員×年月に正規化する:

```
{prefix}/{compId}/{YYYY-MM}/csv/{driverFrom-driverTo|all}/latest.csv
{prefix}/{compId}/{YYYY-MM}/csv/{...}/v-{取得時刻JST}.csv        ← 内容が変わった時のみ
{prefix}/{compId}/{YYYY-MM}/summary/{乗務員CD}/latest.json
{prefix}/{compId}/{YYYY-MM}/summary/{乗務員CD}/v-{取得時刻JST}.json
```

- **データ変更の有無**: SHA-256 (latest の customMetadata) で検知。同じ内容を何度
  取得しても版は増えない。
- **最終確認日**: 内容不変の再取得では latest の `lastVerifiedAt` だけ更新 —
  「元の CSV は最終形が確定するまで変わりうる」ため、**いつの時点までこの値が
  合っていたか**が latest から分かる。各版の有効期間は自身の `fetchedAt` 〜
  次版の `fetchedAt`。
- **削除**: 新しい版に置き換えられた旧版は、後継版の出現から **7 日**
  (`RESTRAINT_VERSION_RETENTION_MS`) 経過後に保存時の掃除で削除する
  (最新版と latest は常に保持)。
- サマリを Postgres (rust-alc-api) に upsert する案は保留 (照会・アラート・
  restraint-compare 自動化が必要になったら rust-alc-api 側 issue を起こす)。

## 未検証・残作業 (CCoW / 実機で確認)

- [ ] staging デプロイ後、実アカウントで /restraint-fetch → login → 取得の一気通貫
- [ ] 全乗務員一括 (乗務員CD 空) の export タイムアウト余裕 (実測数十秒、
      `DEFAULT_EXPORT_TIMEOUT_MS=150s` 内に収まる想定)
- [ ] 集計範囲が「年月指定」以外 (期間指定モード) に設定された企業アカウントでの挙動
      (F-ERS2011 の設定次第で `ucStartDate`/`ucEndMonthDate` 側が有効になる)
- [ ] 和暦設定の企業アカウント (年入力が "08" = 令和8年 表示) で令和2桁フォールバックが
      効くことの実機確認
- [ ] R2 アーカイブの実機確認 (latest の customMetadata / 版の追加 / 7 日掃除)
- [ ] 未集計月の自動集計 (F-ERS2012 の `lstData_chkCheck_N` + 実行 postback) — 今回は
      スコープ外。必要になったら theearth 画面の 集計 を手動実行してから取得する
