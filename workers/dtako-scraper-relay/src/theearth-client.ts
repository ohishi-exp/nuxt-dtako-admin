/**
 * theearth-np.com (ASP.NET WebForms) へのブラウザレス HTTP クライアント。
 *
 * ohishi-exp/dtako-scraper#22 の実機トレース (手元ブラウザでの network capture) を
 * 素の `fetch()` で再現する。Chromium は起動しない — cookie jar・VIEWSTATE 抽出・
 * フォーム POST を全て自前で行う (`fetch` には cookie jar が無いため)。
 *
 * 「黙って200」対策: ページ構造が変わって想定した hidden field / form 要素が
 * 見つからない場合、および ZIP のマジックバイトが一致しない場合は必ず
 * TheearthClientError を throw する (200 で HTML エラーページを ZIP として
 * 返してしまう事故を防ぐ)。
 */

const BASE_URL = "https://theearth-np.com";
const LOGIN_PATH = "/F-OES1010[Login].aspx";
const CSV_PATH = "/F-NOS3010[GeneralCsv].aspx";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

export class TheearthClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TheearthClientError";
  }
}

export type FetchLike = typeof fetch;

// ---------------------------------------------------------------------------
// Cookie jar (fetch には無いので自前実装。redirect:"manual" で各ホップの
// Set-Cookie を収集する)
// ---------------------------------------------------------------------------

export interface CookieJar {
  cookies: Map<string, string>;
}

export function createCookieJar(): CookieJar {
  return { cookies: new Map() };
}

/** `Headers` から Set-Cookie を全て取り出す (Workers/undici は getSetCookie() を持つ)。 */
function extractSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") {
    return withGetSetCookie.getSetCookie();
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

export function ingestSetCookie(jar: CookieJar, headers: Headers): void {
  for (const raw of extractSetCookieHeaders(headers)) {
    const pair = raw.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    jar.cookies.set(name, value);
  }
}

export function cookieHeader(jar: CookieJar): string {
  return Array.from(jar.cookies.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

async function fetchWithJar(
  jar: CookieJar,
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  const res = await fetchImpl(url, { ...init, headers, redirect: "manual" });
  ingestSetCookie(jar, res.headers);
  return res;
}

// ---------------------------------------------------------------------------
// ASP.NET hidden field / form 要素の抽出
// ---------------------------------------------------------------------------

const HIDDEN_FIELD_NAMES = [
  "__VIEWSTATE",
  "__VIEWSTATEGENERATOR",
  "__EVENTVALIDATION",
  "__PREVIOUSPAGE",
  "__EVENTTARGET",
  "__EVENTARGUMENT",
] as const;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function findTagById(html: string, id: string): string | null {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<input\\b[^>]*\\bid=["']${escapedId}["'][^>]*>`, "i");
  return html.match(re)?.[0] ?? null;
}

interface FormFieldRef {
  name: string;
  value: string;
}

/** 指定 id の `<input>` タグから実際の POST 用 `name`/`value` を抽出する。
 * ASP.NET の ClientID (id) と name 属性 (`ctl00$MainContent$...`) は別物なので、
 * id をハードコードした上で name/value は都度ページから読み取る (サイト仕様変更に
 * 対して壊れにくくするため)。 */
function findFormFieldById(html: string, id: string): FormFieldRef | null {
  const tag = findTagById(html, id);
  if (!tag) return null;
  const nameMatch = tag.match(/\bname=["']([^"']+)["']/i);
  if (!nameMatch) return null;
  const valueMatch = tag.match(/\bvalue=["']([^"']*)["']/i);
  return {
    name: nameMatch[1],
    value: valueMatch ? decodeHtmlEntities(valueMatch[1]) : "",
  };
}

/** ASP.NET の hidden postback field (`__VIEWSTATE` 等) をまとめて抽出する。 */
export function extractHiddenFields(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of HIDDEN_FIELD_NAMES) {
    const field = findFormFieldById(html, name);
    if (field) result[name] = field.value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// ログイン
// ---------------------------------------------------------------------------

export interface LoginParams {
  compId: string;
  userName: string;
  userPass: string;
}

function looksLoggedIn(html: string): boolean {
  return html.includes("Button1st_2") || html.includes("Button1st_7");
}

function looksLikeOverlapSessionForm(html: string): boolean {
  return html.includes("txtOverlapSessionID") || html.includes("btnForced");
}

export async function login(
  jar: CookieJar,
  params: LoginParams,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const loginUrl = `${BASE_URL}${LOGIN_PATH}?mode=timeout`;

  const getRes = await fetchWithJar(jar, loginUrl, { method: "GET" }, fetchImpl);
  const html = await getRes.text();
  const hidden = extractHiddenFields(html);

  const body = new URLSearchParams({
    ...hidden,
    txtID2: params.compId,
    txtID1: params.userName,
    txtPass: params.userPass,
    btnLogin: "ログイン",
  });

  const postRes = await postForm(jar, loginUrl, body, fetchImpl);

  // 通常ログイン成功時は Response.Redirect (3xx) で戻ることが多い。
  if (postRes.status >= 300 && postRes.status < 400) {
    const location = postRes.headers.get("location");
    if (location) {
      const followRes = await fetchWithJar(
        jar,
        new URL(location, loginUrl).toString(),
        { method: "GET" },
        fetchImpl,
      );
      await followRes.text();
    }
    return;
  }

  const postHtml = await postRes.text();

  // 同一 comp_id の別セッションが既にログイン中の場合、強制ログインフォームが出る。
  if (looksLikeOverlapSessionForm(postHtml)) {
    const hidden2 = extractHiddenFields(postHtml);
    const btnForced = findFormFieldById(postHtml, "btnForced");
    if (!btnForced) {
      throw new TheearthClientError(
        "セッション重複フォームを検出したが btnForced が見つかりません (ページ仕様変更の可能性)",
      );
    }
    const forcedBody = new URLSearchParams({
      ...hidden2,
      [btnForced.name]: btnForced.value || "ログイン",
    });
    const forcedRes = await postForm(jar, loginUrl, forcedBody, fetchImpl);
    if (forcedRes.status >= 300 && forcedRes.status < 400) return;
    const forcedHtml = await forcedRes.text();
    if (!looksLoggedIn(forcedHtml)) {
      throw new TheearthClientError("強制ログインに失敗しました");
    }
    return;
  }

  if (!looksLoggedIn(postHtml)) {
    throw new TheearthClientError(
      "ログインに失敗しました (ログイン後の画面を検出できません。ID/パスワード誤り、またはサイト仕様変更の可能性)",
    );
  }
}

async function postForm(
  jar: CookieJar,
  url: string,
  body: URLSearchParams,
  fetchImpl: FetchLike,
): Promise<Response> {
  return fetchWithJar(
    jar,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: body.toString(),
    },
    fetchImpl,
  );
}

// ---------------------------------------------------------------------------
// 和暦/西暦判定・日付分解 (dtako-scraper の detect_wareki/parse_date_parts を移植)
// ---------------------------------------------------------------------------

export function detectWareki(html: string, now: Date = new Date()): boolean {
  const matches = html.match(/\b(\d{2})\/\d{2}\/\d{2}\b/g);
  if (!matches || matches.length === 0) return true; // デフォルトは和暦 (Rust版に合わせる)
  const first = matches[0];
  const pageYear = parseInt(first.slice(0, 2), 10);
  const nowYear = now.getUTCFullYear();
  const westernYY = nowYear % 100;
  const reiwaYY = nowYear - 2018;
  return Math.abs(pageYear - reiwaYY) < Math.abs(pageYear - westernYY);
}

export interface JapaneseDateParts {
  y: string;
  m: string;
  d: string;
}

/** "YYYY-MM-DD" を和暦/西暦の年2桁+月2桁+日2桁に分解する。 */
export function splitJapaneseDate(iso: string, isWareki: boolean): JapaneseDateParts {
  const parts = iso.split("-");
  if (parts.length !== 3) {
    throw new TheearthClientError(`不正な日付形式です: '${iso}' (YYYY-MM-DD を期待)`);
  }
  const [yearStr, monthStr, dayStr] = parts;
  const year = Number(yearStr);
  if (!Number.isInteger(year) || !monthStr || !dayStr) {
    throw new TheearthClientError(`不正な日付形式です: '${iso}'`);
  }
  const yy = isWareki ? year - 2018 : year % 100;
  return {
    y: String(yy).padStart(2, "0"),
    m: monthStr.padStart(2, "0"),
    d: dayStr.padStart(2, "0"),
  };
}

// ---------------------------------------------------------------------------
// CSV (csvdata.zip) ダウンロード
// ---------------------------------------------------------------------------

export interface CsvDateRange {
  startDate: string; // "YYYY-MM-DD"
  endDate: string; // "YYYY-MM-DD"
}

const CSV_FORM_IDS = [
  "rdoSelect1",
  "rdoDate1",
  "MainContent_ucStartDate_txtYear",
  "MainContent_ucStartDate_txtMonth",
  "MainContent_ucStartDate_txtDay",
  "MainContent_ucEndDate_txtYear",
  "MainContent_ucEndDate_txtMonth",
  "MainContent_ucEndDate_txtDay",
  "btnCsv",
] as const;

/** ZIP のマジックバイト (`PK\x03\x04`) を検証する。「黙って200」対策の要。 */
export function assertZipMagic(buf: ArrayBuffer): void {
  const bytes = new Uint8Array(buf);
  const ok =
    bytes.length >= 4 &&
    bytes[0] === ZIP_MAGIC[0] &&
    bytes[1] === ZIP_MAGIC[1] &&
    bytes[2] === ZIP_MAGIC[2] &&
    bytes[3] === ZIP_MAGIC[3];
  if (!ok) {
    throw new TheearthClientError(
      `取得したデータが ZIP ではありません (${bytes.length} bytes) — ` +
        "ログイン切れ、または theearth-np のページ仕様変更の可能性があります",
    );
  }
}

export async function downloadCsvZip(
  jar: CookieJar,
  range: CsvDateRange,
  fetchImpl: FetchLike = fetch,
): Promise<ArrayBuffer> {
  const csvUrl = `${BASE_URL}${CSV_PATH}`;

  const getRes = await fetchWithJar(jar, csvUrl, { method: "GET" }, fetchImpl);
  const html = await getRes.text();
  const hidden = extractHiddenFields(html);

  const fields = new Map<string, FormFieldRef>();
  for (const id of CSV_FORM_IDS) {
    const field = findFormFieldById(html, id);
    if (!field) {
      throw new TheearthClientError(
        `CSV フォームの要素 (id=${id}) が見つかりません — theearth-np のページ仕様が変更された可能性があります`,
      );
    }
    fields.set(id, field);
  }

  const isWareki = detectWareki(html);
  const start = splitJapaneseDate(range.startDate, isWareki);
  const end = splitJapaneseDate(range.endDate, isWareki);

  const stage1Body = new URLSearchParams({
    ...hidden,
    [fields.get("rdoSelect1")!.name]: fields.get("rdoSelect1")!.value,
    [fields.get("rdoDate1")!.name]: fields.get("rdoDate1")!.value,
    [fields.get("MainContent_ucStartDate_txtYear")!.name]: start.y,
    [fields.get("MainContent_ucStartDate_txtMonth")!.name]: start.m,
    [fields.get("MainContent_ucStartDate_txtDay")!.name]: start.d,
    [fields.get("MainContent_ucEndDate_txtYear")!.name]: end.y,
    [fields.get("MainContent_ucEndDate_txtMonth")!.name]: end.m,
    [fields.get("MainContent_ucEndDate_txtDay")!.name]: end.d,
    [fields.get("btnCsv")!.name]: fields.get("btnCsv")!.value,
  });

  const stage1Res = await postForm(jar, csvUrl, stage1Body, fetchImpl);
  const stage1ContentType = stage1Res.headers.get("content-type") ?? "";

  // 1段階目で直接 ZIP が返るケース (実装差異に備える)
  if (stage1ContentType.includes("application/octet-stream") || stage1ContentType.includes("zip")) {
    const buf = await stage1Res.arrayBuffer();
    assertZipMagic(buf);
    return buf;
  }

  // 2段階目: 1段階目のレスポンス (確認ページ) の hidden field + 出力ボタンで再 POST
  const stage1Html = await stage1Res.text();
  const hidden2 = extractHiddenFields(stage1Html);
  const outputButton =
    findFormFieldById(stage1Html, "btnCsvSvrOutput") ?? findFormFieldById(stage1Html, "btnCsvOutput");
  if (!outputButton) {
    throw new TheearthClientError(
      "CSV ダウンロードの2段階目ボタンが見つかりません — theearth-np のページ仕様が変更された可能性があります",
    );
  }
  const stage2Body = new URLSearchParams({
    ...hidden2,
    [outputButton.name]: outputButton.value || "ダウンロード",
  });
  const stage2Res = await postForm(jar, csvUrl, stage2Body, fetchImpl);
  const buf = await stage2Res.arrayBuffer();
  assertZipMagic(buf);
  return buf;
}

// ---------------------------------------------------------------------------
// 統合オーケストレーション
// ---------------------------------------------------------------------------

export interface ScrapeHttpParams {
  compId: string;
  userName: string;
  userPass: string;
  startDate: string;
  endDate: string;
}

export type ProgressCallback = (step: "login" | "download" | "done", message?: string) => void;

/** ログイン → CSV ダウンロードを一括で行う。Chromium 不要、素の fetch のみ。 */
export async function scrapeViaHttp(
  params: ScrapeHttpParams,
  onProgress: ProgressCallback,
  fetchImpl: FetchLike = fetch,
): Promise<ArrayBuffer> {
  const jar = createCookieJar();
  onProgress("login");
  await login(jar, { compId: params.compId, userName: params.userName, userPass: params.userPass }, fetchImpl);
  onProgress("download");
  const zip = await downloadCsvZip(jar, { startDate: params.startDate, endDate: params.endDate }, fetchImpl);
  onProgress("done");
  return zip;
}
