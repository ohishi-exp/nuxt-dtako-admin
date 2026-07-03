import { describe, expect, it, vi } from "vitest";
import { createCookieJar, TheearthClientError, type FetchLike } from "../src/theearth-client";
import {
  assertVdfMagic,
  buildDvrSearchKey,
  callVenusBridgeMethod,
  dvrDataUrl,
  DvrSearchParamError,
  getDvrMasters,
  getDvrNotifications,
  openDvrFileStream,
  parseReceiveState,
  requestDvrDownloadPath,
  requestDvrFileTransfer,
  requestDvrFileTransferMulti,
  searchDvrData,
  validateVdfMagicStream,
  VenusSessionExpiredError,
  type DvrSearchParams,
} from "../src/theearth-venus-client";

const VDF_BYTES = new Uint8Array([0x4e, 0x45, 0x54, 0x37, 0x38, 0x30, 0x01, 0x02]); // "NET780" + payload

function jsonResponse(body: unknown, contentType = "application/json; charset=utf-8"): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": contentType } });
}

function sequenceFetch(responses: Response[]): FetchLike {
  let i = 0;
  return (async () => {
    const res = responses[i];
    i += 1;
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`);
    return res;
  }) as FetchLike;
}

/** 任意の chunk 列を流す ReadableStream (multi-chunk / 空 chunk の検証用)。 */
function chunkedStream(chunks: Uint8Array[], onCancel?: (reason: unknown) => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i]);
        i += 1;
      } else {
        controller.close();
      }
    },
    cancel(reason) {
      onCancel?.(reason);
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

describe("callVenusBridgeMethod", () => {
  it('unwraps the "d" field on success', async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ d: { hello: "world" } })]);
    const jar = createCookieJar();
    const d = await callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl);
    expect(d).toEqual({ hello: "world" });
  });

  it("throws on non-2xx status", async () => {
    const fetchImpl = sequenceFetch([new Response("err", { status: 503 })]);
    const jar = createCookieJar();
    await expect(callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl)).rejects.toThrow(TheearthClientError);
  });

  it("maps HTTP 500 to VenusSessionExpiredError (dead ASP.NET session, staging-observed)", async () => {
    // theearth セッションが別の場所での同一アカウントログイン等で無効化されると
    // VenusBridge は HTTP 500 を返す。再ログインで回復するので 401 経路に載せる。
    const fetchImpl = sequenceFetch([new Response("err", { status: 500 })]);
    const jar = createCookieJar();
    await expect(callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });

  it("throws VenusSessionExpiredError when the response is not JSON (silent-200 guard)", async () => {
    const fetchImpl = sequenceFetch([
      new Response("<html>ログインしてください</html>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    ]);
    const jar = createCookieJar();
    await expect(callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl)).rejects.toThrow(
      VenusSessionExpiredError,
    );
  });

  it("throws when the response has no Content-Type header at all", async () => {
    const fetchImpl = sequenceFetch([new Response(new TextEncoder().encode("oops"), { status: 200 })]);
    const jar = createCookieJar();
    await expect(callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl)).rejects.toThrow("unknown");
  });

  it("throws a TheearthClientError when the body is not parseable despite a json content-type", async () => {
    const fetchImpl = sequenceFetch([
      new Response("", { status: 200, headers: { "content-type": "application/json" } }),
    ]);
    const jar = createCookieJar();
    await expect(callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl)).rejects.toThrow(
      "JSON として parse できませんでした",
    );
  });

  it('throws when the JSON response has no "d" field', async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ notD: 1 })]);
    const jar = createCookieJar();
    await expect(callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl)).rejects.toThrow('"d" フィールド');
  });

  it("throws when the JSON response is null", async () => {
    const fetchImpl = sequenceFetch([jsonResponse(null)]);
    const jar = createCookieJar();
    await expect(callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl)).rejects.toThrow('"d" フィールド');
  });
});

describe("getDvrNotifications", () => {
  it("maps known field names", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse({
        d: [
          {
            vehicle_cd: "1001",
            vehicle_name: "Truck A",
            serial_no: "SN1",
            file_name: "20260701_230059-27324455-1-1318-20260702_072616-E",
            file_path: "",
            event_type: "alert",
            dvr_datetime: "2026-07-01T23:00:59",
            driver_name: "山田太郎",
          },
        ],
      }),
    ]);
    const jar = createCookieJar();
    const notifications = await getDvrNotifications(jar, fetchImpl);
    expect(notifications).toEqual([
      {
        raw: expect.any(Object),
        vehicleCd: "1001",
        vehicleName: "Truck A",
        serialNo: "SN1",
        fileName: "20260701_230059-27324455-1-1318-20260702_072616-E",
        filePath: "",
        eventType: "alert",
        dvrDatetime: "2026-07-01T23:00:59",
        driverName: "山田太郎",
        latitude: null,
        longitude: null,
        receiveState: "unknown",
      },
    ]);
  });

  it("maps PascalCase field names and null-fills missing ones", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse({ d: { rows: [{ VehicleCD: "2001", FileName: "f1", SerialNo: "1" }] } }),
    ]);
    const jar = createCookieJar();
    const notifications = await getDvrNotifications(jar, fetchImpl);
    expect(notifications[0]).toMatchObject({
      vehicleCd: "2001",
      fileName: "f1",
      serialNo: "1",
      vehicleName: null,
      eventType: null,
      dvrDatetime: null,
      driverName: null,
      filePath: null,
      latitude: null,
      longitude: null,
    });
  });

  it("parses the real theearth shape [countString, rowsJsonString] with 1e6-scaled coords", async () => {
    // Refs #90 実データ: d = ["4", "<行配列を JSON エンコードした文字列>"]。
    // 各行は PascalCase、VehicleCD は数値、Latitude/Longitude は度 × 1e6 の整数。
    const rows = [
      {
        VehicleCD: 4228,
        VehicleName: "長崎100か4228",
        SerialNo: "AX0605008014180",
        FileName: "20260630_213458-0-0-4228-20260703_015633-E.vdf",
        FilePath: "",
        FileReceive: "fa fa-play-circle fa-icon-green fa-prcs-3-0 fa-lg",
        EventType: "急減速",
        DvrDatetime: "2026/07/03 01:56:56",
        DriverName: "古賀　好春",
        Latitude: 36339272,
        Longitude: 136359420,
      },
    ];
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["4", JSON.stringify(rows)] })]);
    const jar = createCookieJar();
    const notifications = await getDvrNotifications(jar, fetchImpl);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      vehicleCd: "4228",
      vehicleName: "長崎100か4228",
      serialNo: "AX0605008014180",
      fileName: "20260630_213458-0-0-4228-20260703_015633-E.vdf",
      eventType: "急減速",
      dvrDatetime: "2026/07/03 01:56:56",
      driverName: "古賀　好春",
      latitude: 36.339272,
      longitude: 136.35942,
      receiveState: "ready",
    });
  });

  it("handles coord fields given as already-degree numbers, numeric strings, and 0/invalid", async () => {
    const rows = [
      { VehicleCD: "a", Latitude: 35.68, Longitude: "139.76" }, // 度そのまま / 数値文字列
      { VehicleCD: "b", Latitude: 0, Longitude: "not-a-number" }, // 0 / 非数 → null
      { VehicleCD: "c", Latitude: null, Longitude: true }, // key はあるが非数値型 → null
      { VehicleCD: "d" }, // フィールド不在 → null
    ];
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["3", JSON.stringify(rows)] })]);
    const jar = createCookieJar();
    const n = await getDvrNotifications(jar, fetchImpl);
    expect(n[0]).toMatchObject({ latitude: 35.68, longitude: 139.76 });
    expect(n[1]).toMatchObject({ latitude: null, longitude: null });
    expect(n[2]).toMatchObject({ latitude: null, longitude: null });
    expect(n[3]).toMatchObject({ latitude: null, longitude: null });
  });

  it("treats a non-JSON second element as the fallback array shape", async () => {
    // [x, "not json"] は theearth 形として剥がせない → 素の配列フォールバックで
    // オブジェクト要素だけ拾う (スカラーの "x" は除外して in 演算子クラッシュを防ぐ)。
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["x", "not-json-string"] })]);
    const jar = createCookieJar();
    const notifications = await getDvrNotifications(jar, fetchImpl);
    expect(notifications).toEqual([]);
  });

  it("drops scalar elements instead of crashing on the 'in' operator", async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ d: [4, { VehicleCD: "9001" }] })]);
    const jar = createCookieJar();
    const notifications = await getDvrNotifications(jar, fetchImpl);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.vehicleCd).toBe("9001");
  });

  it("resolves {Rows:[]} / {Table:[]} wrapped responses", async () => {
    const jar = createCookieJar();
    const viaRows = await getDvrNotifications(
      jar,
      sequenceFetch([jsonResponse({ d: { Rows: [{ VehicleCD: "3001" }] } })]),
    );
    expect(viaRows[0]?.vehicleCd).toBe("3001");
    const viaTable = await getDvrNotifications(
      jar,
      sequenceFetch([jsonResponse({ d: { Table: [{ VehicleCD: "4001" }] } })]),
    );
    expect(viaTable[0]?.vehicleCd).toBe("4001");
  });

  it("throws loudly when the response shape is unrecognized", async () => {
    const jar = createCookieJar();
    await expect(
      getDvrNotifications(jar, sequenceFetch([jsonResponse({ d: 42 })])),
    ).rejects.toThrow(TheearthClientError);
    await expect(
      getDvrNotifications(jar, sequenceFetch([jsonResponse({ d: { other: 1 } })])),
    ).rejects.toThrow(TheearthClientError);
  });
});

describe("parseReceiveState", () => {
  it("maps the fa-prcs-X-Y class to a receive state", () => {
    expect(parseReceiveState("fa fa-play-circle fa-icon-green fa-prcs-3-0 fa-lg")).toBe("ready");
    expect(parseReceiveState("fa fa-cloud-download fa-prcs-0-0 fa-lg")).toBe("requestable");
    expect(parseReceiveState("fa fa-prcs-1-0")).toBe("in_progress");
    expect(parseReceiveState("fa fa-prcs-1-3")).toBe("in_progress");
    expect(parseReceiveState("fa fa-prcs-2-0")).toBe("in_progress");
    expect(parseReceiveState("fa fa-prcs-1-1")).toBe("error");
    expect(parseReceiveState("fa fa-prcs-2-1")).toBe("error");
    expect(parseReceiveState("fa fa-prcs-3-2")).toBe("error");
  });

  it("returns unknown for null / unrecognized classes", () => {
    expect(parseReceiveState(null)).toBe("unknown");
    expect(parseReceiveState("fa fa-something-else")).toBe("unknown");
  });
});

describe("dvrDataUrl", () => {
  it("builds an absolute /dvrData/ url", () => {
    expect(dvrDataUrl("27324455/4/4228/x/x.vdf")).toBe("https://theearth-np.com/dvrData/27324455/4/4228/x/x.vdf");
  });
});

describe("requestDvrDownloadPath", () => {
  const key1 = "AX0605008014180";
  const key2 = "20260630_213458-0-0-4228-20260703_015633-E.vdf";

  it("resolves the server-provided path and normalizes backslashes", async () => {
    // 実データ: d = [code, "27324455/4/4228/{dir}\\{file}.vdf", filename, key, err]
    const rawPath = "27324455/4/4228/20260630_213458-0-0-4228-20260703_015633-E\\20260630_213458-0-0-4228-20260703_015633-E.vdf";
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["1", rawPath, key2, `${key1};${key2}`, ""] })]);
    const jar = createCookieJar();
    const target = await requestDvrDownloadPath(jar, key1, key2, fetchImpl);
    expect(target.path).toBe(
      "27324455/4/4228/20260630_213458-0-0-4228-20260703_015633-E/20260630_213458-0-0-4228-20260703_015633-E.vdf",
    );
    expect(target.filename).toBe(key2);
  });

  it("falls back to the requested filename when the server omits it", async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["1", "a/b.vdf", "", "k", ""] })]);
    const jar = createCookieJar();
    const target = await requestDvrDownloadPath(jar, key1, key2, fetchImpl);
    expect(target.filename).toBe(key2);
  });

  it("strips a leading slash on the returned path", async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["1", "/a/b.vdf", "b.vdf", "k", ""] })]);
    const jar = createCookieJar();
    expect((await requestDvrDownloadPath(jar, key1, key2, fetchImpl)).path).toBe("a/b.vdf");
  });

  it("throws a receive-needed message when code <= 0 or the path is empty", async () => {
    const jar = createCookieJar();
    await expect(
      requestDvrDownloadPath(jar, key1, key2, sequenceFetch([jsonResponse({ d: ["-1", "", "", ";", "1"] })])),
    ).rejects.toThrow("車両からの転送");
    await expect(
      requestDvrDownloadPath(jar, key1, key2, sequenceFetch([jsonResponse({ d: ["1", "", "", "", ""] })])),
    ).rejects.toThrow("車両からの転送");
    // d[1] が文字列でない (数値等) → path 空扱いで同じく receive-needed
    await expect(
      requestDvrDownloadPath(jar, key1, key2, sequenceFetch([jsonResponse({ d: ["1", 0, "", "", ""] })])),
    ).rejects.toThrow("車両からの転送");
  });

  it("rejects a path-traversal payload", async () => {
    const jar = createCookieJar();
    await expect(
      requestDvrDownloadPath(jar, key1, key2, sequenceFetch([jsonResponse({ d: ["1", "../../etc/passwd", "x", "k", ""] })])),
    ).rejects.toThrow("不正なダウンロードパス");
  });

  it("throws when the response is not the expected array shape", async () => {
    const jar = createCookieJar();
    await expect(
      requestDvrDownloadPath(jar, key1, key2, sequenceFetch([jsonResponse({ d: "nope" })])),
    ).rejects.toThrow(TheearthClientError);
  });
});

describe("requestDvrFileTransfer", () => {
  it("returns code>0 as accepted from an array response", async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["1", "ok"] })]);
    const jar = createCookieJar();
    expect(await requestDvrFileTransfer(jar, "serial", "file.vdf", fetchImpl)).toEqual({ code: 1, raw: ["1", "ok"] });
  });

  it("parses a scalar response and coerces non-numeric to -1", async () => {
    const jar = createCookieJar();
    expect((await requestDvrFileTransfer(jar, "s", "f", sequenceFetch([jsonResponse({ d: 2 })]))).code).toBe(2);
    expect((await requestDvrFileTransfer(jar, "s", "f", sequenceFetch([jsonResponse({ d: "x" })]))).code).toBe(-1);
  });
});

describe("assertVdfMagic / validateVdfMagicStream", () => {
  it("accepts bytes with the NET780 magic", () => {
    expect(() => assertVdfMagic(VDF_BYTES)).not.toThrow();
  });

  it("rejects bytes without the NET780 magic (and too-short heads)", () => {
    expect(() => assertVdfMagic(new Uint8Array([0, 0, 0, 0, 0, 0]))).toThrow(TheearthClientError);
    expect(() => assertVdfMagic(new Uint8Array([0x4e, 0x45]))).toThrow(TheearthClientError);
  });

  it("passes through a single-chunk stream unchanged", async () => {
    const stream = await validateVdfMagicStream(chunkedStream([VDF_BYTES]));
    expect(await readAll(stream)).toEqual(VDF_BYTES);
  });

  it("passes through a multi-chunk stream (magic split across chunks, empty chunk ignored)", async () => {
    const chunks = [
      VDF_BYTES.slice(0, 2),
      new Uint8Array(0),
      VDF_BYTES.slice(2, 5),
      VDF_BYTES.slice(5),
      new Uint8Array([0xff]),
    ];
    const stream = await validateVdfMagicStream(chunkedStream(chunks));
    expect(await readAll(stream)).toEqual(new Uint8Array([...VDF_BYTES, 0xff]));
  });

  it("rejects a stream whose head is not the NET780 magic", async () => {
    await expect(
      validateVdfMagicStream(chunkedStream([new Uint8Array([1, 2, 3, 4, 5, 6, 7])])),
    ).rejects.toThrow(TheearthClientError);
  });

  it("rejects a stream that ends before 6 bytes", async () => {
    await expect(validateVdfMagicStream(chunkedStream([new Uint8Array([0x4e, 0x45])]))).rejects.toThrow(
      "短すぎます",
    );
  });

  it("propagates cancel to the underlying reader", async () => {
    const onCancel = vi.fn();
    const stream = await validateVdfMagicStream(
      chunkedStream([VDF_BYTES, new Uint8Array([0xaa])], onCancel),
    );
    await stream.cancel("stop");
    expect(onCancel).toHaveBeenCalledWith("stop");
  });
});

describe("openDvrFileStream", () => {
  it("returns a validated stream on success", async () => {
    const fetchImpl = sequenceFetch([new Response(VDF_BYTES, { status: 200 })]);
    const jar = createCookieJar();
    const stream = await openDvrFileStream(jar, "https://theearth-np.com/dvrData/x", fetchImpl);
    expect(await readAll(stream)).toEqual(VDF_BYTES);
  });

  it("throws on non-2xx status", async () => {
    const fetchImpl = sequenceFetch([new Response("nope", { status: 404 })]);
    const jar = createCookieJar();
    await expect(openDvrFileStream(jar, "https://theearth-np.com/dvrData/x", fetchImpl)).rejects.toThrow(
      "HTTP 404",
    );
  });

  it("throws when the response has no body", async () => {
    const fetchImpl = sequenceFetch([new Response(null, { status: 200 })]);
    const jar = createCookieJar();
    await expect(openDvrFileStream(jar, "https://theearth-np.com/dvrData/x", fetchImpl)).rejects.toThrow(
      "body がありません",
    );
  });

  it("throws when the body is not a NET780 container (login page guard)", async () => {
    const fetchImpl = sequenceFetch([
      new Response("<html>ログインしてください</html>", { status: 200 }),
    ]);
    const jar = createCookieJar();
    await expect(openDvrFileStream(jar, "https://theearth-np.com/dvrData/x", fetchImpl)).rejects.toThrow(
      TheearthClientError,
    );
  });
});

// --- 映像検索 (Request_DvrDataList、Refs #90 実ページ J-AAV0100 トレース) ---

/** 実測キーに一致する最小の有効パラメータ (車輌のみ指定)。 */
function baseSearchParams(overrides: Partial<DvrSearchParams> = {}): DvrSearchParams {
  return { start: "2026/07/03 18:06", rangeMinutes: 30, vehicleCds: "2131", ...overrides };
}

describe("buildDvrSearchKey", () => {
  it("builds the exact key observed on the real page (vehicle-only search)", () => {
    // 実測: ["2026/07/03 18:06","2026/07/03 18:36","2131","","","","300","1,1,1,1","1,1","1,1,1"]
    expect(buildDvrSearchKey(baseSearchParams())).toEqual([
      "2026/07/03 18:06",
      "2026/07/03 18:36",
      "2131",
      "",
      "",
      "",
      "300",
      "1,1,1,1",
      "1,1",
      "1,1,1",
    ]);
  });

  it("rolls the end datetime across day boundaries", () => {
    const key = buildDvrSearchKey(baseSearchParams({ start: "2026/12/31 23:50", rangeMinutes: 30 }));
    expect(key[0]).toBe("2026/12/31 23:50");
    expect(key[1]).toBe("2027/01/01 00:20");
  });

  it("rejects a start datetime that is not in YYYY/MM/DD HH:mm format", () => {
    expect(() => buildDvrSearchKey(baseSearchParams({ start: "2026-07-03 18:06" }))).toThrow(DvrSearchParamError);
    expect(() => buildDvrSearchKey(baseSearchParams({ start: "26/07/03 18:06" }))).toThrow("開始日時");
  });

  it("rejects an impossible calendar date (Date.UTC silently rolls it over)", () => {
    expect(() => buildDvrSearchKey(baseSearchParams({ start: "2026/02/31 10:00" }))).toThrow(DvrSearchParamError);
    expect(() => buildDvrSearchKey(baseSearchParams({ start: "2026/07/03 24:00" }))).toThrow(DvrSearchParamError);
  });

  it("rejects an invalid rangeMinutes (non-integer / below 1 / above 1440)", () => {
    expect(() => buildDvrSearchKey(baseSearchParams({ rangeMinutes: 30.5 }))).toThrow("範囲 [分]");
    expect(() => buildDvrSearchKey(baseSearchParams({ rangeMinutes: 0 }))).toThrow(DvrSearchParamError);
    expect(() => buildDvrSearchKey(baseSearchParams({ rangeMinutes: 1441 }))).toThrow(DvrSearchParamError);
  });

  it("normalizes comma-separated CD lists (trims spaces, drops empties)", () => {
    const key = buildDvrSearchKey(baseSearchParams({ vehicleCds: " 2131 , 45 ,", driverCds: "1526" }));
    expect(key[2]).toBe("2131,45");
    expect(key[3]).toBe("1526");
  });

  it("rejects non-numeric CD list entries", () => {
    expect(() => buildDvrSearchKey(baseSearchParams({ vehicleCds: "abc" }))).toThrow("車輌CD");
    expect(() => buildDvrSearchKey(baseSearchParams({ driverCds: "1;DROP" }))).toThrow("乗務員CD");
  });

  it("accepts a driver-only search", () => {
    const key = buildDvrSearchKey({ start: "2026/07/03 18:06", rangeMinutes: 30, driverCds: "1526" });
    expect(key[2]).toBe("");
    expect(key[3]).toBe("1526");
  });

  it("converts lat/lng degrees to arc-seconds (negative for south/west)", () => {
    const key = buildDvrSearchKey({
      start: "2026/07/03 18:06",
      rangeMinutes: 30,
      latitude: 32.478749,
      longitude: -130.098251,
      radiusM: 500,
    });
    expect(key[4]).toBe(String(Math.round(32.478749 * 3600)));
    expect(key[5]).toBe(String(Math.round(-130.098251 * 3600)));
    expect(key[6]).toBe("500");
  });

  it("accepts a lat/lng search where only one axis is zero", () => {
    const key = buildDvrSearchKey({ start: "2026/07/03 18:06", rangeMinutes: 30, latitude: 0, longitude: 130 });
    expect(key[4]).toBe("0");
    expect(key[5]).toBe("468000");
  });

  it("treats lat=0 lng=0 as not specified (real page sends empty strings)", () => {
    const key = buildDvrSearchKey(baseSearchParams({ latitude: 0, longitude: 0 }));
    expect(key[4]).toBe("");
    expect(key[5]).toBe("");
  });

  it("rejects a half-specified lat/lng pair", () => {
    expect(() => buildDvrSearchKey(baseSearchParams({ latitude: 32.5 }))).toThrow("緯度・経度の両方");
    expect(() => buildDvrSearchKey(baseSearchParams({ longitude: 130.1 }))).toThrow("緯度・経度の両方");
  });

  it("rejects out-of-range or non-finite lat/lng", () => {
    expect(() => buildDvrSearchKey(baseSearchParams({ latitude: Number.NaN, longitude: 130 }))).toThrow("範囲外");
    expect(() => buildDvrSearchKey(baseSearchParams({ latitude: 91, longitude: 130 }))).toThrow("範囲外");
    expect(() => buildDvrSearchKey(baseSearchParams({ latitude: 32, longitude: Number.NaN }))).toThrow("範囲外");
    expect(() => buildDvrSearchKey(baseSearchParams({ latitude: 32, longitude: 181 }))).toThrow("範囲外");
  });

  it("requires at least one of vehicle / driver / lat-lng", () => {
    expect(() => buildDvrSearchKey({ start: "2026/07/03 18:06", rangeMinutes: 30 })).toThrow(
      "車輌・乗務員・位置範囲のいずれか",
    );
    // lat=0 lng=0 は「未指定」扱いなので、これ単独でも弾かれる
    expect(() =>
      buildDvrSearchKey({ start: "2026/07/03 18:06", rangeMinutes: 30, latitude: 0, longitude: 0 }),
    ).toThrow("車輌・乗務員・位置範囲のいずれか");
  });

  it("rejects an invalid radiusM", () => {
    expect(() => buildDvrSearchKey(baseSearchParams({ radiusM: 0 }))).toThrow("位置範囲 [m]");
    expect(() => buildDvrSearchKey(baseSearchParams({ radiusM: Number.NaN }))).toThrow("位置範囲 [m]");
  });

  it("encodes partial flag groups (warning flag is duplicated per the real page)", () => {
    const key = buildDvrSearchKey(
      baseSearchParams({
        dvrTypes: { warning: false, always: true, emergency: false },
        runStates: { running: true, stopped: false },
        roadTypes: { general: false, highway: true, exclusive: false },
      }),
    );
    expect(key[7]).toBe("0,0,1,0");
    expect(key[8]).toBe("1,0");
    expect(key[9]).toBe("0,1,0");
  });

  it("rejects flag groups where nothing is selected", () => {
    expect(() =>
      buildDvrSearchKey(baseSearchParams({ dvrTypes: { warning: false, always: false, emergency: false } })),
    ).toThrow("映像種別");
    expect(() =>
      buildDvrSearchKey(baseSearchParams({ runStates: { running: false, stopped: false } })),
    ).toThrow("走行状態");
    expect(() =>
      buildDvrSearchKey(baseSearchParams({ roadTypes: { general: false, highway: false, exclusive: false } })),
    ).toThrow("道路種別");
  });

  it("exposes DvrSearchParamError as a named TheearthClientError subclass", () => {
    try {
      buildDvrSearchKey({ start: "bad", rangeMinutes: 30 });
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TheearthClientError);
      expect((e as Error).name).toBe("DvrSearchParamError");
    }
  });
});

describe("searchDvrData", () => {
  it("parses the real theearth shape and maps search-specific columns", async () => {
    // Refs #90 実データ (Request_DvrDataList): d = ["7", "<行JSON文字列>"]
    const rows = [
      {
        DataType: "常時",
        DataTypeCD: 12,
        DriverCD: 1526,
        DriverName: "陣内　尚仁",
        DvrDatetime: "2026/07/03 18:32:26",
        EventType: "",
        EventTypeCD: 0,
        EventValue: "0",
        FileDownload: "",
        FileName: "20260703_094244-0-0-2131-20260703_183226-I.vdf",
        FilePath: "",
        FileReceive: "fa fa-file-video-o fa-icon-green fa-prcs-0-0 fa-lg",
        Flag: "fa fa-check fa-lg fa-icon-transGreen",
        Latitude: 32478749,
        Longitude: 130098251,
        PlaceName: "長崎県雲仙市愛野町浜",
        Revo: 670,
        RoadType: "一般",
        RowIndex: 0,
        RunState: "走行",
        SerialNo: "AX0605008014440",
        Speed: 24,
        VehicleCD: 2131,
        VehicleName: "長崎800か2131",
      },
    ];
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["1", JSON.stringify(rows)] })]);
    const jar = createCookieJar();
    const result = await searchDvrData(jar, buildDvrSearchKey(baseSearchParams()), fetchImpl);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      vehicleCd: "2131",
      vehicleName: "長崎800か2131",
      serialNo: "AX0605008014440",
      fileName: "20260703_094244-0-0-2131-20260703_183226-I.vdf",
      dvrDatetime: "2026/07/03 18:32:26",
      driverName: "陣内　尚仁",
      latitude: 32.478749,
      longitude: 130.098251,
      receiveState: "requestable",
      dataType: "常時",
      runState: "走行",
      roadType: "一般",
      placeName: "長崎県雲仙市愛野町浜",
      speed: 24,
    });
  });

  it("coerces a string Speed and null-fills missing search columns", async () => {
    const rows = [
      { SerialNo: "SN1", FileName: "f1", Speed: "12.5" },
      { SerialNo: "SN2", FileName: "f2", Speed: "not-a-number" },
    ];
    const fetchImpl = sequenceFetch([jsonResponse({ d: ["2", JSON.stringify(rows)] })]);
    const jar = createCookieJar();
    const result = await searchDvrData(jar, buildDvrSearchKey(baseSearchParams()), fetchImpl);
    expect(result[0]).toMatchObject({ speed: 12.5, dataType: null, runState: null, roadType: null, placeName: null });
    expect(result[1]).toMatchObject({ speed: null });
  });

  it("throws when the response shape is not row-like", async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ d: "unexpected" })]);
    const jar = createCookieJar();
    await expect(searchDvrData(jar, buildDvrSearchKey(baseSearchParams()), fetchImpl)).rejects.toThrow(
      "Request_DvrDataList のレスポンス形式",
    );
  });
});

describe("getDvrMasters", () => {
  // Refs #90 実データ: d = [事業所JSON, 車輌JSON, 乗務員JSON, 通知件数, 通知行JSON, 設定]
  const BRANCHES = JSON.stringify([{ code: "00000001", name: "大石運輸倉庫㈱　本社営業所" }]);
  const VEHICLES = JSON.stringify([{ code: 11, link: "00000007", name: "十勝800か11" }]);
  const DRIVERS = JSON.stringify([{ code: 1009, link: "00000001", name: "長谷川  明" }]);

  it("parses the real 6-element response into branches/vehicles/drivers", async () => {
    const fetchImpl = sequenceFetch([jsonResponse({ d: [BRANCHES, VEHICLES, DRIVERS, "4", "[]", ""] })]);
    const jar = createCookieJar();
    const masters = await getDvrMasters(jar, fetchImpl);
    expect(masters).toEqual({
      branches: [{ code: "00000001", name: "大石運輸倉庫㈱　本社営業所" }],
      vehicles: [{ code: "11", link: "00000007", name: "十勝800か11" }],
      drivers: [{ code: "1009", link: "00000001", name: "長谷川  明" }],
    });
  });

  it("null-fills missing code/link/name fields", async () => {
    const fetchImpl = sequenceFetch([
      jsonResponse({ d: [JSON.stringify([{}]), JSON.stringify([{ code: 5 }]), JSON.stringify([{ name: "x" }])] }),
    ]);
    const jar = createCookieJar();
    const masters = await getDvrMasters(jar, fetchImpl);
    expect(masters.branches).toEqual([{ code: "", name: "" }]);
    expect(masters.vehicles).toEqual([{ code: "5", link: null, name: "" }]);
    expect(masters.drivers).toEqual([{ code: "", link: null, name: "x" }]);
  });

  it("throws when d is not an array or too short", async () => {
    const jar = createCookieJar();
    await expect(getDvrMasters(jar, sequenceFetch([jsonResponse({ d: "x" })]))).rejects.toThrow(
      "Request_NetDvrFuncInitValue の応答形式",
    );
    await expect(getDvrMasters(jar, sequenceFetch([jsonResponse({ d: [BRANCHES, VEHICLES] })]))).rejects.toThrow(
      "Request_NetDvrFuncInitValue の応答形式",
    );
  });

  it("throws when a master element is not a string / not JSON / not an array", async () => {
    const jar = createCookieJar();
    await expect(getDvrMasters(jar, sequenceFetch([jsonResponse({ d: [1, VEHICLES, DRIVERS] })]))).rejects.toThrow(
      "文字列ではありません",
    );
    await expect(
      getDvrMasters(jar, sequenceFetch([jsonResponse({ d: [BRANCHES, "{broken", DRIVERS] })])),
    ).rejects.toThrow("JSON として parse できませんでした");
    await expect(
      getDvrMasters(jar, sequenceFetch([jsonResponse({ d: [BRANCHES, VEHICLES, "{}"] })])),
    ).rejects.toThrow("配列ではありません");
  });
});

describe("requestDvrFileTransferMulti", () => {
  it("joins serials/filenames with commas and returns the result code", async () => {
    let requestBody: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      requestBody = init?.body as string;
      return jsonResponse({ d: [2, "ok"] });
    };
    const jar = createCookieJar();
    const result = await requestDvrFileTransferMulti(jar, ["SN1", "SN2"], ["f1.vdf", "f2.vdf"], fetchImpl);
    expect(result.code).toBe(2);
    expect(JSON.parse(requestBody!)).toEqual({ key1: "SN1,SN2", key2: "f1.vdf,f2.vdf" });
  });

  it("accepts a scalar (non-array) result code", async () => {
    const jar = createCookieJar();
    const result = await requestDvrFileTransferMulti(jar, ["SN1"], ["f1"], sequenceFetch([jsonResponse({ d: "3" })]));
    expect(result.code).toBe(3);
  });

  it("returns -1 when the result code is not numeric", async () => {
    const jar = createCookieJar();
    const result = await requestDvrFileTransferMulti(
      jar,
      ["SN1"],
      ["f1"],
      sequenceFetch([jsonResponse({ d: ["abc"] })]),
    );
    expect(result.code).toBe(-1);
  });

  it("rejects empty or mismatched serial/filename lists without fetching", async () => {
    const fetchImpl = vi.fn();
    const jar = createCookieJar();
    await expect(requestDvrFileTransferMulti(jar, [], [], fetchImpl as unknown as FetchLike)).rejects.toThrow(
      DvrSearchParamError,
    );
    await expect(
      requestDvrFileTransferMulti(jar, ["SN1"], ["f1", "f2"], fetchImpl as unknown as FetchLike),
    ).rejects.toThrow("同数");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
