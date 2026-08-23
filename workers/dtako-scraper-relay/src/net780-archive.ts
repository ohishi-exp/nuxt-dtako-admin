/**
 * `POST /cron/dtako/net780-archive` (Refs #760 の 26) の pure ロジック。
 *
 * ## 何をするか
 *
 * 粗利タブの地図 (#783) は運行に NET780 のアーカイブ (R2 + D1 `dtako_uploads`)
 * があれば道なりの軌跡を重ねるが、アーカイブは `/net780` 画面で人がブラウザの
 * theearth セッションで 1 件ずつ「保存」するしかなかった。この口は **無人
 * (`DTAKO_ACCOUNTS` の自前ログイン) で、運行NO の一覧ぶんを 検索 → ダウンロード
 * → 保存** する。書き込みは R2 + D1 のアーカイブだけで、theearth 側は読むだけ。
 *
 * ## 検索窓 (★ 読取日 ≠ 運行日)
 *
 * `searchNet780` の日付絞込は **読取日 (F-GOS0030 `ReadNo` = 退社日時)** 固定で、
 * 運行開始日ではない (theearth-net780-client.ts `buildConfigOverrides`)。読取日は
 * 運行開始日と同日か**それより後** (日跨ぎ運行は翌日、長距離は 1 週間以上後の
 * 実例あり — theearth-venus skill「読取日と運行日は1日ズレることがある (0件ヒット
 * の定番原因)」、kintai-ops skill「読取日 != 運行開始日 52.8%」)。そのため
 * `start_ope` 当日だけで検索すると約半分が `not_found` になる。
 *
 * ここでは **読取日 range + 車輌CD** (運行NO の 13〜22 桁目、先頭 0 落とし) で
 * 検索し、`operationNo` が一致する行を拾う (一致判定は `operationNo` だけ、日付では
 * 弾かない)。窓は **まず [開始日, 開始日 + `NET780_ARCHIVE_NARROW_WINDOW_DAYS`]
 * (多数派の当日〜翌々日読取をここで拾う)、見つからなければ
 * [開始日, 開始日 + `NET780_ARCHIVE_WINDOW_DAYS`]** の順 (`net780ArchiveSearchPlan`、
 * 親指示 2026-08-23 — 狭い窓を先にすることで theearth の往復と 1 ページ上限
 * `NET780_SEARCH_MAX_ROWS` 件に当たる確率を減らす)。両方で不一致なら `not_found`
 * — 最後の一覧が上限に達していたら message に取りこぼしの可能性を明記する。
 *
 * ## 契約 (front #760-27 と共有)
 *
 * body `{ comp_id, items: [{ ope_no (22桁), start_ope ("YYYY/MM/DD H:mm:ss") }] }`
 * (上限 `CRON_BATCH_MAX_ITEMS`、超過は 400)。応答の `results[i].status` は
 * `archived` / `already` (D1 カタログに単一運行の行が既にある、theearth へは
 * 行かない) / `not_found` (一覧に無い) / `error`。session 切れは
 * `runBatchSequential` の流儀で `truncated: true` + `remaining`。
 */
import type { Net780Row, Net780SearchParams, Net780DownloadTarget } from "./theearth-net780-client";
import { OPE_NO_RE, START_OPE_RE } from "./theearth-report-client";
import { TheearthClientError } from "./theearth-client";
import { VenusSessionExpiredError } from "./theearth-venus-client";
import type { BatchRunResult } from "./cron-batch";

/** 最初に引く狭い読取日窓 (開始日からの日数)。日跨ぎ運行 (翌日読取) が大半なので
 * 開始日+2 日までで多数派を拾える。 */
export const NET780_ARCHIVE_NARROW_WINDOW_DAYS = 2;
/** 狭い窓で見つからなかった時の広い窓。長距離運行の退社が開始の 8 日後だった
 * 実例 (theearth-venus skill、出庫 06/28 退社 07/06) を余裕を持って覆う値。 */
export const NET780_ARCHIVE_WINDOW_DAYS = 14;

export interface Net780ArchiveItem {
  opeNo: string;
  startOpe: string;
}

export interface Net780ArchiveRequest {
  compId: string;
  items: Net780ArchiveItem[];
}

/** `POST /cron/dtako/net780-archive` の body を解釈する。`items` 配列形式のみ
 * (単体形式は受けない — この口は最初からバッチ専用)。上限件数の判定は
 * 呼び出し元が `assertBatchSizeWithinLimit` で行う (他の `/cron/dtako/*` と同じ)。 */
export function parseNet780ArchiveRequest(body: {
  comp_id?: unknown;
  items?: unknown;
}): Net780ArchiveRequest | { error: string } {
  const compId = typeof body.comp_id === "string" ? body.comp_id : "";
  if (!compId || !Array.isArray(body.items)) return { error: "comp_id / items が必要です" };
  if (body.items.length === 0) return { error: "items は 1 件以上必要です" };
  const items: Net780ArchiveItem[] = [];
  for (let i = 0; i < body.items.length; i++) {
    const record = (body.items[i] ?? {}) as Record<string, unknown>;
    const opeNo = typeof record.ope_no === "string" ? record.ope_no : "";
    const startOpe = typeof record.start_ope === "string" ? record.start_ope : "";
    if (!OPE_NO_RE.test(opeNo)) {
      return { error: `items[${i}]: ope_no は22桁の数値で指定してください (受領値: ${opeNo})` };
    }
    if (!START_OPE_RE.test(startOpe)) {
      return { error: `items[${i}]: start_ope は "YYYY/MM/DD H:mm:ss" 形式で指定してください (受領値: ${startOpe})` };
    }
    items.push({ opeNo, startOpe });
  }
  return { compId, items };
}

export interface Net780ArchiveSearchKey {
  /** theearth の車輌CD (F-GOS0030 `txtSVehicle`、8桁以内の数値)。運行NO の
   * 13〜22 桁目 (10 桁ゼロ埋め) の先頭 0 を落としたもの。 */
  vehicleCd: string;
  /** 運行開始日 ("YYYY-MM-DD")。`start_ope` の日付部。 */
  startDate: string;
}

const VEHICLE_CD_RE = /^\d{1,8}$/;

/** 運行NO (22桁 = 開始日時12桁 + 車輌CD10桁) と `start_ope` から検索キーを導く。
 * 車輌CD が 0 だけ (= 車輌CD 無し) や 8 桁を超える場合は `null` (検索できない)。
 * 日付は `start_ope` を正とする (呼び出し元が運行NO から機械導出している値なので
 * 通常一致するが、契約上のフィールドはこちら)。 */
export function deriveNet780ArchiveSearchKey(item: Net780ArchiveItem): Net780ArchiveSearchKey | null {
  const vehicleCd = item.opeNo.slice(12, 22).replace(/^0+/, "");
  if (!VEHICLE_CD_RE.test(vehicleCd)) return null;
  const [y, m, d] = item.startOpe.slice(0, 10).split("/");
  return { vehicleCd, startDate: `${y}-${m}-${d}` };
}

/** "YYYY-MM-DD" に日数を足す (UTC で計算、暦日の加算だけなので TZ は効かない)。 */
export function addDaysIso(date: string, days: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** 検索キー + 窓の日数 → `searchNet780` に渡す `Net780SearchParams`。 */
export function buildNet780ArchiveSearchParams(key: Net780ArchiveSearchKey, windowDays: number): Net780SearchParams {
  return {
    operationDateFrom: key.startDate,
    operationDateTo: addDaysIso(key.startDate, windowDays),
    vehicleCdFrom: key.vehicleCd,
    vehicleCdTo: key.vehicleCd,
  };
}

/** 検索する窓の並び (狭い窓 → 広い窓)。呼び出し元は先頭から順に検索し、一致行が
 * 出た時点で止める。全部外れたら `not_found`。 */
export function net780ArchiveSearchPlan(key: Net780ArchiveSearchKey): Net780SearchParams[] {
  return [
    buildNet780ArchiveSearchParams(key, NET780_ARCHIVE_NARROW_WINDOW_DAYS),
    buildNet780ArchiveSearchParams(key, NET780_ARCHIVE_WINDOW_DAYS),
  ];
}

/** 一覧が 1 ページの上限に達していれば、見えていない行に目当ての運行が居る
 * 可能性がある (ページング未実装)。`not_found` の理由文に使う。 */
export function isNet780SearchCapped(rowCount: number, maxRows: number): boolean {
  return rowCount >= maxRows;
}

/** `not_found` の理由文。一覧が上限に達していたら「取りこぼしの可能性」を明記する
 * (黙って not_found にすると「NET780 が無い」と誤読される)。 */
export function describeNet780NotFound(key: Net780ArchiveSearchKey, params: Net780SearchParams, rowCount: number, maxRows: number): string {
  const range = `読取日 ${params.operationDateFrom}〜${params.operationDateTo} / 車輌CD ${key.vehicleCd}`;
  if (isNet780SearchCapped(rowCount, maxRows)) {
    return `${range} の一覧が上限 ${maxRows} 件に達しており、取りこぼしの可能性があります (NET780 が無いとは限りません)`;
  }
  return `${range} の一覧 (${rowCount} 件) に該当する運行がありません`;
}

/** NET780 ダウンロード postback は HTTP 503 の再現性が高い (theearth-net780-client.ts
 * ヘッダコメント、実機確定) ため、`TheearthClientError` なら間隔を空けて
 * `maxAttempts` 回まで試す。**session 切れ (`VenusSessionExpiredError`) と
 * theearth 由来でない例外は即座に投げる** (リトライしても同じ結果)。 */
export const NET780_DOWNLOAD_MAX_ATTEMPTS = 3;

export async function retryNet780Download<T>(
  attempt: () => Promise<T>,
  opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? NET780_DOWNLOAD_MAX_ATTEMPTS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let n = 1; ; n++) {
    try {
      return await attempt();
    } catch (err) {
      if (n >= maxAttempts || err instanceof VenusSessionExpiredError || !(err instanceof TheearthClientError)) {
        throw err;
      }
      await sleep(1000 * n);
    }
  }
}

/** 検索結果から `operationNo` が一致する行を選ぶ (無ければ null)。 */
export function pickNet780RowForOperation(rows: readonly Net780Row[], opeNo: string): Net780Row | null {
  return rows.find((r) => r.operationNo === opeNo) ?? null;
}

/** 検索結果の行 → ダウンロード/カタログ登録に渡す target。`startDateTime` は
 * **一覧の行の値** (F-VOS3020 の行選択 `txtStartDateTime` にそのまま使う値) を
 * 使う — 呼び出し元の `start_ope` ではない。 */
export function net780DownloadTargetFromRow(row: Net780Row): Net780DownloadTarget {
  return {
    operationNo: row.operationNo,
    startDateTime: row.startDateTime,
    vehicleName: row.vehicleName,
    driverCd1: row.driverCd1,
    driverName1: row.driverName1,
    operationDate: row.operationDate,
  };
}

/** D1 カタログ (`dtako_uploads`) の行が「単一運行としてアーカイブ済み」か。
 * `/api/net780/by-operation` (Nitro) と DO の `handleNet780R2View` は
 * `operation_count !== 1` の行を 404 にする (複数運行 zip から個別運行を安全に
 * 取り出せない) ので、そうした行は `already` 扱いにせず取り直す。 */
export function isNet780CatalogRowUsable(row: { operation_count: number | null } | null | undefined): boolean {
  return !!row && row.operation_count === 1;
}

export type Net780ArchiveStatus = "archived" | "already" | "not_found" | "error";

export interface Net780ArchiveResult {
  ope_no: string;
  status: Net780ArchiveStatus;
  bytes?: number;
  message?: string;
}

export interface Net780ArchiveSummary {
  results: Net780ArchiveResult[];
  /** `archived` + `already`。 */
  success_count: number;
  /** `not_found` + `error`。 */
  failure_count: number;
  truncated: boolean;
  remaining: number;
}

/** `runBatchSequential` の結果を契約の `results[]` + 集計に畳む。`runOne` が
 * 例外で落ちた項目 (`ok: false`) は `status: "error"` + `message` にする。
 * `results.length + remaining === items.length` は `runBatchSequential` の不変条件を
 * そのまま引き継ぐ。 */
export function summarizeNet780ArchiveBatch(
  items: readonly Net780ArchiveItem[],
  batch: BatchRunResult<Net780ArchiveResult>,
): Net780ArchiveSummary {
  const results: Net780ArchiveResult[] = batch.results.map((outcome, i) =>
    outcome.ok ? outcome.result! : { ope_no: items[i].opeNo, status: "error", message: outcome.error },
  );
  const successCount = results.filter((r) => r.status === "archived" || r.status === "already").length;
  return {
    results,
    success_count: successCount,
    failure_count: results.length - successCount,
    truncated: batch.truncated,
    remaining: batch.remaining,
  };
}
