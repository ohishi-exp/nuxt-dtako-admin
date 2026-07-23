/**
 * kyuyo-mcp Worker エントリ。
 *
 * 給与比較 (拘束時間×賃金計算) データを読み取り専用 MCP tool として公開する薄い
 * worker。`@ippoan/mcp-cf-workers` の `createWorkerMcp` を consume する
 * (nuxt-dtako-admin#374 Phase 1、cf-access-mcp / gmail-mcp と同じ構成)。
 *
 *   GET  /healthz … ヘルスチェック (認証前段でも通す)
 *   GET  /.well-known/oauth-authorization-server     … AS metadata (auth-staging proxy)
 *   GET  /.well-known/oauth-protected-resource[/...] … PR metadata (auth-staging proxy)
 *   POST /register … Dynamic Client Registration (auth-staging proxy)
 *   POST /mcp      … MCP tool (stateless streamable HTTP)。binding_jwt 認証。
 *
 * 認可は binding_jwt (auth-worker mint) の検証のみで完結させる (gmail-mcp と同じ
 * 規約、独自 allowlist は追加しない — `src/middleware/binding-jwt.ts` 参照)。
 */
import { Hono, type Context } from "hono";
import type { Env } from "./env";
import { handleDiscovery } from "./discovery";
import { bindingJwtMiddleware, type BindingJwtClaims } from "./middleware/binding-jwt";

type Variables = { bindingJwt: BindingJwtClaims };

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

// /healthz は binding_jwt より先に置き、認証なしで疎通確認できるようにする。
app.get("/healthz", (c) => c.json({ ok: true, service: "kyuyo-mcp" }));

// claude.ai fresh connector の OAuth discovery を auth-staging に proxy する
// (認証なし。`src/discovery.ts`)。SDK 非依存なので遅延 import 不要。
const discovery = async (c: Context<{ Bindings: Env; Variables: Variables }>) => {
  const res = await handleDiscovery(c.req.raw, c.env);
  return res ?? c.json({ error: "not_found" }, 404);
};
app.get("/.well-known/oauth-authorization-server", discovery);
app.get("/.well-known/oauth-protected-resource", discovery);
app.get("/.well-known/oauth-protected-resource/:slug", discovery);
app.post("/register", discovery);

// /mcp と /mcp/* は auth-worker (`AUTH_WORKER_ORIGIN`) が mint した binding_jwt
// (Bearer) で認証する。Hono の `/mcp/*` は `/mcp/foo` 以下しかマッチしないため
// `/mcp` 自身にも別途 mount する (secrets-inventory / cf-access-mcp と同じ)。
app.use("/mcp", bindingJwtMiddleware());
app.use("/mcp/*", bindingJwtMiddleware());

// MCP transport (stateless streamable HTTP)。SDK (+ ajv) は重いので /mcp 到達時に
// 遅延 import する (cf-access-mcp と同じ。non-MCP path / テストに SDK を乗せない)。
app.all("/mcp", async (c) => {
  const { handleMcp } = await import("./mcp/server");
  return handleMcp(c.req.raw, c.env, c.get("bindingJwt"));
});

// 未知パスは JSON 404 を返す。
app.notFound((c) => c.json({ error: "not_found" }, 404));

export default app;
