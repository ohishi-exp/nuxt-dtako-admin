/**
 * MCP tool の scope gating ロジック (pure)。cf-access-mcp と同じ形を踏襲するが、
 * kyuyo-mcp の全 tool は `requiresScope` を持たない (read-only) ため
 * `isToolAllowed` は現状常に `true` を返す。将来 write tool を足す時のための配線。
 */
import type { z } from "zod";
import type { ToolEntry } from "./registry";

/** OAuth 慣例の空白区切り scope を Set に。未提供は空 Set。 */
export function parseScopes(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(raw.split(/\s+/).filter((s) => s.length > 0));
}

/** tool が要求する scope を caller が持つか。`requiresScope` 無しは常に許可。 */
export function isToolAllowed(tool: ToolEntry<z.ZodTypeAny>, scopes: Set<string>): boolean {
  return !tool.requiresScope || scopes.has(tool.requiresScope);
}
