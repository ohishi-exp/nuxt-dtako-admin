import { describe, expect, it } from "vitest";
import {
  decodeDvrUserB64,
  DVR_SESSION_TTL_MS,
  encodeDvrUserB64,
  extractBearerToken,
  generateDvrToken,
  isDvrSessionValid,
  resolveDvrRouting,
  timingSafeEqualStr,
  type DvrSessionRecord,
} from "../src/dvr-session";

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

function record(overrides: Partial<DvrSessionRecord> = {}): DvrSessionRecord {
  return {
    token: "tok-1",
    compId: "27324455",
    userName: "user1",
    cookies: [["sid", "abc"]],
    createdAt: 1_000,
    expiresAt: 1_000 + DVR_SESSION_TTL_MS,
    ...overrides,
  };
}

describe("generateDvrToken", () => {
  it("returns 64 hex chars and differs per call", () => {
    const a = generateDvrToken();
    const b = generateDvrToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("timingSafeEqualStr", () => {
  it("matches equal strings", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
  });
  it("rejects different lengths and different contents", () => {
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
  });
});

describe("encodeDvrUserB64 / decodeDvrUserB64", () => {
  it("round-trips ASCII and Japanese user names", () => {
    for (const name of ["user1", "山田太郎", "a+b/c=d"]) {
      const encoded = encodeDvrUserB64(name);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, padding 無し
      expect(decodeDvrUserB64(encoded)).toBe(name);
    }
  });

  it("accepts padded standard base64 too (decode normalizes)", () => {
    expect(decodeDvrUserB64(btoa("user1"))).toBe("user1");
  });

  it("returns null for invalid base64 / invalid UTF-8", () => {
    expect(decodeDvrUserB64("%%%")).toBeNull();
    // 0xff 単独は UTF-8 として不正 (fatal: true で TypeError → null)
    expect(decodeDvrUserB64(btoa(String.fromCharCode(0xff)))).toBeNull();
  });
});

describe("resolveDvrRouting", () => {
  it("resolves comp/user and builds a normalized DO key", () => {
    const routing = resolveDvrRouting(
      headers({ "X-Dvr-Comp-Id": "27324455", "X-Dvr-User-B64": encodeDvrUserB64("山田太郎") }),
    );
    expect(routing).toEqual({
      compId: "27324455",
      userName: "山田太郎",
      doKey: `dvr-27324455:${encodeDvrUserB64("山田太郎")}`,
    });
  });

  it("normalizes padding variations to the same DO key", () => {
    const padded = btoa("user1"); // "dXNlcjE=" (padding あり)
    const routing = resolveDvrRouting(
      headers({ "X-Dvr-Comp-Id": "1", "X-Dvr-User-B64": padded }),
    );
    expect(routing?.doKey).toBe(`dvr-1:${encodeDvrUserB64("user1")}`);
  });

  it("returns null for missing headers", () => {
    expect(resolveDvrRouting(headers({}))).toBeNull();
    expect(resolveDvrRouting(headers({ "X-Dvr-Comp-Id": "1" }))).toBeNull();
    expect(resolveDvrRouting(headers({ "X-Dvr-User-B64": encodeDvrUserB64("u") }))).toBeNull();
  });

  it("returns null for invalid comp_id charset / length", () => {
    expect(
      resolveDvrRouting(headers({ "X-Dvr-Comp-Id": "a/b", "X-Dvr-User-B64": encodeDvrUserB64("u") })),
    ).toBeNull();
    expect(
      resolveDvrRouting(
        headers({ "X-Dvr-Comp-Id": "a".repeat(33), "X-Dvr-User-B64": encodeDvrUserB64("u") }),
      ),
    ).toBeNull();
  });

  it("returns null for undecodable or empty user names", () => {
    expect(resolveDvrRouting(headers({ "X-Dvr-Comp-Id": "1", "X-Dvr-User-B64": "%%%" }))).toBeNull();
    expect(
      resolveDvrRouting(headers({ "X-Dvr-Comp-Id": "1", "X-Dvr-User-B64": encodeDvrUserB64("") })),
    ).toBeNull();
  });
});

describe("extractBearerToken", () => {
  it("extracts the Bearer token", () => {
    expect(extractBearerToken(headers({ Authorization: "Bearer tok-1" }))).toBe("tok-1");
  });
  it("returns empty for missing / non-Bearer values", () => {
    expect(extractBearerToken(headers({}))).toBe("");
    expect(extractBearerToken(headers({ Authorization: "Basic xxx" }))).toBe("");
  });
});

describe("isDvrSessionValid", () => {
  const routing = { compId: "27324455", userName: "user1" };

  it("accepts a matching, unexpired session", () => {
    expect(isDvrSessionValid(record(), "tok-1", routing, 2_000)).toBe(true);
  });

  it("rejects missing record / empty or wrong token", () => {
    expect(isDvrSessionValid(undefined, "tok-1", routing, 2_000)).toBe(false);
    expect(isDvrSessionValid(null, "tok-1", routing, 2_000)).toBe(false);
    expect(isDvrSessionValid(record(), "", routing, 2_000)).toBe(false);
    expect(isDvrSessionValid(record(), "tok-2", routing, 2_000)).toBe(false);
  });

  it("rejects an expired session", () => {
    expect(isDvrSessionValid(record(), "tok-1", routing, 1_000 + DVR_SESSION_TTL_MS)).toBe(false);
  });

  it("rejects comp/user mismatches", () => {
    expect(isDvrSessionValid(record({ compId: "other" }), "tok-1", routing, 2_000)).toBe(false);
    expect(isDvrSessionValid(record({ userName: "other" }), "tok-1", routing, 2_000)).toBe(false);
  });
});
