import { describe, expect, it } from "vitest";
import { chunkIds, countMakecsvResults, ichibanCheckIds, MAKECSV_CHUNK } from "../src/ichiban-makecsv";
// 画面側 (tests/utils/ichiban-check-shared.test.ts) と同じ fixture。片側だけ規則が動いたら落ちる
import fixture from "../../../tests/fixtures/ichiban-check/makecsv-ids.json";

describe("ichibanCheckIds (画面と共有の fixture)", () => {
  it("画面と同じ行数・同じ id の並び", () => {
    expect(ichibanCheckIds(fixture.response)).toEqual({ rows: fixture.rows, ids: fixture.ids });
  });

  it("形が違う応答は 0 行", () => {
    expect(ichibanCheckIds(null)).toEqual({ rows: 0, ids: [] });
    expect(ichibanCheckIds({ diffs: [], ids: "x" })).toEqual({ rows: 0, ids: [] });
    // 乗務員の段が record でなければその乗務員は行にしない (画面の asNested と同じ)
    expect(ichibanCheckIds({ diffs: { 燃料: { "9001": "x" } }, ids: { 燃料: { "9001": { x: ["a"] } } } })).toEqual({ rows: 0, ids: [] });
  });
});

describe("chunkIds", () => {
  it("500 件ずつ", () => {
    expect(MAKECSV_CHUNK).toBe(500);
    const ids = Array.from({ length: 1001 }, (_, i) => String(i));
    expect(chunkIds(ids).map((c) => c.length)).toEqual([500, 500, 1]);
    expect(chunkIds([])).toEqual([]);
  });
});

describe("countMakecsvResults", () => {
  it("status ごとに数え、形が違う要素は数えない", () => {
    const body = {
      results: [
        { id: "a", status: "written" },
        { id: "b", status: "skipped" },
        { id: "c", status: "error" },
        { id: "d", status: "unknown" },
        { status: "written" },
        "x",
      ],
    };
    expect(countMakecsvResults(body, { written: 1, skipped: 0, error: 0 })).toEqual({ written: 2, skipped: 1, error: 1 });
    expect(countMakecsvResults({}, { written: 0, skipped: 0, error: 0 })).toEqual({ written: 0, skipped: 0, error: 0 });
  });
});
