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
 * | 給与大臣の**実支給額** (支給項目) | `/api/kyuyo/payroll` | **email allowlist** (上流) |
 * | **単価マスタ × 拘束時間 の計算賃金** — 月次集計 CSV の `単価`/`…(円)`/`合計(円)`/`総支給時給(割増込)`、最低賃金チェック、タイムカードの残業額 | `/restraint-api/wage-report`・`/restraint-api/wage-master` (計算は `restraint-wage.ts`) | **tenant** (この関数) |
 * | **確定値スナップショット** (期間集計タブの `paid` / 差) | `/restraint-api/wage-snapshot`・`/restraint-api/wage-range` | **tenant (この関数) AND email allowlist** (Refs #951) |
 *
 * email allowlist の実体は**上流にしか無い** — rust-ichibanboshi の
 * `kyuyo::introspect::authorize()` (`#82`) が auth-worker introspect の `email` を
 * オンプレ設定 (`KYUYO_ALLOWED_EMAILS`) と突き合わせる。**この repo は allowlist を
 * 持っていない**し、持たせると二重管理になる (片方だけ更新されて食い違う)。
 * 3 段目もこの正を**聞きに行く**だけで、写しは持たない
 * (`kintai-relay.ts` の `checkKyuyoAccess`)。
 *
 * **なぜ 2 段目が tenant のままか**: あれは給与大臣の実データではなく、**この repo が
 * 持つ単価マスタから計算した労務管理値**で、最低賃金チェックはテナント内の総務が回す
 * 業務だから。**★ ただしこの線でよいかは依然として未決** — 誰が金額を見てよいかは
 * 実装側で決められることではない。**寄せる場合の道具はもう在る** — #951 で足した
 * `GET /api/kyuyo/access` と `checkKyuyoAccess` を同じように AND するだけ。
 * ⇒ **残っているのは「寄せるかどうか」の判断だけで、実装の障壁ではない** (#556)。
 *
 * **★ 3 段目 (確定値スナップショット) は上の論拠が当てはまらない**ので、
 * **#951 で email 側へ寄せた (決着済み)。**`paid` は給与明細由来の**実支給額**で、
 * この repo が計算した値ではない。#951 以前は tenant 単位だけだったため、
 * **allowlist に載っている 1 名が保存した瞬間に、実支給額が tenant 全員の読める
 * 場所へ移っていた** —「漏れ」ではなく**「洗浄」**。
 *
 * いまは `handleWageRange` / `handleWageSnapshotPut` が、この関数の tenant 判定を
 * 通した**後**に `checkKyuyoAccess` (上流 `GET /api/kyuyo/access`) を AND する。
 * **読みだけでなく保存にも掛ける** — 読みだけ塞ぐと「見えないが汚せる」が残る。
 *
 * **★ ブラウザ JWT を転送する経路は `deps.onprem()`** (`kintai-relay.ts` に理由の表)。
 * wage-* 本体が `deps.gcp()` なのに合わせて `gcp()` へ揃えると、GCP 側には
 * allowlist が無いので**全員 503** になる。
 *
 * **2 段目 (単価マスタ × 拘束時間の計算賃金) は tenant のまま**で、これは**据え置き**
 * (#951 の対象外)。上の「なぜ 2 段目が tenant のままか」の論拠がそのまま生きている。
 *
 * ## ★ role (`VIEWER_ADMIN_ROLE`) と email allowlist は**優先関係ではない**
 *
 * 上流の `authorize()` は **`role` を一切見ない** (`src/kyuyo/introspect.rs` 実読、
 * 2026-08-26)。したがって **`role === 'admin'` でも allowlist に居なければ 403** で、
 * これは決めごとではなく**既に本番がそうなっている**。
 *
 * 2 つは**直交した別の軸**で、AND で効く:
 *
 * - **email allowlist** = 給与大臣の実支給額を**見てよいか**
 * - **role / tenant** (この関数) = **どの会社**を見てよいか
 *
 * どちらかがもう一方を上書きすることは無い。**admin に allowlist を無視させる
 * (fail-open) 案は却下**されている (2026-08-26) — 上流の変更が要るうえ、
 * 「管理者だから全部見える」は給与を email 単位に絞った方針そのものを崩す。
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

/** 全会社を見られる role。auth-worker の introspect が JWT の `role` claim を
 * そのまま返す (`{active, tenant_id, role, email, sub, exp}`)。
 *
 * dtako の admin はグループ全体の管理者 1 人だけで、別テナント側に admin を
 * 増やす予定は無い (2026-07-25 ユーザー確認) ため、role だけで全社許可にする。
 * これが変わる時は「全社を許可する tenant_id の allowlist」に切り替えること。 */
export const VIEWER_ADMIN_ROLE = "admin";

/** viewer 経路で触れる comp_id 集合。
 * admin は **DTAKO_ACCOUNTS に載っている会社すべて** (載っていない comp は不可 —
 * ヘッダ偽装で未登録の会社を触らせない)、それ以外は自 tenant の会社のみ。 */
export function allowedViewerComps(
  accounts: DtakoAccountEntry[],
  tenantId: string,
  role: string | undefined,
): Set<string> {
  if (role === VIEWER_ADMIN_ROLE) {
    return new Set(accounts.map((a) => a.comp_id).filter((c): c is string => !!c));
  }
  return viewerCompIdsForTenant(accounts, tenantId);
}

/** `compId` と同じ tenant に属する comp_id 集合 (自分自身を含む)。
 * 社員マスタの会社横断表示・会社対応表 (comp-map) を「同じテナントの会社だけ」に
 * 絞るために使う (Refs #367)。DTAKO_ACCOUNTS に無い comp は空集合 (fail-closed)。 */
export function compIdsInSameTenant(
  accounts: DtakoAccountEntry[],
  compId: string,
  role?: string,
): Set<string> {
  if (role === VIEWER_ADMIN_ROLE) {
    return new Set(accounts.map((a) => a.comp_id).filter((c): c is string => !!c));
  }
  const tenantId = accounts.find((a) => a.comp_id === compId)?.tenant_id ?? "";
  return viewerCompIdsForTenant(accounts, tenantId);
}
