/**
 * binding_jwt middleware for kyuyo-mcp。
 *
 * 検証ロジックは `@ippoan/mcp-cf-workers/auth` にあるので、このファイルは RFC 9728
 * resource-metadata slug を pin するだけの shim (gmail-mcp / cf-access-mcp と同じ)。
 * この worker は自身の RS: `kyuyo-mcp.ippoan.org`、
 * `/.well-known/oauth-protected-resource/kyuyo-mcp` で広告される。
 *
 * 認可はこの binding_jwt 検証のみで完結させる — 独自の email/login allowlist は
 * 追加しない (gmail-mcp と同じ規約。auth-worker 側の resource origin → Google IdP
 * ルーティング (`MCP_RESOURCE_GOOGLE_ORIGINS`) と Google allowlist
 * (`google-mcp-user-allowlist` KV) が認可境界を担う)。
 */
import { bindingJwtMiddleware as libBindingJwtMiddleware } from "@ippoan/mcp-cf-workers/auth/binding-jwt-hono";
import type { IntrospectBindingJwtOptions } from "@ippoan/mcp-cf-workers/auth";
import type { Env } from "../env";

const RESOURCE_METADATA_SLUG = "kyuyo-mcp";

export function bindingJwtMiddleware(
  options: IntrospectBindingJwtOptions = {},
) {
  return libBindingJwtMiddleware<Env>({
    resourceMetadataSlug: RESOURCE_METADATA_SLUG,
    ...options,
  });
}

export type { BindingJwtClaims } from "@ippoan/mcp-cf-workers/auth";
