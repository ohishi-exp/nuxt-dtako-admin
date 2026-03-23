// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:8080',
    },
  },

  nitro: {
    preset: 'cloudflare_module',
  },

  modules: [
    '@nuxt/ui',
  ],

  css: ['~/assets/css/main.css'],
})
