// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  runtimeConfig: {
    // /api/proxy が introspect 後に転送する backend (rust-alc-api Cloud Run)。
    // server-only (public でない) なので client bundle には載らない。
    alcApiUrl: process.env.NUXT_ALC_API_URL || '',
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:8080',
      authWorkerUrl: process.env.NUXT_PUBLIC_AUTH_WORKER_URL || '',
      // /wt-quick --auth-skip <tenant_id> で OAuth バイパス。
      // 設定時は @ippoan/auth-client の useAuth/authMiddleware が JWT 不要モードに切替。
      stagingTenantId: process.env.NUXT_PUBLIC_STAGING_TENANT_ID || '',
      // 自オリジンの dtako-scraper-relay (DO) へ WS 接続する。rust-alc-api 経由の
      // SCRAPER_URL 旧経路は廃止 (front Worker が直接 Cloudflare Tunnel/Workers VPC
      // 経由で dtako-scraper に到達する)。
      scraperRelayUrl: process.env.NUXT_PUBLIC_SCRAPER_RELAY_URL || '',
    },
  },

  nitro: {
    preset: 'cloudflare_module',
  },

  // server route (/api/proxy) が import する @ippoan/auth-client/server (.mjs) を
  // Nitro が解決できるよう transpile 対象に含める。
  build: {
    transpile: ['@ippoan/auth-client'],
  },

  vite: {
    optimizeDeps: {
      // net780-wasm: wasm-bindgen が生成する glue (wasm 初期化) を Vite の
      // dependency pre-bundling に通すと壊れるため除外 (ippoan/fc1200-wasm consumer と同じ扱い)。
      exclude: ['@ippoan/auth-client', 'net780-wasm'],
    },
    server: {
      // /wt-quick の Cloudflare Quick Tunnel (*.trycloudflare.com) からアクセス許可
      allowedHosts: ['.trycloudflare.com'],
    },
  },

  modules: [
    '@nuxt/ui',
  ],

  css: ['~/assets/css/main.css'],
})
