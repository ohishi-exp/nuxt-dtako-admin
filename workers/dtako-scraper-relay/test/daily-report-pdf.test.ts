import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import {
  buildTitle,
  CONTENT_WIDTH,
  dailyReportReadDateRange,
  fetchBranchDailyReportRows,
  fitText,
  formatGeneratedAtJst,
  generateDailyReportPdf,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  paginate,
  PDF_COLUMNS,
  rowsPerPage,
  stripYear,
  toPdfRow,
} from "../src/daily-report-pdf";
import { ReportParamError, type DailyReportRow } from "../src/theearth-report-client";
import { createCookieJar, type FetchLike } from "../src/theearth-client";

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

// --- fixture: DailyReportRow (theearth-report-client の行型) ------------------

function makeRow(overrides: Partial<DailyReportRow> = {}): DailyReportRow {
  return {
    operationNo: "2608240612340000006572",
    startDateTime: "2026/08/24 6:12:34",
    exclusionFlag: false,
    operationDate: "26/08/24",
    branchCd: "1",
    branchName: "大石運輸倉庫㈱　本社営業所",
    vehicleCd: "6572",
    vehicleName: "佐賀100あ6572",
    driverCd1: "1405",
    driverName1: "松尾　等",
    workStartDateTime: "08/24 06:00",
    workEndDateTime: "2026/08/24 18:30",
    operationStartDateTime: "08/24 06:12",
    operationEndDateTime: "08/24 18:10",
    totalRunningDist: "312.4",
    salesFlag: "未",
    expenseFlag: "未",
    ...overrides,
  };
}

// --- pure ヘルパ --------------------------------------------------------------

describe("dailyReportReadDateRange", () => {
  it("builds a one-day read-date range", () => {
    expect(dailyReportReadDateRange("2026/08/24")).toEqual({
      from: "2026/08/24 00:00",
      to: "2026/08/24 23:59",
    });
  });

  it("rejects a malformed date", () => {
    expect(() => dailyReportReadDateRange("2026-08-24")).toThrow(ReportParamError);
    expect(() => dailyReportReadDateRange("2026/8/24")).toThrow(ReportParamError);
  });
});

describe("stripYear", () => {
  it("drops the year from a normalized work-end datetime", () => {
    expect(stripYear("2026/08/24 18:30")).toBe("08/24 18:30");
  });

  it("returns other shapes unchanged", () => {
    expect(stripYear("")).toBe("");
    expect(stripYear("08/24 18:30")).toBe("08/24 18:30");
  });
});

describe("toPdfRow", () => {
  it("maps the F-DES1010 row fields and leaves work/fuel columns empty", () => {
    const pdfRow = toPdfRow(makeRow());
    expect(pdfRow).toEqual({
      driverName: "松尾　等",
      vehicleName: "佐賀100あ6572",
      workStart: "08/24 06:00",
      workEnd: "08/24 18:30",
      opeStart: "08/24 06:12",
      opeEnd: "08/24 18:10",
      totalDist: "312.4",
      work1: "",
      work2: "",
      work3: "",
      work4: "",
      work5: "",
      fuelOwn: "",
      fuelOther: "",
    });
  });

  it("falls back to empty strings for nullable fields", () => {
    const pdfRow = toPdfRow(makeRow({
      driverName1: null,
      vehicleName: null,
      workStartDateTime: null,
      workEndDateTime: "",
      operationStartDateTime: null,
      operationEndDateTime: null,
      totalRunningDist: null,
    }));
    expect(pdfRow.driverName).toBe("");
    expect(pdfRow.vehicleName).toBe("");
    expect(pdfRow.workStart).toBe("");
    expect(pdfRow.workEnd).toBe("");
    expect(pdfRow.opeStart).toBe("");
    expect(pdfRow.opeEnd).toBe("");
    expect(pdfRow.totalDist).toBe("");
  });
});

describe("layout constants", () => {
  it("column widths sum to CONTENT_WIDTH", () => {
    const sum = PDF_COLUMNS.reduce((acc, col) => acc + col.width, 0);
    expect(sum).toBe(CONTENT_WIDTH);
  });

  it("fits at least 20 rows per page", () => {
    expect(rowsPerPage()).toBeGreaterThanOrEqual(20);
  });
});

describe("paginate", () => {
  it("splits rows into per-page chunks preserving order", () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(paginate([1, 2], 2)).toEqual([[1, 2]]);
    expect(paginate([], 2)).toEqual([]);
  });

  it("rejects a non-positive or fractional page size", () => {
    expect(() => paginate([1], 0)).toThrow(ReportParamError);
    expect(() => paginate([1], 1.5)).toThrow(ReportParamError);
  });
});

describe("buildTitle / formatGeneratedAtJst", () => {
  it("builds the header title", () => {
    expect(buildTitle("本社営業所", "2026/08/24")).toBe("本社営業所 運転日報 2026/08/24分");
  });

  it("formats the generation time in JST", () => {
    // UTC 2026-08-24T21:30 = JST 2026-08-25 06:30
    expect(formatGeneratedAtJst(new Date("2026-08-24T21:30:00Z"))).toBe("生成: 2026/08/25 06:30 JST");
  });
});

describe("fitText", () => {
  const widthOf = (text: string, size: number): number => text.length * size;

  it("returns the text unchanged when it fits", () => {
    expect(fitText("abc", 30, 10, widthOf)).toBe("abc");
  });

  it("truncates with an ellipsis when too wide", () => {
    expect(fitText("abcdef", 35, 10, widthOf)).toBe("ab…");
  });

  it("degenerates to the ellipsis alone when nothing fits", () => {
    expect(fitText("abcdef", 5, 10, widthOf)).toBe("…");
  });
});

// --- PDF 生成 -----------------------------------------------------------------

describe("generateDailyReportPdf", () => {
  it("rejects zero rows (caller must skip generation)", async () => {
    await expect(
      generateDailyReportPdf({ rows: [], branchName: "本社営業所", dateJst: "2026/08/24" }),
    ).rejects.toThrow(ReportParamError);
  });

  it("generates a single-page A4-landscape PDF that pdf-lib can reload", async () => {
    const rows = [
      makeRow(),
      makeRow({
        operationNo: "2608240712340000001101",
        driverName1: "とても長い名前の乗務員のフィッティング確認用データ",
        vehicleName: null,
      }),
    ];
    const bytes = await generateDailyReportPdf({
      rows,
      branchName: "大石運輸倉庫㈱　本社営業所",
      dateJst: "2026/08/24",
      generatedAt: new Date("2026-08-24T21:30:00Z"),
    });

    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(1);
    const size = reloaded.getPage(0).getSize();
    expect(size.width).toBeCloseTo(PAGE_WIDTH, 2);
    expect(size.height).toBeCloseTo(PAGE_HEIGHT, 2);

    // かんたんnetprint 対策: classic xref テーブルを持つ正規の PDF であること
    // (useObjectStreams: false)。latin1 で復号して構造マーカーを直接確認する。
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text.startsWith("%PDF-")).toBe(true);
    expect(text).toMatch(/\nxref\n/);
    expect(text).toMatch(/\ntrailer\n/);

    // subset 埋め込みが効いていること (フル OTF 4.5MB を抱えたら桁が変わる)。
    expect(bytes.length).toBeLessThan(1_000_000);
  });

  it("spills onto multiple pages when rows exceed the per-page capacity", async () => {
    const perPage = rowsPerPage();
    const rows = Array.from({ length: perPage + 1 }, (_, i) =>
      makeRow({ operationNo: `26082400000000000${String(i).padStart(5, "0")}` }));
    // generatedAt 省略 (既定の現在時刻) の分岐もここで通す。
    const bytes = await generateDailyReportPdf({
      rows,
      branchName: "本社営業所",
      dateJst: "2026/08/24",
    });
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(2);
  });
});

// --- データ取得 (fetchImpl 注入、実 theearth は叩かない) ----------------------

describe("fetchBranchDailyReportRows", () => {
  function listHtml(): string {
    return `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-DES" />
      <input type="submit" id="btnUpdate" name="ctl00$MainContent$btnUpdate" value="更新" />
    </form></body></html>`;
  }

  function configHtml(): string {
    const dateFields = (prefix: string): string =>
      ["txtYear", "txtMonth", "txtDay"]
        .map((s) => `<input type="text" id="${prefix}_${s}" name="${prefix}$${s}" value="" />`)
        .join("\n")
      + `<input type="checkbox" id="${prefix}_chkUseEra" name="${prefix}$chkUseEra" />`;
    return `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-GOS" />
      <select id="ddlSortDay1" name="ddlSortDay1">
        <option value="OperationDate" selected>運行日</option>
        <option value="ReadNo">読取日</option>
      </select>
      ${dateFields("ucStartDate1")}
      ${dateFields("ucEndDate1")}
      <select id="ddlSortDay2" name="ddlSortDay2">
        <option value="OperationDate">運行日</option>
        <option value="ReadNo" selected>読取日</option>
      </select>
      ${dateFields("ucStartDate2")}
      ${dateFields("ucEndDate2")}
      <input type="submit" id="btnOK" name="btnOK" value="適用" />
    </form></body></html>`;
  }

  /** F-DES1010 グリッド行 (実 DOM の `MainContent_lstOperation_lbl<Field>_<row>`)。 */
  function gridRowHtml(i: number, v: {
    opNo: string;
    workEndRaw: string;
    branchCd?: string;
    driverName?: string;
  }): string {
    const id = (f: string): string => `MainContent_lstOperation_${f}_${i}`;
    return `
      <span id="${id("lblOperationNo")}">${v.opNo}</span>
      <span id="${id("lblStartDateTime")}">2026/08/24 6:12:34</span>
      <span id="${id("lblExclusionFlag")}">0</span>
      <span id="${id("lblBranchCD")}">${v.branchCd ?? "1"}</span>
      <span id="${id("lblDisplayName")}">営業所${v.branchCd ?? "1"}</span>
      <span id="${id("lblVehicleName")}">佐賀100あ6572</span>
      <span id="${id("lblDriverName1")}">${v.driverName ?? "松尾　等"}</span>
      <span id="${id("lblWorkStartDateTime")}">08/24 06:00</span>
      <span id="${id("lblWorkEndDateTime")}">${v.workEndRaw}</span>
      <span id="${id("lblTotalRunningDist")}">312.4</span>`;
  }

  /** 退社日時降順 3 行: 対象営業所 (1) / 別営業所 (8) / 前日行 (早期打ち切り用)。 */
  function gridPageHtml(): string {
    return `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-GRID" />
      ${gridRowHtml(0, { opNo: "2608240612340000006572", workEndRaw: "08/24 18:30", branchCd: "1" })}
      ${gridRowHtml(1, { opNo: "2608240712340000001101", workEndRaw: "08/24 17:00", branchCd: "8" })}
      ${gridRowHtml(2, { opNo: "2608230512340000002202", workEndRaw: "08/23 23:50", branchCd: "1" })}
    </form></body></html>`;
  }

  it("narrows by read date, harvests, and keeps only the requested branch", async () => {
    const jar = createCookieJar();
    const bodies: string[] = [];
    let call = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) return html(listHtml());
      if (call === 2) return html(configHtml());
      bodies.push(String(init?.body ?? ""));
      if (call === 4) return html(gridPageHtml());
      return html("applied");
    }) as FetchLike;

    const rows = await fetchBranchDailyReportRows(
      jar,
      { dateJst: "2026/08/24", branchCd: "1" },
      fetchImpl,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].operationNo).toBe("2608240612340000006572");
    expect(rows[0].branchCd).toBe("1");
    expect(rows[0].workEndDateTime).toBe("2026/08/24 18:30");

    // 読取日 range が F-GOS0030 の ReadNo 行 (2 行目) に上書きされていること。
    const applyBody = new URLSearchParams(bodies[0]);
    expect(applyBody.get("ucStartDate2$txtYear")).toBe("26");
    expect(applyBody.get("ucStartDate2$txtMonth")).toBe("8");
    expect(applyBody.get("ucStartDate2$txtDay")).toBe("24");
    expect(applyBody.get("ucEndDate2$txtDay")).toBe("24");
    expect(applyBody.get("btnOK")).toBe("適用");
    // 全 5 リクエスト (GET 一覧 / GET 設定 / 適用 / btnUpdate / 復元) で完結。
    expect(call).toBe(5);
  });

  it("rejects an invalid branch cd before touching theearth (fetchImpl 省略で既定引数も通す)", async () => {
    const jar = createCookieJar();
    await expect(
      fetchBranchDailyReportRows(jar, { dateJst: "2026/08/24", branchCd: "本社" }),
    ).rejects.toThrow(ReportParamError);
  });

  it("rejects an invalid date before touching theearth", async () => {
    const jar = createCookieJar();
    const neverFetch = (async () => {
      throw new Error("fetch されないはず");
    }) as FetchLike;
    await expect(
      fetchBranchDailyReportRows(jar, { dateJst: "2026/08/32 00:00", branchCd: "1" }, neverFetch),
    ).rejects.toThrow(ReportParamError);
  });
});
