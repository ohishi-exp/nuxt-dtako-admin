/**
 * かんたんnetprint (セブンイレブン、Web 版 lite.printing.ne.jp) へのブラウザレス
 * HTTP クライアント。
 *
 * nuxt-dtako-admin#874 の実機トレース (2026-08-25、Next.js バンドル解析 + 実登録で
 * 予約番号発行まで確認) を素の `fetch()` で再現する。公式 API は非公開なので、
 * Web 版の内部 API を叩く形 — 仕様変更時に「黙って 200」を出さないよう、応答が
 * JSON でない / 想定フィールドが欠けている場合は必ず throw する
 * (theearth-client.ts / etc-meisai-client.ts と同じ方針)。
 *
 * API 契約 (#874 で確定):
 * - `POST /api/register-file` — multipart で PDF を登録。成功 200 JSON
 *   `{id, fileName, …}`。**この id は登録確認 ID であって予約番号ではない。**
 *   失敗は JSON `{code}` (11202=メンテナンス中)。上限 10MB。
 * - `GET /api/registration-status/{id}` — 実ページは 10 秒間隔で poll。
 *   `resultCode` 1=変換処理中 (継続) / 0=完了 → `printID` = プリント予約番号
 *   (8桁英数)、`endDate` = 有効期限 (登録翌日 23:59) / その他=エラー。
 *   **xref の無い不正 PDF は登録 200 → status でエラーになる**ので、完了まで
 *   見届けてから予約番号を通知すること。
 */

import type { FetchLike } from "./theearth-client";

export const NETPRINT_BASE_URL = "https://lite.printing.ne.jp";

/** Web 版バンドルに焼き込まれた静的 ID (全クライアント共通、#874 で確認)。 */
export const NETPRINT_LITE_ID = "86bcdc8d-5635-410a-bcdc-8c49b9fe9b0c";

/** register-file の上限 (10MB)。超過分は送らずに事前 throw する。 */
export const NETPRINT_MAX_PDF_BYTES = 10_485_760;

/** 実ページの poll 間隔 (10 秒)。 */
export const NETPRINT_POLL_INTERVAL_MS = 10_000;
/** poll 上限。10 秒間隔 × 30 回 = 5 分で諦めて throw する。 */
export const NETPRINT_POLL_MAX_ATTEMPTS = 30;

/** register-file 失敗 JSON `{code}` のうち「メンテナンス中」。 */
export const NETPRINT_MAINTENANCE_CODE = 11202;

/** プリント予約番号 (printID) の形 — 8 桁英数。 */
export const NETPRINT_PRINT_ID_RE = /^[0-9A-Za-z]{8}$/;

export class NetprintClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetprintClientError";
  }
}

/** register-file が code 11202 (メンテナンス中) を返した。時間を置けば直る
 * 一時要因なので、呼び出し側が受付エラーと区別できるよう型を分ける。 */
export class NetprintMaintenanceError extends NetprintClientError {
  constructor(message: string) {
    super(message);
    this.name = "NetprintMaintenanceError";
  }
}

/** エラーメッセージに載せる応答本文の断片 (改行を潰して先頭だけ)。 */
const BODY_SNIPPET_MAX = 200;
export function bodySnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= BODY_SNIPPET_MAX ? flat : `${flat.slice(0, BODY_SNIPPET_MAX)}…`;
}

function parseJsonObject(context: string, text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new NetprintClientError(`${context}: JSON でない応答が返りました — ${bodySnippet(text)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new NetprintClientError(`${context}: JSON object でない応答が返りました — ${bodySnippet(text)}`);
  }
  return parsed as Record<string, unknown>;
}

/** number でも数値文字列でも受ける (実 API の型が揺れても黙って落とさないため、
 * どちらでもなければ throw)。 */
function requireFiniteNumber(context: string, field: string, value: unknown, text: string): number {
  const n =
    typeof value === "number" ? value : typeof value === "string" && value !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(n)) {
    throw new NetprintClientError(`${context}: ${field} が欠落または数値でありません — ${bodySnippet(text)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// register-file
// ---------------------------------------------------------------------------

export interface NetprintRegisterOptions {
  /** "0"=A4 (既定), "1"=A3, "2"=B5, "3"=B4, "5"=はがき, "4"=L, "6"=2L。 */
  paperSize?: string;
  /** "0"=プリント時に選択 (既定)。 */
  colorMode?: string;
  /** "0"=ちょっと小さめ しない (既定)。 */
  margin?: string;
  fetchImpl?: FetchLike;
}

/** register-file に送る multipart FormData を組む。10MB 超はここで throw して
 * 送信自体をやめる (サーバに投げても弾かれるだけなので)。 */
export function buildRegisterFormData(
  pdf: Uint8Array,
  fileName: string,
  opts: Pick<NetprintRegisterOptions, "paperSize" | "colorMode" | "margin"> = {},
): FormData {
  if (pdf.byteLength > NETPRINT_MAX_PDF_BYTES) {
    throw new NetprintClientError(
      `PDF が上限 ${NETPRINT_MAX_PDF_BYTES} bytes (10MB) を超えています (${pdf.byteLength} bytes) — 登録せずに中止します`,
    );
  }
  const form = new FormData();
  form.append("fileBody", new Blob([pdf], { type: "application/pdf" }), fileName);
  form.append("fileName", fileName);
  form.append("paperSize", opts.paperSize ?? "0");
  form.append("colorMode", opts.colorMode ?? "0");
  form.append("margin", opts.margin ?? "0");
  return form;
}

/** register-file の応答を検証し、登録確認 ID (予約番号ではない) を返す。 */
export function parseRegisterResponse(status: number, text: string): string {
  const context = `register-file (HTTP ${status})`;
  const body = parseJsonObject(context, text);
  if (status === 200 && typeof body.id === "string" && body.id !== "") {
    return body.id;
  }
  const code =
    typeof body.code === "number" ? body.code : typeof body.code === "string" && body.code !== "" ? Number(body.code) : null;
  if (code === NETPRINT_MAINTENANCE_CODE) {
    throw new NetprintMaintenanceError(
      `かんたんnetprint がメンテナンス中です (code ${NETPRINT_MAINTENANCE_CODE}) — ${bodySnippet(text)}`,
    );
  }
  if (code !== null) {
    throw new NetprintClientError(`${context}: 受付エラー code=${code} — ${bodySnippet(text)}`);
  }
  throw new NetprintClientError(`${context}: 応答に id がありません — ${bodySnippet(text)}`);
}

/** PDF を登録し、登録確認 ID を返す。予約番号は `waitForReservation` で取る。 */
export async function registerPdf(
  pdf: Uint8Array,
  fileName: string,
  opts: NetprintRegisterOptions = {},
): Promise<string> {
  const form = buildRegisterFormData(pdf, fileName, opts);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`${NETPRINT_BASE_URL}/api/register-file`, {
    method: "POST",
    headers: { "X-NPS-LITE-ID": NETPRINT_LITE_ID },
    body: form,
  });
  return parseRegisterResponse(res.status, await res.text());
}

// ---------------------------------------------------------------------------
// registration-status (poll)
// ---------------------------------------------------------------------------

export interface NetprintReservation {
  /** プリント予約番号 (8 桁英数)。マルチコピー機に入れる番号はこれ。 */
  printId: string;
  page: number;
  fileSize: number;
  /** 有効期限 (登録翌日 23:59)。 */
  endDate: string;
  detailUrl: string;
}

export type NetprintStatusResult = { done: false } | { done: true; reservation: NetprintReservation };

/** registration-status の応答 1 回分を判定する。1=変換処理中 (poll 継続) /
 * 0=完了 / その他=エラー。完了時は printID が 8 桁英数であることまで検証する。 */
export function parseStatusResponse(status: number, text: string): NetprintStatusResult {
  const context = `registration-status (HTTP ${status})`;
  if (status !== 200) {
    throw new NetprintClientError(`${context}: HTTP エラーが返りました — ${bodySnippet(text)}`);
  }
  const body = parseJsonObject(context, text);
  const raw = body.resultCode;
  const resultCode =
    typeof raw === "number" ? raw : typeof raw === "string" && raw !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(resultCode)) {
    throw new NetprintClientError(`${context}: resultCode が欠落しています — ${bodySnippet(text)}`);
  }
  if (resultCode === 1) {
    return { done: false };
  }
  if (resultCode !== 0) {
    throw new NetprintClientError(`${context}: resultCode=${resultCode} (変換エラー) — ${bodySnippet(text)}`);
  }
  const printId = body.printID;
  if (typeof printId !== "string" || !NETPRINT_PRINT_ID_RE.test(printId)) {
    throw new NetprintClientError(
      `${context}: printID が 8 桁英数でありません (printID=${JSON.stringify(printId)}) — ${bodySnippet(text)}`,
    );
  }
  const page = requireFiniteNumber(context, "page", body.page, text);
  const fileSize = requireFiniteNumber(context, "fileSize", body.fileSize, text);
  const endDate = body.endDate;
  if (typeof endDate !== "string" || endDate === "") {
    throw new NetprintClientError(`${context}: endDate が欠落しています — ${bodySnippet(text)}`);
  }
  const detailUrl = body.detailURL;
  if (typeof detailUrl !== "string") {
    throw new NetprintClientError(`${context}: detailURL が欠落しています — ${bodySnippet(text)}`);
  }
  return { done: true, reservation: { printId, page, fileSize, endDate, detailUrl } };
}

export interface NetprintPollOptions {
  fetchImpl?: FetchLike;
  sleepImpl?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxAttempts?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 登録確認 ID を poll し、変換完了した予約 (printID 等) を返す。
 * 上限回数までに完了しなければ throw する (登録は翌日 23:59 に自動失効する)。 */
export async function waitForReservation(id: string, opts: NetprintPollOptions = {}): Promise<NetprintReservation> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? defaultSleep;
  const intervalMs = opts.pollIntervalMs ?? NETPRINT_POLL_INTERVAL_MS;
  const maxAttempts = opts.maxAttempts ?? NETPRINT_POLL_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const res = await fetchImpl(`${NETPRINT_BASE_URL}/api/registration-status/${encodeURIComponent(id)}`, {
      method: "GET",
      headers: { "X-NPS-LITE-ID": NETPRINT_LITE_ID },
    });
    const result = parseStatusResponse(res.status, await res.text());
    if (result.done) {
      return result.reservation;
    }
    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  throw new NetprintClientError(
    `registration-status が ${maxAttempts} 回 (${intervalMs}ms 間隔) の poll で完了しませんでした (id=${id})`,
  );
}
