import { describe, expect, it } from "vitest";
import { pickOnpremUnkoNoFromDayEvents } from "../src/dtako-day-events-lookup";

const OPE_NO_22 = "2606050753300000004286";
const UNKO_NO_23_A = `${OPE_NO_22}1`;
const UNKO_NO_23_B = `${OPE_NO_22}2`;

function dayEvents(unkoNos: string[]): unknown {
  return {
    driver_cd: 1078,
    date: "2026-06-05",
    operations: unkoNos.map((unko_no) => ({ unko_no, run_start: null, vehicle: null, links: {}, zip_request: null })),
    events: [],
  };
}

describe("pickOnpremUnkoNoFromDayEvents", () => {
  it("opeNo22 が22桁でなければ常に not_found (曖昧な入力で決め打ちしない)", () => {
    expect(pickOnpremUnkoNoFromDayEvents(dayEvents([UNKO_NO_23_A]), UNKO_NO_23_A)).toEqual({
      status: "not_found",
      unkoNo: null,
      candidates: [],
    });
    expect(pickOnpremUnkoNoFromDayEvents(dayEvents([UNKO_NO_23_A]), "123")).toEqual({
      status: "not_found",
      unkoNo: null,
      candidates: [],
    });
  });

  it("operations が空なら not_found", () => {
    expect(pickOnpremUnkoNoFromDayEvents(dayEvents([]), OPE_NO_22)).toEqual({
      status: "not_found",
      unkoNo: null,
      candidates: [],
    });
  });

  it("prefixが一致しない運行しか無ければ not_found (前日から続く休息等を混同しない)", () => {
    const otherPrefix = "26061112000000000099991";
    expect(pickOnpremUnkoNoFromDayEvents(dayEvents([otherPrefix]), OPE_NO_22)).toEqual({
      status: "not_found",
      unkoNo: null,
      candidates: [],
    });
  });

  it("prefixに一致する23桁が1件だけなら found", () => {
    const otherPrefix = "26061112000000000099991";
    expect(pickOnpremUnkoNoFromDayEvents(dayEvents([otherPrefix, UNKO_NO_23_A]), OPE_NO_22)).toEqual({
      status: "found",
      unkoNo: UNKO_NO_23_A,
      candidates: [UNKO_NO_23_A],
    });
  });

  it("prefixに一致する23桁が複数 (2マン等) なら ambiguous — 黙って1件目を選ばない", () => {
    expect(pickOnpremUnkoNoFromDayEvents(dayEvents([UNKO_NO_23_A, UNKO_NO_23_B]), OPE_NO_22)).toEqual({
      status: "ambiguous",
      unkoNo: null,
      candidates: [UNKO_NO_23_A, UNKO_NO_23_B],
    });
  });

  it("同じ23桁が複数回出ても重複除去してfoundにする", () => {
    expect(pickOnpremUnkoNoFromDayEvents(dayEvents([UNKO_NO_23_A, UNKO_NO_23_A]), OPE_NO_22)).toEqual({
      status: "found",
      unkoNo: UNKO_NO_23_A,
      candidates: [UNKO_NO_23_A],
    });
  });

  it("raw が壊れた形 (null/非object/operations欠落/非配列要素/非23桁unko_no) でも例外を投げず not_found に倒す", () => {
    expect(pickOnpremUnkoNoFromDayEvents(null, OPE_NO_22)).toEqual({
      status: "not_found",
      unkoNo: null,
      candidates: [],
    });
    expect(pickOnpremUnkoNoFromDayEvents("garbage", OPE_NO_22)).toEqual({
      status: "not_found",
      unkoNo: null,
      candidates: [],
    });
    expect(pickOnpremUnkoNoFromDayEvents({}, OPE_NO_22)).toEqual({
      status: "not_found",
      unkoNo: null,
      candidates: [],
    });
    expect(pickOnpremUnkoNoFromDayEvents({ operations: [null, "x", { unko_no: 123 }, { unko_no: "22桁" }] }, OPE_NO_22)).toEqual({
      status: "not_found",
      unkoNo: null,
      candidates: [],
    });
  });
});
