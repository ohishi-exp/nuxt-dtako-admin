import { defineConfig } from "vitest/config";

/**
 * plain node vitest (cf-access-mcp / gmail-mcp と同じ)。DO を持たないので workerd
 * (vitest-pool-workers) は不要。ロジック (r2/*.ts, mcp/tools.ts, redact.ts) は
 * env/fetch を引数で差し替え可能な pure 関数にしてあるため node 上で直接テストできる。
 * MCP SDK / Hono 配線 (mcp/server.ts, index.ts) は SDK (+ ajv) がテスト loader と
 * 相性が悪いため coverage 対象から除外する。
 */
export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts", "src/env.ts", "src/index.ts", "src/mcp/server.ts"],
      // workers/dtako-scraper-relay/vitest.config.ts と同じ 100% gate 規約
      // (coverage_100.toml)。閾値未達は CI で non-zero exit する。
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
});
