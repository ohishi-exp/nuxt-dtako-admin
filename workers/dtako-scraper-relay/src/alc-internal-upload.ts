/**
 * rust-alc-api `POST /api/upload` への csvdata.zip 自動アップロード
 * (Refs ohishi-exp/dtako-scraper#22, ippoan/rust-alc-api#434 caller #4b)。
 *
 * このDOはブラウザ JWT を持たない server-to-server caller で、かつ
 * `comp_id` が複数 tenant にまたがる (nuxt-dtako-admin の管理者は自分の
 * tenant と無関係な comp_id もトリガーできる)。よって:
 *
 * - `device-data-proxy` (device JWT が要る = pairing が要る、Worker が device
 *   になるのは不自然) は不採用
 * - `alc-proxy` (browser JWT の tenant_id を逆引き) も不採用 — トリガーした
 *   管理者の tenant と comp_id の tenant が一致するとは限らないため、
 *   誤った tenant に書き込む恐れがある
 * - `alc-internal-proxy` の shared-secret 経路 (email-receiver が
 *   `/api/dtako/tickets` で使うのと同じ) を採用。`DTAKO_ACCOUNTS` (comp_id ->
 *   tenant_id) から解決した **正しい tenant_id を明示 `X-Tenant-ID` で渡す**。
 *
 * consumer が付けるのは `X-Alc-Proxy-Secret` (INTERNAL_SHARED_SECRET、consumer
 * worker proof) + `X-Tenant-ID` の 2 つだけ。OIDC mint / rust 向け
 * `X-Internal-Shared-Secret` の付与は auth-worker 側 (alc-internal-proxy.ts)
 * に集約されている。
 */

/** service binding fetch 用の絶対 URL base。host は binding が無視するが path が
 * `/alc-internal-proxy/...` で始まる必要がある (auth-worker 側が prefix を slice
 * して rust-alc-api に forward するため)。email-receiver の dtako.ts と同じ規約。 */
const INTERNAL_PROXY_BASE = "https://auth-worker.internal";

export class AlcInternalUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AlcInternalUploadError";
  }
}

export type FetchLike = typeof fetch;

export interface AlcInternalUploadInput {
  sharedSecret: string;
  tenantId: string;
  filename: string;
  zipBytes: ArrayBuffer;
}

/** `multipart/form-data` body を手組みする (rust-alc-api の `extract_file` は
 * フィールド名 `file` を要求する、`crates/alc-dtako/src/dtako_upload.rs` 参照)。 */
function buildMultipartBody(
  boundary: string,
  filename: string,
  zipBytes: ArrayBuffer,
): ArrayBuffer {
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/zip\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const combined = new Uint8Array(head.byteLength + zipBytes.byteLength + tail.byteLength);
  combined.set(head, 0);
  combined.set(new Uint8Array(zipBytes), head.byteLength);
  combined.set(tail, head.byteLength + zipBytes.byteLength);
  return combined.buffer;
}

/** `AUTH_WORKER` service binding 経由で `/alc-internal-proxy/api/upload` に zip を送る。 */
export async function uploadDtakoZipViaAlcInternalProxy(
  input: AlcInternalUploadInput,
  fetchImpl: FetchLike,
): Promise<string> {
  const boundary = `----dtakoScraperRelay${crypto.randomUUID().replace(/-/g, "")}`;
  const body = buildMultipartBody(boundary, input.filename, input.zipBytes);

  const res = await fetchImpl(`${INTERNAL_PROXY_BASE}/alc-internal-proxy/api/upload`, {
    method: "POST",
    headers: {
      "X-Alc-Proxy-Secret": input.sharedSecret,
      "X-Tenant-ID": input.tenantId,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AlcInternalUploadError(`alc-internal-proxy upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return text;
}
