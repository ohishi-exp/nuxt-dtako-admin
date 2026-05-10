// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  devtools: { enabled: true },

  runtimeConfig: {
    public: {
      apiBase: process.env.NUXT_PUBLIC_API_BASE || 'http://localhost:8080',
      authWorkerUrl: process.env.NUXT_PUBLIC_AUTH_WORKER_URL || '',
      // /wt-quick --auth-skip <tenant_id> で OAuth バイパス。
      // 設定時は @ippoan/auth-client の useAuth/authMiddleware が JWT 不要モードに切替。
      stagingTenantId: process.env.NUXT_PUBLIC_STAGING_TENANT_ID || '',
      // notify-realtime-bus Worker (`workers/realtime-bus/` in nuxt-notify) の base URL。
      // Y時間 export の async job 完了通知 (kind=y_time_export) を WebSocket で受信する用途。
      // 例: prod=`wss://realtime.notify.ippoan.org`, staging=`wss://realtime-staging.notify.ippoan.org`
      // 未設定 (空文字) なら useYTimeExportJob は同期 GET にフォールバック。
      realtimeBusUrl: process.env.NUXT_PUBLIC_REALTIME_BUS_URL || '',
    },
  },

  nitro: {
    preset: 'cloudflare_module',
  },

  vite: {
    optimizeDeps: {
      exclude: ['@ippoan/auth-client'],
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
