/**
 * /dvr-api/* (DVR viewer、Refs #90) のセッション管理 pure ロジック (cloudflare 非依存)。
 *
 * 設計: credential pass-through — 利用者が入力した theearth credential はログイン
 * 1 回にだけ使い、**どこにも保存しない**。DO storage に残るのは theearth session
 * cookie とランダム token のみ。アプリ独自のユーザー DB / パスワード保存を持たず、
 * 認証は theearth 本体に委譲する (theearth にログインできる人だけが自分の comp の
 * データを見られる)。
 *
 * routing: browser は全リクエストに `X-Dvr-Comp-Id` / `X-Dvr-User-B64` (UTF-8
 * ユーザー名の base64url) を付け、relay worker の index.ts がそこから
 * `idFromName("dvr-{compId}:{userB64}")` で DO を引く。theearth アカウント単位で
 * DO が定まるので、「同一アカウント複数セッション不可」制約も自然に直列化される。
 * password はヘッダに載せない (login の JSON body のみ)。
 */

/** アプリ側セッション TTL。theearth 側 cookie が先に切れた場合は VenusBridge が
 * HTML を返して VenusSessionExpiredError → 401 で再ログインを促す。 */
export const DVR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** DO storage に置くセッションレコード。credential (password) は含まない。 */
export interface DvrSessionRecord {
  token: string;
  compId: string;
  userName: string;
  /** theearth session cookie (CookieJar.cookies の entries)。 */
  cookies: Array<[string, string]>;
  createdAt: number;
  expiresAt: number;
}

/** 128bit 以上のランダム hex token (32 bytes = 64 hex chars)。 */
export function generateDvrToken(): string {
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

export interface DvrRouting {
  compId: string;
  userName: string;
  /** `idFromName` に渡す DO キー。userName は正規化済み base64url で埋め込む。 */
  doKey: string;
}

const COMP_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** UTF-8 文字列を base64url (padding 無し) に encode する。browser 側も同じ形式で
 * `X-Dvr-User-B64` を組み立てる (ヘッダは ISO-8859-1 制約があるため生の日本語
 * ユーザー名を載せられない)。 */
export function encodeDvrUserB64(userName: string): string {
  const bytes = new TextEncoder().encode(userName);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url を UTF-8 文字列に decode する。不正な base64 / 不正な UTF-8 は null。 */
export function decodeDvrUserB64(b64url: string): string | null {
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

/** `X-Dvr-Comp-Id` / `X-Dvr-User-B64` ヘッダから DO routing を解決する。
 * ヘッダ欠落・comp_id の文字種違反・base64/UTF-8 不正は null (呼び出し側で 400)。 */
export function resolveDvrRouting(headers: { get(name: string): string | null }): DvrRouting | null {
  const compId = headers.get("x-dvr-comp-id");
  const userB64 = headers.get("x-dvr-user-b64");
  if (!compId || !userB64 || !COMP_ID_RE.test(compId)) return null;
  const userName = decodeDvrUserB64(userB64);
  if (!userName || userName.length === 0) return null;
  // クライアントの padding 有無等の表記揺れで DO が分裂しないよう、キーには
  // 受領値ではなく正規化 (再 encode) した base64url を使う。
  return { compId, userName, doKey: `dvr-${compId}:${encodeDvrUserB64(userName)}` };
}

/** Authorization ヘッダから Bearer token を取り出す (無ければ空文字)。 */
export function extractBearerToken(headers: { get(name: string): string | null }): string {
  const auth = headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
}

/** セッションレコードの有効性判定。record 不在 / token 不一致 / 期限切れ /
 * アカウント不一致 (異常系、DO キー構成上は起こらないはず) はすべて false。 */
export function isDvrSessionValid(
  record: DvrSessionRecord | null | undefined,
  token: string,
  routing: Pick<DvrRouting, "compId" | "userName">,
  now: number,
): boolean {
  if (!record) return false;
  if (!token || !timingSafeEqualStr(record.token, token)) return false;
  if (now >= record.expiresAt) return false;
  if (record.compId !== routing.compId || record.userName !== routing.userName) return false;
  return true;
}
