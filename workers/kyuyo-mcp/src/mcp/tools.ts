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

    const apiUrl = (env.NUXT_ICHIBAN_API_URL || "").replace(/\/+$/, "");
    const clientId = env.NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID || "";
    // Secrets Store binding は「宣言はあるが解決できない」時に get() が throw する
    // (ローカル dev や entry の消失・改名)。素通しすると原因が読めないので、
    // 未設定と同じ扱いに倒す — relay の handleKintaiFetch と同じ判断。
    let clientSecret = "";
    try {
      clientSecret = await resolveSecretBinding(env.ICHIBAN_CF_ACCESS_CLIENT_SECRET);
    } catch (err) {
      console.error(JSON.stringify({ kosoku_events: "secret-error", error: describeError(err) }));
    }
    if (!apiUrl || !clientId || !clientSecret) {
      throw new Error(
        "勤怠の取得先 (NUXT_ICHIBAN_API_URL / NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID / " +
          "ICHIBAN_CF_ACCESS_CLIENT_SECRET) が未設定です",
      );
    }

    const url =
      `${apiUrl}/api/kintai/events?month=${encodeURIComponent(args.month)}` +
      `&driver=${encodeURIComponent(args.driver)}`;
    let res: Response;
    try {
      res = await fetch(url, {
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // CF Access の認証画面 HTML が返るケース (Service Token 失効時に踏む)
      throw new Error(
        `rust-ichibanboshi の応答が JSON ではありません: ${text.slice(0, UPSTREAM_EXCERPT)}`,
      );
    }
    const rows = (parsed as { rows?: unknown }).rows;
    return { month: args.month, driver: args.driver, rows: Array.isArray(rows) ? rows : [] };
  },
} satisfies ToolEntry<typeof getKosokuEventsArgs>;

/** server.ts が McpServer に登録する全 tool。inputSchema が異なるため
 *  `ToolEntry<z.ZodTypeAny>` に揃えて束ねる (cf-access-mcp と同じパターン)。 */
export const ALL_TOOLS: ToolEntry<z.ZodTypeAny>[] = [
  listCompaniesTool as unknown as ToolEntry<z.ZodTypeAny>,
  listMonthsTool as unknown as ToolEntry<z.ZodTypeAny>,
  getWageReportTool as unknown as ToolEntry<z.ZodTypeAny>,
  getRestraintSummaryTool as unknown as ToolEntry<z.ZodTypeAny>,
  getKosokuEventsTool as unknown as ToolEntry<z.ZodTypeAny>,
];
