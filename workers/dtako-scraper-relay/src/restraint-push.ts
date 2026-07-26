// 拘束サマリの ichiban push body 構築 (Refs #452 / rust-ichibanboshi#106 Phase 3b)。
//
// wage-report の素材を rust-ichibanboshi の restraint_local.sqlite に集約するため、
// 取り込み (theearth scrape / 勤怠) と resummarize の後にサマリの写しを
// `PUT /api/restraint/summaries` へ push する。このモジュールは pure (cloudflare
// 非依存): D1 写し (restraint-d1.ts) と同じ entry 列から push body を組み立てる
// だけで、送信 (fetch) は DO 側。
//
// 分割: ichiban 側は乗務員単位 upsert (replace-all ではない) なので、body が
// 大きくなる月は複数 PUT に割って良い (冪等)。1 乗務員のサマリは日別込みで
// 数 KB のため、40 名/PUT で最大でも数百 KB — axum の既定 body 上限 (2MB) に
// 十分収まる。

import type { RestraintD1Entry } from "./restraint-d1";
import type { RestraintDriverSummary } from "./theearth-restraint-client";
import type { WageReportSource } from "./timecard-summary";

/** 1 PUT に載せる乗務員数の上限。 */
export const RESTRAINT_PUSH_CHUNK = 40;

/** `PUT /api/restraint/summaries` の entry 1 件 (ichiban 側 PushEntry と同形)。 */
export interface RestraintPushEntry {
  driver_cd: string;
  no_data?: boolean;
  summary?: RestraintDriverSummary;
  fetched_at?: string;
  last_verified_at?: string;
}

/** `PUT /api/restraint/summaries` の body (ichiban 側 PushBody と同形)。 */
export interface RestraintPushBody {
  comp_id: string;
  source: WageReportSource;
  month: string;
  entries: RestraintPushEntry[];
}

/**
 * D1 写しと同じ entry 列から push body 列 (チャンク済み) を組み立てる。
 * entries が空なら空配列 (送信不要)。
 */
export function buildRestraintPushBodies(
  compId: string,
  source: WageReportSource,
  ym: string,
  entries: RestraintD1Entry[],
  chunkSize: number = RESTRAINT_PUSH_CHUNK,
): RestraintPushBody[] {
  const pushEntries: RestraintPushEntry[] = entries.map((entry) =>
    entry.kind === "no-data"
      ? {
          driver_cd: entry.driverCd,
          no_data: true,
          fetched_at: entry.meta.fetchedAt,
          last_verified_at: entry.meta.lastVerifiedAt,
        }
      : {
          driver_cd: entry.summary.driverCd,
          summary: entry.summary,
          fetched_at: entry.meta.fetchedAt,
          last_verified_at: entry.meta.lastVerifiedAt,
        },
  );
  const bodies: RestraintPushBody[] = [];
  for (let i = 0; i < pushEntries.length; i += chunkSize) {
    bodies.push({
      comp_id: compId,
      source,
      month: ym,
      entries: pushEntries.slice(i, i + chunkSize),
    });
  }
  return bodies;
}
