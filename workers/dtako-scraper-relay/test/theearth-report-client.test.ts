import { describe, expect, it } from "vitest";
import {
  downloadEditedZip,
  downloadOperationCsvZip,
  extractLstFuelTextInputs,
  getExpenseForm,
  getReviseForm,
  getWorkForm,
  harvestDailyReport,
  parseExpenseMasters,
  recalculateExpense,
  recalculateWork,
  startSystemLink,
  ReportParamError,
  saveDriver,
  saveFuelRow,
  saveWorkRows,
  unlockOperation,
  verifyReadNoDescending,
  withVehicleNarrow,
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
// 実 DOM 構造 (cdp-pair 実機確認、Refs #183、2026-07-08): `MainContent_` prefix は
// 無い。表示専用行は `lstFuel_lbl<Field>_<N>` の <span>、編集ボタン押下後にだけ
// `lstFuel_etxt<Field>_<N>` の編集用 <input> + `lstFuel_btnUpdateButton_<N>` が現れる。

function fuelDisplayRowHtml(ctrlIndex: number, v: {
  category?: string;
  categoryName?: string | null;
  station?: string;
  stationName?: string;
  type?: string;
  typeName?: string;
  dateTime?: string;
  quantity?: string;
  editButton?: boolean;
} = {}): string {
  // 表示行 span・編集ボタンとも実機準拠の `lstFuel_<suffix>_<N>` 形式。
  const id = (suffix: string) => `lstFuel_${suffix}_${ctrlIndex}`;
  return `
    ${
      v.editButton === false
        ? "" // 編集ボタン自体を欠落させる (findFormFieldById が null を返すケースの fixture)
        : `<input type="submit" id="${id("btnEditButton")}" name="lstFuel$ctrl${ctrlIndex}$btnEditButton" value="" />`
    }
    <span id="${id("lblSupplyCategory")}">${v.category ?? "1"}</span>
    ${
      v.categoryName === null
        ? "" // 名称 span 欠落 (extractSpanTextById が null → "" にフォールバックするケース)
        : `<span id="${id("lblSupplyCategoryName")}">${v.categoryName ?? "主燃料"}</span>`
    }
    <span id="${id("lblSupplyStation")}">${v.station ?? "1"}</span>
    <span id="${id("lblSupplyStationName")}">${v.stationName ?? "自社"}</span>
    <span id="${id("lblSupplyType")}">${v.type ?? "1"}</span>
    <span id="${id("lblSupplyTypeName")}">${v.typeName ?? "軽油"}</span>
    <span id="${id("lblDateTime")}">${v.dateTime ?? "26/07/07 10:29"}</span>
    <span id="${id("lblQuantuty")}">${v.quantity ?? "100"}</span>
  `;
}

function expenseFormHtml(opts: {
  rows?: number;
  linkSysDisabled?: boolean;
  recalculated?: boolean;
  scoreButtonNoValue?: boolean;
} = {}): string {
  const rowCount = opts.rows ?? 2;
  const rows = Array.from({ length: rowCount }, (_, i) => fuelDisplayRowHtml(i, { category: String(i + 1) })).join("\n");
  const linkSysClass = opts.linkSysDisabled === false ? "ButtonCrimson" : "aspNetDisabled ButtonCrimson";
  const scoreValueAttr = opts.scoreButtonNoValue ? "" : ' value="評価点再集計"';
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
    ${rows}
    <input type="submit" id="btnScore" name="btnScore"${scoreValueAttr} />
    <input type="submit" id="btnLinkSys" name="btnLinkSys" value="システム連動開始" class="${linkSysClass}" />
    ${opts.recalculated ? "<div>再集計が終了しました。</div>" : ""}
  </form></body></html>`;
}

/** 編集ボタン postback 後の応答 (対象行だけが編集モードになった状態)。 */
function fuelEditModeHtml(ctrlIndex: number, v: {
  category?: string;
  station?: string;
  type?: string;
  dateTime?: string;
  quantity?: string | null;
  updateButton?: boolean;
} = {}): string {
  const id = (suffix: string) => `lstFuel_${suffix}_${ctrlIndex}`;
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-EDIT" />
    <input type="text" id="${id("etxtOperationNo")}" name="lstFuel$ctrl${ctrlIndex}$etxtOperationNo" value="26070605100100000040" />
    <input type="text" id="${id("etxtSubNo")}" name="lstFuel$ctrl${ctrlIndex}$etxtSubNo" value="1" />
    <input type="text" id="${id("etxtSupplyCategory")}" name="lstFuel$ctrl${ctrlIndex}$etxtSupplyCategory" value="${v.category ?? "1"}" />
    <input type="text" id="${id("etxtSupplyStation")}" name="lstFuel$ctrl${ctrlIndex}$etxtSupplyStation" value="${v.station ?? "1"}" />
    <input type="text" id="${id("etxtSupplyType")}" name="lstFuel$ctrl${ctrlIndex}$etxtSupplyType" value="${v.type ?? "10"}" />
    <input type="text" id="${id("etxtDateTime")}" name="lstFuel$ctrl${ctrlIndex}$etxtDateTime" value="${v.dateTime ?? "26/07/07 10:29"}" />
    <input type="text" id="${id("etxtOldDateTime")}" name="lstFuel$ctrl${ctrlIndex}$etxtOldDateTime" value="2026/07/07 10:29:07" />
    ${
      v.quantity === null
        ? "" // 要素そのものを欠落させる (defensive skip の fixture)
        : `<input type="text" id="${id("etxtQuantuty")}" name="lstFuel$ctrl${ctrlIndex}$etxtQuantuty" value="${v.quantity ?? "35.5"}" />`
    }
    ${
      v.updateButton === false
        ? ""
        : `<input type="submit" id="${id("btnUpdateButton")}" name="lstFuel$ctrl${ctrlIndex}$btnUpdateButton" value="" />`
    }
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
    expect(form.fuelRows[0]).toMatchObject({
      ctrlIndex: 0,
      supplyCategory: "1",
      supplyCategoryName: "主燃料",
      supplyStationName: "自社",
      supplyTypeName: "軽油",
      quantity: "100.0", // 補給量は小数第 1 位表記に整形する
    });
  });

  it("ClientInit マスタも同じ応答から抽出して返す", async () => {
    const jar = createCookieJar();
    const pageHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${fuelDisplayRowHtml(0)}
    </form>${clientInitScript(KUBUN)}</body></html>`;
    const fetchImpl = sequenceFetch([html(pageHtml)]);
    const form = await getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl);
    expect(form.masters.supplyCategory["3"]).toBe("消耗品");
    expect(form.masters.fuelType["1"]).toBe("軽油");
  });

  it("補給量を小数第 1 位に整形する (35.5 はそのまま / 非数値・空は素通し)", async () => {
    const jar = createCookieJar();
    const rows = [
      fuelDisplayRowHtml(0, { quantity: "40" }),
      fuelDisplayRowHtml(1, { quantity: "35.5" }),
      fuelDisplayRowHtml(2, { quantity: "" }),
      fuelDisplayRowHtml(3, { quantity: "不明" }),
    ].join("\n");
    const pageHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${rows}
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(pageHtml)]);
    const form = await getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl);
    expect(form.fuelRows.map((r) => r.quantity)).toEqual(["40.0", "35.5", "", "不明"]);
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
    const missingNameHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${fuelDisplayRowHtml(0, { categoryName: null })}
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(missingNameHtml)]);
    const form = await getExpenseForm(jar, OPE_NO, START_OPE, fetchImpl);
    expect(form.fuelRows[0]?.supplyCategoryName).toBe("");
  });
});

// 実機 (cdp-pair, 2026-07-08) の ClientInit マスタ文字列の代表サブセット。
// 項目区切り `,`・グループ区切り `/n` (リテラル)・`-1` 見出し・給油無関係キー
// (TOLLSETUKB) をすべて含む。
const KUBUN =
  "ADDITIVCLS:-1:添加剤種別,ADDITIVCLS:0:なし,ADDITIVCLS:1:Adblue" +
  "/nFUELTYPE:-1:燃料種別,FUELTYPE:1:軽油,FUELTYPE:2:ガソリン,FUELTYPE:3:LNG,FUELTYPE:4:電気" +
  "/nSUPPLYCTGRY:-1:給油点検分類,SUPPLYCTGRY:1:主燃料,SUPPLYCTGRY:2:主添加剤,SUPPLYCTGRY:3:消耗品,SUPPLYCTGRY:4:副燃料,SUPPLYCTGRY:5:副添加剤" +
  "/nTOLLSETUKB:-1:料金精算区分,TOLLSETUKB:0:コーポレート" +
  "/nCONSUMABLE:1:オイル" +
  "/nPUTGASKB:1:自社,PUTGASKB:2:吉田石油,PUTGASKB:3:西日本F";

function clientInitScript(kubun: string): string {
  return `<script type="text/javascript">//<![CDATA[\nClientInit('', '', '${kubun}', '', '編集_削除_新規_未登録のコードです。');\n//]]></` + `script>`;
}

describe("parseExpenseMasters", () => {
  it("ClientInit の kubun を enum キー別 code→name に分解する (実機 _Enum と同じ形)", () => {
    const masters = parseExpenseMasters(`<html><body>${clientInitScript(KUBUN)}</body></html>`);
    // 分類 (SUPPLYCTGRY): -1 見出しは落とす
    expect(masters.supplyCategory).toEqual({
      "1": "主燃料",
      "2": "主添加剤",
      "3": "消耗品",
      "4": "副燃料",
      "5": "副添加剤",
    });
    // 区分 (PUTGASKB)
    expect(masters.supplyStation).toEqual({ "1": "自社", "2": "吉田石油", "3": "西日本F" });
    // 種別マスタ 3 種
    expect(masters.fuelType).toEqual({ "1": "軽油", "2": "ガソリン", "3": "LNG", "4": "電気" });
    // ADDITIVCLS は code 0 (なし) を含む 0 始まり
    expect(masters.additive).toEqual({ "0": "なし", "1": "Adblue" });
    expect(masters.consumable).toEqual({ "1": "オイル" });
  });

  it("ClientInit が無い応答 (cold GET / 給油 0 件) では全マップ空", () => {
    const masters = parseExpenseMasters("<html><body><form></form></body></html>");
    expect(masters).toEqual({
      supplyCategory: {},
      supplyStation: {},
      fuelType: {},
      additive: {},
      consumable: {},
    });
  });

  it("3 パート未満の壊れた項目は無視する (name 欠落等)", () => {
    // "SUPPLYCTGRY:9" は code のみで name が無い (2 パート) → 落とす
    const masters = parseExpenseMasters(
      `<html>${clientInitScript("SUPPLYCTGRY:9/nSUPPLYCTGRY:1:主燃料")}</html>`,
    );
    expect(masters.supplyCategory).toEqual({ "1": "主燃料" });
  });
});

describe("extractLstFuelTextInputs", () => {
  it("lstFuel の text 入力だけを name→value で抽出する (Refs #199)", () => {
    const html = `
      <input type="text" name="lstFuel$ctrl0$etxtOperationNo" value="2607060510" />
      <input type="text" name="lstFuel$ctrl0$etxtSubNo" value="1" />
      <input type="text" id="q" name="lstFuel$ctrl0$etxtQuantuty" value="100" />
      <input type="text" name="lstFuel$ctrl1$itxtQuantuty" />            <!-- value 属性なし → "" -->
      <input type="hidden" name="lstFuel$ctrl0$etxtHidden" value="x" />  <!-- text でない → 除外 -->
      <input type="submit" name="lstFuel$ctrl0$btnUpdateButton" value="" /> <!-- text でない → 除外 -->
      <input type="text" name="lstTollRoad$ctrl0$etxtFoo" value="9" />   <!-- lstFuel 以外 → 除外 -->
      <input type="text" value="noname" />                              <!-- name 無し → 除外 -->
    `;
    expect(extractLstFuelTextInputs(html)).toEqual({
      "lstFuel$ctrl0$etxtOperationNo": "2607060510",
      "lstFuel$ctrl0$etxtSubNo": "1",
      "lstFuel$ctrl0$etxtQuantuty": "100",
      "lstFuel$ctrl1$itxtQuantuty": "",
    });
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
    dateTime: "26/07/07 12:00",
    quantity: "40",
  };

  it("saves the edited row and returns the refreshed rows", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 2 })),
      html(fuelEditModeHtml(0)),
      html(expenseFormHtml({ rows: 2 })),
    ]);
    const result = await saveFuelRow(jar, baseParams, fetchImpl);
    expect(result.fuelRows).toHaveLength(2);
  });

  it("更新 POST に編集行の全 etxt (OperationNo/SubNo/OldDateTime 含む) を送り、編集値で上書きする (Refs #199)", async () => {
    const jar = createCookieJar();
    const bodies: string[] = [];
    const responses = [
      html(expenseFormHtml({ rows: 1 })),
      html(fuelEditModeHtml(0)),
      html(expenseFormHtml({ rows: 1 })),
    ];
    let call = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.body) bodies.push(String(init.body));
      return responses[call++]!;
    };
    await saveFuelRow(jar, baseParams, fetchImpl);
    const updateBody = new URLSearchParams(bodies[1]); // 2 回目の POST = 更新
    // 欠落していた等の全 etxt が現在値で送られる (FormatException 回避の要)
    expect(updateBody.get("lstFuel$ctrl0$etxtOperationNo")).toBe("26070605100100000040");
    expect(updateBody.get("lstFuel$ctrl0$etxtSubNo")).toBe("1");
    expect(updateBody.get("lstFuel$ctrl0$etxtOldDateTime")).toBe("2026/07/07 10:29:07");
    // 対象行の編集対象フィールドは params の新値で上書き
    expect(updateBody.get("lstFuel$ctrl0$etxtSupplyCategory")).toBe("2");
    expect(updateBody.get("lstFuel$ctrl0$etxtDateTime")).toBe("26/07/07 12:00");
    expect(updateBody.get("lstFuel$ctrl0$etxtQuantuty")).toBe("40");
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

  it("throws when the edit button is missing", async () => {
    const jar = createCookieJar();
    const noButtonHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${fuelDisplayRowHtml(0, { editButton: false })}
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(noButtonHtml)]);
    await expect(saveFuelRow(jar, baseParams, fetchImpl)).rejects.toThrow(TheearthClientError);
  });

  it("throws on non-ok POST / login redirect on the edit-start POST", async () => {
    const jar1 = createCookieJar();
    await expect(
      saveFuelRow(jar1, baseParams, sequenceFetch([html(expenseFormHtml({ rows: 1 })), status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      saveFuelRow(jar2, baseParams, sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("500 応答の ASP.NET エラー詳細をエラーメッセージに含める (調査用、Refs #199)", async () => {
    // <title> のある ASP.NET エラーページ → title を要約に採用
    const jar1 = createCookieJar();
    const aspErr = new Response(
      "<html><head><title>Runtime Error</title></head><body>Server Error in '/' Application.</body></html>",
      { status: 500, headers: { "content-type": "text/html" } },
    );
    await expect(
      saveFuelRow(jar1, baseParams, sequenceFetch([html(expenseFormHtml({ rows: 1 })), aspErr])),
    ).rejects.toThrow(/POST が HTTP 500 を返しました — Runtime Error/);
  });

  it("500 応答の本文が空なら詳細サフィックスを付けない (調査用)", async () => {
    const jar = createCookieJar();
    const emptyErr = new Response("", { status: 500 });
    await expect(
      saveFuelRow(jar, baseParams, sequenceFetch([html(expenseFormHtml({ rows: 1 })), emptyErr])),
    ).rejects.toThrow(/^POST が HTTP 500 を返しました$/);
  });

  it("500 応答本文が title 無し・長文なら 200 字で切り詰める (調査用)", async () => {
    const jar = createCookieJar();
    const longBody = new Response("x".repeat(500), { status: 500 });
    let caught: unknown;
    await saveFuelRow(jar, baseParams, sequenceFetch([html(expenseFormHtml({ rows: 1 })), longBody])).catch(
      (e: unknown) => {
        caught = e;
      },
    );
    const message = (caught as Error).message;
    expect(message).toContain("…");
    expect(message).toContain("x".repeat(200));
    expect(message).not.toContain("x".repeat(201));
  });

  it("throws when the edit-start response indicates a concurrent-edit conflict", async () => {
    const jar = createCookieJar();
    const conflictHtml = `<html><body>他ユーザー編集中のため処理を中止しました。</body></html>`;
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(conflictHtml)]);
    await expect(saveFuelRow(jar, baseParams, fetchImpl)).rejects.toThrow(/他ユーザー/);
  });

  it("throws when the update button is missing (edit-start postback didn't enter edit mode)", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1 })),
      html(fuelEditModeHtml(0, { updateButton: false })),
    ]);
    await expect(saveFuelRow(jar, baseParams, fetchImpl)).rejects.toThrow(TheearthClientError);
  });

  it("skips writing a field whose element is missing from the edit response (defensive, doesn't throw)", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1 })),
      html(fuelEditModeHtml(0, { quantity: null })),
      html(expenseFormHtml({ rows: 1 })),
    ]);
    const result = await saveFuelRow(jar, baseParams, fetchImpl);
    expect(result.fuelRows).toHaveLength(1);
  });

  it("throws on non-ok POST / login redirect on the update POST", async () => {
    const jar1 = createCookieJar();
    await expect(
      saveFuelRow(
        jar1, baseParams,
        sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(fuelEditModeHtml(0)), status(500)]),
      ),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      saveFuelRow(
        jar2, baseParams,
        sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(fuelEditModeHtml(0)), html(LOGIN_REDIRECT_HTML)]),
      ),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws when the update response indicates a concurrent-edit conflict", async () => {
    const jar = createCookieJar();
    const conflictHtml = `<html><body>他ユーザー編集中のため処理を中止しました。</body></html>`;
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(fuelEditModeHtml(0)), html(conflictHtml)]);
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
      <input type="submit" id="btnScore" name="btnScore" value="評価点再集計" />
      再集計が終了しました。
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(noLinkSysHtml)]);
    const result = await recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl);
    expect(result.linkSysEnabled).toBe(false);
  });

  it("falls back to a default label when the score button has no value attribute", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1, scoreButtonNoValue: true })),
      html(expenseFormHtml({ rows: 1, recalculated: true })),
    ]);
    const result = await recalculateExpense(jar, OPE_NO, START_OPE, fetchImpl);
    expect(result.linkSysEnabled).toBe(false);
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
    const noButtonHtml = `<html><body><form><input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" /></form></body></html>`;
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

describe("startSystemLink", () => {
  // btnLinkSys postback (連動) の応答。conflict / 成功文言有無 / btnLinkSys の value を制御。
  const linkResponseHtml = (v: { linkedMsg?: boolean; conflict?: boolean } = {}): string =>
    `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-LINK" />
      ${v.conflict ? "他ユーザー編集中のため処理を中止しました。" : ""}
      ${v.linkedMsg === false ? "" : "<div>システム連動を開始しました。</div>"}
    </form></body></html>`;
  // btnScore postback 後の応答 (再集計完了 + btnLinkSys enable、value 制御可)。
  const recalcedHtml = (v: { linkSysValue?: string } = {}): string =>
    `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-EDIT" />
      <input type="submit" id="btnScore" name="btnScore" value="評価点再集計" />
      <input type="submit" id="btnLinkSys" name="btnLinkSys" value="${v.linkSysValue ?? "システム連動開始"}" class="ButtonCrimson" />
      再集計が終了しました。
    </form></body></html>`;

  it("recalc → btnLinkSys 連鎖で連動し linked=true を返す", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1 })),
      html(recalcedHtml()),
      html(linkResponseHtml({ linkedMsg: true })),
    ]);
    const res = await startSystemLink(jar, OPE_NO, START_OPE, fetchImpl);
    expect(res).toMatchObject({ linked: true, recalcConfirmed: true, linkSysWasEnabled: true });
  });

  it("連動応答に成功文言が無ければ linked=false + message を返す", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1 })),
      html(recalcedHtml({ linkSysValue: "" })), // btnLinkSys value 空 → ラベル fallback を通す
      html(linkResponseHtml({ linkedMsg: false })),
    ]);
    const res = await startSystemLink(jar, OPE_NO, START_OPE, fetchImpl);
    expect(res.linked).toBe(false);
  });

  it("btnScore の value 無しでもラベル fallback で連鎖する", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1, scoreButtonNoValue: true })),
      html(recalcedHtml()),
      html(linkResponseHtml({ linkedMsg: true })),
    ]);
    const res = await startSystemLink(jar, OPE_NO, START_OPE, fetchImpl);
    expect(res.linked).toBe(true);
  });

  it("rejects malformed OpeNo / StartOpe", async () => {
    const jar = createCookieJar();
    await expect(startSystemLink(jar, "bad", START_OPE)).rejects.toThrow(ReportParamError);
    await expect(startSystemLink(jar, OPE_NO, "bad")).rejects.toThrow(ReportParamError);
  });

  it("throws on non-ok GET / login redirect on GET", async () => {
    const jar1 = createCookieJar();
    await expect(startSystemLink(jar1, OPE_NO, START_OPE, sequenceFetch([status(500)]))).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      startSystemLink(jar2, OPE_NO, START_OPE, sequenceFetch([html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws when btnScore is missing", async () => {
    const jar = createCookieJar();
    const noScoreHtml = `<html><body><form><input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" /></form></body></html>`;
    await expect(startSystemLink(jar, OPE_NO, START_OPE, sequenceFetch([html(noScoreHtml)]))).rejects.toThrow(TheearthClientError);
  });

  it("throws when the recalc completion message is missing (連動の前提)", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(expenseFormHtml({ rows: 1 }))]);
    await expect(startSystemLink(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(/再集計/);
  });

  it("throws when btnLinkSys is absent after recalc", async () => {
    const jar = createCookieJar();
    const noLinkSysHtml = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      <input type="submit" id="btnScore" name="btnScore" value="評価点再集計" />
      再集計が終了しました。
    </form></body></html>`;
    await expect(
      startSystemLink(jar, OPE_NO, START_OPE, sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(noLinkSysHtml)])),
    ).rejects.toThrow(/btnLinkSys|見つかりません/);
  });

  it("throws when btnLinkSys is still disabled after recalc", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1 })),
      html(expenseFormHtml({ rows: 1, linkSysDisabled: true, recalculated: true })),
    ]);
    await expect(startSystemLink(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(/有効になりませんでした/);
  });

  it("throws on concurrent-edit conflict during recalc", async () => {
    const jar = createCookieJar();
    const conflictHtml = `<html><body>他ユーザー編集中のため処理を中止しました。</body></html>`;
    await expect(
      startSystemLink(jar, OPE_NO, START_OPE, sequenceFetch([html(expenseFormHtml({ rows: 1 })), html(conflictHtml)])),
    ).rejects.toThrow(/編集中のため/);
  });

  it("throws on concurrent-edit conflict during link postback", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(expenseFormHtml({ rows: 1 })),
      html(recalcedHtml()),
      html(linkResponseHtml({ conflict: true })),
    ]);
    await expect(startSystemLink(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(/編集中のため/);
  });
});

describe("unlockOperation", () => {
  // 実 DOM 構造 (cdp-pair 実機確認、Refs #183、2026-07-08): `MainContent_` prefix は
  // 無い。対象行が一覧に現在表示されている必要は無く、txtOperationNo/
  // txtStartDateTime に対象値を直接書いて送れば解除できる (実機確認済み)。
  function unlockListHtml(opts: {
    withButton?: boolean;
    buttonNoValue?: boolean;
    withHiddenFields?: boolean;
  } = {}): string {
    const hiddenFields = opts.withHiddenFields === false
      ? ""
      : `
        <input type="text" id="txtOperationNo" name="ctl00$MainContent$txtOperationNo" class="none" />
        <input type="text" id="txtStartDateTime" name="ctl00$MainContent$txtStartDateTime" class="none" />
        <input type="text" id="txtIndex" name="ctl00$MainContent$txtIndex" class="none" />
        <input type="text" id="txtCurrentID" name="ctl00$MainContent$txtCurrentID" class="none" />
      `;
    const buttonValueAttr = opts.buttonNoValue ? "" : ' value="編集制御解除"';
    const button = opts.withButton === false
      ? ""
      : `<input type="submit" id="btnInitialize" name="ctl00$MainContent$btnInitialize"${buttonValueAttr} />`;
    return `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${hiddenFields}
      ${button}
    </form></body></html>`;
  }

  it("unlocks the target operation", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(unlockListHtml()), html(unlockListHtml())]);
    await expect(
      unlockOperation(jar, { opeNo: OPE_NO, startOpe: START_OPE }, fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("falls back to a default label when the button has no value attribute", async () => {
    const jar = createCookieJar();
    const noValueHtml = unlockListHtml({ buttonNoValue: true });
    const fetchImpl = sequenceFetch([html(noValueHtml), html(noValueHtml)]);
    await expect(
      unlockOperation(jar, { opeNo: OPE_NO, startOpe: START_OPE }, fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("rejects malformed OpeNo / StartOpe", async () => {
    const jar = createCookieJar();
    await expect(unlockOperation(jar, { opeNo: "bad", startOpe: START_OPE })).rejects.toThrow(ReportParamError);
    await expect(unlockOperation(jar, { opeNo: OPE_NO, startOpe: "bad" })).rejects.toThrow(ReportParamError);
  });

  it("throws on non-ok GET / login redirect on GET", async () => {
    const jar1 = createCookieJar();
    await expect(
      unlockOperation(jar1, { opeNo: OPE_NO, startOpe: START_OPE }, sequenceFetch([status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      unlockOperation(jar2, { opeNo: OPE_NO, startOpe: START_OPE }, sequenceFetch([html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws when the button is missing", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(unlockListHtml({ withButton: false }))]);
    await expect(
      unlockOperation(jar, { opeNo: OPE_NO, startOpe: START_OPE }, fetchImpl),
    ).rejects.toThrow(TheearthClientError);
  });

  it("throws when the row-selection hidden fields are missing", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(unlockListHtml({ withHiddenFields: false }))]);
    await expect(
      unlockOperation(jar, { opeNo: OPE_NO, startOpe: START_OPE }, fetchImpl),
    ).rejects.toThrow(TheearthClientError);
  });

  it("throws on non-ok POST / login redirect on POST", async () => {
    const jar1 = createCookieJar();
    await expect(
      unlockOperation(jar1, { opeNo: OPE_NO, startOpe: START_OPE }, sequenceFetch([html(unlockListHtml()), status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      unlockOperation(
        jar2, { opeNo: OPE_NO, startOpe: START_OPE },
        sequenceFetch([html(unlockListHtml()), html(LOGIN_REDIRECT_HTML)]),
      ),
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

describe("withVehicleNarrow", () => {
  const range = { from: "1000", to: "1000" };

  // F-DES1010 (親一覧ページ)。btnUpdate + select (full form 直列化の検証用) を持つ。
  function operationListHtml(opts: { missingBtnUpdate?: boolean } = {}): string {
    return `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-DES" />
      <select id="MainContent_ddlRowCount" name="ctl00$MainContent$ddlRowCount">
        <option value="10">10</option><option value="30" selected>30</option>
      </select>
      ${opts.missingBtnUpdate ? "" : `<input type="submit" id="btnUpdate" name="ctl00$MainContent$btnUpdate" value="更新" />`}
    </form></body></html>`;
  }

  function displayConfigHtml(opts: { sVehicle?: string; eVehicle?: string; missingVehicleFields?: boolean; missingBtnOK?: boolean } = {}): string {
    if (opts.missingVehicleFields) {
      return `<html><body><form>
        <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-GOS" />
      </form></body></html>`;
    }
    return `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-GOS" />
      <input type="text" id="txtSDriver" name="txtSDriver" value="baseline-driver" />
      <input type="text" id="txtSVehicle" name="txtSVehicle" value="${opts.sVehicle ?? ""}" />
      <input type="text" id="txtEVehicle" name="txtEVehicle" value="${opts.eVehicle ?? ""}" />
      <select id="ddlOrder0" name="ddlOrder0"><option value="ReadNo" selected>読取日</option><option value="OperationDate">運行日</option></select>
      ${opts.missingBtnOK ? "" : `<input type="submit" id="btnOK" name="btnOK" value="適用" />`}
    </form></body></html>`;
  }

  /** 成功系の標準 fetch モック: GET DES → GET GOS → POST 適用 → POST btnUpdate →
   * POST 復元 の順で応答し、POST body を capture する。 */
  function narrowFetchMock(opts: { gosHtml?: string; desHtml?: string; firstPage?: string } = {}) {
    const bodies: string[] = [];
    let call = 0;
    const fetchImpl = (async (_url, init) => {
      call += 1;
      if (call === 1) return html(opts.desHtml ?? operationListHtml());
      if (call === 2) return html(opts.gosHtml ?? displayConfigHtml());
      bodies.push(String(init?.body ?? ""));
      if (call === 4) return html(opts.firstPage ?? "first-page-html");
      return html("applied");
    }) as FetchLike;
    return { fetchImpl, bodies };
  }

  it("rejects a non-numeric or over-length vehicle CD before making any request", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([]);
    await expect(
      withVehicleNarrow(jar, { from: "abc", to: "1000" }, async () => "ok", fetchImpl),
    ).rejects.toThrow(ReportParamError);
    await expect(
      withVehicleNarrow(jar, { from: "1000", to: "123456789" }, async () => "ok", fetchImpl),
    ).rejects.toThrow(ReportParamError);
  });

  it("applies via btnOK, refreshes via full-form btnUpdate, passes the filtered first page to fn, then restores", async () => {
    const jar = createCookieJar();
    const { fetchImpl, bodies } = narrowFetchMock({ firstPage: "<html>filtered-first-page</html>" });

    const seen: { jar?: unknown; firstPageHtml?: string } = {};
    const result = await withVehicleNarrow(
      jar,
      range,
      async (innerJar, firstPageHtml) => {
        seen.jar = innerJar;
        seen.firstPageHtml = firstPageHtml;
        return "fn-result";
      },
      fetchImpl,
    );

    expect(result).toBe("fn-result");
    expect(seen.jar).toBe(jar);
    // fn は btnUpdate 応答 (絞込反映済み 1 ページ目) を受け取る
    expect(seen.firstPageHtml).toBe("<html>filtered-first-page</html>");
    expect(bodies).toHaveLength(3);

    // 適用 POST: GOS の full form + 車輌CD range + btnOK (lnkSaveCategory ではない)
    const applyBody = new URLSearchParams(bodies[0]);
    expect(applyBody.get("txtSVehicle")).toBe("1000");
    expect(applyBody.get("txtEVehicle")).toBe("1000");
    expect(applyBody.get("txtSDriver")).toBe("baseline-driver");
    expect(applyBody.get("__VIEWSTATE")).toBe("VS-GOS");
    expect(applyBody.get("btnOK")).toBe("適用");
    expect(applyBody.get("__EVENTTARGET")).toBeNull();

    // btnUpdate POST: DES の full form (select 含む) + btnUpdate
    const updateBody = new URLSearchParams(bodies[1]);
    expect(updateBody.get("__VIEWSTATE")).toBe("VS-DES");
    expect(updateBody.get("ctl00$MainContent$ddlRowCount")).toBe("30");
    expect(updateBody.get("ctl00$MainContent$btnUpdate")).toBe("更新");

    // 復元 POST: 元値 (空) を btnOK で適用し直す
    const restoreBody = new URLSearchParams(bodies[2]);
    expect(restoreBody.get("txtSVehicle")).toBe("");
    expect(restoreBody.get("txtEVehicle")).toBe("");
    expect(restoreBody.get("btnOK")).toBe("適用");
  });

  it("restores a pre-existing non-empty vehicle range instead of blanking it", async () => {
    const jar = createCookieJar();
    const { fetchImpl, bodies } = narrowFetchMock({ gosHtml: displayConfigHtml({ sVehicle: "500", eVehicle: "600" }) });

    await withVehicleNarrow(jar, range, async () => undefined, fetchImpl);
    const restoreBody = new URLSearchParams(bodies[2]);
    expect(restoreBody.get("txtSVehicle")).toBe("500");
    expect(restoreBody.get("txtEVehicle")).toBe("600");
  });

  it("falls back to default button captions when btnOK/btnUpdate have no value attribute", async () => {
    const jar = createCookieJar();
    const desNoValue = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-DES" />
      <input type="submit" id="btnUpdate" name="ctl00$MainContent$btnUpdate" />
    </form></body></html>`;
    const gosNoValue = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-GOS" />
      <input type="text" id="txtSVehicle" name="txtSVehicle" value="" />
      <input type="text" id="txtEVehicle" name="txtEVehicle" value="" />
      <input type="submit" id="btnOK" name="btnOK" />
    </form></body></html>`;
    const { fetchImpl, bodies } = narrowFetchMock({ desHtml: desNoValue, gosHtml: gosNoValue });

    await withVehicleNarrow(jar, range, async () => undefined, fetchImpl);
    expect(new URLSearchParams(bodies[0]).get("btnOK")).toBe("適用");
    expect(new URLSearchParams(bodies[1]).get("ctl00$MainContent$btnUpdate")).toBe("更新");
  });

  it("restores the original range even when fn throws, then rethrows fn's error", async () => {
    const jar = createCookieJar();
    const { fetchImpl, bodies } = narrowFetchMock();
    await expect(
      withVehicleNarrow(
        jar,
        range,
        async () => {
          throw new Error("boom");
        },
        fetchImpl,
      ),
    ).rejects.toThrow("boom");
    expect(bodies).toHaveLength(3); // 適用 + btnUpdate + 復元
  });

  it("propagates a non-ok GET / login redirect of the operation list page without touching the config", async () => {
    const jar1 = createCookieJar();
    await expect(
      withVehicleNarrow(jar1, range, async () => "x", sequenceFetch([status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      withVehicleNarrow(jar2, range, async () => "x", sequenceFetch([html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws when btnUpdate is missing, before touching the shared config", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([html(operationListHtml({ missingBtnUpdate: true }))]);
    await expect(withVehicleNarrow(jar, range, async () => "x", fetchImpl)).rejects.toThrow("btnUpdate");
  });

  it("propagates a non-ok GET / login redirect of the display config page", async () => {
    const jar1 = createCookieJar();
    await expect(
      withVehicleNarrow(jar1, range, async () => "x", sequenceFetch([html(operationListHtml()), status(500)])),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      withVehicleNarrow(
        jar2, range, async () => "x", sequenceFetch([html(operationListHtml()), html(LOGIN_REDIRECT_HTML)]),
      ),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws when the vehicle narrow fields are missing from the config page", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(operationListHtml()),
      html(displayConfigHtml({ missingVehicleFields: true })),
    ]);
    await expect(withVehicleNarrow(jar, range, async () => "x", fetchImpl)).rejects.toThrow(
      "txtSVehicle/txtEVehicle",
    );
  });

  it("throws when the btnOK apply button is missing from the config page", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(operationListHtml()),
      html(displayConfigHtml({ missingBtnOK: true })),
    ]);
    await expect(withVehicleNarrow(jar, range, async () => "x", fetchImpl)).rejects.toThrow("btnOK");
  });

  it("defaults the captured original range to an empty string when serializeFormFields omits the field", async () => {
    // findFormFieldById (id 検索、type 無関係) は見つけるが serializeFormFields
    // (submit 系 type を除外) は拾わない、という食い違いを意図的に作る fixture。
    // 実ページでは起こらない想定だが、baseline[name] が undefined になる防御分岐
    // (`?? ""`) をテストするための contrived fixture。
    const jar = createCookieJar();
    const oddGos = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-GOS" />
      <input type="submit" id="txtSVehicle" name="txtSVehicle" value="999" />
      <input type="submit" id="txtEVehicle" name="txtEVehicle" value="999" />
      <input type="submit" id="btnOK" name="btnOK" value="適用" />
    </form></body></html>`;
    const { fetchImpl, bodies } = narrowFetchMock({ gosHtml: oddGos });

    await withVehicleNarrow(jar, range, async () => undefined, fetchImpl);
    const restoreBody = new URLSearchParams(bodies[2]);
    expect(restoreBody.get("txtSVehicle")).toBe("");
    expect(restoreBody.get("txtEVehicle")).toBe("");
  });

  it("propagates a non-ok apply POST without invoking fn (config presumed unchanged)", async () => {
    const jar = createCookieJar();
    let fnCalled = false;
    const fetchImpl = sequenceFetch([html(operationListHtml()), html(displayConfigHtml()), status(500)]);
    await expect(
      withVehicleNarrow(
        jar,
        range,
        async () => {
          fnCalled = true;
          return "x";
        },
        fetchImpl,
      ),
    ).rejects.toThrow(TheearthClientError);
    expect(fnCalled).toBe(false);
  });

  it("propagates a login redirect on the apply POST", async () => {
    const jar = createCookieJar();
    const fetchImpl = sequenceFetch([
      html(operationListHtml()),
      html(displayConfigHtml()),
      html(LOGIN_REDIRECT_HTML),
    ]);
    await expect(withVehicleNarrow(jar, range, async () => "x", fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });

  it("restores the config when the btnUpdate refresh fails (non-ok), then rethrows", async () => {
    const jar = createCookieJar();
    const bodies: string[] = [];
    let call = 0;
    let fnCalled = false;
    const fetchImpl = (async (_url, init) => {
      call += 1;
      if (call === 1) return html(operationListHtml());
      if (call === 2) return html(displayConfigHtml());
      bodies.push(String(init?.body ?? ""));
      if (call === 4) return status(500); // btnUpdate が失敗
      return html("applied");
    }) as FetchLike;
    await expect(
      withVehicleNarrow(
        jar,
        range,
        async () => {
          fnCalled = true;
          return "x";
        },
        fetchImpl,
      ),
    ).rejects.toThrow(/btnUpdate.*HTTP 500/);
    expect(fnCalled).toBe(false);
    // 適用済みの絞込は必ず復元される
    const restoreBody = new URLSearchParams(bodies[2]);
    expect(restoreBody.get("txtSVehicle")).toBe("");
  });

  it("maps a login redirect on the btnUpdate refresh to VenusSessionExpiredError (after restore)", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(operationListHtml());
      if (call === 2) return html(displayConfigHtml());
      if (call === 4) return html(LOGIN_REDIRECT_HTML); // btnUpdate 応答がログイン画面
      return html("applied");
    }) as FetchLike;
    await expect(withVehicleNarrow(jar, range, async () => "x", fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });

  it("throws a restore-failure error (no fn-failure note) when restore fails but fn succeeded", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(operationListHtml());
      if (call === 2) return html(displayConfigHtml());
      if (call === 5) return status(500); // 復元 POST が失敗
      return html("ok");
    }) as FetchLike;
    let caught: unknown;
    try {
      await withVehicleNarrow(jar, range, async () => "ok", fetchImpl);
    }
    catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TheearthClientError);
    expect((caught as Error).message).toMatch(/戻せませんでした/);
    expect((caught as Error).message).not.toMatch(/元の処理も失敗/);
  });

  it("throws a combined restore+fn failure message when both fail", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(operationListHtml());
      if (call === 2) return html(displayConfigHtml());
      if (call === 5) return status(500); // 復元 POST が失敗
      return html("ok");
    }) as FetchLike;
    let caught: unknown;
    try {
      await withVehicleNarrow(
        jar,
        range,
        async () => {
          throw new Error("fn-boom");
        },
        fetchImpl,
      );
    }
    catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/元の処理も失敗していました: fn-boom/);
  });

  it("stringifies a non-Error thrown fn value in the combined failure message", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(operationListHtml());
      if (call === 2) return html(displayConfigHtml());
      if (call === 5) return status(500); // 復元 POST が失敗
      return html("ok");
    }) as FetchLike;
    let caught: unknown;
    try {
      await withVehicleNarrow(
        jar,
        range,
        async () => {
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw "plain-string-error";
        },
        fetchImpl,
      );
    }
    catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/元の処理も失敗していました: plain-string-error/);
  });

  it("stringifies a non-Error restore failure", async () => {
    const jar = createCookieJar();
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1) return html(operationListHtml());
      if (call === 2) return html(displayConfigHtml());
      if (call === 5) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "raw-restore-failure";
      }
      return html("ok");
    }) as FetchLike;
    let caught: unknown;
    try {
      await withVehicleNarrow(jar, range, async () => "ok", fetchImpl);
    }
    catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toMatch(/戻せませんでした: raw-restore-failure/);
  });
});

// --- F-NOS3010 運行データ選択モード (単一運行 zip) fixture ---------------------
// 実 DOM 構造 (cdp-pair 実機確認、2026-07-09、Refs #203): 選択状態は CSS 非表示の
// text input (`ucDataSelect$txtOperationNo` / `txtStartDateTime`)。stage 2 で
// `ddlSystem` (連動出力形式) 等のフィールドを落とすと 22 バイトの空 ZIP が返る。

function csvSelectPageHtml(opts: {
  omit?: "rdoSelect0" | "txtOperationNo" | "txtStartDateTime" | "btnCsvSvr";
  stage1ButtonValue?: string;
} = {}): string {
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-CSV" />
    ${opts.omit === "rdoSelect0" ? "" : `<input type="radio" id="rdoSelect0" name="ctl00$MainContent$SelectM" value="rdoSelect0" checked="checked" />`}
    <input type="radio" id="rdoSelect1" name="ctl00$MainContent$SelectM" value="rdoSelect1" />
    ${opts.omit === "txtOperationNo" ? "" : `<input type="text" id="txtOperationNo" name="ctl00$MainContent$ucDataSelect$txtOperationNo" value="" />`}
    ${opts.omit === "txtStartDateTime" ? "" : `<input type="text" id="txtStartDateTime" name="ctl00$MainContent$ucDataSelect$txtStartDateTime" value="" />`}
    <select name="ctl00$MainContent$ddlSystem"><option value="0">連動出力形式</option><option value="1" selected="selected">形式1</option></select>
    ${opts.omit === "btnCsvSvr" ? "" : `<input type="submit" id="btnCsvSvr" name="ctl00$MainContent$btnCsvSvr" value="${opts.stage1ButtonValue ?? "ダウンロード"}" />`}
  </form></body></html>`;
}

function csvConfirmPageHtml(opts: {
  omitOutput?: boolean;
  outputButtonValue?: string;
} = {}): string {
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-CONFIRM" />
    <input type="radio" id="rdoSelect0" name="ctl00$MainContent$SelectM" value="rdoSelect0" checked="checked" />
    <input type="text" id="txtOperationNo" name="ctl00$MainContent$ucDataSelect$txtOperationNo" value="server-echo" />
    <input type="text" id="txtStartDateTime" name="ctl00$MainContent$ucDataSelect$txtStartDateTime" value="server-echo" />
    <select name="ctl00$MainContent$ddlSystem"><option value="0">連動出力形式</option><option value="1" selected="selected">形式1</option></select>
    ${opts.omitOutput ? "" : `<input type="submit" id="btnCsvSvrOutput" name="ctl00$MainContent$btnCsvSvrOutput" value="${opts.outputButtonValue ?? "ダウンロード"}" />`}
  </form></body></html>`;
}

/** EOCD (`PK\x05\x06`) だけの 22 バイト空 ZIP (F-NOS3010 の「該当 0 件」応答の実測形)。 */
function emptyZipResponse(): Response {
  const bytes = new Uint8Array(22);
  bytes.set([0x50, 0x4b, 0x05, 0x06], 0);
  return new Response(bytes, { status: 200, headers: { "content-type": "application/octet-stream" } });
}

function binaryResponse(bytes: number[], contentType: string): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": contentType } });
}

describe("downloadOperationCsvZip", () => {
  it("runs the 2-stage postback with full form fields and returns the zip bytes", async () => {
    const jar = createCookieJar();
    const bodies: string[] = [];
    const responses = [html(csvSelectPageHtml()), html(csvConfirmPageHtml()), zipResponse()];
    let call = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.body) bodies.push(String(init.body));
      return responses[call++]!;
    };
    const buf = await downloadOperationCsvZip(jar, { opeNo: OPE_NO, startOpe: START_OPE }, fetchImpl);
    expect(new Uint8Array(buf).slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));

    const stage1 = new URLSearchParams(bodies[0]);
    expect(stage1.get("ctl00$MainContent$SelectM")).toBe("rdoSelect0"); // 運行データ選択モード
    expect(stage1.get("ctl00$MainContent$ucDataSelect$txtOperationNo")).toBe(OPE_NO);
    expect(stage1.get("ctl00$MainContent$ucDataSelect$txtStartDateTime")).toBe(START_OPE);
    expect(stage1.get("ctl00$MainContent$btnCsvSvr")).toBe("ダウンロード");

    // stage 2: 確認ページの全フィールド (ddlSystem 含む) + 選択フィールドの明示上書き。
    // これを落とすと空 ZIP が返る (2026-07-09 実測、Refs #203)
    const stage2 = new URLSearchParams(bodies[1]);
    expect(stage2.get("ctl00$MainContent$ddlSystem")).toBe("1");
    expect(stage2.get("__VIEWSTATE")).toBe("VS-CONFIRM");
    expect(stage2.get("ctl00$MainContent$ucDataSelect$txtOperationNo")).toBe(OPE_NO); // server-echo を上書き
    expect(stage2.get("ctl00$MainContent$ucDataSelect$txtStartDateTime")).toBe(START_OPE);
    expect(stage2.get("ctl00$MainContent$btnCsvSvrOutput")).toBe("ダウンロード");
  });

  it("rejects malformed OpeNo / StartOpe", async () => {
    const jar = createCookieJar();
    await expect(downloadOperationCsvZip(jar, { opeNo: "bad", startOpe: START_OPE })).rejects.toThrow(ReportParamError);
    await expect(downloadOperationCsvZip(jar, { opeNo: OPE_NO, startOpe: "bad" })).rejects.toThrow(ReportParamError);
  });

  it("throws VenusSessionExpiredError when the GET returns the login page", async () => {
    const jar = createCookieJar();
    await expect(
      downloadOperationCsvZip(jar, { opeNo: OPE_NO, startOpe: START_OPE }, sequenceFetch([html(LOGIN_REDIRECT_HTML)])),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it.each(["rdoSelect0", "txtOperationNo", "txtStartDateTime", "btnCsvSvr"] as const)(
    "throws when the form element %s is missing",
    async (omit) => {
      const jar = createCookieJar();
      await expect(
        downloadOperationCsvZip(jar, { opeNo: OPE_NO, startOpe: START_OPE }, sequenceFetch([html(csvSelectPageHtml({ omit }))])),
      ).rejects.toThrow(/CSV フォームの要素/);
    },
  );

  it("returns the zip directly when stage 1 responds with binary (and falls back to a default button label)", async () => {
    const jar = createCookieJar();
    const bodies: string[] = [];
    const responses = [html(csvSelectPageHtml({ stage1ButtonValue: "" })), binaryResponse([0x50, 0x4b, 0x03, 0x04, 9], "application/zip")];
    let call = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.body) bodies.push(String(init.body));
      return responses[call++]!;
    };
    const buf = await downloadOperationCsvZip(jar, { opeNo: OPE_NO, startOpe: START_OPE }, fetchImpl, {
      requestTimeoutMs: 1000,
      exportTimeoutMs: 2000,
    });
    expect(buf.byteLength).toBe(5);
    expect(new URLSearchParams(bodies[0]).get("ctl00$MainContent$btnCsvSvr")).toBe("ダウンロード"); // value="" の fallback
  });

  it("fails loudly when stage 1 directly returns the empty (0 件) zip", async () => {
    const jar = createCookieJar();
    await expect(
      downloadOperationCsvZip(
        jar,
        { opeNo: OPE_NO, startOpe: START_OPE },
        sequenceFetch([html(csvSelectPageHtml()), emptyZipResponse()]),
      ),
    ).rejects.toThrow(/該当 0 件/);
  });

  it("throws VenusSessionExpiredError when the confirmation page is the login page", async () => {
    const jar = createCookieJar();
    await expect(
      downloadOperationCsvZip(
        jar,
        { opeNo: OPE_NO, startOpe: START_OPE },
        sequenceFetch([html(csvSelectPageHtml()), html(LOGIN_REDIRECT_HTML)]),
      ),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("throws when the confirmation page has no output button", async () => {
    const jar = createCookieJar();
    await expect(
      downloadOperationCsvZip(
        jar,
        { opeNo: OPE_NO, startOpe: START_OPE },
        sequenceFetch([html(csvSelectPageHtml()), html(csvConfirmPageHtml({ omitOutput: true }))]),
      ),
    ).rejects.toThrow(/btnCsvSvrOutput/);
  });

  it("fails loudly when stage 2 returns the empty (0 件) zip, with a fallback output button label", async () => {
    const jar = createCookieJar();
    const bodies: string[] = [];
    const responses = [html(csvSelectPageHtml()), html(csvConfirmPageHtml({ outputButtonValue: "" })), emptyZipResponse()];
    let call = 0;
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.body) bodies.push(String(init.body));
      return responses[call++]!;
    };
    await expect(downloadOperationCsvZip(jar, { opeNo: OPE_NO, startOpe: START_OPE }, fetchImpl)).rejects.toThrow(
      /該当 0 件/,
    );
    expect(new URLSearchParams(bodies[1]).get("ctl00$MainContent$btnCsvSvrOutput")).toBe("ダウンロード");
  });

  it("tolerates responses without a content-type header (defensive ?? fallback)", async () => {
    const jar = createCookieJar();
    // Response に文字列 body を渡すと text/plain が自動付与されるため、header 無しを
    // 再現するには Uint8Array body を使う (ArrayBufferView は content-type を付けない)。
    const noCtHtml = new Response(new TextEncoder().encode(csvConfirmPageHtml()), { status: 200 });
    const noCtZip = new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 7]), { status: 200 });
    const buf = await downloadOperationCsvZip(
      jar,
      { opeNo: OPE_NO, startOpe: START_OPE },
      sequenceFetch([html(csvSelectPageHtml()), noCtHtml, noCtZip]),
    );
    expect(buf.byteLength).toBe(5);
  });

  it("throws TheearthClientError when stage 2 returns non-zip bytes (magic mismatch, incl. <4 bytes)", async () => {
    const jar = createCookieJar();
    await expect(
      downloadOperationCsvZip(
        jar,
        { opeNo: OPE_NO, startOpe: START_OPE },
        sequenceFetch([html(csvSelectPageHtml()), html(csvConfirmPageHtml()), binaryResponse([0x50, 0x4b], "application/octet-stream")]),
      ),
    ).rejects.toThrow(TheearthClientError);
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

// --- F-DES1010 運行データ入力(一覧) fixture -----------------------------------

function reportRowHtml(row: number, v: {
  operationNo?: string;
  startDateTime?: string;
  workEndDateTime?: string;
} = {}): string {
  const id = (field: string) => `MainContent_lstOperation_${field}_${row}`;
  return `
    <span id="${id("lblOperationNo")}">${v.operationNo ?? `OPE${row}`}</span>
    <span id="${id("lblStartDateTime")}">${v.startDateTime ?? "2026/07/01 8:00:00"}</span>
    <span id="${id("lblExclusionFlag")}">0</span>
    <span id="${id("lblOperationDate")}">26/07/01</span>
    <span id="${id("lblBranchCD")}">8</span>
    <span id="${id("lblDisplayName")}">佐賀大石運輸㈱</span>
    <span id="${id("lblVehicleCD")}">6572</span>
    <span id="${id("lblVehicleName")}">佐賀100あ6572</span>
    <span id="${id("lblDriverCD1")}">1405</span>
    <span id="${id("lblDriverName1")}">松尾　等</span>
    <span id="${id("lblWorkStartDateTime")}">07/01 07:50</span>
    <span id="${id("lblWorkEndDateTime")}">${v.workEndDateTime ?? "07/01 18:00"}</span>
    <span id="${id("lblOperationStartDateTime")}">07/01 08:00</span>
    <span id="${id("lblOperationEndDateTime")}">07/01 18:00</span>
    <span id="${id("lblTotalRunningDist")}">120</span>
    <span id="${id("lblSalesFlag")}">済</span>
    <span id="${id("lblExpenseFlag")}">未</span>
  `;
}

function pagerLink(target: string, argument: string, text: string): string {
  return `<a href="javascript:__doPostBack('${target}','${argument}')">${text}</a>`;
}

/** `reportPageHtml({ links: [...] })` に渡す `{target, argument, text}` を作る。 */
function link(target: string, argument: string, text: string): { target: string; argument: string; text: string } {
  return { target, argument, text };
}

/** ページャの「最初」ボタン (`<input type="submit">`)。1ページ目は disabled。 */
function firstButtonHtml(opts: { disabled?: boolean } = {}): string {
  const disabledAttr = opts.disabled ? ' disabled="disabled" class="aspNetDisabled Buttonglay"' : ' class="Buttonglay"';
  return `<input type="submit" name="ctl00$MainContent$dpOperation$ctl00$ctl00" value="最初"${disabledAttr} />`;
}

function reportPageHtml(opts: {
  rows: { operationNo: string; startDateTime: string; workEndDateTime: string }[];
  currentPage: number;
  links: { target: string; argument: string; text: string }[];
  firstButton?: { disabled?: boolean };
}): string {
  const rowsHtml = opts.rows
    .map((r, i) => reportRowHtml(i, { operationNo: r.operationNo, startDateTime: r.startDateTime, workEndDateTime: r.workEndDateTime }))
    .join("\n");
  const linksHtml = opts.links.map((l) => pagerLink(l.target, l.argument, l.text)).join("\n");
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-${opts.currentPage}" />
    ${opts.firstButton ? firstButtonHtml(opts.firstButton) : ""}
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

  it("starts from initialHtml without any GET (vehicle-narrow first page)", async () => {
    // 車輌絞込は btnUpdate 応答にしか反映されず plain GET では消えるため、
    // withVehicleNarrow が渡す 1 ページ目 HTML をそのまま使えることを固定する。
    // sequenceFetch([]) は fetch されると throw するので「GET していない」ことの
    // 証明になる。
    const jar = createCookieJar();
    const page1 = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 1,
      links: [],
      firstButton: { disabled: true },
    });
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      sequenceFetch([]),
      undefined,
      page1,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A"]);
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

  it("resets to the first page via the 最初 submit button, then early-breaks once below `from`", async () => {
    const jar = createCookieJar();
    const pageWithFirstButton = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 2,
      links: [link("ctl01$ctl02", "", "3")],
      firstButton: { disabled: false },
    });
    const afterFirst = reportPageHtml({
      rows: [
        { operationNo: "B", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" },
        { operationNo: "C", startDateTime: "2026/06/29 08:00:00", workEndDateTime: "06/29 18:00" }, // range.from 未満
      ],
      currentPage: 1,
      links: [link("ctl01$ctl02", "", "2")],
      firstButton: { disabled: true },
    });
    const fetchImpl = sequenceFetch([html(pageWithFirstButton), html(afterFirst)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["B"]);
  });

  it("throws on non-ok POST / login redirect on POST while resetting via the 最初 button", async () => {
    const jar1 = createCookieJar();
    const pageWithFirstButton = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 2,
      links: [],
      firstButton: { disabled: false },
    });
    await expect(
      harvestDailyReport(
        jar1,
        { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
        sequenceFetch([html(pageWithFirstButton), status(500)]),
      ),
    ).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(
      harvestDailyReport(
        jar2,
        { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
        sequenceFetch([html(pageWithFirstButton), html(LOGIN_REDIRECT_HTML)]),
      ),
    ).rejects.toThrow(VenusSessionExpiredError);
  });

  it("skips the 最初 reset when the button is disabled (already on page 1)", async () => {
    const jar = createCookieJar();
    const page1 = reportPageHtml({
      rows: [{ operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" }],
      currentPage: 1,
      links: [],
      firstButton: { disabled: true },
    });
    const fetchImpl = sequenceFetch([html(page1)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A"]);
  });

  it("skips a submit button with no value attribute when scanning for 最初 (defensive)", async () => {
    const jar = createCookieJar();
    const page1 = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      <input type="submit" name="ctl00$MainContent$btnOther" class="Buttonglay" />
      ${reportRowHtml(0, { operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" })}
      <span class="gCurrentPage">1</span>
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(page1)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A"]);
  });

  it("treats a matching 最初 button with no name attribute as not found (defensive)", async () => {
    const jar = createCookieJar();
    const page1 = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      <input type="submit" value="最初" class="Buttonglay" />
      ${reportRowHtml(0, { operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" })}
      <span class="gCurrentPage">1</span>
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(page1)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows.map((r) => r.operationNo)).toEqual(["A"]);
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

  it("normalizes an empty-content cell to null instead of an empty string", async () => {
    const jar = createCookieJar();
    const page1 = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS1" />
      ${reportRowHtml(0, { operationNo: "A", startDateTime: "2026/07/05 08:00:00", workEndDateTime: "07/05 18:00" })
        .replace(/<span id="MainContent_lstOperation_lblBranchCD_0">8<\/span>/, '<span id="MainContent_lstOperation_lblBranchCD_0"></span>')}
      <span class="gCurrentPage">1</span>
    </form></body></html>`;
    const fetchImpl = sequenceFetch([html(page1)]);
    const rows = await harvestDailyReport(
      jar,
      { from: "2026/07/01 00:00", to: "2026/07/07 00:00" },
      fetchImpl,
    );
    expect(rows[0]?.branchCd).toBeNull();
  });

  it("defaults missing grid cells to null/empty instead of throwing", async () => {
    const jar = createCookieJar();
    // lblStartDateTime / lblWorkEndDateTime のセルが (仕様変更等で) 欠落しているケース。
    const partialRowHtml = `
      <span id="MainContent_lstOperation_lblOperationNo_0">A</span>
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
      <span id="MainContent_lstOperation_lblOperationNo_0" />
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

// --- F-DES1013 作業入力フォーム fixture --------------------------------------
// lstWork のフィールド形式は SKILL.md の 2026-07-08 実機トレース (name =
// `lstWork$ctrl<i>$<field>`) を primary とし、lstFuel で後から判明した
// `lstWork_<field>_<i>` (id) 形式もフォールバックで受け付ける (Refs #183/#184 の
// 経緯)。fixture は両形式を用意する。

interface WorkRowSpec {
  event?: string;
  start?: string;
  intStart?: string | null;
  end?: string;
  intEnd?: string | null;
  driverType?: string;
  noStart?: boolean;
}

function workRowInputsHtml(i: number, v: WorkRowSpec = {}): string {
  const id = (field: string) => `lstWork_ctrl${i}_${field}`;
  const name = (field: string) => `lstWork$ctrl${i}$${field}`;
  const start = v.start ?? "26/07/03 10:38";
  const end = v.end ?? "26/07/03 11:38";
  return `
    <select id="${id("iddlEventName")}" name="${name("iddlEventName")}">
      <option value="1">積み</option>
      <option value="2"${v.event === "2" ? " selected" : ""}>降ろし</option>
      <option value="3"${v.event === "3" ? " selected" : ""}>休憩</option>
    </select>
    ${v.noStart ? "" : `<input type="text" id="${id("itxtStartDateTime")}" name="${name("itxtStartDateTime")}" value="${start}" />`}
    ${
      v.intStart === null
        ? ""
        : `<input type="hidden" id="${id("intxtStartDateTime")}" name="${name("intxtStartDateTime")}" value="${v.intStart ?? start.replace(/\D/g, "")}" />`
    }
    <input type="text" id="${id("itxtEndDateTime")}" name="${name("itxtEndDateTime")}" value="${end}" />
    ${
      v.intEnd === null
        ? ""
        : `<input type="hidden" id="${id("intxtEndDateTime")}" name="${name("intxtEndDateTime")}" value="${v.intEnd ?? end.replace(/\D/g, "")}" />`
    }
    <input type="text" id="${id("itxtDriverType")}" name="${name("itxtDriverType")}" value="${v.driverType ?? "1"}" />
    <input type="text" id="${id("itxtStartPlaceCD")}" name="${name("itxtStartPlaceCD")}" value="10" />
    <input type="text" id="${id("itxtStartPlaceName")}" name="${name("itxtStartPlaceName")}" value="出発地" />
    <input type="text" id="${id("itxtStartCityCD")}" name="${name("itxtStartCityCD")}" value="41" />
    <input type="text" id="${id("itxtStartCityName")}" name="${name("itxtStartCityName")}" value="佐賀市" />
    <input type="text" id="${id("itxtEndPlaceCD")}" name="${name("itxtEndPlaceCD")}" value="20" />
    <input type="text" id="${id("itxtEndPlaceName")}" name="${name("itxtEndPlaceName")}" value="到着地" />
    <input type="text" id="${id("itxtEndCityCD")}" name="${name("itxtEndCityCD")}" value="40" />
    <input type="text" id="${id("itxtEndCityName")}" name="${name("itxtEndCityName")}" value="福岡市" />
  `;
}

function workFormHtml(opts: {
  rows?: string[];
  registButton?: boolean;
  scoreButton?: boolean;
  recalculated?: boolean;
  linkSysDisabled?: boolean;
} = {}): string {
  const rows = opts.rows ?? [workRowInputsHtml(0), workRowInputsHtml(1, { event: "2" })];
  const linkSysClass = opts.linkSysDisabled === false ? "ButtonCrimson" : "aspNetDisabled ButtonCrimson";
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-WORK" />
    ${rows.join("\n")}
    ${opts.registButton === false ? "" : '<input type="submit" id="btnRegist1" name="btnRegist1" value="登録" />'}
    ${opts.scoreButton === false ? "" : '<input type="submit" id="btnScore" name="btnScore" value="作業時間再集計" />'}
    <input type="submit" id="btnLinkSys" name="btnLinkSys" value="システム連動開始" class="${linkSysClass}" />
    ${opts.recalculated ? "<div>再集計が終了しました。</div>" : ""}
  </form></body></html>`;
}

/** postback body を記録する fetch モック (URLSearchParams を文字列で保存)。 */
function recordingFetch(responses: (Response | (() => Response))[], bodies: string[]): FetchLike {
  let i = 0;
  return (async (_input: unknown, init?: { body?: unknown }) => {
    bodies.push(init && init.body !== undefined && init.body !== null ? String(init.body) : "");
    const entry = responses[i];
    i += 1;
    if (!entry) throw new Error(`unexpected extra fetch call (#${i})`);
    return typeof entry === "function" ? entry() : entry;
  }) as FetchLike;
}

describe("getWorkForm", () => {
  it("parses work rows and event options from the work edit page", async () => {
    const jar = createCookieJar();
    const form = await getWorkForm(jar, OPE_NO, START_OPE, sequenceFetch([html(workFormHtml())]));
    expect(form.workRows).toHaveLength(2);
    expect(form.workRows[0]).toMatchObject({
      ctrlIndex: 0,
      eventCd: "1",
      eventName: "積み",
      startDateTime: "26/07/03 10:38",
      endDateTime: "26/07/03 11:38",
      driverType: "1",
      startPlaceCd: "10",
      startPlaceName: "出発地",
      startCityCd: "41",
      startCityName: "佐賀市",
      endPlaceCd: "20",
      endPlaceName: "到着地",
      endCityCd: "40",
      endCityName: "福岡市",
    });
    expect(form.workRows[1].eventCd).toBe("2");
    expect(form.workRows[1].eventName).toBe("降ろし");
    expect(form.eventOptions).toEqual([
      { value: "1", label: "積み" },
      { value: "2", label: "降ろし" },
      { value: "3", label: "休憩" },
    ]);
  });

  it("accepts the lstWork_<field>_<i> id fallback format", async () => {
    const page = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS" />
      <select id="lstWork_iddlEventName_3" name="lstWork_iddlEventName_3">
        <option value="1" selected>積み</option>
      </select>
      <input type="text" id="lstWork_itxtStartDateTime_3" name="lstWork_itxtStartDateTime_3" value="26/07/03 10:38" />
    </form></body></html>`;
    const jar = createCookieJar();
    const form = await getWorkForm(jar, OPE_NO, START_OPE, sequenceFetch([html(page)]));
    expect(form.workRows).toHaveLength(1);
    expect(form.workRows[0].ctrlIndex).toBe(3);
    expect(form.workRows[0].eventCd).toBe("1");
    expect(form.workRows[0].startDateTime).toBe("26/07/03 10:38");
  });

  it("skips malformed lstWork-prefixed elements and unnamed selects", async () => {
    const page = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS" />
      <input name="lstWorkBroken" />
      <input name="lstWorkBroken2" id="lstWork_odd" />
      <input type="submit" name="lstWork$ctrl0$btnSomething" value="x" />
      <select><option value="z">no name</option></select>
      <select name="other$field"><option value="z">not lstWork</option></select>
      <select name="lstWorkBrokenSelect"><option value="z">locate fails</option></select>
      ${workRowInputsHtml(0)}
    </form></body></html>`;
    const jar = createCookieJar();
    const form = await getWorkForm(jar, OPE_NO, START_OPE, sequenceFetch([html(page)]));
    expect(form.workRows).toHaveLength(1);
    expect(form.workRows[0].ctrlIndex).toBe(0);
  });

  it("handles value-less inputs, select without selected/options and rows without event select", async () => {
    const page = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS" />
      <input name="lstWork$ctrl0$itxtStartDateTime" />
      <select name="lstWork$ctrl0$iddlEventName">
        <option value="1">積み</option>
        <option>ラベルのみ</option>
      </select>
      <select name="lstWork$ctrl1$iddlEventName"></select>
      <input type="text" name="lstWork$ctrl2$itxtDriverType" value="2" />
    </form></body></html>`;
    const jar = createCookieJar();
    const form = await getWorkForm(jar, OPE_NO, START_OPE, sequenceFetch([html(page)]));
    expect(form.workRows).toHaveLength(3);
    // 行0: value 属性なし input は "" / selected なし select は先頭 option
    expect(form.workRows[0].startDateTime).toBe("");
    expect(form.workRows[0].eventCd).toBe("1");
    // 行1: option 0 件の select は value/label とも ""
    expect(form.workRows[1].eventCd).toBe("");
    expect(form.workRows[1].eventName).toBe("");
    // 行2: event select の無い行
    expect(form.workRows[2].eventCd).toBe("");
    expect(form.workRows[2].driverType).toBe("2");
    expect(form.eventOptions).toEqual([
      { value: "1", label: "積み" },
      { value: "", label: "ラベルのみ" },
    ]);
  });

  it("rejects invalid opeNo / startOpe", async () => {
    const jar = createCookieJar();
    await expect(getWorkForm(jar, "123", START_OPE, sequenceFetch([]))).rejects.toThrow(ReportParamError);
    await expect(getWorkForm(jar, OPE_NO, "2026-07-03", sequenceFetch([]))).rejects.toThrow(ReportParamError);
  });

  it("throws on non-ok GET / login redirect", async () => {
    const jar1 = createCookieJar();
    await expect(getWorkForm(jar1, OPE_NO, START_OPE, sequenceFetch([status(500)]))).rejects.toThrow(
      TheearthClientError,
    );
    const jar2 = createCookieJar();
    await expect(getWorkForm(jar2, OPE_NO, START_OPE, sequenceFetch([html(LOGIN_REDIRECT_HTML)]))).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });

  it("throws when the page is not the work edit page (no __VIEWSTATE)", async () => {
    const jar = createCookieJar();
    await expect(
      getWorkForm(jar, OPE_NO, START_OPE, sequenceFetch([html("<html><body>別のページ</body></html>")])),
    ).rejects.toThrow(/__VIEWSTATE/);
  });

  it("throws when lstWork exists but in an unrecognized format", async () => {
    const page = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS" />
      <span id="lstWork_lblEventName_0">積み</span>
      <input type="submit" name="lstWork$btnEditButton_0" value="" />
    </form></body></html>`;
    const jar = createCookieJar();
    await expect(getWorkForm(jar, OPE_NO, START_OPE, sequenceFetch([html(page)]))).rejects.toThrow(
      /フィールド形式が想定/,
    );
  });

  it("returns empty rows for a work edit page without any lstWork markup", async () => {
    const page = `<html><body><form>
      <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS" />
    </form></body></html>`;
    const jar = createCookieJar();
    const form = await getWorkForm(jar, OPE_NO, START_OPE, sequenceFetch([html(page)]));
    expect(form.workRows).toEqual([]);
    expect(form.eventOptions).toEqual([]);
  });
});

describe("saveWorkRows", () => {
  const baseParams = {
    opeNo: OPE_NO,
    startOpe: START_OPE,
    rows: [{ ctrlIndex: 0, eventCd: "3", startDateTime: "26/07/03 09:00" }],
  };

  it("posts the full serialized form with edited fields and synced internal datetimes", async () => {
    const bodies: string[] = [];
    const fetchImpl = recordingFetch(
      [html(workFormHtml()), html(workFormHtml({ rows: [workRowInputsHtml(0, { event: "3", start: "26/07/03 09:00" })] }))],
      bodies,
    );
    const jar = createCookieJar();
    const result = await saveWorkRows(jar, baseParams, fetchImpl);
    expect(result.workRows[0].eventCd).toBe("3");
    const sent = new URLSearchParams(bodies[1]);
    expect(sent.get("lstWork$ctrl0$iddlEventName")).toBe("3");
    expect(sent.get("lstWork$ctrl0$itxtStartDateTime")).toBe("26/07/03 09:00");
    // intxt は現在値ペアで「数字のみ抽出」則が成立しているので新値にも適用される
    expect(sent.get("lstWork$ctrl0$intxtStartDateTime")).toBe("2607030900");
    // 変更していない行・フィールドも full form 直列化で丸ごと送る (Refs #199 の教訓)
    expect(sent.get("lstWork$ctrl1$iddlEventName")).toBe("2");
    expect(sent.get("lstWork$ctrl0$itxtEndDateTime")).toBe("26/07/03 11:38");
    expect(sent.get("btnRegist1")).toBe("登録");
    expect(sent.get("__VIEWSTATE")).toBe("VS-WORK");
  });

  it("keeps the current internal datetime when the digits-only rule does not hold", async () => {
    const bodies: string[] = [];
    const page = workFormHtml({ rows: [workRowInputsHtml(0, { intStart: "UNKNOWN-FORMAT" })] });
    const fetchImpl = recordingFetch([html(page), html(page)], bodies);
    const jar = createCookieJar();
    await saveWorkRows(jar, baseParams, fetchImpl);
    const sent = new URLSearchParams(bodies[1]);
    expect(sent.get("lstWork$ctrl0$itxtStartDateTime")).toBe("26/07/03 09:00");
    expect(sent.get("lstWork$ctrl0$intxtStartDateTime")).toBe("UNKNOWN-FORMAT");
  });

  it("tolerates rows without an internal datetime field", async () => {
    const page = workFormHtml({ rows: [workRowInputsHtml(0, { intStart: null })] });
    const fetchImpl = sequenceFetch([html(page), html(page)]);
    const jar = createCookieJar();
    const result = await saveWorkRows(jar, baseParams, fetchImpl);
    expect(result.workRows).toHaveLength(1);
  });

  it("re-reads the form when the save response has no work rows", async () => {
    const fetchImpl = sequenceFetch([
      html(workFormHtml()),
      html('<html><body><form><input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS2" /></form></body></html>'),
      html(workFormHtml({ rows: [workRowInputsHtml(0, { event: "3" })] })),
    ]);
    const jar = createCookieJar();
    const result = await saveWorkRows(jar, baseParams, fetchImpl);
    expect(result.workRows).toHaveLength(1);
    expect(result.workRows[0].eventCd).toBe("3");
  });

  it("rejects invalid params", async () => {
    const jar = createCookieJar();
    await expect(saveWorkRows(jar, { ...baseParams, opeNo: "x" }, sequenceFetch([]))).rejects.toThrow(
      ReportParamError,
    );
    await expect(
      saveWorkRows(jar, { ...baseParams, rows: undefined as unknown as [] }, sequenceFetch([])),
    ).rejects.toThrow(ReportParamError);
    await expect(saveWorkRows(jar, { ...baseParams, rows: [] }, sequenceFetch([]))).rejects.toThrow(
      ReportParamError,
    );
  });

  it("rejects when the target row does not exist", async () => {
    const jar = createCookieJar();
    await expect(
      saveWorkRows(
        jar,
        { ...baseParams, rows: [{ ctrlIndex: 9, eventCd: "1" }] },
        sequenceFetch([html(workFormHtml())]),
      ),
    ).rejects.toThrow(/ctrlIndex=9/);
  });

  it("throws when an edited field is missing from the row", async () => {
    const page = workFormHtml({ rows: [workRowInputsHtml(0, { noStart: true })] });
    const jar = createCookieJar();
    await expect(
      saveWorkRows(
        jar,
        { ...baseParams, rows: [{ ctrlIndex: 0, startDateTime: "26/07/03 09:00" }] },
        sequenceFetch([html(page)]),
      ),
    ).rejects.toThrow(/itxtStartDateTime/);
  });

  it("throws when btnRegist1 is missing", async () => {
    const jar = createCookieJar();
    await expect(
      saveWorkRows(jar, baseParams, sequenceFetch([html(workFormHtml({ registButton: false }))])),
    ).rejects.toThrow(/btnRegist1/);
  });

  it("falls back to the 登録 label when btnRegist1 has no value attribute", async () => {
    const page = workFormHtml().replace('name="btnRegist1" value="登録"', 'name="btnRegist1"');
    const bodies: string[] = [];
    const fetchImpl = recordingFetch([html(page), html(page)], bodies);
    const jar = createCookieJar();
    await saveWorkRows(jar, baseParams, fetchImpl);
    expect(new URLSearchParams(bodies[1]).get("btnRegist1")).toBe("登録");
  });

  it("throws on the other-user-editing conflict message", async () => {
    const conflictHtml = "<html><body>他ユーザー編集中のため処理を中止しました。</body></html>";
    const jar = createCookieJar();
    await expect(
      saveWorkRows(jar, baseParams, sequenceFetch([html(workFormHtml()), html(conflictHtml)])),
    ).rejects.toThrow(/他ユーザー/);
  });

  it("throws on non-ok GET / login redirect", async () => {
    const jar1 = createCookieJar();
    await expect(saveWorkRows(jar1, baseParams, sequenceFetch([status(500)]))).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(saveWorkRows(jar2, baseParams, sequenceFetch([html(LOGIN_REDIRECT_HTML)]))).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });
});

describe("recalculateWork", () => {
  it("posts btnScore on the work edit page and reports linkSys enablement", async () => {
    const fetchImpl = sequenceFetch([
      html(workFormHtml()),
      html(workFormHtml({ recalculated: true, linkSysDisabled: false })),
    ]);
    const jar = createCookieJar();
    const result = await recalculateWork(jar, OPE_NO, START_OPE, fetchImpl);
    expect(result.linkSysEnabled).toBe(true);
  });

  it("rejects invalid opeNo", async () => {
    const jar = createCookieJar();
    await expect(recalculateWork(jar, "x", START_OPE, sequenceFetch([]))).rejects.toThrow(ReportParamError);
  });

  it("throws when the completion message is missing", async () => {
    const fetchImpl = sequenceFetch([html(workFormHtml()), html(workFormHtml())]);
    const jar = createCookieJar();
    await expect(recalculateWork(jar, OPE_NO, START_OPE, fetchImpl)).rejects.toThrow(/再集計が終了しました/);
  });

  it("throws when btnScore is missing", async () => {
    const jar = createCookieJar();
    await expect(
      recalculateWork(jar, OPE_NO, START_OPE, sequenceFetch([html(workFormHtml({ scoreButton: false }))])),
    ).rejects.toThrow(/btnScore/);
  });
});

// --- F-DES1011 運行データ修正フォーム fixture --------------------------------

function reviseFormHtml(opts: {
  driver1?: string | null;
  vehicle?: string | null;
  branch?: string | null;
  dist?: string;
  regButton?: boolean;
} = {}): string {
  return `<html><body><form>
    <input type="hidden" id="__VIEWSTATE" name="__VIEWSTATE" value="VS-REVISE" />
    ${opts.driver1 === null ? "" : `<input type="text" id="txtDriver1" name="txtDriver1" value="${opts.driver1 ?? "1405"}" />`}
    ${opts.vehicle === null ? "" : `<input type="text" id="txtVehicle" name="txtVehicle" value="${opts.vehicle ?? "6572"}" />`}
    ${opts.branch === null ? "" : `<input type="text" id="txtBranch" name="txtBranch" value="${opts.branch ?? "8"}" />`}
    <input type="text" id="txtDist" name="txtDist" value="${opts.dist ?? "1890.2"}" />
    ${opts.regButton === false ? "" : '<input type="submit" id="btnReg" name="btnReg" value="登録" />'}
  </form></body></html>`;
}

describe("getReviseForm", () => {
  it("parses driver / vehicle / branch and detects a filled form", async () => {
    const jar = createCookieJar();
    const form = await getReviseForm(jar, OPE_NO, START_OPE, sequenceFetch([html(reviseFormHtml())]));
    expect(form).toMatchObject({
      opeNo: OPE_NO,
      startOpe: START_OPE,
      driver1: "1405",
      vehicle: "6572",
      branch: "8",
      formFilled: true,
    });
  });

  it("reports formFilled=false when probe fields are all empty (JS PageLoad 依存の未充填フォーム)", async () => {
    const jar = createCookieJar();
    const page = reviseFormHtml({ driver1: "", vehicle: "", branch: "", dist: "" });
    const form = await getReviseForm(jar, OPE_NO, START_OPE, sequenceFetch([html(page)]));
    expect(form.formFilled).toBe(false);
    expect(form.driver1).toBe("");
  });

  it("falls back to empty strings when vehicle / branch fields are absent", async () => {
    const jar = createCookieJar();
    const page = reviseFormHtml({ vehicle: null, branch: null });
    const form = await getReviseForm(jar, OPE_NO, START_OPE, sequenceFetch([html(page)]));
    expect(form.vehicle).toBe("");
    expect(form.branch).toBe("");
    expect(form.formFilled).toBe(true); // txtDist が非空
  });

  it("throws when txtDriver1 is missing", async () => {
    const jar = createCookieJar();
    await expect(
      getReviseForm(jar, OPE_NO, START_OPE, sequenceFetch([html(reviseFormHtml({ driver1: null }))])),
    ).rejects.toThrow(/txtDriver1/);
  });

  it("rejects invalid params and maps GET failures", async () => {
    const jar = createCookieJar();
    await expect(getReviseForm(jar, "123", START_OPE, sequenceFetch([]))).rejects.toThrow(ReportParamError);
    await expect(getReviseForm(jar, OPE_NO, "bad", sequenceFetch([]))).rejects.toThrow(ReportParamError);
    const jar1 = createCookieJar();
    await expect(getReviseForm(jar1, OPE_NO, START_OPE, sequenceFetch([status(500)]))).rejects.toThrow(
      TheearthClientError,
    );
    const jar2 = createCookieJar();
    await expect(getReviseForm(jar2, OPE_NO, START_OPE, sequenceFetch([html(LOGIN_REDIRECT_HTML)]))).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });
});

describe("saveDriver", () => {
  const baseParams = { opeNo: OPE_NO, startOpe: START_OPE, driver1: "2001" };

  it("posts the full serialized form with the new driver CD", async () => {
    const bodies: string[] = [];
    const fetchImpl = recordingFetch(
      [html(reviseFormHtml()), html(reviseFormHtml({ driver1: "2001" }))],
      bodies,
    );
    const jar = createCookieJar();
    const result = await saveDriver(jar, baseParams, fetchImpl);
    expect(result.driver1After).toBe("2001");
    const sent = new URLSearchParams(bodies[1]);
    expect(sent.get("txtDriver1")).toBe("2001");
    expect(sent.get("txtVehicle")).toBe("6572"); // 変更しないフィールドも丸ごと送る
    expect(sent.get("btnReg")).toBe("登録");
  });

  it("returns null when the response is not the revise page anymore", async () => {
    const fetchImpl = sequenceFetch([
      html(reviseFormHtml()),
      html("<html><body>登録後の別画面</body></html>"),
    ]);
    const jar = createCookieJar();
    const result = await saveDriver(jar, baseParams, fetchImpl);
    expect(result.driver1After).toBeNull();
  });

  it("throws when the response echoes a different driver CD (theearth 側で拒否)", async () => {
    const fetchImpl = sequenceFetch([
      html(reviseFormHtml()),
      html(reviseFormHtml({ driver1: "1405" })),
    ]);
    const jar = createCookieJar();
    await expect(saveDriver(jar, baseParams, fetchImpl)).rejects.toThrow(/反映されませんでした/);
  });

  it("refuses to save when the form is not filled (既存データを空で上書きしない)", async () => {
    const page = reviseFormHtml({ driver1: "", vehicle: "", branch: "", dist: "" });
    const jar = createCookieJar();
    await expect(saveDriver(jar, baseParams, sequenceFetch([html(page)]))).rejects.toThrow(/初期値が空/);
  });

  it("rejects an invalid driver CD", async () => {
    const jar = createCookieJar();
    await expect(saveDriver(jar, { ...baseParams, driver1: "abc" }, sequenceFetch([]))).rejects.toThrow(
      ReportParamError,
    );
    await expect(saveDriver(jar, { ...baseParams, driver1: "123456789" }, sequenceFetch([]))).rejects.toThrow(
      ReportParamError,
    );
  });

  it("throws when txtDriver1 / btnReg are missing", async () => {
    const jar1 = createCookieJar();
    await expect(
      saveDriver(jar1, baseParams, sequenceFetch([html(reviseFormHtml({ driver1: null }))])),
    ).rejects.toThrow(/txtDriver1/);
    const jar2 = createCookieJar();
    await expect(
      saveDriver(jar2, baseParams, sequenceFetch([html(reviseFormHtml({ regButton: false }))])),
    ).rejects.toThrow(/btnReg/);
  });

  it("throws on the other-user-editing conflict message", async () => {
    const conflictHtml = "<html><body>他ユーザー編集中のため処理を中止しました。</body></html>";
    const jar = createCookieJar();
    await expect(
      saveDriver(jar, baseParams, sequenceFetch([html(reviseFormHtml()), html(conflictHtml)])),
    ).rejects.toThrow(/他ユーザー/);
  });

  it("falls back to the 登録 label when btnReg has no value attribute", async () => {
    const page = reviseFormHtml().replace('name="btnReg" value="登録"', 'name="btnReg"');
    const bodies: string[] = [];
    const fetchImpl = recordingFetch([html(page), html(reviseFormHtml({ driver1: "2001" }))], bodies);
    const jar = createCookieJar();
    await saveDriver(jar, baseParams, fetchImpl);
    expect(new URLSearchParams(bodies[1]).get("btnReg")).toBe("登録");
  });

  it("throws on non-ok GET / login redirect", async () => {
    const jar1 = createCookieJar();
    await expect(saveDriver(jar1, baseParams, sequenceFetch([status(500)]))).rejects.toThrow(TheearthClientError);
    const jar2 = createCookieJar();
    await expect(saveDriver(jar2, baseParams, sequenceFetch([html(LOGIN_REDIRECT_HTML)]))).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });
});
