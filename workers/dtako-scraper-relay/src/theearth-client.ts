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
 *
 * CSV ダウンロード段は fetch() だけで実データ入り ZIP を取得できる (2026-07-03
 * 実機検証で確定、詳細は downloadCsvZip の doc comment 参照)。真因は「2段階目
 * (btnCsvSvrOutput の POST) に日付範囲フィールドを含めていなかった」ことで、
 * これを含めれば `SCRAPER_MODE=http` (Chromium 不要) で正常動作する。
 */

export const BASE_URL = "https://theearth-np.com";
const LOGIN_PATH = "/F-OES1010[Login].aspx";
const CSV_PATH = "/F-NOS3010[GeneralCsv].aspx";

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** ログイン / GET / 確認ページ POST など軽い応答用のタイムアウト (ms)。
 * サーバが固まった / セッションが hang した時に無限待ちを避けて loud fail する。 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** CSV export (2段階目 = btnCsvSvrOutput POST) 用のタイムアウト (ms)。
 * サーバ側の ZIP 生成が数十秒〜掛かる (実測 90 秒超のケースあり) ため長めに取る。 */
export const DEFAULT_EXPORT_TIMEOUT_MS = 150_000;

export class TheearthClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TheearthClientError";
  }
}

export type FetchLike = typeof fetch;

/** GET / stage1 (要求応答) と stage2 (CSV export) で別々のタイムアウトを渡すための束。 */
export interface ScrapeTimeouts {
  /** ログイン・GET・stage1・確認ページ POST 用 (ms、既定 DEFAULT_REQUEST_TIMEOUT_MS)。 */
  requestTimeoutMs?: number;
  /** stage2 (CSV export) 用 (ms、既定 DEFAULT_EXPORT_TIMEOUT_MS)。 */
  exportTimeoutMs?: number;
}

/** `AbortSignal.timeout` があれば timeout 用 signal を作る (無い環境では undefined)。
 * テストの fake fetch は signal を無視するので、この分岐はテスト実行に影響しない。 */
function makeTimeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

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

export async function fetchWithJar(
  jar: CookieJar,
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  timeoutMs?: number,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  const signal = init.signal ?? makeTimeoutSignal(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, headers, redirect: "manual", signal });
  } catch (e: unknown) {
    // timeout (AbortSignal.timeout 発火) を明示的な TheearthClientError に翻訳して
    // loud fail する。ハングしたセッション / 遅いサーバをそのまま無限待ちしない。
    if (signal?.aborted) {
      throw new TheearthClientError(
        `theearth-np への通信がタイムアウトしました (${timeoutMs}ms) — ` +
          "サーバ応答が遅い、またはセッションが固まっている可能性があります",
      );
    }
    throw e;
  }
  ingestSetCookie(jar, res.headers);
  return res;
}

// ---------------------------------------------------------------------------
// ASP.NET hidden field / form 要素の抽出
// ---------------------------------------------------------------------------

const HIDDEN_FIELD_NAMES = [
  "__VIEWSTATE",
  "__VIEWSTATEGENERATOR",
  // theearth のログインページは viewstate 暗号化が有効で、この field (値は空) を
  // POST に含めないと ASP.NET が「viewstate MAC の検証が失敗しました」の 500 を返し
  // ログイン自体が絶対に成功しない (Refs #90 実測、2026-07-03)。
  "__VIEWSTATEENCRYPTED",
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

/** ページがまだログインフォームか (= txtPass input が居るか)。ログイン失敗時の
 * 再表示は 200 でログインページに戻るので、これが失敗判定の主シグナル。 */
function hasLoginForm(html: string): boolean {
  return findTagById(html, "txtPass") !== null;
}

/**
 * セッション重複プロンプトが「実際に発動しているか」を判定する。
 *
 * theearth は 2 通りで重複を通知する (`J-OES1010[Login].js` 実機確認、2026-07-03):
 *
 * 1. **単純なセッション重複** (同一アカウントが別セッションでログイン中):
 *    サーバが startup script で `OverlapDialog("<message>")` を呼び、JS が
 *    OK/Cancel ダイアログを出して OK なら `$('#btnForced').click()` する。
 *    **この経路では txtOverlapSessionID は populate されない** (常に空のまま)。
 * 2. **ライセンス数超過** (LicenceOver): ユーザー一覧ダイアログで選ばせ、
 *    `ReturnLicenceOver` が `txtOverlapSessionID` に値を焼いてから btnForced を click。
 *
 * 旧実装は (2) の「txtOverlapSessionID に値がある」時だけ強制ログインしていたため、
 * 圧倒的に多い (1) の経路を「ログイン失敗」と誤判定して throw していた
 * (ohishi-exp/dtako-scraper#22 で 27324455 が踏んだ)。両経路を検出する。
 *
 * 注意: theearth のログインページは txtOverlapSessionID / btnForced を常時 hidden で
 * 埋めている (Refs #90)。ID/パスワード誤りの再表示は `OverlapDialog(` を含まないので、
 * 「`OverlapDialog(` の呼び出し」または「txtOverlapSessionID が非空」を重複シグナルと
 * する (単なる field の存在では判定しない)。
 */
function hasOverlapPrompt(html: string): boolean {
  // OverlapDialog 関数の *定義* は外部 JS (J-OES1010[Login].js) にあり aspx 応答には
  // 載らないため、aspx 応答中の `OverlapDialog(` は startup script の *呼び出し* に限る。
  // ※ `LicenceOverDialog(` は "OverlapDialog" を含まないので誤検出しない (別処理)。
  if (/OverlapDialog\s*\(/.test(html)) return true;
  const field = findFormFieldById(html, "txtOverlapSessionID");
  return !!(field && field.value);
}

/**
 * ライセンス数超過 (定数オーバー) の startup script `LicenceOverDialog(...)` を検出し、
 * 見つかればその呼び出し文字列 (診断用、credential は含まれない) を返す。
 *
 * この経路は単純重複 (OverlapDialog → 即 btnForced) と違い、`F-OSS1010[LoginUserList].aspx`
 * で既存ログインユーザーを一覧して kick 対象を選び、`ReturnLicenceOver` が
 * `txtOverlapSessionID = returnNo` を焼いてから btnForced を click する対話が要る
 * (`J-OES1010[Login].js` 実機確認、2026-07-03)。headless での自動 kick は
 * LoginUserList の HTML 構造 (returnNo の形式) が必要だが、当該ページは Target1/Target2
 * を渡さないと `Page_Load` が NullReferenceException を投げる (= 実 license-over
 * イベントを採取しないと構造が分からない)。よって現状は **検出して loud fail** に留め、
 * 運用者に既存セッションのログアウトを促す (自動対応は実応答採取後に実装)。
 */
function detectLicenceOver(html: string): string | null {
  const m = html.match(/LicenceOverDialog\s*\([^)]*\)/);
  return m ? m[0] : null;
}

/** 想定外ページの診断用に title + タグ除去済み本文の先頭を 1 行にする
 * (credential は含まれない。エラーメッセージ / log 用)。 */
function describePage(html: string): string {
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "(no title)";
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `title="${title}" 本文先頭: ${text.slice(0, 160)}`;
}

export async function login(
  jar: CookieJar,
  params: LoginParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<void> {
  const loginUrl = `${BASE_URL}${LOGIN_PATH}?mode=timeout`;

  const getRes = await fetchWithJar(jar, loginUrl, { method: "GET" }, fetchImpl, timeoutMs);
  const html = await getRes.text();
  const hidden = extractHiddenFields(html);

  const body = new URLSearchParams({
    ...hidden,
    txtID2: params.compId,
    txtID1: params.userName,
    txtPass: params.userPass,
    btnLogin: "ログイン",
  });

  const postRes = await postForm(jar, loginUrl, body, fetchImpl, timeoutMs);

  // 通常ログイン成功時は Response.Redirect (3xx) で戻ることが多い。
  if (postRes.status >= 300 && postRes.status < 400) {
    const location = postRes.headers.get("location");
    if (location) {
      const followRes = await fetchWithJar(
        jar,
        new URL(location, loginUrl).toString(),
        { method: "GET" },
        fetchImpl,
        timeoutMs,
      );
      await followRes.text();
    }
    return;
  }

  const postHtml = await postRes.text();

  // viewstate MAC 失敗等の ASP.NET エラーは 500 で返る。原因究明できるよう
  // ページ内容 (title + 本文先頭) を添えて loud fail する (Refs #90)。
  if (!postRes.ok) {
    throw new TheearthClientError(
      `ログイン POST が HTTP ${postRes.status} を返しました (${describePage(postHtml)})`,
    );
  }

  // 同一アカウントの別セッションが既にログイン中の場合、強制ログインプロンプトが出る
  // (`OverlapDialog(...)` の startup script、または LicenceOver 経路で txtOverlapSessionID
  // に値が焼かれる。hasOverlapPrompt の注意書き参照)。
  if (hasOverlapPrompt(postHtml)) {
    const hidden2 = extractHiddenFields(postHtml);
    const btnForced = findFormFieldById(postHtml, "btnForced");
    if (!btnForced) {
      throw new TheearthClientError(
        "セッション重複フォームを検出したが btnForced が見つかりません (ページ仕様変更の可能性)",
      );
    }
    // 強制ログイン POST は実ブラウザのフォーム送信 (`$('#btnForced').click()`) を再現する:
    // hidden + credential (txtID2/txtID1/txtPass) + btnForced を含める。credential を落とすと
    // サーバに拒否され「強制ログインに失敗しました」で詰まる (Refs #90、実ページ検証済み)。
    // btnLogin/btnCancel は押下 submit ではないので送らない。txtOverlapSessionID は
    // LicenceOver 経路のみ非空になる (単純重複 = OverlapDialog では空)。存在すれば
    // その値 (空でも可) をそのまま送る。
    const forcedBody = new URLSearchParams({
      ...hidden2,
      txtID2: params.compId,
      txtID1: params.userName,
      txtPass: params.userPass,
      [btnForced.name]: btnForced.value || "ログイン",
    });
    const overlapField = findFormFieldById(postHtml, "txtOverlapSessionID");
    if (overlapField) forcedBody.set(overlapField.name, overlapField.value);
    const forcedRes = await postForm(jar, loginUrl, forcedBody, fetchImpl, timeoutMs);
    if (forcedRes.status >= 300 && forcedRes.status < 400) return;
    const forcedHtml = await forcedRes.text();
    if (!forcedRes.ok) {
      throw new TheearthClientError(
        `強制ログイン POST が HTTP ${forcedRes.status} を返しました (${describePage(forcedHtml)})`,
      );
    }
    if (looksLoggedIn(forcedHtml)) return;
    if (hasLoginForm(forcedHtml)) {
      throw new TheearthClientError("強制ログインに失敗しました");
    }
    return;
  }

  if (looksLoggedIn(postHtml)) return;

  // ライセンス数超過 (定数オーバー): 単純重複と違い kick 対象の選択が要るため
  // headless 自動対応は未実装。紛らわしい後続エラー (CSV が ZIP でない等) にせず、
  // ここで actionable に loud fail する (detectLicenceOver の注意書き参照)。
  const licenceOver = detectLicenceOver(postHtml);
  if (licenceOver) {
    throw new TheearthClientError(
      "ライセンス数超過 (定数オーバー) を検出しました。同一アカウントの同時ログイン数が上限に達しています。" +
        "既存セッションをログアウトしてから再実行してください " +
        `(headless での自動セッション整理は未対応)。診断: ${licenceOver}`,
    );
  }

  // 200 でログインページに戻された = 認証失敗 (ID/パスワード誤り) が典型。
  if (hasLoginForm(postHtml)) {
    throw new TheearthClientError(
      "ログインに失敗しました (theearth のログイン画面に戻されました。会社ID / ユーザーID / パスワードを確認してください)",
    );
  }

  // ログインフォームでも既知メニューページでもない 200 ページ。成功マーカー
  // (Button1st_2/7) は管理者アカウントの実機 trace 由来で、権限が異なるアカウントは
  // 別ページに着地しうるため、ここは寛容に成功とみなす (後続の VenusBridge / CSV
  // 取得が実質の検証になり、セッション不成立なら loud fail する)。
}

async function postForm(
  jar: CookieJar,
  url: string,
  body: URLSearchParams,
  fetchImpl: FetchLike,
  timeoutMs?: number,
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
    timeoutMs,
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
  // 表示上の "ダウンロード" ボタン (id=btnCsv) の onclick は
  // `DateCheck() { $('#btnCsvSvr').click(); return false; }` (J-NOS3010[GeneralCsv].js) —
  // btnCsv 自身の送信は常にキャンセルされ、実際に POST されるのは隠しボタン
  // btnCsvSvr の name/value。id=btnCsv を使うと実クリックと異なるフィールド名を
  // 送ることになる (2026-07-03 実機検証で確認)。
  "btnCsvSvr",
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

/**
 * CSV (csvdata.zip) を fetch() だけで取得する。Chromium 不要。
 *
 * **真因メモ (2026-07-03 実機検証で確定、ohishi-exp/dtako-scraper#22):**
 * このフローは 2 段階 postback (`btnCsvSvr` → 確認ページ → `btnCsvSvrOutput`) で、
 * サーバ側の CSV export ハンドラは **2段階目の POST body からも日付範囲を読む**。
 * 以前の実装は 2段階目に hidden field と出力ボタンしか含めておらず、日付範囲を
 * 落としていたため「範囲外 = 0 件」の **22 バイトの空 ZIP** (`PK\x05\x06` の EOCD
 * のみ) が返っていた。実ブラウザのクリックは確認ページの DOM に日付が残ったまま
 * submit するので成功していた。2段階目にも日付範囲を再送すれば fetch でも実データ
 * 入りの ZIP が返る (実測 85KB、`PK\x03\x04`)。
 *
 * 過去に「fetch では原理的に不可能、`Sec-Fetch-Mode` 等 navigation 判定が原因」と
 * 誤って結論づけた時期があった (PR #101) が、それは 2段階目の日付欠落を見落とした
 * 誤診だった。navigation の有無は無関係。
 *
 * hang 対策: サーバの export 生成が遅い (実測 90 秒超) ため 2段階目のみ
 * `exportTimeoutMs` を長めに取り、その他は `requestTimeoutMs` で短く切る。
 * 同一 ASP.NET セッションへの **並行リクエストはセッションロックで hang/500 する**
 * ため、呼び出し側 (DO) は comp_id 単位で直列化すること (この関数は逐次実行前提)。
 */
export async function downloadCsvZip(
  jar: CookieJar,
  range: CsvDateRange,
  fetchImpl: FetchLike = fetch,
  timeouts: ScrapeTimeouts = {},
): Promise<ArrayBuffer> {
  const requestTimeoutMs = timeouts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const exportTimeoutMs = timeouts.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const csvUrl = `${BASE_URL}${CSV_PATH}`;

  const getRes = await fetchWithJar(jar, csvUrl, { method: "GET" }, fetchImpl, requestTimeoutMs);
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

  // 日付範囲フィールド (rdoSelect1/rdoDate1 の radio + 開始/終了 年月日)。ASP.NET の
  // field name (`ctl00$MainContent$...`) は GET ページと確認ページで同一なので、
  // GET から抽出した name を stage1 / stage2 の **両方** で再利用する (真因の修正)。
  const dateRange: Record<string, string> = {
    [fields.get("rdoSelect1")!.name]: fields.get("rdoSelect1")!.value,
    [fields.get("rdoDate1")!.name]: fields.get("rdoDate1")!.value,
    [fields.get("MainContent_ucStartDate_txtYear")!.name]: start.y,
    [fields.get("MainContent_ucStartDate_txtMonth")!.name]: start.m,
    [fields.get("MainContent_ucStartDate_txtDay")!.name]: start.d,
    [fields.get("MainContent_ucEndDate_txtYear")!.name]: end.y,
    [fields.get("MainContent_ucEndDate_txtMonth")!.name]: end.m,
    [fields.get("MainContent_ucEndDate_txtDay")!.name]: end.d,
  };

  const stage1Body = new URLSearchParams({
    ...hidden,
    ...dateRange,
    [fields.get("btnCsvSvr")!.name]: fields.get("btnCsvSvr")!.value,
  });

  const stage1Res = await postForm(jar, csvUrl, stage1Body, fetchImpl, requestTimeoutMs);
  const stage1ContentType = stage1Res.headers.get("content-type") ?? "";

  // 1段階目で直接 ZIP が返るケース (実装差異に備える)
  if (stage1ContentType.includes("application/octet-stream") || stage1ContentType.includes("zip")) {
    const buf = await stage1Res.arrayBuffer();
    assertZipMagic(buf);
    return buf;
  }

  // 2段階目: 1段階目のレスポンス (確認ページ) の hidden field + **日付範囲** + 出力ボタン
  // で再 POST。日付範囲を落とすと空 ZIP が返る (このフロー最大の落とし穴、上の doc 参照)。
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
    ...dateRange,
    [outputButton.name]: outputButton.value || "ダウンロード",
  });
  const stage2Res = await postForm(jar, csvUrl, stage2Body, fetchImpl, exportTimeoutMs);
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

/**
 * ログイン → CSV ダウンロードを一括で行う。Chromium 不要、素の fetch のみ。
 *
 * hang / セッションロック対策: 各リクエストにタイムアウトを掛ける (downloadCsvZip
 * の doc 参照)。**同一 comp_id への並行呼び出しは theearth 側のセッションロックで
 * hang/500 する**ため、呼び出し側 (DO) は comp_id 単位で直列化すること。
 */
export async function scrapeViaHttp(
  params: ScrapeHttpParams,
  onProgress: ProgressCallback,
  fetchImpl: FetchLike = fetch,
  timeouts: ScrapeTimeouts = {},
): Promise<ArrayBuffer> {
  const jar = createCookieJar();
  onProgress("login");
  await login(
    jar,
    { compId: params.compId, userName: params.userName, userPass: params.userPass },
    fetchImpl,
    timeouts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  onProgress("download");
  const zip = await downloadCsvZip(
    jar,
    { startDate: params.startDate, endDate: params.endDate },
    fetchImpl,
    timeouts,
  );
  onProgress("done");
  return zip;
}
