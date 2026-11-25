/**
 * 一番星突合の「すべて出す」を cron で押すための pure ロジック (`ICHIBAN_MAKECSV_CRON`)。
 *
 * **画面 (`app/utils/ichiban-check.ts` の `flattenIchibanCheck` + `idsOfRows`) と同じ id を同じ並びで返す。**
 * relay は app/ を import できない (vitest が repo ルートの `.nuxt` 前提の tsconfig を読みに行って落ちる) ので、
 * 規則を写して持ち、**両側に同じ fixture** (`tests/fixtures/ichiban-check/makecsv-ids.json`) を当てて
 * 食い違いを検出する (#1017 ④ の運行手当マスタと同じ流儀)。画面側の規則を変えたらこちらも変えること。
 *
 * 応答の形は app 側の doc (yhonda-ohishi/nginx#826): `diffs` / `ids` は同じ入れ子で、勤怠だけ
 * 「項目」の段が 1 つ多い。行は `diffs` のキー (付き物 `差分` 等を外した本体) ごとに 1 行で、
 * その行の id は `ids[本体]` と `ids[本体差分]`。`diffs` に無いキーの id は画面に出ないので出さない。
 */

const CATEGORIES = ["勤怠", "燃料", "経費", "旅費残業", "支払日"] as const;
const SUFFIXES = ["差分", "_車両番号", "_部門", "_dtako_row_id"] as const;

/** 勤怠 Worker の 1 回あたりの上限 (`MAKECSV_MAX_IDS`、画面の `MAKECSV_CHUNK` と同じ)。 */
export const MAKECSV_CHUNK = 500;

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function rec(v: unknown): Rec {
  return isRecord(v) ? v : {};
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function baseKey(key: string): string {
  for (const s of SUFFIXES) {
    if (key.endsWith(s) && key.length > s.length) return key.slice(0, -s.length);
  }
  return key;
}

/** 突合の応答 → 画面の行数と「すべて出す」の id (重複なし、画面と同じ並び)。 */
export function ichibanCheckIds(res: unknown): { rows: number; ids: string[] } {
  const diffs = rec(rec(res).diffs);
  const idsRoot = rec(rec(res).ids);
  const out = new Set<string>();
  let rows = 0;
  const byDriver = (values: Rec, ids: Rec) => {
    for (const cd of Object.keys(values).sort()) {
      if (!isRecord(values[cd])) continue;
      const driverIds = rec(ids[cd]);
      for (const b of [...new Set(Object.keys(values[cd]).map(baseKey))].sort()) {
        rows += 1;
        for (const id of [...strings(driverIds[b]), ...strings(driverIds[`${b}差分`])]) out.add(id);
      }
    }
  };
  for (const c of CATEGORIES) {
    if (c === "勤怠") {
      const items = rec(diffs[c]);
      const idItems = rec(idsRoot[c]);
      for (const item of Object.keys(items).sort()) {
        if (isRecord(items[item])) byDriver(items[item], rec(idItems[item]));
      }
    } else {
      byDriver(rec(diffs[c]), rec(idsRoot[c]));
    }
  }
  return { rows, ids: [...out] };
}

/** id を 1 回で送れる大きさに分ける。 */
export function chunkIds(ids: readonly string[], size = MAKECSV_CHUNK): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export type MakecsvCounts = { written: number; skipped: number; error: number };

/** 勤怠 Worker の `{results: [{id, status}]}` を数える (形が違う要素は数えない。画面の `parseMakecsvResults` と同じ)。 */
export function countMakecsvResults(body: unknown, into: MakecsvCounts): MakecsvCounts {
  const list = isRecord(body) && Array.isArray(body.results) ? body.results : [];
  for (const r of list) {
    if (!isRecord(r) || typeof r.id !== "string") continue;
    if (r.status === "written" || r.status === "skipped" || r.status === "error") into[r.status] += 1;
  }
  return into;
}
