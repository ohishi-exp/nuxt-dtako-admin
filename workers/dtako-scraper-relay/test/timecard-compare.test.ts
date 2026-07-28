import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOLERANCE_MINUTES,
  compareTimecardMonth,
  compareTimecardMonthAll,
  daysOfMonth,
  parsePdfJson,
  pdfJsonError,
  toDateKey,
  type NginxDriverMonth,
} from "../src/timecard-compare";
// 実応答 (yhonda-ohishi/nginx#784) を 3 名 × 数日に間引いたもの。
// ssh ohishi-data → `curl http://127.0.0.1:120/time-card/pdf-json?month=2026-04&recalc=0`
import REAL_PDF_JSON from "./fixtures/pdf-json-2026-04.json";

/** こちら側 (暦日按分後) の入力を作る。 */
function ours(entries: Record<string, number>): Map<string, { restraintMinutes: number }> {
  return new Map(Object.entries(entries).map(([d, m]) => [d, { restraintMinutes: m }]));
}

describe("toDateKey", () => {
  it("date をそのまま使う", () => {
    expect(toDateKey({ date: "2026-04-03" }, "2026-04")).toBe("2026-04-03");
  });

  it("day (1〜31) から暦日を組む", () => {
    expect(toDateKey({ day: 3 }, "2026-04")).toBe("2026-04-03");
    expect(toDateKey({ day: 31 }, "2026-04")).toBe("2026-04-31");
  });

  it("date の書式が違えば day へ落ちる", () => {
    expect(toDateKey({ date: "2026/04/03", day: 3 }, "2026-04")).toBe("2026-04-03");
    expect(toDateKey({ date: 20260403, day: 3 }, "2026-04")).toBe("2026-04-03");
  });

  it("どちらも無い・範囲外なら null", () => {
    expect(toDateKey({}, "2026-04")).toBeNull();
    expect(toDateKey({ day: 0 }, "2026-04")).toBeNull();
    expect(toDateKey({ day: 32 }, "2026-04")).toBeNull();
    expect(toDateKey({ day: 1.5 }, "2026-04")).toBeNull();
    expect(toDateKey({ day: "3" }, "2026-04")).toBeNull();
    expect(toDateKey({ day: Number.NaN }, "2026-04")).toBeNull();
  });
});

describe("daysOfMonth", () => {
  it("月末を正しく出す", () => {
    expect(daysOfMonth("2026-04")).toHaveLength(30);
    expect(daysOfMonth("2026-02")).toHaveLength(28);
    expect(daysOfMonth("2028-02")).toHaveLength(29);
  });

  it("12 月は翌年へ回さず 31 日", () => {
    const d = daysOfMonth("2026-12");
    expect(d).toHaveLength(31);
    expect(d[30]).toBe("2026-12-31");
  });

  it("先頭はゼロ詰め", () => {
    expect(daysOfMonth("2026-04")[0]).toBe("2026-04-01");
  });
});

describe("parsePdfJson", () => {
  it("全乗務員の形を読む", () => {
    const m = parsePdfJson(
      {
        month: "2026-04",
        drivers: [
          {
            driver_id: 1021,
            name: "テスト 乗務員",
            days: [{ day: 1, kosoku_minutes: 570, kosoku_by_type: { デジタコ: 510, TC_DC: 60 } }],
            totals: { shukkin: 2, kyujitsu_shukkin_raw: -1 },
          },
        ],
      },
      "2026-04",
    );
    const d = m.get("1021");
    expect(d?.name).toBe("テスト 乗務員");
    expect(d?.days[0]).toEqual({
      date: "2026-04-01",
      kosokuMinutes: 570,
      kosokuByType: { デジタコ: 510, TC_DC: 60 },
    });
    expect(d?.totals).toEqual({ shukkin: 2, kyujitsu_shukkin_raw: -1 });
  });

  it("1 名指定の形 (drivers 無し) も読む", () => {
    const m = parsePdfJson({ driver_id: 1021, days: [{ day: 1, kosoku_minutes: 60 }] }, "2026-04");
    expect(m.get("1021")?.days).toHaveLength(1);
    expect(m.get("1021")?.name).toBe("");
  });

  it("driver でも driver_id でも拾う", () => {
    expect(parsePdfJson({ drivers: [{ driver: "1021", days: [] }] }, "2026-04").has("1021")).toBe(
      true,
    );
  });

  it("乗務員CD は数値正規化する", () => {
    expect(parsePdfJson({ drivers: [{ driver_id: "01021", days: [] }] }, "2026-04").has("1021")).toBe(
      true,
    );
  });

  it("解釈できない入力は空", () => {
    expect(parsePdfJson(null, "2026-04").size).toBe(0);
    expect(parsePdfJson("x", "2026-04").size).toBe(0);
    expect(parsePdfJson({ drivers: [null, 1, "x"] }, "2026-04").size).toBe(0);
    // 乗務員CD が取れない / 0
    expect(parsePdfJson({ drivers: [{ driver_id: "x", days: [] }] }, "2026-04").size).toBe(0);
    expect(parsePdfJson({ drivers: [{ driver_id: 0, days: [] }] }, "2026-04").size).toBe(0);
  });

  it("壊れた日・型違いの項目は捨てて残りを活かす", () => {
    const m = parsePdfJson(
      {
        drivers: [
          {
            driver_id: 1021,
            name: 42,
            days: [
              null,
              "x",
              { day: 99 },
              { day: 2, kosoku_minutes: "60", kosoku_by_type: { TC_DC: "x", デジタコ: 10 } },
            ],
            totals: { ok: 1, ng: "x" },
          },
        ],
      },
      "2026-04",
    );
    const d = m.get("1021");
    expect(d?.name).toBe("");
    expect(d?.days).toHaveLength(1);
    expect(d?.days[0]?.kosokuMinutes).toBeNull();
    expect(d?.days[0]?.kosokuByType).toEqual({ デジタコ: 10 });
    expect(d?.totals).toEqual({ ok: 1 });
  });

  it("days / kosoku_by_type / totals が配列や非オブジェクトでも壊れない", () => {
    const m = parsePdfJson(
      {
        drivers: [
          { driver_id: 1021, days: "x", totals: [1, 2] },
          { driver_id: 1022, days: [{ day: 1, kosoku_by_type: [1], kosoku_minutes: 1 }], totals: null },
        ],
      },
      "2026-04",
    );
    expect(m.get("1021")?.days).toEqual([]);
    expect(m.get("1021")?.totals).toEqual({});
    expect(m.get("1022")?.days[0]?.kosokuByType).toEqual({});
    expect(m.get("1022")?.totals).toEqual({});
  });
});

// 実応答 (yhonda-ohishi/nginx#784) の形。起票時の想定と 3 点違っていた:
// トップが `rows` / `kosoku_minutes` がオブジェクト / 月計が `summary`。
describe("parsePdfJson — 実応答 (nginx#784)", () => {
  const parsed = parsePdfJson(REAL_PDF_JSON, "2026-04");

  it("rows を読む", () => {
    expect([...parsed.keys()].sort()).toEqual(["1021", "1049", "1379"]);
    expect(parsed.get("1021")?.name).toBe("鈴木  昭");
  });

  it("kosoku_minutes オブジェクトから total と type 別内訳を取る", () => {
    // 1379 の 4/27 は TC_DC が負 (合計は正) — 実データ
    const day = parsed.get("1379")?.days.find((d) => d.date === "2026-04-27");
    expect(day?.kosokuMinutes).toBe(644);
    expect(day?.kosokuByType).toEqual({ デジタコ: 653, TC_DC: -9 });
  });

  it("値が null の日は「行はあるが値なし」にする", () => {
    // 4/1 は公休で拘束が無い日 ({total: null, デジタコ: null, TC_DC: null})
    const day = parsed.get("1021")?.days.find((d) => d.date === "2026-04-01");
    expect(day?.kosokuMinutes).toBeNull();
    expect(day?.kosokuByType).toEqual({});
  });

  it("summary を月計として読む (kyujitsu_shukkin_raw の負値もそのまま)", () => {
    expect(parsed.get("1049")?.totals.kyujitsu_shukkin_raw).toBe(-1);
    expect(parsed.get("1021")?.totals.shukkin).toBe(21);
  });

  it("実データの負値がそのまま突合結果の異常になる", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1379",
      nginx: parsed.get("1379") ?? null,
      oursByDate: ours({ "2026-04-27": 644 }),
    });
    // 合計は一致しているのに内訳が負 — 差分と独立に出ることの実データ確認
    expect(r.days.find((d) => d.date === "2026-04-27")?.status).toBe("match");
    expect(r.anomalies).toEqual([
      expect.objectContaining({ kind: "negative-kosoku-type", date: "2026-04-27", field: "TC_DC", minutes: -9 }),
    ]);
  });
});

describe("parsePdfJson — kosoku_minutes の形ゆれ", () => {
  const oneDay = (kosoku: unknown) =>
    parsePdfJson({ rows: [{ driver_id: 1, days: [{ day: 1, kosoku_minutes: kosoku }] }] }, "2026-04")
      .get("1")?.days[0];

  it("数値 1 個の形も受ける (起票時の想定)", () => {
    expect(oneDay(570)).toMatchObject({ kosokuMinutes: 570, kosokuByType: {} });
  });

  it("total が無いオブジェクトは合計 null のまま内訳だけ取る", () => {
    expect(oneDay({ TC_DC: -9 })).toMatchObject({ kosokuMinutes: null, kosokuByType: { TC_DC: -9 } });
  });

  it("配列・文字列・null は値なし", () => {
    for (const raw of [[1], "60", null, undefined]) {
      expect(oneDay(raw)).toMatchObject({ kosokuMinutes: null, kosokuByType: {} });
    }
  });
});

describe("pdfJsonError", () => {
  it("nginx が 200 で返すエラーを拾う (月の書式違い・基礎日数の未登録)", () => {
    expect(pdfJsonError({ error: "month は YYYY-MM 形式で指定してください" })).toBe(
      "month は YYYY-MM 形式で指定してください",
    );
  });

  it("正常応答・空文字・非オブジェクトは null", () => {
    expect(pdfJsonError(REAL_PDF_JSON)).toBeNull();
    expect(pdfJsonError({ error: "" })).toBeNull();
    expect(pdfJsonError({ error: 42 })).toBeNull();
    expect(pdfJsonError(null)).toBeNull();
    expect(pdfJsonError("x")).toBeNull();
  });
});

/** 突合用の nginx 側 1 名を素早く作る。 */
function nginxDriver(
  days: Array<{ date: string; kosokuMinutes: number | null; byType?: Record<string, number> }>,
  totals: Record<string, number> = {},
): NginxDriverMonth {
  return {
    driverCd: "1021",
    name: "テスト 乗務員",
    days: days.map((d) => ({
      date: d.date,
      kosokuMinutes: d.kosokuMinutes,
      kosokuByType: d.byType ?? {},
    })),
    totals,
  };
}

describe("compareTimecardMonth", () => {
  it("月の全暦日を返す (画面が 1〜31 日の固定行で描くため)", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: null,
      oursByDate: ours({}),
    });
    expect(r.days).toHaveLength(30);
    expect(r.days.every((d) => d.status === "both-empty")).toBe(true);
    expect(r.name).toBe("");
    expect(r.toleranceMinutes).toBe(DEFAULT_TOLERANCE_MINUTES);
  });

  it("一致・許容内・不一致を分ける", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([
        { date: "2026-04-01", kosokuMinutes: 570 },
        { date: "2026-04-02", kosokuMinutes: 571 },
        { date: "2026-04-03", kosokuMinutes: 600 },
      ]),
      oursByDate: ours({ "2026-04-01": 570, "2026-04-02": 570, "2026-04-03": 570 }),
    });
    expect(r.days[0]?.status).toBe("match");
    expect(r.days[1]?.status).toBe("within-tolerance");
    expect(r.days[1]?.diffMinutes).toBe(1);
    expect(r.days[2]?.status).toBe("mismatch");
    expect(r.days[2]?.diffMinutes).toBe(30);
    expect(r.mismatchCount).toBe(1);
  });

  it("許容誤差は差し替えられる", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-01", kosokuMinutes: 575 }]),
      oursByDate: ours({ "2026-04-01": 570 }),
      toleranceMinutes: 5,
    });
    expect(r.days[0]?.status).toBe("within-tolerance");
    expect(r.toleranceMinutes).toBe(5);
  });

  it("片方だけに値がある日を分けて数える", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-01", kosokuMinutes: 570 }]),
      oursByDate: ours({ "2026-04-02": 480 }),
    });
    expect(r.days[0]?.status).toBe("nginx-only");
    expect(r.days[0]?.diffMinutes).toBeNull();
    expect(r.days[1]?.status).toBe("ours-only");
    expect(r.mismatchCount).toBe(2);
  });

  it("0 分と行なしは一致扱い (稼働の無い日で差が埋もれないように)", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([
        { date: "2026-04-01", kosokuMinutes: 0 },
        { date: "2026-04-02", kosokuMinutes: null },
      ]),
      oursByDate: ours({ "2026-04-02": 0 }),
    });
    expect(r.days[0]?.status).toBe("both-empty");
    expect(r.days[1]?.status).toBe("both-empty");
    expect(r.mismatchCount).toBe(0);
  });

  it("負の拘束を clamp せず異常として拾う (nginx#783)", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-02", kosokuMinutes: -30, byType: { TC_DC: -30, デジタコ: 0 } }]),
      oursByDate: ours({ "2026-04-02": 0 }),
    });
    const day = r.days[1];
    expect(day?.nginxMinutes).toBe(-30);
    expect(day?.anomalies.map((a) => a.kind)).toEqual(["negative-kosoku", "negative-kosoku-type"]);
    expect(day?.anomalies[1]?.field).toBe("TC_DC");
    expect(r.totals.nginxMinutes).toBe(-30);
    expect(r.anomalies).toHaveLength(2);
  });

  it("合計が正でも内訳が負なら拾う", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-01", kosokuMinutes: 480, byType: { デジタコ: 540, TC_DC: -60 } }]),
      oursByDate: ours({ "2026-04-01": 480 }),
    });
    expect(r.days[0]?.status).toBe("match");
    expect(r.anomalies.map((a) => a.kind)).toEqual(["negative-kosoku-type"]);
  });

  it("1 日 (1440 分) を超える拘束を拾う", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-01", kosokuMinutes: 1500 }]),
      oursByDate: ours({ "2026-04-01": 1500 }),
    });
    expect(r.anomalies.map((a) => a.kind)).toEqual(["impossible-kosoku"]);
    expect(r.anomalies[0]?.message).toContain("1440");
  });

  it("月次集計欄の負値を拾う (日付は null)", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([], { shukkin: 2, kyujitsu_shukkin_raw: -1 }),
      oursByDate: ours({}),
    });
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({
      kind: "negative-total",
      date: null,
      field: "kyujitsu_shukkin_raw",
      minutes: -1,
    });
  });

  it("月合計は両側それぞれ足して差を出す", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([
        { date: "2026-04-01", kosokuMinutes: 570 },
        { date: "2026-04-02", kosokuMinutes: 480 },
      ]),
      oursByDate: ours({ "2026-04-01": 570, "2026-04-02": 470 }),
    });
    expect(r.totals).toEqual({ nginxMinutes: 1050, oursMinutes: 1040, diffMinutes: 10 });
  });

  it("対象月の外の日は無視する", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-05-01", kosokuMinutes: 570 }]),
      oursByDate: ours({ "2026-03-31": 480 }),
    });
    expect(r.totals).toEqual({ nginxMinutes: 0, oursMinutes: 0, diffMinutes: 0 });
    expect(r.mismatchCount).toBe(0);
  });
});

describe("compareTimecardMonthAll", () => {
  const nginxByDriver = new Map<string, NginxDriverMonth>([
    ["1021", { ...nginxDriver([{ date: "2026-04-01", kosokuMinutes: 570 }]), driverCd: "1021" }],
    [
      "1022",
      {
        ...nginxDriver([{ date: "2026-04-01", kosokuMinutes: -30 }]),
        driverCd: "1022",
        name: "負の人",
      },
    ],
    ["1030", { ...nginxDriver([{ date: "2026-04-01", kosokuMinutes: 600 }]), driverCd: "1030" }],
  ]);
  const oursByDriver = new Map<string, Map<string, { restraintMinutes: number }>>([
    ["1021", ours({ "2026-04-01": 570 })],
    ["1022", ours({ "2026-04-01": 0 })],
    ["1030", ours({ "2026-04-01": 540 })],
    ["1099", ours({ "2026-04-02": 480 })],
  ]);

  it("既定では全乗務員を乗務員CD 順に返す", () => {
    const rs = compareTimecardMonthAll({ month: "2026-04", nginxByDriver, oursByDriver });
    expect(rs.map((r) => r.driverCd)).toEqual(["1021", "1022", "1030", "1099"]);
  });

  it("onlyAnomalies で差分も異常も無い人を落とす", () => {
    const rs = compareTimecardMonthAll({
      month: "2026-04",
      nginxByDriver,
      oursByDriver,
      onlyAnomalies: true,
    });
    // 1021 は完全一致なので落ちる。1022 = 負値、1030 = 60 分差、1099 = nginx に居ない
    expect(rs.map((r) => r.driverCd)).toEqual(["1022", "1030", "1099"]);
    expect(rs[0]?.anomalies[0]?.kind).toBe("negative-kosoku");
    expect(rs[2]?.days[1]?.status).toBe("ours-only");
  });

  it("nginx にしか居ない乗務員も返す (積集合を取らない)", () => {
    const rs = compareTimecardMonthAll({
      month: "2026-04",
      nginxByDriver: new Map([["1021", nginxDriver([{ date: "2026-04-01", kosokuMinutes: 570 }])]]),
      oursByDriver: new Map(),
      onlyAnomalies: true,
    });
    expect(rs).toHaveLength(1);
    expect(rs[0]?.days[0]?.status).toBe("nginx-only");
  });

  it("許容誤差を渡せる", () => {
    const rs = compareTimecardMonthAll({
      month: "2026-04",
      nginxByDriver,
      oursByDriver,
      toleranceMinutes: 60,
      onlyAnomalies: true,
    });
    // 1030 の 60 分差が許容内に入り落ちる
    expect(rs.map((r) => r.driverCd)).toEqual(["1022", "1099"]);
  });
});
