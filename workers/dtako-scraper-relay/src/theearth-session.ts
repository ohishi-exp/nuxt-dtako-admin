/**
 * theearth-np.com credential pass-through セッション/routing の実装 (pure、
 * cloudflare 非依存)。`/dvr-api/*` と `/daily-report-api/*` は **同一の theearth
 * ログインセッションを共有する** (Refs #233。かつては Refs #169 の設計で DO
 * instance ごと `dvr-` / `report-` に分離していたが、theearth が同一アカウントの
 * 同時ログインを許さない (ライセンス数超過で既存セッションを kick する) ため、
 * 片方のページでログインするともう片方の theearth cookie が失効し、ページを
 * 移動するたびに再ログインになる実害があった)。
 *
 * 設計: 利用者が入力した theearth credential はログイン 1 回にだけ使い、
 * **どこにも保存しない**。DO storage に残るのは theearth session cookie と
 * ランダム token のみ。password はヘッダに載せない (login の JSON body のみ)。
 */

/** DO storage に置くセッションレコード。credential (password) は含まない。 */
export interface TheearthSessionRecord {
  token: string;
  compId: string;
  userName: string;
  /** theearth session cookie (CookieJar.cookies の entries)。 */
  cookies: Array<[string, string]>;
  createdAt: number;
  expiresAt: number;
}

export interface TheearthRouting {
  compId: string;
  userName: string;
  /** `idFromName` に渡す DO キー。userName は正規化済み base64url で埋め込む。 */
  doKey: string;
}

const COMP_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 128bit 以上のランダム hex token (32 bytes = 64 hex chars)。 */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 文字列の timing-safe 比較 (長さ不一致は即 false、内容は XOR 集約で比較)。 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const ea = encoder.encode(a);
  const eb = encoder.encode(b);
  if (ea.length !== eb.length) return false;
  let diff = 0;
  for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
  return diff === 0;
}

/** UTF-8 文字列を base64url (padding 無し) に encode する。browser 側も同じ
 * 形式でヘッダを組み立てる (ヘッダは ISO-8859-1 制約があるため生の日本語
 * ユーザー名を載せられない)。 */
export function encodeUserB64(userName: string): string {
  const bytes = new TextEncoder().encode(userName);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url を UTF-8 文字列に decode する。不正な base64 / 不正な UTF-8 は null。 */
export function decodeUserB64(b64url: string): string | null {
  try {
    const std = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const padded = std + "=".repeat((4 - (std.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    // @cloudflare/workers-types の TextDecoderConstructorOptions は ignoreBOM も必須
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

/** Authorization ヘッダから Bearer token を取り出す (無ければ空文字)。
 * ヘッダ prefix に依存しない共通処理。 */
export function extractBearerToken(headers: { get(name: string): string | null }): string {
  const auth = headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
}

export interface TheearthSessionHelpers {
  /** `{headerPrefix}-comp-id` / `{headerPrefix}-user-b64` ヘッダから DO routing
   * を解決する。ヘッダ欠落・comp_id の文字種違反・base64/UTF-8 不正は null
   * (呼び出し側で 400)。 */
  resolveRouting(headers: { get(name: string): string | null }): TheearthRouting | null;
  /** セッションレコードの有効性判定。record 不在 / token 不一致 / 期限切れ /
   * アカウント不一致 (異常系、DO キー構成上は起こらないはず) はすべて false。 */
  isSessionValid(
    record: TheearthSessionRecord | null | undefined,
    token: string,
    routing: Pick<TheearthRouting, "compId" | "userName">,
    now: number,
  ): boolean;
}

/** `headerPrefix` (例 `"x-dvr"`) / `doKeyPrefix` (例 `"dvr"`) を渡して
 * session/routing ヘルパーを具体化する。 */
export function createTheearthSession(headerPrefix: string, doKeyPrefix: string): TheearthSessionHelpers {
  const compIdHeader = `${headerPrefix}-comp-id`;
  const userB64Header = `${headerPrefix}-user-b64`;

  function resolveRouting(headers: { get(name: string): string | null }): TheearthRouting | null {
    const compId = headers.get(compIdHeader);
    const userB64 = headers.get(userB64Header);
    if (!compId || !userB64 || !COMP_ID_RE.test(compId)) return null;
    const userName = decodeUserB64(userB64);
    if (!userName || userName.length === 0) return null;
    // クライアントの padding 有無等の表記揺れで DO が分裂しないよう、キーには
    // 受領値ではなく正規化 (再 encode) した base64url を使う。
    return { compId, userName, doKey: `${doKeyPrefix}-${compId}:${encodeUserB64(userName)}` };
  }

  function isSessionValid(
    record: TheearthSessionRecord | null | undefined,
    token: string,
    routing: Pick<TheearthRouting, "compId" | "userName">,
    now: number,
  ): boolean {
    if (!record) return false;
    if (!token || !timingSafeEqualStr(record.token, token)) return false;
    if (now >= record.expiresAt) return false;
    if (record.compId !== routing.compId || record.userName !== routing.userName) return false;
    return true;
  }

  return { resolveRouting, isSessionValid };
}

/** theearth ログインセッションの TTL (dvr / daily-report 共通)。theearth 側
 * cookie が先に切れた場合は各 client が VenusSessionExpiredError 相当 → 401 に
 * マップして再ログインを促す。 */
export const THEEARTH_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// /dvr-api/* と /daily-report-api/* は同一の theearth ログインセッションを共有
// する (Refs #233)。DO キーは経路によらず `theearth-{comp}:{userB64}` の 1 系統。
const unifiedSession = createTheearthSession("x-theearth", "theearth");
// 旧フロント (X-Dvr-* / X-Report-* を送る) は本番タグリリースまで残るため、旧
// ヘッダも受理して**同じ** DO キーに解決する (relay worker は main merge で先に
// デプロイされるデプロイ順 skew 対応)。旧ヘッダの撤去は Refs #233 の後続整理で。
const legacyDvrHeaders = createTheearthSession("x-dvr", "theearth");
const legacyReportHeaders = createTheearthSession("x-report", "theearth");

/** `X-Theearth-Comp-Id` / `X-Theearth-User-B64` (fallback: 旧 `X-Dvr-*` /
 * `X-Report-*`) から DO routing を解決する。どのヘッダで来ても DO キーは
 * `theearth-{comp}:{userB64}` に正規化される。不正は null (呼び出し側で 400)。 */
export function resolveTheearthRouting(headers: {
  get(name: string): string | null;
}): TheearthRouting | null {
  return (
    unifiedSession.resolveRouting(headers) ??
    legacyDvrHeaders.resolveRouting(headers) ??
    legacyReportHeaders.resolveRouting(headers)
  );
}

/** セッションレコードの有効性判定。record 不在 / token 不一致 / 期限切れ /
 * アカウント不一致 (異常系、DO キー構成上は起こらないはず) はすべて false。 */
export const isTheearthSessionValid = unifiedSession.isSessionValid;
