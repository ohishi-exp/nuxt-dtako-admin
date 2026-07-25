import { describe, expect, it } from "vitest";

import {
  compareText,
  normalizeBranchLabel,
  resolveBranchPrefecture,
  suggestBranchGroups,
} from "../src/branch-prefecture";

/** 本番 (comp 27324455) の `employee_attrs.branch` 31 種。2026-07-25 実測。
 * `本社  乗務員` (全角2つ) と `本社 乗務員` の揺れがそのまま入っている。 */
const PRODUCTION_BRANCHES = [
  "佐賀 乗務員", "佐賀 事務員", "佐賀 執行役", "佐賀 役員",
  "北九州営業所一般管理", "北九州営業所乗務員", "北九州営業所乗務員トレ",
  "大阪 トレーラ乗務員", "大阪 乗務員", "大阪 事務員",
  "帯広 乗務員", "帯広 乗務員(トレーラ-)", "帯広 事務員",
  "広島 事務員",
  "本社  乗務員", "本社  乗務員(トレーラ)", "本社  事務員", "本社  作業員",
  "本社  作業員2", "本社  作業員点呼者", "本社  執行役", "本社  役員", "本社  特定技能",
  "本社 乗務員", "本社 事務員", "本社 作業員", "本社 修理", "本社 役員",
  "諸富 乗務員", "諸富 乗務員(トレーラ)", "諸富 事務員",
];

// ══════════════════════════════════════════════════════════════
// normalizeBranchLabel
// ══════════════════════════════════════════════════════════════

describe("normalizeBranchLabel", () => {
  it("全角スペースを半角へ倒し連続空白を潰す", () => {
    // 給与大臣の所属名には同じ拠点でスペース数の違う 2 系統が実在する
    expect(normalizeBranchLabel("本社  乗務員")).toBe("本社 乗務員");
    expect(normalizeBranchLabel("本社 乗務員")).toBe("本社 乗務員");
    expect(normalizeBranchLabel("  佐賀\t乗務員 ")).toBe("佐賀 乗務員");
  });

  it("空白だけ・空文字は空になる", () => {
    expect(normalizeBranchLabel("　 ")).toBe("");
    expect(normalizeBranchLabel("")).toBe("");
  });
});

// ══════════════════════════════════════════════════════════════
// compareText
// ══════════════════════════════════════════════════════════════

describe("compareText", () => {
  it("昇順で -1 / 0 / 1 を返す", () => {
    // localeCompare を使わない (ICU の照合順が OS 間で逆転し CI だけ落ちる)
    expect(compareText("あ", "い")).toBe(-1);
    expect(compareText("い", "あ")).toBe(1);
    expect(compareText("あ", "あ")).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// resolveBranchPrefecture
// ══════════════════════════════════════════════════════════════

describe("resolveBranchPrefecture", () => {
  it("拠点キー 1 つで職種違いをまとめて覆う", () => {
    // これが前方一致にした理由 — 職種が増えても再設定が要らない
    const map = { 本社: "長崎県" };
    expect(resolveBranchPrefecture(map, "本社  乗務員").prefecture).toBe("長崎県");
    expect(resolveBranchPrefecture(map, "本社 乗務員").prefecture).toBe("長崎県");
    expect(resolveBranchPrefecture(map, "本社 修理").prefecture).toBe("長崎県");
    expect(resolveBranchPrefecture(map, "本社  作業員点呼者").prefecture).toBe("長崎県");
  });

  it("空白の無い所属も覆う", () => {
    const map = { 北九州営業所: "福岡県" };
    expect(resolveBranchPrefecture(map, "北九州営業所乗務員").prefecture).toBe("福岡県");
    expect(resolveBranchPrefecture(map, "北九州営業所一般管理").prefecture).toBe("福岡県");
  });

  it("複数一致したら最長のキーを採る", () => {
    const map = { 本社: "長崎県", "本社 大阪出向": "大阪府" };
    expect(resolveBranchPrefecture(map, "本社 大阪出向 乗務員")).toEqual({
      prefecture: "大阪府",
      matchedKey: "本社 大阪出向",
    });
    expect(resolveBranchPrefecture(map, "本社 乗務員").matchedKey).toBe("本社");
  });

  it("長いキーが先に登録されていても短いキーに負けない", () => {
    // 走査順は登録順なので、後から来た短いキーで上書きしないこと
    const map = { "本社 大阪出向": "大阪府", 本社: "長崎県" };
    expect(resolveBranchPrefecture(map, "本社 大阪出向 乗務員")).toEqual({
      prefecture: "大阪府",
      matchedKey: "本社 大阪出向",
    });
  });

  it("キー側の空白揺れも正規化して比べる", () => {
    expect(resolveBranchPrefecture({ "本社　乗務員": "長崎県" }, "本社  乗務員").prefecture).toBe("長崎県");
  });

  it("theearth 事業所名の完全一致キー (Refs #253) もそのまま効く", () => {
    const map = { "㈲大石運輸　帯広営業所": "北海道" };
    expect(resolveBranchPrefecture(map, "㈲大石運輸　帯広営業所").prefecture).toBe("北海道");
  });

  it("未マッピングは null を返す — 推定しない", () => {
    // 誤った県で最低賃金割れを判定するより、判定しないほうが安全
    expect(resolveBranchPrefecture({ 本社: "長崎県" }, "広島 事務員")).toEqual({
      prefecture: null,
      matchedKey: null,
    });
    expect(resolveBranchPrefecture({}, "本社 乗務員").prefecture).toBeNull();
  });

  it("空キーは何にも一致しない (全件を巻き込まない)", () => {
    expect(resolveBranchPrefecture({ "": "長崎県", " ": "佐賀県" }, "本社 乗務員").prefecture).toBeNull();
  });

  it("前方一致であって部分一致ではない", () => {
    expect(resolveBranchPrefecture({ 乗務員: "長崎県" }, "本社 乗務員").prefecture).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
// suggestBranchGroups
// ══════════════════════════════════════════════════════════════

describe("suggestBranchGroups", () => {
  const groups = suggestBranchGroups(PRODUCTION_BRANCHES);
  const byPrefix = Object.fromEntries(groups.map(g => [g.prefix, g.branches]));

  it("本番の 31 種が 7 拠点にまとまる", () => {
    expect(groups.map(g => g.prefix).sort()).toEqual(
      ["佐賀", "北九州営業所", "大阪", "帯広", "広島", "本社", "諸富"].sort(),
    );
  });

  it("スペース数の揺れを 1 グループに寄せる", () => {
    // `本社  乗務員` (全角2つ) と `本社 乗務員` が別拠点に割れないこと
    expect(byPrefix["本社"]).toContain("本社  乗務員");
    expect(byPrefix["本社"]).toContain("本社 乗務員");
    expect(byPrefix["本社"]).toHaveLength(14);
  });

  it("空白の無い所属を共通の前方一致でまとめる", () => {
    expect(byPrefix["北九州営業所"]).toEqual([
      "北九州営業所一般管理",
      "北九州営業所乗務員",
      "北九州営業所乗務員トレ",
    ]);
  });

  it("全所属がどこかのグループに入る (取りこぼし無し)", () => {
    expect(groups.flatMap(g => g.branches).sort()).toEqual([...PRODUCTION_BRANCHES].sort());
  });

  it("空白なしが既存の拠点キーに前方一致すればそこへ寄る", () => {
    // branches は原文のまま返す (画面で元の所属名を見せるため)
    const g = suggestBranchGroups(["帯広 乗務員", "帯広事務員"]);
    expect(g).toEqual([{ prefix: "帯広", branches: ["帯広 乗務員", "帯広事務員"] }]);
  });

  it("空白なしが複数の拠点キーに前方一致したら最長へ寄る", () => {
    const g = suggestBranchGroups(["本社 乗務員", "本社別館 事務員", "本社別館作業員"]);
    const byPrefix = Object.fromEntries(g.map(x => [x.prefix, x.branches]));
    expect(byPrefix["本社別館"]).toEqual(["本社別館 事務員", "本社別館作業員"]);
    expect(byPrefix["本社"]).toEqual(["本社 乗務員"]);
  });

  it("どれとも共有しない空白なしは単独グループになる", () => {
    const g = suggestBranchGroups(["本社 乗務員", "単独拠点"]);
    expect(g.map(x => x.prefix).sort()).toEqual(["single".replace("single", "単独拠点"), "本社"].sort());
  });

  it("件数の多い前方一致を優先し、同数なら長いほうを採る", () => {
    // ABC 系 3 件 と ABCD 系 2 件 → 3 件の ABC でまとまる
    const g = suggestBranchGroups(["ABCあ", "ABCい", "ABCDう"]);
    expect(g).toEqual([{ prefix: "ABC", branches: ["ABCDう", "ABCあ", "ABCい"].sort() }]);
    // 同数なら長い前方一致 (XY より XYZ)
    const h = suggestBranchGroups(["XYZあ", "XYZい"]);
    expect(h[0]!.prefix).toBe("XYZ");
  });

  it("1 文字しか共有しないものはまとめない", () => {
    const g = suggestBranchGroups(["A本社", "A支店"]);
    expect(g.map(x => x.prefix).sort()).toEqual(["A支店", "A本社"]);
  });

  it("空文字・空白だけの所属は落とす", () => {
    expect(suggestBranchGroups(["", "　 ", "本社 乗務員"])).toEqual([
      { prefix: "本社", branches: ["本社 乗務員"] },
    ]);
  });

  it("空の入力は空を返す", () => {
    expect(suggestBranchGroups([])).toEqual([]);
  });

  it("同じ所属名が重複して来ても 1 件に畳む", () => {
    expect(suggestBranchGroups(["本社 乗務員", "本社 乗務員"])).toEqual([
      { prefix: "本社", branches: ["本社 乗務員"] },
    ]);
  });

  it("prefix の昇順で返す", () => {
    const prefixes = groups.map(g => g.prefix);
    expect([...prefixes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(prefixes);
  });
});
