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
import { PromiseQueue } from "./promise-queue";
import {
  createCookieJar,
  login,
  scrapeViaHttp,
  TheearthClientError,
  TheearthNotZipError,
  type CookieJar,
  type LoginResult,
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
import { CronConfigError, etcCsvKey, parseDtakoAccounts, parseEtcAccounts, resolveDtakoAccountsRaw, resolveSecretBinding, type DtakoAccountEntry, type EtcAccountEntry } from "./cron";
import {
  allowedViewerComps,
  compIdsInSameTenant,
  devViewerCompIds,
  isR2OnlyRestraintPath,
} from "./restraint-viewer-auth";
import { needsTheearthQueue } from "./restraint-queue";
import { UpstreamMemo } from "./upstream-memo";
import { measurePhase, PhaseTimer, phaseTimingLogLine } from "./phase-timing";
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
// theearth ログインセッション (dvr-api / daily-report-api 共通、Refs #233):
// routing 解決・レコード検証・token 生成 / Bearer token 抽出は theearth-session.ts
// が唯一の実装元 (かつての dvr-session.ts / report-session.ts ラッパーは統合済み)。
import {
  extractBearerToken,
  generateSessionToken,
  isTheearthSessionValid,
  resolveTheearthRouting,
  THEEARTH_SESSION_TTL_MS,
  type TheearthRouting,
  type TheearthSessionRecord,
} from "./theearth-session";
import {
  applyMinWageToWageMaster,
  computeWageRow,
  normalizeMinWageMaster,
  normalizeSalaryItemConfig,
  normalizeWageConfig,
  normalizeWageMaster,
  upsertWageMasterFromCsv,
  WageMasterError,
  type MinWageMaster,
  type WageConfig,
  type WageMaster,
} from "./restraint-wage";
import {
  MHLW_NATIONAL_LIST_URL,
  MinWageImportError,
  PREFECTURES,
  mergeMinWageRows,
  parseMhlwNationalList,
} from "./min-wage-import";
import { branchByDriverCdAt, buildBranchGroups, resolveBranchPrefecture } from "./branch-prefecture";
import {
  buildCompMapResponse,
  buildEmployeeMasterResponse,
  buildEmployeeMasterWriteStatements,
  EmployeeMasterError,
  normalizeEmployeeMasterPutBody,
  payKubunByDriverCdAt,
  resolveAttrsAt,
  type CompPayrollMapD1Row,
  type EmployeeAttrD1Row,
  type EmployeeD1Row,
} from "./employee-master";
import {
  buildHolidayWorkResponse,
  buildHolidayWorkWriteStatements,
  buildNightShiftResponse,
  buildNightShiftWriteStatements,
  buildWorkScheduleResponse,
  buildWorkScheduleWriteStatements,
  normalizeHolidayWorkPutBody,
  normalizeNightShiftPutBody,
  normalizeWorkSchedulePutBody,
  WorkScheduleError,
  type HolidayWorkD1Row,
  type NightShiftD1Row,
  type WorkScheduleD1Row,
  scopeByDriverCdAt,
  buildHolidayWorkIndex,
  buildNightShiftIndex,
  resolveWorkScheduleAt,
} from "./work-schedule";
import {
  isClericalJob,
  kintaiR2Paths,
  mergeSummarySources,
  stableTimecardSummaryBody,
  summarizeTimecardMonth,
  type TimecardDailyRow,
  type WageReportSource,
} from "./timecard-summary";
import {
  crossMonthMinutesByDate,
  kosokuPartsByDate,
  mergeKosokuShiftMaps,
  parseKosokuDaily,
  parseFerryMinusByDriver,
  parsePaperDriftByDriver,
  prevYmOf,
  type KosokuShift,
} from "./kosoku-daily";
import {
  compareTimecardMonth,
  compareTimecardMonthAll,
  parsePdfJson,
  pdfJsonError,
  type CompareResult,
} from "./timecard-compare";
import { buildRestraintD1Statements, type RestraintD1Entry } from "./restraint-d1";
import { buildRestraintPushBodies } from "./restraint-push";
import {
  isWageSourceResponse,
  wageSourceMonthToSummaries,
  type WageSourceMonthWire,
  type WageSourceResponseWire,
} from "./restraint-wage-source";
import {
  appendHistoryJsonl,
  downloadRestraintCsv,
  parseRestraintCsv,
  pickSupersededVersionKeys,
  restraintDriverRangeLabel,
  restraintHistoryLine,
  restraintR2Paths,
  RestraintParamError,
  restraintVersionTimestamp,
  stableNoDataSummaryBody,
  stableSummaryBody,
  summarizeRestraintDriver,
  validateRestraintParams,
  type RestraintCsvParams,
  type RestraintDriverSummary,
  type RestraintSummaryDay,
} from "./theearth-restraint-client";
import {
  addFuelRow,
  deleteFuelRow,
  downloadEditedZip,
  downloadOperationCsvZip,
  getExpenseForm,
  getReviseFormPage,
  getWorkForm,
  releaseLoadedOperation,
  harvestDailyReport,
  recalculateExpense,
  recalculateWork,
  startSystemLink,
  ReportParamError,
  saveDriverFromPage,
  saveFuelRow,
  saveWorkRowFromPage,
  startWorkRowEdit,
  unlockOperation,
  verifyReadNoDescending,
  withDisplayNarrow,
  type DisplayNarrow,
  type AddFuelRowParams,
  type DeleteFuelRowParams,
  type SaveFuelRowParams,
  type SaveWorkRowParams,
} from "./theearth-report-client";
import {
  downloadNet780Zip,
  net780R2IndexBody,
  net780R2Paths,
  Net780ParamError,
  searchNet780,
  validateNet780DownloadTargets,
  type Net780DownloadTarget,
  type Net780SearchParams,
} from "./theearth-net780-client";

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

/** theearth ログインセッションレコードを置く DO storage キー。/dvr-api/* と
 * /daily-report-api/* で共有する (Refs #233)。この DO instance は theearth
 * アカウント単位 (`theearth-{comp}:{userB64}`) なので 1 キーで足りる。 */
const THEEARTH_SESSION_KEY = "theearth:session";

/** F-DES1011 (運行データ修正) の取得時ページ HTML を置く DO storage キー。
 * F-DES1011 は最初の URL 直接 GET でだけ運行データがロードされる (2 回目の
 * GET は初期値が空。staging 実機 2026-07-10、Refs #171) ため、フォーム取得時の
 * ページを保存して登録 postback で再利用する (実ブラウザと同じ「開いたページ
 * から送信」を再現する)。 */
const REPORT_REVISE_PAGE_KEY = "report:revise-page";

/** 取得時ページの有効期限。theearth 側セッション/viewstate の寿命より十分短く。 */
const REPORT_REVISE_PAGE_TTL_MS = 15 * 60_000;

interface RevisePageRecord {
  opeNo: string;
  startOpe: string;
  html: string;
  savedAt: number;
}

/** F-DES1013 (作業入力) の編集モードページ HTML を置く DO storage キー。
 * `startWorkRowEdit` (btnEditButton postback) の応答を保存し、行の保存
 * (`saveWorkRowFromPage`) はその viewstate からそのまま `btnUpdateButton` を
 * postback する (実ブラウザの「鉛筆 → 修正 → 保存」の再現、Refs #170)。 */
const REPORT_WORK_EDIT_PAGE_KEY = "report:work-edit-page";

interface WorkEditPageRecord {
  opeNo: string;
  startOpe: string;
  ctrlIndex: number;
  html: string;
  savedAt: number;
}

function dvrJsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * 中継ハンドラの失敗を HTTP ステータスへ writeback するための型 (Refs #492 PR-A)。
 *
 * タイムカード突合は「クエリ検証 → 上流 2 本 → 純ロジック」と段が多く、途中で
 * `Response` を返す形にすると `Promise.all` が組めない。throw して 1 箇所
 * ([`relayErrorResponse`]) で写す。
 */
class RelayBadRequestError extends Error {}
/** 資格情報・binding が揃っていない (= 503)。 */
class RelayConfigError extends Error {}
/** 上流が non-2xx を返した (= 502)。 */
class RelayUpstreamError extends Error {}

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

/** 今日の日付 (JST) を "YYYY-MM-DD" で返す (タイムカードの当日判定用、nginx#780)。 */
function formatJstDate(date: Date): string {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  return (
    `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}`
    + `-${String(jst.getUTCDate()).padStart(2, "0")}`
  );
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
   * relay の設定 KV (`dtako-relay-config`)。`dtako_accounts` キーに
   * `DTAKO_ACCOUNTS` の JSON を置く — dashboard の plain 変数は deploy で消えて
   * viewer 認可が全社 401 になる事故があったため、KV を正とする (Refs #367)。
   * 投入は CI (`dtako-scraper-relay-deploy.yml`)。
   */
  DTAKO_CONFIG_KV?: unknown;
  /**
   * ローカル開発専用: restraint viewer 経路 (Refs #272) の introspect を短絡して
   * この comp を許可する。`wrangler dev --var RESTRAINT_DEV_VIEWER_COMP:<comp>`
   * でのみ渡す — デプロイ環境 (wrangler.toml / dashboard) には置かない。
   *
   * **カンマ区切りで複数指定できる** (`--var RESTRAINT_DEV_VIEWER_COMP:a,b`) —
   * 社員マスタの会社横断表示 (Refs #367) をローカルで検証するために必要
   * (本番は DTAKO_ACCOUNTS の tenant 逆引きで複数 comp が許可される)。
   */
  RESTRAINT_DEV_VIEWER_COMP?: string;
  /**
   * ETC 利用照会サービスのアカウント JSON 配列 (`[{user_id, password}, ...]`、
   * browser-render-rust の `ETC_ACCOUNTS` env と同一 shape)。DTAKO_ACCOUNTS と
   * 同じく dashboard の plain Environment Variable として投入する (wrangler.toml
   * に置かない = git 履歴に平文を残さない、`keep_vars = true` で deploy を
   * またいで保持)。未設定の間は ETC cron が skip される (Refs
   * ohishi-exp/browser-render-rust#14)。
   */
  ETC_ACCOUNTS?: unknown;
  /** 勤怠 (タイムカード) の取得先 = rust-ichibanboshi の CF Tunnel hostname
   * (Refs #424 PR-A)。未設定なら `/restraint-api/kintai/fetch` は 503。 */
  NUXT_ICHIBAN_API_URL?: string;
  /** 一番星 CF Access Service Token の client_id (公開識別子)。 */
  NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID?: string;
  /** 同 client_secret (Secrets Store binding。app 本体と同じ entry を物理共有)。 */
  ICHIBAN_CF_ACCESS_CLIENT_SECRET?: unknown;
  /** 勤怠アーカイブの R2 prefix (既定 `kintai`)。theearth 由来 (`restraint`) とは
   * 別に置く — 同じ月・同じ乗務員CD で両方存在しうるため。 */
  KINTAI_R2_PREFIX?: string;
  /** ETC 明細 CSV の保存先 R2 bucket (dtako-uploads)。拘束時間管理表 CSV
   * (`/restraint-api/*`、Refs #241) のアーカイブ先も兼ねる。 */
  DTAKO_R2?: R2Bucket;
  /** ETC CSV の R2 key prefix。staging は `etc-staging` で本番 (`etc`) と分離する。 */
  ETC_R2_PREFIX?: string;
  /** 拘束時間管理表 CSV / サマリ JSON の R2 key prefix (`restraint` /
   * `restraint-staging` / `restraint-preview`)。key 設計とバージョン管理
   * (latest + 内容が変わった時だけ `v-{ts}` 追加、SHA-256 変化検知) は
   * `theearth-restraint-client.ts` の `restraintR2Paths` の doc 参照。 */
  RESTRAINT_R2_PREFIX?: string;
  /** NET780 生データ一括ダウンロード ZIP の R2 key prefix (`net780` /
   * `net780-staging` / `net780-preview`)。key 設計 (内容ハッシュで dedup +
   * operationNo ごとのポインタ index) は `theearth-net780-client.ts` の
   * `net780R2Paths` の doc 参照 (Refs #302)。 */
  NET780_R2_PREFIX?: string;
  /** NET780 / vehicle-settings アップロードデータの検索カタログ D1 (Refs #299)。
   * R2 が正、D1 は車番/乗務員CD/運行No 検索用の再構築可能インデックス。未
   * binding の環境では検索カタログへの書き込みを best-effort でスキップする。 */
  DTAKO_DB?: D1Database;
}

export class DtakoScraperRelayDO extends DurableObject<RelayEnv> {
  /** 上流 (dtako-scraper) への WebSocket。plain socket なので DO を active に保つ。 */
  private upstream: WebSocket | null = null;
  /** SCRAPER_MODE=http 時、同一 comp_id (= この DO インスタンス) 内でスクレイプを
   * 直列化するための待ち行列。`PromiseQueue` (pure、node vitest でテスト可) 実装
   * を利用する。 */
  private scrapeQueue = new PromiseQueue();
  /** dvr-api / daily-report-api の theearth セッション (cookie) を読み書きする
   * 処理を直列化する待ち行列。同一 DO 内で複数リクエストが並行すると
   * storage.get → theearth への実 HTTP コール → storage.put がインターリーブし、
   * 片方の書き戻しがもう片方の新しい cookie を古いスナップショットで上書きする
   * lost update が起き、theearth 側セッションが即座に無効化される (Refs #237、
   * dvr-viewer.vue の loadNotifications+loadMasters 並列発火で顕在化)。
   * scrapeQueue と同じ `PromiseQueue` 実装を利用する。 */
  private theearthQueue = new PromiseQueue();

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
  /** DTAKO_ACCOUNTS の生 JSON。KV (`DTAKO_CONFIG_KV`) が正、無ければ binding。
   * **空なら loud fail** — 空のまま viewer 認可へ進むと全会社 401 になり、画面には
   * 「セッションが無効か期限切れです」としか出ないため原因が追えない
   * (2026-07-25 に本番で実際に起きた)。 */
  private async dtakoAccountsRaw(): Promise<string> {
    const raw = await resolveDtakoAccountsRaw(this.env.DTAKO_CONFIG_KV, this.env.DTAKO_ACCOUNTS);
    if (!raw) {
      console.error(
        JSON.stringify({
          dtako_accounts: "missing",
          detail: "KV(dtako_accounts) も binding も空 — viewer 認可は全 comp で拒否されます",
        }),
      );
    }
    return raw;
  }

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
      return {
        active: true,
        tenant_id: typeof data.tenant_id === "string" ? data.tenant_id : undefined,
        role: typeof data.role === "string" ? data.role : undefined,
      };
    } catch {
      return { active: false };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // /dvr-viewer 系 (Refs #90) の DVR viewer API。scraper 系とは独立した経路で、
    // 認証は auth-worker introspect ではなく「theearth へのログインそのもの」
    // (credential pass-through、./theearth-session.ts のヘッダコメント参照)。
    if (url.pathname.startsWith("/dvr-api/")) {
      return this.handleDvrApi(request, url);
    }

    // /daily-report-edit (日報編集、Refs #169) の API。DVR viewer と同型の
    // credential pass-through で、theearth ログインセッションも共有する
    // (同一 DO instance `theearth-{comp}:{userB64}` + 同一レコード、Refs #233)。
    if (url.pathname.startsWith("/daily-report-api/")) {
      return this.handleReportApi(request, url);
    }

    // /restraint-fetch (拘束時間管理表 CSV 取得、Refs #241) の API。日報編集と
    // 同型の credential pass-through + theearth ログインセッション共有。
    if (url.pathname.startsWith("/restraint-api/")) {
      return this.handleRestraintApi(request, url);
    }

    // /net780 (theearth F-VOS3020 検索・NET780 生データ一括ダウンロード、Refs #302)
    // の API。他の theearth 系エンドポイントと同型の credential pass-through +
    // theearth ログインセッション共有。
    if (url.pathname.startsWith("/net780-api/")) {
      return this.handleNet780Api(request, url);
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

  /** この DO インスタンス内でスクレイプ job を直列化する共通キュー。WS 手動
   * トリガーと cron 無人実行が同一 comp_id / ETC アカウントに重なっても直列に
   * 捌かれる (issue #22 の設計どおり)。`scrapeQueue` (`PromiseQueue`) への薄い
   * delegator (Refs #237、theearthQueue と実装元を統合)。 */
  private async enqueueScrape<T>(job: () => Promise<T>): Promise<T> {
    return this.scrapeQueue.enqueue(job);
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
    const routing = resolveTheearthRouting(request.headers);
    if (!routing) {
      return dvrJsonError(400, "X-Theearth-Comp-Id / X-Theearth-User-B64 ヘッダが不正です");
    }
    // record の read → theearth への実 HTTP コール → write を丸ごとキューで直列化
    // する (Refs #237)。login/logout も同じキューに乗せ、cookie の lost update を防ぐ。
    return this.theearthQueue.enqueue(() => this.dispatchDvrApi(request, url, routing));
  }

  private async dispatchDvrApi(request: Request, url: URL, routing: TheearthRouting): Promise<Response> {
    if (url.pathname === "/dvr-api/login" && request.method === "POST") {
      return this.handleTheearthLogin(request, routing);
    }

    const record = await this.ctx.storage.get<TheearthSessionRecord>(THEEARTH_SESSION_KEY);
    const token = extractBearerToken(request.headers);
    if (!isTheearthSessionValid(record, token, routing, Date.now())) {
      return dvrJsonError(401, "セッションが無効か期限切れです。再ログインしてください");
    }

    if (url.pathname === "/dvr-api/logout" && request.method === "POST") {
      await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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

  /** POST /dvr-api/login・/daily-report-api/login (共通、Refs #233) — theearth に
   * その場でログインし、成功したら session cookie + token を保存して token を返す。
   * credential はこのメソッドのスコープ外に出さない。 */
  private async handleTheearthLogin(request: Request, routing: TheearthRouting): Promise<Response> {
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
    let loginResult: LoginResult;
    try {
      loginResult = await login(jar, {
        compId: routing.compId,
        userName: routing.userName,
        userPass,
      });
    } catch (err) {
      // TheearthClientError の message は自前クライアントの説明文 (credential は含まない)。
      console.error("theearth login error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `theearth へのログインに失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(401, message);
    }

    const now = Date.now();
    const record: TheearthSessionRecord = {
      token: generateSessionToken(),
      compId: routing.compId,
      userName: routing.userName,
      cookies: Array.from(jar.cookies.entries()),
      createdAt: now,
      expiresAt: now + THEEARTH_SESSION_TTL_MS,
    };
    await this.ctx.storage.put(THEEARTH_SESSION_KEY, record);
    // フロント (TheearthSessionHeader.vue) がライセンス超過の自動 kick を表示できるよう返す (Refs #169)。
    return Response.json({
      token: record.token,
      expires_at: record.expiresAt,
      kicked: loginResult.kicked,
      ...(loginResult.kickedUserName ? { kicked_user_name: loginResult.kickedUserName } : {}),
    });
  }

  /** GET /dvr-api/notifications — VenusBridge の DVR 動画通知一覧。 */
  private async handleDvrNotifications(record: TheearthSessionRecord): Promise<Response> {
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const notifications = await getDvrNotifications(jar);
      // theearth 側が cookie を更新した場合に備えて書き戻す (セッション延命)。
      await this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json({ notifications });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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
  private async handleDvrMasters(record: TheearthSessionRecord): Promise<Response> {
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const masters = await getDvrMasters(jar);
      await this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json(masters);
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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
  private async handleDvrSearch(record: TheearthSessionRecord, request: Request): Promise<Response> {
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
      await this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json({ rows });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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
    record: TheearthSessionRecord,
    errorLabel: string,
    fn: (jar: CookieJar) => Promise<T>,
  ): Promise<Response> {
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const result = await fn(jar);
      await this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json(result);
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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
  private handleDvrVehicleStates(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const branch = url.searchParams.get("branch") ?? "";
    return this.callDvrVenus(record, "車輌現在地の取得", async jar => ({
      vehicles: await getVehicleStates(jar, branch),
    }));
  }

  /** GET /dvr-api/log-track?vehicle=<CD>&start=YYYY/MM/DD&end=YYYY/MM/DD —
   * 車輌 1 台の動態履歴 GPS 軌跡 (VehicleStateTable)。 */
  private handleDvrLogTrack(record: TheearthSessionRecord, url: URL): Promise<Response> {
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
  private async handleDvrTransfer(record: TheearthSessionRecord, request: Request): Promise<Response> {
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
      await this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      // code<=0 は要求が受理されなかったケース (既に転送中 / 対象外等)。UI で判別できるよう
      // accepted フラグを載せる (エラーにはしない — 状態は通知一覧で再確認する)。
      return Response.json({ accepted: result.code > 0, code: result.code });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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
  private async handleDvrFile(record: TheearthSessionRecord, url: URL): Promise<Response> {
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
        this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
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
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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
  // 保存も log 出力もしない)。theearth ログインセッションは DVR viewer と共有する
  // (同一 DO instance `theearth-{comp}:{userB64}` + 同一レコード、Refs #233)。
  // -------------------------------------------------------------------------

  private async handleReportApi(request: Request, url: URL): Promise<Response> {
    const routing = resolveTheearthRouting(request.headers);
    if (!routing) {
      return dvrJsonError(400, "X-Theearth-Comp-Id / X-Theearth-User-B64 ヘッダが不正です");
    }
    // record の read → theearth への実 HTTP コール → write を丸ごとキューで直列化
    // する (Refs #237)。dvr-api と同じ DO 内 theearthQueue を共有するため、
    // dvr-api / daily-report-api をまたいだ並行アクセスも直列化される。
    return this.theearthQueue.enqueue(() => this.dispatchReportApi(request, url, routing));
  }

  private async dispatchReportApi(request: Request, url: URL, routing: TheearthRouting): Promise<Response> {
    if (url.pathname === "/daily-report-api/login" && request.method === "POST") {
      return this.handleTheearthLogin(request, routing);
    }

    const record = await this.ctx.storage.get<TheearthSessionRecord>(THEEARTH_SESSION_KEY);
    const token = extractBearerToken(request.headers);
    if (!isTheearthSessionValid(record, token, routing, Date.now())) {
      return dvrJsonError(401, "セッションが無効か期限切れです。再ログインしてください");
    }

    if (url.pathname === "/daily-report-api/logout" && request.method === "POST") {
      await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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
    if (url.pathname === "/daily-report-api/expense/add" && request.method === "POST") {
      return this.handleReportExpenseAdd(record!, request);
    }
    if (url.pathname === "/daily-report-api/expense/delete" && request.method === "POST") {
      return this.handleReportExpenseDelete(record!, request);
    }
    if (url.pathname === "/daily-report-api/expense/recalculate" && request.method === "POST") {
      return this.handleReportExpenseRecalculate(record!, request);
    }
    if (url.pathname === "/daily-report-api/expense/link-sys" && request.method === "POST") {
      return this.handleReportSystemLink(record!, request);
    }
    if (url.pathname === "/daily-report-api/zip" && request.method === "GET") {
      return this.handleReportZip(record!, url);
    }
    if (url.pathname === "/daily-report-api/unlock" && request.method === "POST") {
      return this.handleReportUnlock(record!, request);
    }
    if (url.pathname === "/daily-report-api/work" && request.method === "GET") {
      return this.handleReportWorkForm(record!, url);
    }
    if (url.pathname === "/daily-report-api/work/edit-start" && request.method === "POST") {
      return this.handleReportWorkEditStart(record!, request);
    }
    if (url.pathname === "/daily-report-api/work/save" && request.method === "POST") {
      return this.handleReportWorkSave(record!, request);
    }
    if (url.pathname === "/daily-report-api/work/recalculate" && request.method === "POST") {
      return this.handleReportWorkRecalculate(record!, request);
    }
    if (url.pathname === "/daily-report-api/revise" && request.method === "GET") {
      return this.handleReportReviseForm(record!, url);
    }
    if (url.pathname === "/daily-report-api/revise/save" && request.method === "POST") {
      return this.handleReportReviseSave(record!, request);
    }
    if (url.pathname === "/daily-report-api/masters" && request.method === "GET") {
      return this.handleReportMasters(record!);
    }
    return dvrJsonError(404, "Not Found");
  }

  // -------------------------------------------------------------------------
  // /restraint-api/* — 拘束時間管理表 CSV 取得 (F-ERS2010、Refs #241)。
  // credential pass-through / theearth セッション共有は daily-report-api と同じ。
  // 実機確定知見は ./theearth-restraint-client.ts のヘッダコメント参照。
  // -------------------------------------------------------------------------

  private async handleRestraintApi(request: Request, url: URL): Promise<Response> {
    const routing = resolveTheearthRouting(request.headers);
    if (!routing) {
      return dvrJsonError(400, "X-Theearth-Comp-Id / X-Theearth-User-B64 ヘッダが不正です");
    }
    // theearth の cookie を read→HTTP→write するルートだけ直列化する (Refs #237/#507)。
    // dvr-api / daily-report-api と同じキューなので、ページをまたいだ並行アクセス
    // も直列化される (同一 ASP.NET セッションへの並行リクエストは hang/500 する)。
    // theearth に触らないルート (wage-report / kosoku-daily 中継 / D1 / R2 系) は
    // キューを通さない — 全ルートを直列化していた時は、タブを開いた時の同時
    // リクエストが 1 本ずつ処理され、D1 のみの employee-master が CPU 0ms のまま
    // p95 31 秒になっていた (本番実測 2026-07-29)。キュー外ルートはセッション
    // record を読むだけで書かないので、並行しても theearth セッションは壊れない。
    if (needsTheearthQueue(url.pathname)) {
      return this.theearthQueue.enqueue(() => this.dispatchRestraintApi(request, url, routing));
    }
    return this.dispatchRestraintApi(request, url, routing);
  }

  /** URL query から RestraintCsvParams を組み立てる。検証は呼び出し側で
   * validateRestraintParams (RestraintParamError → 400)。 */
  private parseRestraintQuery(url: URL): RestraintCsvParams {
    return {
      year: Number(url.searchParams.get("year") ?? ""),
      month: Number(url.searchParams.get("month") ?? ""),
      driverFrom: url.searchParams.get("driverFrom") ?? "",
      driverTo: url.searchParams.get("driverTo") ?? "",
    };
  }

  /**
   * R2-only ルートの viewer 認可 (Refs #272): auth-worker introspect で JWT を検証し、
   * DTAKO_ACCOUNTS (comp_id→tenant_id) の逆引きで routing の compId がその tenant の
   * ものだと確認できた時だけ、閲覧用の合成レコードを返す。合成レコードは cookies を
   * 持たない — R2-only ハンドラは record.compId しか参照しないため十分。
   * DTAKO_ACCOUNTS 未設定/不正・introspect 不成立は null (fail-closed)。
   */
  private async authorizeRestraintViewer(
    token: string | null,
    routing: TheearthRouting,
    url: URL,
  ): Promise<TheearthSessionRecord | null> {
    const viewerRecord = (role?: string): TheearthSessionRecord => ({
      viewerRole: role,
      token: token ?? "viewer",
      compId: routing.compId,
      userName: routing.userName,
      cookies: [],
      createdAt: Date.now(),
      expiresAt: Date.now(),
    });
    // ローカル開発専用の短絡 (Env.RESTRAINT_DEV_VIEWER_COMP のコメント参照)。
    // nuxt dev は stagingTenantId バイパスで auth セッションを持たないため、
    // JWT 無しでも許可する (token 必須チェックより先に判定)。
    if (this.env.RESTRAINT_DEV_VIEWER_COMP) {
      return devViewerCompIds(this.env.RESTRAINT_DEV_VIEWER_COMP).has(routing.compId) ? viewerRecord() : null;
    }
    if (!token) return null;
    const result = await this.introspect(token, `https://${url.host}`);
    if (!result.active || !result.tenant_id) return null;
    let accounts: DtakoAccountEntry[];
    try {
      accounts = parseDtakoAccounts((await this.dtakoAccountsRaw()) || undefined);
    } catch {
      return null; // DTAKO_ACCOUNTS 不正は fail-closed (viewer 経路のみ閉じる)
    }
    // admin は DTAKO_ACCOUNTS に載っている全会社を見られる (グループ管理者、
    // Refs #367)。それ以外は従来どおり自 tenant の会社のみ。
    return allowedViewerComps(accounts, result.tenant_id, result.role).has(routing.compId)
      ? viewerRecord(result.role)
      : null;
  }

  private async dispatchRestraintApi(request: Request, url: URL, routing: TheearthRouting): Promise<Response> {
    if (url.pathname === "/restraint-api/login" && request.method === "POST") {
      return this.handleTheearthLogin(request, routing);
    }

    const stored = await this.ctx.storage.get<TheearthSessionRecord>(THEEARTH_SESSION_KEY);
    const token = extractBearerToken(request.headers);
    let record: TheearthSessionRecord | null = isTheearthSessionValid(stored, token, routing, Date.now())
      ? stored!
      : null;
    // R2-only ルート (賃金マスタ・アーカイブ閲覧・wage-report 等) は theearth
    // セッションが無くても auth-worker JWT (viewer 経路) で認可する (Refs #272)。
    // theearth を実際に触る login/logout/report/csv は従来どおりセッション必須。
    if (!record && isR2OnlyRestraintPath(url.pathname)) {
      record = await this.authorizeRestraintViewer(token, routing, url);
    }
    if (!record) {
      return dvrJsonError(401, "セッションが無効か期限切れです。再ログインしてください");
    }

    if (url.pathname === "/restraint-api/logout" && request.method === "POST") {
      await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/restraint-api/report" && request.method === "GET") {
      return this.handleRestraintReport(record!, url);
    }
    if (url.pathname === "/restraint-api/csv" && request.method === "GET") {
      return this.handleRestraintCsv(record!, url);
    }
    // ---- 賃金マスタ / 計算設定 (R2、theearth には触らない。Refs #244) ----
    if (url.pathname === "/restraint-api/wage-master") {
      return this.handleWageMasterRoute(record!, request, "wage-master", (raw) => normalizeWageMaster(raw));
    }
    if (url.pathname === "/restraint-api/min-wage") {
      return this.handleWageMasterRoute(record!, request, "min-wage", (raw) => normalizeMinWageMaster(raw));
    }
    if (url.pathname === "/restraint-api/min-wage/import-mhlw" && request.method === "POST") {
      return this.handleMinWageImport(record!, request);
    }
    if (url.pathname === "/restraint-api/min-wage/branches" && request.method === "GET") {
      return this.handleMinWageBranches(record!);
    }
    if (url.pathname === "/restraint-api/min-wage/apply-to-wage-master" && request.method === "POST") {
      return this.handleApplyMinWageToWageMaster(record!, request);
    }
    if (url.pathname === "/restraint-api/wage-config") {
      return this.handleWageMasterRoute(record!, request, "wage-config", (raw) => normalizeWageConfig(raw));
    }
    // 給与明細 CSV 比較の支給項目区分 (Refs #253)。CSV 本文は保存しない —
    // 保存対象はこの区分設定 JSON だけ (比較はブラウザ内で完結する)。
    if (url.pathname === "/restraint-api/salary-item-config") {
      return this.handleWageMasterRoute(record!, request, "salary-item-config", (raw) => normalizeSalaryItemConfig(raw));
    }
    if (url.pathname === "/restraint-api/wage-master/csv" && request.method === "POST") {
      return this.handleWageMasterCsvImport(record!, request);
    }
    // ---- 社員マスタ (D1、金額は持たない。Refs #367) ----
    if (url.pathname === "/restraint-api/employee-master" && request.method === "GET") {
      return this.handleEmployeeMasterGet(record!);
    }
    if (url.pathname === "/restraint-api/employee-master" && request.method === "PUT") {
      return this.handleEmployeeMasterPut(request, record!);
    }
    if (url.pathname === "/restraint-api/comp-map" && request.method === "GET") {
      return this.handleCompMap(record!);
    }
    // ---- 所定労働時間マスタ / 休日出勤の承認簿 (Refs #424 PR-C) ----
    if (url.pathname === "/restraint-api/work-schedule" && request.method === "GET") {
      return this.handleWorkScheduleGet(record!);
    }
    if (url.pathname === "/restraint-api/work-schedule" && request.method === "PUT") {
      return this.handleWorkSchedulePut(request, record!);
    }
    if (url.pathname === "/restraint-api/holiday-work" && request.method === "GET") {
      return this.handleHolidayWorkGet(record!, url);
    }
    if (url.pathname === "/restraint-api/holiday-work" && request.method === "PUT") {
      return this.handleHolidayWorkPut(request, record!);
    }
    if (url.pathname === "/restraint-api/night-shift" && request.method === "GET") {
      return this.handleNightShiftGet(record!);
    }
    if (url.pathname === "/restraint-api/night-shift" && request.method === "PUT") {
      return this.handleNightShiftPut(request, record!);
    }
    // ---- 勤怠 (タイムカード) の取得とアーカイブ (Refs #424 PR-A) ----
    if (url.pathname === "/restraint-api/kintai/fetch" && request.method === "POST") {
      return this.handleKintaiFetch(record!, url);
    }
    if (url.pathname === "/restraint-api/kintai/archive" && request.method === "GET") {
      return this.handleKintaiArchive(record!, url);
    }
    // ---- 打刻基準の日別サマリ (ドライバーの拘束・深夜。Refs #472 PR-A) ----
    if (url.pathname === "/restraint-api/kintai/pdf-json" && request.method === "GET") {
      return this.handleKintaiPdfJson(url);
    }
    if (url.pathname === "/restraint-api/timecard-compare" && request.method === "GET") {
      return this.handleTimecardCompare(url);
    }
    if (url.pathname === "/restraint-api/kintai/kosoku-daily" && request.method === "GET") {
      return this.handleKintaiKosokuDaily(url);
    }
    // ---- アーカイブ閲覧 (R2 読み出しのみ。Refs #244) ----
    if (url.pathname === "/restraint-api/archive/summaries" && request.method === "GET") {
      return this.handleArchiveSummaries(record!, url);
    }
    if (url.pathname === "/restraint-api/archive/csv-list" && request.method === "GET") {
      return this.handleArchiveCsvList(record!, url);
    }
    if (url.pathname === "/restraint-api/archive/csv" && request.method === "GET") {
      return this.handleArchiveCsvDownload(record!, url);
    }
    if (url.pathname === "/restraint-api/archive/history" && request.method === "GET") {
      return this.handleArchiveHistory(record!, url);
    }
    if (url.pathname === "/restraint-api/archive/resummarize" && request.method === "POST") {
      return this.handleArchiveResummarize(record!, url);
    }
    if (url.pathname === "/restraint-api/archive/months" && request.method === "GET") {
      return this.handleArchiveMonths(record!);
    }
    // ---- 賃金計算 (月指定、R2 summary + マスタから。Refs #244) ----
    if (url.pathname === "/restraint-api/wage-report" && request.method === "GET") {
      return this.handleWageReport(record!, url);
    }
    return dvrJsonError(404, "Not Found");
  }

  // -------------------------------------------------------------------------
  // /restraint-api の賃金マスタ・アーカイブ閲覧・賃金計算 (Refs #244)
  // いずれも theearth には触らず R2 だけを読み書きする。
  // -------------------------------------------------------------------------

  /** マスタ類の R2 配置 (comp 単位、月に依らない)。 */
  private wageMasterR2Paths(compId: string, name: "wage-master" | "min-wage" | "wage-config" | "salary-item-config") {
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const dir = `${prefix}/${compId}/${name}`;
    return { dir, latest: `${dir}/latest.json`, version: (ts: string) => `${dir}/v-${ts}.json` };
  }

  /** R2 list を cursor で全件回す (versions が増えると 1 回の list に収まらないため)。 */
  private async listAllR2(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
    const out: R2Object[] = [];
    let cursor: string | undefined;
    do {
      // `include` はランタイムでは実装済みだが、この workers-types バージョンの
      // R2ListOptions に型が無いため cast する (customMetadata を list 結果に含める)。
      const res: R2Objects = await bucket.list({
        prefix,
        cursor,
        include: ["customMetadata"],
      } as unknown as R2ListOptions);
      out.push(...res.objects);
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);
    return out;
  }

  /** GET/PUT /restraint-api/{wage-master|min-wage|wage-config} — マスタ JSON の
   * 読み書き。PUT は normalize (構造検証) 後に putVersionedR2 で版管理保存する
   * (一括変更 = PUT 1 回 = 1 版)。
   *
   * 楽観排他 (Refs #253): GET は latest の sha256 を `version` として返す。PUT の
   * body に `baseVersion` (GET で受け取った version) があれば、保存直前の
   * latest.sha256 と突き合わせる。不一致 = 自分が読んだ後に他の保存が入った ⇒
   * 409 + 現在のサーバ内容を返す (上書きせず、クライアント側でマージしてから
   * 再送させる)。baseVersion 省略時は従来通り無条件保存 (他マスタとの後方互換)。 */
  private async handleWageMasterRoute(
    record: TheearthSessionRecord,
    request: Request,
    name: "wage-master" | "min-wage" | "wage-config" | "salary-item-config",
    normalize: (raw: unknown) => unknown,
  ): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定のためマスタを保存できません");
    const paths = this.wageMasterR2Paths(record.compId, name);
    if (request.method === "GET") {
      const obj = await bucket.get(paths.latest);
      if (!obj) return Response.json({ exists: false, data: null, version: null });
      try {
        const data = normalize(JSON.parse(await obj.text()));
        return Response.json({
          exists: true,
          data,
          updated_at: obj.customMetadata?.fetchedAt ?? null,
          version: obj.customMetadata?.sha256 ?? null,
        });
      } catch (err) {
        console.error(`wage master ${name} read error:`, err);
        return dvrJsonError(502, `${name} の保存データが壊れています (${describeUnknownError(err)})`);
      }
    }
    if (request.method === "PUT") {
      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return dvrJsonError(400, "JSON body が必要です");
      }
      const baseVersion =
        raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { baseVersion?: unknown }).baseVersion : undefined;
      if (baseVersion !== undefined && typeof baseVersion !== "string") {
        return dvrJsonError(400, "baseVersion は文字列が必要です");
      }
      let normalized: unknown;
      try {
        normalized = normalize(raw);
      } catch (err) {
        if (err instanceof WageMasterError) return dvrJsonError(400, err.message);
        throw err;
      }
      if (typeof baseVersion === "string") {
        const currentHead = await bucket.head(paths.latest);
        const currentSha = currentHead?.customMetadata?.sha256 ?? null;
        if (currentSha !== null && currentSha !== baseVersion) {
          const currentObj = await bucket.get(paths.latest);
          let currentData: unknown = null;
          try {
            currentData = currentObj ? normalize(JSON.parse(await currentObj.text())) : null;
          } catch {
            currentData = null;
          }
          return Response.json(
            { error: "conflict", current: { data: currentData, version: currentSha } },
            { status: 409 },
          );
        }
      }
      const ts = restraintVersionTimestamp(new Date());
      const result = await this.putVersionedR2(
        bucket,
        paths.latest,
        paths.version(ts),
        JSON.stringify(normalized),
        "application/json",
        ts,
      );
      if (result.changed) await this.pruneRestraintVersions(bucket, paths.dir);
      return Response.json({ saved: true, changed: result.changed, data: normalized, version: result.sha256 });
    }
    return dvrJsonError(405, "Method Not Allowed");
  }

  /**
   * POST /restraint-api/min-wage/import-mhlw — 厚労省「地域別最低賃金の全国一覧」
   * を取り込んで min-wage マスタへマージする。
   *
   * body に `{ html }` があればそれを使い、無ければ厚労省サイトを fetch する。
   * 貼り付け経路を残しているのは、Workers からの外向き fetch が先方に弾かれた
   * 時の逃げ道 — パーサは同じものを通るので結果は変わらない。
   *
   * **47 件揃わなければ何も書かない** (parseMhlwNationalList が throw する)。
   * 部分結果でマスタを更新すると、欠けた県が「最低賃金なし」に化けて最低賃金
   * 割れを見逃す。
   */
  private async handleMinWageImport(
    record: TheearthSessionRecord,
    request: Request,
  ): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定のためマスタを保存できません");

    let pastedHtml: string | null = null;
    if ((request.headers.get("content-type") ?? "").includes("application/json")) {
      try {
        const body = (await request.json()) as { html?: unknown };
        if (typeof body?.html === "string" && body.html.trim() !== "") pastedHtml = body.html;
      } catch {
        return dvrJsonError(400, "JSON body が不正です");
      }
    }

    let html: string;
    let source: string;
    if (pastedHtml !== null) {
      html = pastedHtml;
      source = "paste";
    } else {
      source = MHLW_NATIONAL_LIST_URL;
      let res: Response;
      try {
        res = await fetch(MHLW_NATIONAL_LIST_URL, {
          headers: { "User-Agent": "nuxt-dtako-admin/min-wage-import (+https://dtako.ippoan.org)" },
        });
      } catch (err) {
        return dvrJsonError(
          502,
          `厚労省サイトへ接続できませんでした (${describeUnknownError(err)})。ページのソースを貼り付けて取り込むこともできます`,
        );
      }
      if (!res.ok) {
        return dvrJsonError(502, `厚労省サイトが ${res.status} を返しました (${source})`);
      }
      html = await res.text();
    }

    let rows;
    try {
      rows = parseMhlwNationalList(html);
    } catch (err) {
      if (err instanceof MinWageImportError) return dvrJsonError(400, err.message);
      throw err;
    }

    const paths = this.wageMasterR2Paths(record.compId, "min-wage");
    let current: MinWageMaster = { prefectures: {}, branchToPrefecture: {} };
    const obj = await bucket.get(paths.latest);
    if (obj) {
      try {
        current = normalizeMinWageMaster(JSON.parse(await obj.text()));
      } catch (err) {
        return dvrJsonError(502, `min-wage の保存データが壊れています (${describeUnknownError(err)})`);
      }
    }

    const merged = mergeMinWageRows(current, rows);
    const ts = restraintVersionTimestamp(new Date());
    const result = await this.putVersionedR2(
      bucket,
      paths.latest,
      paths.version(ts),
      JSON.stringify(merged.master),
      "application/json",
      ts,
    );
    if (result.changed) await this.pruneRestraintVersions(bucket, paths.dir);

    return Response.json({
      saved: true,
      changed: result.changed,
      source,
      prefectures: rows.length,
      added: merged.added,
      updated: merged.updated,
      unchanged: merged.unchanged,
      data: merged.master,
      version: result.sha256,
    });
  }

  /**
   * POST /restraint-api/min-wage/apply-to-wage-master — 拠点の最低賃金を単価マスタへ
   * 一括で入れる (「単価マスタ = 最低賃金」運用、Refs #282 / #409 Phase 4)。
   *
   * body: `{ asOf, sites?, overwrite?, dryRun? }`
   *
   * **単価の適用開始日は厚労省が定めた県ごとの発効日**をそのまま使う (2026-07-25 決定)。
   * `asOf` はどの版の最低賃金かと所属を引く月を決めるだけで、適用日には使わない。
   *
   * **`dryRun` を既定にはしない**が、画面は必ず dryRun でプレビューしてから確定させる。
   * 既に単価がある乗務員は `overwrite` を明示しない限り触らない — 会社が決めた支給単価を
   * 最低賃金で潰さないため。
   */
  private async handleApplyMinWageToWageMaster(
    record: TheearthSessionRecord,
    request: Request,
  ): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定のためマスタを保存できません");

    let body: { asOf?: unknown; sites?: unknown; overwrite?: unknown; dryRun?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    // 参照時点。この日で「どの版の最低賃金か」と「所属を引く月」が決まる。
    // 単価の適用開始日には使わない — 書き込むのは厚労省が定めた県ごとの発効日
    const asOf = body?.asOf;
    if (typeof asOf !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
      return dvrJsonError(400, "asOf は YYYY-MM-DD が必要です");
    }
    if (body.sites !== undefined && (!Array.isArray(body.sites) || body.sites.some((s) => typeof s !== "string"))) {
      return dvrJsonError(400, "sites は文字列の配列が必要です");
    }
    const sites = (body.sites as string[] | undefined) ?? null;
    const overwrite = body.overwrite === true;
    const dryRun = body.dryRun === true;

    const readMaster = async <T>(name: "wage-master" | "min-wage", normalize: (raw: unknown) => T, fallback: T): Promise<T | null> => {
      const obj = await bucket.get(this.wageMasterR2Paths(record.compId, name).latest);
      if (!obj) return fallback;
      try {
        return normalize(JSON.parse(await obj.text()));
      } catch {
        return null;
      }
    };
    const [wageMaster, minWageMaster] = await Promise.all([
      readMaster<WageMaster>("wage-master", normalizeWageMaster, { drivers: {} }),
      readMaster<MinWageMaster>("min-wage", normalizeMinWageMaster, { prefectures: {}, branchToPrefecture: {} }),
    ]);
    if (!wageMaster || !minWageMaster) {
      return dvrJsonError(502, "マスタの保存データが壊れています");
    }

    const ym = asOf.slice(0, 7);
    const { branches, names } = await this.branchByDriverCd(record.compId, ym);
    if (branches.size === 0) {
      return dvrJsonError(400, "社員マスタに乗務員CDつきの所属が見つかりません (社員マスタタブで取り込んでください)");
    }

    let result;
    try {
      result = applyMinWageToWageMaster(wageMaster, minWageMaster, branches, asOf, {
        overwrite,
        sites,
        namesByDriverCd: names,
      });
    } catch (err) {
      if (err instanceof WageMasterError) return dvrJsonError(400, err.message);
      throw err;
    }

    const summary = {
      asOf,
      dryRun,
      added: result.added,
      overwritten: result.overwritten,
      kept: result.kept,
      unresolved: result.unresolved,
      items: result.items,
    };
    if (dryRun) return Response.json({ ...summary, saved: false, changed: false });

    const paths = this.wageMasterR2Paths(record.compId, "wage-master");
    const ts = restraintVersionTimestamp(new Date());
    const saved = await this.putVersionedR2(
      bucket,
      paths.latest,
      paths.version(ts),
      JSON.stringify(result.master),
      "application/json",
      ts,
    );
    if (saved.changed) await this.pruneRestraintVersions(bucket, paths.dir);
    return Response.json({ ...summary, saved: true, changed: saved.changed, version: saved.sha256 });
  }

  /**
   * 乗務員CD → その月に適用する所属・給与区分 (社員マスタ、月末時点)。
   *
   * D1 が未 binding / 読めない場合は**空 Map を返して黙って続行する** — 最低賃金が
   * 引けなくなるだけで、拘束時間集計そのものは落とさない (この経路は #409 で
   * 後から足した補助情報であって、月次集計の必須依存ではない)。給与区分
   * (Refs #429) も同じ — 引けなければ給与比較が基本給(計算)を出さないだけ。
   */
  private async branchByDriverCd(
    compId: string,
    ym: string,
  ): Promise<{
    branches: Map<string, string>;
    names: Map<string, string>;
    payKubun: Map<string, number>;
  }> {
    const db = this.env.DTAKO_DB;
    if (!db) return { branches: new Map(), names: new Map(), payKubun: new Map() };
    try {
      const [employeeResult, attrResult] = await Promise.all([
        db
          .prepare(`SELECT company, payroll_cd, name, driver_cd, hire_date, retire_date FROM employees WHERE comp_id = ?`)
          .bind(compId)
          .all<EmployeeD1Row>(),
        db
          .prepare(
            `SELECT company, payroll_cd, effective_from, branch, pay_scheme, branch_code, branch_name, job_name, pay_kubun FROM employee_attrs WHERE comp_id = ?`,
          )
          .bind(compId)
          .all<EmployeeAttrD1Row>(),
      ]);
      const { employees } = buildEmployeeMasterResponse(
        employeeResult.results ?? [],
        attrResult.results ?? [],
      );
      const branches = branchByDriverCdAt(employees, ym, resolveAttrsAt);
      const names = new Map<string, string>();
      for (const e of employees) {
        if (e.driverCd && e.name && branches.has(e.driverCd)) names.set(e.driverCd, e.name);
      }
      return { branches, names, payKubun: payKubunByDriverCdAt(employees, ym, resolveAttrsAt) };
    } catch (err) {
      console.error(JSON.stringify({ branch_by_driver_cd: "error", error: describeUnknownError(err) }));
      return { branches: new Map(), names: new Map(), payKubun: new Map() };
    }
  }

  /**
   * GET /restraint-api/min-wage/branches — 社員マスタの所属を拠点ごとにまとめ、
   * 現在の都道府県マッピングと突き合わせて返す (Refs #409 Phase 2)。
   *
   * 拠点は**営業所名 (`SHOZOKU.NAME1`) がそのままキー**になり、並びは所属コード
   * (`INCODE`) 順 = 給与大臣の所属順。営業所名をまだ持たない行だけ表示名からの
   * 推定へ回る (buildBranchGroups)。画面はこれを描くだけでよく、まとめ方の知識を
   * フロントに持たせない。**都道府県は推定しない** — `prefecture` が null の
   * グループは未設定のまま返し、人が選ぶ。
   */
  private async handleMinWageBranches(record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "社員マスタ (DTAKO_DB) が未設定です");
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定のためマスタを読めません");

    let master: MinWageMaster = { prefectures: {}, branchToPrefecture: {} };
    const obj = await bucket.get(this.wageMasterR2Paths(record.compId, "min-wage").latest);
    if (obj) {
      try {
        master = normalizeMinWageMaster(JSON.parse(await obj.text()));
      } catch (err) {
        return dvrJsonError(502, `min-wage の保存データが壊れています (${describeUnknownError(err)})`);
      }
    }

    let attrRows: EmployeeAttrD1Row[];
    try {
      const result = await db
        .prepare(
          `SELECT company, payroll_cd, effective_from, branch, pay_scheme, branch_code, branch_name, job_name FROM employee_attrs WHERE comp_id = ?`,
        )
        .bind(record.compId)
        .all<EmployeeAttrD1Row>();
      attrRows = result.results ?? [];
    } catch (err) {
      console.error(JSON.stringify({ min_wage_branches: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "社員マスタの取得に失敗しました");
    }

    // 所属ごとの人数 (同じ社員が履歴を複数持つので社員単位で数える)。
    // キーは buildBranchGroups が `branches` に入れるラベルと同じ規則で取る。
    const employeesByBranch = new Map<string, Set<string>>();
    for (const row of attrRows) {
      const label = row.branch || row.branch_name;
      if (!label) continue;
      const set = employeesByBranch.get(label) ?? new Set<string>();
      set.add(`${row.company}|${row.payroll_cd}`);
      employeesByBranch.set(label, set);
    }

    const rows = attrRows.map((r) => ({
      branch: r.branch,
      branchName: r.branch_name,
      branchCode: r.branch_code,
    }));
    const groups = buildBranchGroups(rows).map((group) => {
      const employees = new Set<string>();
      for (const branch of group.branches) {
        for (const id of employeesByBranch.get(branch) ?? []) employees.add(id);
      }
      const lookup = resolveBranchPrefecture(master.branchToPrefecture, group.prefix);
      return {
        prefix: group.prefix,
        /** 給与大臣の所属コード (`SHOZOKU.INCODE`)。並び順の根拠として画面に出す。 */
        branchCode: group.branchCode,
        branches: group.branches,
        employees: employees.size,
        prefecture: lookup.prefecture,
        matchedKey: lookup.matchedKey,
      };
    });

    return Response.json({
      groups,
      unmapped: groups.filter((g) => g.prefecture === null).length,
      prefectures: PREFECTURES,
      minWagePrefectures: Object.keys(master.prefectures).length,
    });
  }

  /** POST /restraint-api/wage-master/csv — 単価 CSV (1 行 = 1 履歴) を現在の
   * マスタへ upsert して保存する (Excel 編集 → 再取込の一括変更経路)。body は
   * text/plain の CSV そのもの。 */
  private async handleWageMasterCsvImport(record: TheearthSessionRecord, request: Request): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定のためマスタを保存できません");
    const csvText = await request.text();
    const paths = this.wageMasterR2Paths(record.compId, "wage-master");
    let base: WageMaster = { drivers: {} };
    const existing = await bucket.get(paths.latest);
    if (existing) {
      try {
        base = normalizeWageMaster(JSON.parse(await existing.text()));
      } catch (err) {
        console.error("wage-master csv import: base read error:", err);
        return dvrJsonError(502, `既存の単価マスタが壊れています (${describeUnknownError(err)})`);
      }
    }
    let merged: WageMaster;
    try {
      merged = upsertWageMasterFromCsv(base, csvText);
    } catch (err) {
      if (err instanceof WageMasterError) return dvrJsonError(400, err.message);
      throw err;
    }
    const ts = restraintVersionTimestamp(new Date());
    const result = await this.putVersionedR2(
      bucket,
      paths.latest,
      paths.version(ts),
      JSON.stringify(merged),
      "application/json",
      ts,
    );
    if (result.changed) await this.pruneRestraintVersions(bucket, paths.dir);
    return Response.json({ saved: true, changed: result.changed, data: merged });
  }

  // ---------------------------------------------------------------------------
  // 社員マスタ (D1、Refs #367)。給与コード×会社を主キーに乗務員CD・所属/給与体系
  // の履歴を持つ。金額・明細は持たない。company は theearth compId ではなく給与
  // 会社ラベル (「株」「有」等、取り込みUIと同じ自由文字列) — 1 theearth テナント
  // 内で複数の給与会社が混在する運用実績がある (Refs #364-366) ため、GET は
  // compId で絞らず全件返す (kyuyo_companies と同じくテナント非スコープ)。
  // ---------------------------------------------------------------------------

  /** GET /restraint-api/employee-master — 社員マスタ全件。
   * D1 (DTAKO_DB) 未 binding は 503。
   *
   * **comp スコープ必須** (migration 0007、Refs #367): dtako テナントは複数あり
   * (27324455 = 給与DB 0100/0200/0300、75700192 = 0400)、社員の識別情報を
   * テナント跨ぎで見せてはいけない。comp はセッション record から取る。 */
  private async handleEmployeeMasterGet(record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "社員マスタ (DTAKO_DB) が未設定です");
    try {
      const [employeeResult, attrResult] = await Promise.all([
        db
          .prepare(`SELECT company, payroll_cd, name, driver_cd, hire_date, retire_date FROM employees WHERE comp_id = ?`)
          .bind(record.compId)
          .all<EmployeeD1Row>(),
        db
          .prepare(
            `SELECT company, payroll_cd, effective_from, branch, pay_scheme, branch_code, branch_name, job_name, pay_kubun FROM employee_attrs WHERE comp_id = ?`,
          )
          .bind(record.compId)
          .all<EmployeeAttrD1Row>(),
      ]);
      return Response.json(buildEmployeeMasterResponse(employeeResult.results ?? [], attrResult.results ?? []));
    } catch (err) {
      console.error(JSON.stringify({ employee_master_get: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "社員マスタの取得に失敗しました");
    }
  }

  /** GET /restraint-api/comp-map — dtako 会社ID ↔ 給与大臣の会社コード対応
   * (migration 0008)。**同じ tenant の会社だけ**返す — 会社名・会社IDを別テナントに
   * 見せない (Refs #367)。DTAKO_ACCOUNTS 未設定・自 comp が未登録なら空配列
   * (fail-closed)。 */
  private async handleCompMap(record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "会社対応表 (DTAKO_DB) が未設定です");
    let allowed = new Set<string>([record.compId]);
    try {
      const accounts = parseDtakoAccounts((await this.dtakoAccountsRaw()) || undefined);
      const sameTenant = compIdsInSameTenant(accounts, record.compId, record.viewerRole);
      if (sameTenant.size > 0) allowed = sameTenant;
    } catch {
      // DTAKO_ACCOUNTS 不正時は自 comp のみ (fail-closed)
    }
    try {
      const result = await db
        .prepare(
          `SELECT comp_id, comp_label, payroll_company, legacy_label, payroll_company_name, sort_order FROM comp_payroll_map`,
        )
        .all<CompPayrollMapD1Row>();
      return Response.json({ comps: buildCompMapResponse(result.results ?? [], allowed) });
    } catch (err) {
      console.error(JSON.stringify({ comp_map_get: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "会社対応表の取得に失敗しました");
    }
  }

  /** PUT /restraint-api/employee-master — 差分 upsert/削除。last-write-wins
   * (楽観排他なし — R2 版マスタと異なり D1 行単位 upsert のため不要、Refs #367)。
   * 書き込み先の comp はセッション record から取る (body の値は見ない)。 */
  private async handleEmployeeMasterPut(request: Request, record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "社員マスタ (DTAKO_DB) が未設定です");
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    let body: ReturnType<typeof normalizeEmployeeMasterPutBody>;
    try {
      body = normalizeEmployeeMasterPutBody(raw);
    } catch (err) {
      if (err instanceof EmployeeMasterError) return dvrJsonError(400, err.message);
      throw err;
    }
    const statements = buildEmployeeMasterWriteStatements(body, new Date().toISOString(), record.compId);
    if (statements.length === 0) return Response.json({ saved: true, changed: 0 });
    try {
      await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
    } catch (err) {
      console.error(JSON.stringify({ employee_master_put: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "社員マスタの保存に失敗しました");
    }
    return Response.json({ saved: true, changed: statements.length });
  }

  /** GET /restraint-api/work-schedule — 所定労働時間マスタ全件 (Refs #424 PR-C)。
   *
   * タイムカード由来の勤務で「実働が所定を超えた分 = 時間外」を出すための入力。
   * デジタコ (theearth) 由来の乗務員は CSV が時間外をそのまま持つので無関係。
   * 社員マスタと同じく **comp スコープ必須** (テナント跨ぎで見せない、Refs #367)。 */
  private async handleWorkScheduleGet(record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "所定マスタ (DTAKO_DB) が未設定です");
    try {
      const result = await db
        .prepare(
          `SELECT effective_from, branch_code, job_name, daily_work_minutes FROM work_schedules WHERE comp_id = ?`,
        )
        .bind(record.compId)
        .all<WorkScheduleD1Row>();
      return Response.json({ schedules: buildWorkScheduleResponse(result.results ?? []) });
    } catch (err) {
      console.error(JSON.stringify({ work_schedule_get: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "所定マスタの取得に失敗しました");
    }
  }

  /** PUT /restraint-api/work-schedule — 差分 upsert/削除 (last-write-wins)。
   * 書き込み先の comp はセッション record から取る (body の値は見ない)。 */
  private async handleWorkSchedulePut(request: Request, record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "所定マスタ (DTAKO_DB) が未設定です");
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    let body: ReturnType<typeof normalizeWorkSchedulePutBody>;
    try {
      body = normalizeWorkSchedulePutBody(raw);
    } catch (err) {
      if (err instanceof WorkScheduleError) return dvrJsonError(400, err.message);
      throw err;
    }
    const statements = buildWorkScheduleWriteStatements(body, new Date().toISOString(), record.compId);
    if (statements.length === 0) return Response.json({ saved: true, changed: 0 });
    try {
      await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
    } catch (err) {
      console.error(JSON.stringify({ work_schedule_put: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "所定マスタの保存に失敗しました");
    }
    return Response.json({ saved: true, changed: statements.length });
  }

  /** GET /restraint-api/holiday-work[?month=YYYY-MM] — 承認済み休日出勤の一覧。
   *
   * ここに載っている日だけが「休日出勤」として割増賃金の対象になる。載っていない
   * 休日の打刻は「自主出勤」として賃金計算から外す (時間は記録・表示する)。
   * `month` は任意 — 指定時はその月だけに絞る (画面は月単位で引く)。 */
  private async handleHolidayWorkGet(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "休日出勤の承認簿 (DTAKO_DB) が未設定です");
    const month = url.searchParams.get("month");
    if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      return dvrJsonError(400, "month は YYYY-MM で指定してください");
    }
    const sql = `SELECT driver_cd, work_date, reason FROM holiday_work_approvals WHERE comp_id = ?`;
    try {
      const stmt =
        month === null
          ? db.prepare(sql).bind(record.compId)
          : db.prepare(`${sql} AND work_date LIKE ?`).bind(record.compId, `${month}-%`);
      const result = await stmt.all<HolidayWorkD1Row>();
      return Response.json({ approvals: buildHolidayWorkResponse(result.results ?? []) });
    } catch (err) {
      console.error(JSON.stringify({ holiday_work_get: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "休日出勤の承認簿の取得に失敗しました");
    }
  }

  /** PUT /restraint-api/holiday-work — 差分 upsert/削除 (last-write-wins)。 */
  private async handleHolidayWorkPut(request: Request, record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "休日出勤の承認簿 (DTAKO_DB) が未設定です");
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    let body: ReturnType<typeof normalizeHolidayWorkPutBody>;
    try {
      body = normalizeHolidayWorkPutBody(raw);
    } catch (err) {
      if (err instanceof WorkScheduleError) return dvrJsonError(400, err.message);
      throw err;
    }
    const statements = buildHolidayWorkWriteStatements(body, new Date().toISOString(), record.compId);
    if (statements.length === 0) return Response.json({ saved: true, changed: 0 });
    try {
      await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
    } catch (err) {
      console.error(JSON.stringify({ holiday_work_put: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "休日出勤の承認簿の保存に失敗しました");
    }
    return Response.json({ saved: true, changed: statements.length });
  }

  /** GET /restraint-api/night-shift — 夜勤者マスタ全件 (Refs #433 PR-A)。
   *
   * 日跨ぎ打刻を「打刻エラー」とみなす判定からの除外リスト。**履歴を全件返す** —
   * 月で絞らないのは、過去月を再取り込みした時に当時の姿を再現する必要があるため
   * (絞り込みは `buildNightShiftIndex` が対象月の末日時点で行う)。 */
  private async handleNightShiftGet(record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "夜勤者マスタ (DTAKO_DB) が未設定です");
    try {
      const result = await db
        .prepare(`SELECT driver_cd, effective_from, is_night FROM night_shift_workers WHERE comp_id = ?`)
        .bind(record.compId)
        .all<NightShiftD1Row>();
      return Response.json({ workers: buildNightShiftResponse(result.results ?? []) });
    } catch (err) {
      console.error(JSON.stringify({ night_shift_get: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "夜勤者マスタの取得に失敗しました");
    }
  }

  /** PUT /restraint-api/night-shift — 差分 upsert/削除 (last-write-wins)。 */
  private async handleNightShiftPut(request: Request, record: TheearthSessionRecord): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) return dvrJsonError(503, "夜勤者マスタ (DTAKO_DB) が未設定です");
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    let body: ReturnType<typeof normalizeNightShiftPutBody>;
    try {
      body = normalizeNightShiftPutBody(raw);
    } catch (err) {
      if (err instanceof WorkScheduleError) return dvrJsonError(400, err.message);
      throw err;
    }
    const statements = buildNightShiftWriteStatements(body, new Date().toISOString(), record.compId);
    if (statements.length === 0) return Response.json({ saved: true, changed: 0 });
    try {
      await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
    } catch (err) {
      console.error(JSON.stringify({ night_shift_put: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "夜勤者マスタの保存に失敗しました");
    }
    return Response.json({ saved: true, changed: statements.length });
  }

  /**
   * POST /restraint-api/kintai/fetch?month=YYYY-MM — 勤怠 (タイムカード) の取り込み
   * (Refs #424 PR-A)。
   *
   * 経路: CakePHP (LAN, loopback) ← rust-ichibanboshi (同一ホスト) ← ここ (CF Access
   * Service Token)。**上流応答は解釈せず生のまま**バージョン管理付きで R2 に保存し、
   * 併せて社員別サマリ (`summarizeTimecardMonth`) も保存する。wage-report はこの
   * サマリを読む (PR-D)。
   *
   * 冪等: 同じ内容なら latest の lastVerifiedAt だけ進み版は増えない
   * (`putVersionedR2` の sha256 比較。theearth の CSV 取得と同じ作法)。
   */
  private async handleKintaiFetch(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { year, month, ym } = parsed;

    const apiUrl = (this.env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
    const clientId = this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
    // Secrets Store binding は「宣言はあるが解決できない」時に get() が throw する
    // (ローカル dev や entry の消失・改名)。素通しすると生のスタック付き 500 になり
    // 原因が読めないので、未設定と同じ 503 に倒す (2026-07-26 に dev で実際に踏んだ)
    let clientSecret = "";
    try {
      clientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch (err) {
      console.error(JSON.stringify({ kintai_fetch: "secret-error", error: describeUnknownError(err) }));
    }
    if (!apiUrl || !clientId || !clientSecret) {
      return dvrJsonError(503, "勤怠の取得先 (NUXT_ICHIBAN_*) が未設定です");
    }

    // 1) 上流から生 JSON を取る
    let rawText: string;
    let rows: TimecardDailyRow[];
    try {
      // refresh=1 で ichiban の derived store を飛ばして CakePHP から引き直す
      // (rust-ichibanboshi#106 Phase 2)。取り込みは「今の打刻」を取るのが目的なので
      // キャッシュ命中で古い当月を掴まない
      const upstream = await fetch(
        `${apiUrl}/api/kintai/daily?month=${encodeURIComponent(ym)}&refresh=1`,
        {
          headers: {
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          },
        },
      );
      rawText = await upstream.text();
      if (!upstream.ok) {
        console.error(JSON.stringify({ kintai_fetch: "upstream-error", status: upstream.status }));
        return dvrJsonError(502, `勤怠 API が ${upstream.status} を返しました: ${rawText.slice(0, 200)}`);
      }
      const body = JSON.parse(rawText) as { rows?: unknown };
      if (!Array.isArray(body.rows)) {
        return dvrJsonError(502, "勤怠 API の応答に rows 配列がありません");
      }
      rows = body.rows as TimecardDailyRow[];
      // ichiban が足すキャッシュメタ (source / synced_at) は取得ごとに値が変わる。
      // R2 原本に残すと内容不変でも sha256 が毎回変わり raw の版が際限なく増える
      // ため、正規化して除いてから版管理に載せる (キー順は JSON.parse の挿入順 =
      // 上流の出現順が保存されるので、データ不変なら byte 不変)
      delete (body as Record<string, unknown>).source;
      delete (body as Record<string, unknown>).synced_at;
      rawText = JSON.stringify(body);
    } catch (err) {
      console.error(JSON.stringify({ kintai_fetch: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "勤怠 API の取得に失敗しました");
    }

    // 1.5) 打刻基準の日別サマリ (kosoku-daily) — **時間の出どころはこちらに統一する**
    // (2026-07-28 決定)。打刻から組んだ勤務は、長距離のように出発時と帰着時にしか
    // 打刻しない人で数日が 1 勤務になり、所定を超えた分が全部 時間外になる
    // (実測: 乗務員 1104 / 2026-04 で 8 日間 1 勤務・月の残業 321h04m)。
    //
    // **前月も取る** — 前月に始業して当月へ跨いだ勤務は、上流が始業日 (= 前月) の
    // 応答にしか入れないため。`kosokuPartsByDate` が当月に落ちる分だけ拾う。
    // 取れなければ null のまま = 従来どおり打刻から組む (取り込みを止めない)。
    const kosokuShifts = await this.loadKosokuShifts(apiUrl, clientId, clientSecret, [ym, prevYmOf(ym)]);

    // 2) 所定労働時間・休日出勤の承認・社員のスコープ・夜勤者を D1 から引く
    const { schedules, approved, scopes, nightShift } = await this.loadKintaiInputs(record.compId, ym);
    const scopeOf = (driverCd: string) => scopes.get(driverCd) ?? { branchCode: null, jobName: null };
    const { summaries, warnings } = summarizeTimecardMonth(rows, {
      yearMonth: ym,
      dailyWorkMinutesFor: (driverCd) => {
        const scope = scopeOf(driverCd);
        return (
          resolveWorkScheduleAt(schedules, ym, scope.branchCode, scope.jobName)?.dailyWorkMinutes ?? null
        );
      },
      approvedHolidayWork: approved,
      // 職種は社員マスタの `employee_attrs.job_name` (対象月末時点)。未取り込みの社員は
      // null → 非事務職として扱われ、自主出勤の隔離も打刻エラーの判定も掛からない
      isClerical: (driverCd) => isClericalJob(scopeOf(driverCd).jobName),
      isNightShift: (driverCd) => nightShift.has(driverCd),
      // 当日 (JST) の未終業打刻を「退社打刻なし」にしないための基準 (nginx#780)
      today: formatJstDate(new Date()),
      // 上流が取れた時だけ渡す。**渡した月は全員ぶん kosoku 由来**になるので、
      // 同じ月の中で人によって出どころが変わることは無い (2026-07-28 決定)
      ...(kosokuShifts
        ? {
            kosokuPartsFor: (driverCd: string) => {
              const shifts = kosokuShifts.get(driverCd);
              return shifts ? kosokuPartsByDate(shifts, ym) : null;
            },
          }
        : {}),
    });
    if (!kosokuShifts) {
      warnings.push(
        "打刻基準の日別サマリ (kosoku-daily) が取れなかったため、時間は打刻から組んでいます"
        + " — 長距離のように運行単位でしか打刻しない乗務員は残業が過大に出ます。取り込み直してください",
      );
    }

    // 3) R2 へバージョン管理付きで保存
    const prefix = this.env.KINTAI_R2_PREFIX || "kintai";
    const paths = kintaiR2Paths(prefix, record.compId, year, month);
    const ts = restraintVersionTimestamp(new Date());
    let summariesWrote = 0;
    try {
      const rawResult = await this.putVersionedR2(
        bucket,
        paths.rawLatest,
        paths.rawVersion(ts),
        rawText,
        "application/json; charset=utf-8",
        ts,
      );
      if (rawResult.changed) await this.pruneRestraintVersions(bucket, paths.rawDir);
      await this.appendRestraintHistory(
        bucket,
        paths.rawHistory,
        restraintHistoryLine(
          ts,
          rawResult.changed ? "new-version" : "unchanged",
          rawResult.sha256,
          new TextEncoder().encode(rawText).byteLength,
        ),
      );
      const d1Entries: RestraintD1Entry[] = [];
      for (const summary of summaries) {
        const wrote = await this.putVersionedR2(
          bucket,
          paths.summaryLatest(summary.driverCd),
          paths.summaryVersion(summary.driverCd, ts),
          stableTimecardSummaryBody(record.compId, year, month, summary),
          "application/json; charset=utf-8",
          ts,
        );
        if (wrote.changed) {
          summariesWrote += 1;
          await this.pruneRestraintVersions(bucket, paths.summaryDir(summary.driverCd));
        }
        d1Entries.push({
          kind: "summary",
          summary,
          meta: { sha256: wrote.sha256, fetchedAt: wrote.fetchedAt, lastVerifiedAt: ts },
        });
      }
      await this.upsertRestraintSummariesD1(record.compId, "timecard", ym, d1Entries);
      await this.pushRestraintSummariesToIchiban(record.compId, "timecard", ym, d1Entries);
    } catch (err) {
      console.error(JSON.stringify({ kintai_fetch: "r2-error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "勤怠データの保存に失敗しました");
    }

    return Response.json({
      month: ym,
      rows: rows.length,
      drivers: summaries.length,
      summaries_updated: summariesWrote,
      fetched_at: ts,
      warnings,
    });
  }

  /** 勤怠サマリ計算の入力 (所定マスタ・休日出勤の承認・社員のスコープ・夜勤者) を
   * D1 から読む。
   *
   * D1 未 binding / 読めない時は空で返す — 所定が引けない社員は時間外が出ないだけで、
   * 取り込み自体は成功させる (fail-soft)。**夜勤者が空になる側に倒れる**のは
   * 「事務職の日跨ぎが全部エラーに見える」= 目に付く壊れ方なので、黙って賃金が
   * 変わるより気付きやすい。 */
  private async loadKintaiInputs(compId: string, ym: string) {
    const empty = {
      schedules: [] as ReturnType<typeof buildWorkScheduleResponse>,
      approved: new Set<string>(),
      scopes: new Map<string, { branchCode: number | null; jobName: string | null }>(),
      nightShift: new Set<string>(),
    };
    const db = this.env.DTAKO_DB;
    if (!db) return empty;
    try {
      const [scheduleResult, holidayResult, employeeResult, attrResult, nightResult] = await Promise.all([
        db
          .prepare(
            `SELECT effective_from, branch_code, job_name, daily_work_minutes FROM work_schedules WHERE comp_id = ?`,
          )
          .bind(compId)
          .all<WorkScheduleD1Row>(),
        db
          .prepare(
            `SELECT driver_cd, work_date, reason FROM holiday_work_approvals WHERE comp_id = ? AND work_date LIKE ?`,
          )
          .bind(compId, `${ym}-%`)
          .all<HolidayWorkD1Row>(),
        db
          .prepare(`SELECT company, payroll_cd, name, driver_cd, hire_date, retire_date FROM employees WHERE comp_id = ?`)
          .bind(compId)
          .all<EmployeeD1Row>(),
        db
          .prepare(
            `SELECT company, payroll_cd, effective_from, branch, pay_scheme, branch_code, branch_name, job_name, pay_kubun FROM employee_attrs WHERE comp_id = ?`,
          )
          .bind(compId)
          .all<EmployeeAttrD1Row>(),
        // 夜勤者は履歴全件を読む — 対象月の末日時点での解決は buildNightShiftIndex が行う
        db
          .prepare(`SELECT driver_cd, effective_from, is_night FROM night_shift_workers WHERE comp_id = ?`)
          .bind(compId)
          .all<NightShiftD1Row>(),
      ]);
      const { employees } = buildEmployeeMasterResponse(
        employeeResult.results ?? [],
        attrResult.results ?? [],
      );
      return {
        schedules: buildWorkScheduleResponse(scheduleResult.results ?? []),
        approved: buildHolidayWorkIndex(buildHolidayWorkResponse(holidayResult.results ?? [])),
        scopes: scopeByDriverCdAt(employees, ym, resolveAttrsAt),
        nightShift: buildNightShiftIndex(buildNightShiftResponse(nightResult.results ?? []), ym),
      };
    } catch (err) {
      console.error(JSON.stringify({ kintai_inputs: "error", error: describeUnknownError(err) }));
      return empty;
    }
  }

  /** GET /restraint-api/kintai/archive?month=YYYY-MM — 生 JSON の版一覧と確認履歴
   * (theearth 側の archive/csv-list + archive/history と同じ役割)。 */
  private async handleKintaiArchive(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const prefix = this.env.KINTAI_R2_PREFIX || "kintai";
    const paths = kintaiR2Paths(prefix, record.compId, parsed.year, parsed.month);
    try {
      const [objects, historyObj] = await Promise.all([
        this.listAllR2(bucket, `${paths.rawDir}/`),
        bucket.get(paths.rawHistory),
      ]);
      const history = historyObj ? (await historyObj.text()).split("\n").filter(Boolean) : [];
      const latest = objects.find((o) => o.key === paths.rawLatest);
      return Response.json({
        month: parsed.ym,
        latest: latest
          ? {
              key: latest.key,
              size: latest.size,
              fetched_at: latest.customMetadata?.fetchedAt ?? null,
              last_verified_at: latest.customMetadata?.lastVerifiedAt ?? null,
              sha256: latest.customMetadata?.sha256 ?? null,
            }
          : null,
        versions: objects
          .filter((o) => o.key.includes("/v-"))
          .map((o) => ({ key: o.key, size: o.size }))
          .sort((a, b) => (a.key < b.key ? 1 : -1)),
        history: history.map((line) => {
          try {
            return JSON.parse(line) as unknown;
          } catch {
            return { raw: line };
          }
        }),
      });
    } catch (err) {
      console.error(JSON.stringify({ kintai_archive: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "勤怠アーカイブの取得に失敗しました");
    }
  }

  /**
   * GET /restraint-api/kintai/kosoku-daily?month=YYYY-MM — **打刻基準の日別サマリ**を
   * 全乗務員ぶん中継する (Refs #472 PR-A、上流は ohishi-exp/rust-ichibanboshi#125)。
   *
   * タイムカード表にドライバーを出すための経路。ドライバーは打刻を持たない代わりに
   * 運行イベントを持ち、上流が打刻と休息から日別に畳んだものを返す。
   *
   * - **中継だけ。解釈しないし R2 にも置かない** — 上流の生イベントからいつでも
   *   作り直せる派生値で、原本は社内 MariaDB 側にある。版を持つ意味が無い。
   *   ただし生応答は 60 秒だけ DO 内 memo する (wage-report と共有、Refs #508) —
   *   タブを開くと両経路が同じ月をほぼ同時に取りに来るため
   * - **`driver` は渡さない** (= 上流は全乗務員を返す)。画面が要るのは全員ぶんで、
   *   1 名ずつだと 96 名で約 3 秒かかる (一括は実測 0.25 秒)
   * - 応答は上流の JSON をそのまま返す (`{month, drivers: [{driver, days}]}`)。
   *   `days` の各項目は #118 の日別サマリ (拘束・休憩・実働・時間区分・深夜)。
   *   `view=timecard` (rust-ichibanboshi#164) で 0 値・未使用項目が省かれた slim 形 —
   *   受け手 (front の `toKosokuDay`) は欠けを 0/false に落とす
   * - **会社で絞らない。** 乗務員CD は一番星 `社員ﾏｽﾀ.社員C` と同一番号体系で会社を
   *   跨がず、`/kintai/fetch` の取り込みも同じ単位。受け手が社員マスタで引き当てる
   */
  private async handleKintaiKosokuDaily(url: URL): Promise<Response> {
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { ym } = parsed;
    // フェーズ計測 (Refs #543 PR-1)。挙動は変えない — ログ 1 行と Server-Timing だけ
    const timer = new PhaseTimer();

    const apiUrl = (this.env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
    const clientId = this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
    // Secrets Store binding は「宣言はあるが解決できない」時に get() が throw する。
    // 素通しすると生のスタック付き 500 になるので未設定と同じ 503 に倒す
    // (`/kintai/fetch` と同じ扱い)
    let clientSecret = "";
    try {
      clientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch (err) {
      console.error(JSON.stringify({ kosoku_daily: "secret-error", error: describeUnknownError(err) }));
    }
    if (!apiUrl || !clientId || !clientSecret) {
      return dvrJsonError(503, "勤怠の取得先 (NUXT_ICHIBAN_*) が未設定です");
    }

    // 生応答 memo を wage-report と共有する (Refs #508)。上流エラーの詳細は
    // fetchKosokuRaw が log 済みなので、ここは null = 502 に畳む
    const body = (await timer.measure("kosoku-cur", () =>
      this.fetchKosokuRaw(apiUrl, clientId, clientSecret, ym, timer, "kosoku-cur"),
    )) as { drivers?: unknown } | null;
    if (body == null) {
      return dvrJsonError(502, "拘束サマリ API の取得に失敗しました");
    }
    // 形だけ見る (中身は解釈しない)。上流が 1 名指定の形 (`days`) を返したら、
    // 呼び出し方を間違えている = 全乗務員が入っていないので黙って通さない
    if (!Array.isArray(body.drivers)) {
      return dvrJsonError(502, "拘束サマリ API の応答に drivers 配列がありません");
    }
    console.log(JSON.stringify({ kosoku_daily: "relayed", month: ym, drivers: body.drivers.length }));
    return this.withPhaseTiming("kintai/kosoku-daily", ym, timer, Response.json(body));
  }

  /** フェーズ計測の出力 (ログ 1 行 + Server-Timing ヘッダ)。**応答は絶対に壊さない**
   * — 計測側の不具合はここで握って応答をそのまま返す (Refs #543 PR-1)。 */
  private withPhaseTiming(route: string, month: string, timer: PhaseTimer, res: Response): Response {
    try {
      console.log(phaseTimingLogLine(route, month, timer, "live"));
      res.headers.set("Server-Timing", timer.serverTimingHeader());
    } catch (err) {
      console.error(JSON.stringify({ phase_timing: "emit-error", route, error: describeUnknownError(err) }));
    }
    return res;
  }

  /**
   * ichiban (rust-ichibanboshi) 呼び出しの資格情報を揃える。取れなければ null。
   *
   * Secrets Store binding は「宣言はあるが解決できない」時に `get()` が throw するので、
   * 素通しせず未設定と同じ扱いに倒す (`/kintai/fetch` と同じ)。
   */
  private async ichibanCreds(
    tag: string,
  ): Promise<{ apiUrl: string; clientId: string; clientSecret: string } | null> {
    const apiUrl = (this.env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
    const clientId = this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
    let clientSecret = "";
    try {
      clientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch (err) {
      console.error(JSON.stringify({ [tag]: "secret-error", error: describeUnknownError(err) }));
    }
    if (!apiUrl || !clientId || !clientSecret) return null;
    return { apiUrl, clientId, clientSecret };
  }

  /**
   * 社内 CakePHP のタイムカード表 **PDF 相当**を取る (Refs #492 PR-A、上流は
   * ohishi-exp/rust-ichibanboshi#143 → yhonda-ohishi/nginx#782)。
   *
   * `driver` を渡せば 1 名、省略すれば全乗務員。**キャッシュしない** — 突合は
   * 「いま nginx が何を出しているか」を見るのが目的で、こちらで溜めると nginx 側の
   * 修正が反映されたかどうかが分からなくなる。
   */
  private async fetchNginxPdfJson(ym: string, driver: string | null): Promise<unknown> {
    const creds = await this.ichibanCreds("pdf_json");
    if (!creds) throw new RelayConfigError("勤怠の取得先 (NUXT_ICHIBAN_*) が未設定です");
    const q = new URLSearchParams({ month: ym });
    if (driver) q.set("driver", driver);
    const upstream = await fetch(`${creds.apiUrl}/api/kintai/pdf-json?${q.toString()}`, {
      headers: {
        "CF-Access-Client-Id": creds.clientId,
        "CF-Access-Client-Secret": creds.clientSecret,
      },
    });
    const rawText = await upstream.text();
    if (!upstream.ok) {
      console.error(JSON.stringify({ pdf_json: "upstream-error", status: upstream.status }));
      throw new RelayUpstreamError(
        // 200 字だと CakePHP の HTML エラーページの <head> で埋まり、肝心の
        // 「Error: Call to undefined ...」が切れて読めない (#492 の実機確認で実際に踏んだ)
        `タイムカードPDF API が ${upstream.status} を返しました: ${rawText.slice(0, 600)}`,
      );
    }
    const body: unknown = JSON.parse(rawText);
    // nginx はエラーも HTTP 200 + `{error}` で返す (nginx#784)。素通しすると
    // `rows` が無いだけになり、画面に「差なし」と出てしまう
    const upstreamError = pdfJsonError(body);
    if (upstreamError) throw new RelayUpstreamError(`タイムカードPDF API: ${upstreamError}`);
    return body;
  }

  /** 乗務員CD クエリの検証。未指定は null、書式違いは `Error` (= 400)。 */
  private parseDriverParam(url: URL): string | null {
    const raw = url.searchParams.get("driver");
    if (raw === null) return null;
    if (!/^\d+$/.test(raw)) throw new RelayBadRequestError("driver は乗務員CD (数字) で指定してください");
    return String(Number(raw));
  }

  /**
   * GET /restraint-api/kintai/pdf-json?month=YYYY-MM[&driver=1021] — nginx の
   * タイムカード表 PDF 相当 JSON を**そのまま**中継する (Refs #492 PR-A)。
   *
   * 突合結果ではなく生の上流応答が要る場面 (nginx 側の修正確認・形の調査) 用。
   * 解釈は [`handleTimecardCompare`] 側で行う。
   */
  private async handleKintaiPdfJson(url: URL): Promise<Response> {
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    try {
      const driver = this.parseDriverParam(url);
      const body = await this.fetchNginxPdfJson(parsed.ym, driver);
      return Response.json(body);
    } catch (err) {
      return this.relayErrorResponse("pdf_json", err, "タイムカードPDF API の取得に失敗しました");
    }
  }

  /**
   * GET /restraint-api/timecard-compare?month=YYYY-MM[&driver=1021][&tolerance=1][&only_anomalies=1]
   * — nginx のタイムカード表とこちらの拘束時間を**暦日ごとに突き合わせる** (Refs #492 PR-A)。
   *
   * - `driver` 指定 = 1 vs 1 (画面の目視突合)。省略 = 全乗務員 (MCP の一括チェック)
   * - `only_anomalies=1` は全乗務員のときだけ効く。差分も異常も無い人を落とす
   * - 突合するのは**拘束だけ**。残業は定義が別物なので比較しない (ユーザー決定)
   *
   * こちら側の値は `kosoku-daily` を**当月 + 前月**取って暦日按分したもの — 前月から
   * 跨いだ勤務が当月 1 日に落ちるため、前月を取らないと月初が過少になる。
   */
  private async handleTimecardCompare(url: URL): Promise<Response> {
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { ym } = parsed;

    let driver: string | null;
    let tolerance: number | undefined;
    try {
      driver = this.parseDriverParam(url);
      tolerance = this.parseToleranceParam(url);
    } catch (err) {
      return this.relayErrorResponse("timecard_compare", err, "クエリの解釈に失敗しました");
    }
    const onlyAnomalies = url.searchParams.get("only_anomalies") === "1";

    const creds = await this.ichibanCreds("timecard_compare");
    if (!creds) return dvrJsonError(503, "勤怠の取得先 (NUXT_ICHIBAN_*) が未設定です");

    try {
      // こちら側 (kosoku-daily) は 1 名指定でも全乗務員ぶん取る — 上流が月単位で
      // 1 リクエスト (実測 0.25 秒) であり、絞る API を別に持つ意味が無い。
      // nginx 側は driver をそのまま渡す (1 名なら 1 名だけ返る)
      const [pdfBody, compareKosoku] = await Promise.all([
        this.fetchNginxPdfJson(ym, driver),
        this.loadCompareKosoku(creds.apiUrl, creds.clientId, creds.clientSecret, ym),
      ]);
      const { shifts, paperDriftByDriver, ferryMinusByDriver } = compareKosoku;
      const nginxByDriver = parsePdfJson(pdfBody, ym);
      const oursByDriver = new Map<string, Map<string, { restraintMinutes: number }>>();
      // 月境界を跨ぐ勤務由来の分 — 紙は月内の打刻だけで対を組むため月を跨ぐ勤務が
      // どちらの月にも載らない。その分を cause "month-boundary" として説明する
      const crossMonthByDriver = new Map<string, Map<string, number>>();
      for (const [driverCd, driverShifts] of shifts ?? []) {
        oursByDriver.set(driverCd, kosokuPartsByDate(driverShifts, ym));
        crossMonthByDriver.set(driverCd, crossMonthMinutesByDate(driverShifts, ym));
      }

      let results: CompareResult[];
      if (driver) {
        results = [
          compareTimecardMonth({
            month: ym,
            driverCd: driver,
            nginx: nginxByDriver.get(driver) ?? null,
            oursByDate: oursByDriver.get(driver) ?? new Map(),
            crossMonthByDate: crossMonthByDriver.get(driver),
            paperDriftByDate: paperDriftByDriver.get(driver),
            ferryMinusByDate: ferryMinusByDriver.get(driver),
            toleranceMinutes: tolerance,
          }),
        ];
      } else {
        results = compareTimecardMonthAll({
          month: ym,
          nginxByDriver,
          oursByDriver,
          crossMonthByDriver,
          paperDriftByDriver,
          ferryMinusByDriver,
          toleranceMinutes: tolerance,
          onlyAnomalies,
        });
      }

      console.log(
        JSON.stringify({
          timecard_compare: "built",
          month: ym,
          driver,
          results: results.length,
          // 上流が落ちても突合自体は返す (片側 null で nginx-only / ours-only に出る)
          ours: shifts ? "yes" : "no",
        }),
      );
      return Response.json({
        month: ym,
        driver,
        onlyAnomalies: driver ? false : onlyAnomalies,
        oursAvailable: shifts !== null,
        results,
      });
    } catch (err) {
      return this.relayErrorResponse("timecard_compare", err, "タイムカード突合に失敗しました");
    }
  }

  /** `tolerance` クエリ。未指定は undefined (= 既定 1 分)、負・非数は 400。 */
  private parseToleranceParam(url: URL): number | undefined {
    const raw = url.searchParams.get("tolerance");
    if (raw === null) return undefined;
    if (!/^\d+$/.test(raw)) throw new RelayBadRequestError("tolerance は 0 以上の分数で指定してください");
    return Number(raw);
  }

  /** 中継系のエラーを HTTP へ写す (400 / 502 / 503)。 */
  private relayErrorResponse(tag: string, err: unknown, fallback: string): Response {
    if (err instanceof RelayBadRequestError) return dvrJsonError(400, err.message);
    if (err instanceof RelayConfigError) return dvrJsonError(503, err.message);
    if (err instanceof RelayUpstreamError) return dvrJsonError(502, err.message);
    console.error(JSON.stringify({ [tag]: "error", error: describeUnknownError(err) }));
    return dvrJsonError(502, fallback);
  }

  /**
   * 上流応答の短期メモ (この DO インスタンス内、Refs #508)。
   *
   * wage-report はタブ切替・月切替のたびに呼ばれ、そのたびに `kintai/daily` と
   * `kosoku-daily` を取り直していた (1 回 1.7MB)。画面が「勤務を読み込んでいます…」
   * から進まなくなったので、**同じ月は 60 秒だけ使い回す**。取り込み直後の反映が
   * 最大 60 秒遅れるだけで、値そのものは上流が正。in-flight 共有も持つ — タブを
   * 開くと wage-report と `/kintai/kosoku-daily` 中継が同じ月をほぼ同時に取りに
   * 来るため、値キャッシュだけでは初回の重複が止まらない (rust-ichibanboshi#154
   * で実測: 同じ月を 2〜3 回)。
   */
  private kintaiUpstreamMemo = new UpstreamMemo(60_000, 8);

  /** `key` の結果を TTL 内なら使い回す。null/undefined はキャッシュしない (再試行させる)。 */
  private memoKintaiUpstream<T>(key: string, load: () => Promise<T>): Promise<T> {
    return this.kintaiUpstreamMemo.get(key, Date.now(), load);
  }

  /**
   * `kosoku-daily` の上流生応答 (JSON parse 済み) を月単位で memo する (Refs #508)。
   *
   * wage-report (`loadKosokuShifts`) と `/restraint-api/kintai/kosoku-daily` 中継が
   * **同じ月を別々に取っていた**のを、この 1 本に統一する。`view=timecard` は画面
   * 経路の減量 (ohishi-exp/rust-ichibanboshi#164) — 消費側 (front の
   * `toKosokuDay` / relay の `parseKosokuDaily`) はどちらも欠けた数値を 0、欠けた
   * bool を false に落とすので slim 応答をそのまま食える。未対応の上流は未知 view を
   * 無視して全項目を返すため、デプロイ順序に制約はない。
   *
   * 取れなければ null (memo されず次回再試行)。
   */
  private fetchKosokuRaw(
    apiUrl: string,
    clientId: string,
    clientSecret: string,
    ym: string,
    timer?: PhaseTimer,
    phase?: string,
  ): Promise<unknown> {
    return this.memoKintaiUpstream(`kosoku-raw:${ym}`, async () => {
      try {
        const upstream = await fetch(
          `${apiUrl}/api/kintai/kosoku-daily?month=${encodeURIComponent(ym)}&view=timecard`,
          { headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } },
        );
        if (!upstream.ok) {
          console.error(JSON.stringify({ kosoku_raw: "upstream-error", ym, status: upstream.status }));
          return null;
        }
        const text = await upstream.text();
        // 応答サイズを計測に載せる (memo ヒット時はこの loader ごと呼ばれない = bytes 無し)
        if (timer && phase) timer.setBytes(phase, text.length);
        return JSON.parse(text) as unknown;
      } catch (err) {
        console.error(JSON.stringify({ kosoku_raw: "error", ym, error: describeUnknownError(err) }));
        return null;
      }
    });
  }

  /**
   * タイムカード側のサマリを**その場で組む** (2026-07-28 決定「R2 やめろ」)。
   *
   * これまでは `kintai/fetch` が R2 へ書いたサマリを wage-report が読んでいたため、
   * **取り込みを回すまで古い値が出続けていた** (実測: 乗務員 1108 / 2026-04 が
   * 打刻由来の 3 勤務・拘束 447h29m のまま。上流の kosoku-daily では 24 勤務・
   * 拘束 172h04m)。サマリは生イベントからいつでも作り直せる派生値なので、
   * **原本を持たない R2 を経由するのをやめて毎回組む**。
   *
   * 素材:
   * - 休暇・休日区分・打刻エラー … `/api/kintai/daily` (CakePHP 中継、上流が SQLite で
   *   read-through しているので 2 回目以降はミリ秒)
   * - 時間 … `/api/kintai/kosoku-daily` (打刻 + 休息、MariaDB 直読み)
   *
   * 前月ぶんも組む — 週40h の月初跨ぎ週が前月の日別を要るため。**前々月から前月へ
   * 跨いだ勤務までは拾わない** (前月の 1 日の週40h がわずかに小さく出るだけで、
   * 当月の賃金には効かない)。
   *
   * 取得先が未設定・上流が落ちている時は null を返し、呼び出し側が従来どおり
   * R2 へ落ちる。
   */
  private async buildKintaiSummariesLive(
    compId: string,
    ym: string,
    prevYm: string,
    timer?: PhaseTimer,
  ): Promise<{
    current: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
    prev: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
  } | null> {
    const apiUrl = (this.env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
    const clientId = this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
    let clientSecret = "";
    try {
      clientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch {
      // secret 不調は他所で log 済み。ここは R2 へ落ちるだけで良い
    }
    if (!apiUrl || !clientId || !clientSecret) return null;

    const headers = { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret };
    const fetchDaily = async (month: string, phase: string): Promise<TimecardDailyRow[] | null> => {
      try {
        const res = await fetch(
          `${apiUrl}/api/kintai/daily?month=${encodeURIComponent(month)}`,
          { headers },
        );
        if (!res.ok) {
          console.error(JSON.stringify({ wage_report_kintai: "daily-error", month, status: res.status }));
          return null;
        }
        const text = await res.text();
        // 応答サイズを計測に載せる (memo ヒット時はこの loader ごと呼ばれない = bytes 無し)
        timer?.setBytes(phase, text.length);
        const body = JSON.parse(text) as { rows?: unknown };
        return Array.isArray(body.rows) ? (body.rows as TimecardDailyRow[]) : null;
      } catch (err) {
        console.error(
          JSON.stringify({ wage_report_kintai: "daily-throw", month, error: describeUnknownError(err) }),
        );
        return null;
      }
    };

    // **同じ月を 2 度取らない。** 当月ぶんは「前月 + 当月」の勤務が要るが、前月ぶんも
    // 同じ前月を使い回せる。最初の版は 3 回取っており (1 回 1.7MB)、画面が
    // 「勤務を読み込んでいます…」から進まなくなった (2026-07-28 本番で発覚)
    const [dailyCurrent, dailyPrev, shiftsCurrent, shiftsPrev] = await Promise.all([
      measurePhase(timer, "daily-cur", () =>
        this.memoKintaiUpstream(`daily:${ym}`, () => fetchDaily(ym, "daily-cur")),
      ),
      measurePhase(timer, "daily-prev", () =>
        this.memoKintaiUpstream(`daily:${prevYm}`, () => fetchDaily(prevYm, "daily-prev")),
      ),
      // kosoku の memo は fetchKosokuRaw の生応答層にある (Refs #508) — 画面の
      // `/kintai/kosoku-daily` 中継と同じ月を共有するため、ここでは重ねない
      measurePhase(timer, "kosoku-cur", () =>
        this.loadKosokuShifts(apiUrl, clientId, clientSecret, [ym], timer, "kosoku-cur"),
      ),
      measurePhase(timer, "kosoku-prev", () =>
        this.loadKosokuShifts(apiUrl, clientId, clientSecret, [prevYm], timer, "kosoku-prev"),
      ),
    ]);
    // 当月の勤務 = 前月から跨いだ分 + 当月分 (`kosokuPartsByDate` が当月に落ちる分だけ拾う)
    const kosokuCurrent = mergeKosokuShiftMaps(shiftsPrev, shiftsCurrent);
    const kosokuPrev = shiftsPrev;
    // 当月が取れないと賃金の素材が無い — 黙って空にせず R2 へ落とす
    if (!dailyCurrent) return null;

    const build = async (
      month: string,
      rows: TimecardDailyRow[] | null,
      shifts: Map<string, KosokuShift[]> | null,
    ) => {
      if (!rows) return { summaries: [], noDataDrivers: [] };
      const { schedules, approved, scopes, nightShift } = await this.loadKintaiInputs(compId, month);
      const scopeOf = (driverCd: string) => scopes.get(driverCd) ?? { branchCode: null, jobName: null };
      const { summaries } = summarizeTimecardMonth(rows, {
        yearMonth: month,
        dailyWorkMinutesFor: (driverCd) => {
          const scope = scopeOf(driverCd);
          return (
            resolveWorkScheduleAt(schedules, month, scope.branchCode, scope.jobName)?.dailyWorkMinutes ?? null
          );
        },
        approvedHolidayWork: approved,
        isClerical: (driverCd) => isClericalJob(scopeOf(driverCd).jobName),
        isNightShift: (driverCd) => nightShift.has(driverCd),
        today: formatJstDate(new Date()),
        ...(shifts
          ? {
              kosokuPartsFor: (driverCd: string) => {
                const s = shifts.get(driverCd);
                return s ? kosokuPartsByDate(s, month) : null;
              },
            }
          : {}),
      });
      return {
        summaries: summaries.map((data) => ({ data, fetchedAt: null, lastVerifiedAt: null })),
        noDataDrivers: [] as string[],
      };
    };

    const [current, prev] = await Promise.all([
      measurePhase(timer, "build-cur", () => build(ym, dailyCurrent, kosokuCurrent)),
      measurePhase(timer, "build-prev", () => build(prevYm, dailyPrev, kosokuPrev)),
    ]);
    console.log(
      JSON.stringify({
        wage_report_kintai: "live",
        comp_id: compId,
        ym,
        drivers: current.summaries.length,
        kosoku: kosokuCurrent ? "yes" : "no",
      }),
    );
    return { current, prev };
  }

  /**
   * `kosoku-daily` を当月 + 前月ぶん取って乗務員CD 引きにまとめる (2026-07-28)。
   *
   * **取れなければ null** — 取り込み自体は止めず、呼び出し側が従来どおり打刻から
   * 組んだ上で warning を出す。片方だけ取れた場合は取れた方だけを使う (前月が
   * 落ちても当月の勤務は正しく、月初に跨いだ勤務が欠けるだけで済む)。
   *
   * timer/phase はフェーズ計測用 (Refs #543 PR-1、任意) — 応答サイズを phase に載せる。
   */
  private async loadKosokuShifts(
    apiUrl: string,
    clientId: string,
    clientSecret: string,
    months: string[],
    timer?: PhaseTimer,
    phase?: string,
  ): Promise<Map<string, KosokuShift[]> | null> {
    const fetchMonth = async (ym: string): Promise<Map<string, KosokuShift[]> | null> => {
      // 賃金計算 (wage-report) の経路 — 画面の `/kintai/kosoku-daily` 中継と
      // 同じ生応答 memo を共有する (Refs #508)。view=timecard の slim 応答でも
      // parseKosokuDaily は欠けた数値を 0 に落とすので同じ形に畳める
      const body = await this.fetchKosokuRaw(apiUrl, clientId, clientSecret, ym, timer, phase);
      return body == null ? null : parseKosokuDaily(body);
    };
    const results = await Promise.all(months.map(fetchMonth));
    // 当月 (先頭) が取れていないと時間が丸ごと出ないので、その時は諦める
    if (!results[0]) return null;
    const merged = new Map<string, KosokuShift[]>();
    for (const result of results) {
      if (!result) continue;
      for (const [driverCd, shifts] of result) {
        merged.set(driverCd, [...(merged.get(driverCd) ?? []), ...shifts]);
      }
    }
    return merged;
  }

  /**
   * 突合用に `view=compare` で当月 + 前月を取る (Refs ohishi-exp/rust-ichibanboshi#157)。
   *
   * 既定の応答は 1 日 19 キー・全乗務員で **1.73 MB** あるが、突合が使うのは日付・拘束・
   * フェリー控除と暦日按分用の `parts` だけ。絞ると **256 KB (実測 6.8 分の 1)**。
   * この経路は社内から Cloudflare Tunnel を通るので、サイズがそのまま応答時間になる
   * (実測: DB 0.48 秒 / rust 0.46 秒 なのにブラウザで 14〜57 秒)。
   *
   * 前月も取るのは月初の暦日按分のため (前月から跨いだ勤務が当月 1 日に落ちる)。
   * **紙の再現値との差 (`paper_drift_by_date`) は当月の応答からだけ**読む — 紙も
   * この再現も月単位で閉じている (Refs ohishi-exp/rust-ichibanboshi#179)。
   * 取れなければ shifts は null (呼び出し側が ours 欠けとして突合を続ける)。
   */
  private async loadCompareKosoku(
    apiUrl: string,
    clientId: string,
    clientSecret: string,
    ym: string,
  ): Promise<{
    shifts: Map<string, KosokuShift[]> | null;
    paperDriftByDriver: Map<string, Map<string, number>>;
    ferryMinusByDriver: Map<string, Map<string, number>>;
  }> {
    const fetchMonth = async (month: string): Promise<unknown | null> => {
      try {
        const upstream = await fetch(
          `${apiUrl}/api/kintai/kosoku-daily?month=${encodeURIComponent(month)}&view=compare`,
          { headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } },
        );
        if (!upstream.ok) {
          console.error(
            JSON.stringify({ kintai_fetch_kosoku: "upstream-error", ym: month, status: upstream.status }),
          );
          return null;
        }
        return JSON.parse(await upstream.text());
      } catch (err) {
        console.error(
          JSON.stringify({ kintai_fetch_kosoku: "error", ym: month, error: describeUnknownError(err) }),
        );
        return null;
      }
    };
    const [curBody, prevBody] = await Promise.all([fetchMonth(ym), fetchMonth(prevYmOf(ym))]);
    const paperDriftByDriver =
      curBody == null ? new Map<string, Map<string, number>>() : parsePaperDriftByDriver(curBody);
    // フェリー控除の日別マップも当月応答からだけ読む (rust#181 — 勤務に貼れない日がある)
    const ferryMinusByDriver =
      curBody == null ? new Map<string, Map<string, number>>() : parseFerryMinusByDriver(curBody);
    // 当月が取れていないと時間が丸ごと出ないので、その時は諦める
    if (curBody == null) return { shifts: null, paperDriftByDriver, ferryMinusByDriver };
    const merged = new Map<string, KosokuShift[]>();
    for (const body of [curBody, prevBody]) {
      if (body == null) continue;
      for (const [driverCd, shifts] of parseKosokuDaily(body)) {
        merged.set(driverCd, [...(merged.get(driverCd) ?? []), ...shifts]);
      }
    }
    return { shifts: merged, paperDriftByDriver, ferryMinusByDriver };
  }

  // R2 突合マスタ (salary-cd-map) → 社員マスタの取り込み
  // (`POST /restraint-api/employee-master/import-cd-map`) は本番移行完了により
  // 撤去した (2026-07-25、Refs #367)。移行後は 27324455 が 183 名・75700192 は
  // R2 マスタ自体を持たない = `migratable` が両会社で false になったのを確認済み。
  // 社員の登録経路は「給与DBから取り込み」(`/api/kyuyo/employees`) と給与明細
  // CSV の「未登録 N 名をマスタへ登録」(PUT) の 2 本に一本化されている。

  /** month クエリ ("YYYY-MM") を検証して {year, month, ym} を返す。不正は null。 */
  private parseMonthParam(url: URL): { year: number; month: number; ym: string } | null {
    const m = (url.searchParams.get("month") ?? "").match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month < 1 || month > 12) return null;
    return { year, month, ym: `${m[1]}-${m[2]}` };
  }

  /** 指定月の summary latest 一覧を R2 から読む (wage-report と archive/summaries
   * の共通処理)。noData マーカーは summaries から分離して返す。
   *
   * `prefix` 省略時は theearth 由来 (`restraint/`)。タイムカード由来は同じ形の
   * サマリを別 prefix (`kintai/`) に置いてあるので、そちらを読む時だけ指定する
   * (Refs #424 PR-D)。 */
  private async loadMonthSummaries(
    bucket: R2Bucket,
    compId: string,
    ym: string,
    prefix: string = this.env.RESTRAINT_R2_PREFIX || "restraint",
  ): Promise<{
    summaries: Array<{ data: RestraintDriverSummary; fetchedAt: string | null; lastVerifiedAt: string | null }>;
    noDataDrivers: string[];
  }> {
    const objects = await this.listAllR2(bucket, `${prefix}/${compId}/${ym}/summary/`);
    const latests = objects.filter((o) => o.key.endsWith("/latest.json"));
    const summaries: Array<{ data: RestraintDriverSummary; fetchedAt: string | null; lastVerifiedAt: string | null }> = [];
    const noDataDrivers: string[] = [];
    // 乗務員ごとの latest.json は並列に読む — 逐次 GET だと乗務員数 × RTT で
    // 月表示が数秒かかる (同時接続数は runtime が自動で絞る)
    const loaded = await Promise.all(
      latests.map(async (meta) => {
        const obj = await bucket.get(meta.key);
        if (!obj) return null; // list 後に消えた場合はスキップ
        try {
          return { meta, parsed: JSON.parse(await obj.text()) as unknown };
        } catch {
          console.error(JSON.stringify({ restraint_archive: "broken-summary", key: meta.key }));
          return null;
        }
      }),
    );
    for (const entry of loaded) {
      if (!entry) continue;
      const { meta, parsed } = entry;
      const record = parsed as { noData?: unknown; driverCd?: unknown };
      if (record.noData === true) {
        noDataDrivers.push(typeof record.driverCd === "string" ? record.driverCd : "");
        continue;
      }
      // v1 summary (days なし) も読めるよう防御的に補完する
      const summary = parsed as RestraintDriverSummary & { days?: unknown };
      summaries.push({
        data: { ...summary, days: Array.isArray(summary.days) ? (summary.days as RestraintSummaryDay[]) : [] },
        fetchedAt: meta.customMetadata?.fetchedAt ?? null,
        lastVerifiedAt: meta.customMetadata?.lastVerifiedAt ?? null,
      });
    }
    summaries.sort((a, b) => a.data.driverCd.localeCompare(b.data.driverCd, undefined, { numeric: true }));
    return { summaries, noDataDrivers };
  }

  /** GET /restraint-api/archive/summaries?month=YYYY-MM — R2 の summary latest 一覧。 */
  private async handleArchiveSummaries(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { summaries, noDataDrivers } = await this.loadMonthSummaries(bucket, record.compId, parsed.ym);
    return Response.json({ month: parsed.ym, summaries, no_data_drivers: noDataDrivers });
  }

  /** GET /restraint-api/archive/csv-list?month=YYYY-MM — 生 CSV (latest/版/履歴) の一覧。 */
  private async handleArchiveCsvList(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const base = `${prefix}/${record.compId}/${parsed.ym}/csv/`;
    const objects = await this.listAllR2(bucket, base);
    const entries = objects.map((o) => {
      const rel = o.key.slice(base.length); // "{range}/latest.csv" 等
      const [range, file] = [rel.slice(0, rel.lastIndexOf("/")), rel.slice(rel.lastIndexOf("/") + 1)];
      const kind = file === "latest.csv" ? "latest" : file === "history.jsonl" ? "history" : "version";
      return {
        key: o.key,
        range,
        file,
        kind,
        size: o.size,
        fetched_at: o.customMetadata?.fetchedAt ?? null,
        last_verified_at: o.customMetadata?.lastVerifiedAt ?? null,
      };
    });
    return Response.json({ month: parsed.ym, entries });
  }

  /** GET /restraint-api/archive/csv?key= — R2 の生 CSV 素通しダウンロード。
   * key は自 comp の csv 配下のみ許可する (他社 prefix・summary 等は 400)。 */
  private async handleArchiveCsvDownload(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const key = url.searchParams.get("key") ?? "";
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const allowed = `${prefix}/${record.compId}/`;
    if (!key.startsWith(allowed) || !key.includes("/csv/") || key.includes("..") || !key.endsWith(".csv")) {
      return dvrJsonError(400, "key が不正です (自社の拘束 CSV アーカイブのみ取得できます)");
    }
    const obj = await bucket.get(key);
    if (!obj) return dvrJsonError(404, "指定の CSV が見つかりません");
    const filename = key.slice(allowed.length).replace(/[^A-Za-z0-9._-]/g, "_");
    return new Response(obj.body, {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=Shift_JIS",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  }

  /** GET /restraint-api/archive/history?month=YYYY-MM&range= — 確認履歴 (JSONL) の閲覧。 */
  private async handleArchiveHistory(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const range = url.searchParams.get("range") ?? "all";
    if (!/^(all|\d{1,8}-\d{1,8})$/.test(range)) {
      return dvrJsonError(400, "range は all または {from}-{to} で指定してください");
    }
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const key = `${prefix}/${record.compId}/${parsed.ym}/csv/${range}/history.jsonl`;
    const obj = await bucket.get(key);
    if (!obj) return Response.json({ month: parsed.ym, range, entries: [] });
    const text = await obj.text();
    const entries = text
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l) as unknown;
        } catch {
          return { raw: l };
        }
      });
    return Response.json({ month: parsed.ym, range, entries });
  }

  /** 指定 prefix 配下の月ディレクトリ (YYYY-MM) を降順で列挙する。 */
  private async listMonthDirs(bucket: R2Bucket, base: string): Promise<string[]> {
    const months: string[] = [];
    let cursor: string | undefined;
    do {
      const res: R2Objects = await bucket.list({ prefix: base, delimiter: "/", cursor });
      for (const p of res.delimitedPrefixes) {
        const m = p.slice(base.length).match(/^(\d{4}-\d{2})\/$/);
        if (m) months.push(m[1]);
      }
      cursor = res.truncated ? res.cursor : undefined;
    } while (cursor);
    months.sort((a, b) => b.localeCompare(a));
    return months;
  }

  /** GET /restraint-api/archive/months — アーカイブが存在する月 (YYYY-MM) の
   * 一覧 (降順)。年月タブ UI と一括再計算・一括印刷の対象列挙に使う。R2 の
   * delimited list で月ディレクトリだけ拾う (wage-master 等の非月 prefix は除外)。
   * `kintai_months` はタイムカード取り込み済みの月 (別 prefix、月タブの
   * バッジ表示用。Refs #460)。 */
  private async handleArchiveMonths(record: TheearthSessionRecord): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const kintaiPrefix = this.env.KINTAI_R2_PREFIX || "kintai";
    const [months, kintaiMonths, ichibanMonths] = await Promise.all([
      this.listMonthDirs(bucket, `${prefix}/${record.compId}/`),
      this.listMonthDirs(bucket, `${kintaiPrefix}/${record.compId}/`),
      this.listIchibanSyncedMonths(record.compId),
    ]);
    return Response.json({ months, kintai_months: kintaiMonths, ichiban_months: ichibanMonths });
  }

  /** ichiban に拘束サマリ (theearth source) が push 済みの月一覧 (Refs #460)。
   * 月タブの「高速表示可」バッジと未同期時のバックフィル案内用。best-effort —
   * 未設定・失敗は空 (バッジが出ないだけで月タブは従来どおり動く)。 */
  private async listIchibanSyncedMonths(compId: string): Promise<string[]> {
    const apiUrl = (this.env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
    const clientId = this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
    let clientSecret = "";
    try {
      clientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch (err) {
      // 失敗を黙って握るとバッジが出ない原因が追えない (2026-07-27 実害) —
      // フォールバック (空 = バッジ非表示) は維持しつつ、必ず 1 行残す
      console.error(JSON.stringify({ restraint_synced_months: "secret-error", error: describeUnknownError(err) }));
    }
    if (!apiUrl || !clientId || !clientSecret) {
      console.log(JSON.stringify({ restraint_synced_months: "skipped-not-configured", comp_id: compId }));
      return [];
    }
    try {
      const res = await fetch(
        `${apiUrl}/api/restraint/synced-months?comp=${encodeURIComponent(compId)}`,
        {
          headers: {
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          },
        },
      );
      if (!res.ok) {
        console.error(
          JSON.stringify({
            restraint_synced_months: "upstream-error",
            comp_id: compId,
            status: res.status,
            body: (await res.text()).slice(0, 200),
          }),
        );
        return [];
      }
      const raw = (await res.json()) as { entries?: unknown };
      if (!Array.isArray(raw.entries)) {
        console.error(JSON.stringify({ restraint_synced_months: "bad-shape", comp_id: compId }));
        return [];
      }
      // wage-report の fan-out を支配するのは theearth 側 — 「高速表示可」の
      // 判定は theearth source の同期有無で見る
      const months = raw.entries
        .filter(
          (e): e is { source: string; month: string } =>
            typeof e === "object" && e !== null
            && (e as { source?: unknown }).source === "theearth"
            && typeof (e as { month?: unknown }).month === "string",
        )
        .map((e) => e.month);
      console.log(
        JSON.stringify({ restraint_synced_months: "ok", comp_id: compId, months: months.length }),
      );
      return [...new Set(months)].sort((a, b) => b.localeCompare(a));
    } catch (err) {
      console.error(
        JSON.stringify({ restraint_synced_months: "error", comp_id: compId, error: describeUnknownError(err) }),
      );
      return [];
    }
  }

  /** POST /restraint-api/archive/resummarize?month=YYYY-MM — R2 に保存済みの
   * 生 CSV (`csv/{range}/latest.csv`) からサマリを再計算して保存し直す
   * (theearth には触らない)。summary スキーマの更新 (v1 → v2 の日別データ・
   * 派生指標追加など) を過去アーカイブへ適用する経路。
   *
   * **CSV 側の lastVerifiedAt / 確認履歴は更新しない** — theearth で内容を
   * 確認したわけではないため。書くのは summary の latest + 版だけ (内容が
   * 変わらなければ putVersionedR2 が版を増やさず lastVerifiedAt だけ進むが、
   * これは「保存済み CSV から同じサマリが再現された」ことの記録として正しい)。 */
  private async handleArchiveResummarize(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const base = `${prefix}/${record.compId}/${parsed.ym}/csv/`;
    const objects = await this.listAllR2(bucket, base);
    const latests = objects.filter((o) => o.key.endsWith("/latest.csv"));
    const ts = restraintVersionTimestamp(new Date());
    let csvCount = 0;
    let summariesWritten = 0;
    let newVersions = 0;
    const errors: string[] = [];
    const d1Entries: RestraintD1Entry[] = [];
    for (const meta of latests) {
      const obj = await bucket.get(meta.key);
      if (!obj) continue;
      try {
        const text = new TextDecoder("shift_jis").decode(await obj.arrayBuffer());
        const report = parseRestraintCsv(text);
        const limit = report.maxRestraintHours !== null ? report.maxRestraintHours * 60 : null;
        const range = meta.key.slice(base.length, meta.key.length - "/latest.csv".length);
        const paths = restraintR2Paths(prefix, record.compId, parsed.year, parsed.month, range);
        for (const block of report.drivers) {
          const summary = summarizeRestraintDriver(block, limit);
          const body = stableSummaryBody(record.compId, parsed.year, parsed.month, summary);
          const wrote = await this.putVersionedR2(
            bucket,
            paths.summaryLatest(summary.driverCd),
            paths.summaryVersion(summary.driverCd, ts),
            body,
            "application/json",
            ts,
          );
          summariesWritten++;
          if (wrote.changed) {
            newVersions++;
            await this.pruneRestraintVersions(bucket, paths.summaryDir(summary.driverCd));
          }
          d1Entries.push({
            kind: "summary",
            summary,
            meta: { sha256: wrote.sha256, fetchedAt: wrote.fetchedAt, lastVerifiedAt: ts },
          });
        }
        csvCount++;
      } catch (err) {
        errors.push(`${meta.key}: ${describeUnknownError(err)}`);
        console.error(JSON.stringify({ restraint_resummarize: "error", key: meta.key, error: describeUnknownError(err) }));
      }
    }
    await this.upsertRestraintSummariesD1(record.compId, "theearth", parsed.ym, d1Entries);
    await this.pushRestraintSummariesToIchiban(record.compId, "theearth", parsed.ym, d1Entries);
    return Response.json({
      month: parsed.ym,
      csv_processed: csvCount,
      summaries_written: summariesWritten,
      summaries_new_version: newVersions,
      errors,
    });
  }

  /** wage-report の素材 (当月+前月 × theearth+timecard のサマリ) を読む
   * (Refs #452 / rust-ichibanboshi#106 Phase 3c)。
   *
   * まず ichiban の `GET /api/restraint/wage-source` を 1 fetch — Phase 3b の
   * push が溜めた写しで、従来の R2 GET 約300本 (fan-out) を置き換える。
   * フォールバックは 2 段:
   *
   * - fetch 自体の失敗 / 未設定環境 → 全部 R2 (従来経路そのまま)
   * - fetch は成功したが特定の (source, 月) が未 push (`synced_at` null) →
   *   その piece だけ R2 から読む (push が追い付くまでの過渡期・新月の初回)
   */
  private async loadWageReportSource(
    bucket: R2Bucket,
    compId: string,
    ym: string,
    prevYm: string,
    kintaiPrefix: string,
    timer?: PhaseTimer,
  ): Promise<{
    current: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
    prev: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
    kintaiCurrent: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
    kintaiPrev: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
  }> {
    // タイムカード側は **R2 を読まずその場で組む** (2026-07-28 決定「R2 やめろ」)。
    // R2 は `kintai/fetch` を回した時点の写しでしかなく、取り込みを忘れると古い値が
    // 出続ける (実測: 乗務員 1108 / 2026-04 が打刻由来の 3 勤務・拘束 447h29m のまま)。
    // 上流が取れない時だけ従来どおり R2 へ落ちる。
    const live = await measurePhase(timer, "kintai-live", () =>
      this.buildKintaiSummariesLive(compId, ym, prevYm, timer),
    );
    const fromR2 = {
      current: () =>
        measurePhase(timer, "r2-theearth-cur", () => this.loadMonthSummaries(bucket, compId, ym)),
      prev: () =>
        measurePhase(timer, "r2-theearth-prev", () => this.loadMonthSummaries(bucket, compId, prevYm)),
      kintaiCurrent: () =>
        live
          ? Promise.resolve(live.current)
          : measurePhase(timer, "r2-kintai-cur", () =>
              this.loadMonthSummaries(bucket, compId, ym, kintaiPrefix),
            ),
      kintaiPrev: () =>
        live
          ? Promise.resolve(live.prev)
          : measurePhase(timer, "r2-kintai-prev", () =>
              this.loadMonthSummaries(bucket, compId, prevYm, kintaiPrefix),
            ),
    };
    const allR2 = async () => {
      const [current, prev, kintaiCurrent, kintaiPrev] = await Promise.all([
        fromR2.current(),
        fromR2.prev(),
        fromR2.kintaiCurrent(),
        fromR2.kintaiPrev(),
      ]);
      return { current, prev, kintaiCurrent, kintaiPrev };
    };

    const apiUrl = (this.env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
    const clientId = this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
    let clientSecret = "";
    try {
      clientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch {
      // secret 不調は push 側で別途 log 済み — ここは R2 に落ちるだけで良い
    }
    if (!apiUrl || !clientId || !clientSecret) {
      console.log(JSON.stringify({ wage_report_source: "r2-not-configured", comp_id: compId, ym }));
      return allR2();
    }

    let wire: WageSourceResponseWire;
    try {
      const res = await measurePhase(timer, "wage-source", () =>
        fetch(
          `${apiUrl}/api/restraint/wage-source?comp=${encodeURIComponent(compId)}&month=${encodeURIComponent(ym)}`,
          {
            headers: {
              "CF-Access-Client-Id": clientId,
              "CF-Access-Client-Secret": clientSecret,
            },
          },
        ),
      );
      if (!res.ok) {
        console.error(
          JSON.stringify({ wage_report_source: "upstream-error", comp_id: compId, ym, status: res.status }),
        );
        return allR2();
      }
      // JSON parse (本文受信込み) は fetch (ヘッダ到着まで) と分けて計る。
      // サイズは content-length があればそれを載せる (Tunnel 圧縮時は無いこともある)
      const contentLength = Number(res.headers.get("content-length"));
      if (timer && Number.isFinite(contentLength) && contentLength > 0) {
        timer.setBytes("wage-source-parse", contentLength);
      }
      const raw: unknown = await measurePhase(timer, "wage-source-parse", () => res.json());
      if (!isWageSourceResponse(raw)) {
        console.error(JSON.stringify({ wage_report_source: "bad-shape", comp_id: compId, ym }));
        return allR2();
      }
      wire = raw;
    } catch (err) {
      console.error(
        JSON.stringify({ wage_report_source: "fetch-error", comp_id: compId, ym, error: describeUnknownError(err) }),
      );
      return allR2();
    }

    // 未 push (synced_at null) の piece だけ R2 へ (過渡期・新月初回)
    const pick = async (
      month: WageSourceMonthWire,
      fallback: () => ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>,
      label: string,
    ) => {
      if (month.synced_at !== null) return wageSourceMonthToSummaries(month);
      console.log(JSON.stringify({ wage_report_source: "r2-piece-fallback", comp_id: compId, piece: label }));
      return fallback();
    };
    const [current, prev, kintaiCurrent, kintaiPrev] = await Promise.all([
      pick(wire.current_theearth, fromR2.current, `theearth:${ym}`),
      pick(wire.prev_theearth, fromR2.prev, `theearth:${prevYm}`),
      // **タイムカード側は ichiban の写しも使わない** — R2 と同じく push した時点で
      // 止まっており、取り込みを回すまで古い値が出る (2026-07-28 決定「R2 やめろ」)。
      // その場で組めた時はそれを使い、組めなかった時だけ写しへ落ちる
      live ? live.current : pick(wire.current_timecard, fromR2.kintaiCurrent, `timecard:${ym}`),
      live ? live.prev : pick(wire.prev_timecard, fromR2.kintaiPrev, `timecard:${prevYm}`),
    ]);
    console.log(JSON.stringify({ wage_report_source: "ichiban", comp_id: compId, ym }));
    return { current, prev, kintaiCurrent, kintaiPrev };
  }

  /** GET /restraint-api/wage-report?month=YYYY-MM — R2 の summary + マスタから
   * 時間給計算行を返す (Refs #244)。週40h の月初跨ぎ週のため前月 summary の
   * days も読み込む (無ければ跨ぎ週は当月分のみで近似し warning を返す)。
   *
   * **theearth (デジタコ) と timecard (タイムカード) の両方を読んで合流する**
   * (Refs #424 PR-D) — デジタコに乗らない本社事務員等はタイムカード側からしか
   * 出てこない。行には `source` が付く。`computeWageRow` / `classifyMonth` /
   * `compareSalaryMonth` はどちらの由来でも同じものを使う (タイムカード側が
   * `RestraintDriverSummary` 互換の形で保存されているため)。
   * **重複は timecard が勝つ** (2026-07-28 決定 — 賃金は打刻を根拠にする)。 */
  private async handleWageReport(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { year, month, ym } = parsed;
    // フェーズ計測 (Refs #543 PR-1)。挙動は変えない — ログ 1 行と Server-Timing だけ
    const timer = new PhaseTimer();

    const loadMaster = async <T>(
      name: "wage-master" | "min-wage" | "wage-config",
      normalize: (raw: unknown) => T,
      fallback: T,
    ): Promise<T> => {
      const obj = await bucket.get(this.wageMasterR2Paths(record.compId, name).latest);
      if (!obj) return fallback;
      try {
        return normalize(JSON.parse(await obj.text()));
      } catch (err) {
        console.error(`wage-report ${name} read error:`, err);
        return fallback;
      }
    };
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYm = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;
    // タイムカード由来 (本社事務員等) のサマリは別 prefix に置いてある — デジタコに
    // 乗らない人はここからしか出てこない (Refs #424 PR-D)
    const kintaiPrefix = this.env.KINTAI_R2_PREFIX || "kintai";
    // マスタ 3 種と当月・前月 summary は互いに独立なので一括並列で読む (月切替の体感に直結)
    const [wageMaster, minWageMaster, config, { current, prev, kintaiCurrent, kintaiPrev }] =
      await Promise.all([
        timer.measure("master-wage", () =>
          loadMaster<WageMaster>("wage-master", normalizeWageMaster, { drivers: {} }),
        ),
        timer.measure("master-min-wage", () =>
          loadMaster<MinWageMaster>("min-wage", normalizeMinWageMaster, {
            prefectures: {},
            branchToPrefecture: {},
          }),
        ),
        timer.measure("master-config", () =>
          loadMaster<WageConfig>("wage-config", normalizeWageConfig, normalizeWageConfig(null)),
        ),
        timer.measure("source", () =>
          this.loadWageReportSource(bucket, record.compId, ym, prevYm, kintaiPrefix, timer),
        ),
      ]);
    const { noDataDrivers } = current;
    const endMerge = timer.begin("merge");
    // 同じ乗務員CD が両方に居たら timecard を採る (打刻を賃金の根拠にする、2026-07-28)
    const { merged, warnings } = mergeSummarySources(current.summaries, kintaiCurrent.summaries);
    // 前月 days (週40h の月初跨ぎ週用) も同じ優先順で合流する — 当月と別の source を
    // 混ぜると跨ぎ週の実働が二重に積まれる
    const { merged: prevMerged } = mergeSummarySources(prev.summaries, kintaiPrev.summaries);
    const prevDaysByDriver = new Map<string, RestraintSummaryDay[]>(
      prevMerged.map((m) => [m.entry.data.driverCd, m.entry.data.days]),
    );

    if (merged.length > 0 && prevMerged.length === 0) {
      warnings.push(
        `前月 (${prevYm}) の summary がアーカイブに無いため、月初の跨ぎ週の週40h計算は当月分のみで近似しています`,
      );
    }
    endMerge();
    // 最低賃金の県は theearth の事業所名ではなく社員マスタの所属 (月末時点) で引く
    // (Refs #409 Phase 3)。D1 が無い / 読めない場合は空のまま = 従来どおり
    // theearth 事業所名 + defaultPrefecture のフォールバックで動く
    const { branches: employeeBranches, payKubun } = await timer.measure("branches", () =>
      this.branchByDriverCd(record.compId, ym),
    );

    const endRows = timer.begin("rows");
    const rows = merged.map(({ entry, source }) => ({
      summary: entry.data,
      /** 'theearth' (デジタコ) | 'timecard' (タイムカード)。画面のバッジ用 (PR-E)。 */
      source,
      /** 給与区分 (1=月給 / 2=日給 / 3=時給 / 4=その他)。社員マスタに無ければ null。
       * 給与比較が「基本給(計算)」の単価の掛け方を決めるのに使う (Refs #429)。 */
      pay_kubun: payKubun.get(entry.data.driverCd) ?? null,
      fetched_at: entry.fetchedAt,
      last_verified_at: entry.lastVerifiedAt,
      wage: computeWageRow(
        entry.data,
        year,
        month,
        wageMaster,
        minWageMaster,
        config,
        prevDaysByDriver.get(entry.data.driverCd) ?? [],
        employeeBranches.get(entry.data.driverCd) ?? null,
      ),
    }));
    endRows();
    return this.withPhaseTiming(
      "wage-report",
      ym,
      timer,
      Response.json({ month: ym, rows, no_data_drivers: noDataDrivers, warnings, config }),
    );
  }

  /** SHA-256 の hex digest (R2 アーカイブの変化検知用)。 */
  private async sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      bytes instanceof Uint8Array ? (bytes as unknown as ArrayBuffer) : bytes,
    );
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  /** `latest` の customMetadata.sha256 と比較するバージョン管理 put:
   *
   * - **内容不変** → latest の `lastVerifiedAt` だけ今回時刻に更新して false を
   *   返す (version は増やさない)。「元の CSV は最終形が確定するまで変わりうる」
   *   ため、**いつの時点までこの値が合っていたか** を latest が常に持つ。
   * - **内容が変わった** → latest を上書き (fetchedAt = 今回) + `v-{ts}` 版を
   *   追加して true を返す。置き換えられた旧版はこの時点から
   *   RESTRAINT_VERSION_RETENTION_MS (7 日) 後に削除対象になる
   *   (pruneRestraintVersions)。 */
  private async putVersionedR2(
    bucket: R2Bucket,
    latestKey: string,
    versionKey: string,
    body: ArrayBuffer | string,
    contentType: string,
    fetchedAt: string,
  ): Promise<{ changed: boolean; sha256: string; fetchedAt: string }> {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const hash = await this.sha256Hex(bytes);
    const latest = await bucket.head(latestKey);
    if (latest?.customMetadata?.sha256 === hash) {
      await bucket.put(latestKey, bytes, {
        httpMetadata: { contentType },
        customMetadata: { ...latest.customMetadata, lastVerifiedAt: fetchedAt },
      });
      // 内容不変なら fetchedAt は据え置き (D1 写しにも同じ値を流す)
      return { changed: false, sha256: hash, fetchedAt: latest.customMetadata?.fetchedAt ?? fetchedAt };
    }
    const options = {
      httpMetadata: { contentType },
      customMetadata: { sha256: hash, fetchedAt, lastVerifiedAt: fetchedAt },
    };
    await bucket.put(latestKey, bytes, options);
    await bucket.put(versionKey, bytes, options);
    return { changed: true, sha256: hash, fetchedAt };
  }

  /** サマリ写しを rust-ichibanboshi (restraint_local.sqlite) へ push する
   * (Refs #452 / rust-ichibanboshi#106 Phase 3b)。best-effort — 到達不能・非 2xx でも
   * 取り込み自体は成功させる (R2 が正。欠けは resummarize の再実行で追い付ける)。
   * wage-report の読みは Phase 3c でこの写し (wage-source) に切り替わる。 */
  private async pushRestraintSummariesToIchiban(
    compId: string,
    source: WageReportSource,
    ym: string,
    entries: RestraintD1Entry[],
  ): Promise<void> {
    if (entries.length === 0) return;
    const apiUrl = (this.env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
    const clientId = this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
    let clientSecret = "";
    try {
      clientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch (err) {
      console.error(JSON.stringify({ restraint_push: "secret-error", error: describeUnknownError(err) }));
    }
    if (!apiUrl || !clientId || !clientSecret) {
      // 未設定環境 (ローカル dev 等) では push なしで動く — wage-source 側は
      // synced_at null になり、読みは R2 フォールバックのまま
      console.log(JSON.stringify({ restraint_push: "skipped-not-configured", comp_id: compId, source, ym }));
      return;
    }
    try {
      for (const body of buildRestraintPushBodies(compId, source, ym, entries)) {
        const res = await fetch(`${apiUrl}/api/restraint/summaries`, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "CF-Access-Client-Id": clientId,
            "CF-Access-Client-Secret": clientSecret,
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          console.error(
            JSON.stringify({
              restraint_push: "upstream-error",
              comp_id: compId,
              source,
              ym,
              status: res.status,
              body: (await res.text()).slice(0, 200),
            }),
          );
          return; // 同一 push 内の続きは諦める (次の取り込み/resummarize で追い付く)
        }
      }
      console.log(
        JSON.stringify({ restraint_push: "done", comp_id: compId, source, ym, entries: entries.length }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({ restraint_push: "error", comp_id: compId, source, ym, error: describeUnknownError(err) }),
      );
    }
  }

  /** サマリ写しを D1 (restraint_driver_month + restraint_daily) へ upsert する
   * (Refs #452 PR-A)。best-effort — D1 未 binding・書き込み失敗でも取り込み自体は
   * 成功させる (R2 が正。欠けた分は PR-B のバックフィルで追い付ける)。
   *
   * batch は 1 乗務員分のステートメントを跨いで分割しない (DELETE→INSERT の
   * 総入れ替えが途中で切れると日別行が欠けたまま残るため)。 */
  private async upsertRestraintSummariesD1(
    compId: string,
    source: WageReportSource,
    ym: string,
    entries: RestraintD1Entry[],
  ): Promise<void> {
    const db = this.env.DTAKO_DB;
    if (!db || entries.length === 0) return;
    try {
      // 1 乗務員 ≈ 8 statement (delete + month + 日別 6 行 ×6)。乗務員単位を保った
      // まま 1 batch ≤ 40 statement 程度に畳む
      let buf: Array<{ sql: string; params: Array<string | number | null> }> = [];
      const flush = async () => {
        if (buf.length === 0) return;
        await db.batch(buf.map((s) => db.prepare(s.sql).bind(...s.params)));
        buf = [];
      };
      for (const entry of entries) {
        const statements = buildRestraintD1Statements(compId, source, ym, [entry]);
        if (buf.length > 0 && buf.length + statements.length > 40) await flush();
        buf.push(...statements);
      }
      await flush();
    } catch (err) {
      console.error(
        JSON.stringify({
          restraint_d1: "error",
          comp_id: compId,
          source,
          ym,
          entries: entries.length,
          error: describeUnknownError(err),
        }),
      );
    }
  }

  /** 確認履歴 (history.jsonl) に 1 行追記する。「unchanged」「no-data」も残す —
   * latest の lastVerifiedAt (最新値のみ) と違い、確認の時系列が全部残る。 */
  private async appendRestraintHistory(
    bucket: R2Bucket,
    historyKey: string,
    line: string,
  ): Promise<void> {
    const existing = await bucket.get(historyKey);
    const text = existing ? await existing.text() : null;
    await bucket.put(historyKey, appendHistoryJsonl(text, line), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  }

  /** 新しい版を書いた後の掃除: `{dir}/v-*` を list して、後継版の出現から
   * 7 日を過ぎた旧版を削除する (最新版は常に残る、選定は pure な
   * pickSupersededVersionKeys)。 */
  private async pruneRestraintVersions(bucket: R2Bucket, dir: string): Promise<void> {
    const listed = await bucket.list({ prefix: `${dir}/v-` });
    const stale = pickSupersededVersionKeys(listed.objects.map((o) => o.key), new Date());
    for (const key of stale) {
      await bucket.delete(key);
    }
    if (stale.length > 0) {
      console.log(JSON.stringify({ restraint_r2: "pruned", dir, deleted: stale.length }));
    }
  }

  /** 取得できた拘束時間管理表 CSV (Shift_JIS 生バイト) + 乗務員別サマリ JSON を
   * R2 にバージョン管理付きで保存する (Refs #241、key 設計は restraintR2Paths の
   * doc 参照)。waitUntil 前提の best-effort — 保存失敗でユーザーへの応答は落とさ
   * ない (console.error → Workers Observability / Tail Worker で追う)。 */
  private async saveRestraintToR2(
    compId: string,
    params: RestraintCsvParams,
    csvBytes: ArrayBuffer,
    summaries: RestraintDriverSummary[],
  ): Promise<void> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return; // R2 未 binding の環境ではアーカイブなし (取得自体は成功させる)
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const range = restraintDriverRangeLabel(params);
    const paths = restraintR2Paths(prefix, compId, params.year, params.month, range);
    const ts = restraintVersionTimestamp(new Date());
    try {
      const csvResult = await this.putVersionedR2(
        bucket,
        paths.csvLatest,
        paths.csvVersion(ts),
        csvBytes,
        "text/csv; charset=Shift_JIS",
        ts,
      );
      if (csvResult.changed) await this.pruneRestraintVersions(bucket, paths.csvDir);
      await this.appendRestraintHistory(
        bucket,
        paths.csvHistory,
        restraintHistoryLine(
          ts,
          csvResult.changed ? "new-version" : "unchanged",
          csvResult.sha256,
          csvBytes.byteLength,
        ),
      );
      let summariesWrote = 0;
      const d1Entries: RestraintD1Entry[] = [];
      for (const summary of summaries) {
        const body = stableSummaryBody(compId, params.year, params.month, summary);
        const wrote = await this.putVersionedR2(
          bucket,
          paths.summaryLatest(summary.driverCd),
          paths.summaryVersion(summary.driverCd, ts),
          body,
          "application/json",
          ts,
        );
        if (wrote.changed) {
          summariesWrote++;
          await this.pruneRestraintVersions(bucket, paths.summaryDir(summary.driverCd));
        }
        d1Entries.push({
          kind: "summary",
          summary,
          meta: { sha256: wrote.sha256, fetchedAt: wrote.fetchedAt, lastVerifiedAt: ts },
        });
      }
      const ym = `${params.year}-${String(params.month).padStart(2, "0")}`;
      await this.upsertRestraintSummariesD1(compId, "theearth", ym, d1Entries);
      await this.pushRestraintSummariesToIchiban(compId, "theearth", ym, d1Entries);
      console.log(
        JSON.stringify({
          restraint_r2: "done",
          key: paths.csvLatest,
          csv_new_version: csvResult.changed,
          summaries_total: summaries.length,
          summaries_new_version: summariesWrote,
        }),
      );
    } catch (err) {
      console.error(
        JSON.stringify({ restraint_r2: "error", key: paths.csvLatest, error: describeUnknownError(err) }),
      );
    }
  }

  /** 「該当データがありません」だった確認も R2 に残す (Refs #241 — 途中入社・
   * 休職・未集計などで正当にありうる状態。未取得と区別するため、確認履歴に
   * `no-data` 行を追記し、乗務員単体取得なら summary 側にも noData マーカーを
   * 版管理付きで置く)。waitUntil 前提の best-effort。 */
  private async saveRestraintNoDataToR2(compId: string, params: RestraintCsvParams): Promise<void> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return;
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const range = restraintDriverRangeLabel(params);
    const paths = restraintR2Paths(prefix, compId, params.year, params.month, range);
    const ts = restraintVersionTimestamp(new Date());
    try {
      await this.appendRestraintHistory(
        bucket,
        paths.csvHistory,
        restraintHistoryLine(ts, "no-data", null, null),
      );
      // 乗務員単体 (from=to) なら summary にも noData マーカーを残す (全乗務員
      // 取得では「誰が居なかったか」を列挙できないため履歴のみ)
      if (params.driverFrom !== "" && params.driverFrom === params.driverTo) {
        const body = stableNoDataSummaryBody(compId, params.year, params.month, params.driverFrom);
        const wrote = await this.putVersionedR2(
          bucket,
          paths.summaryLatest(params.driverFrom),
          paths.summaryVersion(params.driverFrom, ts),
          body,
          "application/json",
          ts,
        );
        if (wrote.changed) await this.pruneRestraintVersions(bucket, paths.summaryDir(params.driverFrom));
        const ym = `${params.year}-${String(params.month).padStart(2, "0")}`;
        const noDataEntries: RestraintD1Entry[] = [
          {
            kind: "no-data",
            driverCd: params.driverFrom,
            meta: { sha256: wrote.sha256, fetchedAt: wrote.fetchedAt, lastVerifiedAt: ts },
          },
        ];
        await this.upsertRestraintSummariesD1(compId, "theearth", ym, noDataEntries);
        await this.pushRestraintSummariesToIchiban(compId, "theearth", ym, noDataEntries);
      }
      console.log(JSON.stringify({ restraint_r2: "no-data", key: paths.csvHistory }));
    } catch (err) {
      console.error(
        JSON.stringify({ restraint_r2: "error", key: paths.csvHistory, error: describeUnknownError(err) }),
      );
    }
  }

  /** GET /restraint-api/report?year=&month=&driverFrom=&driverTo= — F-ERS2010 の
   * CSV を取得してパース済み JSON で返す。「該当データがありません」(未集計月・
   * 在籍しない乗務員CD) は 200 の `{no_data: true}` (エラーではない)。フロントは
   * 乗務員×月のループでこれを逐次呼ぶ (並列化しない — theearthQueue が直列化する
   * が、順序と進捗表示のためフロントも直列で呼ぶ想定)。 */
  private async handleRestraintReport(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const params = this.parseRestraintQuery(url);
    try {
      validateRestraintParams(params);
    } catch (err) {
      if (err instanceof RestraintParamError) return dvrJsonError(400, err.message);
      throw err;
    }
    return this.callReportAction(record, "拘束時間管理表の取得", async (jar) => {
      const csv = await downloadRestraintCsv(jar, params);
      if (csv === null) {
        // 「データなし」も確認結果として R2 に残す (途中入社・休職と正当にありうる)
        this.ctx.waitUntil(this.saveRestraintNoDataToR2(record.compId, params));
        return { no_data: true };
      }
      const report = parseRestraintCsv(csv.text);
      const limitMinutes = report.maxRestraintHours !== null ? report.maxRestraintHours * 60 : null;
      const summaries = report.drivers.map((d) => summarizeRestraintDriver(d, limitMinutes));
      // 生 CSV + 乗務員別サマリを R2 にバージョン管理付きで保存 (応答をブロックしない)
      this.ctx.waitUntil(this.saveRestraintToR2(record.compId, params, csv.bytes, summaries));
      return { no_data: false, report, summaries };
    });
  }

  /** GET /restraint-api/csv?year=&month=&driverFrom=&driverTo= — F-ERS2010 の
   * 生 CSV (Shift_JIS) を素通しダウンロードする (handleReportZip と同型)。
   * 該当データ無しは 404。 */
  private async handleRestraintCsv(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const params = this.parseRestraintQuery(url);
    try {
      validateRestraintParams(params);
    } catch (err) {
      if (err instanceof RestraintParamError) return dvrJsonError(400, err.message);
      throw err;
    }
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const csv = await downloadRestraintCsv(jar, params);
      // cookie 書き戻しはヘッダ送出をブロックしない (handleDvrFile と同じ理由)。
      this.ctx.waitUntil(
        this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
          ...record,
          cookies: Array.from(jar.cookies.entries()),
        }),
      );
      if (csv === null) {
        this.ctx.waitUntil(this.saveRestraintNoDataToR2(record.compId, params));
        return dvrJsonError(404, "該当データがありません (未集計の年月、または該当乗務員なし)");
      }
      // 生 CSV 素通し経路でもサマリを抽出してアーカイブする (パース失敗は
      // アーカイブ側の縮退のみ — ユーザーへの CSV 応答は落とさない)
      let archiveSummaries: RestraintDriverSummary[] = [];
      try {
        const archiveReport = parseRestraintCsv(csv.text);
        const archiveLimit =
          archiveReport.maxRestraintHours !== null ? archiveReport.maxRestraintHours * 60 : null;
        archiveSummaries = archiveReport.drivers.map((d) => summarizeRestraintDriver(d, archiveLimit));
      } catch (err) {
        console.error(JSON.stringify({ restraint_r2: "parse-skip", error: describeUnknownError(err) }));
      }
      this.ctx.waitUntil(this.saveRestraintToR2(record.compId, params, csv.bytes, archiveSummaries));
      const range = params.driverFrom ? `${params.driverFrom}-${params.driverTo}` : "all";
      const month = String(params.month).padStart(2, "0");
      return new Response(csv.bytes, {
        status: 200,
        headers: {
          "content-type": "text/csv; charset=Shift_JIS",
          "content-disposition": `attachment; filename="restraint_${params.year}${month}_${range}.csv"`,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      console.error("Restraint csv error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `拘束時間管理表 CSV の取得に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  // -------------------------------------------------------------------------
  // /net780-api/* — theearth F-VOS3020 検索 + NET780 生データ一括ダウンロード
  // (Refs #302)。credential pass-through / theearth セッション共有は
  // /restraint-api と同じ。実機確定知見は ./theearth-net780-client.ts のヘッダ
  // コメントおよび theearth-venus skill の「3要素解析データ (NET780 生データ)
  // ダウンロード F-VOS3020[VehicleComDataDownLoad]」節参照。
  // -------------------------------------------------------------------------

  private async handleNet780Api(request: Request, url: URL): Promise<Response> {
    const routing = resolveTheearthRouting(request.headers);
    if (!routing) {
      return dvrJsonError(400, "X-Theearth-Comp-Id / X-Theearth-User-B64 ヘッダが不正です");
    }
    // 同一 ASP.NET セッションへの並行リクエストはセッションロックで hang/500 する
    // ため、他の theearth 系エンドポイントと同じキューで直列化する。
    return this.theearthQueue.enqueue(() => this.dispatchNet780Api(request, url, routing));
  }

  private async dispatchNet780Api(request: Request, url: URL, routing: TheearthRouting): Promise<Response> {
    if (url.pathname === "/net780-api/login" && request.method === "POST") {
      return this.handleTheearthLogin(request, routing);
    }

    const stored = await this.ctx.storage.get<TheearthSessionRecord>(THEEARTH_SESSION_KEY);
    const token = extractBearerToken(request.headers);
    const record = isTheearthSessionValid(stored, token, routing, Date.now()) ? stored! : null;
    if (!record) {
      return dvrJsonError(401, "セッションが無効か期限切れです。再ログインしてください");
    }

    if (url.pathname === "/net780-api/logout" && request.method === "POST") {
      await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/net780-api/search" && request.method === "GET") {
      return this.handleNet780Search(record, url);
    }
    if (url.pathname === "/net780-api/download" && request.method === "POST") {
      return this.handleNet780Download(record, request);
    }
    if (url.pathname === "/net780-api/r2-view" && request.method === "GET") {
      return this.handleNet780R2View(record.compId, url);
    }
    if (url.pathname === "/net780-api/history" && request.method === "GET") {
      return this.handleNet780History(record.compId, url);
    }
    return dvrJsonError(404, "不明なエンドポイントです");
  }

  /** GET /net780-api/search?operationDateFrom=&operationDateTo=&driverCdFrom=&
   * driverCdTo=&vehicleCdFrom=&vehicleCdTo= — F-GOS0030 の絞込を適用して
   * F-VOS3020 の一覧 (最大30件) を取得する。 */
  private async handleNet780Search(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const params: Net780SearchParams = {
      operationDateFrom: url.searchParams.get("operationDateFrom") || undefined,
      operationDateTo: url.searchParams.get("operationDateTo") || undefined,
      driverCdFrom: url.searchParams.get("driverCdFrom") || undefined,
      driverCdTo: url.searchParams.get("driverCdTo") || undefined,
      vehicleCdFrom: url.searchParams.get("vehicleCdFrom") || undefined,
      vehicleCdTo: url.searchParams.get("vehicleCdTo") || undefined,
    };
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const rows = await searchNet780(jar, params);
      this.ctx.waitUntil(
        this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
          ...record,
          cookies: Array.from(jar.cookies.entries()),
        }),
      );
      return Response.json({ rows });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      if (err instanceof Net780ParamError) {
        return dvrJsonError(400, err.message);
      }
      console.error("Net780 search error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `NET780 検索に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** POST /net780-api/download — body `{targets: [{operationNo, startDateTime}]}`
   * (常に1件) を選択した運行の NET780 生データ zip をそのままストリーム素通し
   * する (`handleReportZip` と同型)。複数運行の一括ダウンロードは、後から
   * 個別運行を安全に取り出せない ZIP (`operationCount > 1`) を生んでしまう
   * ため廃止した — フロント側で選択件数分この endpoint を順に呼ぶ (Refs #299)。
   * ダウンロード postback は HTTP 503 の再現性が高い (theearth-net780-client.ts
   * ヘッダコメント参照) ため、数回リトライする。 */
  private async handleNet780Download(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { targets?: unknown };
    try {
      body = (await request.json()) as { targets?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const targets = Array.isArray(body.targets) ? (body.targets as Net780DownloadTarget[]) : [];
    if (targets.length !== 1) {
      return dvrJsonError(
        400,
        `NET780 ダウンロードは1件ずつ実行してください (受領: ${targets.length}件) — ` +
          "個別運行の再取得を保証するため一括ダウンロードは廃止しました",
      );
    }
    try {
      validateNet780DownloadTargets(targets);
    } catch (err) {
      if (err instanceof Net780ParamError) return dvrJsonError(400, err.message);
      throw err;
    }

    const jar: CookieJar = { cookies: new Map(record.cookies) };
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const zip = await downloadNet780Zip(jar, targets);
        this.ctx.waitUntil(
          this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
            ...record,
            cookies: Array.from(jar.cookies.entries()),
          }),
        );
        // ダウンロードできた ZIP をそのまま R2 にアーカイブする (Refs #302 続き)。
        // 応答をブロックしない best-effort — 保存失敗はログのみ。
        this.ctx.waitUntil(this.saveNet780ToR2(record.compId, targets, zip));
        return new Response(zip, {
          headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="net780-${targets[0]!.operationNo}.zip"`,
            "cache-control": "no-store",
          },
        });
      } catch (err) {
        lastErr = err;
        if (err instanceof VenusSessionExpiredError) {
          await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
          return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
        }
        // HTTP 503 等の一時的な不安定さ (theearth-net780-client.ts 実機確定) は
        // 間隔を空けてリトライする。それ以外のエラーは即座に諦める。
        if (attempt < maxAttempts && err instanceof TheearthClientError) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        break;
      }
    }
    console.error("Net780 download error:", lastErr);
    const message =
      lastErr instanceof TheearthClientError
        ? lastErr.message
        : `NET780 ダウンロードに失敗しました (${describeUnknownError(lastErr)})`;
    return dvrJsonError(502, message);
  }

  /** ダウンロードできた NET780 ZIP (常に単一運行、Refs #299) を R2 にアーカイブ
   * する。ZIP 本体は内容の SHA-256 で dedup 保存し、operationNo からその ZIP を
   * 指すポインタ index を (常に上書きで) 書く — NET780 生データは過去の運行
   * 記録で内容が変わらないため、restraint 系のような版管理は不要。
   * waitUntil 前提の best-effort — 保存失敗でユーザーへの応答は落とさない。
   *
   * **既知の罠 (実害確認済み、2026-07-19)**: `upsertNet780Catalog` (D1 書き込み)
   * は以前この関数内部でさらに `this.ctx.waitUntil(...)` を呼ぶ二重ネスト構造
   * だった。この関数自体が既に呼び出し元 (`handleNet780Download`) の
   * `this.ctx.waitUntil(this.saveNet780ToR2(...))` で実行される非同期処理なので、
   * 内部でさらに `waitUntil` に登録すると、この関数の Promise が resolve した
   * 時点でまだ内側の D1 書き込みが完了していない可能性があり、その場合 DO
   * インスタンスが処理を打ち切ってしまう。実機で確認したところ R2 書き込み
   * (`await` で直列化済み) は毎回成功するのに D1 書き込みだけが消えるという
   * 症状が実際に発生した (`dtako_uploads` に対象 operation_no の行が一切
   * 作られない)。`await` で直列化し、この関数自体の完了を D1 書き込み完了まで
   * 待つようにして解消した。 */
  private async saveNet780ToR2(
    compId: string,
    targets: Net780DownloadTarget[],
    zipBytes: ArrayBuffer,
  ): Promise<void> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return; // R2 未 binding の環境ではアーカイブなし (ダウンロード自体は成功させる)
    const prefix = this.env.NET780_R2_PREFIX || "net780";
    const paths = net780R2Paths(prefix, compId);
    const fetchedAt = new Date().toISOString();
    try {
      const sha256 = await this.sha256Hex(zipBytes);
      const zipKey = paths.zipObject(sha256);
      const existing = await bucket.head(zipKey);
      if (!existing) {
        await bucket.put(zipKey, zipBytes, {
          httpMetadata: { contentType: "application/zip" },
          customMetadata: { sha256, fetchedAt },
        });
      }
      for (const target of targets) {
        await bucket.put(
          paths.indexObject(target.operationNo),
          net780R2IndexBody({
            zipKey,
            startDateTime: target.startDateTime,
            fetchedAt,
            operationCount: targets.length,
          }),
          { httpMetadata: { contentType: "application/json" } },
        );
        await this.upsertNet780Catalog(compId, target, zipKey, fetchedAt, targets.length);
      }
      console.log(
        JSON.stringify({ net780_r2: "done", zipKey, operations: targets.length, dedup: !!existing }),
      );
    } catch (err) {
      console.error(JSON.stringify({ net780_r2: "error", error: describeUnknownError(err) }));
    }
  }

  /** D1 検索カタログ (`dtako_uploads`、Refs #299) に NET780 の1行を upsert する。
   * 車番 (vehicle_cd) は theearth F-VOS3020 の検索結果グリッドに含まれない
   * (`lblVehicleName` のみ、車輌CD自体は無い) ため NULL のまま — 検索は
   * vehicle_name の部分一致 + driver_cd1 の完全一致で行う想定。comp_id
   * (theearth 会社ID) で書き込み、検索側も必ずこれで絞り込んでテナント間の
   * 混在を防ぐ。`operationCount` も書き込み、`operation_count !== 1` の行は
   * by-operation.get.ts (Nitro、`/operations` タブ用) が個別抽出不可として
   * 拒否する — r2-view (この DO) 側の同種ガードと揃える (実害: 2026-07-18、
   * 複数運行 archive の zip を由来不明のまま返し parse エラーになった)。
   * D1 はあくまで再構築可能なインデックスなので、binding 未設定や書き込み
   * 失敗は内部で catch してログのみに留め、呼び出し元 (`saveNet780ToR2`) には
   * 例外を伝播させない (best-effort)。呼び出し元はこの完了を `await` する
   * (二重 `waitUntil` ネストで完了が保証されない不具合があったため、Refs
   * `saveNet780ToR2` のコメント)。 */
  private async upsertNet780Catalog(
    compId: string,
    target: Net780DownloadTarget,
    zipKey: string,
    fetchedAt: string,
    operationCount: number,
  ): Promise<void> {
    const db = this.env.DTAKO_DB;
    if (!db) return;
    try {
      await db
        .prepare(
          `INSERT INTO dtako_uploads
             (dataset, schema_version, comp_id, vehicle_name, driver_cd1, driver_name1, operation_no, start_datetime, r2_key, uploaded_at, operation_count)
           VALUES ('net780', '1', ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(dataset, operation_no) WHERE operation_no IS NOT NULL DO UPDATE SET
             comp_id = excluded.comp_id,
             vehicle_name = excluded.vehicle_name,
             driver_cd1 = excluded.driver_cd1,
             driver_name1 = excluded.driver_name1,
             start_datetime = excluded.start_datetime,
             r2_key = excluded.r2_key,
             uploaded_at = excluded.uploaded_at,
             operation_count = excluded.operation_count`,
        )
        .bind(
          compId,
          target.vehicleName ?? null,
          target.driverCd1 ?? null,
          target.driverName1 ?? null,
          target.operationNo,
          target.startDateTime,
          zipKey,
          fetchedAt,
          operationCount,
        )
        .run();
    } catch (err) {
      console.error(JSON.stringify({ net780_d1: "error", error: describeUnknownError(err) }));
    }
  }

  /** GET /net780-api/history?vehicleName=&driverCd1= — D1 検索カタログ
   * (`dtako_uploads`、Refs #299) から過去にダウンロード済みの運行を検索する。
   * vehicleName は部分一致、driverCd1 は完全一致。両方省略時は直近200件を返す。
   * comp_id (theearth 会社ID) で必ず絞り込み、他社データが混在しないようにする。
   * D1 未 binding は 503 (検索機能そのものが使えないので、R2/theearth 側の
   * 動作には影響しない)。 */
  private async handleNet780History(compId: string, url: URL): Promise<Response> {
    const db = this.env.DTAKO_DB;
    if (!db) {
      return dvrJsonError(503, "検索カタログ (DTAKO_DB) が未設定です");
    }
    const vehicleName = url.searchParams.get("vehicleName")?.trim() || null;
    const driverCd1 = url.searchParams.get("driverCd1")?.trim() || null;

    const conditions = ["dataset = 'net780'", "comp_id = ?"];
    const params: unknown[] = [compId];
    if (vehicleName) {
      conditions.push("vehicle_name LIKE ? ESCAPE '\\'");
      params.push(`%${vehicleName.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (driverCd1) {
      conditions.push("driver_cd1 = ?");
      params.push(driverCd1);
    }

    try {
      const result = await db
        .prepare(
          `SELECT operation_no, vehicle_name, driver_cd1, driver_name1, start_datetime, r2_key, uploaded_at
           FROM dtako_uploads
           WHERE ${conditions.join(" AND ")}
           ORDER BY uploaded_at DESC
           LIMIT 200`,
        )
        .bind(...params)
        .all();
      return Response.json({ rows: result.results ?? [] });
    } catch (err) {
      console.error(JSON.stringify({ net780_history: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "検索カタログの取得に失敗しました");
    }
  }

  /** GET /net780-api/r2-view?operationNo= — 過去に**単一運行として**
   * ダウンロード済みの operationNo なら theearth に再アクセスせず R2
   * アーカイブから ZIP をそのまま返す (`extractSingleOperationZip` +
   * `parseNet780Zip` はフロント側で従来どおり実行、フォーマットは
   * ダウンロード直後の ZIP と同一)。`operationCount > 1` は Refs #299 で
   * ダウンロードを1件ずつに変更する前 (旧 handleNet780Download) が複数選択を
   * 一括で archive していた名残 — そうした旧 archive は安全に対象運行だけを
   * 取り出せない (Net780R2Index のコメント参照) ため 404 と同様にフォールバック
   * させる。未アーカイブも 404 — 呼び出し側は通常の /net780-api/download に
   * フォールバックすること。 */
  private async handleNet780R2View(compId: string, url: URL): Promise<Response> {
    const operationNo = url.searchParams.get("operationNo") ?? "";
    if (!/^\d{22}$/.test(operationNo)) {
      return dvrJsonError(400, "operationNo は22桁の数値で指定してください");
    }
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const prefix = this.env.NET780_R2_PREFIX || "net780";
    const paths = net780R2Paths(prefix, compId);
    const indexObj = await bucket.get(paths.indexObject(operationNo));
    if (!indexObj) {
      return dvrJsonError(404, "R2 にアーカイブがありません (まだダウンロードされていません)");
    }
    const index = (await indexObj.json()) as { zipKey: string; operationCount: number };
    if (index.operationCount > 1) {
      return dvrJsonError(
        404,
        "R2 アーカイブは複数運行の一括ダウンロードのため、この運行単体では安全に取り出せません",
      );
    }
    const zipObj = await bucket.get(index.zipKey);
    if (!zipObj) {
      return dvrJsonError(404, "R2 のアーカイブ本体が見つかりません (index との不整合)");
    }
    return new Response(zipObj.body, {
      headers: {
        "content-type": "application/zip",
        "cache-control": "no-store",
      },
    });
  }

  /** report 系 API 呼び出しの共通ラッパ (callDvrVenus と同型): cookie 書き戻し +
   * セッション切れ 401 / パラメータ不正 400 / その他 502 のマッピング。 */
  private async callReportAction<T>(
    record: TheearthSessionRecord,
    errorLabel: string,
    fn: (jar: CookieJar) => Promise<T>,
  ): Promise<Response> {
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    try {
      const result = await fn(jar);
      await this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
        ...record,
        cookies: Array.from(jar.cookies.entries()),
      });
      return Response.json(result);
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
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

  /** GET /daily-report-api/list?from=&to=&vehicleFrom=&vehicleTo=&driverFrom=&driverTo= — F-DES1010
   * 全ページ収集。from/to は "YYYY/MM/DD HH:mm" 形式 (harvestDailyReport の
   * HarvestRange)。読取日ソートが降順設定になっているか (`sortOk`) も併せて返す —
   * false の場合フロント側で「表示条件指定を確認してください」の警告を出す想定
   * (SKILL.md 早期打ち切りの前提)。
   *
   * F-GOS0030 の絞込条件は取得のたびに一時適用して、取得後は必ず元へ戻す
   * (`withDisplayNarrow` 参照、アカウント単位の共有設定のため)。読取日 range は
   * **常に** from/to で上書きする (共有設定に残留した読取日下限が一覧グリッドを
   * 絞り、期間外検索がエラーなく 0 件になる事故の再発防止)。vehicleFrom/vehicleTo
   * (車輌CD、両方揃った時のみ) はこれに加えて車輌絞込も適用する。絞込は btnUpdate
   * 応答 (= `firstPageHtml`) にしか反映されないため、それを harvest の 1 ページ目に
   * 流し込む。2 ページ目以降のページャ postback で絞込が維持されるかは未検証
   * (実データが 1 ページに収まり確認不能だった) なので、返す直前に車輌CD range で
   * 防御的にフィルタして「絞れていない行が混ざる」事故を塞ぐ (期間は
   * harvestDailyReport が常に workEndDateTime でフィルタ済み)。
   *
   * 同一 theearth セッションへの並行リクエストはセッションロックで hang/500 する
   * ため、必ず逐次実行する (Promise.all で並列化しない)。 */
  private handleReportList(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    const vehicleFrom = url.searchParams.get("vehicleFrom");
    const vehicleTo = url.searchParams.get("vehicleTo");
    const driverFrom = url.searchParams.get("driverFrom");
    const driverTo = url.searchParams.get("driverTo");
    return this.callReportAction(record, "運転日報の取得", async (jar) => {
      // 並び順チェック (F-GOS0030) は表示用の事前確認に過ぎない (早期打ち切りの
      // 安全性は harvestDailyReport 側の単調非増加ランタイム検証が守る) ため、
      // ここが 500 でも一覧取得全体を落とさない (staging 2026-07-10 に F-GOS0030
      // が HTTP 500 を返し続けて一覧が全滅した事象への対処)。sortOk=null で
      // 「確認できなかった」をフロントに伝える。セッション切れだけは即 401 に
      // したいので rethrow する。
      let sortOk: boolean | null = null;
      try {
        sortOk = await verifyReadNoDescending(jar);
      } catch (err) {
        if (err instanceof VenusSessionExpiredError) throw err;
        console.error("Report list sort check error (degraded to sortOk=null):", err);
      }
      // 読取日絞込は常に適用する。F-GOS0030 (アカウント共有設定) に残留した読取日
      // 下限 (実機で "26/4/29〜" を確認) が一覧グリッド自体を絞るため、明示上書き
      // しないと残留値より前の期間の検索がエラーなく 0 件になる (Refs #524)。
      const narrow: DisplayNarrow = { readDate: { from, to } };
      if (vehicleFrom && vehicleTo) narrow.vehicle = { from: vehicleFrom, to: vehicleTo };
      // 乗務員CD range (両方揃った時のみ)。グリッドが対象乗務員の行だけになり、
      // ページ送り数が激減する (全社 950 行 → 1 名 ~20 行、Refs #536)。結果の
      // 取りこぼし防止のため防御的な後段フィルタは掛けない (theearth 側の条件が
      // 乗務員2 にも一致し得るため。front 側の絞込表示がそのまま最終形になる)。
      if (driverFrom && driverTo) narrow.driver = { from: driverFrom, to: driverTo };
      const harvested = await withDisplayNarrow(
        jar,
        narrow,
        (narrowJar, firstPageHtml) =>
          harvestDailyReport(narrowJar, { from, to }, undefined, undefined, firstPageHtml),
      );
      if (vehicleFrom && vehicleTo) {
        const lo = Number(vehicleFrom);
        const hi = Number(vehicleTo);
        const rows = harvested.filter((r) => {
          const cd = r.vehicleCd === null ? Number.NaN : Number(r.vehicleCd);
          return cd >= lo && cd <= hi;
        });
        return { rows, sortOk };
      }
      return { rows: harvested, sortOk };
    });
  }

  /** GET /daily-report-api/expense?opeNo=&startOpe= — F-DES1012 給油行の現在値。 */
  private handleReportExpenseForm(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const opeNo = url.searchParams.get("opeNo") ?? "";
    const startOpe = url.searchParams.get("startOpe") ?? "";
    return this.callReportAction(record, "経費入力フォームの取得", async (jar) => {
      // theearth セッションに残る「読み込み済み運行」を解放してから開く (別運行の
      // グリッドが返る事故の根治、releaseLoadedOperation の doc 参照。Refs #540)
      await releaseLoadedOperation(jar);
      return getExpenseForm(jar, opeNo, startOpe);
    });
  }

  /** POST /daily-report-api/expense/save — `btnExpenceEditSetting` postback で
   * 給油行 1 件を登録する (body は SaveFuelRowParams)。 */
  private async handleReportExpenseSave(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: SaveFuelRowParams;
    try {
      body = (await request.json()) as SaveFuelRowParams;
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    return this.callReportAction(record, "給油行の登録", (jar) => saveFuelRow(jar, body));
  }

  /** POST /daily-report-api/expense/add — 新規行テンプレート (`itxt*`) +
   * `btnInsertButton` postback で給油行を 1 件追加する (body は AddFuelRowParams、
   * 給油 0 件の運行でも追加できる)。 */
  private async handleReportExpenseAdd(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: AddFuelRowParams;
    try {
      body = (await request.json()) as AddFuelRowParams;
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    return this.callReportAction(record, "給油行の追加", (jar) => addFuelRow(jar, body));
  }

  /** POST /daily-report-api/expense/delete — `lstFuel_btnDeleteButton_<N>` postback で
   * 給油行 1 件を削除する (body は DeleteFuelRowParams、Refs #280)。 */
  private async handleReportExpenseDelete(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: DeleteFuelRowParams;
    try {
      body = (await request.json()) as DeleteFuelRowParams;
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    return this.callReportAction(record, "給油行の削除", (jar) => deleteFuelRow(jar, body));
  }

  /** POST /daily-report-api/expense/recalculate — `btnScore` postback で評価点を
   * 再集計する (body は `{opeNo, startOpe}`)。 */
  private async handleReportExpenseRecalculate(record: TheearthSessionRecord, request: Request): Promise<Response> {
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

  /** POST /daily-report-api/expense/link-sys — `btnScore` (再集計) → `btnLinkSys`
   * (システム連動開始) の連鎖 postback (body は `{opeNo, startOpe}`)。theearth 側に
   * データを連動させる本番アクション。成功シグナル観測のため worker 側で log を厚く出す。 */
  private async handleReportSystemLink(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { opeNo?: unknown; startOpe?: unknown };
    try {
      body = (await request.json()) as { opeNo?: unknown; startOpe?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const opeNo = typeof body.opeNo === "string" ? body.opeNo : "";
    const startOpe = typeof body.startOpe === "string" ? body.startOpe : "";
    return this.callReportAction(record, "システム連動開始", (jar) => startSystemLink(jar, opeNo, startOpe));
  }

  /** GET /daily-report-api/zip — F-NOS3010 の編集後 csvdata.zip を browser に
   * ストリーム素通しする (handleDvrFile と同型、JSON でなく binary body なので
   * callReportAction ではなく専用 handler にしてある)。2 つの指定方法がある:
   *
   * - `?opeNo=&startOpe=` — **単一運行のみ** の zip (運行データ選択モード、Refs #203)
   * - `?from=&to=` — 日付範囲 ("YYYY-MM-DD"、downloadCsvZip の CsvDateRange) */
  private async handleReportZip(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const opeNo = url.searchParams.get("opeNo") ?? "";
    const startOpe = url.searchParams.get("startOpe") ?? "";
    const startDate = url.searchParams.get("from") ?? "";
    const endDate = url.searchParams.get("to") ?? "";
    const jar: CookieJar = { cookies: new Map(record.cookies) };
    const filenameSuffix = opeNo ? opeNo : record.compId;
    try {
      const bytes = opeNo
        ? await downloadOperationCsvZip(jar, { opeNo, startOpe })
        : await downloadEditedZip(jar, { startDate, endDate });
      // cookie 書き戻しはヘッダ送出をブロックしない (handleDvrFile と同じ理由)。
      this.ctx.waitUntil(
        this.ctx.storage.put<TheearthSessionRecord>(THEEARTH_SESSION_KEY, {
          ...record,
          cookies: Array.from(jar.cookies.entries()),
        }),
      );
      return new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": `attachment; filename="csvdata-${filenameSuffix}.zip"`,
          "cache-control": "no-store",
        },
      });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        await this.ctx.storage.delete(THEEARTH_SESSION_KEY);
        return dvrJsonError(401, THEEARTH_SESSION_EXPIRED_MESSAGE);
      }
      if (err instanceof ReportParamError) {
        return dvrJsonError(400, err.message);
      }
      console.error("Report zip error:", err);
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `csvdata.zip の取得に失敗しました (${describeUnknownError(err)})`;
      return dvrJsonError(502, message);
    }
  }

  /** POST /daily-report-api/unlock — F-DES1010 の行選択 + `btnInitialize`
   * postback で、対象運行 1 件だけの編集ロックを解除する (全ロック一括解放では
   * ない、cdp-pair 実機確認、Refs #183)。 */
  private async handleReportUnlock(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { opeNo?: unknown; startOpe?: unknown };
    try {
      body = (await request.json()) as { opeNo?: unknown; startOpe?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const opeNo = typeof body.opeNo === "string" ? body.opeNo : "";
    const startOpe = typeof body.startOpe === "string" ? body.startOpe : "";
    return this.callReportAction(record, "編集制御解除", async (jar) => {
      await unlockOperation(jar, { opeNo, startOpe });
      return { ok: true };
    });
  }

  /** GET /daily-report-api/work?opeNo=&startOpe= — F-DES1013 作業行の現在値
   * (Refs #170)。 */
  private handleReportWorkForm(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const opeNo = url.searchParams.get("opeNo") ?? "";
    const startOpe = url.searchParams.get("startOpe") ?? "";
    return this.callReportAction(record, "作業入力フォームの取得", async (jar) => {
      await releaseLoadedOperation(jar);
      return getWorkForm(jar, opeNo, startOpe);
    });
  }

  /** POST /daily-report-api/work/edit-start — 対象行の `btnEditButton` postback で
   * 編集モードにし、編集モード行の現在値を返す (body は `{opeNo, startOpe,
   * ctrlIndex}`、Refs #170)。応答ページは storage に保存して保存 postback で再利用。 */
  private async handleReportWorkEditStart(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { opeNo?: unknown; startOpe?: unknown; ctrlIndex?: unknown };
    try {
      body = (await request.json()) as { opeNo?: unknown; startOpe?: unknown; ctrlIndex?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const opeNo = typeof body.opeNo === "string" ? body.opeNo : "";
    const startOpe = typeof body.startOpe === "string" ? body.startOpe : "";
    const ctrlIndex = typeof body.ctrlIndex === "number" ? body.ctrlIndex : -1;
    return this.callReportAction(record, "作業行の編集開始", async (jar) => {
      const { row, editHtml } = await startWorkRowEdit(jar, { opeNo, startOpe, ctrlIndex });
      await this.ctx.storage.put<WorkEditPageRecord>(REPORT_WORK_EDIT_PAGE_KEY, {
        opeNo,
        startOpe,
        ctrlIndex,
        html: editHtml,
        savedAt: Date.now(),
      });
      return { row };
    });
  }

  /** POST /daily-report-api/work/save — 編集モード行の値を書き換えて
   * `btnUpdateButton` postback で保存する (body は SaveWorkRowParams、Refs #170)。
   * postback には handleReportWorkEditStart が保存した編集モードページを使う。 */
  private async handleReportWorkSave(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: SaveWorkRowParams;
    try {
      body = (await request.json()) as SaveWorkRowParams;
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const page = await this.ctx.storage.get<WorkEditPageRecord>(REPORT_WORK_EDIT_PAGE_KEY);
    if (!page || page.opeNo !== body.opeNo || page.startOpe !== body.startOpe || page.ctrlIndex !== body.ctrlIndex) {
      return dvrJsonError(409, "作業行の編集開始情報がありません — 行の「編集」からやり直してください");
    }
    if (Date.now() - page.savedAt > REPORT_REVISE_PAGE_TTL_MS) {
      await this.ctx.storage.delete(REPORT_WORK_EDIT_PAGE_KEY);
      return dvrJsonError(409, "作業行の編集開始から時間が経ちすぎています — 行の「編集」からやり直してください");
    }
    return this.callReportAction(record, "作業行の更新", async (jar) => {
      const result = await saveWorkRowFromPage(jar, page.html, body);
      await this.ctx.storage.delete(REPORT_WORK_EDIT_PAGE_KEY);
      return result;
    });
  }

  /** POST /daily-report-api/work/recalculate — F-DES1013 の `btnScore` postback で
   * 作業時間を再集計する (DriverState1〜5Min が更新される。body は `{opeNo, startOpe}`)。 */
  private async handleReportWorkRecalculate(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { opeNo?: unknown; startOpe?: unknown };
    try {
      body = (await request.json()) as { opeNo?: unknown; startOpe?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const opeNo = typeof body.opeNo === "string" ? body.opeNo : "";
    const startOpe = typeof body.startOpe === "string" ? body.startOpe : "";
    return this.callReportAction(record, "作業時間再集計", (jar) => recalculateWork(jar, opeNo, startOpe));
  }

  /** GET /daily-report-api/revise?opeNo=&startOpe= — F-DES1011 乗務員CD 等の現在値
   * (Refs #171)。取得時のページ HTML を DO storage に保存し、登録 postback で
   * 再利用する (F-DES1011 は最初の GET でだけ運行データがロードされるため、
   * 登録時に fresh GET し直すと初期値が空で返る。staging 実機 2026-07-10)。 */
  private handleReportReviseForm(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const opeNo = url.searchParams.get("opeNo") ?? "";
    const startOpe = url.searchParams.get("startOpe") ?? "";
    return this.callReportAction(record, "運行データ修正フォームの取得", async (jar) => {
      await releaseLoadedOperation(jar);
      const { form, pageHtml } = await getReviseFormPage(jar, opeNo, startOpe);
      await this.ctx.storage.put<RevisePageRecord>(REPORT_REVISE_PAGE_KEY, {
        opeNo,
        startOpe,
        html: pageHtml,
        savedAt: Date.now(),
      });
      return form;
    });
  }

  /** POST /daily-report-api/revise/save — `btnReg` postback で乗務員CD を登録する
   * (body は `{opeNo, startOpe, driver1}`、Refs #171)。postback には
   * handleReportReviseForm が保存した取得時ページを使う。無い/古い/別運行の
   * 場合はフォームの開き直しを促す (fresh GET へのフォールバックはしない —
   * 初期値が空のページを送って既存データを消す事故を防ぐ)。 */
  private async handleReportReviseSave(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { opeNo?: unknown; startOpe?: unknown; driver1?: unknown };
    try {
      body = (await request.json()) as { opeNo?: unknown; startOpe?: unknown; driver1?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const opeNo = typeof body.opeNo === "string" ? body.opeNo : "";
    const startOpe = typeof body.startOpe === "string" ? body.startOpe : "";
    const driver1 = typeof body.driver1 === "string" ? body.driver1 : "";

    const page = await this.ctx.storage.get<RevisePageRecord>(REPORT_REVISE_PAGE_KEY);
    if (!page || page.opeNo !== opeNo || page.startOpe !== startOpe) {
      return dvrJsonError(409, "運行データ修正フォームの取得情報がありません — モーダルを開き直してください");
    }
    if (Date.now() - page.savedAt > REPORT_REVISE_PAGE_TTL_MS) {
      await this.ctx.storage.delete(REPORT_REVISE_PAGE_KEY);
      return dvrJsonError(409, "運行データ修正フォームの取得から時間が経ちすぎています — モーダルを開き直してください");
    }
    return this.callReportAction(record, "乗務員の登録", async (jar) => {
      const result = await saveDriverFromPage(jar, page.html, { opeNo, startOpe, driver1 });
      // 使用済み viewstate は再利用しない (二重送信・stale postback 防止)。
      await this.ctx.storage.delete(REPORT_REVISE_PAGE_KEY);
      return result;
    });
  }

  /** GET /daily-report-api/masters — 事業所/車輌/乗務員マスタ (VenusBridge
   * `Request_NetDvrFuncInitValue`、/dvr-api/masters と同一実装)。乗務員CD →
   * 名称の live 解決と検索フォーム用 (Refs #171)。 */
  private handleReportMasters(record: TheearthSessionRecord): Promise<Response> {
    return this.callReportAction(record, "マスタの取得", (jar) => getDvrMasters(jar));
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
