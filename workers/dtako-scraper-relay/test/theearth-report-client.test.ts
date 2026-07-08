import { describe, expect, it } from "vitest";
import {
  downloadEditedZip,
  forceUnlockAll,
  getExpenseForm,
  harvestDailyReport,
  recalculateExpense,
  ReportParamError,
  saveFuelRow,
  verifyReadNoDescending,
} from "../src/theearth-report-client";
import { createCookieJar, TheearthClientError, type FetchLike } from "../src/theearth-client";
import { VenusSessionExpiredError } from "../src/theearth-venus-client";

function html(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

function status(code: number): Response {
  return new Response("error", { status: code });
}

function zipResponse(): Response {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
}

/** 呼び出し順に Response を返す fetch モック。関数を渡すと呼び出し毎に動的に生成できる。 */
function sequenceFetch(responses: (Response | (() => Response))[]): FetchLike {
  let i = 0;
  return (async () => {
    const entry = responses[i];
    i += 1;
    if (!entry) throw new Error(`unexpected extra fetch call (#${i})`);
    return typeof entry === "function" ? entry() : entry;
  }) as FetchLike;
}

const LOGIN_REDIRECT_HTML = `<html><body><form><input id="txtPass" name="txtPass" type="password" /></form></body></html>`;

// --- F-DES1012 経費入力フォーム fixture -------------------------------------

function fuelRowHtml(ctrlIndex: number, v: {
  operationNo?: string;
  subNo?: string | null;
  category?: string;
  station?: string;
  type?: string;
  dateTime?: string;
  quantity?: string;
} = {}): string {
  const prefix = `MainContent_lstFuel_ctrl${ctrlIndex}`;
  const nprefix = `ctl00$MainContent$lstFuel$ctrl${ctrlIndex}`;
  return `
    <input type="hidden" id="${prefix}_itxtOperationNo" name="${nprefix}$itxtOperationNo" value="${v.operationNo ?? "2231234567890123456789"}" />
    ${
      v.subNo === null
        ? "" // 要素そのものを欠落させる (findFormFieldById が null を返すケースの fixture)
        : `<input type="hidden" id="${prefix}_itxtSubNo" name="${nprefix}$itxtSubNo" value="${v.subNo ?? "1"}" />`
    }
    <input type="text" id="${prefix}_itxtSupplyCategory" name="${nprefix}$itxtSupplyCategory" value="${v.category ?? "1"}" />
    <input type="text" id="${prefix}_itxtSupplyStation" name="${nprefix}$itxtSupplyStation" value="${v.station ?? "1"}" />
    <input type="text" id="${prefix}_itxtSupplyType" name="${nprefix}$itxtSupplyType" value="${v.type ?? "10"}" />
    <input type="text" id="${prefix}_itxtDateTime" name="${nprefix}$itxtDateTime" value="${v.dateTime ?? "20260707103000"}" />
    <input type="text" id="${prefix}_itxtQuantuty" name="${nprefix}$itxtQuantuty" value="${v.quantity ?? "35.5"}" />
  `;
}

function expenseFormHtml(opts: { rows?: number; linkSysDisabled?: boolean; recalculated?: boolean } = {}): string {
  const rowCount = opts.rows ?? 2;
  const rows = Array.from({ length: rowCount }, (_, i) => fuelRowHtml(i, { operationNo: `row${i}` })).join("\n");
  const linkSysClass = opts.linkSysDisabled === false ? "ButtonCrimson" : "aspNetDisabled ButtonCrimson";
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
    ${rows}
    <input type="submit" id="MainContent_btnExpenceEditSetting" name="ctl00$MainContent$btnExpenceEditSetting" value="登録" />
    <input type="submit" id="MainContent_btnScore" name="ctl00$MainContent$btnScore" value="評価点再集計" />
    <input type="submit" id="MainContent_btnLinkSys" name="ctl00$MainContent$btnLinkSys" value="システム連動開始" class="${linkSysClass}" />
    ${opts.recalculated ? "<div>再集計が終了しました。</div>" : ""}
  </form></body></html>`;
}

const OPE_NO = "2231234567890123456789";
const START_OPE = "2026/07/07 10:00:00";

describe("getExpenseForm", () => {
  it("parses fuel rows from the expense edit page", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 2 }))]);
    const form = await getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl);
    expect(form.opeNo).toBe(OPE_NO);
    expect(form.fuelRows).toHaveLength(2);
    expect(form.fuelRows[0]).toMatchObject({ ctrlIndex: 0, operationNo: "row0", quantity: "35.5" });
  });

  it("rejects malformed OpeNo / StartOpe", async () => {
    const jar = createCookieJar();
    await expect(getExpenseForm(jar, "bad", START_OPE)).rejects.toThrow(ReportParamError);
    await expect(getExpenseForm(jar, OPE_NO, "bad")).rejects.toThrow(ReportParamError);
  });

  it("throws on non-ok GET", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([status(500)]);
    await expect(getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(TheearthClientError);
  });

  it("throws VenusSessionExpiredError on login redirect", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(LOGIN_REDIRECT_HTML)]);
    await expect(getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(VenusSessionExpiredError);
  });

  it("accepts zero fuel rows when __VIEWSTATE is present (no fuel this trip)", async () => {
    const jar = createCookieJar();
    const emptyHtml = `<html><body><form><input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" /></form></body></html>`;
    const fetchImpl = sequenceFetch([html(emptyHtml)]);
    const form = await getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl);
    expect(form.fuelRows).toHaveLength(0);
  });

  it("throws when the page has neither fuel rows nor __VIEWSTATE (unexpected structure)", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html("<html><body>何か違うページ</body></html>")]);
    await expect(getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(TheearthClientError);
  });

  it("defaults a missing field to an empty string instead of throwing", async () => {
    const jar = createCookieJar();
    const missingSubNoHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${fuelRowHtml(0, { subNo: null })}
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(missingSubNoHtml)]);
    const form = await getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl);
    expect(form.fuelRows[0]?.subNo).toBe("");
  });
});

describe("saveFuelRow", () => {
  const baseParams = {
    opeNo: OPE_NO,
    startOpe: START_OPE,
    ctrlIndex: 0,
    supplyCategory: "2",
    supplyStation: "2",
    supplyType: "20",
    dateTime: "20260707120000",
    quantity: "40",
  };

  it("saves the edited row and returns the refreshed rows", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 2 })),
      html(expenseFormHtml({ rows: 2 })),
    ]);
    const result = await saveFuelRow(jar, baseParams, fetchImpl);
    expect(result.fuelRows).toHaveLength(2);
  });

  it("rejects malformed OpeNo / StartOpe", async () => {
    const jar = createCookieJar();
    await expect(saveFuelRow(jar, { ...baseParams, opeNo: "bad" })).rejects.toThrow(ReportParamError);
    await expect(saveFuelRow(jar, { ...baseParams, startOpe: "bad" })).rejects.toThrow(ReportParamError);
  });

  it("throws on non-ok GET / login redirect on GET", async () => {
    const jar1 = createCookieJar();
    await expect(saveFuelRow(jar1, baseParams, sequenceFetch([status(500)]))).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      saveFuelRow(jar2, baseParams, sequenceFetch([html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("rejects an unknown ctrlIndex", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 }))]);
    await expect(saveFuelRow(jar, { ...baseParams, ctrlIndex: 9 }, fetchImpl)).rejects.toThrow(ReportParamError);
  });

  it("throws when the save button is missing", async () => {
    const jar = createCookieJar();
    const noButtonHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${fuelRowHtml(0)}
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(noButtonHtml)]);
    await expect(saveFuelRow(jar, baseParams, fetchImpl)).rejects.toThrow(TheearthClientError);
  });

  it("falls back to a default label when the save button has no value attribute", async () => {
    const jar = createCookieJar();
    const noValueButtonHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${fuelRowHtml(0)}
      <input type="submit" id="MainContent_btnExpenceEditSetting" name="ctl00$MainContent$btnExpenceEditSetting" />
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(noValueButtonHtml), html(noValueButtonHtml)]);
    const result = await saveFuelRow(jar, baseParams, fetchImpl);
    expect(result.fuelRows).toHaveLength(1);
  });

  it("throws on non-ok POST / login redirect on POST", async () => {
    const jar1 = createCookieJar();
    await expect(
      saveFuelRow(jar1, baseParams, sequenceFetch([html(expenseFormHtml({ rows: 1 })), status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      saveFuelRow(jar2, baseParams, sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws when the response indicates a concurrent-edit conflict", async () => {
    const jar = createCookieJar();
    const conflictHtml = `<html><body>他ユーザー編集中のため処理を中止しました。</body></html>`;
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(conflictHtml)]);
    await expect(saveFuelRow(jar, baseParams, fetchImpl)).rejects.toThrow(/他ユーザー/);
  });
});

describe("recalculateExpense", () => {
  it("succeeds and reports linkSysEnabled=true after recalculation", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1 })),
      html(expenseFormHtml({ rows: 1, linkSysDisabled: false, recalculated: true })),
    ]);
    const result = await recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl);
    expect(result.linkSysEnabled).toBe(true);
  });

  it("reports linkSysEnabled=false when the button is still disabled", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1 })),
      html(expenseFormHtml({ rows: 1, linkSysDisabled: true, recalculated: true })),
    ]);
    const result = await recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl);
    expect(result.linkSysEnabled).toBe(false);
  });

  it("reports linkSysEnabled=false when the button tag is absent entirely", async () => {
    const jar = createCookieJar();
    const noLinkSysHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${fuelRowHtml(0)}
      <input type="submit" id="MainContent_btnScore" name="ctl00$MainContent$btnScore" value="評価点再集計" />
      再集計が終了しました。
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(noLinkSysHtml)]);
    const result = await recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl);
    expect(result.linkSysEnabled).toBe(false);
  });

  it("skips writing a field whose element is missing from the page (defensive, doesn't throw)", async () => {
    const jar = createCookieJar();
    const missingSubNoHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${fuelRowHtml(0, { subNo: null })}
      <input type="submit" id="MainContent_btnScore" name="ctl00$MainContent$btnScore" value="評価点再集計" />
      <input type="submit" id="MainContent_btnLinkSys" name="ctl00$MainContent$btnLinkSys" value="システム連動開始" class="ButtonCrimson" />
      再集計が終了しました。
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(missingSubNoHtml), html(missingSubNoHtml)]);
    const result = await recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl);
    expect(result.linkSysEnabled).toBe(true);
  });

  it("rejects malformed OpeNo / StartOpe", async () => {
    const jar = createCookieJar();
    await expect(recalculateExpense(jar, "bad", START_OPE)).rejects.toThrow(ReportParamError);
    await expect(recalculateExpense(jar, OPE_NO, "bad")).rejects.toThrow(ReportParamError);
  });

  it("throws on non-ok GET / login redirect on GET", async () => {
    const jar1 = createCookieJar();
    await expect(
      recalculateExpense(jar1, OPE_NO, START_OPE, sequenceFetch([status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      recalculateExpense(jar2, OPE_NO, START_OPE, sequenceFetch([html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws when the score button is missing", async () => {
    const jar = createCookieJar();
    const noButtonHtml = `<html><body><form><input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />${fuelRowHtml(0)}</form></body></html>`;
    const fetchImpl = sequenceFetch([html(noButtonHtml)]);
    await expect(recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(TheearthClientError);
  });

  it("throws on non-ok POST / login redirect on POST", async () => {
    const jar1 = createCookieJar();
    await expect(
      recalculateExpense(jar1, OPE_NO, START_OPE, sequenceFetch([html(expenseFormHtml({ rows: 1 })), status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      recalculateExpense(
        jar2,
        OPE_NO,
        START_OPE,
        sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(LOGIN_REDIRECT_HTML)]),
      ),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws on concurrent-edit conflict", async () => {
    const jar = createCookieJar();
    const conflictHtml = `<html><body>他ユーザー編集中のため処理を中止しました。</body></html>`;
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(conflictHtml)]);
    await expect(recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(/他ユーザー/);
  });

  it("throws when the completion message is missing", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(expenseFormHtml({ rows: 1 }))]);
    await expect(recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(/再集計が終了しました/);
  });
});

describe("forceUnlockAll", () => {
  const listHtml = (opts: { withButton?: boolean } = { withButton: true }) => `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
    ${
      opts.withButton
        ? '<input type="submit" id="MainContent_btnInitialize" name="ctl00$MainContent$btnInitialize" value="編集制御解除" />'
        : ""
    }
  </form></body></html>`;

  it("succeeds", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(listHtml()), html(listHtml())]);
    await expect(forceUnlockAll(jar, fetchImpl)).resolves.toBeUndefined();
  });

  it("falls back to a default label when the button has no value attribute", async () => {
    const jar = createCookieJar();
    const noValueHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      <input type="submit" id="MainContent_btnInitialize" name="ctl00$MainContent$btnInitialize" />
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(noValueHtml), html(noValueHtml)]);
    await expect(forceUnlockAll(jar, fetchImpl)).resolves.toBeUndefined();
  });

  it("throws on non-ok GET / login redirect on GET", async () => {
    const jar1 = createCookieJar();
    await expect(forceUnlockAll(jar1, sequenceFetch([status(500)]))).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(forceUnlockAll(jar2, sequenceFetch([html(LOGIN_REDIRECT_HTML)]))).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });

  it("throws when the button is missing", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(listHtml({ withButton: false }))]);
    await expect(forceUnlockAll(jar, fetchImpl)).rejects.toThrow(TheearthClientError);
  });

  it("throws on non-ok POST / login redirect on POST", async () => {
    const jar1 = createCookieJar();
    await expect(forceUnlockAll(jar1, sequenceFetch([html(listHtml()), status(500)]))).rejects.toThrow(
      TheearthClientError,
    );
    const jar2 = createCookieJar();
    await expect(
      forceUnlockAll(jar2, sequenceFetch([html(listHtml()), html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });
});

describe("verifyReadNoDescending", () => {
  function configHtml(opts: { orderValue?: string; descending?: boolean; noOrderSelect?: boolean; noSelectedOption?: boolean } = {}): string {
    if (opts.noOrderSelect) {
      return `<html><body>表示条件指定 (想定外の構造)</body></html>`;
    }
    const options = opts.noSelectedOption
      ? `<option value="OperationDate">運行日</option><option value="ReadNo">読取日</option>`
      : `<option value="OperationDate">運行日</option><option value="${opts.orderValue ?? "ReadNo"}" selected>選択中</option>`;
    const radio = opts.descending === false
      ? `<input type="radio" id="MainContent_rdoUpOrder0" name="rdo0" value="Up" checked="checked" />
         <input type="radio" id="MainContent_rdoDwOrder0" name="rdo0" value="Down" />`
      : `<input type="radio" id="MainContent_rdoUpOrder0" name="rdo0" value="Up" />
         <input type="radio" id="MainContent_rdoDwOrder0" name="rdo0" value="Down" checked="checked" />`;
    return `<html><body><form>
      <select id="MainContent_ddlOrder0" name="ctl00$MainContent$ddlOrder0">${options}</select>
      ${radio}
    </form></body></html>`;
  }

  it("returns true when ReadNo + descending", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(configHtml())]);
    await expect(verifyReadNoDescending(jar, fetchImpl)).resolves.toBe(true);
  });

  it("returns false when the sort key isn't ReadNo", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(configHtml({ orderValue: "OperationDate" }))]);
    await expect(verifyReadNoDescending(jar, fetchImpl)).resolves.toBe(false);
  });

  it("returns false when sorted ascending", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(configHtml({ descending: false }))]);
    await expect(verifyReadNoDescending(jar, fetchImpl)).resolves.toBe(false);
  });

  it("returns false when the <select> itself is missing (no selected option value)", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(configHtml({ noOrderSelect: true }))]);
    await expect(verifyReadNoDescending(jar, fetchImpl)).resolves.toBe(false);
  });

  it("returns false when no <option> is marked selected", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(configHtml({ noSelectedOption: true }))]);
    await expect(verifyReadNoDescending(jar, fetchImpl)).resolves.toBe(false);
  });

  it("returns false when the selected option has no value attribute", async () => {
    const jar = createCookieJar();
    const noValueHtml = `<html><body><form>
      <select id="MainContent_ddlOrder0" name="x"><option selected>読取日</option></select>
      <input type="radio" id="MainContent_rdoDwOrder0" name="rdo0" checked="checked" />
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(noValueHtml)]);
    await expect(verifyReadNoDescending(jar, fetchImpl)).resolves.toBe(false);
  });

  it("throws on non-ok GET / login redirect on GET", async () => {
    const jar1 = createCookieJar();
    await expect(verifyReadNoDescending(jar1, sequenceFetch([status(500)]))).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      verifyReadNoDescending(jar2, sequenceFetch([html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });
});

describe("downloadEditedZip", () => {
  it("delegates to downloadCsvZip and returns the zip bytes", async () => {
    const jar = createCookieJar();
    const csvPageHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      <input type="radio" id="rdoSelect1" name="rdoSelect1" value="1" />
      <input type="radio" id="rdoDate1" name="rdoDate1" value="1" />
      <input type="text" id="MainContent_ucStartDate_txtYear" name="startY" value="" />
      <input type="text" id="MainContent_ucStartDate_txtMonth" name="startM" value="" />
      <input type="text" id="MainContent_ucStartDate_txtDay" name="startD" value="" />
      <input type="text" id="MainContent_ucEndDate_txtYear" name="endY" value="" />
      <input type="text" id="MainContent_ucEndDate_txtMonth" name="endM" value="" />
      <input type="text" id="MainContent_ucEndDate_txtDay" name="endD" value="" />
      <input type="submit" id="btnCsvSvr" name="btnCsvSvr" value="ダウンロード" />
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(csvPageHtml), zipResponse()]);
    const buf = await downloadEditedZip(jar, { startDate: "2026-07-01", endDate: "2026-07-07" }, fetchImpl);
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
  });
});

// --- F-NRS1010 運転日報 fixture ----------------------------------------------

function reportRowHtml(row: number, v: {
  operationNo?: string;
  startDateTime?: string;
  workEndDateTime?: string;
} = {}): string {
  const id = (field: string) => `MainContent_T1_lstOperation_${field}_${row}`;
  return `
    <span id="${id("lblOperationNo")}">${v.operationNo ?? `OPE${row}`}</span>
    <span id="${id("lblStartDateTime")}">${v.startDateTime ?? "2026/07/01 8:00:00"}</span>
    <span id="${id("lblWorkStartDateTime")}">07/01 07:50</span>
    <span id="${id("lblWorkEndDateTime")}">${v.workEndDateTime ?? "07/01 18:00"}</span>
    <span id="${id("lblOperationStartDateTime")}">2026/07/01 08:00:00</span>
    <span id="${id("lblOperationEndDateTime")}">2026/07/01 18:00:00</span>
    <span id="${id("lblDriverState1Min")}">1:00</span>
    <span id="${id("lblDriverState2Min")}"></span>
    <span id="${id("lblDriverState3Min")}">0:30</span>
    <span id="${id("lblDriverState4Min")}">0:15</span>
    <span id="${id("lblDriverState5Min")}">0:05</span>
    <span id="${id("lblTotalRunningDist")}">120</span>
    <span id="${id("lblStartOdometer")}">1000</span>
    <span id="${id("lblEndOdometer")}">1120</span>
    <span id="${id("lblNwayRunningDist")}">80</span>
    <span id="${id("lblEwayRunningDist")}">40</span>
    <span id="${id("lblBwayRunningDist")}">0</span>
    <span id="${id("lblIntankFuel1")}">20</span>
    <span id="${id("lblSSFuel1")}">0</span>
  `;
}

function pagerLink(target: string, argument: string, text: string): string {
  return `<a href="javascript:__doPostBack('${target}','${argument}')">${text}</a>`;
}

/** `reportPageHtml({ links: [...] })` に渡す `{target, argument, text}` を作る。 */
function link(target: string, argument: string, text: string): { target: string; argument: string; text: string } {
  return { target, argument, text };
}

function reportPageHtml(opts: {
  rows: { operationNo: string; startDateTime: string; workEndDateTime: string }[];
  currentPage: number;
  links: { target: string; argument: string; text: string }[];
}): string {
  const rowsHtml = opts.rows
    .map((r, i) => reportRowHtml(i, { operationNo: r.operationNo, startDateTime: r.startDateTime, workEndDateTime: r.workEndDateTime }))
    .join("\n");
  const linksHtml = opts.links.map((l) => pagerLink(l.target, l.argument, l.text)).join("\n");
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-${opts.currentPage}" />
    ${rowsHtml}
    <span class="gCurrentPage">${opts.currentPage}</span>
    ${linksHtml}
  </form></body></html>`;
}

describe("harvestDailyReport", () => {
  it("passes through an unparseable workEndDateTime/startDateTime as-is (defensive fallback)", async () => {
    const jar = createCookieJar();
    const page = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "不正な形式", workEndDateTime: "不正な形式" }],
      currentPage: 1,
      links: [],
    });
    const fetchImpl = sequenceFetch([html(page)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    // 範囲比較・単調性検証のどちらにも合致しないため、結果としては除外される
    // (パース不能値をでっち上げの日付にせず、そのまま弾かれる形にしてある)。
    expect(rows).toEqual([]);
  });

  it("rejects a malformed range", async () => {
    const jar = createCookieJar();
    await expect(harvestDailyReport(jar, { from: "bad", to: "2026/07/07 00:00" })).rejects.toThrow(
      ReportParamError,
    );
  });

  it("throws on non-ok GET / login redirect on the initial GET", async () => {
    const jar1 = createCookieJar();
    await expect(
      harvestDailyReport(jar1, { from: "2026/07/01 00:00", to: "2026/07/07 00:00" }, sequenceFetch([status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      harvestDailyReport(
        jar2,
        { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
        sequenceFetch([html(LOGIN_REDIRECT_HTML)]),
      ),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("resets to the first page when a 最初 link is present, then early-breaks once below `from`", async () => {
    const jar = createCookieJar();
    const page1WithFirstLink = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 1,
      links: [link("ctl01$first", "", "最初"), link("ctl01$ctl02", "", "2")],
    });
    const afterFirst = reportPageHtml({
      rows: [
        { operationNo: "B", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" },
        { operationNo: "C", startDateTime: "2026/06/29 08:00:00", workEndDateTime: "06/29 18:00" }, // range.from 未満
      ],
      currentPage: 1,
      links: [link("ctl01$ctl02", "", "2")],
    });
    const fetchImpl = sequenceFetch([html(page1WithFirstLink), html(afterFirst)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["B"]);
  });

  it("walks to the next numbered page when the current page doesn't reach `from`", async () => {
    const jar = createCookieJar();
    const page1 = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 1,
      links: [link("ctl01$ctl02", "", "2")],
    });
    const page2 = reportPageHtml({
      rows: [{ operationNo: "B", startDateTime: "2026/06/20 08:00:00", workEndDateTime: "06/20 18:00" }],
      currentPage: 2,
      links: [],
    });
    const fetchImpl = sequenceFetch([html(page1), html(page2)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A"]);
  });

  it("follows a ... link to cross a pager window, then finds the target page", async () => {
    const jar = createCookieJar();
    const page1 = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 1,
      links: [link("ctl01$more", "", "...")],
    });
    const windowJump = reportPageHtml({
      rows: [],
      currentPage: 1,
      links: [link("ctl02$ctl02", "", "2")],
    });
    const page2 = reportPageHtml({
      // B は A より新しくないが範囲内 (07/01〜07/07)。C は範囲下限未満で早期打ち切りを誘発する。
      rows: [
        { operationNo: "B", startDateTime: "2026/07/03 08:00:00", workEndDateTime: "07/03 18:00" },
        { operationNo: "C", startDateTime: "2026/06/20 08:00:00", workEndDateTime: "06/20 18:00" },
      ],
      currentPage: 2,
      links: [],
    });
    const fetchImpl = sequenceFetch([html(page1), html(windowJump), html(page2)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A", "B"]);
  });

  it("stops when no next page link can be found at all (last page)", async () => {
    const jar = createCookieJar();
    const onlyPage = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 1,
      links: [],
    });
    const fetchImpl = sequenceFetch([html(onlyPage)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A"]);
  });

  it("falls back to a full scan when a workEndDateTime increase (non-descending) is detected", async () => {
    const jar = createCookieJar();
    const page1 = reportPageHtml({
      rows: [
        { operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" },
        // 前行より新しい (増加) = 降順が崩れている
        { operationNo: "B", startDateTime: "2026/07/06 08:00:00", workEndDateTime: "07/06 18:00" },
      ],
      currentPage: 1,
      links: [],
    });
    const fetchImpl = sequenceFetch([html(page1)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A", "B"]);
  });

  it("carries the workEndDateTime into the following year when it wraps around (Dec -> Jan)", async () => {
    const jar = createCookieJar();
    const page1 = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/12/31 20:00:00", workEndDateTime: "01/02 08:00" }],
      currentPage: 1,
      links: [],
    });
    const fetchImpl = sequenceFetch([html(page1)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/12/01 00:00", to: "2027/01/31 00:00" },
      fetchImpl,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.workEndDateTime).toBe("2027/01/02 08:00");
  });

  it("defaults missing grid cells to null/empty instead of throwing", async () => {
    const jar = createCookieJar();
    // lblStartDateTime / lblWorkEndDateTime のセルが (仕様変更等で) 欠落しているケース。
    const partialRowHtml = `
      <span id="MainContent_T1_lstOperation_lblOperationNo_0">A</span>
    `;
    const page1 = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${partialRowHtml}
      <span class="gCurrentPage">1</span>
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(page1)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    // workEndDateTime が空文字になり範囲比較で弾かれるため、収集元データとしては
    // 空配列になる (黙って別行として混入させない)。
    expect(rows).toEqual([]);
  });

  it("defaults lblOperationNo itself to an empty string when unparseable (id present, no matching </span>)", async () => {
    const jar = createCookieJar();
    // 行の存在検出 (id 属性の有無) と内容抽出 (閉じ </span> 必須) は別ロジックなので、
    // 自己終端タグは「行としては見つかるが内容は取れない」を再現できる。
    const page1 = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      <span id="MainContent_T1_lstOperation_lblOperationNo_0" />
      <div class="gCurrentPage">1</div>
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(page1)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows).toEqual([]);
  });

  it("falls back to page 1 when no gCurrentPage marker is present on the first page", async () => {
    const jar = createCookieJar();
    const page1NoCurrentPageMarker = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${reportRowHtml(0, { operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" })}
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(page1NoCurrentPageMarker)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A"]);
  });

  it("falls back to the previous currentPage when the ... jump target has no gCurrentPage marker", async () => {
    const jar = createCookieJar();
    const page1 = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 1,
      links: [link("ctl01$more", "", "...")],
    });
    const windowJumpNoMarker = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-jump" />
      ${pagerLink("ctl02$ctl02", "", "2")}
    </form></body></html>`;
    const page2 = reportPageHtml({
      rows: [{ operationNo: "B", startDateTime: "2026/06/20 08:00:00", workEndDateTime: "06/20 18:00" }],
      currentPage: 2,
      links: [],
    });
    const fetchImpl = sequenceFetch([html(page1), html(windowJumpNoMarker), html(page2)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A"]);
  });

  it("throws on non-ok POST / login redirect while paging", async () => {
    const jar1 = createCookieJar();
    const page1 = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 1,
      links: [link("ctl01$ctl02", "", "2")],
    });
    await expect(
      harvestDailyReport(
        jar1,
        { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
        sequenceFetch([html(page1), status(500)]),
      ),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      harvestDailyReport(
        jar2,
        { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
        sequenceFetch([html(page1), html(LOGIN_REDIRECT_HTML)]),
      ),
    ).rejects.toThrow(VenusSessionExpiredError);
  });
});
