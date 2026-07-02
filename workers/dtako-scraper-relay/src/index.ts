// nuxt-dtako-admin-scraper-relay — DtakoScraperRelayDO 専用 worker。
// app (nuxt-dtako-admin) から **service binding** 経由で /ws/scraper が転送されてくる。
// default fetch が session id → DO instance に routing する (DO binding はこの worker
// 内部、migration もこの worker が持つ)。app 側は DO binding / migration を持たず
// no-traffic release を維持する (Refs error 10211/10061、nuxt-items/items-sync と同型)。
export { DtakoScraperRelayDO } from "./dtako-scraper-relay-do";

interface RelayWorkerEnv {
  RELAY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws/scraper") {
      // session は browser 側が接続ごとに生成する一意な id (1 scrape トリガー = 1 DO)。
      const session = url.searchParams.get("session");
      if (!session) return new Response("Bad Request: missing session", { status: 400 });
      const id = env.RELAY.idFromName(`scraper-${session}`);
      return env.RELAY.get(id).fetch(request);
    }
    return new Response("nuxt-dtako-admin-scraper-relay: durable object worker", {
      status: 404,
    });
  },
};
