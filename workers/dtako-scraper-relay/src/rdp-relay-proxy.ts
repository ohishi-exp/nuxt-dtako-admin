/**
 * `/ws/rdp` — ブラウザ内 RemoteApp ビューア (IronRDP/WASM) と、オンプレの RDP 中継
 * (`rust-ichibanboshi` の `rdp-relay`) を繋ぐ WebSocket 中継。
 *
 * 経路 (**具体的な host / tunnel 名はここに書かない — この repo は public**。
 * 実際の宛先は VPC Service 側の設定が持つ):
 *
 *   ブラウザ ──WS──> app worker ──service binding──> この worker
 *            ──Workers VPC binding──> 社内の RDP 中継 ──TLS──> RemoteApp
 *
 * **なぜ Worker を挟むのか。** ブラウザの WebSocket は JS から開くのでヘッダを足せず、
 * Cloudflare Access の cookie も別オリジン宛には (SameSite 次第で) 飛ばない。中継を
 * 公開ホスト名で出して Access に守らせる形はそこで成立しない。アプリと同一オリジンの
 * `/ws/rdp` で受けてここで認証すれば、その問題が丸ごと消える。中継はインターネットに
 * 出さず、VPC binding からしか届かない。
 *
 * 認証は `/ws/scraper` と同じ — browser の auth-worker JWT を `token` クエリで受け、
 * `/auth/introspect` が `active` を返すことだけ確かめる (`decideRelayAuth`)。
 * WebSocket はヘッダを付けられないので、token をクエリで渡すのは既存経路と同じ判断。
 *
 * **上流は VPS の dtako-scraper 経路 (`connectVpcRelay`) と同じ形だが、転送だけは
 * 別物にしてある。** あちらは `typeof evt.data === "string"` で文字列しか流さない。
 * RDP は最初のバイトからバイナリ (RDCleanPath の DER、その後は素の RDP) なので、
 * それを写すと**1 フレームも通らない**。ここは data をそのまま渡す。
 */
import { decideRelayAuth, type IntrospectResult } from "./auth-decision";

/**
 * 上流 URL のホスト名。**経路はここでは決まらない** — VPC Service binding は
 * Service 側に登録された host/port へ必ず送る。fetch に渡す host は Host ヘッダに
 * 入るだけ、port は無視される。だから見て分かる名前にしてある。
 */
export const RDP_UPSTREAM_ORIGIN = "http://rdp-relay.internal";

/** この中継が必要とする binding だけを写した型。 */
export interface RdpRelayEnv {
  /** VPC Service `rdp-relay` (localTunnel 経由でオンプレの中継へ)。 */
  RDP_RELAY_VPC?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  /** auth-worker への service binding (`/auth/introspect`)。 */
  AUTH_WORKER?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  INTERNAL_SHARED_SECRET?: unknown;
  NUXT_PUBLIC_AUTH_WORKER_URL?: string;
}

/**
 * 上流 (`rdp-relay` の `/rdp`) へ渡す URL を組み立てる。
 *
 * `token` / `session` はこの worker が認証に使うもので、**上流には渡さない**
 * (中継は `--auth vpc` で動いており、誰を通すかの判断はこちら側が持つ。
 * 資格情報を必要のない先へ配らない)。
 */
export function buildRdpUpstreamUrl(requestUrl: URL): string {
  const params = new URLSearchParams(requestUrl.search);
  params.delete("token");
  params.delete("session");
  const query = params.toString();
  return query ? `${RDP_UPSTREAM_ORIGIN}/rdp?${query}` : `${RDP_UPSTREAM_ORIGIN}/rdp`;
}

/** 失敗を WebSocket ではなく HTTP で返す。ハンドシェイク前なのでこれが素直。 */
function reject(status: number, reason: string): Response {
  return new Response(reason, { status });
}

/**
 * auth-worker `/auth/introspect` を service binding 経由で叩く (DO 側と同じ形)。
 *
 * **`origin` を必ず送る。** これが無いと auth-worker は通さない (実機で 401 になった)。
 * DO 側の introspect も `{ token, origin }` を送っている。
 */
async function introspect(
  env: RdpRelayEnv,
  token: string,
  origin: string,
): Promise<IntrospectResult> {
  const secret = env.INTERNAL_SHARED_SECRET;
  const sharedSecret =
    typeof secret === "string"
      ? secret
      : await (secret as { get?: () => Promise<string> } | undefined)?.get?.();
  if (!sharedSecret || !env.AUTH_WORKER) return { active: false };

  // 引数の origin (呼び出し元のオリジン) とは別物。DO 側と同じ名前にしておく。
  const authWorkerUrl = env.NUXT_PUBLIC_AUTH_WORKER_URL || "https://auth.ippoan.org";
  try {
    const res = await env.AUTH_WORKER.fetch(`${authWorkerUrl}/auth/introspect`, {
      method: "POST",
      headers: {
        Authorization: sharedSecret,
        "Content-Type": "application/json",
        "User-Agent": "nuxt-dtako-admin/rdp-relay-proxy",
      },
      body: JSON.stringify({ token, origin }),
    });
    if (!res.ok) return { active: false };
    return (await res.json()) as IntrospectResult;
  } catch {
    // introspect に届かないときは通さない。落ちている側に倒す。
    return { active: false };
  }
}

/**
 * ブラウザの WebSocket を、オンプレの RDP 中継へ繋ぎ替える。
 *
 * 戻り値が 101 のときだけ中継が成立している。それ以外は理由を本文に入れて返す
 * (ブラウザ側は「0 件で切断」しか観測できないので、理由をここで潰しておかないと
 * 切り分けができなくなる — scraper 経路で実際に踏んだ問題)。
 */
export async function proxyRdpWebSocket(env: RdpRelayEnv, request: Request): Promise<Response> {
  if (request.headers.get("Upgrade") !== "websocket") {
    return reject(426, "Expected Upgrade: websocket");
  }

  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return reject(401, "token クエリが無い");

  if (decideRelayAuth(await introspect(env, token, `https://${url.host}`)).status !== 101) {
    // ここを黙って返していたせいで、実機の 401 が Workers Logs から追えなかった。
    console.error(`rdp-relay-proxy introspect rejected: origin=https://${url.host}`);
    return reject(401, "セッションが無効か期限切れです");
  }

  if (!env.RDP_RELAY_VPC) {
    // binding の付け忘れ。黙って 502 にすると上流ダウンと区別が付かない。
    return reject(503, "RDP_RELAY_VPC binding が未設定です");
  }

  const upstreamUrl = buildRdpUpstreamUrl(url);
  let upstreamRes: Response;
  try {
    upstreamRes = await env.RDP_RELAY_VPC.fetch(upstreamUrl, {
      headers: { Upgrade: "websocket" },
    });
  } catch (err) {
    console.error(
      `rdp-relay-proxy fetch threw: url=${upstreamUrl} err=${err instanceof Error ? err.message : String(err)}`,
    );
    return reject(502, "RDP 中継に接続できません (VPC binding の fetch が失敗)");
  }

  const upstream = upstreamRes.webSocket;
  if (!upstream) {
    console.error(`rdp-relay-proxy no webSocket: status=${upstreamRes.status}`);
    return reject(502, `RDP 中継が WebSocket を返しませんでした (status=${upstreamRes.status})`);
  }

  upstream.accept();
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
  server.accept();

  // **data をそのまま渡す。** RDP はバイナリなので、string だけ転送する
  // scraper 経路の書き方をここに写すと 1 フレームも通らない。
  upstream.addEventListener("message", (evt: MessageEvent) => {
    try {
      server.send(evt.data as string | ArrayBuffer);
    } catch {
      // 相手が既に閉じている。close 側で後始末される。
    }
  });
  server.addEventListener("message", (evt: MessageEvent) => {
    try {
      upstream.send(evt.data as string | ArrayBuffer);
    } catch {
      // 同上。
    }
  });

  // 片方が閉じたら道連れにする。RDP は片側だけ生きていても意味が無い。
  const closeBoth = (socket: WebSocket, code: number, reason: string) => {
    try {
      socket.close(code, reason);
    } catch {
      // already closed
    }
  };
  upstream.addEventListener("close", (evt: CloseEvent) => {
    // 1005 (No Status Received) は close() にそのまま渡すと throw する。
    closeBoth(server, evt.code === 1005 ? 1000 : evt.code, "upstream closed");
  });
  upstream.addEventListener("error", () => closeBoth(server, 1011, "upstream error"));
  server.addEventListener("close", () => closeBoth(upstream, 1000, "client closed"));
  server.addEventListener("error", () => closeBoth(upstream, 1011, "client error"));

  return new Response(null, { status: 101, webSocket: client });
}
