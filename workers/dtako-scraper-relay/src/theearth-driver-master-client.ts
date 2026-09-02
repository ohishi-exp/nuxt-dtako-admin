/**
 * theearth (web地球号) の **乗務員マスタ** F-MMS0320 [DriverMaintenance] を
 * ブラウザレス fetch で全ページ収集し、alc の employees へ流し込める形に畳む
 * (Refs ippoan/alc-app-s3#125)。
 *
 * ## なぜ HTML 一覧をページングするのか
 *
 * CoreS3 / alc-app のタブレットは免許証の「交付日 8 桁 + 有効期限 8 桁」= 16 桁を
 * `employees.nfc_id` として乗務員を引く。その 16 桁を全乗務員ぶん埋められる正は
 * theearth の乗務員マスタだけで、**CSV 出力 (F-MOS0010) には免許列が無い**。
 * ⇒ 一覧 HTML をポストバックでページングして読む以外に経路が無い。
 *
 * ## ★ 名寄せの正は 2 系統ある (混同しないこと)
 *
 * `employee-master.ts` / D1 の `employees` は **「給与コード × 会社」基準の別マスタ**で、
 * ここが読む theearth の「乗務員CD」とは番号体系こそ同じ (給与マスタの `driverCd` と
 * 同じ番号) だが**別の台帳**。この module は D1 側に一切触れず、名前も `driver-master`
 * 系で通す (取り違えると片方だけ直る事故になる)。
 *
 * ## 読まない列 (意図的)
 *
 * 免許証番号・住所・電話・メールは**読まない・送らない・ログに出さない**。
 * 送るのは 乗務員CD / 氏名 / nfc_id / 交付年月日 / 有効期限 だけ。
 *
 * ## ページャの罠 (F-DES1010 の harvest で実測済み。ここでも同じ形を踏襲する)
 *
 * 1. **部分 POST だと `ddlRowCount` が既定に落ちてアカウント設定として残留する。**
 *    ⇒ postback は常に `serializeFormFields` の full form に上書きする形で組む。
 * 2. **`...` は窓の前 (戻る側) と後ろ (進む側) の両方に出る。**
 *    ⇒ 数字リンクの**後ろ**にある `...` だけを次ページ候補にする (先頭 match だと後退する)。
 * 3. **`gCurrentPage` が前進したことを毎ページ検証する。**
 *    ⇒ 進まないまま回ると静かに件数が欠ける (2026-07-29 に運転日報で実害)。
 */

import {
  decodeHtmlEntities,
  fetchWithJar,
  hasLoginForm,
  postForm,
  serializeFormFields,
  BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TheearthClientError,
  VenusSessionExpiredError,
  type CookieJar,
  type FetchLike,
} from "./theearth-client";
import {
  extractCurrentPageNumber,
  extractPagerLinks,
  postPagerLink,
  type PagerLink,
} from "./theearth-report-client";

/** 乗務員マスタ一覧のパス。 */
export const DRIVER_MASTER_PATH = "/F-MMS0320[DriverMaintenance].aspx";

/** ページャ誤検出時に無限ループしないための安全弁 (実測 5 ページ超、余裕を取る)。 */
export const MAX_DRIVER_MASTER_PAGES = 50;

/** 1 ページに出す行数。既定 20 のまま回しても全件は取れるが、往復を減らす。 */
export const DRIVER_MASTER_ROW_COUNT = "30";

/** 退職を表す乗務員分類4 の接頭辞。 */
const RETIRED_CLASSIFICATION_PREFIX = "999:";

/** 一覧から読む列 (header 行の列名で引く。**固定 idx では引かない** — 列追加に耐える)。 */
const COLUMN_LABELS = {
  driverCd: "乗務員CD",
  name: "乗務員名",
  retiredOn: "退職年月日",
  classification4: "乗務員分類4",
  licenseIssuedOn: "交付年月日",
  licenseExpiresOn: "有効期限",
} as const;

/** データ行を見分ける目印 (この grid のセルは `<span id="lstMain_LabelValue{col}_{row}">`)。
 * **最終行の「新規追加用 `<input type="text">` 行」はこの span を持たないので自然に落ちる。** */
const DATA_CELL_MARKER = "lstMain_LabelValue";

/** 一覧 1 行ぶん (theearth の表記のまま持つ。変換は `toUpsertItems` の責務)。 */
export interface DriverMasterRow {
  /** 乗務員CD。 */
  driverCd: string;
  /** 乗務員名。 */
  name: string;
  /** 退職年月日 (`YYYY/MM/DD`。在籍中は空文字)。 */
  retiredOn: string;
  /** 乗務員分類4 (`999:退職` のような `コード:名称` 形式)。 */
  classification4: string;
  /** 免許証の交付年月日 (`YYYY/MM/DD`。未登録は空文字)。 */
  licenseIssuedOn: string;
  /** 免許証の有効期限 (`YYYY/MM/DD`。未登録は空文字)。 */
  licenseExpiresOn: string;
}

/** `PUT /api/employees/bulk-by-code` (rust-alc-api) に送る 1 件。
 * フィールド名は alc の `employees` 列 (`code` / `name` / `nfc_id` /
 * `license_issue_date` / `license_expiry_date`) にそのまま合わせる。 */
export interface EmployeeUpsertItem {
  code: string;
  name: string;
  /** 交付日 8 桁 + 有効期限 8 桁 = 16 桁。**両方揃った時だけ**組み立てる。 */
  nfc_id: string | null;
  /** `YYYY-MM-DD`。 */
  license_issue_date: string | null;
  /** `YYYY-MM-DD`。 */
  license_expiry_date: string | null;
}

/** `parseDriverMasterPage` の戻り。 */
export interface DriverMasterPage {
  rows: DriverMasterRow[];
  /** `gCurrentPage` の値。ページャが無い (1 ページに収まる) 一覧では 1。 */
  currentPage: number;
  /**
   * 次ページへ進む postback リンク。無ければ null (= 最終ページ)。
   *
   * **`postPagerLink` が `{target, argument}` の対を要求する**ので、target 文字列
   * だけでなくリンクそのものを返す (argument を落とすと `__EVENTARGUMENT` が
   * 送れず、引数を持つページャで静かに進まなくなる)。
   */
  nextTarget: PagerLink | null;
}

/** セルの内側からタグを剥がし、entity を戻して trim する (textContent 相当)。 */
function cellText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ")).trim();
}

/** `<tr>…</tr>` を順に取り出し、それぞれの生 HTML とセル文字列の組にして返す。 */
function splitRows(html: string): Array<{ raw: string; cells: string[] }> {
  const rows: Array<{ raw: string; cells: string[] }> = [];
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = trRe.exec(html)) !== null) {
    const cells: string[] = [];
    const cellRe = /<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi;
    let c: RegExpExecArray | null;
    while ((c = cellRe.exec(m[1])) !== null) cells.push(cellText(c[1]));
    rows.push({ raw: m[0], cells });
  }
  return rows;
}

/** header 行 (乗務員CD と 乗務員名 の両方を持つ最初の行) から 列名 → 列位置 を作る。 */
function resolveColumnIndexes(rows: Array<{ cells: string[] }>): Map<string, number> | null {
  for (const row of rows) {
    if (!row.cells.includes(COLUMN_LABELS.driverCd) || !row.cells.includes(COLUMN_LABELS.name)) continue;
    const map = new Map<string, number>();
    row.cells.forEach((label, index) => {
      if (label && !map.has(label)) map.set(label, index);
    });
    return map;
  }
  return null;
}

/**
 * 乗務員マスタ一覧 (1 ページぶんの HTML) を行 + ページャ状態に畳む。
 *
 * - 列は **header 行の列名**で引く (固定 idx では引かない)。header が読めなければ 0 行。
 * - データ行は `lstMain_LabelValue` セルを持つ行だけ。**最終行の新規追加用
 *   `<input type="text">` 行はこの目印を持たないので落ちる。**
 * - 一覧に無い列 (会社ごとに列構成が違う場合) は空文字にする。
 */
export function parseDriverMasterPage(html: string): DriverMasterPage {
  const currentPage = extractCurrentPageNumber(html) ?? 1;
  const allRows = splitRows(html);
  const columns = resolveColumnIndexes(allRows);
  const rows: DriverMasterRow[] = [];
  if (columns) {
    const at = (cells: string[], label: string): string => {
      const index = columns.get(label);
      return index === undefined ? "" : (cells[index] ?? "");
    };
    for (const row of allRows) {
      if (!row.raw.includes(DATA_CELL_MARKER)) continue;
      rows.push({
        driverCd: at(row.cells, COLUMN_LABELS.driverCd),
        name: at(row.cells, COLUMN_LABELS.name),
        retiredOn: at(row.cells, COLUMN_LABELS.retiredOn),
        classification4: at(row.cells, COLUMN_LABELS.classification4),
        licenseIssuedOn: at(row.cells, COLUMN_LABELS.licenseIssuedOn),
        licenseExpiresOn: at(row.cells, COLUMN_LABELS.licenseExpiresOn),
      });
    }
  }
  return { rows, currentPage, nextTarget: pickNextPagerLink(extractPagerLinks(html), currentPage) };
}

/**
 * 次ページへ進むリンクを選ぶ。
 *
 * 1. テキストが `currentPage + 1` の数字リンク
 * 2. 無ければ **数字リンクより後ろにある** `...` (= 進む側の窓送り)。
 *    先頭 match を採ると**戻る側**の `...` を踏んで後退する (運転日報で実測済みの罠)。
 * 3. どちらも無ければ null (最終ページ)
 */
export function pickNextPagerLink(links: PagerLink[], currentPage: number): PagerLink | null {
  const nextText = String(currentPage + 1);
  const numeric = links.find((l) => l.text === nextText);
  if (numeric) return numeric;
  let lastNumericIndex = -1;
  links.forEach((l, index) => {
    if (/^\d+$/.test(l.text)) lastNumericIndex = index;
  });
  const forward = links.find((l, index) => (l.text === "..." || l.text === "…") && index > lastNumericIndex);
  return forward ?? null;
}

/** `YYYY/MM/DD` を `YYYY-MM-DD` にする。読めない形 (空欄含む) は null。 */
export function toIsoDate(value: string): string | null {
  const m = value.trim().match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** 退職者か (退職年月日が入っている、または 乗務員分類4 が `999:` で始まる)。 */
export function isRetiredDriver(row: DriverMasterRow): boolean {
  return row.retiredOn.trim() !== "" || row.classification4.trim().startsWith(RETIRED_CLASSIFICATION_PREFIX);
}

/**
 * 一覧の行を `PUT /api/employees/bulk-by-code` の items に畳む。
 *
 * - **退職者は送らない** (`isRetiredDriver`)。
 * - 乗務員CD が空の行は送らない (`code` が主キーなので空では upsert できない)。
 * - 免許日付は `YYYY-MM-DD` に直す。**片方だけでも入れる** (期限だけ判っている乗務員が居る)。
 * - `nfc_id` は 交付 8 桁 + 期限 8 桁。**両方揃わなければ null** (タブレットが引けないだけで、
 *   氏名と判っている方の日付は入れておく)。
 * - 同じ乗務員CD が複数ページに跨って出た時は**後勝ち**。
 */
export function toUpsertItems(rows: DriverMasterRow[]): EmployeeUpsertItem[] {
  const byCode = new Map<string, EmployeeUpsertItem>();
  for (const row of rows) {
    const code = row.driverCd.trim();
    if (!code || isRetiredDriver(row)) continue;
    const issue = toIsoDate(row.licenseIssuedOn);
    const expiry = toIsoDate(row.licenseExpiresOn);
    byCode.set(code, {
      code,
      name: row.name.trim(),
      nfc_id: issue && expiry ? `${issue.replace(/-/g, "")}${expiry.replace(/-/g, "")}` : null,
      license_issue_date: issue,
      license_expiry_date: expiry,
    });
  }
  return [...byCode.values()];
}

/** 一覧ページを POST し、セッション切れ / 非 200 を loud fail する。 */
async function postDriverMasterForm(
  jar: CookieJar,
  url: string,
  html: string,
  extra: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  // ★ full form 直列化。hidden だけの部分 POST だと `ddlRowCount` が既定へ落ち、
  // その値が**アカウント設定として残留する** (btnUpdate で実証済みの罠)。
  const body = new URLSearchParams({ ...serializeFormFields(html), ...extra });
  const res = await postForm(jar, url, body, fetchImpl, timeoutMs, "driver_master_post");
  if (!res.ok) {
    throw new TheearthClientError(`乗務員マスタ一覧の表示が HTTP ${res.status} を返しました`);
  }
  const nextHtml = await res.text();
  assertNotLoggedOut(nextHtml, "乗務員マスタ一覧の表示");
  return nextHtml;
}

/** ログイン画面が返っていたらセッション切れとして loud fail する。 */
function assertNotLoggedOut(html: string, what: string): void {
  if (hasLoginForm(html)) {
    throw new VenusSessionExpiredError(`${what}でログイン画面が返されました — theearth セッションが切れています`);
  }
}

/**
 * 乗務員マスタ (F-MMS0320) を全ページ収集する。
 *
 * 手順 (実ブラウザで確認、2026-09-02):
 * 1. GET — **この時点の一覧は空**。
 * 2. 「表示」ボタン (`ctl00$btnChange`) の postback で全事業所ぶんが出る。
 *    事業所 select (`ctl00$ddlSort`) は "0" (全事業所) のまま触らない。
 *    同じ POST に `ctl00$ddlRowCount` を載せて 1 ページの行数を上げる。
 * 3. `nextTarget` がある間ページ送りし、行を乗務員CD で重複排除しながら積む。
 *
 * **打ち切りは 3 通りとも「静かに減らさない」形にしてある**:
 * - 次ページが無い → 正常終了
 * - 新しい乗務員CD が 1 件も増えなかった → 同じページを読み直しているので終了
 * - `gCurrentPage` が前進しない / 上限ページに達した → **loud fail** (件数欠けを
 *   「そういうデータだった」と読ませないため)
 */
export async function fetchDriverMaster(
  jar: CookieJar,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<DriverMasterRow[]> {
  const url = `${BASE_URL}${DRIVER_MASTER_PATH}`;
  const getRes = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs, "driver_master_get");
  if (!getRes.ok) {
    throw new TheearthClientError(`乗務員マスタ一覧の取得が HTTP ${getRes.status} を返しました`);
  }
  const initialHtml = await getRes.text();
  assertNotLoggedOut(initialHtml, "乗務員マスタ一覧の取得");

  let html = await postDriverMasterForm(
    jar,
    url,
    initialHtml,
    {
      __EVENTTARGET: "",
      __EVENTARGUMENT: "",
      "ctl00$ddlRowCount": DRIVER_MASTER_ROW_COUNT,
      "ctl00$btnChange": "表示",
    },
    fetchImpl,
    timeoutMs,
  );

  const rows: DriverMasterRow[] = [];
  const seen = new Set<string>();
  let page = parseDriverMasterPage(html);
  for (let pageCount = 1; ; pageCount++) {
    let added = 0;
    for (const row of page.rows) {
      if (seen.has(row.driverCd)) continue;
      seen.add(row.driverCd);
      rows.push(row);
      added++;
    }
    if (added === 0 || !page.nextTarget) break;
    if (pageCount >= MAX_DRIVER_MASTER_PAGES) {
      throw new TheearthClientError(
        `乗務員マスタ一覧が上限 ${MAX_DRIVER_MASTER_PAGES} ページを超えました ` +
          `(page=${page.currentPage} rows=${rows.length}) — ページャの読み違いで回り続けている可能性があります`,
      );
    }
    const previousPage = page.currentPage;
    html = await postPagerLink(jar, url, html, page.nextTarget, fetchImpl, timeoutMs);
    page = parseDriverMasterPage(html);
    if (page.currentPage <= previousPage) {
      throw new TheearthClientError(
        `乗務員マスタ一覧のページ送りで gCurrentPage が前進しませんでした ` +
          `(${previousPage} → ${page.currentPage}) — 件数が静かに欠けるため中断します`,
      );
    }
  }
  return rows;
}

/** `PUT /api/employees/bulk-by-code` の応答 (rust-alc-api、Refs ippoan/alc-app-s3#125)。 */
export interface DriverMasterUpsertResult {
  /** 新規に作られた件数。読めなければ null。 */
  created: number | null;
  /** 更新された件数。読めなければ null。 */
  updated: number | null;
  /** 上流が受け取らなかった乗務員CD。**空でなければ呼び出し側が warn する。** */
  skipped: string[];
  /** 応答を数値として読めなかった理由 (読めたら null)。
   * **2xx で返ってきた以上、書き込み自体は通っている**ので job ごと失敗にはしない。
   * ただし「0 件だった」と同じ静かさにもしない — 呼び出し側が warn で名指しする。 */
  unreadable: string | null;
}

/** 上流の応答本文を `DriverMasterUpsertResult` に畳む (pure)。 */
export function parseDriverMasterUpsertResult(text: string): DriverMasterUpsertResult {
  const unreadable = (why: string): DriverMasterUpsertResult => ({
    created: null,
    updated: null,
    skipped: [],
    unreadable: `${why}: ${text.slice(0, 200)}`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable("応答が JSON として読めません");
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unreadable("応答が JSON オブジェクトではありません");
  }
  const body = parsed as { created?: unknown; updated?: unknown; skipped?: unknown };
  const count = (value: unknown): number | null => (typeof value === "number" ? value : null);
  return {
    created: count(body.created),
    updated: count(body.updated),
    skipped: Array.isArray(body.skipped) ? body.skipped.map((v) => String(v)) : [],
    unreadable: null,
  };
}
