/**
 * `src/driver0-alert.ts` のテスト (Refs ippoan/alc-app#676)。
 * KUDGURI の見出しは alc の取り込み (alc-csv-parser の kudguri.rs) と同じ並び。値は架空。
 */

import { describe, it, expect } from "vitest";
import {
  Driver0CsvShapeError,
  driver0MailLines,
  findDriver0Runs,
  formatKudguriDateTime,
} from "../src/driver0-alert";

const HEADER =
  "運行NO,読取日,事業所CD,事業所名,車輌CD,車輌名,乗務員CD1,対象乗務員CD,対象乗務員名,対象乗務員区分,出庫日時,帰庫日時,総走行距離";

function row(unko: string, driverCd: string, km: string, out = "2026/11/27 8:05:42", inn = "2026/11/27 18:30:00"): string {
  return `${unko},2026/11/27,1,本社,1001,テスト1号,${driverCd},${driverCd},,1,${out},${inn},${km}`;
}

describe("findDriver0Runs", () => {
  it("対象乗務員CD=0 で 10km 以上だけを運行NO で 1 つにする (BOM・CRLF・空行も読む)", () => {
    const csv =
      "﻿" +
      [
        HEADER,
        row("A", "0", "23.9"),
        row("A", "0", "23.9"), // 2 マン運行の 2 行目
        row("B", "0", "9.9"),
        row("C", "0", "10", "", ""),
        row("D", "1234", "300"),
        row("E", "0", ""),
        "F,2026/11/27,1,本社,1001,テスト1号,0,0", // 距離の列まで届かない短い行
        "",
      ].join("\r\n");
    expect(findDriver0Runs(csv)).toEqual([
      {
        unkoNo: "A",
        vehicleName: "テスト1号",
        garageOutAt: "2026/11/27 8:05:42",
        garageInAt: "2026/11/27 18:30:00",
        distanceKm: 23.9,
      },
      { unkoNo: "C", vehicleName: "テスト1号", garageOutAt: null, garageInAt: null, distanceKm: 10 },
    ]);
  });

  it("対象乗務員CD が無い古い形は乗務員CD1 で見る。任意の列が無ければ空", () => {
    const csv = ["運行NO,乗務員CD1,総走行距離", "A,0,12.5"].join("\n");
    expect(findDriver0Runs(csv)).toEqual([
      { unkoNo: "A", vehicleName: "", garageOutAt: null, garageInAt: null, distanceKm: 12.5 },
    ]);
  });

  it("要る列が無ければ黙って 0 件にせず throw する", () => {
    expect(() => findDriver0Runs("読取日\n2026/11/27")).toThrow(Driver0CsvShapeError);
    expect(() => findDriver0Runs("")).toThrow("KUDGURI.csv に列がありません: 運行NO, 対象乗務員CD, 総走行距離");
  });
});

describe("formatKudguriDateTime", () => {
  it("0 埋めして分までにする。無い・形が違えば -", () => {
    expect(formatKudguriDateTime("2026/1/7 8:05:42")).toBe("2026/01/07 08:05");
    expect(formatKudguriDateTime(null)).toBe("-");
    expect(formatKudguriDateTime("2026-11-27T08:05:00Z")).toBe("-");
  });
});

describe("driver0MailLines", () => {
  it("0 件なら何も足さない (空)", () => {
    expect(driver0MailLines([])).toEqual([]);
  });

  it("件数の行と、1 運行 1 行 (運行NO・車輌・出庫・帰庫・距離)", () => {
    expect(
      driver0MailLines([
        { unkoNo: "A", vehicleName: "テスト1号", garageOutAt: "2026/11/27 8:05:42", garageInAt: "2026/11/27 18:30:00", distanceKm: 23.94 },
        { unkoNo: "C", vehicleName: "", garageOutAt: null, garageInAt: null, distanceKm: 10 },
      ]),
    ).toEqual([
      "乗務員未登録のまま 10km 以上走った運行: 2 件",
      "・運行NO A / 車輌 テスト1号 / 出庫 2026/11/27 08:05 / 帰庫 2026/11/27 18:30 / 23.9km",
      "・運行NO C / 車輌 - / 出庫 - / 帰庫 - / 10.0km",
    ]);
  });
});
