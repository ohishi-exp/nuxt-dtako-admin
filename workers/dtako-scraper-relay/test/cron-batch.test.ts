import { describe, expect, it } from "vitest";
import {
  BatchTooLargeError,
  CRON_BATCH_MAX_ITEMS,
  assertBatchSizeWithinLimit,
  runBatchSequential,
  parseOperationZipRequest,
  parseDtakoReimportRequest,
  parseDtakoAlcUploadRequest,
} from "../src/cron-batch";
import { VenusSessionExpiredError } from "../src/theearth-venus-client";
import { TheearthClientError } from "../src/theearth-client";

const OPE_A = "2231234567890123456781";
const START_A = "2026/07/07 10:00:00";
const OPE_B = "2231234567890123456782";
const START_B = "2026/07/08 11:00:00";
const OPE_C = "2231234567890123456783";
const START_C = "2026/07/09 12:00:00";

describe("assertBatchSizeWithinLimit", () => {
  it("does not throw when at or under the limit", () => {
    expect(() => assertBatchSizeWithinLimit(CRON_BATCH_MAX_ITEMS)).not.toThrow();
    expect(() => assertBatchSizeWithinLimit(1)).not.toThrow();
    expect(() => assertBatchSizeWithinLimit(0)).not.toThrow();
  });

  it("throws BatchTooLargeError with limit/received when over the limit (does not truncate)", () => {
    expect(() => assertBatchSizeWithinLimit(CRON_BATCH_MAX_ITEMS + 1)).toThrow(BatchTooLargeError);
    try {
      assertBatchSizeWithinLimit(21);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BatchTooLargeError);
      const e = err as BatchTooLargeError;
      expect(e.limit).toBe(CRON_BATCH_MAX_ITEMS);
      expect(e.received).toBe(21);
      expect(e.message).toContain("21");
      expect(e.message).toContain(String(CRON_BATCH_MAX_ITEMS));
    }
  });

  it("supports a custom limit override", () => {
    expect(() => assertBatchSizeWithinLimit(5, 5)).not.toThrow();
    expect(() => assertBatchSizeWithinLimit(6, 5)).toThrow(BatchTooLargeError);
  });
});

describe("runBatchSequential", () => {
  it("processes all items successfully in order", async () => {
    const calls: string[] = [];
    const result = await runBatchSequential(["a", "b", "c"], async (item, index) => {
      calls.push(`${item}:${index}`);
      return `result-${item}`;
    });
    expect(calls).toEqual(["a:0", "b:1", "c:2"]);
    expect(result).toEqual({
      results: [
        { ok: true, result: "result-a" },
        { ok: true, result: "result-b" },
        { ok: true, result: "result-c" },
      ],
      truncated: false,
      remaining: 0,
    });
  });

  it("continues past a single item failure and records the reason (Refs #633)", async () => {
    const result = await runBatchSequential([OPE_A, OPE_B, OPE_C], async (item) => {
      if (item === OPE_B) throw new TheearthClientError(`failed for ${item}`);
      return `ok-${item}`;
    });
    expect(result.truncated).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.results).toEqual([
      { ok: true, result: `ok-${OPE_A}` },
      { ok: false, error: `failed for ${OPE_B}` },
      { ok: true, result: `ok-${OPE_C}` },
    ]);
  });

  it("stops on VenusSessionExpiredError, records it, and reports the remaining count (Refs #633)", async () => {
    const attempted: string[] = [];
    const result = await runBatchSequential([OPE_A, OPE_B, OPE_C], async (item) => {
      attempted.push(item);
      if (item === OPE_B) throw new VenusSessionExpiredError("session expired mid-batch");
      return `ok-${item}`;
    });
    // C は一切試行されない (打ち切り)
    expect(attempted).toEqual([OPE_A, OPE_B]);
    expect(result.truncated).toBe(true);
    expect(result.remaining).toBe(1);
    expect(result.results).toEqual([
      { ok: true, result: `ok-${OPE_A}` },
      { ok: false, error: "session expired mid-batch" },
    ]);
    // 不変条件: results.length + remaining === items.length
    expect(result.results.length + result.remaining).toBe(3);
  });

  it("does not retry after a session expiry — it is a single cutoff, not a loop", async () => {
    let callCount = 0;
    const result = await runBatchSequential([OPE_A], async () => {
      callCount += 1;
      throw new VenusSessionExpiredError("expired");
    });
    expect(callCount).toBe(1);
    expect(result.truncated).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("handles a non-Error throw by stringifying it", async () => {
    const result = await runBatchSequential(["x"], async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "plain string failure";
    });
    expect(result.results).toEqual([{ ok: false, error: "plain string failure" }]);
  });

  it("returns an empty result for an empty items array", async () => {
    const result = await runBatchSequential([], async () => "unused");
    expect(result).toEqual({ results: [], truncated: false, remaining: 0 });
  });
});

describe("parseOperationZipRequest", () => {
  it("parses a single-item body exactly as the pre-batch shape (regression, Refs #633)", () => {
    const parsed = parseOperationZipRequest({
      comp_id: "75700192",
      ope_no: OPE_A,
      start_ope: START_A,
      recalculate: true,
    });
    expect(parsed).toEqual({
      compId: "75700192",
      items: [{ opeNo: OPE_A, startOpe: START_A, recalculate: true }],
      isBatch: false,
    });
  });

  it("defaults recalculate to false when omitted (single-item, matches pre-batch default)", () => {
    const parsed = parseOperationZipRequest({ comp_id: "1", ope_no: OPE_A, start_ope: START_A });
    expect(parsed).toEqual({
      compId: "1",
      items: [{ opeNo: OPE_A, startOpe: START_A, recalculate: false }],
      isBatch: false,
    });
  });

  it("rejects a single-item body missing required fields with the original message (regression)", () => {
    expect(parseOperationZipRequest({ comp_id: "1", start_ope: START_A })).toEqual({
      error: "comp_id / ope_no / start_ope が必要です",
    });
    expect(parseOperationZipRequest({ ope_no: OPE_A, start_ope: START_A })).toEqual({
      error: "comp_id / ope_no / start_ope が必要です",
    });
  });

  it("parses a batch body into normalized items", () => {
    const parsed = parseOperationZipRequest({
      comp_id: "75700192",
      items: [
        { ope_no: OPE_A, start_ope: START_A },
        { ope_no: OPE_B, start_ope: START_B, recalculate: true },
      ],
    });
    expect(parsed).toEqual({
      compId: "75700192",
      items: [
        { opeNo: OPE_A, startOpe: START_A, recalculate: false },
        { opeNo: OPE_B, startOpe: START_B, recalculate: true },
      ],
      isBatch: true,
    });
  });

  it("rejects a batch body missing comp_id", () => {
    expect(parseOperationZipRequest({ items: [{ ope_no: OPE_A, start_ope: START_A }] })).toEqual({
      error: "comp_id / items が必要です",
    });
  });

  it("rejects a batch item missing ope_no/start_ope, naming the index", () => {
    expect(
      parseOperationZipRequest({
        comp_id: "1",
        items: [{ ope_no: OPE_A, start_ope: START_A }, { ope_no: OPE_B }],
      }),
    ).toEqual({ error: "items[1]: ope_no / start_ope が必要です" });
  });

  it("treats a non-array items and a missing/malformed item entry defensively", () => {
    expect(parseOperationZipRequest({ comp_id: "1", ope_no: OPE_A, start_ope: START_A, items: "not-an-array" })).toEqual({
      compId: "1",
      items: [{ opeNo: OPE_A, startOpe: START_A, recalculate: false }],
      isBatch: false,
    });
    expect(parseOperationZipRequest({ comp_id: "1", items: [null] })).toEqual({
      error: "items[0]: ope_no / start_ope が必要です",
    });
  });
});

describe("parseDtakoReimportRequest", () => {
  const baseSingle = { comp_id: "1", ope_no: OPE_A, start_ope: START_A, unko_no: "12345678901234567890123" };

  it("parses a single-item body exactly as the pre-batch shape (regression)", () => {
    expect(parseDtakoReimportRequest(baseSingle)).toEqual({
      compId: "1",
      items: [{ opeNo: OPE_A, startOpe: START_A, unkoNo: baseSingle.unko_no, resetTimecard: false }],
      isBatch: false,
    });
  });

  it("carries reset_timecard through for the single-item body", () => {
    expect(parseDtakoReimportRequest({ ...baseSingle, reset_timecard: true })).toEqual({
      compId: "1",
      items: [{ opeNo: OPE_A, startOpe: START_A, unkoNo: baseSingle.unko_no, resetTimecard: true }],
      isBatch: false,
    });
  });

  it("rejects a single-item body missing unko_no with the original message (regression)", () => {
    const { unko_no: _unused, ...withoutUnkoNo } = baseSingle;
    expect(parseDtakoReimportRequest(withoutUnkoNo)).toEqual({
      error: "comp_id / ope_no / start_ope / unko_no が必要です",
    });
  });

  it("requires unko_no per batch item (cannot be omitted even though items are batched)", () => {
    expect(
      parseDtakoReimportRequest({
        comp_id: "1",
        items: [{ ope_no: OPE_A, start_ope: START_A, unko_no: "12345678901234567890123" }, { ope_no: OPE_B, start_ope: START_B }],
      }),
    ).toEqual({ error: "items[1]: ope_no / start_ope / unko_no が必要です" });
  });

  it("parses a batch body into normalized items with per-item reset_timecard", () => {
    expect(
      parseDtakoReimportRequest({
        comp_id: "1",
        items: [
          { ope_no: OPE_A, start_ope: START_A, unko_no: "111", reset_timecard: true },
          { ope_no: OPE_B, start_ope: START_B, unko_no: "222" },
        ],
      }),
    ).toEqual({
      compId: "1",
      items: [
        { opeNo: OPE_A, startOpe: START_A, unkoNo: "111", resetTimecard: true },
        { opeNo: OPE_B, startOpe: START_B, unkoNo: "222", resetTimecard: false },
      ],
      isBatch: true,
    });
  });

  it("rejects a batch body missing comp_id", () => {
    expect(parseDtakoReimportRequest({ items: [{ ope_no: OPE_A, start_ope: START_A, unko_no: "1" }] })).toEqual({
      error: "comp_id / items が必要です",
    });
  });
});

describe("parseDtakoAlcUploadRequest", () => {
  it("parses a single-item body exactly as the pre-batch shape (regression, no unko_no field at all)", () => {
    expect(parseDtakoAlcUploadRequest({ comp_id: "1", ope_no: OPE_A, start_ope: START_A })).toEqual({
      compId: "1",
      items: [{ opeNo: OPE_A, startOpe: START_A }],
      isBatch: false,
    });
  });

  it("rejects a single-item body missing required fields with the original message (regression)", () => {
    expect(parseDtakoAlcUploadRequest({ comp_id: "1", start_ope: START_A })).toEqual({
      error: "comp_id / ope_no / start_ope が必要です",
    });
  });

  it("parses a batch body into normalized items (no unko_no field)", () => {
    expect(
      parseDtakoAlcUploadRequest({
        comp_id: "1",
        items: [
          { ope_no: OPE_A, start_ope: START_A },
          { ope_no: OPE_B, start_ope: START_B },
        ],
      }),
    ).toEqual({
      compId: "1",
      items: [
        { opeNo: OPE_A, startOpe: START_A },
        { opeNo: OPE_B, startOpe: START_B },
      ],
      isBatch: true,
    });
  });

  it("rejects a batch body missing comp_id", () => {
    expect(parseDtakoAlcUploadRequest({ items: [{ ope_no: OPE_A, start_ope: START_A }] })).toEqual({
      error: "comp_id / items が必要です",
    });
  });

  it("rejects a batch item missing ope_no/start_ope, naming the index", () => {
    expect(
      parseDtakoAlcUploadRequest({ comp_id: "1", items: [{ ope_no: OPE_A, start_ope: START_A }, {}] }),
    ).toEqual({ error: "items[1]: ope_no / start_ope が必要です" });
  });
});
