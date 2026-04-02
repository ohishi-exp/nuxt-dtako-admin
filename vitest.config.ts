import { defineVitestConfig } from '@nuxt/test-utils/config'

export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['app/utils/**', 'app/composables/**'],
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
    },
  },
})
