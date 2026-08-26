import { describe, it, expect } from "vitest";

import {
  DtakoDeviceCredsError,
  credentialForTenant,
  parseDtakoDeviceCreds,
} from "../src/dtako-device-creds";
import { DTAKO_DEVICE_CREDS_KV_KEY, resolveDtakoDeviceCredsRaw } from "../src/cron";

const ENTRIES = [
  { tenant_id: "t-1", device_id: "dev-1", device_secret: "sec-1" },
  { tenant_id: "t-2", device_id: "dev-2", device_secret: "sec-2" },
];

describe("parseDtakoDeviceCreds", () => {
  it("未設定は空配列 (履歴を扱わないだけ、取り込みは止めない)", () => {
    expect(parseDtakoDeviceCreds(undefined)).toEqual([]);
    expect(parseDtakoDeviceCreds(null)).toEqual([]);
    expect(parseDtakoDeviceCreds("")).toEqual([]);
  });

  it("配列をそのまま返す", () => {
    expect(parseDtakoDeviceCreds(JSON.stringify(ENTRIES))).toEqual(ENTRIES);
  });

  it("★ JSON 不正は throw する (設定ミスを『未設定』と同じ静かさで扱わない)", () => {
    expect(() => parseDtakoDeviceCreds("{")).toThrow(DtakoDeviceCredsError);
  });

  it("配列でなければ throw する", () => {
    expect(() => parseDtakoDeviceCreds('{"tenant_id":"t-1"}')).toThrow(
      /JSON 配列である必要があります/,
    );
  });
});

describe("credentialForTenant", () => {
  it("tenant で引ける (device JWT は 1 tenant 束縛なので 2 社 = 2 件)", () => {
    expect(credentialForTenant(ENTRIES, "t-2")).toEqual({
      deviceId: "dev-2",
      deviceSecret: "sec-2",
    });
  });

  it("見つからなければ null", () => {
    expect(credentialForTenant(ENTRIES, "t-9")).toBeNull();
    expect(credentialForTenant([], "t-1")).toBeNull();
  });

  it("tenant が空なら null (全社共通の credential は無い)", () => {
    expect(credentialForTenant(ENTRIES, "")).toBeNull();
  });

  it("★ 欠けた行は「無い」扱い — 中途半端な値で mint しに行かない", () => {
    expect(credentialForTenant([{ tenant_id: "t-1", device_id: "", device_secret: "s" }], "t-1")).toBeNull();
    expect(credentialForTenant([{ tenant_id: "t-1", device_id: "d", device_secret: "" }], "t-1")).toBeNull();
    expect(
      credentialForTenant(
        [{ tenant_id: "t-1", device_id: 1, device_secret: "s" } as unknown as (typeof ENTRIES)[0]],
        "t-1",
      ),
    ).toBeNull();
    expect(
      credentialForTenant(
        [{ tenant_id: "t-1", device_id: "d", device_secret: 1 } as unknown as (typeof ENTRIES)[0]],
        "t-1",
      ),
    ).toBeNull();
  });

  it("null / 非オブジェクトの行は読み飛ばす", () => {
    const dirty = [null, "x", ENTRIES[0]!] as unknown as typeof ENTRIES;
    expect(credentialForTenant(dirty, "t-1")).toEqual({ deviceId: "dev-1", deviceSecret: "sec-1" });
  });
});

describe("resolveDtakoDeviceCredsRaw", () => {
  it("★ DTAKO_ACCOUNTS とは別 key を読む (相乗りさせると再投入が要るため)", async () => {
    expect(DTAKO_DEVICE_CREDS_KV_KEY).toBe("dtako_device_creds");
    expect(DTAKO_DEVICE_CREDS_KV_KEY).not.toBe("dtako_accounts");

    const seen: string[] = [];
    const kv = {
      get: async (key: string) => {
        seen.push(key);
        return JSON.stringify(ENTRIES);
      },
    };
    expect(await resolveDtakoDeviceCredsRaw(kv, null)).toBe(JSON.stringify(ENTRIES));
    expect(seen).toEqual(["dtako_device_creds"]);
  });

  it("KV に無ければ binding へ落ちる", async () => {
    const kv = { get: async () => null };
    expect(await resolveDtakoDeviceCredsRaw(kv, "[]")).toBe("[]");
  });
});
