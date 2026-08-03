import { describe, it, expect } from "vitest";
import {
  buildKintaiDiff,
  gcpSummariesToMap,
  onpremKosokuDailyToMap,
  pickRecalcObservations,
  pickRestDiffGuarantee,
  deriveOpeNoFromUnkoNo,
  KINTAI_DIFF_MAX_ITEMS,
} from "../src/kintai-diff";

/** GCP `day_summaries` の応答形。 */
function gcpBody(summaries: Record<string, unknown>) {
  return { month: "2026-06", rows: Object.keys(summaries).length, summaries };
}

/** オンプレ `kosoku-daily` (view 省略 = Full) の応答形。 */
function onpremBody(drivers: Array<{ driver: number; days: unknown[] }>) {
  return { month: "2026-06", drivers };
}

function day(over: Partial<Record<string, unknown>> = {}) {
  return {
    date: "2026-06-01",
    start: "2026-06-01 08:00:00",
    end: "2026-06-01 20:00:00",
    source: "timecard",
    restraint_minutes: 720,
    working_minutes: 600,
    break_minutes: 120,
    rest_minus_minutes: 0,
    statutory_minutes: 480,
    within_statutory_overtime_minutes: 0,
    overtime_minutes: 120,
    legal_holiday_minutes: 0,
    night_minutes: 0,
    overtime_night_minutes: 0,
    legal_holiday_night_minutes: 0,
    punches: [{ at: "2026-06-01 08:00:00", state: "始業" }],
    parts: [],
    ...over,
  };
}

const GCP_VALUE = {
  shift_source: "timecard",
  restraint_minutes: 720,
  working_minutes: 600,
  break_minutes: 120,
  rest_minus_minutes: 0,
  statutory_minutes: 480,
  within_statutory_overtime_minutes: 0,
  overtime_minutes: 120,
  legal_holiday_minutes: 0,
  night_minutes: 0,
  overtime_night_minutes: 0,
  legal_holiday_night_minutes: 0,
};

describe("buildKintaiDiff (Refs #615-4)", () => {
  it("5 分類 (only_gcp / only_onprem_driver0 / only_onprem_other / restraint一致 / restraint不一致) に振り分け、完全一致行は落とす", () => {
    const KEY_ONLY_GCP = "2001|2026-06-01|2026-06-01 08:00:00";
    const KEY_RESTRAINT_MATCH = "2003|2026-06-04|2026-06-04 09:00:00";
    const KEY_RESTRAINT_MISMATCH = "2004|2026-06-05|2026-06-05 09:00:00";
    const KEY_IDENTICAL = "2005|2026-06-06|2026-06-06 09:00:00";

    const onprem = onpremBody([
      { driver: 0, days: [day({ date: "2026-06-02", start: "2026-06-02 09:00:00" })] },
      { driver: 2002, days: [day({ date: "2026-06-03", start: "2026-06-03 09:00:00" })] },
      {
        driver: 2003,
        days: [
          day({ date: "2026-06-04", start: "2026-06-04 09:00:00", break_minutes: 100, working_minutes: 620 }),
        ],
      },
      { driver: 2004, days: [day({ date: "2026-06-05", start: "2026-06-05 09:00:00", restraint_minutes: 700 })] },
      { driver: 2005, days: [day({ date: "2026-06-06", start: "2026-06-06 09:00:00" })] },
    ]);
    const gcp = gcpBody({
      [KEY_ONLY_GCP]: GCP_VALUE,
      [KEY_RESTRAINT_MATCH]: GCP_VALUE,
      [KEY_RESTRAINT_MISMATCH]: GCP_VALUE,
      [KEY_IDENTICAL]: GCP_VALUE,
    });

    const res = buildKintaiDiff(gcp, onprem);

    expect(res.gcp_rows).toBe(4);
    expect(res.onprem_rows).toBe(5);
    expect(res.onprem_unreadable).toBe(false);

    expect(res.only_gcp.total).toBe(1);
    expect(res.only_gcp.items[0]).toMatchObject({
      driver_cd: "2001",
      date: "2026-06-01",
      start: "2026-06-01 08:00:00",
    });

    expect(res.only_onprem_driver0.total).toBe(1);
    expect(res.only_onprem_driver0.items[0]).toMatchObject({ driver_cd: "0", date: "2026-06-02" });

    expect(res.only_onprem_other.total).toBe(1);
    expect(res.only_onprem_other.items[0]).toMatchObject({ driver_cd: "2002", date: "2026-06-03" });

    expect(res.value_diff_restraint_match.total).toBe(1);
    const matchRow = res.value_diff_restraint_match.items[0]!;
    expect(matchRow.driver_cd).toBe("2003");
    expect(matchRow.gcp.restraint_minutes).toBe(matchRow.onprem.restraint_minutes);
    expect([...matchRow.diff_fields].sort()).toEqual(["break_minutes", "working_minutes"]);

    expect(res.value_diff_restraint_mismatch.total).toBe(1);
    const mismatchRow = res.value_diff_restraint_mismatch.items[0]!;
    expect(mismatchRow.driver_cd).toBe("2004");
    expect(mismatchRow.gcp.restraint_minutes).not.toBe(mismatchRow.onprem.restraint_minutes);
    expect(mismatchRow.diff_fields).toEqual(["restraint_minutes"]);

    // 完全一致行 (KEY_IDENTICAL) はどのカテゴリにも出ない
    const allKeys = [
      ...res.only_gcp.items,
      ...res.only_onprem_driver0.items,
      ...res.only_onprem_other.items,
      ...res.value_diff_restraint_match.items,
      ...res.value_diff_restraint_mismatch.items,
    ].map((r) => `${r.driver_cd}|${r.date}`);
    expect(allKeys).not.toContain("2005|2026-06-06");

    // punches/parts は突合結果に含めない (捨てている)
    expect(JSON.stringify(res)).not.toMatch(/punches/);
    expect(JSON.stringify(res)).not.toMatch(/"parts"/);
  });

  it(`カテゴリごとに ${KINTAI_DIFF_MAX_ITEMS} 件で切り、total と capped で分かる形にする`, () => {
    const summaries: Record<string, unknown> = {};
    for (let i = 0; i < KINTAI_DIFF_MAX_ITEMS + 1; i++) {
      summaries[`${3000 + i}|2026-06-01|2026-06-01 08:00:00`] = GCP_VALUE;
    }
    const res = buildKintaiDiff(gcpBody(summaries), onpremBody([]));
    expect(res.only_gcp.total).toBe(KINTAI_DIFF_MAX_ITEMS + 1);
    expect(res.only_gcp.items).toHaveLength(KINTAI_DIFF_MAX_ITEMS);
    expect(res.only_gcp.capped).toBe(true);
    expect(res.only_onprem_other.capped).toBe(false);
  });

  it("GCP `summaries` が欠けている / 形が違う応答は空扱いにする", () => {
    const res = buildKintaiDiff({ month: "2026-06", rows: 0 }, onpremBody([]));
    expect(res.gcp_rows).toBe(0);
  });

  it("GCP body が null でも例外を投げない", () => {
    const res = buildKintaiDiff(null, onpremBody([]));
    expect(res.gcp_rows).toBe(0);
  });

  it("オンプレ `drivers` が配列でない / `days` が配列でない / date・start が文字列でない行は無視する", () => {
    const res = buildKintaiDiff(
      gcpBody({}),
      {
        month: "2026-06",
        drivers: [
          { driver: 1, days: "not-an-array" },
          { driver: 2, days: [{ ...day(), date: undefined }] },
          { driver: 3, days: [{ ...day(), start: undefined }] },
        ],
      },
    );
    expect(res.onprem_rows).toBe(0);
  });

  it("分数が number でも非有限 (NaN 等) なら 0 扱いにする", () => {
    const onprem = onpremBody([
      { driver: 5001, days: [day({ date: "2026-06-07", start: "2026-06-07 09:00:00", night_minutes: NaN })] },
    ]);
    const res = buildKintaiDiff(gcpBody({}), onprem);
    expect(res.only_onprem_other.items[0]!.onprem.night_minutes).toBe(0);
  });

  it("driver 指定形 (`drivers` が無くトップレベルに `driver`/`days`) を単一乗務員として読む (#599)", () => {
    const onprem = {
      month: "2026-06",
      driver: 1518,
      days: [day({ date: "2026-06-01", start: "2026-06-01 08:00:00" })],
      punches: [],
      duplicate_rows: 0,
    };
    const res = buildKintaiDiff(
      gcpBody({ "1518|2026-06-01|2026-06-01 08:00:00": GCP_VALUE }),
      onprem,
      "1518",
    );
    expect(res.onprem_rows).toBe(1);
    expect(res.onprem_unreadable).toBe(false);
    // 値が両側で完全一致 → 修正前は `drivers` 不在で onprem が空になり only_gcp に化けていた
    expect(res.only_gcp.total).toBe(0);
    expect(res.only_onprem_other.total).toBe(0);
    expect(res.value_diff_restraint_match.total).toBe(0);
    expect(res.value_diff_restraint_mismatch.total).toBe(0);
  });

  it("単一乗務員形の応答に `driver` が無ければ、呼び出しに渡した driver 引数へ落とす", () => {
    const onprem = { month: "2026-06", days: [day({ date: "2026-06-08", start: "2026-06-08 09:00:00" })] };
    const res = buildKintaiDiff(gcpBody({}), onprem, "1049");
    expect(res.onprem_rows).toBe(1);
    expect(res.only_onprem_other.items[0]!.driver_cd).toBe("1049");
  });

  it("driver 省略の全乗務員形 (`drivers` 配列) は従来どおり読める (回帰確認)", () => {
    const res = buildKintaiDiff(gcpBody({}), onpremBody([{ driver: 1518, days: [day()] }]));
    expect(res.onprem_rows).toBe(1);
    expect(res.onprem_unreadable).toBe(false);
  });

  it("オンプレ `drivers` そのものが配列でない応答は空扱いにする", () => {
    const res = buildKintaiDiff(gcpBody({}), { month: "2026-06" });
    expect(res.onprem_rows).toBe(0);
  });

  it("★ どちらの形にも当てはまらないときは、静かに 0 行にせず onprem_unreadable を立てる (#599)", () => {
    const res = buildKintaiDiff(
      gcpBody({ "1518|2026-06-01|2026-06-01 08:00:00": GCP_VALUE }),
      { month: "2026-06", weird: true },
      "1518",
    );
    expect(res.onprem_rows).toBe(0);
    expect(res.onprem_unreadable).toBe(true);
    // GCP 側の行は (形が読めなかったので) only_gcp に残る
    expect(res.only_gcp.total).toBe(1);
  });
});

describe("gcpSummariesToMap / onpremKosokuDailyToMap (単体)", () => {
  it("gcpSummariesToMap は summaries が object でなければ空 Map", () => {
    expect(gcpSummariesToMap({ summaries: "not-an-object" }).size).toBe(0);
    expect(gcpSummariesToMap(undefined).size).toBe(0);
  });

  it("onpremKosokuDailyToMap は body が null でも unreadable ではなく安全に扱う", () => {
    const res = onpremKosokuDailyToMap(null);
    expect(res.unreadable).toBe(true);
    expect(res.map.size).toBe(0);
  });
});

describe("pickRecalcObservations (Refs #615-4)", () => {
  it("stale/fold/warnings/unko_diff_gcp_only_in_month/next_after_driver_cd を読む", () => {
    const obs = pickRecalcObservations({
      stale: { drivers: 3 },
      fold: { drivers_written: 5 },
      warnings: ["dtako 入力欠け: 乗務員12名の末尾が16日超"],
      unko_diff_gcp_only_in_month: 417,
      next_after_driver_cd: 1234,
    });
    expect(obs).toEqual({
      stale_drivers: 3,
      fold_would_write_drivers: 5,
      warnings: ["dtako 入力欠け: 乗務員12名の末尾が16日超"],
      unko_diff_gcp_only_in_month: 417,
      next_after_driver_cd: 1234,
    });
  });

  it("fold.drivers_written が無ければトップレベルの drivers_written へ落ちる", () => {
    const obs = pickRecalcObservations({ fold: {}, drivers_written: 9 });
    expect(obs.fold_would_write_drivers).toBe(9);
  });

  it("原型が壊れていても例外を投げず null/空配列に倒す (未知の応答形への耐性)", () => {
    expect(pickRecalcObservations(null)).toEqual({
      stale_drivers: null,
      fold_would_write_drivers: null,
      warnings: [],
      unko_diff_gcp_only_in_month: null,
      next_after_driver_cd: null,
    });
    expect(pickRecalcObservations("not-an-object")).toEqual({
      stale_drivers: null,
      fold_would_write_drivers: null,
      warnings: [],
      unko_diff_gcp_only_in_month: null,
      next_after_driver_cd: null,
    });
  });

  it("warnings に文字列以外が混ざっていたら落とす", () => {
    const obs = pickRecalcObservations({ warnings: ["ok", 123, null] });
    expect(obs.warnings).toEqual(["ok"]);
  });

  it("stale/fold が object でなければ無視する", () => {
    const obs = pickRecalcObservations({ stale: "nope", fold: null });
    expect(obs.stale_drivers).toBeNull();
    expect(obs.fold_would_write_drivers).toBeNull();
  });
});

describe("pickRestDiffGuarantee (Refs #615-4)", () => {
  const REST_DIFF_BODY = {
    by_driver: { "1412": 2 },
    items: [
      { unko_no: "26060104145700000011091", kind: "dtako_missing" },
      { unko_no: "26060304163200000011091", kind: "mismatch" },
    ],
  };

  it("kind: mismatch は guaranteed: true", () => {
    const res = pickRestDiffGuarantee(REST_DIFF_BODY, "26060304163200000011091");
    expect(res).toEqual({ found: true, kind: "mismatch", guaranteed: true });
  });

  it("kind: dtako_missing は found: true だが guaranteed: false", () => {
    const res = pickRestDiffGuarantee(REST_DIFF_BODY, "26060104145700000011091");
    expect(res).toEqual({ found: true, kind: "dtako_missing", guaranteed: false });
  });

  it("対象 unko_no が items に無ければ found: false / guaranteed: false (判定不能)", () => {
    const res = pickRestDiffGuarantee(REST_DIFF_BODY, "99999999999999999999999");
    expect(res).toEqual({ found: false, kind: null, guaranteed: false });
  });

  it("items が配列でない/応答が壊れていても例外を投げない", () => {
    expect(pickRestDiffGuarantee({}, "x")).toEqual({ found: false, kind: null, guaranteed: false });
    expect(pickRestDiffGuarantee(null, "x")).toEqual({ found: false, kind: null, guaranteed: false });
  });

  it("kind が文字列でない要素は kind: null 扱い", () => {
    const res = pickRestDiffGuarantee({ items: [{ unko_no: "x", kind: 123 }] }, "x");
    expect(res).toEqual({ found: true, kind: null, guaranteed: false });
  });
});

describe("deriveOpeNoFromUnkoNo (Refs #615-4、親指摘 2026-08-03)", () => {
  // 23桁 = 開始日時12桁 (260519054958 = 2026-05-19 05:49:58) + 車輌CD10桁 + 対象CD1桁
  const UNKO_NO_23 = "26051905495800000018740";
  const OPE_NO_22 = UNKO_NO_23.slice(0, 22);

  it("23桁 (オンプレ形) は末尾1桁を落として22桁にし、先頭12桁から start_ope を組む", () => {
    expect(UNKO_NO_23).toHaveLength(23);
    const res = deriveOpeNoFromUnkoNo(UNKO_NO_23);
    expect(res).toEqual({ opeNo22: OPE_NO_22, startOpe: "2026/05/19 5:49:58" });
  });

  it("22桁 (GCP形) はそのまま ope_no_22 として使う", () => {
    expect(OPE_NO_22).toHaveLength(22);
    const res = deriveOpeNoFromUnkoNo(OPE_NO_22);
    expect(res).toEqual({ opeNo22: OPE_NO_22, startOpe: "2026/05/19 5:49:58" });
  });

  it("桁数が23でも22でもなければ null (呼び出し側が400にする)", () => {
    expect(deriveOpeNoFromUnkoNo("123")).toBeNull();
    expect(deriveOpeNoFromUnkoNo("2".repeat(24))).toBeNull();
    expect(deriveOpeNoFromUnkoNo("")).toBeNull();
    expect(deriveOpeNoFromUnkoNo("abcdefghijklmnopqrstuvw")).toBeNull(); // 23文字だが数字でない
  });

  it("時が2桁 (10時以降) ならそのまま2桁で出る", () => {
    // 2026-05-19 14:05:03
    const res = deriveOpeNoFromUnkoNo("26051914050300000018740");
    expect(res?.startOpe).toBe("2026/05/19 14:05:03");
  });

  it("時が0時台なら1桁になる (0埋めなし)", () => {
    const res = deriveOpeNoFromUnkoNo("26051900050300000018740");
    expect(res?.startOpe).toBe("2026/05/19 0:05:03");
  });
});
