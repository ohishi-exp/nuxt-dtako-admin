/**
 * MCP transport 配線。
 *
 * `@ippoan/mcp-cf-workers` の `createWorkerMcp` (stateless streamable HTTP) に
 * registry の tool を登録するだけの薄い 1 枚。実ロジックは `./tools` (pure) に
 * 置き、ここはそれを MCP tool として公開するアダプタに徹する (SDK / transport
 * 依存はこのファイルに閉じる、cf-access-mcp と同じ設計)。
 *
 * 各 tool の戻り値は `redactDriverNames()` でラップしてから返す — 個々の tool
 * 実装が氏名を漏らさない設計に依存しない defense-in-depth (issue #374 の合意)。
 *
 * scope gating: 全 tool は `requiresScope` を持たない (read-only) ため
 * `isToolAllowed` は現状 no-op。将来 write tool を足す時のための配線を維持する。
 *
 * SDK (+ ajv) は workers-pool テスト loader と相性が悪いため、このモジュールは
 * `index.ts` から `/mcp` 到達時のみ遅延 import される。ロジックは `tools.ts` /
 * `redact.ts` を直接テストする (vitest.config.ts の coverage exclude 参照)。
 */
import { createWorkerMcp } from "@ippoan/mcp-cf-workers";
import type { z } from "zod";
import type { Env } from "../env";
import type { BindingJwtClaims } from "../middleware/binding-jwt";
import { redactDriverNames } from "../redact";
import type { ToolEntry } from "./registry";
import { ALL_TOOLS } from "./tools";
import { isToolAllowed, parseScopes } from "./scope";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(redactDriverNames(value), null, 2) }] };
}
function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

interface RegisterableServer {
  registerTool: (
    name: string,
    config: { description: string; inputSchema: z.ZodRawShape },
    cb: (args: Record<string, unknown>) => Promise<ToolResult>,
  ) => unknown;
}

function registerToolEntry(
  server: RegisterableServer,
  env: Env,
  tool: ToolEntry<z.ZodTypeAny>,
  scopes: Set<string>,
  scopeLabel: string,
): void {
  const shape = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: shape },
    async (args: Record<string, unknown>): Promise<ToolResult> => {
      if (!isToolAllowed(tool, scopes)) {
        return fail(`forbidden: tool ${tool.name} requires scope "${tool.requiresScope}", got "${scopeLabel}"`);
      }
      const parsed = tool.inputSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return fail(`invalid arguments: ${parsed.error.message}`);
      }
      try {
        return ok(await tool.execute(env, parsed.data));
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  );
}

/** `/mcp` に mount する stateless ハンドラ。claims は binding_jwt middleware が立てたもの。 */
export async function handleMcp(
  request: Request,
  env: Env,
  claims?: BindingJwtClaims,
): Promise<Response> {
  const scopes = parseScopes(claims?.scope);
  const scopeLabel = claims?.scope ?? "";

  const handler = createWorkerMcp<Env>({
    name: "kyuyo-mcp",
    version: "0.1.0",
    registerTools: (server, e) => {
      const reg = server as unknown as RegisterableServer;
      for (const tool of ALL_TOOLS) {
        registerToolEntry(reg, e, tool, scopes, scopeLabel);
      }
    },
  });

  return handler(request, env);
}
