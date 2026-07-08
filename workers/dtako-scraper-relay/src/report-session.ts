/**
 * /daily-report-api/* (日報編集、Refs #169) のセッション管理。
 * `./theearth-session.ts` の汎用 factory を `report-` prefix で具体化した
 * 薄いラッパー (dvr-session.ts と同型だが、DVR viewer とは別の theearth
 * ログインセッションを持つ — アーキテクチャ上意図的に DO インスタンスを
 * `report-{compId}:{userB64}` で分離する)。
 */
import { createTheearthSession, type TheearthRouting, type TheearthSessionRecord } from "./theearth-session";

/** アプリ側セッション TTL。dvr-session.ts と同じ 8h (theearth 側 cookie が先に
 * 切れた場合は theearth-report-client 側が VenusSessionExpiredError 相当で 401 に
 * マップし再ログインを促す)。 */
export const REPORT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** DO storage に置くセッションレコード。credential (password) は含まない。 */
export type ReportSessionRecord = TheearthSessionRecord;

export type ReportRouting = TheearthRouting;

const reportSession = createTheearthSession("x-report", "report");

/** `X-Report-Comp-Id` / `X-Report-User-B64` ヘッダから DO routing を解決する。
 * ヘッダ欠落・comp_id の文字種違反・base64/UTF-8 不正は null (呼び出し側で 400)。 */
export const resolveReportRouting = reportSession.resolveRouting;

/** セッションレコードの有効性判定。record 不在 / token 不一致 / 期限切れ /
 * アカウント不一致 (異常系、DO キー構成上は起こらないはず) はすべて false。 */
export const isReportSessionValid = reportSession.isSessionValid;
