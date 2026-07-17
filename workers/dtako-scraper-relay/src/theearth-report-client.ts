/**
 * theearth-np.com の運行データ編集・再集計・日報取得クライアント (日報編集、Refs #169)。
 *
 * F-DES1010/1011/1012/1013/F-NRS1010/F-GOS0030 は WCF VenusBridge ではなく全て
 * ASP.NET WebForms の postback。cookie jar / login / hidden field 抽出は既存の
 * `./theearth-client` をそのまま再利用する (二重実装しない)。フィールド仕様・
 * ボタン名・DOM 構造の実機確認結果は `.claude/skills/theearth-venus/SKILL.md`
 * (「運行データ編集・再集計・連動・日報」節) に集約されている。
 *
 * **lstFuel (給油行) の DOM 構造は cdp-pair で実機確認済み** (Refs #183、2026-07-08、
 * 給油実データ有りの運行で確認)。旧実装は `MainContent_lstFuel_ctrl<i>_itxt<field>`
 * という id 形式・`btnExpenceEditSetting` という保存ボタンを仮定していたが、
 * どちらも実在せず (`MainContent_` prefix は無い、保存ボタンという名の要素も無い)、
 * 給油行が常に 0 件に見える/保存が必ず失敗するバグだった。実際の構造は
 * `fuelRowId`/`FUEL_LABEL_IDS`/`FUEL_EDIT_FIELD_IDS` の doc comment、および
 * `saveFuelRow` の doc comment を参照。
 *
 * **未検証部分について**: 以下は SKILL.md でも「実機で要確認」と明記されている、
 * または今回のドキュメント調査からの推測に留まる:
 * - F-NRS1010 ページャの `__doPostBack` target/argument の命名規則
 * - `saveFuelRow` の更新 postback 後の遷移先・viewstate 更新挙動 (更新ボタン自体の
 *   存在・field id は実機確認済みだが、保存成功時の成功シグナルは未確認)
 * - F-DES1013 (作業入力) の `btnUpdateButton` 応答の遷移先 (作業行を再描画するか。
 *   Refs #170、`saveWorkRowFromPage` は再描画されないケースを再 GET でカバーする)
 * - F-DES1011 (運行データ修正) は**最初の URL 直接 GET でだけ**運行データが
 *   ロードされる (2 回目以降の GET は初期値が空。staging 実機 2026-07-10 確認、
 *   Refs #171)。`saveDriverFromPage` は取得時ページの再利用が前提で、初期値が
 *   空のときは登録を拒否する設計
 * これらは「黙って200」を避けるため、期待した要素/文言が見つからない場合は必ず
 * TheearthClientError (または派生) を throw する設計にしてある。実運用で構造が
 * 違えば早期に loud fail するので、staging 実機確認で修正する。
 */
import {
  BASE_URL,
  decodeHtmlEntities,
  CSV_PATH,
  DEFAULT_EXPORT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  downloadCsvZip,
  ensureZip,
  extractHiddenFields,
  fetchWithJar,
  findFormFieldById,
  findTagById,
  postForm,
  serializeFormFields,
  TheearthClientError,
  type CookieJar,
  type CsvDateRange,
  type FetchLike,
  type ScrapeTimeouts,
} from "./theearth-client";
import { isLoginRedirect, VenusSessionExpiredError } from "./theearth-venus-client";

const DAILY_REPORT_PATH = "/F-DES1010[OperationEdit].aspx";
const DISPLAY_CONFIG_PATH = "/F-GOS0030[DataDisplayConfig].aspx";
const OPERATION_LIST_PATH = "/F-DES1010[OperationEdit].aspx";
const EXPENSE_EDIT_PATH = "/F-DES1012[OperationExpenseEdit].aspx";

/** パラメータ不正 (400 相当)。theearth 側エラーではなく呼び出し元の入力ミス。 */
export class ReportParamError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "ReportParamError";
  }
}

const OPE_NO_RE = /^\d{22}$/;
// 時は1桁のこともある (lblStartDateTime の実測値 "2026/07/07 1:03:16"、
// ゼロ埋めされない。cdp-pair 実機確認、Refs #169)。
const START_OPE_RE = /^\d{4}\/\d{2}\/\d{2} \d{1,2}:\d{2}:\d{2}$/;
const RANGE_BOUND_RE = /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/;

function validateOpeNo(opeNo: string): void {
  if (!OPE_NO_RE.test(opeNo)) {
    throw new ReportParamError(`運行No (OpeNo) は22桁の数値で指定してください: "${opeNo}"`);
  }
}

function validateStartOpe(startOpe: string): void {
  if (!START_OPE_RE.test(startOpe)) {
    throw new ReportParamError(
      `出庫日時 (StartOpe) は "YYYY/MM/DD H:mm:ss" 形式で指定してください: "${startOpe}"`,
    );
  }
}

/** F-DES1011/1012/1013 共通の URL 直接遷移形式。StartOpe の空白だけ `%20` に
 * 置換する (SKILL.md 実機確認: "2026/07/07 18:31:06" → "2026/07/07%2018:31:06")。
 * `encodeURIComponent` は `/` `:` も encode してしまい実機の形式と一致しなくなる
 * ため使わない。 */
function buildOperationExpenseUrl(opeNo: string, startOpe: string): string {
  const encodedStartOpe = startOpe.replace(/ /g, "%20");
  return `${BASE_URL}${EXPENSE_EDIT_PATH}?OpeNo=${opeNo}&StartOpe=${encodedStartOpe}`;
}

/** 「他ユーザー編集中のため処理を中止しました」(SKILL.md「排他ロック」節、実機確認
 * 済みの失敗メッセージ)。postback 応答が 200 でも実際には失敗しているケースを
 * 黙って成功扱いしない。 */
function assertNoOtherEditConflict(html: string, actionLabel: string): void {
  if (html.includes("他ユーザー編集中のため処理を中止しました")) {
    throw new TheearthClientError(
      `${actionLabel}が失敗しました: 他ユーザーが編集中のため処理を中止しました。時間をおいて再試行するか、` +
        "「編集制御解除」で残留ロックを解放してください",
    );
  }
}

/** GET が非 2xx を返した時に、ASP.NET エラーページの要約を log + メッセージに
 * 載せて throw する (postback 版の postButton と同じ調査手法、Refs #199)。
 * F-GOS0030 / F-DES1011 が再ログイン後も HTTP 500 を返し続ける事象 (staging
 * 2026-07-10) の真因を Tail Worker log から追えるようにする。 */
async function throwGetError(pageLabel: string, res: { status: number; text: () => Promise<string> }): Promise<never> {
  let detail = "";
  try {
    const rawBody = await res.text();
    detail = extractErrorSnippet(rawBody);
    const dump = rawBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
    console.error(`theearth GET failed: HTTP ${res.status} page=${pageLabel} body=${dump}`);
  } catch {
    // body が読めなくても HTTP status だけで throw する
  }
  throw new TheearthClientError(
    `${pageLabel}の取得が HTTP ${res.status} を返しました${detail ? ` — ${detail}` : ""}`,
  );
}

// ---------------------------------------------------------------------------
// F-DES1012 [運行経費入力] — 給油行 (lstFuel)
// ---------------------------------------------------------------------------

/** `lstFuel` grid の実 id ビルダ。表示行 span・編集ボタン・編集入力欄すべて
 * `lstFuel_<suffix>_<N>` 形式 (cdp-pair 実機確認、2026-07-08、`MainContent_` prefix
 * 無し)。read パス (表示 span) と save パス (btnEditButton / etxt) で共通。 */
function fuelRowId(ctrlIndex: number, suffix: string): string {
  return `lstFuel_${suffix}_${ctrlIndex}`;
}

/** 表示専用行 (`lstFuel_lbl<Field>_<N>`) の span id サフィックス。実 DOM の綴りを
 * そのまま使う (原文スペルミス "Quantuty")。名称列 (`lblSupply*Name`) が既に HTML に
 * 存在するため、別途 F-GSS0010 マスタを照会せずコード+名称を出せる。 */
const FUEL_LABEL_IDS = {
  supplyCategory: "lblSupplyCategory",
  supplyCategoryName: "lblSupplyCategoryName",
  supplyStation: "lblSupplyStation",
  supplyStationName: "lblSupplyStationName",
  supplyType: "lblSupplyType",
  supplyTypeName: "lblSupplyTypeName",
  dateTime: "lblDateTime",
  quantity: "lblQuantuty",
} as const;

/** 編集モードの入力欄 (`lstFuel_etxt<Field>_<N>`) の各フィールド id サフィックス。
 * `saveFuelRow` の更新 POST でのみ使う。 */
const FUEL_EDIT_FIELD_IDS = {
  supplyCategory: "etxtSupplyCategory",
  supplyStation: "etxtSupplyStation",
  supplyType: "etxtSupplyType",
  dateTime: "etxtDateTime",
  quantity: "etxtQuantuty",
} as const;

/** id が指定 id の `<span>` の中身 (タグ除去済みテキスト) を返す。 */
function extractSpanTextById(html: string, id: string): string | null {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<span\\b[^>]*\\bid=["']${escapedId}["'][^>]*>([\\s\\S]*?)</span>`, "i");
  const m = html.match(re);
  if (!m) return null;
  return m[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
}

/** 補給量を小数第 1 位表記に整える (例 "100" → "100.0"、"35.5" はそのまま)。数値
 * として解釈できない値 (空文字・非数値) はそのまま返す (0.0 を捏造しない)。 */
function formatQuantity(raw: string): string {
  if (raw.trim() === "") return raw;
  const n = Number(raw);
  return Number.isFinite(n) ? n.toFixed(1) : raw;
}

/** 給油行 1 件 (`lstFuel_<field>_<N>`)。分類/区分/種別は CD (コード) と名称の両方を
 * 持つ (名称列 `lblSupply*Name` は実 DOM に既存)。`operationNo`/`subNo` の span も
 * 実在するが frontend で未使用のため保持しない (行の特定は opeNo/startOpe+ctrlIndex)。 */
export interface FuelRow {
  ctrlIndex: number;
  supplyCategory: string;
  supplyCategoryName: string;
  supplyStation: string;
  supplyStationName: string;
  supplyType: string;
  supplyTypeName: string;
  dateTime: string;
  quantity: string;
}

/** F-DES1012 の給油マスタ (コード→名称)。theearth はページ末尾の
 * `ClientInit('', '', '<kubun>', ...)` 第 3 引数にマスタ全体を `KEY:code:name`
 * 形式 (項目区切り `,`、グループ区切り `/n` (リテラル)、`code=-1` は見出し行) で
 * 埋め込む。給油行 (`lstFuel`) を含む応答には必ず同梱される (cdp-pair 実機確認、
 * 2026-07-08: 運行ロード済み応答は lstFuel と ClientInit を常に同時に持ち、cold GET
 * はどちらも持たない)。名称解決は theearth の `FuelChange()` が `_Enum[KEY][code]` を
 * 引くのと同じで、F-GSS0010 マスタ検索画面は不要。
 *
 * 種別 (SupplyType) の参照先は分類コードで分岐する (`FuelChange` の switch と同一):
 * 分類 1/4 → FUELTYPE、2/5 → ADDITIVCLS、3 → CONSUMABLE。 */
export interface ExpenseMasters {
  /** 分類 (SUPPLYCTGRY): 1 主燃料 / 2 主添加剤 / 3 消耗品 / 4 副燃料 / 5 副添加剤 */
  supplyCategory: Record<string, string>;
  /** 区分 (PUTGASKB): 1 自社 / 2… (給油所、会社固有) */
  supplyStation: Record<string, string>;
  /** 種別 — 分類 1/4 (主燃料/副燃料) 用 (FUELTYPE): 1 軽油 / 2 ガソリン / … */
  fuelType: Record<string, string>;
  /** 種別 — 分類 2/5 (主添加剤/副添加剤) 用 (ADDITIVCLS): 0 なし / 1 Adblue */
  additive: Record<string, string>;
  /** 種別 — 分類 3 (消耗品) 用 (CONSUMABLE): 1 オイル */
  consumable: Record<string, string>;
}

export interface ExpenseForm {
  opeNo: string;
  startOpe: string;
  fuelRows: FuelRow[];
  masters: ExpenseMasters;
}

/** ClientInit の第 3 引数 (kubun マスタ文字列) を enum キー別 code→name に分解する。
 * ClientInit が無い応答 (給油 0 件・cold GET) では全マップ空を返す (frontend は取得時の
 * 初期名称ラベルにフォールバックする)。kubun は日本語名称のみでシングルクォートを
 * 含まない (実機確認) ため `'[^']*'` で安全に抜ける。 */
export function parseExpenseMasters(html: string): ExpenseMasters {
  const masters: ExpenseMasters = {
    supplyCategory: {},
    supplyStation: {},
    fuelType: {},
    additive: {},
    consumable: {},
  };
  const m = html.match(/ClientInit\('[^']*',\s*'[^']*',\s*'([^']*)'/);
  if (!m) return masters;
  const byKey: Record<string, keyof ExpenseMasters> = {
    SUPPLYCTGRY: "supplyCategory",
    PUTGASKB: "supplyStation",
    FUELTYPE: "fuelType",
    ADDITIVCLS: "additive",
    CONSUMABLE: "consumable",
  };
  // 項目区切りは `,` またはグループ区切り `/n` (改行ではなくリテラル 2 文字)。
  for (const item of m[1].split(/,|\/n/)) {
    const parts = item.split(":");
    if (parts.length < 3) continue;
    const target = byKey[parts[0]];
    if (!target) continue; // TOLLSETUKB / EXPENDSUBJ / FERRYCMPNY 等 給油に無関係なキーは無視
    const code = Number(parts[1]);
    if (!(code >= 0)) continue; // `-1` 見出し行・非数値コードを捨てる
    masters[target][String(code)] = parts.slice(2).join(":");
  }
  return masters;
}

function parseFuelRows(html: string): FuelRow[] {
  // 行 index は日時 span (`lblDateTime`、給油行なら必ず存在) で検出する。給油 0 件の
  // 運行はヒット 0 = 空配列 (呼び出し元が __VIEWSTATE 有無で構造崩れと切り分ける)。
  const indexes = [...html.matchAll(/id="lstFuel_lblDateTime_(\d+)"/g)].map((m) => Number(m[1]));
  return indexes.map((ctrlIndex) => {
    const get = (idSuffix: string) => extractSpanTextById(html, fuelRowId(ctrlIndex, idSuffix)) ?? "";
    return {
      ctrlIndex,
      supplyCategory: get(FUEL_LABEL_IDS.supplyCategory),
      supplyCategoryName: get(FUEL_LABEL_IDS.supplyCategoryName),
      supplyStation: get(FUEL_LABEL_IDS.supplyStation),
      supplyStationName: get(FUEL_LABEL_IDS.supplyStationName),
      supplyType: get(FUEL_LABEL_IDS.supplyType),
      supplyTypeName: get(FUEL_LABEL_IDS.supplyTypeName),
      dateTime: get(FUEL_LABEL_IDS.dateTime),
      quantity: formatQuantity(get(FUEL_LABEL_IDS.quantity)),
    };
  });
}

/** GET F-DES1012 — 給油行の現在値一覧を取得する (編集フォームの初期表示用)。 */
export async function getExpenseForm(
  jar: CookieJar,
  opeNo: string,
  startOpe: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<ExpenseForm> {
  validateOpeNo(opeNo);
  validateStartOpe(startOpe);
  const url = buildOperationExpenseUrl(opeNo, startOpe);
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`経費入力ページの取得が HTTP ${res.status} を返しました`);
  }
  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "経費入力ページがログイン画面を返しました — theearth セッションが切れています",
    );
  }
  const fuelRows = parseFuelRows(html);
  if (fuelRows.length === 0) {
    // 給油 0 件の運行は実運用上あり得るが、ページ構造自体が想定と違う場合も同じ
    // 「0件」に見えてしまうため、hidden field (__VIEWSTATE) の有無で「経費入力
    // ページとして読めているか」だけは切り分ける。
    const hidden = extractHiddenFields(html);
    if (!hidden.__VIEWSTATE) {
      throw new TheearthClientError(
        "経費入力ページの構造が想定と異なります (__VIEWSTATE が見つかりません) — " +
          "theearth-np のページ仕様変更の可能性があります",
      );
    }
  }
  return { opeNo, startOpe, fuelRows, masters: parseExpenseMasters(html) };
}

/** upstream (theearth) のエラー応答本文から診断用の 1 行要約を取り出す。ASP.NET の
 * エラーページは `<title>` に概要 (例 "Runtime Error") を持つのでそれを優先し、無ければ
 * 本文のタグを剥がして先頭を使う。長すぎる本文をそのまま log/UI に流さないよう 200 字で
 * 切る。値 (viewstate 等) を含み得るため機微だが、内部管理ツールの調査用途に限定する。 */
function extractErrorSnippet(body: string): string {
  const title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const text = (title ?? body).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/** hidden field のみを乗せた単純な postback を送る内部ヘルパ (ボタン 1 個押下相当)。
 * `buttonName`/`buttonValue` は呼び出し元が `findFormFieldById` で都度読み取った
 *実値を渡す。 */
async function postButton(
  jar: CookieJar,
  url: string,
  html: string,
  buttonName: string,
  buttonValue: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
  extra: Record<string, string> = {},
): Promise<string> {
  const hidden = extractHiddenFields(html);
  const body = new URLSearchParams({ ...hidden, ...extra, [buttonName]: buttonValue });
  const postRes = await postForm(jar, url, body, fetchImpl, timeoutMs);
  if (!postRes.ok) {
    // theearth の postback 500 は ASP.NET 例外 (yellow screen) の詳細を body に持つ。
    // 従来は本文を捨てていて原因が不明だったため、要約を log + エラーメッセージに載せて
    // 保存 500 の真因を追えるようにする (Refs #199、給油保存 500 の調査用)。
    const rawBody = await postRes.text();
    const detail = extractErrorSnippet(rawBody);
    // ASP.NET エラーページ本文をタグ除去して広めに (1200 字) log に出す。title だけ
    // だと「入力文字列の形式が正しくありません」までしか分からないが、本文には
    // 「例外の詳細 / ソース エラー / スタック トレース」があり、**theearth のどの
    // メソッドが parse に失敗したか** が分かる (= 真の原因フィールド特定)。エラー
    // ページ本文は viewstate を含まないので広めに出してよい (Refs #199)。
    const bodyDump = rawBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
    // 送信した非 hidden フィールド (etxt 値等) も log に出す。値は frontend 入力
    // 由来なので改行/制御文字を escape + 長さ制限して log injection を防ぐ。
    const sanitize = (s: string) =>
      s.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t").slice(0, 100);
    const sent = Object.entries(extra)
      .map(([k, v]) => `${k}=${sanitize(v)}`)
      .join(", ");
    console.error(
      `theearth postback failed: HTTP ${postRes.status} button=${buttonName}` +
        `${sent ? ` sent=[${sent}]` : ""} body=${bodyDump}`,
    );
    throw new TheearthClientError(
      `POST が HTTP ${postRes.status} を返しました${detail ? ` — ${detail}` : ""}`,
    );
  }
  const postHtml = await postRes.text();
  if (isLoginRedirect(postHtml)) {
    throw new VenusSessionExpiredError(
      "POST 後にログイン画面が返されました — theearth セッションが切れています",
    );
  }
  return postHtml;
}

/** 編集モード応答から `lstFuel` 系の全テキスト入力 (編集行 `etxt*` + 新規行 `itxt*`)
 * を name→現在値 で抽出する。theearth の更新 postback は編集行の etxtOperationNo /
 * etxtSubNo / etxtOldDateTime まで含む全フィールドを要求し、欠落すると code-behind の
 * `FuelCheck` が空を `int.Parse` して FormatException (HTTP 500) を返す (cdp-pair 実機
 * 確認、Refs #199)。値は数値・日時のみで HTML entity を含まないため raw のまま使う。 */
export function extractLstFuelTextInputs(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\btype=["']text["']/i.test(tag)) continue;
    const nameMatch = tag.match(/\bname=["']([^"']*)["']/i);
    if (!nameMatch || !nameMatch[1].startsWith("lstFuel")) continue;
    const valueMatch = tag.match(/\bvalue=["']([^"']*)["']/i);
    result[nameMatch[1]] = valueMatch ? valueMatch[1] : "";
  }
  return result;
}

export interface SaveFuelRowParams {
  opeNo: string;
  startOpe: string;
  ctrlIndex: number;
  supplyCategory: string;
  supplyStation: string;
  supplyType: string;
  dateTime: string;
  quantity: string;
}

export interface SaveFuelRowResult {
  fuelRows: FuelRow[];
}

/** POST 相当: 給油行 1 件を編集して保存する。**`btnExpenceEditSetting` という
 * ボタンは実在しない** (旧実装の誤り、cdp-pair 実機確認、Refs #183)。実際は 2 段階
 * postback:
 * 1. 対象行の `lstFuel_btnEditButton_<ctrlIndex>` を押す — 応答に編集用入力欄
 *    `lstFuel_etxt<Field>_<ctrlIndex>` と保存ボタン `lstFuel_btnUpdateButton_<ctrlIndex>`
 *    が現れる (押す前は存在しない)
 * 2. `lstFuel_etxt<Field>_<ctrlIndex>` を書き換えて `lstFuel_btnUpdateButton_<ctrlIndex>`
 *    を押す
 * `etxtDateTime` の実値は "26/07/07 10:29" 形式 (`maxlength="14"` の生数値ではなく
 * マスク入力後の表示形式、cdp-pair 実機確認)。呼び出し元はこの形式で `dateTime` を渡すこと。 */
export async function saveFuelRow(
  jar: CookieJar,
  params: SaveFuelRowParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<SaveFuelRowResult> {
  validateOpeNo(params.opeNo);
  validateStartOpe(params.startOpe);
  const url = buildOperationExpenseUrl(params.opeNo, params.startOpe);

  const getRes = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!getRes.ok) {
    throw new TheearthClientError(`経費入力ページの取得が HTTP ${getRes.status} を返しました`);
  }
  const html = await getRes.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "経費入力ページがログイン画面を返しました — theearth セッションが切れています",
    );
  }
  const rows = parseFuelRows(html);
  if (!rows.some((r) => r.ctrlIndex === params.ctrlIndex)) {
    throw new ReportParamError(`給油行 (ctrlIndex=${params.ctrlIndex}) が見つかりません`);
  }

  // Step 1: 編集ボタン postback で対象行を編集モードにする。
  const editButtonId = fuelRowId(params.ctrlIndex, "btnEditButton");
  const editButton = findFormFieldById(html, editButtonId);
  if (!editButton) {
    throw new TheearthClientError(
      `給油行の編集ボタン (${editButtonId}) が見つかりません — theearth-np のページ仕様変更の可能性があります`,
    );
  }
  const editHtml = await postButton(jar, url, html, editButton.name, editButton.value, fetchImpl, timeoutMs);
  assertNoOtherEditConflict(editHtml, "給油行の編集開始");

  // Step 2: 編集モードの入力欄 (etxt*) を書き換えて更新ボタンで保存する。
  const updateButtonId = fuelRowId(params.ctrlIndex, "btnUpdateButton");
  const updateButton = findFormFieldById(editHtml, updateButtonId);
  if (!updateButton) {
    throw new TheearthClientError(
      `給油行の更新ボタン (${updateButtonId}) が見つかりません — ` +
        "編集開始 postback が想定通りに動かなかった可能性があります (theearth-np のページ仕様変更の可能性)",
    );
  }
  const editedValues: Record<keyof typeof FUEL_EDIT_FIELD_IDS, string> = {
    supplyCategory: params.supplyCategory,
    supplyStation: params.supplyStation,
    supplyType: params.supplyType,
    dateTime: params.dateTime,
    quantity: params.quantity,
  };
  // theearth の更新 postback は編集行の **全 etxt フィールド** (etxtOperationNo /
  // etxtSubNo / etxtOldDateTime を含む) を要求する。5 フィールドしか送らないと
  // code-behind の `FuelCheck` が欠落フィールドを空のまま `int.Parse` して
  // FormatException (「入力文字列の形式が正しくありません」= HTTP 500) になる
  // (cdp-pair 実機確認、Refs #199)。編集モード応答の全 lstFuel テキスト入力を
  // 現在値でベースに送り、対象行の編集対象フィールドだけ params の新値で上書きする。
  const fieldValues = extractLstFuelTextInputs(editHtml);
  for (const [key, idSuffix] of Object.entries(FUEL_EDIT_FIELD_IDS) as [keyof typeof FUEL_EDIT_FIELD_IDS, string][]) {
    const ref = findFormFieldById(editHtml, fuelRowId(params.ctrlIndex, idSuffix));
    if (ref) fieldValues[ref.name] = editedValues[key];
  }
  const postHtml = await postButton(
    jar, url, editHtml, updateButton.name, updateButton.value, fetchImpl, timeoutMs, fieldValues,
  );
  assertNoOtherEditConflict(postHtml, "給油行の更新");
  return { fuelRows: parseFuelRows(postHtml) };
}

/** 新規行テンプレートのフィールド名を name パターンで解決する。lstFuel の
 * テンプレート行の name は `lstFuel$ctrl<N>$<field>` (lstWork と同型) と
 * `lstFuel$<field>` (index 無し) の両形式に耐性を持たせる (テンプレート行の
 * 実 name 形式は staging で確定させる。見つからなければ loud fail)。 */
function findFuelTemplateFieldName(html: string, field: string): string | null {
  const re = new RegExp(`^lstFuel(?:\\$ctrl\\d+)?\\$${field}$`);
  for (const m of html.matchAll(/<input\b([^>]*)>/gi)) {
    const nameMatch = m[1].match(/\bname=["']([^"']+)["']/i);
    if (nameMatch && re.test(nameMatch[1])) return nameMatch[1];
  }
  return null;
}

/** 新規給油行の入力フィールド (テンプレート行の itxt*)。原文スペルミス
 * "Quantuty" をそのまま使う。 */
const FUEL_NEW_FIELD_SUFFIXES = {
  supplyCategory: "itxtSupplyCategory",
  supplyStation: "itxtSupplyStation",
  supplyType: "itxtSupplyType",
  dateTime: "itxtDateTime",
  quantity: "itxtQuantuty",
} as const;

export interface AddFuelRowParams {
  opeNo: string;
  startOpe: string;
  supplyCategory: string;
  supplyStation: string;
  supplyType: string;
  /** "26/07/07 10:29" 形式 (etxtDateTime と同じマスク表示形式)。 */
  dateTime: string;
  quantity: string;
}

export interface AddFuelRowResult {
  fuelRows: FuelRow[];
  masters: ExpenseMasters;
}

/** POST 相当: 給油行を 1 件追加する (新規行テンプレートの `itxt*` に値を入れて
 * `btnInsertButton` postback。給油 0 件の運行でもテンプレート行は常駐するため
 * 追加できる)。postback body は hidden + lstFuel 系フィールドのみ
 * (`extractLstFuelTextInputs`、event validation 対策は saveWorkRowFromPage の
 * doc comment 参照)。 */
export async function addFuelRow(
  jar: CookieJar,
  params: AddFuelRowParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<AddFuelRowResult> {
  validateOpeNo(params.opeNo);
  validateStartOpe(params.startOpe);
  const url = buildOperationExpenseUrl(params.opeNo, params.startOpe);
  const pageHtml = await fetchEditPageHtml(jar, url, "経費入力ページ", fetchImpl, timeoutMs);

  const insertButtonName = findFuelTemplateFieldName(pageHtml, "btnInsertButton");
  if (!insertButtonName) {
    throw new TheearthClientError(
      "給油の新規行ボタン (btnInsertButton) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  const body = extractLstFuelTextInputs(pageHtml);
  for (const [key, suffix] of Object.entries(FUEL_NEW_FIELD_SUFFIXES) as [keyof typeof FUEL_NEW_FIELD_SUFFIXES, string][]) {
    const fieldName = findFuelTemplateFieldName(pageHtml, suffix);
    if (!fieldName) {
      throw new TheearthClientError(
        `給油の新規行フィールド (${suffix}) が見つかりません — theearth-np のページ仕様変更の可能性があります`,
      );
    }
    body[fieldName] = params[key];
  }

  const postHtml = await postButton(jar, url, pageHtml, insertButtonName, "", fetchImpl, timeoutMs, body);
  assertNoOtherEditConflict(postHtml, "給油行の追加");

  let fuelRows = parseFuelRows(postHtml);
  let mastersHtml = postHtml;
  if (fuelRows.length === 0) {
    // 追加後の応答が一覧を再描画しないケースに備えて再 GET で読み直す。
    const rereadHtml = await fetchEditPageHtml(jar, url, "経費入力ページ", fetchImpl, timeoutMs);
    fuelRows = parseFuelRows(rereadHtml);
    mastersHtml = rereadHtml;
    if (fuelRows.length === 0) {
      throw new TheearthClientError(
        "給油行の追加後も給油行を確認できませんでした — theearth 側で追加が受け付けられなかった可能性があります",
      );
    }
  }
  return { fuelRows, masters: parseExpenseMasters(mastersHtml) };
}

export interface DeleteFuelRowParams {
  opeNo: string;
  startOpe: string;
  ctrlIndex: number;
}

export interface DeleteFuelRowResult {
  fuelRows: FuelRow[];
}

/** POST 相当: 給油行 1 件を削除する (`lstFuel_btnDeleteButton_<ctrlIndex>` postback)。
 *
 * ボタン id は lstWork (F-DES1013) の行ボタン `btnDeleteButton_<N>` (cdp-pair 実機
 * 確定、SKILL.md「作業行 lstWork の実構造 (lstFuel と同型)」) からの同型推測で、
 * **lstFuel 側は実機未検証** (Refs #280)。実在しなければ loud fail する。
 *
 * postback は save/add と同じ同期 form POST (lstFuel は sync で insert が永続化する
 * 実績あり)。ただし F-DES1013 で「HTTP 200 でも DB に書かれない無音 no-op」の前例が
 * あるため、削除後は行数が 1 減ったことを必ず検証する: postback 応答で減っていなければ
 * 再 GET で読み直し、それでも減っていなければ throw する (黙って成功扱いしない)。 */
export async function deleteFuelRow(
  jar: CookieJar,
  params: DeleteFuelRowParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<DeleteFuelRowResult> {
  validateOpeNo(params.opeNo);
  validateStartOpe(params.startOpe);
  const url = buildOperationExpenseUrl(params.opeNo, params.startOpe);
  const pageHtml = await fetchEditPageHtml(jar, url, "経費入力ページ", fetchImpl, timeoutMs);

  const rowsBefore = parseFuelRows(pageHtml);
  if (!rowsBefore.some((r) => r.ctrlIndex === params.ctrlIndex)) {
    throw new ReportParamError(`給油行 (ctrlIndex=${params.ctrlIndex}) が見つかりません`);
  }

  const deleteButtonId = fuelRowId(params.ctrlIndex, "btnDeleteButton");
  const deleteButton = findFormFieldById(pageHtml, deleteButtonId);
  if (!deleteButton) {
    throw new TheearthClientError(
      `給油行の削除ボタン (${deleteButtonId}) が見つかりません — theearth-np のページ仕様変更、` +
        "または lstFuel には行削除ボタンが無い可能性があります",
    );
  }

  // body は add と同じく hidden + 全 lstFuel テキスト入力 (欠落フィールドを code-behind が
  // 空のまま int.Parse して 500 になる FuelCheck の前例 (Refs #199) を踏まないため)。
  const body = extractLstFuelTextInputs(pageHtml);
  const postHtml = await postButton(
    jar, url, pageHtml, deleteButton.name, deleteButton.value, fetchImpl, timeoutMs, body,
  );
  assertNoOtherEditConflict(postHtml, "給油行の削除");

  const expectedCount = rowsBefore.length - 1;
  let fuelRows = parseFuelRows(postHtml);
  if (fuelRows.length !== expectedCount) {
    // 削除応答が一覧を再描画しないケースに備えて再 GET で読み直す。
    const rereadHtml = await fetchEditPageHtml(jar, url, "経費入力ページ", fetchImpl, timeoutMs);
    fuelRows = parseFuelRows(rereadHtml);
    if (fuelRows.length !== expectedCount) {
      throw new TheearthClientError(
        `給油行の削除後も行数が減っていません (${rowsBefore.length}件のまま) — ` +
          "theearth 側で削除が受け付けられなかった可能性があります (無音 no-op、Refs #280)",
      );
    }
  }
  return { fuelRows };
}

export interface RecalculateExpenseResult {
  /** 再集計成功後に「システム連動開始」ボタンが enable されたか
   * (SKILL.md: 再集計成功の副次確認シグナル)。 */
  linkSysEnabled: boolean;
}

/** GET → HTTP ステータス / ログインリダイレクト検査、の共通ヘルパ (F-DES1011/
 * 1012/1013 の各編集ページで同一パターン)。 */
async function fetchEditPageHtml(
  jar: CookieJar,
  url: string,
  pageLabel: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!res.ok) {
    await throwGetError(pageLabel, res);
  }
  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      `${pageLabel}がログイン画面を返しました — theearth セッションが切れています`,
    );
  }
  return html;
}

// ---------------------------------------------------------------------------
// MS AJAX UpdatePanel 非同期 postback (Refs #170、cdp-pair 実機で生 XHR 捕獲 2026-07-10)
//
// F-DES1012/1013 のグリッド行編集ボタン (btnEditButton/btnUpdateButton/
// btnInsertButton 等) は UpdatePanel 内にあり、**同期 postback では更新コマンドが
// 一切発火しない** (HTTP 200・エラー無し・旧状態を再描画する無音 no-op になる)。
// 実ブラウザは XMLHttpRequest で以下を送っている:
//   - header: `X-MicrosoftAjax: Delta=true` / `X-Requested-With: XMLHttpRequest`
//   - body に `ScriptManager=<UpdatePanelUniqueID>|<targetUniqueID>` と `__ASYNCPOST=true`
// 応答は完全 HTML ではなく MS AJAX delta 形式 (`len|type|id|content|…`、hidden は
// `|hiddenField|NAME|VALUE|`)。この関数はその XHR を fetch で再現する。
// ---------------------------------------------------------------------------

/** delta 応答から hidden postback field (`|hiddenField|NAME|VALUE|`) を抽出する。 */
function parseDeltaHiddenFields(delta: string): Record<string, string> {
  const result: Record<string, string> = {};
  const re = /\|hiddenField\|([^|]+)\|([^|]*)\|/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(delta)) !== null) {
    result[m[1]] = decodeHtmlEntities(m[2]);
  }
  return result;
}

/** 指定 anchor id を含む `<div id="…UpdatePanel…">` の UniqueID を推定する。
 * MS AJAX の UpdatePanel は ClientID と UniqueID が (名前空間無しページでは) 一致
 * するため id 属性をそのまま UniqueID として使える。anchor より前に現れる最後の
 * UpdatePanel を「囲っている panel」とみなす (div のネストを正確に辿らない heuristic
 * だが F-DES1012/1013 は panel が 1〜2 個で十分特定できる、実機確認 2026-07-10)。 */
export function findEnclosingUpdatePanelId(html: string, anchorId: string): string | null {
  const anchorPos = html.indexOf(`id="${anchorId}"`);
  const search = anchorPos >= 0 ? html.slice(0, anchorPos) : html;
  const ids = [...search.matchAll(/id="([^"]*UpdatePanel[^"]*)"/gi)].map((m) => m[1]);
  if (ids.length > 0) return ids[ids.length - 1];
  // anchor より前に無ければ全体から最初の UpdatePanel を使う (fallback)
  const first = html.match(/id="([^"]*UpdatePanel[^"]*)"/i);
  return first ? first[1] : null;
}

/** MS AJAX UpdatePanel 非同期 postback を実行し delta 応答テキストを返す。
 * `bodyFields` は既に組み立て済みの postback body (hidden + フォーム値)。この関数が
 * `ScriptManager`/`__ASYNCPOST` を足し、AJAX ヘッダを付けて送る。 */
async function asyncPostback(
  jar: CookieJar,
  url: string,
  updatePanelId: string,
  targetName: string,
  bodyFields: Record<string, string>,
  pageLabel: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const body = new URLSearchParams(bodyFields);
  body.set("ScriptManager", `${updatePanelId}|${targetName}`);
  body.set("__ASYNCPOST", "true");
  // submitter (押下ボタン) を form collection に含める (実測どおり値は空)。呼び出し元が
  // 既に入れていれば残す。
  if (body.get(targetName) === null) body.set(targetName, "");
  const res = await fetchWithJar(
    jar,
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        "X-MicrosoftAjax": "Delta=true",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body.toString(),
    },
    fetchImpl,
    timeoutMs,
  );
  if (!res.ok) {
    await throwGetError(`${pageLabel}の非同期更新`, res);
  }
  const delta = await res.text();
  // 診断ログ (Refs ohishi-exp/nuxt-dtako-admin#224): Content-Length と実受信長が
  // 食い違えば「受信データが欠落している」ことの直接証拠になる。一時計測。
  const contentLengthHeader = res.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) !== delta.length) {
    console.error(
      `[asyncPostback diag] ${pageLabel} content-length mismatch: header=${contentLengthHeader} actualTextLen=${delta.length}`,
    );
  }
  // async 応答のセッション切れは `pageRedirect` delta (ログイン画面 URL) で返る。
  if (isLoginRedirect(delta) || /\|pageRedirect\|[^|]*F-OES1010/.test(delta)) {
    throw new VenusSessionExpiredError(
      `${pageLabel}の非同期更新でログイン画面が返されました — theearth セッションが切れています`,
    );
  }
  return delta;
}

/** postback body 用に**全フォームフィールド (disabled 含む) を直列化**する。
 * `serializeFormFields` (既存、disabled も含め全 input/select を拾う) を土台に、
 * **option が 0 件の `<select>` (`ddlCourse_*` 等、JS が options を埋める) だけ除去**
 * する — 空値を post すると ASP.NET の event validation が 500 で弾くため。
 *
 * MS AJAX の UpdatePanel 更新は実ブラウザが disabled フィールド (テンプレート行・
 * 運行ヘッダの検索欄) も含めて送っており、これらを省くと ItemUpdating がサーバー側で
 * 無音 no-op になる (cdp-pair 実機で確定、2026-07-10)。 */
function serializeAllFieldsSkippingEmptySelects(html: string): Record<string, string> {
  const fields = serializeFormFields(html);
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = m[1].match(/\bname=["']([^"']+)["']/i)?.[1];
    if (name && [...m[2].matchAll(/<option\b/gi)].length === 0) delete fields[name];
  }
  return fields;
}

/** `btnScore` postback の共通実装。F-DES1012 (評価点再集計) と F-DES1013
 * (作業時間再集計) は物理的に同一ボタンでラベルだけ違う (SKILL.md 実機確認)。 */
async function recalculateByScore(
  jar: CookieJar,
  url: string,
  pageLabel: string,
  actionLabel: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<RecalculateExpenseResult> {
  const html = await fetchEditPageHtml(jar, url, pageLabel, fetchImpl, timeoutMs);

  const button = findFormFieldById(html, "btnScore");
  if (!button) {
    throw new TheearthClientError(
      `${actionLabel}ボタン (btnScore) が見つかりません — theearth-np のページ仕様変更の可能性があります`,
    );
  }
  const postHtml = await postButton(jar, url, html, button.name, button.value || actionLabel, fetchImpl, timeoutMs);
  assertNoOtherEditConflict(postHtml, actionLabel);

  // 成功シグナルは「再集計が終了しました。」モーダル文言 (SKILL.md 実機確認済み)。
  // これが無ければ何が起きたか分からないまま成功扱いにしない。
  if (!postHtml.includes("再集計が終了しました")) {
    throw new TheearthClientError(
      `${actionLabel}の完了メッセージ (「再集計が終了しました。」) が確認できませんでした — ` +
        "theearth-np のページ仕様変更、または再集計が失敗した可能性があります",
    );
  }
  const linkSysTag = findTagById(postHtml, "btnLinkSys");
  const linkSysEnabled = !!linkSysTag && !/class=["'][^"']*aspNetDisabled/i.test(linkSysTag);
  return { linkSysEnabled };
}

/** POST 相当: `btnScore` postback で評価点を再集計する (F-DES1013 の「作業時間
 * 再集計」と物理的に同一ボタン、F-DES1012 では「評価点再集計」ラベル)。
 * `btnScore`/`btnLinkSys` に `MainContent_` prefix は無い (cdp-pair 実機確認、Refs #183)。 */
export async function recalculateExpense(
  jar: CookieJar,
  opeNo: string,
  startOpe: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<RecalculateExpenseResult> {
  validateOpeNo(opeNo);
  validateStartOpe(startOpe);
  const url = buildOperationExpenseUrl(opeNo, startOpe);
  return recalculateByScore(jar, url, "経費入力ページ", "評価点再集計", fetchImpl, timeoutMs);
}

export interface StartSystemLinkResult {
  /** 連動が成功したと判定できたか (成功シグナルは未確定のため保守的判定、Refs #199)。 */
  linked: boolean;
  /** 前提の再集計 (btnScore) 完了を確認できたか。 */
  recalcConfirmed: boolean;
  /** 再集計後に btnLinkSys が enable されたか。 */
  linkSysWasEnabled: boolean;
  /** 連動 postback 応答のタグ除去テキスト先頭 (成功シグナル観測用、UI 表示にも使う)。 */
  message: string;
}

/** システム連動開始 (btnLinkSys)。skill (theearth-venus) の順序依存に従い、まず
 * `btnScore` (再集計) → その応答で `btnLinkSys` が disabled→enabled になる → その
 * viewstate で `btnLinkSys` postback、の連鎖で実行する。**theearth 側にデータを連動
 * させる本番アクション**。連動完了の成功シグナルは skill 未記載のため、各段階の状態と
 * 応答本文を log に厚く出して実機で観測できるようにする (判定は後で確定、Refs #199)。 */
export async function startSystemLink(
  jar: CookieJar,
  opeNo: string,
  startOpe: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<StartSystemLinkResult> {
  validateOpeNo(opeNo);
  validateStartOpe(startOpe);
  const url = buildOperationExpenseUrl(opeNo, startOpe);
  console.log(`[link-sys] start opeNo=${opeNo} startOpe=${startOpe}`);

  // 1. GET (最新 viewstate 取得)
  const getRes = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  console.log(`[link-sys] GET status=${getRes.status}`);
  if (!getRes.ok) {
    throw new TheearthClientError(`経費入力ページの取得が HTTP ${getRes.status} を返しました`);
  }
  const html = await getRes.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "経費入力ページがログイン画面を返しました — theearth セッションが切れています",
    );
  }

  // 2. 再集計 (btnScore) — システム連動の前提 (順序依存、skill 確定)
  const scoreButton = findFormFieldById(html, "btnScore");
  if (!scoreButton) {
    throw new TheearthClientError("評価点再集計ボタン (btnScore) が見つかりません — 連動の前提が満たせません");
  }
  console.log(`[link-sys] POST btnScore name=${scoreButton.name}`);
  const recalcHtml = await postButton(
    jar, url, html, scoreButton.name, scoreButton.value || "評価点再集計", fetchImpl, timeoutMs,
  );
  assertNoOtherEditConflict(recalcHtml, "システム連動の前提となる再集計");
  const recalcConfirmed = recalcHtml.includes("再集計が終了しました");
  console.log(`[link-sys] recalc confirmed=${recalcConfirmed}`);
  if (!recalcConfirmed) {
    throw new TheearthClientError(
      "再集計の完了メッセージ (「再集計が終了しました。」) が確認できませんでした — システム連動の前提が満たせません",
    );
  }

  // 3. btnLinkSys が enable されたか (aspNetDisabled class の有無で判定、skill 確定)
  const linkSysTag = findTagById(recalcHtml, "btnLinkSys");
  if (!linkSysTag) {
    throw new TheearthClientError("システム連動開始ボタン (btnLinkSys) が見つかりません");
  }
  const linkSysWasEnabled = !/class=["'][^"']*aspNetDisabled/i.test(linkSysTag);
  console.log(`[link-sys] btnLinkSys enabled=${linkSysWasEnabled} tag=${linkSysTag.slice(0, 200)}`);
  if (!linkSysWasEnabled) {
    throw new TheearthClientError(
      "再集計後もシステム連動開始 (btnLinkSys) が有効になりませんでした — 連動できません",
    );
  }

  // 4. btnLinkSys postback (システム連動開始 = 本番アクション)。tag が取れた =
  // name も取れる (form ボタン) ので `!` で受ける。
  const linkButton = findFormFieldById(recalcHtml, "btnLinkSys")!;
  console.log(`[link-sys] POST btnLinkSys name=${linkButton.name} value=${linkButton.value}`);
  const linkHtml = await postButton(
    jar, url, recalcHtml, linkButton.name, linkButton.value || "システム連動開始", fetchImpl, timeoutMs,
  );
  assertNoOtherEditConflict(linkHtml, "システム連動開始");

  // 5. 成功判定: 連動完了の成功シグナルは skill 未記載のため、応答本文を log に
  // 厚く出して実機で確定する。暫定判定は「連動〜(開始|完了|終了)しました」文言の有無。
  const message = linkHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  const linked = /連動[^。<]{0,6}(開始|完了|終了)しました/.test(linkHtml);
  console.log(`[link-sys] done linked=${linked} message="${message}"`);
  return { linked, recalcConfirmed, linkSysWasEnabled, message };
}

// ---------------------------------------------------------------------------
// F-DES1010 [運行データ入力(一覧)] — 編集制御解除
// ---------------------------------------------------------------------------

export interface UnlockOperationParams {
  opeNo: string;
  startOpe: string;
}

/** POST 相当: 対象の運行 1 件だけの編集ロックを解除する。**`btnInitialize`
 * (編集制御解除) は「全ロック一括解放」ではない** (旧実装 `forceUnlockAll` の誤り、
 * cdp-pair 実機確認、2026-07-08)。実ブラウザでは F-DES1010 一覧の行クリック
 * (`RowsClick`) で `txtOperationNo`/`txtStartDateTime`/`txtIndex`/`txtCurrentID`
 * という hidden field に選択行の値をセットしてから `btnInitialize` を押すと、
 * **選択した行のロックだけ**が解除される (他行のロックは残る)。
 *
 * **対象行が一覧に現在表示されている必要は無い** (cdp-pair 実機確認、
 * 2026-07-08)。サーバ側の解除処理は `txtOperationNo`/`txtStartDateTime` の値
 * (= 対象を一意に特定する OpeNo/StartOpe) だけを見ており、`txtIndex`/
 * `txtCurrentID` は行ハイライトの復元用に過ぎない — 一覧のソート順・絞込条件・
 * ページ位置によって対象行が「現在の一覧上で見つからない」ことがあっても、
 * これらの hidden field に直接値を書いて送れば解除できる (実機で確認済み。
 * 旧実装は一覧をページ送りしながら対象行を探していたが、これは不要などころか
 * 「一覧に表示されていない (ソート順・絞込の都合)」場合に解除自体が不可能になる
 * 誤ったバグだった)。`txtIndex`/`txtCurrentID` はダミー値 (`"0"` / 1行目の
 * DOM id) を送っても解除は成功する。 */
export async function unlockOperation(
  jar: CookieJar,
  params: UnlockOperationParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<void> {
  validateOpeNo(params.opeNo);
  validateStartOpe(params.startOpe);
  const url = `${BASE_URL}${OPERATION_LIST_PATH}`;

  const getRes = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!getRes.ok) {
    await throwGetError("運行データ入力一覧", getRes);
  }
  const html = await getRes.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "運行データ入力一覧がログイン画面を返しました — theearth セッションが切れています",
    );
  }

  const button = findFormFieldById(html, "btnInitialize");
  if (!button) {
    throw new TheearthClientError(
      "編集制御解除ボタン (btnInitialize) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  const opNoField = findFormFieldById(html, "txtOperationNo");
  const startDtField = findFormFieldById(html, "txtStartDateTime");
  const indexField = findFormFieldById(html, "txtIndex");
  const currentIdField = findFormFieldById(html, "txtCurrentID");
  if (!opNoField || !startDtField || !indexField || !currentIdField) {
    throw new TheearthClientError(
      "行選択用の hidden field (txtOperationNo/txtStartDateTime/txtIndex/txtCurrentID) が" +
        "見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  const hidden = extractHiddenFields(html);
  const body = new URLSearchParams({
    ...hidden,
    [opNoField.name]: params.opeNo,
    [startDtField.name]: params.startOpe,
    [indexField.name]: "0",
    [currentIdField.name]: "MainContent_lstOperation_row_0",
    [button.name]: button.value || "編集制御解除",
  });
  const postRes = await postForm(jar, url, body, fetchImpl, timeoutMs);
  if (!postRes.ok) {
    throw new TheearthClientError(`編集制御解除 POST が HTTP ${postRes.status} を返しました`);
  }
  const postHtml = await postRes.text();
  if (isLoginRedirect(postHtml)) {
    throw new VenusSessionExpiredError(
      "編集制御解除後にログイン画面が返されました — theearth セッションが切れています",
    );
  }
}

// ---------------------------------------------------------------------------
// F-GOS0030 [表示条件指定] — ソート設定確認
// ---------------------------------------------------------------------------

/** id が指定 suffix で終わる `<select>` の selected option value を返す。
 * SKILL.md が `[id$=ddlOrder0]` という suffix セレクタで実機検証した経緯に合わせ、
 * id の完全形 (真の container 階層) を仮定しない。 */
function extractSelectedOptionValueBySuffix(html: string, idSuffix: string): string | null {
  const escaped = idSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selectRe = new RegExp(`<select\\b[^>]*\\bid=["'][^"']*${escaped}["'][^>]*>([\\s\\S]*?)</select>`, "i");
  const selectMatch = html.match(selectRe);
  if (!selectMatch) return null;
  const optionRe = /<option\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = optionRe.exec(selectMatch[1])) !== null) {
    if (/\bselected\b/i.test(m[1])) {
      const valueMatch = m[1].match(/\bvalue=["']([^"']*)["']/i);
      return valueMatch ? valueMatch[1] : null;
    }
  }
  return null;
}

/** id が指定 suffix で終わる radio `<input>` が checked か。 */
function isRadioCheckedBySuffix(html: string, idSuffix: string): boolean {
  const escaped = idSuffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<input\\b[^>]*\\bid=["'][^"']*${escaped}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  return !!tag && /\bchecked\b/i.test(tag);
}

/** F-GOS0030 の並び順設定が「読取日 (ReadNo) 降順」か確認する。日報グリッドの
 * 早期打ち切りハーベストの前提チェック (SKILL.md「表示条件指定」節)。 */
export async function verifyReadNoDescending(
  jar: CookieJar,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  const url = `${BASE_URL}${DISPLAY_CONFIG_PATH}`;
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!res.ok) {
    await throwGetError("表示条件指定ページ", res);
  }
  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "表示条件指定ページがログイン画面を返しました — theearth セッションが切れています",
    );
  }
  const orderSelected = extractSelectedOptionValueBySuffix(html, "ddlOrder0");
  const descChecked = isRadioCheckedBySuffix(html, "rdoDwOrder0");
  return orderSelected === "ReadNo" && descChecked;
}

export interface VehicleNarrowRange {
  /** 車輌CD 下限 (F-GOS0030 の `txtSVehicle`、8桁以内の数値)。 */
  from: string;
  /** 車輌CD 上限 (`txtEVehicle`)。単一車輌に絞る場合は from と同じ値を渡す。 */
  to: string;
}

const VEHICLE_CD_RE = /^\d{1,8}$/;

function validateVehicleCd(value: string, label: string): void {
  if (!VEHICLE_CD_RE.test(value)) {
    throw new ReportParamError(`車輌CD (${label}) は8桁以内の数値で指定してください: "${value}"`);
  }
}

async function fetchDisplayConfigHtml(
  jar: CookieJar,
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!res.ok) {
    await throwGetError("表示条件指定ページ", res);
  }
  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "表示条件指定ページがログイン画面を返しました — theearth セッションが切れています",
    );
  }
  return html;
}

/** F-DES1010 [運行データ入力(一覧)] を GET して full form HTML を返す (btnUpdate
 * postback 用)。 */
async function fetchOperationListHtml(
  jar: CookieJar,
  url: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!res.ok) {
    await throwGetError("運行データ入力一覧", res);
  }
  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "運行データ入力一覧がログイン画面を返しました — theearth セッションが切れています",
    );
  }
  return html;
}

/** F-GOS0030 の車輌絞込を `btnOK` (適用) postback で反映する。`lnkSaveCategory`
 * (絞込条件保存) では**一覧に反映されない** (実機確認、withVehicleNarrow の doc 参照)。 */
async function applyVehicleNarrowConfig(
  jar: CookieJar,
  url: string,
  baseline: Record<string, string>,
  fieldNames: { sName: string; eName: string },
  applyButton: { name: string; value: string },
  vehicleFrom: string,
  vehicleTo: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<void> {
  const body = new URLSearchParams({
    ...baseline,
    [fieldNames.sName]: vehicleFrom,
    [fieldNames.eName]: vehicleTo,
    [applyButton.name]: applyButton.value || "適用",
  });
  const res = await postForm(jar, url, body, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`表示条件指定 (車輌絞込) の適用が HTTP ${res.status} を返しました`);
  }
  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "表示条件指定 (車輌絞込) の適用後にログイン画面が返されました — theearth セッションが切れています",
    );
  }
}

/** F-DES1010 の `btnUpdate` (更新) を **full form** で postback し、絞込反映済みの
 * 1ページ目 HTML を返す。hidden だけの部分 POST だと `ddlRowCount` (表示件数) 等が
 * 既定値へ落ちる (実機で 30行→10行 に化けた) ため、必ず `serializeFormFields` で
 * ページ全体を直列化して送る。 */
async function postOperationListUpdate(
  jar: CookieJar,
  url: string,
  listHtml: string,
  updateButton: { name: string; value: string },
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const body = new URLSearchParams({
    ...serializeFormFields(listHtml),
    [updateButton.name]: updateButton.value || "更新",
  });
  const res = await postForm(jar, url, body, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`運行データ入力一覧の更新 (btnUpdate) が HTTP ${res.status} を返しました`);
  }
  const html = await res.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "運行データ入力一覧の更新後にログイン画面が返されました — theearth セッションが切れています",
    );
  }
  return html;
}

/**
 * F-GOS0030 の「車輌」絞込条件 (`txtSVehicle`/`txtEVehicle`、車輌CD 範囲) を
 * 一時的に適用して `fn` を実行し、**成功しても失敗しても必ず元の値へ書き戻す**。
 *
 * 実ブラウザの適用フロー (cdp-pair 実機確定、2026-07-08。これ以外の経路は**効かない**):
 *
 * 1. 親ページ F-DES1010 を開いた状態で F-GOS0030 (別窓) に車輌CD range を入力
 * 2. **`btnOK` (適用) postback** — 応答の startup script `Return(val)` が
 *    `window.opener.ReturnDisplayConfig(val)` を呼ぶ
 * 3. `ReturnDisplayConfig` は **親ページの `btnUpdate` (更新) を click** (J-DES1010
 *    実機取得済み) — この **full form の btnUpdate postback 応答で初めて一覧が
 *    絞り込まれる** (実測: 6572 指定で全行が車輌CD 6572 のみになった)
 *
 * ハマりどころ (どれも実機で「効かない」を確認済み):
 * - `lnkSaveCategory` (絞込条件保存) だけでは一覧に反映されない (保存のみ)
 * - `btnOK` 適用後でも **plain GET では反映されない** — btnUpdate postback が必須
 * - btnUpdate を hidden だけの部分 POST で送ると `ddlRowCount` 等が既定値に落ちる
 *   (30行→10行に化ける) — full form 直列化 (`serializeFormFields`) が必須
 *
 * この設定はアカウント単位で共有される (実際に複数の担当者 sakai/honda/k.kodama 等が
 * 同一アカウントを共有している実績が LicenceOverDialog で確認済み)。書き戻しを怠ると
 * 他の担当者が web地球号 の画面を直接使った時にも**黙って車輌が絞り込まれたまま**に
 * なるため、`fn` のエラーより書き戻し失敗の方を運用上深刻として主エラーで throw する
 * (`fn` のエラーがあれば付記)。btnUpdate が見つからない等の前提不成立は、共有設定を
 * 触る前 (適用 postback の前) に loud fail する。
 *
 * `fn` には絞込反映済みの 1ページ目 HTML を渡す (`harvestDailyReport` の
 * `initialHtml` にそのまま流し込む用)。
 */
export async function withVehicleNarrow<T>(
  jar: CookieJar,
  range: VehicleNarrowRange,
  fn: (jar: CookieJar, firstPageHtml: string) => Promise<T>,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  validateVehicleCd(range.from, "下限");
  validateVehicleCd(range.to, "上限");

  const listUrl = `${BASE_URL}${OPERATION_LIST_PATH}`;
  const configUrl = `${BASE_URL}${DISPLAY_CONFIG_PATH}`;

  // 実ブラウザ同様、親ページ (F-DES1010) の full form を先に確保する。btnUpdate が
  // 見つからない場合は共有設定 (F-GOS0030) を触る前にここで loud fail する。
  const listHtml = await fetchOperationListHtml(jar, listUrl, fetchImpl, timeoutMs);
  const updateButton = findFormFieldById(listHtml, "btnUpdate");
  if (!updateButton) {
    throw new TheearthClientError(
      "運行データ入力一覧の更新ボタン (btnUpdate) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }

  const configHtml = await fetchDisplayConfigHtml(jar, configUrl, fetchImpl, timeoutMs);
  const sField = findFormFieldById(configHtml, "txtSVehicle");
  const eField = findFormFieldById(configHtml, "txtEVehicle");
  if (!sField || !eField) {
    throw new TheearthClientError(
      "表示条件指定ページの車輌絞込フィールド (txtSVehicle/txtEVehicle) が見つかりません — " +
        "theearth-np のページ仕様変更の可能性があります",
    );
  }
  const applyButton = findFormFieldById(configHtml, "btnOK");
  if (!applyButton) {
    throw new TheearthClientError(
      "表示条件指定ページの適用ボタン (btnOK) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }

  const baseline = serializeFormFields(configHtml);
  const fieldNames = { sName: sField.name, eName: eField.name };
  const originalFrom = baseline[fieldNames.sName] ?? "";
  const originalTo = baseline[fieldNames.eName] ?? "";

  await applyVehicleNarrowConfig(
    jar, configUrl, baseline, fieldNames, applyButton, range.from, range.to, fetchImpl, timeoutMs,
  );

  let result: T | undefined;
  let fnFailed = false;
  let fnError: unknown;
  try {
    const firstPageHtml = await postOperationListUpdate(jar, listUrl, listHtml, updateButton, fetchImpl, timeoutMs);
    result = await fn(jar, firstPageHtml);
  } catch (err) {
    fnFailed = true;
    fnError = err;
  }

  try {
    await applyVehicleNarrowConfig(
      jar, configUrl, baseline, fieldNames, applyButton, originalFrom, originalTo, fetchImpl, timeoutMs,
    );
  } catch (restoreErr) {
    const restoreMessage = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
    const fnMessage = fnFailed ? (fnError instanceof Error ? fnError.message : String(fnError)) : null;
    throw new TheearthClientError(
      `車輌絞込 (F-GOS0030) を元 ("${originalFrom}"〜"${originalTo}") へ戻せませんでした: ${restoreMessage}` +
        (fnMessage ? ` (元の処理も失敗していました: ${fnMessage})` : "") +
        " — theearth の表示条件指定を手動で確認してください",
    );
  }

  if (fnFailed) throw fnError;
  return result as T;
}

// ---------------------------------------------------------------------------
// F-DES1010 [運行データ入力(一覧)] — 全ページ収集
//
// 日報編集の一覧はここを使う (F-NRS1010 ではない)。F-NRS1010 は「作業時間の
// 一括取得元」という別用途で、編集画面への導線 (OpeNo/StartOpe) を持たない。
// F-DES1010 は行ごとに OpeNo (lblOperationNo) + StartOpe (lblStartDateTime、
// 編集画面遷移にそのまま使える形) を持つ一覧で、cdp-pair での実機確認
// (2026-07-08、SKILL.md「F-DES1010 の実グリッド構造」節) で確定済み。
// ---------------------------------------------------------------------------

export interface DailyReportRow {
  /** 運行No (22桁、編集画面遷移の OpeNo)。 */
  operationNo: string;
  /** 編集画面遷移の StartOpe そのもの ("YYYY/MM/DD H:mm:ss"、時は1桁のことがある)。 */
  startDateTime: string;
  /** 排他ロック中か (`"1"`)。ロック中の行は他ユーザーが編集中で保存が失敗しうる。 */
  exclusionFlag: boolean;
  /** 運行日 ("YY/MM/DD"、2桁年)。 */
  operationDate: string | null;
  branchCd: string | null;
  branchName: string | null;
  vehicleCd: string | null;
  vehicleName: string | null;
  driverCd1: string | null;
  driverName1: string | null;
  workStartDateTime: string | null;
  /** 退社日時 (=読取日)。年補正済み "YYYY/MM/DD HH:mm" (ゼロ埋め、辞書順 = 時系列順)。 */
  workEndDateTime: string;
  operationStartDateTime: string | null;
  operationEndDateTime: string | null;
  totalRunningDist: string | null;
  /** 売上入力状況 ("未"/"済")。 */
  salesFlag: string | null;
  /** 経費入力状況 ("未"/"済")。 */
  expenseFlag: string | null;
}

function extractReportCell(html: string, field: string, row: number): string | null {
  const m = html.match(new RegExp(`id="MainContent_lstOperation_${field}_${row}"[^>]*>([\\s\\S]*?)</span>`));
  if (!m) return null;
  const v = m[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
  return v === "" ? null : v;
}

/** 退社日時 "MM/DD HH:mm" (年なし) を、同行の出庫日時 (年あり) を基準に年補正する
 * (SKILL.md「年跨ぎ補正」節: 退社月<出庫月なら+1年)。zero-pad 済みの
 * "YYYY/MM/DD HH:mm" は文字列比較がそのまま時系列比較になる。 */
function normalizeWorkEndDateTime(workEndRaw: string, startDateTimeFull: string): string {
  const m = workEndRaw.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  const startMatch = startDateTimeFull.match(/^(\d{4})\/(\d{1,2})\//);
  if (!m || !startMatch) {
    // パース不能な形式はそのまま返す (呼び出し側の単調性検証・範囲比較で弾かれる)。
    return workEndRaw;
  }
  const [, mm, dd, hh, min] = m;
  const startYear = Number(startMatch[1]);
  const startMonth = Number(startMatch[2]);
  const workMonth = Number(mm);
  const year = workMonth < startMonth ? startYear + 1 : startYear;
  return `${year}/${mm.padStart(2, "0")}/${dd.padStart(2, "0")} ${hh.padStart(2, "0")}:${min}`;
}

/** 行集合の中で最小の workEndDateTime ("YYYY/MM/DD HH:mm" はゼロ埋めなので
 * 文字列比較がそのまま時系列比較になる)。空なら null。 */
function minWorkEndDateTime(rows: DailyReportRow[]): string | null {
  return rows.reduce<string | null>(
    (min, r) => (min === null || r.workEndDateTime < min ? r.workEndDateTime : min),
    null,
  );
}

function parseDailyReportRows(html: string): DailyReportRow[] {
  const indexes = [...html.matchAll(/id="MainContent_lstOperation_lblOperationNo_(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
  return indexes.map((i) => {
    const startDateTime = extractReportCell(html, "lblStartDateTime", i) ?? "";
    const workEndRaw = extractReportCell(html, "lblWorkEndDateTime", i);
    return {
      operationNo: extractReportCell(html, "lblOperationNo", i) ?? "",
      startDateTime,
      exclusionFlag: extractReportCell(html, "lblExclusionFlag", i) === "1",
      operationDate: extractReportCell(html, "lblOperationDate", i),
      branchCd: extractReportCell(html, "lblBranchCD", i),
      branchName: extractReportCell(html, "lblDisplayName", i),
      vehicleCd: extractReportCell(html, "lblVehicleCD", i),
      vehicleName: extractReportCell(html, "lblVehicleName", i),
      driverCd1: extractReportCell(html, "lblDriverCD1", i),
      driverName1: extractReportCell(html, "lblDriverName1", i),
      workStartDateTime: extractReportCell(html, "lblWorkStartDateTime", i),
      workEndDateTime: workEndRaw ? normalizeWorkEndDateTime(workEndRaw, startDateTime) : "",
      operationStartDateTime: extractReportCell(html, "lblOperationStartDateTime", i),
      operationEndDateTime: extractReportCell(html, "lblOperationEndDateTime", i),
      totalRunningDist: extractReportCell(html, "lblTotalRunningDist", i),
      salesFlag: extractReportCell(html, "lblSalesFlag", i),
      expenseFlag: extractReportCell(html, "lblExpenseFlag", i),
    };
  });
}

interface PagerLink {
  target: string;
  argument: string;
  text: string;
}

/** ページャの `<a href="javascript:__doPostBack('T','A')">TEXT</a>` を全て
 * 抽出する。target/argument の命名規則 (数値引数か各リンク固有 target か) は
 * SKILL.md でも実データ未採取のため仮定せず、可視テキストで次ページを探す。 */
function extractPagerLinks(html: string): PagerLink[] {
  const links: PagerLink[] = [];
  const re = /<a\b[^>]*href="javascript:__doPostBack\('([^']*)'\s*,\s*'([^']*)'\)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const text = m[3].replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
    links.push({ target: m[1], argument: m[2], text });
  }
  return links;
}

function extractCurrentPageNumber(html: string): number | null {
  const m = html.match(/class="[^"]*\bgCurrentPage\b[^"]*"[^>]*>\s*(\d+)\s*</i);
  return m ? Number(m[1]) : null;
}

interface PagerSubmitButton {
  name: string;
  value: string;
}

/** ページャの「最初」「最後」だけは `<a href="__doPostBack">` ではなく通常の
 * ASP.NET Button (`<input type="submit" name=… value=…>`) (SKILL.md「F-DES1010
 * の実グリッド構造」節、cdp-pair 実機確認済み)。属性順序に依存しないよう `<input>`
 * タグ全体を走査し、`disabled` (1ページ目の「最初」等) なら null を返す。 */
function findPagerSubmitButton(html: string, label: string): PagerSubmitButton | null {
  const re = /<input\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (!/\btype="submit"/i.test(tag)) continue;
    const valueMatch = tag.match(/\bvalue="([^"]*)"/i);
    if (valueMatch?.[1] !== label) continue;
    if (/\bdisabled\b/i.test(tag)) return null;
    const nameMatch = tag.match(/\bname="([^"]*)"/i);
    return nameMatch ? { name: nameMatch[1], value: label } : null;
  }
  return null;
}

async function postPagerSubmitButton(
  jar: CookieJar,
  url: string,
  html: string,
  button: PagerSubmitButton,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const body = new URLSearchParams({ ...extractHiddenFields(html), [button.name]: button.value });
  const res = await postForm(jar, url, body, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`運行データ入力一覧のページ送りが HTTP ${res.status} を返しました`);
  }
  const nextHtml = await res.text();
  if (isLoginRedirect(nextHtml)) {
    throw new VenusSessionExpiredError(
      "運行データ入力一覧のページ送り中にログイン画面が返されました — theearth セッションが切れています",
    );
  }
  return nextHtml;
}

async function postPagerLink(
  jar: CookieJar,
  url: string,
  html: string,
  link: PagerLink,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const body = new URLSearchParams({
    ...extractHiddenFields(html),
    __EVENTTARGET: link.target,
    __EVENTARGUMENT: link.argument,
  });
  const res = await postForm(jar, url, body, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`運転日報のページ送りが HTTP ${res.status} を返しました`);
  }
  const nextHtml = await res.text();
  if (isLoginRedirect(nextHtml)) {
    throw new VenusSessionExpiredError(
      "運転日報のページ送り中にログイン画面が返されました — theearth セッションが切れています",
    );
  }
  return nextHtml;
}

export interface HarvestRange {
  /** 退社日時 (=読取日) の下限、"YYYY/MM/DD HH:mm" (含む)。 */
  from: string;
  /** 退社日時 (=読取日) の上限、"YYYY/MM/DD HH:mm" (含む)。 */
  to: string;
}

/** ページャ誤検出時に無限ループしないための安全弁。 */
const MAX_HARVEST_PAGES = 500;

/**
 * F-DES1010 [運行データ入力(一覧)] を全ページ収集する。退社日時 (=読取日) の
 * 降順を前提に `range.from` 未満に落ちた時点で早期打ち切りするが、途中で降順が
 * 崩れている (増加) のを検知したら早期打ち切りを無効化して最終ページまで走査する
 * (SKILL.md「早期打ち切りの前提」節、config を信じず実データで守る設計)。
 *
 * ページ送りは async (`X-MicrosoftAjax`/`__ASYNCPOST`) ヘッダを付けない**同期
 * postback** で行う。UpdatePanel は非同期送信時のみ部分レンダリングの差分応答
 * (MS AJAX delta 形式) を返す仕組みで、同期 postback なら常に完全な HTML が
 * 返る (`getVehicleLogTrack` の 2 段階 postback と同じ技法)。
 *
 * `initialHtml` を渡すと初回 GET を省略してそれを 1 ページ目として扱う。
 * 車輌絞込 (`withVehicleNarrow`) は **btnUpdate postback の応答にしか反映されず、
 * plain GET では絞込が消える** (cdp-pair 実機確認、2026-07-08) ため、絞込ハーベスト
 * では btnUpdate 応答をここへ流し込むことが必須。
 */
export async function harvestDailyReport(
  jar: CookieJar,
  range: HarvestRange,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  initialHtml?: string,
): Promise<DailyReportRow[]> {
  if (!RANGE_BOUND_RE.test(range.from) || !RANGE_BOUND_RE.test(range.to)) {
    throw new ReportParamError('期間は "YYYY/MM/DD HH:mm" 形式で指定してください');
  }

  const url = `${BASE_URL}${DAILY_REPORT_PATH}`;
  let html: string;
  if (initialHtml !== undefined) {
    html = initialHtml;
  } else {
    const getRes = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
    if (!getRes.ok) {
      await throwGetError("運転日報ページ", getRes);
    }
    html = await getRes.text();
    if (isLoginRedirect(html)) {
      throw new VenusSessionExpiredError(
        "運転日報ページがログイン画面を返しました — theearth セッションが切れています",
      );
    }
  }

  // 前回のページ位置が残っている可能性があるため、まず「最初」へ戻す
  // (SKILL.md「開始前に『最初』へ戻す」節)。「最初」ボタンは1ページ目では
  // disabled になり findPagerSubmitButton が null を返すので、その場合は
  // 既に1ページ目とみなしてスキップする。
  const firstButton = findPagerSubmitButton(html, "最初");
  if (firstButton) {
    html = await postPagerSubmitButton(jar, url, html, firstButton, fetchImpl, timeoutMs);
  }

  const rows: DailyReportRow[] = [];
  let monotonic = true;
  let prevWorkEnd: string | null = null;
  let currentPage = extractCurrentPageNumber(html) ?? 1;

  for (let pageCount = 0; pageCount < MAX_HARVEST_PAGES; pageCount++) {
    const pageRows = parseDailyReportRows(html);
    for (const row of pageRows) {
      if (prevWorkEnd !== null && row.workEndDateTime > prevWorkEnd) {
        monotonic = false;
      }
      prevWorkEnd = row.workEndDateTime;
    }
    rows.push(...pageRows);
    const minWorkEndOnPage = minWorkEndDateTime(pageRows);

    if (monotonic && minWorkEndOnPage !== null && minWorkEndOnPage < range.from) {
      break; // 降順が保たれている前提で from 未満に落ちたので打ち切ってよい
    }

    const links = extractPagerLinks(html);
    const nextText = String(currentPage + 1);
    let nextLink = links.find((l) => l.text === nextText);
    if (!nextLink) {
      const moreLink = links.find((l) => l.text === "...");
      if (moreLink) {
        html = await postPagerLink(jar, url, html, moreLink, fetchImpl, timeoutMs);
        currentPage = extractCurrentPageNumber(html) ?? currentPage;
        nextLink = extractPagerLinks(html).find((l) => l.text === nextText);
      }
    }
    if (!nextLink) {
      // 「次」リンクが無い = 最終ページに到達したとみなして打ち切る。
      // 注意: これはページャ構造の想定違いと区別できない (「本当に最終ページ」
      // と「regex が実際のマークアップに一致していない」を応答内容だけから
      // 判別する信頼できるシグナルが無いため)。row 数が想定より少なく見える等
      // 挙動がおかしい場合は staging 実機で pager markup を確認すること。
      break;
    }
    html = await postPagerLink(jar, url, html, nextLink, fetchImpl, timeoutMs);
    currentPage += 1;
  }

  return rows.filter((r) => r.workEndDateTime >= range.from && r.workEndDateTime <= range.to);
}

// ---------------------------------------------------------------------------
// F-NOS3010 [CSV出力] — 編集後の csvdata.zip
// ---------------------------------------------------------------------------

/** 編集後の csvdata.zip をダウンロードする。編集は theearth 側 DB に反映される
 * ため、既存の `downloadCsvZip` をそのまま再利用すれば編集後の値が入った zip が
 * 取れる (SKILL.md「編集 → 再集計 → zip DL」節)。 */
export async function downloadEditedZip(
  jar: CookieJar,
  range: CsvDateRange,
  fetchImpl: FetchLike = fetch,
  timeouts: ScrapeTimeouts = {},
): Promise<ArrayBuffer> {
  return downloadCsvZip(jar, range, fetchImpl, timeouts);
}

/** EOCD (`PK\x05\x06`) だけの空 ZIP か。F-NOS3010 は「該当データ 0 件」を
 * 22 バイトの空 ZIP (200) で返すため、マジックバイト検査 (`PK\x03\x04`) より
 * 先にこれを識別して原因の分かるメッセージで loud fail する。 */
function isEmptyZip(buf: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buf);
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x05 && bytes[3] === 0x06;
}

/**
 * 単一運行だけの csvdata.zip をダウンロードする (F-NOS3010 の「運行データ選択」
 * モード、cdp-pair 実機確認 2026-07-09、Refs #203)。
 *
 * 実ブラウザでは一覧の行クリック (`RowsClick`) → 「ダウンロード」だが、行クリックは
 * CSS 非表示の text input (`ucDataSelect$txtOperationNo` / `txtStartDateTime`) に
 * 値をセットするだけなので、**一覧の表示・ソート・ページ位置に関係なく** この
 * 2 フィールドへ直接値を書いて送ればよい (`unlockOperation` と同じパターン。
 * 別運行 2 件で実機確認済み)。複数運行はカンマ連結で送れる (`_Multi=1`) が、
 * この関数は単一運行のみ受け付ける。
 *
 * フローは日付範囲モード (`downloadCsvZip`) と同じ 2 段階 postback
 * (`btnCsvSvr` → 確認ページ → `btnCsvSvrOutput`)。**stage 2 には確認ページの
 * 全フォームフィールド (select 含む) を忠実に再送する必要がある** —
 * `ddlSystem` (連動出力形式) 等を落とすと該当 0 件扱いになり 22 バイトの
 * 空 ZIP が返る (実測。日付範囲モードの「stage 2 で日付欠落 → 空 ZIP」と同じ
 * 罠の選択モード版)。curated なフィールドリストではなく `serializeFormFields`
 * で丸ごと直列化する。
 */
export async function downloadOperationCsvZip(
  jar: CookieJar,
  params: UnlockOperationParams,
  fetchImpl: FetchLike = fetch,
  timeouts: ScrapeTimeouts = {},
): Promise<ArrayBuffer> {
  validateOpeNo(params.opeNo);
  validateStartOpe(params.startOpe);
  const requestTimeoutMs = timeouts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const exportTimeoutMs = timeouts.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const csvUrl = `${BASE_URL}${CSV_PATH}`;

  const getRes = await fetchWithJar(jar, csvUrl, { method: "GET" }, fetchImpl, requestTimeoutMs);
  const html = await getRes.text();
  if (isLoginRedirect(html)) {
    throw new VenusSessionExpiredError(
      "CSV ダウンロードページがログイン画面を返しました — theearth セッションが切れています",
    );
  }

  // フィールド名 (`ctl00$MainContent$...`) は実ページの id から都度解決する。
  const selectModeRadio = findFormFieldById(html, "rdoSelect0"); // 運行データ選択 (ページ既定)
  const opNoField = findFormFieldById(html, "txtOperationNo");
  const startDtField = findFormFieldById(html, "txtStartDateTime");
  const stage1Button = findFormFieldById(html, "btnCsvSvr");
  if (!selectModeRadio || !opNoField || !startDtField || !stage1Button) {
    throw new TheearthClientError(
      "CSV フォームの要素 (rdoSelect0/txtOperationNo/txtStartDateTime/btnCsvSvr) が見つかりません — " +
        "theearth-np のページ仕様が変更された可能性があります",
    );
  }

  const selection: Record<string, string> = {
    [selectModeRadio.name]: selectModeRadio.value,
    [opNoField.name]: params.opeNo,
    [startDtField.name]: params.startOpe,
  };

  const stage1Body = new URLSearchParams({
    ...serializeFormFields(html),
    ...selection,
    [stage1Button.name]: stage1Button.value || "ダウンロード",
  });
  const stage1Res = await postForm(jar, csvUrl, stage1Body, fetchImpl, requestTimeoutMs);
  const stage1ContentType = stage1Res.headers.get("content-type") ?? "";

  // 1段階目で直接 ZIP が返るケース (downloadCsvZip と同様、実装差異に備える)
  if (stage1ContentType.includes("application/octet-stream") || stage1ContentType.includes("zip")) {
    return ensureOperationZip(await stage1Res.arrayBuffer(), stage1ContentType, params.opeNo);
  }

  const stage1Html = await stage1Res.text();
  if (isLoginRedirect(stage1Html)) {
    throw new VenusSessionExpiredError(
      "CSV ダウンロードの確認ページがログイン画面を返しました — theearth セッションが切れています",
    );
  }
  const outputButton = findFormFieldById(stage1Html, "btnCsvSvrOutput");
  if (!outputButton) {
    throw new TheearthClientError(
      "CSV ダウンロードの2段階目ボタン (btnCsvSvrOutput) が見つかりません — " +
        "theearth-np のページ仕様が変更された可能性があります",
    );
  }
  // 確認ページは選択フィールドをエコーバックするが、欠落 = 空 ZIP の事故を防ぐ
  // ため選択フィールドはこちらの値で明示的に上書きする。
  const stage2Body = new URLSearchParams({
    ...serializeFormFields(stage1Html),
    ...selection,
    [outputButton.name]: outputButton.value || "ダウンロード",
  });
  const stage2Res = await postForm(jar, csvUrl, stage2Body, fetchImpl, exportTimeoutMs);
  const buf = await stage2Res.arrayBuffer();
  return ensureOperationZip(buf, stage2Res.headers.get("content-type") ?? "", params.opeNo);
}

/** 空 ZIP (該当 0 件) を明示メッセージで loud fail し、それ以外は ZIP マジックを検証する。 */
function ensureOperationZip(buf: ArrayBuffer, contentType: string, opeNo: string): ArrayBuffer {
  if (isEmptyZip(buf)) {
    throw new TheearthClientError(
      `運行 ${opeNo} の csvdata.zip が空 (該当 0 件) でした — 運行No/出庫日時の組み合わせが ` +
        "存在しないか、theearth-np のページ仕様変更でフォームフィールドが欠落した可能性があります",
    );
  }
  return ensureZip(buf, contentType);
}

// ---------------------------------------------------------------------------
// F-DES1013 [作業入力] — 作業行 (lstWork) 編集 + 作業時間再集計 (Refs #170)
//
// 実 DOM 構造 (cdp-pair 実機確認、2026-07-10。lstFuel と同型):
// - 表示行: `lstWork_lbl<Field>_<N>` の <span> + 行ごとの編集/削除/挿入ボタン
//   (`lstWork_btnEditButton_<N>` 等)
// - 編集モード: `btnEditButton` postback 後にだけ現れる `lstWork_etxt<Field>_<N>`
//   入力 + `lstWork_eddlEventName_<N>` (作業種別 select、202積み/203降し/204その他/
//   205待機/301休憩/302休息) + `btnUpdateButton`/`btnCancelButton`。
//   `etxtStartDateTime` は "YYYY/MM/DD HH:mm:ss" のフル形式 (表示 span の
//   "YY/MM/DD HH:mm" と違い秒まで持つ) — 編集フォームの初期値は必ず編集モード
//   応答から読むこと (表示 span から組み立てると秒が失われる)
// - 最下段に新規行テンプレート (`lstWork$ctrl<行数>$itxt*` / `iddlEventName`) が
//   常駐する (旧実装が「1 行だけの空フォーム」と誤認していたのはこれ)
// - **GET は編集ロックを取得する**。別セッションがロック中の運行への GET は
//   lstWork を一切含まない空ページ + CloseMsg「他のユーザーが前回の編集を完了
//   していないため、編集できません。…[編集制御解除]…」が返る (同一セッション
//   内の再 GET は通る)
// ---------------------------------------------------------------------------

const WORK_EDIT_PATH = "/F-DES1013[OperationWorkEdit].aspx";

function buildOperationWorkUrl(opeNo: string, startOpe: string): string {
  const encodedStartOpe = startOpe.replace(/ /g, "%20");
  return `${BASE_URL}${WORK_EDIT_PATH}?OpeNo=${opeNo}&StartOpe=${encodedStartOpe}`;
}

/** `lstWork` grid の実 id ビルダ (`lstWork_<suffix>_<N>`、cdp-pair 実機確認
 * 2026-07-10。`MainContent_` prefix は無い)。 */
function workRowId(ctrlIndex: number, suffix: string): string {
  return `lstWork_${suffix}_${ctrlIndex}`;
}

/** 表示専用行 (`lstWork_lbl<Field>_<N>`) の span id サフィックス。 */
const WORK_LABEL_IDS = {
  eventCd: "lblEventCD",
  eventName: "lblEventName",
  startDateTime: "lblStartDateTime",
  endDateTime: "lblEndDateTime",
  eventMin: "lblEventMin",
  driverType: "lblDriverType",
  startPlaceCd: "lblStartPlaceCD",
  startPlaceName: "lblStartPlaceName",
  startCityCd: "lblStartCityCD",
  startCityName: "lblStartCityName",
  endPlaceCd: "lblEndPlaceCD",
  endPlaceName: "lblEndPlaceName",
  endCityCd: "lblEndCityCD",
  endCityName: "lblEndCityName",
} as const;

/** 編集モード入力欄 (`lstWork_etxt<Field>_<N>`) の id サフィックス。作業種別は
 * select (`eddlEventName`) + 同期用 text (`etxtEventCD`) の 2 要素で別扱い。 */
const WORK_EDIT_FIELD_IDS = {
  startDateTime: "etxtStartDateTime",
  endDateTime: "etxtEndDateTime",
  driverType: "etxtDriverType",
  startPlaceCd: "etxtStartPlaceCD",
  startPlaceName: "etxtStartPlaceName",
  startCityCd: "etxtStartCityCD",
  startCityName: "etxtStartCityName",
  endPlaceCd: "etxtEndPlaceCD",
  endPlaceName: "etxtEndPlaceName",
  endCityCd: "etxtEndCityCD",
  endCityName: "etxtEndCityName",
} as const;

/** ロック中運行への GET 応答か (CloseMsg の実文言、cdp-pair 実機確認 2026-07-10)。
 * ロック中はページが空 (lstWork 無し) になるため、「作業 0 件」と誤認する前に
 * ここで loud fail する。 */
function assertWorkPageNotLocked(html: string): void {
  if (html.includes("編集を完了していないため、編集できません")) {
    throw new TheearthClientError(
      "この運行は編集ロック中のためデータを表示できません — 一覧の「編集制御解除」で" +
        "ロックを解放してから開き直してください",
    );
  }
}

export interface WorkEventOption {
  value: string;
  label: string;
}

/** id 指定で `<select>` の selected value と全 option を返す。selected 無しは
 * HTML 仕様どおり先頭 option (serializeFormFields と同じ規約)。 */
function parseSelectOptionsById(html: string, id: string): { value: string; options: WorkEventOption[] } | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<select\\b[^>]*\\bid=["']${escaped}["'][^>]*>([\\s\\S]*?)</select>`, "i");
  const m = html.match(re);
  if (!m) return null;
  const options: WorkEventOption[] = [];
  let selected: WorkEventOption | null = null;
  for (const om of m[1].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)) {
    const valueMatch = om[1].match(/\bvalue=["']([^"']*)["']/i);
    const option = {
      value: valueMatch ? valueMatch[1] : "",
      label: om[2].replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim(),
    };
    options.push(option);
    if (/\bselected\b/i.test(om[1])) selected = option;
  }
  return { value: (selected ?? options[0] ?? { value: "", label: "" }).value, options };
}

/** 指定 id の `<select>` から POST 用 name を抽出する (`findFormFieldById` は
 * `<input>` 専用のため select 用に別実装)。 */
function findSelectNameById(html: string, id: string): string | null {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = html.match(new RegExp(`<select\\b[^>]*\\bid=["']${escaped}["'][^>]*>`, "i"));
  return m ? (m[0].match(/\bname=["']([^"']+)["']/i)?.[1] ?? null) : null;
}

/** 作業種別マスタを新規行テンプレート (`iddlEventName`) または編集モード行
 * (`eddlEventName`) の select から抽出する。 */
function parseWorkEventOptions(html: string): WorkEventOption[] {
  const m = html.match(/\bid=["'](lstWork_(?:i|e)ddlEventName_\d+)["']/);
  if (!m) return [];
  return parseSelectOptionsById(html, m[1])?.options ?? [];
}

/** 作業行 1 件 (表示行の型付きビュー)。 */
export interface WorkRow {
  ctrlIndex: number;
  /** 作業種別 CD (`lblEventCD`、例 301) / 可視ラベル (`lblEventName`、例 休憩)。 */
  eventCd: string;
  eventName: string;
  /** 表示行の日時は "YY/MM/DD HH:mm" の短縮形式 (秒なし)。編集には
   * `startWorkRowEdit` が返すフル形式を使うこと。 */
  startDateTime: string;
  endDateTime: string;
  /** 作業時間 ("H:mm"、再集計で更新される表示値)。 */
  eventMin: string;
  driverType: string;
  startPlaceCd: string;
  startPlaceName: string;
  startCityCd: string;
  startCityName: string;
  endPlaceCd: string;
  endPlaceName: string;
  endCityCd: string;
  endCityName: string;
}

export interface WorkForm {
  opeNo: string;
  startOpe: string;
  workRows: WorkRow[];
  /** 作業種別 (EventName) の選択肢 (業務マスタ由来)。 */
  eventOptions: WorkEventOption[];
}


function parseWorkRows(html: string): WorkRow[] {
  const indexes = [...html.matchAll(/id="lstWork_lblEventCD_(\d+)"/g)].map((m) => Number(m[1]));
  return indexes.map((ctrlIndex) => {
    const get = (suffix: string) => extractSpanTextById(html, workRowId(ctrlIndex, suffix)) ?? "";
    return {
      ctrlIndex,
      eventCd: get(WORK_LABEL_IDS.eventCd),
      eventName: get(WORK_LABEL_IDS.eventName),
      startDateTime: get(WORK_LABEL_IDS.startDateTime),
      endDateTime: get(WORK_LABEL_IDS.endDateTime),
      eventMin: get(WORK_LABEL_IDS.eventMin),
      driverType: get(WORK_LABEL_IDS.driverType),
      startPlaceCd: get(WORK_LABEL_IDS.startPlaceCd),
      startPlaceName: get(WORK_LABEL_IDS.startPlaceName),
      startCityCd: get(WORK_LABEL_IDS.startCityCd),
      startCityName: get(WORK_LABEL_IDS.startCityName),
      endPlaceCd: get(WORK_LABEL_IDS.endPlaceCd),
      endPlaceName: get(WORK_LABEL_IDS.endPlaceName),
      endCityCd: get(WORK_LABEL_IDS.endCityCd),
      endCityName: get(WORK_LABEL_IDS.endCityName),
    };
  });
}

/** GET F-DES1013 — 作業行の現在値一覧を取得する (編集フォームの初期表示用)。 */
export async function getWorkForm(
  jar: CookieJar,
  opeNo: string,
  startOpe: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<WorkForm> {
  validateOpeNo(opeNo);
  validateStartOpe(startOpe);
  const url = buildOperationWorkUrl(opeNo, startOpe);
  const pageHtml = await fetchEditPageHtml(jar, url, "作業入力ページ", fetchImpl, timeoutMs);
  assertWorkPageNotLocked(pageHtml);
  const workRows = parseWorkRows(pageHtml);
  if (workRows.length === 0) {
    // 作業 0 件 (新規行テンプレートだけのページ) は実運用上あり得るが、ページ構造の
    // 想定違いと区別する (getExpenseForm の給油 0 件と同じ切り分け設計)。
    const hidden = extractHiddenFields(pageHtml);
    if (!hidden.__VIEWSTATE) {
      throw new TheearthClientError(
        "作業入力ページの構造が想定と異なります (__VIEWSTATE が見つかりません) — " +
          "theearth-np のページ仕様変更の可能性があります",
      );
    }
    if (/id="lstWork_lbl/.test(pageHtml)) {
      throw new TheearthClientError(
        "作業行の表示 span (lstWork_lbl*) は存在しますが行 index を検出できません — " +
          "theearth-np のページ仕様変更の可能性があります",
      );
    }
  }
  return { opeNo, startOpe, workRows, eventOptions: parseWorkEventOptions(pageHtml) };
}

export interface StartWorkRowEditParams {
  opeNo: string;
  startOpe: string;
  ctrlIndex: number;
}

/** 編集モード行の現在値 (編集フォームの初期値)。日時は "YYYY/MM/DD HH:mm:ss" の
 * フル形式 (表示 span と違い秒まで保持)。 */
export interface WorkEditFormRow {
  ctrlIndex: number;
  eventCd: string;
  eventOptions: WorkEventOption[];
  /** 行先 checkbox (`enchkDestination`)。 */
  destination: boolean;
  startDateTime: string;
  endDateTime: string;
  driverType: string;
  startPlaceCd: string;
  startPlaceName: string;
  startCityCd: string;
  startCityName: string;
  endPlaceCd: string;
  endPlaceName: string;
  endCityCd: string;
  endCityName: string;
}

/** 編集モードの delta に含まれる __VIEWSTATE 等の hidden を、初回 GET の hidden に
 * マージした「更新 postback 用の hidden セット」を作る。delta は変わった hidden
 * だけ返すので、GET 由来の hidden をベースに delta 由来で上書きする。 */
function mergeHidden(base: Record<string, string>, delta: string): Record<string, string> {
  return { ...base, ...parseDeltaHiddenFields(delta) };
}

/** POST 相当: 対象行の `btnEditButton` を **MS AJAX 非同期 postback** で押して編集
 * モードにし、編集モード行の現在値と、更新 postback に必要な情報 (編集モード delta・
 * GET 由来 hidden・UpdatePanel id) を返す。**呼び出し元 (DO) はこれを保存して
 * `saveWorkRowFromPage` に渡すこと** (実ブラウザの「鉛筆 → 修正 → 保存」と同じ流れ)。
 *
 * 同期 postback では更新コマンドが発火しないため async 必須 (cdp-pair 実機で確定、
 * 2026-07-10。`asyncPostback` の doc comment 参照)。 */
export async function startWorkRowEdit(
  jar: CookieJar,
  params: StartWorkRowEditParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<{ row: WorkEditFormRow; editHtml: string }> {
  validateOpeNo(params.opeNo);
  validateStartOpe(params.startOpe);
  const url = buildOperationWorkUrl(params.opeNo, params.startOpe);
  const pageHtml = await fetchEditPageHtml(jar, url, "作業入力ページ", fetchImpl, timeoutMs);
  assertWorkPageNotLocked(pageHtml);
  const rows = parseWorkRows(pageHtml);
  if (!rows.some((r) => r.ctrlIndex === params.ctrlIndex)) {
    throw new ReportParamError(`作業行 (ctrlIndex=${params.ctrlIndex}) が見つかりません`);
  }

  const editButtonId = workRowId(params.ctrlIndex, "btnEditButton");
  const editButton = findFormFieldById(pageHtml, editButtonId);
  if (!editButton) {
    throw new TheearthClientError(
      `作業行の編集ボタン (${editButtonId}) が見つかりません — theearth-np のページ仕様変更の可能性があります`,
    );
  }
  const panelId = findEnclosingUpdatePanelId(pageHtml, editButtonId);
  if (!panelId) {
    throw new TheearthClientError(
      "作業入力ページの UpdatePanel が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  // 編集開始も async postback (同期だと編集モードに入らない)。body は全フィールド。
  const editBody = serializeAllFieldsSkippingEmptySelects(pageHtml);
  editBody[editButton.name] = editButton.value;
  const editDelta = await asyncPostback(jar, url, panelId, editButton.name, editBody, "作業入力ページ", fetchImpl, timeoutMs);
  assertNoOtherEditConflict(editDelta, "作業行の編集開始");

  const updateButtonId = workRowId(params.ctrlIndex, "btnUpdateButton");
  if (!findFormFieldById(editDelta, updateButtonId)) {
    // 診断ログ (Refs ohishi-exp/nuxt-dtako-admin#224): 大規模運行 (作業行数が多い)
    // で受信データが欠落しているのか、送信データの問題かを切り分けるための一時計測。
    const foundUpdateButtonIndexes = [...editDelta.matchAll(/id="lstWork_btnUpdateButton_(\d+)"/g)].map((m) =>
      Number(m[1]),
    );
    console.error(
      `[work-edit-start diag] ctrlIndex=${params.ctrlIndex} pageHtmlLen=${pageHtml.length} rowsParsed=${rows.length} ` +
        `editDeltaLen=${editDelta.length} foundUpdateButtonIndexes=${JSON.stringify(foundUpdateButtonIndexes)} ` +
        `editDeltaTail=${JSON.stringify(editDelta.slice(-200))}`,
    );
    throw new TheearthClientError(
      `作業行の更新ボタン (${updateButtonId}) が見つかりません — ` +
        "編集開始 postback が想定通りに動かなかった可能性があります (theearth-np のページ仕様変更の可能性)",
    );
  }

  // 更新 postback に必要な情報を editHtml (JSON) に詰めて DO に持たせる。delta は
  // 完全 HTML ではないので、初回 GET の hidden を土台に delta hidden で上書きする。
  const baseHidden = extractHiddenFields(pageHtml);
  const editHtmlEnvelope = JSON.stringify({
    v: 2,
    panelId,
    hidden: mergeHidden(baseHidden, editDelta),
    delta: editDelta,
  });

  const get = (suffix: string) => findFormFieldById(editDelta, workRowId(params.ctrlIndex, suffix))?.value ?? "";
  const eventSelect = parseSelectOptionsById(editDelta, workRowId(params.ctrlIndex, "eddlEventName"));
  const destinationTag = findTagById(editDelta, workRowId(params.ctrlIndex, "enchkDestination"));
  const row: WorkEditFormRow = {
    ctrlIndex: params.ctrlIndex,
    eventCd: eventSelect?.value ?? get("etxtEventCD"),
    eventOptions: eventSelect?.options ?? [],
    destination: !!destinationTag && /\bchecked\b/i.test(destinationTag),
    startDateTime: get(WORK_EDIT_FIELD_IDS.startDateTime),
    endDateTime: get(WORK_EDIT_FIELD_IDS.endDateTime),
    driverType: get(WORK_EDIT_FIELD_IDS.driverType),
    startPlaceCd: get(WORK_EDIT_FIELD_IDS.startPlaceCd),
    startPlaceName: get(WORK_EDIT_FIELD_IDS.startPlaceName),
    startCityCd: get(WORK_EDIT_FIELD_IDS.startCityCd),
    startCityName: get(WORK_EDIT_FIELD_IDS.startCityName),
    endPlaceCd: get(WORK_EDIT_FIELD_IDS.endPlaceCd),
    endPlaceName: get(WORK_EDIT_FIELD_IDS.endPlaceName),
    endCityCd: get(WORK_EDIT_FIELD_IDS.endCityCd),
    endCityName: get(WORK_EDIT_FIELD_IDS.endCityName),
  };
  return { row, editHtml: editHtmlEnvelope };
}

/** 作業行 1 件分の保存内容。undefined のフィールドは編集モードの現在値のまま送る。 */
export interface SaveWorkRowParams {
  opeNo: string;
  startOpe: string;
  ctrlIndex: number;
  eventCd?: string;
  destination?: boolean;
  startDateTime?: string;
  endDateTime?: string;
  driverType?: string;
  startPlaceCd?: string;
  startPlaceName?: string;
  startCityCd?: string;
  startCityName?: string;
  endPlaceCd?: string;
  endPlaceName?: string;
  endCityCd?: string;
  endCityName?: string;
}

export interface SaveWorkRowResult {
  workRows: WorkRow[];
  eventOptions: WorkEventOption[];
}

interface WorkEditEnvelope {
  v: number;
  panelId: string;
  hidden: Record<string, string>;
  delta: string;
}

function parseWorkEditEnvelope(editHtml: string): WorkEditEnvelope {
  let env: unknown;
  try {
    env = JSON.parse(editHtml);
  } catch {
    throw new TheearthClientError("作業行の編集情報が壊れています — 行の「編集」からやり直してください");
  }
  const e = env as Partial<WorkEditEnvelope>;
  if (!e || e.v !== 2 || typeof e.panelId !== "string" || typeof e.delta !== "string" || typeof e.hidden !== "object") {
    throw new TheearthClientError("作業行の編集情報の形式が想定と異なります — 行の「編集」からやり直してください");
  }
  return e as WorkEditEnvelope;
}

/** POST 相当: 編集モード行の値を書き換えて `btnUpdateButton` を **MS AJAX 非同期
 * postback** で送り保存する。
 *
 * **`editHtml` には `startWorkRowEdit` が返した envelope (JSON) をそのまま渡すこと**
 * (呼び出し元 DO が storage に保持している)。実ブラウザの生 XHR を捕獲して確定した
 * 保存の要件 (cdp-pair 実機、2026-07-10):
 *
 * 1. **非同期 postback 必須** — 同期だと更新コマンドが無音 no-op (200・不発火)。
 * 2. **全フォームフィールド (disabled 含む) を送る** (`serializeAllFieldsSkippingEmptySelects`)。
 *    運行ヘッダ/テンプレート行 (disabled) を省くと ItemUpdating が確定しない。
 *    空 select (`ddlCourse_*`) だけは event validation 500 になるので除外。
 * 3. **作業種別は `eddlEventName` にだけ新値を入れ、`etxtEventCD` は元値のまま**にする。
 *    サーバーは両者の差分で変更を検知するため、両方新値にすると「変更なし」と
 *    判定され黙って無視される (これが「UI は OK だが DB 反映されない」の真因だった)。 */
export async function saveWorkRowFromPage(
  jar: CookieJar,
  editHtml: string,
  params: SaveWorkRowParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<SaveWorkRowResult> {
  validateOpeNo(params.opeNo);
  validateStartOpe(params.startOpe);
  const url = buildOperationWorkUrl(params.opeNo, params.startOpe);
  const env = parseWorkEditEnvelope(editHtml);
  const delta = env.delta;

  const updateButtonId = workRowId(params.ctrlIndex, "btnUpdateButton");
  const updateButton = findFormFieldById(delta, updateButtonId);
  if (!updateButton) {
    throw new TheearthClientError(
      `作業行の更新ボタン (${updateButtonId}) が見つかりません — 編集開始からやり直してください`,
    );
  }

  // 全フィールド (disabled 含む、空 select 除外) + 編集 delta の最新 hidden。
  const body = { ...serializeAllFieldsSkippingEmptySelects(delta), ...env.hidden };
  const setField = (suffix: string, value: string) => {
    const field = findFormFieldById(delta, workRowId(params.ctrlIndex, suffix));
    if (!field) {
      throw new TheearthClientError(
        `作業行 (ctrlIndex=${params.ctrlIndex}) の ${suffix} が見つかりません — ` +
          "theearth-np のページ仕様変更の可能性があります",
      );
    }
    body[field.name] = value;
  };
  for (const [key, suffix] of Object.entries(WORK_EDIT_FIELD_IDS) as [keyof typeof WORK_EDIT_FIELD_IDS, string][]) {
    const newValue = params[key];
    if (newValue !== undefined) setField(suffix, newValue);
  }
  if (params.eventCd !== undefined) {
    const selectName = findSelectNameById(delta, workRowId(params.ctrlIndex, "eddlEventName"));
    if (!selectName) {
      throw new TheearthClientError(
        `作業行 (ctrlIndex=${params.ctrlIndex}) の eddlEventName が見つかりません — ` +
          "theearth-np のページ仕様変更の可能性があります",
      );
    }
    // eddlEventName にだけ新値。etxtEventCD は元値のまま (変更検知の基準)。
    body[selectName] = params.eventCd;
  }
  if (params.destination !== undefined) {
    const checkbox = findFormFieldById(delta, workRowId(params.ctrlIndex, "enchkDestination"));
    if (checkbox) {
      if (params.destination) body[checkbox.name] = checkbox.value || "on";
      else delete body[checkbox.name];
    }
  }

  const updateDelta = await asyncPostback(
    jar, url, env.panelId, updateButton.name, body, "作業入力ページ", fetchImpl, timeoutMs,
  );
  assertNoOtherEditConflict(updateDelta, "作業行の更新");

  // 更新後は fresh GET で確定値を読み直す (delta は編集セッションの再描画で、DB
  // 反映確認には別セッションの GET が確実)。GET はロックを取り直すが、同一 jar なら
  // 直後の一覧表示までで解放される想定。
  const rereadHtml = await fetchEditPageHtml(jar, url, "作業入力ページ", fetchImpl, timeoutMs);
  assertWorkPageNotLocked(rereadHtml);
  return { workRows: parseWorkRows(rereadHtml), eventOptions: parseWorkEventOptions(rereadHtml) };
}

/** POST 相当: F-DES1013 の `btnScore` postback で作業時間を再集計する
 * (DriverState1〜5Min が更新される。F-DES1012 の評価点再集計と物理的に同一ボタン)。 */
export async function recalculateWork(
  jar: CookieJar,
  opeNo: string,
  startOpe: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<RecalculateExpenseResult> {
  validateOpeNo(opeNo);
  validateStartOpe(startOpe);
  const url = buildOperationWorkUrl(opeNo, startOpe);
  return recalculateByScore(jar, url, "作業入力ページ", "作業時間再集計", fetchImpl, timeoutMs);
}

// ---------------------------------------------------------------------------
// F-DES1011 [運行データ修正] — 乗務員変更 + 登録 (Refs #171)
// ---------------------------------------------------------------------------

const REVISE_EDIT_PATH = "/F-DES1011[OperationRevise].aspx";

function buildOperationReviseUrl(opeNo: string, startOpe: string): string {
  const encodedStartOpe = startOpe.replace(/ /g, "%20");
  return `${BASE_URL}${REVISE_EDIT_PATH}?OpeNo=${opeNo}&StartOpe=${encodedStartOpe}`;
}

/** F-DES1011 のフォームに初期値が入っているかの判定に使う代表フィールド。
 * SKILL.md (2026-07-08 実機確認) では「URL 直接 GET だと初期値が空。code-behind が
 * JS PageLoad (J-DES1011) で埋める設計」とあり、**値の入っていないフォームを
 * 丸ごと postback すると既存の運行データを空で上書きする恐れがある**。 */
const REVISE_FILLED_PROBE_IDS = ["txtVehicle", "txtBranch", "txtDist", "txtStartOdo", "txtEndOdo"];

function reviseFormLooksFilled(html: string): boolean {
  return REVISE_FILLED_PROBE_IDS.some((id) => (findFormFieldById(html, id)?.value ?? "") !== "");
}

export interface ReviseForm {
  opeNo: string;
  startOpe: string;
  /** 乗務員CD (txtDriver1) の現在値。 */
  driver1: string;
  /** 車両CD (txtVehicle) / 事業所CD (txtBranch)、表示用。 */
  vehicle: string;
  branch: string;
  /** フォームにサーバー描画の初期値が入っているか。false の場合
   * `saveDriverFromPage` は既存データを空で上書きしないよう登録を拒否する
   * (loud fail)。 */
  formFilled: boolean;
}

/** GET F-DES1011 — 乗務員CD 等の現在値と**取得時のページ HTML** を返す。
 *
 * ページ HTML を呼び出し元 (DO) が保存して `saveDriverFromPage` に渡す設計に
 * している。staging 実機 (2026-07-10) で「モーダルを開いた直後の GET は値が
 * 入っているのに、登録時にもう一度 GET すると初期値が空で返る」ことを確認した —
 * F-DES1011 の code-behind は最初の URL 直接 GET でだけ運行データをロードする
 * (排他ロック取得を伴うとみられる) ため、実ブラウザと同じく**最初に取得した
 * ページの viewstate からそのまま postback する**必要がある。 */
export async function getReviseFormPage(
  jar: CookieJar,
  opeNo: string,
  startOpe: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<{ form: ReviseForm; pageHtml: string }> {
  validateOpeNo(opeNo);
  validateStartOpe(startOpe);
  const url = buildOperationReviseUrl(opeNo, startOpe);
  const pageHtml = await fetchEditPageHtml(jar, url, "運行データ修正ページ", fetchImpl, timeoutMs);
  const driverField = findFormFieldById(pageHtml, "txtDriver1");
  if (!driverField) {
    throw new TheearthClientError(
      "乗務員CD フィールド (txtDriver1) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  return {
    form: {
      opeNo,
      startOpe,
      driver1: driverField.value,
      vehicle: findFormFieldById(pageHtml, "txtVehicle")?.value ?? "",
      branch: findFormFieldById(pageHtml, "txtBranch")?.value ?? "",
      formFilled: reviseFormLooksFilled(pageHtml),
    },
    pageHtml,
  };
}

/** GET F-DES1011 — 乗務員CD 等の現在値のみ (frontend 応答用の薄い wrapper)。 */
export async function getReviseForm(
  jar: CookieJar,
  opeNo: string,
  startOpe: string,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<ReviseForm> {
  const { form } = await getReviseFormPage(jar, opeNo, startOpe, fetchImpl, timeoutMs);
  return form;
}

const DRIVER_CD_RE = /^\d{1,8}$/;

export interface SaveDriverParams {
  opeNo: string;
  startOpe: string;
  /** 変更後の乗務員CD (8桁以内の数値、txtDriver1 の maxLength=8)。 */
  driver1: string;
}

export interface SaveDriverResult {
  /** 登録 postback 応答から読み直した乗務員CD (応答が同ページでない場合は null)。 */
  driver1After: string | null;
}

/** POST 相当: F-DES1011 の乗務員CD (`txtDriver1`) を変更して `btnReg` (登録)
 * postback で保存する。
 *
 * **`pageHtml` には `getReviseFormPage` が取得したページをそのまま渡すこと**
 * (呼び出し元 DO が storage に保持している)。登録時に fresh GET し直す設計は
 * 使えない — staging 実機 (2026-07-10、Refs #171) で「モーダルを開いた直後の
 * GET は値が入っているのに、登録直前にもう一度 GET すると初期値が空で返る」
 * ことを確認した。F-DES1011 の code-behind は最初の URL 直接 GET でだけ運行
 * データをロードするため、実ブラウザと同じく最初に取得したページの viewstate
 * からそのまま postback する。
 *
 * **フォームの初期値が空の場合は登録せず loud fail する** — 空フォームを
 * 丸ごと送ると既存の運行データを空で上書きする恐れがあるため (Refs #188 の
 * 「推測で送らない」教訓)。 */
export async function saveDriverFromPage(
  jar: CookieJar,
  pageHtml: string,
  params: SaveDriverParams,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<SaveDriverResult> {
  validateOpeNo(params.opeNo);
  validateStartOpe(params.startOpe);
  if (!DRIVER_CD_RE.test(params.driver1)) {
    throw new ReportParamError(`乗務員CD は8桁以内の数値で指定してください: "${params.driver1}"`);
  }
  const url = buildOperationReviseUrl(params.opeNo, params.startOpe);

  const driverField = findFormFieldById(pageHtml, "txtDriver1");
  if (!driverField) {
    throw new TheearthClientError(
      "乗務員CD フィールド (txtDriver1) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  const regButton = findFormFieldById(pageHtml, "btnReg");
  if (!regButton) {
    throw new TheearthClientError(
      "登録ボタン (btnReg) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  if (!reviseFormLooksFilled(pageHtml)) {
    throw new TheearthClientError(
      "運行データ修正フォームの初期値が空のため登録を中止しました (既存の運行データを空で" +
        "上書きしないための保護) — モーダルを開き直してからやり直してください",
    );
  }

  const body = { ...serializeFormFields(pageHtml), [driverField.name]: params.driver1 };
  const postHtml = await postButton(
    jar, url, pageHtml, regButton.name, regButton.value || "登録", fetchImpl, timeoutMs, body,
  );
  assertNoOtherEditConflict(postHtml, "乗務員の登録");

  const after = findFormFieldById(postHtml, "txtDriver1");
  if (after && after.value !== params.driver1) {
    // 応答が同ページの再描画で、かつ送った値になっていない = theearth 側で
    // 弾かれた可能性が高い (存在しない乗務員CD 等)。黙って成功扱いにしない。
    const snippet = postHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    throw new TheearthClientError(
      `乗務員CD の登録が反映されませんでした (応答値: "${after.value}") — ` +
        `theearth 側で拒否された可能性があります: ${snippet}`,
    );
  }
  return { driver1After: after ? after.value : null };
}
