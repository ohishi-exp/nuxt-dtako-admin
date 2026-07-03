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

  const json = (await res.json()) as unknown;
  if (json === null || typeof json !== "object" || !("d" in json)) {
    throw new TheearthClientError(
      `VenusBridge ${methodName} のレスポンスに "d" フィールドがありません: ${JSON.stringify(json).slice(0, 200)}`,
    );
  }
  return (json as { d: unknown }).d;
}

function toItemArray(d: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(d)) return d as Array<Record<string, unknown>>;
  if (d && typeof d === "object") {
    const rows = (d as { rows?: unknown }).rows
      ?? (d as { Rows?: unknown }).Rows
      ?? (d as { Table?: unknown }).Table;
    if (Array.isArray(rows)) return rows as Array<Record<string, unknown>>;
  }
  return null;
}

function pickStringField(record: Record<string, unknown>, candidates: readonly string[]): string | null {
  for (const key of candidates) {
    if (key in record && record[key] != null) return String(record[key]);
  }
  return null;
}

// --- DVR 動画通知 (Monitoring_DvrNotification2、browser-render-rust#14 で実機確認済み) ---

const DVR_VEHICLE_CD_CANDIDATES = ["vehicle_cd", "VehicleCD", "VehicleCd"] as const;
const DVR_VEHICLE_NAME_CANDIDATES = ["vehicle_name", "VehicleName"] as const;
const DVR_SERIAL_NO_CANDIDATES = ["serial_no", "SerialNo"] as const;
const DVR_FILE_NAME_CANDIDATES = ["file_name", "FileName"] as const;
const DVR_FILE_PATH_CANDIDATES = ["file_path", "FilePath"] as const;
const DVR_EVENT_TYPE_CANDIDATES = ["event_type", "EventType"] as const;
const DVR_DATETIME_CANDIDATES = ["dvr_datetime", "DvrDatetime", "DvrDateTime"] as const;
const DVR_DRIVER_NAME_CANDIDATES = ["driver_name", "DriverName"] as const;

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
