/**
 * 厚労省「地域別最低賃金の全国一覧」の取り込み (pure)。
 *
 * 最低賃金には公的な API が無い — 厚労省の提供形式は PDF / Excel / HTML テーブル
 * だけで、e-Stat にも data.go.jp にも地域別最低賃金額のデータセットは無い
 * (「最低賃金に関する実態調査」は別物)。よって HTML テーブルを取り込む。
 *
 * 取得元に `saiteichingin.mhlw.go.jp` を選んだ理由: URL が安定している。
 * `mhlw.go.jp` 側の「地域別最低賃金改定状況」xlsx は平成14年度からの全履歴が
 * 入っていて魅力的だが、URL に年ごとに変わる content ID (`001571219.xlsx`) が
 * 入るためインデックスページの走査が要る。
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
