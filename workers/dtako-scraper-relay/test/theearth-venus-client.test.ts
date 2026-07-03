import { describe, expect, it, vi } from "vitest";
import { createCookieJar, TheearthClientError, type FetchLike } from "../src/theearth-client";
import {
  assertVdfMagic,
  buildDvrFileUrl,
  callVenusBridgeMethod,
  getDvrNotifications,
  openDvrFileStream,
  validateVdfMagicStream,
  VenusSessionExpiredError,
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
    const fetchImpl = sequenceFetch([new Response("err", { status: 500 })]);
    const jar = createCookieJar();
    await expect(callVenusBridgeMethod(jar, "SomeMethod", {}, fetchImpl)).rejects.toThrow(TheearthClientError);
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
    });
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

describe("buildDvrFileUrl", () => {
  it("builds the deterministic path", () => {
    expect(buildDvrFileUrl("27324455", "1", "1318", "20260701_230059-27324455-1-1318-20260702_072616-E")).toBe(
      "https://theearth-np.com/dvrData/27324455/1/1318/20260701_230059-27324455-1-1318-20260702_072616-E/20260701_230059-27324455-1-1318-20260702_072616-E.vdf",
    );
  });

  it("rejects segments with path traversal / unsafe characters", () => {
    expect(() => buildDvrFileUrl("../etc", "1", "1318", "a")).toThrow(TheearthClientError);
    expect(() => buildDvrFileUrl("27324455", "../etc", "1318", "a")).toThrow(TheearthClientError);
    expect(() => buildDvrFileUrl("27324455", "1", "13/18", "a")).toThrow(TheearthClientError);
    expect(() => buildDvrFileUrl("27324455", "1", "1318", "a.vdf")).toThrow(TheearthClientError);
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
