/**
 * `get_kushiro_branch_estimate` (Refs #760 の 34)。
 *
 * 試算そのもの (組み直しの式・分類・欠測の扱い) は双子 util 側のテスト
 * (`kushiro-doto-rebuild.test.ts`) が共有 fixture + golden で固定している。
 * ここが見るのは **tool の配線** — 引数の既定値・座標の上書き・最低賃金マスタの
 * 引き方・一番星との突合・警告・上流失敗をそのまま投げること。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getKushiroBranchEstimateTool } from "../src/mcp/tools";
import { createMockR2 } from "./helpers/mock-r2";
import { DEPOTS } from "../src/depot-distance";
import type { Env } from "../src/env";
import rawOperations from "../../../tests/fixtures/kushiro-loading/doto-operations-2026-07.json";
import measured from "../../../tests/fixtures/kushiro-loading/doto-measured-2026-07.json";
import golden from "../../../tests/fixtures/kushiro-loading/golden/doto-2026-07.json";

type Args = Parameters<typeof getKushiroBranchEstimateTool.execute>[1];

/** 共有 fixture をそのまま tool の引数に渡せる (`kmBreakdown` 等も受け付ける)。 */
const OPERATIONS = rawOperations as unknown as Args["operations"];

/**
 * **本番と同じ形の min-wage マスタ** — `branchToPrefecture` は社員マスタ由来なので
 * **実在しない `釧路営業所` は載らない**し、`defaultPrefecture` も無い。
 * 2026-08-24 に本番で `get_kushiro_branch_estimate` を叩いたら、この形のせいで
 * `prefecture: null / rate: null` になり最低賃金の比較が丸ごと出なかった。
 */
const MIN_WAGE_MASTER = {
  prefectures: {
    // **本番の実測をそのまま写した** (2026-08-23、`master_effective_froms: ["2025-10-04"]` /
    // `rate: 1075`)。額をずらすと結論が変わるので、実測から動かさないこと。
    北海道: [{ effectiveFrom: "2025-10-04", rate: 1075 }],
    東京都: [{ effectiveFrom: "2025-10-01", rate: 1226 }],
  },
  branchToPrefecture: { 帯広: "北海道", 本社: "東京都" },
};

/** 北海道の最低賃金 (本番実測)。テストの期待値に直書きしないための 1 か所。 */
const HOKKAIDO_MIN_WAGE_YEN = 1075;

function env(over: Partial<Env> = {}, master: unknown = MIN_WAGE_MASTER): Env {
  return {
    DTAKO_R2: createMockR2(
      master === null
        ? {}
        : { "restraint/27324455/min-wage/latest.json": { value: JSON.stringify(master) } },
    ),
    RESTRAINT_R2_PREFIX: "restraint",
    NUXT_ICHIBAN_API_URL: "https://rust-ichiban.example.com",
    NUXT_ICHIBAN_CF_ACCESS_CLIENT_ID: "cid.access",
    ICHIBAN_CF_ACCESS_CLIENT_SECRET: { get: async () => "csecret" },
    ...over,
  } as Env;
}

function baseArgs(over: Partial<Args> = {}): Args {
  return {
    company: "27324455",
    from: "2026-07-01",
    to: "2026-08-01",
    operations: OPERATIONS,
    sales_cross_check: false,
    ...over,
  } as Args;
}

/** 一番星の売上明細 1 件ぶんの応答。 */
function salesBody(amount: number, rows = 1) {
  return {
    source_table: "sales",
    data: Array.from({ length: rows }, () => ({ sale_date: "2026-07-01", amount })),
  };
}

function mockIchiban(bodies: unknown[] | (() => Response)): void {
  if (typeof bodies === "function") {
    vi.stubGlobal("fetch", vi.fn(async () => bodies()));
    return;
  }
  let i = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(bodies[i++ % bodies.length]), { status: 200 })),
  );
}

type Result = Awaited<ReturnType<typeof getKushiroBranchEstimateTool.execute>> & {
  estimated: boolean;
  warnings: string[];
  summary: Record<string, unknown>;
  min_wage: Record<string, unknown>;
  legs_per_day: Record<string, unknown>;
  sensitivity: Record<string, Record<string, unknown>[]>;
  break_even_legs_per_day: Record<string, number | null>;
  labor_cost: Record<string, unknown>;
  input: Record<string, number>;
  depot: string;
  depot_points: Record<string, { lat: number; lng: number }>;
  dest_area: string;
  routes: Record<string, unknown>[];
  drivers: Record<string, unknown>[];
  sales_cross_check: Record<string, unknown> | null;
};

const run = (e: Env, a: Args) => getKushiroBranchEstimateTool.execute(e, a) as Promise<Result>;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("get_kushiro_branch_estimate — 既定の呼び出し", () => {
  it("実在しない試算であることを応答で明示する", async () => {
    const res = await run(env(), baseArgs());
    expect(res.estimated).toBe(true);
    expect(res.estimate_note).toContain("釧路営業所は実在しない");
    expect(res.depot).toBe("kushiro");
    expect(res.dest_area).toBe("doto");
    expect(res.depot_points).toEqual(DEPOTS);
  });

  it("対象は 道東卸し 38 便 / 23 運行 で、実測の集計に戻る", async () => {
    const res = await run(env(), baseArgs());
    expect(res.summary.legs).toBe(measured.legs);
    expect(res.summary.operations).toBe(measured.operations);
    expect(res.summary.sales_yen).toBe(measured.salesYen);
    expect(res.summary.allowance_yen).toBe(measured.allowanceYen);
    expect(res.summary.haul_km).toBeCloseTo(measured.haulKm, 6);
    expect(res.summary.measured_deadhead_km).toBeCloseTo(measured.deadheadKm, 6);
    expect(res.summary.missing_legs).toBe(0);
  });

  it("便/日 の既定は実測の分布の平均 (定数で埋めない)", async () => {
    const res = await run(env(), baseArgs());
    expect(res.legs_per_day.source).toBe("measured");
    expect(res.legs_per_day.value).toBeCloseTo(measured.legs / measured.operations, 12);
    expect(res.legs_per_day.measured_mean).toBe(res.legs_per_day.value);
    expect(res.legs_per_day.buckets).toEqual([
      { legs_in_operation: 1, operations: 11 },
      { legs_in_operation: 2, operations: 9 },
      { legs_in_operation: 3, operations: 3 },
    ]);
    expect(res.summary.runs_for_legs_per_day).toBeCloseTo(measured.operations, 9);
  });

  it("受け取った運行ペイロードをそのまま数え直して返す (貼り間違いに気づけるように)", async () => {
    const res = await run(env(), baseArgs());
    expect(res.input.operations).toBe(measured.operations);
    // 絞り込み前なので、道東 38 便より多い (十勝卸し・広尾積みも入っている)
    expect(res.input.legs).toBeGreaterThan(measured.legs);
    expect(res.input.sales_yen).toBeGreaterThan(measured.salesYen);
    expect(res.input.allowance_yen).toBeGreaterThan(measured.allowanceYen);
  });

  it("回送の推定・差・較正比は双子 util の golden と同じ値を返す", async () => {
    const res = await run(env(), baseArgs());
    const km = res.summary.rebuilt_deadhead_km as Record<string, number>;
    expect(km.kushiro).toBeCloseTo(golden.doto.rebuiltDeadheadKm.kushiro, 9);
    expect(km.obihiro).toBeCloseTo(golden.doto.rebuiltDeadheadKm.obihiro, 9);
    expect(res.summary.depot_diff_km).toBeCloseTo(golden.doto.depotDiffKm, 9);
    // 釧路積み・道東卸しなら釧路営業所の方が短い
    expect(res.summary.depot_diff_km as number).toBeLessThan(0);
    const ratio = res.summary.calibration_ratio as Record<string, number>;
    expect(ratio.kushiro).toBeCloseTo(golden.doto.calibrationRatio.kushiro, 9);
  });

  it("拘束は下限であることを旗で明示し、実測の速度も出す", async () => {
    const res = await run(env(), baseArgs());
    const byDepot = res.summary.restraint_hours as Record<string, Record<string, unknown>>;
    // **両営業所ぶん返る** (片側だけ返すと「帯広を基準に比較」ができない)
    expect(Object.keys(byDepot).sort()).toEqual(["kushiro", "obihiro"]);
    const hours = byDepot.kushiro!;
    expect(hours.restraint_is_lower_bound).toBe(true);
    // 実測は組み直し前の話なので、どちらの営業所でも同じ値
    for (const d of ["kushiro", "obihiro"]) {
      expect(byDepot[d]!.measured_haul).toBeCloseTo(measured.haulHours, 6);
      expect(byDepot[d]!.measured_deadhead).toBeCloseTo(measured.deadheadHours, 6);
    }
    expect(hours.rebuilt_total).toBeCloseTo(golden.doto.restraint.kushiro.rebuiltTotalHours, 9);
    expect(byDepot.obihiro!.rebuilt_total).toBeCloseTo(golden.doto.restraint.obihiro.rebuiltTotalHours, 9);
    const speed = res.summary.measured_speed_kmh as Record<string, number>;
    expect(speed.deadhead).toBeCloseTo(measured.deadheadKm / measured.deadheadHours, 6);
  });

  it("必要乗務員数は 帯広実績 57 便/月 の切り上げ (引数で上書きできる)", async () => {
    const res = await run(env(), baseArgs());
    expect(res.summary.legs_per_driver_month).toBe(57);
    expect(res.summary.required_drivers).toBe(1);
    const forced = await run(env(), baseArgs({ legs_per_driver_month: 10 }));
    expect(forced.summary.required_drivers).toBe(4);
  });

  it("行 (経路別・乗務員別) を足すと全体に戻る", async () => {
    const res = await run(env(), baseArgs());
    for (const rows of [res.routes, res.drivers]) {
      const legs = rows.reduce((a, r) => a + (r.legs as number), 0);
      const km = rows.reduce((a, r) => a + ((r.rebuilt_deadhead_km as Record<string, number>).kushiro), 0);
      expect(legs).toBe(res.summary.legs);
      expect(km).toBeCloseTo((res.summary.rebuilt_deadhead_km as Record<string, number>).kushiro, 6);
    }
    expect(res.routes.map((r) => r.to)).toEqual(["標茶", "別海"]);
    expect(res.routes.every((r) => r.doto === true)).toBe(true);
    expect(res.drivers[0]!.driver_name).toBe("中村 一由");
  });

  it("警告は 所属がマスタに無いことと 人件費の前提が無いことだけ (対象と座標は揃っている)", async () => {
    const res = await run(env(), baseArgs());
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings[0]).toContain("branch→都道府県表にありません");
    expect(res.warnings[1]).toContain("人件費の前提がありません");
    // 所属がマスタにある乗務員 + 人件費を渡せば警告は消える
    const clean = await run(env(), baseArgs({ branch: "帯広", monthly_labor_cost_yen: 400000 }));
    expect(clean.warnings).toEqual([]);
  });
});

describe("両営業所ぶん返る (帯広の乗務員を基準に比較できる)", () => {
  /** 片側しか返らない値があると、画面が「両方出ている」と誤解する。 */
  it("回送km・拘束・時給・最賃差・感度分析・損益分岐が 1 回の呼び出しで両方そろう", async () => {
    const res = await run(env(), baseArgs({ depot: "kushiro" }));
    const keys = ["kushiro", "obihiro"];
    for (const field of [
      res.summary.rebuilt_deadhead_km,
      res.summary.calibration_ratio,
      res.summary.restraint_hours,
      res.min_wage.hourly_yen,
      res.min_wage.restraint_hours_per_driver,
      res.min_wage.diff_yen,
      res.min_wage.below_min_wage,
      res.sensitivity,
      res.break_even_legs_per_day,
    ]) {
      expect(Object.keys(field as Record<string, unknown>).sort()).toEqual(keys);
    }
  });

  it("換算時給は両営業所とも双子 util の golden と一致する", async () => {
    const res = await run(env(), baseArgs());
    const hourly = res.min_wage.hourly_yen as Record<string, number>;
    for (const d of ["kushiro", "obihiro"] as const) {
      expect(hourly[d]).toBeCloseTo(
        measured.allowanceYen / golden.doto.restraint[d].rebuiltTotalHours, 6);
    }
    // 釧路の方が拘束が短いぶん時給は高く出る (この案件の結論そのもの)
    expect(hourly.kushiro!).toBeGreaterThan(hourly.obihiro!);
  });

  it("depot を変えても両営業所の値は変わらない (本命のラベルが変わるだけ)", async () => {
    const k = await run(env(), baseArgs({ depot: "kushiro" }));
    const o = await run(env(), baseArgs({ depot: "obihiro" }));
    expect(o.depot).toBe("obihiro");
    expect(o.min_wage.hourly_yen).toEqual(k.min_wage.hourly_yen);
    expect(o.summary.restraint_hours).toEqual(k.summary.restraint_hours);
    expect(o.sensitivity).toEqual(k.sensitivity);
    expect(o.break_even_legs_per_day).toEqual(k.break_even_legs_per_day);
  });

  it("depot が効くのは座標の上書き先だけ", async () => {
    const res = await run(env(), baseArgs({ depot: "obihiro", depot_lat: 43.0, depot_lng: 144.4 }));
    expect(res.depot_points.obihiro).toEqual({ lat: 43.0, lng: 144.4 });
    expect(res.depot_points.kushiro).toEqual(DEPOTS.kushiro);
  });
});

describe("引数", () => {
  it("depot / dest_area / legs_per_day / branch を上書きできる", async () => {
    const res = await run(
      env(),
      baseArgs({ depot: "obihiro", dest_area: "all", legs_per_day: 2, branch: "帯広" }),
    );
    expect(res.depot).toBe("obihiro");
    expect(res.dest_area).toBe("all");
    expect(res.legs_per_day.value).toBe(2);
    expect(res.legs_per_day.source).toBe("given");
    expect(res.min_wage.branch).toBe("帯広");
    // 十勝卸しの便が混ざるので便数が増え、卸地に道東でない行が出る
    expect(res.summary.legs).toBeGreaterThan(measured.legs);
    expect(res.routes.some((r) => r.doto === false)).toBe(true);
  });

  it("depot_lat / depot_lng は選んだ営業所の座標だけを差し替える", async () => {
    const res = await run(env(), baseArgs({ depot_lat: 43.0, depot_lng: 144.4 }));
    expect(res.depot_points.kushiro).toEqual({ lat: 43.0, lng: 144.4 });
    expect(res.depot_points.obihiro).toEqual(DEPOTS.obihiro);
    const base = await run(env(), baseArgs());
    expect((res.summary.rebuilt_deadhead_km as Record<string, number>).kushiro)
      .not.toBeCloseTo((base.summary.rebuilt_deadhead_km as Record<string, number>).kushiro, 3);
  });

  it("座標の片方だけ / 範囲外は弾く", async () => {
    await expect(run(env(), baseArgs({ depot_lat: 43.0 }))).rejects.toThrow("対で指定");
    await expect(run(env(), baseArgs({ depot_lng: 144.4 }))).rejects.toThrow("対で指定");
    await expect(run(env(), baseArgs({ depot_lat: 1000, depot_lng: 0 }))).rejects.toThrow("範囲外");
  });

  it("期間が逆 / 月が壊れていれば弾く", async () => {
    await expect(run(env(), baseArgs({ to: "2026-07-01" }))).rejects.toThrow("半開区間");
    await expect(run(env(), baseArgs({ from: "2026-13-01" }))).rejects.toThrow("YYYY-MM-DD");
  });

  it("運行NO・GPS・秒が欠けていても受け取れる (0 に倒さない)", async () => {
    const res = await run(
      env(),
      baseArgs({
        operations: [
          {
            driverName: "試験 太郎",
            legs: [
              {
                seq: 1,
                originCity: "北海道釧路市西港1-98-41",
                destCity: "北海道川上郡標茶町多和",
                salesYen: 36000,
                allowanceYen: 8000,
                haulKm: 60,
                deadheadKm: 120,
              },
            ],
          },
        ] as unknown as Args["operations"],
      }),
    );
    expect(res.summary.legs).toBe(1);
    expect(res.summary.missing_legs).toBe(1);
    expect(res.summary.estimated_legs).toBe(0);
    expect(res.warnings.some((w) => w.includes("座標が欠けた便"))).toBe(true);
    // 秒が 1 つも無いので速度が出ず、組み直し後の拘束は null (既定値に落とさない)
    const hoursByDepot = res.summary.restraint_hours as Record<string, Record<string, unknown>>;
    for (const d of ["kushiro", "obihiro"]) {
      expect(hoursByDepot[d]!.rebuilt_total).toBeNull();
      expect((res.min_wage.hourly_yen as Record<string, unknown>)[d]).toBeNull();
      expect((res.min_wage.restraint_hours_per_driver as Record<string, unknown>)[d]).toBeNull();
      expect((res.min_wage.diff_yen as Record<string, unknown>)[d]).toBeNull();
      expect((res.min_wage.below_min_wage as Record<string, unknown>)[d]).toBeNull();
    }
  });

  it("対象便が 1 本も無ければ推定を出さず、警告を出す", async () => {
    const res = await run(
      env(),
      baseArgs({
        operations: [
          {
            driverName: "試験 太郎",
            legs: [
              {
                seq: 1,
                originCity: "北海道広尾郡広尾町白樺通",
                destCity: "北海道帯広市川西町",
                salesYen: 1,
                allowanceYen: 1,
                haulKm: 1,
                deadheadKm: 1,
              },
            ],
          },
        ] as unknown as Args["operations"],
      }),
    );
    expect(res.summary.legs).toBe(0);
    expect(res.legs_per_day.value).toBeNull();
    expect(res.summary.runs_for_legs_per_day).toBeNull();
    expect(res.summary.rebuilt_deadhead_km).toEqual({ obihiro: null, kushiro: null });
    expect(res.summary.rebuilt_minus_measured_km).toBeNull();
    expect(res.summary.depot_diff_km).toBeNull();
    expect(res.summary.rebuilt_operations).toBeNull();
    expect(res.summary.calibration_ratio).toEqual({ obihiro: null, kushiro: null });
    expect(res.summary.restraint_hours).toEqual({ obihiro: null, kushiro: null });
    expect(res.summary.deadhead_fuel_yen).toBeNull();
    expect(res.warnings.some((w) => w.includes("便が 1 本もありません"))).toBe(true);
  });
});

describe("便/日 の感度分析 (想定値を固定しない)", () => {
  it("既定は 1 / 実測平均 / 2 / 3 の 4 点", async () => {
    const res = await run(env(), baseArgs());
    expect(res.sensitivity.kushiro!.map((r) => r.legs_per_day)).toEqual([
      1,
      measured.legs / measured.operations,
      2,
      3,
    ]);
    expect(res.sensitivity.kushiro!.map((r) => r.legs_per_day)).toEqual(
      golden.doto.sensitivity.map((r) => r.legsPerDay),
    );
  });

  it("便/日 を増やすと 稼働日数・回送・拘束が減り、換算時給が上がる", async () => {
    const res = await run(env(), baseArgs());
    const rows = res.sensitivity.kushiro!;
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i]!.runs as number).toBeLessThan(rows[i - 1]!.runs as number);
      expect(rows[i]!.rebuilt_deadhead_km as number).toBeLessThan(rows[i - 1]!.rebuilt_deadhead_km as number);
      expect(rows[i]!.restraint_hours as number).toBeLessThan(rows[i - 1]!.restraint_hours as number);
      expect(rows[i]!.hourly_yen as number).toBeGreaterThan(rows[i - 1]!.hourly_yen as number);
    }
    // 必要乗務員数は 便/日 で動く (便の量だけで数えると動かない)
    const drivers = rows.map((r) => (r.required_drivers as Record<string, number>).drivers);
    expect(drivers[0]).toBeGreaterThan(drivers[drivers.length - 1]!);
    expect(res.summary.required_drivers).toBe(1);
  });

  it("双子 util の golden と同じ値を返す", async () => {
    const res = await run(env(), baseArgs());
    for (const [i, row] of res.sensitivity.kushiro!.entries()) {
      const g = golden.doto.sensitivity[i]!;
      expect(row.rebuilt_deadhead_km as number).toBeCloseTo(g.rebuiltDeadheadKm, 9);
      expect(row.restraint_hours as number).toBeCloseTo(g.restraint.rebuiltTotalHours, 9);
      expect(row.hourly_yen as number).toBeCloseTo(g.hourlyYen, 9);
      expect((row.required_drivers as Record<string, number>).drivers).toBe(g.requiredDrivers.drivers);
    }
  });

  it("候補は引数で差し替えられる (昇順・重複除去)", async () => {
    const res = await run(env(), baseArgs({ sensitivity_legs_per_day: [4, 1, 4] }));
    expect(res.sensitivity.kushiro!.map((r) => r.legs_per_day)).toEqual([1, 4]);
  });

  it("運行キャパも引数で上書きできる (便/日 が人数に効く経路)", async () => {
    const res = await run(env(), baseArgs({ runs_per_driver_month: 5 }));
    expect(res.summary.runs_per_driver_month).toBe(5);
    // 1 便/日 = 38 日 → 38 ÷ 5 = 8 名
    expect((res.sensitivity.kushiro![0]!.required_drivers as Record<string, number>).by_runs).toBe(8);
  });

  it("対象便が 0 なら実測平均が無いので整数 3 点だけ並べる", async () => {
    const res = await run(
      env(),
      baseArgs({
        operations: [
          {
            driverName: "試験 太郎",
            legs: [
              {
                seq: 1,
                originCity: "北海道広尾郡広尾町白樺通",
                destCity: "北海道帯広市川西町",
                salesYen: 1,
                allowanceYen: 1,
                haulKm: 1,
                deadheadKm: 1,
              },
            ],
          },
        ] as unknown as Args["operations"],
      }),
    );
    expect(res.sensitivity.kushiro!.map((r) => r.legs_per_day)).toEqual([1, 2, 3]);
  });
});

describe("最低賃金の額が結論を変える (本番実測 ¥1,075 で固定)", () => {
  it("帯広発 2 便/日 は最低賃金を割り、釧路発はどの便/日 でも割らない", async () => {
    const res = await run(env(), baseArgs());
    const at = (depot: string, n: number) =>
      res.sensitivity[depot]!.find((r) => r.legs_per_day === n)!;
    // **旧テストの ¥1,010 なら +44 で「足りている」と読めた行が、実測の ¥1,075 では割る**
    expect(at("obihiro", 2).below_min_wage).toBe(true);
    expect(at("obihiro", 2).min_wage_diff_yen as number).toBeLessThan(0);
    expect(at("obihiro", 2).hourly_yen as number).toBeGreaterThan(1010);
    // 帯広発でも 3 便/日 まで積めば上回る (どこで反転するかが判断の分かれ目)
    expect(at("obihiro", 3).below_min_wage).toBe(false);
    expect(at("obihiro", 1).below_min_wage).toBe(true);
    for (const row of res.sensitivity.kushiro!) {
      expect(row.below_min_wage).toBe(false);
    }
  });

  it("マスタの額を ¥1,010 に戻すと 帯広発 2 便/日 の判定が反転する (額が結論を決める)", async () => {
    const cheap = await run(
      env({}, {
        prefectures: { 北海道: [{ effectiveFrom: "2025-10-04", rate: 1010 }] },
        branchToPrefecture: {},
      }),
      baseArgs(),
    );
    const row = cheap.sensitivity.obihiro!.find((r) => r.legs_per_day === 2)!;
    expect(cheap.min_wage.rate).toBe(1010);
    expect(row.below_min_wage).toBe(false);
    expect(row.min_wage_diff_yen as number).toBeGreaterThan(0);
  });
});

describe("人件費と損益分岐", () => {
  it("引数があればそれを使い、営業利益と損益分岐を出す", async () => {
    const res = await run(env(), baseArgs({
      monthly_labor_cost_yen: 400000,
      km_per_liter: 3,
      yen_per_liter: 150,
    }));
    expect(res.labor_cost.source).toBe("argument");
    expect(res.labor_cost.monthly_per_driver_yen).toBe(400000);
    expect(res.break_even_legs_per_day.kushiro).toBe(golden.doto.breakEvenLegsPerDay);
    const row = res.sensitivity.kushiro![0]!;
    expect(row.labor_cost_yen).toBe(400000 * (row.required_drivers as Record<string, number>).drivers);
    expect(row.operating_margin_yen).toBeCloseTo(
      (row.margin_yen as number) - (row.labor_cost_yen as number), 6);
  });

  it("引数が無ければ一番星の経費区分 08 (給与) を実績から引く", async () => {
    // 売上 5 本 → 経費 5 本 の順で返す
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        call += 1;
        const isCost = String(url).includes("/api/costs/");
        expect(String(url).includes("kind=08")).toBe(isCost);
        return new Response(
          JSON.stringify(isCost ? { data: [{ amount: 500000 }] } : salesBody(1000000)),
          { status: 200 },
        );
      }),
    );
    const res = await run(env(), baseArgs({
      sales_cross_check: undefined,
      km_per_liter: 3,
      yen_per_liter: 150,
    }));
    expect(call).toBe(10);
    expect(res.labor_cost.source).toBe("ichiban");
    expect(res.labor_cost.monthly_per_driver_yen).toBe(500000);
    expect(res.break_even_legs_per_day.kushiro).not.toBeNull();
  });

  it("一番星に給与が 1 円も無ければ人件費を推測せず警告する", async () => {
    mockIchiban([{ data: [{ amount: 0 }] }]);
    const res = await run(env(), baseArgs({ sales_cross_check: undefined, driver: ["1412"] }));
    expect(res.labor_cost.source).toBe("none");
    expect(res.labor_cost.monthly_per_driver_yen).toBeNull();
    expect(res.break_even_legs_per_day.kushiro).toBeNull();
    expect(res.warnings.some((w) => w.includes("給与"))).toBe(true);
  });

  it("上流を止めていて人件費の引数も無ければ、営業利益は出さず警告する", async () => {
    const res = await run(env(), baseArgs());
    expect(res.labor_cost.source).toBe("none");
    expect(res.break_even_legs_per_day.kushiro).toBeNull();
    expect(res.sensitivity.kushiro![0]!.operating_margin_yen).toBeNull();
    expect(res.warnings.some((w) => w.includes("人件費の前提がありません"))).toBe(true);
  });
});

describe("最低賃金 (額は R2 のマスタから引く)", () => {
  it("実在しない営業所でも、会社の所在都道府県で額を引いて比べる (本番で出た欠陥の回帰)", async () => {
    const res = await run(env(), baseArgs());
    expect(res.min_wage.branch).toBe("釧路営業所");
    // 所属ではマスタに当たらない (実在しない営業所なので当然)
    expect(res.min_wage.mapped).toBe(false);
    // それでも県が決まり、額が引ける — **ここが null のままでは要件を満たさない**
    expect(res.min_wage.prefecture).toBe("北海道");
    expect(res.min_wage.prefecture_source).toBe("company-default");
    expect(res.min_wage.rate).toBe(HOKKAIDO_MIN_WAGE_YEN);
    expect(res.min_wage.master_effective_froms).toEqual(["2025-10-04"]);
    expect((res.min_wage.diff_yen as Record<string, number>).kushiro).not.toBeNull();
    expect((res.min_wage.below_min_wage as Record<string, boolean>).kushiro).toBe(false);
    expect(res.warnings.some((w) => w.includes("branch→都道府県表にありません"))).toBe(true);
  });

  it("所属がマスタにあれば、その県の対象月の額で比べる", async () => {
    const res = await run(env(), baseArgs({ branch: "帯広" }));
    expect(res.min_wage.branch).toBe("帯広");
    expect(res.min_wage.prefecture).toBe("北海道");
    expect(res.min_wage.mapped).toBe(true);
    expect(res.min_wage.prefecture_source).toBe("branch");
    // 2026-07 時点で有効なのは 2025-10-04 発効の 1,075 円 (本番実測と同じ)
    expect(res.min_wage.rate).toBe(HOKKAIDO_MIN_WAGE_YEN);
    expect(res.min_wage.rate_effective_from).toBe("2025-10-04");
    expect(res.min_wage.wage_basis).toBe("allowance-only");
    expect(res.min_wage.assumed_monthly_wage_yen).toBe(measured.allowanceYen);
    const hourly = (res.min_wage.hourly_yen as Record<string, number>).kushiro!;
    expect(hourly).toBeCloseTo(
      measured.allowanceYen / golden.doto.restraint.kushiro.rebuiltTotalHours,
      6,
    );
    expect((res.min_wage.diff_yen as Record<string, number>).kushiro)
      .toBeCloseTo(hourly - HOKKAIDO_MIN_WAGE_YEN, 6);
    expect((res.min_wage.below_min_wage as Record<string, boolean>).kushiro)
      .toBe(hourly < HOKKAIDO_MIN_WAGE_YEN);
  });

  it("想定賃金は引数で上書きできる (手当だけでは下限なので)", async () => {
    const res = await run(env(), baseArgs({ assumed_monthly_wage_yen: 100000 }));
    expect(res.min_wage.wage_basis).toBe("argument");
    expect(res.min_wage.assumed_monthly_wage_yen).toBe(100000);
    expect((res.min_wage.below_min_wage as Record<string, boolean>).kushiro).toBe(true);
  });

  it("都道府県は引数で指定できる (正式所在地が別の県になったとき用)", async () => {
    const res = await run(env(), baseArgs({ prefecture: "東京都" }));
    expect(res.min_wage.prefecture).toBe("東京都");
    expect(res.min_wage.prefecture_source).toBe("argument");
    expect(res.min_wage.rate).toBe(1226);
  });

  it("対象月に有効な額が無ければ null にし、マスタが持つ発効日を出して切り分けられるようにする", async () => {
    const res = await run(
      env({}, { prefectures: { 北海道: [{ effectiveFrom: "2027-10-01", rate: 1100 }] }, branchToPrefecture: {} }),
      baseArgs(),
    );
    // 県は決まっている (= 取り込み漏れ側の問題だと分かる)
    expect(res.min_wage.prefecture).toBe("北海道");
    expect(res.min_wage.rate).toBeNull();
    expect(res.min_wage.rate_effective_from).toBeNull();
    expect((res.min_wage.diff_yen as Record<string, unknown>).kushiro).toBeNull();
    expect((res.min_wage.below_min_wage as Record<string, unknown>).kushiro).toBeNull();
    expect(res.min_wage.master_effective_froms).toEqual(["2027-10-01"]);
    expect(res.warnings.some((w) => w.includes("2026-07 時点で有効な行がありません"))).toBe(true);
  });

  it("その県がマスタに 1 行も無ければ、それも警告で分かる", async () => {
    const res = await run(env({}, { prefectures: {}, branchToPrefecture: {} }), baseArgs());
    expect(res.min_wage.prefecture).toBe("北海道");
    expect(res.min_wage.master_effective_froms).toEqual([]);
    expect(res.warnings.some((w) => w.includes("1 件も無い"))).toBe(true);
  });

  it("マスタが R2 に無ければ比較を出さず警告する", async () => {
    const res = await run(env({}, null), baseArgs());
    // 県は決まるが、額の表が空なので rate は出せない
    expect(res.min_wage.prefecture).toBe("北海道");
    expect(res.min_wage.mapped).toBe(false);
    expect(res.min_wage.rate).toBeNull();
    expect(res.min_wage.master_effective_froms).toEqual([]);
    expect(res.warnings.some((w) => w.includes("min-wage/latest.json"))).toBe(true);
  });
});

describe("燃料代 (実績とは別立て)", () => {
  it("燃費と単価が揃ったときだけ出す", async () => {
    const res = await run(env(), baseArgs({ km_per_liter: 3, yen_per_liter: 150 }));
    const diff = res.summary.depot_diff_km as number;
    expect(res.summary.deadhead_fuel_yen).toBeCloseTo((diff / 3) * 150, 6);
    // 回送が減る側なので符号はマイナス (= 浮く額)
    expect(res.summary.deadhead_fuel_yen as number).toBeLessThan(0);
  });

  it("片方だけなら出さない", async () => {
    expect((await run(env(), baseArgs({ km_per_liter: 3 }))).summary.deadhead_fuel_yen).toBeNull();
    expect((await run(env(), baseArgs({ yen_per_liter: 150 }))).summary.deadhead_fuel_yen).toBeNull();
  });
});

describe("一番星の売上との突合", () => {
  it("既定 (省略) では突合する。乗務員は帯広 5 名", async () => {
    mockIchiban([salesBody(1000000)]);
    const res = await run(env(), baseArgs({ sales_cross_check: undefined }));
    const cross = res.sales_cross_check!;
    expect((cross.drivers as unknown[]).length).toBe(5);
    expect((cross.drivers as { driver: string }[]).map((d) => d.driver))
      .toEqual(["1412", "1587", "1656", "1732", "1742"]);
    expect(cross.total_amount).toBe(5000000);
    expect(cross.target_share).toBeCloseTo(measured.salesYen / 5000000, 9);
  });

  it("乗務員は引数で差し替えられる", async () => {
    mockIchiban([salesBody(2000)]);
    const res = await run(env(), baseArgs({ sales_cross_check: undefined, driver: ["1412"] }));
    expect((res.sales_cross_check!.drivers as unknown[]).length).toBe(1);
    expect(res.sales_cross_check!.total_amount).toBe(2000);
  });

  it("売上が 0 なら割合を出さない (0 除算をしない)", async () => {
    mockIchiban([salesBody(0)]);
    const res = await run(env(), baseArgs({ sales_cross_check: undefined, driver: ["1412"] }));
    expect(res.sales_cross_check!.target_share).toBeNull();
  });

  it("上流の 500 件で切られていたら警告する", async () => {
    mockIchiban([salesBody(10, 500)]);
    const res = await run(env(), baseArgs({ sales_cross_check: undefined, driver: ["1412"] }));
    expect(res.warnings.some((w) => w.includes("500 件"))).toBe(true);
  });

  it("上流の失敗はそのまま投げる (握り潰さない)", async () => {
    mockIchiban(() => new Response("boom", { status: 502 }));
    await expect(run(env(), baseArgs({ sales_cross_check: undefined, driver: ["1412"] })))
      .rejects.toThrow("rust-ichibanboshi が 502 を返しました");
  });

  it("false にすると上流を 1 回も叩かない (完全オフライン)", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const res = await run(env(), baseArgs({ sales_cross_check: false }));
    expect(spy).not.toHaveBeenCalled();
    expect(res.sales_cross_check).toBeNull();
  });
});
