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
})
