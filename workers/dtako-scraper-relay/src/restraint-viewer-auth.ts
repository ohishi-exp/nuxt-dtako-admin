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
