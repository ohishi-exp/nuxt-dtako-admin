/**
 * /restraint-api の**theearth セッション不要**なルートを auth-worker introspect
 * (viewer 経路) で認可するための pure ロジック (Refs #272)。
 *
 * theearth セッション必須のままにするのは theearth を実際に触るルート
 * (login / logout / report / csv) だけ。それ以外の /restraint-api/* は
 * auth-worker JWT (introspect active) + tenant→comp 逆引きで許可する。
 *
 * comp スコープの根拠は DTAKO_ACCOUNTS (comp_id→tenant_id) の逆引き —
 * ルーティングヘッダ `X-Theearth-Comp-Id` をそのまま信用しない (ヘッダ偽装で
 * 他社のデータを読めない)。DTAKO_ACCOUNTS 未設定の環境では viewer 経路は常に
 * 不許可 (fail-closed、theearth セッション経路は従来どおり)。
 *
 * **`isR2OnlyRestraintPath` という名前は現在 R2-only ではない対象も含む
 * (Refs #615-4、親指摘 2026-08-03)。** #272 時点では対象が「賃金マスタ・
 * アーカイブ閲覧・wage-report 等、R2 しか読み書きしないルート」だけだったため
 * この名前になったが、#615-4 で足した `/restraint-api/kintai/{diff,refresh/*}`
 * は ichiban (オンプレ) / GCP (Supabase) を叩き、`refresh/*` は書き込みもする。
 * それでも同じ判定関数に乗せて安全なのは、ハンドラ側 (`dispatchRestraintApi` の
 * `authorizeRestraintViewer`) が theearth cookie を持たない合成 record を渡し、
 * 各ハンドラは `record.compId` (tenant スコープ済み) しか読まない設計だから —
 * 判定の実体は「theearth セッションが要らないルートか」であって「R2 しか
 * 触らないか」ではない。改名は影響範囲が広い (呼び出し元・test 名) ため
 * 見送り、意味のずれをここに明記するだけにとどめる。
 *
 * ## ★ 金額を誰が見てよいか — **軸が 2 本ある** (Refs #556、2026-08-26 実測)
 *
 * この repo の画面に出る金額は**出どころが 3 系統**あり、**掛かっている認可が違う**。
 * 「給与は email 制限済み」と一括りにすると読み違える:
 *
 * | 金額 | 経路 | 認可 |
 * | --- | --- | --- |
 * | 給与大臣の**実支給額** (支給項目) | `/api/kyuyo/payroll` | **給与 allowlist** (上流) |
 * | **単価マスタ × 拘束時間 の計算賃金** — 月次集計 CSV の `単価`/`…(円)`/`合計(円)`/`総支給時給(割増込)`、最低賃金チェック、タイムカードの残業額 | `/restraint-api/wage-report`・`/restraint-api/wage-master` (計算は `restraint-wage.ts`) | **tenant** (この関数) |
 * | **確定値スナップショット** (期間集計タブの `paid` / 差) | `/restraint-api/wage-snapshot`・`/restraint-api/wage-range` | **tenant (この関数) AND 給与 allowlist** (Refs #951) |
 *
 * **どちらの allowlist も、この repo には無い** — 給与 allowlist は上流
 * rust-ichibanboshi、全社閲覧 allowlist は auth-worker。**別物**で効き先も違う
 * (下の「email allowlist は 2 つある」)。
 *
 * **給与 allowlist** の実体は rust-ichibanboshi の `kyuyo::introspect::authorize()`
 * (`#82`) で、auth-worker introspect の `email` をオンプレ設定
 * (`KYUYO_ALLOWED_EMAILS`) と突き合わせる。**この repo は給与 allowlist の写しを
 * 持っていない**し、持たせると二重管理になる (片方だけ更新されて食い違う)。
 * 3 段目もこの正を**聞きに行く**だけ (`kintai-relay.ts` の `checkKyuyoAccess`)。
 *
 * **全社閲覧 allowlist** の実体は **auth-worker の `USER_ACL`** (Refs #1049)。
 * この relay は写しを持たず、**`/auth/introspect` の応答 `org_wide` (boolean) を
 * 聞きに行くだけ**。給与 allowlist と同じ「正本は 1 つ、写しは持たない」形。
 *
 * **なぜ 2 段目が tenant のままか**: あれは給与大臣の実データではなく、**この repo が
 * 持つ単価マスタから計算した労務管理値**で、最低賃金チェックはテナント内の総務が回す
 * 業務だから。**★ ただしこの線でよいかは依然として未決** — 誰が金額を見てよいかは
 * 実装側で決められることではない。**寄せる場合の道具はもう在る** — #951 で足した
 * `GET /api/kyuyo/access` と `checkKyuyoAccess` を同じように AND するだけ。
 * ⇒ **残っているのは「寄せるかどうか」の判断だけで、実装の障壁ではない** (#556)。
 *
 * **★ 3 段目 (確定値スナップショット) は上の論拠が当てはまらない**ので、
 * **#951 で給与 allowlist 側へ寄せた (決着済み)。**`paid` は給与明細由来の**実支給額**で、
 * この repo が計算した値ではない。#951 以前は tenant 単位だけだったため、
 * **給与 allowlist に載っている 1 名が保存した瞬間に、実支給額が tenant 全員の
 * 読める場所へ移っていた** —「漏れ」ではなく**「洗浄」**。
 *
 * いまは `handleWageRange` / `handleWageSnapshotPut` が、この関数の tenant 判定を
 * 通した**後**に `checkKyuyoAccess` (上流 `GET /api/kyuyo/access`) を AND する。
 * **読みだけでなく保存にも掛ける** — 読みだけ塞ぐと「見えないが汚せる」が残る。
 *
 * **★ ブラウザ JWT を転送する経路は `deps.onprem()`** (`kintai-relay.ts` に理由の表)。
 * wage-* 本体が `deps.gcp()` なのに合わせて `gcp()` へ揃えると、GCP 側には
 * 給与 allowlist が無いので**全員 503** になる。
 *
 * **2 段目 (単価マスタ × 拘束時間の計算賃金) は tenant のまま**で、これは**据え置き**
 * (#951 の対象外)。上の「なぜ 2 段目が tenant のままか」の論拠がそのまま生きている。
 *
 * ## ★ email allowlist は **2 つある** — 混同しない (Refs #1049)
 *
 * #1049 より前は「email allowlist」といえば上流の給与 allowlist 1 つだけだった。
 * いまは 2 つあり、**名前も置き場も効き先も違う**:
 *
 * | 呼び名 | 実体 | 決めること |
 * | --- | --- | --- |
 * | **給与 allowlist** | **上流** rust-ichibanboshi の `KYUYO_ALLOWED_EMAILS` (`kyuyo::introspect::authorize()`) | 給与大臣の**実支給額**を見てよいか |
 * | **全社閲覧 allowlist** | **auth-worker** の `USER_ACL` → introspect の `org_wide` (`isAllCompsViewer`) | **どの会社**を見てよいか |
 *
 * **無冠で「email allowlist」と書かないこと** — どちらの話か読み手が決められない。
 *
 * ## ★ 「金額の軸」と「会社の軸」は**直交していて AND で効く**
 *
 * - **給与 allowlist** = 給与大臣の実支給額を**見てよいか**
 * - **tenant + 全社閲覧 allowlist** (この関数) = **どの会社**を見てよいか
 *
 * どちらかがもう一方を上書きすることは無い。
 *
 * 上流の `authorize()` は **`role` を一切見ない** (`src/kyuyo/introspect.rs` 実読、
 * 2026-08-26)。したがって **`role === 'admin'` でも給与 allowlist に居なければ 403**
 * で、これは決めごとではなく**既に本番がそうなっている**。
 *
 * **admin に給与 allowlist を無視させる (fail-open) 案は却下**されている
 * (2026-08-26) — 上流の変更が要るうえ、「管理者だから全部見える」は給与を email
 * 単位に絞った方針そのものを崩す。**#1049 で会社の軸からも role を外したので、
 * この方針の論拠は 1 つ増えた** — いまは**どちらの軸も「role で特別扱いしない」で
 * 揃っている**。
 *
 * ## ★ 会社の軸が role を見るのをやめた理由 (Refs #1049)
 *
 * 以前は「role が `admin` なら DTAKO_ACCOUNTS の全会社」だった。根拠は
 * **「dtako の admin はグループ全体の管理者 1 人だけで、別テナント側に admin を
 * 増やす予定は無い」** (2026-07-25 ユーザー確認)。**その前提が崩れた** (管理者ロールの
 * アカウントが複数になった) ため、旧 doc 自身が指定していた「全社を許可する
 * allowlist に切り替えること」という条件に入った。
 *
 * ⇒ いまは **introspect の `org_wide` (= auth-worker の `USER_ACL`) だけ**で決める。
 * **role との AND にもしない** — 2 条件にすると role が変わったときに**黙って権限が
 * 消える**という分かりにくい失敗が増える。「誰が全社を見てよいか」は 1 か所で決める。
 * ⇒ **`role` は全社許可の判定に一度も現れない** (`allowedViewerComps` /
 * `compIdsInSameTenant` のどちらも引数に取らない)。
 *
 * ## ★ なぜ relay 側に allowlist を置かないか (Refs #1049、2 度目の再発明)
 *
 * **「テナントを越えてよい人」の正本は auth-worker の `USER_ACL` に既にある。**
 * relay に写しを作ると**二重管理**になり、片方だけ更新されて食い違う。
 * この案件では **#1004 と #1049 の 2 回**「この repo に allowlist を新設する」案が
 * 出た — **dtako の 3 repo に `USER_ACL` の言及が 0 件**で、知識が auth-worker に
 * しか無いため**構造的に見えない**のが機序 (`nuxt-dtako-admin-map` skill に明記した)。
 *
 * **★ `org_wide` を受け取る側の fail-closed はこちらの責任**。古い auth-worker は
 * このキーを返さない (additive な変更) ので、**`undefined` は false**。型崩れ
 * (`"false"` / `1` / `null`) も false に倒す — `isAllCompsViewer` の doc 参照。
 */
import type { DtakoAccountEntry } from "./cron";

/** theearth を実際に触るため theearth セッション必須のままにするルート。 */
const THEEARTH_ONLY_PATHS = new Set([
  "/restraint-api/login",
  "/restraint-api/logout",
  "/restraint-api/report",
  "/restraint-api/csv",
]);

/** theearth セッションが要らない (viewer 経路の対象になる) /restraint-api
 * ルートか。**名前は R2-only だが、実際の判定は「theearth セッション不要か」**
 * — module docs の「`isR2OnlyRestraintPath` という名前は…」を参照。 */
export function isR2OnlyRestraintPath(pathname: string): boolean {
  if (!pathname.startsWith("/restraint-api/")) return false;
  return !THEEARTH_ONLY_PATHS.has(pathname);
}

/** tenant_id が触れる comp_id 集合 (DTAKO_ACCOUNTS の逆引き)。
 * tenant 空・該当なしは空集合 (fail-closed)。 */
export function viewerCompIdsForTenant(
  accounts: DtakoAccountEntry[],
  tenantId: string,
): Set<string> {
  const out = new Set<string>();
  if (!tenantId) return out;
  for (const a of accounts) {
    if (a.tenant_id === tenantId && a.comp_id) out.add(a.comp_id);
  }
  return out;
}

/** ローカル開発専用の短絡 (`RESTRAINT_DEV_VIEWER_COMP`) が許可する comp_id 集合。
 * カンマ区切りで複数指定できる — 社員マスタの会社横断表示 (Refs #367) を
 * ローカルで検証するため。空要素・前後空白は落とす。 */
export function devViewerCompIds(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/** DTAKO_ACCOUNTS に載っている comp_id すべて (空 comp_id は除外)。
 * 載っていない comp は含めない — ヘッダ偽装で未登録の会社を触らせない。 */
function allRegisteredCompIds(accounts: DtakoAccountEntry[]): Set<string> {
  const out = new Set<string>();
  for (const a of accounts) {
    if (a.comp_id) out.add(a.comp_id);
  }
  return out;
}

/** この viewer が全社を見てよいか (**全社閲覧 allowlist**)。
 *
 * 判定の正本は **auth-worker の `USER_ACL`** で、この relay は
 * `/auth/introspect` の応答 `org_wide` を渡されるだけ (写しを持たない、
 * Refs #1049)。**role は見ない** — 理由は module docs の
 * 「会社の軸が role を見るのをやめた理由」。
 *
 * **★ 引数を `unknown` で受けて `=== true` だけを通すのは意図的**。値は
 * **上流 worker の JSON 応答**から来るので、型注釈は実行時の保証にならない:
 *
 * - **`undefined`** — 古い auth-worker はこのキーを返さない (additive な変更)。
 *   **応答欠落・キー欠落も同じ**
 * - **`null` / 数値 / オブジェクト** — 型崩れ
 * - **文字列 `"false"`** — ★ `Boolean("false")` は `true`。truthy 判定では
 *   通ってしまうので `=== true` で弾く
 *
 * ⇒ **真の boolean の `true` だけが全社許可**。それ以外は全部 false
 * (fail-closed = 自 tenant の会社のみ)。 */
export function isAllCompsViewer(orgWide: unknown): boolean {
  return orgWide === true;
}

/** viewer 経路で触れる comp_id 集合。
 * introspect の `org_wide` が `true` の viewer は **DTAKO_ACCOUNTS に載っている
 * 会社すべて** (載っていない comp は不可 — ヘッダ偽装で未登録の会社を触らせない)、
 * それ以外は自 tenant の会社のみ (Refs #1049)。 */
export function allowedViewerComps(
  accounts: DtakoAccountEntry[],
  tenantId: string,
  orgWide: unknown,
): Set<string> {
  if (isAllCompsViewer(orgWide)) {
    return allRegisteredCompIds(accounts);
  }
  return viewerCompIdsForTenant(accounts, tenantId);
}

/** `compId` と同じ tenant に属する comp_id 集合 (自分自身を含む)。
 * 社員マスタの会社横断表示・会社対応表 (comp-map) を「同じテナントの会社だけ」に
 * 絞るために使う (Refs #367)。DTAKO_ACCOUNTS に無い comp は空集合 (fail-closed)。
 * introspect の `org_wide` が `true` の viewer だけが全社ぶんを見られる
 * (Refs #1049 — ここも `allowedViewerComps` と同じ全社許可を持っているので、
 * 片方だけ絞ると素通りする)。**DO の record 経由**なので、古いセッション record に
 * `viewerOrgWide` が入っていない場合も `undefined` → false に倒れる。 */
export function compIdsInSameTenant(
  accounts: DtakoAccountEntry[],
  compId: string,
  orgWide?: unknown,
): Set<string> {
  if (isAllCompsViewer(orgWide)) {
    return allRegisteredCompIds(accounts);
  }
  const found = accounts.find((a) => a.comp_id === compId);
  const tenantId = found ? found.tenant_id : "";
  return viewerCompIdsForTenant(accounts, tenantId);
}
