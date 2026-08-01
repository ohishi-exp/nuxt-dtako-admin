import { defineConfig } from 'vitest/config'

// DO worker は親 (nuxt-dtako-admin) の vitest config に吸われないようローカル
// config を持つ (nuxt-items/workers/items-sync と同型)。auth-decision.ts は
// pure (cloudflare 非依存) なので素の node 環境でテストできる。
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // 認可判定・theearth-np HTTP クライアント・alc-internal-proxy アップロードの
      // pure ロジックだけ 100% gate。dtako-scraper-relay-do.ts / index.ts は
      // cloudflare:workers / DurableObject / WebSocket runtime 依存で node vitest
      // からは計測不可 (要 @cloudflare/vitest-pool-workers) のため対象外。
      include: [
        'src/auth-decision.ts',
        'src/theearth-client.ts',
        'src/alc-internal-upload.ts',
        'src/theearth-venus-client.ts',
        'src/etc-meisai-client.ts',
        'src/cron.ts',
        'src/theearth-report-client.ts',
        'src/theearth-restraint-client.ts',
        'src/theearth-net780-client.ts',
        'src/restraint-wage.ts',
        'src/restraint-viewer-auth.ts',
        'src/restraint-queue.ts',
        'src/upstream-memo.ts',
        'src/theearth-session.ts',
        'src/promise-queue.ts',
        'src/scrape-dispatch.ts',
        'src/employee-master.ts',
        'src/work-schedule.ts',
        'src/timecard-summary.ts',
        'src/min-wage-import.ts',
        'src/branch-prefecture.ts',
        'src/restraint-d1.ts',
        'src/restraint-push.ts',
        'src/restraint-wage-source.ts',
        'src/timecard-compare.ts',
        'src/phase-timing.ts',
        'src/upstream-cache.ts',
        'src/http-etag.ts',
        'src/kintai-relay.ts',
      ],
      thresholds: {
        lines: 100,
        functions: 100,
        branches: 100,
        statements: 100,
      },
    },
  },
})
