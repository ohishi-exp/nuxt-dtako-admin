import { describe, it, expect } from "vitest";
import {
  buildKintaiDiff,
  buildKintaiDiffCacheSnapshot,
  gcpSummariesToMap,
  onpremKosokuDailyToMap,
  kintaiDiffCacheR2Paths,
  parseKintaiDiffCacheSnapshot,
  pickRecalcObservations,
  pickRestDiffGuarantee,
  deriveOpeNoFromUnkoNo,
  KINTAI_DIFF_MAX_ITEMS,
  KINTAI_DIFF_COMPARED_DAYS_MAX_ITEMS,
  type KintaiDiffResult,
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

    // ★ compared_days (Refs #633-3): 両側に行がある3件 (match/mismatch/完全一致) は
    // 「乗務員CD|暦日」(開始時刻を落として) で入る。only_gcp/only_onprem_* しか無い
    // 行 (KEY_ONLY_GCP/only_onprem_driver0/only_onprem_other) は入らない。
    expect(res.compared_days.items).toEqual(["2003|2026-06-04", "2004|2026-06-05", "2005|2026-06-06"]);
    expect(res.compared_days.total).toBe(3);
    expect(res.compared_days.capped).toBe(false);
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

describe("compared_days (Refs #633-3、親の実測 2026-08-04 で確定した原因への対応)", () => {
  it("★ 実例そのもの: 1445/2026-06-25 (日跨ぎ勤務) はどちら側にも行が無く、compared_days にも only_* にも出ない", () => {
    // 実測: 1445 は 06-24 20:56 開始の勤務 (拘束1326分=22時間06分) が 06-25 19:02 まで
    // 続くため、GCP day_summaries にもオンプレ kosoku-daily にも「06-25」という日の
    // 行はそもそも存在しない (運行の開始日と、折り畳んだ勤務の暦日がずれる)。
    const onprem = onpremBody([
      { driver: 1445, days: [day({ date: "2026-06-24", start: "2026-06-24 20:56:00", restraint_minutes: 1326 })] },
    ]);
    const gcp = gcpBody({
      "1445|2026-06-24|2026-06-24 20:56:00": { ...GCP_VALUE, restraint_minutes: 1326 },
    });
    const res = buildKintaiDiff(gcp, onprem);

    // 06-24 は両側にあるので compared_days に入る (値も完全一致なのでどの区分にも出ない)
    expect(res.compared_days.items).toEqual(["1445|2026-06-24"]);
    // 06-25 は compared_days にも、only_gcp/only_onprem_* のどの items にも出ない
    // (=front 側はこれを「day_absent」= 突き合わせていない、と読むべき)
    const allDayKeys = [
      ...res.compared_days.items,
      ...res.only_gcp.items.map((r) => `${r.driver_cd}|${r.date}`),
      ...res.only_onprem_driver0.items.map((r) => `${r.driver_cd}|${r.date}`),
      ...res.only_onprem_other.items.map((r) => `${r.driver_cd}|${r.date}`),
    ];
    expect(allDayKeys).not.toContain("1445|2026-06-25");
  });

  it("★ 実例そのもの: 1740/2026-06-06 は両側にあり値も違う → mismatch/match に出つつ compared_days にも入る", () => {
    const onprem = onpremBody([
      {
        driver: 1740,
        days: [
          day({
            date: "2026-06-06",
            start: "2026-06-06 08:22:00",
            restraint_minutes: 593,
            working_minutes: 534,
            break_minutes: 60,
            overtime_minutes: 54,
          }),
        ],
      },
    ]);
    const gcp = gcpBody({
      "1740|2026-06-06|2026-06-06 08:22:00": {
        ...GCP_VALUE,
        restraint_minutes: 593,
        working_minutes: 494,
        break_minutes: 100,
        overtime_minutes: 14,
      },
    });
    const res = buildKintaiDiff(gcp, onprem);

    expect(res.compared_days.items).toEqual(["1740|2026-06-06"]);
    // 拘束は一致 (593=593) なので match 側
    expect(res.value_diff_restraint_match.total).toBe(1);
    expect(res.value_diff_restraint_match.items[0]!.driver_cd).toBe("1740");
    expect(res.value_diff_restraint_mismatch.total).toBe(0);
  });

  it("同じ日に複数セッションがあっても compared_days は1つに畳む (重複除去)", () => {
    const onprem = onpremBody([
      {
        driver: 3001,
        days: [
          day({ date: "2026-06-10", start: "2026-06-10 08:00:00" }),
          day({ date: "2026-06-10", start: "2026-06-10 20:00:00" }),
        ],
      },
    ]);
    const gcp = gcpBody({
      "3001|2026-06-10|2026-06-10 08:00:00": GCP_VALUE,
      "3001|2026-06-10|2026-06-10 20:00:00": GCP_VALUE,
    });
    const res = buildKintaiDiff(gcp, onprem);
    expect(res.compared_days.items).toEqual(["3001|2026-06-10"]);
    expect(res.compared_days.total).toBe(1);
  });

  it(`${KINTAI_DIFF_COMPARED_DAYS_MAX_ITEMS} 件を超えたら capped: true で切る (他カテゴリの上限 (${KINTAI_DIFF_MAX_ITEMS}) より緩い)`, () => {
    const summaries: Record<string, unknown> = {};
    const drivers: Array<{ driver: number; days: unknown[] }> = [];
    for (let i = 0; i < KINTAI_DIFF_COMPARED_DAYS_MAX_ITEMS + 1; i++) {
      const driverCd = 4000 + i;
      const key = `${driverCd}|2026-06-01|2026-06-01 08:00:00`;
      summaries[key] = GCP_VALUE;
      drivers.push({ driver: driverCd, days: [day({ date: "2026-06-01", start: "2026-06-01 08:00:00" })] });
    }
    const res = buildKintaiDiff(gcpBody(summaries), onpremBody(drivers));
    expect(res.compared_days.total).toBe(KINTAI_DIFF_COMPARED_DAYS_MAX_ITEMS + 1);
    expect(res.compared_days.items).toHaveLength(KINTAI_DIFF_COMPARED_DAYS_MAX_ITEMS);
    expect(res.compared_days.capped).toBe(true);
  });

  it("ソートされる (front 側が Set/二分探索に頼らず順序を信頼できるように)", () => {
    const onprem = onpremBody([
      { driver: 9002, days: [day({ date: "2026-06-01", start: "2026-06-01 08:00:00" })] },
      { driver: 9001, days: [day({ date: "2026-06-02", start: "2026-06-02 08:00:00" })] },
    ]);
    const gcp = gcpBody({
      "9002|2026-06-01|2026-06-01 08:00:00": GCP_VALUE,
      "9001|2026-06-02|2026-06-02 08:00:00": GCP_VALUE,
    });
    const res = buildKintaiDiff(gcp, onprem);
    expect(res.compared_days.items).toEqual(["9001|2026-06-02", "9002|2026-06-01"]);
  });
});

describe("項目の欠損 (Refs #633-4、親の実測 2026-08-04 で確定した本番の偽陽性への対応)", () => {
  it("★ 実測そのもの: view=timecard でオンプレが rest_minus_minutes を欠いた行は、その項目を比較から除外する (欠損を0扱いして差をでっち上げない)", () => {
    // 実測: 1026|2026-06-14|23:25 は GCP側 rest_minus_minutes=209、
    // オンプレ (view=timecard) はキー自体が応答に無い。旧実装は toNumberOr0 で
    // 欠損を0に倒しており、209 と 0 の差を「値が違う」と誤検出していた
    // (2026-06 実測で「値が違う」26件中23件がこの型の偽陽性だった)。
    const onpremDay = day({ date: "2026-06-14", start: "2026-06-14 23:25:00" });
    delete (onpremDay as Record<string, unknown>).rest_minus_minutes;
    const onprem = onpremBody([{ driver: 1026, days: [onpremDay] }]);
    const gcp = gcpBody({ "1026|2026-06-14|2026-06-14 23:25:00": { ...GCP_VALUE, rest_minus_minutes: 209 } });

    const res = buildKintaiDiff(gcp, onprem);

    // rest_minus_minutes 以外は両側一致させてあるので、除外すれば差は0件
    expect(res.value_diff_restraint_match.total).toBe(0);
    expect(res.value_diff_restraint_mismatch.total).toBe(0);
    // 両側に行はあるので compared_days には入る (突き合わせ自体はできている、Refs #633-3 と矛盾しない)
    expect(res.compared_days.items).toEqual(["1026|2026-06-14"]);
    // 除外した項目は missing_fields に残す (front で「比較していません」と出すため)
    expect(res.missing_fields).toEqual(["rest_minus_minutes"]);
  });

  it("両側にあって値が違う項目は、従来どおり差として数える (回帰確認 — 欠損除外が本物の差まで消さないこと)", () => {
    // 実測: 1029|2026-06-14|20:33 (rest_minus_minutes が両側にあり値が違う想定)
    const onprem = onpremBody([
      { driver: 1029, days: [day({ date: "2026-06-14", start: "2026-06-14 20:33:00", rest_minus_minutes: 344 })] },
    ]);
    const gcp = gcpBody({ "1029|2026-06-14|2026-06-14 20:33:00": { ...GCP_VALUE, rest_minus_minutes: 209 } });

    const res = buildKintaiDiff(gcp, onprem);

    expect(res.value_diff_restraint_match.total).toBe(1);
    expect(res.value_diff_restraint_mismatch.total).toBe(0);
    expect(res.value_diff_restraint_match.items[0]!.diff_fields).toEqual(["rest_minus_minutes"]);
    expect(res.missing_fields).toEqual([]);
  });

  it("missing_fields は複数項目・複数行にまたがってもソート済みで重複除去される", () => {
    const day1 = day({ date: "2026-06-01", start: "2026-06-01 08:00:00" });
    delete (day1 as Record<string, unknown>).night_minutes;
    delete (day1 as Record<string, unknown>).rest_minus_minutes;
    const day2 = day({ date: "2026-06-02", start: "2026-06-02 08:00:00" });
    delete (day2 as Record<string, unknown>).rest_minus_minutes;
    const onprem = onpremBody([
      { driver: 2001, days: [day1] },
      { driver: 2002, days: [day2] },
    ]);
    const gcp = gcpBody({
      "2001|2026-06-01|2026-06-01 08:00:00": GCP_VALUE,
      "2002|2026-06-02|2026-06-02 08:00:00": GCP_VALUE,
    });
    const res = buildKintaiDiff(gcp, onprem);
    expect(res.missing_fields).toEqual(["night_minutes", "rest_minus_minutes"]);
  });

  it("restraint_minutes 自体が片側に無ければ match と断定せず mismatch 側へ倒す (保守的な既定 — 一致の確証が無いものを一致扱いしない)", () => {
    const onpremDay = day({ date: "2026-06-01", start: "2026-06-01 08:00:00" });
    delete (onpremDay as Record<string, unknown>).restraint_minutes;
    const onprem = onpremBody([{ driver: 3001, days: [onpremDay] }]);
    // break_minutes を変えて何らかの diff_fields は生じさせる (restraint 抜きでも比較対象が残る形)
    const gcp = gcpBody({ "3001|2026-06-01|2026-06-01 08:00:00": { ...GCP_VALUE, break_minutes: 999 } });
    const res = buildKintaiDiff(gcp, onprem);
    expect(res.value_diff_restraint_match.total).toBe(0);
    expect(res.value_diff_restraint_mismatch.total).toBe(1);
    expect(res.missing_fields).toContain("restraint_minutes");
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
      unko_diff_gcp_only_driver_split: {
        never_onprem_drivers: 41,
        never_onprem_ops: 399,
        also_in_month_drivers: 2,
        also_in_month_ops: 2,
        other_month_only_drivers: 3,
        other_month_only_ops: 16,
      },
      next_after_driver_cd: 1234,
    });
    expect(obs).toEqual({
      stale_drivers: 3,
      fold_would_write_drivers: 5,
      warnings: ["dtako 入力欠け: 乗務員12名の末尾が16日超"],
      unko_diff_gcp_only_in_month: 417,
      unko_diff_gcp_only_driver_split: {
        never_onprem_drivers: 41,
        never_onprem_ops: 399,
        also_in_month_drivers: 2,
        also_in_month_ops: 2,
        other_month_only_drivers: 3,
        other_month_only_ops: 16,
      },
      next_after_driver_cd: 1234,
    });
  });

  it("fold.drivers_written が無ければトップレベルの drivers_written へ落ちる", () => {
    const obs = pickRecalcObservations({ fold: {}, drivers_written: 9 });
    expect(obs.fold_would_write_drivers).toBe(9);
  });

  it("原型が壊れていても例外を投げず null/空配列/0 に倒す (未知の応答形への耐性)", () => {
    const emptySplit = {
      never_onprem_drivers: 0,
      never_onprem_ops: 0,
      also_in_month_drivers: 0,
      also_in_month_ops: 0,
      other_month_only_drivers: 0,
      other_month_only_ops: 0,
    };
    expect(pickRecalcObservations(null)).toEqual({
      stale_drivers: null,
      fold_would_write_drivers: null,
      warnings: [],
      unko_diff_gcp_only_in_month: null,
      unko_diff_gcp_only_driver_split: emptySplit,
      next_after_driver_cd: null,
    });
    expect(pickRecalcObservations("not-an-object")).toEqual({
      stale_drivers: null,
      fold_would_write_drivers: null,
      warnings: [],
      unko_diff_gcp_only_in_month: null,
      unko_diff_gcp_only_driver_split: emptySplit,
      next_after_driver_cd: null,
    });
  });

  it("unko_diff_gcp_only_driver_split が無ければ全フィールド 0 に倒す (合計との整合を壊さないため null にしない)", () => {
    const obs = pickRecalcObservations({});
    expect(obs.unko_diff_gcp_only_driver_split).toEqual({
      never_onprem_drivers: 0,
      never_onprem_ops: 0,
      also_in_month_drivers: 0,
      also_in_month_ops: 0,
      other_month_only_drivers: 0,
      other_month_only_ops: 0,
    });
  });

  it("unko_diff_gcp_only_driver_split が object でなければ無視する (壊れた形への耐性)", () => {
    const obs = pickRecalcObservations({ unko_diff_gcp_only_driver_split: "nope" });
    expect(obs.unko_diff_gcp_only_driver_split.also_in_month_ops).toBe(0);
  });

  it("unko_diff_gcp_only_driver_split の一部フィールドだけ欠けていたらそこだけ 0 に倒す", () => {
    const obs = pickRecalcObservations({
      unko_diff_gcp_only_driver_split: { also_in_month_drivers: 2, also_in_month_ops: 2 },
    });
    expect(obs.unko_diff_gcp_only_driver_split).toEqual({
      never_onprem_drivers: 0,
      never_onprem_ops: 0,
      also_in_month_drivers: 2,
      also_in_month_ops: 2,
      other_month_only_drivers: 0,
      other_month_only_ops: 0,
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

  it("日時部 (先頭12桁) がカレンダー上不正な値でも null にはせず機械的に切り出す", () => {
    // 年99(2099)・月13・日32・時25・分61・秒61 — 桁数・数字要件は満たすが暦として
    // 存在しない。意味的な妥当性は theearth 側 (push した結果) が判定する設計
    // (module docs 参照) — ここで弾くと「桁数は合っているのに落ちる」という別の
    // 失敗モードを作ってしまう
    const unkoNo = "99133225616100000018740";
    expect(unkoNo).toHaveLength(23);
    const res = deriveOpeNoFromUnkoNo(unkoNo);
    expect(res).toEqual({
      opeNo22: unkoNo.slice(0, 22),
      startOpe: "2099/13/32 25:61:61",
    });
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

describe("突合結果のキャッシュ (Refs #620-3)", () => {
  const OBSERVATIONS = {
    stale_drivers: 3,
    fold_would_write_drivers: 5,
    warnings: ["dtako 入力欠け: 乗務員12名の末尾が16日超"],
    unko_diff_gcp_only_in_month: 417,
    unko_diff_gcp_only_driver_split: {
      never_onprem_drivers: 41,
      never_onprem_ops: 399,
      also_in_month_drivers: 2,
      also_in_month_ops: 2,
      other_month_only_drivers: 3,
      other_month_only_ops: 16,
    },
    next_after_driver_cd: null,
  };

  /** [`KintaiDiffResult`] の最小形 (items はダミー1件ずつ — カテゴリの total/capped
   * だけを保存する仕様なので、items の中身自体はテストの関心事ではない)。 */
  function fullDiffResult(): KintaiDiffResult {
    const cat = <T,>(total: number, items: T[]): { total: number; capped: boolean; items: T[] } => ({
      total,
      capped: total > items.length,
      items,
    });
    return {
      gcp_rows: 10,
      onprem_rows: 8,
      onprem_unreadable: false,
      only_gcp: cat(1, [{ driver_cd: "1", date: "2026-06-01", start: "08:00", gcp: {} as never }]),
      only_onprem_driver0: cat(2, []),
      only_onprem_other: cat(0, []),
      value_diff_restraint_match: cat(0, []),
      value_diff_restraint_mismatch: cat(3, [{} as never]),
      compared_days: cat(5, ["1|2026-06-01"]),
      missing_fields: ["rest_minus_minutes"],
    };
  }

  describe("buildKintaiDiffCacheSnapshot / parseKintaiDiffCacheSnapshot", () => {
    it("フルの突合結果から items を捨てて total/capped だけのスナップショットを組む", () => {
      const snapshot = buildKintaiDiffCacheSnapshot("2026-06", fullDiffResult(), OBSERVATIONS, null);
      expect(snapshot).toEqual({
        month: "2026-06",
        diff: {
          gcp_rows: 10,
          onprem_rows: 8,
          onprem_unreadable: false,
          only_gcp: { total: 1, capped: false },
          only_onprem_driver0: { total: 2, capped: true },
          only_onprem_other: { total: 0, capped: false },
          value_diff_restraint_match: { total: 0, capped: false },
          value_diff_restraint_mismatch: { total: 3, capped: true },
          missing_fields: ["rest_minus_minutes"],
        },
        observations: OBSERVATIONS,
        observations_error: null,
      });
      // items は保存対象に含まれない (JSON化しても混ざっていない)
      expect(JSON.stringify(snapshot)).not.toMatch(/"items"/);
    });

    it("observations が無い (observations_error 付き) スナップショットも組める", () => {
      const snapshot = buildKintaiDiffCacheSnapshot("2026-06", fullDiffResult(), null, "GCP recalc に失敗しました");
      expect(snapshot.observations).toBeNull();
      expect(snapshot.observations_error).toBe("GCP recalc に失敗しました");
    });

    it("JSON round-trip (R2 に保存 → 読み出し) で完全一致する (正常系)", () => {
      const snapshot = buildKintaiDiffCacheSnapshot("2026-06", fullDiffResult(), OBSERVATIONS, null);
      const roundTripped = parseKintaiDiffCacheSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(roundTripped).toEqual(snapshot);
    });

    it("observations が null のスナップショットも round-trip できる", () => {
      const snapshot = buildKintaiDiffCacheSnapshot("2026-06", fullDiffResult(), null, "err");
      const roundTripped = parseKintaiDiffCacheSnapshot(JSON.parse(JSON.stringify(snapshot)));
      expect(roundTripped).toEqual(snapshot);
    });

    it("★ #633-4 より前に保存された旧スナップショット (missing_fields 無し) も読める (空配列に倒す、unreadable にしない)", () => {
      const legacy = {
        month: "2026-06",
        diff: {
          gcp_rows: 10,
          onprem_rows: 8,
          onprem_unreadable: false,
          only_gcp: { total: 1, capped: false },
          only_onprem_driver0: { total: 2, capped: true },
          only_onprem_other: { total: 0, capped: false },
          value_diff_restraint_match: { total: 0, capped: false },
          value_diff_restraint_mismatch: { total: 3, capped: true },
          // missing_fields キー自体が無い (旧形式)
        },
        observations: null,
        observations_error: null,
      };
      const res = parseKintaiDiffCacheSnapshot(legacy);
      expect(res).not.toBeNull();
      expect(res?.diff.missing_fields).toEqual([]);
    });

    it("missing_fields に未知の文字列/非文字列が混ざっていたら除く (フィールド名の集合だけ通す)", () => {
      const res = parseKintaiDiffCacheSnapshot({
        month: "2026-06",
        diff: {
          gcp_rows: 10,
          onprem_rows: 8,
          onprem_unreadable: false,
          only_gcp: { total: 1, capped: false },
          only_onprem_driver0: { total: 2, capped: true },
          only_onprem_other: { total: 0, capped: false },
          value_diff_restraint_match: { total: 0, capped: false },
          value_diff_restraint_mismatch: { total: 3, capped: true },
          missing_fields: ["rest_minus_minutes", "not_a_real_field", 123, null],
        },
      });
      expect(res?.diff.missing_fields).toEqual(["rest_minus_minutes"]);
    });

    it("raw が null / オブジェクトでない場合は null を返す (読めなかった扱い)", () => {
      expect(parseKintaiDiffCacheSnapshot(null)).toBeNull();
      expect(parseKintaiDiffCacheSnapshot(undefined)).toBeNull();
      expect(parseKintaiDiffCacheSnapshot("not-an-object")).toBeNull();
      expect(parseKintaiDiffCacheSnapshot(42)).toBeNull();
    });

    it("month が文字列でなければ null", () => {
      expect(parseKintaiDiffCacheSnapshot({ month: 202606, diff: {} })).toBeNull();
      expect(parseKintaiDiffCacheSnapshot({ diff: {} })).toBeNull();
    });

    it("diff が無い/オブジェクトでなければ null", () => {
      expect(parseKintaiDiffCacheSnapshot({ month: "2026-06" })).toBeNull();
      expect(parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: null })).toBeNull();
      expect(parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: "nope" })).toBeNull();
    });

    const validDiff = () => ({
      gcp_rows: 10,
      onprem_rows: 8,
      onprem_unreadable: false,
      only_gcp: { total: 1, capped: false },
      only_onprem_driver0: { total: 2, capped: true },
      only_onprem_other: { total: 0, capped: false },
      value_diff_restraint_match: { total: 0, capped: false },
      value_diff_restraint_mismatch: { total: 3, capped: true },
    });

    it.each([
      "only_gcp",
      "only_onprem_driver0",
      "only_onprem_other",
      "value_diff_restraint_match",
      "value_diff_restraint_mismatch",
    ] as const)("5区分のうち %s が壊れていれば null (total/capped 欠け・非オブジェクトを個別に確認)", (key) => {
      const brokenMissingTotal = { ...validDiff(), [key]: { capped: false } };
      expect(parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: brokenMissingTotal })).toBeNull();
      const brokenNotObject = { ...validDiff(), [key]: "nope" };
      expect(parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: brokenNotObject })).toBeNull();
      const brokenNull = { ...validDiff(), [key]: null };
      expect(parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: brokenNull })).toBeNull();
    });

    it("gcp_rows/onprem_rows/onprem_unreadable の型が違えば null", () => {
      expect(
        parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: { ...validDiff(), gcp_rows: "10" } }),
      ).toBeNull();
      expect(
        parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: { ...validDiff(), onprem_rows: "8" } }),
      ).toBeNull();
      expect(
        parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: { ...validDiff(), onprem_unreadable: "false" } }),
      ).toBeNull();
    });

    it("observations が null なら結果も null (差の有無とは無関係に読める)", () => {
      const res = parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: validDiff(), observations: null });
      expect(res?.observations).toBeNull();
    });

    it("observations キーが無ければ null 扱い", () => {
      const res = parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: validDiff() });
      expect(res?.observations).toBeNull();
    });

    it("observations がオブジェクトでない (壊れた形) 場合は observations: null に倒す (例外を投げない)", () => {
      const res = parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: validDiff(), observations: "nope" });
      expect(res?.observations).toBeNull();
    });

    it("observations は保存時と同じ平らな形で読む (warnings が配列でなければ空配列に倒す)", () => {
      const res = parseKintaiDiffCacheSnapshot({
        month: "2026-06",
        diff: validDiff(),
        observations: { stale_drivers: 1, warnings: "not-an-array" },
      });
      expect(res?.observations).toEqual({
        stale_drivers: 1,
        fold_would_write_drivers: null,
        warnings: [],
        unko_diff_gcp_only_in_month: null,
        unko_diff_gcp_only_driver_split: {
          never_onprem_drivers: 0,
          never_onprem_ops: 0,
          also_in_month_drivers: 0,
          also_in_month_ops: 0,
          other_month_only_drivers: 0,
          other_month_only_ops: 0,
        },
        next_after_driver_cd: null,
      });
    });

    it("observations_error が文字列でなければ null に倒す", () => {
      const res = parseKintaiDiffCacheSnapshot({ month: "2026-06", diff: validDiff(), observations_error: 123 });
      expect(res?.observations_error).toBeNull();
    });
  });

  describe("kintaiDiffCacheR2Paths", () => {
    it("`${prefix}/${compId}/kintai-diff/${ym}` を基点に latest/version(ts) を組む", () => {
      const paths = kintaiDiffCacheR2Paths("restraint", "27324455", "2026-06");
      expect(paths.dir).toBe("restraint/27324455/kintai-diff/2026-06");
      expect(paths.latest).toBe("restraint/27324455/kintai-diff/2026-06/latest.json");
      expect(paths.version("20260803T211500")).toBe(
        "restraint/27324455/kintai-diff/2026-06/v-20260803T211500.json",
      );
    });
  });
});
