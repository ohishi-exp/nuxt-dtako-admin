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

const getWageReportArgs = z.object(monthArgsShape).strict();

export const getWageReportTool = {
  name: "get_wage_report",
  description:
    "指定した会社・年月の賃金計算結果を、拘束時間サマリと突き合わせた行の配列で返す " +
    "(拘束時間×賃金マスタから computeWageRow で再計算。給与明細実績との突合は含まない — " +
    "サーバー側に給与明細アーカイブが存在しないため)。",
  inputSchema: getWageReportArgs,
  execute: async (env: Env, args) => {
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

    const [wageMaster, minWageMaster, config, current, prev] = await Promise.all([
      loadMaster<WageMaster>("wage-master", normalizeWageMaster, { drivers: {} }),
      loadMaster<MinWageMaster>("min-wage", normalizeMinWageMaster, { prefectures: {}, branchToPrefecture: {} }),
      loadMaster<WageConfig>("wage-config", normalizeWageConfig, normalizeWageConfig(null)),
      loadMonthSummaries(env, args.company, args.month),
      loadMonthSummaries(env, args.company, prevYm),
    ]);

    const prevDaysByDriver = new Map<string, RestraintSummaryDay[]>(
      prev.summaries.map((s) => [s.data.driverCd, s.data.days]),
    );

    const warnings: string[] = [];
    if (current.summaries.length > 0 && prev.summaries.length === 0) {
      warnings.push(
        `前月 (${prevYm}) の summary がアーカイブに無いため、月初の跨ぎ週の週40h計算は当月分のみで近似しています`,
      );
    }

    const rows = current.summaries.map((s) => ({
      summary: s.data,
      fetched_at: s.fetched_at,
      last_verified_at: s.last_verified_at,
      wage: computeWageRow(
        s.data,
        year,
        month,
        wageMaster,
        minWageMaster,
        config,
        prevDaysByDriver.get(s.data.driverCd) ?? [],
      ),
    }));

    return { month: args.month, rows, no_data_drivers: current.noDataDrivers, warnings };
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
  month: z.string().describe("対象月 (YYYY-MM)"),
  after_driver_cd: z
    .number()
    .int()
    .optional()
    .describe("続きから回す位置。前回の応答の next_after_driver_cd を渡す"),
  max_drivers: z.number().int().optional().describe("1 回で回す乗務員数 (既定 10、上限 50)"),
  apply: z
    .boolean()
    .optional()
    .describe("**true で初めて GCP に書く**。省略時は差分の件数を数えるだけ"),
});

/**
 * 打刻をオンプレ → GCP へ 1 ページぶん運ぶ (Refs ohishi-exp/rust-ichibanboshi#205 の 04b)。
 *
 * **運ぶロジックはここに無い。** relay の `POST /kintai-relay/run` を service binding
 * 越しに叩くだけで、署名の突き合わせは rust 側 (`kintai_push::plan_batch`)、tenant の
 * 解決は relay 側 (KV `dtako_accounts`)。ここは MCP の認証付き入口を出すだけ —
 * 人間に `INTERNAL_SHARED_SECRET` を手渡さずに起動できるようにするのが目的。
 */
export const runKintaiRelayTool = {
  name: "run_kintai_relay",
  description:
    "社内 MariaDB の打刻を GCP 側 (Supabase kintai.*) へ 1 ページぶん運ぶ " +
    "(Refs ohishi-exp/rust-ichibanboshi#205 の 04b)。" +
    "**apply を付けない限り 1 件も書かない** — 差分の件数だけ返る (既定)。" +
    "オンプレから乗務員を 1 ページ引き、GCP から署名を集め、差分だけを GCP へ渡す。" +
    "Cloudflare Tunnel の 30 秒上限があるので乗務員数で区切られる — " +
    "応答の nextAfterDriverCd が null になるまで呼び直すこと。" +
    "misplaced が 0 でなければ運び方が壊れている。" +
    "unknownStates が空でなければ上流に DDL の CHECK に無い state が来ている。",
  inputSchema: runKintaiRelayArgs,
  // **write tool。** 打刻を本番 Supabase に書きうるので read tool と同じ扱いにしない
  requiresScope: "mcp.write",
  execute: async (env: Env, args: z.infer<typeof runKintaiRelayArgs>) => {
    if (!parseYm(args.month)) throw new Error("month は YYYY-MM で指定してください");
    const relay = env.SCRAPER_RELAY;
    if (!relay) throw new Error("SCRAPER_RELAY binding が未設定です");
    const secret = await resolveSecretBinding(env.INTERNAL_SHARED_SECRET);
    if (!secret) throw new Error("INTERNAL_SHARED_SECRET が未設定です");

    const res = await relay.fetch("https://relay.internal/kintai-relay/run", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Alc-Proxy-Secret": secret },
      body: JSON.stringify({
        month: args.month,
        after_driver_cd: args.after_driver_cd,
        max_drivers: args.max_drivers,
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

export const ALL_TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  listCompaniesTool as unknown as ToolEntry<z.ZodTypeAny>,
  listMonthsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getWageReportTool as unknown as ToolEntry<z.ZodTypeAny>,
  getRestraintSummaryTool as unknown as ToolEntry<z.ZodTypeAny>,
  getKosokuEventsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getTimecardDiffTool as unknown as ToolEntry<z.ZodTypeAny>,
  runKintaiRelayTool as unknown as ToolEntry<z.ZodTypeAny>,
];
