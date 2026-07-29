import { describe, it, expect } from "vitest";
import {
  DEFAULT_TOLERANCE_MINUTES,
  compareTimecardMonth,
  compareTimecardMonthAll,
  daysOfMonth,
  parsePdfJson,
  pdfJsonError,
  summarizeCompareResult,
  summarizeCompareResults,
  toDateKey,
  type NginxDriverMonth,
} from "../src/timecard-compare";
// 実応答 (yhonda-ohishi/nginx#784) を 3 名 × 数日に間引いたもの。
// ssh ohishi-data → `curl http://127.0.0.1:120/time-card/pdf-json?month=2026-04&recalc=0`
import REAL_PDF_JSON from "./fixtures/pdf-json-2026-04.json";
// 同日フェリー控除の実応答 (nginx#787 後、1726 / 2026-03)。3/14 は控除で合計が負に
// なり、3/21 は控除があっても合計は正のまま — 後者を見落とさないための実データ。
import REAL_FERRY_JSON from "./fixtures/pdf-json-ferry-2026-03.json";

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
      minusUnkoByType: {},
      ferryMinusMinutes: null,
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
    // 原因 (運行開始→始業 の二重補正) を messages に含める — 読む人が毎回調べ直さない
    expect(r.anomalies[0]?.message).toContain("運行開始→始業の 13 分");
    expect(r.anomalies[0]?.message).toContain("減算前は 4 分");
  });
});

// #785 で `kosoku_minutes` に診断値が加わった。拘束区分と混ぜると存在しない
// type ができ、負なら偽の異常になる。
describe("parsePdfJson — 診断値 (nginx#785)", () => {
  const parsed = parsePdfJson(REAL_PDF_JSON, "2026-04");

  it("_before_minus / _minus_unko を type 別内訳に混ぜない", () => {
    const day = parsed.get("1379")?.days.find((d) => d.date === "2026-04-27");
    // 実応答は TC_DC_minus_unko / TC_DC_before_minus / total_before_minus も持つ
    expect(Object.keys(day?.kosokuByType ?? {}).sort()).toEqual(["TC_DC", "デジタコ"]);
    expect(day?.kosokuMinutes).toBe(644);
  });

  it("減算分は minusUnkoByType へ (0 の日は載せない)", () => {
    const days = parsed.get("1379")?.days ?? [];
    expect(days.find((d) => d.date === "2026-04-27")?.minusUnkoByType).toEqual({ TC_DC: 13 });
    expect(days.find((d) => d.date === "2026-04-01")?.minusUnkoByType).toEqual({ TC_DC: 3 });
    // 4/2 は TC_DC_minus_unko: 0
    expect(days.find((d) => d.date === "2026-04-02")?.minusUnkoByType).toEqual({});
  });

  it("拘束が null の日は内訳も減算も空", () => {
    const day = parsed.get("1021")?.days.find((d) => d.date === "2026-04-01");
    expect(day?.kosokuByType).toEqual({});
    expect(day?.minusUnkoByType).toEqual({});
  });

  it("ferry_minus は type 別内訳に混ぜず、負の合計の原因として書く", () => {
    // nginx#787 の実例 (1726 / 2026-03-14): 同日 4 時間未満のフェリー 2 本が
    // 両方引かれ、積算 321 分を食い破って -112 になった
    const r = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1726",
      nginx: nginxDriver([
        { date: "2026-03-14", kosokuMinutes: -112, byType: { デジタコ: -112 }, ferryMinus: 433 },
      ]),
      oursByDate: ours({ "2026-03-14": 321 }),
    });
    const total = r.anomalies.find((a) => a.kind === "negative-kosoku");
    expect(total?.message).toBe(
      "nginx の拘束が負です (-112 分)。同日フェリー控除の 433 分が引かれたため (控除前は 321 分)",
    );
    // 控除前の 321 分はこちらの値と一致する (フェリーは休憩なので拘束からは引かない)
    expect(r.days.find((d) => d.date === "2026-03-14")?.oursMinutes).toBe(321);
  });

  it("ferry_minus が 0 / 未提供なら原因を書かない", () => {
    const r = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1726",
      nginx: nginxDriver([{ date: "2026-03-14", kosokuMinutes: -50 }]),
      oursByDate: ours({ "2026-03-14": 0 }),
    });
    expect(r.anomalies[0]?.message).toBe("nginx の拘束が負です (-50 分)");
  });

  it("減算が無い負値には原因を書かない", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-01", kosokuMinutes: 10, byType: { TC_DC: -5 } }]),
      oursByDate: ours({ "2026-04-01": 10 }),
    });
    expect(r.anomalies[0]?.message).toBe("nginx の拘束内訳 TC_DC が負です (-5 分)");
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

  it("total_before_minus だけでも type には入れない", () => {
    expect(oneDay({ total: 5, total_before_minus: 9 })).toMatchObject({
      kosokuMinutes: 5,
      kosokuByType: {},
      minusUnkoByType: {},
    });
  });

  it("ferry_minus は type に入れず ferryMinusMinutes へ (0 は該当なし)", () => {
    expect(oneDay({ total: -112, デジタコ: -112, ferry_minus: 433 })).toMatchObject({
      kosokuMinutes: -112,
      kosokuByType: { デジタコ: -112 },
      ferryMinusMinutes: 433,
    });
    expect(oneDay({ total: 5, ferry_minus: 0 })).toMatchObject({
      kosokuByType: {},
      ferryMinusMinutes: null,
    });
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
  days: Array<{
    date: string;
    kosokuMinutes: number | null;
    byType?: Record<string, number>;
    minusUnko?: Record<string, number>;
    ferryMinus?: number;
  }>,
  totals: Record<string, number> = {},
): NginxDriverMonth {
  return {
    driverCd: "1021",
    name: "テスト 乗務員",
    days: days.map((d) => ({
      date: d.date,
      kosokuMinutes: d.kosokuMinutes,
      kosokuByType: d.byType ?? {},
      minusUnkoByType: d.minusUnko ?? {},
      ferryMinusMinutes: d.ferryMinus ?? null,
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
    expect(r.totals).toEqual({
      nginxMinutes: 1050,
      oursMinutes: 1040,
      diffMinutes: 10,
      ferryMinusMinutes: 0,
    });
  });

  it("対象月の外の日は無視する", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-05-01", kosokuMinutes: 570 }]),
      oursByDate: ours({ "2026-03-31": 480 }),
    });
    expect(r.totals).toEqual({
      nginxMinutes: 0,
      oursMinutes: 0,
      diffMinutes: 0,
      ferryMinusMinutes: 0,
    });
    expect(r.mismatchCount).toBe(0);
  });
});

// #787 で ferry_minus が出るようになった。控除は**それ自体が nginx 側の欠陥**なので、
// 合計が負でなくても見えないといけない (3/21 がまさにその形)。
describe("同日フェリー控除 — 実応答 (nginx#787)", () => {
  const parsed = parsePdfJson(REAL_FERRY_JSON, "2026-03");
  const result = compareTimecardMonth({
    month: "2026-03",
    driverCd: "1726",
    nginx: parsed.get("1726") ?? null,
    // 実測値 (rust /api/kintai/kosoku-daily の暦日按分)
    oursByDate: ours({
      "2026-03-02": 1197,
      "2026-03-03": 688,
      "2026-03-14": 321,
      "2026-03-21": 755,
    }),
  });
  const dayOf = (date: string) => result.days.find((d) => d.date === date);

  it("控除額を日ごとに持つ (該当なしは null)", () => {
    expect(dayOf("2026-03-14")?.ferryMinusMinutes).toBe(433);
    expect(dayOf("2026-03-21")?.ferryMinusMinutes).toBe(78);
    expect(dayOf("2026-03-03")?.ferryMinusMinutes).toBeNull();
  });

  it("合計が正の日でも異常として出す (負にならないぶん見落とす)", () => {
    const day = dayOf("2026-03-21");
    expect(day?.nginxMinutes).toBe(677);
    expect(day?.status).toBe("mismatch");
    expect(day?.anomalies.map((a) => a.kind)).toEqual(["ferry-minus"]);
    expect(day?.anomalies[0]?.message).toBe(
      "nginx が同日フェリー控除で 78 分を引いています (控除前は 755 分)。控除前の値がこちらと一致するので二重に引いています",
    );
  });

  it("控除前の値がこちらと一致する (控除が差の原因そのもの)", () => {
    for (const date of ["2026-03-14", "2026-03-21"]) {
      const d = dayOf(date)!;
      expect(d.nginxMinutes! + d.ferryMinusMinutes!).toBe(d.oursMinutes);
    }
  });

  it("負の日は合計・控除・内訳の 3 件が出る (同じ原因だがどれも事実)", () => {
    // 合計 -112 / フェリー控除 433 / デジタコ内訳 -112 — 控除が積算を食い破った形
    const kinds = dayOf("2026-03-14")?.anomalies.map((a) => a.kind);
    expect(kinds).toEqual(["negative-kosoku", "ferry-minus", "negative-kosoku-type"]);
    expect(dayOf("2026-03-14")?.anomalies[0]?.message).toBe(
      "nginx の拘束が負です (-112 分)。同日フェリー控除の 433 分が引かれたため (控除前は 321 分)",
    );
  });

  it("月計は nginx の total_ferry_minus と一致する", () => {
    // 実応答の summary.total_ferry_minus = 511
    expect(result.totals.ferryMinusMinutes).toBe(511);
    expect(parsed.get("1726")?.totals.total_ferry_minus).toBe(511);
  });

  it("拘束が null の日に控除だけ来ても控除前は書かない (足す相手が無い)", () => {
    const r = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1726",
      nginx: nginxDriver([{ date: "2026-03-14", kosokuMinutes: null, ferryMinus: 60 }]),
      oursByDate: ours({}),
    });
    expect(r.anomalies.map((a) => a.kind)).toEqual(["ferry-minus"]);
    expect(r.anomalies[0]?.message).toBe(
      "nginx が同日フェリー控除で 60 分を引いています。控除前の値がこちらと一致するので二重に引いています",
    );
  });

  it("控除の無い日は従来どおり", () => {
    expect(dayOf("2026-03-03")?.status).toBe("match");
    expect(dayOf("2026-03-03")?.anomalies).toEqual([]);
  });
});

// 控除額の出どころは **kosoku-daily (こちら側)** へ移った (nginx#788 → rust#146)。
describe("フェリー控除の出どころ", () => {
  /** こちら側 (kosoku-daily 由来) の入力。 */
  const oursWithFerry = (entries: Record<string, [number, number]>) =>
    new Map(
      Object.entries(entries).map(([d, [restraintMinutes, ferryMinusMinutes]]) => [
        d,
        { restraintMinutes, ferryMinusMinutes },
      ]),
    );

  it("こちら側の控除額を使う (nginx が出さなくなったため)", () => {
    const r = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1726",
      // nginx は控除額を出さない (#788 で revert 済み)
      nginx: nginxDriver([{ date: "2026-03-14", kosokuMinutes: -112, byType: { デジタコ: -112 } }]),
      oursByDate: oursWithFerry({ "2026-03-14": [321, 433] }),
    });
    const day = r.days.find((d) => d.date === "2026-03-14");
    expect(day?.ferryMinusMinutes).toBe(433);
    expect(r.totals.ferryMinusMinutes).toBe(433);
    expect(r.anomalies.map((a) => a.kind)).toEqual([
      "negative-kosoku",
      "ferry-minus",
      "negative-kosoku-type",
    ]);
    // 負の合計の説明にもこちらの値が入る
    expect(r.anomalies[0]?.message).toContain("433 分が引かれたため (控除前は 321 分)");
  });

  it("合計が正の日でも出す (負にならないぶん見落とす)", () => {
    const r = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1726",
      nginx: nginxDriver([{ date: "2026-03-21", kosokuMinutes: 677 }]),
      oursByDate: oursWithFerry({ "2026-03-21": [755, 78] }),
    });
    expect(r.days.find((d) => d.date === "2026-03-21")?.ferryMinusMinutes).toBe(78);
    expect(r.anomalies.map((a) => a.kind)).toEqual(["ferry-minus"]);
  });

  it("控除 0 の日は載せない", () => {
    const r = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1726",
      nginx: nginxDriver([{ date: "2026-03-03", kosokuMinutes: 688 }]),
      oursByDate: oursWithFerry({ "2026-03-03": [688, 0] }),
    });
    expect(r.days.find((d) => d.date === "2026-03-03")?.ferryMinusMinutes).toBeNull();
    expect(r.anomalies).toEqual([]);
  });

  it("こちらに控除が無ければ nginx 側の値へ落ちる (後方互換)", () => {
    const r = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1726",
      nginx: nginxDriver([{ date: "2026-03-14", kosokuMinutes: -112, ferryMinus: 433 }]),
      // ferryMinusMinutes を持たない古い形
      oursByDate: ours({ "2026-03-14": 321 }),
    });
    expect(r.days.find((d) => d.date === "2026-03-14")?.ferryMinusMinutes).toBe(433);
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

  it("跨ぎ勤務の分を乗務員ごとに渡せる", () => {
    const rs = compareTimecardMonthAll({
      month: "2026-04",
      nginxByDriver: new Map([
        ["1030", nginxDriver([{ date: "2026-04-01", kosokuMinutes: 540 }])],
      ]),
      oursByDriver: new Map([["1030", ours({ "2026-04-01": 600 })]]),
      crossMonthByDriver: new Map([["1030", new Map([["2026-04-01", 60]])]]),
    });
    expect(rs[0]?.days[0]?.cause).toBe("month-boundary");
  });
});

describe("summarizeCompareResult", () => {
  it("status ごとの日数を全 status ぶん (0 も) 返す", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([
        { date: "2026-04-01", kosokuMinutes: 570 },
        { date: "2026-04-02", kosokuMinutes: 571 },
        { date: "2026-04-03", kosokuMinutes: 500 },
        { date: "2026-04-04", kosokuMinutes: 480 },
      ]),
      oursByDate: ours({
        "2026-04-01": 570,
        "2026-04-02": 570,
        "2026-04-03": 570,
        "2026-04-05": 600,
      }),
    });
    const s = summarizeCompareResult(r);
    expect(s.driverCd).toBe("1021");
    expect(s.name).toBe("テスト 乗務員");
    expect(s.statusDays).toEqual({
      match: 1,
      "within-tolerance": 1,
      mismatch: 1,
      "nginx-only": 1,
      "ours-only": 1,
      // 4 月は 30 日。5 日ぶんが上に出ているので残りは 25 日
      "both-empty": 25,
    });
    expect(s.mismatchCount).toBe(3);
  });

  it("mismatch 日の diff の幅を返す — 一定幅の控除か勤務の切り方かを 1 行で見分ける", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1026",
      nginx: nginxDriver([
        { date: "2026-04-01", kosokuMinutes: 500 },
        { date: "2026-04-02", kosokuMinutes: 400 },
        { date: "2026-04-03", kosokuMinutes: 600 },
      ]),
      oursByDate: ours({ "2026-04-01": 568, "2026-04-02": 476, "2026-04-03": 600 }),
    });
    const s = summarizeCompareResult(r);
    // 4/3 は一致なので幅に入らない。-68 と -76 だけ
    expect(s.diffRange).toEqual({ min: -76, max: -68 });
  });

  it("mismatch が 1 日も無ければ diffRange は null", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-01", kosokuMinutes: 570 }]),
      oursByDate: ours({ "2026-04-01": 570 }),
    });
    expect(summarizeCompareResult(r).diffRange).toBeNull();
  });

  it("片側しか無い日は diffRange に入らない (引き算が成立していない)", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1099",
      nginx: null,
      oursByDate: ours({ "2026-04-01": 480, "2026-04-02": 500 }),
    });
    const s = summarizeCompareResult(r);
    expect(s.statusDays["ours-only"]).toBe(2);
    expect(s.mismatchCount).toBe(2);
    expect(s.diffRange).toBeNull();
    // nginx に居ないので氏名が空になる — 誰なのかは別途こちら側から補う (#501 A)
    expect(s.name).toBe("");
  });

  it("anomaly を kind ごとに数える (0 件の kind は載せない)", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1022",
      nginx: nginxDriver(
        [
          { date: "2026-04-01", kosokuMinutes: -30 },
          { date: "2026-04-02", kosokuMinutes: -12 },
        ],
        { 拘束時間: -42 },
      ),
      oursByDate: ours({ "2026-04-01": 0, "2026-04-02": 0 }),
    });
    const s = summarizeCompareResult(r);
    expect(s.anomalyKinds["negative-kosoku"]).toBe(2);
    expect(s.anomalyKinds["negative-total"]).toBe(1);
    expect(s.anomalyKinds["impossible-kosoku"]).toBeUndefined();
    expect(s.anomalyCount).toBe(3);
  });

  it("月合計は突合結果のものをそのまま持つ", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-01", kosokuMinutes: 500 }]),
      oursByDate: ours({ "2026-04-01": 570 }),
    });
    expect(summarizeCompareResult(r).totals).toEqual(r.totals);
  });
});

describe("summarizeCompareResults", () => {
  it("並び順を保ったまま全件を畳む", () => {
    const rs = compareTimecardMonthAll({
      month: "2026-04",
      nginxByDriver: new Map<string, NginxDriverMonth>([
        ["1021", { ...nginxDriver([{ date: "2026-04-01", kosokuMinutes: 570 }]), driverCd: "1021" }],
      ]),
      oursByDriver: new Map([
        ["1021", ours({ "2026-04-01": 500 })],
        ["1099", ours({ "2026-04-02": 480 })],
      ]),
    });
    const summaries = summarizeCompareResults(rs);
    expect(summaries.map((s) => s.driverCd)).toEqual(["1021", "1099"]);
    expect(summaries[1]?.statusDays["ours-only"]).toBe(1);
  });
});

describe("差の推定原因 (Refs #501)", () => {
  function dayOf(nginxMin: number, oursMin: number, ferry?: number) {
    const oursByDate = new Map<string, { restraintMinutes: number; ferryMinusMinutes?: number }>([
      ["2026-04-01", { restraintMinutes: oursMin, ...(ferry === undefined ? {} : { ferryMinusMinutes: ferry }) }],
    ]);
    return compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([{ date: "2026-04-01", kosokuMinutes: nginxMin }]),
      oursByDate,
      toleranceMinutes: 2,
    }).days[0]!;
  }

  it("許容誤差に収まる日は原因を付けない", () => {
    const d = dayOf(569, 570);
    expect(d.cause).toBe("none");
    expect(d.explainedMinutes).toBe(0);
  });

  it("60 分の差は昼休控除と見る — nginx は拘束から引くがこちらは休憩に入れる", () => {
    const d = dayOf(510, 570);
    expect(d.cause).toBe("lunch");
    expect(d.explainedMinutes).toBe(60);
    expect(d.residualMinutes).toBe(0);
  });

  it("丸め 1 分が乗った 61 分も昼休控除に入れる", () => {
    const d = dayOf(509, 570);
    expect(d.cause).toBe("lunch");
    expect(d.residualMinutes).toBe(-1);
  });

  it("フェリー控除は実額で引く (推定ではない)", () => {
    const d = dayOf(137, 570, 433);
    expect(d.cause).toBe("ferry");
    expect(d.explainedMinutes).toBe(433);
    expect(d.residualMinutes).toBe(0);
  });

  it("昼休とフェリーが重なった日も説明が付く", () => {
    const d = dayOf(77, 570, 433);
    expect(d.cause).toBe("lunch+ferry");
    expect(d.explainedMinutes).toBe(493);
  });

  it("どの規則でも説明が付かない差は unknown で残す", () => {
    const d = dayOf(170, 570);
    expect(d.cause).toBe("unknown");
    expect(d.explainedMinutes).toBe(0);
    expect(d.residualMinutes).toBe(-400);
  });

  it("フェリー控除が 0 の日を ferry で説明したことにしない", () => {
    // 控除 0 を足しても説明にならない。60 分でもないので unknown のまま
    const d = dayOf(400, 570, 0);
    expect(d.cause).toBe("unknown");
  });

  it("片側しか無い日は原因を付けない (引き算が成立していない)", () => {
    const d = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1099",
      nginx: null,
      oursByDate: ours({ "2026-04-01": 480 }),
    }).days[0]!;
    expect(d.status).toBe("ours-only");
    expect(d.cause).toBe("none");
    expect(d.residualMinutes).toBeNull();
  });

  it("月境界を跨ぐ勤務は実額で説明する (1196 副島 03-01 の形)", () => {
    // 前月から跨いだ勤務の朝側 481 分がこちらだけに乗る — 紙は月内の打刻で
    // 対を組めず落とす。nginx 12 = 当日夜勤の頭だけ
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1196",
      nginx: nginxDriver([{ date: "2026-03-01", kosokuMinutes: 12 }]),
      oursByDate: ours({ "2026-03-01": 493 }),
      crossMonthByDate: new Map([["2026-03-01", 481]]),
      toleranceMinutes: 2,
    }).days[0]!;
    expect(d.cause).toBe("month-boundary");
    expect(d.explainedMinutes).toBe(481);
    expect(d.residualMinutes).toBe(0);
  });

  it("翌月へ跨ぐ勤務の頭 (月末の ours-only) も説明する (1196 副島 03-31 の形)", () => {
    const r = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1196",
      nginx: nginxDriver([]),
      oursByDate: ours({ "2026-03-31": 15 }),
      crossMonthByDate: new Map([["2026-03-31", 15]]),
      toleranceMinutes: 2,
    });
    const d = r.days[30]!;
    expect(d.status).toBe("ours-only");
    expect(d.cause).toBe("month-boundary");
    expect(d.explainedMinutes).toBe(15);
    expect(d.residualMinutes).toBeNull();
  });

  it("ours-only でも跨ぎで説明できない値は none のまま", () => {
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1196",
      nginx: nginxDriver([]),
      oursByDate: ours({ "2026-03-31": 480 }),
      crossMonthByDate: new Map([["2026-03-31", 15]]),
      toleranceMinutes: 2,
    }).days[30]!;
    expect(d.status).toBe("ours-only");
    expect(d.cause).toBe("none");
  });

  it("跨ぎ 0 の日を month-boundary で説明したことにしない", () => {
    // crossMonthByDate に無い日 = 跨ぎ 0。explained 0 は候補にならず unknown のまま
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1196",
      nginx: nginxDriver([{ date: "2026-03-02", kosokuMinutes: 170 }]),
      oursByDate: ours({ "2026-03-02": 570 }),
      crossMonthByDate: new Map(),
      toleranceMinutes: 2,
    }).days[1]!;
    expect(d.cause).toBe("unknown");
  });

  it("運行の継ぎ目は実額で説明する (1731 藤田 03-16 の形)", () => {
    // 紙は運行単位のスパン合算なので継ぎ目 23 分 (幽霊運行を挟む 12:17→12:40) が
    // 入らない。こちらは #123 のとおり入れる — 差は上流の run_gap_minutes で説明
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1731",
      nginx: nginxDriver([{ date: "2026-03-16", kosokuMinutes: 648 }]),
      oursByDate: new Map([
        ["2026-03-16", { restraintMinutes: 671, runGapMinutes: 23 }],
      ]),
      toleranceMinutes: 2,
    }).days[15]!;
    expect(d.cause).toBe("run-gap");
    expect(d.explainedMinutes).toBe(23);
    expect(d.residualMinutes).toBe(0);
  });

  it("昼休と継ぎ目が重なった日も説明が付く", () => {
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1541",
      nginx: nginxDriver([{ date: "2026-03-14", kosokuMinutes: 487 }]),
      oursByDate: new Map([
        ["2026-03-14", { restraintMinutes: 570, runGapMinutes: 23 }],
      ]),
      toleranceMinutes: 2,
    }).days[13]!;
    expect(d.cause).toBe("lunch+run-gap");
    expect(d.explainedMinutes).toBe(83);
  });

  it("継ぎ目 0 の日を run-gap や lunch+run-gap で説明したことにしない", () => {
    // runGap 0 なら候補にならない — 60 分差は従来どおり lunch
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1541",
      nginx: nginxDriver([{ date: "2026-03-14", kosokuMinutes: 510 }]),
      oursByDate: new Map([
        ["2026-03-14", { restraintMinutes: 570, runGapMinutes: 0 }],
      ]),
      toleranceMinutes: 2,
    }).days[13]!;
    expect(d.cause).toBe("lunch");
  });

  it("フェリーと日跨ぎ終業の尻尾が重なった日も説明が付く (1708 松江 03-13 の形)", () => {
    // -584 = フェリー二重控除 432 + 尻尾 151 + 丸め 1
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1708",
      nginx: nginxDriver([{ date: "2026-03-13", kosokuMinutes: 51 }]),
      oursByDate: new Map([
        ["2026-03-13", { restraintMinutes: 635, ferryMinusMinutes: 432, punchTailMinutes: 151 }],
      ]),
      toleranceMinutes: 2,
    }).days[12]!;
    expect(d.cause).toBe("ferry+punch-tail");
    expect(d.explainedMinutes).toBe(583);
    expect(d.residualMinutes).toBe(-1);
  });

  it("尻尾だけの日も説明が付く", () => {
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1708",
      nginx: nginxDriver([{ date: "2026-03-13", kosokuMinutes: 483 }]),
      oursByDate: new Map([
        ["2026-03-13", { restraintMinutes: 635, punchTailMinutes: 151 }],
      ]),
      toleranceMinutes: 2,
    }).days[12]!;
    expect(d.cause).toBe("punch-tail");
    expect(d.explainedMinutes).toBe(151);
  });

  it("尻尾 0 の日を punch-tail 系で説明したことにしない", () => {
    // ferry+punch-tail は両方が実在するときだけ候補になる
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1708",
      nginx: nginxDriver([{ date: "2026-03-13", kosokuMinutes: 51 }]),
      oursByDate: new Map([
        ["2026-03-13", { restraintMinutes: 635, ferryMinusMinutes: 432 }],
      ]),
      toleranceMinutes: 2,
    }).days[12]!;
    expect(d.cause).toBe("unknown");
  });

  it("昼休と尻尾が重なった日も説明が付く", () => {
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1541",
      nginx: nginxDriver([{ date: "2026-03-14", kosokuMinutes: 497 }]),
      oursByDate: new Map([
        ["2026-03-14", { restraintMinutes: 570, punchTailMinutes: 13 }],
      ]),
      toleranceMinutes: 2,
    }).days[13]!;
    expect(d.cause).toBe("lunch+punch-tail");
    expect(d.explainedMinutes).toBe(73);
  });

  it("日跨ぎ始業の頭は実額で説明する (1108 福留 03-06 の形)", () => {
    // 始業 03-05 07:41 の対が無く当日イベント無し — 頭のうち 03-06 に落ちた
    // 516 分 (00:00→運行開始 08:36) がそのまま差になる
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1108",
      nginx: nginxDriver([{ date: "2026-03-06", kosokuMinutes: 318 }]),
      oursByDate: new Map([
        ["2026-03-06", { restraintMinutes: 834, punchHeadMinutes: 516 }],
      ]),
      toleranceMinutes: 2,
    }).days[5]!;
    expect(d.cause).toBe("punch-head");
    expect(d.explainedMinutes).toBe(516);
    expect(d.residualMinutes).toBe(0);
  });

  it("ours-only の日も頭で説明する (1108 福留 03-05 の形)", () => {
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1108",
      nginx: nginxDriver([]),
      oursByDate: new Map([
        ["2026-03-05", { restraintMinutes: 979, punchHeadMinutes: 979 }],
      ]),
      toleranceMinutes: 2,
    }).days[4]!;
    expect(d.status).toBe("ours-only");
    expect(d.cause).toBe("punch-head");
    expect(d.explainedMinutes).toBe(979);
  });

  it("ours-only でも頭で説明できない値は none のまま", () => {
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1108",
      nginx: nginxDriver([]),
      oursByDate: new Map([
        ["2026-03-05", { restraintMinutes: 979, punchHeadMinutes: 500 }],
      ]),
      toleranceMinutes: 2,
    }).days[4]!;
    expect(d.cause).toBe("none");
  });

  it("紙が控除しきれない運行の頭は負の実額で説明する (1026 一瀬 03-12 の形)", () => {
    // 朝の頭 8 + 夕の頭 3、紙の minus_unko は 3 のみ → 紙が 8 分前後大きい。
    // diff +7 (丸め差 1) が run-head で収まる
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1026",
      nginx: nginxDriver([
        { date: "2026-03-12", kosokuMinutes: 799, minusUnko: { TC_DC: 3 } },
      ]),
      oursByDate: new Map([
        ["2026-03-12", { restraintMinutes: 792, runHeadMinutes: 11 }],
      ]),
      toleranceMinutes: 2,
    }).days[11]!;
    expect(d.cause).toBe("run-head");
    expect(d.explainedMinutes).toBe(-8);
    expect(d.residualMinutes).toBe(-1);
  });

  it("フェリーと運行の頭が併発した日も説明が付く (1026 の毎日の形)", () => {
    // diff = -ferry + 頭の残り: -72 = -76 + 4 (+丸め)
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1026",
      nginx: nginxDriver([
        { date: "2026-03-09", kosokuMinutes: 849, minusUnko: { TC_DC: 4 } },
      ]),
      oursByDate: new Map([
        ["2026-03-09", { restraintMinutes: 921, ferryMinusMinutes: 76, runHeadMinutes: 9 }],
      ]),
      toleranceMinutes: 2,
    }).days[8]!;
    expect(d.cause).toBe("ferry+run-head");
    expect(d.explainedMinutes).toBe(71);
    expect(d.residualMinutes).toBe(-1);
  });

  it("頭も控除も無い日を run-head で説明したことにしない", () => {
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1026",
      nginx: nginxDriver([{ date: "2026-03-12", kosokuMinutes: 580 }]),
      oursByDate: new Map([["2026-03-12", { restraintMinutes: 570 }]]),
      toleranceMinutes: 2,
    }).days[11]!;
    expect(d.cause).toBe("unknown");
  });

  it("紙の控除と頭が釣り合う日は補正 0 で候補にならない", () => {
    // minus_unko 6 = 頭 6 → 補正 0。60 分差は従来どおり lunch
    const d = compareTimecardMonth({
      month: "2026-03",
      driverCd: "1026",
      nginx: nginxDriver([
        { date: "2026-03-02", kosokuMinutes: 510, minusUnko: { TC_DC: 6 } },
      ]),
      oursByDate: new Map([
        ["2026-03-02", { restraintMinutes: 570, runHeadMinutes: 6 }],
      ]),
      toleranceMinutes: 2,
    }).days[1]!;
    expect(d.cause).toBe("lunch");
  });

  it("未説明の日数と残差を月で数える — 検知の抜けを測る数字", () => {
    const r = compareTimecardMonth({
      month: "2026-04",
      driverCd: "1021",
      nginx: nginxDriver([
        { date: "2026-04-01", kosokuMinutes: 510 }, // 昼休
        { date: "2026-04-02", kosokuMinutes: 170 }, // 未説明 -400
        { date: "2026-04-03", kosokuMinutes: 470 }, // 未説明 -100
      ]),
      oursByDate: ours({ "2026-04-01": 570, "2026-04-02": 570, "2026-04-03": 570 }),
      toleranceMinutes: 2,
    });
    expect(r.unknownCount).toBe(2);
    expect(r.unknownMinutes).toBe(-500);
    expect(summarizeCompareResult(r).causeDays).toEqual({ lunch: 1, unknown: 2 });
    expect(summarizeCompareResult(r).unknownCount).toBe(2);
  });
});
