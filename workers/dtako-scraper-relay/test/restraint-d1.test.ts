// restraint-d1 (拘束サマリの D1 写し、Refs #452 PR-A) のテスト。
//
// 中核は round-trip: 実 fixture のサマリ (theearth 4 名 / timecard 6 名) を
// buildRestraintD1Statements で行に落とし、INSERT パラメータから復元した行を
// restraintSummaryFromD1Rows に通すと**元のサマリと深い等価**になることを固定する。
// この D1 写しは表示には使わない突合用のスナップショット (2026-08-03 決定、
// #606-5 / #614) — round-trip が崩れると突合の値が欠ける。

import { describe, expect, it } from 'vitest'
import {
  buildRestraintD1Statements,
  restraintSummaryFromD1Rows,
  type D1Statement,
  type RestraintD1Entry,
  type RestraintDailyD1Row,
  type RestraintMonthD1Row,
  type RestraintSummaryMeta,
} from '../src/restraint-d1'
import type { RestraintDriverSummary } from '../src/theearth-restraint-client'
import type { TimecardDriverSummary, WageReportSource } from '../src/timecard-summary'
import rawTheearthSummaries from '../../../tests/fixtures/restraint-wage/summaries.json'
import rawTimecardGolden from '../../../tests/fixtures/restraint-wage/golden/timecard-summaries.json'

const theearthSummaries = rawTheearthSummaries as unknown as RestraintDriverSummary[]
const timecardSummaries = (rawTimecardGolden as unknown as { summaries: TimecardDriverSummary[] })
  .summaries

const META: RestraintSummaryMeta = {
  sha256: 'a'.repeat(64),
  fetchedAt: '2026-07-01T00-00-00Z',
  lastVerifiedAt: '2026-07-02T00-00-00Z',
}

// INSERT のカラム順 (migration 0016 / restraint-d1.ts と同順)。並びを変えたら
// ここも合わせる — round-trip が崩れるのでズレは必ずテストで検出される。
const MONTH_COLUMNS = [
  'comp_id', 'source', 'driver_cd', 'ym', 'no_data', 'driver_name', 'branch_name',
  'work_days', 'rest_days', 'restraint_minutes', 'driving_minutes', 'loading_minutes',
  'break_minutes', 'working_minutes', 'overtime_minutes', 'night_minutes',
  'overtime_night_minutes', 'max_daily_restraint_minutes', 'fiscal_cumulative_minutes',
  'restraint_limit_minutes', 'excess_restraint_minutes', 'over15h_days',
  'avg_driving_9h_over_count', 'voluntary_minutes', 'punch_error_days',
  'punch_error_minutes', 'leave_counts', 'sha256', 'fetched_at', 'last_verified_at',
] as const
const DAILY_COLUMNS = [
  'comp_id', 'source', 'driver_cd', 'ym', 'day', 'is_rest_day', 'restraint_minutes',
  'working_minutes', 'overtime_minutes', 'night_minutes', 'overtime_night_minutes',
  'holiday_kind', 'voluntary_minutes', 'punch_error_minutes', 'leaves', 'sessions',
] as const

/** ステートメント列を「INSERT パラメータ → 行」で解釈するミニ実行器。 */
function applyStatements(statements: D1Statement[]): {
  months: RestraintMonthD1Row[]
  daysByDriver: Map<string, RestraintDailyD1Row[]>
} {
  const months: RestraintMonthD1Row[] = []
  const daysByDriver = new Map<string, RestraintDailyD1Row[]>()
  for (const stmt of statements) {
    if (stmt.sql.startsWith('DELETE FROM restraint_daily')) {
      daysByDriver.delete(String(stmt.params[2]))
    }
    else if (stmt.sql.includes('INSERT INTO restraint_driver_month')) {
      const row = Object.fromEntries(MONTH_COLUMNS.map((c, i) => [c, stmt.params[i]]))
      months.push(row as unknown as RestraintMonthD1Row)
    }
    else if (stmt.sql.includes('INSERT INTO restraint_daily')) {
      for (let i = 0; i < stmt.params.length; i += DAILY_COLUMNS.length) {
        const row = Object.fromEntries(
          DAILY_COLUMNS.map((c, j) => [c, stmt.params[i + j]]),
        ) as unknown as RestraintDailyD1Row & { driver_cd: string }
        const list = daysByDriver.get(row.driver_cd) ?? []
        list.push(row)
        daysByDriver.set(row.driver_cd, list)
      }
    }
  }
  return { months, daysByDriver }
}

function roundTrip(source: WageReportSource, summary: RestraintDriverSummary) {
  const statements = buildRestraintD1Statements('comp-1', source, '2026-06', [
    { kind: 'summary', summary, meta: META },
  ])
  const { months, daysByDriver } = applyStatements(statements)
  expect(months).toHaveLength(1)
  return restraintSummaryFromD1Rows(months[0]!, daysByDriver.get(summary.driverCd) ?? [])
}

describe('round-trip (summary → D1 行 → summary)', () => {
  it('theearth fixture 4 名が恒等で戻る (null 欠損・holidayKind 無しを含む)', () => {
    for (const summary of theearthSummaries) {
      const loaded = roundTrip('theearth', summary)
      expect(loaded.noData).toBe(false)
      if (loaded.noData) continue
      expect(loaded.data).toStrictEqual(summary)
      expect(loaded.fetchedAt).toBe(META.fetchedAt)
      expect(loaded.lastVerifiedAt).toBe(META.lastVerifiedAt)
    }
  })

  it('timecard golden 6 名が恒等で戻る (sessions / leaves / leaveCounts を含む)', () => {
    for (const summary of timecardSummaries) {
      const loaded = roundTrip('timecard', summary)
      expect(loaded.noData).toBe(false)
      if (loaded.noData) continue
      expect(loaded.data).toStrictEqual(summary)
    }
  })

  it('日別行の並びが崩れていても day 順に整列して戻す', () => {
    const summary = theearthSummaries[0]!
    const statements = buildRestraintD1Statements('comp-1', 'theearth', '2026-06', [
      { kind: 'summary', summary, meta: META },
    ])
    const { months, daysByDriver } = applyStatements(statements)
    const shuffled = [...daysByDriver.get(summary.driverCd)!].reverse()
    const loaded = restraintSummaryFromD1Rows(months[0]!, shuffled)
    expect(loaded.noData).toBe(false)
    if (loaded.noData) return
    expect(loaded.data.days.map(d => d.day)).toStrictEqual(summary.days.map(d => d.day))
  })
})

describe('noData マーカー (Refs #241)', () => {
  it('no-data entry は月行 no_data=1 のみで日別行を残さず、復元で noData に戻る', () => {
    const statements = buildRestraintD1Statements('comp-1', 'theearth', '2026-06', [
      { kind: 'no-data', driverCd: '9901', meta: META },
    ])
    // DELETE (日別総入れ替え) + 月行 upsert のみ
    expect(statements).toHaveLength(2)
    const { months, daysByDriver } = applyStatements(statements)
    expect(daysByDriver.size).toBe(0)
    expect(months[0]!.no_data).toBe(1)
    const loaded = restraintSummaryFromD1Rows(months[0]!, [])
    expect(loaded).toStrictEqual({ noData: true, driverCd: '9901' })
  })
})

describe('ステートメントの形', () => {
  it('D1 の bind 上限 (100/statement) を全ステートメントで下回る', () => {
    const entries: RestraintD1Entry[] = [
      ...theearthSummaries.map(summary => ({ kind: 'summary' as const, summary, meta: META })),
      { kind: 'no-data', driverCd: '9999', meta: META },
    ]
    const statements = buildRestraintD1Statements('comp-1', 'theearth', '2026-06', entries)
    for (const stmt of statements) expect(stmt.params.length).toBeLessThanOrEqual(100)
  })

  it('31 日分は 6 行ずつ 6 INSERT に分割される (delete + month + 6)', () => {
    const summary: RestraintDriverSummary = {
      ...theearthSummaries[0]!,
      days: Array.from({ length: 31 }, (_, i) => ({
        day: i + 1,
        isRestDay: i % 7 === 0,
        restraintMinutes: 600,
        workingMinutes: 540,
        overtimeMinutes: 60,
        nightMinutes: 0,
        overtimeNightMinutes: 0,
      })),
    }
    const statements = buildRestraintD1Statements('comp-1', 'theearth', '2026-06', [
      { kind: 'summary', summary, meta: META },
    ])
    expect(statements).toHaveLength(2 + Math.ceil(31 / 6))
    const loaded = roundTrip('theearth', summary)
    if (!loaded.noData) expect(loaded.data.days).toHaveLength(31)
  })

  it('days が空でも delete + month upsert は出る (日別行の残骸を消す)', () => {
    const summary: RestraintDriverSummary = { ...theearthSummaries[0]!, days: [] }
    const statements = buildRestraintD1Statements('comp-1', 'theearth', '2026-06', [
      { kind: 'summary', summary, meta: META },
    ])
    expect(statements).toHaveLength(2)
    expect(statements[0]!.sql).toContain('DELETE FROM restraint_daily')
    expect(statements[1]!.sql).toContain('ON CONFLICT (comp_id, source, driver_cd, ym)')
  })
})

describe('手作業・欠損行への防御 (書き込み側は通らない経路)', () => {
  const monthBase: RestraintMonthD1Row = {
    comp_id: 'comp-1',
    source: 'timecard',
    driver_cd: '77',
    ym: '2026-06',
    no_data: 0,
    driver_name: '手作業　花子',
    branch_name: '本社',
    work_days: null,
    rest_days: null,
    restraint_minutes: null,
    driving_minutes: null,
    loading_minutes: null,
    break_minutes: null,
    working_minutes: null,
    overtime_minutes: null,
    night_minutes: null,
    overtime_night_minutes: null,
    max_daily_restraint_minutes: null,
    fiscal_cumulative_minutes: null,
    restraint_limit_minutes: null,
    excess_restraint_minutes: null,
    over15h_days: null,
    avg_driving_9h_over_count: null,
    voluntary_minutes: null,
    punch_error_days: null,
    punch_error_minutes: null,
    leave_counts: null,
    sha256: null,
    fetched_at: null,
    last_verified_at: null,
  }

  it('数値カラム NULL は 0 / 既定 leaveCounts で埋める (timecard)', () => {
    const dayRow: RestraintDailyD1Row = {
      driver_cd: '77',
      day: 3,
      is_rest_day: 1,
      restraint_minutes: null,
      working_minutes: null,
      overtime_minutes: null,
      night_minutes: null,
      overtime_night_minutes: null,
      holiday_kind: 'legal',
      voluntary_minutes: null,
      punch_error_minutes: null,
      leaves: null,
      sessions: null,
    }
    const loaded = restraintSummaryFromD1Rows(monthBase, [dayRow])
    expect(loaded.noData).toBe(false)
    if (loaded.noData) return
    const data = loaded.data as TimecardDriverSummary
    expect(data.workDays).toBe(0)
    expect(data.voluntaryMinutes).toBe(0)
    expect(data.punchErrorDays).toBe(0)
    expect(data.punchErrorMinutes).toBe(0)
    expect(data.leaveCounts).toStrictEqual({
      publicHoliday: 0, paidLeave: 0, absence: 0, specialLeave: 0, late: 0, earlyLeave: 0,
    })
    const day = data.days[0]!
    expect(day.isRestDay).toBe(true)
    expect(day.holidayKind).toBe('legal')
    expect(day.voluntaryMinutes).toBe(0)
    expect(day.punchErrorMinutes).toBe(0)
    expect(day.leaves).toStrictEqual([])
    expect(day.sessions).toStrictEqual([])
    expect(loaded.fetchedAt).toBeNull()
    expect(loaded.lastVerifiedAt).toBeNull()
  })

  it('theearth 側でも月計 NULL は 0 で埋める', () => {
    const loaded = restraintSummaryFromD1Rows({ ...monthBase, source: 'theearth' }, [])
    expect(loaded.noData).toBe(false)
    if (loaded.noData) return
    expect(loaded.data.workDays).toBe(0)
    expect(loaded.data.restDays).toBe(0)
    expect(loaded.data.over15hDays).toBe(0)
    expect(loaded.data.avgDriving9hOverCount).toBe(0)
    expect(loaded.data.restraintMinutes).toBeNull()
  })
})
