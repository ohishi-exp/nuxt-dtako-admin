// https://nuxt.com/docs/api/configuration/nuxt-config
/** wrangler dev のポート (dev-login-local-verify skill)。relay と front worker を
 * 同時に立てる時だけ NUXT_DEV_FRONT_PORT で分ける。 */
const relayPort = process.env.NUXT_DEV_RELAY_PORT || '8787'
const frontPort = process.env.NUXT_DEV_FRONT_PORT || '8787'

/**
 * **この bundle を作ったコードの版** (`v0.0.517`)。粗利の集計を R2 に版管理で残すとき
 * (Refs #826)、「同じ入力でもロジックが変われば数字は動く」ぶんを区別するために刻む。
 *
 * GitHub Actions は全ての step に `GITHUB_REF_TYPE` / `GITHUB_REF_NAME` を渡すので、
 * **タグリリース (`v*` push) のビルドだけ**が値を持つ。**branch のビルド
 * (preview / staging / ローカル) は空文字**にする — `main` や branch 名を版として
 * 記録すると、中身が動き続ける名前を「版」と読んでしまう。空文字は保存側が
 * `resolveCodeVersion` で `unknown` に倒すので、undefined も空文字も版には混ざらない。
 */
const codeVersion = process.env.GITHUB_REF_TYPE === 'tag' ? (process.env.GITHUB_REF_NAME || '') : ''

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
      // RemoteApp ビューアが繋ぐ RDP 中継 (Cloudflare Access が守る公開ホスト名)。
      // 画面から直接張る (app/utils/rdp-access.ts)。Worker はこの経路に居ない。
      rdpRelayUrl: process.env.NUXT_PUBLIC_RDP_RELAY_URL || '',
      // 上の `codeVersion` (ビルド時定数)。粗利タブが R2 の版に刻む (Refs #826)。
      // **public に置く**のは、数字を計算するのが画面 (client bundle) だから —
      // 画面が名乗る版が、その数字を作った版そのものになる。
      codeVersion,
    },
  },

  nitro: {
    preset: 'cloudflare_module',
    // ローカル dev 専用 (Refs #268 PR-D): /restraint-api を wrangler dev の relay
    // (127.0.0.1:8787) へ転送する。デプロイでは front worker が service binding で
    // 処理するため devProxy は使われない。起動手順は docs/plan-268 参照。
    // /net780-api (Refs #302) も同じ relay worker (dtako-scraper-relay) が
    // 処理するため同一ポートへ転送する。
    devProxy: {
      // relay worker (dtako-scraper-relay) と front worker (この worker) は
      // どちらも wrangler dev で並走しうる。既定は両方 :8787 (単体起動の従来手順)
      // で、両方同時に要る検証だけ NUXT_DEV_FRONT_PORT=8788 のように分ける
      // (dev-login-local-verify skill 参照)。
      '/restraint-api': { target: `http://127.0.0.1:${relayPort}/restraint-api` },
      '/net780-api': { target: `http://127.0.0.1:${relayPort}/net780-api` },
      // hybrid dev (dev-login-local-verify skill): AUTH_WORKER binding 依存の
      // /api/proxy と dev-login callback (/__dev) を並走中の wrangler dev
      // (front worker) へ転送し、UI は nuxt dev の HMR で回す。
      // 編集→反映 90秒 (nuxt build) → 0.1秒 (実測 106ms, 2026-07-25)。
      // 起動は setup-dev-env.sh --hybrid (skill 同梱) が全自動で行う。
      '/api/proxy': { target: `http://127.0.0.1:${frontPort}/api/proxy` },
      '/__dev': { target: `http://127.0.0.1:${frontPort}/__dev` },
      // 給与大臣読み取り (Refs #367) も ICHIBAN_CF_ACCESS_* (Secrets Store binding)
      // 依存なので front worker 経由でないと 503 になる。
      '/api/kyuyo': { target: `http://127.0.0.1:${frontPort}/api/kyuyo` },
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

  // chunk load 失敗 (immutable キャッシュされた `/_nuxt/*.js` の 404) からの自動復旧。
  // `experimental.emitRouteChunkError = 'manual'` と transpile 登録も module 側が行う
  // ので consumer は 1 行で済む (Refs ippoan/auth-worker#452)。
  modules: [
    '@nuxt/ui',
    '@ippoan/auth-client/module',
  ],

  css: ['~/assets/css/main.css'],
})
