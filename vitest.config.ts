import { resolve } from 'node:path'
import { configDefaults } from 'vitest/config'
import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
    // workers/* はそれぞれ独立した package.json + vitest.config.ts + CI job
    // (workers/dtako-scraper-relay, workers/kyuyo-mcp 等) を持つ。既定の test
    // discovery glob には除外指定が無く、happy-dom 環境で workers/kyuyo-mcp の
    // Cloudflare Workers 向けテスト (Hono app.request() 等) を拾って fail させて
    // いたため明示的に除外する (root CI が誤って落ちる問題、2026-07-23 発覚)。
    exclude: [...configDefaults.exclude, 'workers/**'],
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['app/**/*.ts', 'app/**/*.vue'],
      exclude: ['app/types/**'],
      reporter: ['text', ['json-summary', { file: 'coverage-summary.json' }], 'json'],
      reportsDirectory: 'coverage',
    },
  },
  resolve: {
    alias: {
      // net780-wasm (vendor/net780-wasm/ に vendoring 済み) は wasm バイナリの
      // fetch() 初期化が vitest/happy-dom 環境で動かないため、テストではモックに
      // 差し替える (ippoan/fc1200-wasm consumer と同じ扱い)。
      'net780-wasm': resolve(import.meta.dirname!, 'tests/mocks/net780-wasm.ts'),
    },
  },
})
