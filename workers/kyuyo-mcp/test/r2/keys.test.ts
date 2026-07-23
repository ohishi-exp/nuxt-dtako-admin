import { describe, it, expect } from "vitest";
import {
  companiesListPrefix,
  monthsListPrefix,
  summaryListPrefix,
  wageMasterR2Paths,
  restraintR2Paths,
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

  it("works for every WageMasterName variant", () => {
    for (const name of ["wage-master", "min-wage", "wage-config", "salary-item-config", "salary-cd-map"] as const) {
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
