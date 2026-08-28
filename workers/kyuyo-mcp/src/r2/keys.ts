/**
 * R2 key builder。既存 `workers/dtako-scraper-relay` の規約をそのまま踏襲する
 * (新規実装しない)。
 *
 * ## 型は import する。複製するのは関数だけ (Refs #1022)
 *
 * - **型 `WageMasterName` は relay の `restraint-wage.ts` が正本で、ここは
 *   import して再輸出するだけ。** この worker は `mcp/tools.ts` で既に同じ
 *   ファイルから import しているので、型を複製する理由が無い。**複製していた頃は
 *   実際に drift していた** — #805 PR-1 が relay に足した `"allowance-rate"` が、
 *   この複製だけ 4 値のまま取り残された。import にすると drift は
 *   「検出される」のではなく**起きえなくなる**。
 * - **関数 `wageMasterR2Paths` だけは複製する。** 正本が
 *   `dtako-scraper-relay-do.ts` の private instance method (`this.env` に依存)
 *   で import できないため (3 行)。
 * - `restraintR2Paths` は `theearth-restraint-client.ts` の純粋関数をそのまま
 *   import する。
 */
import type { WageMasterName } from "../../../dtako-scraper-relay/src/restraint-wage";

export { restraintR2Paths } from "../../../dtako-scraper-relay/src/theearth-restraint-client";

/** R2 のマスタ種別 (`restraint/{compId}/{name}/…`)。**正本は relay 側**。 */
export type { WageMasterName };

/** `dtako-scraper-relay-do.ts::wageMasterR2Paths` と同一ロジック (prefix を引数化)。 */
export function wageMasterR2Paths(
  prefix: string,
  compId: string,
  name: WageMasterName,
): { dir: string; latest: string; version: (ts: string) => string } {
  const dir = `${prefix}/${compId}/${name}`;
  return { dir, latest: `${dir}/latest.json`, version: (ts: string) => `${dir}/v-${ts}.json` };
}

/** 会社一覧を得るための R2 prefix (`{prefix}/`)。既存 precedent は無いが
 *  `monthsListPrefix` の 1 階層上への直接の類推。 */
export function companiesListPrefix(prefix: string): string {
  return `${prefix}/`;
}

/** 指定会社の月一覧を得るための R2 prefix (`{prefix}/{compId}/`)。
 *  `dtako-scraper-relay-do.ts::handleArchiveMonths` と同じ pattern。 */
export function monthsListPrefix(prefix: string, compId: string): string {
  return `${prefix}/${compId}/`;
}

/** 指定会社・年月の summary 一覧を得るための R2 prefix。
 *  `dtako-scraper-relay-do.ts::loadMonthSummaries` と同じ pattern。 */
export function summaryListPrefix(prefix: string, compId: string, ym: string): string {
  return `${prefix}/${compId}/${ym}/summary/`;
}
