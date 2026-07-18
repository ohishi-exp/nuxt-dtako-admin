/**
 * theearth-np.com F-VOS3020[VehicleComDataDownLoad] (3要素解析データダウンロード) の
 * ブラウザレス検索 + NET780 生データ zip 一括ダウンロード (Refs #302)。
 *
 * 実機確定知見 (2026-07-18、詳細は theearth-venus skill 参照):
 * - 表示条件 (F-GOS0030) の絞込適用は `Return(val)` → `window.opener.ReturnDisplayConfig(val)`
 *   → `{ if (val != undefined) { $('#btnUpdate').click(); } }`。F-VOS3020 側の
 *   反映ボタンは id="btnUpdate" (name: ctl00$MainContent$ucDataSelect$btnUpdate)、
 *   F-DES1010 の withVehicleNarrow と同じ「full form 確保→GOS0030差し替えbtnOK
 *   適用postback→元画面のbtnUpdate相当postback」の3段階フローが当てはまる。
 * - 行選択 (Ctrl+クリック複数選択) 時、txtOperationNo/txtStartDateTime/txtCurrentID は
 *   いずれもカンマ連結で蓄積される (実測確認: 2行選択で長さが単一値の2倍+1)。
 * - ダウンロード実行ボタンは見た目「ダウンロード」だが実体は
 *   MainContent_btnPreview (name: ctl00$MainContent$btnPreview)、単一 postback で
 *   完結する (F-NOS3010 のような2段階確認ページは無い)。
 * - ダウンロード postback は HTTP 503 の再現性が高い (原因未特定、単一選択・
 *   複数選択の両方で複数回再現)。呼び出し側 (DO) でリトライを検討すること。
 *
 * 未検証・簡略化した点 (次回改修候補):
 * - 一覧のページング全件収集 (F-DES1010 の harvestDailyReport のようなページャ
 *   walk) は未実装。`ddlRowCount` を最大 (30件) に設定して1ページ取得するのみ。
 *   30件を超える検索結果は取りこぼす。
 * - ダウンロード対象の行数上限 (`NET780_DOWNLOAD_MAX_ROWS`) は POST body 長の
 *   実質上限が未検証のため暫定値。
 */

import {
  BASE_URL,
  DEFAULT_EXPORT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  TheearthClientError,
  VenusSessionExpiredError,
  ensureZip,
  fetchWithJar,
  findFormFieldById,
  hasLoginForm,
  postForm,
  serializeFormFields,
  splitJapaneseDate,
  type CookieJar,
  type FetchLike,
  type FormFieldRef,
  type ScrapeTimeouts,
} from "./theearth-client";

export const NET780_LIST_PATH = "/F-VOS3020[VehicleComDataDownLoad].aspx";
export const NET780_CONFIG_PATH = "/F-GOS0030[DataDisplayConfig].aspx";

/** パラメータ不正 (呼び出し側で 400 にマップする)。 */
export class Net780ParamError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "Net780ParamError";
  }
}

export interface Net780SearchParams {
  /** 読取日 range ("YYYY-MM-DD"。from のみ指定可、to のみは不可)。F-GOS0030 の
   * 日付種別 select (`ddlSortDay1`) を "ReadNo"(読取日) に固定して絞り込む
   * (運行日ではない、Refs #299 — buildConfigOverrides 参照)。 */
  operationDateFrom?: string;
  operationDateTo?: string;
  /** 乗務員CD range (from のみ指定可、to のみは不可)。 */
  driverCdFrom?: string;
  driverCdTo?: string;
  /** 車輌CD range (from のみ指定可、to のみは不可)。 */
  vehicleCdFrom?: string;
  vehicleCdTo?: string;
}

const CD_RE = /^\d{1,8}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * from/to のペアを検証する。from のみの指定は許可する (to 側は空のまま
 * theearth に送られ、F-GOS0030 側で上限なしとして扱われる — buildConfigOverrides
 * 参照)。to のみの指定 (from 省略) は意味が曖昧なため不可とする。
 */
function validateRangePair(
  label: string,
  from: string | undefined,
  to: string | undefined,
  re: RegExp,
  formatHint: string,
): void {
  const hasFrom = from !== undefined && from !== "";
  const hasTo = to !== undefined && to !== "";
  if (hasTo && !hasFrom) {
    throw new Net780ParamError(`${label} は from を指定してください (to のみの指定はできません)`);
  }
  for (const [side, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (value && !re.test(value)) {
      throw new Net780ParamError(`${label}${side} は ${formatHint} で指定してください (受領値: ${value})`);
    }
  }
}

/** Net780SearchParams を検証する。少なくとも1つの絞込条件が必要
 * (無条件の全件検索は theearth 側・下流のダウンロード対象双方にとって危険なため不可)。 */
export function validateNet780SearchParams(params: Net780SearchParams): void {
  validateRangePair("operationDate", params.operationDateFrom, params.operationDateTo, ISO_DATE_RE, "YYYY-MM-DD");
  validateRangePair("driverCd", params.driverCdFrom, params.driverCdTo, CD_RE, "8桁以内の数値");
  validateRangePair("vehicleCd", params.vehicleCdFrom, params.vehicleCdTo, CD_RE, "8桁以内の数値");

  const hasAny = !!params.operationDateFrom || !!params.driverCdFrom || !!params.vehicleCdFrom;
  if (!hasAny) {
    throw new Net780ParamError(
      "読取日・乗務員CD・車輌CD のいずれか1つ以上を指定してください (無条件の全件検索はできません)",
    );
  }
}

export interface Net780Row {
  /** 運行No (22桁)。ダウンロード対象の指定にそのまま使う。 */
  operationNo: string;
  /** F-VOS3020 行選択の txtStartDateTime にそのまま使う値。 */
  startDateTime: string;
  operationDate: string | null;
  vehicleName: string | null;
  branchName: string | null;
  driverCd1: string | null;
  driverName1: string | null;
  driverName2: string | null;
  cityName: string | null;
}

function extractCell(html: string, field: string, row: number): string | null {
  const m = html.match(
    new RegExp(`id="MainContent_ucDataSelect_lstOperation_${field}_${row}"[^>]*>([\\s\\S]*?)</span>`),
  );
  if (!m) return null;
  const v = m[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").trim();
  return v === "" ? null : v;
}

/** 一覧 HTML から現ページの行を抽出する (ページング全件収集は未実装、1ページ分のみ)。 */
export function parseNet780Rows(html: string): Net780Row[] {
  const indexes = [...html.matchAll(/id="MainContent_ucDataSelect_lstOperation_lblOperationNo_(\d+)"/g)].map(
    (m) => Number(m[1]),
  );
  return indexes.map((i) => ({
    operationNo: extractCell(html, "lblOperationNo", i) ?? "",
    startDateTime: extractCell(html, "lblStartDateTime", i) ?? "",
    operationDate: extractCell(html, "lblOperationDate", i),
    vehicleName: extractCell(html, "lblVehicleName", i),
    branchName: extractCell(html, "lblDisplayName", i),
    driverCd1: extractCell(html, "lblDriverCD1", i),
    driverName1: extractCell(html, "lblDriverName1", i),
    driverName2: extractCell(html, "lblDriverName2", i),
    cityName: extractCell(html, "lblCityName", i),
  }));
}

async function fetchListHtml(jar: CookieJar, fetchImpl: FetchLike, timeoutMs: number): Promise<string> {
  const url = `${BASE_URL}${NET780_LIST_PATH}`;
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`3要素解析データダウンロード一覧の取得が HTTP ${res.status} を返しました`);
  }
  const html = await res.text();
  if (hasLoginForm(html)) {
    throw new VenusSessionExpiredError(
      "3要素解析データダウンロード一覧がログイン画面を返しました — theearth セッションが切れています",
    );
  }
  return html;
}

async function fetchConfigHtml(jar: CookieJar, fetchImpl: FetchLike, timeoutMs: number): Promise<string> {
  const url = `${BASE_URL}${NET780_CONFIG_PATH}`;
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`表示条件指定ページの取得が HTTP ${res.status} を返しました`);
  }
  const html = await res.text();
  if (hasLoginForm(html)) {
    throw new VenusSessionExpiredError(
      "表示条件指定ページがログイン画面を返しました — theearth セッションが切れています",
    );
  }
  return html;
}

const CONFIG_FIELD_IDS = [
  "txtSDriver",
  "txtEDriver",
  "txtSVehicle",
  "txtEVehicle",
  "ddlSortDay1",
  "ucStartDate1_txtYear",
  "ucStartDate1_txtMonth",
  "ucStartDate1_txtDay",
  "ucEndDate1_txtYear",
  "ucEndDate1_txtMonth",
  "ucEndDate1_txtDay",
  "btnOK",
] as const;
type ConfigFieldId = (typeof CONFIG_FIELD_IDS)[number];

function resolveConfigFields(html: string): Record<ConfigFieldId, FormFieldRef> {
  const refs = {} as Record<ConfigFieldId, FormFieldRef>;
  for (const id of CONFIG_FIELD_IDS) {
    const ref = findFormFieldById(html, id);
    if (!ref) {
      throw new TheearthClientError(
        `表示条件指定ページの要素 (id=${id}) が見つかりません — theearth-np のページ仕様が変更された可能性があります`,
      );
    }
    refs[id] = ref;
  }
  return refs;
}

/** F-GOS0030 の年入力は西暦2桁 (実機確認: "26" = 2026)。和暦企業への対応は未検証。 */
function dateFieldValues(iso: string | undefined): { y: string; m: string; d: string } {
  if (!iso) return { y: "", m: "", d: "" };
  return splitJapaneseDate(iso, false);
}

/** F-GOS0030 の日付種別 select (`ddlSortDay1`) の値。実機確定オプション:
 * `OperationDate`(運行日) / `ReadNo`(読取日) / `OperationStartDateTime`(出庫日) /
 * `OperationEndDateTime`(帰庫日) (theearth-venus skill 参照)。NET780 の検索は
 * 読取日 (=退社日時、データが確定した日) 基準で絞り込む方針 (Refs #299)。 */
const DATE_FILTER_TYPE_READ_NO = "ReadNo";

function buildConfigOverrides(
  refs: Record<ConfigFieldId, FormFieldRef>,
  params: Net780SearchParams,
): Record<string, string> {
  const from = dateFieldValues(params.operationDateFrom);
  const to = dateFieldValues(params.operationDateTo);
  return {
    [refs.txtSDriver.name]: params.driverCdFrom ?? "",
    [refs.txtEDriver.name]: params.driverCdTo ?? "",
    [refs.txtSVehicle.name]: params.vehicleCdFrom ?? "",
    [refs.txtEVehicle.name]: params.vehicleCdTo ?? "",
    [refs.ddlSortDay1.name]: DATE_FILTER_TYPE_READ_NO,
    [refs.ucStartDate1_txtYear.name]: from.y,
    [refs.ucStartDate1_txtMonth.name]: from.m,
    [refs.ucStartDate1_txtDay.name]: from.d,
    [refs.ucEndDate1_txtYear.name]: to.y,
    [refs.ucEndDate1_txtMonth.name]: to.m,
    [refs.ucEndDate1_txtDay.name]: to.d,
  };
}

/** F-GOS0030 の絞込を `btnOK` (適用) postback で反映する。`lnkSaveCategory`
 * (絞込条件保存) では一覧に反映されない (F-DES1010 と同じ罠、theearth-venus skill 参照)。 */
async function applyConfig(
  jar: CookieJar,
  configHtml: string,
  refs: Record<ConfigFieldId, FormFieldRef>,
  overrides: Record<string, string>,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<void> {
  const url = `${BASE_URL}${NET780_CONFIG_PATH}`;
  const body = new URLSearchParams({
    ...serializeFormFields(configHtml),
    ...overrides,
    [refs.btnOK.name]: refs.btnOK.value || "適用",
  });
  const res = await postForm(jar, url, body, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`表示条件指定 (絞込) の適用が HTTP ${res.status} を返しました`);
  }
  const html = await res.text();
  if (hasLoginForm(html)) {
    throw new VenusSessionExpiredError(
      "表示条件指定 (絞込) の適用後にログイン画面が返されました — theearth セッションが切れています",
    );
  }
}

/** `<select id="...">` の POST 用 name を抽出する。`findFormFieldById` は
 * `<input>` タグしか見ないため select には使えず、別途これが必要。 */
function findSelectNameById(html: string, id: string): string | null {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<select\\b[^>]*\\bid=["']${escapedId}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const nameMatch = tag.match(/\bname=["']([^"']+)["']/i);
  return nameMatch ? nameMatch[1] : null;
}

/** 1ページあたりの表示件数を最大 (30件) に設定してから一覧を取り直す。件数
 * select が見つからない場合は既定件数のまま緩やかに続行する (検索自体を
 * 止めるほどの問題ではないため loud fail にしない)。 */
async function applyMaxRowCount(
  jar: CookieJar,
  listHtml: string,
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<string> {
  const ddlName = findSelectNameById(listHtml, "MainContent_ucDataSelect_ddlRowCount");
  const btn = findFormFieldById(listHtml, "MainContent_ucDataSelect_btnRowCount");
  if (!ddlName || !btn) return listHtml;

  const url = `${BASE_URL}${NET780_LIST_PATH}`;
  const body = new URLSearchParams({
    ...serializeFormFields(listHtml),
    [ddlName]: "30",
    [btn.name]: btn.value || "表示",
  });
  const res = await postForm(jar, url, body, fetchImpl, timeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(`一覧の表示件数変更が HTTP ${res.status} を返しました`);
  }
  const html = await res.text();
  if (hasLoginForm(html)) {
    throw new VenusSessionExpiredError(
      "一覧の表示件数変更後にログイン画面が返されました — theearth セッションが切れています",
    );
  }
  return html;
}

/**
 * F-GOS0030 で絞込を適用し、F-VOS3020 の一覧 (最大30件、ページング全件収集は
 * 未実装) を取得する。絞込は関数終了時に**必ず元の値へ復元する** (この設定は
 * theearth アカウント単位で共有されるため、他の担当者の画面に影響を残さない
 * 設計。theearth-report-client.ts の withVehicleNarrow と同じ考え方)。
 */
export async function searchNet780(
  jar: CookieJar,
  params: Net780SearchParams,
  fetchImpl: FetchLike = fetch,
  timeouts: ScrapeTimeouts = {},
): Promise<Net780Row[]> {
  validateNet780SearchParams(params);
  const timeoutMs = timeouts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const listHtml = await fetchListHtml(jar, fetchImpl, timeoutMs);
  const updateButton = findFormFieldById(listHtml, "btnUpdate");
  if (!updateButton) {
    throw new TheearthClientError(
      "3要素解析データダウンロード一覧の更新ボタン (btnUpdate) が見つかりません — " +
        "theearth-np のページ仕様変更の可能性があります",
    );
  }

  const configHtml = await fetchConfigHtml(jar, fetchImpl, timeoutMs);
  const refs = resolveConfigFields(configHtml);
  const baseline = serializeFormFields(configHtml);
  const originalValues: Record<string, string> = {};
  for (const id of CONFIG_FIELD_IDS) {
    if (id === "btnOK") continue;
    originalValues[refs[id].name] = baseline[refs[id].name] ?? "";
  }

  await applyConfig(jar, configHtml, refs, buildConfigOverrides(refs, params), fetchImpl, timeoutMs);

  let rows: Net780Row[] = [];
  let searchFailed = false;
  let searchError: unknown;
  try {
    const listUrl = `${BASE_URL}${NET780_LIST_PATH}`;
    const updateBody = new URLSearchParams({
      ...serializeFormFields(listHtml),
      [updateButton.name]: updateButton.value || "更新",
    });
    const updateRes = await postForm(jar, listUrl, updateBody, fetchImpl, timeoutMs);
    if (!updateRes.ok) {
      throw new TheearthClientError(`3要素解析データダウンロード一覧の更新が HTTP ${updateRes.status} を返しました`);
    }
    const updatedHtml = await updateRes.text();
    if (hasLoginForm(updatedHtml)) {
      throw new VenusSessionExpiredError(
        "3要素解析データダウンロード一覧の更新後にログイン画面が返されました — theearth セッションが切れています",
      );
    }
    const wideHtml = await applyMaxRowCount(jar, updatedHtml, fetchImpl, timeoutMs);
    rows = parseNet780Rows(wideHtml);
  } catch (err) {
    searchFailed = true;
    searchError = err;
  }

  // 絞込を必ず元に戻す (他の担当者の画面に影響を残さないため)。
  try {
    const restoreConfigHtml = await fetchConfigHtml(jar, fetchImpl, timeoutMs);
    const restoreRefs = resolveConfigFields(restoreConfigHtml);
    await applyConfig(jar, restoreConfigHtml, restoreRefs, originalValues, fetchImpl, timeoutMs);
  } catch (restoreErr) {
    const restoreMessage = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
    const searchMessage = searchFailed
      ? searchError instanceof Error
        ? searchError.message
        : String(searchError)
      : null;
    throw new TheearthClientError(
      `表示条件指定 (F-GOS0030) を元の値へ戻せませんでした: ${restoreMessage}` +
        (searchMessage ? ` (検索処理も失敗していました: ${searchMessage})` : "") +
        " — theearth の表示条件指定を手動で確認してください",
    );
  }

  if (searchFailed) throw searchError;
  return rows;
}

// ---------------------------------------------------------------------------
// ダウンロード
// ---------------------------------------------------------------------------

export interface Net780DownloadTarget {
  operationNo: string;
  startDateTime: string;
  /**
   * D1 検索カタログ (`dtako_uploads`、Refs #299) 用の表示メタ。theearth への
   * postback には使わない (downloadNet780Zip はこれらのフィールドを無視する)。
   * フロント側が検索結果の Net780Row から素通しで渡す想定、値が無くても
   * ダウンロード自体は成立する (カタログ行が検索性の低いものになるだけ)。
   */
  vehicleName?: string | null;
  driverCd1?: string | null;
  driverName1?: string | null;
  operationDate?: string | null;
}

/** ダウンロード対象の行数上限 (暫定値。POST body 長の実質上限は未検証、
 * theearth-venus skill の「未検証・要確認」参照)。 */
export const NET780_DOWNLOAD_MAX_ROWS = 30;

/** ダウンロード対象を検証する (1件以上、上限件数、運行No形式)。 */
export function validateNet780DownloadTargets(targets: Net780DownloadTarget[]): void {
  if (targets.length === 0) {
    throw new Net780ParamError("ダウンロード対象を1件以上選択してください");
  }
  if (targets.length > NET780_DOWNLOAD_MAX_ROWS) {
    throw new Net780ParamError(
      `ダウンロード対象は最大 ${NET780_DOWNLOAD_MAX_ROWS} 件までです (受領: ${targets.length} 件) — 絞り込んで分割してください`,
    );
  }
  for (const t of targets) {
    if (!/^\d{22}$/.test(t.operationNo)) {
      throw new Net780ParamError(`運行No は22桁の数値で指定してください (受領値: ${t.operationNo})`);
    }
  }
}

/**
 * 選択した運行の NET780 生データ zip をダウンロードする。
 *
 * 実機確定: 行選択 (Ctrl+クリック複数選択) は txtOperationNo/txtStartDateTime に
 * カンマ連結で蓄積され、`MainContent_btnPreview` の**単一 postback** で zip が
 * 返る (F-NOS3010 のような2段階確認ページは無い)。ダウンロード postback は
 * HTTP 503 の再現性が高い (原因未特定) ため、呼び出し側 (DO) でリトライを
 * 検討すること。
 */
export async function downloadNet780Zip(
  jar: CookieJar,
  targets: Net780DownloadTarget[],
  fetchImpl: FetchLike = fetch,
  timeouts: ScrapeTimeouts = {},
): Promise<ArrayBuffer> {
  validateNet780DownloadTargets(targets);
  const requestTimeoutMs = timeouts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const exportTimeoutMs = timeouts.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS;
  const url = `${BASE_URL}${NET780_LIST_PATH}`;

  const getRes = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl, requestTimeoutMs);
  if (!getRes.ok) {
    throw new TheearthClientError(`3要素解析データダウンロード一覧の取得が HTTP ${getRes.status} を返しました`);
  }
  const html = await getRes.text();
  if (hasLoginForm(html)) {
    throw new VenusSessionExpiredError(
      "3要素解析データダウンロード一覧がログイン画面を返しました — theearth セッションが切れています",
    );
  }

  const opNoField = findFormFieldById(html, "txtOperationNo");
  const startDtField = findFormFieldById(html, "txtStartDateTime");
  const downloadButton = findFormFieldById(html, "MainContent_btnPreview");
  if (!opNoField || !startDtField || !downloadButton) {
    throw new TheearthClientError(
      "3要素解析データダウンロード一覧のフォーム要素 (txtOperationNo/txtStartDateTime/btnPreview) が" +
        "見つかりません — theearth-np のページ仕様が変更された可能性があります",
    );
  }

  const body = new URLSearchParams({
    ...serializeFormFields(html),
    [opNoField.name]: targets.map((t) => t.operationNo).join(","),
    [startDtField.name]: targets.map((t) => t.startDateTime).join(","),
    [downloadButton.name]: downloadButton.value || "ダウンロード",
  });

  const res = await postForm(jar, url, body, fetchImpl, exportTimeoutMs);
  if (!res.ok) {
    throw new TheearthClientError(
      `NET780 データダウンロードの postback が HTTP ${res.status} を返しました — theearth 側で` +
        "一時的な不安定さが発生することがあるため、再試行を検討してください",
    );
  }
  const contentType = res.headers.get("content-type") ?? "";
  const buf = await res.arrayBuffer();

  if (contentType.includes("text/html")) {
    const errHtml = new TextDecoder("utf-8").decode(buf);
    if (hasLoginForm(errHtml)) {
      throw new VenusSessionExpiredError(
        "NET780 データダウンロードの postback がログイン画面を返しました — theearth セッションが切れています",
      );
    }
    throw new TheearthClientError("NET780 データダウンロードの postback が想定外の HTML を返しました");
  }

  return ensureZip(buf, contentType);
}

// ---------------------------------------------------------------------------
// R2 アーカイブの key 設計 (pure — R2 I/O は DO 側、Refs #302 続き)
// ---------------------------------------------------------------------------

/**
 * NET780 生データ ZIP の R2 アーカイブ key 群。
 *
 * ダウンロード ZIP (Refs #299 以降は常に単一 operationNo、以前の一括ダウンロード
 * archive は運行数不定) は **内容の SHA-256 でそのまま dedup 保存**
 * (`zipObject`) し、運行単位の「どの ZIP に入っているか」だけを `indexObject`
 * (operationNo ごとの小さなポインタ JSON) に持たせる。NET780 生データは取得後に
 * 内容が変わることがない (過去の運行記録) ため、restraint 系のような版管理・
 * retention は不要 — index は常に上書きで良い (再取得しても同じ zipKey を指す
 * だけ)。
 */
export interface Net780R2Paths {
  /** ダウンロード ZIP 本体 (内容ハッシュで dedup)。 */
  zipObject(sha256: string): string;
  /** operationNo → zipObject の場所を指すポインタ JSON。 */
  indexObject(operationNo: string): string;
}

export function net780R2Paths(prefix: string, compId: string): Net780R2Paths {
  const base = `${prefix}/${compId}`;
  return {
    zipObject: (sha256) => `${base}/zips/${sha256}.zip`,
    indexObject: (operationNo) => `${base}/by-operation/${operationNo}.json`,
  };
}

/**
 * `indexObject` の body (決定論 JSON)。
 *
 * `operationCount` はその zipKey に含まれる運行数 (=保存時の targets.length)。
 * ダウンロード ZIP は `{車輌CD}/{タイムスタンプ}-0-0-{車輌CD}/` というフォルダで
 * 運行ごとに分かれているが、フォルダ名は運行No (operationNo) ではなく車輌CD+
 * タイムスタンプ由来 (theearth-venus skill 参照、対応関係未検証) のため、
 * **2件以上の運行を含む ZIP からは「どのフォルダが要求された operationNo か」を
 * 安全に特定できない**。Refs #299 でダウンロードを1件ずつに変更したため新規
 * archive の `operationCount` は常に 1 になるが、フィールド自体と r2-view 側の
 * ガードは変更前の旧 archive (2件以上を含みうる) との後方互換のため残す —
 * さもないと `extractSingleOperationZip` の「先頭フォルダのみ」抽出が別運行の
 * データを黙って返しかねない (呼び出し側は operationCount > 1 を拒否すること)。
 */
export interface Net780R2Index {
  zipKey: string;
  startDateTime: string;
  fetchedAt: string;
  operationCount: number;
}

export function net780R2IndexBody(index: Net780R2Index): string {
  return JSON.stringify(index);
}
