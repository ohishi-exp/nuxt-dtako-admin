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
 * **宛先はトークルーム (channel) と個人 (recipient) の 2 種類**があり、rust 側は
 * `{channel_id?, recipient_id?, text}` の**どちらか一方だけ**を受ける (両方 / 両方
 * 無しは 400、Refs #874 の 9)。実運用ではトークルームが 1 件も登録されておらず
 * `notify_recipients` の個人宛が使われるため、relay 側も両方を渡せる必要がある。
 * 「どちらの id か」を呼び出し側が取り違えると**別人へ誤配して取り消せない**ので、
 * 文字列 1 本ではなく [`LineworksDestination`] (種別 + id) で受ける。
 *
 * 非 2xx は本文付き loud fail (`alc-internal-upload.ts` と同じ流儀 — 通知が
 * 飛ばなかったことを黙って握らない)。**種別も message に載せる** — 同じ Uuid 形式
 * なので、id だけでは「channel の id を recipient として送った」を読み取れない。
 *
 * **rust が返す error code (`recipient_not_found` / `recipient_disabled` /
 * `recipient_not_lineworks` / `target_ambiguous` 等) で relay 側は分岐しない**
 * (#887 で確立した方針)。status と本文をそのまま detail に載せれば、運用者は
 * #874 の表を見て原因を特定できる — 「行が無い」と「無効化されている」を別 code に
 * 分けているのは、まさにその切り分けのためで、relay がそれを畳むと情報が減る。
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

/** 送信先の種別。**どちらも Uuid で見分けが付かない**ので、id と対で運ぶ。
 *
 * - `channel` — DB `lineworks_channels` の行 id。**LINE WORKS の channelId そのもの
 *   ではない** (Bot / tenant / 実チャンネルの対応は rust 側が DB で引く)
 * - `recipient` — DB `notify_recipients` の行 id (個人宛)
 */
export type LineworksDestinationKind = "channel" | "recipient";

/** 送信先 1 件。`kind` がそのまま rust 側の body キー (`channel_id` /
 * `recipient_id`) を決める。 */
export interface LineworksDestination {
  kind: LineworksDestinationKind;
  id: string;
}

export interface LineworksNotifyInput {
  /** `INTERNAL_SHARED_SECRET` (consumer worker proof)。 */
  sharedSecret: string;
  /** トークルーム宛か個人宛か + その行 id。 */
  destination: LineworksDestination;
  text: string;
}

/** `POST /api/internal/lineworks/send` の request body。**指定した側のキーだけを
 * 出す** — rust 側は「両方あり」を 400 にするので、`null` を載せて片方を明示的に
 * 空にする形は取らない (#874-9)。 */
export function buildLineworksSendBody(destination: LineworksDestination, text: string): string {
  const target =
    destination.kind === "channel" ? { channel_id: destination.id } : { recipient_id: destination.id };
  return JSON.stringify({ ...target, text });
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
    body: buildLineworksSendBody(input.destination, input.text),
  });
  if (!res.ok) {
    const text = await res.text();
    const { kind, id } = input.destination;
    throw new LineworksNotifyError(
      `LINE WORKS 送信失敗 (HTTP ${res.status}, ${kind} ${id}): ${text.slice(0, 300)}`,
    );
  }
}

/** 宛先 id (`channel_id` / `recipient_id` のどちらも DB の行 id) の形。Uuid で
 * ないものは DB を引くまでもなく設定ミスなので、alc へ投げる前に弾く —
 * 「LINE WORKS の channelId をそのまま貼った」を静かに 404 にせず、設定した人に
 * 見える形で落とすため。**この検証をするのはここだけ** — auth-worker の allowlist
 * は path しか見ず (宛先は body にある)、rust 側の 404 は「DB に無い行」と
 * 「そもそも id の形ではない」を区別しない。
 *
 * **通知を出す cron が増えるたびに書き写さない** (Refs #967)。#874 で
 * `NETPRINT_TARGETS` 用に書いた規則を、#967 の `SCRAPE_ALERT_TARGET` が
 * そのまま使う — 宛先の表 (`lineworks_channels` / `notify_recipients`) は
 * 通知の種類で変わらないので、規則も文言も 1 か所に置く。 */
export const LINEWORKS_DESTINATION_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 設定 JSON から読んだ宛先の生の形。**`unknown` で受ける** — 設定 JSON は
 * 素通しされてくるので、型が言うほど string とは限らない。 */
export interface LineworksDestinationConfig {
  channel_id?: unknown;
  recipient_id?: unknown;
}

export type LineworksDestinationResolution =
  | { ok: true; destination: LineworksDestination }
  | { ok: false; error: string };

/**
 * `channel_id` / `recipient_id` から送信先を 1 つ決める。
 *
 * **どちらか一方だけ**が要る (rust の `POST /api/internal/lineworks/send` が
 * 両方 / 両方無しを 400 にするのと同じ規則、#874-9)。ここで弾くのは往復を
 * 減らすためではなく、**設定した人がその場で直せる日本語**を返すため —
 * rust の 400 は relay の `detail` を経て画面に出るころには HTTP status に
 * 潰れている。
 *
 * 非文字列 (数値・null 等) は「無い」に倒す。
 */
export function resolveLineworksDestination(
  config: LineworksDestinationConfig,
): LineworksDestinationResolution {
  const channelId = typeof config.channel_id === "string" ? config.channel_id.trim() : "";
  const recipientId = typeof config.recipient_id === "string" ? config.recipient_id.trim() : "";
  if (channelId !== "" && recipientId !== "") {
    return { ok: false, error: "channel_id と recipient_id はどちらか一方だけ指定してください" };
  }
  if (channelId === "" && recipientId === "") {
    return { ok: false, error: "channel_id と recipient_id のどちらか一方を指定してください" };
  }
  const destination: LineworksDestination =
    channelId !== "" ? { kind: "channel", id: channelId } : { kind: "recipient", id: recipientId };
  if (!LINEWORKS_DESTINATION_ID_RE.test(destination.id)) {
    return { ok: false, error: describeBadLineworksDestinationId(destination.kind) };
  }
  return { ok: true, destination };
}

/** Uuid でない宛先 id の理由。**どの表を引く id なのか**まで書く (設定した人が
 * 画面のどこから値を持ってくればよいか分かるように)。 */
function describeBadLineworksDestinationId(kind: LineworksDestinationKind): string {
  return kind === "channel"
    ? "channel_id が UUID 形式ではありません (lineworks_channels の行 id を指定してください)"
    : "recipient_id が UUID 形式ではありません (notify_recipients の行 id を指定してください)";
}
