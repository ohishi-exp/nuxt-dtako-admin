// タイムカード表 (既存 PDF 準拠の 8 列) への変換テスト (Refs #424 PR-E)
import { describe, expect, it } from 'vitest'
import {
  buildTimecardTable,
  countWorkKinds,
  dayKindLabel,
  dayOfWeek,
  daysInMonth,
  formatPunch,
} from '../../app/utils/timecard-view'
import type { RestraintSummaryDay } from '../../app/utils/restraint-wage-view'

function day(over: Partial<RestraintSummaryDay> & { day: number }): RestraintSummaryDay {
  return {
    isRestDay: false,
    restraintMinutes: 0,
    workingMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    overtimeNightMinutes: 0,
    ...over,
  }
}

describe('daysInMonth', () => {
  it('月末を返す (うるう年も)', () => {
    expect(daysInMonth(2026, 6)).toBe(30)
    expect(daysInMonth(2026, 7)).toBe(31)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
  })

  it('範囲外・非整数は 0 (表を描かない)', () => {
    expect(daysInMonth(2026, 0)).toBe(0)
    expect(daysInMonth(2026, 13)).toBe(0)
    expect(daysInMonth(2026.5, 6)).toBe(0)
    expect(daysInMonth(2026, 6.5)).toBe(0)
  })
})

describe('dayOfWeek', () => {
  it('0=日 で返す', () => {
    expect(dayOfWeek(2026, 6, 7)).toBe(0) // 日
    expect(dayOfWeek(2026, 6, 8)).toBe(1) // 月
    expect(dayOfWeek(2026, 6, 13)).toBe(6) // 土
  })
})

describe('formatPunch', () => {
  it('同じ日なら HH:MM', () => {
    expect(formatPunch('2026-06-11 07:44:15', '2026-06-11')).toBe('07:44')
  })

  it('日跨ぎは「翌 HH:MM」— 前日の時刻に見えるのを防ぐ', () => {
    expect(formatPunch('2026-06-12 05:30:00', '2026-06-11')).toBe('翌 05:30')
  })

  it('T 区切りも読む', () => {
    expect(formatPunch('2026-06-11T07:44:15', '2026-06-11')).toBe('07:44')
  })

  it('未定義・読めない形式は null', () => {
    expect(formatPunch(undefined, '2026-06-11')).toBeNull()
    expect(formatPunch('2026/06/11 07:44', '2026-06-11')).toBeNull()
    expect(formatPunch('', '2026-06-11')).toBeNull()
  })
})

describe('dayKindLabel', () => {
  it('自主出勤 = 休み扱いだが実働が残っている日', () => {
    expect(dayKindLabel(day({ day: 7, isRestDay: true, voluntaryMinutes: 480 }))).toBe('自主出勤')
  })

  it('ただの休みは空欄', () => {
    expect(dayKindLabel(day({ day: 7, isRestDay: true, voluntaryMinutes: 0 }))).toBe('')
    expect(dayKindLabel(day({ day: 7, isRestDay: true }))).toBe('')
  })

  it('承認済み休日出勤は法定/法定外を区別する', () => {
    expect(dayKindLabel(day({ day: 7, holidayKind: 'legal' }))).toBe('休日出勤 (法定)')
    expect(dayKindLabel(day({ day: 7, holidayKind: 'non_legal' }))).toBe('休日出勤')
  })

  it('平日・区分なし (theearth 由来) は空欄', () => {
    expect(dayKindLabel(day({ day: 1, holidayKind: 'weekday' }))).toBe('')
    expect(dayKindLabel(day({ day: 1 }))).toBe('')
  })
})

describe('buildTimecardTable', () => {
  it('1〜月末まで全日を並べる (打刻の無い日も空行)', () => {
    const rows = buildTimecardTable([day({ day: 1 })], 2026, 6)
    expect(rows).toHaveLength(30)
    expect(rows.map(r => r.day)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
    // 打刻の無い日は 4 列とも null
    expect(rows[1]).toMatchObject({ day: 2, in1: null, out1: null, in2: null, out2: null, note: '' })
  })

  it('中抜けは 出勤2/退社2 に入る (実データ: 松永 2026-06-11)', () => {
    const rows = buildTimecardTable([day({
      day: 11,
      sessions: [
        { start: '2026-06-11 07:44:15', end: '2026-06-11 11:41:10' },
        { start: '2026-06-11 13:14:38', end: '2026-06-11 16:49:11' },
      ],
    })], 2026, 6)
    expect(rows[10]).toMatchObject({
      day: 11, in1: '07:44', out1: '11:41', in2: '13:14', out2: '16:49', note: '',
    })
  })

  it('3 回以上の打刻は 2 本目まで出して件数を備考に残す', () => {
    const rows = buildTimecardTable([day({
      day: 1,
      sessions: [
        { start: '2026-06-01 08:00:00', end: '2026-06-01 10:00:00' },
        { start: '2026-06-01 11:00:00', end: '2026-06-01 12:00:00' },
        { start: '2026-06-01 13:00:00', end: '2026-06-01 17:00:00' },
      ],
    })], 2026, 6)
    expect(rows[0]!.in2).toBe('11:00')
    expect(rows[0]!.note).toBe('打刻 3 回')
  })

  it('日曜に網掛けフラグが立つ (PDF と同じ)', () => {
    const rows = buildTimecardTable([], 2026, 6)
    // 2026-06 の日曜は 7/14/21/28
    expect(rows.filter(r => r.isSunday).map(r => r.day)).toEqual([7, 14, 21, 28])
    expect(rows[6]!.dowLabel).toBe('日')
  })

  it('残業は 時間外 + 時間外深夜 の合計', () => {
    const rows = buildTimecardTable([day({ day: 1, overtimeMinutes: 60, overtimeNightMinutes: 30 })], 2026, 6)
    expect(rows[0]!.overtimeMinutes).toBe(90)
  })

  it('自主出勤は区分が備考に出て、フラグが立つ (時間は賃金計算に入らないが消さない)', () => {
    const rows = buildTimecardTable([day({
      day: 7,
      isRestDay: true,
      voluntaryMinutes: 480,
      holidayKind: 'legal',
      sessions: [{ start: '2026-06-07 08:00:00', end: '2026-06-07 17:00:00' }],
    })], 2026, 6)
    expect(rows[6]).toMatchObject({ day: 7, note: '自主出勤', isVoluntary: true, in1: '08:00', out1: '17:00' })
  })

  it('承認済み休日出勤は区分が出て自主出勤フラグは立たない', () => {
    const rows = buildTimecardTable([day({ day: 7, holidayKind: 'legal' })], 2026, 6)
    expect(rows[6]).toMatchObject({ note: '休日出勤 (法定)', isVoluntary: false })
  })

  it('区分と打刻回数は両方あれば併記する', () => {
    const rows = buildTimecardTable([day({
      day: 7,
      holidayKind: 'non_legal',
      sessions: [
        { start: '2026-06-07 08:00:00', end: '2026-06-07 10:00:00' },
        { start: '2026-06-07 11:00:00', end: '2026-06-07 12:00:00' },
        { start: '2026-06-07 13:00:00', end: '2026-06-07 17:00:00' },
      ],
    })], 2026, 6)
    expect(rows[6]!.note).toBe('休日出勤 / 打刻 3 回')
  })

  it('日跨ぎ勤務の退社は「翌」が付く', () => {
    const rows = buildTimecardTable([day({
      day: 1,
      sessions: [{ start: '2026-06-01 23:52:33', end: '2026-06-02 13:51:00' }],
    })], 2026, 6)
    expect(rows[0]).toMatchObject({ in1: '23:52', out1: '翌 13:51' })
  })

  it('区分を持たない休みの日 (theearth 由来) は自主出勤にしない', () => {
    // theearth 由来の日は voluntaryMinutes を持たない — undefined を 0 と読めずに
    // 自主出勤へ倒すと、乗務員の休日が全部「自主出勤」になってしまう
    const rows = buildTimecardTable([day({ day: 7, isRestDay: true })], 2026, 6)
    expect(rows[6]).toMatchObject({ isVoluntary: false, note: '' })
  })

  it('月が不正なら空表 (描かない)', () => {
    expect(buildTimecardTable([day({ day: 1 })], 2026, 13)).toEqual([])
  })
})

describe('countWorkKinds', () => {
  it('通常 / 残業あり / 休日出勤 / 自主出勤 を数える', () => {
    const counts = countWorkKinds([
      day({ day: 1 }),
      day({ day: 2, overtimeMinutes: 60 }),
      day({ day: 3, overtimeNightMinutes: 30 }),
      day({ day: 7, holidayKind: 'legal' }),
      day({ day: 8, holidayKind: 'non_legal' }),
      day({ day: 14, isRestDay: true, voluntaryMinutes: 300 }),
      day({ day: 21, isRestDay: true, voluntaryMinutes: 0 }),
    ])
    expect(counts).toEqual({
      normal: 1, overtime: 2, holidayWork: 2, voluntary: 1, voluntaryMinutes: 300,
    })
  })

  it('休日出勤は残業の有無に関わらず休日出勤に数える (二重に数えない)', () => {
    const counts = countWorkKinds([day({ day: 7, holidayKind: 'legal', overtimeMinutes: 120 })])
    expect(counts).toMatchObject({ holidayWork: 1, overtime: 0, normal: 0 })
  })

  it('区分を持たない日 (theearth 由来) は残業の有無だけで分かれる', () => {
    const counts = countWorkKinds([day({ day: 1 }), day({ day: 2, overtimeMinutes: 60 })])
    expect(counts).toMatchObject({ normal: 1, overtime: 1, holidayWork: 0 })
  })

  it('時間が null の日 (theearth CSV の欠損) は残業なしとして通常に数える', () => {
    const counts = countWorkKinds([day({ day: 1, overtimeMinutes: null, overtimeNightMinutes: null })])
    expect(counts).toMatchObject({ normal: 1, overtime: 0 })
  })

  it('空入力はすべて 0', () => {
    expect(countWorkKinds([])).toEqual({
      normal: 0, overtime: 0, holidayWork: 0, voluntary: 0, voluntaryMinutes: 0,
    })
  })
})
