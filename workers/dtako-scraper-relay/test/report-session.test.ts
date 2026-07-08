import { describe, expect, it } from "vitest";
import { encodeDvrUserB64 } from "../src/dvr-session";
import {
  isReportSessionValid,
  REPORT_SESSION_TTL_MS,
  resolveReportRouting,
  type ReportSessionRecord,
} from "../src/report-session";

function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

function record(overrides: Partial<ReportSessionRecord> = {}): ReportSessionRecord {
  return {
    token: "tok-1",
    compId: "27324455",
    userName: "user1",
    cookies: [["sid", "abc"]],
    createdAt: 1_000,
    expiresAt: 1_000 + REPORT_SESSION_TTL_MS,
    ...overrides,
  };
}

describe("resolveReportRouting", () => {
  it("resolves comp/user and builds a normalized DO key with the report- prefix", () => {
    const routing = resolveReportRouting(
      headers({ "X-Report-Comp-Id": "27324455", "X-Report-User-B64": encodeDvrUserB64("山田太郎") }),
    );
    expect(routing).toEqual({
      compId: "27324455",
      userName: "山田太郎",
      doKey: `report-27324455:${encodeDvrUserB64("山田太郎")}`,
    });
  });

  it("normalizes padding variations to the same DO key", () => {
    const padded = btoa("user1");
    const routing = resolveReportRouting(headers({ "X-Report-Comp-Id": "1", "X-Report-User-B64": padded }));
    expect(routing?.doKey).toBe(`report-1:${encodeDvrUserB64("user1")}`);
  });

  it("returns null for missing headers", () => {
    expect(resolveReportRouting(headers({}))).toBeNull();
    expect(resolveReportRouting(headers({ "X-Report-Comp-Id": "1" }))).toBeNull();
    expect(resolveReportRouting(headers({ "X-Report-User-B64": encodeDvrUserB64("u") }))).toBeNull();
  });

  it("returns null for invalid comp_id charset / length", () => {
    expect(
      resolveReportRouting(headers({ "X-Report-Comp-Id": "a/b", "X-Report-User-B64": encodeDvrUserB64("u") })),
    ).toBeNull();
    expect(
      resolveReportRouting(
        headers({ "X-Report-Comp-Id": "a".repeat(33), "X-Report-User-B64": encodeDvrUserB64("u") }),
      ),
    ).toBeNull();
  });

  it("returns null for undecodable or empty user names", () => {
    expect(resolveReportRouting(headers({ "X-Report-Comp-Id": "1", "X-Report-User-B64": "%%%" }))).toBeNull();
    expect(
      resolveReportRouting(headers({ "X-Report-Comp-Id": "1", "X-Report-User-B64": encodeDvrUserB64("") })),
    ).toBeNull();
  });
});

describe("isReportSessionValid", () => {
  const routing = { compId: "27324455", userName: "user1" };

  it("accepts a matching, unexpired session", () => {
    expect(isReportSessionValid(record(), "tok-1", routing, 2_000)).toBe(true);
  });

  it("rejects missing record / empty or wrong token", () => {
    expect(isReportSessionValid(undefined, "tok-1", routing, 2_000)).toBe(false);
    expect(isReportSessionValid(null, "tok-1", routing, 2_000)).toBe(false);
    expect(isReportSessionValid(record(), "", routing, 2_000)).toBe(false);
    expect(isReportSessionValid(record(), "tok-2", routing, 2_000)).toBe(false);
  });

  it("rejects an expired session", () => {
    expect(isReportSessionValid(record(), "tok-1", routing, 1_000 + REPORT_SESSION_TTL_MS)).toBe(false);
  });

  it("rejects comp/user mismatches", () => {
    expect(isReportSessionValid(record({ compId: "other" }), "tok-1", routing, 2_000)).toBe(false);
    expect(isReportSessionValid(record({ userName: "other" }), "tok-1", routing, 2_000)).toBe(false);
  });
});
