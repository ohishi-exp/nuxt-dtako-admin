/**
 * 最低賃金の不足と「就労調整金」による年の補填 (Refs ohishi-exp/nuxt-dtako-admin#1263 / #p414)。
 *
 * ## なぜ relay に置くか
 *
 * 同じ結果を **画面 (期間集計タブの「年の補填」カード・年間レポート PDF)** と
 * **MCP (kyuyo-mcp)** の両方から出すため。app と workers の間の import は前例が無いので、
 * 片方に置いて両方から呼べるのは relay だけ (以前は画面の `loadMinWageAdjustment` と
 * `app/utils/min-wage-adjustment.ts` が持っていた。この移設で画面側は消した)。
 *
 * ## 読む順序 (直列。給与大臣は同時 1 本)
 *
 * 社員マスタ (給与社員CD → 乗務員CD) → 年ごとに [期間集計 (`wage-range`、勤務月 1〜12 月) →
 * 賞与 (支給日の年) → 月例 (勤務月 前年12月〜11月 = 支給日の年)]。fetch は {@link AnnualReportSources}
 * で注入する (DO が D1・勤怠 Worker・給与大臣 Worker を渡す)。
 *
 * ## 判定のきまり (画面の旧実装と同じ。変えるときは PDF の「判定のきまり」も直す)
 *
 * - 不足 = その年の勤務月のうち「給与 − 計算」(合計) がマイナスだった月の不足額の合計。
 *   **プラスの月とは相殺しない** (補填は就労調整金で見る運用の前提)
 * - 補填 = 支給日がその年の「就労調整金」(賞与 + 月例)
 * - **集計に入らなかった月は 0 円ではない** — `missingMonths` に出し、判定文に
 *   「N か月未集計のため確定でない」を必ず添える (欠けたまま「補填済み」と言い切らない)
 * - 差は `paid - calc` (単月表の `minWageCompareRow` と同じ向き)。
 *   `WageRow.totalPayDiff` (単価マスタ − 最低賃金) は実支給を含まないので使わない
 *
 * ## app 側と同じ規則の写し
 *
 * `monthDiff` (app/utils/wage-range-view.ts)・`salaryCdMapKey` / `resolveCdKey`
 * (app/utils/salary-compare.ts)・支給日から月を取る `payrollToParsedSalary`
 * (app/utils/kyuyo-fetch.ts) と同じ規則で書いている。app 側はほかの画面が使うので残る。
 * 変えるときは両方に反映すること (`normalizeNameKey` と同じ扱い)。
 */
import { normalizeNameKey } from "./employee-master";
import { relayWageRangeGet, type KintaiRelayDeps } from "./kintai-relay";
import { describeUnknownError } from "./scrape-queue";

/** 補填に使う支給項目の名前 (給与大臣の項目名そのもの)。 */
export const ADJUSTMENT_ITEM_LABEL = "就労調整金";

/** 1 回に出せる年の数 (賞与は 1 社 10〜20 秒かかり、年 × 会社で直列に読むため)。 */
export const MAX_REPORT_YEARS = 5;

/** 状態と HTTP status を持つ失敗。DO はこの status をそのまま返す。 */
export class AnnualReportError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AnnualReportError";
  }
}

// ---------------------------------------------------------------------------
// クエリ
// ---------------------------------------------------------------------------

export interface AnnualReportQuery {
  fromYear: number;
  toYear: number;
  /** 乗務員CD。省略時は会社の全員 (画面のカード)。PDF には必須。 */
  driver: string | null;
  format: "json" | "pdf";
  /** `wage-range` へそのまま渡すもの (`source` / `wage_logic_version` / `salary_item_sha`)。 */
  rangeParams: Record<string, string>;
}

const YEAR_RE = /^\d{4}$/;
const DRIVER_RE = /^\d{1,10}$/;
const PASS_PARAM_RE = /^[\w.:-]{1,128}$/;
const PASS_PARAMS = ["source", "wage_logic_version", "salary_item_sha"] as const;

/** `?driver=&from_year=&to_year=&format=` を検証する。不正なら日本語の理由。 */
export function parseAnnualReportQuery(params: URLSearchParams): AnnualReportQuery | { error: string } {
  const from = params.get("from_year") ?? "";
  const to = params.get("to_year") ?? from;
  if (!YEAR_RE.test(from) || !YEAR_RE.test(to)) return { error: "from_year / to_year は YYYY で指定してください" };
  const fromYear = Number(from);
  const toYear = Number(to);
  if (fromYear > toYear) return { error: "from_year が to_year より後になっています" };
  if (toYear - fromYear + 1 > MAX_REPORT_YEARS) {
    return { error: `一度に出せるのは ${MAX_REPORT_YEARS} 年までです` };
  }
  const driverRaw = params.get("driver");
  if (driverRaw !== null && !DRIVER_RE.test(driverRaw)) return { error: "driver は乗務員CD (数字) で指定してください" };
  const formatRaw = params.get("format") ?? "json";
  if (formatRaw !== "json" && formatRaw !== "pdf") return { error: "format は json か pdf です" };
  if (formatRaw === "pdf" && driverRaw === null) return { error: "PDF は driver (乗務員CD) の指定が必要です" };
  const rangeParams: Record<string, string> = {};
  for (const name of PASS_PARAMS) {
    const v = params.get(name);
    if (v === null) continue;
    if (!PASS_PARAM_RE.test(v)) return { error: `${name} の形式が不正です` };
    rangeParams[name] = v;
  }
  return { fromYear, toYear, driver: driverRaw, format: formatRaw, rangeParams };
}

// ---------------------------------------------------------------------------
// 月と突合キー
// ---------------------------------------------------------------------------

/** 年の勤務月 (`YYYY-01`〜`YYYY-12`)。 */
export function yearMonths(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

/**
 * 支給日の年が `year` になる月例の勤務月 (= 勤務月 `year-1`/12 〜 `year`/11)。
 * 給与は勤務月の翌月に支給される (画面全体の前提) ので、1 か月前へずらした 12 か月。
 */
export function adjustmentWorkMonths(year: number): string[] {
  return [`${year - 1}-12`, ...yearMonths(year).slice(0, 11)];
}

/** 乗務員CD の突合キー (前ゼロを除く)。期間集計と給与の両側をこれで揃える。 */
export function driverKey(cd: string): string {
  const n = Number(cd);
  return Number.isFinite(n) ? String(n) : cd;
}

/** 社員マスタの 1 行 (`employees` の突合に要る列)。 */
export interface EmployeeCdRow {
  company: string;
  payrollCd: string;
  name: string;
  driverCd: string | null;
}

/** `salaryCdMapKey` (app/utils/salary-compare.ts) と同じキー: "会社|給与コード(前ゼロ除去)|氏名"。 */
function cdMapKey(company: string, payrollCd: string, name: string): string {
  return `${company.normalize("NFKC").trim()}|${String(Number(payrollCd))}|${normalizeNameKey(name)}`;
}

/** 社員マスタ → 「会社|給与コード|氏名 → 乗務員CD」 (`buildCdMapEntries` と同じ)。 */
export function buildCdMap(employees: readonly EmployeeCdRow[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of employees) {
    if (e.driverCd) map.set(cdMapKey(e.company, e.payrollCd, e.name), e.driverCd);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 期間集計 (`wage-range`) の読み
// ---------------------------------------------------------------------------

/** 3 段 (基本給 / 残業代 / 合計)。片側が無ければ null。 */
export interface Amount3 {
  base: number | null;
  overtime: number | null;
  total: number | null;
}

export interface RowAttrs {
  company: string | null;
  branchCode: number | null;
  branchName: string | null;
  jobName: string | null;
}

/** 期間集計の 1 か月 (月の状態)。 */
export interface RangeMonth {
  ym: string;
  saved: boolean;
  stale: boolean | null;
  excluded: string | null;
}

interface RangeAmounts {
  calcBase: number | null;
  calcOvertime: number | null;
  calcTotal: number | null;
  paidBase: number | null;
  paidOvertime: number | null;
  hourlyRate: number | null;
  workingMinutes: number | null;
}

interface RangeRow {
  driverCd: string;
  driverName: string;
  attrs: RowAttrs;
  byMonth: Record<string, RangeAmounts>;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

/** `wage-range` の応答から、補填の判定と PDF に要る列だけを読む (`parseWageRange` の部分集合)。 */
export function parseRange(body: unknown): { months: RangeMonth[]; rows: RangeRow[] } {
  const b = asRecord(body);
  const months = (Array.isArray(b.months) ? b.months : []).map((m) => {
    const r = asRecord(m);
    return {
      ym: str(r.ym),
      saved: r.saved === true,
      stale: typeof r.stale === "boolean" ? r.stale : null,
      excluded: strOrNull(r.excluded),
    };
  });
  const rows = (Array.isArray(b.rows) ? b.rows : []).map((row) => {
    const r = asRecord(row);
    const byMonth: Record<string, RangeAmounts> = {};
    for (const [ym, v] of Object.entries(asRecord(r.by_month))) {
      const a = asRecord(v);
      byMonth[ym] = {
        calcBase: num(a.calc_base),
        calcOvertime: num(a.calc_overtime),
        calcTotal: num(a.calc_total),
        paidBase: num(a.paid_base),
        paidOvertime: num(a.paid_overtime),
        hourlyRate: num(a.hourly_rate),
        workingMinutes: num(a.working_minutes),
      };
    }
    return {
      driverCd: String(r.driver_cd ?? ""),
      driverName: str(r.driver_name),
      attrs: {
        company: strOrNull(r.company),
        branchCode: num(r.branch_code),
        branchName: strOrNull(r.branch_name),
        jobName: strOrNull(r.job_name),
      },
      byMonth,
    };
  });
  return { months, rows };
}

/** 1 か月の計算・給与・差 (`monthDiff` と同じ定義)。 */
export interface MonthLine {
  ym: string;
  workingMinutes: number | null;
  /** 最低賃金の時給 (その月の計算に使った単価)。 */
  hourlyRate: number | null;
  calc: Amount3;
  paid: Amount3;
  /** 給与 − 計算。片側が無ければ null。 */
  diff: Amount3;
}

function monthLine(ym: string, a: RangeAmounts | undefined): MonthLine {
  const paidTotal = a?.paidBase == null || a.paidOvertime == null ? null : a.paidBase + a.paidOvertime;
  const d = (p: number | null | undefined, c: number | null | undefined) => (p == null || c == null ? null : p - c);
  return {
    ym,
    workingMinutes: a?.workingMinutes ?? null,
    hourlyRate: a?.hourlyRate ?? null,
    calc: { base: a?.calcBase ?? null, overtime: a?.calcOvertime ?? null, total: a?.calcTotal ?? null },
    paid: { base: a?.paidBase ?? null, overtime: a?.paidOvertime ?? null, total: paidTotal },
    diff: { base: d(a?.paidBase, a?.calcBase), overtime: d(a?.paidOvertime, a?.calcOvertime), total: d(paidTotal, a?.calcTotal) },
  };
}

/** 1 乗務員 × 1 年の不足。 */
export interface YearShortfall {
  /** 不足額の合計 (正の円)。不足の月が無ければ 0。 */
  shortfall: number;
  /** 差がマイナスだった勤務月。 */
  shortfallMonths: string[];
  /** 差が出せた (集計に入った) 月の数。 */
  countedMonths: number;
  /** 差が出せなかった勤務月 (未保存・欠測・給与未取込)。0 円の月ではない。 */
  missingMonths: string[];
}

export function yearShortfall(lines: readonly MonthLine[]): YearShortfall {
  const out: YearShortfall = { shortfall: 0, shortfallMonths: [], countedMonths: 0, missingMonths: [] };
  for (const line of lines) {
    const d = line.diff.total;
    if (d == null) {
      out.missingMonths.push(line.ym);
      continue;
    }
    out.countedMonths += 1;
    if (d < 0) {
      out.shortfall += -d;
      out.shortfallMonths.push(line.ym);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 賞与・月例 (給与大臣 Worker の `/kyuyo/{bonus,payroll}`)
// ---------------------------------------------------------------------------

/** 給与大臣の応答から補填に要るものだけ。 */
export interface KyuyoBody {
  rows: Array<{
    employeeCode: string;
    employeeCodeKey: string;
    employeeName: string;
    payDate: string;
    payments: Record<string, number>;
  }>;
  warnings: string[];
  source: "cache" | "live" | null;
  syncedAt: string | null;
}

/** `/kyuyo/{bonus,payroll}` の応答を読む (`toStoredPayroll` と同じく rows 配列 + database 文字列を要る)。 */
export function parseKyuyoBody(body: unknown, label: string): KyuyoBody {
  const b = asRecord(body);
  if (!Array.isArray(b.rows) || typeof b.database !== "string") {
    throw new AnnualReportError(502, `${label} の応答形式が想定外でした`);
  }
  const rows = b.rows.map((row) => {
    const r = asRecord(row);
    const payments: Record<string, number> = {};
    for (const [k, v] of Object.entries(asRecord(r.payments))) {
      const n = num(v);
      if (n !== null) payments[k] = n;
    }
    return {
      employeeCode: str(r.employee_code),
      employeeCodeKey: str(r.employee_code_key),
      employeeName: str(r.employee_name),
      payDate: str(r.pay_date),
      payments,
    };
  });
  const warnings = Array.isArray(b.warnings) ? b.warnings.filter((w): w is string => typeof w === "string") : [];
  const source = b.source === "cache" || b.source === "live" ? b.source : null;
  return { rows, warnings, source, syncedAt: strOrNull(b.synced_at) };
}

const PAY_DATE_RE = /^(\d{4})-\d{2}-\d{2}$/;

/** 1 回の支給 (就労調整金)。 */
export interface AdjustmentEntry {
  payDate: string;
  kind: "bonus" | "payroll";
  company: string;
  amount: number;
}

/** 1 乗務員の補填。 */
export interface DriverAdjustment {
  driverName: string;
  /** "会社:給与社員CD" (PDF の見出し用)。 */
  payrollCodes: string[];
  entries: AdjustmentEntry[];
}

/**
 * 支給日の年が `year` の行から「就労調整金」を乗務員ごとに集める。
 * 0 円・項目なし・支給日が壊れた行は数えない。乗務員は社員マスタで引き、
 * 引けなければ給与側の `employee_code_key` (= 給与社員CD がそのまま乗務員CD の会社) で突き合わせる。
 */
export function collectAdjustments(
  sources: ReadonlyArray<{ kind: "bonus" | "payroll"; company: string; body: KyuyoBody }>,
  cdMap: ReadonlyMap<string, string>,
  year: number,
): Map<string, DriverAdjustment> {
  const out = new Map<string, DriverAdjustment>();
  for (const { kind, company, body } of sources) {
    for (const row of body.rows) {
      const matched = PAY_DATE_RE.exec(row.payDate);
      if (!matched || Number(matched[1]) !== year) continue;
      const amount = row.payments[ADJUSTMENT_ITEM_LABEL] ?? 0;
      if (amount === 0) continue;
      const mapped = cdMap.get(cdMapKey(company, row.employeeCode, row.employeeName));
      const key = driverKey(mapped === undefined ? row.employeeCodeKey : String(Number(mapped)));
      const cur = out.get(key) ?? { driverName: row.employeeName, payrollCodes: [], entries: [] };
      const code = `${company}:${row.employeeCode}`;
      if (!cur.payrollCodes.includes(code)) cur.payrollCodes.push(code);
      cur.entries.push({ payDate: row.payDate, kind, company, amount });
      out.set(key, cur);
    }
  }
  for (const adj of out.values()) adj.entries.sort((a, b) => a.payDate.localeCompare(b.payDate));
  return out;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/** `unmatched` = 期間集計にこの乗務員の行が無く、不足を数えられない。 */
export type AdjustmentStatus = "no-shortfall" | "covered" | "short" | "unmatched";

export interface AdjustmentJudgement {
  status: AdjustmentStatus;
  /** 補填しきれていない不足額 (`short` のときだけ正、それ以外は 0)。 */
  remaining: number;
  /** 12 か月そろっていない (未集計の月がある)。判定はその月を含まない。 */
  incomplete: boolean;
  /** 画面と PDF に出す 1 文。 */
  label: string;
}

/**
 * 期間集計に行が無い人の判定。「不足なし」とは書かない — 不足は 0 ではなく**数えられない**。
 * 多いのは給与社員CD が社員マスタで乗務員CD に対応付いていない人 (その場合 CD 欄は給与社員CD)。
 */
const UNMATCHED: AdjustmentJudgement = {
  status: "unmatched",
  remaining: 0,
  incomplete: true,
  label: "不足を数えられない (期間集計に行が無い — 社員マスタで乗務員CD の対応を確認)",
};

/** 円の 3 桁区切り。 */
export function fmtYen(n: number): string {
  return n.toLocaleString("ja-JP");
}

/**
 * 不足合計 ≤ 補填合計 なら補填済み、超えれば残りの不足額。
 * **未集計の月がある間は言い切らない** — 文に「N か月未集計」を必ず添える。
 */
export function judgeAdjustment(shortfall: number, adjustment: number, missingMonths: number): AdjustmentJudgement {
  const incomplete = missingMonths > 0;
  const suffix = incomplete ? ` (${missingMonths} か月未集計のため確定でない)` : "";
  if (shortfall === 0) return { status: "no-shortfall", remaining: 0, incomplete, label: `不足なし${suffix}` };
  if (shortfall <= adjustment) return { status: "covered", remaining: 0, incomplete, label: `補填済み${suffix}` };
  const remaining = shortfall - adjustment;
  return { status: "short", remaining, incomplete, label: `残り不足 ${fmtYen(remaining)} 円${suffix}` };
}

// ---------------------------------------------------------------------------
// 組み立て
// ---------------------------------------------------------------------------

/** 年の補填の 1 行 (1 乗務員 × 1 年)。 */
export interface AnnualRow {
  driverCd: string;
  driverName: string;
  /** 期間集計 (社員マスタ) の属性。期間集計に行が無い人は null。 */
  attrs: RowAttrs | null;
  payrollCodes: string[];
  /** 12 か月。期間集計に行が無い人は空。 */
  months: MonthLine[];
  /** 期間集計に行が無い人は null (不足を数えられない)。 */
  shortfall: YearShortfall | null;
  adjustments: AdjustmentEntry[];
  bonus: number;
  payroll: number;
  adjustment: number;
  judgement: AdjustmentJudgement;
}

export interface AnnualYear {
  year: number;
  /** 期間集計の材料が揃っていない月 (未保存・要再計算・月ごと除外)。 */
  incompleteMonths: string[];
  /** 賞与の鮮度 ("会社: 保存済み 同期 …")。返さない版の応答なら空。 */
  bonusFreshness: string;
  warnings: string[];
  rows: AnnualRow[];
}

export interface AnnualReport {
  fromYear: number;
  toYear: number;
  driver: string | null;
  years: AnnualYear[];
}

/** 読み先 (DO が D1・勤怠 Worker・給与大臣 Worker を渡す)。どれも失敗は throw。 */
export interface AnnualReportSources {
  employees(): Promise<EmployeeCdRow[]>;
  payrollCompanies(): Promise<string[]>;
  wageRange(from: string, to: string): Promise<unknown>;
  kyuyo(path: "bonus" | "payroll", query: Record<string, string>): Promise<unknown>;
}

function sumAmounts(entries: readonly AdjustmentEntry[], kind: AdjustmentEntry["kind"]): number {
  return entries.reduce((s, e) => (e.kind === kind ? s + e.amount : s), 0);
}

function buildRow(
  base: { driverCd: string; driverName: string; attrs: RowAttrs | null; months: MonthLine[] },
  adj: DriverAdjustment | undefined,
): AnnualRow {
  const entries = adj?.entries ?? [];
  const bonus = sumAmounts(entries, "bonus");
  const payroll = sumAmounts(entries, "payroll");
  const shortfall = base.months.length ? yearShortfall(base.months) : null;
  return {
    ...base,
    payrollCodes: adj?.payrollCodes ?? [],
    shortfall,
    adjustments: entries,
    bonus,
    payroll,
    adjustment: bonus + payroll,
    judgement: shortfall
      ? judgeAdjustment(shortfall.shortfall, bonus + payroll, shortfall.missingMonths.length)
      : UNMATCHED,
  };
}

/**
 * 期間集計の行と補填を乗務員で突き合わせる。期間集計に居ない人 (補填だけある) も落とさない。
 * `driver` を渡すとその 1 名だけ (どちらにも居なくても空の行を 1 本返す — PDF のページを欠かさない)。
 */
export function buildYearRows(
  range: { rows: RangeRow[] },
  adjustments: ReadonlyMap<string, DriverAdjustment>,
  year: number,
  driver: string | null,
): AnnualRow[] {
  const want = driver === null ? null : driverKey(driver);
  const rows: AnnualRow[] = [];
  const seen = new Set<string>();
  for (const r of range.rows) {
    const key = driverKey(r.driverCd);
    if (want !== null && key !== want) continue;
    seen.add(key);
    const months = yearMonths(year).map((ym) => monthLine(ym, r.byMonth[ym]));
    rows.push(buildRow({ driverCd: r.driverCd, driverName: r.driverName, attrs: r.attrs, months }, adjustments.get(key)));
  }
  for (const [key, adj] of adjustments) {
    if (seen.has(key) || (want !== null && key !== want)) continue;
    seen.add(key);
    rows.push(buildRow({ driverCd: key, driverName: adj.driverName, attrs: null, months: [] }, adj));
  }
  if (want !== null && !seen.has(want)) {
    rows.push(buildRow({ driverCd: want, driverName: "", attrs: null, months: [] }, undefined));
  }
  return rows;
}

/** 賞与の鮮度の 1 文 (旧 `describeBonusFreshness`)。どちらも判らない会社は出さない。 */
export function describeBonusFreshness(
  entries: ReadonlyArray<{ company: string; source: "cache" | "live" | null; syncedAt: string | null }>,
): string {
  return entries
    .filter((e) => e.source !== null || e.syncedAt !== null)
    .map((e) => {
      const src = e.source === "cache" ? "保存済み" : e.source === "live" ? "給与大臣から直接" : "";
      const at = e.syncedAt ? `${src ? " " : ""}同期 ${e.syncedAt}` : "";
      return `${e.company}: ${src}${at}`;
    })
    .join(" / ");
}

/**
 * 年間レポートを組み立てる。読む順序は冒頭の doc。**途中で 1 本でも失敗したら全体を失敗にする** —
 * 補填の一部だけで判定すると「残り不足」を過大に出すため。
 */
export async function buildAnnualReport(sources: AnnualReportSources, query: AnnualReportQuery): Promise<AnnualReport> {
  const employees = await sources.employees();
  const cdMap = buildCdMap(employees);
  const companies = await sources.payrollCompanies();
  if (!companies.length) {
    throw new AnnualReportError(
      400,
      "この会社に対応する給与大臣の会社が登録されていません (社員マスタタブの会社対応表)",
    );
  }
  const years: AnnualYear[] = [];
  for (let year = query.fromYear; year <= query.toYear; year++) {
    const range = parseRange(await sources.wageRange(`${year}-01`, `${year}-12`));
    const kyuyoSources: Array<{ kind: "bonus" | "payroll"; company: string; body: KyuyoBody }> = [];
    const freshness: Array<{ company: string; source: "cache" | "live" | null; syncedAt: string | null }> = [];
    const warnings: string[] = [];
    for (const company of companies) {
      const body = parseKyuyoBody(await sources.kyuyo("bonus", { company, year: String(year) }), `賞与 ${company} / ${year} 年`);
      kyuyoSources.push({ kind: "bonus", company, body });
      freshness.push({ company, source: body.source, syncedAt: body.syncedAt });
      warnings.push(...body.warnings.map((w) => `賞与 ${company}: ${w}`));
    }
    for (const workMonth of adjustmentWorkMonths(year)) {
      for (const company of companies) {
        const body = parseKyuyoBody(
          await sources.kyuyo("payroll", { company, month: workMonth }),
          `月例 ${company} / 勤務月 ${workMonth}`,
        );
        kyuyoSources.push({ kind: "payroll", company, body });
      }
    }
    years.push({
      year,
      incompleteMonths: range.months.filter((m) => !m.saved || m.excluded !== null || m.stale === true).map((m) => m.ym),
      bonusFreshness: describeBonusFreshness(freshness),
      warnings,
      rows: buildYearRows(range, collectAdjustments(kyuyoSources, cdMap, year), year, query.driver),
    });
  }
  return { fromYear: query.fromYear, toYear: query.toYear, driver: query.driver, years };
}

// ---------------------------------------------------------------------------
// 給与大臣 Worker の読み (service binding)
// ---------------------------------------------------------------------------

interface FetcherLike {
  fetch(request: Request): Promise<Response>;
}

/** 給与大臣へ渡す token の種類。`browser` = ブラウザ JWT、`mcp` = kyuyo-mcp の binding_jwt。 */
export type KyuyoAuthMode = "browser" | "mcp";

/**
 * 給与大臣 Worker の `GET /kyuyo/{bonus,payroll}` を読む。**ブラウザ JWT をそのまま `Authorization` で
 * 渡す** (front の `server/utils/kyuyo-upstream.ts` と同じ。認可は給与大臣 Worker 側の JWT + allowlist)。
 * path は 2 つに固定 (`..` で同じ Worker の別の口へ届かないよう、呼び手に組み立てさせない)。
 * 401 / 403 はそのまま返し、それ以外の失敗は 502。
 *
 * `authMode: "mcp"` は MCP (kyuyo-mcp) の binding_jwt を渡すとき。`X-Kyuyo-Auth: mcp` を付け、
 * 給与大臣 Worker に auth-worker の `authorizeMcp` で検証させる (ヘッダは検証器を選ぶだけで、
 * どちらの検証器も署名を検証する。ohishi-exp/rust-ichibanboshi#421)。
 */
export async function fetchKyuyoJson(
  binding: FetcherLike | undefined,
  authorization: string | null,
  path: "bonus" | "payroll",
  query: Record<string, string>,
  authMode: KyuyoAuthMode = "browser",
): Promise<unknown> {
  if (!binding) throw new AnnualReportError(503, "給与大臣 Worker (ICHIBAN_KYUYO) が使えません");
  if (!authorization) throw new AnnualReportError(401, "給与大臣を読むための認証情報がありません");
  const headers: Record<string, string> = { Authorization: authorization };
  if (authMode === "mcp") headers["X-Kyuyo-Auth"] = "mcp";
  let res: Response;
  try {
    res = await binding.fetch(
      new Request(`https://ichibanboshi-kyuyo/kyuyo/${path}?${new URLSearchParams(query)}`, { headers }),
    );
  } catch (err) {
    throw new AnnualReportError(502, `給与大臣 Worker への接続に失敗しました: ${String(err)}`);
  }
  if (!res.ok) {
    const text = (await res.text()).trim().slice(0, 200);
    const status = res.status === 401 || res.status === 403 ? res.status : 502;
    throw new AnnualReportError(status, `給与大臣 (${path}) が status ${res.status} を返しました${text ? `: ${text}` : ""}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// HTML (PDF の元)
// ---------------------------------------------------------------------------

/** HTML 本文へ埋める文字列のエスケープ (氏名・営業所名・給与側の警告は外から来る)。 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function yen(n: number | null): string {
  return n == null ? "" : fmtYen(n);
}

/** 差の表示 (+12,345 / −12,345)。マイナスは全角でなく U+2212。 */
function signed(n: number | null): string {
  if (n == null) return "";
  return n < 0 ? `−${fmtYen(-n)}` : `+${fmtYen(n)}`;
}

function hm(minutes: number | null): string {
  if (minutes == null) return "—";
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function monthNo(ym: string): string {
  return `${Number(ym.slice(5, 7))}月`;
}

const KIND_LABEL: Record<AdjustmentEntry["kind"], string> = { bonus: "賞与", payroll: "月例" };

const STATUS_CLASS: Record<AdjustmentStatus, string> = {
  "no-shortfall": "ok",
  covered: "ok",
  short: "ng",
  unmatched: "warn",
};

const CSS = `
@page{size:A4 landscape;margin:8mm} body{font-family:'Noto Sans CJK JP','Noto Sans JP',sans-serif;font-size:9pt;color:#111;margin:0}
section{page-break-after:always} section:last-child{page-break-after:auto}
h1{font-size:14pt;margin:0 0 2mm} .sub{color:#555;margin-bottom:4mm}
.kv{display:flex;gap:6mm;margin-bottom:3mm} .card{border:1px solid #bbb;border-radius:2mm;padding:1.8mm 4mm} .card .l{font-size:8.5pt;color:#555} .card .v{font-size:12.5pt;font-weight:700}
.ok{border-color:#2a8a4a;background:#eef8f1} .ok .v{color:#1e6b38} .ng{border-color:#b00020;background:#fdecee} .ng .v{color:#b00020} .warn{border-color:#b26a00;background:#fff6e5} .warn .v{color:#8a5200}
table{border-collapse:collapse;width:100%} th,td{border:1px solid #bbb;padding:.45mm 2mm;text-align:right} th{background:#f0f0f0;text-align:center;font-weight:600} td:first-child{text-align:center}
.b{font-weight:700} .m{color:#b00020} tr.neg td{background:#fdecee} tr.tot td{background:#f6f6f6;font-weight:700}
h2{font-size:11.5pt;margin:3mm 0 1.5mm} ul{margin:0;padding-left:5mm} li{margin:.6mm 0} .small{font-size:8pt;color:#444}
.two{display:flex;gap:6mm} .two>div{flex:1} .none{color:#666;margin:6mm 0}
`;

function monthTable(row: AnnualRow): string {
  const cell = (n: number | null, extra = "") => `<td class='${extra}${n != null && n < 0 ? " m" : ""}'>${signed(n)}</td>`;
  const lines = row.months.map((l) => {
    const neg = l.diff.total != null && l.diff.total < 0;
    return (
      `<tr class='${neg ? "neg" : ""}'><td>${monthNo(l.ym)}</td><td>${hm(l.workingMinutes)}</td>` +
      `<td>${yen(l.calc.base)}</td><td>${yen(l.calc.overtime)}</td><td class='b'>${yen(l.calc.total)}</td>` +
      `<td>${yen(l.paid.base)}</td><td>${yen(l.paid.overtime)}</td><td class='b'>${yen(l.paid.total)}</td>` +
      `${cell(l.diff.base)}${cell(l.diff.overtime)}${cell(l.diff.total, "b")}</tr>`
    );
  });
  // 年計は 3 つの「合計」列だけ。差が出せた月 (= 集計に入った月) だけを足す
  const counted = row.months.filter((l) => l.diff.total != null);
  const sum = (pick: (l: MonthLine) => number | null) => counted.reduce((s, l) => s + (pick(l) as number), 0);
  const tot = counted.length
    ? `<tr class='tot'><td>年計</td><td></td><td></td><td></td><td class='b'>${yen(sum((l) => l.calc.total))}</td>` +
      `<td></td><td></td><td class='b'>${yen(sum((l) => l.paid.total))}</td><td></td><td></td>` +
      `${cell(sum((l) => l.diff.total), "b")}</tr>`
    : "";
  return (
    "<table><tr><th rowspan=2>勤務月</th><th rowspan=2>実働</th><th colspan=3>計算 (最低賃金で計算した額)</th>" +
    "<th colspan=3>給与 (実際の支給)</th><th colspan=3>差 (給与 − 計算)</th></tr>" +
    "<tr><th>基本給</th><th>残業代</th><th>合計</th><th>基本給</th><th>残業代</th><th>合計</th><th>基本給</th><th>残業代</th><th>合計</th></tr>" +
    `${lines.join("")}${tot}</table>`
  );
}

function adjustmentTable(row: AnnualRow): string {
  if (!row.adjustments.length) return "<p class='none'>この年の支給日の就労調整金はありません。</p>";
  const lines = row.adjustments.map(
    (e) => `<tr><td>${escapeHtml(e.payDate)}</td><td>${KIND_LABEL[e.kind]}</td><td>${escapeHtml(e.company)}</td><td>${fmtYen(e.amount)}</td></tr>`,
  );
  return (
    "<table style='width:auto'><tr><th>支給日</th><th>区分</th><th>会社</th><th>金額</th></tr>" +
    `${lines.join("")}<tr class='tot'><td>合計</td><td></td><td></td><td>${fmtYen(row.adjustment)}</td></tr></table>`
  );
}

/** 単価の移り変わり ("1〜9月 1,000 円 / 10〜12月 1,050 円")。 */
function rateNote(row: AnnualRow): string | null {
  const spans: Array<{ rate: number; from: string; to: string }> = [];
  for (const l of row.months) {
    if (l.hourlyRate == null) continue;
    const last = spans[spans.length - 1];
    if (last && last.rate === l.hourlyRate) last.to = l.ym;
    else spans.push({ rate: l.hourlyRate, from: l.ym, to: l.ym });
  }
  if (!spans.length) return null;
  const label = (s: { from: string; to: string }) =>
    s.from === s.to ? monthNo(s.from) : `${Number(s.from.slice(5, 7))}〜${monthNo(s.to)}`;
  return `最低賃金の単価 (時給): ${spans.map((s) => `${label(s)} ${fmtYen(s.rate)} 円`).join(" / ")}。`;
}

function notes(year: AnnualYear, row: AnnualRow): string[] {
  const out = [
    "出典: dtako 管理画面「拘束×賃金」の期間集計 (最低賃金チェックの保存済みの値) と、給与大臣の賞与・月例給与の「就労調整金」。",
  ];
  const rate = rateNote(row);
  if (rate) out.push(rate);
  if (row.shortfall?.missingMonths.length) {
    out.push(
      `${row.shortfall.missingMonths.map(monthNo).join("・")} は差が出せない (未保存・欠測・給与未取込) ため不足合計に入っていません。0 円の月ではありません。`,
    );
  }
  if (year.incompleteMonths.length) {
    out.push(`会社全体で集計の材料が揃っていない月 (未保存・要再計算・除外): ${year.incompleteMonths.map(monthNo).join("・")}。`);
  }
  const partial = row.months.filter((l) => l.diff.total != null && (l.diff.base == null || l.diff.overtime == null));
  if (partial.length) out.push(`${partial.map((l) => monthNo(l.ym)).join("・")} は合計のみ (基本給・残業代の内訳が無い)。`);
  if (year.bonusFreshness) out.push(`賞与: ${year.bonusFreshness}。`);
  if (year.warnings.length) {
    out.push(`給与大臣の警告 ${year.warnings.length} 件 (会社全体): ${year.warnings.slice(0, 3).join(" / ")}。`);
  }
  return out;
}

function yearSection(year: AnnualYear, row: AnnualRow, generatedAt: string): string {
  const s = row.shortfall;
  const head =
    `<h1>最低賃金チェック 年間レポート — ${year.year} 年</h1>` +
    `<div class=sub>乗務員CD ${escapeHtml(row.driverCd)}${row.driverName ? ` / ${escapeHtml(row.driverName)}` : ""}` +
    `${row.attrs?.branchName ? ` / ${escapeHtml(row.attrs.branchName)}` : ""}` +
    `${row.payrollCodes.length ? ` (給与社員CD ${row.payrollCodes.map(escapeHtml).join(", ")})` : ""}　|　作成 ${escapeHtml(generatedAt)}</div>`;
  const bonusCount = row.adjustments.filter((e) => e.kind === "bonus").length;
  const payrollCount = row.adjustments.length - bonusCount;
  const cmp = s ? `不足 ${fmtYen(s.shortfall)} 円 ${s.shortfall <= row.adjustment ? "≦" : "＞"} 補填 ${fmtYen(row.adjustment)} 円` : "";
  const cards =
    "<div class=kv>" +
    `<div class=card><div class=l>集計月</div><div class=v>${s ? `${s.countedMonths} / 12` : "—"}</div></div>` +
    `<div class=card><div class=l>最低賃金の不足合計</div><div class=v>${s ? `${fmtYen(s.shortfall)} 円` : "—"}</div>` +
    `<div class=l>${s?.shortfallMonths.length ? `不足の月: ${s.shortfallMonths.map(monthNo).join("・")}` : "不足の月: なし"}</div></div>` +
    `<div class=card><div class=l>就労調整金 (${year.year} 年支給)</div><div class=v>${fmtYen(row.adjustment)} 円</div>` +
    `<div class=l>賞与 ${bonusCount} 回・月例 ${payrollCount} 回</div></div>` +
    `<div class='card ${STATUS_CLASS[row.judgement.status]}'><div class=l>判定</div><div class=v>${escapeHtml(row.judgement.label)}</div>` +
    `<div class=l>${cmp}</div></div></div>`;
  const table = row.months.length
    ? `<h2>月ごとの比較 (円)</h2>${monthTable(row)}`
    : "<p class='none'>この年の期間集計にこの乗務員の行がありません (不足を数えられません)。</p>";
  const rules =
    "<h2>判定のきまり</h2><ul>" +
    "<li>年 = 勤務月 1〜12 月 (月末締め・翌月払い)。</li>" +
    "<li>不足合計 = 「給与 − 計算」(合計) がマイナスだった月の不足額の合計。プラスの月とは相殺しない。</li>" +
    "<li>補填 = 支給日がその年の「就労調整金」(賞与 + 月例。月例は勤務月 前年12月〜11月)。</li>" +
    "<li>不足合計 ≦ 補填 のとき「補填済み」。未集計の月があるときは確定としない。</li></ul>";
  const noteList = `<h2>データの出どころと注記</h2><ul class=small>${notes(year, row)
    .map((n) => `<li>${escapeHtml(n)}</li>`)
    .join("")}</ul>`;
  return (
    `<section>${head}${cards}${table}<div class=two><div><h2>就労調整金 (給与大臣)</h2>${adjustmentTable(row)}</div>` +
    `<div>${rules}</div><div style='flex:1.6'>${noteList}</div></div></section>`
  );
}

/**
 * 1 乗務員 × 複数年のレポート HTML (1 年 1 ページ、A4 横)。`report.driver` 付きで組んだものを渡す
 * (各年の行は {@link buildYearRows} が必ず 1 本作る)。`generatedAt` は作成日 (JST の YYYY-MM-DD)。
 */
export function renderAnnualReportHtml(report: AnnualReport, generatedAt: string): string {
  const sections = report.years.map((y) => yearSection(y, y.rows[0]!, generatedAt));
  const title = `最低賃金 年間レポート ${report.driver ?? ""} ${report.fromYear}-${report.toYear}`;
  return `<!doctype html><html lang=ja><meta charset=utf-8><title>${escapeHtml(title)}</title><style>${CSS}</style><body>${sections.join("")}</body></html>`;
}

/** JST の日付 (YYYY-MM-DD)。 */
export function jstDate(nowMs: number): string {
  return new Date(nowMs + 9 * 3600_000).toISOString().slice(0, 10);
}

/** ダウンロード名。乗務員CD と年だけ (氏名は入れない — 保存先のファイル一覧に名前を残さない)。 */
export function reportFilename(report: AnnualReport): string {
  const years = report.fromYear === report.toYear ? `${report.fromYear}` : `${report.fromYear}-${report.toYear}`;
  return `min-wage-annual_${report.driver ?? "all"}_${years}.pdf`;
}

// ---------------------------------------------------------------------------
// 口の本体 (画面の `/restraint-api/min-wage-annual-report` と MCP 用の
// `/kintai-relay/min-wage-annual-report` が共有する。門は呼び手が先に通す)
// ---------------------------------------------------------------------------

interface D1Like {
  prepare(sql: string): { bind(...args: unknown[]): { all<T>(): Promise<{ results?: T[] }> } };
}

export interface AnnualReportRequest {
  /** 認可済みの会社 (呼び手に名乗らせない。画面はセッション、MCP 用の口は `KINTAI_COMP_ID`)。 */
  compId: string;
  params: URLSearchParams;
  /** 社員マスタ・会社対応表 (`DTAKO_DB`)。無ければ 503。 */
  db: D1Like | undefined;
  /** 勤怠 Worker の読み (期間集計 `wage-range`)。 */
  deps: Pick<KintaiRelayDeps, "gcp">;
  /** 給与大臣 Worker (`ICHIBAN_KYUYO`)。 */
  kyuyo: FetcherLike | undefined;
  /** 給与大臣へそのまま渡す `Authorization` (リクエスト自身のもの)。 */
  authorization: string | null;
  authMode: KyuyoAuthMode;
  /** HTML → PDF。BROWSER が無い環境は `null` (PDF の要求は 503)。 */
  pdf: ((html: string) => Promise<Uint8Array>) | null;
  /** PDF から氏名を除く (MCP 用。応答は Claude に渡るので #374 の合意どおり氏名を出さない)。 */
  withoutNames: boolean;
  /** 作成日 (JST) の基準時刻。 */
  now: number;
}

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/** 行の氏名を空にした写し (テンプレは空の氏名を出さない)。 */
export function withoutDriverNames(report: AnnualReport): AnnualReport {
  return {
    ...report,
    years: report.years.map((y) => ({ ...y, rows: y.rows.map((r) => ({ ...r, driverName: "" })) })),
  };
}

/**
 * クエリの検証 → 組み立て → JSON か PDF。失敗は `{error}` (AnnualReportError はその status、他は 502)。
 * 門 (tenant・1 社・給与 allowlist) は呼び手が先に通すこと — ここは 1 つも見ない。
 */
export async function respondAnnualReport(req: AnnualReportRequest): Promise<Response> {
  const query = parseAnnualReportQuery(req.params);
  if ("error" in query) return jsonError(400, query.error);
  const db = req.db;
  if (!db) return jsonError(503, "社員マスタ (DTAKO_DB) が未設定です");
  if (query.format === "pdf" && !req.pdf) {
    return jsonError(503, "PDF の作成 (Browser Rendering の BROWSER) が使えません");
  }
  const { compId } = req;
  try {
    const built = await buildAnnualReport(
      {
        employees: async () =>
          ((
            await db
              .prepare(`SELECT company, payroll_cd, name, driver_cd FROM employees WHERE comp_id = ?`)
              .bind(compId)
              .all<{ company: string; payroll_cd: string; name: string; driver_cd: string | null }>()
          ).results ?? []).map((r) => ({ company: r.company, payrollCd: r.payroll_cd, name: r.name, driverCd: r.driver_cd })),
        payrollCompanies: async () =>
          ((
            await db
              .prepare(`SELECT payroll_company FROM comp_payroll_map WHERE comp_id = ? ORDER BY sort_order, payroll_company`)
              .bind(compId)
              .all<{ payroll_company: string }>()
          ).results ?? []).map((r) => r.payroll_company),
        wageRange: (from, to) =>
          relayWageRangeGet(req.deps, compId, new URLSearchParams({ ...query.rangeParams, from, to })),
        kyuyo: (path, q) => fetchKyuyoJson(req.kyuyo, req.authorization, path, q, req.authMode),
      },
      query,
    );
    const report = req.withoutNames ? withoutDriverNames(built) : built;
    if (query.format === "json") return Response.json(report);
    const pdf = await req.pdf!(renderAnnualReportHtml(report, jstDate(req.now)));
    return new Response(pdf, {
      headers: {
        "content-type": "application/pdf",
        "content-disposition": `attachment; filename="${reportFilename(report)}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const message = describeUnknownError(err);
    console.error(JSON.stringify({ min_wage_annual_report: "error", comp_id: compId, error: message }));
    const status = err instanceof AnnualReportError ? err.status : 502;
    return jsonError(status, `最低賃金 年間レポートを作れませんでした: ${err instanceof AnnualReportError ? err.message : message}`);
  }
}
