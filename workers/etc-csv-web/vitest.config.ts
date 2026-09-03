import { defineConfig } from 'vitest/config'

/**
 * この worker 専用の vitest config (`workers/dtako-scraper-relay` /
 * `workers/kyuyo-mcp` と同じ流儀で、親 nuxt-dtako-admin の config に吸われないよう
 * ローカルに持つ)。
 *
 * DO も cloudflare:workers も使わない素の fetch handler なので、node 環境で
 * `src/**` を丸ごと 100% gate に載せられる (`Request` / `Response` / `URL` は
 * node 22 の global で足りる)。R2 は `R2BucketLite` (構造的型) を偽物で差し替える。
 *
 * ★ `include` は allowlist。`src/` にファイルを足したらここは glob なので自動で
 * 母数に入るが、**除外を足すと gate が緑のまま何も測らなくなる**ので足さないこと。
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
})
