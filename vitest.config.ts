import { resolve } from 'node:path'
import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
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
      // net780-wasm (file: 依存、CI では stub package.json のみ) は実 wasm を
      // 読み込まずモックに差し替える (ippoan/fc1200-wasm consumer と同じ扱い)。
      'net780-wasm': resolve(import.meta.dirname!, 'tests/mocks/net780-wasm.ts'),
    },
  },
})
