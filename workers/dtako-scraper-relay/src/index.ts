// nuxt-dtako-admin-scraper-relay — DtakoScraperRelayDO 専用 worker。
// app (nuxt-dtako-admin) から **service binding** 経由で /ws/scraper と
// /scraper-zip/* が転送されてくる。default fetch が DO instance に routing する
// (DO binding はこの worker 内部、migration もこの worker が持つ)。app 側は DO
// binding / migration を持たず no-traffic release を維持する (Refs error
// 10211/10061、nuxt-items/items-sync と同型)。
export { DtakoScraperRelayDO } from "./dtako-scraper-relay-do";
import { resolveTheearthRouting } from "./theearth-session";
import { resolveSecretBinding, runScheduledCron } from "./cron";

interface RelayWorkerEnv {
  RELAY: DurableObjectNamespace;
  SCRAPER_MODE?: string;
  DTAKO_ACCOUNTS?: unknown;
  ETC_ACCOUNTS?: unknown;
}

export default {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname.startsWith("/dvr-api/")
      || url.pathname.startsWith("/daily-report-api/")
      || url.pathname.startsWith("/restraint-api/")
    ) {
      // DVR viewer (Refs #90)・日報編集 (Refs #169)・拘束時間管理表 CSV 取得
      // (Refs #241) の theearth API。theearth
      // アカウント単位 (`theearth-{comp}:{userB64}`) で DO を引くことで、同一
      // アカウントのセッションを両ページ共有の 1 instance に集約する (theearth は
      // 同一アカウント複数セッションを許さないため、経路ごとに分けるとログインの
      // たびに他方が kick される、Refs #233)。password はヘッダに載らない (login
      // の JSON body のみ) — routing に使うのは comp_id とユーザー名だけ。
      const routing = resolveTheearthRouting(request.headers);
      if (!routing) {
        return new Response(
          "Bad Request: missing/invalid X-Theearth-Comp-Id / X-Theearth-User-B64",
          { status: 400 },
        );
      }
      const id = env.RELAY.idFromName(routing.doKey);
      return env.RELAY.get(id).fetch(request);
    }

    if (url.pathname === "/ws/scraper") {
      // SCRAPER_MODE=http (Refs ohishi-exp/dtako-scraper#22) は comp_id 単位で
      // DO を分けることで同一企業への並列リクエストを自然に直列化する。comp_id が
      // 無い呼び出し (全企業一括トリガー) は従来どおり session 単位で振り分け、
      // vpc-relay 経路 (VPS の dtako-scraper が複数企業を直列処理する) に委ねる。
      // kind=etc (管理タブの ETC 手動実行、Refs #134) は user_id 単位で cron と
      // 同じ DO キー (`etc-{user_id}`) に振り分ける。kind=etc-all (ETC_ACCOUNTS
      // 全件一括実行、user_id 手入力の廃止) は固定キーのディスパッチャ DO に
      // 振り分け、アカウント一覧の解決・fan-out はその DO 自身が行う。
      const kind = url.searchParams.get("kind");
      const key =
        kind === "etc"
          ? (() => {
              const userId = url.searchParams.get("user_id");
              return userId ? `etc-${userId}` : null;
            })()
          : kind === "etc-all"
            ? "etc-admin-all"
            : (() => {
                const compId = url.searchParams.get("comp_id");
                const session = url.searchParams.get("session");
                return compId ? `scraper-comp-${compId}` : session ? `scraper-session-${session}` : null;
              })();
      if (!key) {
        return new Response("Bad Request: missing comp_id/user_id or session", { status: 400 });
      }
      const id = env.RELAY.idFromName(key);
      return env.RELAY.get(id).fetch(request);
    }

    if (url.pathname.startsWith("/scraper-zip/")) {
      // /scraper-zip/{compId}/{requestId} — SCRAPER_MODE=http が生成した1回限りの
      // zip ダウンロード URL。zip を保持している DO (= 同じ comp_id) に転送する。
      const compId = url.pathname.split("/").filter(Boolean)[1];
      if (!compId) return new Response("Bad Request: missing comp_id", { status: 400 });
      const id = env.RELAY.idFromName(`scraper-comp-${compId}`);
      return env.RELAY.get(id).fetch(request);
    }

    return new Response("nuxt-dtako-admin-scraper-relay: durable object worker", {
      status: 404,
    });
  },

  /**
   * Cron Triggers (wrangler.toml `[triggers]`) — VPS / GCE cron の Worker 移行
   * (Refs ohishi-exp/dtako-scraper#22 / ohishi-exp/browser-render-rust#14)。
   *
   * - dtako 日次 (`0 16 * * *` UTC = 01:00 JST): DTAKO_ACCOUNTS の各社について
   *   comp_id 単位 DO の `/cron/dtako` を叩く (SCRAPER_MODE=http の時のみ)。
   * - ETC (`0 21,22,23,0 * * *` UTC = JST 6,7,8,9 時): ETC_ACCOUNTS の各
   *   アカウントについて `etc-{user_id}` DO の `/cron/etc` を叩く。
   *
   * DO 側は job を受理して即 202 を返す (実処理は DO 内で直列化して走り、
   * 結果は DO の console log = Workers Observability に出る)。
   */
  async scheduled(
    controller: ScheduledController,
    env: RelayWorkerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const results = await runScheduledCron(
          controller.cron,
          {
            scraperMode: env.SCRAPER_MODE,
            dtakoAccountsRaw: await resolveSecretBinding(env.DTAKO_ACCOUNTS),
            etcAccountsRaw: await resolveSecretBinding(env.ETC_ACCOUNTS),
          },
          async (doKey, path, body) => {
            const id = env.RELAY.idFromName(doKey);
            const res = await env.RELAY.get(id).fetch(`https://relay.internal${path}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            return { ok: res.ok, status: res.status, text: await res.text() };
          },
          new Date(),
        );
        for (const r of results) {
          const line = JSON.stringify({ scheduled: controller.cron, ...r });
          if (r.ok) console.log(line);
          else console.error(line);
        }
      })(),
    );
  },
};
