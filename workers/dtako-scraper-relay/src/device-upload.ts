/**
 * dtako-scraper (Rust版) の device credential アップロードプロトコルを移植したもの。
 * auth-worker の device JWT 発行 (`/device/token`) + device-data-proxy 経由の
 * rust-alc-api `/api/upload` へのアップロードを行う。
 *
 * ohishi-exp/dtako-scraper の `src/device_auth.rs` / `src/scraper/upload.rs` と
 * 同一プロトコル。device-data-proxy は JWT の `tenant_id` claim を無条件に信頼する
 * ため (なりすまし防止の要)、`assertTenantMatches` で呼び出し元が期待する tenant_id
 * と応答の `tenant_id` の一致を必ず確認する (dtako-scraper の
 * `mint_device_token_for_tenant` と同じガード)。
 */

export class DeviceUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceUploadError";
  }
}

export type FetchLike = typeof fetch;

export interface DeviceCredential {
  deviceId: string;
  deviceSecret: string;
}

interface DeviceTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  tenant_id: string;
}

/** auth-worker `POST /device/token` で device JWT を発行する。応答の tenant_id が
 * `expectedTenantId` と一致しなければ throw する (誤発行・誤登録の早期検知)。 */
export async function mintDeviceToken(
  authWorkerUrl: string,
  credential: DeviceCredential,
  expectedTenantId: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const res = await fetchImpl(`${authWorkerUrl}/device/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: credential.deviceId, device_secret: credential.deviceSecret }),
  });
  if (!res.ok) {
    throw new DeviceUploadError(`device/token が HTTP ${res.status} を返しました: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as DeviceTokenResponse;
  if (data.tenant_id !== expectedTenantId) {
    throw new DeviceUploadError(
      `device credential の tenant_id 不一致です (期待: ${expectedTenantId}, 実際: ${data.tenant_id}) — ` +
        "DTAKO_DEVICE_CREDENTIALS の登録間違いの可能性があります",
    );
  }
  return data.access_token;
}

/** device-data-proxy 経由で rust-alc-api `/api/upload` に zip を multipart POST する。
 * X-Tenant-ID は付与しない (device-data-proxy が JWT の tenant_id claim から注入するため、
 * client からの値は無視される)。 */
export async function uploadZipViaDevice(
  authWorkerUrl: string,
  accessToken: string,
  filename: string,
  zipBytes: ArrayBuffer,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([zipBytes], { type: "application/zip" }), filename);

  const res = await fetchImpl(`${authWorkerUrl}/device-data-proxy/api/upload`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    body: form,
  });
  const body = await res.text();
  if (!res.ok) {
    throw new DeviceUploadError(`アップロードが HTTP ${res.status} を返しました: ${body.slice(0, 200)}`);
  }
  return body;
}

/** ログイン → CSV ダウンロードで得た zip を、device credential 経由で
 * rust-alc-api にアップロードする一連の処理。 */
export async function uploadDtakoZip(
  authWorkerUrl: string,
  credential: DeviceCredential,
  tenantId: string,
  filename: string,
  zipBytes: ArrayBuffer,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const accessToken = await mintDeviceToken(authWorkerUrl, credential, tenantId, fetchImpl);
  return uploadZipViaDevice(authWorkerUrl, accessToken, filename, zipBytes, fetchImpl);
}
