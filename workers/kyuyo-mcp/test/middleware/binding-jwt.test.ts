/**
 * `src/middleware/binding-jwt.ts` の shim (resourceMetadataSlug="kyuyo-mcp" を
 * pin するだけ) を Hono 経由で end-to-end 検証する。introspect 検証ロジック自体
 * (`introspectBindingJwt`/`wwwAuthenticate`) は `@ippoan/mcp-cf-workers` 側で
 * テスト済みなのでここでは再テストしない — この shim が正しい slug/options で
 * ライブラリを呼んでいることだけを確認する。
 */
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { bindingJwtMiddleware } from "../../src/middleware/binding-jwt";
import type { BindingJwtClaims } from "@ippoan/mcp-cf-workers/auth";
import type { Env } from "../../src/env";

const env = { AUTH_WORKER_ORIGIN: "https://auth-staging.test" } as unknown as Env;

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const activeBody = {
  active: true,
  sub: "github:octocat",
  github_login: "octocat",
  scope: "mcp.read",
  exp: 9999999999,
};

function appWith(opts: Parameters<typeof bindingJwtMiddleware>[0] = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { bindingJwt: BindingJwtClaims } }>();
  app.use("/mcp", bindingJwtMiddleware(opts));
  app.all("/mcp", (c) => c.json({ scope: c.get("bindingJwt").scope }));
  return app;
}

describe("bindingJwtMiddleware (kyuyo-mcp shim)", () => {
  it("sets claims and calls next on success", async () => {
    const app = appWith({
      introspectFetch: (async () => jsonResp(activeBody)) as unknown as typeof fetch,
    });
    const res = await app.request("/mcp", { method: "POST", headers: { Authorization: "Bearer x" } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "mcp.read" });
  });

  it("returns 401 + WWW-Authenticate pointing at the kyuyo-mcp resource slug on missing header", async () => {
    const app = appWith();
    const res = await app.request("/mcp", { method: "POST" }, env);
    expect(res.status).toBe(401);
    const wa = res.headers.get("WWW-Authenticate") ?? "";
    expect(wa).toContain("resource_metadata");
    expect(wa).toContain("kyuyo-mcp");
    expect(wa).toContain('error="invalid_request"');
  });

  it("returns 503 (no WWW-Authenticate) when auth-worker is unreachable", async () => {
    const f = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    const app = appWith({ introspectFetch: f });
    const res = await app.request("/mcp", { method: "POST", headers: { Authorization: "Bearer x" } }, env);
    expect(res.status).toBe(503);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });
});
