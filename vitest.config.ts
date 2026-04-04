import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['app/utils/**', 'app/composables/**', 'app/components/**', 'app/middleware/**'],
      exclude: ['tests/**'],
      reporter: ['text', ['json-summary', { file: 'coverage-summary.json' }], 'json'],
      reportsDirectory: 'coverage',
    },
  },
})
