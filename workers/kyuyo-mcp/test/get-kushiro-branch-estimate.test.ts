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

const MIN_WAGE_MASTER = {
  prefectures: {
    北海道: [
      { effectiveFrom: "2025-10-01", rate: 1010 },
      { effectiveFrom: "2026-10-01", rate: 1075 },
    ],
    東京都: [{ effectiveFrom: "2025-10-01", rate: 1226 }],
  },
  branchToPrefecture: { 釧路営業所: "北海道", 帯広: "北海道" },
  defaultPrefecture: "東京都",
};

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
  legs_per_run: Record<string, unknown>;
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

  it("legsPerRun は実測の分布の平均 (定数で埋めない)", async () => {
    const res = await run(env(), baseArgs());
    expect(res.legs_per_run.source).toBe("measured");
    expect(res.legs_per_run.used).toBeCloseTo(measured.legs / measured.operations, 12);
    expect(res.legs_per_run.measured_mean).toBe(res.legs_per_run.used);
    expect(res.legs_per_run.buckets).toEqual([
      { legs_in_operation: 1, operations: 8 },
      { legs_in_operation: 2, operations: 15 },
    ]);
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
    const hours = res.summary.restraint_hours as Record<string, unknown>;
    expect(hours.restraint_is_lower_bound).toBe(true);
    expect(hours.measured_haul).toBeCloseTo(measured.haulHours, 6);
    expect(hours.measured_deadhead).toBeCloseTo(measured.deadheadHours, 6);
    expect(hours.rebuilt_total).toBeCloseTo(golden.doto.restraint.kushiro.rebuiltTotalHours, 9);
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

  it("警告は無い (対象が揃っているとき)", async () => {
    const res = await run(env(), baseArgs());
    expect(res.warnings).toEqual([]);
  });
});

describe("引数", () => {
  it("depot / dest_area / legs_per_run / branch を上書きできる", async () => {
    const res = await run(
      env(),
      baseArgs({ depot: "obihiro", dest_area: "all", legs_per_run: 2, branch: "帯広" }),
    );
    expect(res.depot).toBe("obihiro");
    expect(res.dest_area).toBe("all");
    expect(res.legs_per_run.used).toBe(2);
    expect(res.legs_per_run.source).toBe("argument");
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
    expect((res.summary.restraint_hours as Record<string, unknown>).rebuilt_total).toBeNull();
    expect(res.min_wage.hourly_yen).toBeNull();
    expect(res.min_wage.restraint_hours_per_driver).toBeNull();
    expect(res.min_wage.diff_yen).toBeNull();
    expect(res.min_wage.below_min_wage).toBeNull();
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
    expect(res.legs_per_run.used).toBeNull();
    expect(res.summary.rebuilt_deadhead_km).toEqual({ obihiro: null, kushiro: null });
    expect(res.summary.rebuilt_minus_measured_km).toBeNull();
    expect(res.summary.depot_diff_km).toBeNull();
    expect(res.summary.rebuilt_operations).toBeNull();
    expect(res.summary.calibration_ratio).toEqual({ obihiro: null, kushiro: null });
    expect(res.summary.restraint_hours).toBeNull();
    expect(res.summary.deadhead_fuel_yen).toBeNull();
    expect(res.warnings.some((w) => w.includes("便が 1 本もありません"))).toBe(true);
  });
});

describe("最低賃金 (額は R2 のマスタから引く)", () => {
  it("所属がマスタにあれば、その県の対象月の額で比べる", async () => {
    const res = await run(env(), baseArgs());
    expect(res.min_wage.branch).toBe("釧路営業所");
    expect(res.min_wage.prefecture).toBe("北海道");
    expect(res.min_wage.mapped).toBe(true);
    // 2026-07 時点で有効なのは 2025-10-01 発効の 1010 円 (2026-10-01 はまだ先)
    expect(res.min_wage.rate).toBe(1010);
    expect(res.min_wage.rate_effective_from).toBe("2025-10-01");
    expect(res.min_wage.wage_basis).toBe("allowance-only");
    expect(res.min_wage.assumed_monthly_wage_yen).toBe(measured.allowanceYen);
    const hourly = res.min_wage.hourly_yen as number;
    expect(hourly).toBeCloseTo(
      measured.allowanceYen / golden.doto.restraint.kushiro.rebuiltTotalHours,
      6,
    );
    expect(res.min_wage.diff_yen).toBeCloseTo(hourly - 1010, 6);
    expect(res.min_wage.below_min_wage).toBe(hourly < 1010);
  });

  it("想定賃金は引数で上書きできる (手当だけでは下限なので)", async () => {
    const res = await run(env(), baseArgs({ assumed_monthly_wage_yen: 100000 }));
    expect(res.min_wage.wage_basis).toBe("argument");
    expect(res.min_wage.assumed_monthly_wage_yen).toBe(100000);
    expect(res.min_wage.below_min_wage).toBe(true);
  });

  it("所属がマスタに無ければ default 県で近似し、警告する", async () => {
    const res = await run(env(), baseArgs({ branch: "存在しない営業所" }));
    expect(res.min_wage.mapped).toBe(false);
    expect(res.min_wage.prefecture).toBe("東京都");
    expect(res.warnings.some((w) => w.includes("で近似"))).toBe(true);
  });

  it("対象月に有効な額が無ければ null にして警告する (0 円にしない)", async () => {
    const res = await run(
      env({}, { prefectures: { 北海道: [{ effectiveFrom: "2027-10-01", rate: 1100 }] }, branchToPrefecture: { 釧路営業所: "北海道" } }),
      baseArgs(),
    );
    expect(res.min_wage.rate).toBeNull();
    expect(res.min_wage.rate_effective_from).toBeNull();
    expect(res.min_wage.diff_yen).toBeNull();
    expect(res.min_wage.below_min_wage).toBeNull();
    expect(res.warnings.some((w) => w.includes("最低賃金が引けませんでした"))).toBe(true);
  });

  it("マスタが R2 に無ければ比較を出さず警告する", async () => {
    const res = await run(env({}, null), baseArgs());
    expect(res.min_wage.prefecture).toBeNull();
    expect(res.min_wage.mapped).toBe(false);
    expect(res.min_wage.rate).toBeNull();
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
