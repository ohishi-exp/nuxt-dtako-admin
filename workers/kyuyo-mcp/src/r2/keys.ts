/**
 * R2 key builder。既存 `workers/dtako-scraper-relay` の規約をそのまま踏襲する
 * (新規実装しない)。
 *
 * `restraintR2Paths` は `theearth-restraint-client.ts` の純粋関数をそのまま
 * import する。一方 `wageMasterR2Paths` は `dtako-scraper-relay-do.ts` の
 * private instance method (`this.env` に依存) で import できないため、
 * ここに同じロジックをローカル複製する (3 行、Refs 調査で判明した drift)。
 */
export { restraintR2Paths } from "../../../dtako-scraper-relay/src/theearth-restraint-client";

export type WageMasterName =
  | "wage-master"
  | "min-wage"
  | "wage-config"
  | "salary-item-config"
  | "salary-cd-map";

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
