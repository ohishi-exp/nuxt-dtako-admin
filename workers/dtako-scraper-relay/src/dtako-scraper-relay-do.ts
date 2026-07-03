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
import { createCookieJar, login, scrapeViaHttp, TheearthClientError, type CookieJar } from "./theearth-client";
import { uploadDtakoZipViaAlcInternalProxy } from "./alc-internal-upload";
import {
  buildDvrFileUrl,
  getDvrNotifications,
  openDvrFileStream,
  VenusSessionExpiredError,
} from "./theearth-venus-client";
import {
  DVR_SESSION_TTL_MS,
  extractBearerToken,
  generateDvrToken,
  isDvrSessionValid,
  resolveDvrRouting,
  type DvrRouting,
  type DvrSessionRecord,
} from "./dvr-session";

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
}

const ZIP_TTL_MS = 10 * 60 * 1000;

/** /dvr-api/* のセッションレコードを置く DO storage キー。この DO instance は
 * theearth アカウント単位 (`dvr-{comp}:{userB64}`) なので 1 キーで足りる。 */
const DVR_SESSION_KEY = "dvr:session";

function dvrJsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
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

    // SCRAPER_MODE=http が完了後に生成する、1回だけ取得できる zip ダウンロード URL。
    // WebSocket アップグレードではない通常の GET。
    if (url.pathname.startsWith("/scraper-zip/")) {
      return this.handleZipDownload(url);
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

  /** 同一 comp_id (= この DO インスタンス) 内でのスクレイプ直列化。DO はシングルスレッド
   * 実行なので、Promise チェーンで先行タスクの完了を待つだけで安全に直列化できる。 */
  private async runHttpScrapeJob(
    server: WebSocket,
    params: { compId: string; startDate: string; endDate: string },
  ): Promise<void> {
    const myTurn = this.scrapeQueue.catch(() => undefined);
    let release: () => void = () => {};
    this.scrapeQueue = myTurn.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    this.sendSafely(server, { event: "progress", comp_id: params.compId, step: "queued" });
    await myTurn;

    try {
      await this.executeScrape(server, params);
    } finally {
      release();
    }
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
      this.sendSafely(server, { event: "result", comp_id: params.compId, step: "done", status: "error", message });
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
      const message =
        err instanceof TheearthClientError ? err.message : "theearth へのログインに失敗しました";
      return dvrJsonError(401, message);
    }

    const now = Date.now();
    const record: DvrSessionRecord = {
      token: generateDvrToken(),
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
        return dvrJsonError(401, "theearth セッションが切れました。再ログインしてください");
      }
      const message =
        err instanceof TheearthClientError ? err.message : "DVR 動画通知の取得に失敗しました";
      return dvrJsonError(502, message);
    }
  }

  /** GET /dvr-api/file?support_id=&vehicle_cd=&filename= — `.vdf` をマジックバイト
   * 検証付きで browser にストリーム素通しする (数十 MB になり得るため buffer しない)。
   * comp_id はクライアントから受けず、ログイン済みセッションの値を使う (他 comp の
   * パスを組み立てさせない)。 */
  private async handleDvrFile(record: DvrSessionRecord, url: URL): Promise<Response> {
    const supportId = url.searchParams.get("support_id");
    const vehicleCd = url.searchParams.get("vehicle_cd");
    const filename = url.searchParams.get("filename");
    if (!supportId || !vehicleCd || !filename) {
      return dvrJsonError(400, "support_id / vehicle_cd / filename がすべて必要です");
    }

    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const fileUrl = buildDvrFileUrl(record.compId, supportId, vehicleCd, filename);
      const stream = await openDvrFileStream(jar, fileUrl);
      return new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${filename}.vdf"`,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      const message =
        err instanceof TheearthClientError ? err.message : "DVR 動画ファイルの取得に失敗しました";
      return dvrJsonError(502, message);
    }
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
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="csvdata-${record.compId}.zip"`,
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
