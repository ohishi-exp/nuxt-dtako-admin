import { describe, expect, it } from "vitest";
import { handleDiscovery } from "../src/discovery";
import type { Env } from "../src/env";

const env = { AUTH_WORKER_ORIGIN: "https://auth-staging.test" } as Env;

/** 呼ばれた URL / init を記録しつつ固定レスポンスを返す fake fetch。 */
function fakeFetch(
  status: number,
  body: string,
  contentType = "application/json",
): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(body, { status, headers: { "Content-Type": contentType } });
  }) as unknown as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("handleDiscovery", () => {
  it("AS metadata を auth-staging に proxy する", async () => {
    const f = fakeFetch(200, '{"issuer":"https://auth-staging.test"}');
    const req = new Request("https://kyuyo-mcp.test/.well-known/oauth-authorization-server");
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(f.calls[0]!.url).toBe("https://auth-staging.test/.well-known/oauth-authorization-server");
    expect(await res!.json()).toEqual({ issuer: "https://auth-staging.test" });
  });

  it("protected-resource metadata (slug 無し) を slug 付き upstream に proxy する", async () => {
    const f = fakeFetch(200, '{"resource":"https://kyuyo-mcp.ippoan.org"}');
    const req = new Request("https://kyuyo-mcp.test/.well-known/oauth-protected-resource");
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.status).toBe(200);
    expect(f.calls[0]!.url).toBe(
      "https://auth-staging.test/.well-known/oauth-protected-resource/kyuyo-mcp",
    );
  });

  it("protected-resource metadata (slug 付き) も受ける", async () => {
    const f = fakeFetch(200, "{}");
    const req = new Request(
      "https://kyuyo-mcp.test/.well-known/oauth-protected-resource/kyuyo-mcp",
    );
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.status).toBe(200);
    expect(f.calls[0]!.url).toBe(
      "https://auth-staging.test/.well-known/oauth-protected-resource/kyuyo-mcp",
    );
  });

  it("POST /register を auth-staging/mcp/register に body 透過 proxy する", async () => {
    const f = fakeFetch(201, '{"client_id":"abc"}');
    const req = new Request("https://kyuyo-mcp.test/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"redirect_uris":["https://claude.ai/api/mcp/auth_callback"]}',
    });
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.status).toBe(201);
    expect(f.calls[0]!.url).toBe("https://auth-staging.test/mcp/register");
    expect(f.calls[0]!.init?.method).toBe("POST");
    expect(String(f.calls[0]!.init?.body)).toContain("redirect_uris");
    expect(await res!.json()).toEqual({ client_id: "abc" });
  });

  it("upstream に Content-Type ヘッダが無い場合 application/json にフォールバックする", async () => {
    const fetchImpl = (async () => {
      // 文字列 body を渡す Response コンストラクタは自動で text/plain を付けてしまう
      // ため、`headers.get()` が本当に null を返す最小限の fake を直接組む。
      const upstream = { status: 200, text: async () => "{}", headers: { get: () => null } };
      return upstream as unknown as Response;
    }) as unknown as typeof fetch;
    const req = new Request("https://kyuyo-mcp.test/.well-known/oauth-authorization-server");
    const res = await handleDiscovery(req, env, fetchImpl);
    expect(res!.headers.get("Content-Type")).toBe("application/json");
  });

  it("POST /register リクエストに Content-Type が無い場合 application/json で upstream に転送する", async () => {
    const f = fakeFetch(201, "{}");
    const req = new Request("https://kyuyo-mcp.test/register", {
      method: "POST",
      body: '{"redirect_uris":[]}',
    });
    // 文字列 body を渡す Request コンストラクタが自動付与した Content-Type を削除し、
    // 「本当に未設定」なケースを再現する。
    req.headers.delete("Content-Type");
    await handleDiscovery(req, env, f.fetch);
    expect((f.calls[0]!.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("upstream の status / content-type を透過する (404 もそのまま)", async () => {
    const f = fakeFetch(404, "nope", "text/plain");
    const req = new Request("https://kyuyo-mcp.test/.well-known/oauth-authorization-server");
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.status).toBe(404);
    expect(res!.headers.get("Content-Type")).toBe("text/plain");
  });

  it("CORS header は付けない (稼働サーバーと parity)", async () => {
    const f = fakeFetch(200, "{}");
    const req = new Request("https://kyuyo-mcp.test/.well-known/oauth-authorization-server");
    const res = await handleDiscovery(req, env, f.fetch);
    expect(res!.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("discovery 対象外の path は null (通常 routing に委譲)", async () => {
    const f = fakeFetch(200, "{}");
    for (const [method, path] of [
      ["GET", "/mcp"],
      ["GET", "/healthz"],
      ["GET", "/register"],
      ["POST", "/.well-known/oauth-authorization-server"],
      ["GET", "/.well-known/unknown"],
    ] as const) {
      const req = new Request(`https://kyuyo-mcp.test${path}`, { method });
      const res = await handleDiscovery(req, env, f.fetch);
      expect(res, `${method} ${path}`).toBeNull();
    }
    expect(f.calls).toHaveLength(0);
  });

  it("AUTH_WORKER_ORIGIN 未設定なら staging default を使う", async () => {
    const f = fakeFetch(200, "{}");
    const req = new Request("https://kyuyo-mcp.test/.well-known/oauth-authorization-server");
    await handleDiscovery(req, {} as Env, f.fetch);
    expect(f.calls[0]!.url).toBe(
      "https://auth-staging.ippoan.org/.well-known/oauth-authorization-server",
    );
  });
});
