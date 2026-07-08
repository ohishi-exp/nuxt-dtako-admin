/**
 * DtakoScraperRelayDO — browser の scrape-trigger WebSocket を受け、2通りの経路の
 * いずれかで dtako 運行ログの CSV (csvdata.zip) を取得する Durable Object。
 *
 * - `SCRAPER_MODE=vpc-relay` (デフォルト、既存挙動): Kagoya VPS 上の dtako-scraper
 *   (`/scrape/ws`、chromiumoxide ヘッドレス Chrome) に Workers VPC binding 経由で
 *   中継する。dtako-scraper は VPS の `127.0.0.1:8081` にしか bind されておらず、
 *   GCP Cloud Run からは到達不可能なため、front (nuxt-dtako-admin, 既に Worker) が
 *   既存の `kagoya_tunnel` へ Workers VPC binding (beta) で直接到達してこの relay
 *   を持つ。
 * - `SCRAPER_MODE=http` (ohishi-exp/dtako-scraper#22 のブラウザレス化): Chromium を
 *   使わず、この DO 自身が theearth-np.com に素の `fetch()` でログイン + CSV
 *   ダウンロードを行う (`./theearth-client.ts`)。DO を `comp_id` 単位で
 *   `idFromName` するため (`index.ts` 参照)、同一企業への並列リクエストは自然に
 *   直列化される (issue #22 の設計どおり)。取得した zip は `ctx.storage` に一時
 *   保存し、`/scraper-zip/:compId/:requestId` で 1 回だけダウンロードできる。
 *
 * browser ──WS (Hibernatable)──> このDO ──(vpc-relay: WS / http: fetch)──> upstream
 *
 * 認証: browser から渡された auth-worker JWT を `/auth/introspect` で検証する
 * (nuxt-items の ItemsSyncDO と同型)。tenant 突き合わせは不要 (auth-decision.ts 参照)。
 *
 * hibernation について: vpc-relay 経路は上流の素の WebSocket を保持する間 DO が
 * 常に active になる。http 経路は `ctx.waitUntil` でスクレイプ完了まで active を
 * 維持する。browser 側だけ Hibernatable API を使うのは、org 標準の「DO の WS は
 * 必ず Hibernatable API 経由」を満たすため。
 *
 * auth-worker 呼び出しは全て `AUTH_WORKER` service binding 経由 (Worker→Worker
 * in-process fetch、素の公開 fetch より低遅延)。SCRAPER_MODE=http で取得した zip の
 * rust-alc-api 自動アップロードも、device pairing (device JWT) ではなく
 * `/alc-internal-proxy/api/upload` (shared-secret 経路、`./alc-internal-upload.ts`)
 * を使う — この DO はブラウザ JWT を持たない server-to-server caller で、かつ
 * `comp_id` は複数 tenant にまたがりうるため、tenant は DTAKO_ACCOUNTS (comp_id ->
 * tenant_id) から解決した値を明示 X-Tenant-ID として渡す (Refs
 * ohishi-exp/dtako-scraper#22, ippoan/rust-alc-api#434)。
 */
import { DurableObject } from "cloudflare:workers";
import { decideRelayAuth, type IntrospectResult } from "./auth-decision";
import {
  createCookieJar,
  login,
  scrapeViaHttp,
  TheearthClientError,
  TheearthNotZipError,
  type CookieJar,
} from "./theearth-client";
import { uploadDtakoZipViaAlcInternalProxy } from "./alc-internal-upload";
import {
  EtcMeisaiClientError,
  EtcMeisaiNoUsageError,
  EtcMeisaiNotCsvError,
  resolveScrapeMonthAnchor,
  scrapeEtcCsv,
  type ScrapeMonthTarget,
} from "./etc-meisai-client";
import { CronConfigError, etcCsvKey, parseEtcAccounts, type EtcAccountEntry } from "./cron";
import {
  buildDvrSearchKey,
  dvrDataUrl,
  DvrSearchParamError,
  getDvrMasters,
  getDvrNotifications,
  getVehicleLogTrack,
  getVehicleStates,
  openDvrFileStream,
  requestDvrDownloadPath,
  requestDvrFileTransfer,
  requestDvrFileTransferMulti,
  searchDvrData,
  VenusSessionExpiredError,
  type DvrSearchParams,
} from "./theearth-venus-client";
import {
  DVR_SESSION_TTL_MS,
  isDvrSessionValid,
  resolveDvrRouting,
  type DvrRouting,
  type DvrSessionRecord,
} from "./dvr-session";
import {
  downloadEditedZip,
  forceUnlockAll,
  getExpenseForm,
  harvestDailyReport,
  recalculateExpense,
  ReportParamError,
  saveFuelRow,
  verifyReadNoDescending,
  type SaveFuelRowParams,
} from "./theearth-report-client";
import {
  isReportSessionValid,
  REPORT_SESSION_TTL_MS,
  resolveReportRouting,
  type ReportRouting,
  type ReportSessionRecord,
} from "./report-session";
// token 生成 / Bearer token 抽出は dvr/report で共通の theearth-session.ts が
// 唯一の実装元 (Refs #169、dvr-session.ts から間借りしていたのを整理)。
import { extractBearerToken, generateSessionToken } from "./theearth-session";

/** `DTAKO_ACCOUNTS` (dtako-scraper の Rust 版と同一 JSON shape) の1エントリ。 */
interface DtakoAccountRaw {
  comp_id: string;
  user_name: string;
  user_pass: string;
  tenant_id: string;
}

interface StoredZip {
  compId: string;
  createdAt: number;
  bytes: ArrayBuffer;
  /** 既定 application/zip。ZIP でない応答 (HTML エラーページ等) を原因調査用に保存する時に上書き。 */
  contentType?: string;
  /** 既定 csvdata-<compId>.zip。上に同じ。 */
  filename?: string;
}

const ZIP_TTL_MS = 10 * 60 * 1000;

/** performEtcScrape の結果 (cron ログ出力 / WS result イベントの両方の素になる)。 */
interface EtcScrapeOutcome {
  status: "success" | "skipped" | "error";
  message: string;
  key?: string;
  csvBytes?: number;
  filename?: string;
  /** kind=etc-all 経由 (`handleInternalEtcScrape`) の時だけ載る、途中の onProgress
   * 通知の記録。dispatcher (`executeEtcScrapeAll`) はこれを受け取った時点で
   * まとめて "progress" イベントとして再送する — 単発 `/internal/etc-scrape` は
   * 同期 fetch (WS を持たない) なので、途中経過は response body 経由で運ぶしかない
   * (Refs #134 後続報告、riyouMonth 診断が etc-all 実行では一切表示されなかった
   * 根本原因)。 */
  progressLog?: { step: string; message?: string }[];
}

/** /dvr-api/* のセッションレコードを置く DO storage キー。この DO instance は
 * theearth アカウント単位 (`dvr-{comp}:{userB64}`) なので 1 キーで足りる。 */
const DVR_SESSION_KEY = "dvr:session";

/** /daily-report-api/* (日報編集、Refs #169) のセッションレコードを置く DO
 * storage キー。DVR viewer とは別の theearth ログインセッションを持つため
 * (DO instance も `report-{comp}:{userB64}` で分離、routing は
 * ./report-session.ts)、DVR_SESSION_KEY とは別 key を使う。 */
const REPORT_SESSION_KEY = "report:session";

function dvrJsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** VenusSessionExpiredError を 401 にマップする時の文言。dvr-api / daily-report-api
 * の両方で 10 箇所超に同じ文字列がハードコードされていたのを 1 箇所に集約する
 * (Refs #169 のバグ調査で見つかった重複、文言を直す時に片方だけ直し忘れる事故を防ぐ)。 */
const THEEARTH_SESSION_EXPIRED_MESSAGE = "theearth セッションが切れました。再ログインしてください";

/** 想定外の例外 (TheearthClientError 以外) を診断可能な 1 行にする。自前 client の
 * 例外情報のみで credential は含まれない。エラーメッセージと log の両方に出す —
 * generic 文言に潰すと現場で原因が追えない (Refs #90 staging 実機で実害)。 */
function describeUnknownError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** ETC 手動実行 (`/ws/scraper?kind=etc|etc-all`) の「今月/先月」ボタン選択を
 * URL query (`month=previous`) から読む。`previous` 以外 (未指定含む) は
 * `undefined` = 今月 (`resolveScrapeMonthAnchor` の既定) にフォールバックする。 */
function parseScrapeMonthParam(url: URL): ScrapeMonthTarget | undefined {
  return url.searchParams.get("month") === "previous" ? "previous" : undefined;
}

/** `resolveScrapeMonthAnchor()` の結果を進捗ログ表示用の `YYYY年MM月` にする
 * (診断専用、submitSearch() の挙動には影響しない)。 */
function formatJstYearMonth(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  return `${jst.getUTCFullYear()}年${String(jst.getUTCMonth() + 1).padStart(2, "0")}月`;
}

/** SecretsStoreSecret (`.get()`) / 文字列 のどちらの binding でも値を取り出す。 */
async function resolveSecret(binding: unknown): Promise<string> {
  if (typeof binding === "string") return binding;
  if (binding && typeof (binding as { get?: unknown }).get === "function") {
    return (await (binding as { get(): Promise<string> }).get()) ?? "";
  }
  return "";
}

export interface RelayEnv {
  RELAY: DurableObjectNamespace;
  /** auth-worker introspect / alc-internal-proxy 呼び出し用 shared secret
   * (CF Secrets Store binding、`X-Alc-Proxy-Secret` として consumer worker
   * proof に使う)。 */
  INTERNAL_SHARED_SECRET?: unknown;
  /** auth-worker origin (wrangler vars と共有)。introspect の絶対 URL 組み立てにのみ使う
   * (service binding は host を無視するため、値そのものは到達性に影響しない)。 */
  NUXT_PUBLIC_AUTH_WORKER_URL?: string;
  /** auth-worker への service binding (Worker→Worker in-process fetch)。
   * `/auth/introspect` と `/alc-internal-proxy/api/upload`
   * (ohishi-exp/dtako-scraper#22 の自動アップロード) の両方をこれ経由で叩く。 */
  AUTH_WORKER: Fetcher;
  /**
   * Workers VPC binding (beta) — kagoya_tunnel (Tunnel ID
   * e690242e-06cb-43a6-b2f5-67dfec95ca46) 経由で dtako-scraper (VPS
   * 127.0.0.1:8081) に到達する Fetcher。VPC Service `dtako-scraper-relay`
   * (service_id: 019f20af-c6ac-7dd0-8381-ea22add4bd40) を wrangler.toml の
   * `vpc_services` binding で参照する。
   */
  DTAKO_SCRAPER_VPC: Fetcher;
  /**
   * `"http"` でブラウザレス経路 (theearth-client.ts) を有効化する。未設定/それ以外は
   * 従来どおり `"vpc-relay"` (VPS の dtako-scraper へ中継) を使う。運用移行の安全弁 —
   * `DTAKO_ACCOUNTS` を Secrets Store に投入し動作確認できてから切り替える想定
   * (Refs ohishi-exp/dtako-scraper#22)。
   */
  SCRAPER_MODE?: string;
  /**
   * dtako-scraper の Rust 版と同一 JSON shape (`comp_id`/`user_name`/`user_pass`/
   * `tenant_id` の配列) の CF Secrets Store binding。`SCRAPER_MODE=http` の時のみ
   * 参照する。未設定の間は http モードが有効化されていても comp_id 解決に失敗し、
   * WS 経由でその旨をエラー通知する (fail-closed、クラッシュはしない)。
   */
  DTAKO_ACCOUNTS?: unknown;
  /**
   * ETC 利用照会サービスのアカウント JSON 配列 (`[{user_id, password}, ...]`、
   * browser-render-rust の `ETC_ACCOUNTS` env と同一 shape)。DTAKO_ACCOUNTS と
   * 同じく dashboard の plain Environment Variable として投入する (wrangler.toml
   * に置かない = git 履歴に平文を残さない、`keep_vars = true` で deploy を
   * またいで保持)。未設定の間は ETC cron が skip される (Refs
   * ohishi-exp/browser-render-rust#14)。
   */
  ETC_ACCOUNTS?: unknown;
  /** ETC 明細 CSV の保存先 R2 bucket (dtako-uploads)。 */
  DTAKO_R2?: R2Bucket;
  /** ETC CSV の R2 key prefix。staging は `etc-staging` で本番 (`etc`) と分離する。 */
  ETC_R2_PREFIX?: string;
}

export class DtakoScraperRelayDO extends DurableObject<RelayEnv> {
  /** 上流 (dtako-scraper) への WebSocket。plain socket なので DO を active に保つ。 */
  private upstream: WebSocket | null = null;
  /** SCRAPER_MODE=http 時、同一 comp_id (= この DO インスタンス) 内でスクレイプを
   * 直列化するための待ち行列。DO はシングルスレッド実行なのでロックは不要、
   * Promise チェーンで先行タスクの完了を待つだけで十分。 */
  private scrapeQueue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: RelayEnv) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  /**
   * auth-worker `/auth/introspect` を service binding 経由で叩く (DO は h3 context
   * を持たないので @ippoan/auth-client/server の requireAuth は使えない)。素の
   * `fetch()` ではなく `AUTH_WORKER` service binding を使う (Worker→Worker
   * in-process、公開 fetch より低遅延・DNS/TLS 不要)。
   */
  private async introspect(
    token: string,
    origin: string,
  ): Promise<IntrospectResult> {
    const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
    if (!sharedSecret) return { active: false };
    const authWorkerUrl =
      this.env.NUXT_PUBLIC_AUTH_WORKER_URL || "https://auth.ippoan.org";
    try {
      const res = await this.env.AUTH_WORKER.fetch(`${authWorkerUrl}/auth/introspect`, {
        method: "POST",
        headers: {
          Authorization: sharedSecret,
          "Content-Type": "application/json",
          "User-Agent": "nuxt-dtako-admin/dtako-scraper-relay-do",
        },
        body: JSON.stringify({ token, origin }),
      });
      if (!res.ok) return { active: false };
      const data = (await res.json()) as Record<string, unknown>;
      if (!data || data.active !== true) return { active: false };
      return { active: true };
    } catch {
      return { active: false };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // /dvr-viewer (Refs #90) の DVR viewer API。scraper 系とは独立した経路で、
    // 認証は auth-worker introspect ではなく「theearth へのログインそのもの」
    // (credential pass-through、./dvr-session.ts のヘッダコメント参照)。
    if (url.pathname.startsWith("/dvr-api/")) {
      return this.handleDvrApi(request, url);
    }

    // /daily-report-edit (日報編集、Refs #169) の API。DVR viewer と同型の
    // credential pass-through だが、theearth ログインセッションは別に持つ
    // (DO instance も report-{comp}:{userB64} で分離、resolveReportRouting 参照)。
    if (url.pathname.startsWith("/daily-report-api/")) {
      return this.handleReportApi(request, url);
    }

    // SCRAPER_MODE=http が完了後に生成する、1回だけ取得できる zip ダウンロード URL。
    // WebSocket アップグレードではない通常の GET。
    if (url.pathname.startsWith("/scraper-zip/")) {
      return this.handleZipDownload(url);
    }

    // Cron Triggers (index.ts の scheduled handler) からの無人実行。外部には
    // 公開されない (この worker は workers_dev=false + routes 無しで、app の
    // service binding は /ws/scraper・/scraper-zip/・/dvr-api/ しか転送しない)
    // ため、追加の認証は持たない。job を受理して即 202 を返し、実処理は
    // waitUntil + scrapeQueue 直列化で走らせる (結果は console log =
    // Workers Observability で追う)。
    if (url.pathname === "/cron/dtako" && request.method === "POST") {
      return this.handleCronDtako(request);
    }
    if (url.pathname === "/cron/etc" && request.method === "POST") {
      return this.handleCronEtc(request);
    }

    // ETC 全アカウント一括実行 (kind=etc-all) のディスパッチャ DO インスタンス
    // (idFromName("etc-admin-all")、index.ts 参照) が、各アカウント固有の DO
    // (`etc-{user_id}`) に対して叩く同期スクレイプ endpoint。cron/etc と同じく
    // この worker 自身からしか到達できない (workers_dev=false、app の service
    // binding は /ws/scraper・/scraper-zip/・/dvr-api/ しか転送しない)。
    if (url.pathname === "/internal/etc-scrape" && request.method === "POST") {
      return this.handleInternalEtcScrape(request);
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const token = url.searchParams.get("token");
    if (!token) {
      return new Response("Missing token", { status: 401 });
    }

    const result = await this.introspect(token, `https://${url.host}`);
    const decision = decideRelayAuth(result);
    if (decision.status !== 101) {
      return new Response("Invalid or expired token", { status: decision.status });
    }

    const kind = url.searchParams.get("kind");
    if (kind === "etc") {
      // ETC は SCRAPER_MODE (vpc-relay/http) と無関係な別経路 (管理タブ手動実行、Refs #134)。
      return this.handleEtcScrapeWs(url);
    }
    if (kind === "etc-all") {
      // ETC_ACCOUNTS 全件を一括実行 (user_id 手入力を不要にする、Refs #134)。
      return this.handleEtcScrapeAllWs(url);
    }

    if (this.env.SCRAPER_MODE === "http") {
      return this.handleHttpScrape(url);
    }
    return this.connectVpcRelay(url);
  }

  /** 従来経路: Kagoya VPS の dtako-scraper (`/scrape/ws`) に Workers VPC binding 経由で中継する。 */
  private async connectVpcRelay(url: URL): Promise<Response> {
    // 上流 (dtako-scraper) の /scrape/ws にスクレイプパラメータをそのまま渡して接続。
    // token / session id は上流には不要なので除去して転送する。
    const upstreamParams = new URLSearchParams(url.search);
    upstreamParams.delete("token");
    upstreamParams.delete("session");
    // TODO: Workers VPC (beta) の実際のホスト/パス解決方法を deploy 前に要確認。
    // ここでは binding が private target への routing を担う前提のプレースホルダ URL。
    const upstreamUrl = `http://dtako-scraper.internal/scrape/ws?${upstreamParams.toString()}`;
    const upstreamRes = await this.env.DTAKO_SCRAPER_VPC.fetch(upstreamUrl, {
      headers: { Upgrade: "websocket" },
    });
    const upstreamWs = upstreamRes.webSocket;
    if (!upstreamWs) {
      return new Response("Upstream scraper unavailable", { status: 502 });
    }
    upstreamWs.accept();
    this.upstream = upstreamWs;

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    upstreamWs.addEventListener("message", (evt: MessageEvent) => {
      if (typeof evt.data === "string") server.send(evt.data);
    });
    upstreamWs.addEventListener("close", () => {
      this.upstream = null;
      try {
        server.close(1000, "upstream closed");
      } catch {
        // already closed
      }
    });
    upstreamWs.addEventListener("error", () => {
      this.upstream = null;
      try {
        server.close(1011, "upstream error");
      } catch {
        // already closed
      }
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /** 新経路 (Refs ohishi-exp/dtako-scraper#22): Chromium を使わず DO 自身が theearth-np に
   * ログイン + CSV ダウンロードを行う。WS ハンドシェイクは即座に返し、スクレイプ本体は
   * `ctx.waitUntil` で背後に走らせる (fire-and-forget、進捗は WS 経由で push)。 */
  private async handleHttpScrape(url: URL): Promise<Response> {
    const compId = url.searchParams.get("comp_id");
    const startDate = url.searchParams.get("start_date");
    const endDate = url.searchParams.get("end_date");
    if (!compId || !startDate || !endDate) {
      return new Response(
        "Bad Request: SCRAPER_MODE=http では comp_id/start_date/end_date が必須です",
        { status: 400 },
      );
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    this.ctx.waitUntil(
      this.runHttpScrapeJob(server, { compId, startDate, endDate }).catch((err) => {
        console.error("DtakoScraperRelayDO handleHttpScrape unexpected error:", err);
        this.sendSafely(server, { event: "error", message: "予期しないエラーが発生しました" });
        this.closeSafely(server, 1011, "unexpected error");
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /** この DO インスタンス内でスクレイプ job を直列化する共通キュー。DO は
   * シングルスレッド実行なので、Promise チェーンで先行タスクの完了を待つだけで
   * 安全に直列化できる。WS 手動トリガーと cron 無人実行が同一 comp_id /
   * ETC アカウントに重なっても直列に捌かれる (issue #22 の設計どおり)。 */
  private async enqueueScrape<T>(job: () => Promise<T>): Promise<T> {
    const myTurn = this.scrapeQueue.catch(() => undefined);
    let release: () => void = () => {};
    this.scrapeQueue = myTurn.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await myTurn;
    try {
      return await job();
    } finally {
      release();
    }
  }

  /** 同一 comp_id (= この DO インスタンス) 内でのスクレイプ直列化。 */
  private async runHttpScrapeJob(
    server: WebSocket,
    params: { compId: string; startDate: string; endDate: string },
  ): Promise<void> {
    this.sendSafely(server, { event: "progress", comp_id: params.compId, step: "queued" });
    await this.enqueueScrape(() => this.executeScrape(server, params));
  }

  // -------------------------------------------------------------------------
  // Cron (無人実行) — Refs ohishi-exp/dtako-scraper#22 /
  // ohishi-exp/browser-render-rust#14。VPS / GCE cron からの移行。
  // -------------------------------------------------------------------------

  /** POST /cron/dtako — body {comp_id, start_date, end_date}。WS 経路の
   * executeScrape と同じ scrapeViaHttp + alc-internal-proxy アップロードを、
   * WS なしで実行する。 */
  private async handleCronDtako(request: Request): Promise<Response> {
    let body: { comp_id?: unknown; start_date?: unknown; end_date?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "JSON body が必要です" }, { status: 400 });
    }
    const compId = typeof body.comp_id === "string" ? body.comp_id : "";
    const startDate = typeof body.start_date === "string" ? body.start_date : "";
    const endDate = typeof body.end_date === "string" ? body.end_date : "";
    if (!compId || !startDate || !endDate) {
      return Response.json({ error: "comp_id / start_date / end_date が必要です" }, { status: 400 });
    }

    const account = await this.resolveAccount(compId);
    if (!account) {
      return Response.json(
        { error: `comp_id=${compId} が DTAKO_ACCOUNTS に見つかりません` },
        { status: 500 },
      );
    }

    this.ctx.waitUntil(
      this.enqueueScrape(() => this.runCronDtakoScrape(account, { startDate, endDate })),
    );
    return Response.json({ accepted: true, comp_id: compId }, { status: 202 });
  }

  private async runCronDtakoScrape(
    account: DtakoAccountRaw,
    range: { startDate: string; endDate: string },
  ): Promise<void> {
    const logBase = { cron: "dtako", comp_id: account.comp_id, range: `${range.startDate}..${range.endDate}` };
    try {
      const zip = await scrapeViaHttp(
        {
          compId: account.comp_id,
          userName: account.user_name,
          userPass: account.user_pass,
          startDate: range.startDate,
          endDate: range.endDate,
        },
        (step) => console.log(JSON.stringify({ ...logBase, step })),
      );

      const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
      if (!sharedSecret) {
        console.error(
          JSON.stringify({ ...logBase, status: "error", message: "INTERNAL_SHARED_SECRET 未設定のためアップロード不能 (zip は破棄)" }),
        );
        return;
      }
      const uploadBody = await uploadDtakoZipViaAlcInternalProxy(
        { sharedSecret, tenantId: account.tenant_id, filename: "csvdata.zip", zipBytes: zip },
        this.env.AUTH_WORKER.fetch.bind(this.env.AUTH_WORKER),
      );
      console.log(
        JSON.stringify({ ...logBase, status: "success", zip_bytes: zip.byteLength, upload: uploadBody.slice(0, 200) }),
      );
    } catch (err) {
      const message =
        err instanceof TheearthClientError ? err.message : describeUnknownError(err);
      console.error(JSON.stringify({ ...logBase, status: "error", message }));
    }
  }

  /** POST /cron/etc — body {user_id}。credential は DO 自身が ETC_ACCOUNTS
   * から解決する (cron dispatch 側に password を運ばせない)。取得した CSV は
   * R2 (DTAKO_R2) に保存する。 */
  private async handleCronEtc(request: Request): Promise<Response> {
    let body: { user_id?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "JSON body が必要です" }, { status: 400 });
    }
    const userId = typeof body.user_id === "string" ? body.user_id : "";
    if (!userId) {
      return Response.json({ error: "user_id が必要です" }, { status: 400 });
    }

    const account = await this.resolveEtcAccount(userId);
    if (!account) {
      return Response.json(
        { error: `user_id=${userId} が ETC_ACCOUNTS に見つかりません` },
        { status: 500 },
      );
    }
    if (!this.env.DTAKO_R2) {
      return Response.json(
        { error: "DTAKO_R2 binding が未設定のため ETC CSV を保存できません" },
        { status: 500 },
      );
    }

    this.ctx.waitUntil(this.enqueueScrape(() => this.runCronEtcScrape(account)));
    return Response.json({ accepted: true, user_id: userId }, { status: 202 });
  }

  private async resolveEtcAccount(userId: string): Promise<EtcAccountEntry | null> {
    const raw = await resolveSecret(this.env.ETC_ACCOUNTS);
    if (!raw) return null;
    try {
      return parseEtcAccounts(raw).find((a) => a.user_id === userId) ?? null;
    } catch (err) {
      console.error("DtakoScraperRelayDO: ETC_ACCOUNTS parse error:", describeUnknownError(err));
      return null;
    }
  }

  /** ETC スクレイプ本体 (login → 検索 → CSV) + R2 保存。cron (無人実行、waitUntil +
   * console.log のみ) と手動 WS トリガー (`/ws/scraper?kind=etc`、進捗を browser に
   * 中継しつつ同じ結果を返す) の両方から共有する。 */
  private async performEtcScrape(
    account: EtcAccountEntry,
    onStep: (step: string, message?: string) => void,
    now: Date = new Date(),
  ): Promise<EtcScrapeOutcome> {
    const bucket = this.env.DTAKO_R2!;
    const prefix = this.env.ETC_R2_PREFIX || "etc";
    try {
      const result = await scrapeEtcCsv(
        { userId: account.user_id, password: account.password },
        onStep,
        undefined,
        undefined,
        now,
      );
      const key = etcCsvKey(prefix, account.user_id, now);
      await bucket.put(key, result.bytes, {
        httpMetadata: { contentType: "text/csv; charset=shift_jis" },
        customMetadata: { filename: result.filename, account_type: result.accountType },
      });
      return {
        status: "success",
        message: `CSV 取得成功 (${result.bytes.byteLength} bytes, ${result.filename})`,
        key,
        csvBytes: result.bytes.byteLength,
        filename: result.filename,
      };
    } catch (err) {
      if (err instanceof EtcMeisaiNoUsageError) {
        // 明細 0 件は正常系 (VPS 版の NoUsageData skip と同じ扱い)
        return { status: "skipped", message: err.message };
      }
      // CSV でない応答は原因調査用に R2 の errors/ 配下へ保存する (「黙って200」対策の
      // 診断経路。ページ仕様変更 / ログイン失敗の中身をあとから確認できる)
      if (err instanceof EtcMeisaiNotCsvError) {
        const errorKey = `${prefix}-errors/${account.user_id}/${Date.now()}.bin`;
        try {
          await bucket.put(errorKey, err.responseBytes, {
            httpMetadata: { contentType: err.contentType || "application/octet-stream" },
          });
          return { status: "error", message: err.message, key: errorKey };
        } catch {
          // 保存失敗は下の共通 return に落とす
        }
      }
      const message =
        err instanceof EtcMeisaiClientError ? err.message : describeUnknownError(err);
      return { status: "error", message };
    }
  }

  private async runCronEtcScrape(account: EtcAccountEntry): Promise<void> {
    const logBase = { cron: "etc", user_id: account.user_id };
    const outcome = await this.performEtcScrape(account, (step) =>
      console.log(JSON.stringify({ ...logBase, step })),
    );
    const line = JSON.stringify({ ...logBase, ...outcome });
    if (outcome.status === "error") console.error(line);
    else console.log(line);
  }

  /** POST /ws/scraper?kind=etc&user_id=... — 認証 (introspect) 済みの WS 経由で
   * ETC アカウント単位の手動スクレイプを行う (管理タブ用、Refs #134)。DO は
   * `etc-{user_id}` で idFromName されるため、cron の無人実行と手動トリガーが
   * 同一アカウントに重なっても enqueueScrape の直列化キューで捌かれる。 */
  private async handleEtcScrapeWs(url: URL): Promise<Response> {
    const userId = url.searchParams.get("user_id");
    if (!userId) {
      return new Response("Bad Request: user_id が必須です", { status: 400 });
    }
    const now = resolveScrapeMonthAnchor(parseScrapeMonthParam(url), new Date());

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    this.ctx.waitUntil(
      this.enqueueScrape(() => this.executeEtcScrape(server, userId, now)).catch((err) => {
        console.error("DtakoScraperRelayDO handleEtcScrapeWs unexpected error:", err);
        this.sendSafely(server, { event: "error", user_id: userId, message: "予期しないエラーが発生しました" });
        this.closeSafely(server, 1011, "unexpected error");
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  private async executeEtcScrape(server: WebSocket, userId: string, now: Date): Promise<void> {
    const account = await this.resolveEtcAccount(userId);
    if (!account) {
      this.sendSafely(server, {
        event: "error",
        user_id: userId,
        message: `user_id=${userId} が ETC_ACCOUNTS に見つかりません`,
      });
      this.closeSafely(server, 1011, "account not found");
      return;
    }
    if (!this.env.DTAKO_R2) {
      this.sendSafely(server, {
        event: "error",
        user_id: userId,
        message: "DTAKO_R2 binding が未設定のため ETC CSV を保存できません",
      });
      this.closeSafely(server, 1011, "r2 not configured");
      return;
    }

    const outcome = await this.performEtcScrape(
      account,
      (step, message) => {
        this.sendSafely(server, { event: "progress", user_id: userId, step, message });
      },
      now,
    );

    const status = outcome.status === "error" ? "error" : "success";
    this.sendSafely(server, {
      event: "result",
      user_id: userId,
      step: "done",
      status,
      message: outcome.message,
      key: outcome.key,
    });
    this.sendSafely(server, { event: "done" });
    this.closeSafely(server, status === "error" ? 1011 : 1000, "done");
  }

  /** POST /ws/scraper?kind=etc-all — ETC_ACCOUNTS 登録済みの全アカウントを
   * user_id 入力無しで一括実行する (管理タブ用、Refs #134)。account ごとに
   * `etc-{user_id}` DO へ内部 fetch で処理を委譲するため、既存のアカウント単位
   * 直列化 (enqueueScrape) はそのまま保たれつつ、アカウント間は Promise.all で
   * 並列に実行される。 */
  private async handleEtcScrapeAllWs(url: URL): Promise<Response> {
    const now = resolveScrapeMonthAnchor(parseScrapeMonthParam(url), new Date());
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    this.ctx.waitUntil(
      this.executeEtcScrapeAll(server, now).catch((err) => {
        console.error("DtakoScraperRelayDO handleEtcScrapeAllWs unexpected error:", err);
        this.sendSafely(server, { event: "error", message: "予期しないエラーが発生しました" });
        this.closeSafely(server, 1011, "unexpected error");
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  private async executeEtcScrapeAll(server: WebSocket, now: Date): Promise<void> {
    const raw = await resolveSecret(this.env.ETC_ACCOUNTS);
    if (!raw) {
      this.sendSafely(server, { event: "error", message: "ETC_ACCOUNTS が未設定です" });
      this.closeSafely(server, 1011, "no accounts configured");
      return;
    }
    let accounts: EtcAccountEntry[];
    try {
      accounts = parseEtcAccounts(raw);
    } catch (err) {
      const message = err instanceof CronConfigError ? err.message : describeUnknownError(err);
      this.sendSafely(server, { event: "error", message });
      this.closeSafely(server, 1011, "invalid accounts config");
      return;
    }
    if (accounts.length === 0) {
      this.sendSafely(server, { event: "error", message: "ETC_ACCOUNTS が空です" });
      this.closeSafely(server, 1011, "no accounts configured");
      return;
    }

    this.sendSafely(server, {
      event: "progress",
      step: "start",
      message: `${accounts.length}件のアカウントを実行します (対象月: ${formatJstYearMonth(now)})`,
    });

    let hadError = false;
    await Promise.all(
      accounts.map(async (account) => {
        try {
          const stub = this.env.RELAY.get(this.env.RELAY.idFromName(`etc-${account.user_id}`));
          const res = await stub.fetch("https://relay.internal/internal/etc-scrape", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ user_id: account.user_id, now: now.toISOString() }),
          });
          const outcome = (await res.json()) as EtcScrapeOutcome;
          for (const p of outcome.progressLog ?? []) {
            this.sendSafely(server, {
              event: "progress",
              user_id: account.user_id,
              step: p.step,
              message: p.message,
            });
          }
          if (outcome.status === "error") hadError = true;
          this.sendSafely(server, {
            event: "result",
            user_id: account.user_id,
            step: "done",
            status: outcome.status === "error" ? "error" : "success",
            message: outcome.message,
            key: outcome.key,
          });
        } catch (err) {
          hadError = true;
          this.sendSafely(server, {
            event: "result",
            user_id: account.user_id,
            step: "done",
            status: "error",
            message: describeUnknownError(err),
          });
        }
      }),
    );

    this.sendSafely(server, { event: "done" });
    this.closeSafely(server, hadError ? 1011 : 1000, "done");
  }

  /** POST /internal/etc-scrape — kind=etc-all のディスパッチャ (`executeEtcScrapeAll`)
   * が各アカウント固有の DO (`etc-{user_id}`) に対して叩く、同期スクレイプ endpoint。
   * `/cron/etc` (202 accepted + waitUntil) とは異なり、結果 JSON を待って返す。 */
  private async handleInternalEtcScrape(request: Request): Promise<Response> {
    let body: { user_id?: unknown; now?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ status: "error", message: "JSON body が必要です" }, { status: 400 });
    }
    const userId = typeof body.user_id === "string" ? body.user_id : "";
    if (!userId) {
      return Response.json({ status: "error", message: "user_id が必要です" }, { status: 400 });
    }
    // `executeEtcScrapeAll` (kind=etc-all ディスパッチャ) が「今月/先月」選択を
    // 解決済みの Date を渡してくる。パース不能 (壊れた ISO 文字列等) なら
    // fail-safe で現在時刻に落とす。
    const parsedNow = typeof body.now === "string" ? new Date(body.now) : null;
    const now = parsedNow && !Number.isNaN(parsedNow.getTime()) ? parsedNow : new Date();

    const account = await this.resolveEtcAccount(userId);
    if (!account) {
      return Response.json({
        status: "error",
        message: `user_id=${userId} が ETC_ACCOUNTS に見つかりません`,
      });
    }
    if (!this.env.DTAKO_R2) {
      return Response.json({
        status: "error",
        message: "DTAKO_R2 binding が未設定のため ETC CSV を保存できません",
      });
    }

    const progressLog: { step: string; message?: string }[] = [];
    const outcome = await this.enqueueScrape(() =>
      this.performEtcScrape(
        account,
        (step, message) => {
          progressLog.push({ step, message });
        },
        now,
      ),
    );
    return Response.json({ ...outcome, progressLog });
  }

  private async executeScrape(
    server: WebSocket,
    params: { compId: string; startDate: string; endDate: string },
  ): Promise<void> {
    const account = await this.resolveAccount(params.compId);
    if (!account) {
      this.sendSafely(server, {
        event: "error",
        comp_id: params.compId,
        message: `comp_id=${params.compId} が DTAKO_ACCOUNTS に見つかりません`,
      });
      this.closeSafely(server, 1011, "account not found");
      return;
    }

    try {
      const zip = await scrapeViaHttp(
        {
          compId: account.comp_id,
          userName: account.user_name,
          userPass: account.user_pass,
          startDate: params.startDate,
          endDate: params.endDate,
        },
        (step, message) => {
          this.sendSafely(server, { event: "progress", comp_id: params.compId, step, message });
        },
      );

      // 手動ダウンロード用に常に保存 (自動アップロードの成否に関わらず、監査/リトライ用に残す)。
      const requestId = crypto.randomUUID();
      await this.ctx.storage.put<StoredZip>(`zip:${requestId}`, {
        compId: params.compId,
        createdAt: Date.now(),
        bytes: zip,
      });
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null) {
        await this.ctx.storage.setAlarm(Date.now() + ZIP_TTL_MS);
      }
      const zipUrl = `/scraper-zip/${encodeURIComponent(params.compId)}/${requestId}`;

      // rust-alc-api への自動アップロード。auth-worker `/alc-internal-proxy`
      // (shared-secret 経路、AUTH_WORKER service binding) 経由で account.tenant_id
      // (DTAKO_ACCOUNTS の comp_id -> tenant_id) を明示 X-Tenant-ID として渡す。
      // device pairing 不要、INTERNAL_SHARED_SECRET は introspect と共用。
      const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
      let resultStatus: "success" | "error" = "success";
      let resultMessage: string;
      if (sharedSecret) {
        this.sendSafely(server, { event: "progress", comp_id: params.compId, step: "upload" });
        try {
          const uploadBody = await uploadDtakoZipViaAlcInternalProxy(
            { sharedSecret, tenantId: account.tenant_id, filename: "csvdata.zip", zipBytes: zip },
            this.env.AUTH_WORKER.fetch.bind(this.env.AUTH_WORKER),
          );
          resultMessage = `アップロード完了: ${uploadBody.slice(0, 300)}`;
        } catch (err) {
          resultStatus = "error";
          resultMessage = `zip取得は成功しましたが自動アップロードに失敗しました: ${
            err instanceof Error ? err.message : "unknown error"
          }`;
        }
      } else {
        resultMessage = `${zip.byteLength} bytes (INTERNAL_SHARED_SECRET 未設定のため自動アップロードはスキップ、手動ダウンロードのみ)`;
      }

      this.sendSafely(server, {
        event: "result",
        comp_id: params.compId,
        step: "done",
        status: resultStatus,
        message: resultMessage,
        zip_url: zipUrl,
      });
      this.sendSafely(server, { event: "done" });
      this.closeSafely(server, 1000, "done");
    } catch (err) {
      const message = err instanceof TheearthClientError ? err.message : "スクレイプに失敗しました";
      // ZIP でない応答 (HTML エラーページ / ログインページ等) も原因調査用にダウンロード
      // できるよう保存し、download URL を result に載せる (「でもダウンロードさせろ」対応)。
      let zipUrl: string | undefined;
      if (err instanceof TheearthNotZipError) {
        const requestId = crypto.randomUUID();
        const isHtml = err.contentType.includes("html");
        await this.ctx.storage.put<StoredZip>(`zip:${requestId}`, {
          compId: params.compId,
          createdAt: Date.now(),
          bytes: err.responseBytes,
          contentType: err.contentType || "application/octet-stream",
          filename: `theearth-response-${params.compId}.${isHtml ? "html" : "bin"}`,
        });
        const currentAlarm = await this.ctx.storage.getAlarm();
        if (currentAlarm === null) {
          await this.ctx.storage.setAlarm(Date.now() + ZIP_TTL_MS);
        }
        zipUrl = `/scraper-zip/${encodeURIComponent(params.compId)}/${requestId}`;
      }
      this.sendSafely(server, {
        event: "result",
        comp_id: params.compId,
        step: "done",
        status: "error",
        message,
        zip_url: zipUrl,
      });
      this.sendSafely(server, { event: "done" });
      this.closeSafely(server, 1011, "scrape failed");
    }
  }

  private async resolveAccount(compId: string): Promise<DtakoAccountRaw | null> {
    const raw = await resolveSecret(this.env.DTAKO_ACCOUNTS);
    if (!raw) return null;
    let accounts: DtakoAccountRaw[];
    try {
      accounts = JSON.parse(raw);
    } catch {
      console.error("DtakoScraperRelayDO: DTAKO_ACCOUNTS is not valid JSON");
      return null;
    }
    return accounts.find((a) => a.comp_id === compId) ?? null;
  }

  // -------------------------------------------------------------------------
  // /dvr-api/* — DVR viewer (Refs #90)。credential pass-through 設計:
  // password はログイン 1 リクエストの body にだけ現れ、保存も log 出力もしない。
  // DO storage に残るのは theearth session cookie + ランダム token のみ。
  // -------------------------------------------------------------------------

  private async handleDvrApi(request: Request, url: URL): Promise<Response> {
    const routing = resolveDvrRouting(request.headers);
    if (!routing) {
      return dvrJsonError(400, "X-Dvr-Comp-Id / X-Dvr-User-B64 ヘッダが不正です");
    }

    if (url.pathname === "/dvr-api/login" && request.method === "POST") {
      return this.handleDvrLogin(request, routing);
    }

    const record = await this.ctx.storage.get<DvrSessionRecord>(DVR_SESSION_KEY);
    const token = extractBearerToken(request.headers);
    if (!isDvrSessionValid(record, token, routing, Date.now())) {
      return dvrJsonError(401, "セッションが無効か期限切れです。再ログインしてください");
    }

    if (url.pathname === "/dvr-api/logout" && request.method === "POST") {
      await this.ctx.storage.delete(DVR_SESSION_KEY);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/dvr-api/notifications" && request.method === "GET") {
      return this.handleDvrNotifications(record!);
    }
    if (url.pathname === "/dvr-api/masters" && request.method === "GET") {
      return this.handleDvrMasters(record!);
    }
    if (url.pathname === "/dvr-api/search" && request.method === "POST") {
      return this.handleDvrSearch(record!, request);
    }
    if (url.pathname === "/dvr-api/vehicle-states" && request.method === "GET") {
      return this.handleDvrVehicleStates(record!, url);
    }
    if (url.pathname === "/dvr-api/log-track" && request.method === "GET") {
      return this.handleDvrLogTrack(record!, url);
    }
    if (url.pathname === "/dvr-api/transfer" && request.method === "POST") {
      return this.handleDvrTransfer(record!, request);
    }
    if (url.pathname === "/dvr-api/file" && request.method === "GET") {
      return this.handleDvrFile(record!, url);
    }
    return dvrJsonError(404, "Not Found");
  }

  /** POST /dvr-api/login — theearth にその場でログインし、成功したら session cookie
   * + token を保存して token を返す。credential はこのメソッドのスコープ外に出さない。 */
  private async handleDvrLogin(request: Request, routing: DvrRouting): Promise<Response> {
    let body: { user_pass?: unknown };
    try {
      body = (await request.json()) as { user_pass?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const userPass = typeof body.user_pass === "string" ? body.user_pass : "";
    if (!userPass) {
      return dvrJsonError(400, "user_pass が必要です");
    }

    const jar = createCookieJar();
    try {
      await login(jar, {
        compId: routing.compId,
        userName: routing.userName,
        userPass,
      });
    } catch (err) {
      // TheearthClientError の message は自前クライアントの説明文 (credential は含まない)。
      console.error("DVR login error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `theearth へのログインに失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(401, message);
    }

    const now = Date.now();
    const record: DvrSessionRecord = {
      token: generateSessionToken(),
      compId: routing.compId,
      userName: routing.userName,
      cookies: Array.from(jar.cookies.entries()),
      createdAt: now,
      expiresAt: now + DVR_SESSION_TTL_MS,
    };
    await this.ctx.storage.put(DVR_SESSION_KEY, record);
    return Response.json({ token: record.token, expires_at: record.expiresAt });
  }

  /** GET /dvr-api/notifications — VenusBridge の DVR 動画通知一覧。 */
  private async handleDvrNotifications(record: DvrSessionRecord): Promise<Response> {
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const notifications = await getDvrNotifications(jar);
      // theearth 側が cookie を更新した場合に備えて書き戻す (セッション延命)。
      await this.ctx.storage.put<DvrSessionRecord>(DVR_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json({ notifications });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(DVR_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      console.error("DVR notifications error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `DVR 動画通知の取得に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** GET /dvr-api/masters — 映像検索フォーム用の 事業所/車輌/乗務員 マスタ
   * (Request_NetDvrFuncInitValue、Refs #90 実 API 検証済み)。 */
  private async handleDvrMasters(record: DvrSessionRecord): Promise<Response> {
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const masters = await getDvrMasters(jar);
      await this.ctx.storage.put<DvrSessionRecord>(DVR_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json(masters);
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(DVR_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      console.error("DVR masters error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `車輌・乗務員マスタの取得に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** POST /dvr-api/search — 映像検索 (Request_DvrDataList)。body は DvrSearchParams。
   * パラメータ不正 (必須条件未達等) は 400、theearth セッション切れは 401。 */
  private async handleDvrSearch(record: DvrSessionRecord, request: Request): Promise<Response> {
    let params: DvrSearchParams;
    try {
      params = (await request.json()) as DvrSearchParams;
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }

    let key: string[];
    try {
      key = buildDvrSearchKey(params);
    } catch (err) {
      if (err instanceof DvrSearchParamError) {
        return dvrJsonError(400, err.message);
      }
      throw err;
    }

    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const rows = await searchDvrData(jar, key);
      await this.ctx.storage.put<DvrSessionRecord>(DVR_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json({ rows });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(DVR_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      console.error("DVR search error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `映像検索に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** venus API 呼び出しの共通ラッパ: cookie 書き戻し + セッション切れ 401 /
   * パラメータ不正 400 / その他 502 のマッピング (新規 GET endpoint 用)。 */
  private async callDvrVenus<T>(
    record: DvrSessionRecord,
    errorLabel: string,
    fn: (jar: CookieJar) => Promise<T>,
  ): Promise<Response> {
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const result = await fn(jar);
      await this.ctx.storage.put<DvrSessionRecord>(DVR_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json(result);
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(DVR_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      if (err instanceof DvrSearchParamError) {
        return dvrJsonError(400, err.message);
      }
      console.error(`DVR ${errorLabel} error:`, err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `${errorLabel}に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** GET /dvr-api/vehicle-states?branch=<事業所code> — 車輌現在地一覧
   * (VehicleStateTableForBranchEx、位置情報ページ用)。 */
  private handleDvrVehicleStates(record: DvrSessionRecord, url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch") ?? "";
    return this.callDvrVenus(record, "車輌現在地の取得", async jar => ({
      vehicles: await getVehicleStates(jar, branch),
    }));
  }

  /** GET /dvr-api/log-track?vehicle=<CD>&start=YYYY/MM/DD&end=YYYY/MM/DD —
   * 車輌 1 台の動態履歴 GPS 軌跡 (VehicleStateTable)。 */
  private handleDvrLogTrack(record: DvrSessionRecord, url: URL): Promise<Response> {
    const vehicle = url.searchParams.get("vehicle") ?? "";
    const start = url.searchParams.get("start") ?? "";
    const end = url.searchParams.get("end") ?? "";
    return this.callDvrVenus(record, "動態履歴の取得", async jar => ({
      points: await getVehicleLogTrack(jar, vehicle, start, end),
    }));
  }

  /** POST /dvr-api/transfer — 車両 (車載機) に映像ファイルの転送を要求する
   * (「車両から取得」の 1 段目)。転送は非同期なので即 200 を返し、完了は一覧の
   * receiveState 変化で観測する。body は 2 形式:
   * - {serial, filename} — 通知一覧からの単一要求 (Request_DvrFileTransfer_target)
   * - {serials: [], filenames: []} — 映像検索からの一括要求
   *   (Request_DvrFileTransfer_MultiTarget。実ページは車輌絞込検索時の単一行要求にも
   *   MultiTarget を使うため、検索由来はこちらに寄せる) */
  private async handleDvrTransfer(record: DvrSessionRecord, request: Request): Promise<Response> {
    let body: { serial?: unknown; filename?: unknown; serials?: unknown; filenames?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }

    const isStringArray = (v: unknown): v is string[] =>
      Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "");
    const multi =
      isStringArray(body.serials)
      && isStringArray(body.filenames)
      && body.serials.length === body.filenames.length;
    const serial = typeof body.serial === "string" ? body.serial : "";
    const filename = typeof body.filename === "string" ? body.filename : "";
    if (!multi && (!serial || !filename)) {
      return dvrJsonError(400, "serial / filename (または同数の serials / filenames) が必要です");
    }

    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const result = multi
        ? await requestDvrFileTransferMulti(jar, body.serials as string[], body.filenames as string[])
        : await requestDvrFileTransfer(jar, serial, filename);
      await this.ctx.storage.put<DvrSessionRecord>(DVR_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      // code<=0 は要求が受理されなかったケース (既に転送中 / 対象外等)。UI で判別できるよう
      // accepted フラグを載せる (エラーにはしない — 状態は通知一覧で再確認する)。
      return Response.json({ accepted: result.code > 0, code: result.code });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(DVR_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      console.error("DVR transfer error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `映像ファイルの転送要求に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** GET /dvr-api/file?serial=&filename= — `.vdf` をマジックバイト検証付きで browser に
   * ストリーム素通しする (数十 MB になり得るため buffer しない)。
   *
   * ダウンロードは 2 段 (Refs #90 実ページ検証済み): Request_DvrFileDownload で
   * サーバー生成の実相対パスを解決 → `/dvrData/{path}` を GET。決定論パスは組み立て
   * られない (実データで 404)。未転送 (receiveState != ready) の場合は
   * Request_DvrFileDownload が code<=0 を返し、requestDvrDownloadPath が「受信してから」
   * を促す TheearthClientError を投げる。 */
  private async handleDvrFile(record: DvrSessionRecord, url: URL): Promise<Response> {
    const serial = url.searchParams.get("serial");
    const filename = url.searchParams.get("filename");
    if (!serial || !filename) {
      return dvrJsonError(400, "serial / filename が必要です");
    }

    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const target = await requestDvrDownloadPath(jar, serial, filename);
      const stream = await openDvrFileStream(jar, dvrDataUrl(target.path));
      // cookie 更新を書き戻す (セッション延命)。stream 開始後なので await はしない
      // (ヘッダ送出をブロックしない) — 失敗しても致命的でない。
      this.ctx.waitUntil(
        this.ctx.storage.put<DvrSessionRecord>(DVR_SESSION_KEY, {
          ...record,
          cookies: Array.from(jar.cookies.entries()),
        }),
      );
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${target.filename}"`,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(DVR_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      console.error("DVR file error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `DVR 動画ファイルの取得に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  // -------------------------------------------------------------------------
  // /daily-report-api/* — 日報編集 (Refs #169)。credential pass-through 設計は
  // /dvr-api/* と同じ (password はログイン 1 リクエストの body にだけ現れ、
  // 保存も log 出力もしない)。DVR viewer とは theearth ログインセッションを
  // 共有しない (DO instance 自体が report-{comp}:{userB64} で別れる)。
  // -------------------------------------------------------------------------

  private async handleReportApi(request: Request, url: URL): Promise<Response> {
    const routing = resolveReportRouting(request.headers);
    if (!routing) {
      return dvrJsonError(400, "X-Report-Comp-Id / X-Report-User-B64 ヘッダが不正です");
    }

    if (url.pathname === "/daily-report-api/login" && request.method === "POST") {
      return this.handleReportLogin(request, routing);
    }

    const record = await this.ctx.storage.get<ReportSessionRecord>(REPORT_SESSION_KEY);
    const token = extractBearerToken(request.headers);
    if (!isReportSessionValid(record, token, routing, Date.now())) {
      return dvrJsonError(401, "セッションが無効か期限切れです。再ログインしてください");
    }

    if (url.pathname === "/daily-report-api/logout" && request.method === "POST") {
      await this.ctx.storage.delete(REPORT_SESSION_KEY);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/daily-report-api/list" && request.method === "GET") {
      return this.handleReportList(record!, url);
    }
    if (url.pathname === "/daily-report-api/expense" && request.method === "GET") {
      return this.handleReportExpenseForm(record!, url);
    }
    if (url.pathname === "/daily-report-api/expense/save" && request.method === "POST") {
      return this.handleReportExpenseSave(record!, request);
    }
    if (url.pathname === "/daily-report-api/expense/recalculate" && request.method === "POST") {
      return this.handleReportExpenseRecalculate(record!, request);
    }
    if (url.pathname === "/daily-report-api/zip" && request.method === "GET") {
      return this.handleReportZip(record!, url);
    }
    if (url.pathname === "/daily-report-api/unlock-all" && request.method === "POST") {
      return this.handleReportUnlockAll(record!);
    }
    return dvrJsonError(404, "Not Found");
  }

  /** POST /daily-report-api/login — theearth にその場でログインし、成功したら
   * session cookie + token を保存して token を返す (handleDvrLogin と同型)。 */
  private async handleReportLogin(request: Request, routing: ReportRouting): Promise<Response> {
    let body: { user_pass?: unknown };
    try {
      body = (await request.json()) as { user_pass?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const userPass = typeof body.user_pass === "string" ? body.user_pass : "";
    if (!userPass) {
      return dvrJsonError(400, "user_pass が必要です");
    }

    const jar = createCookieJar();
    try {
      await login(jar, {
        compId: routing.compId,
        userName: routing.userName,
        userPass,
      });
    } catch (err) {
      console.error("Report login error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `theearth へのログインに失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(401, message);
    }

    const now = Date.now();
    const record: ReportSessionRecord = {
      token: generateSessionToken(),
      compId: routing.compId,
      userName: routing.userName,
      cookies: Array.from(jar.cookies.entries()),
      createdAt: now,
      expiresAt: now + REPORT_SESSION_TTL_MS,
    };
    await this.ctx.storage.put(REPORT_SESSION_KEY, record);
    return Response.json({ token: record.token, expires_at: record.expiresAt });
  }

  /** report 系 API 呼び出しの共通ラッパ (callDvrVenus と同型): cookie 書き戻し +
   * セッション切れ 401 / パラメータ不正 400 / その他 502 のマッピング。 */
  private async callReportAction<T>(
    record: ReportSessionRecord,
    errorLabel: string,
    fn: (jar: CookieJar) => Promise<T>,
  ): Promise<Response> {
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const result = await fn(jar);
      await this.ctx.storage.put<ReportSessionRecord>(REPORT_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json(result);
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(REPORT_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      if (err instanceof ReportParamError) {
        return dvrJsonError(400, err.message);
      }
      console.error(`Report ${errorLabel} error:`, err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `${errorLabel}に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** GET /daily-report-api/list?from=&to= — F-NRS1010 全ページ収集。from/to は
   * "YYYY/MM/DD HH:mm" 形式 (harvestDailyReport の HarvestRange)。読取日ソートが
   * 降順設定になっているか (`sortOk`) も併せて返す — false の場合フロント側で
   * 「表示条件指定を確認してください」の警告を出す想定 (SKILL.md 早期打ち切りの前提)。
   * 同一 theearth セッションへの並行リクエストはセッションロックで hang/500 する
   * ため、必ず逐次実行する (Promise.all で並列化しない)。 */
  private handleReportList(record: ReportSessionRecord, url: URL): Promise<Response> {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    return this.callReportAction(record, "運転日報の取得", async (jar) => {
      const sortOk = await verifyReadNoDescending(jar);
      const rows = await harvestDailyReport(jar, { from, to });
      return { rows, sortOk };
    });
  }

  /** GET /daily-report-api/expense?opeNo=&startOpe= — F-DES1012 給油行の現在値。 */
  private handleReportExpenseForm(record: ReportSessionRecord, url: URL): Promise<Response> {
    const opeNo = url.searchParams.get("opeNo") ?? "";
    const startOpe = url.searchParams.get("startOpe") ?? "";
    return this.callReportAction(record, "経費入力フォームの取得", (jar) => getExpenseForm(jar, opeNo, startOpe));
  }

  /** POST /daily-report-api/expense/save — `btnExpenceEditSetting` postback で
   * 給油行 1 件を登録する (body は SaveFuelRowParams)。 */
  private async handleReportExpenseSave(record: ReportSessionRecord, request: Request): Promise<Response> {
    let body: SaveFuelRowParams;
    try {
      body = (await request.json()) as SaveFuelRowParams;
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    return this.callReportAction(record, "給油行の登録", (jar) => saveFuelRow(jar, body));
  }

  /** POST /daily-report-api/expense/recalculate — `btnScore` postback で評価点を
   * 再集計する (body は `{opeNo, startOpe}`)。 */
  private async handleReportExpenseRecalculate(record: ReportSessionRecord, request: Request): Promise<Response> {
    let body: { opeNo?: unknown; startOpe?: unknown };
    try {
      body = (await request.json()) as { opeNo?: unknown; startOpe?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const opeNo = typeof body.opeNo === "string" ? body.opeNo : "";
    const startOpe = typeof body.startOpe === "string" ? body.startOpe : "";
    return this.callReportAction(record, "評価点再集計", (jar) => recalculateExpense(jar, opeNo, startOpe));
  }

  /** GET /daily-report-api/zip?from=&to= — F-NOS3010 の編集後 csvdata.zip を
   * browser にストリーム素通しする (handleDvrFile と同型、JSON でなく binary
   * body なので callReportAction ではなく専用 handler にしてある)。from/to は
   * "YYYY-MM-DD" 形式 (downloadCsvZip の CsvDateRange)。 */
  private async handleReportZip(record: ReportSessionRecord, url: URL): Promise<Response> {
    const startDate = url.searchParams.get("from") ?? "";
    const endDate = url.searchParams.get("to") ?? "";
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const bytes = await downloadEditedZip(jar, { startDate, endDate });
      // cookie 書き戻しはヘッダ送出をブロックしない (handleDvrFile と同じ理由)。
      this.ctx.waitUntil(
        this.ctx.storage.put<ReportSessionRecord>(REPORT_SESSION_KEY, {
          ...record,
          cookies: Array.from(jar.cookies.entries()),
        }),
      );
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="csvdata-${record.compId}.zip"`,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(REPORT_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      console.error("Report zip error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `csvdata.zip の取得に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** POST /daily-report-api/unlock-all — F-DES1010 `btnInitialize` postback で
   * 残留ロックを全強制解放する。 */
  private handleReportUnlockAll(record: ReportSessionRecord): Promise<Response> {
    return this.callReportAction(record, "編集制御解除", async (jar) => {
      await forceUnlockAll(jar);
      return { ok: true };
    });
  }

  /** `/scraper-zip/:compId/:requestId` — 1回だけ取得できる zip ダウンロード。 */
  private async handleZipDownload(url: URL): Promise<Response> {
    const parts = url.pathname.split("/").filter(Boolean); // ["scraper-zip", compId, requestId]
    const requestId = parts[2];
    if (!requestId) return new Response("Bad Request", { status: 400 });

    const record = await this.ctx.storage.get<StoredZip>(`zip:${requestId}`);
    if (!record) {
      return new Response("Not Found (期限切れ、または既にダウンロード済みです)", { status: 404 });
    }
    await this.ctx.storage.delete(`zip:${requestId}`);

    return new Response(record.bytes, {
      status: 200,
      headers: {
        "content-type": record.contentType ?? "application/zip",
        "content-disposition": `attachment; filename="${record.filename ?? `csvdata-${record.compId}.zip`}"`,
      },
    });
  }

  /** DO storage に溜まった期限切れ zip を掃除する (ダウンロードされずに放置されたケース)。 */
  async alarm(): Promise<void> {
    const all = await this.ctx.storage.list<StoredZip>({ prefix: "zip:" });
    const now = Date.now();
    for (const [key, record] of all) {
      if (now - record.createdAt > ZIP_TTL_MS) {
        await this.ctx.storage.delete(key);
      }
    }
  }

  private sendSafely(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // ソケットが既に閉じている場合は無視 (browser 側が先に切断したケース)
    }
  }

  private closeSafely(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  // browser → dtako-scraper 方向は現状不要 (トリガー時のパラメータは接続 URL の
  // query string で完結する) が、将来 client からの中断指示等に備えて no-op で持つ。
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // 現状 browser → upstream の転送は不要。
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
    this.upstream?.close();
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    console.error("DtakoScraperRelayDO WebSocket error:", error);
    ws.close(1011, "Internal error");
    this.upstream?.close();
  }
}
