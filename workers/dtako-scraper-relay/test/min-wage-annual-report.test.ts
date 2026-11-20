import { describe, expect, it } from "vitest";
import {
  AnnualReportError,
  adjustmentWorkMonths,
  buildAnnualReport,
  buildCdMap,
  buildYearRows,
  collectAdjustments,
  describeBonusFreshness,
  driverKey,
  escapeHtml,
  fetchKyuyoJson,
  jstDate,
  judgeAdjustment,
  parseAnnualReportQuery,
  parseKyuyoBody,
  parseRange,
  renderAnnualReportHtml,
  withoutDriverNames,
  reportFilename,
  yearMonths,
  type AnnualReport,
  type AnnualReportSources,
  type KyuyoBody,
} from "../src/min-wage-annual-report";

// 名前・金額・コードはすべて架空 (public repo。実在の乗務員の値を写さない)

const q = (s: string) => parseAnnualReportQuery(new URLSearchParams(s));

describe("parseAnnualReportQuery", () => {
  it("既定は json・全員・to_year は from_year と同じ", () => {
    expect(q("from_year=2025")).toEqual({ fromYear: 2025, toYear: 2025, driver: null, format: "json", rangeParams: {} });
  });
  it("pdf + driver + wage-range へ渡す 3 つ", () => {
    expect(q("from_year=2024&to_year=2026&driver=0912&format=pdf&source=gcp&wage_logic_version=v3&salary_item_sha=ab12")).toEqual({
      fromYear: 2024,
      toYear: 2026,
      driver: "0912",
      format: "pdf",
      rangeParams: { source: "gcp", wage_logic_version: "v3", salary_item_sha: "ab12" },
    });
  });
  it.each([
    ["", "from_year / to_year は YYYY で指定してください"],
    ["from_year=2025&to_year=25", "from_year / to_year は YYYY で指定してください"],
    ["from_year=2026&to_year=2025", "from_year が to_year より後になっています"],
    ["from_year=2020&to_year=2025", "一度に出せるのは 5 年までです"],
    ["from_year=2025&driver=abc", "driver は乗務員CD (数字) で指定してください"],
    ["from_year=2025&format=csv", "format は json か pdf です"],
    ["from_year=2025&format=pdf", "PDF は driver (乗務員CD) の指定が必要です"],
    ["from_year=2025&source=../x", "source の形式が不正です"],
  ])("%s → %s", (s, error) => {
    expect(q(s)).toEqual({ error });
  });
});

describe("月と突合キー", () => {
  it("yearMonths / adjustmentWorkMonths (勤務月 前年12月〜11月)", () => {
    expect(yearMonths(2025)).toHaveLength(12);
    expect(yearMonths(2025)[0]).toBe("2025-01");
    expect(adjustmentWorkMonths(2025)).toEqual([
      "2024-12", "2025-01", "2025-02", "2025-03", "2025-04", "2025-05",
      "2025-06", "2025-07", "2025-08", "2025-09", "2025-10", "2025-11",
    ]);
  });
  it("driverKey は前ゼロを落とし、数字でなければそのまま", () => {
    expect(driverKey("00912")).toBe("912");
    expect(driverKey("x1")).toBe("x1");
  });
  it("buildCdMap は乗務員CD の無い行を入れず、キーは 会社(NFKC)|給与コード(前ゼロ除去)|氏名(空白除去)", () => {
    const map = buildCdMap([
      { company: "０１００", payrollCd: "0042", name: "架空 太郎", driverCd: "0912" },
      { company: "0100", payrollCd: "43", name: "架空 次郎", driverCd: null },
    ]);
    expect([...map]).toEqual([["0100|42|架空太郎", "0912"]]);
  });
});

describe("parseRange", () => {
  it("壊れた本文でも落ちず空", () => {
    expect(parseRange(null)).toEqual({ months: [], rows: [] });
    expect(parseRange({ months: "x", rows: 1 })).toEqual({ months: [], rows: [] });
  });
  it("月の状態と行を読む (型の合わない値は null)", () => {
    const got = parseRange({
      months: [{ ym: "2025-01", saved: true, stale: false, excluded: "" }, { ym: 5, stale: "no", excluded: "payroll_missing" }, null],
      rows: [
        {
          driver_cd: 912,
          driver_name: "架空 太郎",
          company: "0100",
          branch_code: 1,
          branch_name: "本社",
          job_name: "乗務員",
          by_month: { "2025-01": { calc_base: 100, calc_overtime: "x", paid_base: 90 }, "2025-02": null },
        },
        null,
      ],
    });
    expect(got.months).toEqual([
      { ym: "2025-01", saved: true, stale: false, excluded: null },
      { ym: "", saved: false, stale: null, excluded: "payroll_missing" },
      { ym: "", saved: false, stale: null, excluded: null },
    ]);
    expect(got.rows[0]).toEqual({
      driverCd: "912",
      driverName: "架空 太郎",
      attrs: { company: "0100", branchCode: 1, branchName: "本社", jobName: "乗務員" },
      byMonth: {
        "2025-01": { calcBase: 100, calcOvertime: null, calcTotal: null, paidBase: 90, paidOvertime: null, hourlyRate: null, workingMinutes: null },
        "2025-02": { calcBase: null, calcOvertime: null, calcTotal: null, paidBase: null, paidOvertime: null, hourlyRate: null, workingMinutes: null },
      },
    });
    expect(got.rows[1]).toEqual({
      driverCd: "",
      driverName: "",
      attrs: { company: null, branchCode: null, branchName: null, jobName: null },
      byMonth: {},
    });
  });
});

describe("parseKyuyoBody", () => {
  it("rows 配列と database 文字列が無ければ 502", () => {
    expect(() => parseKyuyoBody({ rows: [] }, "賞与 0100 / 2025 年")).toThrow(
      new AnnualReportError(502, "賞与 0100 / 2025 年 の応答形式が想定外でした"),
    );
    expect(() => parseKyuyoBody(null, "x")).toThrow(AnnualReportError);
  });
  it("数値でない支給額は落とし、source / synced_at を読む", () => {
    expect(
      parseKyuyoBody(
        {
          database: "db",
          rows: [{ employee_code: "0042", employee_code_key: "42", employee_name: "架空 太郎", pay_date: "2025-08-10", payments: { 就労調整金: 1000, 備考: "x" } }, {}],
          warnings: ["w1", 2],
          source: "cache",
          synced_at: "2025-12-01T00:00:00Z",
        },
        "x",
      ),
    ).toEqual({
      rows: [
        { employeeCode: "0042", employeeCodeKey: "42", employeeName: "架空 太郎", payDate: "2025-08-10", payments: { 就労調整金: 1000 } },
        { employeeCode: "", employeeCodeKey: "", employeeName: "", payDate: "", payments: {} },
      ],
      warnings: ["w1"],
      source: "cache",
      syncedAt: "2025-12-01T00:00:00Z",
    });
    expect(parseKyuyoBody({ database: "db", rows: [], source: "other" }, "x")).toEqual({ rows: [], warnings: [], source: null, syncedAt: null });
    expect(parseKyuyoBody({ database: "db", rows: [], source: "live" }, "x").source).toBe("live");
  });
});

function body(rows: Array<[code: string, key: string, name: string, payDate: string, amount?: number]>): KyuyoBody {
  return {
    rows: rows.map(([employeeCode, employeeCodeKey, employeeName, payDate, amount]) => ({
      employeeCode,
      employeeCodeKey,
      employeeName,
      payDate,
      payments: (amount === undefined ? { 基本給: 1 } : { 就労調整金: amount }) as Record<string, number>,
    })),
    warnings: [],
    source: null,
    syncedAt: null,
  };
}

describe("collectAdjustments", () => {
  const cdMap = buildCdMap([{ company: "0100", payrollCd: "0042", name: "架空 太郎", driverCd: "0912" }]);
  it("支給日の年だけ・0 円と項目なしと壊れた支給日を除き、社員マスタで乗務員CD に寄せる", () => {
    const got = collectAdjustments(
      [
        {
          kind: "bonus",
          company: "0100",
          body: body([
            ["0042", "42", "架空 太郎", "2025-12-20", 300],
            ["0042", "42", "架空 太郎", "2025-08-10", 200],
            ["0042", "42", "架空 太郎", "2024-12-20", 999], // 前年の支給
            ["0042", "42", "架空 太郎", "2025-07-10", 0],
            ["0042", "42", "架空 太郎", "2025-07-10"], // 就労調整金なし
            ["0042", "42", "架空 太郎", "2025/07/10", 5], // 壊れた支給日
          ]),
        },
        // マスタに無い人は給与側の key (前ゼロ除去) のまま
        { kind: "payroll", company: "0200", body: body([["0077", "077", "架空 花子", "2025-03-25", 50], ["0077", "077", "架空 花子", "2025-04-25", 60]]) },
        { kind: "payroll", company: "0100", body: body([["0042", "42", "架空 太郎", "2025-01-25", 10]]) },
      ],
      cdMap,
      2025,
    );
    expect([...got.keys()]).toEqual(["912", "77"]);
    expect(got.get("912")).toEqual({
      driverName: "架空 太郎",
      payrollCodes: ["0100:0042"],
      entries: [
        { payDate: "2025-01-25", kind: "payroll", company: "0100", amount: 10 },
        { payDate: "2025-08-10", kind: "bonus", company: "0100", amount: 200 },
        { payDate: "2025-12-20", kind: "bonus", company: "0100", amount: 300 },
      ],
    });
    expect(got.get("77")!.entries.map((e) => e.amount)).toEqual([50, 60]);
  });
});

describe("judgeAdjustment", () => {
  it.each([
    [0, 0, 0, { status: "no-shortfall", remaining: 0, incomplete: false, label: "不足なし" }],
    [0, 0, 2, { status: "no-shortfall", remaining: 0, incomplete: true, label: "不足なし (2 か月未集計のため確定でない)" }],
    [100, 100, 0, { status: "covered", remaining: 0, incomplete: false, label: "補填済み" }],
    [12345, 345, 1, { status: "short", remaining: 12000, incomplete: true, label: "残り不足 12,000 円 (1 か月未集計のため確定でない)" }],
  ])("不足 %d / 補填 %d / 未集計 %d", (s, a, m, want) => {
    expect(judgeAdjustment(s, a, m)).toEqual(want);
  });
});

/** wage-range の生の 1 行 (by_month)。 */
function rangeRow(cd: string, name: string, byMonth: Record<string, Record<string, number>>) {
  return { driver_cd: cd, driver_name: name, company: "0100", branch_name: "本社", by_month: byMonth };
}
const full = (calcBase: number, calcOt: number, paidBase: number, paidOt: number) => ({
  calc_base: calcBase,
  calc_overtime: calcOt,
  calc_total: calcBase + calcOt,
  paid_base: paidBase,
  paid_overtime: paidOt,
  hourly_rate: 1000,
  working_minutes: 12_345,
});

describe("buildYearRows", () => {
  const range = parseRange({
    rows: [
      rangeRow("0912", "架空 太郎", {
        "2025-01": full(100_000, 50_000, 100_000, 60_000), // +10,000
        "2025-02": full(100_000, 50_000, 95_000, 50_000), // −5,000
        "2025-03": full(100_000, 50_000, 100_000, 47_000), // −3,000
      }),
      rangeRow("0913", "架空 次郎", {}),
    ],
  });
  const adj = collectAdjustments(
    [
      { kind: "bonus", company: "0100", body: body([["912", "912", "架空 太郎", "2025-08-10", 8_000]]) },
      { kind: "payroll", company: "0100", body: body([["555", "555", "架空 三郎", "2025-05-25", 1_000]]) },
    ],
    new Map(),
    2025,
  );

  it("全員: 不足は負の月だけ足し (相殺しない)、期間集計に居ない人も落とさない", () => {
    const rows = buildYearRows(range, adj, 2025, null);
    expect(rows.map((r) => [r.driverCd, r.judgement.status])).toEqual([
      ["0912", "covered"],
      ["0913", "no-shortfall"],
      ["555", "unmatched"],
    ]);
    const taro = rows[0]!;
    expect(taro.shortfall).toEqual({
      shortfall: 8_000,
      shortfallMonths: ["2025-02", "2025-03"],
      countedMonths: 3,
      missingMonths: yearMonths(2025).slice(3),
    });
    expect([taro.bonus, taro.payroll, taro.adjustment]).toEqual([8_000, 0, 8_000]);
    expect(taro.judgement.label).toBe("補填済み (9 か月未集計のため確定でない)");
    expect(taro.months[1]).toEqual({
      ym: "2025-02",
      workingMinutes: 12_345,
      hourlyRate: 1000,
      calc: { base: 100_000, overtime: 50_000, total: 150_000 },
      paid: { base: 95_000, overtime: 50_000, total: 145_000 },
      diff: { base: -5_000, overtime: 0, total: -5_000 },
    });
    expect(taro.months[5]).toEqual({
      ym: "2025-06",
      workingMinutes: null,
      hourlyRate: null,
      calc: { base: null, overtime: null, total: null },
      paid: { base: null, overtime: null, total: null },
      diff: { base: null, overtime: null, total: null },
    });
    const saburo = rows[2]!;
    expect(saburo).toMatchObject({ attrs: null, months: [], shortfall: null, payroll: 1_000, payrollCodes: ["0100:555"] });
    expect(saburo.judgement.label).toBe("不足を数えられない (期間集計に行が無い — 社員マスタで乗務員CD の対応を確認)");
  });

  it("driver 指定: その 1 名だけ (前ゼロ違いでも一致)", () => {
    expect(buildYearRows(range, adj, 2025, "912").map((r) => r.driverCd)).toEqual(["0912"]);
    expect(buildYearRows(range, adj, 2025, "555").map((r) => r.driverCd)).toEqual(["555"]);
  });

  it("driver 指定でどちらにも居なければ空の行を 1 本 (PDF のページを欠かさない)", () => {
    const rows = buildYearRows(range, adj, 2025, "0999");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ driverCd: "999", driverName: "", months: [], adjustment: 0, judgement: { status: "unmatched" } });
  });
});

describe("describeBonusFreshness", () => {
  it("どちらも判らない会社は出さない", () => {
    expect(
      describeBonusFreshness([
        { company: "0100", source: "cache", syncedAt: "T1" },
        { company: "0200", source: "live", syncedAt: null },
        { company: "0300", source: null, syncedAt: "T3" },
        { company: "0400", source: null, syncedAt: null },
      ]),
    ).toBe("0100: 保存済み 同期 T1 / 0200: 給与大臣から直接 / 0300: 同期 T3");
  });
});

/** 読み先の stub。呼ばれた順を記録する。 */
function stubSources(opts: { companies?: string[]; kyuyo?: (path: string, query: Record<string, string>) => unknown } = {}) {
  const calls: string[] = [];
  const sources: AnnualReportSources = {
    employees: async () => (calls.push("employees"), [{ company: "0100", payrollCd: "0042", name: "架空 太郎", driverCd: "0912" }]),
    payrollCompanies: async () => (calls.push("companies"), opts.companies ?? ["0100", "0200"]),
    wageRange: async (from, to) => {
      calls.push(`range ${from}..${to}`);
      return {
        months: [{ ym: `${from.slice(0, 4)}-01`, saved: true }, { ym: `${from.slice(0, 4)}-02`, saved: true, stale: true }],
        rows: [rangeRow("0912", "架空 太郎", { [`${from.slice(0, 4)}-02`]: full(100_000, 0, 90_000, 0) })],
      };
    },
    kyuyo: async (path, query) => {
      calls.push(`${path} ${query.company} ${query.year ?? query.month}`);
      if (opts.kyuyo) return opts.kyuyo(path, query);
      const year = query.year ?? "";
      const isBonus = path === "bonus";
      return {
        database: "db",
        rows:
          isBonus && query.company === "0100"
            ? [{ employee_code: "0042", employee_code_key: "42", employee_name: "架空 太郎", pay_date: `${year}-12-10`, payments: { 就労調整金: 4_000 } }]
            : [],
        warnings: isBonus && query.company === "0200" ? ["読めない行"] : [],
        ...(isBonus ? { source: "cache", synced_at: "2026-01-05" } : {}),
      };
    },
  };
  return { sources, calls };
}

describe("buildAnnualReport", () => {
  it("読む順序 (社員マスタ → 会社 → 年ごとに 期間集計 → 賞与 → 月例) と組み立て", async () => {
    const { sources, calls } = stubSources();
    const query = q("from_year=2024&to_year=2025&driver=912") as Exclude<ReturnType<typeof q>, { error: string }>;
    const report = await buildAnnualReport(sources, query);
    expect(calls.slice(0, 6)).toEqual(["employees", "companies", "range 2024-01..2024-12", "bonus 0100 2024", "bonus 0200 2024", "payroll 0100 2023-12"]);
    expect(calls).toContain("payroll 0200 2024-11");
    expect(calls.indexOf("range 2025-01..2025-12")).toBe(2 + 1 + 2 + 24);
    expect(calls).toHaveLength(2 + 2 * (1 + 2 + 24));
    expect(report.years.map((y) => y.year)).toEqual([2024, 2025]);
    const y = report.years[1]!;
    expect(y.incompleteMonths).toEqual(["2025-02"]);
    expect(y.bonusFreshness).toBe("0100: 保存済み 同期 2026-01-05 / 0200: 保存済み 同期 2026-01-05");
    expect(y.warnings).toEqual(["賞与 0200: 読めない行"]);
    expect(y.rows).toHaveLength(1);
    expect(y.rows[0]).toMatchObject({ driverCd: "0912", shortfall: { shortfall: 10_000 }, adjustment: 4_000, judgement: { status: "short", remaining: 6_000 } });
  });

  it("給与大臣の会社が無ければ 400 で、期間集計も給与大臣も読まない", async () => {
    const { sources, calls } = stubSources({ companies: [] });
    await expect(buildAnnualReport(sources, q("from_year=2025") as never)).rejects.toThrow(
      new AnnualReportError(400, "この会社に対応する給与大臣の会社が登録されていません (社員マスタタブの会社対応表)"),
    );
    expect(calls).toEqual(["employees", "companies"]);
  });

  it("月例の応答が壊れていたら全体を失敗にする (補填の一部だけで判定しない)", async () => {
    const { sources } = stubSources({ kyuyo: (path) => (path === "bonus" ? { database: "d", rows: [] } : { rows: [] }) });
    await expect(buildAnnualReport(sources, q("from_year=2025") as never)).rejects.toThrow("月例 0100 / 勤務月 2024-12 の応答形式が想定外でした");
  });
});

describe("fetchKyuyoJson", () => {
  const ok = { fetch: async (r: Request) => Response.json({ url: r.url, auth: r.headers.get("authorization") }) };
  it("path を固定し、ブラウザの Authorization をそのまま渡す", async () => {
    expect(await fetchKyuyoJson(ok, "Bearer jwt", "bonus", { company: "0100", year: "2025" })).toEqual({
      url: "https://ichibanboshi-kyuyo/kyuyo/bonus?company=0100&year=2025",
      auth: "Bearer jwt",
    });
  });
  it("mcp は X-Kyuyo-Auth: mcp を付ける (既定の browser は付けない)", async () => {
    const seen: Array<string | null> = [];
    const b = { fetch: async (r: Request) => (seen.push(r.headers.get("x-kyuyo-auth")), Response.json({})) };
    await fetchKyuyoJson(b, "Bearer mcp-jwt", "payroll", { month: "2025-01" }, "mcp");
    await fetchKyuyoJson(b, "Bearer jwt", "payroll", { month: "2025-01" });
    expect(seen).toEqual(["mcp", null]);
  });
  it("binding 無しは 503、Authorization 無しは 401 (給与大臣を呼ばない)", async () => {
    await expect(fetchKyuyoJson(undefined, "Bearer jwt", "bonus", {})).rejects.toThrow(new AnnualReportError(503, "給与大臣 Worker (ICHIBAN_KYUYO) が使えません"));
    let called = false;
    const spy = { fetch: async () => ((called = true), new Response("{}")) };
    await expect(fetchKyuyoJson(spy, null, "bonus", {})).rejects.toMatchObject({ status: 401 });
    expect(called).toBe(false);
  });
  it("接続失敗は 502", async () => {
    const broken = { fetch: async () => Promise.reject(new Error("boom")) };
    await expect(fetchKyuyoJson(broken, "Bearer j", "payroll", {})).rejects.toThrow(new AnnualReportError(502, "給与大臣 Worker への接続に失敗しました: Error: boom"));
  });
  it.each([
    [401, "no", 401, "給与大臣 (payroll) が status 401 を返しました: no"],
    [403, "", 403, "給与大臣 (payroll) が status 403 を返しました"],
    [500, " x ".repeat(1), 502, "給与大臣 (payroll) が status 500 を返しました: x"],
  ])("上流 %d → %d", async (upstream, text, status, message) => {
    const b = { fetch: async () => new Response(text, { status: upstream }) };
    await expect(fetchKyuyoJson(b, "Bearer j", "payroll", {})).rejects.toThrow(new AnnualReportError(status, message));
  });
});

describe("HTML", () => {
  it("escapeHtml", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&#60;a href=&#34;x&#34;&#62;&#38;&#39;&#60;/a&#62;");
  });
  it("jstDate は UTC 15:00 で翌日になる", () => {
    expect(jstDate(Date.UTC(2026, 10, 19, 14, 59))).toBe("2026-11-19");
    expect(jstDate(Date.UTC(2026, 10, 19, 15, 0))).toBe("2026-11-20");
  });
  it("reportFilename に氏名を入れない", () => {
    const r = { fromYear: 2025, toYear: 2025, driver: "912", years: [] } as AnnualReport;
    expect(reportFilename(r)).toBe("min-wage-annual_912_2025.pdf");
    expect(reportFilename({ ...r, toYear: 2026 })).toBe("min-wage-annual_912_2025-2026.pdf");
    expect(reportFilename({ ...r, driver: null })).toBe("min-wage-annual_all_2025.pdf");
  });

  /** HTML からタグを除いた本文 (値の検査用)。 */
  const text = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

  it("1 年 1 ページ: 見出し・カード・月の表 (不足月に色)・年計・就労調整金・注記", async () => {
    const range = parseRange({
      months: [{ ym: "2025-04", saved: false }],
      rows: [
        {
          ...rangeRow("0912", "架空 <太郎>", {
            "2025-01": { calc_total: 200_000, paid_base: 120_000, paid_overtime: 90_000 }, // 合計のみ (+10,000)
            "2025-02": { ...full(100_000, 50_000, 95_000, 50_000), hourly_rate: 1000, working_minutes: 125 }, // −5,000
            "2025-03": { ...full(100_000, 50_000, 104_000, 50_000), hourly_rate: 1000 },
            "2025-05": { ...full(100_000, 50_000, 100_000, 51_000), hourly_rate: 1050 },
          }),
        },
      ],
    });
    const adj = collectAdjustments(
      [
        { kind: "bonus", company: "0100", body: body([["42", "912", "架空 太郎", "2025-08-10", 4_000]]) },
        { kind: "payroll", company: "0100", body: body([["42", "912", "架空 太郎", "2025-03-25", 1_000]]) },
      ],
      new Map(),
      2025,
    );
    const report: AnnualReport = {
      fromYear: 2025,
      toYear: 2026,
      driver: "912",
      years: [
        {
          year: 2025,
          incompleteMonths: ["2025-04"],
          bonusFreshness: "0100: 保存済み",
          warnings: ["w1", "w2", "w3", "w4"],
          rows: buildYearRows(range, adj, 2025, "912"),
        },
        { year: 2026, incompleteMonths: [], bonusFreshness: "", warnings: [], rows: buildYearRows({ rows: [] }, new Map(), 2026, "912") },
      ],
    };
    const html = renderAnnualReportHtml(report, "2026-11-20");
    expect(html.match(/<section>/g)).toHaveLength(2);
    expect(html).toContain("<title>最低賃金 年間レポート 912 2025-2026</title>");
    expect(html).toContain("size:A4 landscape");
    const t = text(html);
    // 見出し (氏名はエスケープ)
    expect(html).toContain("乗務員CD 0912 / 架空 &#60;太郎&#62; / 本社 (給与社員CD 0100:42)　|　作成 2026-11-20");
    // カード
    expect(t).toContain("|集計月|4 / 12|");
    expect(t).toContain("|最低賃金の不足合計|5,000 円|不足の月: 2月|");
    expect(t).toContain("|就労調整金 (2025 年支給)|5,000 円|賞与 1 回・月例 1 回|");
    expect(html).toContain("<div class='card ok'><div class=l>判定</div><div class=v>補填済み (8 か月未集計のため確定でない)</div><div class=l>不足 5,000 円 ≦ 補填 5,000 円");
    // 月の表: 不足月だけ neg、差の符号と実働
    expect(html).toContain("<tr class='neg'><td>2月</td><td>2h05m</td><td>100,000</td><td>50,000</td><td class='b'>150,000</td><td>95,000</td><td>50,000</td><td class='b'>145,000</td><td class=' m'>−5,000</td><td class=''>+0</td><td class='b m'>−5,000</td></tr>");
    expect(html).toContain("<tr class=''><td>1月</td><td>—</td><td></td><td></td><td class='b'>200,000</td><td>120,000</td><td>90,000</td><td class='b'>210,000</td><td class=''></td><td class=''></td><td class='b'>+10,000</td></tr>");
    // 年計 (集計に入った月だけ): 計算 200,000+150,000+150,000+150,000 / 給与 210,000+145,000+154,000+151,000
    expect(html).toContain("<tr class='tot'><td>年計</td><td></td><td></td><td></td><td class='b'>650,000</td><td></td><td></td><td class='b'>660,000</td><td></td><td></td><td class='b'>+10,000</td></tr>");
    // 就労調整金
    expect(t).toContain("|2025-03-25|月例|0100|1,000|2025-08-10|賞与|0100|4,000|合計|5,000|");
    // 注記
    expect(t).toContain("最低賃金の単価 (時給): 2〜3月 1,000 円 / 5月 1,050 円。");
    expect(t).toContain("4月・6月・7月・8月・9月・10月・11月・12月 は差が出せない");
    expect(t).toContain("会社全体で集計の材料が揃っていない月 (未保存・要再計算・除外): 4月。");
    expect(t).toContain("1月 は合計のみ (基本給・残業代の内訳が無い)。");
    expect(t).toContain("賞与: 0100: 保存済み。");
    expect(t).toContain("給与大臣の警告 4 件 (会社全体): w1 / w2 / w3。");
    // 2 年目: 期間集計にも補填にも居ない
    expect(t).toContain("最低賃金チェック 年間レポート — 2026 年|乗務員CD 912　|　作成 2026-11-20|");
    expect(t).toContain("|集計月|—|最低賃金の不足合計|—|不足の月: なし|");
    expect(t).toContain("この年の期間集計にこの乗務員の行がありません");
    expect(t).toContain("この年の支給日の就労調整金はありません。");
    expect(html).toContain("<div class='card warn'><div class=l>判定</div>");

    // MCP 用 (#374): 氏名だけを除く。上の html が氏名を持つことが陽性対照
    expect(html).toContain("架空 &#60;太郎&#62;");
    const anon = renderAnnualReportHtml(withoutDriverNames(report), "2026-11-20");
    expect(anon).not.toContain("架空");
    expect(anon).toContain("乗務員CD 0912 / 本社 (給与社員CD 0100:42)　|　作成 2026-11-20");
    expect(anon.replace("乗務員CD 0912 / 本社", "")).toBe(html.replace("乗務員CD 0912 / 架空 &#60;太郎&#62; / 本社", ""));
    // 元の report は書き換えない
    expect(report.years[0]!.rows[0]!.driverName).toBe("架空 <太郎>");
  });

  it("残り不足は ng・比較は ＞、単価が 1 か月だけ・集計月 0 の行は年計を出さない", () => {
    const range = parseRange({
      rows: [rangeRow("1", "架空 四郎", { "2025-07": { ...full(100, 0, 50, 0), hourly_rate: 900 }, "2025-08": { calc_total: 1 } })],
    });
    const html = renderAnnualReportHtml(
      { fromYear: 2025, toYear: 2025, driver: "1", years: [{ year: 2025, incompleteMonths: [], bonusFreshness: "", warnings: [], rows: buildYearRows(range, new Map(), 2025, "1") }] },
      "2026-01-01",
    );
    expect(html).toContain("<div class='card ng'>");
    expect(html).toContain("不足 50 円 ＞ 補填 0 円");
    expect(text(html)).toContain("最低賃金の単価 (時給): 7月 900 円。");

    const empty = parseRange({ rows: [rangeRow("2", "架空 五郎", {})] });
    const html2 = renderAnnualReportHtml(
      { fromYear: 2025, toYear: 2025, driver: "2", years: [{ year: 2025, incompleteMonths: [], bonusFreshness: "", warnings: [], rows: buildYearRows(empty, new Map(), 2025, "2") }] },
      "2026-01-01",
    );
    expect(html2).not.toContain("年計");
    expect(html2).not.toContain("最低賃金の単価");
    expect(html2).toContain("<div class='card ok'><div class=l>判定</div><div class=v>不足なし (12 か月未集計のため確定でない)</div>");
  });

  it("driver 無しのレポートでもタイトルが組める", () => {
    expect(renderAnnualReportHtml({ fromYear: 2025, toYear: 2025, driver: null, years: [] }, "x")).toContain("<title>最低賃金 年間レポート  2025-2025</title>");
  });
});
