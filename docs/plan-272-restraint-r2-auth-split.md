# restraint-api: R2-only ルートの認可分離 — 計画 (Refs #272)

`/restraint-api` の theearth セッション gate に、theearth に一切触らない R2-only
ルート群 (賃金マスタ・アーカイブ閲覧・wage-report・salary 設定) が相乗りしている
問題の解消。詳細な背景と実害は #272 本文。#268 の PR-D (ローカル mock) の前提。

## 設計

- **認可**: R2-only ルートは auth-worker `/auth/introspect` (relay 既存の
  AUTH_WORKER service binding + INTERNAL_SHARED_SECRET) で JWT を検証。
  introspect は `{active, tenant_id, role, email, sub, exp}` を返す —
  **auth-worker 側の変更は不要**。
- **comp スコープ**: `DTAKO_ACCOUNTS` (comp_id→tenant_id) を逆引きし、JWT の
  tenant_id が触れる comp 集合と `X-Theearth-Comp-Id` を突合 (ヘッダ偽装で他社
  R2 を読めない)。DTAKO_ACCOUNTS 未設定/不正は viewer 経路のみ fail-closed
  (theearth セッション経路は従来どおり)。
- **theearth 必須のまま**: login / logout / report / csv (実取得系) の 4 ルート。
- **後方互換**: theearth セッションが有効ならこれまでどおり全ルート通る。viewer
  経路はセッションが無い時のフォールバックとして追加 (デプロイ順 skew 安全)。
- **ローカル dev**: `wrangler dev --var RESTRAINT_DEV_VIEWER_COMP:<comp>` の時
  だけ introspect を短絡 (デプロイ環境にこの変数は置かない)。#268 PR-D の
  seed:local はこの上に乗る。

## PR 分割

| PR | 内容 | 状態 |
|---|---|---|
| **F1 (worker)** | `restraint-viewer-auth.ts` (pure、100% gate: R2-only 判定 + tenant→comp 逆引き) + DO の dispatchRestraintApi に viewer フォールバック + introspect の tenant_id 透過 | 本 PR |
| **F2 (app)** | `/restraint-wage` は**全タブ R2-only** と判明 (theearth ルート呼び出しゼロ、取得系は /restraint-fetch) → ページから theearth ログイン要求を撤去し、viewer ヘッダ (auth-worker JWT + 会社ID) に切替。theearth セッションが有効なら従来ヘッダを使う後方互換。会社ID は前回閲覧 → theearth ログイン履歴 → 手入力の順で prefill | 本 PR |
| **F3 (見送り)** | R2-only ハンドラの DO からの worker 直抽出は**やらない** — (1) `listAllR2`/`putVersionedR2` 等のヘルパを取得系 (theearth 必須側) と共有しており抽出は分割か重複を生む (2) マスタ PUT / resummarize の R2 書き込みが DO 単位で直列化される利点を失う (3) DO hop は同 colo 内で実質コストなし | 不採用 |
| **#268 PR-D** | seed:local + wrangler dev local + launch.json (F1 の dev 短絡を利用) | 未着手 |

## viewer 経路の合成レコード

R2-only ハンドラは `record.compId` しか参照しないため、viewer 認可成立時は
cookies を持たない合成 `TheearthSessionRecord` を渡す。theearth ハンドラ
(login/report/csv) には流れない (isR2OnlyRestraintPath で先に分岐済み)。

## F2 の実装メモ

- JWT は `app/utils/api.ts` の `currentAccessToken()` (initApi に渡された
  tokenGetter をそのまま返す)。素の `$fetch` 経路なので 401 自動 refresh は
  無い — viewer の 401 は「comp 不許可 or JWT 失効」としてエラー表示
- viewer の `X-Theearth-User-B64` は固定 `viewer` — 同一 comp の閲覧者は同一
  DO instance に集約され、マスタ PUT の直列化が per-comp で保たれる
- ページヘッダ (TheearthSessionHeader) は共有コンポーネントのため無改変 —
  theearth ログイン自体は引き続き可能 (ログインすれば従来ヘッダに戻る)
