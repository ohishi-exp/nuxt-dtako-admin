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
  /** null = この (source, 月) は一度も push されていない → R2 フォールバック対象。 */
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
