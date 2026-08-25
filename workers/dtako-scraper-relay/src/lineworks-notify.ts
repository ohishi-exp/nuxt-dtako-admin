/**
 * LINE WORKS へのテキスト通知 — rust-alc-api の `POST /api/internal/lineworks/send`
 * を `AUTH_WORKER` service binding 経由で叩く (Refs #874 の 8)。
 *
 * **なぜ relay が自前で LINE WORKS を叩かないか** (#874-1 / PR #875 の作り直し):
 * 同じ Bot クライアント (JWT RS256 → token → messages) が rust-alc-api の
 * `alc-notify` に既にあり、**credential も通知先チャンネルも DB で一元管理**
 * されている (`lineworks_channels` テーブル、`SSO_ENCRYPTION_KEY` で rust が復号)。
 * relay に 2 つ目の実装と 2 つ目の credential 置き場 (Secrets Store の Bot
 * credential entry) を持つと、Bot を差し替えたときに片方だけ古くなる。よって
 * relay からは「どのチャンネルへ何を送るか」だけを渡し、Bot の資格情報は一切
 * 持たない。
 *
 * **なぜ既存の `POST /notify/lineworks/channels/{id}/test-send` ではないか**:
 * あちらは tenant 経路 (`require_tenant_header`) で、auth-worker の
 * `alc-internal-proxy` は tenant 経路の forward を明確に禁じている (shared secret
 * だけで `X-Tenant-ID` を詐称できてしまうため)。無人の cron から叩ける口として
 * `internal_router()` 側に `/api/internal/lineworks/send` を新設した (#874-6)。
 *
 * **consumer が付けるヘッダは `X-Alc-Proxy-Secret` (= `INTERNAL_SHARED_SECRET`)
 * だけ。** auth-worker 側 (`alc-internal-proxy.ts` の `internal-jwt` クラス) が
 * `Authorization` を `internalAuthToken` (aud=alc-api-internal) に差し替えて
 * forward する。`X-Internal-Shared-Secret` も `X-Tenant-ID` も relay は付けない
 * (付けても forward されない — tenant は rust が channel の id 引きで解決する)。
 *
 * 非 2xx は本文付き loud fail (`alc-internal-upload.ts` と同じ流儀 — 通知が
 * 飛ばなかったことを黙って握らない)。
 */

/** service binding fetch 用の絶対 URL base。host は binding が無視するが path が
 * `/alc-internal-proxy/...` で始まる必要がある (auth-worker 側が prefix を slice
 * して rust-alc-api に forward するため)。`alc-internal-upload.ts` と同じ規約。 */
const INTERNAL_PROXY_BASE = "https://auth-worker.internal";

/** auth-worker の allowlist (`classifyInternalPath`) に `internal-jwt` クラスで
 * 載っているパス (#874-7)。**POST のみ許可**されている。 */
export const LINEWORKS_SEND_PATH = "/alc-internal-proxy/api/internal/lineworks/send";

export class LineworksNotifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineworksNotifyError";
  }
}

export type FetchLike = typeof fetch;

export interface LineworksNotifyInput {
  /** `INTERNAL_SHARED_SECRET` (consumer worker proof)。 */
  sharedSecret: string;
  /** DB `lineworks_channels` の行 id (Uuid)。**LINE WORKS の channelId そのもの
   * ではない** — Bot / tenant / 実チャンネルの対応は rust 側が DB で引く。 */
  channelId: string;
  text: string;
}

/** `POST /api/internal/lineworks/send` の request body。 */
export function buildLineworksSendBody(channelId: string, text: string): string {
  return JSON.stringify({ channel_id: channelId, text });
}

/**
 * `AUTH_WORKER` service binding 経由で LINE WORKS へテキストを 1 通送る。
 *
 * 成功時の応答本文は読まない (rust 側は送信完了を 2xx で表す。message id 等を
 * relay が使う予定は無いので、増えたフィールドに依存しない)。
 */
export async function sendLineworksTextViaAlcInternalProxy(
  input: LineworksNotifyInput,
  fetchImpl: FetchLike,
): Promise<void> {
  const res = await fetchImpl(`${INTERNAL_PROXY_BASE}${LINEWORKS_SEND_PATH}`, {
    method: "POST",
    headers: {
      "X-Alc-Proxy-Secret": input.sharedSecret,
      "Content-Type": "application/json",
    },
    body: buildLineworksSendBody(input.channelId, input.text),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new LineworksNotifyError(
      `LINE WORKS 送信失敗 (HTTP ${res.status}, channel ${input.channelId}): ${text.slice(0, 300)}`,
    );
  }
}
