/**
 * theearth-np.com の運行データ編集・再集計・日報取得クライアント (日報編集、Refs #169)。
 *
 * F-DES1010/1012/F-NRS1010/F-GOS0030 は WCF VenusBridge ではなく全て ASP.NET
 * WebForms の postback。cookie jar / login / hidden field 抽出は既存の
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
 * これらは「黙って200」を避けるため、期待した要素/文言が見つからない場合は必ず
 * TheearthClientError (または派生) を throw する設計にしてある。実運用で構造が
 * 違えば早期に loud fail するので、staging 実機確認で修正する。
 */
import {
  BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  downloadCsvZip,
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

// ---------------------------------------------------------------------------
// F-DES1012 [運行経費入力] — 給油行 (lstFuel)
// ---------------------------------------------------------------------------

/** save パス (`saveFuelRow`) 用の id ビルダ。実機の編集ボタンは
 * `__doPostBack('lstFuel$ctrl<N>$btnItemEdit')` で、この `lstFuel_<suffix>_<N>` 形式
 * とは異なる (**編集モードの実 id は cdp-pair 未確認。Refs #188 対象外**)。read パス
 * (表示 span) は実機準拠の `fuelLabelId` を使う。 */
function fuelRowId(ctrlIndex: number, suffix: string): string {
  return `lstFuel_${suffix}_${ctrlIndex}`;
}

/** read パス (表示専用 span) の実 id ビルダ。実機は `lstFuel_ctrl<N>_<suffix>` 形式
 * (cdp-pair 実機確認、Refs #188、2026-07-08、給油実データ有りの運行で確認)。
 * `MainContent_` prefix は無い。 */
function fuelLabelId(ctrlIndex: number, suffix: string): string {
  return `lstFuel_ctrl${ctrlIndex}_${suffix}`;
}

/** 表示専用行 (`lstFuel_ctrl<N>_lb*`) の span id サフィックス。実 DOM の綴りを
 * そのまま使う (theearth 原文は分類 "Suppuly" / 区分 "SuppulyKb" / 種別 "Shu" /
 * 数量 = 補給量 "HokyuRyou")。名称列 (`...Name`) が既に HTML に存在するため、
 * 別途 F-GSS0010 マスタを照会せずコード+名称を出せる (Refs #188)。 */
const FUEL_LABEL_IDS = {
  supplyCategory: "lblSuppuly",
  supplyCategoryName: "lblSuppulyName",
  supplyStation: "lblSuppulyKb",
  supplyStationName: "lblSuppulyKbName",
  supplyType: "lblShu",
  supplyTypeName: "lblShuName",
  dateTime: "lblDate",
  quantity: "lblHokyuRyou",
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

/** 給油行 1 件 (`lstFuel_ctrl<N>_*`)。分類/区分/種別は CD (コード) と名称の両方を
 * 持つ (名称列は実 DOM に既存、Refs #188)。表示行に `operationNo`/`subNo` の span は
 * 無いため保持しない (行の特定は URL の opeNo/startOpe と ctrlIndex で足りる)。 */
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

export interface ExpenseForm {
  opeNo: string;
  startOpe: string;
  fuelRows: FuelRow[];
}

function parseFuelRows(html: string): FuelRow[] {
  // 行 index は分類コード span (`lblSuppuly`、給油行なら必ず存在) で検出する。末尾の
  // `"` により `lblSuppulyName` / `lblSuppulyKb` への誤マッチを防ぐ。給油 0 件の運行は
  // ヒット 0 = 空配列 (呼び出し元が __VIEWSTATE 有無で構造崩れと切り分ける)。
  const indexes = [...html.matchAll(/id="lstFuel_ctrl(\d+)_lblSuppuly"/g)].map((m) => Number(m[1]));
  return indexes.map((ctrlIndex) => {
    const get = (idSuffix: string) => extractSpanTextById(html, fuelLabelId(ctrlIndex, idSuffix)) ?? "";
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
  return { opeNo, startOpe, fuelRows };
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
    throw new TheearthClientError(`POST が HTTP ${postRes.status} を返しました`);
  }
  const postHtml = await postRes.text();
  if (isLoginRedirect(postHtml)) {
    throw new VenusSessionExpiredError(
      "POST 後にログイン画面が返されました — theearth セッションが切れています",
    );
  }
  return postHtml;
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
  const fieldValues: Record<string, string> = {};
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

export interface RecalculateExpenseResult {
  /** 再集計成功後に「システム連動開始」ボタンが enable されたか
   * (SKILL.md: 再集計成功の副次確認シグナル)。 */
  linkSysEnabled: boolean;
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

  const button = findFormFieldById(html, "btnScore");
  if (!button) {
    throw new TheearthClientError(
      "評価点再集計ボタン (btnScore) が見つかりません — theearth-np のページ仕様変更の可能性があります",
    );
  }
  const postHtml = await postButton(jar, url, html, button.name, button.value || "評価点再集計", fetchImpl, timeoutMs);
  assertNoOtherEditConflict(postHtml, "評価点再集計");

  // 成功シグナルは「再集計が終了しました。」モーダル文言 (SKILL.md 実機確認済み)。
  // これが無ければ何が起きたか分からないまま成功扱いにしない。
  if (!postHtml.includes("再集計が終了しました")) {
    throw new TheearthClientError(
      "評価点再集計の完了メッセージ (「再集計が終了しました。」) が確認できませんでした — " +
        "theearth-np のページ仕様変更、または再集計が失敗した可能性があります",
    );
  }
  const linkSysTag = findTagById(postHtml, "btnLinkSys");
  const linkSysEnabled = !!linkSysTag && !/class=["'][^"']*aspNetDisabled/i.test(linkSysTag);
  return { linkSysEnabled };
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
    throw new TheearthClientError(`運行データ入力一覧の取得が HTTP ${getRes.status} を返しました`);
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
    throw new TheearthClientError(`表示条件指定ページの取得が HTTP ${res.status} を返しました`);
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
    throw new TheearthClientError(`表示条件指定ページの取得が HTTP ${res.status} を返しました`);
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
    throw new TheearthClientError(`運行データ入力一覧の取得が HTTP ${res.status} を返しました`);
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
      throw new TheearthClientError(`運転日報ページの取得が HTTP ${getRes.status} を返しました`);
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
