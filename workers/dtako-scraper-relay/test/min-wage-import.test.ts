import { describe, expect, it } from "vitest";

// 2026-07-25 に取得した厚労省「地域別最低賃金の全国一覧」(令和7年度) の実物。
// 実サイトの構造が変わったらこの fixture を差し替えて差分をレビューする。
import nationalListHtml from "./fixtures/mhlw-nationallist-2025.html?raw";
// 2026-09-30 に取得した厚労省「地域別最低賃金改定状況」xlsx の実物 (公表値。個人情報なし) の
// base64。relay は @types/node を持たないので、バイナリを直に読まず文字列で取り込む。
import xlsxBase64 from "./fixtures/mhlw-minwage-history.xlsx.b64?raw";

import {
  MHLW_NATIONAL_LIST_URL,
  MHLW_REVISION_INDEX_URL,
  MinWageImportError,
  PREFECTURES,
  findRevisionXlsxHref,
  mergeMinWageRows,
  parseEraDate,
  parseMhlwNationalList,
  parseMhlwRevisionHistory,
  readXlsxParts,
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

// ══════════════════════════════════════════════════════════════
// 改定状況 xlsx (平成14年度〜の全履歴) — Refs #1133 c1133-20
// ══════════════════════════════════════════════════════════════

// 平成14〜令和8年度の 25 年度 × 47 県。据え置き年度は前年度と同じ発効日・額が並ぶ。
const xlsxBuf = (): ArrayBuffer =>
  Uint8Array.from(atob(xlsxBase64.trim()), (c) => c.charCodeAt(0)).buffer as ArrayBuffer;

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

const deflateRaw = async (raw: Uint8Array): Promise<Uint8Array> =>
  new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());

/** 最小の zip を組む (method 0 = stored / 8 = deflate)。 */
async function makeZip(entries: Record<string, string>, method: 0 | 8 = 8): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const raw = enc.encode(text);
    const data = method === 8 ? await deflateRaw(raw) : raw;
    const nameBuf = enc.encode(name);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBuf.length, true);
    parts.push(local, nameBuf, data);
    const cd = new Uint8Array(46);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, method, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBuf.length, true);
    cv.setUint32(42, offset, true);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = concat(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, Object.keys(entries).length, true);
  ev.setUint32(12, cdBuf.length, true);
  ev.setUint32(16, offset, true);
  return concat([...parts, cdBuf, eocd]).buffer as ArrayBuffer;
}

const SHEET = "xl/worksheets/sheet1.xml";
const SST = "xl/sharedStrings.xml";

describe("readXlsxParts", () => {
  it("実物の xlsx から シート と 共有文字列表 を取り出す", async () => {
    const { sheetXml, sharedStringsXml } = await readXlsxParts(xlsxBuf());
    expect(sheetXml).toContain("<dimension ref=\"A1:AY52\"/>");
    expect(sharedStringsXml).toContain("都道府県名");
  });

  it.each([8, 0] as const)("method %i (deflate / stored) を読む", async (method) => {
    const parts = await readXlsxParts(await makeZip({ [SHEET]: "<s/>", [SST]: "<sst/>" }, method));
    expect(parts).toEqual({ sheetXml: "<s/>", sharedStringsXml: "<sst/>" });
  });

  it("該当エントリが無ければ MinWageImportError", async () => {
    await expect(readXlsxParts(await makeZip({ [SHEET]: "<s/>" }))).rejects.toThrow(/sharedStrings\.xml がありません/);
  });

  it("壊れた zip (zip でない / 末尾が切れている) は 500 でなく MinWageImportError", async () => {
    const junk = new TextEncoder().encode("not a zip at all, just text").buffer as ArrayBuffer;
    await expect(readXlsxParts(junk)).rejects.toThrow(MinWageImportError);
    await expect(readXlsxParts(new ArrayBuffer(3))).rejects.toThrow(MinWageImportError);
    await expect(readXlsxParts(xlsxBuf().slice(0, 20_000))).rejects.toThrow(MinWageImportError);
  });

  it("deflate のデータが壊れていれば DecompressionStream の TypeError を MinWageImportError に包む", async () => {
    const zip = new Uint8Array(await makeZip({ [SHEET]: "<s>".repeat(2000), [SST]: "<sst/>" }));
    zip.fill(0xff, 30 + SHEET.length, 30 + SHEET.length + 8); // 先頭エントリの圧縮データを潰す
    const err = await readXlsxParts(zip.buffer as ArrayBuffer).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MinWageImportError);
    expect((err as Error).message).toMatch(/展開できません/);
  });

  it("中央ディレクトリの位置が範囲外なら RangeError を MinWageImportError に包む", async () => {
    const zip = new Uint8Array(await makeZip({ [SHEET]: "<s/>", [SST]: "<sst/>" }));
    new DataView(zip.buffer).setUint32(zip.length - 6, 0xfffffff0, true); // cd offset
    await expect(readXlsxParts(zip.buffer as ArrayBuffer)).rejects.toThrow(MinWageImportError);
  });

  it("圧縮方式が未対応 / local header が壊れていれば throw", async () => {
    const zip = new Uint8Array(await makeZip({ [SHEET]: "<s/>", [SST]: "<sst/>" }));
    const cdStart = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    const bad = zip.slice();
    new DataView(bad.buffer).setUint16(cdStart + 10, 12, true);
    await expect(readXlsxParts(bad.buffer as ArrayBuffer)).rejects.toThrow(/圧縮方式 12/);
    const noLocal = zip.slice();
    new DataView(noLocal.buffer).setUint32(0, 0, true);
    await expect(readXlsxParts(noLocal.buffer as ArrayBuffer)).rejects.toThrow(/local header/);
    const noCentral = zip.slice();
    new DataView(noCentral.buffer).setUint32(cdStart, 0, true);
    await expect(readXlsxParts(noCentral.buffer as ArrayBuffer)).rejects.toThrow(/中央ディレクトリ/);
  });

  it("データが切れている / 大きさの上限を超えるものは throw", async () => {
    const zip = new Uint8Array(await makeZip({ [SHEET]: "<s/>", [SST]: "<sst/>" }, 0));
    const cdStart = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    const lying = zip.slice();
    new DataView(lying.buffer).setUint32(cdStart + 20, 100_000, true); // 圧縮サイズを盛る
    await expect(readXlsxParts(lying.buffer as ArrayBuffer)).rejects.toThrow(/途中で切れています/);
    const huge = zip.slice();
    new DataView(huge.buffer).setUint32(cdStart + 24, 6 * 1024 * 1024, true); // 展開後サイズを盛る
    await expect(readXlsxParts(huge.buffer as ArrayBuffer)).rejects.toThrow(/大きすぎます/);
    await expect(readXlsxParts(new ArrayBuffer(6 * 1024 * 1024))).rejects.toThrow(/大きすぎます/);
  });

  it("実際に上限を超えて展開される deflate (usize を偽る zip 爆弾) は途中で止める", async () => {
    const big = "a".repeat(6 * 1024 * 1024);
    const zip = new Uint8Array(await makeZip({ [SHEET]: big, [SST]: "<sst/>" }));
    const cdStart = new DataView(zip.buffer).getUint32(zip.length - 6, true);
    new DataView(zip.buffer).setUint32(cdStart + 24, 10, true); // 申告は 10 バイト
    await expect(readXlsxParts(zip.buffer as ArrayBuffer)).rejects.toThrow(/展開結果が大きすぎます/);
  });
});

describe("findRevisionXlsxHref", () => {
  const BASE = MHLW_REVISION_INDEX_URL;
  const link = (href: string, text = "平成14年度から令和８年度までの地域別最低賃金改定状況［29KB］") =>
    `<li><a data-icon="excel" target="_blank" href="${href}">${text}</a></li>`;

  it("「改定状況」のリンクだけを絶対 URL にして返す (セルフチェックシートは拾わない)", () => {
    const html = link("/content/11200000/001753407.xlsx") + link("/content/11200000/001753408.xlsx", "最低賃金に関するセルフチェックシート［28KB］");
    expect(findRevisionXlsxHref(html, BASE)).toBe("https://www.mhlw.go.jp/content/11200000/001753407.xlsx");
  });

  it("属性の並びが違っても・同じ href が 2 回出ても 1 本として拾う", () => {
    const html = `<a class="m-link" href='/content/1/a.xlsx' target="_blank">改定状況</a>` + link("/content/1/a.xlsx");
    expect(findRevisionXlsxHref(html, BASE)).toBe("https://www.mhlw.go.jp/content/1/a.xlsx");
  });

  it("0 本 / 2 本以上は throw", () => {
    expect(() => findRevisionXlsxHref("<a href='/x.xlsx'>別の資料</a>", BASE)).toThrow(/0 本/);
    expect(() => findRevisionXlsxHref(link("/a.xlsx") + link("/b.xlsx"), BASE)).toThrow(/2 本/);
    expect(() => findRevisionXlsxHref(link("/a.pdf"), BASE)).toThrow(/0 本/);
  });

  it("取得先が mhlw.go.jp の https xlsx でなければ throw", () => {
    expect(() => findRevisionXlsxHref(link("https://evil.example.com/a.xlsx"), BASE)).toThrow(/厚労省/);
    expect(() => findRevisionXlsxHref(link("http://www.mhlw.go.jp/a.xlsx"), BASE)).toThrow(/厚労省/);
    expect(() => findRevisionXlsxHref(link("https://www.mhlw.go.jp.evil.example.com/a.xlsx"), BASE)).toThrow(/厚労省/);
  });

  it("URL として解釈できない href は throw", () => {
    expect(() => findRevisionXlsxHref(link("http://[bad.xlsx"), BASE)).toThrow(/URL として解釈できません/);
  });
});

describe("parseMhlwRevisionHistory (実物 xlsx)", () => {
  const load = async () => readXlsxParts(xlsxBuf());
  const parse = async (edit: (sheet: string, sst: string) => [string, string] = (a, b) => [a, b]) => {
    const { sheetXml, sharedStringsXml } = await load();
    return parseMhlwRevisionHistory(...edit(sheetXml, sharedStringsXml));
  };

  it("25 年度 × 47 県。据え置きの重複を 1 件にして 1126 件、年度範囲は平成14〜令和８", async () => {
    const { rows, years } = await parse();
    expect(rows).toHaveLength(1126);
    expect(years).toEqual({ from: "平成14年度", to: "令和８年度" });
    expect(new Set(rows.map((r) => r.prefecture)).size).toBe(47);
    for (const p of PREFECTURES) expect(rows.filter((r) => r.prefecture === p).length).toBeGreaterThanOrEqual(20);
  });

  it("福岡 (`福　岡` → 福岡県) の令和4〜8年度の額と発効日", async () => {
    const { rows } = await parse();
    const fukuoka = rows.filter((r) => r.prefecture === "福岡県").map((r) => [r.effectiveFrom, r.rate]);
    expect(fukuoka.slice(-5)).toEqual([
      ["2022-10-08", 900],
      ["2023-10-06", 941],
      ["2024-10-05", 992],
      ["2025-11-16", 1057],
      ["2026-10-04", 1114],
    ]);
  });

  it("「全国加重平均額」行 (額が小数、発効日が「-」) は県として読まない", async () => {
    const { rows } = await parse();
    expect(rows.every((r) => Number.isInteger(r.rate))).toBe(true);
  });

  it("既存マスタの最新 1 件と重複する (県, 発効日) は unchanged になり、過去分が added になる", async () => {
    const { rows } = await parse();
    const master: MinWageMaster = {
      prefectures: { 福岡県: [{ effectiveFrom: "2025-11-16", rate: 1057 }] },
      branchToPrefecture: {},
    };
    const merged = mergeMinWageRows(master, rows);
    expect(merged.unchanged).toBe(1);
    expect(merged.added).toBe(1125);
    expect(merged.master.prefectures["福岡県"]![0]).toEqual({ effectiveFrom: expect.any(String), rate: expect.any(Number) });
    expect(merged.master.prefectures["福岡県"]!.at(-2)).toEqual({ effectiveFrom: "2025-11-16", rate: 1057 });
  });

  // ── 陰性対照: 47 県チェック (fail-closed) を外すと、この 1 本が落ちる ──
  it("ある年度で 1 県でも欠ければ throw する (欠けた県を名指し)", async () => {
    // 令和４年度 (AP/AQ 列) の北海道 (3 行目) を消す
    await expect(
      parse((sheet, sst) => [sheet.replace(/<c r="AP3"[^>]*>\s*<v>\d+<\/v>\s*<\/c>/, "").replace(/<c r="AQ3"[^>]*>\s*<v>\d+<\/v>\s*<\/c>/, ""), sst]),
    ).rejects.toThrow(/令和４年度: 取り込めた都道府県が 46 件で 47 件に足りません \(欠け: 北海道\)/);
  });

  it("列全体が空の年度 (未公表) だけは飛ばす", async () => {
    const { rows, years } = await parse((sheet, sst) => [
      sheet.replace(/<c r="A[XY](?:[3-9]|[1-5]\d)"[^>]*>\s*<v>\d+<\/v>\s*<\/c>/g, ""),
      sst,
    ]);
    expect(years.to).toBe("令和７年度");
    expect(rows.some((r) => r.effectiveFrom === "2026-10-04")).toBe(false);
  });

  it("額が「-」などで読めなければ throw", async () => {
    const { sheetXml, sharedStringsXml } = await load();
    const cell = /<c r="AP3"([^>]*)>\s*<v>\d+<\/v>\s*<\/c>/.exec(sheetXml)!;
    const withDash = (v: string) => sheetXml.replace(cell[0], `<c r="AP3"><v>${v}</v></c>`);
    // 数値セルの中身を直値の文字列に差し替える (「1,131円」は許す)
    expect(() => parseMhlwRevisionHistory(withDash("-"), sharedStringsXml)).toThrow(/最低賃金時間額が不正です/);
    expect(() => parseMhlwRevisionHistory(withDash("50"), sharedStringsXml)).toThrow(/最低賃金時間額が不正です/);
    expect(() => parseMhlwRevisionHistory(withDash("1,131円"), sharedStringsXml)).not.toThrow();
  });

  it("発効年月日が範囲外・数値でなければ throw", async () => {
    const { sheetXml, sharedStringsXml } = await load();
    const cell = /<c r="AQ3"([^>]*)><v>\d+<\/v><\/c>/.exec(sheetXml)!;
    for (const v of ["12", "99999", "abc"]) {
      const bad = sheetXml.replace(cell[0], `<c r="AQ3"${cell[1]}><v>${v}</v></c>`);
      expect(() => parseMhlwRevisionHistory(bad, sharedStringsXml), v).toThrow(/シリアル値/);
    }
  });

  it("同じ (県, 発効日) で年度により額が違えば throw", async () => {
    const { sheetXml, sharedStringsXml } = await load();
    // 令和２年度 (AL) の北海道は令和元年度 (AJ/AK) と同じ 861 / 43741 の据え置き
    const cell = /<c r="AL3"([^>]*)><v>\d+<\/v><\/c>/.exec(sheetXml)!;
    const bad = sheetXml.replace(cell[0], `<c r="AL3"${cell[1]}><v>862</v></c>`);
    expect(() => parseMhlwRevisionHistory(bad, sharedStringsXml)).toThrow(/年度により額が食い違っています/);
  });

  it("県名が特定できない / 同じ県が 2 行あれば throw", async () => {
    const { sheetXml, sharedStringsXml } = await load();
    const sst = (from: string, to: string) => sharedStringsXml.replace(`<t>${from}</t>`, `<t>${to}</t>`);
    expect(() => parseMhlwRevisionHistory(sheetXml, sst("神奈川", "火星"))).toThrow(/都道府県名を特定できません: 火星/);
    expect(() => parseMhlwRevisionHistory(sheetXml, sst("神奈川", "　"))).toThrow(/都道府県名を特定できません/);
    // 「京」は京都府の前方一致 1 件だが、「島」は島根県 1 件、「山」は山形/山梨/山口の 3 件 (曖昧)
    expect(() => parseMhlwRevisionHistory(sheetXml, sst("神奈川", "山"))).toThrow(/都道府県名を特定できません: 山/);
    expect(() => parseMhlwRevisionHistory(sheetXml, sst("神奈川", "千　葉"))).toThrow(/重複しています: 千葉県/);
  });

  it("見出しの形が違えば throw (改定額に発効年月日が続かない / 年度が 1 つも読めない)", async () => {
    const { sheetXml, sharedStringsXml } = await load();
    expect(() => parseMhlwRevisionHistory("<sheetData></sheetData>", sharedStringsXml)).toThrow(/年度を 1 つも読めませんでした/);
    const broken = sharedStringsXml.replace("<t>発効年月日</t>", "<t>別の列</t>");
    expect(() => parseMhlwRevisionHistory(sheetXml, broken)).toThrow(/「発効年月日」が続いていません/);
    expect(() => parseMhlwRevisionHistory(sheetXml, "<sst></sst>")).toThrow(/共有文字列 \d+ がありません/);
  });

  it("A 列の無い行は読まず、値の欠けたセルは「読めない」として throw する", async () => {
    const { sheetXml, sharedStringsXml } = await load();
    const cellOf = (ref: string) => new RegExp(`<c r="${ref}"[^>]*>\\s*<v>\\d+</v>\\s*</c>`).exec(sheetXml)![0];
    const stray = sheetXml.replace("</sheetData>", `<row r="60"><c r="B60"><v>5</v></c></row></sheetData>`);
    expect(parseMhlwRevisionHistory(stray, sharedStringsXml).rows).toHaveLength(1126);
    // 北海道の令和４年度: 額だけ / 発効日だけ 欠ける
    expect(() => parseMhlwRevisionHistory(sheetXml.replace(cellOf("AP3"), ""), sharedStringsXml)).toThrow(/不正です: \(空\)/);
    expect(() => parseMhlwRevisionHistory(sheetXml.replace(cellOf("AQ3"), ""), sharedStringsXml)).toThrow(/シリアル値/);
    // 見出し: 「改定額」の右隣が無い / 年度名が無い
    expect(() => parseMhlwRevisionHistory(sheetXml.replace(cellOf("AY2"), ""), sharedStringsXml)).toThrow(/続いていません/);
    expect(parseMhlwRevisionHistory(sheetXml.replace(cellOf("AX1"), ""), sharedStringsXml).years.to).toBe("50 列目");
  });

  it("共有文字列の XML 実体参照を戻す", async () => {
    const { rows } = await parse((sheet, sst) => [sheet, sst.replace("<t>福　岡</t>", "<t>福&amp;岡</t>")]).catch(
      (e: Error) => ({ rows: [], years: e.message }),
    );
    expect(rows).toEqual([]); // 「福&岡」は県名として特定できず throw (実体参照が戻されている証拠)
  });
});
