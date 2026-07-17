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
    // ローカル dev 専用 (Refs #268 PR-D): /restraint-api を wrangler dev の relay
    // (127.0.0.1:8787) へ転送する。デプロイでは front worker が service binding で
    // 処理するため devProxy は使われない。起動手順は docs/plan-268 参照。
    devProxy: {
      '/restraint-api': { target: 'http://127.0.0.1:8787/restraint-api' },
    },
  },

  // VidMap.vue が使う `google.maps.*` グローバル型 (@types/google.maps) を
  // tsconfig の types に追加。
  typescript: {
    tsConfig: {
      compilerOptions: {
        types: ['google.maps'],
      },
    },
  },

  // server route (/api/proxy) が import する @ippoan/auth-client/server (.mjs) を
  // Nitro が解決できるよう transpile 対象に含める。
  build: {
    transpile: ['@ippoan/auth-client'],
  },

  vite: {
    optimizeDeps: {
      // net780-wasm / dtako-vid-wasm: wasm-bindgen が生成する glue (wasm 初期化) を
      // Vite の dependency pre-bundling に通すと壊れるため除外
      // (ippoan/fc1200-wasm consumer と同じ扱い。dtako-vid-wasm は pre-bundle 対象に
      // すると同梱 .wasm が `.vite/deps` キャッシュにコピーされず 404 になる実害あり)。
      exclude: ['@ippoan/auth-client', 'net780-wasm', 'dtako-vid-wasm'],
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
