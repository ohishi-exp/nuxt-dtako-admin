/**
 * オンプレのデジタコ運行 (`dtako_rows`) から、乗務員 × 月の運行一覧を作る pure ロジック
 * (訴訟準備「alc にあってオンプレのデジタコに無い運行」、Refs #1133)。
 *
 * 上流は rust-ichibanboshi `GET /api/kintai/reading-dates?month=&driver=` — `dtako_rows` を
 * 出庫日時・帰庫日時・運行日のどれかが「月初〜翌月 2 日」にかかる運行で引く (広め)。
 * ここで**運行を始めた月** (運行NO の先頭 4 桁 `YYMM`) が対象月のものだけに絞り、先頭 22 桁
 * (対象CD を落とした運行の番号) にして返す。alc 側も同じ 22 桁・同じ月の決め方で突き合わせる
 * (画面の `litigation-errors.ts`)。
 *
 * `time_card_dtako` (タイムカードに紐付く勤務時間登録) は**見ない** — 打刻しない乗務員
 * (営業所所属など) には無いのが正常で、デジタコの運行が揃っているかの照合先にならない
 * (ある乗務員の 2023-06 で、time_card_dtako は 0 件・dtako の運行は alc の 7 件と全部一致、2026-09-29)。
 */

const UNKO_NO_RE = /^\d{22,23}$/;
const MONTH_RE = /^(\d{2})(\d{2})-(0[1-9]|1[0-2])$/;

export interface OnpremMonthOperations {
  /** 対象月に始まった運行の先頭 22 桁 (昇順・重複なし) */
  opeNos: string[];
  /** 上流の `items` が `total` より少ない (上流の上限で切れた) — 一覧が欠けている */
  truncated: boolean;
}

/** `YYYY-MM` → 運行NO の先頭 4 桁 (`YYMM`)。形が違えば null。 */
export function unkoNoMonthPrefix(month: string): string | null {
  const m = MONTH_RE.exec(month);
  return m ? `${m[2]}${m[3]}` : null;
}

/** `reading-dates` の応答 (`raw`) から、対象月に始まった運行の 22 桁を拾う。形の崩れた行は落とす。 */
export function pickOnpremMonthOperations(raw: unknown, month: string): OnpremMonthOperations {
  const prefix = unkoNoMonthPrefix(month);
  const r = (raw ?? {}) as Record<string, unknown>;
  const items = Array.isArray(r.items) ? r.items : [];
  const out = new Set<string>();
  for (const it of items) {
    const u = (it as { unko_no?: unknown } | null)?.unko_no;
    if (typeof u !== "string" || !UNKO_NO_RE.test(u) || prefix === null || !u.startsWith(prefix)) continue;
    out.add(u.slice(0, 22));
  }
  const total = typeof r.total === "number" ? r.total : items.length;
  return { opeNos: [...out].sort(), truncated: items.length < total };
}
