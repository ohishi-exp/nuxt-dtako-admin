import { describe, it, expect } from "vitest";

import {
  ALC_TENANT_RPC_MISSING,
  AlcTenantRpcError,
  requireAlcTenantForwarder,
  unwrapAlcTenantData,
  type AlcTenantDataForwarder,
  type AlcTenantDataResult,
} from "../src/alc-tenant-rpc";

const res = (status: number, body = ""): AlcTenantDataResult => ({
  status,
  body,
  contentType: null,
});

describe("unwrapAlcTenantData", () => {
  it("2xx は本文をそのまま返す", () => {
    expect(unwrapAlcTenantData("alc x", res(200, "[]"))).toBe("[]");
    expect(unwrapAlcTenantData("alc x", res(204, ""))).toBe("");
    expect(unwrapAlcTenantData("alc x", res(299, "ok"))).toBe("ok");
  });

  it("★ 非 2xx は黙って空を返さず throw する (0 件と引けなかったを混ぜない)", () => {
    expect(() => unwrapAlcTenantData("alc x", res(403, '{"error":"path_not_forwardable"}'))).toThrow(
      AlcTenantRpcError,
    );
    // 3xx も 2xx ではない
    expect(() => unwrapAlcTenantData("alc x", res(302, "moved"))).toThrow(AlcTenantRpcError);
    expect(() => unwrapAlcTenantData("alc x", res(199, "early"))).toThrow(AlcTenantRpcError);
  });

  it("★ 何をしようとして落ちたか・status・本文抜粋を名指しする", () => {
    expect(() => unwrapAlcTenantData("alc scraper history", res(502, "upstream boom"))).toThrow(
      /alc scraper history failed \(502\): upstream boom/,
    );
  });

  it("長い本文は 300 字で切る (ログを膨らませない)", () => {
    const err = (() => {
      try {
        unwrapAlcTenantData("alc x", res(500, "x".repeat(1000)));
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err).not.toBeNull();
    expect(err!.message).toContain("x".repeat(300));
    expect(err!.message).not.toContain("x".repeat(301));
  });
});

describe("requireAlcTenantForwarder", () => {
  it("binding があればそのまま返す", () => {
    const rpc: AlcTenantDataForwarder = {
      forwardAlcTenantData: async () => res(200, "[]"),
    };
    expect(requireAlcTenantForwarder(rpc)).toBe(rpc);
  });

  it("★ binding が無ければ黙って通さず、何を宣言すればいいか名指しして throw する", () => {
    for (const missing of [undefined, null]) {
      expect(() => requireAlcTenantForwarder(missing)).toThrow(AlcTenantRpcError);
      expect(() => requireAlcTenantForwarder(missing)).toThrow(/AUTH_WORKER_RPC binding がありません/);
      // named environment の宣言漏れで静かに 0 件にならないよう、直し方まで文面に出す
      expect(() => requireAlcTenantForwarder(missing)).toThrow(/InternalEntrypoint/);
    }
    expect(ALC_TENANT_RPC_MISSING).toContain("env.staging");
    expect(ALC_TENANT_RPC_MISSING).toContain("env.preview");
  });
});
