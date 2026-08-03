import { describe, expect, it } from "vitest";
import { pickDayOperationsList } from "../src/dtako-day-operations-list";

const OPE_NO_22 = "2606050753300000004286";
const UNKO_NO_23 = `${OPE_NO_22}1`;
const START_OPE = "2026/06/05 7:53:30";

function op(overrides: Record<string, unknown> = {}): unknown {
  return {
    unko_no: UNKO_NO_23,
    run_start: "2026-06-05 07:53:30",
    vehicle: "長崎100か1234",
    links: {},
    zip_request: { ope_no: OPE_NO_22, start_ope: START_OPE },
    ...overrides,
  };
}

function dayEvents(operations: unknown[]): unknown {
  return { driver_cd: 1078, date: "2026-06-05", operations, events: [] };
}

describe("pickDayOperationsList", () => {
  it("zip_request の ope_no/start_ope をそのまま (加工せず) 返す", () => {
    expect(pickDayOperationsList(dayEvents([op()]))).toEqual([
      {
        unko_no: UNKO_NO_23,
        ope_no: OPE_NO_22,
        start_ope: START_OPE,
        run_start: "2026-06-05 07:53:30",
        vehicle: "長崎100か1234",
      },
    ]);
  });

  it("operations が空なら空配列 (0件でも安全)", () => {
    expect(pickDayOperationsList(dayEvents([]))).toEqual([]);
  });

  it("複数運行を並べて返す (自動で1件を選ばない)", () => {
    const opeNoB = "2606050900000000004287";
    const unkoNoB = `${opeNoB}2`;
    const opB = op({ unko_no: unkoNoB, zip_request: { ope_no: opeNoB, start_ope: "2026/06/05 9:00:00" } });
    const result = pickDayOperationsList(dayEvents([op(), opB]));
    expect(result.map((r) => r.unko_no)).toEqual([UNKO_NO_23, unkoNoB]);
  });

  it("run_start/vehicle が無い (null) 運行でも ope_no/start_ope があれば通す", () => {
    expect(pickDayOperationsList(dayEvents([op({ run_start: null, vehicle: null })]))).toEqual([
      { unko_no: UNKO_NO_23, ope_no: OPE_NO_22, start_ope: START_OPE, run_start: null, vehicle: null },
    ]);
  });

  it("zip_request が無い運行は alc へ上げ直せないので落とす (捏造しない)", () => {
    expect(pickDayOperationsList(dayEvents([op({ zip_request: null })]))).toEqual([]);
    expect(pickDayOperationsList(dayEvents([op({ zip_request: undefined })]))).toEqual([]);
  });

  it("zip_request.ope_no が22桁でない・start_ope が空文字/非文字列なら落とす", () => {
    expect(pickDayOperationsList(dayEvents([op({ zip_request: { ope_no: "123", start_ope: START_OPE } })]))).toEqual(
      [],
    );
    expect(
      pickDayOperationsList(dayEvents([op({ zip_request: { ope_no: OPE_NO_22, start_ope: "" } })])),
    ).toEqual([]);
    expect(
      pickDayOperationsList(dayEvents([op({ zip_request: { ope_no: OPE_NO_22, start_ope: 123 } })])),
    ).toEqual([]);
  });

  it("unko_no が23桁でない・重複していれば落とす/畳む", () => {
    expect(pickDayOperationsList(dayEvents([op({ unko_no: "123" })]))).toEqual([]);
    expect(pickDayOperationsList(dayEvents([op(), op()]))).toHaveLength(1);
  });

  it("raw が壊れた形 (null/非object/operations欠落/非配列要素) でも例外を投げず空配列に倒す", () => {
    expect(pickDayOperationsList(null)).toEqual([]);
    expect(pickDayOperationsList("garbage")).toEqual([]);
    expect(pickDayOperationsList({})).toEqual([]);
    expect(pickDayOperationsList({ operations: [null, "x", 123] })).toEqual([]);
  });
});
