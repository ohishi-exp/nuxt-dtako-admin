// 打刻基準の日別サマリ (ドライバーの拘束・深夜) の受け取りテスト (Refs #472 PR-B)
import { describe, expect, it } from 'vitest'
import {
  buildKosokuTimecardTable,
  countKosokuWorkKinds,
  groupTimecardSheetsByCompany,
  mergeKosokuDays,
  parseKosokuDaily,
  toKosokuDay,
} from '../../app/utils/kosoku-daily'
import type { KosokuDay } from '../../app/utils/kosoku-daily'

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

/** 勤務 1 本。時刻以外は既定値。 */
function shift(start: string, end: string, over: Partial<KosokuDay> = {}): KosokuDay {
  return {
    date: start.slice(0, 10),
    start,
    end,
    source: 'rest',
    isLegalHoliday: false,
    over24h: false,
    restraintMinutes: 0,
    breakMinutes: 0,
    workingMinutes: 0,
    statutoryMinutes: 0,
    withinStatutoryOvertimeMinutes: 0,
    overtimeMinutes: 0,
    legalHolidayMinutes: 0,
    nightMinutes: 0,
    overtimeNightMinutes: 0,
    legalHolidayNightMinutes: 0,
    ...over,
  }
}

describe('buildKosokuTimecardTable', () => {
  it('1〜月末の全日を出し、始業した日に 出勤1/退社1 を置く', () => {
    const rows = buildKosokuTimecardTable([shift('2026-06-02 06:00:00', '2026-06-02 18:30:00')], 2026, 6)
    expect(rows.length).toBe(30)
    expect(rows[1]).toMatchObject({ day: 2, dowLabel: '火', in1: '06:00', out1: '18:30', in2: null, out2: null })
    // 勤務の無い日は空行として並べる (日付が飛ぶと目で追えない)
    expect(rows[0]).toMatchObject({ day: 1, in1: null, out1: null, note: '' })
  })

  it('同じ日に始業した 2 本目は 出勤2/退社2 (実際に起きる)', () => {
    const rows = buildKosokuTimecardTable([
      shift('2026-06-08 14:00:00', '2026-06-08 18:00:00'),
      shift('2026-06-08 04:42:00', '2026-06-08 10:00:00'),
    ], 2026, 6)
    // 時刻順に 1 本目 / 2 本目へ入る (入力順ではない)
    expect(rows[7]).toMatchObject({ in1: '04:42', out1: '10:00', in2: '14:00', out2: '18:00', note: '' })
  })

  it('3 本以上は想定外 — 8 列に入らない分は備考に件数を出す (#472)', () => {
    const rows = buildKosokuTimecardTable([
      shift('2026-06-10 01:00:00', '2026-06-10 03:00:00'),
      shift('2026-06-10 06:00:00', '2026-06-10 09:00:00'),
      shift('2026-06-10 12:00:00', '2026-06-10 15:00:00'),
    ], 2026, 6)
    expect(rows[9]).toMatchObject({ in1: '01:00', out1: '03:00', in2: '06:00', out2: '09:00' })
    expect(rows[9]!.note).toContain('出退勤 6 件')
  })

  it('始業・終業はそれぞれ起きた日の行に出す', () => {
    const rows = buildKosokuTimecardTable([shift('2026-06-02 22:00:00', '2026-06-03 08:00:00')], 2026, 6)
    expect(rows[1]).toMatchObject({ day: 2, in1: '22:00', out1: null })
    expect(rows[2]).toMatchObject({ day: 3, in1: null, out1: '08:00' })
  })

  it('前日から続く終業がある日は 退社1 に入り、その日の始業は 出勤2 へ回る (社内 PDF と同じ形)', () => {
    const rows = buildKosokuTimecardTable([
      shift('2026-06-02 22:00:00', '2026-06-03 08:00:00'),
      shift('2026-06-03 20:00:00', '2026-06-04 06:00:00'),
    ], 2026, 6)
    expect(rows[2]).toMatchObject({ day: 3, in1: null, out1: '08:00', in2: '20:00', out2: null })
    expect(rows[2]!.note).toBe('')
    expect(rows[3]).toMatchObject({ day: 4, in1: null, out1: '06:00' })
  })

  it('始業が前月でも終業は出す (月初の「退社が取れていない」を作らない)', () => {
    // 乗務員 1194 / 2026-04-01 で実際に起きていた形
    const rows = buildKosokuTimecardTable([
      shift('2026-05-31 21:00:00', '2026-06-01 17:07:00'),
      shift('2026-06-01 21:31:00', '2026-06-02 15:00:00'),
    ], 2026, 6)
    expect(rows[0]).toMatchObject({ day: 1, in1: null, out1: '17:07', in2: '21:31', out2: null })
    expect(rows[1]).toMatchObject({ day: 2, out1: '15:00' })
  })

  it('翌月に終業する勤務は始業だけ出す (終業を置く行がこの表に無い)', () => {
    const rows = buildKosokuTimecardTable([shift('2026-06-30 20:00:00', '2026-07-01 09:00:00')], 2026, 6)
    expect(rows[29]).toMatchObject({ day: 30, in1: '20:00', out1: null })
    expect(rows[29]!.note).toBe('')
  })

  it('同時刻に終業と始業が並ぶ日は終業が先 (前の勤務が終わってから次が始まる)', () => {
    const rows = buildKosokuTimecardTable([
      shift('2026-06-02 06:00:00', '2026-06-03 14:00:00'),
      shift('2026-06-03 14:00:00', '2026-06-03 22:00:00'),
    ], 2026, 6)
    expect(rows[2]).toMatchObject({ day: 3, in1: null, out1: '14:00', in2: '14:00', out2: '22:00' })
  })

  it('残業は 時間外 + 時間外深夜 (事務員と同じ定義)、同じ日は合算', () => {
    const rows = buildKosokuTimecardTable([
      shift('2026-06-02 06:00:00', '2026-06-02 12:00:00', { overtimeMinutes: 30, overtimeNightMinutes: 0 }),
      shift('2026-06-02 20:00:00', '2026-06-02 23:00:00', { overtimeMinutes: 10, overtimeNightMinutes: 45 }),
    ], 2026, 6)
    expect(rows[1]!.overtimeMinutes).toBe(85)
  })

  it('法定休日は備考に出す・日曜は網掛けの対象', () => {
    const rows = buildKosokuTimecardTable([
      shift('2026-06-07 08:00:00', '2026-06-07 20:00:00', { isLegalHoliday: true }),
    ], 2026, 6)
    expect(rows[6]!.note).toContain('法定休日')
    expect(rows[6]!.isSunday).toBe(true)
    // 打刻側の色分け (自主出勤・打刻エラー) はドライバーには無い
    expect(rows[6]).toMatchObject({ isVoluntary: false, isPunchError: false, isAfterPunchError: false })
  })

  it('24 時間で打ち切った勤務の終業は列に出さない (実在しない時刻)', () => {
    // 乗務員 1194 / 2026-05-07 の形 — 終業打刻が無く `21:32 → 翌 21:32` になる
    const rows = buildKosokuTimecardTable([
      shift('2026-06-09 21:32:00', '2026-06-10 21:32:00', { over24h: true }),
      shift('2026-06-11 06:00:00', '2026-06-11 15:00:00'),
    ], 2026, 6)
    expect(rows[8]).toMatchObject({ day: 9, in1: '21:32', out1: null })
    expect(rows[8]!.note).toContain('退社不明 (拘束 24 時間で打ち切り)')
    // 翌日の行に本物の退社があるように見せない
    expect(rows[9]).toMatchObject({ day: 10, in1: null, out1: null, note: '' })
    // 打ち切りでない勤務は従来どおり
    expect(rows[10]).toMatchObject({ day: 11, in1: '06:00', out1: '15:00' })
  })

  it('読めない時刻は出さない (壊れた行で表を壊さない)', () => {
    const rows = buildKosokuTimecardTable([
      shift('壊れた', 'これも壊れた'),
      shift('2026-06-02 06:00:00', '壊れた'),
    ], 2026, 6)
    expect(rows[1]).toMatchObject({ day: 2, in1: '06:00', out1: null })
    expect(rows.every(r => r.note === '')).toBe(true)
  })

  it('当月の外で始まり当月の外で終わる勤務は出さない', () => {
    const rows = buildKosokuTimecardTable([shift('2026-05-01 06:00:00', '2026-05-01 18:00:00')], 2026, 6)
    expect(rows.every(r => r.in1 === null && r.out1 === null && r.in2 === null && r.out2 === null)).toBe(true)
  })

  it('月が不正なら行を作らない', () => {
    expect(buildKosokuTimecardTable([shift('2026-06-02 06:00:00', '2026-06-02 18:00:00')], 2026, 13)).toEqual([])
  })
})

describe('mergeKosokuDays', () => {
  it('打刻の勤務と重なる休息由来の欠片を落とす (月境界の残骸)', () => {
    // 乗務員 1194 / 2026-04-01 の形 — 前月に始業した打刻の勤務が 4/1 17:07 に終わるのに、
    // 当月分だけだと休息の隙間 04:38〜04:45 が 7 分の勤務として残る
    const prev = [shift('2026-03-31 21:31:00', '2026-04-01 17:07:00', { source: 'timecard' })]
    const current = [
      shift('2026-04-01 04:38:00', '2026-04-01 04:45:00', { source: 'rest' }),
      shift('2026-04-01 21:31:00', '2026-04-02 15:00:00', { source: 'timecard' }),
    ]
    const merged = mergeKosokuDays(prev, current)
    expect(merged.map(d => d.start)).toEqual(['2026-03-31 21:31:00', '2026-04-01 21:31:00'])
  })

  it('打刻と重ならない休息由来は残す (打刻の無い乗務員の勤務が消えない)', () => {
    const current = [
      shift('2026-04-02 04:42:00', '2026-04-02 16:18:00', { source: 'rest' }),
      shift('2026-04-03 05:00:00', '2026-04-03 17:00:00', { source: 'rest' }),
    ]
    expect(mergeKosokuDays([], current).length).toBe(2)
  })

  it('打刻どうしは重なっていても落とさない (上流の判断を覆さない)', () => {
    const days = [
      shift('2026-04-02 06:00:00', '2026-04-02 18:00:00', { source: 'timecard' }),
      shift('2026-04-02 12:00:00', '2026-04-02 20:00:00', { source: 'timecard' }),
    ]
    expect(mergeKosokuDays([], days).length).toBe(2)
  })
})

describe('countKosokuWorkKinds', () => {
  it('残業の有無と法定休日で数える。同じ日の 2 勤務は 1 日', () => {
    const c = countKosokuWorkKinds([
      shift('2026-06-02 06:00:00', '2026-06-02 12:00:00'),
      shift('2026-06-02 20:00:00', '2026-06-02 23:00:00', { overtimeMinutes: 30 }),
      shift('2026-06-03 06:00:00', '2026-06-03 20:00:00', { overtimeNightMinutes: 20 }),
      shift('2026-06-07 08:00:00', '2026-06-07 12:00:00', { isLegalHoliday: true }),
      shift('2026-06-04 06:00:00', '2026-06-04 12:00:00'),
    ])
    expect(c.overtime).toBe(2) // 6/2 (合算で残業あり) と 6/3
    expect(c.normal).toBe(1) // 6/4
    expect(c.holidayWork).toBe(1) // 6/7
    // 打刻にしか無い区分は 0 のまま (画面はドライバーの行に出さない)
    expect(c).toMatchObject({ publicHoliday: 0, paidLeave: 0, absence: 0, voluntary: 0, punchError: 0, halfLeaveDays: 0 })
  })
})

describe('groupTimecardSheetsByCompany', () => {
  const sheets = [
    { driverCd: '1119', isDriver: true },
    { driverCd: '1018', isDriver: false },
    { driverCd: '1442', isDriver: true },
    { driverCd: '9001', isDriver: true },
    { driverCd: '1200', isDriver: false },
  ]
  const comp = (cd: string) => ({ 1119: 'B', 1018: 'A', 1442: 'A', 1200: 'B' } as Record<string, string>)[cd] ?? null

  it('会社ごとに区切り、事務員 → ドライバーの順に並べる', () => {
    const sections = groupTimecardSheetsByCompany(sheets, comp, ['A', 'B'])
    expect(sections.map(s => s.compId)).toEqual(['A', 'B', null])
    expect(sections[0]!.sheets.map(s => s.driverCd)).toEqual(['1018', '1442'])
    expect(sections[1]!.sheets.map(s => s.driverCd)).toEqual(['1200', '1119'])
  })

  it('compOrder の会社を先に出し、それ以外は会社ID 昇順で後ろに付ける', () => {
    expect(groupTimecardSheetsByCompany(sheets, comp, ['B']).map(s => s.compId)).toEqual(['B', 'A', null])
    expect(groupTimecardSheetsByCompany(sheets, comp).map(s => s.compId)).toEqual(['A', 'B', null])
    // 該当者の居ない会社は見出しごと出さない
    expect(groupTimecardSheetsByCompany(sheets, comp, ['Z', 'A']).map(s => s.compId)).toEqual(['A', 'B', null])
  })

  it('会社が引けない乗務員CD は末尾の会社不明へ (落とさない)', () => {
    const sections = groupTimecardSheetsByCompany(sheets, comp, ['A', 'B'])
    expect(sections[2]).toMatchObject({ compId: null })
    expect(sections[2]!.sheets.map(s => s.driverCd)).toEqual(['9001'])
  })

  it('会社不明が居なければ区画を作らない', () => {
    const only = [{ driverCd: '1018', isDriver: false }]
    expect(groupTimecardSheetsByCompany(only, comp, ['A']).map(s => s.compId)).toEqual(['A'])
  })

  it('乗務員CD は数値順 (文字列順にしない)', () => {
    const many = [
      { driverCd: '1100', isDriver: true },
      { driverCd: '999', isDriver: true },
      { driverCd: '1000', isDriver: true },
    ]
    expect(groupTimecardSheetsByCompany(many, () => 'A', ['A'])[0]!.sheets.map(s => s.driverCd))
      .toEqual(['999', '1000', '1100'])
  })
})
