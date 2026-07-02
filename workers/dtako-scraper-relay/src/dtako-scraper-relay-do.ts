/**
 * DtakoScraperRelayDO — browser の scrape-trigger WebSocket と、Kagoya VPS 上の
 * dtako-scraper (`/scrape/ws`) との間を中継する Durable Object。
 *
 * 経緯: dtako-scraper は VPS の `127.0.0.1:8081` にしか bind されておらず、GCP
 * Cloud Run (rust-alc-api) からは到達不可能 (Cloud Run は WARP client になれず
 * Cloudflare Tunnel の Private Network route に乗れないため)。一方 Cloudflare
 * Workers は既存の `kagoya_tunnel` へ Workers VPC binding (beta) で直接到達できる
 * ため、front (nuxt-dtako-admin, 既に Worker) がこの relay を持つ。
 *
 * browser ──WS (Hibernatable)──> このDO ──WS (Workers VPC binding)──> dtako-scraper
 *
 * 認証: browser から渡された auth-worker JWT を `/auth/introspect` で検証する
 * (nuxt-items の ItemsSyncDO と同型)。tenant 突き合わせは不要 (auth-decision.ts 参照)。
 *
 * hibernation について: 上流 (dtako-scraper) 側は `ctx.acceptWebSocket` を使わない
 * 素の WebSocket なので、上流が繋がっている間 DO は常に active (このソケットが
 * hibernate を妨げる)。browser 側だけ Hibernatable API を使うのは、org 標準の
 * 「DO の WS は必ず Hibernatable API 経由」を満たすためと、再接続時に前回の JS
 * メモリを持ち越さない (evict 可能な) ことが目的で、この relay の実際の課金削減効果は
 * 「1 scrape セッション = 1 DO インスタンスの短寿命」であることが主な理由。
 */
import { DurableObject } from "cloudflare:workers";
import { decideRelayAuth, type IntrospectResult } from "./auth-decision";

/** SecretsStoreSecret (`.get()`) / 文字列 のどちらの binding でも値を取り出す。 */
async function resolveSecret(binding: unknown): Promise<string> {
  if (typeof binding === "string") return binding;
  if (binding && typeof (binding as { get?: unknown }).get === "function") {
    return (await (binding as { get(): Promise<string> }).get()) ?? "";
  }
  return "";
}

export interface RelayEnv {
  RELAY: DurableObjectNamespace;
  /** auth-worker introspect 用 shared secret (CF Secrets Store binding)。 */
  INTERNAL_SHARED_SECRET?: unknown;
  /** auth-worker origin (wrangler vars と共有)。 */
  NUXT_PUBLIC_AUTH_WORKER_URL?: string;
  /**
   * Workers VPC binding (beta) — kagoya_tunnel (Tunnel ID
   * e690242e-06cb-43a6-b2f5-67dfec95ca46) 経由で dtako-scraper (VPS
   * 127.0.0.1:8081) に到達する Fetcher。VPC Service `dtako-scraper-relay`
   * (service_id: 019f20af-c6ac-7dd0-8381-ea22add4bd40) を wrangler.toml の
   * `vpc_services` binding で参照する。
   */
  DTAKO_SCRAPER_VPC: Fetcher;
}

export class DtakoScraperRelayDO extends DurableObject<RelayEnv> {
  /** 上流 (dtako-scraper) への WebSocket。plain socket なので DO を active に保つ。 */
  private upstream: WebSocket | null = null;

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  /**
   * auth-worker `/auth/introspect` を直接叩く (DO は h3 context を持たないので
   * @ippoan/auth-client/server の requireAuth は使えない)。
   */
  private async introspect(
    token: string,
    origin: string,
  ): Promise<IntrospectResult> {
    const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
    if (!sharedSecret) return { active: false };
    const authWorkerUrl =
      this.env.NUXT_PUBLIC_AUTH_WORKER_URL || "https://auth.ippoan.org";
    try {
      const res = await fetch(`${authWorkerUrl}/auth/introspect`, {
        method: "POST",
        headers: {
          Authorization: sharedSecret,
          "Content-Type": "application/json",
          "User-Agent": "nuxt-dtako-admin/dtako-scraper-relay-do",
        },
        body: JSON.stringify({ token, origin }),
      });
      if (!res.ok) return { active: false };
      const data = (await res.json()) as Record<string, unknown>;
      if (!data || data.active !== true) return { active: false };
      return { active: true };
    } catch {
      return { active: false };
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return new Response("Missing token", { status: 401 });
    }

    const result = await this.introspect(token, `https://${url.host}`);
    const decision = decideRelayAuth(result);
    if (decision.status !== 101) {
      return new Response("Invalid or expired token", { status: decision.status });
    }

    // 上流 (dtako-scraper) の /scrape/ws にスクレイプパラメータをそのまま渡して接続。
    // token / session id は上流には不要なので除去して転送する。
    const upstreamParams = new URLSearchParams(url.search);
    upstreamParams.delete("token");
    upstreamParams.delete("session");
    // TODO: Workers VPC (beta) の実際のホスト/パス解決方法を deploy 前に要確認。
    // ここでは binding が private target への routing を担う前提のプレースホルダ URL。
    const upstreamUrl = `http://dtako-scraper.internal/scrape/ws?${upstreamParams.toString()}`;
    const upstreamRes = await this.env.DTAKO_SCRAPER_VPC.fetch(upstreamUrl, {
      headers: { Upgrade: "websocket" },
    });
    const upstreamWs = upstreamRes.webSocket;
    if (!upstreamWs) {
      return new Response("Upstream scraper unavailable", { status: 502 });
    }
    upstreamWs.accept();
    this.upstream = upstreamWs;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    upstreamWs.addEventListener("message", (evt: MessageEvent) => {
      if (typeof evt.data === "string") server.send(evt.data);
    });
    upstreamWs.addEventListener("close", () => {
      this.upstream = null;
      try {
        server.close(1000, "upstream closed");
      } catch {
        // already closed
      }
    });
    upstreamWs.addEventListener("error", () => {
      this.upstream = null;
      try {
        server.close(1011, "upstream error");
      } catch {
        // already closed
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // browser → dtako-scraper 方向は現状不要 (トリガー時のパラメータは接続 URL の
  // query string で完結する) が、将来 client からの中断指示等に備えて no-op で持つ。
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // 現状 browser → upstream の転送は不要。
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
    this.upstream?.close();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("DtakoScraperRelayDO WebSocket error:", error);
    ws.close(1011, "Internal error");
    this.upstream?.close();
  }
}
