import { describe, expect, it } from "vitest";
import {
  createTheearthSession,
  decodeUserB64,
  encodeUserB64,
  extractBearerToken,
  generateSessionToken,
  timingSafeEqualStr,
  type TheearthSessionRecord,
} from "../src/theearth-session";

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function record(overrides: Partial<TheearthSessionRecord> = {}): TheearthSessionRecord {
  return {
    token: "tok-1",
    compId: "27324455",
    userName: "user1",
    cookies: [["sid", "abc"]],
    createdAt: 1_000,
    expiresAt: 1_000 + SESSION_TTL_MS,
    ...overrides,
  };
}

describe("generateSessionToken", () => {
  it("returns 64 hex chars and differs per call", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
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

describe("encodeUserB64 / decodeUserB64", () => {
  it("round-trips ASCII and Japanese user names", () => {
    for (const name of ["user1", "山田太郎", "a+b/c=d"]) {
      const encoded = encodeUserB64(name);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, padding 無し
      expect(decodeUserB64(encoded)).toBe(name);
    }
  });

  it("accepts padded standard base64 too (decode normalizes)", () => {
    expect(decodeUserB64(btoa("user1"))).toBe("user1");
  });

  it("returns null for invalid base64 / invalid UTF-8", () => {
    expect(decodeUserB64("%%%")).toBeNull();
    // 0xff 単独は UTF-8 として不正 (fatal: true で TypeError → null)
    expect(decodeUserB64(btoa(String.fromCharCode(0xff)))).toBeNull();
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

describe("createTheearthSession", () => {
  const session = createTheearthSession("x-test", "test");
  const routing = { compId: "27324455", userName: "user1" };

  describe("resolveRouting", () => {
    it("resolves comp/user and builds a normalized DO key using the given prefixes", () => {
      const result = session.resolveRouting(
        headers({ "X-Test-Comp-Id": "27324455", "X-Test-User-B64": encodeUserB64("山田太郎") }),
      );
      expect(result).toEqual({
        compId: "27324455",
        userName: "山田太郎",
        doKey: `test-27324455:${encodeUserB64("山田太郎")}`,
      });
    });

    it("normalizes padding variations to the same DO key", () => {
      const padded = btoa("user1");
      const result = session.resolveRouting(headers({ "X-Test-Comp-Id": "1", "X-Test-User-B64": padded }));
      expect(result?.doKey).toBe(`test-1:${encodeUserB64("user1")}`);
    });

    it("returns null for missing headers", () => {
      expect(session.resolveRouting(headers({}))).toBeNull();
      expect(session.resolveRouting(headers({ "X-Test-Comp-Id": "1" }))).toBeNull();
      expect(session.resolveRouting(headers({ "X-Test-User-B64": encodeUserB64("u") }))).toBeNull();
    });

    it("returns null for invalid comp_id charset / length", () => {
      expect(
        session.resolveRouting(headers({ "X-Test-Comp-Id": "a/b", "X-Test-User-B64": encodeUserB64("u") })),
      ).toBeNull();
      expect(
        session.resolveRouting(
          headers({ "X-Test-Comp-Id": "a".repeat(33), "X-Test-User-B64": encodeUserB64("u") }),
        ),
      ).toBeNull();
    });

    it("returns null for undecodable or empty user names", () => {
      expect(session.resolveRouting(headers({ "X-Test-Comp-Id": "1", "X-Test-User-B64": "%%%" }))).toBeNull();
      expect(
        session.resolveRouting(headers({ "X-Test-Comp-Id": "1", "X-Test-User-B64": encodeUserB64("") })),
      ).toBeNull();
    });
  });

  describe("isSessionValid", () => {
    it("accepts a matching, unexpired session", () => {
      expect(session.isSessionValid(record(), "tok-1", routing, 2_000)).toBe(true);
    });

    it("rejects missing record / empty or wrong token", () => {
      expect(session.isSessionValid(undefined, "tok-1", routing, 2_000)).toBe(false);
      expect(session.isSessionValid(null, "tok-1", routing, 2_000)).toBe(false);
      expect(session.isSessionValid(record(), "", routing, 2_000)).toBe(false);
      expect(session.isSessionValid(record(), "tok-2", routing, 2_000)).toBe(false);
    });

    it("rejects an expired session", () => {
      expect(session.isSessionValid(record(), "tok-1", routing, 1_000 + SESSION_TTL_MS)).toBe(false);
    });

    it("rejects comp/user mismatches", () => {
      expect(session.isSessionValid(record({ compId: "other" }), "tok-1", routing, 2_000)).toBe(false);
      expect(session.isSessionValid(record({ userName: "other" }), "tok-1", routing, 2_000)).toBe(false);
    });
  });
});
