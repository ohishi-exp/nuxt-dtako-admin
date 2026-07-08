/**
 * theearth-np.com VenusBridgeService (WCF `.svc`) クライアント — DVR 動画通知一覧 +
 * `.vdf` (NET780 独自コンテナ) 取得。/dvr-viewer (Refs #90) が使う。
 *
 * ohishi-exp/nuxt_dtako_logs の `server/utils/theearth-venus-client.ts` (実機トレース済み、
 * Refs ohishi-exp/browser-render-rust#14) から移植。cookie jar / ログインは同一実装の
 * `./theearth-client` を再利用し二重管理しない。現在地 (VehicleStateTableForBranchEx、
 * 推測実装) は viewer では使わないため移植していない。
 */
import {
  BASE_URL,
  extractHiddenFields,
  fetchWithJar,
  TheearthClientError,
  type CookieJar,
  type FetchLike,
} from "./theearth-client";

const VENUS_BRIDGE_PATH = "/Bridge/B-GOS0010[VenusBridgeService].svc";

/**
 * VenusBridge が JSON ではなく HTML (ログイン画面等) を返した時に throw する。
 * theearth 側セッション切れの典型症状なので、呼び出し側 (DO) はこれを 401 に
 * マップして browser に再ログインを促す。
 */
export class VenusSessionExpiredError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "VenusSessionExpiredError";
  }
}

/** `POST {VenusBridgeService}/{methodName}` を叩き `{"d": ...}` の `d` を返す。
 * HTML エラーページ (ログイン切れ等) を JSON として誤扱いしないよう、
 * content-type と `d` フィールドの存在を必ず検証する (「黙って200」対策)。 */
export async function callVenusBridgeMethod(
  jar: CookieJar,
  methodName: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<unknown> {
  const url = `${BASE_URL}${VENUS_BRIDGE_PATH}/${methodName}`;
  const res = await fetchWithJar(
    jar,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body),
    },
    fetchImpl,
  );

  if (!res.ok) {
    // theearth セッションが無効化されると (別の場所での同一アカウントログイン /
    // アイドルタイムアウト等)、VenusBridge は HTML ではなく **HTTP 500** を返す
    // (2026-07-03 staging 実機で確認)。再ログインで回復するので、502 に潰さず
    // VenusSessionExpiredError → 401 に載せ替えて browser に再ログインを促す。
    if (res.status === 500) {
      throw new VenusSessionExpiredError(
        `VenusBridge ${methodName} が HTTP 500 を返しました — theearth セッションが` +
          "無効化された可能性があります (別の場所での同一アカウントログイン等)。再ログインしてください",
      );
    }
    throw new TheearthClientError(`VenusBridge ${methodName} が HTTP ${res.status} を返しました`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const text = await res.text();
    throw new VenusSessionExpiredError(
      `VenusBridge ${methodName} が JSON ではなく "${contentType || "unknown"}" を返しました ` +
        `(先頭200文字: ${text.slice(0, 200)}) — ログイン切れ、またはサイト仕様変更の可能性`,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    // content-type は json なのに body が JSON として読めない (空 body / BOM 等)。
    // 生の SyntaxError を上に漏らすと呼び出し側で「予期しないエラー」に潰れるので、
    // 診断可能な TheearthClientError に変換する。
    throw new TheearthClientError(
      `VenusBridge ${methodName} のレスポンスを JSON として parse できませんでした: ${String(e)}`,
    );
  }
  if (json === null || typeof json !== "object" || !("d" in json)) {
    throw new TheearthClientError(
      `VenusBridge ${methodName} のレスポンスに "d" フィールドがありません: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return (json as { d: unknown }).d;
}

/** レスポンスの `d` から行オブジェクト配列を取り出す。theearth VenusBridge は
 * DVR 通知を **`["<件数>", "<行配列を JSON エンコードした文字列>"]`** という
 * 2 要素配列で返す (Refs #90、実データで確認)。この形を最優先で剥がしてから、
 * 素の配列 / `{rows}` ラップ等の一般形にフォールバックする。要素がオブジェクト
 * でないものは除外する (`"4"` 等のスカラーに `in` 演算子を当てて落ちるのを防ぐ)。 */
function toItemArray(d: unknown): Array<Record<string, unknown>> | null {
  // theearth 形: [countString, rowsJsonString]
  if (Array.isArray(d) && d.length === 2 && typeof d[1] === "string") {
    try {
      const parsed = JSON.parse(d[1]) as unknown;
      if (Array.isArray(parsed)) return keepObjects(parsed);
    } catch {
      // JSON 文字列でなければ一般形フォールバックに委ねる
    }
  }
  if (Array.isArray(d)) return keepObjects(d);
  if (d && typeof d === "object") {
    const rows = (d as { rows?: unknown }).rows
      ?? (d as { Rows?: unknown }).Rows
      ?? (d as { Table?: unknown }).Table;
    if (Array.isArray(rows)) return keepObjects(rows);
  }
  return null;
}

/** オブジェクト要素だけを残す (スカラー/null/配列を除外)。 */
function keepObjects(arr: unknown[]): Array<Record<string, unknown>> {
  return arr.filter(
    (x): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x),
  );
}

function pickStringField(record: Record<string, unknown>, candidates: readonly string[]): string | null {
  for (const key of candidates) {
    if (key in record && record[key] != null) return String(record[key]);
  }
  return null;
}

// --- DVR 動画通知 (Monitoring_DvrNotification2、browser-render-rust#14 で実機確認済み) ---

// 実データ (Refs #90) は PascalCase (VehicleCD 等)。snake_case も念のため候補に残す。
const DVR_VEHICLE_CD_CANDIDATES = ["VehicleCD", "vehicle_cd", "VehicleCd"] as const;
const DVR_VEHICLE_NAME_CANDIDATES = ["VehicleName", "vehicle_name"] as const;
const DVR_SERIAL_NO_CANDIDATES = ["SerialNo", "serial_no"] as const;
const DVR_FILE_NAME_CANDIDATES = ["FileName", "file_name"] as const;
const DVR_FILE_PATH_CANDIDATES = ["FilePath", "file_path"] as const;
const DVR_EVENT_TYPE_CANDIDATES = ["EventType", "event_type"] as const;
const DVR_DATETIME_CANDIDATES = ["DvrDatetime", "dvr_datetime", "DvrDateTime"] as const;
const DVR_DRIVER_NAME_CANDIDATES = ["DriverName", "driver_name"] as const;
const DVR_LAT_CANDIDATES = ["Latitude", "latitude", "GPSLatitude"] as const;
const DVR_LNG_CANDIDATES = ["Longitude", "longitude", "GPSLongitude"] as const;
const DVR_FILE_RECEIVE_CANDIDATES = ["FileReceive", "file_receive"] as const;

/**
 * 映像ファイルの受信状態 (実ページ J-AAV0100 の `fa-prcs-X-Y` クラス由来、Refs #90)。
 * - `ready`: 3-0 = サーバーに映像あり、ダウンロード/再生できる
 * - `requestable`: 0-0 = まだ車両にしかない。転送要求 (車両から取得) が必要
 * - `in_progress`: 1-0/1-3 (要求中/運行開始待ち) / 2-0 (アップロード中)
 * - `error`: 1-1 (未検出) / 1-2 (タイムアウト) / 2-1 (送信中断) / 3-1・3-2 (破損)
 * - `unknown`: FileReceive を解釈できなかった
 */
export type DvrReceiveState = "ready" | "requestable" | "in_progress" | "error" | "unknown";

/** FileReceive セルの class 文字列 (`... fa-prcs-3-0 ...`) から受信状態を判定する。 */
export function parseReceiveState(fileReceive: string | null): DvrReceiveState {
  if (!fileReceive) return "unknown";
  const m = fileReceive.match(/fa-prcs-(\d)-(\d)/);
  if (!m) return "unknown";
  const code = `${m[1]}-${m[2]}`;
  switch (code) {
    case "3-0":
      return "ready";
    case "0-0":
      return "requestable";
    case "1-0":
    case "1-3":
    case "2-0":
      return "in_progress";
    default:
      // 1-1 / 1-2 / 2-1 / 3-1 / 3-2 等
      return "error";
  }
}

export interface DvrNotification {
  raw: Record<string, unknown>;
  vehicleCd: string | null;
  vehicleName: string | null;
  serialNo: string | null;
  fileName: string | null;
  filePath: string | null;
  eventType: string | null;
  dvrDatetime: string | null;
  driverName: string | null;
  /** 度単位の緯度経度 (実データは 1e6 倍の整数、例 36339272 = 36.339272)。取れなければ null。 */
  latitude: number | null;
  longitude: number | null;
  /** 映像ファイルの受信状態 (車両から取得 → ダウンロード可能 の段階を表す)。 */
  receiveState: DvrReceiveState;
}

/**
 * theearth の緯度経度整数 (NMEA 由来の **DDMM 形式**: 度×1e6 + 分×1e4 + 分の小数×1e4)
 * を十進度に変換する。実ページ J-GOS0100[MapEvent].js の `ConvertLatLngDDMMtoDD` の移植
 * (2026-07-03 実機確定 — DVR 行 / 現在地 / 動態履歴すべてこの形式)。
 * 例: 32478749 → 32°47.8749' → 32.7981。0 (GPS 未捕捉) と非数値は null。
 * |値| ≤ 180 は既に度とみなして素通しする (DDMM は 1 度以上で必ず 1e6 を超えるため)。
 */
export function convertDdmmToDegrees(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (Number.isNaN(n) || n === 0) return null;
  if (Math.abs(n) <= 180) return n;
  const abs = Math.abs(n);
  const deg = Math.floor(abs / 1_000_000);
  const min = Math.floor(abs / 10_000) % 100;
  const minFrac = (abs % 10_000) / 10_000;
  const result = deg + (min + minFrac) / 60;
  return n < 0 ? -result : result;
}

/** レコードから DDMM 形式の緯度/経度候補フィールドを拾って十進度に変換する。 */
function pickDegreeField(record: Record<string, unknown>, candidates: readonly string[]): number | null {
  for (const key of candidates) {
    if (key in record) {
      const deg = convertDdmmToDegrees(record[key]);
      if (deg !== null) return deg;
    }
  }
  return null;
}

export async function getDvrNotifications(
  jar: CookieJar,
  fetchImpl: FetchLike = fetch,
): Promise<DvrNotification[]> {
  // sort 引数形式: "fieldName,dir,pageIndex,pageSize" (Refs browser-render-rust#14)
  const d = await callVenusBridgeMethod(jar, "Monitoring_DvrNotification2", { sort: ",,0,100" }, fetchImpl);

  const items = toItemArray(d);
  if (!items) {
    throw new TheearthClientError(
      `Monitoring_DvrNotification2 のレスポンス形式が想定と異なります (配列でも {rows:[]} でもありません): ` +
        `${JSON.stringify(d).slice(0, 300)}`,
    );
  }

  return items.map((raw) => ({
    raw,
    vehicleCd: pickStringField(raw, DVR_VEHICLE_CD_CANDIDATES),
    vehicleName: pickStringField(raw, DVR_VEHICLE_NAME_CANDIDATES),
    serialNo: pickStringField(raw, DVR_SERIAL_NO_CANDIDATES),
    fileName: pickStringField(raw, DVR_FILE_NAME_CANDIDATES),
    filePath: pickStringField(raw, DVR_FILE_PATH_CANDIDATES),
    eventType: pickStringField(raw, DVR_EVENT_TYPE_CANDIDATES),
    dvrDatetime: pickStringField(raw, DVR_DATETIME_CANDIDATES),
    driverName: pickStringField(raw, DVR_DRIVER_NAME_CANDIDATES),
    latitude: pickDegreeField(raw, DVR_LAT_CANDIDATES),
    longitude: pickDegreeField(raw, DVR_LNG_CANDIDATES),
    receiveState: parseReceiveState(pickStringField(raw, DVR_FILE_RECEIVE_CANDIDATES)),
  }));
}

// --- DVR 映像検索 (Request_DvrDataList、Refs #90 実ページ J-AAV0100 の
// igButton_dvrdata_click / igGrid_dvrdata2_Refresh_callback を cdp トレースして確定) ---
//
// 検索キーは string[10]:
//   [0] 開始日時 "YYYY/MM/DD HH:mm"   [1] 終了日時 (開始 + 範囲分)
//   [2] 車輌CD (カンマ区切り可)        [3] 乗務員CD (カンマ区切り可)
//   [4] 緯度 (度×3600 の秒整数、S は負) [5] 経度 (同、W は負)。未指定は両方 ""
//   [6] 位置範囲 [m]                   [7] 映像種別 "警告,警告,常時,緊急" の 4 フラグ
//   [8] 走行状態 "走行,停車"           [9] 道路種別 "一般,高速,専用"
// 実測例: ["2026/07/03 18:06","2026/07/03 18:36","2131","","","","300","1,1,1,1","1,1","1,1,1"]
// 応答は Monitoring_DvrNotification2 と同じ ["<件数>", "<行JSON文字列>"]。

/** 検索パラメータの検証エラー (呼び出し側で 400 にマップする)。 */
export class DvrSearchParamError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "DvrSearchParamError";
  }
}

export interface DvrSearchParams {
  /** 開始日時 "YYYY/MM/DD HH:mm" (theearth サーバーローカル = JST)。 */
  start: string;
  /** 検索範囲 (分)。開始日時 + 範囲 = 終了日時。 */
  rangeMinutes: number;
  /** 車輌CD (カンマ区切りで複数可)。車輌/乗務員/位置範囲のいずれか 1 つは必須。 */
  vehicleCds?: string;
  /** 乗務員CD (カンマ区切りで複数可)。 */
  driverCds?: string;
  /** 位置範囲の中心緯度 (度)。経度とペアで指定。 */
  latitude?: number | null;
  /** 位置範囲の中心経度 (度)。 */
  longitude?: number | null;
  /** 位置範囲の半径 [m] (既定 300)。 */
  radiusM?: number;
  /** 映像種別 (既定: 全て true)。最低 1 つは true。 */
  dvrTypes?: { warning?: boolean; always?: boolean; emergency?: boolean };
  /** 走行状態 (既定: 全て true)。最低 1 つは true。 */
  runStates?: { running?: boolean; stopped?: boolean };
  /** 道路種別 (既定: 全て true)。最低 1 つは true。 */
  roadTypes?: { general?: boolean; highway?: boolean; exclusive?: boolean };
}

const DVR_SEARCH_DATETIME_RE = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/;

/** "YYYY/MM/DD HH:mm" を naive な epoch ms に変換する (TZ 変換はしない — theearth
 * サーバーローカル時刻の算術にだけ使う)。不正な日付 (2026/02/31 等) は null。 */
function parseSearchDatetime(value: string): number | null {
  const m = value.match(DVR_SEARCH_DATETIME_RE);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Date.UTC は 2026/02/31 のような不正日付を黙って繰り上げる。round-trip して
  // 入力と一致しなければ不正として弾く。
  return formatSearchDatetime(t) === value ? t : null;
}

function formatSearchDatetime(t: number): string {
  const dt = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getUTCFullYear()}/${pad(dt.getUTCMonth() + 1)}/${pad(dt.getUTCDate())} ${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}`;
}

/** カンマ区切りの CD リストを検証・正規化する (空白除去、空要素除去)。 */
function normalizeCdList(value: string | undefined, label: string): string {
  if (!value) return "";
  const parts = value.split(",").map((p) => p.trim()).filter((p) => p !== "");
  for (const p of parts) {
    if (!/^\d+$/.test(p)) {
      throw new DvrSearchParamError(`${label}は数値 (カンマ区切り可) で指定してください: "${p}"`);
    }
  }
  return parts.join(",");
}

function flag(v: boolean | undefined, fallback: boolean): "0" | "1" {
  return (v ?? fallback) ? "1" : "0";
}

/** 検索パラメータから Request_DvrDataList の key (string[10]) を組み立てる。
 * 実ページと同じ必須条件 (車輌/乗務員/位置範囲のいずれか + 各チェック群最低 1 つ) を
 * 検証し、満たさなければ DvrSearchParamError を投げる (pure、fetch しない)。 */
export function buildDvrSearchKey(params: DvrSearchParams): string[] {
  const startMs = parseSearchDatetime(params.start);
  if (startMs === null) {
    throw new DvrSearchParamError(`開始日時は "YYYY/MM/DD HH:mm" 形式で指定してください: "${params.start}"`);
  }
  const range = params.rangeMinutes;
  if (!Number.isInteger(range) || range < 1 || range > 1440) {
    throw new DvrSearchParamError(`範囲 [分] は 1〜1440 の整数で指定してください: ${range}`);
  }

  const vehicleCds = normalizeCdList(params.vehicleCds, "車輌CD");
  const driverCds = normalizeCdList(params.driverCds, "乗務員CD");

  const hasLat = params.latitude != null;
  const hasLng = params.longitude != null;
  if (hasLat !== hasLng) {
    throw new DvrSearchParamError("位置範囲は緯度・経度の両方を指定してください");
  }
  let latSec = "";
  let lngSec = "";
  if (hasLat && hasLng) {
    const lat = params.latitude!;
    const lng = params.longitude!;
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) {
      throw new DvrSearchParamError(`緯度経度が範囲外です: ${lat}, ${lng}`);
    }
    // 実ページは 度×3600 + 分×60 + 秒 の秒単位整数 (南緯/西経は負) を送る。
    latSec = String(Math.round(lat * 3600));
    lngSec = String(Math.round(lng * 3600));
  }
  const hasLatLng = latSec !== "" && (latSec !== "0" || lngSec !== "0");
  if (!hasLatLng) {
    latSec = "";
    lngSec = "";
  }

  if (!vehicleCds && !driverCds && !hasLatLng) {
    throw new DvrSearchParamError("車輌・乗務員・位置範囲のいずれかは必ず指定してください");
  }

  const radiusM = params.radiusM ?? 300;
  if (!Number.isFinite(radiusM) || radiusM < 1) {
    throw new DvrSearchParamError(`位置範囲 [m] は正の数で指定してください: ${radiusM}`);
  }

  const w = flag(params.dvrTypes?.warning, true);
  const a = flag(params.dvrTypes?.always, true);
  const e = flag(params.dvrTypes?.emergency, true);
  if (w === "0" && a === "0" && e === "0") {
    throw new DvrSearchParamError("映像種別はいずれか 1 つ以上を指定してください");
  }
  const run = flag(params.runStates?.running, true);
  const stop = flag(params.runStates?.stopped, true);
  if (run === "0" && stop === "0") {
    throw new DvrSearchParamError("走行状態はいずれか 1 つ以上を指定してください");
  }
  const general = flag(params.roadTypes?.general, true);
  const highway = flag(params.roadTypes?.highway, true);
  const exclusive = flag(params.roadTypes?.exclusive, true);
  if (general === "0" && highway === "0" && exclusive === "0") {
    throw new DvrSearchParamError("道路種別はいずれか 1 つ以上を指定してください");
  }

  return [
    formatSearchDatetime(startMs),
    formatSearchDatetime(startMs + range * 60_000),
    vehicleCds,
    driverCds,
    latSec,
    lngSec,
    String(radiusM),
    // 実ページの key[7] は先頭 2 フラグが同値 (警告を 2 回) の 4 要素
    `${w},${w},${a},${e}`,
    `${run},${stop}`,
    `${general},${highway},${exclusive}`,
  ];
}

const DVR_DATA_TYPE_CANDIDATES = ["DataType", "data_type"] as const;
const DVR_RUN_STATE_CANDIDATES = ["RunState", "run_state"] as const;
const DVR_ROAD_TYPE_CANDIDATES = ["RoadType", "road_type"] as const;
const DVR_PLACE_NAME_CANDIDATES = ["PlaceName", "place_name"] as const;
const DVR_SPEED_CANDIDATES = ["Speed", "speed"] as const;

/** 映像検索の結果 1 行。通知一覧 (DvrNotification) と同じ受信/DL フローに乗せられる
 * よう同フィールドを持ち、検索固有の列 (映像種別/走行/道路/地点/速度) を足したもの。 */
export interface DvrSearchRow extends DvrNotification {
  /** 映像種別 (常時/警告/緊急ボタン)。 */
  dataType: string | null;
  /** 走行状態 (走行/停車)。 */
  runState: string | null;
  /** 道路種別 (一般/高速/専用)。 */
  roadType: string | null;
  /** 地点名。 */
  placeName: string | null;
  /** 速度 [km/h]。 */
  speed: number | null;
}

function pickNumberField(record: Record<string, unknown>, candidates: readonly string[]): number | null {
  for (const key of candidates) {
    if (key in record && record[key] != null) {
      const v = record[key];
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isNaN(n)) return n;
    }
  }
  return null;
}

/** `Request_DvrDataList(key)` で映像検索する。key は buildDvrSearchKey の戻り値。 */
export async function searchDvrData(
  jar: CookieJar,
  key: string[],
  fetchImpl: FetchLike = fetch,
): Promise<DvrSearchRow[]> {
  const d = await callVenusBridgeMethod(jar, "Request_DvrDataList", { key }, fetchImpl);

  const items = toItemArray(d);
  if (!items) {
    throw new TheearthClientError(
      `Request_DvrDataList のレスポンス形式が想定と異なります: ${JSON.stringify(d).slice(0, 300)}`,
    );
  }

  return items.map((raw) => ({
    raw,
    vehicleCd: pickStringField(raw, DVR_VEHICLE_CD_CANDIDATES),
    vehicleName: pickStringField(raw, DVR_VEHICLE_NAME_CANDIDATES),
    serialNo: pickStringField(raw, DVR_SERIAL_NO_CANDIDATES),
    fileName: pickStringField(raw, DVR_FILE_NAME_CANDIDATES),
    filePath: pickStringField(raw, DVR_FILE_PATH_CANDIDATES),
    eventType: pickStringField(raw, DVR_EVENT_TYPE_CANDIDATES),
    dvrDatetime: pickStringField(raw, DVR_DATETIME_CANDIDATES),
    driverName: pickStringField(raw, DVR_DRIVER_NAME_CANDIDATES),
    latitude: pickDegreeField(raw, DVR_LAT_CANDIDATES),
    longitude: pickDegreeField(raw, DVR_LNG_CANDIDATES),
    receiveState: parseReceiveState(pickStringField(raw, DVR_FILE_RECEIVE_CANDIDATES)),
    dataType: pickStringField(raw, DVR_DATA_TYPE_CANDIDATES),
    runState: pickStringField(raw, DVR_RUN_STATE_CANDIDATES),
    roadType: pickStringField(raw, DVR_ROAD_TYPE_CANDIDATES),
    placeName: pickStringField(raw, DVR_PLACE_NAME_CANDIDATES),
    speed: pickNumberField(raw, DVR_SPEED_CANDIDATES),
  }));
}

// --- 検索フォーム用マスタ (Request_NetDvrFuncInitValue、Refs #90 実 API 検証済み) ---
//
// d = [事業所JSON, 車輌JSON, 乗務員JSON, 通知件数, 通知行JSON, 設定] の 6 要素。
// 車輌/乗務員は {code, link (所属事業所 code), name}。

export interface DvrMasterBranch {
  code: string;
  name: string;
}

export interface DvrMasterItem {
  code: string;
  /** 所属事業所の code (branches[].code に対応)。 */
  link: string | null;
  name: string;
}

export interface DvrMasters {
  branches: DvrMasterBranch[];
  vehicles: DvrMasterItem[];
  drivers: DvrMasterItem[];
}

function parseMasterJson(value: unknown, label: string): Array<Record<string, unknown>> {
  if (typeof value !== "string") {
    throw new TheearthClientError(`Request_NetDvrFuncInitValue の${label}マスタが文字列ではありません`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TheearthClientError(`Request_NetDvrFuncInitValue の${label}マスタを JSON として parse できませんでした`);
  }
  if (!Array.isArray(parsed)) {
    throw new TheearthClientError(`Request_NetDvrFuncInitValue の${label}マスタが配列ではありません`);
  }
  return keepObjects(parsed);
}

/** 検索フォームのドロップダウン用に 事業所/車輌/乗務員 マスタを取得する。 */
export async function getDvrMasters(
  jar: CookieJar,
  fetchImpl: FetchLike = fetch,
): Promise<DvrMasters> {
  const d = await callVenusBridgeMethod(jar, "Request_NetDvrFuncInitValue", {}, fetchImpl);
  if (!Array.isArray(d) || d.length < 3) {
    throw new TheearthClientError(
      `Request_NetDvrFuncInitValue の応答形式が想定と異なります: ${JSON.stringify(d).slice(0, 200)}`,
    );
  }

  const branches = parseMasterJson(d[0], "事業所").map((r) => ({
    code: r.code != null ? String(r.code) : "",
    name: r.name != null ? String(r.name) : "",
  }));
  const toItem = (r: Record<string, unknown>): DvrMasterItem => ({
    code: r.code != null ? String(r.code) : "",
    link: r.link != null ? String(r.link) : null,
    name: r.name != null ? String(r.name) : "",
  });
  return {
    branches,
    vehicles: parseMasterJson(d[1], "車輌").map(toItem),
    drivers: parseMasterJson(d[2], "乗務員").map(toItem),
  };
}

/** `Request_DvrFileTransfer_MultiTarget(serialCSV, fileCSV)` で複数の映像ファイル転送を
 * 一括要求する (映像検索グリッドの「選択行要求」相当。実ページは車輌絞込検索時の単一行
 * 要求にもこれを使う)。応答の先頭要素を結果コードとして返す (>0 で受理)。 */
export async function requestDvrFileTransferMulti(
  jar: CookieJar,
  serialNos: string[],
  fileNames: string[],
  fetchImpl: FetchLike = fetch,
): Promise<{ code: number; raw: unknown }> {
  if (serialNos.length === 0 || serialNos.length !== fileNames.length) {
    throw new DvrSearchParamError("serial と filename は同数で 1 件以上指定してください");
  }
  const d = await callVenusBridgeMethod(
    jar,
    "Request_DvrFileTransfer_MultiTarget",
    { key1: serialNos.join(","), key2: fileNames.join(",") },
    fetchImpl,
  );
  const code = Array.isArray(d) ? Number(d[0]) : Number(d);
  return { code: Number.isNaN(code) ? -1 : code, raw: d };
}

// --- 車輌現在地 / 動態履歴 (2026-07-03 実機確定) ---
//
// - `VehicleStateTableForBranchEx(strBranchCD, strScrapCarDisp)` — VenusMain (位置情報)
//   の車輌一覧。d は `VehicleSetStateData` の素オブジェクト配列 (通知一覧の
//   [件数, JSON文字列] 形式ではない)。GPSLatitude/GPSLongitude は DDMM 形式。
// - `VehicleStateTable(VehicleCD, dtmST, dtmED)` — F-DOV0010 (動態履歴) の GPS 軌跡。
//   日付は "YYYY/MM/DD"。1 日で 150 点前後、各点 DataDateTime ("MM/DD HH:mm") + GPS。
//
// nuxt_dtako_logs の theearth-venus-client.ts は同メソッドを推測実装していたが、
// フィールド名 (GPSLatitude/GPSLongitude) と DDMM スケールはここで確定した。

/** 現在地 / 動態履歴の 1 点 (VehicleSetStateData のうち利用フィールドのみ)。 */
export interface VehicleStatePoint {
  vehicleCd: string | null;
  vehicleName: string | null;
  branchName: string | null;
  driverName: string | null;
  /** 十進度 (DDMM から変換済み)。GPS 未捕捉は null。 */
  latitude: number | null;
  longitude: number | null;
  /** データ時刻 "MM/DD HH:mm" (theearth サーバーローカル)。 */
  dataDatetime: string | null;
  /** 通信時刻 "MM/DD HH:mm"。 */
  comuDatetime: string | null;
  speed: number | null;
  revo: number | null;
  /** 進行方向 (GPSDirection、度・北 0 時計回り想定。地図の矢印マーカーの回転に使う)。 */
  direction: number | null;
  /** 現在作業名 (現在地一覧のみ、履歴では null)。 */
  currentWorkName: string | null;
}

const VS_SPEED_CANDIDATES = ["Speed"] as const;
const VS_REVO_CANDIDATES = ["Revo"] as const;
const VS_DIRECTION_CANDIDATES = ["GPSDirection"] as const;

function mapVehicleStateRow(raw: Record<string, unknown>): VehicleStatePoint {
  return {
    vehicleCd: pickStringField(raw, DVR_VEHICLE_CD_CANDIDATES),
    vehicleName: pickStringField(raw, DVR_VEHICLE_NAME_CANDIDATES),
    branchName: pickStringField(raw, ["BranchName"]),
    driverName: pickStringField(raw, DVR_DRIVER_NAME_CANDIDATES),
    latitude: convertDdmmToDegrees(raw.GPSLatitude),
    longitude: convertDdmmToDegrees(raw.GPSLongitude),
    dataDatetime: pickStringField(raw, ["DataDateTime"]),
    comuDatetime: pickStringField(raw, ["ComuDateTime"]),
    speed: pickNumberField(raw, VS_SPEED_CANDIDATES),
    revo: pickNumberField(raw, VS_REVO_CANDIDATES),
    direction: pickNumberField(raw, VS_DIRECTION_CANDIDATES),
    currentWorkName: pickStringField(raw, ["CurrentWorkName"]),
  };
}

function assertVehicleStateArray(d: unknown, methodName: string): Array<Record<string, unknown>> {
  if (!Array.isArray(d)) {
    throw new TheearthClientError(
      `${methodName} のレスポンス形式が想定と異なります (配列ではありません): ${JSON.stringify(d).slice(0, 200)}`,
    );
  }
  return keepObjects(d);
}

/** 事業所単位の車輌現在地一覧 (`VehicleStateTableForBranchEx`)。branchCd は
 * getDvrMasters の branches[].code ("00000001" 形式)。 */
export async function getVehicleStates(
  jar: CookieJar,
  branchCd: string,
  fetchImpl: FetchLike = fetch,
): Promise<VehicleStatePoint[]> {
  if (!/^\d+$/.test(branchCd)) {
    throw new DvrSearchParamError(`事業所コードは数値で指定してください: "${branchCd}"`);
  }
  const d = await callVenusBridgeMethod(
    jar,
    "VehicleStateTableForBranchEx",
    // strScrapCarDisp: 廃車表示フラグ (実ページ lblScrapCarDisp の値、通常 "0")
    { strBranchCD: branchCd, strScrapCarDisp: "0" },
    fetchImpl,
  );
  return assertVehicleStateArray(d, "VehicleStateTableForBranchEx").map(mapVehicleStateRow);
}

const VEHICLE_LOG_DAY_RE = /^\d{4}\/\d{2}\/\d{2}$/;

// 動態履歴ページ (F-DOV0010[LogDataDisp].aspx)。VenusBridge の VehicleStateTable は
// GPS 軌跡しか返さず **速度・回転数が全点 0** になる (2026-07-03 実機確認)。速度・回転数・
// 住所・走行状態・乗務員は、このページを 2 段階 postback して返る HTML の
// `VehicleDisp` テーブル (各セル `<span id="lstVehicle_lbl<Field>_<row>">値</span>`) に
// しか載っていないため、API ではなく postback + span パースで取得する。
const VEHICLE_LOG_PATH = "/WebVenus/F-DOV0010[LogDataDisp].aspx";

/** 動態履歴 1 点 (VehicleDisp テーブルの 1 行)。VehicleStateTable API と違い速度・
 * 回転数・住所・走行状態・乗務員まで取れる。 */
export interface VehicleLogPoint {
  /** データ日時 "MM/DD HH:mm" (theearth サーバーローカル)。 */
  dataDatetime: string | null;
  /** 通信日時 "MM/DD HH:mm"。 */
  comuDatetime: string | null;
  /** 十進度 (DDMM から変換済み)。GPS 未捕捉は null。 */
  latitude: number | null;
  longitude: number | null;
  /** 速度 [km/h]。 */
  speed: number | null;
  /** エンジン回転数 [rpm]。 */
  revo: number | null;
  /** 総合状態 (運転 / 停車 等、lblAllState)。 */
  state: string | null;
  /** 道路種別 (高速 / 一般 等、lblState2)。 */
  roadType: string | null;
  /** 住所 (lblAddressDispC)。 */
  address: string | null;
  /** 乗務員 ("(コード)氏名")。 */
  driverName: string | null;
  /** データ種別 (動態 / イベント 等、lblReciveTypeName)。 */
  dataType: string | null;
}

/** postback 応答がログイン画面に戻されているか (セッション切れの検出)。 */
export function isLoginRedirect(html: string): boolean {
  return html.includes("txtPass") || html.includes("F-OES1010");
}

/** `application/x-www-form-urlencoded` の postback を送る (ASP.NET WebForms)。 */
function postFormEncoded(
  jar: CookieJar,
  url: string,
  params: URLSearchParams,
  fetchImpl: FetchLike,
): Promise<Response> {
  return fetchWithJar(
    jar,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
      body: params.toString(),
    },
    fetchImpl,
  );
}

/** VehicleDisp テーブルの 1 セル `<span id="lstVehicle_<field>_<idx>" ...>値</span>` を
 * 取り出す (中の入れ子タグは除去、空文字は null)。 */
function extractLogCell(html: string, field: string, idx: number): string | null {
  const m = html.match(
    new RegExp(`id="lstVehicle_${field}_${idx}"[^>]*>([\\s\\S]*?)</span>`),
  );
  if (!m) return null;
  const v = m[1].replace(/<[^>]*>/g, "").trim();
  return v === "" ? null : v;
}

function logCellNumber(html: string, field: string, idx: number): number | null {
  const s = extractLogCell(html, field, idx);
  if (s === null) return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

/** postback 応答 HTML の VehicleDisp テーブルを VehicleLogPoint[] に変換する。 */
export function parseVehicleLogRows(html: string): VehicleLogPoint[] {
  // 行 index は GPS 緯度セルの id 列挙で確定する (全行に必ず存在)。
  const indexes = [...html.matchAll(/id="lstVehicle_lblGPSLatitude_(\d+)"/g)].map((m) => Number(m[1]));
  return indexes.map((i) => ({
    dataDatetime: extractLogCell(html, "lblDataDateTime", i),
    comuDatetime: extractLogCell(html, "lblComuDateTime", i),
    latitude: convertDdmmToDegrees(extractLogCell(html, "lblGPSLatitude", i)),
    longitude: convertDdmmToDegrees(extractLogCell(html, "lblGPSLongitude", i)),
    speed: logCellNumber(html, "lblSpeed", i),
    revo: logCellNumber(html, "lblRevo", i),
    state: extractLogCell(html, "lblAllState", i),
    roadType: extractLogCell(html, "lblState2", i),
    address: extractLogCell(html, "lblAddressDispC", i),
    driverName: extractLogCell(html, "lblDriverName", i),
    dataType: extractLogCell(html, "lblReciveTypeName", i),
  }));
}

/**
 * 車輌 1 台の動態履歴 (速度・回転数・住所・状態付き)。実ページ F-DOV0010 と同じ
 * **2 段階 postback** で取る (2026-07-03 cdp 実機確定):
 *   1. GET でページ + hidden (__VIEWSTATE 等) 取得
 *   2. `btnBranch=絞込` postback で ddlVehicle に車輌一覧をロード (初期ページには
 *      車輌が入っておらず、ここを飛ばすと event validation で HTTP 500)
 *   3. `btnDataDisp=動態履歴` postback で VehicleDisp テーブルを取得 → span パース
 * 各 postback は直前応答の hidden を使う (event validation を通すため)。
 */
export async function getVehicleLogTrack(
  jar: CookieJar,
  vehicleCd: string,
  startDay: string,
  endDay: string,
  fetchImpl: FetchLike = fetch,
): Promise<VehicleLogPoint[]> {
  if (!/^\d+$/.test(vehicleCd)) {
    throw new DvrSearchParamError(`車輌CDは数値で指定してください: "${vehicleCd}"`);
  }
  if (!VEHICLE_LOG_DAY_RE.test(startDay) || !VEHICLE_LOG_DAY_RE.test(endDay)) {
    throw new DvrSearchParamError('日付は "YYYY/MM/DD" 形式で指定してください');
  }
  const url = `${BASE_URL}${VEHICLE_LOG_PATH}`;
  // ddlVehicle の option 値は 10 桁ゼロ埋め (実測 "0000001802")。
  const ddlVehicleValue = vehicleCd.padStart(10, "0");

  const getRes = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl);
  if (!getRes.ok) {
    throw new TheearthClientError(`動態履歴ページの取得が HTTP ${getRes.status} を返しました`);
  }
  const html1 = await getRes.text();
  if (isLoginRedirect(html1)) {
    throw new VenusSessionExpiredError(
      "動態履歴ページがログイン画面を返しました — theearth セッションが切れています",
    );
  }

  // 1 段目: 全事業所で絞込 → ddlVehicle に全車輌をロード。
  const branchParams = new URLSearchParams({
    ...extractHiddenFields(html1),
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __LASTFOCUS: "",
    ddlBranch: "00000000",
    txtVehicleCD: "",
    ddlVehicle: "0000000000",
    txtStartDate: startDay,
    txtEndDate: endDay,
    btnBranch: "絞込",
  });
  const branchRes = await postFormEncoded(jar, url, branchParams, fetchImpl);
  if (!branchRes.ok) {
    throw new TheearthClientError(`動態履歴の事業所絞込が HTTP ${branchRes.status} を返しました`);
  }
  const html2 = await branchRes.text();

  // 2 段目: 車輌 + 日付範囲で動態履歴を表示。
  const dispParams = new URLSearchParams({
    ...extractHiddenFields(html2),
    __EVENTTARGET: "",
    __EVENTARGUMENT: "",
    __LASTFOCUS: "",
    ddlBranch: "00000000",
    txtVehicleCD: vehicleCd,
    ddlVehicle: ddlVehicleValue,
    txtStartDate: startDay,
    txtEndDate: endDay,
    btnDataDisp: "動態履歴",
  });
  const dispRes = await postFormEncoded(jar, url, dispParams, fetchImpl);
  if (!dispRes.ok) {
    throw new TheearthClientError(`動態履歴の表示が HTTP ${dispRes.status} を返しました`);
  }
  const html3 = await dispRes.text();
  if (isLoginRedirect(html3)) {
    throw new VenusSessionExpiredError(
      "動態履歴の表示がログイン画面を返しました — theearth セッションが切れています",
    );
  }
  return parseVehicleLogRows(html3);
}

// --- DVR 動画ファイル (VenusBridge 経由、Refs #90 実ページ検証済み) ---
//
// ダウンロードパスは通知行から決定論的に組み立てられない (browser-render-rust#14 の
// 決定論パス仮説は実データで 404 だった)。実ページ (J-AAV0100) は:
//   1. VenusBridgeService.Request_DvrFileDownload(SerialNo, FileName) を呼ぶ
//      → d = [code, url, filename, key, err]。code>0 なら url がサーバー生成の相対パス
//   2. GET /dvrData/{url} を blob で取得
// という 2 段。転送 (車両から取得) が必要な場合は先に Request_DvrFileTransfer_target を
// 呼ぶ (下記)。

/** Request_DvrFileDownload が解決したダウンロード対象。 */
export interface DvrDownloadTarget {
  /** `/dvrData/` 配下の相対パス (`\` は `/` に正規化済み)。 */
  path: string;
  /** サーバーが返した表示用ファイル名 (.vdf 付き)。 */
  filename: string;
}

/** `Request_DvrFileDownload(SerialNo, FileName)` を呼び、`/dvrData/` 配下の実相対パスを
 * 解決する。code<=0 (未転送 / 未検出) は「まだダウンロードできない」ことを表すので、
 * 受信を促す TheearthClientError を投げる (Refs #90 実ページ検証済み)。 */
export async function requestDvrDownloadPath(
  jar: CookieJar,
  serialNo: string,
  fileName: string,
  fetchImpl: FetchLike = fetch,
): Promise<DvrDownloadTarget> {
  const d = await callVenusBridgeMethod(
    jar,
    "Request_DvrFileDownload",
    { key1: serialNo, key2: fileName },
    fetchImpl,
  );
  if (!Array.isArray(d) || d.length < 2) {
    throw new TheearthClientError(
      `Request_DvrFileDownload の応答形式が想定と異なります: ${JSON.stringify(d).slice(0, 200)}`,
    );
  }
  const code = Number(d[0]);
  const rawPath = typeof d[1] === "string" ? d[1] : "";
  if (!(code > 0) || !rawPath) {
    throw new TheearthClientError(
      "この映像はまだダウンロードできません (車両からの転送が完了していません)。" +
        "「受信」で車両に映像を要求し、状態が「再生可能」になってから再度お試しください。",
    );
  }
  // theearth はサーバー生成パスを Windows 区切り `\` で返す (最終要素の直前)。
  // URL では `/` に正規化する。path traversal は弾く (返り値はサーバー由来だが念のため)。
  const path = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (path.includes("..")) {
    throw new TheearthClientError(`不正なダウンロードパスが返されました: ${path}`);
  }
  const filename = typeof d[2] === "string" && d[2] ? d[2] : fileName;
  return { path, filename };
}

/** `Request_DvrFileTransfer_target(SerialNo, FileName)` を呼び、車両 (車載機) に映像
 * ファイルの転送を要求する (= 「車両から取得」の 1 段目)。転送は非同期で、完了後に
 * 通知一覧の receiveState が `in_progress` → `ready` に変わる。応答の先頭要素を
 * 結果コードとして返す (>0 で受理)。 */
export async function requestDvrFileTransfer(
  jar: CookieJar,
  serialNo: string,
  fileName: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ code: number; raw: unknown }> {
  const d = await callVenusBridgeMethod(
    jar,
    "Request_DvrFileTransfer_target",
    { key1: serialNo, key2: fileName },
    fetchImpl,
  );
  const code = Array.isArray(d) ? Number(d[0]) : Number(d);
  return { code: Number.isNaN(code) ? -1 : code, raw: d };
}

/** `/dvrData/{path}` の絶対 URL を組み立てる (requestDvrDownloadPath の正規化済み path 用)。 */
export function dvrDataUrl(relativePath: string): string {
  return `${BASE_URL}/dvrData/${relativePath}`;
}

const VDF_MAGIC = [0x4e, 0x45, 0x54, 0x37, 0x38, 0x30]; // ASCII "NET780"

/** `.vdf` (NET780 独自コンテナ) のマジックバイトを検証する。「黙って200」対策 —
 * ログイン切れの HTML ページを動画として browser に流さない。 */
export function assertVdfMagic(head: Uint8Array): void {
  const ok = head.length >= VDF_MAGIC.length && VDF_MAGIC.every((b, i) => head[i] === b);
  if (!ok) {
    throw new TheearthClientError(
      "取得したデータが NET780 (.vdf) 形式ではありません — " +
        "ログイン切れ、またはファイルパスの想定違いの可能性があります",
    );
  }
}

/**
 * body 先頭の NET780 マジックバイトを検証してから、buffer せずに素通しできる
 * ReadableStream を返す。`.vdf` は動画で数十 MB になり得るため、DO のメモリ /
 * storage に載せず stream で中継する (検証は status commit 前に済むので、
 * マジック不一致は 200 を返す前に loud fail できる)。
 */
export async function validateVdfMagicStream(
  body: ReadableStream<Uint8Array>,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const buffered: Uint8Array[] = [];
  let seen = 0;
  while (seen < VDF_MAGIC.length) {
    const { done, value } = await reader.read();
    if (done) {
      throw new TheearthClientError(
        `取得したデータが短すぎます (${seen} bytes) — NET780 (.vdf) 形式ではありません`,
      );
    }
    if (value.length === 0) continue;
    buffered.push(value);
    seen += value.length;
  }

  const head = new Uint8Array(VDF_MAGIC.length);
  let offset = 0;
  for (const chunk of buffered) {
    const take = Math.min(chunk.length, head.length - offset);
    head.set(chunk.subarray(0, take), offset);
    offset += take;
    if (offset >= head.length) break;
  }
  assertVdfMagic(head);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of buffered) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

/** DVR `.vdf` を cookie 付き GET し、マジックバイト検証済みの stream を返す。 */
export async function openDvrFileStream(
  jar: CookieJar,
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetchWithJar(jar, url, { method: "GET" }, fetchImpl);
  if (!res.ok) {
    throw new TheearthClientError(`DVR ファイル取得が HTTP ${res.status} を返しました`);
  }
  if (!res.body) {
    throw new TheearthClientError("DVR ファイル取得のレスポンスに body がありません");
  }
  return validateVdfMagicStream(res.body);
}
