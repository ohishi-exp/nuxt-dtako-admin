import { describe, it, expect } from "vitest";
import { redactDriverNames } from "../src/redact";

describe("redactDriverNames", () => {
  it("removes a top-level driverName field, keeps driverCd", () => {
    const input = { driverCd: "1234", driverName: "山田太郎", amount: 1000 };
    expect(redactDriverNames(input)).toEqual({ driverCd: "1234", amount: 1000 });
  });

  it("removes driverName in nested objects", () => {
    const input = { wage: { driverCd: "1234", driverName: "山田太郎", total: 5000 } };
    expect(redactDriverNames(input)).toEqual({ wage: { driverCd: "1234", total: 5000 } });
  });

  it("removes driverName inside array elements", () => {
    const input = {
      rows: [
        { driverCd: "1", driverName: "A" },
        { driverCd: "2", driverName: "B" },
      ],
    };
    expect(redactDriverNames(input)).toEqual({
      rows: [{ driverCd: "1" }, { driverCd: "2" }],
    });
  });

  it("handles deeply nested arrays-of-objects-with-arrays", () => {
    const input = {
      rows: [
        {
          driverCd: "1",
          driverName: "A",
          days: [{ date: "2026-07-01", driverName: "A" }],
        },
      ],
    };
    expect(redactDriverNames(input)).toEqual({
      rows: [{ driverCd: "1", days: [{ date: "2026-07-01" }] }],
    });
  });

  it("passes through primitives unchanged", () => {
    expect(redactDriverNames(42)).toBe(42);
    expect(redactDriverNames("hello")).toBe("hello");
    expect(redactDriverNames(true)).toBe(true);
    expect(redactDriverNames(null)).toBe(null);
    expect(redactDriverNames(undefined)).toBe(undefined);
  });

  it("passes through an empty object/array unchanged", () => {
    expect(redactDriverNames({})).toEqual({});
    expect(redactDriverNames([])).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = { driverCd: "1", driverName: "A" };
    redactDriverNames(input);
    expect(input).toEqual({ driverCd: "1", driverName: "A" });
  });

  it("preserves array order and non-object array elements", () => {
    const input = [1, "two", { driverName: "A", driverCd: "3" }, null];
    expect(redactDriverNames(input)).toEqual([1, "two", { driverCd: "3" }, null]);
  });
});
