import { describe, expect, it } from "vitest";

// 2026-07-25 に取得した厚労省「地域別最低賃金の全国一覧」(令和7年度) の実物。
// 実サイトの構造が変わったらこの fixture を差し替えて差分をレビューする。
import nationalListHtml from "./fixtures/mhlw-nationallist-2025.html?raw";

import {
  MHLW_NATIONAL_LIST_URL,
  MinWageImportError,
  PREFECTURES,
  mergeMinWageRows,
  parseEraDate,
  parseMhlwNationalList,
} from "../src/min-wage-import";
import type { MinWageMaster } from "../src/restraint-wage";

// ══════════════════════════════════════════════════════════════
// parseEraDate
// ══════════════════════════════════════════════════════════════

describe("parseEraDate", () => {
  it("令和・平成を西暦へ直す", () => {
    expect(parseEraDate("令和7.10.04")).toBe("2025-10-04");
    expect(parseEraDate("令和8.01.01")).toBe("2026-01-01");
    expect(parseEraDate("平成31.10.01")).toBe("2019-10-01");
  });

  it("元年を 1 年として扱う", () => {
    expect(parseEraDate("令和元.10.01")).toBe("2019-10-01");
  });

  it("全角ピリオド・前後の空白・1 桁月日を許す", () => {
    expect(parseEraDate(" 令和 7．9．1 ")).toBe("2025-09-01");
  });

  it("未知の元号や書式違いは throw する", () => {
    // 西暦へ勝手に倒すと 1 年ズレて発効前の額を使ってしまう
    expect(() => parseEraDate("昭和64.01.07")).toThrow(MinWageImportError);
    expect(() => parseEraDate("2025-10-04")).toThrow(/発効年月日を解釈できません/);
  });

  it("月日が範囲外なら throw する", () => {
    expect(() => parseEraDate("令和7.13.01")).toThrow(/発効年月日が不正です/);
    expect(() => parseEraDate("令和7.10.32")).toThrow(/発効年月日が不正です/);
    expect(() => parseEraDate("令和7.00.10")).toThrow(/発効年月日が不正です/);
    expect(() => parseEraDate("令和7.10.00")).toThrow(/発効年月日が不正です/);
  });
});

// ══════════════════════════════════════════════════════════════
// parseMhlwNationalList (実物の fixture)
// ══════════════════════════════════════════════════════════════

/** テスト用に 1 行ぶんの HTML を組む。 */
function row(pref: string, money: string, date: string): string {
  return `<tr><td><a href="/check/?p=0">${pref}</a></td>`
    + `<td class="money">${money}<div class="note"></div></td>`
    + `<td class="date">${date}</td></tr>`;
}

/** 47 件そろった最小の表 (rate は県ごとに変えて取り違えを検知できるようにする)。 */
function fullTable(override: Partial<Record<string, string>> = {}): string {
  return `<table>${PREFECTURES.map((p, i) =>
    row(p, override[p] ?? `${1000 + i}円`, "令和7.10.01"),
  ).join("")}</table>`;
}

describe("parseMhlwNationalList (厚労省の実 HTML)", () => {
  const rows = parseMhlwNationalList(nationalListHtml);

  it("47 都道府県ぶん取れる", () => {
    expect(rows).toHaveLength(47);
    expect(new Set(rows.map(r => r.prefecture)).size).toBe(47);
  });

  it("拠点のある県の実額が取れる", () => {
    const by = Object.fromEntries(rows.map(r => [r.prefecture, r]));
    // 本社=長崎 / 佐賀・諸富 / 北九州=福岡 / 大阪 / 帯広=北海道 / 広島
    expect(by["長崎県"]).toEqual({ prefecture: "長崎県", rate: 1031, effectiveFrom: "2025-12-01" });
    expect(by["佐賀県"]).toEqual({ prefecture: "佐賀県", rate: 1030, effectiveFrom: "2025-11-21" });
    expect(by["福岡県"]).toEqual({ prefecture: "福岡県", rate: 1057, effectiveFrom: "2025-11-16" });
    expect(by["大阪府"]).toEqual({ prefecture: "大阪府", rate: 1177, effectiveFrom: "2025-10-16" });
    expect(by["北海道"]).toEqual({ prefecture: "北海道", rate: 1075, effectiveFrom: "2025-10-04" });
    expect(by["広島県"]).toEqual({ prefecture: "広島県", rate: 1085, effectiveFrom: "2025-11-01" });
  });

  it("県によって額が違う (全社共通 1 本では表せない)", () => {
    const rates = rows.map(r => r.rate);
    expect(Math.max(...rates) - Math.min(...rates)).toBeGreaterThan(100);
  });

  it("地方見出し行やページ内の他テーブルを拾わない", () => {
    // 実 HTML には検索フォーム等 6 つの table と <th class="area"> の見出し行がある
    expect(rows.every(r => PREFECTURES.includes(r.prefecture))).toBe(true);
  });

  it("取得元 URL を公開している", () => {
    expect(MHLW_NATIONAL_LIST_URL).toContain("saiteichingin.mhlw.go.jp");
  });
});

describe("parseMhlwNationalList (異常系)", () => {
  it("1 県でも欠けたら throw する — 部分結果で書くと欠けた県が最低賃金なしに化ける", () => {
    const html = `<table>${PREFECTURES.slice(0, 46).map(p => row(p, "1,000円", "令和7.10.01")).join("")}</table>`;
    expect(() => parseMhlwNationalList(html)).toThrow(/47 件に足りません/);
    expect(() => parseMhlwNationalList(html)).toThrow(/沖縄県/);
  });

  it("空の HTML も 47 件に足りないものとして throw する", () => {
    expect(() => parseMhlwNationalList("")).toThrow(MinWageImportError);
  });

  it("未知の県名は throw する (表記変更の検知)", () => {
    const html = `<table>${row("佐賀", "1,000円", "令和7.10.01")}</table>`;
    expect(() => parseMhlwNationalList(html)).toThrow(/未知の都道府県名です: 佐賀/);
  });

  it("同じ県が 2 回出たら throw する", () => {
    const html = `<table>${row("佐賀県", "1,000円", "令和7.10.01")}${row("佐賀県", "1,100円", "令和7.10.01")}</table>`;
    expect(() => parseMhlwNationalList(html)).toThrow(/都道府県が重複しています/);
  });

  it("金額が読めない・非現実的なら throw する", () => {
    expect(() => parseMhlwNationalList(`<table>${row("佐賀県", "未定", "令和7.10.01")}</table>`))
      .toThrow(/最低賃金時間額を解釈できません/);
    expect(() => parseMhlwNationalList(`<table>${row("佐賀県", "10円", "令和7.10.01")}</table>`))
      .toThrow(/現実的な範囲にありません/);
    expect(() => parseMhlwNationalList(`<table>${row("佐賀県", "1,000,000円", "令和7.10.01")}</table>`))
      .toThrow(/現実的な範囲にありません/);
  });

  it("money/date クラスが無い 3 セル行は対象外", () => {
    const plain = "<table><tr><td>佐賀県</td><td>1,000円</td><td>令和7.10.01</td></tr></table>";
    expect(() => parseMhlwNationalList(plain)).toThrow(/47 件に足りません/);
    const dateOnly = `<table><tr><td>佐賀県</td><td>1,000円</td><td class="date">令和7.10.01</td></tr></table>`;
    expect(() => parseMhlwNationalList(dateOnly)).toThrow(/47 件に足りません/);
    const moneyOnly = `<table><tr><td>佐賀県</td><td class="money">1,000円</td><td>令和7.10.01</td></tr></table>`;
    expect(() => parseMhlwNationalList(moneyOnly)).toThrow(/47 件に足りません/);
  });

  it("セル数が 3 でない行は対象外", () => {
    const html = `<table><tr><td>a</td><td class="money">1,000円</td></tr></table>`;
    expect(() => parseMhlwNationalList(html)).toThrow(/47 件に足りません/);
  });

  it("実体参照つきの県名も読める", () => {
    const html = fullTable();
    expect(parseMhlwNationalList(html.replace("佐賀県", "佐賀県&nbsp;"))).toHaveLength(47);
  });
});

// ══════════════════════════════════════════════════════════════
// mergeMinWageRows
// ══════════════════════════════════════════════════════════════

describe("mergeMinWageRows", () => {
  const rows = parseMhlwNationalList(nationalListHtml);

  it("空のマスタへ 47 県ぶん足す", () => {
    const base: MinWageMaster = { prefectures: {}, branchToPrefecture: {} };
    const res = mergeMinWageRows(base, rows);
    expect(res.added).toBe(47);
    expect(res.updated).toBe(0);
    expect(res.unchanged).toBe(0);
    expect(Object.keys(res.master.prefectures)).toHaveLength(47);
    expect(res.master.prefectures["長崎県"]).toEqual([{ effectiveFrom: "2025-12-01", rate: 1031 }]);
  });

  it("全社共通 1 本の運用 (Refs #253) を壊さない", () => {
    const base: MinWageMaster = {
      prefectures: { 全社共通: [{ effectiveFrom: "2025-10-01", rate: 1000 }] },
      branchToPrefecture: { "㈲大石運輸　帯広営業所": "北海道" },
      defaultPrefecture: "全社共通",
    };
    const res = mergeMinWageRows(base, rows);
    expect(res.master.prefectures["全社共通"]).toEqual([{ effectiveFrom: "2025-10-01", rate: 1000 }]);
    expect(res.master.branchToPrefecture).toEqual({ "㈲大石運輸　帯広営業所": "北海道" });
    expect(res.master.defaultPrefecture).toBe("全社共通");
  });

  it("同じ発効日で額が変わっていれば上書きし、同じなら触らない", () => {
    const base: MinWageMaster = {
      prefectures: {
        長崎県: [{ effectiveFrom: "2025-12-01", rate: 999 }],
        佐賀県: [{ effectiveFrom: "2025-11-21", rate: 1030 }],
      },
      branchToPrefecture: {},
    };
    const res = mergeMinWageRows(base, rows);
    expect(res.updated).toBe(1);
    expect(res.unchanged).toBe(1);
    expect(res.added).toBe(45);
    expect(res.master.prefectures["長崎県"]).toEqual([{ effectiveFrom: "2025-12-01", rate: 1031 }]);
  });

  it("過去の履歴を消さず、発効日の昇順で並べる", () => {
    const base: MinWageMaster = {
      prefectures: { 長崎県: [{ effectiveFrom: "2024-10-01", rate: 953 }] },
      branchToPrefecture: {},
    };
    const res = mergeMinWageRows(base, rows);
    expect(res.master.prefectures["長崎県"]).toEqual([
      { effectiveFrom: "2024-10-01", rate: 953 },
      { effectiveFrom: "2025-12-01", rate: 1031 },
    ]);
  });

  it("既存より古い改定を取り込んでも昇順に直る", () => {
    // 過去年度ぶんを後から取り込む場合。push 後の並べ替えが効くこと
    const base: MinWageMaster = {
      prefectures: { 長崎県: [{ effectiveFrom: "2026-10-01", rate: 1080 }] },
      branchToPrefecture: {},
    };
    const res = mergeMinWageRows(base, rows);
    expect(res.master.prefectures["長崎県"]).toEqual([
      { effectiveFrom: "2025-12-01", rate: 1031 },
      { effectiveFrom: "2026-10-01", rate: 1080 },
    ]);
  });

  it("同じ発効日が既に重複していても落ちない", () => {
    // マスタは PUT で手編集できるので、同じ発効日が 2 つ入った状態もあり得る
    const base: MinWageMaster = {
      prefectures: {
        長崎県: [
          { effectiveFrom: "2025-12-01", rate: 999 },
          { effectiveFrom: "2025-12-01", rate: 998 },
        ],
      },
      branchToPrefecture: {},
    };
    const res = mergeMinWageRows(base, rows);
    const nagasaki = res.master.prefectures["長崎県"]!;
    expect(nagasaki).toHaveLength(2);
    expect(nagasaki.map(e => e.rate).sort((a, b) => a - b)).toEqual([998, 1031]);
  });

  it("元のマスタを破壊しない", () => {
    const base: MinWageMaster = {
      prefectures: { 長崎県: [{ effectiveFrom: "2024-10-01", rate: 953 }] },
      branchToPrefecture: {},
    };
    mergeMinWageRows(base, rows);
    expect(base.prefectures["長崎県"]).toEqual([{ effectiveFrom: "2024-10-01", rate: 953 }]);
  });
});
