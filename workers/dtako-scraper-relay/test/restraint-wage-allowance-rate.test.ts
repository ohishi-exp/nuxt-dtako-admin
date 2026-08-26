import { describe, expect, it } from "vitest";

import {
  isAuditedWageMaster,
  normalizeAllowanceRateMaster,
  WageMasterError,
  type AllowanceRateRow,
} from "../src/restraint-wage";

// fixture は最小限 (実在の取引先名・銘柄を写さない)。検証しているのは形だけで、
// 値の中身には依存しない。
function row(over: Partial<AllowanceRateRow> = {}): AllowanceRateRow {
  return {
    shipper: "G社",
    customer: "得意先A",
    loader: "積地業者A",
    origin: "積地A",
    dest: "卸地A",
    brand: "銘柄A",
    farePerT: 2750,
    allowanceYen: 9000,
    note: "",
    ...over,
  };
}

describe("normalizeAllowanceRateMaster", () => {
  it("正常形はそのまま通る", () => {
    const master = { rows: [row()] };
    expect(normalizeAllowanceRateMaster(master)).toEqual(master);
  });

  it("★ farePerT: null を保持する (0 に倒さない)", () => {
    const out = normalizeAllowanceRateMaster({ rows: [row({ farePerT: null })] });
    expect(out.rows[0].farePerT).toBeNull();
    // 「null が残る」だけでなく「0 になっていない」を明示的に固定する
    // (0 に倒す実装でも toBeNull 以外は通ってしまうため)。
    expect(out.rows[0].farePerT).not.toBe(0);
  });

  it("★ 行の順序を保つ (#805 の seed 投入で順序込み deepEqual を取る)", () => {
    const rows = [row({ dest: "卸地A" }), row({ dest: "卸地B" }), row({ dest: "卸地C" })];
    const out = normalizeAllowanceRateMaster({ rows });
    expect(out.rows.map((r) => r.dest)).toEqual(["卸地A", "卸地B", "卸地C"]);
  });

  it("余計なキーは落とす (保存形は RateRow の 9 キーだけ)", () => {
    const out = normalizeAllowanceRateMaster({ rows: [{ ...row(), extra: "x" }] });
    expect(Object.keys(out.rows[0]).sort()).toEqual(
      ["allowanceYen", "brand", "customer", "dest", "farePerT", "loader", "note", "origin", "shipper"],
    );
  });

  it.each([
    ["null", null],
    ["文字列", "rows"],
    ["配列", [row()]],
  ])("トップレベルが %s だと投げる", (_label, raw) => {
    expect(() => normalizeAllowanceRateMaster(raw)).toThrow(WageMasterError);
  });

  it.each([
    ["未指定", undefined],
    ["オブジェクト", { 0: row() }],
  ])("rows が配列でない (%s) と投げる", (_label, rows) => {
    expect(() => normalizeAllowanceRateMaster({ rows })).toThrow(/rows が配列ではありません/);
  });

  it.each([
    ["null", null],
    ["文字列", "row"],
    ["配列", []],
  ])("行が %s だと投げる", (_label, bad) => {
    expect(() => normalizeAllowanceRateMaster({ rows: [bad] })).toThrow(/rows\[0\] がオブジェクトではありません/);
  });

  it.each(["shipper", "customer", "loader", "origin", "dest", "brand", "note"] as const)(
    "%s が文字列でないと投げる",
    (field) => {
      const bad = { ...row(), [field]: 1 };
      expect(() => normalizeAllowanceRateMaster({ rows: [bad] })).toThrow(
        new RegExp(`rows\\[0\\]\\.${field} は文字列が必要です`),
      );
    },
  );

  it.each([
    ["負", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["文字列", "9000"],
    ["未指定", undefined],
  ])("allowanceYen が %s だと投げる", (_label, allowanceYen) => {
    expect(() => normalizeAllowanceRateMaster({ rows: [{ ...row(), allowanceYen }] })).toThrow(
      /allowanceYen は 0 以上の数値が必要です/,
    );
  });

  it("allowanceYen が 0 は通る (無償の便を『壊れている』にしない)", () => {
    expect(normalizeAllowanceRateMaster({ rows: [row({ allowanceYen: 0 })] }).rows[0].allowanceYen).toBe(0);
  });

  it.each([
    ["文字列", "2750"],
    ["NaN", Number.NaN],
    ["未指定 (null を明示していない)", undefined],
  ])("farePerT が %s だと投げる", (_label, farePerT) => {
    expect(() => normalizeAllowanceRateMaster({ rows: [{ ...row(), farePerT }] })).toThrow(
      /farePerT は数値または null が必要です/,
    );
  });
});

describe("isAuditedWageMaster", () => {
  it("allowance-rate だけが監査対象 (旧版を消さない・履歴を残す)", () => {
    expect(isAuditedWageMaster("allowance-rate")).toBe(true);
  });

  it.each(["wage-master", "min-wage", "wage-config", "salary-item-config"] as const)(
    "%s は従来どおり (監査対象ではない)",
    (name) => {
      expect(isAuditedWageMaster(name)).toBe(false);
    },
  );
});
