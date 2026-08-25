import { describe, expect, it, vi } from "vitest";
import {
  buildOperationSelection,
  dailyReportReadDateRange,
  fetchBranchDailyReport,
  fetchDailyReportPdf,
  parsePreviewDocumentUrl,
  PREVIEW_POLL_INTERVAL_MS,
  PREVIEW_TIMEOUT_MS,
} from "../src/daily-report-preview";
import { ReportParamError } from "../src/theearth-report-client";
import { createCookieJar, TheearthClientError, type FetchLike } from "../src/theearth-client";
import { VenusSessionExpiredError } from "../src/theearth-venus-client";

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function pdfResponse(bytes = [0x25, 0x50, 0x44, 0x46]): Response {
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { "content-type": "application/pdf" },
  });
}

const LOGIN_REDIRECT_HTML = `<html><body><form><input id="txtPass" name="txtPass" type="password" /></form></body></html>`;

// ---------------------------------------------------------------------------
// pure ヘルパ
// ---------------------------------------------------------------------------

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

describe("buildOperationSelection", () => {
  it("joins the operations into the four hidden fields (実機 J-GOS0010 の MultiProcess と同じ形)", () => {
    expect(
      buildOperationSelection([
        { operationNo: "2608240913380000003269", startDateTime: "2026/08/24 9:13:38" },
        { operationNo: "2608180808200000004286", startDateTime: "2026/08/18 8:08:20" },
      ]),
    ).toEqual({
      operationNo: "2608240913380000003269,2608180808200000004286",
      startDateTime: "2026/08/24 9:13:38,2026/08/18 8:08:20",
      currentId: "MainContent_T1_lstOperation_row_0,MainContent_T1_lstOperation_row_1",
      index: "0",
    });
  });
});

describe("parsePreviewDocumentUrl", () => {
  it("picks the F-GRS0010 URL out of the startup script verbatim", () => {
    const body = `<script type="text/javascript">
//<![CDATA[
window.open('F-GRS0010[PreviewDocument].aspx?title=運転日報&fileName=20260825202627_0')var __cultureInfo = {};
//]]>
</script>`;
    expect(parsePreviewDocumentUrl(body)).toBe(
      "F-GRS0010[PreviewDocument].aspx?title=運転日報&fileName=20260825202627_0",
    );
  });

  it("returns null when the response has no preview URL (= サーバが選択を受け取っていない)", () => {
    expect(parsePreviewDocumentUrl("<html><body>運行データが選択されていません。</body></html>")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fetchBranchDailyReport (F-DES1010 harvest + 営業所絞り込み)
// ---------------------------------------------------------------------------

describe("fetchBranchDailyReport", () => {
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
  function gridRowHtml(i: number, v: { opNo: string; workEndRaw: string; branchCd?: string }): string {
    const id = (f: string): string => `MainContent_lstOperation_${f}_${i}`;
    return `
      <span id="${id("lblOperationNo")}">${v.opNo}</span>
      <span id="${id("lblStartDateTime")}">2026/08/24 6:12:34</span>
      <span id="${id("lblExclusionFlag")}">0</span>
      <span id="${id("lblBranchCD")}">${v.branchCd ?? "1"}</span>
      <span id="${id("lblDisplayName")}">営業所${v.branchCd ?? "1"}</span>
      <span id="${id("lblVehicleName")}">佐賀100あ6572</span>
      <span id="${id("lblDriverName1")}">松尾　等</span>
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

  it("narrows by read date, harvests F-DES1010 and keeps only the target branch", async () => {
    const jar = createCookieJar();
    const bodies: string[] = [];
    let call = 0;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) return html(listHtml());
      if (call === 2) return html(configHtml());
      if (call === 3) {
        bodies.push(String(init?.body ?? ""));
        return html("applied"); // F-GOS0030 適用
      }
      if (call === 4) {
        bodies.push(String(init?.body ?? ""));
        return html(gridPageHtml()); // btnUpdate → F-DES1010 1 ページ目
      }
      return html("applied"); // 復元
    }) as FetchLike;

    const report = await fetchBranchDailyReport(jar, { dateJst: "2026/08/24", branchCd: "1" }, fetchImpl);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].operationNo).toBe("2608240612340000006572");
    expect(report.rows[0].branchCd).toBe("1");
    expect(report.rows[0].workEndDateTime).toBe("2026/08/24 18:30");

    // 読取日 range が F-GOS0030 の ReadNo 行 (2 行目) に上書きされていること。
    const applyBody = new URLSearchParams(bodies[0]);
    expect(applyBody.get("ucStartDate2$txtYear")).toBe("26");
    expect(applyBody.get("ucStartDate2$txtMonth")).toBe("8");
    expect(applyBody.get("ucStartDate2$txtDay")).toBe("24");
    expect(applyBody.get("ucEndDate2$txtDay")).toBe("24");
    expect(applyBody.get("btnOK")).toBe("適用");
    // F-NRS1010 は harvest しない (公式帳票に作業時間・燃料が載るため)。
    // GET 一覧 / GET 設定 / 適用 / btnUpdate / 復元 の 5 リクエストのみ。
    expect(call).toBe(5);
  });

  it("returns an empty row set when no row matches the branch", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(listHtml());
      if (call === 2) return html(configHtml());
      if (call === 4) return html(gridPageHtml());
      return html("applied");
    }) as FetchLike;

    const report = await fetchBranchDailyReport(jar, { dateJst: "2026/08/24", branchCd: "9" }, fetchImpl);
    expect(report.rows).toEqual([]);
    expect(call).toBe(5);
  });

  it("rejects an invalid branch cd before touching theearth (fetchImpl 省略で既定引数も通す)", async () => {
    const jar = createCookieJar();
    await expect(
      fetchBranchDailyReport(jar, { dateJst: "2026/08/24", branchCd: "本社" }),
    ).rejects.toThrow(ReportParamError);
  });

  it("rejects an invalid date before touching theearth", async () => {
    const jar = createCookieJar();
    const neverFetch = (async () => {
      throw new Error("fetch されないはず");
    }) as FetchLike;
    await expect(
      fetchBranchDailyReport(jar, { dateJst: "2026/08/32 00:00", branchCd: "1" }, neverFetch),
    ).rejects.toThrow(ReportParamError);
  });
});

// ---------------------------------------------------------------------------
// fetchDailyReportPdf (F-NRS1010 プレビュー → F-GRS0010 の PDF)
// ---------------------------------------------------------------------------

describe("fetchDailyReportPdf", () => {
  const ROWS = [
    { operationNo: "2608240913380000003269", startDateTime: "2026/08/24 9:13:38" },
    { operationNo: "2608180808200000004286", startDateTime: "2026/08/18 8:08:20" },
  ];

  /** F-NRS1010 の全 form。実 DOM と同じく hidden の id は `txtOperationNo`、
   * name は `ctl00$MainContent$T1$txtOperationNo` 形式で別物。 */
  function nrsFormHtml(opts: { omitFieldId?: string; previewValue?: string | null } = {}): string {
    const hidden = (id: string): string =>
      opts.omitFieldId === id
        ? ""
        : `<input type="text" id="${id}" name="ctl00$MainContent$T1$${id}" class="none" />`;
    const previewValue =
      opts.previewValue === null ? "" : ` value="${opts.previewValue ?? "プレビュー"}"`;
    const preview =
      opts.omitFieldId === "MainContent_Button3"
        ? ""
        : `<input type="submit" name="ctl00$MainContent$Button3"${previewValue} id="MainContent_Button3" />`;
    return `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-NRS" />
      <input type="submit" name="ctl00$MainContent$Button1" value="全選択" id="MainContent_Button1" />
      ${hidden("txtOperationNo")}
      ${hidden("txtStartDateTime")}
      ${hidden("txtCurrentID")}
      ${hidden("txtIndex")}
      ${preview}
    </form></body></html>`;
  }

  function previewResponseHtml(fileName = "20260825202627_0"): string {
    return `<html><body><form></form><script type="text/javascript">
//<![CDATA[
window.open('F-GRS0010[PreviewDocument].aspx?title=運転日報&fileName=${fileName}')
//]]>
</script></body></html>`;
  }

  it("selects the operations, posts プレビュー, and downloads the PDF the server names", async () => {
    const jar = createCookieJar();
    const calls: { url: string; body: string }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      if (calls.length === 1) return html(nrsFormHtml());
      if (calls.length === 2) return html(previewResponseHtml());
      return pdfResponse();
    }) as FetchLike;

    const pdf = await fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl);

    expect(Array.from(pdf)).toEqual([0x25, 0x50, 0x44, 0x46]);
    expect(calls[0].url).toBe("https://theearth-np.com/F-NRS1010[DailyOperationReport].aspx");

    const posted = new URLSearchParams(calls[1].body);
    expect(posted.get("ctl00$MainContent$T1$txtOperationNo")).toBe(
      "2608240913380000003269,2608180808200000004286",
    );
    expect(posted.get("ctl00$MainContent$T1$txtStartDateTime")).toBe(
      "2026/08/24 9:13:38,2026/08/18 8:08:20",
    );
    expect(posted.get("ctl00$MainContent$T1$txtCurrentID")).toBe(
      "MainContent_T1_lstOperation_row_0,MainContent_T1_lstOperation_row_1",
    );
    expect(posted.get("ctl00$MainContent$T1$txtIndex")).toBe("0");
    expect(posted.get("ctl00$MainContent$Button3")).toBe("プレビュー");
    // VIEWSTATE ごと full form で送る (部分 POST は ASP.NET が受け付けない)。
    expect(posted.get("__VIEWSTATE")).toBe("VS-NRS");

    // 帳票 URL はサーバが決めた fileName ごとそのまま使う (`_0` suffix を落とさない)。
    expect(calls[2].url).toBe(
      "https://theearth-np.com/F-GRS0010[PreviewDocument].aspx?title=%E9%81%8B%E8%BB%A2%E6%97%A5%E5%A0%B1&fileName=20260825202627_0",
    );
  });

  it("gives the プレビュー postback its own long timeout (一覧の GET は短いまま)", async () => {
    const jar = createCookieJar();
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      signals.push(init?.signal);
      if (signals.length === 1) return html(nrsFormHtml());
      if (signals.length === 2) return html(previewResponseHtml());
      return pdfResponse();
    }) as FetchLike;

    // 既定の 30 秒では 9 運行ぶんの帳票生成に足りず実機で timeout した (#874-13)。
    // 一覧 GET だけは軽いので短い timeout のままにしてある。
    const seen: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation(((ms: number) => {
      seen.push(ms);
      return new AbortController().signal;
    }) as typeof AbortSignal.timeout);
    try {
      await fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl, 30_000);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([30_000, PREVIEW_TIMEOUT_MS, PREVIEW_TIMEOUT_MS]);
  });

  it("falls back to a literal プレビュー when the button carries no value attribute", async () => {
    const jar = createCookieJar();
    const bodies: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body ?? ""));
      if (bodies.length === 1) return html(nrsFormHtml({ previewValue: null }));
      if (bodies.length === 2) return html(previewResponseHtml());
      return pdfResponse();
    }) as FetchLike;

    await fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl);
    expect(new URLSearchParams(bodies[1]).get("ctl00$MainContent$Button3")).toBe("プレビュー");
  });

  it("uses the global fetch and the default poll settings when they are omitted", async () => {
    const jar = createCookieJar();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(html(nrsFormHtml()))
      .mockResolvedValueOnce(html(previewResponseHtml()))
      .mockResolvedValueOnce(pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchDailyReportPdf(jar, { rows: ROWS })).resolves.toBeInstanceOf(Uint8Array);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses an empty selection instead of posting a preview nobody asked for", async () => {
    const jar = createCookieJar();
    const neverFetch = (async () => {
      throw new Error("fetch されないはず");
    }) as FetchLike;
    await expect(fetchDailyReportPdf(jar, { rows: [] }, neverFetch)).rejects.toThrow(
      /対象運行が 0 件/,
    );
  });

  it("loud-fails when F-NRS1010 itself returns a non-2xx", async () => {
    const jar = createCookieJar();
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as FetchLike;
    await expect(fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl)).rejects.toThrow(
      /F-NRS1010\) の取得が HTTP 500/,
    );
  });

  it("maps a login page on F-NRS1010 to a session-expired error", async () => {
    const jar = createCookieJar();
    const fetchImpl = (async () => html(LOGIN_REDIRECT_HTML)) as FetchLike;
    await expect(fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });

  it("loud-fails when the プレビュー button is gone (ページ仕様変更)", async () => {
    const jar = createCookieJar();
    const fetchImpl = (async () => html(nrsFormHtml({ omitFieldId: "MainContent_Button3" }))) as FetchLike;
    await expect(fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl)).rejects.toThrow(
      /プレビューボタン \(Button3\) が見つかりません/,
    );
  });

  it("loud-fails when a selection hidden is gone (ページ仕様変更)", async () => {
    const jar = createCookieJar();
    const fetchImpl = (async () => html(nrsFormHtml({ omitFieldId: "txtCurrentID" }))) as FetchLike;
    await expect(fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl)).rejects.toThrow(
      /選択フィールド \(txtCurrentID\) が見つかりません/,
    );
  });

  it("loud-fails when the プレビュー postback returns a non-2xx", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1 ? html(nrsFormHtml()) : new Response("boom", { status: 502 });
    }) as FetchLike;
    await expect(fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl)).rejects.toThrow(
      /プレビューが HTTP 502/,
    );
  });

  it("maps a login page after the プレビュー postback to a session-expired error", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1 ? html(nrsFormHtml()) : html(LOGIN_REDIRECT_HTML);
    }) as FetchLike;
    await expect(fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });

  it("loud-fails (件数つき) when the response carries no 帳票 URL", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return call === 1 ? html(nrsFormHtml()) : html("<html><body>選択されていません</body></html>");
    }) as FetchLike;
    await expect(fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl)).rejects.toThrow(
      /帳票 URL \(F-GRS0010\) がありません \(対象 2 件\)/,
    );
  });

  it("waits and retries while the 帳票 is still being generated", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(nrsFormHtml());
      if (call === 2) return html(previewResponseHtml());
      // 生成前は PDF ではないものが返る (ログイン画面ではない = 待てば変わる)。
      if (call === 3) return html("<html><body>準備中</body></html>");
      return pdfResponse([0x25, 0x50]);
    }) as FetchLike;
    const sleepImpl = vi.fn(async () => {});

    const pdf = await fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl, undefined, { sleepImpl });

    expect(Array.from(pdf)).toEqual([0x25, 0x50]);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(PREVIEW_POLL_INTERVAL_MS);
  });

  it("uses the real setTimeout when sleepImpl is omitted (pollIntervalMs 0 で待たない)", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(nrsFormHtml());
      if (call === 2) return html(previewResponseHtml());
      if (call === 3) return html("<html><body>準備中</body></html>");
      return pdfResponse();
    }) as FetchLike;

    await expect(
      fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl, undefined, { pollIntervalMs: 0 }),
    ).resolves.toBeInstanceOf(Uint8Array);
    expect(call).toBe(4);
  });

  it("gives up immediately when the 帳票 URL returns a login page", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(nrsFormHtml());
      if (call === 2) return html(previewResponseHtml());
      return html(LOGIN_REDIRECT_HTML);
    }) as FetchLike;
    const sleepImpl = vi.fn(async () => {});

    await expect(
      fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl, undefined, { sleepImpl }),
    ).rejects.toThrow(VenusSessionExpiredError);
    // セッション切れは待っても変わらないので 1 回で諦める。
    expect(sleepImpl).not.toHaveBeenCalled();
    expect(call).toBe(3);
  });

  it("reports the last response after exhausting the attempts (content-type 無しも書き分ける)", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(nrsFormHtml());
      if (call === 2) return html(previewResponseHtml());
      return new Response(null, { status: 503 });
    }) as FetchLike;
    const sleepImpl = vi.fn(async () => {});

    await expect(
      fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl, undefined, { sleepImpl, maxAttempts: 3 }),
    ).rejects.toThrow(/3 回の試行で取得できませんでした \(最後の応答: HTTP 503 content-type 不明\)/);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("reports the last content-type when one is present", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(nrsFormHtml());
      if (call === 2) return html(previewResponseHtml());
      return html("<html><body>準備中</body></html>");
    }) as FetchLike;

    await expect(
      fetchDailyReportPdf(jar, { rows: ROWS }, fetchImpl, undefined, {
        sleepImpl: async () => {},
        maxAttempts: 2,
      }),
    ).rejects.toThrow(TheearthClientError);
  });
});
