/**
 * etc-meisai.jp (ETC利用照会サービス) へのブラウザレス HTTP クライアント。
 *
 * ohishi-exp/browser-render-rust#14 の実機トレース (手元ブラウザでの network
 * capture、fetch のみで login → 検索 → 実 CSV 取得まで実証済み) を素の
 * `fetch()` で再現する。Chromium は起動しない。
 *
 * サイト構造 (issue #14 で確定):
 * - 独自ルーター `/etc/R` に funccode でディスパッチする form POST の連続。
 *   全遷移が `submitPage` / `submitOpenPage` / `goOutput` = form POST の薄い
 *   JS ラッパーなので、hidden field (48 文字の `p` 等) をページから抽出して
 *   POST すれば再現できる。
 * - ログイン: `POST /etc/R?funccode=1013000000&nextfunc=1013000000`
 *   (`risLoginId` / `risPassword` + hidden)。2FA / CAPTCHA 無し。
 * - 検索: `POST ...&nextfunc=1032000000`。**`sokoKbn` の初期値は
 *   「ETC無線走行のみ」(1)** — 明示的に `sokoKbn=0` (全て) を送らないと明細が
 *   欠落する (issue #14 の最重要 gotcha)。
 * - 明細 CSV 出力: `POST ...&nextfunc=1032500000` →
 *   `application/octet-stream` / `attachment; filename=...csv` (Shift_JIS)。
 *
 * 「黙って200」対策: 想定した form / field が見つからない場合、および CSV の
 * はずが HTML が返った場合は必ず EtcMeisaiClientError 系を throw する
 * (theearth-client.ts と同じ方針)。ページは Shift_JIS の可能性があるため、
 * 応答は charset を sniff してデコードする (フィールド名は ASCII なので
 * デコード失敗はパースに致命傷ではないが、「ご利用はありません」等の日本語
 * マーカー判定に必要)。
 */

import {
  cookieHeader,
  createCookieJar,
  ingestSetCookie,
  type CookieJar,
  type FetchLike,
} from "./theearth-client";

export const ETC_BASE_URL = "https://www.etc-meisai.jp";

/** ログイン (issue #14: `POST /etc/R?funccode=1013000000&nextfunc=1013000000`)。 */
export const ETC_FUNC_LOGIN = "1013000000";
/** 検索条件 → 検索 (issue #14: `nextfunc=1032000000`)。 */
export const ETC_FUNC_SEARCH = "1032000000";
/** 明細 CSV 出力 (issue #14: `nextfunc=1032500000`)。 */
export const ETC_FUNC_CSV_OUTPUT = "1032500000";

/** ログイン・ページ遷移用タイムアウト (ms)。 */
export const ETC_REQUEST_TIMEOUT_MS = 30_000;
/** CSV 出力 POST 用タイムアウト (ms)。明細件数が多いと生成に時間が掛かり得る。 */
export const ETC_EXPORT_TIMEOUT_MS = 120_000;

const REDIRECT_LIMIT = 5;

export class EtcMeisaiClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EtcMeisaiClientError";
  }
}

/** 「当該月のご利用はありません」— 明細 0 件はエラーではなくこの typed error で
 * 区別する (cron 側は成功扱いで skip する)。 */
export class EtcMeisaiNoUsageError extends EtcMeisaiClientError {
  constructor() {
    super("当該月のご利用はありません (明細 0 件)");
    this.name = "EtcMeisaiNoUsageError";
  }
}

/** CSV のはずが CSV でない応答が返った時の error。原因調査用に生バイトを載せる
 * (呼び出し側が R2 等に保存して中身を確認できるようにする)。 */
export class EtcMeisaiNotCsvError extends EtcMeisaiClientError {
  readonly responseBytes: ArrayBuffer;
  readonly contentType: string;
  constructor(message: string, responseBytes: ArrayBuffer, contentType: string) {
    super(message);
    this.name = "EtcMeisaiNotCsvError";
    this.responseBytes = responseBytes;
    this.contentType = contentType;
  }
}

// ---------------------------------------------------------------------------
// fetch ラッパー (cookie jar + redirect 手動追跡 + タイムアウト)
// ---------------------------------------------------------------------------

/** `AbortSignal.timeout` があれば timeout 用 signal を作る (無い環境では undefined)。 */
function makeTimeoutSignal(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || typeof AbortSignal === "undefined" || typeof AbortSignal.timeout !== "function") {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

async function fetchEtc(
  jar: CookieJar,
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = cookieHeader(jar);
  if (cookie) headers.set("cookie", cookie);
  const signal = makeTimeoutSignal(timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, headers, redirect: "manual", signal });
  } catch (e: unknown) {
    if (signal?.aborted) {
      throw new EtcMeisaiClientError(
        `etc-meisai.jp への通信がタイムアウトしました (${timeoutMs}ms) — ` +
          "サーバ応答が遅い、またはセッションが固まっている可能性があります",
      );
    }
    throw e;
  }
  ingestSetCookie(jar, res.headers);
  return res;
}

export interface EtcPage {
  /** redirect 追跡後の最終 URL。相対 action の解決 / アカウント種別判定に使う。 */
  url: string;
  html: string;
}

/** 3xx を最大 REDIRECT_LIMIT 回まで手動追跡し、最終ページを charset sniff 付きで
 * デコードして返す。 */
async function followToPage(
  jar: CookieJar,
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<EtcPage> {
  let currentUrl = url;
  let res = await fetchEtc(jar, currentUrl, init, fetchImpl, timeoutMs);
  for (let hop = 0; hop < REDIRECT_LIMIT && res.status >= 300 && res.status < 400; hop += 1) {
    const location = res.headers.get("location");
    if (!location) break;
    currentUrl = new URL(location, currentUrl).toString();
    res = await fetchEtc(jar, currentUrl, { method: "GET" }, fetchImpl, timeoutMs);
  }
  if (!res.ok) {
    throw new EtcMeisaiClientError(
      `etc-meisai.jp が HTTP ${res.status} を返しました (url=${currentUrl})`,
    );
  }
  const bytes = await res.arrayBuffer();
  const html = decodeHtml(bytes, res.headers.get("content-type"));
  return { url: currentUrl, html };
}

// ---------------------------------------------------------------------------
// charset sniff + デコード (etc-meisai は Shift_JIS の可能性が高い)
// ---------------------------------------------------------------------------

/** content-type ヘッダ → meta タグ → Shift_JIS の順で charset を決める。
 * etc-meisai の CSV は Shift_JIS 実測 (issue #14) なので、宣言が無いページも
 * Shift_JIS とみなすのが安全側。 */
export function sniffCharset(contentType: string | null, bytes: Uint8Array): string {
  const fromHeader = contentType?.match(/charset=([^;\s"']+)/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();
  // meta charset は ASCII 互換部分にしか現れない前提で先頭 2KB を latin1 相当で見る
  let prefix = "";
  const limit = Math.min(bytes.length, 2048);
  for (let i = 0; i < limit; i += 1) prefix += String.fromCharCode(bytes[i]);
  const fromMeta =
    prefix.match(/<meta[^>]+charset=["']?([a-z0-9_-]+)/i)?.[1];
  if (fromMeta) return fromMeta.toLowerCase();
  return "shift_jis";
}

export function decodeHtml(buf: ArrayBuffer, contentType: string | null): string {
  const bytes = new Uint8Array(buf);
  const charset = sniffCharset(contentType, bytes);
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // 未知の charset ラベルは UTF-8 で読む (フィールド名は ASCII なので form
    // パースは成立する。日本語マーカー判定だけ劣化するが loud fail 側に倒れる)
    return new TextDecoder("utf-8").decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// HTML form パース
// ---------------------------------------------------------------------------

export interface EtcCheckbox {
  name: string;
  value: string;
}

export interface EtcForm {
  /** form の action 属性 (無ければ空 = 現在 URL に POST)。 */
  action: string;
  /** POST に載せる field (hidden / text / password / checked radio / checked
   * checkbox / select)。type=submit/button/image は JS ラッパー経由の遷移では
   * 送信されないため含めない。 */
  fields: Map<string, string>;
  /** form 内の全 checkbox (「全選択」相当の一括チェックに使う)。 */
  checkboxes: EtcCheckbox[];
}

function getAttr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"));
  return m ? m[1] : null;
}

function hasBareAttr(tag: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`, "i").test(tag);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const NON_POSTED_INPUT_TYPES = new Set(["submit", "button", "image", "reset", "file"]);

/** ページ内の全 `<form>` をパースする。 */
export function parseForms(html: string): EtcForm[] {
  const forms: EtcForm[] = [];
  const formRe = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let fm: RegExpExecArray | null;
  while ((fm = formRe.exec(html)) !== null) {
    const attrs = fm[1];
    const body = fm[2];
    const form: EtcForm = {
      action: decodeEntities(getAttr(`<form ${attrs}>`, "action") ?? ""),
      fields: new Map(),
      checkboxes: [],
    };

    const inputRe = /<input\b[^>]*>/gi;
    let im: RegExpExecArray | null;
    while ((im = inputRe.exec(body)) !== null) {
      const tag = im[0];
      const name = getAttr(tag, "name");
      if (!name) continue;
      const type = (getAttr(tag, "type") ?? "text").toLowerCase();
      if (NON_POSTED_INPUT_TYPES.has(type)) continue;
      const value = decodeEntities(getAttr(tag, "value") ?? "");
      if (type === "checkbox") {
        const cbValue = value || "on";
        form.checkboxes.push({ name, value: cbValue });
        if (hasBareAttr(tag, "checked")) form.fields.set(name, cbValue);
        continue;
      }
      if (type === "radio") {
        if (hasBareAttr(tag, "checked")) form.fields.set(name, value);
        continue;
      }
      form.fields.set(name, value);
    }

    const selectRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
    let sm: RegExpExecArray | null;
    while ((sm = selectRe.exec(body)) !== null) {
      const name = getAttr(`<select ${sm[1]}>`, "name");
      if (!name) continue;
      const optionRe = /<option\b[^>]*>/gi;
      let firstValue: string | null = null;
      let selectedValue: string | null = null;
      let om: RegExpExecArray | null;
      while ((om = optionRe.exec(sm[2])) !== null) {
        const value = decodeEntities(getAttr(om[0], "value") ?? "");
        if (firstValue === null) firstValue = value;
        if (selectedValue === null && hasBareAttr(om[0], "selected")) selectedValue = value;
      }
      form.fields.set(name, selectedValue ?? firstValue ?? "");
    }

    forms.push(form);
  }
  return forms;
}

/** 指定 field 名を持つ form を探す。 */
export function findFormWithField(forms: EtcForm[], fieldName: string): EtcForm | null {
  return forms.find((f) => f.fields.has(fieldName)) ?? null;
}

/** 遷移 POST に使う「メイン form」を選ぶ: `nextfunc` / `funccode` hidden を持つ
 * form を優先し、無ければ最初の form。 */
export function pickMainForm(forms: EtcForm[]): EtcForm | null {
  return (
    forms.find((f) => f.fields.has("nextfunc") || f.fields.has("funccode")) ?? forms[0] ?? null
  );
}

// ---------------------------------------------------------------------------
// リンク抽出 (submitPage 系 JS ラッパー対応)
// ---------------------------------------------------------------------------

export interface EtcLink {
  href: string;
  text: string;
}

export function parseLinks(html: string): EtcLink[] {
  const links: EtcLink[] = [];
  // href の値は `javascript:submitPage('a','b')` のように **逆側の quote を内包
  // し得る** ため、開き quote と同種の quote までを 1 つの値として読む
  // (`["']([^"']*)["']` だと submitPage の第1引数の quote で切れる)。
  const re = /<a\b[^>]*href=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    links.push({
      href: decodeEntities(m[1] ?? m[2]),
      text: m[3].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    });
  }
  return links;
}

/** `javascript:submitPage('1032000000','1032000000')` 等の JS ラッパー href から
 * 引数リストを抽出する。JS でなければ null。 */
export function parseJsSubmitArgs(href: string): string[] | null {
  if (!/^javascript:/i.test(href.trim())) return null;
  const args: string[] = [];
  const re = /'([^']*)'|"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(href)) !== null) {
    args.push(m[1] ?? m[2]);
  }
  return args;
}

// ---------------------------------------------------------------------------
// form POST (funccode ルーター向け)
// ---------------------------------------------------------------------------

/** action URL の query に nextfunc を強制セットする (issue #14 のトレースでは
 * 遷移は常に `POST /etc/R?funccode=...&nextfunc=...`)。hidden field 側にも
 * nextfunc があれば呼び出し側で override する。 */
export function withNextfunc(actionUrl: string, nextfunc: string): string {
  const u = new URL(actionUrl);
  u.searchParams.set("nextfunc", nextfunc);
  return u.toString();
}

/** ページ内 form を指定 override 付きで POST し、次ページを返す。 */
async function submitForm(
  jar: CookieJar,
  page: EtcPage,
  form: EtcForm,
  overrides: Record<string, string>,
  nextfunc: string | null,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<EtcPage> {
  let action = new URL(form.action || page.url, page.url).toString();
  const body = new URLSearchParams();
  for (const [name, value] of form.fields) body.set(name, value);
  for (const [name, value] of Object.entries(overrides)) body.set(name, value);
  if (nextfunc !== null) {
    action = withNextfunc(action, nextfunc);
    if (form.fields.has("nextfunc")) body.set("nextfunc", nextfunc);
  }
  return followToPage(
    jar,
    action,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    fetchImpl,
    timeoutMs,
  );
}

// ---------------------------------------------------------------------------
// ログイン
// ---------------------------------------------------------------------------

export type EtcAccountType = "personal" | "corporate";

export interface EtcSession {
  page: EtcPage;
  accountType: EtcAccountType;
}

export interface EtcLoginParams {
  userId: string;
  password: string;
}

/** ログイン後 URL からアカウント種別を判定する (issue #14: 個人
 * `/etc_user_meisai/` / 法人 `/etc_corp_meisai/` で分岐)。 */
export function detectAccountType(url: string): EtcAccountType {
  return url.includes("/etc_corp_meisai/") ? "corporate" : "personal";
}

export async function etcLogin(
  jar: CookieJar,
  params: EtcLoginParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = ETC_REQUEST_TIMEOUT_MS,
): Promise<EtcSession> {
  // 1. トップページからログインリンク (funccode=1013000000) を辿る
  const top = await followToPage(jar, `${ETC_BASE_URL}/`, { method: "GET" }, fetchImpl, timeoutMs);
  const loginLink = parseLinks(top.html).find((l) =>
    l.href.includes(`funccode=${ETC_FUNC_LOGIN}`),
  );
  if (!loginLink) {
    throw new EtcMeisaiClientError(
      "トップページにログインリンク (funccode=1013000000) が見つかりません — " +
        "etc-meisai.jp のページ仕様が変更された可能性があります",
    );
  }
  const loginPage = await followToPage(
    jar,
    new URL(loginLink.href, top.url).toString(),
    { method: "GET" },
    fetchImpl,
    timeoutMs,
  );

  // 2. ログインフォーム (risLoginId) に credential + hidden (`p` 等) を載せて POST
  const loginForm = findFormWithField(parseForms(loginPage.html), "risLoginId");
  if (!loginForm) {
    throw new EtcMeisaiClientError(
      "ログインフォーム (risLoginId) が見つかりません — etc-meisai.jp のページ仕様が変更された可能性があります",
    );
  }
  const afterLogin = await submitForm(
    jar,
    loginPage,
    loginForm,
    { risLoginId: params.userId, risPassword: params.password },
    ETC_FUNC_LOGIN,
    fetchImpl,
    timeoutMs,
  );

  // 3. ログイン失敗 = ログインフォームが再表示される (200 のまま)
  if (findFormWithField(parseForms(afterLogin.html), "risLoginId")) {
    throw new EtcMeisaiClientError(
      "ログインに失敗しました (etc-meisai のログイン画面に戻されました。ユーザーID / パスワードを確認してください)",
    );
  }

  return { page: afterLogin, accountType: detectAccountType(afterLogin.url) };
}

// ---------------------------------------------------------------------------
// 検索条件ページへの遷移 → 検索 → CSV
// ---------------------------------------------------------------------------

/** ログイン後ページから検索条件フォーム (sokoKbn) のあるページへ遷移する。
 * 既に sokoKbn form があればそのまま返す。「検索条件」リンクが JS ラッパー
 * (`javascript:submitPage(...)`) の場合はメイン form の POST で再現する。 */
export async function navigateToSearchPage(
  jar: CookieJar,
  session: EtcSession,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = ETC_REQUEST_TIMEOUT_MS,
): Promise<EtcPage> {
  const page = session.page;
  if (findFormWithField(parseForms(page.html), "sokoKbn")) return page;

  const link = parseLinks(page.html).find(
    (l) => l.text.includes("検索条件") || l.text.includes("利用明細検索"),
  );
  if (!link) {
    throw new EtcMeisaiClientError(
      "「検索条件の指定」リンクが見つかりません — etc-meisai.jp のページ仕様が変更された可能性があります",
    );
  }

  const jsArgs = parseJsSubmitArgs(link.href);
  let next: EtcPage;
  if (jsArgs === null) {
    next = await followToPage(
      jar,
      new URL(link.href, page.url).toString(),
      { method: "GET" },
      fetchImpl,
      timeoutMs,
    );
  } else {
    const mainForm = pickMainForm(parseForms(page.html));
    if (!mainForm) {
      throw new EtcMeisaiClientError(
        "「検索条件の指定」の遷移用 form が見つかりません — etc-meisai.jp のページ仕様が変更された可能性があります",
      );
    }
    // submitPage('funccode','nextfunc') / submitPage('nextfunc') の両形式に対応:
    // 最後の引数を nextfunc、2 引数以上なら先頭を funccode とみなす。
    const nextfunc = jsArgs[jsArgs.length - 1] ?? "";
    const overrides: Record<string, string> = {};
    if (jsArgs.length >= 2 && mainForm.fields.has("funccode")) {
      overrides.funccode = jsArgs[0];
    }
    next = await submitForm(jar, page, mainForm, overrides, nextfunc || null, fetchImpl, timeoutMs);
  }

  if (!findFormWithField(parseForms(next.html), "sokoKbn")) {
    throw new EtcMeisaiClientError(
      "検索条件フォーム (sokoKbn) が見つかりません — etc-meisai.jp のページ仕様が変更された可能性があります",
    );
  }
  return next;
}

/** 検索条件フォームを `sokoKbn=0` (全て) + 全 checkbox 選択 (「全選択」相当) で
 * POST し、明細一覧ページを返す。明細 0 件は EtcMeisaiNoUsageError。 */
export async function submitSearch(
  jar: CookieJar,
  searchPage: EtcPage,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = ETC_REQUEST_TIMEOUT_MS,
): Promise<EtcPage> {
  const form = findFormWithField(parseForms(searchPage.html), "sokoKbn");
  if (!form) {
    throw new EtcMeisaiClientError(
      "検索条件フォーム (sokoKbn) が見つかりません — etc-meisai.jp のページ仕様が変更された可能性があります",
    );
  }
  const overrides: Record<string, string> = { sokoKbn: "0" };
  for (const cb of form.checkboxes) overrides[cb.name] = cb.value;

  const result = await submitForm(
    jar,
    searchPage,
    form,
    overrides,
    ETC_FUNC_SEARCH,
    fetchImpl,
    timeoutMs,
  );
  if (result.html.includes("当該月のご利用はありません")) {
    throw new EtcMeisaiNoUsageError();
  }
  return result;
}

export interface EtcCsvResult {
  bytes: ArrayBuffer;
  /** content-disposition の filename (取れなければ meisai.csv)。 */
  filename: string;
}

/** content-disposition から filename を抜く (ASCII のみ想定、無ければ fallback)。 */
export function parseCsvFilename(contentDisposition: string | null): string {
  const m = contentDisposition?.match(/filename=["']?([^"';]+)/i);
  return m ? m[1].trim() : "meisai.csv";
}

/** 明細一覧ページから CSV 出力 (`nextfunc=1032500000`) を POST し、CSV バイト列を
 * 返す。CSV でない応答 (HTML エラーページ等) は EtcMeisaiNotCsvError。 */
export async function downloadMeisaiCsv(
  jar: CookieJar,
  resultPage: EtcPage,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = ETC_EXPORT_TIMEOUT_MS,
): Promise<EtcCsvResult> {
  const form = pickMainForm(parseForms(resultPage.html));
  if (!form) {
    throw new EtcMeisaiClientError(
      "明細一覧ページに CSV 出力用 form が見つかりません — etc-meisai.jp のページ仕様が変更された可能性があります",
    );
  }

  let action = new URL(form.action || resultPage.url, resultPage.url).toString();
  action = withNextfunc(action, ETC_FUNC_CSV_OUTPUT);
  const body = new URLSearchParams();
  for (const [name, value] of form.fields) body.set(name, value);
  if (form.fields.has("nextfunc")) body.set("nextfunc", ETC_FUNC_CSV_OUTPUT);

  const res = await fetchEtc(
    jar,
    action,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    },
    fetchImpl,
    timeoutMs,
  );
  const contentType = res.headers.get("content-type") ?? "";
  const bytes = await res.arrayBuffer();

  // 「黙って200」対策: octet-stream / csv 以外、または中身が HTML (先頭が '<')
  // なら CSV とみなさない。CSV にはマジックバイトが無いため二重に判定する。
  const looksBinary = contentType.includes("application/octet-stream") || contentType.includes("csv");
  const firstChar = bytes.byteLength > 0 ? String.fromCharCode(new Uint8Array(bytes)[0]) : "";
  if (!res.ok || !looksBinary || bytes.byteLength === 0 || firstChar === "<") {
    throw new EtcMeisaiNotCsvError(
      `取得したデータが CSV ではありません (HTTP ${res.status}, content-type=${contentType || "(none)"}, ` +
        `${bytes.byteLength} bytes) — ログイン切れ、または etc-meisai.jp のページ仕様変更の可能性があります`,
      bytes,
      contentType,
    );
  }
  return { bytes, filename: parseCsvFilename(res.headers.get("content-disposition")) };
}

// ---------------------------------------------------------------------------
// 統合オーケストレーション
// ---------------------------------------------------------------------------

export interface EtcScrapeParams {
  userId: string;
  password: string;
}

export interface EtcTimeouts {
  requestTimeoutMs?: number;
  exportTimeoutMs?: number;
}

export type EtcProgressCallback = (
  step: "login" | "search" | "download" | "done",
  message?: string,
) => void;

export interface EtcScrapeResult extends EtcCsvResult {
  accountType: EtcAccountType;
}

/**
 * ログイン → 検索条件ページ → 検索 (sokoKbn=0 + 全選択) → CSV 出力を一括で行う。
 * Chromium 不要、素の fetch のみ。明細 0 件は EtcMeisaiNoUsageError で通知する。
 *
 * 同一アカウントへの並行呼び出しはセッション衝突の恐れがあるため、呼び出し側
 * (DO) はアカウント単位で直列化すること (theearth と同じ前提)。
 */
export async function scrapeEtcCsv(
  params: EtcScrapeParams,
  onProgress: EtcProgressCallback,
  fetchImpl: FetchLike = fetch,
  timeouts: EtcTimeouts = {},
): Promise<EtcScrapeResult> {
  const requestTimeoutMs = timeouts.requestTimeoutMs ?? ETC_REQUEST_TIMEOUT_MS;
  const exportTimeoutMs = timeouts.exportTimeoutMs ?? ETC_EXPORT_TIMEOUT_MS;
  const jar = createCookieJar();

  onProgress("login");
  const session = await etcLogin(
    jar,
    { userId: params.userId, password: params.password },
    fetchImpl,
    requestTimeoutMs,
  );

  onProgress("search");
  const searchPage = await navigateToSearchPage(jar, session, fetchImpl, requestTimeoutMs);
  const resultPage = await submitSearch(jar, searchPage, fetchImpl, requestTimeoutMs);

  onProgress("download");
  const csv = await downloadMeisaiCsv(jar, resultPage, fetchImpl, exportTimeoutMs);

  onProgress("done");
  return { ...csv, accountType: session.accountType };
}
