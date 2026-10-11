// 拘束サマリの ichiban push body 構築 (Refs #452 / rust-ichibanboshi#106 Phase 3b)。
//
// wage-report の素材を rust-ichibanboshi の restraint_local.sqlite に集約するため、
// 取り込み (theearth scrape / 勤怠) と resummarize の後にサマリの写しを
// `PUT /api/restraint/summaries` へ push する。このモジュールは pure (cloudflare
// 非依存): D1 写し (restraint-d1.ts) と同じ entry 列から push body を組み立て、
// 宛先 1 つへの送信ループ (`sendRestraintPushBodies`) も持つ。宛先 (fetch するもの・
// URL・ヘッダー) と secret の解決は DO 側。
//
// 分割: ichiban 側は乗務員単位 upsert (replace-all ではない) なので、body が
// 大きくなる月は複数 PUT に割って良い (冪等)。1 乗務員のサマリは日別込みで
// 数 KB のため、40 名/PUT で最大でも数百 KB — axum の既定 body 上限 (2MB) に
// 十分収まる。

import type { RestraintD1Entry } from "./restraint-d1";
import type { RestraintDriverSummary } from "./theearth-restraint-client";
import type { WageReportSource } from "./timecard-summary";
import { describeUnknownError } from "./scrape-queue";

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

/** push の宛先の名前 (ログと resummarize の応答のキー)。 */
export type RestraintPushTargetName = "kintai";

/**
 * push の宛先。宛先ごとの違い (fetch するもの・URL・ヘッダー) をここで渡す
 * (Refs ohishi-exp/rust-ichibanboshi#322)。いまは `kintai` — 勤怠 Worker (`ichibanboshi-kintai`) を
 * Service Binding + `X-Kintai-Write-Token` で — だけ。
 */
export interface RestraintPushTarget {
  url: string;
  headers: Record<string, string>;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** 宛先 1 つぶんの push の結果。`status` は非 2xx の応答の status。 */
export type RestraintPushResult =
  | { outcome: "done"; puts: number }
  | { outcome: "skipped-empty" }
  | { outcome: "skipped-not-configured" }
  | { outcome: "upstream-error"; status: number }
  | { outcome: "error"; error: string };

/**
 * 組み立て済みの body 列を宛先 1 つへ順に PUT する。best-effort で throw しない
 * (取り込み自体は成功させる。R2 が正で、欠けは resummarize の再実行で追い付ける)。
 * 非 2xx が返ったら同じ push の続きは諦める。宛先ごとに独立に呼ぶので、片方の失敗は
 * 他方を止めない。
 *
 * `target` が null = 未設定 (URL・binding・secret のどれかが無い) で skip。
 * **ログにリクエストのヘッダー (token) を出さない** — 出すのは
 * 応答本文の先頭 200 字だけ。
 */
export async function sendRestraintPushBodies(
  name: RestraintPushTargetName,
  target: RestraintPushTarget | null,
  bodies: RestraintPushBody[],
): Promise<RestraintPushResult> {
  const first = bodies[0];
  if (!first) return { outcome: "skipped-empty" };
  const ctx = { target: name, comp_id: first.comp_id, source: first.source, ym: first.month };
  if (!target) {
    // 未設定環境 (ローカル dev・staging・preview) では push なしで動く
    console.log(JSON.stringify({ restraint_push: "skipped-not-configured", ...ctx }));
    return { outcome: "skipped-not-configured" };
  }
  try {
    for (const body of bodies) {
      const res = await target.fetch(target.url, {
        method: "PUT",
        headers: { "content-type": "application/json", ...target.headers },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 200);
        console.error(JSON.stringify({ restraint_push: "upstream-error", ...ctx, status: res.status, body: text }));
        return { outcome: "upstream-error", status: res.status };
      }
    }
    const entries = bodies.reduce((n, b) => n + b.entries.length, 0);
    console.log(JSON.stringify({ restraint_push: "done", ...ctx, entries }));
    return { outcome: "done", puts: bodies.length };
  } catch (err) {
    const error = describeUnknownError(err);
    console.error(JSON.stringify({ restraint_push: "error", ...ctx, error }));
    return { outcome: "error", error };
  }
}
