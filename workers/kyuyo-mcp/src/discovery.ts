/**
 * claude.ai connector の fresh OAuth discovery 対応。
 *
 * claude.ai は新規 connector 登録時、MCP server origin 自身を authorization server
 * とみなして RFC 8414 の origin discovery を叩く:
 *
 *   GET  https://kyuyo-mcp.ippoan.org/.well-known/oauth-authorization-server
 *   POST https://kyuyo-mcp.ippoan.org/register
 *
 * これらを auth-worker (staging) に proxy する (`ippoan/mcp-cf-workers` の
 * cf-access-mcp 例と同じパターン、Refs ippoan/mcp-cf-workers#26)。
 */
import type { Env } from "./env";

function authOrigin(env: Env): string {
  return env.AUTH_WORKER_ORIGIN && env.AUTH_WORKER_ORIGIN !== ""
    ? env.AUTH_WORKER_ORIGIN
    : "https://auth-staging.ippoan.org";
}

/** auth-worker の per-resource metadata endpoint と一致させる規約 (hostname 先頭 label)。 */
const RESOURCE_SLUG = "kyuyo-mcp";

/** upstream のレスポンスを body 透過で返す (CORS は付けない = 稼働サーバーと parity)。 */
async function passthrough(upstream: Response): Promise<Response> {
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/**
 * fresh OAuth discovery のリクエストなら auth-staging に proxy した Response を、
 * そうでなければ `null` を返す (= 呼び出し側が通常 routing を続ける)。
 * framework 非依存。`fetchImpl` はテスト差し替え用。
 */
export async function handleDiscovery(
  req: Request,
  env: Env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response | null> {
  const { pathname } = new URL(req.url);
  const origin = authOrigin(env);

  if (req.method === "GET" && pathname === "/.well-known/oauth-authorization-server") {
    return passthrough(await fetchImpl(`${origin}/.well-known/oauth-authorization-server`));
  }

  if (
    req.method === "GET" &&
    (pathname === "/.well-known/oauth-protected-resource" ||
      pathname === `/.well-known/oauth-protected-resource/${RESOURCE_SLUG}`)
  ) {
    return passthrough(
      await fetchImpl(`${origin}/.well-known/oauth-protected-resource/${RESOURCE_SLUG}`),
    );
  }

  if (req.method === "POST" && pathname === "/register") {
    const body = await req.text();
    return passthrough(
      await fetchImpl(`${origin}/mcp/register`, {
        method: "POST",
        headers: { "Content-Type": req.headers.get("Content-Type") ?? "application/json" },
        body,
      }),
    );
  }

  return null;
}
