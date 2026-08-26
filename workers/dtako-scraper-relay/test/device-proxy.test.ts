import { describe, it, expect, vi } from "vitest";

import type { FetchLike } from "../src/device-proxy";
import {
  deviceProxyGet,
  deviceProxyPostJson,
  deviceProxyUrl,
  requestDeviceJwt,
} from "../src/device-proxy";

const CRED = { deviceId: "dev-1", deviceSecret: "s3cret" };

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("requestDeviceJwt", () => {
  it("device credential を短命 JWT に交換し、tenant は応答から採る", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      jsonRes({ access_token: "jwt-abc", tenant_id: "t-1", expires_in: 3600 }),
    );
    const got = await requestDeviceJwt(CRED, fetchImpl);

    expect(got).toEqual({ accessToken: "jwt-abc", tenantId: "t-1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://auth-worker.internal/device/token");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      device_id: "dev-1",
      device_secret: "s3cret",
    });
  });

  it("失敗は status と本文抜粋つきで throw する (握らない)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ error: "invalid_credential" }, 401));
    await expect(requestDeviceJwt(CRED, fetchImpl)).rejects.toThrow(
      /device token mint failed \(401\).*invalid_credential/,
    );
  });

  it("★ 失敗しても device_secret は例外文言に載せない", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes({ error: "invalid_credential" }, 401));
    const err = await requestDeviceJwt(CRED, fetchImpl).catch((e: Error) => e);
    expect(String(err)).not.toContain("s3cret");
  });

  it("JSON でない応答は parse 失敗として throw", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("<html>502</html>", { status: 200 }));
    await expect(requestDeviceJwt(CRED, fetchImpl)).rejects.toThrow(/device token parse failed/);
  });

  it("access_token が無い / 空なら throw", async () => {
    for (const body of [{ tenant_id: "t-1" }, { access_token: "", tenant_id: "t-1" }, { access_token: 1, tenant_id: "t-1" }]) {
      const fetchImpl = vi.fn<FetchLike>(async () => jsonRes(body));
      await expect(requestDeviceJwt(CRED, fetchImpl)).rejects.toThrow(/no access_token/);
    }
  });

  it("tenant_id が無い / 空なら throw", async () => {
    for (const body of [{ access_token: "jwt" }, { access_token: "jwt", tenant_id: "" }, { access_token: "jwt", tenant_id: 1 }]) {
      const fetchImpl = vi.fn<FetchLike>(async () => jsonRes(body));
      await expect(requestDeviceJwt(CRED, fetchImpl)).rejects.toThrow(/no tenant_id/);
    }
  });
});

describe("deviceProxyUrl", () => {
  it("prefix を付ける (auth-worker が slice して alc の path にする)", () => {
    expect(deviceProxyUrl("/api/scraper/history")).toBe(
      "https://auth-worker.internal/device-data-proxy/api/scraper/history",
    );
  });

  it("query は付けられる (allowlist は pathname だけ見る)", () => {
    expect(deviceProxyUrl("/api/scraper/history", "?limit=20")).toBe(
      "https://auth-worker.internal/device-data-proxy/api/scraper/history?limit=20",
    );
  });
});

describe("deviceProxyGet / deviceProxyPostJson", () => {
  it("GET は Bearer を付ける", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes([]));
    await deviceProxyGet("/api/dtako/events/etags", "?date_from=2026-07-01", "jwt-abc", fetchImpl);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(
      "https://auth-worker.internal/device-data-proxy/api/dtako/events/etags?date_from=2026-07-01",
    );
    expect(init!.method).toBe("GET");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer jwt-abc");
  });

  it("★ X-Tenant-ID は付けない (auth-worker が device record から注入する)", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => jsonRes([]));
    await deviceProxyGet("/api/scraper/history", "", "jwt-abc", fetchImpl);
    const headers = fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers["X-Tenant-ID"]).toBeUndefined();
  });

  it("POST は Bearer + JSON body", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response(null, { status: 204 }));
    const entry = { target_date: "2026-08-25", comp_id: "75700192", status: "success" };
    const res = await deviceProxyPostJson("/api/scraper/history", entry, "jwt-abc", fetchImpl);

    expect(res.status).toBe(204);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://auth-worker.internal/device-data-proxy/api/scraper/history");
    expect(init!.method).toBe("POST");
    const headers = init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer jwt-abc");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init!.body as string)).toEqual(entry);
    expect(headers["X-Tenant-ID"]).toBeUndefined();
  });
});
