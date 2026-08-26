/**
 * 給与比較 (拘束時間×賃金計算) tool 本体。すべて read-only、R2 直読み。
 *
 * ロジックは `workers/dtako-scraper-relay/src/dtako-scraper-relay-do.ts` の
 * `handleWageReport` / `loadMonthSummaries` / `handleArchiveMonths` を、DO
 * instance (`this.env`) 依存を外して移植したもの (新規実装しない)。
 */
import { z } from "zod";
import {
  computeWageRow,
  minWageForBranch,
  normalizeMinWageMaster,
  normalizeWageConfig,
  normalizeWageMaster,
  type MinWageMaster,
  type WageConfig,
  type WageMaster,
} from "../../../dtako-scraper-relay/src/restraint-wage";
import type {
  RestraintDriverSummary,
  RestraintSummaryDay,
} from "../../../dtako-scraper-relay/src/theearth-restraint-client";
import { resolveSecretBinding } from "../../../dtako-scraper-relay/src/cron";
import {
  gcpPartsFor,
  overlayGcpDayTimes,
  parseGcpDaySummaries,
  type GcpDayPart,
} from "../../../dtako-scraper-relay/src/gcp-day-summaries";
import { OPE_NO_RE, START_OPE_RE } from "../../../dtako-scraper-relay/src/theearth-report-client";
import { CRON_BATCH_MAX_ITEMS } from "../../../dtako-scraper-relay/src/cron-batch";
import {
  crossMonthMinutesByDate,
  kosokuPartsByDate,
  parseKosokuDaily,
  parseFerryMinusByDriver,
  parseGapMidnightByDriver,
  parseMinusUnkoByDriver,
  parseOursOutsideByDriver,
  parsePaperDriftByDriver,
  parsePaperOutsideByDriver,
  prevYmOf,
  type KosokuShift,
} from "../../../dtako-scraper-relay/src/kosoku-daily";
import {
  compareTimecardMonth,
  compareTimecardMonthAll,
  parsePdfJson,
  pdfJsonError,
  summarizeCompareResults,
  type CompareResult,
  type CompareSummaryRow,
} from "../../../dtako-scraper-relay/src/timecard-compare";
import {
  DEFAULT_DEST_AREA,
  DEFAULT_LEGS_PER_DRIVER_MONTH,
  DEFAULT_RUNS_PER_DRIVER_MONTH,
  DEST_AREAS,
  breakEvenLegsPerDay,
  estimateCalibrationRatio,
  haulSpeedKmh,
  hourlyWageYen,
  rebuildDeadheadSpeedKmh,
  rebuiltDeadheadKm,
  rebuiltDepotDiffKm,
  rebuiltRuns,
  requiredDrivers,
  restraintHours,
  runsForLegsPerDay,
  sensitivityGrid,
  summarizeDotoRebuild,
} from "../kushiro-doto-rebuild";
import type {
  DepotPoints,
  RebuildOperationInput,
  RebuildTotals,
  SensitivityInput,
  SensitivityRow,
} from "../kushiro-doto-rebuild";
import { DEPOT_KEYS, deadheadFuelYen } from "../kushiro-loading-legs";
import { DEPOTS, isValidLatLng } from "../depot-distance";
import type { DepotKey } from "../depot-distance";
import type { Env } from "../env";
import {
  companiesListPrefix,
  monthsListPrefix,
  summaryListPrefix,
  wageMasterR2Paths,
} from "../r2/keys";
import { getJson, listAllR2, listDelimitedPrefixes } from "../r2/read";
import type { ToolEntry } from "./registry";

function r2Prefix(env: Env): string {
  return env.RESTRAINT_R2_PREFIX || "restraint";
}

const noArgs = z.object({}).strict();

// ===== list_companies ========================================================

/** デジタコ (theearth) の会社コード。給与 (給与大臣) 側の4桁会社コードとは別体系
 *  (1対多) で、桁数も固定ではない (実例: 本番テナントで8桁 "27324455")。
 *  R2 の compId ディレクトリ名を "会社コード" として素通しするだけなので、
 *  数字であること以外は決め打ちしない。 */
const COMP_ID_PATTERN = /^\d{1,20}$/;

export const listCompaniesTool = {
  name: "list_companies",
  description:
    "給与比較アーカイブに存在する会社コード (デジタコ側の数値ID。桁数は会社により異なる) の一覧を返す。" +
    "list_months / get_wage_report / get_restraint_summary の company 引数に使う。",
  inputSchema: noArgs,
  execute: async (env: Env) => {
    const prefixes = await listDelimitedPrefixes(env.DTAKO_R2, companiesListPrefix(r2Prefix(env)));
    const base = companiesListPrefix(r2Prefix(env));
    const companies = prefixes
      .map((p) => p.slice(base.length).replace(/\/$/, ""))
      .filter((c) => COMP_ID_PATTERN.test(c))
      .sort();
    return { companies };
  },
} satisfies ToolEntry<typeof noArgs>;

// ===== list_months ===========================================================

const listMonthsArgs = z
  .object({ company: z.string().regex(COMP_ID_PATTERN).describe("会社コード (デジタコ側の数値ID、list_companies から取得)") })
  .strict();

export const listMonthsTool = {
  name: "list_months",
  description: "指定した会社について、給与比較アーカイブが存在する年月 (YYYY-MM) の一覧を降順で返す。",
  inputSchema: listMonthsArgs,
  execute: async (env: Env, args) => {
    const base = monthsListPrefix(r2Prefix(env), args.company);
    const prefixes = await listDelimitedPrefixes(env.DTAKO_R2, base);
    const months = prefixes
      .map((p) => p.slice(base.length).match(/^(\d{4}-\d{2})\/$/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]!)
      .sort((a, b) => b.localeCompare(a));
    return { company: args.company, months };
  },
} satisfies ToolEntry<typeof listMonthsArgs>;

// ===== shared: month summary loader (loadMonthSummaries 移植) ================

interface LoadedSummary {
  data: RestraintDriverSummary;
  fetched_at: string | null;
  last_verified_at: string | null;
}

async function loadMonthSummaries(
  env: Env,
  compId: string,
  ym: string,
): Promise<{ summaries: LoadedSummary[]; noDataDrivers: string[] }> {
  const objects = await listAllR2(env.DTAKO_R2, summaryListPrefix(r2Prefix(env), compId, ym));
  const latests = objects.filter((o) => o.key.endsWith("/latest.json"));
  const summaries: LoadedSummary[] = [];
  const noDataDrivers: string[] = [];
  const loaded = await Promise.all(
    latests.map(async (meta) => {
      const parsed = await getJson<unknown>(env.DTAKO_R2, meta.key);
      if (parsed === null) return null;
      return { meta, parsed };
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
    const summary = parsed as RestraintDriverSummary & { days?: unknown };
    summaries.push({
      data: { ...summary, days: Array.isArray(summary.days) ? (summary.days as RestraintSummaryDay[]) : [] },
      fetched_at: meta.customMetadata?.fetchedAt ?? null,
      last_verified_at: meta.customMetadata?.lastVerifiedAt ?? null,
    });
  }
  summaries.sort((a, b) => a.data.driverCd.localeCompare(b.data.driverCd, undefined, { numeric: true }));
  return { summaries, noDataDrivers };
}

function parseYm(ym: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

const monthArgsShape = {
  company: z.string().regex(COMP_ID_PATTERN).describe("会社コード (デジタコ側の数値ID、list_companies から取得)"),
  month: z.string().regex(/^\d{4}-\d{2}$/).describe("対象年月 (YYYY-MM、list_months から取得)"),
};

// ===== get_wage_report ========================================================

/** 拘束時間の出どころ (画面の `RestraintSourceKey` と同じ値域、Refs #675)。 */
const RESTRAINT_SOURCES = ["current", "gcp"] as const;

/** 省略時の既定。**画面 (最低賃金チェック) の既定と揃える** — 揃っていないと
 * 同じ会社・月・乗務員で MCP と画面が違う数字を返し、MCP を根拠に判断できない。 */
const DEFAULT_RESTRAINT_SOURCE = "gcp" as const;

const getWageReportArgs = z
  .object({
    ...monthArgsShape,
    source: z
      .enum(RESTRAINT_SOURCES)
      .optional()
      .describe(
        "拘束時間の出どころ。省略時は gcp (最低賃金チェック画面の既定と同じ)。" +
          "gcp = GCP kintai.day_summaries の拘束時間だけを差し替えて再計算 " +
          "(休暇・休日区分・運転/荷役は current のまま) / " +
          "current = theearth 拘束時間管理表 (運行ベース) + オンプレ kosoku-daily (打刻ベース) " +
          "の合流で GCP は 1 行も混ざらない",
      ),
  })
  .strict();

/**
 * GCP `kintai.day_summaries` を月ぶん読む (`get_kintai_day_summaries` と同じ口)。
 * relay 側 `loadGcpDayTimes` (`dtako-scraper-relay-do.ts`) の MCP 版。
 *
 * 月を直列で取らない — この口は 1 か月で数十秒かかることがあり、当月+前月を
 * 直列にすると倍積む (relay 側が 2026-08-04 の本番実測で踏んだ)。
 */
async function loadGcpDayParts(
  env: Env,
  months: readonly string[],
): Promise<Map<string, Map<string, Map<string, GcpDayPart>>>> {
  const relay = env.SCRAPER_RELAY;
  if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です (source=gcp には relay が要ります)");
  const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
  if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");

  const fetched = await Promise.all(
    months.map(async (month) => {
      const q = new URLSearchParams({ month });
      const res = await relay.fetch(`https://relay.internal/kintai-relay/day-summaries?${q}`, {
        headers: { "X-Alc-Proxy-Secret": secret },
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`GCP day-summaries (${month}): status ${res.status}: ${body.slice(0, 200)}`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new Error(`GCP day-summaries (${month}): parse failed: ${body.slice(0, 200)}`);
      }
      return { month, map: parseGcpDaySummaries(raw) };
    }),
  );
  return new Map(fetched.map((f) => [f.month, f.map]));
}

export const getWageReportTool = {
  name: "get_wage_report",
  description:
    "指定した会社・年月の賃金計算結果を、拘束時間サマリと突き合わせた行の配列で返す " +
    "(拘束時間×賃金マスタから computeWageRow で再計算。給与明細実績との突合は含まない — " +
    "サーバー側に給与明細アーカイブが存在しないため)。" +
    "拘束時間の出どころは `source` で選べ、**省略時は画面と同じ gcp**。" +
    "source=gcp では日別行 (summary.days) を落とす (計算は days を使い切った後なので数字は変わらない)。",
  inputSchema: getWageReportArgs,
  execute: async (env: Env, args) => {
    const source = args.source ?? DEFAULT_RESTRAINT_SOURCE;
    const parsed = parseYm(args.month);
    if (!parsed) throw new Error("month は YYYY-MM で指定してください");
    const { year, month } = parsed;

    const loadMaster = async <T>(
      name: "wage-master" | "min-wage" | "wage-config",
      normalize: (raw: unknown) => T,
      fallback: T,
    ): Promise<T> => {
      const raw = await getJson<unknown>(env.DTAKO_R2, wageMasterR2Paths(r2Prefix(env), args.company, name).latest);
      if (raw === null) return fallback;
      try {
        return normalize(raw);
      } catch {
        return fallback;
      }
    };

    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYm = `${prevYear}-${String(prevMonth).padStart(2, "0")}`;

    const [wageMaster, minWageMaster, config, current, prev, gcpByMonth] = await Promise.all([
      loadMaster<WageMaster>("wage-master", normalizeWageMaster, { drivers: {} }),
      loadMaster<MinWageMaster>("min-wage", normalizeMinWageMaster, { prefectures: {}, branchToPrefecture: {} }),
      loadMaster<WageConfig>("wage-config", normalizeWageConfig, normalizeWageConfig(null)),
      loadMonthSummaries(env, args.company, args.month),
      loadMonthSummaries(env, args.company, prevYm),
      // 素材読みとは独立 (月しか要らない) なので待たずに並列で走らせる
      source === "gcp" ? loadGcpDayParts(env, [args.month, prevYm]) : Promise.resolve(null),
    ]);

    // 拘束時間を GCP 由来に差し替える。**当月と前月の両方**を差し替えること —
    // 片方だけだと月初の跨ぎ週 (週40h) で 2 つのソースの実働が混ざる
    // (relay 側 handleWageReport と同じ手順、Refs #675)。
    const overlay = (entry: RestraintDriverSummary, forYm: string) =>
      gcpByMonth
        ? overlayGcpDayTimes(entry, gcpPartsFor(gcpByMonth.get(forYm)!, entry.driverCd), forYm)
        : { summary: entry, missing: false };

    const prevDaysByDriver = new Map<string, RestraintSummaryDay[]>(
      prev.summaries.map((s) => [s.data.driverCd, overlay(s.data, prevYm).summary.days]),
    );

    const warnings: string[] = [];
    if (current.summaries.length > 0 && prev.summaries.length === 0) {
      warnings.push(
        `前月 (${prevYm}) の summary がアーカイブに無いため、月初の跨ぎ週の週40h計算は当月分のみで近似しています`,
      );
    }

    const rows = current.summaries.map((s) => {
      const { summary, missing } = overlay(s.data, args.month);
      return {
        // source=gcp では日別行を本文に載せない (relay 側と同じ、Refs #675)。
        // 112 名ぶんの日別が応答の大半 (実測 1.1MB 超) を占めるのに、賃金計算は
        // days を使い切った後なので落としても数字は 1 円も変わらない。
        summary: gcpByMonth ? { ...summary, days: [] } : summary,
        fetched_at: s.fetched_at,
        last_verified_at: s.last_verified_at,
        // GCP 側にこの乗務員 × この月の行が無かった (= 欠測)。**0 分ではない**ので
        // 呼び出し側は金額・最低賃金割れの判定を出さないこと。
        ...(gcpByMonth ? { restraint_missing: missing } : {}),
        wage: computeWageRow(
          summary,
          year,
          month,
          wageMaster,
          minWageMaster,
          config,
          prevDaysByDriver.get(s.data.driverCd) ?? [],
        ),
      };
    });

    // どちらのソースで計算したかを必ず載せる — 応答だけ見て画面と突き合わせられるように
    return {
      month: args.month,
      restraint_source: source,
      rows,
      no_data_drivers: current.noDataDrivers,
      warnings,
    };
  },
} satisfies ToolEntry<typeof getWageReportArgs>;

// ===== get_restraint_summary ==================================================

const getRestraintSummaryArgs = z
  .object({
    ...monthArgsShape,
    driver: z.string().optional().describe("乗務員CD で絞り込む (省略時は全員)"),
  })
  .strict();

export const getRestraintSummaryTool = {
  name: "get_restraint_summary",
  description: "指定した会社・年月の拘束時間サマリ (乗務員別) をそのまま返す。driver 指定で1名に絞り込める。",
  inputSchema: getRestraintSummaryArgs,
  execute: async (env: Env, args) => {
    const { summaries, noDataDrivers } = await loadMonthSummaries(env, args.company, args.month);
    const rows = args.driver
      ? summaries.filter((s) => s.data.driverCd === args.driver)
      : summaries;
    return { month: args.month, rows, no_data_drivers: noDataDrivers };
  },
} satisfies ToolEntry<typeof getRestraintSummaryArgs>;

// ===== get_kosoku_events ======================================================

const getKosokuEventsArgs = z
  .object({
    driver: z
      .string()
      .regex(/^\d{1,10}$/)
      .describe("乗務員CD (数字。上流が必須にしているため省略不可)"),
    month: z.string().regex(/^\d{4}-\d{2}$/).describe("対象年月 (YYYY-MM)"),
  })
  .strict();

/** 上流 (rust-ichibanboshi) の応答本文をエラーメッセージに載せる長さ。
 *  原因が読める程度に切る (CF Access のログイン HTML 等が丸ごと来ることがある)。 */
const UPSTREAM_EXCERPT = 300;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * rust-ichibanboshi (社内 LAN の橋) を叩いて JSON を返す。
 *
 * **握り潰さない** — 未設定・接続不能・非 2xx・非 JSON をそれぞれ原因の分かる
 * メッセージにして throw する。Secrets Store binding は「宣言はあるが解決できない」
 * 時に `get()` が throw する (ローカル dev や entry の消失・改名) ので、未設定と
 * 同じ扱いに倒す — relay の `handleKintaiFetch` と同じ判断。
 */
async function fetchIchibanJson(env: Env, pathWithQuery: string, tag: string): Promise<unknown> {
  const apiUrl = (env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
  const clientId = env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
  let clientSecret = "";
  try {
    clientSecret = await resolveSecretBinding(env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
  } catch (err) {
    console.error(JSON.stringify({ [tag]: "secret-error", error: describeError(err) }));
  }
  if (!apiUrl || !clientId || !clientSecret) {
    throw new Error(
      "勤怠の取得先 (NUXT_ICHIBAN_API_URL / NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID / " +
        "ICHIBAN_CF_ACCESS_CLIENT_SECRET) が未設定です",
    );
  }
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${pathWithQuery}`, {
      headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret },
    });
  } catch (err) {
    // 握り潰さず原因を返す (社内 LAN が落ちている / Tunnel 断)
    throw new Error(`rust-ichibanboshi へ接続できません: ${describeError(err)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `rust-ichibanboshi が ${res.status} を返しました: ${text.slice(0, UPSTREAM_EXCERPT)}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    // CF Access の認証画面 HTML が返るケース (Service Token 失効時に踏む)
    throw new Error(
      `rust-ichibanboshi の応答が JSON ではありません: ${text.slice(0, UPSTREAM_EXCERPT)}`,
    );
  }
}

export const getKosokuEventsTool = {
  name: "get_kosoku_events",
  description:
    "指定した乗務員・年月の、打刻 (タイムカード) と運行イベントの**生の時系列**を時刻順に返す " +
    "(拘束時間の打刻基準化 Phase 1、Refs #470)。集計しないので、同日2運行・打刻と運行のズレ・" +
    "細切れ休憩・休息の長さといったパターンを実データで数えるのに使う。" +
    "source は timecard (打刻) / dtako (運行の確定イベント) / dtako_events (デジタコ生イベント) の3種。" +
    "end_datetime は区間を持つ dtako_events 由来の行だけ非 null。" +
    "**注意: dtako_events の区間は入れ子** (運転の中に一般道/高速道などの道路種別が入る) なので、" +
    "区間長を素朴に合計すると二重計上になる。",
  inputSchema: getKosokuEventsArgs,
  execute: async (env: Env, args) => {
    if (!parseYm(args.month)) throw new Error("month は YYYY-MM で指定してください");
    const parsed = await fetchIchibanJson(
      env,
      `/api/kintai/events?month=${encodeURIComponent(args.month)}` +
        `&driver=${encodeURIComponent(args.driver)}`,
      "kosoku_events",
    );
    const rows = (parsed as { rows?: unknown }).rows;
    return { month: args.month, driver: args.driver, rows: Array.isArray(rows) ? rows : [] };
  },
} satisfies ToolEntry<typeof getKosokuEventsArgs>;

// ===== get_rest_diff =========================================================

const getRestDiffArgs = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/).describe("対象年月 (YYYY-MM)"),
    driver: z
      .string()
      .regex(/^\d{1,10}$/)
      .optional()
      .describe("乗務員CD (数字)。**省略すると全乗務員** — 1 回で対象が全部出る"),
  })
  .strict();

export const getRestDiffTool = {
  name: "get_rest_diff",
  description:
    "同じ運行について `time_card_dtako` 由来の休息と `dtako_events` 由来の休息を突き合わせ、" +
    "**ずれている運行を名指しで返す** (Refs ohishi-exp/rust-ichibanboshi#205 の 41)。" +
    "オンプレ (CakePHP) の `_setbyUnkoNo` は INSERT しかしないため、デジタコ側が休息を切り直しても " +
    "`time_card_dtako` は追従せず**古い行が残る**。残ると勤務の切れ目が増えて拘束・休憩が狂う。" +
    "ここに出た運行は旅費編集画面の「勤務時間再登録」(yhonda-ohishi/nginx#792) を押せば直る。" +
    "**driver は省略可** — 省略すると月ぶんの対象が全部出る。" +
    "items[] は {unko_no, driver_cds, run_date, dtako_rest_rows, dtako_events_rest_intervals, " +
    "dtako_only, dtako_events_only}。`dtako_only` が古い行の疑い、`dtako_events_only` が未反映の疑い。" +
    "items は max_items (500) で切られるが、`total` と乗務員別内訳 `by_driver` は**切る前の総数**。" +
    "**判定には一切入らない観測用**で、拘束の値そのものは変えない。",
  inputSchema: getRestDiffArgs,
  execute: async (env: Env, args) => {
    if (!parseYm(args.month)) throw new Error("month は YYYY-MM で指定してください");
    const driver = args.driver ? `&driver=${encodeURIComponent(args.driver)}` : "";
    return await fetchIchibanJson(
      env,
      `/api/kintai/rest-diff?month=${encodeURIComponent(args.month)}${driver}`,
      "rest_diff",
    );
  },
} satisfies ToolEntry<typeof getRestDiffArgs>;

// ===== get_timecard_diff =====================================================

const getTimecardDiffArgs = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/).describe("対象年月 (YYYY-MM)"),
    driver: z
      .string()
      .regex(/^\d{1,10}$/)
      .optional()
      .describe("乗務員CD (数字)。省略すると全乗務員を突合する"),
    tolerance_minutes: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("拘束の許容誤差 (分)。既定 1 — 秒→分の丸め方の違いで 1 分ずれるため"),
    only_anomalies: z
      .boolean()
      .optional()
      .describe(
        "差分も異常も無い乗務員を落とし、各乗務員の days も該当日だけに絞る (既定 true)。" +
          "false にすると全乗務員×全暦日を返すので応答が大きくなる",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "mode=summary で返す乗務員の数 (既定 20)。**未説明 (unknown) の多い順**に絞る。" +
          "落とした行も totals には入るので、全体の数字は変わらない",
      ),
    mode: z
      .enum(["days", "summary"])
      .optional()
      .describe(
        "days (既定) = 日別を返す。summary = 日別を落として乗務員ごとに 1 行 " +
          "(status 別日数 / mismatch の diff 幅 / 月合計 / anomaly 件数) にし、" +
          "営業所名を添える。全乗務員を一括で見るときは summary から入る",
      ),
  })
  .strict();

/** `summary` モードで乗務員に添える所属。給与比較アーカイブ (R2) 由来。 */
interface DriverIdentity {
  driverName: string;
  branchName: string;
}

/**
 * 給与比較アーカイブから `乗務員CD → 氏名・営業所` を引く (Refs #501 A)。
 *
 * 突合の `name` は **nginx 側の氏名**なので、`ours-only` の乗務員 (nginx のタイムカード
 * 表に出ない人) は空になる。誰が落ちているのか読めないと分類できないので、こちら側の
 * アーカイブから補う。
 *
 * **アーカイブが無くても突合自体は返す** — 会社の解決も R2 の読み取りも失敗したら
 * 空の Map を返し、`branchName` は null になるだけにする。
 */
async function loadDriverIdentities(env: Env, ym: string): Promise<Map<string, DriverIdentity>> {
  const out = new Map<string, DriverIdentity>();
  try {
    const base = companiesListPrefix(r2Prefix(env));
    const prefixes = await listDelimitedPrefixes(env.DTAKO_R2, base);
    const companies = prefixes
      .map((p) => p.slice(base.length).replace(/\/$/, ""))
      .filter((c) => COMP_ID_PATTERN.test(c));
    for (const compId of companies) {
      const { summaries } = await loadMonthSummaries(env, compId, ym);
      for (const s of summaries) {
        const cd = Number(s.data.driverCd);
        if (!Number.isFinite(cd)) continue;
        // 乗務員CD の正規化は突合側 (`String(Number(...))`) に合わせる
        out.set(String(cd), {
          driverName: s.data.driverName,
          branchName: s.data.branchName,
        });
      }
    }
  } catch {
    return new Map();
  }
  return out;
}

/** `summary` モードの 1 行。突合の畳んだ行に、こちら側の氏名・営業所を足したもの。 */
type TimecardDiffSummaryRow = CompareSummaryRow & {
  /** こちら側 (拘束時間管理表) の氏名。アーカイブに無ければ null。 */
  oursName: string | null;
  /** 営業所名。アーカイブに無ければ null。 */
  branchName: string | null;
};

/** `summary` モードの既定の返却件数。全乗務員だと 8 万文字を超えて読み手に載らない。 */
const SUMMARY_DEFAULT_LIMIT = 20;

/**
 * 全乗務員ぶんの合計 (Refs #501)。**絞り込みの前に**数えるので、`limit` を変えても
 * ここは動かない。
 *
 * 今回の目標は差を全部検知することなので、見るべきは `unknown_days` — **既知の規則で
 * 説明が付かなかった日数**。ここが 0 になるまでが検知の仕事。
 */
function summaryTotals(rows: readonly TimecardDiffSummaryRow[]) {
  const causeDays: Record<string, number> = {};
  let unknownDays = 0;
  let unknownMinutes = 0;
  let anomalyCount = 0;
  for (const row of rows) {
    // `causeDays` は 0 件の原因を載せない = 生えている鍵の値は必ず数。
    // `Partial<Record<..>>` の型どおりに `?? 0` を書くと到達しない分岐が残る
    for (const [cause, days] of Object.entries(row.causeDays) as Array<[string, number]>) {
      causeDays[cause] = (causeDays[cause] ?? 0) + days;
    }
    unknownDays += row.unknownCount;
    unknownMinutes += row.unknownMinutes;
    anomalyCount += row.anomalyCount;
  }
  return {
    drivers: rows.length,
    cause_days: causeDays,
    unknown_days: unknownDays,
    unknown_minutes: unknownMinutes,
    anomaly_count: anomalyCount,
  };
}

/**
 * 未説明の多い順に並べる。同数なら残差の大きい順 (符号は問わない — 過大も過少も
 * 同じだけ調べる価値がある)。
 */
function byUnknownDesc(a: TimecardDiffSummaryRow, b: TimecardDiffSummaryRow): number {
  if (b.unknownCount !== a.unknownCount) return b.unknownCount - a.unknownCount;
  return Math.abs(b.unknownMinutes) - Math.abs(a.unknownMinutes);
}

/**
 * `ours-only` の日数を営業所ごとに数える (Refs #501 A)。
 *
 * `ours-only` = こちらに実績があるのに nginx のタイムカード表に居ない日。実測 2026-03
 * では 47 名 / 1083 日あり、その主因は**大阪営業所が社内タイムカードを打っていない**こと
 * だった (nginx の `createPdf` は打刻のある人しか PDF に載せない)。営業所で割ると
 * 「紙と比べられない群」と「本当にこちらの欠落」を分けられる。
 */
function oursOnlyByBranch(
  rows: readonly TimecardDiffSummaryRow[],
): Array<{ branchName: string | null; drivers: number; days: number }> {
  const acc = new Map<string, { branchName: string | null; drivers: number; days: number }>();
  for (const row of rows) {
    const days = row.statusDays["ours-only"];
    if (days === 0) continue;
    const key = row.branchName ?? "";
    const cur = acc.get(key) ?? { branchName: row.branchName, drivers: 0, days: 0 };
    cur.drivers += 1;
    cur.days += days;
    acc.set(key, cur);
  }
  return [...acc.values()].sort((a, b) => b.days - a.days);
}

/** 突合結果の 1 日が「見るべき日」か。 */
function isNotableDay(d: CompareResult["days"][number]): boolean {
  if (d.anomalies.length > 0) return true;
  return d.status !== "match" && d.status !== "within-tolerance" && d.status !== "both-empty";
}

export const getTimecardDiffTool = {
  name: "get_timecard_diff",
  description:
    "社内 CakePHP のタイムカード表 (PDF) の拘束と、こちらの打刻基準の拘束を**暦日ごとに突き合わせて**返す " +
    "(Refs #492)。driver 省略で全乗務員を一括チェックできる。" +
    "既定 (only_anomalies=true) では差分も異常も無い乗務員を落とし、各乗務員の days も該当日だけに絞る。" +
    "status は match / within-tolerance (許容誤差内) / mismatch / nginx-only / ours-only / both-empty。" +
    "**残業は比較しない** — nginx 側は旅費由来+手入力の加算補正、こちらは所定超で定義が別物のため。" +
    "anomalies は nginx 側のデータ異常で、負の拘束 (negative-kosoku / negative-kosoku-type、" +
    "yhonda-ohishi/nginx#783)・1 日 1440 分超・月次集計欄の負値を拾う。**差分と独立に出る** " +
    "(両者が一致していても nginx 側が負なら報告される)。" +
    "**全乗務員を見るときは mode=summary から入る** — 日別を落として 1 行にし、" +
    "`totals` (原因別日数・未説明日数) を添えたうえで**未説明の多い順に既定 20 名**だけ返す (limit で変更可)。" +
    "totals と ours_only_by_branch は絞り込む前の全乗務員で数えるので limit を変えても動かない。" +
    "こちら側の氏名・営業所と `ours_only_by_branch` (ours-only 日数の営業所別内訳) を添える。" +
    "そこで見当を付けてから driver 指定で日別に掘る。",
  inputSchema: getTimecardDiffArgs,
  execute: async (env: Env, args) => {
    if (!parseYm(args.month)) throw new Error("month は YYYY-MM で指定してください");
    const onlyAnomalies = args.only_anomalies ?? true;
    const driver = args.driver ? String(Number(args.driver)) : null;

    // こちら側は前月も要る — 前月から跨いだ勤務が当月 1 日に落ちるため、
    // 取らないと月初が過少になる
    const prevYm = prevYmOf(args.month);
    // **突合は `view=compare` で取る** (Refs ohishi-exp/rust-ichibanboshi#157)。
    // 既定の応答は 1 日 19 キー・全乗務員で 1.73 MB あるが、突合が使うのは日付・拘束・
    // フェリー控除と暦日按分用の parts だけ。絞ると 256 KB (実測 6.8 分の 1) になる。
    // この経路は社内から Cloudflare Tunnel を通るので、サイズがそのまま応答時間になる
    const kosokuQuery = (ym: string) =>
      `/api/kintai/kosoku-daily?month=${encodeURIComponent(ym)}&view=compare`;
    const [pdfBody, curBody, prevBody] = await Promise.all([
      fetchIchibanJson(
        env,
        `/api/kintai/pdf-json?month=${encodeURIComponent(args.month)}` +
          (driver ? `&driver=${encodeURIComponent(driver)}` : ""),
        "timecard_diff",
      ),
      fetchIchibanJson(env, kosokuQuery(args.month), "timecard_diff"),
      fetchIchibanJson(env, kosokuQuery(prevYm), "timecard_diff"),
    ]);

    // 当月 + 前月を乗務員CD ごとに連結してから暦日按分する。relay の
    // `mergeKosokuShiftMaps` を使わないのは、あちらが「取得失敗 = null」を扱う
    // 都合で null を返しうる型になっており、ここでは起きない分岐が残るため
    const shifts = new Map<string, KosokuShift[]>();
    for (const body of [curBody, prevBody]) {
      for (const [driverCd, driverShifts] of parseKosokuDaily(body)) {
        shifts.set(driverCd, [...(shifts.get(driverCd) ?? []), ...driverShifts]);
      }
    }
    const oursByDriver = new Map<string, Map<string, { restraintMinutes: number }>>();
    // 月境界を跨ぐ勤務由来の分 — 紙は月内の打刻だけで対を組むため月を跨ぐ勤務が
    // どちらの月にも載らない。cause "month-boundary" の説明に使う (Refs #501)
    const crossMonthByDriver = new Map<string, Map<string, number>>();
    for (const [driverCd, driverShifts] of shifts) {
      oursByDriver.set(driverCd, kosokuPartsByDate(driverShifts, args.month));
      crossMonthByDriver.set(driverCd, crossMonthMinutesByDate(driverShifts, args.month));
    }
    // 紙の再現値との差 (cause "rounding" の実額) — 当月の応答からだけ読む
    // (Refs ohishi-exp/rust-ichibanboshi#179)
    const paperDriftByDriver = parsePaperDriftByDriver(curBody);
    // 紙だけが数える勤務外の分 (cause "paper-outside" の実額、Refs #546 / rust#182)
    const paperOutsideByDriver = parsePaperOutsideByDriver(curBody);
    // こちらだけが数える時間 (cause "ours-outside" の実額、鏡像)
    const oursOutsideByDriver = parseOursOutsideByDriver(curBody);
    // 紙が引く 運行開始 → 始業 (cause "minus-unko" の実額、Refs #546 / rust#182)
    const minusUnkoByDriver = parseMinusUnkoByDriver(curBody);
    // 深夜を跨ぐ継ぎ目の暦日配分の差 (cause "gap-midnight" の実額、Refs #546)
    const gapMidnightByDriver = parseGapMidnightByDriver(curBody);
    // フェリー控除の日別マップ (rust#181) — 勤務に貼れない日があるのでマップ優先
    const ferryMinusByDriver = parseFerryMinusByDriver(curBody);
    // nginx はエラーも HTTP 200 + `{error}` で返す (nginx#784)。素通しすると
    // 「差なし」に見えるので必ず表に出す
    const upstreamError = pdfJsonError(pdfBody);
    if (upstreamError) throw new Error(`タイムカードPDF API: ${upstreamError}`);
    const nginxByDriver = parsePdfJson(pdfBody, args.month);

    let results: CompareResult[];
    if (driver) {
      results = [
        compareTimecardMonth({
          month: args.month,
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
          toleranceMinutes: args.tolerance_minutes,
        }),
      ];
    } else {
      results = compareTimecardMonthAll({
        month: args.month,
        nginxByDriver,
        oursByDriver,
        crossMonthByDriver,
        paperOutsideByDriver,
        oursOutsideByDriver,
        minusUnkoByDriver,
        gapMidnightByDriver,
        paperDriftByDriver,
        ferryMinusByDriver,
        toleranceMinutes: args.tolerance_minutes,
        onlyAnomalies,
      });
    }
    // 日別を落として 1 行にする。only_anomalies=true でも 129 名で 54 万文字返り、
    // 読み手の context に載らなかった (Refs #501 F)
    if (args.mode === "summary") {
      const identities = await loadDriverIdentities(env, args.month);
      const rows: TimecardDiffSummaryRow[] = summarizeCompareResults(results).map((row) => {
        const id = identities.get(row.driverCd);
        return {
          ...row,
          oursName: id?.driverName ?? null,
          branchName: id?.branchName ?? null,
        };
      });
      // 合計と営業所別は**絞り込む前**の全行で数える — limit は読む量を減らす
      // だけで、全体像を変えてはいけない
      const totals = summaryTotals(rows);
      const branches = oursOnlyByBranch(rows);
      const limit = args.limit ?? SUMMARY_DEFAULT_LIMIT;
      const shown = [...rows].sort(byUnknownDesc).slice(0, limit);
      return {
        month: args.month,
        driver,
        onlyAnomalies,
        mode: "summary" as const,
        drivers: rows.length,
        totals,
        ours_only_by_branch: branches,
        /** 未説明の多い順。`limit` で切った残りの件数。 */
        omitted: rows.length - shown.length,
        results: shown,
      };
    }

    // 全暦日を返すと 130 名 × 31 日で読み手の context を食い潰す。既定では
    // 「見るべき日」だけに絞る (件数は mismatchCount / anomalies に残る)
    const trimmed = onlyAnomalies
      ? results.map((r) => ({ ...r, days: r.days.filter(isNotableDay) }))
      : results;

    return {
      month: args.month,
      driver,
      onlyAnomalies,
      mode: "days" as const,
      drivers: trimmed.length,
      results: trimmed,
    };
  },
} satisfies ToolEntry<typeof getTimecardDiffArgs>;

/** server.ts が McpServer に登録する全 tool。inputSchema が異なるため
 *  `ToolEntry<z.ZodTypeAny>` に揃えて束ねる (cf-access-mcp と同じパターン)。 */

// ── run_kintai_relay ──────────────────────────────────────────────────────────

const runKintaiRelayArgs = z.object({
  month: z
    .string()
    .optional()
    .describe("窓の最後の月 (YYYY-MM)。省略すると JST の当月"),
  month_count: z
    .number()
    .int()
    .optional()
    .describe("窓の月数 (既定 2 = 当月 + 前月、上限 12)"),
  apply: z
    .boolean()
    .optional()
    .describe("**true で初めて GCP に書く**。省略時は変わる件数を数えるだけ"),
});

/**
 * 打刻をオンプレ → GCP へ**窓ぶんまるごと**運ぶ (Refs ohishi-exp/rust-ichibanboshi#205 の 04b)。
 *
 * **運ぶロジックはここに無い。** relay の `POST /kintai-relay/run` を service binding
 * 越しに叩くだけで、署名の突き合わせは受け側 (`kintai_push::plan_window`)、tenant の
 * 解決は relay 側 (KV `dtako_accounts`)。ここは MCP の認証付き入口を出すだけ —
 * 人間に `INTERNAL_SHARED_SECRET` を手渡さずに起動できるようにするのが目的。
 */
export const runKintaiRelayTool = {
  name: "run_kintai_relay",
  description:
    "社内 MariaDB の打刻を GCP 側 (Supabase kintai.*) へ運ぶ " +
    "(Refs ohishi-exp/rust-ichibanboshi#205 の 04b)。" +
    "**apply を付けない限り 1 行も書かない** — 変わる件数だけ返る (既定)。" +
    "窓 (既定 = 当月 + 前月) をまるごと 1 回で運ぶので、**呼び直しは要らない**。" +
    "毎回まるごと送り直すのは 始業/終業 が後から直るため。" +
    "書き込みは受け側の日単位署名が守るので、変わった日しか書かれない — " +
    "daysWritten が 0 なら「変わっていない」であって「動かなかった」ではない。" +
    "misplaced が 0 でなければ運び方が壊れている。" +
    "unknownStates が空でなければ上流に DDL の CHECK に無い state が来ている。" +
    "timings に各レグの所要時間 (ms) が入る (onprem*Ms との差が Tunnel の往復ぶん)。",
  inputSchema: runKintaiRelayArgs,
  // **write tool。** 打刻を本番 Supabase に書きうるので read tool と同じ扱いにしない
  requiresScope: "mcp.write",
  execute: async (env: Env, args: z.infer<typeof runKintaiRelayArgs>) => {
    if (args.month !== undefined && !parseYm(args.month)) {
      throw new Error("month は YYYY-MM で指定してください");
    }
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");

    const res = await relay.fetch("https://relay.internal/kintai-relay/run", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
      body: JSON.stringify({
        month: args.month,
        month_count: args.month_count,
        apply: args.apply === true,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${body.slice(0, 200)}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${body.slice(0, 200)}`);
    }
  },
};

// ── run_dtako_scrape / get_dtako_scrape_status ────────────────────────────────

const runDtakoScrapeArgs = z
  .object({
    dates: z
      .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
      .min(1)
      .describe(
        "取り直す**読取日**の配列 (YYYY-MM-DD)。**必須** — 既定値は無い。" +
          "get_reading_dates (rust-ichibanboshi の /api/kintai/reading-dates) の " +
          "by_reading_date のキーをそのまま渡す。**勤務日ではなく読取日**",
      ),
    comp_id: z.string().optional().describe("会社。省略すると relay の既定 (KINTAI_COMP_ID)"),
  })
  .strict();

/**
 * 読取日を名指しでスクレイプし直す (Refs ohishi-exp/rust-ichibanboshi#205 の 42)。
 *
 * **配るロジックはここに無い。** relay の `POST /kintai-relay/scrape` を service
 * binding 越しに叩くだけ (`run_kintai_relay` と同じ形)。
 */
export const runDtakoScrapeTool = {
  name: "run_dtako_scrape",
  description:
    "**【書き込み】指定した読取日のデジタコデータを取り直す** " +
    "(Refs ohishi-exp/rust-ichibanboshi#205 の 42)。" +
    "イベント分類 (休憩⇄運転) を後から編集すると alc の R2 の CSV が古いままになり、" +
    "拘束・休憩の値がオンプレとずれる。該当の読取日を取り直せば直る。" +
    "**dates は必須で既定値は無い** — 取り込みは has_kudgivt を一旦 FALSE に戻すので、" +
    "要らない日を巻き込むと運行が読み取り側から消える。" +
    "**勤務日ではなく読取日**を渡すこと (長距離は運行終了の数日後に読取日が付く。実測 +11 日)。" +
    "1 回の上限は 10 日で、**超えたぶんは truncated_dates に返る** (黙って切らない)。" +
    "★**応答は「受理した」までで、結果はまだ出ていない。** スクレイプは非同期に走るので、" +
    "終わったかどうかは get_dtako_scrape_status で別に確認すること。",
  inputSchema: runDtakoScrapeArgs,
  // **write tool。** 本番の R2 / DB を書き換えうるので read tool と同じ扱いにしない
  requiresScope: "mcp.write",
  execute: async (env: Env, args: z.infer<typeof runDtakoScrapeArgs>) => {
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");
    const res = await relay.fetch("https://relay.internal/kintai-relay/scrape", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
      body: JSON.stringify({ dates: args.dates, comp_id: args.comp_id }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${body.slice(0, 200)}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${body.slice(0, 200)}`);
    }
  },
};

const getDtakoScrapeStatusArgs = z
  .object({
    limit: z.number().int().min(1).max(200).optional().describe("引く履歴の件数 (既定 50)"),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        "unsplit_total を数える期間の始まり (YYYY-MM-DD)。" +
          "**date_to と両方渡さないと unsplit_total は null (見ていない) になる**",
      ),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("同・終わり (YYYY-MM-DD)。期間の上限は alc 側で 40 日"),
  })
  .strict();

export const getDtakoScrapeStatusTool = {
  name: "get_dtako_scrape_status",
  description:
    "run_dtako_scrape で起動した取り直しの**結果**を返す " +
    "(Refs ohishi-exp/rust-ichibanboshi#205 の 42)。読むだけ。" +
    "history は {target_date, comp_id, status, message} の配列で、" +
    "status が split_failed の行は CSV 分割が落ちた回。" +
    "★**split_failed が 0 でも has_kudgivt = FALSE が残ることがある** " +
    "(alc の update_has_kudgivt が当たらなくても Ok(0) を返すため) — " +
    "**必要条件であって十分条件ではない**。" +
    "**date_from / date_to を渡すと unsplit_total (未 split の運行数) を直接数える** — " +
    "これが 0 なら取り込みは完了している。" +
    "**unsplit_total が null なのは「残っていない」ではなく「見ていない」** " +
    "(date_from / date_to を渡していないか、alc から引けなかった。後者は unsplit_error に出る)。" +
    // ── 履歴に「載っていない」の読み方 (Refs #958) ──────────────────────────
    "★**history に載っていないことを「実行されていない」の根拠にしない。** " +
    "画面 (WS) 経由の手動スクレイプに加えて、#946 以降は日次 cron / run_dtako_scrape の" +
    "無人実行もここに載るようになったが、履歴の書き込みは best-effort で " +
    "(落ちても取り込み本体は成功のまま進む)、#946 より前の無人実行はそもそも載っていない。" +
    "**無人実行が走ったかどうかは get_dtako_scrape_progress (DO 自身の状態) で見ること。** " +
    "こちらには fold (取り込み後の畳み直し) の情報も一切載らない — " +
    "fold_* は get_dtako_scrape_progress 側だけが持つ。",
  inputSchema: getDtakoScrapeStatusArgs,
  execute: async (env: Env, args: z.infer<typeof getDtakoScrapeStatusArgs>) => {
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");
    const p = new URLSearchParams();
    if (args.limit !== undefined) p.set("limit", String(args.limit));
    if (args.date_from !== undefined) p.set("date_from", args.date_from);
    if (args.date_to !== undefined) p.set("date_to", args.date_to);
    const q = p.size === 0 ? "" : `?${p.toString()}`;
    const res = await relay.fetch(`https://relay.internal/kintai-relay/scrape-history${q}`, {
      method: "GET",
      headers: { "X-Alc-Proxy-Secret": secret },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${body.slice(0, 200)}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${body.slice(0, 200)}`);
    }
  },
};

const getDtakoScrapeProgressArgs = z
  .object({
    comp_id: z
      .string()
      .optional()
      .describe(
        "会社を絞る (省略すると dtako_accounts に載っている全社ぶんを comps 配列で返す)",
      ),
  })
  .strict();

export const getDtakoScrapeProgressTool = {
  name: "get_dtako_scrape_progress",
  description:
    "**run_dtako_scrape で起動した `/cron/dtako` job が「まだ走っている / 終わった / " +
    "落ちた」かを DO の scrapeQueue から直接見る** (Refs ohishi-exp/rust-ichibanboshi#205 の 43)。" +
    "読むだけ。**get_dtako_scrape_status とは別物** — あちらは alc 側の履歴で、" +
    "画面 (WS) 経由の手動スクレイプはあちらにしか載らない (こちらには 1 件も載らない)。" +
    "**逆に、無人実行が「あちらに載らない」のは #946 より前の話** — " +
    "#946 以降は日次 cron / run_dtako_scrape の結果も alc 履歴に書くようになった。" +
    "ただしその書き込みは best-effort (落ちても取り込み本体は成功のまま進む) なので、" +
    "**あちらに無いことを「実行されていない」の根拠にしない**。" +
    "こちらは DO 自身が持つ状態なので、無人実行でも見える。" +
    "**DO は comp_id ごとの instance。** comp_id を省略すると dtako_accounts の" +
    "全社ぶんを `comps` 配列で返す (会社ごとに comp_id 付き) — 1 社しか見えていないのに" +
    "全部見たと錯覚しないよう、常にどの社のものかが分かる形になっている。" +
    "各 job の state は pending/running/done/failed の 4 つ。" +
    "**failed には error が付く。黙って消えない。** " +
    "done でも split_failed が null でない数を持つことがある — " +
    "0 より大きければ取り込みは成功したが CSV 分割が落ちた回 " +
    "(get_dtako_scrape_status の split_failed と同じ注意: 必要条件であって十分条件ではない)。" +
    "**進捗は上限 200 件で古い方から捨てる** (応答の max_records で分かる)。" +
    // ── fold_* の意味 (Refs #958) ──────────────────────────────────────────
    "各 job には、取り込みの後に走る勤怠の畳み直し (fold) の記録が fold_* として載る。" +
    "**fold_* は state を一切動かさない** — fold_state: failed でも state は取り込みが" +
    "決めた値のままで、逆に state: done を見て fold まで成功したと読んではいけない " +
    "(fold の内訳は応答の fold_counts を見る。pending/running/done/failed の 4 件数は" +
    "取り込みのもので、fold の成否を 1 件も含まない)。" +
    "**fold_state の 9 値**: running (走行中。**これだけが非終端**) / done (畳み切った) / " +
    "capped (ページ上限で打ち切った。**失敗ではないが完了でもない** — 畳み残しがあり、" +
    "続きは次回の fold に委ねている。打ち切った回は月ゲートを封じない) / " +
    "stale (running のまま閾値を超えたので終端に倒した。**fold が失敗したと確認できたわけではない** — " +
    "DO の再起動 (deploy / evict) 等で終端の記録が書かれず取り残されただけのことがある。" +
    "倒した理由と経過時間は fold_error に書いてある) / failed (fold 自体が落ちた。理由は fold_error) / " +
    "skipped_no_upload・skipped_split_failed・skipped_out_of_scope " +
    "(**意図して回さなかった。失敗ではない**) / " +
    "not_configured (**設定の穴**。skipped_* と混ぜない — あちらは意図して回さなかった状態で、" +
    "こちらは設定を直せば回る)。" +
    "**なぜ回さなかったかは fold_skip_reason が名指しする** (skipped_* / not_configured のとき)。" +
    "fold_months は畳んだ対象月、fold_started_at は fold_state: running を書いた時刻、" +
    "fold_pages / fold_drivers_written は **fold の終端 1 か所でしか書かない全月の合計**。" +
    "fold_running_for_ms / fold_stale は running のレコードにだけ応答で添える算出値で" +
    "保存値ではない (fold_stale: true は「疑え」であって「失敗した」ではない)。" +
    "★**fold_* には別の試行の値が残り得る。** 進捗レコードは部分 spread で重ねるので、" +
    "patch に含まれないフィールドは前回の試行の値のまま残る。" +
    "fold_pages / fold_drivers_written は fold の終端でしか書かないので、" +
    "**running の間に見えている数字は今回の途中経過ではなく前回の試行の終端値** " +
    "(#945 がこれを今回の途中経過と読んで誤診した)。fold_error も同じで、" +
    "前回 failed → 今回 running にすると古いエラーが残る。" +
    "**#944 以降は running の入口で前回の残骸を捨てるようになったが、" +
    "それ以前に書かれた記録には残ったままなので、古い記録を読むときは必ず疑うこと。** " +
    // ── done + pre_upload + error が混ざる (Refs #959) ─────────────────────
    "★**state: \"done\" なのに phase: \"pre_upload\" と error を抱えた記録が混ざる。** " +
    "phase は破壊的操作 (取り込み) の前か後かを表す pre_upload / post_upload で、" +
    "state: running の間だけ意味を持つ。取り込み経路はアップロードを発火する直前に " +
    "post_upload へ倒してからでないと done を書かないので、" +
    "**done + pre_upload の組は取り込み経路では作れない**。" +
    "これは **#942 以前に書かれた記録**で、当時は画面 (WS) 経路の fold が既存レコードに " +
    "state: \"done\" を重ねており、前の試行の phase / error を残したまま done に化けた。" +
    "**#942 は新規発生を止めただけで、既に書かれた記録はそのまま残っている** " +
    "(2026-08-26 時点で複数の読取日に現存)。" +
    "⇒ **state と error が矛盾しているので、どちらが真かは記録からは決まらない** — " +
    "error と phase: pre_upload からは「アップロード前に落ちた」と読めるが、state: done と食い違う。" +
    "**この形を見たら記録だけで取り込みの成否を判定せず、alc 側 " +
    "(get_dtako_scrape_status の unsplit_total 等) で確かめること。**",
  inputSchema: getDtakoScrapeProgressArgs,
  execute: async (env: Env, args: z.infer<typeof getDtakoScrapeProgressArgs>) => {
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");
    const q = args.comp_id ? `?comp_id=${encodeURIComponent(args.comp_id)}` : "";
    const res = await relay.fetch(`https://relay.internal/kintai-relay/scrape-progress${q}`, {
      method: "GET",
      headers: { "X-Alc-Proxy-Secret": secret },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${body.slice(0, 200)}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${body.slice(0, 200)}`);
    }
  },
};

// ── get_operation_zip ────────────────────────────────────────────────────────

const getOperationZipItemArgs = z
  .object({
    ope_no_22: z
      .string()
      .regex(OPE_NO_RE)
      .describe(
        "運行No。**theearth 側の 22 桁**。オンプレの unko_no は 23 桁 — " +
          "呼び出し元が末尾 1 桁を落として渡すこと。",
      ),
    start_ope: z
      .string()
      .regex(START_OPE_RE)
      .describe('出庫日時。"YYYY/MM/DD H:mm:ss" (時は0埋めしない、例 "2026/07/07 7:53:30")'),
    recalculate: z
      .boolean()
      .optional()
      .describe(
        "true にすると relay が読む前に theearth の作業時間を再集計する (書き込み)。既定 false。",
      ),
  })
  .strict();

const getOperationZipArgs = z
  .object({
    ope_no_22: z
      .string()
      .regex(OPE_NO_RE)
      .optional()
      .describe(
        "運行No。**theearth 側の 22 桁**。オンプレの unko_no は 23 桁 — " +
          "呼び出し元が末尾 1 桁を落として渡すこと (この tool は 22 桁しか受け付けない)。" +
          "rust-ichibanboshi の day-events (#273) が返す zip_request.ope_no がそのまま渡せる。" +
          "**`items` を渡す場合は省略する** (単体形式専用のフィールド)。",
      ),
    start_ope: z
      .string()
      .regex(START_OPE_RE)
      .optional()
      .describe(
        '出庫日時。"YYYY/MM/DD H:mm:ss" (時は0埋めしない、例 "2026/07/07 7:53:30")。' +
          "**`items` を渡す場合は省略する**。",
      ),
    recalculate: z
      .boolean()
      .optional()
      .describe(
        "**既定 false — 読むだけで theearth 側は一切書き換えない。** " +
          "true にすると relay が読む前に theearth の作業時間を再集計する (書き込み操作)。" +
          "**単体形式のときだけ有効** — `items` を渡す場合は items[].recalculate を使う。",
      ),
    comp_id: z.string().optional().describe("会社。省略すると relay の既定 (KINTAI_COMP_ID)"),
    items: z
      .array(getOperationZipItemArgs)
      .min(1)
      .max(CRON_BATCH_MAX_ITEMS)
      .optional()
      .describe(
        `複数運行をまとめて 1 回の呼び出しで処理する場合の配列 (**上限 ${CRON_BATCH_MAX_ITEMS} 件、` +
          "超過は relay が 400 で拒否する — 切り詰めない)。指定すると単体形式の " +
          "ope_no_22/start_ope/recalculate は無視され、items の各要素がそれぞれ処理される。" +
          "**★ items 形式の応答には zip_base64 が含まれない** (`bytes`/`entries`/`omitted` の" +
          "メタ情報のみ) — 20件分の base64 で応答が膨れるのを避けるため。中身のバイト列が" +
          "要る運行は、その運行だけ単体形式 (items を使わない呼び出し) で個別に取り直すこと。" +
          "応答には results[]/success_count/failure_count/truncated/remaining/theearth_logins " +
          "が載る。theearth セッション切れ (truncated: true) の場合、remaining 件は未着手なので " +
          "残りを別の呼び出しで処理すること。",
      ),
  })
  .strict()
  .refine((v) => (v.items && v.items.length > 0) || (v.ope_no_22 && v.start_ope), {
    message: "ope_no_22 と start_ope の組、または items のどちらかが必要です",
  });

/**
 * 運行 1 件ぶん (または `items` で複数件まとめて) の csvdata.zip を取る (Refs
 * ohishi-exp/rust-ichibanboshi#274, #205 の 59、複数件対応は Refs #633)。
 *
 * **read-only。** relay の `POST /kintai-relay/operation-zip` を叩くだけ —
 * relay 側が `DTAKO_ACCOUNTS` で自前ログインして theearth から zip を取る
 * (ブラウザセッションに依存しない)。取り込み (`autoload` への POST) はしない、
 * 1 段目だけの tool。
 *
 * **単体形式 (`ope_no_22`/`start_ope`) は `items` 追加前と body/挙動を変えていない**
 * — `items` が無ければ従来どおりの1件形式のまま relay へ送る (Refs #633-24)。
 */
export const getOperationZipTool = {
  name: "get_operation_zip",
  description:
    "運行 1 件ぶんの csvdata.zip を取る (Refs ohishi-exp/rust-ichibanboshi#274, #205 の 59)。" +
    "**読むだけ — 取り込み (nginx への autoload POST) はしない。** " +
    "relay が `DTAKO_ACCOUNTS` で自前ログインして theearth から取得する " +
    "(ブラウザのセッションには依存しない、無人で呼べる)。" +
    "**zip_base64 は上限 (既定 1MB、応答の limit_bytes) を超えると null** になり、" +
    "代わりに `omitted: true` が立つ (壊れた zip を黙って返さない)。" +
    "単一運行の実測は 8.7KB — 超えるなら ope_no_22/start_ope の指定間違いを疑うこと。" +
    "`entries` に zip 内の CSV 名 (KUDGFUL/KUDGIVT/KUDGURI/SokudoData 等) が入るので、" +
    "取り込み側が探すファイルが揃っているかを事前に確認できる。" +
    "**既定は読むだけ (theearth 側は書き換えない)。** `recalculate: true` を渡すと、読む前に " +
    "relay が theearth の作業時間を再集計する (書き込み操作、既定 false のまま変えない)。" +
    `**複数運行をまとめる場合は \`items\` (最大 ${CRON_BATCH_MAX_ITEMS} 件、超過は relay が400) を使う。` +
    "★ items 形式では zip_base64 は返らない (bytes/entries/omitted のみ) — 中身が要る運行は" +
    "単体形式で個別に取り直すこと。応答に results[]/success_count/failure_count/truncated/" +
    "remaining/theearth_logins が載る。",
  inputSchema: getOperationZipArgs,
  execute: async (env: Env, args: z.infer<typeof getOperationZipArgs>) => {
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");
    const body = args.items
      ? {
          comp_id: args.comp_id,
          items: args.items.map((item) => ({
            ope_no: item.ope_no_22,
            start_ope: item.start_ope,
            recalculate: item.recalculate === true,
          })),
        }
      : { ope_no: args.ope_no_22, start_ope: args.start_ope, recalculate: args.recalculate, comp_id: args.comp_id };
    const res = await relay.fetch("https://relay.internal/kintai-relay/operation-zip", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
      body: JSON.stringify(body),
    });
    const responseBody = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${responseBody.slice(0, 200)}`);
    try {
      return JSON.parse(responseBody) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${responseBody.slice(0, 200)}`);
    }
  },
};

// ── run_dtako_reimport ───────────────────────────────────────────────────────

/** オンプレ側 `unko_no` は23桁 (kintai-ops skill §4.6 — theearth/GCP 側の
 * `ope_no_22` とは桁数が違う。混同すると存在しない運行を指す)。 */
const UNKO_NO_23_RE = /^\d{23}$/;

/** relay (`dtako-reimport.ts` の `isUnkoNoAcceptable`) は `reset_timecard: false`
 * (明示時) のとき 22 桁 (対象CD抜き、GCP/alc 由来) も受け付ける — 取り込み対象は
 * zip (ope_no_22+start_ope) が決めるため。ここで一律23桁固定にすると relay なら
 * 通るはずの22桁を MCP 側で弾いてしまう (Refs #633-24-3)。**MCP tool 側の
 * reset_timecard 既定は true (#633-24-2) だが、この regex 自体は false/true どちらの
 * 値でも構文として通す — 桁数と既定値の強制は runDtakoReimportItemArgs/
 * runDtakoReimportArgs の `.refine()` が担う。** */
const UNKO_NO_22_OR_23_RE = /^\d{22,23}$/;

/** `unko_no` の説明文 (単体・items 共通)。reset_timecard の値で意味が変わる
 * (dtako-reimport.ts の `isUnkoNoAcceptable`/module doc 参照)。**「間違えると
 * 別の運行に取り込む」という説明は reset_timecard=true (既定、#633-24-2) のときだけ
 * 正しい** — reset_timecard=false を明示したときだけ取り込み対象を zip
 * (ope_no_22+start_ope) が決め、unko_no は「1件に紐付ける歯止めと監査ラベル」でしか
 * ない (Refs #633-24、旧説明のせいで作業が止まった)。 */
const UNKO_NO_DESCRIPTION =
  "オンプレ側の運行NO。**23桁**、ope_no_22 とは桁が違う (末尾1桁 = 対象CD を含む値)。" +
  "**reset_timecard=false を明示したときは「1件に紐付ける歯止めと監査ラベル」でしかない** — " +
  "取り込み対象は zip (ope_no_22 + start_ope) が決めるため、unko_no を間違えても別の運行に" +
  "取り込まれることはない。**reset_timecard=true (既定) のときだけ意味が変わる**: 23桁目 " +
  "(対象CD) が「2マンの何人目か」を区別する実物の値として使われるため、ここを間違えると" +
  "別の乗務員の勤務時間を書き換えてしまう。**2マンの運行でも、22桁 (対象CD抜き) 1本の投入で" +
  "主・助手の両方が取り込まれる** (`operations_count: 2` で実証済み) — `…1`/`…2` の2桁を" +
  "2回に分けて呼ぶ必要は無い。**22桁 (対象CD抜き) を受け付けるのは reset_timecard=false を" +
  "明示したときだけ** — 23桁が必須になるのは reset_timecard=true (既定) のときだけ。";

const runDtakoReimportItemArgs = z
  .object({
    ope_no_22: z.string().regex(OPE_NO_RE).describe("運行No。theearth 側の22桁。"),
    start_ope: z
      .string()
      .regex(START_OPE_RE)
      .describe('出庫日時。"YYYY/MM/DD H:mm:ss" (時は0埋めしない、例 "2026/07/07 7:53:30")'),
    unko_no: z.string().regex(UNKO_NO_22_OR_23_RE).describe(UNKO_NO_DESCRIPTION),
    reset_timecard: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "true (既定) で②(取り込み)に続けて③(勤務時間再登録)まで実行する。" +
          "false にすると②だけで止める。",
      ),
  })
  .strict()
  .refine((v) => v.reset_timecard !== true || UNKO_NO_23_RE.test(v.unko_no), {
    message: "reset_timecard: true のときは unko_no は23桁である必要があります",
    path: ["unko_no"],
  });

const runDtakoReimportArgs = z
  .object({
    ope_no_22: z
      .string()
      .regex(OPE_NO_RE)
      .optional()
      .describe(
        "運行No。theearth 側の22桁 (get_operation_zip の ope_no_22 と同じ)。" +
          "**`items` を渡す場合は省略する** (単体形式専用のフィールド)。",
      ),
    start_ope: z
      .string()
      .regex(START_OPE_RE)
      .optional()
      .describe(
        '出庫日時。"YYYY/MM/DD H:mm:ss" (時は0埋めしない、例 "2026/07/07 7:53:30")。' +
          "**`items` を渡す場合は省略する**。",
      ),
    unko_no: z
      .string()
      .regex(UNKO_NO_22_OR_23_RE)
      .optional()
      .describe(`${UNKO_NO_DESCRIPTION} **\`items\` を渡す場合は省略する** (items[].unko_no を使う)。`),
    reset_timecard: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "true (既定) で②(取り込み)に続けて③(勤務時間再登録、resetby-unko-no)まで実行する。" +
          "false にすると②だけで止める (GCP側 time_card_dtako には届かない)。" +
          "**単体形式のときだけ有効** — `items` を渡す場合は items[].reset_timecard を使う。",
      ),
    comp_id: z.string().optional().describe("会社。省略すると relay の既定 (KINTAI_COMP_ID)"),
    items: z
      .array(runDtakoReimportItemArgs)
      .min(1)
      .max(CRON_BATCH_MAX_ITEMS)
      .optional()
      .describe(
        `複数運行をまとめて 1 回の呼び出しで取り込む場合の配列 (**上限 ${CRON_BATCH_MAX_ITEMS} 件、` +
          "超過は relay が 400 で拒否する — 切り詰めない)。**`unko_no` は items の各要素にも必須**" +
          " (alc-upload と違い reimport は常に unko_no が要る)。指定すると単体形式の " +
          "ope_no_22/start_ope/unko_no/reset_timecard は無視される。応答には " +
          "results[]/success_count/failure_count/truncated/remaining/theearth_logins が載る — " +
          "theearth セッション切れ (truncated: true) の場合、remaining 件は未着手。" +
          "**results[i] に uncertain: true が含まれる項目は、同じ引数で再実行しないこと** " +
          "(push 後に応答不明=二重取り込みの可能性)。",
      ),
  })
  .strict()
  .refine((v) => (v.items && v.items.length > 0) || (v.ope_no_22 && v.start_ope && v.unko_no), {
    message: "ope_no_22/start_ope/unko_no の組、または items のどちらかが必要です",
  })
  .refine(
    (v) => {
      // items 指定時は単体の reset_timecard/unko_no は無視される仕様なので、
      // items が無いときだけこのチェックを効かせる (relay の isUnkoNoAcceptable と同じ条件)。
      if (v.items && v.items.length > 0) return true;
      if (v.reset_timecard !== true) return true;
      return !!v.unko_no && UNKO_NO_23_RE.test(v.unko_no);
    },
    {
      message: "reset_timecard: true のときは unko_no は23桁である必要があります",
      path: ["unko_no"],
    },
  );

/**
 * 運行 1 件の csvdata.zip を取得〜オンプレ取り込みまで 1 tool で完結させる
 * (Refs ohishi-exp/rust-ichibanboshi#280、#205 の 67)。
 *
 * **目的: モデルが base64 を書き写さない。** 以前は `get_operation_zip` の
 * `zip_base64` をモデルが書き写してオンプレへ POST しており、書き写した時点で
 * 壊れる事故が 2 回起きていた (`base64: invalid input`)。しかも壊れた zip を
 * 投げても社内 nginx (CakePHP) は黙って無視するため、原因が分からなかった。
 *
 * この tool は relay の `POST /kintai-relay/dtako-reimport` を叩くだけ — ①zip
 * 取得 (自前ログイン) と②オンプレ push (`rust-ichibanboshi` の
 * `POST /api/dtako/autoload`、変更しない) は relay 内で完結し、zip のバイト列は
 * このプロセス (kyuyo-mcp) にも、ましてやモデルにも渡らない。
 *
 * **write tool。** dtako_events / (reset_timecard=true なら) time_card_dtako を
 * 書き換えうる破壊的操作なので、`get_operation_zip` と違い `mcp.write` を要求する。
 */
export const runDtakoReimportTool = {
  name: "run_dtako_reimport",
  description:
    "運行 1 件の csvdata.zip を theearth から取得し、そのままオンプレの取り込み口 " +
    "(`POST /api/dtako/autoload`) へ push する 1 tool 完結版 " +
    "(Refs ohishi-exp/rust-ichibanboshi#280、#205 の 67)。" +
    "**base64 をモデルが書き写す必要が無い** — get_operation_zip の zip_base64 を" +
    "手で運んでいた旧経路は書き写した時点で壊れる事故が起きていた。relay が " +
    "①zip取得(自前ログイン)〜②オンプレpush まで内部で完結させる。" +
    "**書き込み tool。** dtako_events を書き換える破壊的操作。preview は無い — " +
    "内容を先に確認したいなら get_operation_zip を先に呼ぶこと。" +
    "**★★ http_status / reset_http_status は成功の証明にならない。** autoload は " +
    "api フラグ無しだと307を返すことがあるが、取り込み自体は redirect 判定より前に" +
    "実行済み。reset_timecard(③)の応答は空200で、成否はPHP側のFlash(session)にしか" +
    "出ない。判断材料は response_excerpt / dtako_events_count / reset_note であって" +
    "http_status の2xx/3xx分類ではない (rust-ichibanboshi dtako_autoload.rs の" +
    "module doc 参照)。" +
    "**reset_timecard の既定は true (2026-08-04 変更)。** ②(取り込み)に続けて" +
    "③(勤務時間再登録)まで実行し、GCP側 (time_card_dtako 由来の fold 入力) にも" +
    "反映する。**②だけ (false) にすると GCP 側には永久に届かない** — これで半日" +
    "溶かした実害があったため既定を反転した。③は材料 (dtako_events の 休息/運行開始/" +
    "運行終了) が0件ならfail-closedでスキップされ (rust-ichibanboshi#283/#290)、" +
    "誤って time_card_dtako を消すことはない。②だけで止めたい場合は " +
    "reset_timecard: false を明示すること。" +
    "応答には entries (zip内のファイル名) と、オンプレ側の応答をそのまま含む " +
    "autoload (http_status/http_ok/location/response_excerpt/reset_*) が入る。" +
    "**★★ エラーに `uncertain: true` が含まれていたら、この tool を同じ引数で" +
    "再実行しないこと。** push (②) を送った後に応答を確定できなかった場合の印で、" +
    "取り込みは応答より前に走るため既に取り込み済みの可能性がある。盲目的な" +
    "再実行は二重取り込みになりうる — 再実行の前に対象の dtako_events / " +
    "time_card_dtako が既に更新されていないかを別経路で確認すること。" +
    `**unko_no: ${UNKO_NO_DESCRIPTION}** ` +
    `**複数運行をまとめる場合は \`items\` (最大 ${CRON_BATCH_MAX_ITEMS} 件、超過は relay が400) を使う。` +
    "items の各要素にも unko_no が必須。応答に results[]/success_count/failure_count/" +
    "truncated/remaining/theearth_logins が載る。",
  inputSchema: runDtakoReimportArgs,
  // **write tool。** read-only 一覧 (test/mcp/tools.test.ts の READ_ONLY) には
  // 入れない — 取り込みという破壊的操作を伴うため (受け入れ条件7)
  requiresScope: "mcp.write",
  execute: async (env: Env, args: z.infer<typeof runDtakoReimportArgs>) => {
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");
    const body = args.items
      ? {
          comp_id: args.comp_id,
          items: args.items.map((item) => ({
            ope_no: item.ope_no_22,
            start_ope: item.start_ope,
            unko_no: item.unko_no,
            reset_timecard: item.reset_timecard === true,
          })),
        }
      : {
          ope_no: args.ope_no_22,
          start_ope: args.start_ope,
          unko_no: args.unko_no,
          reset_timecard: args.reset_timecard === true,
          comp_id: args.comp_id,
        };
    const res = await relay.fetch("https://relay.internal/kintai-relay/dtako-reimport", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
      body: JSON.stringify(body),
    });
    const responseBody = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${responseBody.slice(0, 200)}`);
    try {
      return JSON.parse(responseBody) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${responseBody.slice(0, 200)}`);
    }
  },
};

// ── run_dtako_alc_upload ─────────────────────────────────────────────────────

const runDtakoAlcUploadItemArgs = z
  .object({
    ope_no_22: z.string().regex(OPE_NO_RE).describe("運行No。theearth 側の22桁。"),
    start_ope: z
      .string()
      .regex(START_OPE_RE)
      .describe('出庫日時。"YYYY/MM/DD H:mm:ss" (時は0埋めしない、例 "2026/07/07 7:53:30")'),
  })
  .strict();

const runDtakoAlcUploadArgs = z
  .object({
    ope_no_22: z
      .string()
      .regex(OPE_NO_RE)
      .optional()
      .describe(
        "運行No。theearth 側の22桁 (get_operation_zip の ope_no_22 と同じ)。" +
          "オンプレの unko_no (23桁) を持っている場合は末尾1桁を落として渡すこと。" +
          "**`items` を渡す場合は省略する** (単体形式専用のフィールド)。",
      ),
    start_ope: z
      .string()
      .regex(START_OPE_RE)
      .optional()
      .describe(
        '出庫日時。"YYYY/MM/DD H:mm:ss" (時は0埋めしない、例 "2026/07/07 7:53:30")。' +
          "**`items` を渡す場合は省略する**。",
      ),
    comp_id: z.string().optional().describe("会社。省略すると relay の既定 (KINTAI_COMP_ID)"),
    items: z
      .array(runDtakoAlcUploadItemArgs)
      .min(1)
      .max(CRON_BATCH_MAX_ITEMS)
      .optional()
      .describe(
        `複数運行をまとめて 1 回の呼び出しで alc へ上げ直す場合の配列 (**上限 ` +
          `${CRON_BATCH_MAX_ITEMS} 件、超過は relay が 400 で拒否する — 切り詰めない)。` +
          "unko_no は無い (alc-upload に unko_no は不要なので items にも無い)。" +
          "relay 側が直列に処理するので、**items を使えば「同一 comp_id を並列に叩かない」" +
          "を自分で気をつける必要が無くなる**。応答には results[]/success_count/" +
          "failure_count/truncated/remaining/theearth_logins が載る。",
      ),
  })
  .strict()
  .refine((v) => (v.items && v.items.length > 0) || (v.ope_no_22 && v.start_ope), {
    message: "ope_no_22 と start_ope の組、または items のどちらかが必要です",
  });

/**
 * 運行 1 件の csvdata.zip を theearth から取得し、そのまま alc へ上げ直す
 * (Refs #633-9、relay 側は #633-7 / PR #638 で完成済み)。
 *
 * **`run_dtako_reimport` との違いは宛先と body だけ。** あちらはオンプレの
 * `POST /api/dtako/autoload` (23桁の unko_no が要る、dtako_events を書く) を叩くが、
 * こちらは alc の `/api/upload` (`POST /kintai-relay/dtako-alc-upload`、relay の
 * `dtako-alc-upload.ts` 参照) を叩く。alc 側は zip 内 KUDGURI.csv の行から
 * `ope_no`/`start_ope` を読むため **`unko_no` は渡さない**。オンプレを触らないので
 * `reset_timecard` (③ 勤務時間再登録) に相当するものも無い。
 */
export const runDtakoAlcUploadTool = {
  name: "run_dtako_alc_upload",
  description:
    "運行 1 件の csvdata.zip を theearth から取得し、alc へ上げ直す " +
    "(Refs #633-9。relay の POST /kintai-relay/dtako-alc-upload を叩くだけ)。" +
    "**run_dtako_reimport との違い: unko_no は渡さない・reset_timecard も無い。** " +
    "alc の /api/upload は zip 内 KUDGURI.csv から ope_no/start_ope を読むため " +
    "オンプレの23桁 unko_no は不要。オンプレ (dtako_events / time_card_dtako) は" +
    "一切触らないので③(勤務時間再登録)に相当する引数も無い。" +
    "**書き込み tool。preview は無い** — 中身を先に確認したいなら同じ引数で " +
    "get_operation_zip (read-only) を先に呼ぶこと。" +
    "**応答の split_confirmed は常に false。** split_failed: 0 を『分割済み』と" +
    "読まないこと — try_split_csv はアップロード直後に non-blocking で走るため、" +
    "この応答の時点では確定しない。確定させたいなら時間を置いて upload_id で改めて" +
    "確認すること。" +
    "**has_kudgivt は DEFAULT FALSE に戻る。** split が成功するまで、この運行は" +
    "読み取り側 (/api/dtako/events・/etags・Y時間) から一時的に消える。" +
    "**同一 comp_id を並列に叩かないこと。** theearth のセッションは1社1本しか" +
    "持てず、並列で呼ぶと hang や 500 になりうる — 1件ずつ呼ぶこと " +
    `(または \`items\` で最大 ${CRON_BATCH_MAX_ITEMS} 件をまとめて渡すと relay が直列に処理する)。` +
    "**複数運行をまとめる場合は `items` を使う。unko_no は無い。★ items 形式でも zip_base64 は" +
    "元々含まれない (このtoolの応答にzip_base64は無い)。** 応答に results[]/success_count/" +
    "failure_count/truncated/remaining/theearth_logins が載る。",
  inputSchema: runDtakoAlcUploadArgs,
  // **write tool。** read-only 一覧 (test/mcp/tools.test.ts の READ_ONLY) には
  // 入れない — alc への書き込み (upsert) を伴うため
  requiresScope: "mcp.write",
  execute: async (env: Env, args: z.infer<typeof runDtakoAlcUploadArgs>) => {
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");
    const body = args.items
      ? {
          comp_id: args.comp_id,
          items: args.items.map((item) => ({ ope_no: item.ope_no_22, start_ope: item.start_ope })),
        }
      : { ope_no: args.ope_no_22, start_ope: args.start_ope, comp_id: args.comp_id };
    const res = await relay.fetch("https://relay.internal/kintai-relay/dtako-alc-upload", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
      body: JSON.stringify(body),
    });
    const responseBody = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${responseBody.slice(0, 200)}`);
    try {
      return JSON.parse(responseBody) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${responseBody.slice(0, 200)}`);
    }
  },
};

// ── run_kintai_recalc ────────────────────────────────────────────────────────

const runKintaiRecalcArgs = z.object({
  month: z
    .string()
    .optional()
    .describe("対象月 (YYYY-MM)。省略すると JST の当月"),
  after_driver_cd: z
    .number()
    .int()
    .optional()
    .describe("続きから回す位置。前回の応答の next_after_driver_cd をそのまま渡す"),
  max_drivers: z
    .number()
    .int()
    .optional()
    .describe(
      "1 ページで畳む乗務員数。既定 100、上限 150。" +
        "**月ゲートに指紋を書かせたい (= 次回以降のゼロ読みを成立させたい) 場合は、" +
        "母集団を 1 ページに収める値**を指定すること — gate を書く条件に" +
        "「1 ページで回りきる」が含まれるため。" +
        "逆に **logic_version 変更直後の全量 apply は 50 程度に落とす**こと " +
        "(etags 約 25 秒 + 全量読み + 全員ぶんの書き込みが Cloudflare の 100 秒上限を" +
        "超えて 524 になる実測がある)。",
    ),
  stale_only: z
    .boolean()
    .optional()
    .describe("現行の logic_version を 1 つも持たない乗務員だけに絞る (既定 false)"),
  apply: z
    .boolean()
    .optional()
    .describe("**true で初めて GCP に書く**。省略時は変わる件数を数えるだけ (preview)"),
});

/**
 * 全量再計算を GCP 側で 1 ページぶん進める (Refs ohishi-exp/rust-ichibanboshi#205 の 10)。
 *
 * `run_kintai_relay` が拾うのは**窓で打刻が変わった乗務員だけ**。`kosoku.rs` の
 * deploy や TOML の閾値・丸め方を変えると全乗務員が一斉に stale になり、そちらでは
 * 拾えない — この tool が受け持つ。**続きがある** — `next_after_driver_cd` を
 * `after_driver_cd` に渡して呼び直すとページングできる。
 *
 * **ロジックはここに無い。** relay の `POST /kintai-relay/recalc` を service
 * binding 越しに叩くだけで、`apply` の有無で受け側 (rust-ichibanboshi) への
 * `GET`/`POST` を relay が選ぶ。ここは MCP の認証付き入口を出すだけ。
 */
export const runKintaiRecalcTool = {
  name: "run_kintai_recalc",
  description:
    "全量再計算を 1 ページぶん進める (Refs ohishi-exp/rust-ichibanboshi#205 の 10)。" +
    "`run_kintai_relay` が拾わない stale (kosoku.rs の deploy / TOML 変更由来) を畳み直す。" +
    "**apply を付けない限り 1 行も書かない** — 変わる件数だけ返る (既定)。" +
    "1 ページで終わらなければ応答の next_after_driver_cd が入る。" +
    "**続きがあるので、それを after_driver_cd に渡して回りきるまで呼び直す** " +
    "(`null` なら回りきっている)。応答の fold / stale は受け側の形をそのまま返す。",
  inputSchema: runKintaiRecalcArgs,
  // **write tool。** apply: true で本番 Supabase に書きうるので read tool と同じ扱いにしない
  requiresScope: "mcp.write",
  execute: async (env: Env, args: z.infer<typeof runKintaiRecalcArgs>) => {
    if (args.month !== undefined && !parseYm(args.month)) {
      throw new Error("month は YYYY-MM で指定してください");
    }
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");

    const res = await relay.fetch("https://relay.internal/kintai-relay/recalc", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
      body: JSON.stringify({
        month: args.month,
        after_driver_cd: args.after_driver_cd,
        max_drivers: args.max_drivers,
        stale_only: args.stale_only,
        apply: args.apply === true,
      }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${body.slice(0, 200)}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${body.slice(0, 200)}`);
    }
  },
};

// ── run_kintai_restraint_sync ───────────────────────────────────────────────

const runKintaiRestraintSyncArgs = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/).describe("同期する年月 (YYYY-MM)。省略値は無い"),
    comp_id: z.string().optional().describe("会社。省略すると relay の既定 (KINTAI_COMP_ID)"),
  })
  .strict();

/**
 * 拘束サマリの写し (R2 `kintai/` prefix) を無人で押し直す
 * (Refs #606-6)。画面の「取り込み」ボタン (`POST /restraint-api/kintai/fetch`)
 * だけがこの写しを更新でき、無人経路が無かったため化石化していた
 * (実測 2026-08-03: 全月 2026-07-27 の push のまま)。
 *
 * **運ぶロジックはここに無い。** relay の `POST /kintai-relay/restraint-sync`
 * (Refs #606-6) を叩くだけ — `run_kintai_relay` / `run_dtako_reimport` と同じ
 * `X-Alc-Proxy-Secret` 方式。**`/restraint-api/*` は叩かない** — あちらは
 * auth-worker JWT (viewer 経路) 前提の名前空間で、機械呼び出し用の共有シークレット
 * バイパスを持たせない設計判断のため (Refs #606-6 親子間の合意)。
 */
export const runKintaiRestraintSyncTool = {
  name: "run_kintai_restraint_sync",
  description:
    "拘束サマリの写し (R2 `kintai/` prefix、拘束×賃金画面が読む) を指定した年月ぶん押し直す " +
    "(Refs #606-6)。画面の「取り込み」ボタンと同じ処理を無人で叩けるようにしたもの — " +
    "この口が無いと写しは二度と更新されず化石化する (実例: 2026-08-03 時点で全月" +
    "2026-07-27 の push のまま止まっていた)。" +
    "**month は必須、省略値は無い** — 呼び出し側 (cron 等) が前月・当月をそれぞれ明示して呼ぶ想定。" +
    "**`/restraint-api/*` ではなく `/kintai-relay/*` (機械用の名前空間、既存の " +
    "run_kintai_relay と同じ X-Alc-Proxy-Secret 方式) を叩く。**",
  inputSchema: runKintaiRestraintSyncArgs,
  // **write tool。** 拘束サマリの R2 アーカイブを書き換えうるので read tool と同じ扱いにしない
  requiresScope: "mcp.write",
  execute: async (env: Env, args: z.infer<typeof runKintaiRestraintSyncArgs>) => {
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");

    const res = await relay.fetch("https://relay.internal/kintai-relay/restraint-sync", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
      body: JSON.stringify({ month: args.month, comp_id: args.comp_id }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${body.slice(0, 200)}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${body.slice(0, 200)}`);
    }
  },
};

// ── get_kintai_day_summaries ─────────────────────────────────────────────────

const getKintaiDaySummariesArgs = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .describe("対象年月 (YYYY-MM)"),
  driver: z
    .string()
    .regex(/^\d{1,10}$/)
    .optional()
    .describe("乗務員CD (数字)。省略すると全乗務員"),
});

/**
 * GCP 側で畳んだ日別サマリ (`kintai.day_summaries`) を読む
 * (Refs ohishi-exp/rust-ichibanboshi#205 の 23)。
 *
 * **読むだけの tool。** 受け側 (`src/routes/kintai_day_summaries.rs`) に `POST` が
 * 無く、`run_kintai_recalc` の `apply` に当たる引数もここには無い — 引数は
 * `month` と `driver` の 2 つだけで、この tool からは 1 行も書けない。
 *
 * `requiresScope` を持たないのは既存の read tool (`get_kosoku_events` /
 * `get_restraint_summary` 等) と揃えたため — この repo の read tool は
 * `requiresScope` を持たず、`mcp.write` は書ける tool
 * (`run_kintai_relay` / `run_kintai_recalc`) だけが要求する
 * (`src/mcp/scope.ts`: `requiresScope` 無しは常に許可)。書けないこの tool に
 * `mcp.write` と同じ強さを求めない。
 *
 * 応答は**そのまま返す**。用途はオンプレ基準 JSON (`get_timecard_diff` が使う側) との
 * **行単位**の突合で、受け側がキー (`乗務員CD|暦日|開始時刻`) も列名も基準ファイルに
 * 合わせてある。ここで件数の要約や整形を挟むと、突合スクリプトがそのまま比較できない。
 */
export const getKintaiDaySummariesTool = {
  name: "get_kintai_day_summaries",
  description:
    "GCP 側で畳んだ日別サマリ (kintai.day_summaries) を月ぶん返す " +
    "(Refs ohishi-exp/rust-ichibanboshi#205 の 23)。" +
    "**読むだけ — 1 行も書かない。** " +
    "キーは `乗務員CD|暦日|開始時刻`、値は shift_source と拘束/実働/休憩/深夜などの**分数**。" +
    "オンプレ基準 (get_kosoku_events / 拘束時間管理表) との突合を総数ではなく" +
    "**行・分単位**でやるための口で、応答は受け側の形をそのまま返す (整形も要約もしない)。" +
    "データが 0 件の月は 404 ではなく rows: 0 と空の summaries が返る。",
  inputSchema: getKintaiDaySummariesArgs,
  execute: async (env: Env, args: z.infer<typeof getKintaiDaySummariesArgs>) => {
    if (!parseYm(args.month)) throw new Error("month は YYYY-MM で指定してください");
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");

    const q = new URLSearchParams({ month: args.month });
    if (args.driver) q.set("driver", args.driver);
    const res = await relay.fetch(`https://relay.internal/kintai-relay/day-summaries?${q}`, {
      headers: { "X-Alc-Proxy-Secret": secret },
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`relay: status ${res.status}: ${body.slice(0, 200)}`);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error(`relay: parse failed: ${body.slice(0, 200)}`);
    }
  },
};

// ── get_kintai_diff ─────────────────────────────────────────────────────────

/**
 * オンプレ (`kosoku-daily`) と GCP (`day_summaries`) の共通 11 分数列。
 *
 * 列名はもともと両受け口で一致している (`kintai_day_summaries.rs` のモジュール docs)。
 * オンプレ側だけ `source`、GCP 側だけ `shift_source` と呼ぶので、そこだけ読み替える。
 */
const KINTAI_DIFF_MINUTE_FIELDS = [
  "restraint_minutes",
  "working_minutes",
  "break_minutes",
  "rest_minus_minutes",
  "statutory_minutes",
  "within_statutory_overtime_minutes",
  "overtime_minutes",
  "legal_holiday_minutes",
  "night_minutes",
  "overtime_night_minutes",
  "legal_holiday_night_minutes",
] as const;

type KintaiDiffMinuteField = (typeof KINTAI_DIFF_MINUTE_FIELDS)[number];

/** 突合 1 行の値 (両側とも同じ形に揃えて持つ)。 */
type KintaiDiffValue = { shift_source: unknown } & Record<KintaiDiffMinuteField, number>;

function toNumberOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** GCP `day_summaries` の `{summaries: {key: {...}}}` を突合用の Map にする。 */
function gcpSummariesToMap(body: unknown): Map<string, KintaiDiffValue> {
  const out = new Map<string, KintaiDiffValue>();
  const summaries = (body as { summaries?: unknown }).summaries;
  if (!summaries || typeof summaries !== "object") return out;
  for (const [key, raw] of Object.entries(summaries as Record<string, unknown>)) {
    const r = raw as Record<string, unknown>;
    const value = { shift_source: r.shift_source } as KintaiDiffValue;
    for (const f of KINTAI_DIFF_MINUTE_FIELDS) value[f] = toNumberOr0(r[f]);
    out.set(key, value);
  }
  return out;
}

/** `onpremKosokuDailyToMap` の結果。読めたかどうかを Map の中身から切り離して持つ
 *  (空 Map だけでは「本当に 0 行」と「形が読めなかった」の区別が付かないため)。 */
interface OnpremParseResult {
  map: Map<string, KintaiDiffValue>;
  /** `drivers` 配列 (省略形) にも `days` 配列 (driver 指定形) にも当てはまらなかった。 */
  unreadable: boolean;
}

/** `days` 配列 1 人ぶんを `driver` 引きのキーで Map に足す (両形式で共有)。
 *
 * **`punches` / `parts` はここで捨てる** — 全乗務員月ぶんで punches/parts まで持ち回すと
 * Worker の CPU/メモリを無駄に食う。突合に要るのは 11 分数 + `source` + キー 3 つだけ。 */
function addOnpremDriverDays(out: Map<string, KintaiDiffValue>, driver: unknown, days: unknown[]): void {
  for (const day of days) {
    const r = day as Record<string, unknown>;
    const date = r.date;
    const start = r.start;
    if (typeof date !== "string" || typeof start !== "string") continue;
    const key = `${driver}|${date}|${start}`;
    const value = { shift_source: r.source } as KintaiDiffValue;
    for (const f of KINTAI_DIFF_MINUTE_FIELDS) value[f] = toNumberOr0(r[f]);
    out.set(key, value);
  }
}

/**
 * オンプレ `kosoku-daily` を突合用の Map にする。**応答の形が `driver` クエリの
 * 有無で変わる** (Refs ohishi-exp/nuxt-dtako-admin#599):
 *
 * - `driver` 省略 = `{drivers: [{driver, days: [...]}]}` (全乗務員)
 * - `driver` 指定 = `{driver, days: [...]}` (`drivers` が無い。単一乗務員をトップレベルに展開)
 *
 * 単一乗務員形の乗務員CD は**応答の `driver` を優先し、無ければ呼び出しに渡した
 * `requestedDriver` (MCP tool の引数) へ落とす** — 上流はほぼ必ず `driver` を
 * エコーするが、必須の保証が無いため。
 *
 * **どちらの形にも当てはまらなければ空 Map ではなく `unreadable: true` を返す。**
 * 空 Map のまま返すと「オンプレにその乗務員の行が無い」と「応答の形を読み間違えた」が
 * 呼び出し側から区別できず、両側に在る行まで `only_gcp` に化ける (#599)。
 */
function onpremKosokuDailyToMap(body: unknown, requestedDriver: string | undefined): OnpremParseResult {
  const out = new Map<string, KintaiDiffValue>();
  const b = body as { drivers?: unknown; driver?: unknown; days?: unknown };
  if (Array.isArray(b.drivers)) {
    for (const d of b.drivers) {
      const driver = (d as { driver?: unknown }).driver;
      const days = (d as { days?: unknown }).days;
      if (!Array.isArray(days)) continue;
      addOnpremDriverDays(out, driver, days);
    }
    return { map: out, unreadable: false };
  }
  if (Array.isArray(b.days)) {
    const driver = b.driver ?? requestedDriver;
    addOnpremDriverDays(out, driver, b.days);
    return { map: out, unreadable: false };
  }
  return { map: out, unreadable: true };
}

/** `driver|date|start` キーから乗務員CD (先頭要素) を取り出す。 */
function driverOfKey(key: string): string {
  return key.slice(0, key.indexOf("|"));
}

/** キーは常に `gcpSummariesToMap` / `onpremKosokuDailyToMap` が組んだ 3 要素なので、
 *  分解結果が欠けることはない。 */
function keyToRow(key: string): { driver_cd: string; date: string; start: string } {
  const [driver_cd, date, ...rest] = key.split("|");
  return { driver_cd: driver_cd as string, date: date as string, start: rest.join("|") };
}

/** カテゴリごとの上限。500 は `get_rest_diff` と同じ既定に揃えた。 */
const KINTAI_DIFF_MAX_ITEMS = 500;

/** 1 カテゴリぶんを `max_items` で切り、`total`/`capped` を添えて返す。黙って切らない。 */
function capCategory<T>(items: T[]): { total: number; capped: boolean; items: T[] } {
  return {
    total: items.length,
    capped: items.length > KINTAI_DIFF_MAX_ITEMS,
    items: items.slice(0, KINTAI_DIFF_MAX_ITEMS),
  };
}

const getKintaiDiffArgs = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/).describe("対象年月 (YYYY-MM)"),
    driver: z
      .string()
      .regex(/^\d{1,10}$/)
      .optional()
      .describe("乗務員CD (数字)。省略すると全乗務員"),
  })
  .strict();

export const getKintaiDiffTool = {
  name: "get_kintai_diff",
  description:
    "オンプレ (rust-ichibanboshi の `/api/kintai/kosoku-daily`) と GCP " +
    "(`kintai.day_summaries`、`get_kintai_day_summaries` と同じ値) の日別サマリを " +
    "`乗務員CD|暦日|開始時刻` キーで突き合わせ、**ずれている行だけを名指しで返す**。" +
    "**GET 2 本を叩いて突き合わせるだけ** — 1 バイトも書かない。" +
    "ずれは 4 つに分ける: only_gcp (GCPにしか無い) / " +
    "only_onprem_driver0 (オンプレにしか無く乗務員CD=0。GCPが意図的に除外しているので" +
    "「欠け」ではない) / only_onprem_other (オンプレにしか無く乗務員CD≠0。こちらが本当の欠け) / " +
    "value_diff_restraint_match (値が違うが restraint_minutes は一致) / " +
    "value_diff_restraint_mismatch (restraint_minutes も違う)。" +
    "各カテゴリ items は " +
    String(KINTAI_DIFF_MAX_ITEMS) +
    " 件で切るが、total は切る前の総数 (capped で切れたかが分かる)。" +
    "**どちら側が古いかは判定しない** — 休憩/休息の伸び縮みは双方向に起きるため、" +
    "件数や長さだけで古い側を決めると外れる (実例あり)。古い側の特定は取り直しの結果で判断すること。" +
    "**GCP が畳み直し待ち (stale) のときは、ここに出る差が入力のずれではなく単なる未反映のこともある** — " +
    "stale かどうかは `run_kintai_recalc` を `apply` 省略で叩いて別途確認すること " +
    "(この tool 自身は version の一致/不一致を主張しない)。" +
    "**オンプレ応答は driver 指定の有無で形が変わる** (省略時 `{drivers:[...]}` / 指定時 " +
    "`{driver, days:[...]}` で `drivers` が無い) — 両方読む。`onprem_unreadable` が true なら " +
    "どちらの形にも当てはまらず読めなかったということで、onprem_rows: 0 は " +
    "「本当に 0 行」ではないので only_gcp を「GCP にしか無い」と解釈しないこと。",
  inputSchema: getKintaiDiffArgs,
  execute: async (env: Env, args: z.infer<typeof getKintaiDiffArgs>) => {
    if (!parseYm(args.month)) throw new Error("month は YYYY-MM で指定してください");

    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");

    const gcpQuery = new URLSearchParams({ month: args.month });
    if (args.driver) gcpQuery.set("driver", args.driver);
    const onpremQuery =
      `/api/kintai/kosoku-daily?month=${encodeURIComponent(args.month)}` +
      (args.driver ? `&driver=${encodeURIComponent(args.driver)}` : "");

    const [gcpRes, onpremBody] = await Promise.all([
      relay.fetch(`https://relay.internal/kintai-relay/day-summaries?${gcpQuery}`, {
        headers: { "X-Alc-Proxy-Secret": secret },
      }),
      fetchIchibanJson(env, onpremQuery, "kintai_diff"),
    ]);
    const gcpText = await gcpRes.text();
    if (!gcpRes.ok) throw new Error(`relay: status ${gcpRes.status}: ${gcpText.slice(0, 200)}`);
    let gcpBody: unknown;
    try {
      gcpBody = JSON.parse(gcpText);
    } catch {
      throw new Error(`relay: parse failed: ${gcpText.slice(0, 200)}`);
    }

    const gcp = gcpSummariesToMap(gcpBody);
    const onpremParsed = onpremKosokuDailyToMap(onpremBody, args.driver);
    const onprem = onpremParsed.map;

    const onlyGcp: Array<{ driver_cd: string; date: string; start: string; gcp: KintaiDiffValue }> = [];
    const onlyOnpremDriver0: Array<{
      driver_cd: string;
      date: string;
      start: string;
      onprem: KintaiDiffValue;
    }> = [];
    const onlyOnpremOther: Array<{
      driver_cd: string;
      date: string;
      start: string;
      onprem: KintaiDiffValue;
    }> = [];
    const restraintMatch: Array<{
      driver_cd: string;
      date: string;
      start: string;
      diff_fields: KintaiDiffMinuteField[];
      gcp: KintaiDiffValue;
      onprem: KintaiDiffValue;
    }> = [];
    const restraintMismatch: typeof restraintMatch = [];

    for (const [key, g] of gcp) {
      const o = onprem.get(key);
      const row = keyToRow(key);
      if (!o) {
        onlyGcp.push({ ...row, gcp: g });
        continue;
      }
      const diffFields = KINTAI_DIFF_MINUTE_FIELDS.filter((f) => g[f] !== o[f]);
      if (diffFields.length === 0) continue;
      const bucket = g.restraint_minutes === o.restraint_minutes ? restraintMatch : restraintMismatch;
      bucket.push({ ...row, diff_fields: diffFields, gcp: g, onprem: o });
    }
    for (const [key, o] of onprem) {
      if (gcp.has(key)) continue;
      const row = keyToRow(key);
      (driverOfKey(key) === "0" ? onlyOnpremDriver0 : onlyOnpremOther).push({ ...row, onprem: o });
    }

    return {
      month: args.month,
      driver: args.driver ?? null,
      gcp_rows: gcp.size,
      onprem_rows: onprem.size,
      onprem_unreadable: onpremParsed.unreadable,
      only_gcp: capCategory(onlyGcp),
      only_onprem_driver0: capCategory(onlyOnpremDriver0),
      only_onprem_other: capCategory(onlyOnpremOther),
      value_diff_restraint_match: capCategory(restraintMatch),
      value_diff_restraint_mismatch: capCategory(restraintMismatch),
      note:
        "どちら側が古いかはこの tool では判定しない。GCP が stale (畳み直し待ち) の場合、" +
        "ここに出る差が未反映なだけのことがある — run_kintai_recalc を apply 省略で叩いて確認すること。" +
        (onpremParsed.unreadable
          ? " **onprem_unreadable: true — オンプレ応答の形が読めなかった** " +
            "(drivers 配列も driver 指定形の days 配列も無かった)。onprem_rows: 0 は " +
            "「本当に 0 行」ではなく「読めなかった」なので、この結果の only_gcp を " +
            "「GCP にしか無い」と解釈しないこと。"
          : ""),
    };
  },
} satisfies ToolEntry<typeof getKintaiDiffArgs>;

// ===== get_ichiban_costs / get_ichiban_sales =================================
//
// 一番星 (rust-ichibanboshi) の **経費明細 / 売上明細** を読む 2 本 (Refs #760)。
// 粗利タブ (`app/utils/margin.ts`) が画面で組み立てている材料を、集計される前の
// **生の行**として出すのが目的 — 「この車輌の直課経費が多いのは何の区分か」を
// 画面のフィルタに縛られずに数えるため。
//
// **行は pass-through で返す。** ここでフィールドを選ぶと、上流が足した列
// (`remarks` / `vendor_name` / `entered_date` 等) が静かに落ちる。tool が足すのは
// 集計 (`summary`) だけで、行そのものは上流の形を変えない。

/** 日付 (YYYY-MM-DD)。暦としての妥当性は上流に任せる (既存 tool と同じ扱い)。 */
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 車輌C / 乗務員CD (数字)。車番は実務上 4 桁だが桁を決め打ちしない
 *  (`COMP_ID_PATTERN` と同じ判断 — 上流は完全一致で引くだけ)。 */
const ICHIBAN_CODE_RE = /^\d{1,10}$/;

/** 上流が `limit` 未指定のときに返す最大件数 (rust-ichibanboshi の default 500)。
 *  ここに達したら**黙って切られている**ので `summary.truncated` で表に出す。 */
const ICHIBAN_DEFAULT_LIMIT = 500;

/** `row[key]` を安全に読む (上流の行は pass-through なので型を仮定しない)。 */
function fieldOf(row: unknown, key: string): unknown {
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)[key]
    : undefined;
}
/** 数値フィールド。欠け・型違いは 0 に倒す (集計が NaN で全滅するのを避ける)。 */
function numField(row: unknown, key: string): number {
  const v = fieldOf(row, key);
  return typeof v === "number" ? v : 0;
}
/** 文字列フィールド。欠け・型違いは空文字 (集計キーとして使うため null を混ぜない)。 */
function strField(row: unknown, key: string): string {
  const v = fieldOf(row, key);
  return typeof v === "string" ? v : "";
}
/** 上流応答 `{ source_table, data: Row[] }` の `data`。形が違えば空配列。 */
function ichibanRows(parsed: unknown): unknown[] {
  const data = fieldOf(parsed, "data");
  return Array.isArray(data) ? data : [];
}
/** 上流の default limit に達している = 切られている疑い。 */
function truncatedAt(rows: unknown[]): boolean {
  return rows.length >= ICHIBAN_DEFAULT_LIMIT;
}
/** Map の値をキー昇順で配列にする (応答を決定的にするため)。 */
function sortedByKey<T>(map: Map<string, T>): T[] {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}
/** `from`/`to` に、値のある絞り込みだけを足したクエリ文字列を組む。 */
function ichibanRangeQuery(
  path: string,
  from: string,
  to: string,
  filters: Record<string, string | undefined>,
): string {
  const qs = new URLSearchParams({ from, to });
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) qs.set(key, value);
  }
  return `${path}?${qs.toString()}`;
}
/** 期間だけの全社スキャンを拒む (上流にとって重く、読む側も使い道が無い)。 */
function requireVehicleOrDriver(args: { vehicle?: string; driver?: string }): void {
  if (!args.vehicle && !args.driver) {
    throw new Error(
      "vehicle (車輌C) か driver (乗務員CD) のどちらかは必須です " +
        "— 期間だけの全社ぶんは重いので受け付けません",
    );
  }
}

const getIchibanCostsArgs = z
  .object({
    from: z.string().regex(YMD_RE).describe("運行年月日の下限 (YYYY-MM-DD、**含む**)"),
    to: z
      .string()
      .regex(YMD_RE)
      .describe("運行年月日の上限 (YYYY-MM-DD、**含まない** — 半開区間。月なら翌月1日)"),
    vehicle: z
      .string()
      .regex(ICHIBAN_CODE_RE)
      .optional()
      .describe("車輌C (車番。実務上 4 桁)。driver とどちらか必須"),
    driver: z
      .string()
      .regex(ICHIBAN_CODE_RE)
      .optional()
      .describe("乗務員CD。vehicle とどちらか必須"),
    kind: z
      .string()
      .regex(/^\d{2}$/)
      .optional()
      .describe("経費種別C (2桁。燃料 01 / 通行料 04 等)。省略すると全区分"),
  })
  .strict();

export const getIchibanCostsTool = {
  name: "get_ichiban_costs",
  description:
    "一番星 (販売管理) の**経費明細**を、期間 × 車輌 or 乗務員で**行のまま**返す (Refs #760)。" +
    "粗利タブ (/margin) が経費として引いているのと同じ口 (`GET /api/costs/vehicle-daily`) なので、" +
    "「直課経費が多いのはどの区分・どの日か」を画面のフィルタ抜きで数えられる。" +
    "**行 (`rows`) は上流の pass-through** — 列が増えたらそのまま増える。tool が足すのは `summary` だけ。" +
    "**`amount` は税抜金額**、**`diesel_tax` (軽油引取税) は `amount` に含まれない別立て**で、" +
    "実額は `amount + diesel_tax` (粗利タブの `costYen` と同じ。燃料以外はふつう 0)。" +
    "`summary` は `amount` と `diesel_tax` を**別々に**合計するので、突合するときは足してから比べること。" +
    "**`is_fixed` は `固定経費K == \"1\"`** (保険料・リース等の月極め) — 運行に紐づかないため、" +
    "粗利タブはこれを走行距離の比で按分している (運行単位に素直に足すと 1 運行だけが赤くなる)。" +
    "**粗利タブは `01 燃料ｵｲﾙ代` / `08 給与(人件費)` / `11 賞与・調整金` / `15 アドブルー` を粗利の経費から除いている** " +
    "(燃料系は走行距離から出し、人件費は運行手当と二重になるため)。画面の粗利と突き合わせるなら " +
    "`summary.by_kind` からこの 4 区分を引くこと。" +
    "`vehicle` / `driver` は**どちらか必須** (期間だけの全社スキャンは拒否)。`to` は**含まない**半開区間。" +
    "上流は limit 未指定で **500 件**で切るので、`summary.truncated` が true なら期間を割って引き直すこと。",
  inputSchema: getIchibanCostsArgs,
  execute: async (env: Env, args) => {
    requireVehicleOrDriver(args);
    const parsed = await fetchIchibanJson(
      env,
      ichibanRangeQuery("/api/costs/vehicle-daily", args.from, args.to, {
        vehicle: args.vehicle,
        driver: args.driver,
        kind: args.kind,
      }),
      "ichiban_costs",
    );
    const rows = ichibanRows(parsed);

    interface KindAgg {
      cost_kind: string;
      cost_kind_name: string;
      amount: number;
      diesel_tax: number;
      rows: number;
    }
    interface DateAgg {
      date: string;
      amount: number;
      diesel_tax: number;
      rows: number;
    }
    const byKind = new Map<string, KindAgg>();
    const byDate = new Map<string, DateAgg>();
    let totalAmount = 0;
    let totalDieselTax = 0;
    let fixedAmount = 0;

    for (const row of rows) {
      const amount = numField(row, "amount");
      const dieselTax = numField(row, "diesel_tax");
      totalAmount += amount;
      totalDieselTax += dieselTax;
      // `is_fixed` は上流が bool 化済み。真偽が読めない行は変動費側に倒す。
      if (fieldOf(row, "is_fixed") === true) fixedAmount += amount;

      const kind = strField(row, "cost_kind");
      const kindAgg = byKind.get(kind) ?? {
        cost_kind: kind,
        cost_kind_name: strField(row, "cost_kind_name"),
        amount: 0,
        diesel_tax: 0,
        rows: 0,
      };
      kindAgg.amount += amount;
      kindAgg.diesel_tax += dieselTax;
      kindAgg.rows += 1;
      byKind.set(kind, kindAgg);

      const date = strField(row, "operation_date");
      const dateAgg = byDate.get(date) ?? { date, amount: 0, diesel_tax: 0, rows: 0 };
      dateAgg.amount += amount;
      dateAgg.diesel_tax += dieselTax;
      dateAgg.rows += 1;
      byDate.set(date, dateAgg);
    }

    return {
      source_table: fieldOf(parsed, "source_table") ?? null,
      from: args.from,
      to: args.to,
      vehicle: args.vehicle ?? null,
      driver: args.driver ?? null,
      kind: args.kind ?? null,
      rows,
      summary: {
        rows: rows.length,
        total_amount: totalAmount,
        total_diesel_tax: totalDieselTax,
        fixed_amount: fixedAmount,
        by_kind: sortedByKey(byKind),
        by_date: sortedByKey(byDate),
        truncated: truncatedAt(rows),
      },
    };
  },
} satisfies ToolEntry<typeof getIchibanCostsArgs>;

const getIchibanSalesArgs = z
  .object({
    from: z.string().regex(YMD_RE).describe("売上年月日の下限 (YYYY-MM-DD、**含む**)"),
    to: z
      .string()
      .regex(YMD_RE)
      .describe("売上年月日の上限 (YYYY-MM-DD、**含まない** — 半開区間)"),
    vehicle: z
      .string()
      .regex(ICHIBAN_CODE_RE)
      .optional()
      .describe("車輌C (車番)。driver とどちらか必須"),
    driver: z
      .string()
      .regex(ICHIBAN_CODE_RE)
      .optional()
      .describe("乗務員CD。vehicle とどちらか必須"),
  })
  .strict();

export const getIchibanSalesTool = {
  name: "get_ichiban_sales",
  description:
    "一番星 (販売管理) の**売上明細**を、期間 × 車輌 or 乗務員で**行のまま**返す (Refs #760)。" +
    "粗利タブ (/margin) が売上として引いているのと同じ口 (`GET /api/sales/vehicle-daily`)。" +
    "**行 (`rows`) は上流の pass-through**、tool が足すのは `summary` だけ。" +
    "**`driver` (乗務員CD) で引くと、その乗務員が別の車番で走った日の売上も入る。" +
    "`vehicle` (車番) で引くと、その日の明細がまるごと落ちる**" +
    " — デジタコを積んでいない車輌等に売上が載ることがあるため (粗利タブと同じ注意、Refs #741)。" +
    "`amount` は税抜で、自車/傭車のどちらを使うかは上流が `is_subcontracted` で選択済み。" +
    "**`request_kind` (請求K)** は `\"0\"` 通常運送 / `\"1\"` 請求のみ (運送を伴わない請求行) / " +
    "`\"2\"` 非請求 (車輌収支用の按分行)。**`\"1\"` と `\"2\"` は同じ荷の表裏になりうるので、" +
    "車輌ごとの収支に両方足すと二重計上になる** (走っていないのは `\"1\"` の方)。" +
    "`vehicle` / `driver` は**どちらか必須**。`to` は**含まない**半開区間。" +
    "上流は limit 未指定で **500 件**で切るので、`summary.truncated` が true なら期間を割って引き直すこと。",
  inputSchema: getIchibanSalesArgs,
  execute: async (env: Env, args) => {
    requireVehicleOrDriver(args);
    const parsed = await fetchIchibanJson(
      env,
      ichibanRangeQuery("/api/sales/vehicle-daily", args.from, args.to, {
        vehicle: args.vehicle,
        driver: args.driver,
      }),
      "ichiban_sales",
    );
    const rows = ichibanRows(parsed);

    const byDate = new Map<string, { date: string; amount: number; rows: number }>();
    const byRequestKind = new Map<string, { request_kind: string; amount: number; rows: number }>();
    let totalAmount = 0;

    for (const row of rows) {
      const amount = numField(row, "amount");
      totalAmount += amount;

      const date = strField(row, "sale_date");
      const dateAgg = byDate.get(date) ?? { date, amount: 0, rows: 0 };
      dateAgg.amount += amount;
      dateAgg.rows += 1;
      byDate.set(date, dateAgg);

      // 上流が `request_kind` を持たない (列が消えた/古い) ときは by_request_kind ごと出さない
      // — 空の区分に全額が寄って「全部が通常運送」に見えるのを避ける。
      const requestKind = strField(row, "request_kind");
      if (requestKind !== "") {
        const kindAgg = byRequestKind.get(requestKind) ?? {
          request_kind: requestKind,
          amount: 0,
          rows: 0,
        };
        kindAgg.amount += amount;
        kindAgg.rows += 1;
        byRequestKind.set(requestKind, kindAgg);
      }
    }

    return {
      source_table: fieldOf(parsed, "source_table") ?? null,
      from: args.from,
      to: args.to,
      vehicle: args.vehicle ?? null,
      driver: args.driver ?? null,
      rows,
      summary: {
        rows: rows.length,
        total_amount: totalAmount,
        by_date: sortedByKey(byDate),
        ...(byRequestKind.size > 0 ? { by_request_kind: sortedByKey(byRequestKind) } : {}),
        truncated: truncatedAt(rows),
      },
    };
  },
} satisfies ToolEntry<typeof getIchibanSalesArgs>;

// ===== get_kushiro_branch_estimate ===========================================

/**
 * 帯広の乗務員 5 名 (オーナー 2026-08-23 の比較基準)。**この試算そのものには使わず**、
 * 一番星の売上と突き合わせて「対象便がその乗務員たちの期間売上のどれくらいか」を
 * 出すためだけに使う。
 */
const OBIHIRO_DRIVER_CDS: readonly string[] = ["1412", "1587", "1656", "1732", "1742"];

/** 対象運行の上限。**超えたら期間を割って呼び直す** — 黙って切り詰めない。 */
const KUSHIRO_ESTIMATE_MAX_OPERATIONS = 500;

/** 一番星の経費区分 `08 給与(人件費)`。粗利タブが粗利の経費から外している区分
 *  (運行手当と二重になるため) で、**人件費の実績はここにある**。 */
const ICHIBAN_LABOR_COST_KIND = "08";

/**
 * 所属がマスタに無いときに最低賃金を引く都道府県の既定 = **北海道**。
 *
 * **釧路営業所は実在しない**ので、社員マスタ由来の `branchToPrefecture` には
 * 未来永劫載らない。最低賃金は**就業地の県**で決まるので、県が分かれば額は引ける —
 * 帯広も釧路もどちらも北海道なので、会社の所在都道府県をそのまま既定にする。
 * **額 (円) は定数にしない**方針はそのまま — ここで決めているのは県の名前だけで、
 * 額は R2 の min-wage マスタ (厚労省の一覧の取り込み結果) から引く。
 * 引数 `prefecture` で上書きできる。
 */
const DEFAULT_MIN_WAGE_PREFECTURE = "北海道";

const latLngArgs = z.object({ lat: z.number(), lng: z.number() }).strict();

const kushiroLegArgs = z
  .object({
    seq: z.number().int().describe("便の順番 (1 始まり)"),
    originCity: z.string().describe("積地。**住所そのまま可** (`北海道釧路市西港1-98-41`)"),
    destCity: z.string().describe("卸地。**住所そのまま可** (`北海道川上郡標茶町多和`)"),
    salesYen: z.number(),
    allowanceYen: z.number().describe("運行手当 (便あたり定額)"),
    haulKm: z.number().describe("売上走行km (積み → その便の最後の降し)"),
    deadheadKm: z.number().describe("**その便に割り付いた回送km** (その便へ向かう移動 + 最終便の帰庫)"),
    loadPoint: latLngArgs.nullish().describe("積地の実測 GPS。取れなければ null (**0 に倒さない**)"),
    unloadPoint: latLngArgs.nullish().describe("卸地の実測 GPS。取れなければ null"),
    haulSec: z.number().nullish().describe("売上走行の実測秒。読めなければ null"),
    deadheadSec: z.number().nullish().describe("回送の実測秒 (approachSec + tailSec)。読めなければ null"),
  })
  .strict();

const kushiroOperationArgs = z
  .object({
    unkoNo: z.string().optional().describe("運行NO (追跡用。計算には使わない)"),
    driverName: z.string().describe("乗務員名。`drivers[]` の行のキー"),
    legs: z.array(kushiroLegArgs).describe("その運行の便 (**釧路積み以外・道東卸し以外も入れてよい** — tool が絞る)"),
    // 以下 3 つは**この tool は読まない**。画面 (/profit/margin) の運行ペイロードや
    // 共有 fixture をそのまま貼れるように受け付けるだけ (組み直しは便に割り付いた
    // 回送km と便ごとの GPS しか見ない)。
    kmBreakdown: z
      .object({
        preLoadKm: z.number(),
        haulKm: z.number(),
        betweenKm: z.number(),
        postUnloadKm: z.number(),
        otherKm: z.number(),
      })
      .strict()
      .optional()
      .describe("運行単位の km 内訳。**この tool は読まない** (そのまま貼れるように受けるだけ)"),
    firstLoadPoint: latLngArgs.nullish().describe("最初の積地の GPS。**この tool は読まない**"),
    lastUnloadPoint: latLngArgs.nullish().describe("最後の卸地の GPS。**この tool は読まない**"),
  })
  .strict();

const getKushiroBranchEstimateArgs = z
  .object({
    company: z
      .string()
      .regex(COMP_ID_PATTERN)
      .describe("会社コード。**最低賃金マスタ (R2) を引くためだけ**に使う"),
    from: z.string().regex(YMD_RE).describe("対象期間の下限 (YYYY-MM-DD、**含む**)。最低賃金はこの月で引く"),
    to: z
      .string()
      .regex(YMD_RE)
      .describe("対象期間の上限 (YYYY-MM-DD、**含まない** — 半開区間。月なら翌月1日)"),
    operations: z
      .array(kushiroOperationArgs)
      .min(1)
      .max(KUSHIRO_ESTIMATE_MAX_OPERATIONS)
      .describe(
        "対象期間の運行。**必須** — この worker から運行一覧を引く口が無いため " +
          "(理由は tool の説明を参照)。`tests/fixtures/kushiro-loading/doto-operations-2026-07.json` と同じ形。",
      ),
    driver: z
      .array(z.string().regex(ICHIBAN_CODE_RE))
      .min(1)
      .max(20)
      .optional()
      .describe(`一番星の売上と突き合わせる乗務員CD。省略時は帯広 5 名 (${OBIHIRO_DRIVER_CDS.join(",")})`),
    depot: z
      .enum(DEPOT_KEYS as [string, ...string[]])
      .optional()
      .describe(
        "本命として読む営業所。既定 kushiro。**回送km・拘束時間・換算時給・最低賃金差・" +
          "感度分析・損益分岐はすべて両営業所ぶん返る**ので、この引数が実際に効くのは " +
          "`depot_lat` / `depot_lng` でどちらの座標を差し替えるかだけ。",
      ),
    depot_lat: z.number().optional().describe("`depot` の緯度を上書き (正式所在地が決まったとき用)。lng と対で指定"),
    depot_lng: z.number().optional().describe("`depot` の経度を上書き。lat と対で指定"),
    dest_area: z
      .enum(DEST_AREAS)
      .optional()
      .describe("卸地の絞り込み。既定 doto (道東卸しだけ) / all で釧路積みぜんぶ"),
    legs_per_day: z
      .number()
      .positive()
      .optional()
      .describe(
        "**1 日に何便まわすか** (組み直しは日帰りなので 1 運行 = 1 日)。" +
          "**省略時は実測の分布の平均** (定数で埋めない)。応答の `legs_per_day.source` で " +
          "`measured` / `given` のどちらだったか分かる。**これは固定の想定値ではなく変数** — " +
          "`sensitivity[]` で複数点を同時に見ること。",
      ),
    sensitivity_legs_per_day: z
      .array(z.number().positive())
      .min(1)
      .max(12)
      .optional()
      .describe(
        "感度分析で並べる 便/日 の候補。省略時は **1 / 実測平均 / 2 / 3** の 4 点。" +
          "昇順・重複除去して返す。",
      ),
    legs_per_driver_month: z
      .number()
      .positive()
      .optional()
      .describe(`乗務員 1 名あたりの月間**便数**の上限。省略時 ${DEFAULT_LEGS_PER_DRIVER_MONTH} (帯広実績 284 便 ÷ 5 名)`),
    runs_per_driver_month: z
      .number()
      .positive()
      .optional()
      .describe(
        "乗務員 1 名あたりの月間**運行数 (稼働日数)** の上限。省略時 18.2 (帯広実績 91 運行 ÷ 5 名)。" +
          "**便/日 が必要乗務員数に効くのはこちら** — 便だけで数えると便/日 を変えても人数が動かない。",
      ),
    monthly_labor_cost_yen: z
      .number()
      .optional()
      .describe(
        "乗務員 1 名あたりの月間人件費。**省略時は一番星の経費区分 `08 給与(人件費)` を " +
          "`from`〜`to` × `driver` で引いて 1 名あたりに均す** (実績から取る。定数で埋めない)。" +
          "`sales_cross_check: false` で上流を止めているときは引けないので、損益分岐は出さない。",
      ),
    branch: z
      .string()
      .optional()
      .describe("最低賃金を引く所属名。既定 `釧路営業所`。**実在しない営業所はマスタに無い**ので、その場合は `prefecture` で引く"),
    prefecture: z
      .string()
      .min(1)
      .optional()
      .describe(
        "`branch` が最低賃金マスタの branch→都道府県表に無いときに使う都道府県。" +
          `既定 ${DEFAULT_MIN_WAGE_PREFECTURE} (会社の所在都道府県)。**額ではなく県の名前だけ**を決める引数で、` +
          "額は R2 の min-wage マスタから引く。どの経路で県が決まったかは `min_wage.prefecture_source` に載る",
      ),
    assumed_monthly_wage_yen: z
      .number()
      .optional()
      .describe("換算時給の分子。**省略時は対象便の運行手当の合計** (= 手当のみの下限)"),
    km_per_liter: z.number().optional().describe("燃費。`yen_per_liter` と対で渡すと差km の燃料代を別立てで出す"),
    yen_per_liter: z.number().optional().describe("軽油単価。`km_per_liter` と対"),
    sales_cross_check: z
      .boolean()
      .optional()
      .describe("一番星の売上と突き合わせるか。既定 true。**false にすると上流を 1 回も叩かない** (完全オフライン)"),
  })
  .strict();

/** `RebuildTotals` を応答用の snake_case に落とす (行と summary で同じ形にする)。 */
function kushiroTotalsJson(totals: RebuildTotals, legsPerRun: number | null) {
  const n = legsPerRun;
  const rebuilt = (depot: DepotKey) => (n === null ? null : rebuiltDeadheadKm(totals, depot, n));
  return {
    legs: totals.legs,
    sales_yen: totals.salesYen,
    allowance_yen: totals.allowanceYen,
    haul_km: totals.haulKm,
    measured_deadhead_km: totals.deadheadKm,
    estimated_legs: totals.estimatedLegs,
    missing_legs: totals.missingLegs,
    /** `estimated_legs` のうち、卸地を運行終了の位置で代用した便 (Refs #760 の 38)。 */
    substituted_unload_legs: totals.substitutedUnloadLegs,
    comparable_measured_deadhead_km: totals.comparableDeadheadKm,
    rebuilt_deadhead_km: { obihiro: rebuilt("obihiro"), kushiro: rebuilt("kushiro") },
    rebuilt_minus_measured_km:
      n === null ? null : rebuiltDeadheadKm(totals, "kushiro", n)! - totals.comparableDeadheadKm,
    depot_diff_km: n === null ? null : rebuiltDepotDiffKm(totals, "obihiro", "kushiro", n),
  };
}

export const getKushiroBranchEstimateTool = {
  name: "get_kushiro_branch_estimate",
  description:
    "**釧路営業所 (実在しない・暫定) の試算**を検算するための tool (Refs #760 の 34)。" +
    "積地 = 釧路 かつ 卸地 = 道東 (標茶・別海 等) の便を切り出し、**釧路市役所を起終点とする " +
    "新しい運行として組み直したときの回送km・拘束時間・換算時給**を、帯広営業所で同じように " +
    "組み直した場合と並べて返す。**応答の `estimated` は常に true — これは実績ではない。**\n" +
    "**なぜ営業所の差し替えではなく『組み直し』か**: 本番 2026-07 の対象 38 便は 23 運行すべてが " +
    "道東卸しと十勝卸しの混在運行で、道東だけで閉じた運行が 1 本も無い。既存の運行の起終点を " +
    "差し替えるモデルでは 1 便も動かせない。\n" +
    "**`operations` は必須** — この worker から『その月の運行一覧』を引く口が無いため " +
    "(上流は R2 / dtako-scraper-relay / rust-ichibanboshi の 3 つだけで、運行一覧は " +
    "rust-alc-api 直 fetch = 画面側の経路)。便の積地・卸地・売上・手当・km・GPS を呼び出し側が渡す。" +
    "画面 (/profit/margin) が出したのと同じ入力を渡せば、**画面と同じ数字が出ることを確かめられる** " +
    "(`tests/fixtures/kushiro-loading/doto-operations-2026-07.json` がその形の実例)。\n" +
    "**回送km・拘束時間・換算時給・最低賃金との差・感度分析・損益分岐は、すべて " +
    "`{ obihiro, kushiro }` の両営業所ぶん返る** — オーナーの要件が「帯広の乗務員を基準に " +
    "比較」なので、1 回の呼び出しで両側が並ぶ。`depot` は本命のラベルと座標上書きの対象を " +
    "決めるだけで、片側しか返らない値は無い。**実測 (`measured_*`) は組み直し前の話なので " +
    "どちらの営業所でも同じ値**で、営業所で変わるのは `rebuilt_*` だけ。\n" +
    "**距離は直線 (haversine)**。道なりではないので実距離は必ずこれ以上。" +
    "**営業所どうしの差 (`depot_diff_km`) は両側とも推定**なので引き算してよいが、" +
    "**`rebuilt_minus_measured_km` は推定と実測の差**で、営業所の差ではなく測り方の差が混ざる — " +
    "橋渡しは `calibration_ratio` (推定 ÷ 実測) で見ること。\n" +
    "**拘束時間は 走行 + 回送 だけ**で積込・荷降ろしの待機を含まない (入力に無い) ので**下限**。" +
    "したがって換算時給は**上限**で、『この上限でも最低賃金を割っているなら確実に割っている』" +
    "という向きで読む (`restraint_is_lower_bound` が必ず立つ)。" +
    "最低賃金は R2 の min-wage マスタ (厚労省の一覧の取り込み結果) から引くので、額は定数ではない。\n" +
    "**燃料代を出す場合も実績の燃料代とは別立て** — 月の燃料総額は給油実績で固定されており、" +
    "回送km が減っても実績側は 1 円も動かない。\n" +
    "**「1 日に何便まわすか」は固定の想定値ではなく変数** (オーナー指示 2026-08-23)。" +
    "`legs_per_day` を渡さなければ実測の平均 (`legs_per_day.source: \"measured\"`) を使い、" +
    "**`sensitivity[]` に 1 / 実測平均 / 2 / 3 便/日 の 4 点**を必ず並べる (候補は " +
    "`sensitivity_legs_per_day` で差し替え可)。便数を変えると**動く**のは 組み直し後の回送km → " +
    "回送時間 → 拘束 → 換算時給 / 燃料代 / 稼働日数 → 必要乗務員数 → 人件費 で、**動かない**のは " +
    "売上・手当 (便あたり定額) と 売上走行km・走行時間。`break_even_legs_per_day` は " +
    "**営業利益 (売上 − 手当 − 燃料 − 人件費) が 0 以上になる最小の 便/日**で、人件費は " +
    "一番星の経費区分 08 (給与) の実績から取る (定数で埋めない)。\n" +
    "**現状の回送 (`measured_deadhead_km`) と組み直し後の推定をそのまま引き算しないこと** — " +
    "実データの道東卸しは運行の途中にあり、降ろした後は必ず十勝へ戻ってきている " +
    "(帰庫は 27km/運行しかない)。この試算は現状からの差分ではなく**新しい運行を 1 から組んだ姿**。" +
    "受け取った運行ペイロードは `input` にそのまま数え直して返すので、貼り間違いはそこで気付ける。\n" +
    "**最低賃金は「所属 → 都道府県 → 額」の順に引く。** 釧路営業所は実在しないので " +
    "branch→都道府県表には載らず、その場合は `prefecture` (既定 " +
    `${DEFAULT_MIN_WAGE_PREFECTURE}` + ") で引く。決まった経路は `min_wage.prefecture_source` " +
    "(`branch` / `argument` / `company-default`) に、額が引けなかったときの切り分け用に " +
    "その県の改定発効日が `min_wage.master_effective_froms` に載る。**額は必ず R2 の " +
    "min-wage マスタ (厚労省の一覧の取り込み結果) から引き、定数で埋めない。**",
  inputSchema: getKushiroBranchEstimateArgs,
  execute: async (env: Env, args: z.infer<typeof getKushiroBranchEstimateArgs>) => {
    const parsed = parseYm(args.from.slice(0, 7));
    if (!parsed) throw new Error("from は YYYY-MM-DD で指定してください");
    if (args.to <= args.from) throw new Error("to は from より後 (半開区間) にしてください");
    if ((args.depot_lat === undefined) !== (args.depot_lng === undefined)) {
      throw new Error("depot_lat と depot_lng は対で指定してください (片方だけでは座標になりません)");
    }

    const depot = (args.depot ?? "kushiro") as DepotKey;
    const area = args.dest_area ?? DEFAULT_DEST_AREA;
    const drivers = args.driver ?? OBIHIRO_DRIVER_CDS;
    const branch = args.branch ?? "釧路営業所";
    const legsPerDriverMonth = args.legs_per_driver_month ?? DEFAULT_LEGS_PER_DRIVER_MONTH;
    const runsPerDriverMonth = args.runs_per_driver_month ?? DEFAULT_RUNS_PER_DRIVER_MONTH;
    const capacity = { legsPerDriverMonth, runsPerDriverMonth };
    const warnings: string[] = [];

    // 営業所の座標。上書きは `depot` で選んだ側にだけ効く (もう片方は比較の基準なので動かさない)。
    const depots: DepotPoints = { ...DEPOTS };
    if (args.depot_lat !== undefined && args.depot_lng !== undefined) {
      const override = { lat: args.depot_lat, lng: args.depot_lng };
      if (!isValidLatLng(override)) throw new Error("depot_lat / depot_lng が座標の範囲外です");
      depots[depot] = override;
    }

    const operations: RebuildOperationInput[] = args.operations.map((op) => ({
      unkoNo: op.unkoNo ?? "",
      driverName: op.driverName,
      // 組み直しは運行単位の km 内訳を読まない (便に割り付いた回送km だけを見る)。
      kmBreakdown: { preLoadKm: 0, haulKm: 0, betweenKm: 0, postUnloadKm: 0, otherKm: 0 },
      legs: op.legs.map((leg) => ({
        ...leg,
        loadPoint: leg.loadPoint ?? null,
        unloadPoint: leg.unloadPoint ?? null,
        haulSec: leg.haulSec ?? null,
        deadheadSec: leg.deadheadSec ?? null,
      })),
    }));

    const summary = summarizeDotoRebuild(operations, {
      area,
      ...(args.legs_per_day === undefined ? {} : { legsPerRun: args.legs_per_day }),
      depots,
    });
    const n = summary.legsPerRun;
    if (n === null) {
      warnings.push(
        `対象 (積地=釧路 / 卸地=${area}) の便が 1 本もありません。組み直しの推定は出していません`,
      );
    }
    if (summary.totals.missingLegs > 0) {
      warnings.push(
        `座標が欠けた便が ${summary.totals.missingLegs} 本あります。**0km に倒さず推定から外している**ので、` +
          `推定の母集団は ${summary.totals.estimatedLegs} 便です`,
      );
    }
    if (summary.totals.substitutedUnloadLegs > 0) {
      warnings.push(
        `推定の母集団 ${summary.totals.estimatedLegs} 便のうち ${summary.totals.substitutedUnloadLegs} 本は、` +
          `**降しの記録が無い最終便**で卸地を**運行終了の位置で代用**しています (実測の卸地ではありません)。` +
          `運行終了が中継拠点なら荷を降ろした場所そのものですが、そうでない運行では実際の卸地より手前になります`,
      );
    }

    const needDrivers = requiredDrivers(summary.totals.legs, legsPerDriverMonth);
    const wageYen = args.assumed_monthly_wage_yen ?? summary.totals.allowanceYen;
    /**
     * **拘束時間と換算時給を両営業所ぶん出す** (Refs #760 の 34)。
     *
     * `depot` を「どちらを本命として読むか」だけの引数にしておきながら、拘束と時給が
     * 選んだ側しか返らないと、**画面が片側だけ見て「両方出ている」と誤解する**。
     * オーナーの要件も「帯広の乗務員を基準に比較」なので、1 回の呼び出しで両側が
     * 並ぶ形にする (`rebuilt_deadhead_km` が既にそうなっているのと同じ形)。
     */
    const perDepot = <T>(pick: (d: DepotKey) => T): Record<DepotKey, T> =>
      Object.fromEntries(DEPOT_KEYS.map((d) => [d, pick(d)])) as Record<DepotKey, T>;

    const hoursByDepot = perDepot((d) => (n === null ? null : restraintHours(summary.totals, d, n)));
    // 1 名あたりの月間拘束時間。**拘束が出ている時点で対象便が 1 本以上あり、
    // `legs_per_driver_month` は zod が正数を保証するので `needDrivers` は 1 以上**
    // (回送の実測秒が 1 秒も無ければ速度が出ず `rebuiltTotalHours` が null になる)。
    const restraintTotalByDepot = perDepot((d) => hoursByDepot[d]?.rebuiltTotalHours ?? null);
    const hoursPerDriverByDepot = perDepot((d) =>
      restraintTotalByDepot[d] === null ? null : restraintTotalByDepot[d]! / needDrivers!,
    );
    // 換算時給は「総賃金 ÷ 総拘束」= 「1 名あたりの賃金 ÷ 1 名あたりの拘束」で同じ値。
    const hourlyByDepot = perDepot((d) => hourlyWageYen(wageYen, restraintTotalByDepot[d]));

    // 最低賃金は R2 のマスタから引く (額を定数で埋めない)。
    const rawMinWage = await getJson<unknown>(
      env.DTAKO_R2,
      wageMasterR2Paths(r2Prefix(env), args.company, "min-wage").latest,
    );
    let minWageMaster: MinWageMaster = { prefectures: {}, branchToPrefecture: {} };
    if (rawMinWage === null) {
      warnings.push("最低賃金マスタ (min-wage/latest.json) が R2 にありません。最低賃金の比較は出していません");
    } else {
      minWageMaster = normalizeMinWageMaster(rawMinWage);
    }
    // まず所属で引く。**実在しない営業所 (釧路営業所) はマスタに載りようが無い**ので、
    // 引けなければ都道府県を直接指定して引き直す — `branchToPrefecture` にその所属の
    // 行を差し込んで**同じ関数をもう一度通す**ことで、額の選び方 (改定履歴から対象月に
    // 有効な行を採る) を書き写さずに済ませる。
    const byBranch = minWageForBranch(minWageMaster, branch, parsed.year, parsed.month);
    const prefectureArg = args.prefecture;
    const prefectureSource = byBranch.mapped
      ? "branch"
      : prefectureArg === undefined
        ? "company-default"
        : "argument";
    const prefecture = prefectureArg ?? DEFAULT_MIN_WAGE_PREFECTURE;
    const lookup = byBranch.mapped
      ? byBranch
      : minWageForBranch(
          {
            ...minWageMaster,
            branchToPrefecture: { ...minWageMaster.branchToPrefecture, [branch]: prefecture },
          },
          branch,
          parsed.year,
          parsed.month,
        );
    if (!byBranch.mapped) {
      warnings.push(
        `所属 "${branch}" は最低賃金マスタの branch→都道府県表にありません ` +
          `(実在しない営業所なので当然)。${prefecture} (${prefectureSource}) で引きました`,
      );
    }
    // `mapped` が true なら県は必ず決まっている (`minWageForBranch` は空文字の県を
    // `mapped: false` に落とす)。決まっていなければ上で差し込んだ `prefecture`。
    // ⇒ **この tool では県が null になる道が無い**ので、額が引けない = マスタ側の
    // 取り込み漏れ、と一意に読める。
    const resolvedPrefecture = byBranch.mapped ? byBranch.prefecture! : prefecture;
    const masterEffectiveFroms = (minWageMaster.prefectures[resolvedPrefecture] ?? [])
      .map((e) => e.effectiveFrom)
      .sort();
    if (lookup.rate === null) {
      warnings.push(
        `${resolvedPrefecture} の最低賃金マスタに ${args.from.slice(0, 7)} 時点で有効な行がありません ` +
          `(マスタが持つ発効日: ${masterEffectiveFroms.join(", ") || "1 件も無い"})。` +
          "min-wage の取り込みを確認してください",
      );
    }

    const fuelYen =
      args.km_per_liter === undefined || args.yen_per_liter === undefined || n === null
        ? null
        : deadheadFuelYen(rebuiltDepotDiffKm(summary.totals, "obihiro", "kushiro", n)!, {
            kmPerLiter: args.km_per_liter,
            yenPerLiter: args.yen_per_liter,
          });

    // 人件費は実績 (一番星の `08 給与(人件費)`) から取る。**引数があればそれが優先。**
    let laborCostYen: number | null = args.monthly_labor_cost_yen ?? null;
    let laborCostSource = args.monthly_labor_cost_yen === undefined ? "none" : "argument";

    // 一番星の売上との突合 (対象便がその乗務員たちの期間売上のどれくらいか)。
    let salesCrossCheck: unknown = null;
    if (args.sales_cross_check !== false) {
      const rows = await Promise.all(
        drivers.map(async (driverCd) => {
          const body = await fetchIchibanJson(
            env,
            ichibanRangeQuery("/api/sales/vehicle-daily", args.from, args.to, { driver: driverCd }),
            "kushiro_estimate_sales",
          );
          const list = ichibanRows(body);
          return {
            driver: driverCd,
            rows: list.length,
            amount: list.reduce((acc: number, row) => acc + numField(row, "amount"), 0),
            truncated: truncatedAt(list),
          };
        }),
      );
      const total = rows.reduce((acc: number, r) => acc + r.amount, 0);
      if (rows.some((r) => r.truncated)) {
        warnings.push("一番星の売上が上流の 500 件で切られています。期間を割って引き直すこと");
      }
      salesCrossCheck = {
        drivers: rows,
        total_amount: total,
        // 対象便の売上が、その乗務員たちの期間売上に占める割合。0 除算はしない。
        target_share: total > 0 ? summary.totals.salesYen / total : null,
      };

      if (laborCostSource === "none") {
        // 経費区分 08 = 給与(人件費)。粗利タブが粗利の経費から外している区分で、
        // **運行手当とは別立ての実績**。1 名あたりに均して人件費の前提に使う。
        const costs = await Promise.all(
          drivers.map(async (driverCd) => {
            const body = await fetchIchibanJson(
              env,
              ichibanRangeQuery("/api/costs/vehicle-daily", args.from, args.to, {
                driver: driverCd,
                kind: ICHIBAN_LABOR_COST_KIND,
              }),
              "kushiro_estimate_labor",
            );
            return ichibanRows(body).reduce((acc: number, row) => acc + numField(row, "amount"), 0);
          }),
        );
        const totalLabor = costs.reduce((acc: number, v) => acc + v, 0);
        if (totalLabor > 0) {
          laborCostYen = totalLabor / drivers.length;
          laborCostSource = "ichiban";
        } else {
          warnings.push(
            `一番星の経費区分 ${ICHIBAN_LABOR_COST_KIND} (給与) が ${args.from}〜${args.to} に 1 円もありません。` +
              "人件費の前提が無いので営業利益と損益分岐は出していません",
          );
        }
      }
    }
    if (laborCostSource === "none") {
      warnings.push(
        "人件費の前提がありません (`monthly_labor_cost_yen` を渡すか、`sales_cross_check` を有効にして " +
          "一番星から引かせてください)。**推測で埋めないので**営業利益と損益分岐は null です",
      );
    }

    // --- 便/日 の感度分析 (オーナー指示「1 日何便まわすかは変数にして」) ---
    const sensitivityInput: SensitivityInput = {
      capacity,
      monthlyWageYen: wageYen,
      minWageYen: lookup.rate,
      fuel: { kmPerLiter: args.km_per_liter ?? null, yenPerLiter: args.yen_per_liter ?? null },
      monthlyLaborCostYen: laborCostYen,
    };
    // 既定の候補は **1 / 実測平均 / 2 / 3**。実測平均が出せない (対象 0 便) ときは整数 3 点だけ。
    const candidates = args.sensitivity_legs_per_day
      ?? (summary.distribution.mean === null ? [1, 2, 3] : [1, summary.distribution.mean, 2, 3]);
    const sensitivityByDepot = perDepot((d) =>
      sensitivityGrid(summary.totals, d, candidates, sensitivityInput),
    );
    const breakEvenByDepot = perDepot((d) =>
      breakEvenLegsPerDay(summary.totals, d, candidates, sensitivityInput),
    );

    /** 感度分析 1 行を応答用に落とす。 */
    const sensitivityJson = (row: SensitivityRow) => ({
      legs_per_day: row.legsPerDay,
      runs: row.runs,
      required_drivers: {
        by_legs: row.requiredDrivers.byLegs,
        by_runs: row.requiredDrivers.byRuns,
        drivers: row.requiredDrivers.drivers,
      },
      rebuilt_deadhead_km: row.rebuiltDeadheadKm,
      restraint_hours: row.restraint.rebuiltTotalHours,
      restraint_hours_per_driver: row.restraintHoursPerDriver,
      hourly_yen: row.hourlyYen,
      min_wage_diff_yen: row.minWageDiffYen,
      below_min_wage: row.belowMinWage,
      fuel_yen: row.fuelYen,
      margin_yen: row.marginYen,
      labor_cost_yen: row.laborCostYen,
      operating_margin_yen: row.operatingMarginYen,
    });

    return {
      // **実在しない営業所の試算**であることを、応答だけ見て取り違えないための旗。
      estimated: true,
      estimate_note:
        "釧路営業所は実在しない。起終点は釧路市役所の暫定座標で、距離は直線 (道なりの下限)。" +
        "拘束時間は 走行 + 回送 のみで荷役・待機を含まない下限、換算時給はその上限。" +
        "**現状の回送 (measured_deadhead_km) は十勝への戻りを含む** — 実データの道東卸しは" +
        "運行の途中にあり、降ろした後は必ず十勝へ戻ってきている (帰庫は 27km/運行しかない)。" +
        "だからこれは現状からの差分ではなく**新しい運行を 1 から組んだ姿**で、" +
        "`measured_deadhead_km` と `rebuilt_deadhead_km` をそのまま引き算して削減量と読まないこと。" +
        "同じ方法どうしの引き算として成立するのは `depot_diff_km` (帯広発 vs 釧路発) だけ。",
      // 貼り間違いに気づけるよう、**受け取った運行ペイロードをそのまま数え直して返す**
      // (絞り込み前の全便。`summary` は積地=釧路 かつ 卸地=dest_area で絞った後の値)。
      input: {
        operations: args.operations.length,
        legs: args.operations.reduce((acc: number, op) => acc + op.legs.length, 0),
        sales_yen: args.operations.reduce(
          (acc: number, op) => acc + op.legs.reduce((a: number, l) => a + l.salesYen, 0), 0),
        allowance_yen: args.operations.reduce(
          (acc: number, op) => acc + op.legs.reduce((a: number, l) => a + l.allowanceYen, 0), 0),
      },
      company: args.company,
      from: args.from,
      to: args.to,
      depot,
      depot_points: depots,
      dest_area: area,
      // **1 日に何便まわすか。想定値を固定しない** (オーナー指示 2026-08-23)。
      legs_per_day: {
        value: n,
        source: args.legs_per_day === undefined ? "measured" : "given",
        measured_mean: summary.distribution.mean,
        operations: summary.distribution.operations,
        buckets: summary.distribution.buckets.map((b) => ({
          legs_in_operation: b.legsInOperation,
          operations: b.operations,
        })),
      },
      // 便/日 を振ったときの姿。**どの前提でも 1 つの表で比べられるようにするためのもの。**
      // **両営業所ぶん返す** — 片側だけだと「帯広を基準に比較」ができない。
      sensitivity: perDepot((d) => sensitivityByDepot[d].map(sensitivityJson)),
      // 営業利益が 0 以上になる最小の 便/日。候補の中に無ければ null (外挿しない)。
      break_even_legs_per_day: breakEvenByDepot,
      labor_cost: {
        monthly_per_driver_yen: laborCostYen,
        source: laborCostSource,
        note:
          "一番星の経費区分 08 (給与) を from〜to × driver で合計し、乗務員数で均した実績。" +
          "運行手当 (allowance_yen) とは別立て — 粗利タブも 08 を粗利の経費から外している。",
      },
      summary: {
        ...kushiroTotalsJson(summary.totals, n),
        operations: summary.distribution.operations,
        rebuilt_operations: n === null ? null : rebuiltRuns(summary.totals, n),
        calibration_ratio: {
          obihiro: n === null ? null : estimateCalibrationRatio(summary.totals, "obihiro", n),
          kushiro: n === null ? null : estimateCalibrationRatio(summary.totals, "kushiro", n),
        },
        measured_speed_kmh: {
          haul: haulSpeedKmh(summary.totals),
          deadhead: rebuildDeadheadSpeedKmh(summary.totals),
        },
        // **両営業所ぶん。** `measured_*` は実測なので営業所に依らず同じ値が入る
        // (組み直し前の話なので当然)。**営業所で変わるのは `rebuilt_*` だけ。**
        restraint_hours: perDepot((d) => {
          const h = hoursByDepot[d];
          return h === null
            ? null
            : {
                measured_haul: h.haulHours,
                measured_deadhead: h.measuredDeadheadHours,
                measured_total: h.measuredTotalHours,
                rebuilt_deadhead: h.rebuiltDeadheadHours,
                rebuilt_total: h.rebuiltTotalHours,
                restraint_is_lower_bound: h.restraintIsLowerBound,
              };
        }),
        // **便の量だけで数えた人数** (便/日 に依らない)。便/日 を効かせた人数は
        // `sensitivity[].required_drivers` を見ること。
        required_drivers: needDrivers,
        legs_per_driver_month: legsPerDriverMonth,
        runs_per_driver_month: runsPerDriverMonth,
        // この便/日 で組んだときの稼働日数 (= 運行数)。**座標が欠けた便も運ぶ。**
        runs_for_legs_per_day: n === null ? null : runsForLegsPerDay(summary.totals.legs, n),
        // 差km の金額化。**実績の燃料代とは足し引きしない別立ての紙。**
        deadhead_fuel_yen: fuelYen,
      },
      min_wage: {
        branch,
        prefecture: resolvedPrefecture,
        /** 県がどう決まったか。`branch` = マスタの branch→都道府県表に当たった /
         *  `argument` = 引数の `prefecture` / `company-default` = 会社の所在都道府県。 */
        prefecture_source: prefectureSource,
        /** **所属名**でマスタに当たったか。実在しない営業所では常に false。 */
        mapped: byBranch.mapped,
        /** その県について マスタが持つ改定の発効日。**`rate` が null のときの切り分け用** —
         *  空なら取り込み漏れ、未来の日付だけなら対象月にはまだ効いていない。 */
        master_effective_froms: masterEffectiveFroms,
        rate: lookup.rate,
        rate_effective_from: lookup.rateEffectiveFrom ?? null,
        assumed_monthly_wage_yen: wageYen,
        wage_basis: args.assumed_monthly_wage_yen === undefined ? "allowance-only" : "argument",
        // **ここから下は両営業所ぶん。** 「帯広の乗務員を基準に比較」が要件なので、
        // 1 回の呼び出しで両側の時給が並ぶようにする。
        restraint_hours_per_driver: hoursPerDriverByDepot,
        hourly_yen: hourlyByDepot,
        diff_yen: perDepot((d) =>
          hourlyByDepot[d] === null || lookup.rate === null ? null : hourlyByDepot[d]! - lookup.rate,
        ),
        below_min_wage: perDepot((d) =>
          hourlyByDepot[d] === null || lookup.rate === null ? null : hourlyByDepot[d]! < lookup.rate,
        ),
      },
      routes: summary.routes.map((row) => ({
        from: row.from,
        to: row.to,
        doto: row.doto,
        ...kushiroTotalsJson(row.totals, n),
      })),
      drivers: summary.drivers.map((row) => ({
        driver_name: row.driverName,
        ...kushiroTotalsJson(row.totals, n),
      })),
      sales_cross_check: salesCrossCheck,
      warnings,
    };
  },
} satisfies ToolEntry<typeof getKushiroBranchEstimateArgs>;

export const ALL_TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  listCompaniesTool as unknown as ToolEntry<z.ZodTypeAny>,
  listMonthsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getWageReportTool as unknown as ToolEntry<z.ZodTypeAny>,
  getRestraintSummaryTool as unknown as ToolEntry<z.ZodTypeAny>,
  getKosokuEventsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getRestDiffTool as unknown as ToolEntry<z.ZodTypeAny>,
  getTimecardDiffTool as unknown as ToolEntry<z.ZodTypeAny>,
  runKintaiRelayTool as unknown as ToolEntry<z.ZodTypeAny>,
  runKintaiRecalcTool as unknown as ToolEntry<z.ZodTypeAny>,
  runKintaiRestraintSyncTool as unknown as ToolEntry<z.ZodTypeAny>,
  runDtakoScrapeTool as unknown as ToolEntry<z.ZodTypeAny>,
  getDtakoScrapeStatusTool as unknown as ToolEntry<z.ZodTypeAny>,
  getDtakoScrapeProgressTool as unknown as ToolEntry<z.ZodTypeAny>,
  getKintaiDaySummariesTool as unknown as ToolEntry<z.ZodTypeAny>,
  getKintaiDiffTool as unknown as ToolEntry<z.ZodTypeAny>,
  getOperationZipTool as unknown as ToolEntry<z.ZodTypeAny>,
  runDtakoReimportTool as unknown as ToolEntry<z.ZodTypeAny>,
  runDtakoAlcUploadTool as unknown as ToolEntry<z.ZodTypeAny>,
  getIchibanCostsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getIchibanSalesTool as unknown as ToolEntry<z.ZodTypeAny>,
  getKushiroBranchEstimateTool as unknown as ToolEntry<z.ZodTypeAny>,
];
