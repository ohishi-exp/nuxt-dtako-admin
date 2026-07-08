/**
 * /daily-report-api/* (日報編集、Refs #169) のセッション管理 pure ロジック
 * (cloudflare 非依存)。/dvr-api/* (`./dvr-session.ts`) と同型の credential
 * pass-through 設計だが、theearth 上のログインセッションは DVR viewer と
 * **共有しない** (issue #169 のアーキテクチャ図どおり、`report-{compId}:{userB64}`
 * という別 DO インスタンス・別ログインで直列化する)。
 *
 * token 生成 / timing-safe 比較 / base64url codec は dvr-session.ts の実装を
 * そのまま再利用する (アカウント routing の仕組み自体は DVR/日報で共通なため、
 * 2 度目の実装をここで複製しない — lib-first)。
 */
import { decodeDvrUserB64, encodeDvrUserB64, timingSafeEqualStr } from "./dvr-session";

/** アプリ側セッション TTL。dvr-session.ts と同じ 8h (theearth 側 cookie が先に
 * 切れた場合は theearth-report-client 側が VenusSessionExpiredError 相当で 401 に
 * マップし再ログインを促す)。 */
export const REPORT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** DO storage に置くセッションレコード。credential (password) は含まない。 */
export interface ReportSessionRecord {
  token: string;
  compId: string;
  userName: string;
  /** theearth session cookie (CookieJar.cookies の entries)。 */
  cookies: Array<[string, string]>;
  createdAt: number;
  expiresAt: number;
}

export interface ReportRouting {
  compId: string;
  userName: string;
  /** `idFromName` に渡す DO キー。userName は正規化済み base64url で埋め込む。 */
  doKey: string;
}

const COMP_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** `X-Report-Comp-Id` / `X-Report-User-B64` ヘッダから DO routing を解決する。
 * ヘッダ欠落・comp_id の文字種違反・base64/UTF-8 不正は null (呼び出し側で 400)。 */
export function resolveReportRouting(headers: { get(name: string): string | null }): ReportRouting | null {
  const compId = headers.get("x-report-comp-id");
  const userB64 = headers.get("x-report-user-b64");
  if (!compId || !userB64 || !COMP_ID_RE.test(compId)) return null;
  const userName = decodeDvrUserB64(userB64);
  if (!userName || userName.length === 0) return null;
  // クライアントの padding 有無等の表記揺れで DO が分裂しないよう、キーには
  // 受領値ではなく正規化 (再 encode) した base64url を使う (dvr-session.ts と同じ設計)。
  return { compId, userName, doKey: `report-${compId}:${encodeDvrUserB64(userName)}` };
}

/** セッションレコードの有効性判定。record 不在 / token 不一致 / 期限切れ /
 * アカウント不一致 (異常系、DO キー構成上は起こらないはず) はすべて false。 */
export function isReportSessionValid(
  record: ReportSessionRecord | null | undefined,
  token: string,
  routing: Pick<ReportRouting, "compId" | "userName">,
  now: number,
): boolean {
  if (!record) return false;
  if (!token || !timingSafeEqualStr(record.token, token)) return false;
  if (now >= record.expiresAt) return false;
  if (record.compId !== routing.compId || record.userName !== routing.userName) return false;
  return true;
}
