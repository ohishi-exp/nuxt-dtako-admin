/**
 * MCP tool registry (single source of truth)。
 *
 * `server.ts` がこの list をループして `createWorkerMcp` の McpServer に登録する。
 * tool を追加する時は `src/mcp/tools.ts` に 1 つ書いて、この list に push するだけ。
 *
 * 全 tool が read-only (R2 直読み) なので `requiresScope` は使わない — binding_jwt
 * が valid なら誰でも呼べる (cf-access-mcp の read tool と同じ扱い)。
 */
import type { z } from "zod";
import type { Env } from "../env";

export interface ToolEntry<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** zod object schema。`.shape` を McpServer.registerTool に渡し、SDK が validate する。 */
  inputSchema: S;
  /** 必要 scope。全 tool read-only のため現状は未使用 (常に許可)。 */
  requiresScope?: string;
  /** tool 本体。R2 バケット等の binding を持つ env をそのまま渡す。 */
  execute: (env: Env, args: z.infer<S>) => Promise<unknown>;
}
