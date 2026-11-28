/**
 * `src/driver0-alert.ts` のテスト (Refs ippoan/alc-app#676)。
 * KUDGURI の見出しは alc の取り込み (alc-csv-parser の kudguri.rs) と同じ並び。値は架空。
 */

import { describe, it, expect } from "vitest";
import {
  DRIVER0_ALERT_TARGET_VAR,
  Driver0CsvShapeError,
  buildDriver0Notification,
  findDriver0Runs,
  formatKudguriDateTime,
  resolveDriver0AlertTarget,
} from "../src/driver0-alert";

const HEADER =
  "運行NO,読取日,事業所CD,事業所名,車輌CD,車輌名,乗務員CD1,対象乗務員CD,対象乗務員名,対象乗務員区分,出庫日時,帰庫日時,総走行距離";

function row(unko: string, driverCd: string, km: string, out = "2026/11/27 8:05:42", inn = "2026/11/27 18:30:00"): string {
  return `${unko},2026/11/27,1,本社,1001,テスト1号,${driverCd},${driverCd},,1,${out},${inn},${km}`;
}

describe("resolveDriver0AlertTarget", () => {
  it("SCRAPE_ALERT_TARGET と同じ規則で、文言は自分の変数名と用途を名指す", () => {
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(resolveDriver0AlertTarget(`{"channel_id":"${id}"}`)).toEqual({
      ok: true,
      destination: { kind: "channel", id },
    });
    const unset = resolveDriver0AlertTarget(undefined);
    expect(unset.ok).toBe(false);
    expect(!unset.ok && unset.error).toContain(`${DRIVER0_ALERT_TARGET_VAR} が未設定のため、乗務員未登録の運行の通知を送っていません`);
    const arr = resolveDriver0AlertTarget("[]");
    expect(!arr.ok && arr.error).toContain(`${DRIVER0_ALERT_TARGET_VAR} は JSON オブジェクト 1 件`);
  });
});

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
        officeName: "本社",
        vehicleName: "テスト1号",
        garageOutAt: "2026/11/27 8:05:42",
        garageInAt: "2026/11/27 18:30:00",
        distanceKm: 23.9,
      },
      { unkoNo: "C", officeName: "本社", vehicleName: "テスト1号", garageOutAt: null, garageInAt: null, distanceKm: 10 },
    ]);
  });

  it("対象乗務員CD が無い古い形は乗務員CD1 で見る。任意の列が無ければ空", () => {
    const csv = ["運行NO,乗務員CD1,総走行距離", "A,0,12.5"].join("\n");
    expect(findDriver0Runs(csv)).toEqual([
      { unkoNo: "A", officeName: "", vehicleName: "", garageOutAt: null, garageInAt: null, distanceKm: 12.5 },
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

describe("buildDriver0Notification", () => {
  it("0 件なら送らない (null)", () => {
    expect(buildDriver0Notification({ compId: "1", readingDate: "2026-11-27", runs: [] })).toBeNull();
  });

  it("1 社 1 日 1 通。運行ごとに 1 行 (事業所・車両・出庫・帰庫・距離)", () => {
    const text = buildDriver0Notification({
      compId: "1",
      readingDate: "2026-11-27",
      runs: [
        { unkoNo: "A", officeName: "本社", vehicleName: "テスト1号", garageOutAt: "2026/11/27 8:05:42", garageInAt: "2026/11/27 18:30:00", distanceKm: 23.94 },
        { unkoNo: "C", officeName: "", vehicleName: "", garageOutAt: null, garageInAt: null, distanceKm: 10 },
      ],
    });
    expect(text).toBe(
      [
        "【dtako 乗務員未登録】comp_id 1 の読取日 2026/11/27 に、乗務員未登録のまま 10km 以上走った運行が 2 件あります",
        "・運行NO A / 本社 / テスト1号 / 始業(出庫) 2026/11/27 08:05 / 終業(帰庫) 2026/11/27 18:30 / 23.9km",
        "・運行NO C / - / - / 始業(出庫) - / 終業(帰庫) - / 10.0km",
      ].join("\n"),
    );
  });
});

