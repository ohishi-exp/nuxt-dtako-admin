/**
 * 厚労省「地域別最低賃金の全国一覧」の取り込み (pure)。
 *
 * 最低賃金には公的な API が無い — 厚労省の提供形式は PDF / Excel / HTML テーブル
 * だけで、e-Stat にも data.go.jp にも地域別最低賃金額のデータセットは無い
 * (「最低賃金に関する実態調査」は別物)。よって HTML テーブルを取り込む。
 *
 * 現行の一覧は `saiteichingin.mhlw.go.jp` から取る (URL が安定している。最新の
 * 改定 1 件だけ)。平成14年度からの全履歴は `mhlw.go.jp` の「地域別最低賃金改定状況」
 * xlsx にあり、URL の content ID (`001753407.xlsx`) が年度ごとに変わるので、
 * 一覧ページ (MHLW_REVISION_INDEX_URL) からリンクを拾って読む
 * (findRevisionXlsxHref / readXlsxParts / parseMhlwRevisionHistory)。
 *
 * このモジュールは **pure** に保つ (fetch はしない)。呼び出し側が取得した HTML
 * 文字列を渡す。ネットワーク経路が変わっても (worker fetch / 貼り付け) パーサは
 * そのまま使えるようにするため。
 *
 * **パース失敗は必ず throw する。** 部分的に取れた結果でマスタを更新すると、
 * 欠けた県が「最低賃金なし」に化けて最低賃金割れを見逃す。47 件揃わなければ
 * 何も書かない、が正しい。
 */

import { TheearthClientError } from "./theearth-client";
import type { MinWageEntry, MinWageMaster } from "./restraint-wage";

/** 取り込み元 HTML の構造不正 (呼び出し側で 400 にマップする)。 */
export class MinWageImportError extends TheearthClientError {
  constructor(message: string) {
    super(message);
    this.name = "MinWageImportError";
  }
}

/** 地域別最低賃金の全国一覧 (現年度 47 件)。 */
export const MHLW_NATIONAL_LIST_URL =
  "https://saiteichingin.mhlw.go.jp/table/page_list_nationallist.php";

/** 47 都道府県 (厚労省の一覧と同じ表記)。取り込み結果の完全性チェックに使う。 */
export const PREFECTURES: readonly string[] = [
  "北海道",
  "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
  "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
  "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県",
  "岐阜県", "静岡県", "愛知県", "三重県",
  "滋賀県", "京都府", "大阪府", "兵庫県", "奈良県", "和歌山県",
  "鳥取県", "島根県", "岡山県", "広島県", "山口県",
  "徳島県", "香川県", "愛媛県", "高知県",
  "福岡県", "佐賀県", "長崎県", "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
];

/** 元号 → 元年の西暦 − 1 (令和1年 = 2019 なので 2018)。 */
const ERA_BASE: Record<string, number> = {
  令和: 2018,
  平成: 1988,
};

/** 最低賃金として現実的な時間額の範囲 (円)。桁落ち・桁増えの検知用。 */
const MIN_RATE = 100;
const MAX_RATE = 100_000;

export interface MinWageImportRow {
  prefecture: string;
  /** 時間額 (円)。 */
  rate: number;
  /** 発効日 (YYYY-MM-DD)。 */
  effectiveFrom: string;
}

/**
 * 和暦の発効日 (`令和7.10.04` / `令和元.10.01`) を ISO (`YYYY-MM-DD`) にする。
 * 元号が未知・書式違いは throw する (西暦へ勝手に倒すと 1 年ズレて発効前の額を
 * 使ってしまうため)。
 */
export function parseEraDate(text: string): string {
  const m = /^(令和|平成)\s*(元|\d{1,2})\s*[.．]\s*(\d{1,2})\s*[.．]\s*(\d{1,2})$/.exec(text.trim());
  if (!m) throw new MinWageImportError(`発効年月日を解釈できません: ${text}`);
  const base = ERA_BASE[m[1]!]!;
  const eraYear = m[2] === "元" ? 1 : Number(m[2]);
  const month = Number(m[3]);
  const day = Number(m[4]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new MinWageImportError(`発効年月日が不正です: ${text}`);
  }
  const year = base + eraYear;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** `1,075円` → 1075。 */
function parseRate(text: string): number {
  const m = /^([\d,，]+)\s*円/.exec(text.trim());
  if (!m) throw new MinWageImportError(`最低賃金時間額を解釈できません: ${text}`);
  const rate = Number(m[1]!.replace(/[,，]/g, ""));
  if (!Number.isInteger(rate) || rate < MIN_RATE || rate > MAX_RATE) {
    throw new MinWageImportError(`最低賃金時間額が現実的な範囲にありません: ${text}`);
  }
  return rate;
}

/** タグと実体参照を落として 1 行の文字列にする。 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 一覧 HTML → 都道府県別の最低賃金。
 *
 * 対象の行は `<td><a>県名</a></td><td class="money">1,075円</td><td class="date">令和7.10.04</td>`。
 * 地方名の見出し行 (`<th class="area">`) やページ内の他テーブルは、`money`/`date`
 * クラスが揃わないので自然に落ちる。
 */
export function parseMhlwNationalList(html: string): MinWageImportRow[] {
  const rows: MinWageImportRow[] = [];
  const seen = new Set<string>();
  for (const rowMatch of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1]!.matchAll(/<td([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (cells.length !== 3) continue;
    if (!/class\s*=\s*["'][^"']*\bmoney\b/i.test(cells[1]![1]!)) continue;
    if (!/class\s*=\s*["'][^"']*\bdate\b/i.test(cells[2]![1]!)) continue;

    const prefecture = textOf(cells[0]![2]!);
    if (!PREFECTURES.includes(prefecture)) {
      throw new MinWageImportError(`未知の都道府県名です: ${prefecture}`);
    }
    if (seen.has(prefecture)) {
      throw new MinWageImportError(`都道府県が重複しています: ${prefecture}`);
    }
    seen.add(prefecture);
    rows.push({
      prefecture,
      rate: parseRate(textOf(cells[1]![2]!)),
      effectiveFrom: parseEraDate(textOf(cells[2]![2]!)),
    });
  }

  const missing = PREFECTURES.filter((p) => !seen.has(p));
  if (missing.length > 0) {
    throw new MinWageImportError(
      `取り込めた都道府県が ${rows.length} 件で 47 件に足りません (欠け: ${missing.join("、")})`,
    );
  }
  return rows;
}

/** 厚労省「地域別最低賃金の全国一覧」ページ (改定状況 xlsx へのリンクを載せている)。 */
export const MHLW_REVISION_INDEX_URL =
  "https://www.mhlw.go.jp/stf/seisakunitsuite/bunya/koyou_roudou/roudoukijun/minimumichiran/index.html";

/** xlsx の取得先として許す host。一覧ページの href を鵜呑みにしない。 */
const MHLW_XLSX_HOST = "www.mhlw.go.jp";

/** xlsx (zip) と、その中の 1 エントリを展開した大きさの上限。 */
const MAX_XLSX_BYTES = 5 * 1024 * 1024;

function decodeXmlText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 一覧ページから「改定状況」xlsx のリンクを 1 本だけ拾い、絶対 URL にする。
 * 0 本・2 本以上・mhlw.go.jp 以外・xlsx 以外は throw (取得先を広げない)。
 */
export function findRevisionXlsxHref(indexHtml: string, baseUrl: string): string {
  const hrefs = new Set<string>();
  for (const m of indexHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    if (!textOf(m[2]!).includes("改定状況")) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[1]!)?.[1];
    if (href && /\.xlsx(?:[?#].*)?$/i.test(href)) hrefs.add(decodeXmlText(href));
  }
  if (hrefs.size !== 1) {
    throw new MinWageImportError(`改定状況 xlsx のリンクが ${hrefs.size} 本見つかりました (1 本のはず)`);
  }
  let url: URL;
  try {
    url = new URL([...hrefs][0]!, baseUrl);
  } catch {
    throw new MinWageImportError("改定状況 xlsx のリンクを URL として解釈できません");
  }
  if (url.protocol !== "https:" || url.hostname !== MHLW_XLSX_HOST || !/\.xlsx$/i.test(url.pathname)) {
    throw new MinWageImportError(`改定状況 xlsx のリンクが厚労省 (${MHLW_XLSX_HOST}) の xlsx ではありません`);
  }
  return url.toString();
}

/** zip の 1 エントリ (中央ディレクトリ → local header) を stored / deflate で展開する。 */
async function readZipEntry(buf: ArrayBuffer, name: string): Promise<string> {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new MinWageImportError("xlsx (zip) の末尾を読めません");
  const count = view.getUint16(eocd + 10, true);
  let pos = view.getUint32(eocd + 16, true);
  for (let n = 0; n < count; n++) {
    if (view.getUint32(pos, true) !== 0x02014b50) throw new MinWageImportError("xlsx (zip) の中央ディレクトリが壊れています");
    const method = view.getUint16(pos + 10, true);
    const csize = view.getUint32(pos + 20, true);
    const usize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const local = view.getUint32(pos + 42, true);
    const entryName = new TextDecoder().decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;
    if (entryName !== name) continue;
    if (usize > MAX_XLSX_BYTES) throw new MinWageImportError(`${name} が大きすぎます (${usize} バイト)`);
    if (view.getUint32(local, true) !== 0x04034b50) throw new MinWageImportError("xlsx (zip) の local header が壊れています");
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + csize);
    if (data.length !== csize) throw new MinWageImportError("xlsx (zip) のデータが途中で切れています");
    if (method === 0) return new TextDecoder().decode(data);
    if (method !== 8) throw new MinWageImportError(`xlsx (zip) の圧縮方式 ${method} は未対応です`);
    const reader = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_XLSX_BYTES) throw new MinWageImportError(`${name} の展開結果が大きすぎます`);
      chunks.push(value);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return new TextDecoder().decode(out);
  }
  throw new MinWageImportError(`xlsx に ${name} がありません`);
}

/**
 * xlsx (zip) から シート 1 枚と共有文字列表を取り出す。依存パッケージを足さないため
 * 中央ディレクトリを自前で読む (operation-zip.ts は契約が逆なので使わない)。
 * DecompressionStream の TypeError・DataView の RangeError も含め、失敗は必ず
 * MinWageImportError にする (route で 400 に写すため。500 に落とさない)。
 */
export async function readXlsxParts(
  buf: ArrayBuffer,
): Promise<{ sheetXml: string; sharedStringsXml: string }> {
  if (buf.byteLength > MAX_XLSX_BYTES) throw new MinWageImportError("xlsx が大きすぎます");
  try {
    return {
      sheetXml: await readZipEntry(buf, "xl/worksheets/sheet1.xml"),
      sharedStringsXml: await readZipEntry(buf, "xl/sharedStrings.xml"),
    };
  } catch (err) {
    if (err instanceof MinWageImportError) throw err;
    throw new MinWageImportError(`xlsx を展開できません (${String(err)})`);
  }
}

/** `AB` → 28。 */
function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64;
  return n;
}

/** sharedStrings.xml → 文字列表 (ふりがな `<rPh>` は落とす)。 */
function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)].map((si) =>
    [...si[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/gi, "").matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)]
      .map((t) => decodeXmlText(t[1]!))
      .join(""),
  );
}

/** シート → 行番号 → (列番号 → 文字列)。値の無いセルは持たない。 */
function parseSheetCells(sheetXml: string, strings: string[]): Map<number, Map<number, string>> {
  const rows = new Map<number, Map<number, string>>();
  for (const cell of sheetXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi)) {
    const ref = /\br="([A-Z]+)(\d+)"/.exec(cell[1]!);
    const v = /<v>([\s\S]*?)<\/v>/.exec(cell[2] ?? "")?.[1];
    if (!ref || v === undefined) continue;
    let text = decodeXmlText(v);
    if (/\bt="s"/.test(cell[1]!)) {
      const s = strings[Number(text)];
      if (s === undefined) throw new MinWageImportError(`共有文字列 ${text} がありません`);
      text = s;
    }
    const row = rows.get(Number(ref[2])) ?? new Map<number, string>();
    row.set(columnIndex(ref[1]!), text);
    rows.set(Number(ref[2]), row);
  }
  return rows;
}

/** Excel シリアル値 (1900 系、2000-01-01 以降) → `YYYY-MM-DD`。範囲外は throw。 */
function excelSerialToIso(text: string): string {
  const serial = Number(text);
  if (!/^\d+$/.test(text) || serial < 36526 || serial > 73050) {
    throw new MinWageImportError(`発効年月日 (シリアル値) が不正です: ${text}`);
  }
  return new Date((serial - 25569) * 86_400_000).toISOString().slice(0, 10);
}

/** `福　岡` → `福岡県`。全角・半角スペースを除いた前方一致が 1 県に決まらなければ throw。 */
function normalizePrefecture(label: string): string {
  const key = label.replace(/[\s　]/g, "");
  const hits = key === "" ? [] : PREFECTURES.filter((p) => p.startsWith(key));
  if (hits.length !== 1) throw new MinWageImportError(`都道府県名を特定できません: ${label}`);
  return hits[0]!;
}

export interface MinWageHistory {
  rows: MinWageImportRow[];
  /** 取り込んだ年度の範囲 (見出しの表記のまま)。 */
  years: { from: string; to: string };
}

/**
 * 「地域別最低賃金改定状況」xlsx (1 シート) → 全県 × 全年度の (額, 発効日)。
 *
 * 1 行目は年度名 (2 列結合)、2 行目は各年度の「改定額」「発効年月日」、3 行目以降が
 * 県。末尾の「全国加重平均額」行は県ではないので読まない。**年度ごとに 47 県が
 * 揃わなければ throw する** (1 年度でも欠けると、その年度の月が前年度の額で引かれて
 * 最低賃金割れを見逃すため)。列全体が空の年度 (未公表) だけは飛ばす。
 * 同じ (県, 発効日) が年度をまたいで現れるのは据え置き年度で、額が同じなら 1 件にする。
 */
export function parseMhlwRevisionHistory(sheetXml: string, sharedStringsXml: string): MinWageHistory {
  const rows = parseSheetCells(sheetXml, parseSharedStrings(sharedStringsXml));
  const yearRow = rows.get(1) ?? new Map<number, string>();
  const headRow = rows.get(2) ?? new Map<number, string>();
  const dataRows = [...rows.entries()]
    .filter(([r, cells]) => r >= 3 && (cells.get(1) ?? "") !== "")
    .filter(([, cells]) => !cells.get(1)!.startsWith("全国"));

  const merged = new Map<string, MinWageImportRow>();
  const years: string[] = [];
  for (const [col, head] of headRow) {
    if (!head.startsWith("改定額")) continue;
    if (!(headRow.get(col + 1) ?? "").startsWith("発効年月日")) {
      throw new MinWageImportError(`${col} 列目の「改定額」に「発効年月日」が続いていません`);
    }
    const year = yearRow.get(col) ?? `${col} 列目`;
    const filled = dataRows.filter(([, c]) => c.has(col) || c.has(col + 1));
    if (filled.length === 0) continue;
    const seen = new Set<string>();
    for (const [, cells] of filled) {
      const prefecture = normalizePrefecture(cells.get(1)!);
      if (seen.has(prefecture)) throw new MinWageImportError(`${year}: 都道府県が重複しています: ${prefecture}`);
      seen.add(prefecture);
      const rateText = (cells.get(col) ?? "").replace(/[,，]|円/g, "").trim();
      const rate = Number(rateText);
      if (!/^\d+$/.test(rateText) || rate < MIN_RATE || rate > MAX_RATE) {
        throw new MinWageImportError(`${year} ${prefecture}: 最低賃金時間額が不正です: ${cells.get(col) ?? "(空)"}`);
      }
      const effectiveFrom = excelSerialToIso((cells.get(col + 1) ?? "").trim());
      const key = `${prefecture}|${effectiveFrom}`;
      const prior = merged.get(key);
      if (prior && prior.rate !== rate) {
        throw new MinWageImportError(`${prefecture} ${effectiveFrom}: 年度により額が食い違っています`);
      }
      merged.set(key, { prefecture, rate, effectiveFrom });
    }
    const missing = PREFECTURES.filter((p) => !seen.has(p));
    if (missing.length > 0) {
      throw new MinWageImportError(`${year}: 取り込めた都道府県が ${seen.size} 件で 47 件に足りません (欠け: ${missing.join("、")})`);
    }
    years.push(year);
  }
  if (years.length === 0) throw new MinWageImportError("改定状況 xlsx から年度を 1 つも読めませんでした");
  return { rows: [...merged.values()], years: { from: years[0]!, to: years[years.length - 1]! } };
}

export interface MinWageMergeResult {
  master: MinWageMaster;
  /** 新しく足した (県, 発効日) の件数。 */
  added: number;
  /** 同じ (県, 発効日) で額が変わったので上書きした件数。 */
  updated: number;
  /** 既にあり額も同じで、何もしなかった件数。 */
  unchanged: number;
}

/**
 * 取り込んだ行を既存マスタへマージする。
 *
 * `(都道府県, 発効日)` をキーに upsert し、**既存の履歴は消さない**。
 * `branchToPrefecture` / `defaultPrefecture` と、全社共通 1 本で運用していた頃の
 * `全社共通` キー (Refs #253) もそのまま残す — 運用中のテナントを壊さないため。
 */
export function mergeMinWageRows(
  master: MinWageMaster,
  rows: MinWageImportRow[],
): MinWageMergeResult {
  const prefectures: Record<string, MinWageEntry[]> = {};
  for (const [key, entries] of Object.entries(master.prefectures)) {
    prefectures[key] = [...entries];
  }

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const row of rows) {
    const entries = prefectures[row.prefecture] ?? [];
    const at = entries.findIndex((e) => e.effectiveFrom === row.effectiveFrom);
    if (at < 0) {
      entries.push({ effectiveFrom: row.effectiveFrom, rate: row.rate });
      added += 1;
    } else if (entries[at]!.rate !== row.rate) {
      entries[at] = { effectiveFrom: row.effectiveFrom, rate: row.rate };
      updated += 1;
    } else {
      unchanged += 1;
    }
    entries.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0));
    prefectures[row.prefecture] = entries;
  }

  return {
    master: { ...master, prefectures },
    added,
    updated,
    unchanged,
  };
}
