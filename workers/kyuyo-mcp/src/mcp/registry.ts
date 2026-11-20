/**
 * MCP tool registry (single source of truth)。
 *
 * `server.ts` がこの list をループして `createWorkerMcpV2` の McpServer に登録する。
 * tool を追加する時は `src/mcp/tools.ts` に 1 つ書いて、この list に push するだけ。
 *
 * 全 tool が read-only (R2 直読み) なので `requiresScope` は使わない — binding_jwt
 * が valid なら誰でも呼べる (cf-access-mcp の read tool と同じ扱い)。
 */
import type { z } from "zod";
import type { Env } from "../env";

/** tool の呼び手。`bindingJwt` は `/mcp` の Bearer (binding_jwt middleware が検証済み)。 */
export interface ToolCaller {
  bindingJwt: string;
}

/** MCP の content 1 件 (text か embedded resource の blob)。 */
export type McpContent =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

/**
 * tool が JSON ではなく MCP の content をそのまま返すときの包み (PDF の embedded resource 等)。
 * server.ts はこれを JSON 化も `redactDriverNames` もせずに返すので、**氏名を含めないのは tool 側の責任**。
 */
export class McpContentResult {
  constructor(readonly content: McpContent[]) {}
}

export interface ToolEntry<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  /** zod object schema。SDK v2 の Standard Schema としてそのまま McpServer.registerTool に渡す。 */
  inputSchema: S;
  /** 必要 scope。全 tool read-only のため現状は未使用 (常に許可)。 */
  requiresScope?: string;
  /** tool 本体。R2 バケット等の binding を持つ env をそのまま渡す。`caller` を読むのは呼び手の
   *  token を上流へ転送する tool だけ (`get_min_wage_annual_report`)。 */
  execute: (env: Env, args: z.infer<S>, caller: ToolCaller) => Promise<unknown>;
}
