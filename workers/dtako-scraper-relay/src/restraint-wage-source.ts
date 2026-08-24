// ichiban wage-source 応答 → loadMonthSummaries 形への変換 (Refs #452 /
// rust-ichibanboshi#106 Phase 3c)。
//
// wage-report の素材読みを「R2 GET 約300本」から「ichiban への 1 fetch
// (GET /api/restraint/wage-source)」に切り替えるための pure 部分。応答の
// summary は relay 自身が push した JSON の素通しなので、ここでは
// loadMonthSummaries と同じ防御 (v1 days 補完) と並び (乗務員CD 数値順) だけを
// 揃える — 型の中身は golden テスト済みの relay 側が正。

import type { RestraintDriverSummary, RestraintSummaryDay } from "./theearth-restraint-client";

/** ichiban `WageSourceMonth` の wire 形。 */
export interface WageSourceMonthWire {
  summaries: Array<{
    driver_cd: string;
    summary: unknown;
    fetched_at: string | null;
    last_verified_at: string | null;
  }>;
  no_data_drivers: string[];
  /** null = この (source, 月) は一度も push されていない → R2 フォールバック対象。
   * **非 null でも写しが空なら R2 へ落ちる** — 判定は `wageSourceMonthR2Fallback`
   * (#812)。ここだけ見て「push 済み = 中身が在る」と読まないこと。 */
  synced_at: string | null;
}

/** ichiban `GET /api/restraint/wage-source` 応答の wire 形。 */
export interface WageSourceResponseWire {
  month: string;
  prev_month: string;
  current_theearth: WageSourceMonthWire;
  current_timecard: WageSourceMonthWire;
  prev_theearth: WageSourceMonthWire;
  prev_timecard: WageSourceMonthWire;
}

/** R2 フォールバックの理由タグ (`wage_report_source` ログの値、Refs #812)。 */
export type WageSourceR2FallbackTag = "r2-piece-fallback" | "r2-empty-copy-fallback";

/** loadMonthSummaries と同じ返り形 (handleWageReport の素材)。 */
export interface MonthSummaries {
  summaries: Array<{
    data: RestraintDriverSummary;
    fetchedAt: string | null;
    lastVerifiedAt: string | null;
  }>;
  noDataDrivers: string[];
}

/**
 * wire 1 ヶ月分を loadMonthSummaries 形へ写す。
 *
 * - v1 summary (days なし) は days:[] に補完 (loadMonthSummaries と同じ防御)
 * - 並びは乗務員CD の数値順 (localeCompare numeric — R2 経路と同一)
 */
export function wageSourceMonthToSummaries(wire: WageSourceMonthWire): MonthSummaries {
  const summaries = wire.summaries.map((s) => {
    const summary = s.summary as RestraintDriverSummary & { days?: unknown };
    return {
      data: {
        ...summary,
        days: Array.isArray(summary.days) ? (summary.days as RestraintSummaryDay[]) : [],
      },
      fetchedAt: s.fetched_at,
      lastVerifiedAt: s.last_verified_at,
    };
  });
  summaries.sort((a, b) => a.data.driverCd.localeCompare(b.data.driverCd, undefined, { numeric: true }));
  return { summaries, noDataDrivers: [...wire.no_data_drivers] };
}

/**
 * theearth 側 1 ヶ月分について「写しを信じるか / R2 へ落ちるか」の判定
 * (pure、Refs #812)。返り値は `null` = 写しを使う、それ以外は
 * `wage_report_source` ログに載せる**理由別のタグ**。
 *
 * - `"r2-piece-fallback"`: `synced_at === null` = この (source, 月) は一度も
 *   push されていない (過渡期・新月の初回)。従来からある経路。
 * - `"r2-empty-copy-fallback"`: push はされた (`synced_at` 非 null) のに写しが
 *   **何も持っていない**。R2 に完全なデータが在るのに読みに行かず表が空になる
 *   欠陥 (#812、本番 2026-07 で 111 名まるごと消えた) を塞ぐ。
 *
 * ★ 「何も持っていない」を `summaries.length === 0` **だけ**で判定してはいけない。
 * `no_data_drivers` が入っているなら「調べた上で該当 0 名だった」なので写しは
 * 正しい — そこを区別しないと、本当に 0 名の月で毎回 R2 fan-out (約300 GET) を
 * 叩くことになる。よって**両方空**のときだけ落とす。
 *
 * ★ **timecard 側 (`current_timecard` / `prev_timecard`) には使わない。**
 * timecard は `buildKintaiSummariesLive` の成否だけで決める (#606-5) — 写しも
 * R2 (`kintai/` prefix) も「取り込みボタンが最後に押された時点の化石」でしかなく、
 * 読むと古い値を正しい拘束時間として黙って表示しかねない。
 */
export function wageSourceMonthR2Fallback(wire: WageSourceMonthWire): WageSourceR2FallbackTag | null {
  if (wire.synced_at === null) return "r2-piece-fallback";
  if (wire.summaries.length === 0 && wire.no_data_drivers.length === 0) return "r2-empty-copy-fallback";
  return null;
}

/** 応答が wage-source の wire 形として最低限成立しているか (fetch 側の防御)。 */
export function isWageSourceResponse(raw: unknown): raw is WageSourceResponseWire {
  if (typeof raw !== "object" || raw === null) return false;
  const record = raw as Record<string, unknown>;
  return (["current_theearth", "current_timecard", "prev_theearth", "prev_timecard"] as const).every(
    (key) => {
      const month = record[key];
      if (typeof month !== "object" || month === null) return false;
      const m = month as Record<string, unknown>;
      return Array.isArray(m.summaries) && Array.isArray(m.no_data_drivers);
    },
  );
}
