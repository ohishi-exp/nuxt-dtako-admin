import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NETPRINT_BASE_URL,
  NETPRINT_LITE_ID,
  NETPRINT_MAINTENANCE_CODE,
  NETPRINT_MAX_PDF_BYTES,
  NETPRINT_POLL_INTERVAL_MS,
  NETPRINT_POLL_MAX_ATTEMPTS,
  NETPRINT_PRINT_ID_RE,
  NetprintClientError,
  NetprintMaintenanceError,
  bodySnippet,
  buildRegisterFormData,
  parseRegisterResponse,
  parseStatusResponse,
  registerPdf,
  waitForReservation,
} from "../src/netprint-client";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** 完了応答の雛形 (実登録で確認した形)。 */
const DONE_BODY = {
  resultCode: 0,
  printID: "J5JZPEQJ",
  page: 1,
  fileSize: 1234,
  endDate: "2026/08/26 23:59",
  detailURL: "https://lite.printing.ne.jp/api/file-detail/xxx",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bodySnippet", () => {
  it("短い本文は空白を潰してそのまま返す", () => {
    expect(bodySnippet("  a\n b\t c  ")).toBe("a b c");
  });

  it("200 文字を超える本文は切り詰めて … を付ける", () => {
    const snippet = bodySnippet("x".repeat(300));
    expect(snippet).toHaveLength(201);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("buildRegisterFormData", () => {
  it("fileBody (application/pdf) と既定の paperSize/colorMode/margin を積む", () => {
    const form = buildRegisterFormData(PDF, "report.pdf");
    const fileBody = form.get("fileBody");
    expect(fileBody).toBeInstanceOf(File);
    expect((fileBody as unknown as File).name).toBe("report.pdf");
    expect((fileBody as unknown as File).type).toBe("application/pdf");
    expect((fileBody as unknown as File).size).toBe(PDF.byteLength);
    expect(form.get("fileName")).toBe("report.pdf");
    expect(form.get("paperSize")).toBe("0");
    expect(form.get("colorMode")).toBe("0");
    expect(form.get("margin")).toBe("0");
  });

  it("paperSize/colorMode/margin は指定があればそれを使う", () => {
    const form = buildRegisterFormData(PDF, "a.pdf", { paperSize: "1", colorMode: "1", margin: "1" });
    expect(form.get("paperSize")).toBe("1");
    expect(form.get("colorMode")).toBe("1");
    expect(form.get("margin")).toBe("1");
  });

  it("上限ちょうど (10485760 bytes) は通す", () => {
    expect(NETPRINT_MAX_PDF_BYTES).toBe(10_485_760);
    const form = buildRegisterFormData(new Uint8Array(NETPRINT_MAX_PDF_BYTES), "max.pdf");
    expect(((form.get("fileBody") as unknown) as File).size).toBe(NETPRINT_MAX_PDF_BYTES);
  });

  it("上限超過は送らずに throw する", () => {
    expect(() => buildRegisterFormData(new Uint8Array(NETPRINT_MAX_PDF_BYTES + 1), "big.pdf")).toThrow(
      /10MB.*を超えています/,
    );
  });
});

describe("parseRegisterResponse", () => {
  it("200 + id で登録確認 ID を返す", () => {
    expect(parseRegisterResponse(200, JSON.stringify({ id: "abc-123", fileName: "a.pdf" }))).toBe("abc-123");
  });

  it("JSON でない応答は throw する (黙って 200 にしない)", () => {
    expect(() => parseRegisterResponse(200, "<html>error</html>")).toThrow(/JSON でない応答/);
  });

  it("JSON でも object でない応答 (配列 / null) は throw する", () => {
    expect(() => parseRegisterResponse(200, "[1]")).toThrow(/JSON object でない応答/);
    expect(() => parseRegisterResponse(200, "null")).toThrow(/JSON object でない応答/);
  });

  it("code 11202 はメンテナンス中として NetprintMaintenanceError を投げる", () => {
    expect(NETPRINT_MAINTENANCE_CODE).toBe(11202);
    let caught: unknown;
    try {
      parseRegisterResponse(200, JSON.stringify({ code: 11202 }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NetprintMaintenanceError);
    expect(caught).toBeInstanceOf(NetprintClientError);
    expect((caught as Error).name).toBe("NetprintMaintenanceError");
    expect((caught as Error).message).toMatch(/メンテナンス中/);
  });

  it("code が文字列 '11202' でもメンテナンス中と判定する", () => {
    expect(() => parseRegisterResponse(500, JSON.stringify({ code: "11202" }))).toThrow(NetprintMaintenanceError);
  });

  it("その他の code は本文付きの受付エラーとして throw する", () => {
    expect(() => parseRegisterResponse(200, JSON.stringify({ code: 11001, message: "dame" }))).toThrow(
      /受付エラー code=11001.*dame/,
    );
  });

  it("id も code も無い応答は throw する", () => {
    expect(() => parseRegisterResponse(200, JSON.stringify({ fileName: "a.pdf" }))).toThrow(/id がありません/);
  });

  it("id が空文字列 / 文字列以外は成功扱いしない", () => {
    expect(() => parseRegisterResponse(200, JSON.stringify({ id: "" }))).toThrow(/id がありません/);
    expect(() => parseRegisterResponse(200, JSON.stringify({ id: 123 }))).toThrow(/id がありません/);
  });

  it("code が空文字列なら code 無し扱いで throw する", () => {
    expect(() => parseRegisterResponse(500, JSON.stringify({ code: "" }))).toThrow(/id がありません/);
  });

  it("HTTP 200 でなければ id があっても成功扱いしない", () => {
    expect(() => parseRegisterResponse(500, JSON.stringify({ id: "abc" }))).toThrow(/HTTP 500.*id がありません/);
  });
});

describe("registerPdf", () => {
  it("register-file へ X-NPS-LITE-ID 付き multipart POST し id を返す", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "reg-id", fileName: "a.pdf" }));
    await expect(registerPdf(PDF, "a.pdf", { fetchImpl })).resolves.toBe("reg-id");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${NETPRINT_BASE_URL}/api/register-file`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-NPS-LITE-ID"]).toBe(NETPRINT_LITE_ID);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("fileName")).toBe("a.pdf");
  });

  it("fetchImpl を省略するとグローバル fetch を使う", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { id: "global-id" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(registerPdf(PDF, "a.pdf")).resolves.toBe("global-id");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("10MB 超はfetch せずに throw する", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { id: "x" }));
    await expect(registerPdf(new Uint8Array(NETPRINT_MAX_PDF_BYTES + 1), "big.pdf", { fetchImpl })).rejects.toThrow(
      /10MB.*を超えています/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("parseStatusResponse", () => {
  it("resultCode 0 で予約 (printID 8 桁英数) を返す", () => {
    expect(parseStatusResponse(200, JSON.stringify(DONE_BODY))).toEqual({
      done: true,
      reservation: {
        printId: "J5JZPEQJ",
        page: 1,
        fileSize: 1234,
        endDate: "2026/08/26 23:59",
        detailUrl: "https://lite.printing.ne.jp/api/file-detail/xxx",
      },
    });
  });

  it("resultCode 1 (変換処理中) は done: false", () => {
    expect(parseStatusResponse(200, JSON.stringify({ resultCode: 1 }))).toEqual({ done: false });
  });

  it("resultCode が数値文字列でも判定できる", () => {
    expect(parseStatusResponse(200, JSON.stringify({ resultCode: "1" }))).toEqual({ done: false });
  });

  it("HTTP 200 以外は本文付きで throw する", () => {
    expect(() => parseStatusResponse(503, "busy")).toThrow(/HTTP 503.*busy/);
  });

  it("JSON でない応答は throw する", () => {
    expect(() => parseStatusResponse(200, "<html>")).toThrow(/JSON でない応答/);
  });

  it("resultCode 欠落 (undefined / null / 空文字列) は throw する", () => {
    expect(() => parseStatusResponse(200, JSON.stringify({}))).toThrow(/resultCode が欠落/);
    expect(() => parseStatusResponse(200, JSON.stringify({ resultCode: null }))).toThrow(/resultCode が欠落/);
    expect(() => parseStatusResponse(200, JSON.stringify({ resultCode: "" }))).toThrow(/resultCode が欠落/);
  });

  it("0/1 以外の resultCode は変換エラーとして throw する", () => {
    expect(() => parseStatusResponse(200, JSON.stringify({ resultCode: 9, detail: "broken pdf" }))).toThrow(
      /resultCode=9.*broken pdf/,
    );
  });

  it("printID が 8 桁英数でなければ throw する", () => {
    expect(NETPRINT_PRINT_ID_RE.test("J5JZPEQJ")).toBe(true);
    expect(() => parseStatusResponse(200, JSON.stringify({ ...DONE_BODY, printID: "SHORT" }))).toThrow(
      /printID が 8 桁英数でありません/,
    );
    expect(() => parseStatusResponse(200, JSON.stringify({ ...DONE_BODY, printID: 12345678 }))).toThrow(
      /printID が 8 桁英数でありません/,
    );
  });

  it("page / fileSize は数値文字列も受けるが、欠落・非数値は throw する", () => {
    const stringNumbers = parseStatusResponse(200, JSON.stringify({ ...DONE_BODY, page: "2", fileSize: "99" }));
    expect(stringNumbers).toMatchObject({ done: true, reservation: { page: 2, fileSize: 99 } });
    expect(() => parseStatusResponse(200, JSON.stringify({ ...DONE_BODY, page: undefined }))).toThrow(
      /page が欠落または数値でありません/,
    );
    expect(() => parseStatusResponse(200, JSON.stringify({ ...DONE_BODY, fileSize: "abc" }))).toThrow(
      /fileSize が欠落または数値でありません/,
    );
  });

  it("endDate 欠落 / 空文字列は throw する", () => {
    expect(() => parseStatusResponse(200, JSON.stringify({ ...DONE_BODY, endDate: undefined }))).toThrow(
      /endDate が欠落/,
    );
    expect(() => parseStatusResponse(200, JSON.stringify({ ...DONE_BODY, endDate: "" }))).toThrow(/endDate が欠落/);
  });

  it("detailURL 欠落は throw する", () => {
    expect(() => parseStatusResponse(200, JSON.stringify({ ...DONE_BODY, detailURL: undefined }))).toThrow(
      /detailURL が欠落/,
    );
  });
});

describe("waitForReservation", () => {
  it("変換処理中 → 完了で予約を返す (poll 間は sleepImpl を挟む)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { resultCode: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, { resultCode: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, DONE_BODY));
    const sleepImpl = vi.fn(async () => {});
    const reservation = await waitForReservation("reg/id", { fetchImpl, sleepImpl });
    expect(reservation.printId).toBe("J5JZPEQJ");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${NETPRINT_BASE_URL}/api/registration-status/reg%2Fid`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>)["X-NPS-LITE-ID"]).toBe(NETPRINT_LITE_ID);
    expect(sleepImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledWith(NETPRINT_POLL_INTERVAL_MS);
  });

  it("1 回目で完了なら sleep しない", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, DONE_BODY));
    const sleepImpl = vi.fn(async () => {});
    await expect(waitForReservation("id", { fetchImpl, sleepImpl })).resolves.toMatchObject({
      printId: "J5JZPEQJ",
    });
    expect(sleepImpl).not.toHaveBeenCalled();
  });

  it("上限回数まで変換処理中なら throw する (最後の poll 後は sleep しない)", async () => {
    expect(NETPRINT_POLL_MAX_ATTEMPTS).toBe(30);
    const fetchImpl = vi.fn(async () => jsonResponse(200, { resultCode: 1 }));
    const sleepImpl = vi.fn(async () => {});
    await expect(waitForReservation("id", { fetchImpl, sleepImpl, maxAttempts: 2, pollIntervalMs: 5 })).rejects.toThrow(
      /2 回 \(5ms 間隔\) の poll で完了しませんでした/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleepImpl).toHaveBeenCalledTimes(1);
    expect(sleepImpl).toHaveBeenCalledWith(5);
  });

  it("途中の変換エラーは即 throw する", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { resultCode: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, { resultCode: 2 }));
    const sleepImpl = vi.fn(async () => {});
    await expect(waitForReservation("id", { fetchImpl, sleepImpl })).rejects.toThrow(/resultCode=2/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fetchImpl / sleepImpl を省略すると既定 (グローバル fetch + setTimeout) を使う", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { resultCode: 1 }))
      .mockResolvedValueOnce(jsonResponse(200, DONE_BODY));
    vi.stubGlobal("fetch", fetchMock);
    await expect(waitForReservation("id", { pollIntervalMs: 0 })).resolves.toMatchObject({ printId: "J5JZPEQJ" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("opts ごと省略できる (poll 間隔・上限も既定値)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, DONE_BODY));
    vi.stubGlobal("fetch", fetchMock);
    await expect(waitForReservation("id")).resolves.toMatchObject({ printId: "J5JZPEQJ" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
