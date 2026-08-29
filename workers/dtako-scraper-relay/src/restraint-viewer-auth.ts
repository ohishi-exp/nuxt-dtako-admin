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
 * **給与 allowlist は上流にしか無い。全社閲覧 allowlist はこの relay にある** —
 * この 2 つは**別物**で、置き場も効き先も違う (下の「email allowlist は 2 つある」)。
 *
 * **給与 allowlist** の実体は rust-ichibanboshi の `kyuyo::introspect::authorize()`
 * (`#82`) で、auth-worker introspect の `email` をオンプレ設定
 * (`KYUYO_ALLOWED_EMAILS`) と突き合わせる。**この repo は給与 allowlist の写しを
 * 持っていない**し、持たせると二重管理になる (片方だけ更新されて食い違う)。
 * 3 段目もこの正を**聞きに行く**だけ (`kintai-relay.ts` の `checkKyuyoAccess`)。
 *
 * **全社閲覧 allowlist** (`ALL_COMPS_VIEWER_EMAILS`、Refs #1049) は**この relay が
 * 自分で持つ**。給与 allowlist の写しではないので、二重管理にはならない — 決める
 * ことが違う (実支給額の可否ではなく、**どの会社**を見てよいか)。
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
 * | **全社閲覧 allowlist** | **この relay** の `ALL_COMPS_VIEWER_EMAILS` (`isAllCompsViewer`) | **どの会社**を見てよいか |
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
 * ⇒ いまは **`ALL_COMPS_VIEWER_EMAILS` (全社閲覧 allowlist) だけ**で決める。
 * **role との AND にもしない** — 2 条件にすると role が変わったときに**黙って権限が
 * 消える**という分かりにくい失敗が増える。「誰が全社を見てよいか」は 1 か所で決める。
 * ⇒ **`role` は全社許可の判定に一度も現れない** (`allowedViewerComps` /
 * `compIdsInSameTenant` のどちらも引数に取らない)。
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

/** **全社閲覧 allowlist** (= DTAKO_ACCOUNTS に載っている会社すべてを見てよい
 * アカウント) を持つ環境変数名。中身は **JSON の文字列配列**
 * (`["viewer@example.com", ...]`)。
 *
 * **`ETC_ACCOUNTS` / `SCRAPE_ALERT_TARGET` と同じ作法** — Cloudflare dashboard の
 * plain 変数 + `keep_vars = true` で、**値は commit しない**
 * (`wrangler.toml` にはキー名とコメントだけ書く。`[vars]` に書くと deploy が
 * その値で dashboard を上書きしてしまう)。 */
export const ALL_COMPS_VIEWER_EMAILS_VAR = "ALL_COMPS_VIEWER_EMAILS";

/** DTAKO_ACCOUNTS に載っている comp_id すべて (空 comp_id は除外)。
 * 載っていない comp は含めない — ヘッダ偽装で未登録の会社を触らせない。 */
function allRegisteredCompIds(accounts: DtakoAccountEntry[]): Set<string> {
  const out = new Set<string>();
  for (const a of accounts) {
    if (a.comp_id) out.add(a.comp_id);
  }
  return out;
}

/** 突き合わせ用のメールアドレス正規化 (前後空白を落として小文字化)。
 * **allowlist 側と viewer 側の両方**をこれに通す — 片側だけだと大文字小文字の
 * 違いで一致しなくなる。 */
export function normalizeViewerEmail(email: string | undefined): string {
  if (!email) return "";
  return email.trim().toLowerCase();
}

/** `ALL_COMPS_VIEWER_EMAILS` の生値 → 正規化済み email の集合。
 *
 * **未設定 / JSON としてパースできない / 配列でない はすべて空集合**
 * (fail-closed = 全社許可を 1 件も出さない)。配列の中の文字列でない要素と、
 * 正規化した結果が空になる要素も落とす。**壊れた設定で全社が開かないこと**が
 * この関数の目的。 */
export function allCompsViewerEmails(raw: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return out;
  }
  if (!Array.isArray(parsed)) return out;
  for (const v of parsed) {
    if (typeof v !== "string") continue;
    const norm = normalizeViewerEmail(v);
    if (norm) out.add(norm);
  }
  return out;
}

/** この viewer が全社を見てよいか (**全社閲覧 allowlist**)。
 * **role は見ない** — 理由は module docs の「会社の軸が role を見るのをやめた理由」。
 * email 不在・allowlist 空 (未設定 / 壊れた設定を含む)・allowlist に未収載 は
 * すべて false (fail-closed)。 */
export function isAllCompsViewer(
  viewerEmail: string | undefined,
  allCompsViewerEmailsRaw: string | undefined,
): boolean {
  const norm = normalizeViewerEmail(viewerEmail);
  if (!norm) return false;
  return allCompsViewerEmails(allCompsViewerEmailsRaw).has(norm);
}

/** viewer 経路で触れる comp_id 集合。
 * `ALL_COMPS_VIEWER_EMAILS` に載っている email は **DTAKO_ACCOUNTS に載っている
 * 会社すべて** (載っていない comp は不可 — ヘッダ偽装で未登録の会社を触らせない)、
 * それ以外は自 tenant の会社のみ (Refs #1049)。 */
export function allowedViewerComps(
  accounts: DtakoAccountEntry[],
  tenantId: string,
  viewerEmail: string | undefined,
  allCompsViewerEmailsRaw: string | undefined,
): Set<string> {
  if (isAllCompsViewer(viewerEmail, allCompsViewerEmailsRaw)) {
    return allRegisteredCompIds(accounts);
  }
  return viewerCompIdsForTenant(accounts, tenantId);
}

/** `compId` と同じ tenant に属する comp_id 集合 (自分自身を含む)。
 * 社員マスタの会社横断表示・会社対応表 (comp-map) を「同じテナントの会社だけ」に
 * 絞るために使う (Refs #367)。DTAKO_ACCOUNTS に無い comp は空集合 (fail-closed)。
 * `ALL_COMPS_VIEWER_EMAILS` に載っている email だけが全社ぶんを見られる
 * (Refs #1049 — ここも `allowedViewerComps` と同じ全社許可を持っているので、
 * 片方だけ絞ると素通りする)。 */
export function compIdsInSameTenant(
  accounts: DtakoAccountEntry[],
  compId: string,
  viewerEmail?: string,
  allCompsViewerEmailsRaw?: string,
): Set<string> {
  if (isAllCompsViewer(viewerEmail, allCompsViewerEmailsRaw)) {
    return allRegisteredCompIds(accounts);
  }
  const found = accounts.find((a) => a.comp_id === compId);
  const tenantId = found ? found.tenant_id : "";
  return viewerCompIdsForTenant(accounts, tenantId);
}
