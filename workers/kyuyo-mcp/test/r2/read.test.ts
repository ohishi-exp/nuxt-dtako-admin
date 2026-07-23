import { describe, it, expect } from "vitest";
import { getJson, listAllR2, listDelimitedPrefixes } from "../../src/r2/read";
import { createMockR2 } from "../helpers/mock-r2";

describe("getJson", () => {
  it("returns parsed JSON for an existing key", async () => {
    const bucket = createMockR2({ "a/b.json": { value: JSON.stringify({ x: 1 }) } });
    expect(await getJson<{ x: number }>(bucket, "a/b.json")).toEqual({ x: 1 });
  });

  it("returns null when the key does not exist", async () => {
    const bucket = createMockR2({});
    expect(await getJson(bucket, "missing.json")).toBeNull();
  });

  it("returns null when the value is not valid JSON", async () => {
    const bucket = createMockR2({ "bad.json": { value: "{not json" } });
    expect(await getJson(bucket, "bad.json")).toBeNull();
  });
});

describe("listAllR2 — cursor pagination", () => {
  it("follows truncated:true → cursor across multiple pages", async () => {
    const calls: Array<R2ListOptions | undefined> = [];
    const bucket = {
      list: async (opts?: R2ListOptions) => {
        calls.push(opts);
        if (!opts?.cursor) {
          return {
            objects: [{ key: "a/1.json", customMetadata: {} }],
            truncated: true,
            cursor: "page-2",
            delimitedPrefixes: [],
          } as unknown as R2Objects;
        }
        return {
          objects: [{ key: "a/2.json", customMetadata: {} }],
          truncated: false,
          delimitedPrefixes: [],
        } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;

    const objs = await listAllR2(bucket, "a/");
    expect(objs.map((o) => o.key)).toEqual(["a/1.json", "a/2.json"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cursor).toBe("page-2");
  });
});

describe("listAllR2", () => {
  it("returns all objects under a prefix, ignoring keys outside it", async () => {
    const bucket = createMockR2({
      "restraint/0100/2026-07/summary/1/latest.json": { value: "{}" },
      "restraint/0100/2026-07/summary/2/latest.json": { value: "{}" },
      "restraint/0200/2026-07/summary/1/latest.json": { value: "{}" },
    });
    const objs = await listAllR2(bucket, "restraint/0100/2026-07/summary/");
    expect(objs.map((o) => o.key).sort()).toEqual([
      "restraint/0100/2026-07/summary/1/latest.json",
      "restraint/0100/2026-07/summary/2/latest.json",
    ]);
  });

  it("returns an empty array when nothing matches", async () => {
    const bucket = createMockR2({});
    expect(await listAllR2(bucket, "nothing/here/")).toEqual([]);
  });

  it("carries customMetadata through", async () => {
    const bucket = createMockR2({
      "a/latest.json": { value: "{}", customMetadata: { fetchedAt: "2026-07-01T00:00:00Z" } },
    });
    const objs = await listAllR2(bucket, "a/");
    expect(objs[0]!.customMetadata).toEqual({ fetchedAt: "2026-07-01T00:00:00Z" });
  });
});

describe("listDelimitedPrefixes — cursor pagination", () => {
  it("follows truncated:true → cursor across multiple pages", async () => {
    const calls: Array<R2ListOptions | undefined> = [];
    const bucket = {
      list: async (opts?: R2ListOptions) => {
        calls.push(opts);
        if (!opts?.cursor) {
          return { objects: [], truncated: true, cursor: "page-2", delimitedPrefixes: ["a/2026-06/"] } as unknown as R2Objects;
        }
        return { objects: [], truncated: false, delimitedPrefixes: ["a/2026-07/"] } as unknown as R2Objects;
      },
    } as unknown as R2Bucket;

    const prefixes = await listDelimitedPrefixes(bucket, "a/");
    expect(prefixes).toEqual(["a/2026-06/", "a/2026-07/"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.cursor).toBe("page-2");
  });
});

describe("listDelimitedPrefixes", () => {
  it("returns direct child directory names under a prefix", async () => {
    const bucket = createMockR2({
      "restraint/0100/2026-06/summary/1/latest.json": { value: "{}" },
      "restraint/0100/2026-07/summary/1/latest.json": { value: "{}" },
      "restraint/0200/2026-07/summary/1/latest.json": { value: "{}" },
    });
    const prefixes = await listDelimitedPrefixes(bucket, "restraint/0100/");
    expect(prefixes.sort()).toEqual(["restraint/0100/2026-06/", "restraint/0100/2026-07/"]);
  });

  it("returns an empty array when nothing matches", async () => {
    const bucket = createMockR2({});
    expect(await listDelimitedPrefixes(bucket, "nothing/")).toEqual([]);
  });
});
