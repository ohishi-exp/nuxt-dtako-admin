// 打刻基準の日別サマリ (ドライバーの拘束・深夜) の受け取りテスト (Refs #472 PR-B)
import { describe, expect, it } from 'vitest'
import { parseKosokuDaily, toKosokuDay } from '../../app/utils/kosoku-daily'

/** 上流 (rust-ichibanboshi /api/kintai/kosoku-daily) の 1 日ぶんの形。 */
function rawDay(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    date: '2026-06-02',
    start: '2026-06-02 09:25:00',
    end: '2026-06-02 19:39:00',
    source: 'timecard',
    is_legal_holiday: false,
    over_24h: false,
    restraint_minutes: 614,
    break_minutes: 96,
    working_minutes: 518,
    statutory_minutes: 450,
    within_statutory_overtime_minutes: 30,
    overtime_minutes: 38,
    legal_holiday_minutes: 0,
    night_minutes: 0,
    overtime_night_minutes: 0,
    legal_holiday_night_minutes: 0,
    ...over,
  }
}

describe('toKosokuDay', () => {
  it('snake_case の日別サマリを画面用に直す', () => {
    const d = toKosokuDay(rawDay())
    expect(d).not.toBeNull()
    expect(d!.date).toBe('2026-06-02')
    expect(d!.source).toBe('timecard')
    expect(d!.restraintMinutes).toBe(614)
    expect(d!.withinStatutoryOvertimeMinutes).toBe(30)
    expect(d!.overtimeMinutes).toBe(38)
    expect(d!.isLegalHoliday).toBe(false)
    expect(d!.over24h).toBe(false)
  })

  it('休息由来・法定休日・24時間超のフラグを保つ', () => {
    const d = toKosokuDay(rawDay({
      source: 'rest',
      is_legal_holiday: true,
      over_24h: true,
      restraint_minutes: 1440,
      legal_holiday_minutes: 1440,
      legal_holiday_night_minutes: 420,
    }))!
    expect(d.source).toBe('rest')
    expect(d.isLegalHoliday).toBe(true)
    expect(d.over24h).toBe(true)
    expect(d.legalHolidayNightMinutes).toBe(420)
  })

  it('日付・始業・終業が欠けた日は捨てる (0 の行として並べない)', () => {
    expect(toKosokuDay(rawDay({ date: null }))).toBeNull()
    expect(toKosokuDay(rawDay({ start: '' }))).toBeNull()
    expect(toKosokuDay(rawDay({ end: undefined }))).toBeNull()
    expect(toKosokuDay(null)).toBeNull()
    expect(toKosokuDay('2026-06-02')).toBeNull()
  })

  it('数値の欠け・非数値は 0 で埋める (項目が増減しても落ちない)', () => {
    const d = toKosokuDay({
      date: '2026-06-02',
      start: '2026-06-02 09:00:00',
      end: '2026-06-02 18:00:00',
      restraint_minutes: '540',
      night_minutes: Number.NaN,
    })!
    expect(d.restraintMinutes).toBe(0)
    expect(d.nightMinutes).toBe(0)
    expect(d.workingMinutes).toBe(0)
    // source が無ければ打刻扱い (上流の既定と同じ)
    expect(d.source).toBe('timecard')
  })
})

describe('parseKosokuDaily', () => {
  it('乗務員CD 引きの表にする', () => {
    const idx = parseKosokuDaily({
      month: '2026-06',
      drivers: [
        { driver: 1018, days: [rawDay()] },
        { driver: 1119, days: [rawDay({ date: '2026-06-03' }), rawDay({ date: '2026-06-04' })] },
      ],
    })
    expect(idx.month).toBe('2026-06')
    expect([...idx.byDriver.keys()]).toEqual(['1018', '1119'])
    expect(idx.byDriver.get('1119')!.length).toBe(2)
  })

  it('乗務員CD を正規化する (0012 と 12 を同じ人として引く)', () => {
    const idx = parseKosokuDaily({ month: '2026-06', drivers: [{ driver: '0012', days: [rawDay()] }] })
    expect(idx.byDriver.get('12')).toBeDefined()
  })

  it('日が 1 つも残らない乗務員は入れない', () => {
    const idx = parseKosokuDaily({
      month: '2026-06',
      drivers: [
        { driver: 1018, days: [] },
        { driver: 1119, days: [{ date: null }] },
        { driver: 1442, days: [rawDay()] },
      ],
    })
    expect([...idx.byDriver.keys()]).toEqual(['1442'])
  })

  it('乗務員CD が数でない項目は捨てる', () => {
    const idx = parseKosokuDaily({
      month: '2026-06',
      drivers: [
        { driver: 'abc', days: [rawDay()] },
        { days: [rawDay()] },
        null,
        1119,
        { driver: 1119, days: 'nope' },
      ],
    })
    expect(idx.byDriver.size).toBe(0)
  })

  it('drivers が無い応答は空 (画面はドライバー行が出ないだけ)', () => {
    expect(parseKosokuDaily({ month: '2026-06' }).byDriver.size).toBe(0)
    expect(parseKosokuDaily({ month: '2026-06', drivers: {} }).byDriver.size).toBe(0)
    expect(parseKosokuDaily(null).byDriver.size).toBe(0)
    expect(parseKosokuDaily('boom').byDriver.size).toBe(0)
  })

  it('month が無ければ呼び出し側の月を使う (どの月の値か分からなくしない)', () => {
    expect(parseKosokuDaily({ drivers: [] }, '2026-06').month).toBe('2026-06')
    expect(parseKosokuDaily({}).month).toBe('')
  })
})
