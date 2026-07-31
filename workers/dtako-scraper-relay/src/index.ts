// nuxt-dtako-admin-scraper-relay — DtakoScraperRelayDO 専用 worker。
// app (nuxt-dtako-admin) から **service binding** 経由で /ws/scraper と
// /scraper-zip/* が転送されてくる。default fetch が DO instance に routing する
// (DO binding はこの worker 内部、migration もこの worker が持つ)。app 側は DO
// binding / migration を持たず no-traffic release を維持する (Refs error
// 10211/10061、nuxt-items/items-sync と同型)。
export { DtakoScraperRelayDO } from "./dtako-scraper-relay-do";
import { resolveTheearthRouting } from "./theearth-session";
import {
  buildDeps,
  relayKintaiDaySummaries,
  relayKintaiRecalc,
  relayKintaiWindow,
  tenantForCompId,
} from "./kintai-relay";
import { resolveDtakoAccountsRaw, resolveSecretBinding, runScheduledCron } from "./cron";

interface RelayWorkerEnv {
  RELAY: DurableObjectNamespace;
  SCRAPER_MODE?: string;
  DTAKO_ACCOUNTS?: unknown;
  /** relay の設定 KV (`dtako-relay-config`)。`dtako_accounts` が DTAKO_ACCOUNTS の正
   * — dashboard の plain 変数は deploy で消える (Refs #367)。 */
  DTAKO_CONFIG_KV?: unknown;
  ETC_ACCOUNTS?: unknown;
  /** auth-worker への service binding。`/ichibanboshi-proxy/*` (OIDC mint) に使う。 */
  AUTH_WORKER?: { fetch(input: string, init?: RequestInit): Promise<Response> };
  /** consumer worker proof (`X-Alc-Proxy-Secret`)。未設定なら打刻の中継は 503。 */
  INTERNAL_SHARED_SECRET?: unknown;
  /** オンプレ rust-ichibanboshi (CF Tunnel) の origin と CF Access Service Token。 */
  NUXT_ICHIBAN_API_URL?: string;
  NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID?: string;
  ICHIBAN_CF_ACCESS_CLIENT_SECRET?: unknown;
  /** 打刻を運ぶ対象の会社。tenant は KV の `dtako_accounts` から引く。 */
  KINTAI_COMP_ID?: string;
}

export default {
  async fetch(request: Request, env: RelayWorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.pathname.startsWith("/dvr-api/")
      || url.pathname.startsWith("/daily-report-api/")
      || url.pathname.startsWith("/restraint-api/")
      || url.pathname.startsWith("/net780-api/")
    ) {
      // DVR viewer (Refs #90)・日報編集 (Refs #169)・拘束時間管理表 CSV 取得
      // (Refs #241)・NET780 検索/一括ダウンロード (Refs #302) の theearth API。theearth
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

    if (url.pathname === "/kintai-relay/run" && request.method === "POST") {
      // 打刻をオンプレ → GCP へ 1 ページぶん運ぶ (Refs ohishi-exp/rust-ichibanboshi#205 の 04b)。
      // DO に載せない — 状態を持たず、直列化も要らない (オンプレ側がページで区切る)。
      return handleKintaiRelay(request, env);
    }

    if (url.pathname === "/kintai-relay/recalc" && request.method === "POST") {
      // 全量再計算を GCP 側で 1 ページぶん進める (Refs ohishi-exp/rust-ichibanboshi#205 の 10)。
      // 打刻を運ぶ経路ではない — deploy / TOML 変更で stale になった乗務員を畳み直すだけ
      return handleKintaiRecalc(request, env);
    }

    if (url.pathname === "/kintai-relay/day-summaries" && request.method === "GET") {
      // 畳んだ結果を読む (Refs ohishi-exp/rust-ichibanboshi#205 の 23)。
      // **GET だけ。** 受け側に書き込みの口が無いので、こちらにも作らない
      return handleKintaiDaySummaries(request, env);
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
            dtakoAccountsRaw: await resolveDtakoAccountsRaw(env.DTAKO_CONFIG_KV, env.DTAKO_ACCOUNTS),
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

/**
 * `POST /kintai-relay/run` — 打刻を**窓ぶんまるごと** 1 回で運ぶ。
 *
 * body は `{month?, month_count?, apply?}`。`month` 省略で JST の当月、
 * `month_count` 省略で 2 か月 (当月 + 前月)。**呼び直しは要らない** —
 * 乗務員でも日でも刻まないので 1 回で運びきる。
 * **`apply` を付けない限り 1 行も書かない** (受け側に `dry_run` を立てて渡す)。
 *
 * 宣言が欠けていれば **503 で fail-closed** — 「走ったが実は何も運んでいない」を
 * 作らない。tenant は KV の `dtako_accounts` から `KINTAI_COMP_ID` で引く
 * (呼び出し元に名乗らせない)。
 */
async function handleKintaiRelay(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const authWorker = env.AUTH_WORKER;
  const compId = (env.KINTAI_COMP_ID ?? "").trim();
  const origin = (env.NUXT_ICHIBAN_API_URL ?? "").trim();
  const cfId = (env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID ?? "").trim();
  const [proxySecret, cfSecret] = await Promise.all([
    resolveSecretBinding(env.INTERNAL_SHARED_SECRET),
    resolveSecretBinding(env.ICHIBAN_CF_ACCESS_CLIENT_SECRET),
  ]);
  if (!authWorker || !compId || !origin || !cfId || !proxySecret || !cfSecret) {
    return fail(503, "kintai-relay not configured");
  }

  // **呼び出し元の proof。** この口は app (worker/index.ts) が素通しするので外から
  // 到達しうる。書き込みを起動する機械経路なので、下流と同じ shared secret を
  // constant-time で検証する (`alc-internal-proxy` の consumer proof と同じ関門)。
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  const accountsRaw = await resolveDtakoAccountsRaw(env.DTAKO_CONFIG_KV, env.DTAKO_ACCOUNTS);
  let accounts: unknown = null;
  try {
    accounts = JSON.parse(accountsRaw || "null");
  } catch {
    accounts = null;
  }
  const tenantId = tenantForCompId(accounts, compId);
  if (!tenantId) {
    // KV から消えた時に静かに別テナントへ書かないよう loud fail (Refs #367 の実害)
    console.error(JSON.stringify({ kintai_relay: "tenant not resolved", comp_id: compId }));
    return fail(503, "tenant not resolved from dtako_accounts");
  }

  let body: { month?: unknown; month_count?: unknown; apply?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "body must be JSON");
  }

  const deps = buildDeps({
    ichibanOrigin: origin,
    cfAccessClientId: cfId,
    cfAccessClientSecret: cfSecret,
    authWorker,
    proxySecret,
    tenantId,
  });
  try {
    const report = await relayKintaiWindow(deps, {
      // month 省略 = JST の当月。窓は既定で当月 + 前月
      month: typeof body.month === "string" && body.month ? body.month : undefined,
      monthCount: typeof body.month_count === "number" ? body.month_count : undefined,
      apply: body.apply === true,
    });
    console.log(JSON.stringify({ kintai_relay: "ok", ...report }));
    return new Response(JSON.stringify(report), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ kintai_relay: "failed", message }));
    return fail(502, message);
  }
}

/**
 * `POST /kintai-relay/recalc` — 全量再計算を 1 ページぶん進める。
 *
 * body は `{month?, after_driver_cd?, max_drivers?, stale_only?, apply?}`。
 * `apply` を付けない限り GCP 側は `GET` (1 行も書かない preview) を叩く。
 * 応答 (`fold` / `stale` / `next_after_driver_cd`) はそのまま返す — 窓の中継と
 * 違い、続きの位置を呼び出し側が運ぶだけなのでこちらでは reshape しない。
 *
 * 認証・tenant 解決は `/kintai-relay/run` と同じ関門 (`X-Alc-Proxy-Secret` の
 * constant-time 検証 → KV `dtako_accounts` から `KINTAI_COMP_ID` で引く)。
 */
async function handleKintaiRecalc(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const authWorker = env.AUTH_WORKER;
  const compId = (env.KINTAI_COMP_ID ?? "").trim();
  const origin = (env.NUXT_ICHIBAN_API_URL ?? "").trim();
  const cfId = (env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID ?? "").trim();
  const [proxySecret, cfSecret] = await Promise.all([
    resolveSecretBinding(env.INTERNAL_SHARED_SECRET),
    resolveSecretBinding(env.ICHIBAN_CF_ACCESS_CLIENT_SECRET),
  ]);
  if (!authWorker || !compId || !origin || !cfId || !proxySecret || !cfSecret) {
    return fail(503, "kintai-relay not configured");
  }

  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  const accountsRaw = await resolveDtakoAccountsRaw(env.DTAKO_CONFIG_KV, env.DTAKO_ACCOUNTS);
  let accounts: unknown = null;
  try {
    accounts = JSON.parse(accountsRaw || "null");
  } catch {
    accounts = null;
  }
  const tenantId = tenantForCompId(accounts, compId);
  if (!tenantId) {
    console.error(JSON.stringify({ kintai_recalc: "tenant not resolved", comp_id: compId }));
    return fail(503, "tenant not resolved from dtako_accounts");
  }

  let body: {
    month?: unknown;
    after_driver_cd?: unknown;
    max_drivers?: unknown;
    stale_only?: unknown;
    apply?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "body must be JSON");
  }

  const deps = buildDeps({
    ichibanOrigin: origin,
    cfAccessClientId: cfId,
    cfAccessClientSecret: cfSecret,
    authWorker,
    proxySecret,
    tenantId,
  });
  try {
    const report = await relayKintaiRecalc(deps, {
      month: typeof body.month === "string" && body.month ? body.month : undefined,
      afterDriverCd: typeof body.after_driver_cd === "number" ? body.after_driver_cd : undefined,
      maxDrivers: typeof body.max_drivers === "number" ? body.max_drivers : undefined,
      staleOnly: body.stale_only === true,
      apply: body.apply === true,
    });
    console.log(JSON.stringify({ kintai_recalc: "ok" }));
    return new Response(JSON.stringify(report), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ kintai_recalc: "failed", message }));
    return fail(502, message);
  }
}

/**
 * `GET /kintai-relay/day-summaries?month=YYYY-MM[&driver=CD]` — 畳んだ結果を読む。
 *
 * **読むだけの口。** 受け側 (`src/routes/kintai_day_summaries.rs`) に `POST` は無く、
 * `recalc` の `apply` に当たるものも無い。ここを `POST` にしないのは、書ける口と
 * 見分けが付かなくなるため — この経路は method からして 1 行も書けない。
 *
 * 応答は**そのまま返す** (件数の要約も整形も挟まない)。用途はオンプレ基準 JSON との
 * 行単位の突合で、突合スクリプトがそのまま比較できることが目的。
 *
 * 認証・tenant 解決は `/kintai-relay/run` と同じ関門 (`X-Alc-Proxy-Secret` の
 * constant-time 検証 → KV `dtako_accounts` から `KINTAI_COMP_ID` で引く)。
 * なお受け側は `X-Tenant-ID` を読まず instance の設定で読み先を固定しているが、
 * ここでは他の中継と同じ形で名乗る (auth-worker の関門が `X-Tenant-ID` を必須にしており、
 * 欠けると 400 になる)。
 */
async function handleKintaiDaySummaries(
  request: Request,
  env: RelayWorkerEnv,
): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const authWorker = env.AUTH_WORKER;
  const compId = (env.KINTAI_COMP_ID ?? "").trim();
  const origin = (env.NUXT_ICHIBAN_API_URL ?? "").trim();
  const cfId = (env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID ?? "").trim();
  const [proxySecret, cfSecret] = await Promise.all([
    resolveSecretBinding(env.INTERNAL_SHARED_SECRET),
    resolveSecretBinding(env.ICHIBAN_CF_ACCESS_CLIENT_SECRET),
  ]);
  if (!authWorker || !compId || !origin || !cfId || !proxySecret || !cfSecret) {
    return fail(503, "kintai-relay not configured");
  }

  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  const accountsRaw = await resolveDtakoAccountsRaw(env.DTAKO_CONFIG_KV, env.DTAKO_ACCOUNTS);
  let accounts: unknown = null;
  try {
    accounts = JSON.parse(accountsRaw || "null");
  } catch {
    accounts = null;
  }
  const tenantId = tenantForCompId(accounts, compId);
  if (!tenantId) {
    console.error(JSON.stringify({ kintai_day_summaries: "tenant not resolved", comp_id: compId }));
    return fail(503, "tenant not resolved from dtako_accounts");
  }

  const url = new URL(request.url);
  const deps = buildDeps({
    ichibanOrigin: origin,
    cfAccessClientId: cfId,
    cfAccessClientSecret: cfSecret,
    authWorker,
    proxySecret,
    tenantId,
  });
  try {
    const summaries = await relayKintaiDaySummaries(deps, {
      month: url.searchParams.get("month") || undefined,
      driver: url.searchParams.get("driver") || undefined,
    });
    console.log(JSON.stringify({ kintai_day_summaries: "ok" }));
    return new Response(JSON.stringify(summaries), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ kintai_day_summaries: "failed", message }));
    return fail(502, message);
  }
}

/** 定数時間比較 (auth-worker の alc-internal-proxy.ts と同実装)。 */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
