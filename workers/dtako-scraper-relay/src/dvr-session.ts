/**
 * /dvr-api/* (DVR viewer、Refs #90) のセッション管理。`./theearth-session.ts`
 * の汎用 factory を `dvr-` prefix で具体化した薄いラッパー (Refs #169 で
 * report-session.ts との重複を統合)。
 *
 * routing: browser は全リクエストに `X-Dvr-Comp-Id` / `X-Dvr-User-B64` (UTF-8
 * ユーザー名の base64url) を付け、relay worker の index.ts がそこから
 * `idFromName("dvr-{compId}:{userB64}")` で DO を引く。theearth アカウント単位で
 * DO が定まるので、「同一アカウント複数セッション不可」制約も自然に直列化される。
 */
import {
  createTheearthSession,
  decodeUserB64,
  encodeUserB64,
  generateSessionToken,
  timingSafeEqualStr,
  type TheearthRouting,
  type TheearthSessionRecord,
} from "./theearth-session";

/** アプリ側セッション TTL。theearth 側 cookie が先に切れた場合は VenusBridge が
 * HTML を返して VenusSessionExpiredError → 401 で再ログインを促す。 */
export const DVR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** DO storage に置くセッションレコード。credential (password) は含まない。 */
export type DvrSessionRecord = TheearthSessionRecord;

export type DvrRouting = TheearthRouting;

const dvrSession = createTheearthSession("x-dvr", "dvr");

/** `X-Dvr-Comp-Id` / `X-Dvr-User-B64` ヘッダから DO routing を解決する。
 * ヘッダ欠落・comp_id の文字種違反・base64/UTF-8 不正は null (呼び出し側で 400)。 */
export const resolveDvrRouting = dvrSession.resolveRouting;

/** セッションレコードの有効性判定。record 不在 / token 不一致 / 期限切れ /
 * アカウント不一致 (異常系、DO キー構成上は起こらないはず) はすべて false。 */
export const isDvrSessionValid = dvrSession.isSessionValid;

// token 生成 / timing-safe 比較 / base64url codec は theearth-session.ts が
// 唯一の実装元。既存の呼び出し元 (dtako-scraper-relay-do.ts 等) を壊さない
// よう、この名前でも re-export する。
export {
  generateSessionToken as generateDvrToken,
  timingSafeEqualStr,
  encodeUserB64 as encodeDvrUserB64,
  decodeUserB64 as decodeDvrUserB64,
};
export { extractBearerToken } from "./theearth-session";
