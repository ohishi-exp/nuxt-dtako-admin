// nuxt-dtako-admin-scraper-relay — DtakoScraperRelayDO 専用 worker。
// app (nuxt-dtako-admin) から **service binding** 経由で /ws/scraper と
// /scraper-zip/* が転送されてくる。default fetch が DO instance に routing する
// (DO binding はこの worker 内部、migration もこの worker が持つ)。app 側は DO
// binding / migration を持たず no-traffic release を維持する (Refs error
// 10211/10061、nuxt-items/items-sync と同型)。
export { DtakoScraperRelayDO } from "./dtako-scraper-relay-do";
import { resolveDvrRouting } from "./dvr-session";

interface RelayWorkerEnv {
  RELAY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/dvr-api/")) {
      // /dvr-viewer (Refs #90) の DVR viewer API。theearth アカウント単位
      // (`dvr-{comp}:{userB64}`) で DO を引くことで、同一アカウントのセッションを
      // 1 instance に集約する (theearth は同一アカウント複数セッションを許さない)。
      // password はヘッダに載らない (login の JSON body のみ) — routing に使うのは
      // comp_id とユーザー名だけ。
      const routing = resolveDvrRouting(request.headers);
      if (!routing) {
        return new Response("Bad Request: missing/invalid X-Dvr-Comp-Id / X-Dvr-User-B64", {
          status: 400,
        });
      }
      const id = env.RELAY.idFromName(routing.doKey);
      return env.RELAY.get(id).fetch(request);
    }

    if (url.pathname === "/ws/scraper") {
      // SCRAPER_MODE=http (Refs ohishi-exp/dtako-scraper#22) は comp_id 単位で
      // DO を分けることで同一企業への並列リクエストを自然に直列化する。comp_id が
      // 無い呼び出し (全企業一括トリガー) は従来どおり session 単位で振り分け、
      // vpc-relay 経路 (VPS の dtako-scraper が複数企業を直列処理する) に委ねる。
      const compId = url.searchParams.get("comp_id");
      const session = url.searchParams.get("session");
      const key = compId ? `scraper-comp-${compId}` : session ? `scraper-session-${session}` : null;
      if (!key) {
        return new Response("Bad Request: missing comp_id or session", { status: 400 });
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
};
