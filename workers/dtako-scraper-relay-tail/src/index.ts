/**
 * dtako-scraper-relay (DtakoScraperRelayDO) 用の Tail Worker。
 *
 * 背景: DtakoScraperRelayDO の ETC 診断ログ (`console.log`) は `ctx.waitUntil()`
 * で継続するバックグラウンド処理 (executeEtcScrapeAll → performEtcScrape →
 * submitSearch) の中で呼ばれており、Cloudflare Workers Logs (Observability
 * ダッシュボード) には反映されないことが実機で確認された (2026-07-04)。
 * Cloudflare 公式ドキュメント (Context (ctx) API) も「waitUntil() でログや
 * 例外を出す場合は Tail Worker を使うこと」を明示的に推奨している —
 * Tail Worker はプロデューサー側の invocation 状態と無関係に確実に実行される。
 *
 * この worker は `nuxt-dtako-admin-scraper-relay` (producer 側 wrangler.toml の
 * `tail_consumers`) から送られてくる TraceItem を受け取り、各 log/exception を
 * そのまま自分自身の `console.log`/`console.error` で出力するだけの薄い中継。
 * Tail Worker 自身の `tail()` は waitUntil に埋もれない通常の invocation なので、
 * ここで出した console.log はこの worker (`nuxt-dtako-admin-scraper-relay-tail`)
 * 自身の Workers Logs に確実に記録される。
 *
 * 値を加工・保存はしない (ログの転写のみ、状態を持たない)。
 */

interface TailEnv {
  // 現状 binding 無し。将来的に外部通知 (Slack 等) を足す場合はここに追加する。
}

export default {
  async tail(events: TraceItem[], _env: TailEnv, _ctx: ExecutionContext): Promise<void> {
    for (const event of events) {
      for (const log of event.logs) {
        const line = {
          tail_source: event.scriptName,
          tail_entrypoint: event.entrypoint,
          level: log.level,
          message: log.message,
          timestamp: log.timestamp,
        };
        if (log.level === "error" || log.level === "warn") {
          console.error(JSON.stringify(line));
        } else {
          console.log(JSON.stringify(line));
        }
      }
      for (const exception of event.exceptions) {
        console.error(
          JSON.stringify({
            tail_source: event.scriptName,
            tail_entrypoint: event.entrypoint,
            exception_name: exception.name,
            exception_message: exception.message,
            exception_stack: exception.stack,
            timestamp: exception.timestamp,
          }),
        );
      }
    }
  },
};
