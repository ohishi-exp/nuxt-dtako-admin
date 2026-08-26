/**
 * `AUTH_WORKER` service binding 経由で **device JWT を mint し、`/device-data-proxy`
 * 越しに alc の tenant (data) 経路を叩く**ための pure ロジック
 * (Refs #931 / #933、案 B)。
 *
 * ## なぜ `alc-internal-proxy` ではないのか
 *
 * alc の `/api/scraper/history` と `/api/dtako/events/etags` は rust 側で
 * `tenant_router()` = `require_tenant_header` の **data 経路**。
 * `alc-internal-proxy` は **data 経路を意図的に allowlist から外している** —
 * shared secret だけで `X-Tenant-ID` を詐称できると #434 の脆弱性の再現になるため。
 * ⇒ **GET / POST とも 403 `{"error":"forbidden"}` で上流へ forward もされない**
 * (実測。`classifyInternalPath` に path が無い。method の差ではない)。
 *
 * `device-data-proxy` は **その穴を埋めるために作られた第三の経路**で、
 * `X-Tenant-ID` を **device record 由来**で auth-worker が注入する
 * (client からは詐称不能)。**rust-alc-api 側は無変更**で通る。
 *
 * ## トークンをキャッシュしない理由
 *
 * device JWT の TTL は 1h (`DEVICE_JWT_TTL_SECONDS`)。一方 mint が要る場面は
 * 日次 cron (1 日 1 回) と履歴の読み (人が叩いた時) だけで、**1 日数回**しかない。
 * 期限切れの判定と保存場所を持つ方が、得られる節約より高くつく。
 * ⇒ **毎回 mint する。**
 */

/** `fetch` 互換 (`AUTH_WORKER.fetch.bind(...)` をそのまま渡せる形)。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const AUTH_WORKER_BASE = "https://auth-worker.internal";
const DEVICE_TOKEN_PATH = "/device/token";
/** auth-worker がこの prefix を slice して alc の path にする。 */
const DEVICE_DATA_PROXY_PREFIX = "/device-data-proxy";

/**
 * 1 tenant ぶんの device credential。**長命**なので KV から読む値であって、
 * ここでは値を組み立てない (`device_secret` は pairing の応答 1 回限りで、
 * 人が投入する)。
 */
export interface DtakoDeviceCredential {
  deviceId: string;
  deviceSecret: string;
}

/** mint した短命 device JWT。 */
export interface DeviceJwt {
  accessToken: string;
  /** auth-worker が device record から返す tenant。**呼び手の申告ではない。** */
  tenantId: string;
}

/**
 * `POST /device/token` で device credential を短命 device JWT に交換する。
 *
 * **失敗は握らずに throw する** — トークンが取れないのに続けても 401 が並ぶだけで、
 * 原因が分からなくなる。取り込み本体を巻き添えにしない責任は
 * `recordScrapeHistoryLoud` (書き) と呼び出し側 (読み) が持つ。
 */
export async function requestDeviceJwt(
  cred: DtakoDeviceCredential,
  fetchImpl: FetchLike,
): Promise<DeviceJwt> {
  const res = await fetchImpl(`${AUTH_WORKER_BASE}${DEVICE_TOKEN_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: cred.deviceId, device_secret: cred.deviceSecret }),
  });
  const text = await res.text();
  if (!res.ok) {
    // **device_secret は載せない。** status と本文抜粋だけ (auth-worker 側は
    // `invalid_credential` / `server_error` のような短い JSON を返す)。
    throw new Error(`device token mint failed (${res.status}): ${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`device token parse failed: ${text.slice(0, 300)}`);
  }
  const obj = parsed as { access_token?: unknown; tenant_id?: unknown };
  if (typeof obj.access_token !== "string" || !obj.access_token) {
    throw new Error("device token response has no access_token");
  }
  if (typeof obj.tenant_id !== "string" || !obj.tenant_id) {
    throw new Error("device token response has no tenant_id");
  }
  return { accessToken: obj.access_token, tenantId: obj.tenant_id };
}

/**
 * `/device-data-proxy` 越しの URL を組む。
 *
 * **allowlist は pathname だけを見る** (`ROLE_PATH_ALLOWLIST` の `Set.has`) ので、
 * query は自由に付けられる (auth-worker は `url.search` をそのまま forward する)。
 */
export function deviceProxyUrl(alcPath: string, search = ""): string {
  return `${AUTH_WORKER_BASE}${DEVICE_DATA_PROXY_PREFIX}${alcPath}${search}`;
}

/**
 * device JWT を付けた GET。**`X-Tenant-ID` は付けない** — auth-worker が
 * device record から注入するので、こちらが送っても使われない (送ると
 * 「詐称できる」と誤読させる)。
 */
export async function deviceProxyGet(
  alcPath: string,
  search: string,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  return fetchImpl(deviceProxyUrl(alcPath, search), {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

/** device JWT を付けた JSON POST。 */
export async function deviceProxyPostJson(
  alcPath: string,
  body: unknown,
  accessToken: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  return fetchImpl(deviceProxyUrl(alcPath), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}
