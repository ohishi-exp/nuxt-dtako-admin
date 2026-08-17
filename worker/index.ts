/**
 * Cloudflare Worker entry。Nuxt/Nitro (cloudflare-module preset) の出力を包んで
 * `/ws/scraper` だけ dtako-scraper-relay worker (nuxt-dtako-admin-scraper-relay) に
 * **service binding** 経由で転送し、それ以外は Nitro に委譲する。
 *
 * DtakoScraperRelayDO は別 worker に分離済み。app からは DO binding ではなく
 * **service binding (worker→worker fetch)** で叩く。session → DO instance の
 * routing は relay worker 側 (default fetch) が行う。app は DO binding
 * (class_name 参照) を持たないので DO migration / class 登録を一切持たず、
 * no-traffic `wrangler versions upload` release を維持できる (DO binding だと
 * class_name 参照が delete-class を阻む [error 10061])。
 *
 * 参考実装: nuxt-items/worker/index.ts (items-sync への service binding 転送)。
 */
// @ts-expect-error nuxt build (nitro cloudflare-module) が生成する成果物。
import nitroApp from "../.output/server/index.mjs";

interface NitroHandler {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
}

interface AppEnv {
  /** service binding → nuxt-dtako-admin-scraper-relay worker (DtakoScraperRelayDO を内包)。 */
  SCRAPER_RELAY: Fetcher;
}

export default {
  async fetch(
    request: Request,
    env: AppEnv & Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === "/ws/scraper"
      || url.pathname === "/ws/rdp"
      || url.pathname.startsWith("/scraper-zip/")
      || url.pathname.startsWith("/dvr-api/")
      || url.pathname.startsWith("/daily-report-api/")
      || url.pathname.startsWith("/restraint-api/")
      || url.pathname.startsWith("/net780-api/")
      || url.pathname.startsWith("/kintai-relay/")
    ) {
      // comp_id/session 抽出と DO routing は relay worker (default fetch) が行う。
      // ここは原 request (WS upgrade + query string、または zip ダウンロード GET) を
      // そのまま転送するだけ。/scraper-zip/* は SCRAPER_MODE=http (Refs
      // ohishi-exp/dtako-scraper#22) が生成する1回限りのダウンロード URL。
      // /dvr-api/* は /dvr-viewer (Refs #90) の DVR viewer API (login/notifications/
      // file/logout)。/daily-report-api/* は /daily-report-edit (日報編集、Refs #169)
      // の API — /dvr-api/* とは別の theearth ログインセッションを持つ
      // (X-Report-Comp-Id / X-Report-User-B64 routing ヘッダ、relay worker 側で解決)。
      // /kintai-relay/* は打刻をオンプレ → GCP へ運ぶ機械経路 (Refs
      // ohishi-exp/rust-ichibanboshi#205 の 04b)。**ブラウザ経路ではない** — relay 側が
      // X-Alc-Proxy-Secret を constant-time 検証する (ここは素通しするだけ)。
      // /ws/rdp はブラウザ内 RemoteApp ビューア ↔ 社内の RDP 中継 (Refs #693)。
      // relay worker が Workers VPC binding で社内へ出る。token の検証も
      // 向こう側 (auth-worker introspect) — ここは素通しするだけ。
      return env.SCRAPER_RELAY.fetch(request);
    }
    return (nitroApp as NitroHandler).fetch(request, env, ctx);
  },
};
