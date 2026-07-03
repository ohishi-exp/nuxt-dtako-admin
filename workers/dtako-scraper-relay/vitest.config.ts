import { defineConfig } from 'vitest/config'

// DO worker は親 (nuxt-dtako-admin) の vitest config に吸われないようローカル
// config を持つ (nuxt-items/workers/items-sync と同型)。auth-decision.ts は
// pure (cloudflare 非依存) なので素の node 環境でテストできる。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 認可判定・theearth-np HTTP クライアントの pure ロジックだけ 100% gate。
      // dtako-scraper-relay-do.ts / index.ts は cloudflare:workers / DurableObject /
      // WebSocket runtime 依存で node vitest からは計測不可 (要
      // @cloudflare/vitest-pool-workers) のため対象外。
      include: ['src/auth-decision.ts', 'src/theearth-client.ts'],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
})
