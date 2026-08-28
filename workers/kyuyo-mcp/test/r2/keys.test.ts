import { describe, it, expect } from "vitest";
import {
  companiesListPrefix,
  monthsListPrefix,
  summaryListPrefix,
  wageMasterR2Paths,
  restraintR2Paths,
  type WageMasterName,
} from "../../src/r2/keys";

describe("companiesListPrefix / monthsListPrefix / summaryListPrefix", () => {
  it("builds the expected prefixes", () => {
    expect(companiesListPrefix("restraint")).toBe("restraint/");
    expect(monthsListPrefix("restraint", "0100")).toBe("restraint/0100/");
    expect(summaryListPrefix("restraint", "0100", "2026-07")).toBe("restraint/0100/2026-07/summary/");
  });
});

describe("wageMasterR2Paths", () => {
  it("matches dtako-scraper-relay-do.ts's private wageMasterR2Paths logic", () => {
    const paths = wageMasterR2Paths("restraint", "0100", "wage-master");
    expect(paths.dir).toBe("restraint/0100/wage-master");
    expect(paths.latest).toBe("restraint/0100/wage-master/latest.json");
    expect(paths.version("20260701T000000Z")).toBe("restraint/0100/wage-master/v-20260701T000000Z.json");
  });

  // ★ **列挙をベタ書きしない。** `Record<WageMasterName, true>` にしておくと、
  // 正本 (relay の `restraint-wage.ts`) が種別を足したときに **tsc が
  // 「プロパティが足りない」で落ちる** (CI の `npx tsc --noEmit`)。ベタ書きの
  // 配列だと足された種別を素通りしたまま "every variant" と名乗り続ける
  // (実際 `"allowance-rate"` が 4 値のまま取り残されていた、Refs #1022)。
  const EVERY_WAGE_MASTER_NAME: Record<WageMasterName, true> = {
    "wage-master": true,
    "min-wage": true,
    "wage-config": true,
    "salary-item-config": true,
    "allowance-rate": true,
  };

  it("works for every WageMasterName variant", () => {
    const names = Object.keys(EVERY_WAGE_MASTER_NAME) as WageMasterName[];
    // 「回っていない」を数で固定する (0 件でも for ループは緑になるため)。
    expect(names).toHaveLength(5);
    for (const name of names) {
      expect(wageMasterR2Paths("restraint", "0100", name).latest).toBe(`restraint/0100/${name}/latest.json`);
    }
  });
});

describe("restraintR2Paths (re-export)", () => {
  it("is importable and produces a summaryLatest path", () => {
    const paths = restraintR2Paths("restraint", "0100", 2026, 7, "");
    expect(paths.summaryLatest("1234")).toBe("restraint/0100/2026-07/summary/1234/latest.json");
  });
});
