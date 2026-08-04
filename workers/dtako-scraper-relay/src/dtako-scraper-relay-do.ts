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
  TheearthPageMismatchError,
  type CookieJar,
  type LoginResult,
  type TheearthEvidence,
} from "./theearth-client";
import {
  parseAlcUploadResponse,
  uploadDtakoZipViaAlcInternalProxy,
  type AlcUploadOutcome,
} from "./alc-internal-upload";
import {
  EtcMeisaiClientError,
  EtcMeisaiNoUsageError,
  EtcMeisaiNotCsvError,
  resolveScrapeMonthAnchor,
  scrapeEtcCsv,
  type ScrapeMonthTarget,
} from "./etc-meisai-client";
import { CronConfigError, etcCsvKey, parseDtakoAccounts, parseEtcAccounts, resolveDtakoAccountsRaw, resolveSecretBinding, type DtakoAccountEntry, type EtcAccountEntry } from "./cron";
import { scrapeJobKey } from "./scrape-dispatch";
import { buildOperationZipPayload } from "./operation-zip";
import { recalculateBeforeFetch } from "./theearth-recalculate";
import { decideRelogin, isEntryReusable, type LoginSessionEntry } from "./theearth-login-session";
import {
  DtakoReimportError,
  DtakoReimportPushUncertainError,
  isUnkoNoAcceptable,
  runDtakoReimport as runDtakoReimportPure,
  type DtakoReimportDeps,
} from "./dtako-reimport";
import {
  DtakoAlcUploadError,
  runDtakoAlcUpload as runDtakoAlcUploadPure,
  type DtakoAlcUploadDeps,
} from "./dtako-alc-upload";
import {
  BatchTooLargeError,
  assertBatchSizeWithinLimit,
  parseDtakoAlcUploadRequest,
  parseDtakoReimportRequest,
  parseOperationZipRequest,
  runBatchSequential,
  type DtakoAlcUploadItem,
  type DtakoReimportItem,
  type OperationZipItem,
} from "./cron-batch";
import { pickOnpremUnkoNoFromDayEvents } from "./dtako-day-events-lookup";
import { pickDayOperationsList } from "./dtako-day-operations-list";
import {
  annotateFoldStaleness,
  clearRunningPointer,
  MAX_SCRAPE_JOB_RECORDS,
  migrateLegacyScrapeJobsOnce,
  popNextScrapeQueueItem,
  pushScrapeQueueItem,
  recordScrapeJob,
  recoverOrphan,
  SCRAPE_JOB_KEY_PREFIX,
  SCRAPE_JOB_ORDER_KEY,
  SCRAPE_QUEUE_KEY,
  setRunningPointer,
  type QueuedScrapeItem,
  type ScrapeJobRecord,
} from "./scrape-queue";
import {
  buildDeps,
  decideFoldTrigger,
  foldMonth,
  FOLD_PAGE_MAX_DRIVERS,
  monthsCoveredByRange,
  relayKintaiDaySummaries,
  relayKintaiRecalc,
  relayKintaiStaleMonths,
  relayKintaiUnkoGaps,
  relayKintaiWindow,
  type FoldTriggerDecision,
  type KintaiRelayDeps,
} from "./kintai-relay";
import { buildScrapeErrorArtifact } from "./scrape-error-artifact";
import {
  allowedViewerComps,
  compIdsInSameTenant,
  devViewerCompIds,
  isR2OnlyRestraintPath,
} from "./restraint-viewer-auth";
import {
  buildKintaiDiff,
  buildKintaiDiffCacheSnapshot,
  deriveOpeNoFromUnkoNo,
  kintaiDiffCacheR2Paths,
  parseKintaiDiffCacheSnapshot,
  pickRecalcObservations,
  pickRestDiffGuarantee,
  type KintaiDiffCacheSnapshot,
  type KintaiDiffObservations,
  type KintaiDiffResult,
} from "./kintai-diff";
import { needsTheearthQueue } from "./restraint-queue";
import { UpstreamMemo } from "./upstream-memo";
import { measurePhase, PhaseTimer, phaseTimingLogLine } from "./phase-timing";
import {
  cacheDoNameForEmail,
  CacheStateTracker,
  gunzipText,
  gzipText,
  LocalUpstreamCache,
  parseVersionResponse,
  UpstreamCache,
  type CacheKind,
  type UpstreamCacheClient,
} from "./upstream-cache";
import { etagMatches, weakEtag } from "./http-etag";
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
  parseGapMidnightByDriver,
  parseMinusUnkoByDriver,
  parseOursOutsideByDriver,
  parsePaperDriftByDriver,
  parsePaperOutsideByDriver,
  prevYmOf,
  type KosokuShift,
} from "./kosoku-daily";
import {
  gcpPartsFor,
  overlayGcpDayTimes,
  parseGcpDaySummaries,
  type GcpDayPart,
} from "./gcp-day-summaries";
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
  recalculateWorkUnattended,
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

/** `/cron/dtako` 1 ジョブぶんの進捗 (Refs #205-43)。`ScrapeJobRecord` 本体は
 * `scrape-queue.ts` へ移設済み (Refs #205-55 — キュー/孤児回収ロジックを pure
 * module に切り出し、素の node vitest で検証できるようにするため)。 */

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

/** scrape 失敗の message と (あれば) 証拠一式を取り出す (Refs #205-52)。
 * `TheearthPageMismatchError` は「想定した form 要素が見つからなかった」時に
 * status/content-type/本文長/経過ms/ログインフォーム検出/本文抜粋を持つ —
 * **原因を断定しない代わりに、断定しなくて済むだけの事実をログに残す。** */
function describeScrapeFailure(err: unknown): { message: string; evidence?: TheearthEvidence } {
  if (err instanceof TheearthPageMismatchError) {
    return { message: err.message, evidence: err.evidence };
  }
  if (err instanceof TheearthClientError) {
    return { message: err.message };
  }
  return { message: describeUnknownError(err) };
}

/** `decideFoldTrigger` が「回さない」と決めた理由 → 進捗レコードの `fold_state`
 * (Refs #633-22)。**全部 `skipped_*`** — どれも失敗ではなく、意図して回さなかった
 * 状態を表す (`scrape-queue.ts` の `ScrapeJobRecord.fold_state` の doc 参照)。
 * 網羅を型で担保するため `Record<...>` で受ける (理由が増えたらここが型エラーになる)。 */
const FOLD_SKIP_STATE: Record<
  Exclude<FoldTriggerDecision, { run: true }>["reason"],
  NonNullable<ScrapeJobRecord["fold_state"]>
> = {
  no_upload: "skipped_no_upload",
  split_failed: "skipped_split_failed",
  out_of_scope: "skipped_out_of_scope",
};

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
   * `"on"` で kintai 系上流応答の DO SQLite キャッシュ + 条件付き再検証を有効化
   * する (Refs #543 PR-2)。off (既定・未設定) は完全に従来経路。詳細は
   * upstream-cache.ts と loadKintaiTextWithCache のコメント参照。
   */
  UPSTREAM_CACHE?: string;
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
   * ローカル開発専用: 上記の短絡時に viewer レコードへ載せる email (Refs #554)。
   * kintai 上流キャッシュは email 単位の DO に置くため、これが無いとローカルでは
   * キャッシュ経路そのものが動かない (= 検証できない)。`wrangler dev --var
   * RESTRAINT_DEV_VIEWER_EMAIL:dev@example.com` でのみ渡す。
   */
  RESTRAINT_DEV_VIEWER_EMAIL?: string;
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
  /** dtako スクレイプ失敗の原本 (ZIP でない応答 / 想定と違うページ) の R2 key
   * prefix (`dtako-scrape` / `-staging` / `-preview`、Refs #633-22)。
   * key 設計と「何を残して何を残さないか」は `scrape-error-artifact.ts` の doc 参照。 */
  DTAKO_SCRAPE_R2_PREFIX?: string;
  /** 勤怠 (fold) の対象会社。`wrangler.toml` の宣言をそのまま fold の可否判定に
   * 使う (`kintai-relay.ts` の `isFoldTargetComp`)。未設定 = 対象なし (fail-closed)。 */
  KINTAI_COMP_ID?: string;
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
  /** 取り込み成功後の勤怠 fold (Refs ohishi-exp/rust-ichibanboshi#205 の 10) を
   * 同一 DO 内で直列化する待ち行列。cron と手動 WS が同じ comp_id に同時に
   * 触っても、fold の多重起動 (重複書き込み) を防ぐ。 */
  private foldQueue = new PromiseQueue();
  /** dvr-api / daily-report-api の theearth セッション (cookie) を読み書きする
   * 処理を直列化する待ち行列。同一 DO 内で複数リクエストが並行すると
   * storage.get → theearth への実 HTTP コール → storage.put がインターリーブし、
   * 片方の書き戻しがもう片方の新しい cookie を古いスナップショットで上書きする
   * lost update が起き、theearth 側セッションが即座に無効化される (Refs #237、
   * dvr-viewer.vue の loadNotifications+loadMasters 並列発火で顕在化)。
   * scrapeQueue と同じ `PromiseQueue` 実装を利用する。 */
  private theearthQueue = new PromiseQueue();
  /** 自前ログイン経路 (`runOperationZip`/`runDtakoReimportJob`/
   * `runDtakoAlcUploadJob`、いずれも `scrapeQueue` 経由で直列化済み) が使い回す
   * theearth ログインセッション。**DO インスタンス内のメモリだけ**に置き、
   * `ctx.storage` には保存しない (`theearth-session.ts` の DO storage セッション
   * — `dvr-api`/`daily-report-api` のブラウザ由来経路、2213行付近 — とは別物。
   * こちらは今まで何も永続化していなかった posture を変えない。DO が evict
   * されたらログインし直すだけで十分。Refs #633-20)。 */
  private theearthLoginCache: LoginSessionEntry<CookieJar> | null = null;

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
        // kintai 上流キャッシュの DO 鍵 (Refs #554)。認可には使わない
        email: typeof data.email === "string" ? data.email : undefined,
      };
    } catch {
      return { active: false };
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // email 単位キャッシュ DO の内部ルート (Refs #554)。worker は /internal/ を
    // DO へ流さないので、ここへ来るのは同 namespace の DO からの stub 呼び出しだけ
    if (url.pathname.startsWith("/internal/kintai-cache/")) {
      return this.handleKintaiCacheInternal(request, url);
    }

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
    // read-only。この DO インスタンス (= 1 comp_id) の /cron/dtako 進捗を返す
    // (Refs #205-43)。認証は /cron/dtako と同じくこの worker 自身からしか
    // 到達できない前提 (index.ts の /kintai-relay/scrape-progress 側で持つ)。
    if (url.pathname === "/cron/dtako/progress" && request.method === "GET") {
      return this.handleCronDtakoProgress();
    }
    // 運行 1 件ぶんの csvdata.zip を自前ログインで取る (Refs
    // ohishi-exp/rust-ichibanboshi#274, #205 の 59)。**`/cron/dtako` と違い同期**
    // (202 で受理するだけの非同期ジョブにしない) — 取り込み (autoload への POST)
    // をしないので、破壊的操作の待ち行列に乗せる理由が無い。認証は index.ts の
    // /kintai-relay/operation-zip 側 (X-Alc-Proxy-Secret) が持つ。
    if (url.pathname === "/cron/dtako/operation-zip" && request.method === "POST") {
      return this.handleCronDtakoOperationZip(request);
    }
    // ① zip 取得 (自前ログイン) → ② オンプレ autoload push を 1 回で完結させる
    // (Refs ohishi-exp/rust-ichibanboshi#280, #205 の 67)。**書き込み (取り込み) を
    // 伴う**ので `/cron/dtako/operation-zip` と違い破壊的操作 — `scrapeQueue` で
    // 直列化する (`handleCronDtakoOperationZip` と同じキュー)。認証は index.ts の
    // /kintai-relay/dtako-reimport 側 (X-Alc-Proxy-Secret) が持つ。
    if (url.pathname === "/cron/dtako/reimport" && request.method === "POST") {
      return this.handleCronDtakoReimport(request);
    }
    // ① zip 取得 (自前ログイン) → ② alc 投入 (`/api/upload`) を運行1件で完結させる
    // (Refs #633-7)。`handleCronDtakoReimport` (オンプレ autoload 向け) と対だが、
    // 投入先が alc なので unko_no は要らない (`/api/upload` は zip 内の
    // KUDGURI.csv から読む)。書き込み (取り込み) を伴うので `scrapeQueue` で直列化。
    // 認証は index.ts の /kintai-relay/dtako-alc-upload 側 (X-Alc-Proxy-Secret) が持つ。
    if (url.pathname === "/cron/dtako/alc-upload" && request.method === "POST") {
      return this.handleCronDtakoAlcUpload(request);
    }
    if (url.pathname === "/cron/etc" && request.method === "POST") {
      return this.handleCronEtc(request);
    }

    // 拘束サマリの写し (R2 kintai/ prefix) を無人で押し直す (Refs #606-6)。
    // dtako グループとは無関係だが、認証・到達性の作法 (index.ts の
    // /kintai-relay/restraint-sync 側で X-Alc-Proxy-Secret を検証、この worker
    // 自身からしか到達できない) は /cron/dtako/* と同じなのでこの並びに置く。
    if (url.pathname === "/cron/restraint-sync" && request.method === "POST") {
      return this.handleCronRestraintSync(request);
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

    // どちらの経路に入ったかを必ず残す。SCRAPER_MODE の実効値が分からないまま
    // 「WS が無言で閉じる」を追うと切り分けに時間がかかる (2026-07-30 の調査)。
    console.log(
      `DtakoScraperRelayDO route: mode=${this.env.SCRAPER_MODE ?? "(unset)"} kind=${kind ?? "(none)"} comp_id=${url.searchParams.get("comp_id") ?? "(none)"}`,
    );
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
    let upstreamRes: Response;
    try {
      upstreamRes = await this.env.DTAKO_SCRAPER_VPC.fetch(upstreamUrl, {
        headers: { Upgrade: "websocket" },
      });
    } catch (err) {
      // fetch 自体の throw (VPC binding の解決失敗・上流ダウン等)。従来はそのまま
      // 上位に飛んで DO の unhandled になり、browser には何も届かなかった。
      console.error(
        `DtakoScraperRelayDO connectVpcRelay fetch threw: url=${upstreamUrl} err=${err instanceof Error ? err.message : String(err)}`,
      );
      return this.rejectWithReason(
        "上流スクレイパー (dtako-scraper) に接続できません (VPC binding の fetch が失敗)",
      );
    }
    const upstreamWs = upstreamRes.webSocket;
    if (!upstreamWs) {
      // 502 を返すと browser 側は「メッセージ 0 件で切断」しか観測できず、
      // `handshake failed (comp_id 不正 / 認証エラー等)` という無関係な推測文言が
      // 表示される。実際の理由 (上流が WS upgrade を返さなかった) を WS で伝える。
      console.error(
        `DtakoScraperRelayDO connectVpcRelay no webSocket in upstream response: url=${upstreamUrl} status=${upstreamRes.status}`,
      );
      return this.rejectWithReason(
        `上流スクレイパー (dtako-scraper) が WebSocket を返しませんでした (status=${upstreamRes.status})`,
      );
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

    // このインスタンスに触れる経路 (WS 手動・/cron/dtako どちらか先に来た方) が
    // 一度だけ移送する (Refs #205-55 条件10)。compId を知っているのはここと
    // handleCronDtako だけ — alarm() 単体では compId を復元できない
    // (`migrateLegacyScrapeJobsOnce` の docs 参照)。
    await migrateLegacyScrapeJobsOnce(this.ctx.storage, compId);

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

    // この comp_id への初回アクセスなら、この PR より前に投入された孤児
    // (`scrape-job:*` の pending/running) を新キューへ一度だけ移送する (Refs
    // #205-55 条件10)。
    await migrateLegacyScrapeJobsOnce(this.ctx.storage, compId);

    // 受理した時点で pending を記録する。**waitUntil の外で await** — ここで
    // 待たないと、202 を返した直後に progress を引いても pending すら見えない
    // (Refs #205-43)。書き込み自体の失敗は recordScrapeJob 内で握って本体を止めない。
    //
    // **実行はここではもう起こさない。** キューの実体は storage (`scrape-queue`)
    // に置き、`alarm()` が drain する (Refs #205-55) — DO が deploy/evict で
    // 再作成されても、メモリ上の `waitUntil` ではなく storage + alarm が実行を
    // 引き継ぐ。
    const jobKey = scrapeJobKey(startDate, endDate);
    await recordScrapeJob(this.ctx.storage, jobKey, { state: "pending" });
    await pushScrapeQueueItem(this.ctx.storage, { jobKey, compId, startDate, endDate });
    return Response.json({ accepted: true, comp_id: compId }, { status: 202 });
  }

  private async runCronDtakoScrape(
    account: DtakoAccountRaw,
    range: { startDate: string; endDate: string },
    jobKey: string,
  ): Promise<void> {
    const logBase = { cron: "dtako", comp_id: account.comp_id, range: `${range.startDate}..${range.endDate}` };
    // started_at / phase を記録する (Refs #205-55 条件3)。phase は "pre_upload"
    // から始める — まだ破壊的操作 (has_kudgivt リセット) に触れていない。
    await recordScrapeJob(this.ctx.storage, jobKey, {
      state: "running",
      started_at: new Date().toISOString(),
      phase: "pre_upload",
    });
    // 段階別 (login/csv_get/stage1/stage2) の所要 ms (Refs #205-52)。成功/失敗
    // どちらでも finally で 1 行出す — **失敗時のログだけで「どの段が何ms掛かったか
    // (= timeout に当たったか当たっていないか)」の両方向が読める**ようにする。
    const timer = new PhaseTimer();
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
        undefined,
        {},
        timer,
      );

      const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
      if (!sharedSecret) {
        const message = "INTERNAL_SHARED_SECRET 未設定のためアップロード不能 (zip は破棄)";
        console.error(JSON.stringify({ ...logBase, status: "error", message }));
        await recordScrapeJob(this.ctx.storage, jobKey, { state: "failed", error: message });
        return;
      }
      // ★ 破壊的操作 (has_kudgivt を FALSE に戻すアップロード) の fetch を発火する
      // 直前。alc の process_zip はリクエストが届いた時点で有効になるので、
      // **応答を待たずに DO が死んでも「壊した後」と正しく判定できるよう**、
      // 発火前に必ず phase を post_upload へ倒しておく (Refs #205-55)。
      await recordScrapeJob(this.ctx.storage, jobKey, { state: "running", phase: "post_upload" });
      const uploadBody = await uploadDtakoZipViaAlcInternalProxy(
        { sharedSecret, tenantId: account.tenant_id, filename: "csvdata.zip", zipBytes: zip },
        this.env.AUTH_WORKER.fetch.bind(this.env.AUTH_WORKER),
      );
      const outcome = parseAlcUploadResponse(uploadBody);
      const line = {
        ...logBase,
        zip_bytes: zip.byteLength,
        upload: uploadBody.slice(0, 200),
        upload_id: outcome.uploadId,
        split_failed: outcome.splitFailed,
      };
      // cron には画面もリトライの当てもない (`/api/split-csv/{id}` は
      // alc-internal-proxy の path allowlist に無いので DO からは 403、Refs
      // #205-40) ので、**分割の失敗は error レベルで鳴らす**。握り潰すと該当運行が
      // 読み取り側 (has_kudgivt = TRUE 絞り) から黙って消える。復旧は管理画面の
      // 「CSV分割」/「未分割をまとめて分割」で行う。診断ログは Tail Worker 側に出る。
      //
      // **進捗としては `done`。** アップロード自体は成功しているので、
      // split_failed の件数はレコードに残すだけで state は failed にしない
      // (get_dtako_scrape_status の split_failed / unsplit_total 側の役目)。
      if (outcome.splitFailed !== null && outcome.splitFailed > 0) {
        console.error(
          JSON.stringify({
            ...line,
            status: "split_failed",
            message: `取り込みは成功したが CSV 分割が ${outcome.splitFailed} 件失敗した (該当運行が読み取り側から消える)`,
          }),
        );
      } else {
        console.log(JSON.stringify({ ...line, status: "success" }));
      }
      await recordScrapeJob(this.ctx.storage, jobKey, {
        state: "done",
        upload_id: outcome.uploadId,
        split_failed: outcome.splitFailed,
      });
      // 取り込み本体はここで完了済み (state: "done" 記録済み)。この先で fold が
      // 何をしようと、上の記録は変わらない (条件3: fold 失敗が取り込みを道連れ
      // にしない)。cron 経路は元々 ctx.waitUntil の中なので、ここで await して
      // 待ち時間を伸ばして良い (WS 経路の executeScrape とは違い、閉じるべき
      // 接続が無い)。
      //
      // **二重に catch する。** `foldAfterIngest` 自身が全部 catch する設計だが、
      // ここは既に取り込み成功を記録した"後"の try ブロック内 — 万一
      // `foldAfterIngest` が想定外に throw すると、下の catch が取り込みの
      // 成否を "failed" で上書きしてしまう (条件3 違反)。それを避けるための
      // 保険。
      try {
        await this.foldAfterIngest(account, range, jobKey, outcome);
      } catch (foldErr) {
        console.error(
          JSON.stringify({
            kintai_fold: "unexpected_error_outer",
            comp_id: account.comp_id,
            error: describeUnknownError(foldErr),
          }),
        );
      }
    } catch (err) {
      const { message, evidence } = describeScrapeFailure(err);
      // 原本を R2 へ残す (Refs #633-22)。**console だけでは数日で消える** —
      // Tail Worker は Workers Logs へ転写するだけで保存しないので、2026-08-01 の
      // `id=rdoSelect1 が見つかりません` は 3 日後には原本がどこにも無かった。
      // 何を残して何を残さないか (空 ZIP は残さない等) は `scrape-error-artifact.ts`。
      const artifactKey = await this.saveScrapeErrorArtifact(err, account.comp_id, jobKey);
      // evidence がある時 (= TheearthPageMismatchError) だけ本文抜粋/status/
      // content-type/経過msをログに載せる。DO storage の `error` は短い要約のみ
      // (Refs #205-52 条件6 — 本文は response 由来なので credential は含まないが、
      // 進捗レコードを肥大させない)。**`bodyPrefix` は載せない** — 生の HTML は
      // R2 側の役目 (ログを膨らませない)。
      console.error(
        JSON.stringify({
          ...logBase,
          status: "error",
          message,
          ...(evidence ? { evidence } : {}),
          ...(artifactKey ? { error_artifact: artifactKey } : {}),
        }),
      );
      await recordScrapeJob(this.ctx.storage, jobKey, { state: "failed", error: message });
    } finally {
      const { phases, totalMs } = timer.report();
      console.log(JSON.stringify({ ...logBase, scrape_phase_timing: phases, total_ms: totalMs }));
    }
  }

  /**
   * スクレイプ失敗の原本を R2 へ保存する (Refs #633-22)。保存した key を返す
   * (保存しなかった / できなかった時は `null`)。
   *
   * **失敗しても本体を止めない。** これは診断のための書き込みで、ここで throw
   * すると「取り込みが落ちた理由」より「証拠が保存できなかった」が上に出てしまう
   * (`recordScrapeJob` と同じ流儀、Refs #205-43 条件3)。ETC の
   * `EtcMeisaiNotCsvError` 保存も同型で握っている。
   */
  private async saveScrapeErrorArtifact(
    err: unknown,
    compId: string,
    jobKey: string,
  ): Promise<string | null> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return null;
    const artifact = buildScrapeErrorArtifact(err, {
      prefix: this.env.DTAKO_SCRAPE_R2_PREFIX || "dtako-scrape",
      compId,
      jobKey,
      nowMs: Date.now(),
    });
    if (!artifact) return null;
    try {
      await bucket.put(artifact.key, artifact.body, {
        httpMetadata: { contentType: artifact.contentType },
      });
      return artifact.key;
    } catch (putErr) {
      console.error(
        JSON.stringify({
          scrape_error_artifact: "put_failed",
          comp_id: compId,
          job: jobKey,
          key: artifact.key,
          error: describeUnknownError(putErr),
        }),
      );
      return null;
    }
  }

  /**
   * 取り込み (アップロード) 成功後に勤怠の畳み直しを蹴る (Refs
   * ohishi-exp/rust-ichibanboshi#205 の 10)。
   *
   * **取り込み本体を絶対に道連れにしない** — 呼び出し元は取り込みの成否記録を
   * 終えた"後"にこれを呼ぶこと。ここでは例外を外へ投げない (全部 catch する)。
   *
   * **`split_failed > 0` の間は skip する。** rust-alc-api の
   * `has_kudgivt = TRUE` フィルタにより、split が終わっていない運行は fold の
   * 入力 (`GET /api/dtako/events`) からそもそも見えない (`decideFoldTrigger` の
   * docs 参照、`rust-alc-api/crates/alc-dtako/src/dtako_events.rs` で確認済み)。
   * ここで畳むと「不完全なデータで上書きし、しかも成功したように見える」—
   * 何もしない方がまだマシ、という判断 (Refs #205 監督)。
   */
  private async foldAfterIngest(
    account: DtakoAccountRaw,
    range: { startDate: string; endDate: string },
    jobKey: string,
    uploadOutcome: AlcUploadOutcome | null,
  ): Promise<void> {
    try {
      // **`KINTAI_COMP_ID` の宣言をそのまま判定に使う** (値をコピーしない、
      // Refs #633-22)。対象外の会社で fold を回すと畳み先が 403 を返し、恒久的な
      // `fold_state: "failed"` になって本物の失敗が埋もれる (`isFoldTargetComp` の doc)。
      const decision = decideFoldTrigger(uploadOutcome, {
        compId: account.comp_id,
        kintaiCompId: this.env.KINTAI_COMP_ID,
      });
      if (!decision.run) {
        await recordScrapeJob(this.ctx.storage, jobKey, {
          state: "done",
          fold_state: FOLD_SKIP_STATE[decision.reason],
        });
        return;
      }

      const months = monthsCoveredByRange(range.startDate, range.endDate);
      if (months.length === 0) {
        await recordScrapeJob(this.ctx.storage, jobKey, {
          state: "done",
          fold_state: "failed",
          fold_error: `不正な日付範囲: ${range.startDate}..${range.endDate}`,
        });
        return;
      }

      // 同一 comp_id (= この DO インスタンス) 内で fold の多重起動を防ぐ
      // (cron と手動 WS が同時に触っても直列に捌く、scrapeQueue と同じ理由)。
      await this.foldQueue.enqueue(() => this.runFoldMonths(account, jobKey, months));
    } catch (err) {
      console.error(
        JSON.stringify({
          kintai_fold: "unexpected_error",
          comp_id: account.comp_id,
          error: describeUnknownError(err),
        }),
      );
    }
  }

  /**
   * [`foldAfterIngest`] からキュー越しに呼ばれる本体。対象月ぶんを順に
   * `foldMonth` (`kintai-relay.ts`) へ渡す。1 か月あたりのページ数上限は
   * `foldMonth` 側が持つ — ここでは複数月ぶんの結果を合算して記録するだけ。
   *
   * `relayKintaiRecalc` / `buildDeps` を HTTP self-call (`/kintai-relay/recalc`)
   * 経由にしないのは、この DO が既に `DTAKO_ACCOUNTS` から引いた
   * `account.tenant_id` を持っているため — `/kintai-relay/recalc` は
   * `env.KINTAI_COMP_ID` という単一 tenant 前提の口 (MCP tool 用) で、この DO の
   * ような複数 comp_id/tenant を跨ぐ呼び出し元には合わない。
   */
  private async runFoldMonths(
    account: DtakoAccountRaw,
    jobKey: string,
    months: string[],
  ): Promise<void> {
    await recordScrapeJob(this.ctx.storage, jobKey, {
      state: "done",
      fold_state: "running",
      fold_started_at: new Date().toISOString(),
      fold_months: months,
    });
    try {
      const origin = (this.env.NUXT_ICHIBAN_API_URL ?? "").trim();
      const cfAccessClientId = (this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID ?? "").trim();
      const [sharedSecret, cfAccessClientSecret] = await Promise.all([
        resolveSecret(this.env.INTERNAL_SHARED_SECRET),
        resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET),
      ]);
      if (!origin || !cfAccessClientId || !sharedSecret || !cfAccessClientSecret) {
        await recordScrapeJob(this.ctx.storage, jobKey, {
          state: "done",
          fold_state: "not_configured",
          fold_error:
            "NUXT_ICHIBAN_API_URL / NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID / ICHIBAN_CF_ACCESS_CLIENT_SECRET / INTERNAL_SHARED_SECRET のいずれかが未設定",
        });
        return;
      }

      const deps = buildDeps({
        ichibanOrigin: origin,
        cfAccessClientId,
        cfAccessClientSecret,
        authWorker: this.env.AUTH_WORKER,
        proxySecret: sharedSecret,
        tenantId: account.tenant_id,
      });

      let totalPages = 0;
      let totalDriversWritten = 0;
      let anyCapped = false;
      for (const month of months) {
        const report = await foldMonth(deps, { month, apply: true });
        totalPages += report.pages + (report.attemptedGateClose ? 1 : 0);
        totalDriversWritten += report.driversWritten;
        if (report.capped) anyCapped = true;
        console.log(
          JSON.stringify({ kintai_fold: "month_done", comp_id: account.comp_id, ...report }),
        );
      }

      await recordScrapeJob(this.ctx.storage, jobKey, {
        state: "done",
        fold_state: anyCapped ? "capped" : "done",
        fold_pages: totalPages,
        fold_drivers_written: totalDriversWritten,
      });
    } catch (err) {
      const message = describeUnknownError(err);
      console.error(
        JSON.stringify({ kintai_fold: "failed", comp_id: account.comp_id, months, message }),
      );
      await recordScrapeJob(this.ctx.storage, jobKey, { state: "done", fold_state: "failed", fold_error: message });
    }
  }

  /** GET /cron/dtako/progress — この DO インスタンス (= 1 comp_id) の
   * `/cron/dtako` 進捗一覧。read-only (Refs #205-43)。 */
  private async handleCronDtakoProgress(): Promise<Response> {
    try {
      const order = (await this.ctx.storage.get<string[]>(SCRAPE_JOB_ORDER_KEY)) ?? [];
      const records = await Promise.all(
        order.map((d) => this.ctx.storage.get<ScrapeJobRecord>(SCRAPE_JOB_KEY_PREFIX + d)),
      );
      const queue = records
        .filter((r): r is ScrapeJobRecord => r != null)
        .map((r) => annotateFoldStaleness(r, Date.now()));
      const counts = { pending: 0, running: 0, done: 0, failed: 0 };
      for (const r of queue) counts[r.state] += 1;
      return Response.json({
        queue,
        ...counts,
        max_records: MAX_SCRAPE_JOB_RECORDS,
      });
    } catch (err) {
      console.error(
        `DtakoScraperRelayDO handleCronDtakoProgress failed: ${describeUnknownError(err)}`,
      );
      return Response.json({ error: "進捗の読み出しに失敗しました" }, { status: 500 });
    }
  }

  /** 1 job (`runOperationZip`/`runDtakoReimportJob`/`runDtakoAlcUploadJob` の
   * 1 回の実行) の間だけ生きる、再ログイン予算とログイン実績のカウンタ。
   * `theearth-login-session.ts` の判定 (`decideRelogin`) が読む
   * `reloginAttempts` と、応答/ログに載せる `logins` を持つ。job ごとに
   * 呼び出し側 (`runOperationZip` 等) が新規に作る — DO インスタンスを跨いで
   * 持ち越さない。 */
  private makeTheearthLoginJobState(): { reloginAttempts: number; logins: Array<LoginResult & { at: number }> } {
    return { reloginAttempts: 0, logins: [] };
  }

  /** 自前ログインを実行し、`this.theearthLoginCache` を更新する。ログインの
   * たびに `kicked`/`kickedUserName` を構造化ログへ出す (issue #633-20 の
   * 「代わりに可視化する」節 — 繰り返し蹴っていることが黙って進まないように
   * するのが目的)。 */
  private async freshTheearthLoginSession(
    account: DtakoAccountRaw,
    jobState: { reloginAttempts: number; logins: Array<LoginResult & { at: number }> },
  ): Promise<LoginSessionEntry<CookieJar>> {
    const jar = createCookieJar();
    const result = await login(jar, {
      compId: account.comp_id,
      userName: account.user_name,
      userPass: account.user_pass,
    });
    const now = Date.now();
    jobState.logins.push({ ...result, at: now });
    console.log(
      JSON.stringify({
        theearth_login_session: "login",
        comp_id: account.comp_id,
        kicked: result.kicked,
        kicked_user_name: result.kickedUserName ?? null,
        logins_this_job: jobState.logins.length,
      }),
    );
    const entry: LoginSessionEntry<CookieJar> = { compId: account.comp_id, jar, loggedInAt: now, lastUsedAt: now };
    this.theearthLoginCache = entry;
    return entry;
  }

  /**
   * theearth を叩く 1 操作 (`recalculateWork`/`downloadOperationCsvZip` 等) を、
   * DO インスタンス内で使い回しているログインセッション経由で実行する
   * (Refs #633-20)。判定ロジック本体は `theearth-login-session.ts`
   * (`isEntryReusable`/`decideRelogin`) — ここは配線だけ:
   *
   * 1. 使い回せるキャッシュがあればそれを使う。無ければ新規ログイン
   * 2. `run` が成功したら `lastUsedAt` を更新して返す (idle TTL の起点)
   * 3. `VenusSessionExpiredError` を受けたらキャッシュを破棄し、
   *    `decideRelogin` (予算 + 最短寿命ガード) が許可した時だけ**1 回だけ**
   *    再ログインして**同じ操作を1回だけ**やり直す。拒否されたら
   *    理由をログに残して元の例外をそのまま投げる (呼び出し元が 401 に
   *    マップする、既存の挙動を変えない)
   *
   * **`scrapeQueue` (`enqueueScrape`) の直列化の中でしか呼ばれない** — 同一
   * comp_id への並行呼び出しは無いので、`this.theearthLoginCache` の
   * 読み書きに新しいロックは要らない。
   */
  private async withTheearthLoginSession<T>(
    account: DtakoAccountRaw,
    jobState: { reloginAttempts: number; logins: Array<LoginResult & { at: number }> },
    run: (jar: CookieJar) => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const entry = isEntryReusable(this.theearthLoginCache, account.comp_id, now)
      ? this.theearthLoginCache!
      : await this.freshTheearthLoginSession(account, jobState);
    try {
      const result = await run(entry.jar);
      entry.lastUsedAt = Date.now();
      return result;
    } catch (err) {
      if (!(err instanceof VenusSessionExpiredError)) throw err;
      if (this.theearthLoginCache === entry) this.theearthLoginCache = null;
      const decision = decideRelogin(entry, Date.now(), jobState.reloginAttempts);
      console.error(
        JSON.stringify({
          theearth_login_session: "session_expired",
          comp_id: account.comp_id,
          relogin_allowed: decision.allow,
          relogin_reason: decision.reason ?? null,
          relogin_attempts_used: jobState.reloginAttempts,
        }),
      );
      if (!decision.allow) throw err;
      jobState.reloginAttempts++;
      const freshEntry = await this.freshTheearthLoginSession(account, jobState);
      const result = await run(freshEntry.jar);
      freshEntry.lastUsedAt = Date.now();
      return result;
    }
  }

  /**
   * POST /cron/dtako/operation-zip — body {comp_id, ope_no, start_ope} (単体) か
   * {comp_id, items: [{ope_no, start_ope, recalculate?}, ...]} (バッチ、Refs
   * #633)。運行 1 件ぶんの csvdata.zip を**自前ログイン**で取る (Refs
   * ohishi-exp/rust-ichibanboshi#274, #205 の 59)。`handleReportZip`
   * (`/daily-report-api/zip`) はブラウザ由来の `TheearthSessionRecord` (別 DO
   * instance `theearth-{comp}:{userB64}`) に依存するため使えない — こちらは
   * `runCronDtakoScrape` と同じ「comp_id 単位 DO + 都度 `login()`」の型を採る。
   *
   * **単体形式の body/応答は `items` 追加前と 1 バイトも変えていない**
   * (`parseOperationZipRequest` が単体形式を解いた時は既存の
   * `runOperationZip` をそのまま呼ぶ、body の判定・正規化ロジックは
   * `cron-batch.ts` の pure 関数でテスト済み)。
   *
   * **`scrapeQueue` (`enqueueScrape`) で直列化する** — 同一 comp_id への並行
   * theearth リクエストはセッションロックで hang/500 する (`downloadCsvZip` の
   * doc comment 参照)。cron scrape (`/cron/dtako`) と同じキューを共有するため、
   * 窓の無人取り直しと本経路が同時に来ても直列に捌かれる。**取り込み
   * (`autoload` への POST) はしない** — `downloadOperationCsvZip` が返す zip を
   * 応答に載せるだけの read-only な操作。
   */
  private async handleCronDtakoOperationZip(request: Request): Promise<Response> {
    let body: { comp_id?: unknown; ope_no?: unknown; start_ope?: unknown; recalculate?: unknown; items?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "JSON body が必要です" }, { status: 400 });
    }
    const parsed = parseOperationZipRequest(body);
    if ("error" in parsed) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }

    const account = await this.resolveAccount(parsed.compId);
    if (!account) {
      return Response.json({ error: `comp_id=${parsed.compId} が DTAKO_ACCOUNTS に見つかりません` }, { status: 500 });
    }

    if (!parsed.isBatch) {
      const { opeNo, startOpe, recalculate } = parsed.items[0];
      return this.enqueueScrape(() => this.runOperationZip(account, opeNo, startOpe, recalculate));
    }
    try {
      assertBatchSizeWithinLimit(parsed.items.length);
    } catch (err) {
      if (err instanceof BatchTooLargeError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
    return this.enqueueScrape(() => this.runOperationZipBatch(account, parsed.items));
  }

  private async runOperationZip(
    account: DtakoAccountRaw,
    opeNo: string,
    startOpe: string,
    recalculate: boolean,
  ): Promise<Response> {
    const jobState = this.makeTheearthLoginJobState();
    // recalculateBeforeFetch は成否 (ok/error) だけを畳んで返し、内側の resolved
    // value (unlocked/selfUnlocked) は捨てる — ログに出すためクロージャの外の
    // 可変オブジェクトで受け取る (jobState.logins と同じ流儀。let 変数への
    // 再代入だと closure 経由の代入を型が追い切れないため object にする、Refs #633-23)。
    const unlockInfo: { unlocked: boolean | null; selfUnlocked: boolean | null } = {
      unlocked: null,
      selfUnlocked: null,
    };
    try {
      const recalculateResult = recalculate
        ? await recalculateBeforeFetch(() =>
            this.withTheearthLoginSession(account, jobState, async (jar) => {
              // セッションに前回の運行が読み込み済みのまま残っていると、そちらが
              // 再集計される (Refs #633-23、theearth-venus skill「運行はセッションに
              // 1件だけ…」節)。処理後も解放し、他セッションを空ページ+HTTP 500 で
              // ブロックしたままにしない。
              await releaseLoadedOperation(jar);
              const result = await recalculateWorkUnattended(jar, opeNo, startOpe);
              unlockInfo.unlocked = result.unlocked;
              unlockInfo.selfUnlocked = result.selfUnlocked;
              await releaseLoadedOperation(jar);
              return result;
            }),
          )
        : null;
      if (recalculateResult && !recalculateResult.ok) {
        console.error(
          JSON.stringify({
            operation_zip: "recalculate_failed",
            comp_id: account.comp_id,
            ope_no: opeNo,
            message: recalculateResult.error,
          }),
        );
      }
      const zip = await this.withTheearthLoginSession(account, jobState, (jar) =>
        downloadOperationCsvZip(jar, { opeNo, startOpe }),
      );
      const payload = buildOperationZipPayload(zip);
      console.log(
        JSON.stringify({
          operation_zip: "ok",
          comp_id: account.comp_id,
          ope_no: opeNo,
          recalculate_ok: recalculateResult?.ok ?? null,
          bytes: payload.bytes,
          omitted: payload.omitted,
          entries: payload.entries,
          theearth_logins: jobState.logins.length,
          theearth_kicked: jobState.logins.some((l) => l.kicked),
          // btnInitialize は他ユーザーの正当なロックも解除しうるため、呼んだ
          // かどうかを必ず可視化する (#642 の theearth_kicked と同じ理由、Refs #633-23)。
          theearth_unlocked: unlockInfo.unlocked,
          theearth_self_unlocked: unlockInfo.selfUnlocked,
        }),
      );
      return Response.json({
        ok: true,
        comp_id: account.comp_id,
        ope_no: opeNo,
        start_ope: startOpe,
        recalculate: recalculateResult,
        bytes: payload.bytes,
        zip_base64: payload.zipBase64,
        omitted: payload.omitted,
        limit_bytes: payload.limitBytes,
        entries: payload.entries,
        theearth_logins: jobState.logins.length,
        theearth_kicked: jobState.logins.some((l) => l.kicked),
        // 構造化ログ (上の console.log) にしか出ていなかった抜けを直す (Refs #633-24)。
        theearth_unlocked: unlockInfo.unlocked,
        theearth_self_unlocked: unlockInfo.selfUnlocked,
      });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        return Response.json({ error: THEEARTH_SESSION_EXPIRED_MESSAGE }, { status: 401 });
      }
      if (err instanceof ReportParamError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      const message =
        err instanceof TheearthClientError ? err.message : `csvdata.zip の取得に失敗しました (${describeUnknownError(err)})`;
      console.error(
        JSON.stringify({ operation_zip: "failed", comp_id: account.comp_id, ope_no: opeNo, message }),
      );
      return Response.json({ error: message }, { status: 502 });
    }
  }

  /**
   * バッチ版 `runOperationZip` (Refs #633)。`items` を 1 つの job (= 1 回の
   * `enqueueScrape`) の中で直列に処理する — ログインセッション (`jobState`) を
   * 全件で共有するので、theearth へのログインは通常 1 回で済む (#642 が既に
   * 達成済みの効果を、バッチにすることで HTTP 往復も 1 回にまとめる)。
   *
   * **`zip_base64` は載せない** (親指示5) — 20 件分の base64 で応答が膨れて
   * 転記事故を誘発するため。中身が要る運行だけ単体形式で取り直すこと。
   */
  private async runOperationZipBatch(account: DtakoAccountRaw, items: OperationZipItem[]): Promise<Response> {
    const jobState = this.makeTheearthLoginJobState();
    const batch = await runBatchSequential(items, async (item, index) => {
      const unlockInfo: { unlocked: boolean | null; selfUnlocked: boolean | null } = {
        unlocked: null,
        selfUnlocked: null,
      };
      const recalculateResult = item.recalculate
        ? await recalculateBeforeFetch(() =>
            this.withTheearthLoginSession(account, jobState, async (jar) => {
              await releaseLoadedOperation(jar);
              const result = await recalculateWorkUnattended(jar, item.opeNo, item.startOpe);
              unlockInfo.unlocked = result.unlocked;
              unlockInfo.selfUnlocked = result.selfUnlocked;
              await releaseLoadedOperation(jar);
              return result;
            }),
          )
        : null;
      if (recalculateResult && !recalculateResult.ok) {
        console.error(
          JSON.stringify({
            operation_zip_batch: "recalculate_failed",
            comp_id: account.comp_id,
            ope_no: item.opeNo,
            index,
            message: recalculateResult.error,
          }),
        );
      }
      const zip = await this.withTheearthLoginSession(account, jobState, (jar) =>
        downloadOperationCsvZip(jar, { opeNo: item.opeNo, startOpe: item.startOpe }),
      );
      const payload = buildOperationZipPayload(zip);
      console.log(
        JSON.stringify({
          operation_zip_batch: "ok",
          comp_id: account.comp_id,
          ope_no: item.opeNo,
          index,
          recalculate_ok: recalculateResult?.ok ?? null,
          bytes: payload.bytes,
          omitted: payload.omitted,
          theearth_unlocked: unlockInfo.unlocked,
          theearth_self_unlocked: unlockInfo.selfUnlocked,
        }),
      );
      return {
        ope_no: item.opeNo,
        start_ope: item.startOpe,
        recalculate: recalculateResult,
        bytes: payload.bytes,
        omitted: payload.omitted,
        entries: payload.entries,
        // 構造化ログ (上の console.log) にしか出ていなかった抜けを直す (Refs #633-24)。
        // バッチは項目ごとに値が異なりうるので、単体形式の「応答トップレベル」
        // ではなく results[i] (この item の結果オブジェクト) に載せる。
        theearth_unlocked: unlockInfo.unlocked,
        theearth_self_unlocked: unlockInfo.selfUnlocked,
      };
    });

    const successCount = batch.results.filter((r) => r.ok).length;
    console.log(
      JSON.stringify({
        operation_zip_batch: "done",
        comp_id: account.comp_id,
        item_count: items.length,
        success_count: successCount,
        failure_count: batch.results.length - successCount,
        truncated: batch.truncated,
        remaining: batch.remaining,
        theearth_logins: jobState.logins.length,
        theearth_kicked: jobState.logins.some((l) => l.kicked),
      }),
    );
    return Response.json({
      ok: true,
      comp_id: account.comp_id,
      results: batch.results,
      success_count: successCount,
      failure_count: batch.results.length - successCount,
      truncated: batch.truncated,
      remaining: batch.remaining,
      theearth_logins: jobState.logins.length,
      theearth_kicked: jobState.logins.some((l) => l.kicked),
    });
  }

  /**
   * POST /cron/dtako/reimport — body {comp_id, ope_no, start_ope, unko_no,
   * reset_timecard?} (単体) か {comp_id, items: [{ope_no, start_ope, unko_no,
   * reset_timecard?}, ...]} (バッチ、Refs #633)。運行 1 件の csvdata.zip を
   * **自前ログイン**で取得し、オンプレ rust-ichibanboshi の
   * `POST /api/dtako/autoload` (Refs #205 の 58/61/63/65、**変更しない**) へ
   * そのまま push する (Refs ohishi-exp/rust-ichibanboshi#280、#205 の 67)。
   *
   * **単体形式の body/応答は `items` 追加前と 1 バイトも変えていない**
   * (`parseDtakoReimportRequest` 参照。`unko_no` は `reimport` にだけ必須 —
   * バッチでも省略できない)。
   *
   * `runOperationZip` と同じ「comp_id 単位 DO + 都度 `login()`」だが、こちらは
   * **取り込みまで実行する**破壊的操作なので、同じ `scrapeQueue` で直列化しつつも
   * 応答は同期で返す (受理しただけの 202 にしない — 呼び出し元がその場で
   * entries / 取り込み結果を見られるようにする)。
   */
  private async handleCronDtakoReimport(request: Request): Promise<Response> {
    let body: {
      comp_id?: unknown;
      ope_no?: unknown;
      start_ope?: unknown;
      unko_no?: unknown;
      reset_timecard?: unknown;
      items?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "JSON body が必要です" }, { status: 400 });
    }
    const parsed = parseDtakoReimportRequest(body);
    if ("error" in parsed) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }

    const account = await this.resolveAccount(parsed.compId);
    if (!account) {
      return Response.json({ error: `comp_id=${parsed.compId} が DTAKO_ACCOUNTS に見つかりません` }, { status: 500 });
    }

    // オンプレの資格情報 (Refs #280 の条件1 — kosoku-daily/pdf-json 等の既存経路と
    // 同じ CF Access Service Token、新しい credential/allowlist 登録は不要)。
    // Secrets Store binding は「宣言はあるが解決できない」時に throw するので、
    // 素通しせず未設定と同じ扱いに倒す (`handleKintaiKosokuDaily` と同じ)。
    const origin = (this.env.NUXT_ICHIBAN_API_URL ?? "").trim();
    const cfAccessClientId = (this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID ?? "").trim();
    let cfAccessClientSecret = "";
    try {
      cfAccessClientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch (err) {
      console.error(JSON.stringify({ dtako_reimport: "secret-error", error: describeUnknownError(err) }));
    }
    if (!origin || !cfAccessClientId || !cfAccessClientSecret) {
      return Response.json(
        {
          error:
            "オンプレの取得先 (NUXT_ICHIBAN_API_URL / NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID / ICHIBAN_CF_ACCESS_CLIENT_SECRET) が未設定です",
        },
        { status: 503 },
      );
    }

    if (!parsed.isBatch) {
      const { opeNo, startOpe, unkoNo, resetTimecard } = parsed.items[0];
      return this.enqueueScrape(() =>
        this.runDtakoReimportJob(
          account,
          { opeNo, startOpe, unkoNo, resetTimecard },
          origin,
          cfAccessClientId,
          cfAccessClientSecret,
        ),
      );
    }
    try {
      assertBatchSizeWithinLimit(parsed.items.length);
    } catch (err) {
      if (err instanceof BatchTooLargeError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
    return this.enqueueScrape(() =>
      this.runDtakoReimportBatch(account, parsed.items, origin, cfAccessClientId, cfAccessClientSecret),
    );
  }

  private async runDtakoReimportJob(
    account: DtakoAccountRaw,
    input: { opeNo: string; startOpe: string; unkoNo: string; resetTimecard: boolean },
    origin: string,
    cfAccessClientId: string,
    cfAccessClientSecret: string,
  ): Promise<Response> {
    const base = origin.replace(/\/+$/, "");
    // 自前ログインセッションは再集計 (recalculateWork) と zip 取得
    // (downloadOperationCsvZip) で使い回す — DO インスタンス内キャッシュ経由
    // (`withTheearthLoginSession`、Refs #633-20)。login() はどちらの呼び出しに
    // も埋め込まない — `fetchZip` が `recalculateWork` を経由しなくても
    // (将来そういう経路ができても) ログイン済み jar を確実に使える。
    const jobState = this.makeTheearthLoginJobState();
    // deps.recalculateWork の戻り値は Promise<void> (dtako-reimport.ts の pure 側の
    // 契約) なので、ログに出す unlocked/selfUnlocked はクロージャの外の可変
    // オブジェクトで受け取る (Refs #633-23、runOperationZip と同じ理由)。
    const unlockInfo: { unlocked: boolean | null; selfUnlocked: boolean | null } = {
      unlocked: null,
      selfUnlocked: null,
    };
    const deps: DtakoReimportDeps = {
      recalculateWork: async () => {
        await this.withTheearthLoginSession(account, jobState, async (jar) => {
          // Refs #633-23 (dtako-alc-upload と同じ理由、runOperationZip のコメント参照)。
          await releaseLoadedOperation(jar);
          const result = await recalculateWorkUnattended(jar, input.opeNo, input.startOpe);
          unlockInfo.unlocked = result.unlocked;
          unlockInfo.selfUnlocked = result.selfUnlocked;
          await releaseLoadedOperation(jar);
        });
      },
      fetchZip: () =>
        this.withTheearthLoginSession(account, jobState, (jar) =>
          downloadOperationCsvZip(jar, { opeNo: input.opeNo, startOpe: input.startOpe }),
        ),
      onpremAutoload: (path, init) =>
        fetch(`${base}${path}`, {
          ...init,
          headers: {
            ...(init.headers as Record<string, string> | undefined),
            "CF-Access-Client-Id": cfAccessClientId,
            "CF-Access-Client-Secret": cfAccessClientSecret,
          },
        }),
    };
    try {
      const report = await runDtakoReimportPure(deps, {
        opeNo: input.opeNo,
        startOpe: input.startOpe,
        unkoNo: input.unkoNo,
        resetTimecard: input.resetTimecard,
      });
      if (!report.recalculate.ok) {
        console.error(
          JSON.stringify({
            dtako_reimport: "recalculate_failed",
            comp_id: account.comp_id,
            unko_no: input.unkoNo,
            message: report.recalculate.error,
          }),
        );
      }
      console.log(
        JSON.stringify({
          dtako_reimport: "ok",
          comp_id: account.comp_id,
          unko_no: input.unkoNo,
          recalculate_ok: report.recalculate.ok,
          bytes: report.bytes,
          entries: report.entries,
          http_status: report.http_status,
          theearth_logins: jobState.logins.length,
          theearth_kicked: jobState.logins.some((l) => l.kicked),
          theearth_unlocked: unlockInfo.unlocked,
          theearth_self_unlocked: unlockInfo.selfUnlocked,
        }),
      );
      return Response.json({
        ...report,
        theearth_logins: jobState.logins.length,
        theearth_kicked: jobState.logins.some((l) => l.kicked),
        theearth_unlocked: unlockInfo.unlocked,
        theearth_self_unlocked: unlockInfo.selfUnlocked,
      });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        return Response.json({ error: THEEARTH_SESSION_EXPIRED_MESSAGE }, { status: 401 });
      }
      // **push 送信後に応答を確定できなかった場合は区別する** (親指摘
      // 2026-08-01)。取り込みは応答より前に走るため、盲目的な再実行は二重取り込み
      // になりうる — `uncertain: true` を呼び出し元 (kyuyo-mcp tool) まで伝える。
      if (err instanceof DtakoReimportPushUncertainError) {
        console.error(
          JSON.stringify({
            dtako_reimport: "push_uncertain",
            comp_id: account.comp_id,
            unko_no: input.unkoNo,
            message: err.message,
          }),
        );
        return Response.json({ error: err.message, uncertain: true }, { status: 502 });
      }
      if (err instanceof ReportParamError || err instanceof DtakoReimportError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      const message =
        err instanceof TheearthClientError ? err.message : `dtako reimport に失敗しました (${describeUnknownError(err)})`;
      console.error(
        JSON.stringify({ dtako_reimport: "failed", comp_id: account.comp_id, unko_no: input.unkoNo, message }),
      );
      return Response.json({ error: message }, { status: 502 });
    }
  }

  /**
   * バッチ版 `runDtakoReimportJob` (Refs #633)。`items` を 1 job で直列に処理し、
   * ログインセッション (`jobState`) を全件で共有する。1 件の失敗は
   * `results[i]` に理由 (`err.message`、`DtakoReimportPushUncertainError` を
   * 含む) を積んで続行し、`VenusSessionExpiredError` だけは残りを打ち切る
   * (`runBatchSequential` の契約、`cron-batch.ts` 参照)。 */
  private async runDtakoReimportBatch(
    account: DtakoAccountRaw,
    items: DtakoReimportItem[],
    origin: string,
    cfAccessClientId: string,
    cfAccessClientSecret: string,
  ): Promise<Response> {
    const base = origin.replace(/\/+$/, "");
    const jobState = this.makeTheearthLoginJobState();
    const batch = await runBatchSequential(items, async (item, index) => {
      const unlockInfo: { unlocked: boolean | null; selfUnlocked: boolean | null } = {
        unlocked: null,
        selfUnlocked: null,
      };
      const deps: DtakoReimportDeps = {
        recalculateWork: async () => {
          await this.withTheearthLoginSession(account, jobState, async (jar) => {
            await releaseLoadedOperation(jar);
            const result = await recalculateWorkUnattended(jar, item.opeNo, item.startOpe);
            unlockInfo.unlocked = result.unlocked;
            unlockInfo.selfUnlocked = result.selfUnlocked;
            await releaseLoadedOperation(jar);
          });
        },
        fetchZip: () =>
          this.withTheearthLoginSession(account, jobState, (jar) =>
            downloadOperationCsvZip(jar, { opeNo: item.opeNo, startOpe: item.startOpe }),
          ),
        onpremAutoload: (path, init) =>
          fetch(`${base}${path}`, {
            ...init,
            headers: {
              ...(init.headers as Record<string, string> | undefined),
              "CF-Access-Client-Id": cfAccessClientId,
              "CF-Access-Client-Secret": cfAccessClientSecret,
            },
          }),
      };
      const report = await runDtakoReimportPure(deps, {
        opeNo: item.opeNo,
        startOpe: item.startOpe,
        unkoNo: item.unkoNo,
        resetTimecard: item.resetTimecard,
      });
      if (!report.recalculate.ok) {
        console.error(
          JSON.stringify({
            dtako_reimport_batch: "recalculate_failed",
            comp_id: account.comp_id,
            unko_no: item.unkoNo,
            index,
            message: report.recalculate.error,
          }),
        );
      }
      console.log(
        JSON.stringify({
          dtako_reimport_batch: "ok",
          comp_id: account.comp_id,
          unko_no: item.unkoNo,
          index,
          recalculate_ok: report.recalculate.ok,
          bytes: report.bytes,
          http_status: report.http_status,
          theearth_unlocked: unlockInfo.unlocked,
          theearth_self_unlocked: unlockInfo.selfUnlocked,
        }),
      );
      // 構造化ログ (上の console.log) にしか出ていなかった抜けを直す (Refs #633-24)。
      return { ...report, theearth_unlocked: unlockInfo.unlocked, theearth_self_unlocked: unlockInfo.selfUnlocked };
    });

    const successCount = batch.results.filter((r) => r.ok).length;
    console.log(
      JSON.stringify({
        dtako_reimport_batch: "done",
        comp_id: account.comp_id,
        item_count: items.length,
        success_count: successCount,
        failure_count: batch.results.length - successCount,
        truncated: batch.truncated,
        remaining: batch.remaining,
        theearth_logins: jobState.logins.length,
        theearth_kicked: jobState.logins.some((l) => l.kicked),
      }),
    );
    return Response.json({
      ok: true,
      comp_id: account.comp_id,
      results: batch.results,
      success_count: successCount,
      failure_count: batch.results.length - successCount,
      truncated: batch.truncated,
      remaining: batch.remaining,
      theearth_logins: jobState.logins.length,
      theearth_kicked: jobState.logins.some((l) => l.kicked),
    });
  }

  /**
   * POST /cron/dtako/alc-upload — body {comp_id, ope_no, start_ope} (単体) か
   * {comp_id, items: [{ope_no, start_ope}, ...]} (バッチ、Refs #633)。運行 1 件の
   * csvdata.zip を**自前ログイン**で取得し、rust-alc-api の `POST /api/upload`
   * (`alc-internal-upload.ts` の `uploadDtakoZipViaAlcInternalProxy`、
   * `runCronDtakoScrape` が読取日ぶん全部で使うのと同じ経路) へ**運行1件だけ**で
   * 投入する (Refs #633-7)。
   *
   * **単体形式の body/応答は `items` 追加前と 1 バイトも変えていない**
   * (`parseDtakoAlcUploadRequest` 参照。`unko_no` はこの経路には無い —
   * `reimport` と違い、zip 内 KUDGURI.csv から読むため受け取らない)。
   *
   * `handleCronDtakoReimport` (オンプレ autoload 向け) と対になる — こちらは
   * `unko_no` が要らない (`/api/upload` は zip 内の KUDGURI.csv から unko_no を
   * 読むため URL に載せる必要が無い)。中身を先に確認したいだけなら、この口を
   * 叩く前に既存の read-only な `POST /cron/dtako/operation-zip` を使うこと
   * (`runDtakoAlcUploadPure` の module doc 参照 — この route に preview は無い)。
   */
  private async handleCronDtakoAlcUpload(request: Request): Promise<Response> {
    let body: { comp_id?: unknown; ope_no?: unknown; start_ope?: unknown; items?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return Response.json({ error: "JSON body が必要です" }, { status: 400 });
    }
    const parsed = parseDtakoAlcUploadRequest(body);
    if ("error" in parsed) {
      return Response.json({ error: parsed.error }, { status: 400 });
    }

    const account = await this.resolveAccount(parsed.compId);
    if (!account) {
      return Response.json({ error: `comp_id=${parsed.compId} が DTAKO_ACCOUNTS に見つかりません` }, { status: 500 });
    }

    const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
    if (!sharedSecret) {
      return Response.json(
        { error: "INTERNAL_SHARED_SECRET 未設定のため alc へ投入できません" },
        { status: 503 },
      );
    }

    if (!parsed.isBatch) {
      const { opeNo, startOpe } = parsed.items[0];
      return this.enqueueScrape(() => this.runDtakoAlcUploadJob(account, { opeNo, startOpe }, sharedSecret));
    }
    try {
      assertBatchSizeWithinLimit(parsed.items.length);
    } catch (err) {
      if (err instanceof BatchTooLargeError) return Response.json({ error: err.message }, { status: 400 });
      throw err;
    }
    return this.enqueueScrape(() => this.runDtakoAlcUploadBatch(account, parsed.items, sharedSecret));
  }

  private async runDtakoAlcUploadJob(
    account: DtakoAccountRaw,
    input: { opeNo: string; startOpe: string },
    sharedSecret: string,
  ): Promise<Response> {
    // 自前ログインセッションは再集計 (recalculateWork) と zip 取得
    // (downloadOperationCsvZip) で使い回す — DO インスタンス内キャッシュ経由
    // (`withTheearthLoginSession`、dtako-reimport と同じ理由、Refs #633-20)。
    const jobState = this.makeTheearthLoginJobState();
    // Refs #633-23 (runDtakoReimportJob と同じ理由) — deps.recalculateWork は
    // Promise<void> 契約なので、ログに出す情報はクロージャの外の可変オブジェクトで
    // 受け取る。
    const unlockInfo: { unlocked: boolean | null; selfUnlocked: boolean | null } = {
      unlocked: null,
      selfUnlocked: null,
    };
    const deps: DtakoAlcUploadDeps = {
      recalculateWork: async () => {
        await this.withTheearthLoginSession(account, jobState, async (jar) => {
          // Refs #633-23 (runOperationZip のコメント参照)。
          await releaseLoadedOperation(jar);
          const result = await recalculateWorkUnattended(jar, input.opeNo, input.startOpe);
          unlockInfo.unlocked = result.unlocked;
          unlockInfo.selfUnlocked = result.selfUnlocked;
          await releaseLoadedOperation(jar);
        });
      },
      fetchZip: () =>
        this.withTheearthLoginSession(account, jobState, (jar) =>
          downloadOperationCsvZip(jar, { opeNo: input.opeNo, startOpe: input.startOpe }),
        ),
      uploadZip: (filename, zipBytes) =>
        uploadDtakoZipViaAlcInternalProxy(
          { sharedSecret, tenantId: account.tenant_id, filename, zipBytes },
          this.env.AUTH_WORKER.fetch.bind(this.env.AUTH_WORKER),
        ),
    };
    try {
      const report = await runDtakoAlcUploadPure(deps, { opeNo: input.opeNo, startOpe: input.startOpe });
      if (!report.recalculate.ok) {
        console.error(
          JSON.stringify({
            dtako_alc_upload: "recalculate_failed",
            comp_id: account.comp_id,
            ope_no: input.opeNo,
            message: report.recalculate.error,
          }),
        );
      }
      const line = {
        dtako_alc_upload: "ok" as const,
        comp_id: account.comp_id,
        ope_no: input.opeNo,
        recalculate_ok: report.recalculate.ok,
        bytes: report.bytes,
        upload_id: report.upload_id,
        split_failed: report.split_failed,
        theearth_logins: jobState.logins.length,
        theearth_kicked: jobState.logins.some((l) => l.kicked),
        theearth_unlocked: unlockInfo.unlocked,
        theearth_self_unlocked: unlockInfo.selfUnlocked,
      };
      // split は非同期 — 失敗件数が既にこの応答に乗っていれば error レベルで鳴らす
      // (`runCronDtakoScrape` と同じ方針)。0/null (未確定) は info ログのみ。
      if (report.split_failed !== null && report.split_failed > 0) {
        console.error(
          JSON.stringify({
            ...line,
            status: "split_failed",
            message: `取り込みは成功したが CSV 分割が ${report.split_failed} 件失敗した (該当運行が読み取り側から消える)`,
          }),
        );
      } else {
        console.log(JSON.stringify({ ...line, status: "success" }));
      }
      return Response.json({
        ...report,
        theearth_logins: jobState.logins.length,
        theearth_kicked: jobState.logins.some((l) => l.kicked),
        theearth_unlocked: unlockInfo.unlocked,
        theearth_self_unlocked: unlockInfo.selfUnlocked,
      });
    } catch (err) {
      if (err instanceof VenusSessionExpiredError) {
        return Response.json({ error: THEEARTH_SESSION_EXPIRED_MESSAGE }, { status: 401 });
      }
      if (err instanceof ReportParamError) {
        return Response.json({ error: err.message }, { status: 400 });
      }
      if (err instanceof DtakoAlcUploadError) {
        console.error(
          JSON.stringify({
            dtako_alc_upload: "failed",
            phase: "alc_upload",
            comp_id: account.comp_id,
            ope_no: input.opeNo,
            message: err.message,
          }),
        );
        return Response.json({ error: err.message }, { status: 502 });
      }
      const message =
        err instanceof TheearthClientError
          ? err.message
          : `dtako alc-upload に失敗しました (${describeUnknownError(err)})`;
      console.error(
        JSON.stringify({
          dtako_alc_upload: "failed",
          phase: "theearth_fetch",
          comp_id: account.comp_id,
          ope_no: input.opeNo,
          message,
        }),
      );
      return Response.json({ error: message }, { status: 502 });
    }
  }

  /**
   * バッチ版 `runDtakoAlcUploadJob` (Refs #633)。`items` を 1 job で直列に処理し、
   * ログインセッション (`jobState`) を全件で共有する。1 件の失敗は
   * `results[i]` に理由を積んで続行し、`VenusSessionExpiredError` だけは残りを
   * 打ち切る (`runBatchSequential` の契約、`cron-batch.ts` 参照)。 */
  private async runDtakoAlcUploadBatch(
    account: DtakoAccountRaw,
    items: DtakoAlcUploadItem[],
    sharedSecret: string,
  ): Promise<Response> {
    const jobState = this.makeTheearthLoginJobState();
    const batch = await runBatchSequential(items, async (item, index) => {
      const unlockInfo: { unlocked: boolean | null; selfUnlocked: boolean | null } = {
        unlocked: null,
        selfUnlocked: null,
      };
      const deps: DtakoAlcUploadDeps = {
        recalculateWork: async () => {
          await this.withTheearthLoginSession(account, jobState, async (jar) => {
            await releaseLoadedOperation(jar);
            const result = await recalculateWorkUnattended(jar, item.opeNo, item.startOpe);
            unlockInfo.unlocked = result.unlocked;
            unlockInfo.selfUnlocked = result.selfUnlocked;
            await releaseLoadedOperation(jar);
          });
        },
        fetchZip: () =>
          this.withTheearthLoginSession(account, jobState, (jar) =>
            downloadOperationCsvZip(jar, { opeNo: item.opeNo, startOpe: item.startOpe }),
          ),
        uploadZip: (filename, zipBytes) =>
          uploadDtakoZipViaAlcInternalProxy(
            { sharedSecret, tenantId: account.tenant_id, filename, zipBytes },
            this.env.AUTH_WORKER.fetch.bind(this.env.AUTH_WORKER),
          ),
      };
      const report = await runDtakoAlcUploadPure(deps, { opeNo: item.opeNo, startOpe: item.startOpe });
      if (!report.recalculate.ok) {
        console.error(
          JSON.stringify({
            dtako_alc_upload_batch: "recalculate_failed",
            comp_id: account.comp_id,
            ope_no: item.opeNo,
            index,
            message: report.recalculate.error,
          }),
        );
      }
      if (report.split_failed !== null && report.split_failed > 0) {
        console.error(
          JSON.stringify({
            dtako_alc_upload_batch: "split_failed",
            comp_id: account.comp_id,
            ope_no: item.opeNo,
            index,
            split_failed: report.split_failed,
            message: `取り込みは成功したが CSV 分割が ${report.split_failed} 件失敗した (該当運行が読み取り側から消える)`,
          }),
        );
      } else {
        console.log(
          JSON.stringify({
            dtako_alc_upload_batch: "ok",
            comp_id: account.comp_id,
            ope_no: item.opeNo,
            index,
            recalculate_ok: report.recalculate.ok,
            bytes: report.bytes,
            upload_id: report.upload_id,
            theearth_unlocked: unlockInfo.unlocked,
            theearth_self_unlocked: unlockInfo.selfUnlocked,
          }),
        );
      }
      // 構造化ログ (上の console.log/error) にしか出ていなかった抜けを直す (Refs #633-24)。
      return { ...report, theearth_unlocked: unlockInfo.unlocked, theearth_self_unlocked: unlockInfo.selfUnlocked };
    });

    const successCount = batch.results.filter((r) => r.ok).length;
    console.log(
      JSON.stringify({
        dtako_alc_upload_batch: "done",
        comp_id: account.comp_id,
        item_count: items.length,
        success_count: successCount,
        failure_count: batch.results.length - successCount,
        truncated: batch.truncated,
        remaining: batch.remaining,
        theearth_logins: jobState.logins.length,
        theearth_kicked: jobState.logins.some((l) => l.kicked),
      }),
    );
    return Response.json({
      ok: true,
      comp_id: account.comp_id,
      results: batch.results,
      success_count: successCount,
      failure_count: batch.results.length - successCount,
      truncated: batch.truncated,
      remaining: batch.remaining,
      theearth_logins: jobState.logins.length,
      theearth_kicked: jobState.logins.some((l) => l.kicked),
    });
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

    // 段階別 (login/csv_get/stage1/stage2) の所要 ms (Refs #205-52)。cron/MCP 経路
    // (runCronDtakoScrape) と同じ計測を通す — ブラウザ経路だけ観測が薄いと、
    // 「経路が違うから」という誤診の温床になる。
    const timer = new PhaseTimer();
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
        undefined,
        {},
        timer,
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
      // 取り込み応答の構造化結果。CSV 分割が失敗していても**取り込み自体は成功**
      // なので resultStatus は success のまま separate に運ぶ (Refs #205-40)。
      // ブラウザ側 (scraper.vue) が split_failed > 0 を見て
      // `POST /api/proxy/api/split-csv/{upload_id}` を自動で叩き直す。
      let uploadOutcome: AlcUploadOutcome | null = null;
      if (sharedSecret) {
        this.sendSafely(server, { event: "progress", comp_id: params.compId, step: "upload" });
        try {
          const uploadBody = await uploadDtakoZipViaAlcInternalProxy(
            { sharedSecret, tenantId: account.tenant_id, filename: "csvdata.zip", zipBytes: zip },
            this.env.AUTH_WORKER.fetch.bind(this.env.AUTH_WORKER),
          );
          uploadOutcome = parseAlcUploadResponse(uploadBody);
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

      // 値が取れたフィールドだけ載せる — 欠落 (旧 alc / アップロード未実施) を 0 に
      // 丸めて送ると、front が「分割は成功した」と誤って表示してしまう。
      const uploadFields: Record<string, unknown> = {};
      if (uploadOutcome) {
        if (uploadOutcome.uploadId) uploadFields.upload_id = uploadOutcome.uploadId;
        if (uploadOutcome.operationsCount !== null) {
          uploadFields.operations_count = uploadOutcome.operationsCount;
        }
        if (uploadOutcome.splitFailed !== null) {
          uploadFields.split_failed = uploadOutcome.splitFailed;
        }
      }

      // 取り込み (アップロード) の結果は上の resultStatus/resultMessage で確定
      // 済み。fold はこの先で何をしようと WS の応答内容を変えない (条件4: 取り込み
      // の挙動を変えない)。**await しない** — WS を待たせず即座に "done" を返し、
      // fold は別の ctx.waitUntil で独立して走らせる (ブラウザの接続を fold の
      // 所要時間 [ページング込みで数分かかりうる] だけ引き延ばさないため)。
      const jobKey = scrapeJobKey(params.startDate, params.endDate);
      this.ctx.waitUntil(
        this.foldAfterIngest(account, params, jobKey, uploadOutcome).catch(() => {}),
      );

      this.sendSafely(server, {
        event: "result",
        comp_id: params.compId,
        step: "done",
        status: resultStatus,
        message: resultMessage,
        zip_url: zipUrl,
        ...uploadFields,
      });
      this.sendSafely(server, { event: "done" });
      this.closeSafely(server, 1000, "done");
    } catch (err) {
      const message = err instanceof TheearthClientError ? err.message : "スクレイプに失敗しました";
      // WS 越しの browser にはあえて短い message だけ送る。証拠一式 (status/
      // content-type/本文抜粋/経過ms) は console.error (Tail Worker) 側にだけ出す
      // (Refs #205-52) — cron/MCP 経路と同じ診断面に揃える。
      const { message: diagMessage, evidence } = describeScrapeFailure(err);
      console.error(
        JSON.stringify({
          scraper_ws: "dtako",
          comp_id: params.compId,
          status: "error",
          message: diagMessage,
          ...(evidence ? { evidence } : {}),
        }),
      );
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
    } finally {
      const { phases, totalMs } = timer.report();
      console.log(
        JSON.stringify({ scraper_ws: "dtako", comp_id: params.compId, scrape_phase_timing: phases, total_ms: totalMs }),
      );
    }
  }

  /**
   * scrape 経路の comp_id → theearth 認証情報の解決。
   *
   * **参照先は `dtakoAccountsRaw()` に統一する** (= KV `dtako-relay-config` の
   * `dtako_accounts` が正、無ければ binding に fallback)。以前はここだけ
   * `env.DTAKO_ACCOUNTS` binding を直読みしていたため、規範どおり KV に投入して
   * あっても WS 経由の手動リランからは見えず、`comp_id=... が DTAKO_ACCOUNTS に
   * 見つかりません` になっていた (2026-07-30、comp_id 27324455 / 75700192)。
   * cron 経路 (`resolveDtakoAccounts`) と viewer 認可は既に KV を見ていたので、
   * この関数だけが 2026-07-25 の KV 移行から取り残されていた。
   */
  private async resolveAccount(compId: string): Promise<DtakoAccountRaw | null> {
    const raw = await this.dtakoAccountsRaw();
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
    const viewerRecord = (role?: string, email?: string): TheearthSessionRecord => ({
      viewerRole: role,
      viewerEmail: email,
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
      return devViewerCompIds(this.env.RESTRAINT_DEV_VIEWER_COMP).has(routing.compId)
        ? viewerRecord(undefined, this.env.RESTRAINT_DEV_VIEWER_EMAIL)
        : null;
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
      ? viewerRecord(result.role, result.email)
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
      return this.handleKintaiKosokuDaily(record!, url, request.headers.get("if-none-match"));
    }
    // 手動キャッシュ warm (Refs #554)。上流デプロイで版が動いた後に押しておく口
    if (url.pathname === "/restraint-api/kintai/warm" && request.method === "POST") {
      return this.handleKintaiWarm(record!, url);
    }
    // ---- オンプレ vs GCP 比較 + 取り直し3口 (viewer 認可、既定 dry-run。Refs #615-4) ----
    if (url.pathname === "/restraint-api/kintai/diff" && request.method === "GET") {
      return this.handleKintaiDiff(record!, url);
    }
    // フル突合 (kintai/diff、約50秒) の結果を保存分だけ読む軽い口 (Refs #620-3)。
    // 突合は実行しない — 「未確認/読めなかった/差0件」を区別して返すだけ。
    if (url.pathname === "/restraint-api/kintai/diff-cache" && request.method === "GET") {
      return this.handleKintaiDiffCache(record!, url);
    }
    // 月タブの「畳み直しが要る月」丸 (viewer 認可、Refs #620)。フル突合
    // (kintai/diff、約50秒) とは別の軽い口 — 月タブ描画のたびに叩いても壊れない
    if (url.pathname === "/restraint-api/kintai/stale-months" && request.method === "GET") {
      return this.handleKintaiStaleMonths(record!, url);
    }
    // 取り込み漏れ候補の運行NO一覧 (viewer 認可、Refs #623-2)。★ 遅い口 —
    // ページ描画のたびに叩かない (呼び出し側の責務)。読むだけ、POSTは無い
    if (url.pathname === "/restraint-api/kintai/unko-gaps" && request.method === "GET") {
      return this.handleKintaiUnkoGaps(record!, url);
    }
    if (url.pathname === "/restraint-api/kintai/refresh/timecard" && request.method === "POST") {
      return this.handleKintaiRefreshTimecard(record!, url);
    }
    if (url.pathname === "/restraint-api/kintai/refresh/fold" && request.method === "POST") {
      return this.handleKintaiRefreshFold(record!, url);
    }
    if (url.pathname === "/restraint-api/kintai/refresh/mysql" && request.method === "POST") {
      return this.handleKintaiRefreshMysql(record!, request);
    }
    // ②(取り込み)の後、オンプレから実物の23桁 unko_no を引く (viewer 認可、
    // 読むだけ・②を実行しない。Refs #625)
    if (url.pathname === "/restraint-api/kintai/day-events-lookup" && request.method === "GET") {
      return this.handleKintaiDayEventsLookup(url);
    }
    // 突合明細から運行1件をalcへ上げ直す導線 (viewer 認可、Refs #633-17)。
    // day-operations は読むだけ、alc-upload は既存 /cron/dtako/alc-upload の
    // 内部経路 (runDtakoAlcUploadJob) をそのまま呼ぶ (ロジックの複製をしない)。
    if (url.pathname === "/restraint-api/kintai/day-operations" && request.method === "GET") {
      return this.handleKintaiDayOperationsList(url);
    }
    if (url.pathname === "/restraint-api/kintai/alc-upload" && request.method === "POST") {
      return this.handleKintaiAlcUpload(record!, request);
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
      return this.handleWageReport(record!, url, request.headers.get("if-none-match"));
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
   * 併せて社員別サマリ (`summarizeTimecardMonth`) も保存する。
   *
   * **★ この R2 サマリと ichiban への push (下の `pushRestraintSummariesToIchiban`) は
   * 「押した時点のスナップショット」でしかない** (2026-08-03 決定、#606-5)。
   * wage-report はもう読まない — `loadWageReportSource` の timecard 側は
   * `buildKintaiSummariesLive` (その場で打刻+kosoku-daily から組み直す) の成否だけで
   * 決める。ここでの保存/push を消してはいない (突合・履歴用に残す) が、フォール
   * バック無しを「バグ」と誤解して戻さないこと。
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

    // 0) 上流キャッシュの温め用に「取り込み前の版」を取る (Refs #543 PR-3)。
    // 本文より先に引く — 本文は必ずこの版と同時かそれより新しくなり、
    // 「新しい etag に古い本文」の取り違えが起きない (warmDailyCacheAfterIngest 参照)
    const etagBefore =
      this.env.UPSTREAM_CACHE === "on"
        ? await this.fetchKintaiVersionLive(apiUrl, clientId, clientSecret, ym)
        : null;

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
      // ここでの push は突合用のスナップショットとして残すだけ — wage-report の
      // timecard 側表示はもう読まない (#606-5、handleKintaiFetch の docstring参照)
      await this.pushRestraintSummariesToIchiban(record.compId, "timecard", ym, d1Entries);
    } catch (err) {
      console.error(JSON.stringify({ kintai_fetch: "r2-error", error: describeUnknownError(err) }));
      return dvrJsonError(502, "勤怠データの保存に失敗しました");
    }

    // 4) 上流キャッシュの強制更新 (Refs #543 PR-3)。まず対象月 (+前月) を無効化し、
    // 取り込みが持っている最新の daily 本文だけ温め直す。kosoku は次の読みが
    // write-through で作り直す (二度取りしない)
    // キャッシュは操作者の email 単位 DO にあるので、ここで触れるのも操作者ぶん (Refs #554)
    const cache = await this.remoteUpstreamCache(record.viewerEmail);
    await this.invalidateKintaiUpstreamCache([ym, prevYmOf(ym)], "kintai-fetch", cache);
    await this.warmDailyCacheAfterIngest(apiUrl, clientId, clientSecret, ym, rawText, etagBefore, cache);

    return Response.json({
      month: ym,
      rows: rows.length,
      drivers: summaries.length,
      summaries_updated: summariesWrote,
      fetched_at: ts,
      warnings,
    });
  }

  /**
   * POST /cron/restraint-sync — body {comp_id, month}。拘束サマリの写し
   * (R2 `kintai/` prefix) を無人で押し直す (Refs #606-6)。
   *
   * **処理は `handleKintaiFetch` をそのまま呼ぶだけ (変更しない)。** theearth
   * セッションを持たない synthetic record を組み立て、month を query string に
   * 載せ替えて渡す。`handleKintaiFetch` は `record.compId` / `record.viewerEmail`
   * しか読まない (theearth cookie には触れない R2-only 処理、Refs #606-6 調査済み)
   * ので、theearth ログインは不要。
   *
   * 認証は index.ts の `/kintai-relay/restraint-sync` 側 (`X-Alc-Proxy-Secret`) が
   * 持つ — この worker 自身からしか到達できない前提は `/cron/dtako` と同じ。
   *
   * **★ ここで押した写しは表示に使われない** (2026-08-03 決定、#606-5)。
   * `loadWageReportSource` の timecard 側は live-build (`buildKintaiSummariesLive`)
   * の成否だけで決まる。この同期の目的は突合・履歴用のスナップショットを最新に
   * 保つことで、**同期が失敗しても画面は壊れない** (`handleKintaiFetch` の
   * docstring 参照)。
   */
  private async handleCronRestraintSync(request: Request): Promise<Response> {
    let body: { comp_id?: unknown; month?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return dvrJsonError(400, "body must be JSON");
    }
    const compId = typeof body.comp_id === "string" ? body.comp_id.trim() : "";
    const month = typeof body.month === "string" ? body.month : "";
    if (!compId || !month) {
      return dvrJsonError(400, "comp_id / month は必須です");
    }
    const record: TheearthSessionRecord = {
      token: "cron",
      compId,
      userName: "",
      cookies: [],
      createdAt: Date.now(),
      expiresAt: Date.now(),
    };
    const url = new URL(
      `https://relay.internal/restraint-api/kintai/fetch?month=${encodeURIComponent(month)}`,
    );
    return this.handleKintaiFetch(record, url);
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
  private async handleKintaiKosokuDaily(
    record: TheearthSessionRecord,
    url: URL,
    ifNoneMatch: string | null,
  ): Promise<Response> {
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { ym } = parsed;
    // フェーズ計測 (Refs #543 PR-1)。挙動は変えない — ログ 1 行と Server-Timing だけ
    const timer = new PhaseTimer();
    // キャッシュの hit/miss/live を phase log の cacheState に載せる (Refs #543 PR-2)
    const tracker = new CacheStateTracker();
    // 上流キャッシュは閲覧者の email 単位 DO (Refs #554)
    const cache = await this.remoteUpstreamCache(record.viewerEmail);

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
      this.fetchKosokuRaw(apiUrl, clientId, clientSecret, ym, timer, "kosoku-cur", "version-cur", tracker, cache),
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
    // 内容不変なら 304 で本文を送らない (Refs #543 PR-5)。304 でも計測は出す
    const { res, notModified } = await this.jsonWithEtag(body, ifNoneMatch);
    return this.withPhaseTiming("kintai/kosoku-daily", ym, timer, tracker.aggregate(), res, notModified);
  }

  /** フェーズ計測の出力 (ログ 1 行 + Server-Timing / X-Upstream-Cache ヘッダ)。
   * **応答は絶対に壊さない** — 計測側の不具合はここで握って応答をそのまま返す
   * (Refs #543 PR-1)。cacheState は上流キャッシュの集約結果
   * "hit" | "miss" | "live" (Refs #543 PR-2)。notModified は 304 応答 (PR-5) —
   * 304 でも計測ログは 1 行出す。
   *
   * `X-Upstream-Cache` は front が「上流の版が変わって取り直した (miss)」を
   * 画面に出すために読む (Refs #554)。**本文ではなくヘッダに載せる** — 本文に
   * 入れると hit/miss で本文が変わり、弱 ETag が動いて PR-5 の 304 が効かなくなる。
   * 304 応答にも載せる (ブラウザは 304 のヘッダを保存済み応答へマージするので、
   * 載せないと front が前回の値を読んでしまう)。 */
  private withPhaseTiming(
    route: string,
    month: string,
    timer: PhaseTimer,
    cacheState: string,
    res: Response,
    notModified = false,
  ): Response {
    try {
      console.log(phaseTimingLogLine(route, month, timer, cacheState, notModified));
      res.headers.set("Server-Timing", timer.serverTimingHeader());
      res.headers.set("X-Upstream-Cache", cacheState);
    } catch (err) {
      console.error(JSON.stringify({ phase_timing: "emit-error", route, error: describeUnknownError(err) }));
    }
    return res;
  }

  /**
   * JSON 応答に弱い ETag を付け、If-None-Match 一致なら 304 (本文なし) を返す
   * (Refs #543 PR-5)。kosoku-daily / wage-report の 1.7MB 級応答の転送量削減 —
   * `cache-control: no-cache` はブラウザに「保存してよいが毎回再検証せよ」を
   * 指示し、内容不変なら 304 だけが往復する (フロント変更は不要)。
   *
   * ETag は**実際に送る本文** (JSON.stringify 結果) の sha256 — キャッシュ層の
   * sha256 (gzip 済み上流テキストのもの) は再シリアライズで応答本文と一致しない
   * ため使わない。stringify のキー順は上流の出現順で安定なので、データ不変なら
   * ETag も不変。
   */
  private async jsonWithEtag(
    payload: unknown,
    ifNoneMatch: string | null,
  ): Promise<{ res: Response; notModified: boolean }> {
    const serialized = JSON.stringify(payload);
    const etag = weakEtag(await this.sha256Hex(new TextEncoder().encode(serialized)));
    if (etagMatches(ifNoneMatch, etag)) {
      return {
        res: new Response(null, { status: 304, headers: { etag, "cache-control": "no-cache" } }),
        notModified: true,
      };
    }
    return {
      res: new Response(serialized, {
        status: 200,
        headers: { "content-type": "application/json", etag, "cache-control": "no-cache" },
      }),
      notModified: false,
    };
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

  // -------------------------------------------------------------------------
  // オンプレ vs GCP 比較 + 取り直し3口 (viewer 認可、既定 dry-run。Refs #615-4)
  //
  // `/kintai-relay/*` (共有シークレット・機械用) には一切触れない。ここで組む
  // `KintaiRelayDeps` は viewer 認可済みの `record.compId` から `resolveAccount` で
  // tenant_id を引いて作る — `runFoldMonths` (Refs #205 の 10) が
  // `/kintai-relay/recalc` への HTTP self-call を使わずに複数 comp_id/tenant を
  // 跨いで `buildDeps` を直接組んでいるのと同じ理由・同じパターン。
  // -------------------------------------------------------------------------

  /**
   * account の tenant_id 解決 + オンプレ/GCP 資格情報を揃えて `kintai-relay.ts` の
   * deps を組む。揃わなければ理由付きの Response を返す (呼び出し側は
   * `instanceof Response` で分岐する)。
   */
  private async buildKintaiRelayContext(
    compId: string,
    tag: string,
  ): Promise<
    | { deps: KintaiRelayDeps; creds: { apiUrl: string; clientId: string; clientSecret: string } }
    | Response
  > {
    const creds = await this.ichibanCreds(tag);
    if (!creds) return dvrJsonError(503, "オンプレの取得先 (NUXT_ICHIBAN_*) が未設定です");
    const account = await this.resolveAccount(compId);
    if (!account) return dvrJsonError(500, `comp_id=${compId} が DTAKO_ACCOUNTS に見つかりません`);
    const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
    if (!sharedSecret || !this.env.AUTH_WORKER) {
      return dvrJsonError(503, "GCP の取得先 (INTERNAL_SHARED_SECRET / AUTH_WORKER) が未設定です");
    }
    const deps = buildDeps({
      ichibanOrigin: creds.apiUrl,
      cfAccessClientId: creds.clientId,
      cfAccessClientSecret: creds.clientSecret,
      authWorker: this.env.AUTH_WORKER,
      proxySecret: sharedSecret,
      tenantId: account.tenant_id,
    });
    return { deps, creds };
  }

  /**
   * GET /restraint-api/kintai/diff?month=YYYY-MM — オンプレ (`kosoku-daily`) と
   * GCP (`day_summaries`) の日別サマリを突き合わせ、差の5区分 + 観測値を返す
   * (Refs #615-4)。突合の意味は `kintai-diff.ts` の docs 参照 (kyuyo-mcp
   * `get_kintai_diff` と揃えてある)。
   *
   * **`driver` は受け付けない — 取得は月全体を1回、絞り込みは手元で行う**
   * (#615-3 決定4。rest-diff の driver 絞り込みが月全体より遅い実測があるのと
   * 同じ理由)。
   *
   * `observations` (stale / fold warnings / GCP-only 運行数) は GCP recalc の
   * dry-run 1 ページぶんから拾う副産物。**取れなくても差分表示自体は止めない**
   * (fail-soft、`observations_error` に理由を残す) — 原因を断定しないための
   * 判定材料であって、無いと差分が読めなくなるものではないため。
   *
   * この口自体が約50秒かかるため、応答用に計算した結果は「表示に要る分だけ」を
   * R2 へ保存する (Refs #620-3、`saveKintaiDiffCacheToR2` の doc 参照)。保存は
   * best-effort — 失敗してもこの応答 (ライブの突合結果) は返す。保存できた
   * fetched_at/last_verified_at を応答に含めるので、front は「取り直す」を押した
   * 直後に二度目の read (`/kintai/diff-cache`) を打たずに「最終確認」を更新できる。
   */
  private async handleKintaiDiff(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { ym } = parsed;

    const ctx = await this.buildKintaiRelayContext(record.compId, "kintai_diff");
    if (ctx instanceof Response) return ctx;
    const { deps, creds } = ctx;

    // ★ fetchKosokuRaw (view=timecard、slim) ではなく fetchKosokuRawFull (全項目版)
    // を使う — 突合は11分数を全部比較するため、項目を絞った応答を渡すと欠損を
    // 0扱いして存在しない差をでっち上げる (Refs #633-4、親の実測で確定)。
    const [onpremBody, gcpResult] = await Promise.all([
      this.fetchKosokuRawFull(creds.apiUrl, creds.clientId, creds.clientSecret, ym),
      relayKintaiDaySummaries(deps, { month: ym }).catch((err) => (err instanceof Error ? err : new Error(String(err)))),
    ]);
    if (onpremBody == null) return dvrJsonError(502, "拘束サマリ API の取得に失敗しました");
    if (gcpResult instanceof Error) {
      return dvrJsonError(502, `GCP day-summaries の取得に失敗しました: ${gcpResult.message}`);
    }

    const diff = buildKintaiDiff(gcpResult, onpremBody);

    // 観測値は best-effort。stale/warnings/GCP-only 件数は「判定材料」であって
    // 差分そのものではないので、ここが失敗しても diff は返す
    let observations: ReturnType<typeof pickRecalcObservations> | null = null;
    let observationsError: string | null = null;
    try {
      const raw = await relayKintaiRecalc(deps, { month: ym, maxDrivers: FOLD_PAGE_MAX_DRIVERS, apply: false });
      observations = pickRecalcObservations(raw);
    } catch (err) {
      observationsError = describeUnknownError(err);
      console.error(
        JSON.stringify({ kintai_diff: "observations-error", month: ym, error: observationsError }),
      );
    }

    // 表示に要る分だけを R2 へ保存する (Refs #620-3)。best-effort — 失敗しても
    // このライブ応答は落とさない (取れたてのデータは既に手元にあるため)。
    //
    // ★ `diff.onprem_unreadable` (オンプレ応答の形が読めず突合そのものが成立
    // しなかった回) は保存しない — 保存すると、壊れた回に「最終確認: …」が付いて
    // 確認済みに見えてしまう (親指摘、#620-3 追加1)。保存を諦めても以前の
    // (成立していた) スナップショットが latest に残っているので、次に保存分を
    // 読んだ front には古いが信頼できる値がそのまま出る — 壊れた値で上書きする
    // より安全。`observationsError` (観測値だけ取れなかった側) はここでは弾かない
    // — 差の5区分自体は信頼できるままなので、従来どおり別枠のアラートで扱う。
    let cache: { fetchedAt: string; lastVerifiedAt: string } | null = null;
    if (!diff.onprem_unreadable) {
      try {
        cache = await this.saveKintaiDiffCacheToR2(record.compId, ym, diff, observations, observationsError);
      } catch (err) {
        console.error(
          JSON.stringify({ kintai_diff: "cache-save-error", month: ym, error: describeUnknownError(err) }),
        );
      }
    }

    console.log(
      JSON.stringify({
        kintai_diff: "ok",
        month: ym,
        gcp_rows: diff.gcp_rows,
        onprem_rows: diff.onprem_rows,
      }),
    );
    return Response.json({
      month: ym,
      diff,
      observations,
      observations_error: observationsError,
      fetched_at: cache?.fetchedAt ?? null,
      last_verified_at: cache?.lastVerifiedAt ?? null,
    });
  }

  /**
   * GET /restraint-api/kintai/diff-cache?month=YYYY-MM — `/kintai/diff` (約50秒)
   * を実行せず、保存済みのスナップショットだけを読む軽い口 (Refs #620-3)。
   *
   * front はタブを開いた/月を変えた時にこちらを自動で叩き、「最終確認:
   * MM/DD HH:MM」を出す。50秒の口 (`/kintai/diff`) は「取り直す」ボタンを押した
   * 時だけ叩く — このハンドラは絶対に理論値の突合を実行しない。
   *
   * 応答は3状態を区別する (#620-3 やること★「無い」と「引けていない」の混同禁止):
   * - `{cached: false}` — 一度も保存されていない (=未確認)
   * - `{cached: true, unreadable: true}` — 保存はあるが読めなかった (壊れた JSON 等)
   * - `{cached: true, unreadable: false, ...}` — 保存済みスナップショット
   *   (差0件の「正常」もここに含まれる — front 側が総数0を「差はありません」と表示する)
   */
  private async handleKintaiDiffCache(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { ym } = parsed;
    try {
      const cache = await this.loadKintaiDiffCacheFromR2(record.compId, ym);
      if (!cache.cached) return Response.json({ cached: false });
      if (cache.unreadable) return Response.json({ cached: true, unreadable: true });
      return Response.json({
        cached: true,
        unreadable: false,
        month: cache.snapshot.month,
        diff: cache.snapshot.diff,
        observations: cache.snapshot.observations,
        observations_error: cache.snapshot.observations_error,
        fetched_at: cache.fetchedAt,
        last_verified_at: cache.lastVerifiedAt,
      });
    } catch (err) {
      console.error(
        JSON.stringify({ kintai_diff_cache: "error", month: ym, error: describeUnknownError(err) }),
      );
      return dvrJsonError(502, err instanceof Error ? err.message : "キャッシュの取得に失敗しました");
    }
  }

  /**
   * GET /restraint-api/kintai/stale-months?from=YYYY-MM&to=YYYY-MM — 月タブの
   * 「畳み直しが要る月」丸のための軽い口 (Refs #620)。
   *
   * 中身は `kintai-relay.ts` の `relayKintaiStaleMonths` そのまま (Postgres 1 往復、
   * `unko_diff` の etags 掃引を含まない) — `/kintai/diff` (フル突合、約50秒) と違い、
   * 月タブ描画のたびに叩いても壊れない。`from`/`to` は両方省略可 — 受け側の既定
   * (当月から12か月遡る) に任せる。
   *
   * 応答はそのまま返す。`total_drivers === 0` (データ無し) と `stale_drivers > 0`
   * (畳み直しが要る) の読み分けは front 側 (`app/utils/kintai-stale-months.ts`) の
   * 責務 — ここで丸めない (#620 の教訓: 「無い」と「引けていない」を混同しない)。
   */
  private async handleKintaiStaleMonths(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const ctx = await this.buildKintaiRelayContext(record.compId, "kintai_stale_months");
    if (ctx instanceof Response) return ctx;

    const from = url.searchParams.get("from") || undefined;
    const to = url.searchParams.get("to") || undefined;

    try {
      const months = await relayKintaiStaleMonths(ctx.deps, { from, to });
      console.log(JSON.stringify({ kintai_stale_months: "ok" }));
      return Response.json(months);
    } catch (err) {
      console.error(JSON.stringify({ kintai_stale_months: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, err instanceof Error ? err.message : "月別 stale の取得に失敗しました");
    }
  }

  /**
   * GET /restraint-api/kintai/unko-gaps?month=YYYY-MM&driver_cd=<任意> —
   * 取り込み漏れ候補 (`also_in_month`) の運行NO一覧 (Refs #623-2)。
   *
   * 中身は `kintai-relay.ts` の `relayKintaiUnkoGaps` そのまま。**★ alc への etags
   * 往復を含み遅い** (受け側 docs 「ページ表示で叩く口ではない」) — 呼び出しの
   * タイミングはここでは制御しない。押した時だけ叩く設計は画面側の責務。
   *
   * 応答はそのまま返す。`gcp_etags_available`/`driver_cds_available` が false の
   * ときに「候補なし」と丸めるのは front (画面) の責務 — ここで丸めない。
   */
  private async handleKintaiUnkoGaps(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const month = url.searchParams.get("month") || "";
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return dvrJsonError(400, "month は YYYY-MM で指定してください");
    }
    const driverCd = url.searchParams.get("driver_cd") || undefined;

    const ctx = await this.buildKintaiRelayContext(record.compId, "kintai_unko_gaps");
    if (ctx instanceof Response) return ctx;

    try {
      const gaps = await relayKintaiUnkoGaps(ctx.deps, { month, driverCd });
      console.log(JSON.stringify({ kintai_unko_gaps: "ok", month }));
      return Response.json(gaps);
    } catch (err) {
      console.error(JSON.stringify({ kintai_unko_gaps: "error", month, error: describeUnknownError(err) }));
      return dvrJsonError(502, err instanceof Error ? err.message : "取り込み漏れ候補の取得に失敗しました");
    }
  }

  /**
   * POST /restraint-api/kintai/refresh/timecard?month=&month_count=&apply= —
   * 打刻をオンプレ→GCPへ**窓ぶん**運び直す (Refs #615-4)。
   *
   * 中身は `kintai-relay.ts` の `relayKintaiWindow` そのまま — 窓の既定 (当月+前月)
   * も dry-run の既定もあちらが持つ。**`apply=true` を明示した時だけ書く。**
   */
  private async handleKintaiRefreshTimecard(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const ctx = await this.buildKintaiRelayContext(record.compId, "kintai_refresh_timecard");
    if (ctx instanceof Response) return ctx;

    const month = url.searchParams.get("month") || undefined;
    if (month !== undefined && !/^\d{4}-\d{2}$/.test(month)) {
      return dvrJsonError(400, "month は YYYY-MM で指定してください");
    }
    const monthCountRaw = url.searchParams.get("month_count");
    let monthCount: number | undefined;
    if (monthCountRaw !== null) {
      monthCount = Number(monthCountRaw);
      if (!Number.isInteger(monthCount)) return dvrJsonError(400, "month_count は整数で指定してください");
    }
    const apply = url.searchParams.get("apply") === "true";

    try {
      const report = await relayKintaiWindow(ctx.deps, { month, monthCount, apply });
      console.log(
        JSON.stringify({
          kintai_refresh_timecard: "ok",
          apply,
          drivers_written: report.driversWritten,
          days_written: report.daysWritten,
        }),
      );
      return Response.json(report);
    } catch (err) {
      console.error(JSON.stringify({ kintai_refresh_timecard: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, err instanceof Error ? err.message : "打刻の運び直しに失敗しました");
    }
  }

  /**
   * POST /restraint-api/kintai/refresh/fold?month=&after_driver_cd=&max_drivers=&stale_only=&apply=
   * — GCP 側で全量再計算を**1ページぶん**進める (Refs #615-4)。
   *
   * **ページングは呼び出し側 (front) が回し切る** — 応答の `next_after_driver_cd`
   * をそのまま返すので、`null` になるまで同じ引数で叩き直すこと。
   *
   * **`max_drivers` の既定を大きくしない** — `logic_version` 変更直後の全量 apply は
   * `FOLD_PAGE_MAX_DRIVERS` (50) 程度でないと Cloudflare の 100 秒上限 (524) に
   * 当たる実測がある (#615-3 決定3)。
   */
  private async handleKintaiRefreshFold(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const ctx = await this.buildKintaiRelayContext(record.compId, "kintai_refresh_fold");
    if (ctx instanceof Response) return ctx;

    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");

    const afterDriverCdRaw = url.searchParams.get("after_driver_cd");
    let afterDriverCd: number | undefined;
    if (afterDriverCdRaw !== null) {
      afterDriverCd = Number(afterDriverCdRaw);
      if (!Number.isInteger(afterDriverCd)) return dvrJsonError(400, "after_driver_cd は整数で指定してください");
    }
    const maxDriversRaw = url.searchParams.get("max_drivers");
    let maxDrivers = FOLD_PAGE_MAX_DRIVERS;
    if (maxDriversRaw !== null) {
      maxDrivers = Number(maxDriversRaw);
      if (!Number.isInteger(maxDrivers) || maxDrivers < 1) {
        return dvrJsonError(400, "max_drivers は正の整数で指定してください");
      }
    }
    const staleOnly = url.searchParams.get("stale_only") === "true";
    const apply = url.searchParams.get("apply") === "true";

    try {
      const report = await relayKintaiRecalc(ctx.deps, {
        month: parsed.ym,
        afterDriverCd,
        maxDrivers,
        staleOnly,
        apply,
      });
      console.log(
        JSON.stringify({ kintai_refresh_fold: "ok", month: parsed.ym, apply, max_drivers: maxDrivers }),
      );
      return Response.json(report);
    } catch (err) {
      console.error(JSON.stringify({ kintai_refresh_fold: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, err instanceof Error ? err.message : "畳み直しに失敗しました");
    }
  }

  /**
   * POST /restraint-api/kintai/refresh/mysql — body
   * `{unko_no, ope_no?, start_ope?, reset_timecard?, driver_cd?, month?, apply?}`。
   * 運行**1件**の csvdata.zip を取り直し、オンプレ MariaDB の `dtako_events`
   * (+`reset_timecard: true` なら `time_card_dtako`) へ push する (Refs #615-4)。
   *
   * 実体は `runDtakoReimportJob` (`/cron/dtako/reimport` = `run_dtako_reimport`
   * MCP tool と同じ内部処理) をそのまま呼ぶだけ。**必須引数は `unko_no` だけ** —
   * `ope_no`/`start_ope` は省略可で、省略時は `unko_no` (22桁または23桁) から
   * `deriveOpeNoFromUnkoNo` (`kintai-diff.ts`、桁数で分岐する) で機械的に導出する
   * (親指摘 2026-08-03: 運行NOは桁に開始日時を持っているため、rest-diff が返す
   * `unko_no` をそのまま渡せば足りる)。**明示的に渡された場合はそちらを優先する**
   * (theearth 側の運行検索等で正確な値が既に分かっている場合の上書き用)。
   *
   * **`unko_no` は `reset_timecard` の有無で必要な桁数が変わる** (Refs #625、
   * `isUnkoNoAcceptable`)。③ (`reset_timecard: true`) は `resetby-unko-no/{unko_no}`
   * の対象になるので実物の23桁が必須。①②のみ (既定) は取り込み対象を zip が決めるので、
   * GCP (alc) 由来の22桁 (対象CD 抜き = 取り込み漏れ候補) も受け付ける。
   *
   * **既定は dry-run — `apply: true` が無ければ MariaDB には一切触れない**
   * (zip 取得も push もしない)。`driver_cd`/`month` が両方揃っていれば、
   * オンプレ rest-diff から対象 `unko_no` の `kind` を引いて
   * **「押しても直る保証」(`guarantee`) を返り値に載せる** — `kind: "mismatch"` だけが
   * 保証あり、`dtako_missing`/`events_missing` は保証無し (rust-ichibanboshi
   * `src/kintai_rest_diff.rs` の doc、#615-2 で確認済み)。**保証が無くても実行は
   * ブロックしない** — 実測で `mismatch` が3か月連続0件のため、ブロックすると
   * この口が実質使えなくなる (#615-3 決定2、画面側が保証の有無を併記する設計)。
   */
  private async handleKintaiRefreshMysql(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: {
      unko_no?: unknown;
      ope_no?: unknown;
      start_ope?: unknown;
      reset_timecard?: unknown;
      driver_cd?: unknown;
      month?: unknown;
      apply?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return dvrJsonError(400, "body must be JSON");
    }
    const unkoNo = typeof body.unko_no === "string" ? body.unko_no : "";
    if (!unkoNo) {
      return dvrJsonError(400, "unko_no は必須です");
    }
    // reset_timecard (③まで行うか) で必要な桁数が変わる (Refs #625) — ③は
    // resetby-unko-no/{unko_no} の対象になるため実物の23桁が必須だが、①②のみなら
    // 取り込み対象は zip が決めるので GCP (alc) 由来の22桁 (取り込み漏れ候補) も通す。
    const resetTimecard = body.reset_timecard === true;
    if (!isUnkoNoAcceptable(unkoNo, resetTimecard)) {
      return dvrJsonError(
        400,
        resetTimecard
          ? `勤務時間再登録 (reset_timecard=true) は unko_no が23桁の数値である必要があります: "${unkoNo}"`
          : `unko_no は22桁または23桁の数値で指定してください: "${unkoNo}"`,
      );
    }
    // ope_no/start_ope が明示されていればそちらを優先。無ければ unko_no (22桁または
    // 23桁 = 開始日時12桁+車輌CD10桁[+対象CD1桁]) から機械的に導出する
    // (`deriveOpeNoFromUnkoNo` が桁数で分岐する、Refs #625)
    const explicitOpeNo = typeof body.ope_no === "string" && body.ope_no ? body.ope_no : null;
    const explicitStartOpe = typeof body.start_ope === "string" && body.start_ope ? body.start_ope : null;
    let opeNo: string;
    let startOpe: string;
    if (explicitOpeNo && explicitStartOpe) {
      opeNo = explicitOpeNo;
      startOpe = explicitStartOpe;
    } else {
      const derived = deriveOpeNoFromUnkoNo(unkoNo);
      if (!derived) {
        return dvrJsonError(400, `unko_no から ope_no/start_ope を導出できませんでした: "${unkoNo}"`);
      }
      opeNo = explicitOpeNo ?? derived.opeNo22;
      startOpe = explicitStartOpe ?? derived.startOpe;
    }
    const apply = body.apply === true;
    const driverCd =
      typeof body.driver_cd === "string" && /^\d{1,10}$/.test(body.driver_cd) ? body.driver_cd : null;
    const month = typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month) ? body.month : null;

    // ── 「押しても直る保証」の判定 (driver_cd/month が揃っている時だけ best-effort) ──
    let guarantee: ReturnType<typeof pickRestDiffGuarantee> | null = null;
    let guaranteeError: string | null = null;
    if (driverCd && month) {
      const creds = await this.ichibanCreds("kintai_refresh_mysql_guarantee");
      if (!creds) {
        guaranteeError = "オンプレの取得先 (NUXT_ICHIBAN_*) が未設定のため判定できませんでした";
      } else {
        try {
          const q = new URLSearchParams({ month, driver: driverCd });
          const upstream = await fetch(`${creds.apiUrl}/api/kintai/rest-diff?${q.toString()}`, {
            headers: {
              "CF-Access-Client-Id": creds.clientId,
              "CF-Access-Client-Secret": creds.clientSecret,
            },
          });
          const text = await upstream.text();
          if (!upstream.ok) throw new Error(`status ${upstream.status}: ${text.slice(0, 200)}`);
          guarantee = pickRestDiffGuarantee(JSON.parse(text), unkoNo);
        } catch (err) {
          guaranteeError = describeUnknownError(err);
          console.error(
            JSON.stringify({ kintai_refresh_mysql: "guarantee-error", unko_no: unkoNo, error: guaranteeError }),
          );
        }
      }
    }

    if (!apply) {
      return Response.json({
        dry_run: true,
        ope_no: opeNo,
        start_ope: startOpe,
        unko_no: unkoNo,
        guarantee,
        guarantee_error: guaranteeError,
      });
    }

    const account = await this.resolveAccount(record.compId);
    if (!account) {
      return dvrJsonError(500, `comp_id=${record.compId} が DTAKO_ACCOUNTS に見つかりません`);
    }
    const origin = (this.env.NUXT_ICHIBAN_API_URL ?? "").trim();
    const cfAccessClientId = (this.env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID ?? "").trim();
    let cfAccessClientSecret = "";
    try {
      cfAccessClientSecret = await resolveSecretBinding(this.env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch (err) {
      console.error(JSON.stringify({ kintai_refresh_mysql: "secret-error", error: describeUnknownError(err) }));
    }
    if (!origin || !cfAccessClientId || !cfAccessClientSecret) {
      return dvrJsonError(
        503,
        "オンプレの取得先 (NUXT_ICHIBAN_API_URL / NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID / ICHIBAN_CF_ACCESS_CLIENT_SECRET) が未設定です",
      );
    }

    const res = await this.enqueueScrape(() =>
      this.runDtakoReimportJob(
        account,
        { opeNo, startOpe, unkoNo, resetTimecard },
        origin,
        cfAccessClientId,
        cfAccessClientSecret,
      ),
    );
    // runDtakoReimportJob は成否を Response で返す (成功 json / エラー json どちらも)。
    // 保証の判定結果をここで合成する — 応答が JSON で読めなければそのまま素通しする
    const resultBody = await res
      .clone()
      .json()
      .catch(() => null);
    if (resultBody && typeof resultBody === "object") {
      return Response.json({ ...resultBody, guarantee, guarantee_error: guaranteeError }, { status: res.status });
    }
    return res;
  }

  /**
   * GET /restraint-api/kintai/day-events-lookup?driver_cd=&ope_no= —
   * ②(取り込み)の後、オンプレに生まれた運行から実物の23桁 `unko_no` を引く
   * (Refs #625)。
   *
   * 取り込み漏れ候補は GCP (alc) 由来の22桁 (対象CD抜き) しか無く、③ (勤務時間
   * 再登録) には実物の23桁が必須。**② で取り込んだ直後は、その運行はオンプレに
   * 存在する** — 23桁は CSV から読むのではなく、`GET /api/kintai/day-events`
   * (rust-ichibanboshi、Refs #205 の 57) をそのまま中継し `ope_no` (22桁) で
   * 絞るだけで引ける (`dtako-day-events-lookup.ts` の module doc 参照)。
   *
   * **読むだけ・②③どちらも実行しない。** ①②を実行済みかどうかはこの口では
   * 判定しない — ②の直後に呼んで反映されているかを確かめるのも、時間をおいて
   * もう一度呼ぶのも、呼び出し側 (人 / 画面) の責務。何回でも安全に呼べる
   * (副作用が無い) ようにしてあるのは、そのための設計 — ②の反映タイミングが
   * 未確認 (親の 0 段目コメント参照) なので、自動リトライは持たない。
   *
   * `ope_no` は22桁ちょうどでなければ拒否する — この口は「候補(22桁)から23桁を
   * 引く」専用で、既に23桁が分かっている対象にはそもそも要らない。
   */
  private async handleKintaiDayEventsLookup(url: URL): Promise<Response> {
    const driverCd = url.searchParams.get("driver_cd") || "";
    if (!/^\d{1,10}$/.test(driverCd)) {
      return dvrJsonError(400, "driver_cd は乗務員CD (数字) で指定してください");
    }
    const opeNo = url.searchParams.get("ope_no") || "";
    if (!/^\d{22}$/.test(opeNo)) {
      return dvrJsonError(400, `ope_no は22桁の数値 (GCP側の運行NO) で指定してください: "${opeNo}"`);
    }
    // 22桁は上のガードを通っているので deriveOpeNoFromUnkoNo は必ず成功する
    // (UNKO_NO_22_RE と同じ正規表現、`kintai-diff.ts` 参照)。
    const date = deriveOpeNoFromUnkoNo(opeNo)!.startOpe.slice(0, 10).replace(/\//g, "-");

    const creds = await this.ichibanCreds("kintai_day_events_lookup");
    if (!creds) return dvrJsonError(503, "オンプレの取得先 (NUXT_ICHIBAN_*) が未設定です");

    try {
      const q = new URLSearchParams({ driver: driverCd, date });
      const upstream = await fetch(`${creds.apiUrl}/api/kintai/day-events?${q.toString()}`, {
        headers: {
          "CF-Access-Client-Id": creds.clientId,
          "CF-Access-Client-Secret": creds.clientSecret,
        },
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        return dvrJsonError(502, `day-events が ${upstream.status} を返しました: ${text.slice(0, 300)}`);
      }
      let dayEvents: unknown;
      try {
        dayEvents = JSON.parse(text);
      } catch {
        return dvrJsonError(502, `day-events の応答がJSONではありません: ${text.slice(0, 300)}`);
      }
      const lookup = pickOnpremUnkoNoFromDayEvents(dayEvents, opeNo);
      console.log(
        JSON.stringify({ kintai_day_events_lookup: "ok", driver_cd: driverCd, date, status: lookup.status }),
      );
      return Response.json({ driver_cd: driverCd, date, ope_no: opeNo, lookup });
    } catch (err) {
      console.error(JSON.stringify({ kintai_day_events_lookup: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, err instanceof Error ? err.message : "day-events の取得に失敗しました");
    }
  }

  /**
   * GET /restraint-api/kintai/day-operations?driver_cd=&date= — その日の運行
   * 一覧を返す (Refs #633-17)。`day-events-lookup` の逆 — あちらは ope_no(22桁)
   * で絞って1件を返す専用、こちらは絞らず一覧を返す。上流は同じ
   * `GET /api/kintai/day-events`。
   *
   * **読むだけ・副作用なし。何度呼んでも安全。** 運行が0件でも200で
   * `operations: []` を返す (404にしない — その日に運行が無いのは正常な答え)。
   *
   * `ope_no`/`start_ope` は上流の `operations[].zip_request` からそのまま
   * (`dtako-day-operations-list.ts` 参照、加工しない)。
   */
  private async handleKintaiDayOperationsList(url: URL): Promise<Response> {
    const driverCd = url.searchParams.get("driver_cd") || "";
    if (!/^\d{1,10}$/.test(driverCd)) {
      return dvrJsonError(400, "driver_cd は乗務員CD (数字) で指定してください");
    }
    const date = url.searchParams.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return dvrJsonError(400, `date は YYYY-MM-DD で指定してください: "${date}"`);
    }

    const creds = await this.ichibanCreds("kintai_day_operations_list");
    if (!creds) return dvrJsonError(503, "オンプレの取得先 (NUXT_ICHIBAN_*) が未設定です");

    try {
      const q = new URLSearchParams({ driver: driverCd, date });
      const upstream = await fetch(`${creds.apiUrl}/api/kintai/day-events?${q.toString()}`, {
        headers: {
          "CF-Access-Client-Id": creds.clientId,
          "CF-Access-Client-Secret": creds.clientSecret,
        },
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        return dvrJsonError(502, `day-events が ${upstream.status} を返しました: ${text.slice(0, 300)}`);
      }
      let dayEvents: unknown;
      try {
        dayEvents = JSON.parse(text);
      } catch {
        return dvrJsonError(502, `day-events の応答がJSONではありません: ${text.slice(0, 300)}`);
      }
      const operations = pickDayOperationsList(dayEvents);
      console.log(
        JSON.stringify({ kintai_day_operations_list: "ok", driver_cd: driverCd, date, count: operations.length }),
      );
      return Response.json({ driver_cd: driverCd, date, operations });
    } catch (err) {
      console.error(JSON.stringify({ kintai_day_operations_list: "error", error: describeUnknownError(err) }));
      return dvrJsonError(502, err instanceof Error ? err.message : "day-events の取得に失敗しました");
    }
  }

  /**
   * POST /restraint-api/kintai/alc-upload — 突合明細から運行1件をalcへ上げ直す
   * ブラウザセッション版 (Refs #633-17)。`POST /kintai-relay/dtako-alc-upload`
   * (機械呼び出し・`X-Alc-Proxy-Secret`) と違うのは認証だけ — 実処理は同じ
   * `runDtakoAlcUploadJob` (`/cron/dtako/alc-upload` 内部経路) をそのまま呼ぶ
   * (ロジックを複製しない)。`comp_id` はクエリで受けず `record.compId`
   * (viewer 認可済み) を使う — `/restraint-api/kintai/fetch` と同じ。
   *
   * 応答は `/kintai-relay/dtako-alc-upload` と同じ形 (`upload_id` /
   * `operations_count` / `split_failed` / `split_confirmed` / `notes`)。
   * ここで畳み直し (fold) はしない — 呼び出し側 (画面) が別途案内する。
   */
  private async handleKintaiAlcUpload(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { ope_no?: unknown; start_ope?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return dvrJsonError(400, "body must be JSON");
    }
    const opeNo = typeof body.ope_no === "string" ? body.ope_no : "";
    if (!/^\d{22}$/.test(opeNo)) {
      return dvrJsonError(400, `ope_no は22桁の数値で指定してください: "${opeNo}"`);
    }
    const startOpe = typeof body.start_ope === "string" ? body.start_ope : "";
    if (!startOpe) {
      return dvrJsonError(400, "start_ope は必須です");
    }

    const account = await this.resolveAccount(record.compId);
    if (!account) {
      return dvrJsonError(500, `comp_id=${record.compId} が DTAKO_ACCOUNTS に見つかりません`);
    }
    const sharedSecret = await resolveSecret(this.env.INTERNAL_SHARED_SECRET);
    if (!sharedSecret) {
      return dvrJsonError(503, "INTERNAL_SHARED_SECRET 未設定のため alc へ投入できません");
    }

    return this.enqueueScrape(() => this.runDtakoAlcUploadJob(account, { opeNo, startOpe }, sharedSecret));
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
      const {
        shifts,
        paperDriftByDriver,
        paperOutsideByDriver,
        oursOutsideByDriver,
        minusUnkoByDriver,
        gapMidnightByDriver,
        ferryMinusByDriver,
      } = compareKosoku;
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
            paperOutsideByDate: paperOutsideByDriver.get(driver),
            oursOutsideByDate: oursOutsideByDriver.get(driver),
            minusUnkoByDate: minusUnkoByDriver.get(driver),
            gapMidnightByDate: gapMidnightByDriver.get(driver),
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
          paperOutsideByDriver,
          oursOutsideByDriver,
          minusUnkoByDriver,
          gapMidnightByDriver,
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

  /** kintai 系上流キャッシュ (`UPSTREAM_CACHE=on` の時だけ使う、Refs #543 PR-2)。
   * **この DO 自身の SQLite** — キャッシュ DO (`kintai-cache-*`) として呼ばれた
   * ときだけ中身が入る。経路 DO 側は remote client 経由で触る (Refs #554)。 */
  private upstreamCache: UpstreamCache | null = null;

  /** DO SQLite (`new_sqlite_classes`) 上の上流応答キャッシュ。lazy 生成。 */
  private upstreamCacheStore(): UpstreamCache {
    if (!this.upstreamCache) this.upstreamCache = new UpstreamCache(this.ctx.storage.sql);
    return this.upstreamCache;
  }

  /**
   * email 単位のキャッシュ DO への remote client (Refs #554)。
   *
   * 経路の DO (`theearth-{会社}:{ユーザー}`) は theearth アカウント単位で、共有
   * アカウント運用だと「誰のキャッシュか」が定まらない。キャッシュの中身は月単位の
   * 上流データで theearth とは無関係なので、**認可済みの email** で DO を分ける。
   *
   * email が無い (theearth セッション経路・introspect が email を返さない) 時は
   * null を返し、呼び出し側はキャッシュ無し (= 従来のライブ取得) に倒す。
   */
  private async remoteUpstreamCache(email: string | undefined): Promise<UpstreamCacheClient | null> {
    if (this.env.UPSTREAM_CACHE !== "on" || !email) return null;
    const name = await cacheDoNameForEmail(email);
    const stub = this.env.RELAY.get(this.env.RELAY.idFromName(name));
    const call = async (op: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
      stub.fetch(`https://relay.internal/internal/kintai-cache/${op}`, {
        method: "POST",
        headers,
        body,
      });
    return {
      async getFresh(kind, month, etag) {
        const res = await call("get", null, { "X-Kind": kind, "X-Month": month, "X-Cache-Etag": etag });
        if (res.status !== 200) return null;
        return new Uint8Array(await res.arrayBuffer());
      },
      async put(kind, month, bodyGz, sha256, etag) {
        // BLOB は body に直接載せる (base64 にすると 1.3 倍になる)
        const res = await call("put", bodyGz as unknown as BodyInit, {
          "X-Kind": kind,
          "X-Month": month,
          "X-Cache-Etag": etag,
          "X-Cache-Sha": sha256,
          "Content-Type": "application/octet-stream",
        });
        if (!res.ok) return false;
        return ((await res.json()) as { stored?: boolean }).stored === true;
      },
      async delete(kind, month) {
        await call("delete", null, { "X-Kind": kind, "X-Month": month });
      },
      async monthsWithBothKinds() {
        const res = await call("months", null);
        if (!res.ok) return [];
        return ((await res.json()) as { months?: string[] }).months ?? [];
      },
    };
  }

  /**
   * キャッシュ DO 側の内部ルート (Refs #554)。**外からは到達できない** —
   * worker の `fetch` は `/dvr-api/` `/restraint-api/` 等の既知 prefix しか DO へ
   * 流さず、`/internal/` は 404 になる。ここへ来るのは同 namespace の DO からの
   * stub 呼び出しだけ。
   */
  private async handleKintaiCacheInternal(request: Request, url: URL): Promise<Response> {
    const op = url.pathname.slice("/internal/kintai-cache/".length);
    const store = new LocalUpstreamCache(this.upstreamCacheStore());
    const kind = (request.headers.get("X-Kind") ?? "") as CacheKind;
    const month = request.headers.get("X-Month") ?? "";
    if (op === "months") {
      return Response.json({ months: await store.monthsWithBothKinds() });
    }
    if (kind !== "daily" && kind !== "kosoku") return dvrJsonError(400, "X-Kind は daily|kosoku");
    if (!/^\d{4}-\d{2}$/.test(month)) return dvrJsonError(400, "X-Month は YYYY-MM");
    if (op === "get") {
      const etag = request.headers.get("X-Cache-Etag") ?? "";
      const gz = await store.getFresh(kind, month, etag);
      // 204 = 行なし or 版不一致 (呼び出し側はライブ取得へ)
      if (!gz) return new Response(null, { status: 204 });
      return new Response(gz as unknown as BodyInit, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (op === "put") {
      const etag = request.headers.get("X-Cache-Etag") ?? "";
      const sha = request.headers.get("X-Cache-Sha") ?? "";
      const gz = new Uint8Array(await request.arrayBuffer());
      return Response.json({ stored: await store.put(kind, month, gz, sha, etag) });
    }
    if (op === "delete") {
      await store.delete(kind, month);
      return new Response(null, { status: 204 });
    }
    return dvrJsonError(404, "Not Found");
  }

  /**
   * rust の勤怠データ版数 (`GET /api/kintai/version?month=`) を月単位で引く
   * (Refs #543 PR-2、上流は ohishi-exp/rust-ichibanboshi#184)。応答は
   * `{month, etag}` — etag は opaque な版識別子で、SQLite キャッシュ行の
   * upstream_etag と一致すれば本文を再取得せずに済む。
   *
   * **取れなければ null = キャッシュ不使用 (ライブ取得へ)** — 鮮度の判定材料が
   * 無い以上、古い値を返す側に倒してはならない。60 秒 memo は本文と同じ
   * UpstreamMemo — 同一リクエスト群 (daily と kosoku が同じ月をほぼ同時に引く)
   * の照会を月 1 本に畳む。null (失敗) は memo されず次回再試行。
   */
  private fetchKintaiVersion(
    apiUrl: string,
    clientId: string,
    clientSecret: string,
    ym: string,
    timer?: PhaseTimer,
    phase?: string,
  ): Promise<string | null> {
    return this.memoKintaiUpstream(`kintai-version:${ym}`, () =>
      measurePhase(timer, phase ?? "version", () =>
        this.fetchKintaiVersionLive(apiUrl, clientId, clientSecret, ym, timer, phase),
      ),
    );
  }

  /** `fetchKintaiVersion` の memo 無し版 — 取り込み直後の強制更新 (Refs #543 PR-3)
   * は「今この瞬間の版」が要るので 60s memo を通さない。 */
  private async fetchKintaiVersionLive(
    apiUrl: string,
    clientId: string,
    clientSecret: string,
    ym: string,
    timer?: PhaseTimer,
    phase?: string,
  ): Promise<string | null> {
    try {
      const res = await fetch(`${apiUrl}/api/kintai/version?month=${encodeURIComponent(ym)}`, {
        headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret },
      });
      if (!res.ok) {
        console.error(JSON.stringify({ kintai_version: "upstream-error", ym, status: res.status }));
        return null;
      }
      const text = await res.text();
      if (timer && phase) timer.setBytes(phase, text.length);
      const etag = parseVersionResponse(JSON.parse(text));
      if (etag === null) {
        console.error(JSON.stringify({ kintai_version: "bad-shape", ym }));
      }
      return etag;
    } catch (err) {
      console.error(JSON.stringify({ kintai_version: "error", ym, error: describeUnknownError(err) }));
      return null;
    }
  }

  /**
   * kintai 系上流 (`daily` / `kosoku-daily`) の本文取得に DO SQLite キャッシュを
   * 挟む (Refs #543 PR-2)。`UPSTREAM_CACHE=on` の時だけ有効で、off (既定) なら
   * fetchLive をそのまま呼ぶ = 完全に従来経路。
   *
   * 鮮度は条件付き再検証で守る — 上流の版 (etag) が行と一致した時だけ本文を使う。
   * **古い値は一切返さない**:
   *
   * - 版照会が失敗 → キャッシュを読まずライブ取得 (tracker には "live")
   * - 行なし・版不一致 → ライブ取得して gzip upsert ("miss")
   * - キャッシュ層の失敗 (SQLite/gzip/破損本文) も全て握ってライブへ —
   *   キャッシュの不具合がリクエストを落とすことはない
   * - gzip 後 1.9MB 超は格納スキップ (DO SQLite の行 2MB 制限)。phase log に
   *   `cache-skip-*` の 0ms mark で残す
   */
  private async loadKintaiTextWithCache(opts: {
    kind: CacheKind;
    ym: string;
    apiUrl: string;
    clientId: string;
    clientSecret: string;
    /** 従来のライブ取得。失敗は null (呼び出し側の従来ハンドリングのまま)。 */
    fetchLive: () => Promise<string | null>;
    timer?: PhaseTimer;
    /** 本文フェーズ名 (cache-skip mark 用)。 */
    phase?: string;
    /** 版照会フェーズ名 ("version-cur" / "version-prev")。 */
    versionPhase?: string;
    tracker?: CacheStateTracker;
    /** email 単位キャッシュ DO の client (Refs #554)。**null ならキャッシュ不使用** —
     * identity が取れない経路 (theearth セッション) は従来どおりライブ取得。 */
    cache?: UpstreamCacheClient | null;
  }): Promise<string | null> {
    const { kind, ym, apiUrl, clientId, clientSecret, fetchLive, timer, phase, versionPhase, tracker, cache } =
      opts;
    if (this.env.UPSTREAM_CACHE !== "on" || !cache) return fetchLive();

    const etag = await this.fetchKintaiVersion(apiUrl, clientId, clientSecret, ym, timer, versionPhase);
    if (etag === null) {
      // 版が引けない = 鮮度を判定できない。キャッシュは読まずライブへ (安全側)
      tracker?.add("live");
      return fetchLive();
    }
    try {
      const gz = await cache.getFresh(kind, ym, etag);
      if (gz) {
        const text = await gunzipText(gz);
        tracker?.add("hit");
        return text;
      }
    } catch (err) {
      // 読み出し失敗 (SQLite/破損 gzip) はライブ取得で吸収する (応答は落とさない)
      console.error(
        JSON.stringify({ upstream_cache: "read-error", kind, ym, error: describeUnknownError(err) }),
      );
    }
    tracker?.add("miss");
    const text = await fetchLive();
    if (text !== null) {
      try {
        const gz = await gzipText(text);
        const stored = await cache.put(kind, ym, gz, await this.sha256Hex(gz), etag);
        if (!stored) {
          // 行 2MB 制限: gzip 後 1.9MB 超は格納しない (次回もライブ)。phase log に残す
          timer?.mark(`cache-skip-${phase ?? kind}`, gz.byteLength);
          console.log(JSON.stringify({ upstream_cache: "size-skip", kind, ym, gz_bytes: gz.byteLength }));
        }
      } catch (err) {
        console.error(
          JSON.stringify({ upstream_cache: "write-error", kind, ym, error: describeUnknownError(err) }),
        );
      }
    }
    return text;
  }

  /**
   * 取り込み系 (kintai/fetch・resummarize・拘束 CSV 取込) の完了後に、対象月の
   * 上流キャッシュ (SQLite 行 + 60s memo) を落とす (Refs #543 PR-3)。
   *
   * 「操作者が取り込みを押した = 上流データが動いたかもしれない」の合図なので、
   * 次の読みを必ず再検証 (版照会 → hit/miss) に倒す。**フラグ off でも実行する**
   * — SQL は空振りでも安価で、後からフラグを on にした時に古い行が残らない。
   * memo の無効化はキャッシュ機能と無関係に取り込み直後の画面を最新にする。
   *
   * best-effort — 無効化の失敗で取り込み応答は落とさない (次の読みは版照会で
   * どのみち守られる)。
   *
   * **落とせるのは操作者自身のキャッシュ DO だけ** (Refs #554)。キャッシュを email
   * 単位の DO に分けたため、他人ぶんには手が届かない。ただし鮮度は条件付き再検証が
   * 担保しており (読みは毎回 版照会 → etag 不一致なら miss)、この delete は
   * 「上流の etag が動かなかった場合」に備えた保険という位置づけ。memo (60s、この DO
   * ローカル) の無効化は従来どおり全経路に効く。
   */
  private async invalidateKintaiUpstreamCache(
    months: string[],
    reason: string,
    cache?: UpstreamCacheClient | null,
  ): Promise<void> {
    try {
      for (const ym of months) {
        this.kintaiUpstreamMemo.delete(`daily:${ym}`);
        this.kintaiUpstreamMemo.delete(`kosoku-raw:${ym}`);
        // ★ Refs #633-4: 全項目版 (kintai/diff 用) の memo/永続キャッシュも同時に
        // 落とす。これを忘れると、取り込み直後でも /kintai/diff だけ古いオンプレ
        // 応答を配り続ける (slim 側だけ最新になり、突合結果とズレる)。
        this.kintaiUpstreamMemo.delete(`kosoku-raw-full:${ym}`);
        this.kintaiUpstreamMemo.delete(`kintai-version:${ym}`);
        if (cache) {
          await cache.delete("daily", ym);
          await cache.delete("kosoku", ym);
          await cache.delete("kosoku-full", ym);
        }
      }
      console.log(JSON.stringify({ upstream_cache: "invalidated", reason, months, owner: Boolean(cache) }));
    } catch (err) {
      console.error(
        JSON.stringify({ upstream_cache: "invalidate-error", reason, error: describeUnknownError(err) }),
      );
    }
  }

  /**
   * kintai/fetch (取り込みボタン) 完了後の daily キャッシュ温め (Refs #543 PR-3)。
   *
   * 取り込みが持っている最新の daily 本文 (refresh=1 で取り直した rawText) を
   * **二度取りせず**そのまま格納する。ただし本文と版の対応がズレると「新しい
   * etag に古い本文」が hit し続ける事故になるため、**取り込み前後の版が一致した
   * 時だけ**格納する (etagBefore/etagAfter の二重確認)。ズレた・版が引けない時は
   * 行を消して次回 miss に倒す (invalidate 済みなので何もしない = 消えたまま)。
   *
   * kosoku 側はここで温めない — 読み経路 (loadKintaiTextWithCache) が miss 時に
   * write-through するため、次の読みが自然に格納する (二度取りもしない)。
   *
   * best-effort — 温めの失敗で取り込み応答は落とさない。
   */
  private async warmDailyCacheAfterIngest(
    apiUrl: string,
    clientId: string,
    clientSecret: string,
    ym: string,
    dailyText: string,
    etagBefore: string | null,
    cache: UpstreamCacheClient | null,
  ): Promise<void> {
    if (this.env.UPSTREAM_CACHE !== "on" || etagBefore === null || !cache) return;
    try {
      const etagAfter = await this.fetchKintaiVersionLive(apiUrl, clientId, clientSecret, ym);
      if (etagAfter === null || etagAfter !== etagBefore) {
        // 取り込み中に版が動いた / 版が引けない — 温めを見送る (行は invalidate で
        // 消えているので、次の読みが版照会付きで作り直す)
        console.log(
          JSON.stringify({ upstream_cache: "warm-skip", ym, reason: etagAfter === null ? "version-failed" : "version-moved" }),
        );
        return;
      }
      const gz = await gzipText(dailyText);
      const stored = await cache.put("daily", ym, gz, await this.sha256Hex(gz), etagAfter);
      console.log(
        JSON.stringify({ upstream_cache: stored ? "warmed" : "size-skip", kind: "daily", ym, gz_bytes: gz.byteLength }),
      );
    } catch (err) {
      console.error(JSON.stringify({ upstream_cache: "warm-error", ym, error: describeUnknownError(err) }));
    }
  }

  /**
   * 手動キャッシュ warm (`POST /restraint-api/kintai/warm?month=YYYY-MM`、Refs #554)。
   *
   * 上流 (rust-ichibanboshi) をデプロイすると版 (etag) が動いて全月が miss になる
   * (ohishi-exp/rust-ichibanboshi#191)。次に画面を開いた人が 1.7MB × 2 種を月ぶん
   * 払うことになるので、**先に押しておける口**を用意する。cron ではなく手動なのは、
   * 上流キャッシュが DO ごと = `theearth-{会社}:{ユーザー}` ごとに分かれているため —
   * 押した本人の DO が温まり、その人が読むのも同じ DO になる。
   *
   * 1 リクエスト 1 ヶ月。複数月は front が**順番に**叩く (並列にすると 1.7MB 級の
   * 取得が重なり、上流の kosoku 同時実行キャップ (rust-ichibanboshi#188) と競合する)。
   * daily → kosoku も直列。
   *
   * 応答の `daily` / `kosoku` は `CacheStateTracker` の集約そのまま:
   * `hit` = 既に温まっていた / `miss` = 取り直して格納した / `live` = 版が引けず
   * キャッシュ不使用 (温まっていない)。`error` は上流取得に失敗した月。
   */
  private async handleKintaiWarm(record: TheearthSessionRecord, url: URL): Promise<Response> {
    const ym = url.searchParams.get("month") ?? "";
    if (!/^\d{4}-\d{2}$/.test(ym)) {
      return dvrJsonError(400, "month は YYYY-MM で指定してください");
    }
    const cache = await this.remoteUpstreamCache(record.viewerEmail);
    if (!cache) {
      // フラグ off / email 不明。「壊れている」ではないので 200 で伝える
      return Response.json({ month: ym, enabled: false, daily: "off", kosoku: "off", ms: 0 });
    }
    const creds = await this.ichibanCreds("kintai-warm");
    if (!creds) return dvrJsonError(503, "上流 API (rust-ichibanboshi) の接続情報が未設定です");
    const { apiUrl, clientId, clientSecret } = creds;
    const startedAt = Date.now();
    const dailyTracker = new CacheStateTracker();
    const kosokuTracker = new CacheStateTracker();

    const dailyText = await this.fetchKintaiDailyText({
      apiUrl,
      clientId,
      clientSecret,
      ym,
      tracker: dailyTracker,
      cache,
    });
    const kosokuRaw = await this.fetchKosokuRaw(
      apiUrl,
      clientId,
      clientSecret,
      ym,
      undefined,
      undefined,
      undefined,
      kosokuTracker,
      cache,
    );

    const daily = dailyText === null ? "error" : dailyTracker.aggregate();
    const kosoku = kosokuRaw === null ? "error" : kosokuTracker.aggregate();
    const ms = Date.now() - startedAt;
    console.log(JSON.stringify({ upstream_cache: "warm-manual", month: ym, daily, kosoku, ms }));
    return Response.json({ month: ym, enabled: true, daily, kosoku, ms });
  }

  /**
   * `/api/kintai/daily` の上流本文 (テキスト) をキャッシュ経由で取る (Refs #554)。
   *
   * `buildKintaiSummariesLive` に inline で持っていたものを切り出した — 手動 warm
   * (`/restraint-api/kintai/warm`) が**読みと同じ経路・同じキャッシュ鍵**で温めるため。
   * URL と cache kind をここ 1 箇所に閉じておかないと、warm が別の行を作って
   * 「温めたのに次の読みが miss」になりかねない。
   */
  private fetchKintaiDailyText(opts: {
    apiUrl: string;
    clientId: string;
    clientSecret: string;
    ym: string;
    timer?: PhaseTimer;
    phase?: string;
    versionPhase?: string;
    tracker?: CacheStateTracker;
    cache?: UpstreamCacheClient | null;
  }): Promise<string | null> {
    const { apiUrl, clientId, clientSecret, ym, timer, phase, versionPhase, tracker, cache } = opts;
    return this.loadKintaiTextWithCache({
      kind: "daily",
      ym,
      apiUrl,
      clientId,
      clientSecret,
      timer,
      phase,
      versionPhase,
      tracker,
      cache,
      fetchLive: async () => {
        try {
          const res = await fetch(`${apiUrl}/api/kintai/daily?month=${encodeURIComponent(ym)}`, {
            headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret },
          });
          if (!res.ok) {
            console.error(JSON.stringify({ wage_report_kintai: "daily-error", month: ym, status: res.status }));
            return null;
          }
          const t = await res.text();
          // 応答サイズを計測に載せる (memo ヒット時はこの loader ごと呼ばれない = bytes 無し)
          if (phase) timer?.setBytes(phase, t.length);
          return t;
        } catch (err) {
          console.error(
            JSON.stringify({ wage_report_kintai: "daily-throw", month: ym, error: describeUnknownError(err) }),
          );
          return null;
        }
      },
    });
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
    versionPhase?: string,
    tracker?: CacheStateTracker,
    cache?: UpstreamCacheClient | null,
  ): Promise<unknown> {
    return this.memoKintaiUpstream(`kosoku-raw:${ym}`, async () => {
      const text = await this.loadKintaiTextWithCache({
        kind: "kosoku",
        ym,
        apiUrl,
        clientId,
        clientSecret,
        timer,
        phase,
        versionPhase,
        tracker,
        cache,
        fetchLive: async () => {
          try {
            const upstream = await fetch(
              `${apiUrl}/api/kintai/kosoku-daily?month=${encodeURIComponent(ym)}&view=timecard`,
              { headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } },
            );
            if (!upstream.ok) {
              console.error(JSON.stringify({ kosoku_raw: "upstream-error", ym, status: upstream.status }));
              return null;
            }
            const t = await upstream.text();
            // 応答サイズを計測に載せる (memo ヒット時はこの loader ごと呼ばれない = bytes 無し)
            if (timer && phase) timer.setBytes(phase, t.length);
            return t;
          } catch (err) {
            console.error(JSON.stringify({ kosoku_raw: "error", ym, error: describeUnknownError(err) }));
            return null;
          }
        },
      });
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        console.error(JSON.stringify({ kosoku_raw: "error", ym, error: describeUnknownError(err) }));
        return null;
      }
    });
  }

  /**
   * `kosoku-daily` の上流生応答を**全項目版** (`view` 省略) で月単位 memo する
   * (Refs #633-4)。`fetchKosokuRaw` (`view=timecard`、画面経路の減量用) とは
   * **別物** — `/kintai/diff` (オンプレ⇔GCP突合) だけがこちらを使う。
   *
   * ★★ 分ける理由 (親の実測で確定した本番バグ、2026-08-04): `view=timecard` は
   * `rest_minus_minutes` 等 5 項目をキーごと欠く。突合は11分数を全部比較するため、
   * slim 応答を渡すと欠損を0扱いして存在しない差をでっち上げる (2026-06 実測:
   * 「値が違う」26件中23件がこの偽陽性だった)。
   *
   * `memoKintaiUpstream` のキー (`kosoku-raw-full:${ym}`) と DO SQLite 永続キャッシュ
   * の `CacheKind` (`"kosoku-full"`) を、どちらも `fetchKosokuRaw` の slim 経路
   * (`kosoku-raw:${ym}` / `"kosoku"`) と別にする — 混ぜると、他方の呼び出し
   * (wage-report / `/kintai/kosoku-daily` 中継) の memo/キャッシュと入れ替わって
   * 配信される事故になる。
   *
   * 取れなければ null (memo されず次回再試行)。
   */
  private fetchKosokuRawFull(
    apiUrl: string,
    clientId: string,
    clientSecret: string,
    ym: string,
    timer?: PhaseTimer,
    phase?: string,
    versionPhase?: string,
    tracker?: CacheStateTracker,
    cache?: UpstreamCacheClient | null,
  ): Promise<unknown> {
    return this.memoKintaiUpstream(`kosoku-raw-full:${ym}`, async () => {
      const text = await this.loadKintaiTextWithCache({
        kind: "kosoku-full",
        ym,
        apiUrl,
        clientId,
        clientSecret,
        timer,
        phase,
        versionPhase,
        tracker,
        cache,
        fetchLive: async () => {
          try {
            const upstream = await fetch(
              `${apiUrl}/api/kintai/kosoku-daily?month=${encodeURIComponent(ym)}`,
              { headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } },
            );
            if (!upstream.ok) {
              console.error(JSON.stringify({ kosoku_raw_full: "upstream-error", ym, status: upstream.status }));
              return null;
            }
            const t = await upstream.text();
            if (timer && phase) timer.setBytes(phase, t.length);
            return t;
          } catch (err) {
            console.error(JSON.stringify({ kosoku_raw_full: "error", ym, error: describeUnknownError(err) }));
            return null;
          }
        },
      });
      if (text === null) return null;
      try {
        return JSON.parse(text) as unknown;
      } catch (err) {
        console.error(JSON.stringify({ kosoku_raw_full: "error", ym, error: describeUnknownError(err) }));
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
   * **取得先が未設定・上流が落ちている時は null を返す。** 以前はここで呼び出し側が
   * R2 (写し) へ落ちていたが、2026-08-03 決定 (#606-5) でそのフォールバックは撤去済み
   * — null は `loadWageReportSource` で「timecard 行を空にする」に直結する。
   * 握り潰さないよう、null を返す分岐にはそれぞれ理由を残す。
   */
  private async buildKintaiSummariesLive(
    compId: string,
    ym: string,
    prevYm: string,
    cache: UpstreamCacheClient | null,
    timer?: PhaseTimer,
    tracker?: CacheStateTracker,
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
      // secret 不調は他所で log 済み。ここでは配線未設定と同じ扱いに倒すだけで良い
    }
    if (!apiUrl || !clientId || !clientSecret) {
      console.error(JSON.stringify({ wage_report_kintai: "live-not-configured", comp_id: compId, ym }));
      return null;
    }

    const fetchDaily = async (
      month: string,
      phase: string,
      versionPhase: string,
    ): Promise<TimecardDailyRow[] | null> => {
      const text = await this.fetchKintaiDailyText({
        apiUrl,
        clientId,
        clientSecret,
        ym: month,
        timer,
        phase,
        versionPhase,
        tracker,
        cache,
      });
      if (text === null) return null;
      try {
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
        this.memoKintaiUpstream(`daily:${ym}`, () => fetchDaily(ym, "daily-cur", "version-cur")),
      ),
      measurePhase(timer, "daily-prev", () =>
        this.memoKintaiUpstream(`daily:${prevYm}`, () => fetchDaily(prevYm, "daily-prev", "version-prev")),
      ),
      // kosoku の memo は fetchKosokuRaw の生応答層にある (Refs #508) — 画面の
      // `/kintai/kosoku-daily` 中継と同じ月を共有するため、ここでは重ねない
      measurePhase(timer, "kosoku-cur", () =>
        this.loadKosokuShifts(apiUrl, clientId, clientSecret, [ym], timer, "kosoku-cur", "version-cur", tracker),
      ),
      measurePhase(timer, "kosoku-prev", () =>
        this.loadKosokuShifts(apiUrl, clientId, clientSecret, [prevYm], timer, "kosoku-prev", "version-prev", tracker),
      ),
    ]);
    // 当月の勤務 = 前月から跨いだ分 + 当月分 (`kosokuPartsByDate` が当月に落ちる分だけ拾う)
    const kosokuCurrent = mergeKosokuShiftMaps(shiftsPrev, shiftsCurrent);
    const kosokuPrev = shiftsPrev;
    // 当月の `/api/kintai/daily` が取れないと賃金の素材が無い。R2 へは落とさず null
    // (呼び出し側で timecard 行が空になる、#606-5) — 握り潰さずここで理由を残す
    if (!dailyCurrent) {
      console.error(JSON.stringify({ wage_report_kintai: "live-daily-missing", comp_id: compId, ym }));
      return null;
    }

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
    versionPhase?: string,
    tracker?: CacheStateTracker,
  ): Promise<Map<string, KosokuShift[]> | null> {
    const fetchMonth = async (ym: string): Promise<Map<string, KosokuShift[]> | null> => {
      // 賃金計算 (wage-report) の経路 — 画面の `/kintai/kosoku-daily` 中継と
      // 同じ生応答 memo を共有する (Refs #508)。view=timecard の slim 応答でも
      // parseKosokuDaily は欠けた数値を 0 に落とすので同じ形に畳める
      const body = await this.fetchKosokuRaw(apiUrl, clientId, clientSecret, ym, timer, phase, versionPhase, tracker);
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
    paperOutsideByDriver: Map<string, Map<string, number>>;
    oursOutsideByDriver: Map<string, Map<string, number>>;
    minusUnkoByDriver: Map<string, Map<string, number>>;
    gapMidnightByDriver: Map<string, Map<string, number>>;
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
    // 紙だけが数える勤務外の分も当月応答からだけ読む (Refs #546 / rust#182)
    const paperOutsideByDriver =
      curBody == null
        ? new Map<string, Map<string, number>>()
        : parsePaperOutsideByDriver(curBody);
    const oursOutsideByDriver =
      curBody == null
        ? new Map<string, Map<string, number>>()
        : parseOursOutsideByDriver(curBody);
    // 紙が引く 運行開始 → 始業 も当月応答からだけ読む (cause "minus-unko" の実額)
    const minusUnkoByDriver =
      curBody == null ? new Map<string, Map<string, number>>() : parseMinusUnkoByDriver(curBody);
    // 深夜を跨ぐ継ぎ目の暦日配分の差も当月応答からだけ読む (cause "gap-midnight" の実額)
    const gapMidnightByDriver =
      curBody == null
        ? new Map<string, Map<string, number>>()
        : parseGapMidnightByDriver(curBody);
    // フェリー控除の日別マップも当月応答からだけ読む (rust#181 — 勤務に貼れない日がある)
    const ferryMinusByDriver =
      curBody == null ? new Map<string, Map<string, number>>() : parseFerryMinusByDriver(curBody);
    // 当月が取れていないと時間が丸ごと出ないので、その時は諦める
    if (curBody == null) {
      return {
        shifts: null,
        paperDriftByDriver,
        paperOutsideByDriver,
        oursOutsideByDriver,
        minusUnkoByDriver,
        gapMidnightByDriver,
        ferryMinusByDriver,
      };
    }
    const merged = new Map<string, KosokuShift[]>();
    for (const body of [curBody, prevBody]) {
      if (body == null) continue;
      for (const [driverCd, shifts] of parseKosokuDaily(body)) {
        merged.set(driverCd, [...(merged.get(driverCd) ?? []), ...shifts]);
      }
    }
    return {
      shifts: merged,
      paperDriftByDriver,
      paperOutsideByDriver,
      oursOutsideByDriver,
      minusUnkoByDriver,
      gapMidnightByDriver,
      ferryMinusByDriver,
    };
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
    const [months, kintaiMonths, ichibanSynced] = await Promise.all([
      this.listMonthDirs(bucket, `${prefix}/${record.compId}/`),
      this.listMonthDirs(bucket, `${kintaiPrefix}/${record.compId}/`),
      this.listIchibanSyncedMonths(record.compId),
    ]);
    return Response.json({
      months,
      kintai_months: kintaiMonths,
      ichiban_months: ichibanSynced.theearth,
      // timecard 側が ichiban へ同期済みの月 (#611 の無人同期、Refs #614)。
      // 「高速表示可」バッジの判定自体は theearth 基準のまま変えない (#606-5 で
      // timecard は live-build 一本化済み、同期の有無は表示速度に効かない) が、
      // 画面がどちらの source までバックフィルが進んでいるかを読めるようにする
      ichiban_months_timecard: ichibanSynced.timecard,
      // kintai 上流キャッシュ (daily+kosoku 両方) が揃っている月 — 月タブの
      // 「高速表示可」バッジの 2 段階表示用 (Refs #543 followup)。閲覧者自身の
      // キャッシュ DO に問い合わせる (Refs #554) — バッジは「自分にとって速いか」
      kintai_cached_months: await this.kintaiCachedMonths(record.viewerEmail),
    });
  }

  /** 「高速表示可」バッジ用: kintai 上流キャッシュが揃っている月 (Refs #543 followup)。
   * フラグ off / email 不明ではキャッシュが読まれない = 「速い」表示が嘘になるので空。
   * 失敗しても archive/months 自体は落とさない (バッジが弱表示になるだけ)。 */
  private async kintaiCachedMonths(email: string | undefined): Promise<string[]> {
    try {
      const cache = await this.remoteUpstreamCache(email);
      if (!cache) return [];
      return await cache.monthsWithBothKinds();
    } catch (err) {
      console.error(JSON.stringify({ upstream_cache: "months-error", error: describeUnknownError(err) }));
      return [];
    }
  }

  /** ichiban に拘束サマリが push 済みの月一覧、theearth と timecard の両方
   * (Refs #460、#614)。月タブの「高速表示可」バッジ (theearth 基準) と未同期時の
   * バックフィル案内、および timecard 側の無人同期 (#611) がどこまで進んでいるかの
   * 画面表示に使う。best-effort — 未設定・失敗は両方空 (バッジが出ないだけで
   * 月タブは従来どおり動く)。 */
  private async listIchibanSyncedMonths(compId: string): Promise<{ theearth: string[], timecard: string[] }> {
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
      return { theearth: [], timecard: [] };
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
        return { theearth: [], timecard: [] };
      }
      const raw = (await res.json()) as { entries?: unknown };
      if (!Array.isArray(raw.entries)) {
        console.error(JSON.stringify({ restraint_synced_months: "bad-shape", comp_id: compId }));
        return { theearth: [], timecard: [] };
      }
      const entries = raw.entries.filter(
        (e): e is { source: string, month: string } =>
          typeof e === "object" && e !== null
          && typeof (e as { source?: unknown }).source === "string"
          && typeof (e as { month?: unknown }).month === "string",
      );
      // source 別に集計する (#614) — 「高速表示可」の判定自体は theearth 基準の
      // ままだが (fan-out を支配するのは theearth 側)、timecard 側の無人同期
      // (#611) がどこまで進んでいるかも画面が読めるようにする
      const monthsOf = (source: "theearth" | "timecard") =>
        [...new Set(entries.filter((e) => e.source === source).map((e) => e.month))].sort((a, b) =>
          b.localeCompare(a)
        );
      const theearth = monthsOf("theearth");
      const timecard = monthsOf("timecard");
      console.log(
        JSON.stringify({
          restraint_synced_months: "ok",
          comp_id: compId,
          months: theearth.length,
          months_timecard: timecard.length,
        }),
      );
      return { theearth, timecard };
    } catch (err) {
      console.error(
        JSON.stringify({ restraint_synced_months: "error", comp_id: compId, error: describeUnknownError(err) }),
      );
      return { theearth: [], timecard: [] };
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
   * これは「保存済み CSV から同じサマリが再現された」ことの記録として正しい)。
   *
   * **timecard 版はこれの対になるものを作らない** (2026-08-03 判断、#614)。
   * ここでの再計算は「保存済みの生 CSV から表示用サマリを組み直す」もので、
   * timecard 側は `loadWageReportSource` が wage-report のたびに
   * `buildKintaiSummariesLive` で打刻 + kosoku-daily から毎回組み直しており
   * (#606-5、写しフォールバック無し)、再計算し直すべき「古い表示用サマリ」が
   * そもそも存在しない。突合・履歴用の写し (R2 kintai/ prefix・D1・ichiban) の
   * 更新は #611 の無人同期 (毎日 JST 4:00 の cron/restraint-sync) が担うため、
   * 手動再計算の口も要らない。 */
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
    // 上流キャッシュの無効化 (Refs #543 PR-3)。resummarize 自体は kintai 上流を
    // 変えないが、「操作者が再計算した = 表示を最新にしたい」合図なので、次の
    // kintai 読みを再検証に倒す (最新テキストは持っていないので put はしない)
    this.invalidateKintaiUpstreamCache([parsed.ym, prevYmOf(parsed.ym)], "resummarize");
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
   * **theearth 側** (`current` / `prev`) はまず ichiban の
   * `GET /api/restraint/wage-source` を 1 fetch — Phase 3b の push が溜めた写しで、
   * 従来の R2 GET 約300本 (fan-out) を置き換える。フォールバックは 2 段
   * (theearth 側にのみ適用。timecard 側は下記の通り別扱い):
   *
   * - fetch 自体の失敗 / 未設定環境 → 全部 R2 (従来経路そのまま)
   * - fetch は成功したが特定の (source, 月) が未 push (`synced_at` null) →
   *   その piece だけ R2 から読む (push が追い付くまでの過渡期・新月の初回)
   *
   * **timecard 側** (`kintaiCurrent` / `kintaiPrev`) は **`buildKintaiSummariesLive`
   * の成否だけで決める** (2026-08-03 決定、#606-5 — 写しフォールバックを撤去)。
   * ichiban `wage-source` の `current_timecard`/`prev_timecard` も R2 (`kintai/`
   * prefix) も「`kintai/fetch` (取り込みボタン) が最後に押された時点の写し」でしか
   * なく、押し直す無人経路が無い (cron にも MCP にも `/restraint-api/kintai/fetch`
   * を叩く口が無い)。化石を読むと「493時間」「月まるごと空」のような値を
   * 「正しい拘束時間」として黙って表示しかねない (実測、#606-5)。
   * **live が失敗したら timecard 行は空にする** — 古い値を出すより欠ける方を選ぶ
   * (親判断)。失敗は `kintaiLive: false` で呼び出し側まで伝え、console.error でも
   * 残す (「黙って空」は不可)。
   */
  private async loadWageReportSource(
    bucket: R2Bucket,
    compId: string,
    ym: string,
    prevYm: string,
    cache: UpstreamCacheClient | null,
    timer?: PhaseTimer,
    tracker?: CacheStateTracker,
  ): Promise<{
    current: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
    prev: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
    kintaiCurrent: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
    kintaiPrev: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>>;
    /** timecard 側 live-build の成否。false なら kintaiCurrent/kintaiPrev は
     * 空 (`{ summaries: [], noDataDrivers: [] }`)。呼び出し側 (`handleWageReport`)
     * は warnings 等で応答から観測できるようにすること (#606-5、握り潰し禁止)。 */
    kintaiLive: boolean;
  }> {
    // タイムカード側は **R2 も ichiban の写しも読まず、live-build の成否だけで決める**
    // (2026-07-28「R2 やめろ」決定 → 2026-08-03 に写しフォールバックも撤去、#606-5)。
    // 上の docstring 参照。
    const live = await measurePhase(timer, "kintai-live", () =>
      this.buildKintaiSummariesLive(compId, ym, prevYm, cache, timer, tracker),
    );
    const emptyKintaiMonth: Awaited<ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>> = {
      summaries: [],
      noDataDrivers: [],
    };
    if (!live) {
      // 握り潰さない — buildKintaiSummariesLive 内で理由別ログ済みだが、ここでも
      // 「wage-report のこの応答は timecard 側が空になった」ことを明示しておく
      console.error(JSON.stringify({ wage_report_kintai: "live-failed-empty", comp_id: compId, ym }));
    }
    const kintaiCurrent = live ? live.current : emptyKintaiMonth;
    const kintaiPrev = live ? live.prev : emptyKintaiMonth;
    const kintaiLive = live !== null;
    const fromR2 = {
      current: () =>
        measurePhase(timer, "r2-theearth-cur", () => this.loadMonthSummaries(bucket, compId, ym)),
      prev: () =>
        measurePhase(timer, "r2-theearth-prev", () => this.loadMonthSummaries(bucket, compId, prevYm)),
    };
    const allR2 = async () => {
      const [current, prev] = await Promise.all([fromR2.current(), fromR2.prev()]);
      return { current, prev, kintaiCurrent, kintaiPrev, kintaiLive };
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

    // 未 push (synced_at null) の piece だけ R2 へ (過渡期・新月初回) — **theearth 側のみ**。
    // timecard 側 (`wire.current_timecard` / `wire.prev_timecard`) はここでは一切読まない
    // (#606-5 — 上の docstring 参照。読むと化石スナップショットが表示に混ざる)
    const pick = async (
      month: WageSourceMonthWire,
      fallback: () => ReturnType<DtakoScraperRelayDO["loadMonthSummaries"]>,
      label: string,
    ) => {
      if (month.synced_at !== null) return wageSourceMonthToSummaries(month);
      console.log(JSON.stringify({ wage_report_source: "r2-piece-fallback", comp_id: compId, piece: label }));
      return fallback();
    };
    const [current, prev] = await Promise.all([
      pick(wire.current_theearth, fromR2.current, `theearth:${ym}`),
      pick(wire.prev_theearth, fromR2.prev, `theearth:${prevYm}`),
    ]);
    console.log(JSON.stringify({ wage_report_source: "ichiban", comp_id: compId, ym }));
    return { current, prev, kintaiCurrent, kintaiPrev, kintaiLive };
  }

  /**
   * `wage-report?source=gcp` 用に GCP `kintai.day_summaries` を月ぶん読む。
   *
   * 経路は `/kintai/diff` の GCP 側とまったく同じ (auth-worker `/ichibanboshi-proxy`
   * 経由の `relayKintaiDaySummaries`) — オンプレ (`kosoku-daily`) とは別の口なので
   * 混同しないこと。
   *
   * **取れなければ古い値へ倒さず Response (502) を返す。** ここでフォールバックすると
   * 「GCP を選んだのにオンプレの数字が出る」= 切り替えが効いていないのに効いたように
   * 見える状態になり、突合の道具として成立しない (#606-5 の「化石を黙って出さない」と
   * 同じ考え方)。
   */
  private async loadGcpDayTimes(
    compId: string,
    months: readonly string[],
  ): Promise<Map<string, Map<string, Map<string, GcpDayPart>>> | Response> {
    const ctx = await this.buildKintaiRelayContext(compId, "wage_report_gcp");
    if (ctx instanceof Response) return ctx;
    const out = new Map<string, Map<string, Map<string, GcpDayPart>>>();
    for (const month of months) {
      try {
        out.set(month, parseGcpDaySummaries(await relayKintaiDaySummaries(ctx.deps, { month })));
      } catch (err) {
        const message = describeUnknownError(err);
        console.error(JSON.stringify({ wage_report_gcp: "error", comp_id: compId, month, error: message }));
        return dvrJsonError(502, `GCP day-summaries (${month}) の取得に失敗しました: ${message}`);
      }
    }
    return out;
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
   * **重複は timecard が勝つ** (2026-07-28 決定 — 賃金は打刻を根拠にする)。
   *
   * ## `?source=gcp` — 拘束時間ソースの切り替え (最低賃金チェック用)
   *
   * 省略時 (`current`) は**上の経路そのまま** = 従来の応答と 1 バイトも変わらない。
   * `gcp` を渡した時だけ、合流後のサマリの**時間を GCP `kintai.day_summaries` 由来に
   * 差し替えて**から `computeWageRow` を回す (`gcp-day-summaries.ts`)。休暇・休日区分・
   * 運転/荷役などデジタコ側にしか無い項目は元のまま残る。
   *
   * GCP にその乗務員 × その月の行が 1 つも無い行は **0 分ではなく欠測** (`restraint_missing`)
   * にして返す — 0 に倒すと「拘束 0 の月」として最低賃金割れの判定が回ってしまう
   * (ユーザー決定 2026-08-04)。GCP の取得に失敗した時は**古い値へ倒さず 502** にする。 */
  private async handleWageReport(
    record: TheearthSessionRecord,
    url: URL,
    ifNoneMatch: string | null,
  ): Promise<Response> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return dvrJsonError(503, "R2 (DTAKO_R2) が未設定です");
    const parsed = this.parseMonthParam(url);
    if (!parsed) return dvrJsonError(400, "month は YYYY-MM で指定してください");
    const { year, month, ym } = parsed;
    const restraintSource = url.searchParams.get("source") === "gcp" ? "gcp" : "current";
    // フェーズ計測 (Refs #543 PR-1)。挙動は変えない — ログ 1 行と Server-Timing だけ
    const timer = new PhaseTimer();
    // キャッシュの hit/miss/live を phase log の cacheState に載せる (Refs #543 PR-2)
    const tracker = new CacheStateTracker();
    // 上流キャッシュは閲覧者の email 単位 DO にある (Refs #554)。email が取れない
    // 経路 (theearth セッション) では null = 従来どおりライブ取得
    const wageCache = await this.remoteUpstreamCache(record.viewerEmail);

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
    // タイムカード由来 (本社事務員等、デジタコに乗らない人) のサマリは
    // `loadWageReportSource` が live-build の成否だけで組む (#606-5、Refs #424 PR-D)
    // マスタ 3 種と当月・前月 summary は互いに独立なので一括並列で読む (月切替の体感に直結)
    const [wageMaster, minWageMaster, config, { current, prev, kintaiCurrent, kintaiPrev, kintaiLive }] =
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
          this.loadWageReportSource(bucket, record.compId, ym, prevYm, wageCache, timer, tracker),
        ),
      ]);
    const { noDataDrivers } = current;
    const endMerge = timer.begin("merge");
    // 同じ乗務員CD が両方に居たら timecard を採る (打刻を賃金の根拠にする、2026-07-28)
    const { merged, warnings } = mergeSummarySources(current.summaries, kintaiCurrent.summaries);
    // live-build 失敗は握り潰さない — timecard 行が空になっていることを応答の
    // warnings から観測できるようにする (#606-5。古い写しへは戻さない)
    if (!kintaiLive) {
      warnings.push(
        "タイムカード側の live-build に失敗したため、この月はタイムカード由来の行を表示していません"
          + " (古い写しにはフォールバックしません。取り込み先の疎通を確認してください)",
      );
    }
    // 前月 days (週40h の月初跨ぎ週用) も同じ優先順で合流する — 当月と別の source を
    // 混ぜると跨ぎ週の実働が二重に積まれる
    const { merged: prevMerged } = mergeSummarySources(prev.summaries, kintaiPrev.summaries);

    if (merged.length > 0 && prevMerged.length === 0) {
      warnings.push(
        `前月 (${prevYm}) の summary がアーカイブに無いため、月初の跨ぎ週の週40h計算は当月分のみで近似しています`,
      );
    }
    endMerge();

    // `source=gcp` の時だけ、合流後のサマリの時間を GCP 由来に差し替える。
    // 当月と前月の両方を差し替える — 片方だけだと月初の跨ぎ週で 2 つのソースの
    // 実働が混ざる (既定経路が当月/前月で同じ優先順を使っているのと同じ理由)
    const gcpOverlay =
      restraintSource === "gcp"
        ? await timer.measure("gcp-day-summaries", () =>
            this.loadGcpDayTimes(record.compId, [ym, prevYm]),
          )
        : null;
    if (gcpOverlay instanceof Response) return gcpOverlay;
    const overlay = (entry: RestraintDriverSummary, forYm: string) =>
      gcpOverlay
        ? overlayGcpDayTimes(entry, gcpPartsFor(gcpOverlay.get(forYm)!, entry.driverCd), forYm)
        : { summary: entry, missing: false };

    const prevDaysByDriver = new Map<string, RestraintSummaryDay[]>(
      prevMerged.map((m) => [m.entry.data.driverCd, overlay(m.entry.data, prevYm).summary.days]),
    );
    // 最低賃金の県は theearth の事業所名ではなく社員マスタの所属 (月末時点) で引く
    // (Refs #409 Phase 3)。D1 が無い / 読めない場合は空のまま = 従来どおり
    // theearth 事業所名 + defaultPrefecture のフォールバックで動く
    const { branches: employeeBranches, payKubun } = await timer.measure("branches", () =>
      this.branchByDriverCd(record.compId, ym),
    );

    const endRows = timer.begin("rows");
    const rows = merged.map(({ entry, source }) => {
      const { summary, missing } = overlay(entry.data, ym);
      return {
        summary,
        /** 'theearth' (デジタコ) | 'timecard' (タイムカード)。画面のバッジ用 (PR-E)。 */
        source,
        /** 給与区分 (1=月給 / 2=日給 / 3=時給 / 4=その他)。社員マスタに無ければ null。
         * 給与比較が「基本給(計算)」の単価の掛け方を決めるのに使う (Refs #429)。 */
        pay_kubun: payKubun.get(entry.data.driverCd) ?? null,
        fetched_at: entry.fetchedAt,
        last_verified_at: entry.lastVerifiedAt,
        /** `source=gcp` で GCP 側にこの乗務員 × この月の行が無かった (= 欠測)。
         * **既定経路では列ごと出さない** — 既定の応答本文を 1 バイトも変えないため
         * (変えると全閲覧者の弱 ETag が 1 回無効になる)。 */
        ...(gcpOverlay ? { restraint_missing: missing } : {}),
        wage: computeWageRow(
          summary,
          year,
          month,
          wageMaster,
          minWageMaster,
          config,
          prevDaysByDriver.get(entry.data.driverCd) ?? [],
          employeeBranches.get(entry.data.driverCd) ?? null,
        ),
      };
    });
    endRows();
    const missingCount = rows.filter((r) => r.restraint_missing === true).length;
    if (missingCount > 0) {
      warnings.push(
        `GCP の日別サマリ (day_summaries) に ${missingCount} 名ぶんの ${ym} の行がありません`
          + " (該当行は欠測として金額を出していません — 0 分として最低賃金割れの判定はしません)",
      );
    }
    // 内容不変なら 304 で本文を送らない (Refs #543 PR-5)。304 でも計測は出す
    const { res, notModified } = await this.jsonWithEtag(
      {
        month: ym,
        // 既定経路は従来どおりのキーだけ返す (本文を変えない = ETag を無効にしない)
        ...(gcpOverlay ? { restraint_source: restraintSource } : {}),
        rows,
        no_data_drivers: noDataDrivers,
        warnings,
        config,
      },
      ifNoneMatch,
    );
    return this.withPhaseTiming(
      gcpOverlay ? "wage-report-gcp" : "wage-report",
      ym,
      timer,
      tracker.aggregate(),
      res,
      notModified,
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

  /**
   * `/kintai/diff` の結果 (フル) から「表示に要る分だけ」のスナップショットを組んで
   * R2 へ保存する (Refs #620-3)。`/restraint-fetch` の CSV/サマリ archive と同じ
   * 流儀 (`putVersionedR2`: latest + 内容が変わった時だけ `v-{ts}`、customMetadata
   * に sha256/fetchedAt/lastVerifiedAt) — 新しい保存方式は作らない。
   *
   * R2 未 binding の環境では保存をスキップし `null` を返す (突合自体は成功させる、
   * `saveRestraintToR2` と同じ判断)。呼び出し側はこの戻り値の有無で「保存できたか」
   * を判定し、できなくても失敗にはしない。
   */
  private async saveKintaiDiffCacheToR2(
    compId: string,
    ym: string,
    diff: KintaiDiffResult,
    observations: KintaiDiffObservations | null,
    observationsError: string | null,
  ): Promise<{ fetchedAt: string; lastVerifiedAt: string } | null> {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return null;
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const paths = kintaiDiffCacheR2Paths(prefix, compId, ym);
    const snapshot = buildKintaiDiffCacheSnapshot(ym, diff, observations, observationsError);
    const now = restraintVersionTimestamp(new Date());
    const nowIso = new Date().toISOString();
    const result = await this.putVersionedR2(
      bucket,
      paths.latest,
      paths.version(now),
      JSON.stringify(snapshot),
      "application/json",
      nowIso,
    );
    if (result.changed) await this.pruneRestraintVersions(bucket, paths.dir);
    // lastVerifiedAt は「今回確認した時刻」そのもの (putVersionedR2 が unchanged
    // でも customMetadata.lastVerifiedAt を nowIso に更新するのと同じ意味)。
    return { fetchedAt: result.fetchedAt, lastVerifiedAt: nowIso };
  }

  /**
   * `saveKintaiDiffCacheToR2` が保存したスナップショットを読む (Refs #620-3)。
   * 突合は一切実行しない — R2 read だけの軽い口。
   *
   * `cached: false` (一度も保存されていない) と `cached: true, unreadable: true`
   * (保存はあるが JSON が壊れている等で読めなかった) を区別して返す — どちらも
   * 「差はありません」と混同してはいけない (module docs 冒頭 / #620-3 やること★)。
   */
  private async loadKintaiDiffCacheFromR2(
    compId: string,
    ym: string,
  ): Promise<
    | { cached: false }
    | { cached: true; unreadable: true }
    | {
        cached: true;
        unreadable: false;
        snapshot: KintaiDiffCacheSnapshot;
        fetchedAt: string | null;
        lastVerifiedAt: string | null;
      }
  > {
    const bucket = this.env.DTAKO_R2;
    if (!bucket) return { cached: false };
    const prefix = this.env.RESTRAINT_R2_PREFIX || "restraint";
    const paths = kintaiDiffCacheR2Paths(prefix, compId, ym);
    const obj = await bucket.get(paths.latest);
    if (!obj) return { cached: false };
    let parsed: KintaiDiffCacheSnapshot | null;
    try {
      parsed = parseKintaiDiffCacheSnapshot(JSON.parse(await obj.text()));
    } catch {
      parsed = null;
    }
    if (!parsed) return { cached: true, unreadable: true };
    return {
      cached: true,
      unreadable: false,
      snapshot: parsed,
      fetchedAt: obj.customMetadata?.fetchedAt ?? null,
      lastVerifiedAt: obj.customMetadata?.lastVerifiedAt ?? null,
    };
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
      // 上流キャッシュの無効化 (Refs #543 PR-3)。resummarize と同じ理由 —
      // CSV 取込は kintai 上流を変えないが、次の kintai 読みを再検証に倒す
      const csvYm = `${params.year}-${month}`;
      this.invalidateKintaiUpstreamCache([csvYm, prevYmOf(csvYm)], "restraint-csv");
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
   * 再集計する (body は `{opeNo, startOpe}`)。`recalculateExpense` (→
   * `recalculateByScore`) は GET の前に無条件で `unlockOperation` を呼ぶ
   * (Refs #633-23)。`btnInitialize` は他ユーザーの正当な編集ロックも解除しうる
   * ため、応答 (`unlocked`) に加えて構造化ログにも必ず出す。 */
  private async handleReportExpenseRecalculate(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { opeNo?: unknown; startOpe?: unknown };
    try {
      body = (await request.json()) as { opeNo?: unknown; startOpe?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const opeNo = typeof body.opeNo === "string" ? body.opeNo : "";
    const startOpe = typeof body.startOpe === "string" ? body.startOpe : "";
    return this.callReportAction(record, "評価点再集計", async (jar) => {
      const result = await recalculateExpense(jar, opeNo, startOpe);
      console.log(
        JSON.stringify({
          daily_report_expense_recalculate: "ok",
          ope_no: opeNo,
          theearth_unlocked: result.unlocked,
        }),
      );
      return result;
    });
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
   * 作業時間を再集計する (DriverState1〜5Min が更新される。body は `{opeNo, startOpe}`)。
   * `recalculateWork` (→ `recalculateByScore`) は GET の前に無条件で
   * `unlockOperation` を呼ぶ (Refs #633-23、ユーザー指示: 死んだセッションが
   * 残したロックで弾かれるより先に解除して普通に通る方が正しい)。`btnInitialize`
   * は他ユーザーの正当な編集ロックも解除しうるため、応答 (`unlocked`) に加えて
   * 構造化ログにも必ず出す。 */
  private async handleReportWorkRecalculate(record: TheearthSessionRecord, request: Request): Promise<Response> {
    let body: { opeNo?: unknown; startOpe?: unknown };
    try {
      body = (await request.json()) as { opeNo?: unknown; startOpe?: unknown };
    } catch {
      return dvrJsonError(400, "JSON body が必要です");
    }
    const opeNo = typeof body.opeNo === "string" ? body.opeNo : "";
    const startOpe = typeof body.startOpe === "string" ? body.startOpe : "";
    return this.callReportAction(record, "作業時間再集計", async (jar) => {
      const result = await recalculateWork(jar, opeNo, startOpe);
      console.log(
        JSON.stringify({
          daily_report_work_recalculate: "ok",
          ope_no: opeNo,
          theearth_unlocked: result.unlocked,
        }),
      );
      return result;
    });
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

  /** DO storage に溜まった期限切れ zip を掃除する (ダウンロードされずに放置された
   * ケース)。戻り値は `alarm()` の構造化ログと再スケジュール判定 (`remaining` が
   * 0 より大きければ次の掃除を予約する) に使う。 */
  private async sweepExpiredZips(): Promise<{ swept: number; remaining: number }> {
    const all = await this.ctx.storage.list<StoredZip>({ prefix: "zip:" });
    const now = Date.now();
    let swept = 0;
    for (const [key, record] of all) {
      if (now - record.createdAt > ZIP_TTL_MS) {
        await this.ctx.storage.delete(key);
        swept += 1;
      }
    }
    return { swept, remaining: all.size - swept };
  }

  /** `scrape-queue` から pop した 1 件を実行する。account が解決できない
   * (KV から消えた等) 場合はここで failed にして queue を進める。実行そのものは
   * `enqueueScrape` (`scrapeQueue`) を経由させ、同一 DO インスタンス生存中の
   * WS 手動スクレイプ (`runHttpScrapeJob`) との排他を維持する (Refs #205-55 H2 —
   * WS 手動は DO が死ねば接続も切れるので再開可能性は不要だが、生存中の排他は
   * これまで通り必要)。 */
  private async runQueuedScrapeJob(item: QueuedScrapeItem): Promise<void> {
    const account = await this.resolveAccount(item.compId);
    if (!account) {
      await recordScrapeJob(this.ctx.storage, item.jobKey, {
        state: "failed",
        error: `comp_id=${item.compId} が DTAKO_ACCOUNTS に見つかりません (alarm drain 時点)`,
      });
      return;
    }
    await this.enqueueScrape(() =>
      this.runCronDtakoScrape(account, { startDate: item.startDate, endDate: item.endDate }, item.jobKey),
    );
  }

  /** 2 つの用途 (① ZIP TTL 掃除、② `/cron/dtako` キューの drain) が同居する
   * (Refs #205-55)。Cloudflare の DO alarm は 1 スロットしか持てず「何のために
   * 起きたか」をプラットフォームから受け取れない — 既存の ZIP 掃除も元々
   * 「理由を問わず毎回やる」設計だった。それを踏襲し、**毎回両方やる**。
   * 構造化ログ 1 行で「今回何をしたか」を判別できるようにする (条件5)。 */
  async alarm(): Promise<void> {
    const zip = await this.sweepExpiredZips();

    // 孤児回収 (条件4)。次に pop する job を実行する**前**に必ず先着させる —
    // 前回の alarm() 呼び出しが `scrape-running` をクリアする前に死んだ孤児が
    // あれば、ここで安全側に倒す (壊す前なら再投入、壊した後/不明なら failed)。
    const orphan = await recoverOrphan(this.ctx.storage);

    let queueDrained: string | null = null;
    const next = await popNextScrapeQueueItem(this.ctx.storage);
    if (next) {
      await setRunningPointer(this.ctx.storage, next);
      try {
        await this.runQueuedScrapeJob(next);
      } finally {
        await clearRunningPointer(this.ctx.storage);
      }
      queueDrained = next.jobKey;
    }

    const queueRemaining = ((await this.ctx.storage.get<QueuedScrapeItem[]>(SCRAPE_QUEUE_KEY)) ?? []).length;
    console.log(
      JSON.stringify({
        scrape_alarm: true,
        zip_swept: zip.swept,
        zip_remaining: zip.remaining,
        orphan_recovered: orphan.recovered,
        orphan_failed: orphan.failed,
        queue_drained: queueDrained,
        queue_remaining: queueRemaining,
      }),
    );

    // 再スケジュール: キューが残っていれば即再発火 (drain 優先)。空なら期限切れ
    // 待ちの zip が残っている時だけ ZIP_TTL_MS 後に予約する。両方無ければ alarm
    // を張らない (元の idle 挙動のまま)。
    if (queueRemaining > 0) {
      await this.ctx.storage.setAlarm(Date.now());
    } else if (zip.remaining > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ZIP_TTL_MS);
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

  /**
   * WS ハンドシェイクは 101 で成立させ、`{event:"error"}` で理由を 1 件送ってから
   * 閉じる。502 等の HTTP エラーで返すと browser 側 (`app/utils/api.ts` の
   * `triggerScrapeStream`) は「メッセージ 0 件で切断」しか観測できず、
   * `handshake failed (comp_id 不正 / 認証エラー等)` という**実際の原因と無関係な
   * 推測文言**を表示してしまう (2026-07-30 の調査で 2 社分のエラーがこれだった)。
   */
  private rejectWithReason(message: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.sendSafely(server, { event: "error", message });
    this.closeSafely(server, 1011, "upstream unavailable");
    return new Response(null, { status: 101, webSocket: client });
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
