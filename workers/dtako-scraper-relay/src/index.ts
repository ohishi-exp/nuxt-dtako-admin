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
import {
  dispatchNetprintTargets,
  resolveDtakoAccountsRaw,
  resolveNetprintTargetsRaw,
  resolveSecretBinding,
  runScheduledCron,
  yesterdayJst,
} from "./cron";
import { planNetprintRun } from "./netprint-cron";
import {
  countSplitFailed,
  DEFAULT_HISTORY_LIMIT,
  dispatchScrapeDates,
  fetchScrapeHistory,
  fetchUnsplit,
  isValidDate,
  MAX_SCRAPE_DATES,
  planScrapeDispatch,
} from "./scrape-dispatch";

export interface RelayWorkerEnv {
  RELAY: DurableObjectNamespace;
  SCRAPER_MODE?: string;
  DTAKO_ACCOUNTS?: unknown;
  /** relay の設定 KV (`dtako-relay-config`)。`dtako_accounts` が DTAKO_ACCOUNTS の正、
   * `netprint_targets` が NETPRINT_TARGETS の正 — dashboard の plain 変数は deploy で
   * 消える (Refs #367)。 */
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
  /** auth-worker の origin。introspect の絶対 URL 組み立てにのみ使う。 */
  NUXT_PUBLIC_AUTH_WORKER_URL?: string;
  /** 運転日報 netprint cron の対象 (JSON 配列
   * `[{branch_cd, channel_id | recipient_id}, ...]`、Refs #874)。
   * **KV (`DTAKO_CONFIG_KV`) の `netprint_targets` が正で、この plain 変数は
   * fallback** — dashboard の plain 変数は deploy で消えるため (`dtako_accounts`
   * と同じ理由、Refs #367)。宛先はトークルーム (`channel_id`) か個人
   * (`recipient_id`) のどちらか一方 (#874-10)。KV も変数も未設定なら cron skip。 */
  NETPRINT_TARGETS?: unknown;
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

    if (url.pathname === "/kintai-relay/scrape" && request.method === "POST") {
      // 読取日を名指しで取り直す (Refs ohishi-exp/rust-ichibanboshi#205 の 42)。
      // **本番にデータを書く経路** — 受理しか返さない (結果は下の history で見る)
      return handleScrapeDispatch(request, env);
    }

    if (url.pathname === "/kintai-relay/scrape-history" && request.method === "GET") {
      // 取り直しの結果 (Refs #205 の 42)。**GET だけ。** 配布とは別の口にして、
      // 「起動した」を「終わった」と読み違えられないようにする
      return handleScrapeHistory(request, env);
    }

    if (url.pathname === "/kintai-relay/scrape-progress" && request.method === "GET") {
      // `/cron/dtako` (無人実行) の進捗 — 「まだ走っている/終わった/落ちた」を
      // 区別する (Refs #205-43)。scrape-history (alc 側、ブラウザ経路しか書かない)
      // とは別で、こちらは DO の scrapeQueue が持つ状態を直接見る。read-only
      return handleScrapeProgress(request, env);
    }

    if (url.pathname === "/kintai-relay/day-summaries" && request.method === "GET") {
      // 畳んだ結果を読む (Refs ohishi-exp/rust-ichibanboshi#205 の 23)。
      // **GET だけ。** 受け側に書き込みの口が無いので、こちらにも作らない
      return handleKintaiDaySummaries(request, env);
    }

    if (url.pathname === "/kintai-relay/operation-zip" && request.method === "POST") {
      // 運行 1 件ぶんの csvdata.zip を自前ログインで取る (Refs
      // ohishi-exp/rust-ichibanboshi#274, #205 の 59)。**同期。** 取り込みはしない
      // read-only な操作なので、scrape dispatch (202 非同期) とは別の型にする
      return handleOperationZip(request, env);
    }

    if (url.pathname === "/kintai-relay/dtako-reimport" && request.method === "POST") {
      // ① zip 取得 (自前ログイン) → ② オンプレ autoload push を 1 tool で完結させる
      // (Refs ohishi-exp/rust-ichibanboshi#280, #205 の 67)。**同期。** 取り込みまで
      // 行う書き込み経路なので `/kintai-relay/operation-zip` (read-only) とは別の口
      return handleDtakoReimport(request, env);
    }

    if (url.pathname === "/kintai-relay/dtako-alc-upload" && request.method === "POST") {
      // ① zip 取得 (自前ログイン) → ② alc `/api/upload` 投入を運行1件で完結させる
      // (Refs #633-7)。**同期。** `/kintai-relay/dtako-reimport` (オンプレ autoload
      // 向け) と対になる書き込み経路 — 投入先が alc なので unko_no は不要
      return handleDtakoAlcUpload(request, env);
    }

    if (url.pathname === "/kintai-relay/net780-archive" && request.method === "POST") {
      // 運行NO の一覧ぶんの NET780 生データを自前ログインで 検索→ダウンロード→
      // R2/D1 アーカイブする (Refs #760 の 26)。**同期。** 書き込みは自前の
      // アーカイブだけ (theearth は読むだけ) なので `/kintai-relay/operation-zip`
      // と同じ型 — 粗利タブの一括取得ボタン (#760-27) が叩く
      return handleNet780Archive(request, env);
    }

    if (url.pathname === "/kintai-relay/restraint-sync" && request.method === "POST") {
      // 拘束サマリの写し (R2 kintai/ prefix) を無人で押し直す (Refs #606-6)。
      // 画面の「取り込み」ボタン (POST /restraint-api/kintai/fetch) と同じ処理を
      // DO 内部 (/cron/restraint-sync) へ転送するだけ — auth-worker JWT / theearth
      // セッション前提の /restraint-api/* とは別の、機械呼び出し用の名前空間
      return handleRestraintSync(request, env);
    }

    if (url.pathname === "/kintai-relay/netprint-run" && request.method === "POST") {
      // 運転日報 netprint 登録 + LINE WORKS 通知を、cron (JST 6:30) を待たずに
      // 1 回走らせる (Refs #874)。cron 経路と同じ DO route (/cron/netprint) へ
      // 転送する — 実機確認が「cron でだけ通る道」にならないようにするため
      return handleNetprintRun(request, env);
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
            netprintTargetsRaw: await resolveNetprintTargetsRaw(
              env.DTAKO_CONFIG_KV,
              env.NETPRINT_TARGETS,
            ),
            kintaiCompId: env.KINTAI_COMP_ID,
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

/**
 * `POST /kintai-relay/operation-zip` — 運行 1 件ぶん (または `items` でまとめて
 * 複数件) の csvdata.zip を**自前ログイン** (`DTAKO_ACCOUNTS`) で取る (Refs
 * ohishi-exp/rust-ichibanboshi#274, #205 の 59。複数件対応は Refs #633-24a)。
 *
 * **body は素通しする。** このプロキシが持つのは認証 (`X-Alc-Proxy-Secret`) と
 * `comp_id` フォールバック (`KINTAI_COMP_ID`) と DO routing (`idFromName`) だけで、
 * `ope_no`/`start_ope`/`items`/`recalculate` 等のフィールド検証は一切しない —
 * 全て DO 側の `/cron/dtako/operation-zip` (`parseOperationZipRequest`、
 * `cron-batch.ts`) に委ねる。
 *
 * **★ 以前はここで `ope_no`/`start_ope` だけを拾って新しい object に組み直して
 * いた。この「拾い出し」が原因で、DO 側に `items`/`recalculate` を足しても
 * この層で黙って消えるバグを 2 回踏んだ (Refs #633-24)。二度と同じ穴を踏まない
 * ため、フィールド単位の組み直しを一切やめ、受け取った body をそのまま
 * (`comp_id` だけ解決値で上書きして) DO へ渡す設計にした。** DO へ新しい
 * フィールドを足しても、このプロキシは変更不要になる。
 *
 * **同期で返す。** `/kintai-relay/scrape` (取り込みまで走る非同期ジョブ) と違い、
 * この口は取り込み (`autoload` への POST) をしない read-only な zip 取得なので、
 * 「受理しただけ」の 202 にする理由が無い。
 *
 * 認証・tenant フォールバックは `/kintai-relay/scrape` と同じ (`X-Alc-Proxy-Secret`
 * の constant-time 検証、`comp_id` 省略時は `KINTAI_COMP_ID`)。
 */
export async function handleOperationZip(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!proxySecret) return fail(503, "kintai-relay not configured");
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "body must be JSON");
  }
  const compId =
    (typeof body.comp_id === "string" && body.comp_id.trim()) || (env.KINTAI_COMP_ID ?? "").trim();
  if (!compId) return fail(503, "comp_id が解決できません");

  const id = env.RELAY.idFromName(`scraper-comp-${compId}`);
  const res = await env.RELAY.get(id).fetch("https://relay.internal/cron/dtako/operation-zip", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // body を素通しし、comp_id だけ解決値で上書きする (フィールド単位の組み直しはしない)。
    body: JSON.stringify({ ...body, comp_id: compId }),
  });
  // DO の応答 (成功も失敗も) をそのまま素通しする — ここで reshape しない。
  // ope_no/start_ope 等の検証エラーも DO の文言のままここを通る (Refs #633-24a)。
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `POST /kintai-relay/dtako-reimport` — 運行 1 件 (または `items` でまとめて
 * 複数件) の csvdata.zip を**自前ログイン**で取り、オンプレ rust-ichibanboshi の
 * `POST /api/dtako/autoload` (Refs #205 の 58/61/63/65、変更しない) へそのまま
 * push する (Refs ohishi-exp/rust-ichibanboshi#280、#205 の 67。複数件対応は
 * Refs #633-24a)。
 *
 * **body は素通しする** (`handleOperationZip` の doc comment 参照 — フィールド
 * 単位の組み直しをやめた理由も同じ)。`ope_no`/`start_ope`/`unko_no`/`items` の
 * 検証は DO 側の `/cron/dtako/reimport` (`parseDtakoReimportRequest`) に委ねる。
 * `/kintai-relay/operation-zip` (read-only) と違い**取り込みを伴う書き込み経路**
 * なので、別の口にする。
 *
 * **同期で返す。** entries (zip 内ファイル名) とオンプレの応答をその場で見られる
 * ようにする — `/kintai-relay/scrape` (202 非同期) とは違う型。
 *
 * 認証・tenant フォールバックは `/kintai-relay/operation-zip` と同じ
 * (`X-Alc-Proxy-Secret` の constant-time 検証、`comp_id` 省略時は `KINTAI_COMP_ID`)。
 */
export async function handleDtakoReimport(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!proxySecret) return fail(503, "kintai-relay not configured");
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "body must be JSON");
  }
  const compId =
    (typeof body.comp_id === "string" && body.comp_id.trim()) || (env.KINTAI_COMP_ID ?? "").trim();
  if (!compId) return fail(503, "comp_id が解決できません");

  const id = env.RELAY.idFromName(`scraper-comp-${compId}`);
  const res = await env.RELAY.get(id).fetch("https://relay.internal/cron/dtako/reimport", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // body を素通しし、comp_id だけ解決値で上書きする (フィールド単位の組み直しはしない)。
    body: JSON.stringify({ ...body, comp_id: compId }),
  });
  // DO の応答 (成功も失敗も) をそのまま素通しする — ここで reshape しない。
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `POST /kintai-relay/dtako-alc-upload` — 運行 1 件 (または `items` でまとめて
 * 複数件) の csvdata.zip を**自前ログイン**で取り、rust-alc-api の
 * `POST /api/upload` へそのまま投入する (Refs #633-7。複数件対応は Refs #633-24a)。
 *
 * **body は素通しする** (`handleOperationZip` の doc comment 参照)。`ope_no`/
 * `start_ope`/`items` の検証は DO 側の `/cron/dtako/alc-upload`
 * (`parseDtakoAlcUploadRequest`) に委ねる。`unko_no` は不要 — `/api/upload` は
 * zip 内の KUDGURI.csv から読むため URL に載せる必要が無い
 * (`/kintai-relay/dtako-reimport` = オンプレ autoload 向けとの違い)。
 *
 * **同期で返す。** entries (zip 内ファイル名) と alc の応答 (upload_id/split の
 * 未確定注記) をその場で見られるようにする — `/kintai-relay/dtako-reimport` と
 * 同じ型。
 *
 * 認証・tenant フォールバックは `/kintai-relay/operation-zip` と同じ
 * (`X-Alc-Proxy-Secret` の constant-time 検証、`comp_id` 省略時は `KINTAI_COMP_ID`)。
 */
export async function handleDtakoAlcUpload(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!proxySecret) return fail(503, "kintai-relay not configured");
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "body must be JSON");
  }
  const compId =
    (typeof body.comp_id === "string" && body.comp_id.trim()) || (env.KINTAI_COMP_ID ?? "").trim();
  if (!compId) return fail(503, "comp_id が解決できません");

  const id = env.RELAY.idFromName(`scraper-comp-${compId}`);
  const res = await env.RELAY.get(id).fetch("https://relay.internal/cron/dtako/alc-upload", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // body を素通しし、comp_id だけ解決値で上書きする (フィールド単位の組み直しはしない)。
    body: JSON.stringify({ ...body, comp_id: compId }),
  });
  // DO の応答 (成功も失敗も) をそのまま素通しする — ここで reshape しない。
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `POST /kintai-relay/net780-archive` — 運行NO の一覧ぶん (`items`、上限は DO 側の
 * `CRON_BATCH_MAX_ITEMS`) の NET780 生データを**自前ログイン**で 検索 →
 * ダウンロード → R2 + D1 `dtako_uploads` にアーカイブする (Refs #760 の 26)。
 * 粗利タブの地図 (#783) の「NET780 を一括取得」ボタン (#760-27) が server route
 * 経由で叩く。
 *
 * **body は素通しする** (`handleOperationZip` の doc comment 参照 — フィールド
 * 単位の組み直しで新フィールドが消えるバグを 2 回踏んだ教訓、Refs #633-24)。
 * `items` の検証 (22 桁 / `start_ope` 形式 / 上限) は全て DO 側
 * `/cron/dtako/net780-archive` (`parseNet780ArchiveRequest`、`net780-archive.ts`)
 * に委ねる。
 *
 * **同期で返す。** theearth 側は読むだけ (書き込みは自前の R2/D1 だけ) なので
 * `/kintai-relay/operation-zip` と同じ型。応答 (200) は
 * `{ok, comp_id, results[{ope_no, status: archived|already|not_found|error,
 * bytes?, message?}], success_count, failure_count, truncated, remaining,
 * theearth_logins}`。
 *
 * 認証・tenant フォールバックは `/kintai-relay/operation-zip` と同じ
 * (`X-Alc-Proxy-Secret` の constant-time 検証、`comp_id` 省略時は `KINTAI_COMP_ID`)。
 */
export async function handleNet780Archive(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!proxySecret) return fail(503, "kintai-relay not configured");
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return fail(400, "body must be JSON");
  }
  const compId =
    (typeof body.comp_id === "string" && body.comp_id.trim()) || (env.KINTAI_COMP_ID ?? "").trim();
  if (!compId) return fail(503, "comp_id が解決できません");

  const id = env.RELAY.idFromName(`scraper-comp-${compId}`);
  const res = await env.RELAY.get(id).fetch("https://relay.internal/cron/dtako/net780-archive", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // body を素通しし、comp_id だけ解決値で上書きする (フィールド単位の組み直しはしない)。
    body: JSON.stringify({ ...body, comp_id: compId }),
  });
  // DO の応答 (成功も失敗も) をそのまま素通しする — ここで reshape しない。
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `POST /kintai-relay/restraint-sync` — 拘束サマリの写し (R2 `kintai/` prefix) を
 * 指定した年月ぶん無人で押し直す (Refs #606-6)。
 *
 * body は `{month, comp_id?}`。**`month` は必須。** `comp_id` 省略時は
 * `KINTAI_COMP_ID` (`/kintai-relay/operation-zip` と同じフォールバック)。
 * `month` の形式チェック (YYYY-MM) は DO 側 (`handleKintaiFetch` の
 * `parseMonthParam`) が持つ — ここでは素通しする。
 *
 * **`/restraint-api/kintai/fetch` (auth-worker JWT / theearth セッション前提の
 * viewer 名前空間) は経由しない。** DO 内部の `/cron/restraint-sync` へ直接
 * 転送する — 認証・comp_id フォールバックは `/kintai-relay/operation-zip` と同じ
 * (`X-Alc-Proxy-Secret` の constant-time 検証)。
 *
 * **押した写しは表示に使われない** (#606-5 決定)。突合・履歴用のスナップショットを
 * 最新に保つのが目的で、同期が失敗しても画面は壊れない。
 */
async function handleRestraintSync(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!proxySecret) return fail(503, "kintai-relay not configured");
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  let body: { month?: unknown; comp_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "body must be JSON");
  }
  const month = typeof body.month === "string" ? body.month : "";
  if (!month) return fail(400, "month は必須です");
  const compId =
    (typeof body.comp_id === "string" && body.comp_id.trim()) || (env.KINTAI_COMP_ID ?? "").trim();
  if (!compId) return fail(503, "comp_id が解決できません");

  const id = env.RELAY.idFromName(`scraper-comp-${compId}`);
  const res = await env.RELAY.get(id).fetch("https://relay.internal/cron/restraint-sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ comp_id: compId, month }),
  });
  // DO の応答 (成功も失敗も) をそのまま素通しする — ここで reshape しない。
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/**
 * `POST /kintai-relay/netprint-run` — 運転日報の netprint 登録 + LINE WORKS 通知を
 * cron (JST 6:30) を待たずに 1 回走らせる (Refs #874)。
 *
 * body は全部省略可 `{date?, branch_cd?, channel_id?, recipient_id?, branch_name?, comp_id?}`:
 * - `date` 省略で**前日 (JST)** = cron と同じ対象日。指定は `YYYY-MM-DD`
 * - `branch_cd` + 宛先 (`channel_id` か `recipient_id` の**どちらか一方**) を
 *   **揃えて**渡すとその 1 件だけ走る (`NETPRINT_TARGETS` を触らずに試験用の宛先へ
 *   流せる)。片方だけ / 宛先の両方指定は 400
 * - どちらも省略で `NETPRINT_TARGETS` の全 target = cron と同じ動き
 * - `comp_id` 省略時は `KINTAI_COMP_ID` (他の `/kintai-relay/*` と同じ)
 *
 * **cron と同じ DO route (`/cron/netprint`) を叩く** — 実機確認が「cron でだけ
 * 通る道」にならないようにするため。認証は他の `/kintai-relay/*` と同じ
 * `X-Alc-Proxy-Secret` の constant-time 検証。
 *
 * **応答は同期** (netprint の status poll 完了まで待つので数分かかりうる)。
 * 各 target の結果 (`ok` / `detail` / 予約番号は DO 側 detail に載る) を返す。
 */
export async function handleNetprintRun(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!proxySecret) return fail(503, "kintai-relay not configured");
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  let body: {
    date?: unknown;
    branch_cd?: unknown;
    channel_id?: unknown;
    recipient_id?: unknown;
    branch_name?: unknown;
    comp_id?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "body must be JSON");
  }

  const compId =
    (typeof body.comp_id === "string" && body.comp_id.trim()) || (env.KINTAI_COMP_ID ?? "").trim();
  if (!compId) return fail(503, "comp_id が解決できません");

  let plan;
  try {
    plan = planNetprintRun(
      body,
      await resolveNetprintTargetsRaw(env.DTAKO_CONFIG_KV, env.NETPRINT_TARGETS),
      yesterdayJst(new Date()),
    );
  } catch (err) {
    // NETPRINT_TARGETS の JSON 不正 (CronConfigError)。cron 側と同じく loud fail —
    // 手動実行では応答にも理由を載せる (叩いた人がその場で直せるように)。
    const detail = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ netprint_run: "targets-config-error", error: detail }));
    return fail(503, detail);
  }
  if ("error" in plan) return fail(400, plan.error);

  const results = await dispatchNetprintTargets(compId, plan.targets, plan.date, async (doKey, path, doBody) => {
    const id = env.RELAY.idFromName(doKey);
    const res = await env.RELAY.get(id).fetch(`https://relay.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(doBody),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  });
  for (const result of results) {
    const line = JSON.stringify({ netprint_run: "manual", date: plan.date, ...result });
    if (result.ok) console.log(line);
    else console.error(line);
  }
  return new Response(
    JSON.stringify({ ok: results.every((r) => r.ok), date: plan.date, results }),
    {
      status: results.every((r) => r.ok) ? 200 : 502,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    },
  );
}

/**
 * `POST /kintai-relay/scrape` — **読取日を名指しで取り直す** (Refs
 * ohishi-exp/rust-ichibanboshi#205 の 42)。
 *
 * body は `{dates: ["YYYY-MM-DD", ...], comp_id?}`。**`dates` は必須**で、
 * 既定値を作らない (`scrape-dispatch.ts` の docs — 取り込みは `has_kudgivt` を
 * 一旦 `FALSE` に戻すので、要らない日を巻き込むと運行が読み取り側から消える)。
 *
 * **応答は「受理した」までしか言わない。** `/cron/dtako` は 202 を返して非同期に
 * 走るので、結果は `GET /kintai-relay/scrape-history` で別に見る。
 * 認証・設定の関門は `/kintai-relay/run` と同じ (`X-Alc-Proxy-Secret`)。
 */
async function handleScrapeDispatch(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!proxySecret) return fail(503, "kintai-relay not configured");
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  let body: { dates?: unknown; comp_id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "body must be JSON");
  }
  if (!Array.isArray(body.dates) || body.dates.length === 0) {
    return fail(400, "dates (YYYY-MM-DD の配列) は必須です");
  }
  const compId =
    (typeof body.comp_id === "string" && body.comp_id.trim()) || (env.KINTAI_COMP_ID ?? "").trim();
  if (!compId) return fail(503, "comp_id が解決できません");

  const plan = planScrapeDispatch(body.dates);
  if (plan.dates.length === 0) {
    return fail(400, `YYYY-MM-DD として読める日付がありません: ${plan.invalid.join(", ")}`);
  }

  const dispatched = await dispatchScrapeDates(compId, plan.dates, async (doKey, path, payload) => {
    const id = env.RELAY.idFromName(doKey);
    const res = await env.RELAY.get(id).fetch(`https://relay.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return { ok: res.ok, status: res.status, text: await res.text() };
  });
  console.log(JSON.stringify({ scrape_dispatch: compId, dates: plan.dates.length }));

  return new Response(
    JSON.stringify({
      comp_id: compId,
      // **ここが一番大事** — 受理は完了ではない
      note:
        "**受理しただけで、まだ結果は出ていません。** スクレイプは非同期に走ります。" +
        "結果 (status / split_failed) は GET /kintai-relay/scrape-history で確認してください。",
      dispatched,
      accepted_dates: dispatched.filter((d) => d.accepted).map((d) => d.date),
      failed_dates: dispatched.filter((d) => !d.accepted).map((d) => d.date),
      // 黙って切らない
      truncated_dates: plan.truncated,
      invalid_dates: plan.invalid,
      max_dates_per_call: MAX_SCRAPE_DATES,
    }),
    { status: 202, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}

/**
 * `GET /kintai-relay/scrape-history?limit=` — 取り直しの**結果**を alc から引く
 * (Refs #205 の 42)。配布 (`POST /kintai-relay/scrape`) とは別の口。
 */
async function handleScrapeHistory(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const authWorker = env.AUTH_WORKER;
  const compId = (env.KINTAI_COMP_ID ?? "").trim();
  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!authWorker || !compId || !proxySecret) return fail(503, "kintai-relay not configured");
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
  if (!tenantId) return fail(503, "tenant not resolved from dtako_accounts");

  const params = new URL(request.url).searchParams;
  const raw = params.get("limit");
  const parsed = raw === null ? DEFAULT_HISTORY_LIMIT : Number.parseInt(raw, 10);
  const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : DEFAULT_HISTORY_LIMIT;

  const proxy = ((input: unknown, init?: RequestInit) =>
    authWorker.fetch(input as string, init)) as unknown as typeof fetch;

  let history: unknown;
  try {
    history = await fetchScrapeHistory({ sharedSecret: proxySecret, tenantId, limit }, proxy);
  } catch (err) {
    return fail(502, err instanceof Error ? err.message : String(err));
  }

  // **`split_failed` だけでは足りない。** date_from/date_to をもらえたら
  // `has_kudgivt = FALSE` が残っているかを alc の etags から直接数える
  // (`scrape-dispatch.ts` の fetchUnsplit の docs)。もらえなければ **null** —
  // 「残っていない」と「見ていない」を混ぜない
  const dateFrom = params.get("date_from");
  const dateTo = params.get("date_to");
  let unsplitTotal: number | null = null;
  let unsplit: unknown[] = [];
  let unsplitError: string | null = null;
  if (isValidDate(dateFrom) && isValidDate(dateTo)) {
    try {
      const got = await fetchUnsplit(
        { sharedSecret: proxySecret, tenantId, dateFrom, dateTo },
        proxy,
      );
      unsplitTotal = got.unsplit_total;
      unsplit = got.unsplit;
    } catch (err) {
      // **観測が落ちても履歴は返す。** ただし黙らない
      unsplitError = err instanceof Error ? err.message : String(err);
    }
  }

  return new Response(
    JSON.stringify({
      limit,
      split_failed: countSplitFailed(history),
      // **null は「見ていない」** (date_from / date_to が無い、または引けなかった)
      unsplit_total: unsplitTotal,
      unsplit,
      unsplit_error: unsplitError,
      // **十分条件ではない** ことを応答自身に書く
      note:
        "split_failed が 0 でも has_kudgivt = FALSE が残ることがあります " +
        "(alc の update_has_kudgivt が当たらなくても Ok(0) を返すため)。" +
        "必要条件であって十分条件ではありません。" +
        "確実に確かめるには date_from / date_to を渡して unsplit_total を見てください " +
        "(null は「残っていない」ではなく「見ていない」)。",
      history,
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
  );
}

/** `dtako_accounts` から重複無しの comp_id 一覧を取る。空 / comp_id を持たない行は
 * 無視する (`tenantForCompId` と同じ規約)。 */
function compIdsOf(accounts: unknown): string[] {
  if (!Array.isArray(accounts)) return [];
  const seen = new Set<string>();
  for (const a of accounts) {
    if (typeof a !== "object" || a === null) continue;
    const compId = (a as { comp_id?: unknown }).comp_id;
    if (typeof compId === "string" && compId.trim()) seen.add(compId.trim());
    else if (typeof compId === "number") seen.add(String(compId));
  }
  return [...seen];
}

/**
 * `GET /kintai-relay/scrape-progress?comp_id=` — `/cron/dtako` (無人実行) の
 * 進捗を DO から直接引く (Refs #205-43)。scrape-history (alc 側、ブラウザ経路
 * しか書かないので無人実行は載らない) とは別の口。
 *
 * **DO は comp_id ごとの instance** なので、`comp_id` を渡さなければ
 * `dtako_accounts` に載っている**全社ぶん**を返す — 「片方しか見ていないのに
 * 全部に見える」形を避けるため、常にどの comp のものかを応答に残す。
 */
async function handleScrapeProgress(request: Request, env: RelayWorkerEnv): Promise<Response> {
  const fail = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const proxySecret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!proxySecret) return fail(503, "kintai-relay not configured");
  const caller = request.headers.get("X-Alc-Proxy-Secret") ?? "";
  if (!constantTimeEquals(caller, proxySecret)) return fail(401, "Unauthorized");

  const accountsRaw = await resolveDtakoAccountsRaw(env.DTAKO_CONFIG_KV, env.DTAKO_ACCOUNTS);
  let accounts: unknown = null;
  try {
    accounts = JSON.parse(accountsRaw || "null");
  } catch {
    accounts = null;
  }

  const requested = new URL(request.url).searchParams.get("comp_id")?.trim();
  const compIds = requested ? [requested] : compIdsOf(accounts);
  if (compIds.length === 0) {
    return fail(503, "comp_id が解決できません (dtako_accounts が空、または comp_id を指定してください)");
  }

  const comps = await Promise.all(
    compIds.map(async (compId) => {
      const id = env.RELAY.idFromName(`scraper-comp-${compId}`);
      try {
        const res = await env.RELAY.get(id).fetch("https://relay.internal/cron/dtako/progress");
        const text = await res.text();
        if (!res.ok) return { comp_id: compId, error: `status ${res.status}: ${text.slice(0, 200)}` };
        return { comp_id: compId, ...(JSON.parse(text) as Record<string, unknown>) };
      } catch (err) {
        return { comp_id: compId, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  return new Response(JSON.stringify({ comps }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
