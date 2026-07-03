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
}

/** 実データの Latitude/Longitude は度 × 1e6 の整数。度に変換する (既に度なら素通し)。 */
function pickDegreeField(record: Record<string, unknown>, candidates: readonly string[]): number | null {
  for (const key of candidates) {
    if (key in record) {
      const v = record[key];
      const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
      if (!Number.isNaN(n) && n !== 0) {
        // |緯度| ≤ 90 / |経度| ≤ 180 を超える大きさは 1e6 スケールとみなす。
        return Math.abs(n) > 180 ? n / 1e6 : n;
      }
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
  }));
}

// --- DVR 動画ファイル (決定論的パス、browser-render-rust#14 で実機確認済み) ---

const SAFE_SEGMENT = /^[A-Za-z0-9_-]+$/;

function assertSafeSegment(name: string, value: string): void {
  if (!SAFE_SEGMENT.test(value)) {
    throw new TheearthClientError(`不正な DVR ファイルパスセグメント (${name}): ${value}`);
  }
}

/** `/dvrData/{comp_id}/{support_id}/{vehicleCD}/{filename}/{filename}.vdf` という
 * 決定論的パスを組み立てる (Refs browser-render-rust#14)。各セグメントは英数字/アンダー
 * スコア/ハイフンのみを許可し、path traversal / 想定外パスへの SSRF を防ぐ。 */
export function buildDvrFileUrl(
  compId: string,
  supportId: string,
  vehicleCd: string,
  filename: string,
): string {
  assertSafeSegment("compId", compId);
  assertSafeSegment("supportId", supportId);
  assertSafeSegment("vehicleCd", vehicleCd);
  assertSafeSegment("filename", filename);
  return `${BASE_URL}/dvrData/${compId}/${supportId}/${vehicleCd}/${filename}/${filename}.vdf`;
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
