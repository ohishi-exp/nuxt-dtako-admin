/**
 * LINE WORKS Bot API クライアント (Refs #874)。
 *
 * netprint cron (#874-4) がプリント予約番号をトークルームへ通知するのに使う。
 * Service Account 認証: JWT (RS256) を private key で自前署名し
 * `POST https://auth.worksmobile.com/oauth2/v2.0/token` (grant_type=jwt-bearer,
 * scope=bot) で access_token に交換 → `POST /v1.0/bots/{botId}/channels/{channelId}/messages`
 * でテキスト送信する。
 *
 * 署名は WebCrypto (`crypto.subtle.importKey("pkcs8", ...)` + RSASSA-PKCS1-v1_5) で
 * 行う — Workers runtime と node vitest の両方にあるため、テストは実鍵
 * (generateKey) で署名経路まで通せる。
 *
 * credential は 1 個の JSON secret `LINEWORKS_BOT`
 * (`{client_id, client_secret, service_account, private_key, bot_id}`) に
 * まとめる。未設定 / JSON 不正 / フィールド欠落は loud fail
 * (`LineworksConfigError`) — 既存規約どおり fail-closed で、黙って通知を
 * スキップしない (cron.ts の CronConfigError と同じ流儀。あちらの「未設定は
 * [] で skip」とは違い、こちらは呼ばれた時点で設定されているべきもの)。
 *
 * HTTP の非 2xx も本文付きで throw (`LineworksClientError`) — 黙って握らない。
 */

export const LINEWORKS_TOKEN_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
export const LINEWORKS_API_BASE = "https://www.worksapis.com/v1.0";

/** Service Account JWT の有効期間 (秒)。LINE WORKS Developers の案内どおり
 * `exp = iat + 3600` 固定。 */
export const JWT_LIFETIME_SECONDS = 3600;

/** access_token の残寿命がこの比率を切ったら失効扱いにする (期限ぎりぎりの
 * token で送信して境界で 401 を踏まないための余裕)。 */
export const TOKEN_REFRESH_RATIO = 0.9;

export type FetchLike = typeof fetch;

/** credential (JSON secret) の不備。設定を直すまで何度呼んでも失敗する種類の
 * エラーで、リトライ対象ではない。 */
export class LineworksConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineworksConfigError";
  }
}

/** LINE WORKS API との通信失敗 (非 2xx / 応答形の不一致)。 */
export class LineworksClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineworksClientError";
  }
}

export interface LineworksBotConfig {
  client_id: string;
  client_secret: string;
  service_account: string;
  /** PEM (PKCS#8, `-----BEGIN PRIVATE KEY-----`) の private key。 */
  private_key: string;
  bot_id: string;
}

const CONFIG_FIELDS = [
  "client_id",
  "client_secret",
  "service_account",
  "private_key",
  "bot_id",
] as const;

/** `LINEWORKS_BOT` (JSON secret) をパースする。未設定 / JSON 不正 /
 * フィールド欠落は loud fail。 */
export function parseLineworksBotConfig(raw: string | undefined): LineworksBotConfig {
  if (!raw) {
    throw new LineworksConfigError("LINEWORKS_BOT が未設定です");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LineworksConfigError("LINEWORKS_BOT が JSON としてパースできません");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LineworksConfigError("LINEWORKS_BOT は JSON オブジェクトである必要があります");
  }
  const obj = parsed as Record<string, unknown>;
  for (const field of CONFIG_FIELDS) {
    const value = obj[field];
    if (typeof value !== "string" || value === "") {
      throw new LineworksConfigError(`LINEWORKS_BOT.${field} がありません`);
    }
  }
  return {
    client_id: obj.client_id as string,
    client_secret: obj.client_secret as string,
    service_account: obj.service_account as string,
    private_key: obj.private_key as string,
    bot_id: obj.bot_id as string,
  };
}

/** base64url (padding 無し)。JWT の各セグメントと署名に使う。 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** JWT の署名対象 (`base64url(header).base64url(claims)`) を組み立てる。
 * claims は LINE WORKS Service Account 認証の指定どおり
 * `{iss: client_id, sub: service_account, iat, exp: iat+3600}`。 */
export function buildJwtSigningInput(
  config: Pick<LineworksBotConfig, "client_id" | "service_account">,
  iatSeconds: number,
): string {
  const encoder = new TextEncoder();
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: config.client_id,
    sub: config.service_account,
    iat: iatSeconds,
    exp: iatSeconds + JWT_LIFETIME_SECONDS,
  };
  return (
    base64UrlEncode(encoder.encode(JSON.stringify(header))) +
    "." +
    base64UrlEncode(encoder.encode(JSON.stringify(claims)))
  );
}

/** PEM (PKCS#8) を `crypto.subtle.importKey("pkcs8", ...)` に渡せる DER bytes に
 * する。ヘッダ欠落 / base64 不正は loud fail (importKey の DOMException より先に
 * 「credential の形が違う」と分かる形で落とす)。 */
export function pemToPkcs8Bytes(pem: string): ArrayBuffer {
  const match = /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/.exec(pem);
  if (!match) {
    throw new LineworksConfigError(
      "private_key が PKCS#8 PEM (-----BEGIN PRIVATE KEY-----) ではありません",
    );
  }
  const base64 = match[1].replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw new LineworksConfigError("private_key の base64 がデコードできません");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** signing input を RS256 (RSASSA-PKCS1-v1_5 + SHA-256) で署名し、完成した JWT を
 * 返す。 */
export async function signJwtRs256(signingInput: string, privateKeyPem: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return signingInput + "." + base64UrlEncode(new Uint8Array(signature));
}

/** token endpoint への `application/x-www-form-urlencoded` body。 */
export function buildTokenRequestBody(
  config: Pick<LineworksBotConfig, "client_id" | "client_secret">,
  assertion: string,
): string {
  return new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
    client_id: config.client_id,
    client_secret: config.client_secret,
    scope: "bot",
  }).toString();
}

export interface LineworksToken {
  accessToken: string;
  /** 有効期間 (秒)。LINE WORKS は文字列 ("86400") で返すことがあるため
   * パース側で number に正規化する。 */
  expiresInSeconds: number;
}

/** token endpoint の応答をパースする。`access_token` / `expires_in` が読めない
 * 応答は loud fail (200 でもエラー JSON を握って進まない)。 */
export function parseTokenResponse(body: string): LineworksToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new LineworksClientError(
      `token 応答が JSON ではありません: ${body.slice(0, 300)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LineworksClientError(
      `token 応答が JSON オブジェクトではありません: ${body.slice(0, 300)}`,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const accessToken = obj.access_token;
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new LineworksClientError(
      `token 応答に access_token がありません: ${body.slice(0, 300)}`,
    );
  }
  const expiresIn =
    typeof obj.expires_in === "string" ? Number(obj.expires_in) : obj.expires_in;
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new LineworksClientError(
      `token 応答の expires_in が読めません: ${body.slice(0, 300)}`,
    );
  }
  return { accessToken, expiresInSeconds: expiresIn };
}

/** 取得した token を失効扱いにする時刻 (ms epoch)。`expires_in` の 9 割
 * ([`TOKEN_REFRESH_RATIO`]) で切る。 */
export function tokenExpiresAtMs(obtainedAtMs: number, expiresInSeconds: number): number {
  return obtainedAtMs + expiresInSeconds * TOKEN_REFRESH_RATIO * 1000;
}

/** メッセージ送信 URL。botId / channelId は path segment なので encode する。 */
export function buildMessageUrl(botId: string, channelId: string): string {
  return `${LINEWORKS_API_BASE}/bots/${encodeURIComponent(botId)}/channels/${encodeURIComponent(channelId)}/messages`;
}

/** テキストメッセージの request body。 */
export function buildTextMessageBody(text: string): string {
  return JSON.stringify({ content: { type: "text", text } });
}

/** Service Account 認証で access_token を取得する。非 2xx は本文付きで throw。 */
export async function fetchLineworksAccessToken(
  config: LineworksBotConfig,
  fetchImpl: FetchLike = fetch,
  nowMs: number = Date.now(),
): Promise<LineworksToken> {
  const signingInput = buildJwtSigningInput(config, Math.floor(nowMs / 1000));
  const assertion = await signJwtRs256(signingInput, config.private_key);
  const res = await fetchImpl(LINEWORKS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: buildTokenRequestBody(config, assertion),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new LineworksClientError(
      `token 取得失敗 (HTTP ${res.status}): ${body.slice(0, 300)}`,
    );
  }
  return parseTokenResponse(body);
}

/**
 * Bot でトークルームへテキストを送るクライアント。token は expires_in の 9 割まで
 * メモ化して使い回す (同じ cron 実行内で複数 channel に送っても token 取得は
 * 1 回で済む)。
 */
export class LineworksBotClient {
  private cachedToken: string | null = null;
  private cachedTokenExpiresAtMs = 0;

  constructor(
    private readonly config: LineworksBotConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async getAccessToken(nowMs: number = Date.now()): Promise<string> {
    if (this.cachedToken !== null && nowMs < this.cachedTokenExpiresAtMs) {
      return this.cachedToken;
    }
    const token = await fetchLineworksAccessToken(this.config, this.fetchImpl, nowMs);
    this.cachedToken = token.accessToken;
    this.cachedTokenExpiresAtMs = tokenExpiresAtMs(nowMs, token.expiresInSeconds);
    return token.accessToken;
  }

  /** チャンネルへテキストを 1 通送る。非 2xx は本文付きで throw。 */
  async sendText(channelId: string, text: string, nowMs: number = Date.now()): Promise<void> {
    const accessToken = await this.getAccessToken(nowMs);
    const res = await this.fetchImpl(buildMessageUrl(this.config.bot_id, channelId), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: buildTextMessageBody(text),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new LineworksClientError(
        `メッセージ送信失敗 (HTTP ${res.status}, channel ${channelId}): ${body.slice(0, 300)}`,
      );
    }
  }
}
