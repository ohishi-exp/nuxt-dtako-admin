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
| **F2 (app)** | R2-only 呼び出し (給与系タブ・アーカイブ閲覧) を app の auth-worker セッション JWT + comp 指定に切替。theearth ログインパネルの要求を実取得系のみに縮小 | 未着手 |
| **(任意) F3** | R2-only ハンドラを DO から worker 直 (`index.ts`) の stateless module に抽出 — 閲覧経路が theearth-{comp}:{userB64} DO を経由しなくなる。F1/F2 が安定してから | 未着手 |
| **#268 PR-D** | seed:local + wrangler dev local + launch.json (F1 の dev 短絡を利用) | 未着手 |

## viewer 経路の合成レコード

R2-only ハンドラは `record.compId` しか参照しないため、viewer 認可成立時は
cookies を持たない合成 `TheearthSessionRecord` を渡す。theearth ハンドラ
(login/report/csv) には流れない (isR2OnlyRestraintPath で先に分岐済み)。

## F2 の論点 (次 PR)

- app 側の auth-worker JWT の取り出し方 (@ippoan/auth-client のセッション) と
  `X-Theearth-Comp-Id` の供給元 (テナント設定 or 既定 comp)
- 給与系タブを theearth 未ログインで開けるようにするページ状態遷移
  (`showLoginPanel` の条件分岐)
