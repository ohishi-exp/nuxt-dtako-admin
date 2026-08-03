import { describe, expect, it } from 'vitest'
import {
  applyKosokuTimes,
  kintaiR2Paths,
  mergeSummarySources,
  LUNCH_FROM_HOUR,
  LUNCH_TO_HOUR,
  mergeIntervals,
  NIGHT_FROM_HOUR,
  NIGHT_TO_HOUR,
  overlapLength,
  stableTimecardSummaryBody,
  subtractIntervals,
  countLeaves,
  emptyLeaveCounts,
  hasOvernightSession,
  isClericalJob,
  summarizeTimecardDay,
  summarizeTimecardMonth,
  timestampToSeconds,
  TimecardSummaryError,
  totalLength,
  trailingSlice,
  type TheearthBackfillKey,
  type TimecardDailyRow,
} from '../src/timecard-summary'

/** 打刻 1 本の日を作る。 */
function row(
  date: string,
  spans: Array<[string, string]>,
  holiday: TimecardDailyRow['holiday'] = 'weekday',
  extra: Partial<TimecardDailyRow> = {},
): TimecardDailyRow {
  const sessions = spans.map(([s, e]) => ({ start: `${date} ${s}`, end: e.includes(' ') ? e : `${date} ${e}` }))
  const first = sessions[0]
  const last = sessions[sessions.length - 1]
  return {
    driver_id: 1670,
    name: '松永　寿乃',
    date,
    start: first?.start ?? null,
    end: last?.end ?? null,
    restraint_minutes:
      first && last
        ? Math.floor(((timestampToSeconds(last.end) ?? 0) - (timestampToSeconds(first.start) ?? 0)) / 60)
        : 0,
    sessions,
    holiday,
    office: '大石運輸倉庫㈱ 本社',
    ...extra,
  }
}

/**
 * 既定の日別 opts = **事務職かつ非夜勤**・承認なし = 自主出勤の隔離が効く組み合わせ。
 *
 * 夜勤者は打刻エラーだけでなく**自主出勤の隔離も外れる** (Refs #433) ので、
 * 既定を `nightShift: true` にすると休日の既存ケースが通常計上へ倒れてしまう。
 * 日跨ぎ勤務の時間計算 (深夜帯・恒等式) を見るケースだけ、打刻エラーの隔離を
 * 避けるために `nightShift: true` を明示する。
 */
const NO_APPROVAL = { dailyWorkMinutes: 480, approved: false, clerical: true, nightShift: false }

describe('timestampToSeconds', () => {
  it('秒あり・秒なし・T 区切りを読める', () => {
    const base = timestampToSeconds('2026-06-11 07:44:00')!
    expect(timestampToSeconds('2026-06-11 07:44')).toBe(base)
    expect(timestampToSeconds('2026-06-11T07:44:00')).toBe(base)
  })

  it('秒を保持する (分に丸めない)', () => {
    expect(timestampToSeconds('2026-06-11 07:44:59')! - timestampToSeconds('2026-06-11 07:44:00')!).toBe(59)
  })

  it('読めない形式は null', () => {
    expect(timestampToSeconds('2026/06/11 07:44')).toBeNull()
    expect(timestampToSeconds('')).toBeNull()
  })
})

describe('区間ユーティリティ', () => {
  it('mergeIntervals は重なり・接触を併合し、空区間を捨てる', () => {
    expect(mergeIntervals([{ from: 10, to: 20 }, { from: 15, to: 25 }])).toEqual([{ from: 10, to: 25 }])
    expect(mergeIntervals([{ from: 10, to: 20 }, { from: 20, to: 30 }])).toEqual([{ from: 10, to: 30 }])
    expect(mergeIntervals([{ from: 10, to: 20 }, { from: 30, to: 40 }])).toEqual([
      { from: 10, to: 20 }, { from: 30, to: 40 },
    ])
    expect(mergeIntervals([{ from: 10, to: 10 }])).toEqual([])
  })

  it('mergeIntervals は入力順に依存しない', () => {
    expect(mergeIntervals([{ from: 30, to: 40 }, { from: 10, to: 20 }])).toEqual([
      { from: 10, to: 20 }, { from: 30, to: 40 },
    ])
  })

  it('subtractIntervals は内側・前後・全体・無関係を正しく処理する', () => {
    const base = [{ from: 0, to: 100 }]
    expect(subtractIntervals(base, [{ from: 40, to: 60 }])).toEqual([{ from: 0, to: 40 }, { from: 60, to: 100 }])
    expect(subtractIntervals(base, [{ from: -10, to: 30 }])).toEqual([{ from: 30, to: 100 }])
    expect(subtractIntervals(base, [{ from: 70, to: 200 }])).toEqual([{ from: 0, to: 70 }])
    expect(subtractIntervals(base, [{ from: 0, to: 100 }])).toEqual([])
    expect(subtractIntervals(base, [{ from: 200, to: 300 }])).toEqual([{ from: 0, to: 100 }])
    expect(subtractIntervals(base, [])).toEqual([{ from: 0, to: 100 }])
  })

  it('overlapMinutes は重なりの合計', () => {
    expect(overlapLength([{ from: 0, to: 100 }], [{ from: 50, to: 150 }])).toBe(50)
    expect(overlapLength([{ from: 0, to: 10 }], [{ from: 50, to: 60 }])).toBe(0)
    expect(overlapLength([{ from: 0, to: 10 }, { from: 20, to: 30 }], [{ from: 5, to: 25 }])).toBe(10)
  })

  it('totalMinutes は負の長さを 0 に丸める', () => {
    expect(totalLength([{ from: 0, to: 30 }, { from: 50, to: 40 }])).toBe(30)
  })

  it('trailingSlice は終わり側から切り出す', () => {
    const iv = [{ from: 0, to: 60 }, { from: 100, to: 160 }]
    expect(trailingSlice(iv, 0)).toEqual([])
    expect(trailingSlice(iv, -5)).toEqual([])
    expect(trailingSlice(iv, 30)).toEqual([{ from: 130, to: 160 }])
    expect(trailingSlice(iv, 60)).toEqual([{ from: 100, to: 160 }])
    expect(trailingSlice(iv, 90)).toEqual([{ from: 30, to: 60 }, { from: 100, to: 160 }])
    // 総量を超える指定は全部返す
    expect(trailingSlice(iv, 500)).toEqual([{ from: 0, to: 60 }, { from: 100, to: 160 }])
  })
})

describe('summarizeTimecardDay — 休憩の導出', () => {
  it('中抜けが昼をまたぐ日は二重控除しない (実データ: 松永 2026-06-11)', () => {
    // 07:44:15 → 11:41:10 / 13:14:38 → 16:49:11、拘束 544 分
    const d = summarizeTimecardDay(
      row('2026-06-11', [['07:44:15', '11:41:10'], ['13:14:38', '16:49:11']]),
      NO_APPROVAL,
    )
    expect(d.restraintMinutes).toBe(544)
    // 実働 = 拘束 − 中抜け。12:00-13:00 は中抜け (11:41:10-13:14:38) の内側なので
    // 二重には引かない。秒で足してから丸めるので 451 (打刻ごとに丸めた 236+214=450 ではない)
    expect(d.workingMinutes).toBe(451)
    // タイムカード表の 出勤1/退社1/出勤2/退社2 はこの 2 区間がそのまま入る
    expect(d.sessions).toEqual([
      { start: '2026-06-11 07:44:15', end: '2026-06-11 11:41:10' },
      { start: '2026-06-11 13:14:38', end: '2026-06-11 16:49:11' },
    ])
  })

  it('中抜けが昼と重ならない日は中抜け + 12:00-13:00 の両方を引く (実データ: 松山 2026-06-25)', () => {
    // 08:00:11 → 09:10:53 / 10:26:12 → 16:12:20
    const d = summarizeTimecardDay(
      row('2026-06-25', [['08:00:11', '09:10:53'], ['10:26:12', '16:12:20']]),
      NO_APPROVAL,
    )
    expect(d.restraintMinutes).toBe(492)
    // 打刻 70:42 + 346:08 = 416:50、うち 12:00-13:00 の 60 分は 2 本目の内側
    expect(d.workingMinutes).toBe(356)
  })

  it('打刻を切っていない日も 12:00-13:00 は休憩として引く', () => {
    const d = summarizeTimecardDay(row('2026-06-01', [['08:00:00', '17:00:00']]), NO_APPROVAL)
    expect(d.restraintMinutes).toBe(540)
    expect(d.workingMinutes).toBe(480)
    expect(d.sessions).toEqual([{ start: '2026-06-01 08:00:00', end: '2026-06-01 17:00:00' }])
  })

  it('昼をまたがない勤務は控除なし', () => {
    const d = summarizeTimecardDay(row('2026-06-01', [['13:00:00', '17:00:00']]), NO_APPROVAL)
    expect(d.workingMinutes).toBe(240)
  })
})

describe('summarizeTimecardDay — 時間外と深夜', () => {
  it('所定を超えた分が時間外', () => {
    const d = summarizeTimecardDay(row('2026-06-01', [['08:00:00', '19:00:00']]), NO_APPROVAL)
    expect(d.workingMinutes).toBe(600) // 11h − 昼 1h
    expect(d.overtimeMinutes).toBe(120)
    expect(d.overtimeNightMinutes).toBe(0)
  })

  it('所定未設定なら時間外を出さない', () => {
    const d = summarizeTimecardDay(row('2026-06-01', [['08:00:00', '22:00:00']]), {
      dailyWorkMinutes: null,
      approved: false,
      clerical: true,
      nightShift: true,
    })
    expect(d.overtimeMinutes).toBe(0)
    expect(d.overtimeNightMinutes).toBe(0)
  })

  it('所定以内なら時間外 0', () => {
    const d = summarizeTimecardDay(row('2026-06-01', [['09:00:00', '17:00:00']]), NO_APPROVAL)
    expect(d.workingMinutes).toBe(420)
    expect(d.overtimeMinutes).toBe(0)
  })

  it('深夜帯にかかる残業は時間外深夜へ回り、深夜(通常)と排他になる', () => {
    // 08:00 → 24:00、実働 = 16h − 1h = 900 分、所定 480 → 時間外 420
    // 深夜 22:00-24:00 = 120 分。時間外は終わり側 420 分 = 17:00-24:00 なので全部含む
    const d = summarizeTimecardDay(
      row('2026-06-01', [['08:00:00', '2026-06-02 00:00:00']]),
      { ...NO_APPROVAL, nightShift: true }, // 日跨ぎなので打刻エラーの隔離を外す
    )
    expect(d.workingMinutes).toBe(900)
    expect(d.overtimeNightMinutes).toBe(120)
    expect(d.overtimeMinutes).toBe(300)
    expect(d.nightMinutes).toBe(0)
    // classifyMonth の恒等式: 実働 = 法定内 + 時間外 + 時間外深夜
    expect(d.workingMinutes! - d.overtimeMinutes! - d.overtimeNightMinutes!).toBe(480)
  })

  it('深夜に始まる勤務は深夜(通常)に載る (前日 22:00 起点の窓を見る)', () => {
    // 03:00 → 08:00、実働 300 分、所定 480 なので時間外なし。深夜は 03:00-05:00 = 120 分
    const d = summarizeTimecardDay(row('2026-06-02', [['03:00:00', '08:00:00']]), NO_APPROVAL)
    expect(d.workingMinutes).toBe(300)
    expect(d.overtimeMinutes).toBe(0)
    expect(d.nightMinutes).toBe(120)
    expect(d.overtimeNightMinutes).toBe(0)
  })

  it('日跨ぎ勤務は始業日の 1 行として扱う', () => {
    const d = summarizeTimecardDay(
      row('2026-06-01', [['22:00:00', '2026-06-02 06:00:00']]),
      { dailyWorkMinutes: 480, approved: false, clerical: true, nightShift: true },
    )
    expect(d.day).toBe(1)
    expect(d.restraintMinutes).toBe(480)
    expect(d.workingMinutes).toBe(480) // 昼をまたがない
    expect(d.nightMinutes).toBe(420) // 22:00-05:00
  })
})

describe('summarizeTimecardDay — 休日と自主出勤', () => {
  it('承認の無い休日の打刻は自主出勤 (賃金 0・時間は voluntaryMinutes に退避)', () => {
    const d = summarizeTimecardDay(row('2026-06-07', [['08:00:00', '17:00:00']], 'legal'), NO_APPROVAL)
    expect(d.isRestDay).toBe(true)
    expect(d.workingMinutes).toBe(0)
    expect(d.overtimeMinutes).toBe(0)
    expect(d.nightMinutes).toBe(0)
    expect(d.voluntaryMinutes).toBe(480)
    expect(d.holidayKind).toBe('legal')
  })

  it('法定外休日 (指定休・祝日) でも承認が無ければ自主出勤', () => {
    const d = summarizeTimecardDay(row('2026-05-04', [['08:00:00', '17:00:00']], 'non_legal'), NO_APPROVAL)
    expect(d.isRestDay).toBe(true)
    expect(d.voluntaryMinutes).toBe(480)
  })

  it('承認済みなら通常どおり時間が出る', () => {
    const d = summarizeTimecardDay(row('2026-06-07', [['08:00:00', '17:00:00']], 'legal'), {
      dailyWorkMinutes: 480,
      approved: true,
      clerical: true,
      nightShift: true,
    })
    expect(d.isRestDay).toBe(false)
    expect(d.workingMinutes).toBe(480)
    expect(d.voluntaryMinutes).toBe(0)
  })

  it('平日は承認に関係なく通常どおり', () => {
    const d = summarizeTimecardDay(row('2026-06-01', [['08:00:00', '17:00:00']]), NO_APPROVAL)
    expect(d.isRestDay).toBe(false)
    expect(d.voluntaryMinutes).toBe(0)
  })
})

describe('summarizeTimecardDay — 壊れた入力', () => {
  it('sessions が空なら休み扱い', () => {
    const d = summarizeTimecardDay(row('2026-06-01', []), NO_APPROVAL)
    expect(d.isRestDay).toBe(true)
    expect(d.sessions).toEqual([])
  })

  it('時刻が読めない / 逆転している session は捨てる', () => {
    const r = row('2026-06-01', [['08:00:00', '17:00:00']])
    r.sessions.push({ start: 'bad', end: '2026-06-01 18:00:00' })
    r.sessions.push({ start: '2026-06-01 19:00:00', end: 'bad' })
    r.sessions.push({ start: '2026-06-01 20:00:00', end: '2026-06-01 19:00:00' })
    const d = summarizeTimecardDay(r, NO_APPROVAL)
    // 壊れた打刻は sessions にも残さない (表に出す時刻 = 計算に使った区間)
    expect(d.sessions).toEqual([{ start: '2026-06-01 08:00:00', end: '2026-06-01 17:00:00' }])
    expect(d.workingMinutes).toBe(480)
  })

  it('重なった打刻は併合して 1 区間にする (表と計算で同じ姿になる)', () => {
    const r = row('2026-06-01', [['08:00:00', '12:00:00']])
    r.sessions.push({ start: '2026-06-01 11:00:00', end: '2026-06-01 17:00:00' })
    const d = summarizeTimecardDay(r, NO_APPROVAL)
    expect(d.sessions).toEqual([{ start: '2026-06-01 08:00:00', end: '2026-06-01 17:00:00' }])
  })

  it('date が読めなければ day 0 (月次側が warnings で落とす)', () => {
    const d = summarizeTimecardDay(row('2026/06/01', [['08:00:00', '17:00:00']]), NO_APPROVAL)
    expect(d.day).toBe(0)
  })
})

describe('summarizeTimecardMonth', () => {
  // 既定は NO_APPROVAL と同じく「事務職かつ非夜勤」= 自主出勤の隔離が効く組み合わせ
  // (この describe に日跨ぎの行は無いので打刻エラーには倒れない)
  const opts = (approved: string[] = [], minutes: number | null = 480) => ({
    yearMonth: '2026-06',
    dailyWorkMinutesFor: () => minutes,
    approvedHolidayWork: new Set(approved),
    isClerical: () => true,
    isNightShift: () => false,
  })

  it('乗務員ごとに畳み、乗務員CD の数値順に並べる', () => {
    const rows = [
      { ...row('2026-06-02', [['08:00:00', '17:00:00']]), driver_id: 1029, name: '冨田　竜' },
      row('2026-06-01', [['08:00:00', '17:00:00']]),
      row('2026-06-02', [['08:00:00', '19:00:00']]),
    ]
    const { summaries } = summarizeTimecardMonth(rows, opts())
    expect(summaries.map(s => s.driverCd)).toEqual(['1029', '1670'])
    const m = summaries[1]!
    expect(m.workDays).toBe(2)
    expect(m.workingMinutes).toBe(480 + 600)
    expect(m.overtimeMinutes).toBe(120)
    expect(m.restraintMinutes).toBe(540 + 660)
    expect(m.breakMinutes).toBe(120) // 昼 60 × 2 日
    expect(m.maxDailyRestraintMinutes).toBe(660)
    expect(m.source).toBe('timecard')
    expect(m.days.map(d => d.day)).toEqual([1, 2])
  })

  it('kosokuPartsFor を渡すと時間が kosoku-daily 由来になる (打刻から組んだ勤務は使わない)', () => {
    // 長距離の形: 打刻は 6/1 の始業と 6/9 の終業だけ = 8 日が 1 勤務になる入力
    const rows = [row('2026-06-01', [['05:44:00', '23:59:00']])]
    const parts = new Map([
      ['2026-06-01', { restraintMinutes: 699, workingMinutes: 486, overtimeMinutes: 6, nightMinutes: 30, overtimeNightMinutes: 10, ferryMinusMinutes: 0, runGapMinutes: 0, punchTailMinutes: 0, punchHeadMinutes: 0, runHeadMinutes: 0, lunchOverlapMinutes: 0 }],
      ['2026-06-02', { restraintMinutes: 600, workingMinutes: 540, overtimeMinutes: 60, nightMinutes: 0, overtimeNightMinutes: 0, ferryMinusMinutes: 0, runGapMinutes: 0, punchTailMinutes: 0, punchHeadMinutes: 0, runHeadMinutes: 0, lunchOverlapMinutes: 0 }],
    ])
    const { summaries } = summarizeTimecardMonth(rows, {
      ...opts(),
      kosokuPartsFor: () => parts,
    })
    const m = summaries[0]!
    expect(m.days.map(d => d.day)).toEqual([1, 2])
    expect(m.workDays).toBe(2)
    expect(m.restraintMinutes).toBe(1299)
    expect(m.workingMinutes).toBe(1026)
    expect(m.overtimeMinutes).toBe(66)
    expect(m.overtimeNightMinutes).toBe(10)
  })

  it('kosokuPartsFor がその人の分を持たなければ時間は 0 (出どころは月で 1 つに揃える)', () => {
    const rows = [row('2026-06-01', [['08:00:00', '17:00:00']])]
    const { summaries } = summarizeTimecardMonth(rows, { ...opts(), kosokuPartsFor: () => null })
    expect(summaries[0]!.restraintMinutes).toBe(0)
    expect(summaries[0]!.workingMinutes).toBe(0)
  })

  it('日付順に並べ替える (入力順に依存しない)', () => {
    const { summaries } = summarizeTimecardMonth(
      [row('2026-06-10', [['08:00:00', '17:00:00']]), row('2026-06-03', [['08:00:00', '17:00:00']])],
      opts(),
    )
    expect(summaries[0]!.days.map(d => d.day)).toEqual([3, 10])
  })

  it('自主出勤は restDays に入り voluntaryMinutes が積まれる', () => {
    const { summaries } = summarizeTimecardMonth(
      [row('2026-06-07', [['08:00:00', '17:00:00']], 'legal')],
      opts(),
    )
    const s = summaries[0]!
    expect(s.workDays).toBe(0)
    expect(s.restDays).toBe(1)
    expect(s.voluntaryMinutes).toBe(480)
    expect(s.workingMinutes).toBe(0)
    expect(s.maxDailyRestraintMinutes).toBeNull()
  })

  it('承認済みなら勤務日として計上される', () => {
    const { summaries } = summarizeTimecardMonth(
      [row('2026-06-07', [['08:00:00', '17:00:00']], 'legal')],
      opts(['1670|2026-06-07']),
    )
    expect(summaries[0]!.workDays).toBe(1)
    expect(summaries[0]!.voluntaryMinutes).toBe(0)
  })

  it('法定外休日の承認済み休日出勤は warning を出さない (holidayKind を classifyMonth が見る)', () => {
    const { summaries, warnings } = summarizeTimecardMonth(
      [row('2026-06-15', [['08:00:00', '17:00:00']], 'non_legal')],
      opts(['1670|2026-06-15']),
    )
    // PR-D で classifyMonth が holidayKind を優先するようになったので、
    // 「曜日指定でしか法定外休日を拾えない」という限界は無くなった
    expect(warnings).toEqual([])
    expect(summaries[0]!.days[0]!.holidayKind).toBe('non_legal')
    expect(summaries[0]!.days[0]!.isRestDay).toBe(false)
  })

  it('法定休日の承認済みは warning を出さない (日曜は classifyMonth が拾う)', () => {
    const { warnings } = summarizeTimecardMonth(
      [row('2026-06-07', [['08:00:00', '17:00:00']], 'legal')],
      opts(['1670|2026-06-07']),
    )
    expect(warnings).toEqual([])
  })

  it('15 時間超の日を数える', () => {
    const { summaries } = summarizeTimecardMonth(
      [
        row('2026-06-01', [['05:00:00', '21:00:00']]), // 拘束 16h
        row('2026-06-02', [['08:00:00', '17:00:00']]), // 拘束 9h
      ],
      opts(),
    )
    expect(summaries[0]!.over15hDays).toBe(1)
  })

  it('driver_id が数値でない行は warning を出して無視する', () => {
    const bad = { ...row('2026-06-01', [['08:00:00', '17:00:00']]), driver_id: 'x1' }
    const { summaries, warnings } = summarizeTimecardMonth([bad], opts())
    expect(summaries).toEqual([])
    expect(warnings[0]).toMatch(/driver_id が数値ではない/)
  })

  it('date が読めない行は warning を出して無視する', () => {
    const { summaries, warnings } = summarizeTimecardMonth(
      [row('2026/06/01', [['08:00:00', '17:00:00']])],
      opts(),
    )
    expect(summaries).toEqual([])
    expect(warnings[0]).toMatch(/date が YYYY-MM-DD でない/)
  })

  it('office が無ければ branchName は空文字', () => {
    const r = { ...row('2026-06-01', [['08:00:00', '17:00:00']]), office: null }
    const { summaries } = summarizeTimecardMonth([r], opts())
    expect(summaries[0]!.branchName).toBe('')
  })

  it('所定未設定 (null) の乗務員は時間外が出ない', () => {
    const { summaries } = summarizeTimecardMonth(
      [row('2026-06-01', [['08:00:00', '20:00:00']])],
      opts([], null),
    )
    expect(summaries[0]!.overtimeMinutes).toBe(0)
  })

  it('空入力は空サマリ', () => {
    expect(summarizeTimecardMonth([], opts())).toEqual({ summaries: [], warnings: [] })
  })
})

describe('mergeSummarySources', () => {
  const entry = (driverCd: string) => ({ data: { driverCd } })

  it('両方を乗務員CD の数値順に並べ、source を付ける', () => {
    const { merged, warnings } = mergeSummarySources(
      [entry('1029'), entry('1670')],
      [entry('205'), entry('1800')],
    )
    expect(merged.map(m => m.entry.data.driverCd)).toEqual(['205', '1029', '1670', '1800'])
    expect(merged.map(m => m.source)).toEqual(['timecard', 'theearth', 'theearth', 'timecard'])
    expect(warnings).toEqual([])
    // theearth 単独行 (timecard に counterpart が無い) は埋め戻し自体が起きないので
    // backfilledFromTheearth は付かない (source で theearth 由来と分かるので二重に持たせない)
    for (const m of merged) expect((m.entry.data as { backfilledFromTheearth?: unknown }).backfilledFromTheearth).toBeUndefined()
  })

  it('同じ乗務員CD が両方に居たら timecard を採り warning を出す', () => {
    const timecard = entry('1670')
    const { merged, warnings } = mergeSummarySources([entry('1670')], [timecard, entry('205')])
    expect(merged.map(m => m.entry.data.driverCd)).toEqual(['205', '1670'])
    expect(merged.map(m => m.source)).toEqual(['timecard', 'timecard'])
    // 埋め戻す値が無いので entry はコピーされない
    expect(merged.find(m => m.entry.data.driverCd === '1670')!.entry).toBe(timecard)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/1670/)
    expect(warnings[0]).toMatch(/タイムカード側を採用/)
    // 埋め戻す値が無い重複行は backfilledFromTheearth も付かない
    expect((merged.find(m => m.entry.data.driverCd === '1670')!.entry.data as { backfilledFromTheearth?: unknown }).backfilledFromTheearth).toBeUndefined()
  })

  it('重複行はデジタコにしか無い指標だけ埋め戻す (時間はタイムカードのまま)', () => {
    interface Row {
      data: {
        driverCd: string
        restraintMinutes: number | null
        drivingMinutes: number | null
        loadingMinutes: number | null
        fiscalCumulativeMinutes: number | null
        restraintLimitMinutes: number | null
        excessRestraintMinutes: number | null
        over15hDays: number
        avgDriving9hOverCount: number
        backfilledFromTheearth?: readonly TheearthBackfillKey[]
      }
    }
    const theearth: Row = {
      data: {
        driverCd: '1670',
        restraintMinutes: 9999,
        drivingMinutes: 8000,
        loadingMinutes: 600,
        fiscalCumulativeMinutes: 120000,
        restraintLimitMinutes: 17400,
        excessRestraintMinutes: 300,
        over15hDays: 7,
        avgDriving9hOverCount: 3,
      },
    }
    const timecard: Row = {
      data: {
        driverCd: '1670',
        restraintMinutes: 12000,
        drivingMinutes: null,
        loadingMinutes: null,
        fiscalCumulativeMinutes: null,
        restraintLimitMinutes: null,
        excessRestraintMinutes: null,
        over15hDays: 2,
        avgDriving9hOverCount: 0,
      },
    }
    const { merged } = mergeSummarySources([theearth], [timecard])
    expect(merged).toHaveLength(1)
    const data = merged[0]!.entry.data
    // 拘束・15h超日数 は打刻側 (同じ行の拘束合計と整合する方)
    expect(data.restraintMinutes).toBe(12000)
    expect(data.over15hDays).toBe(2)
    // タイムカードから出せない列だけデジタコで埋まる
    expect(data.drivingMinutes).toBe(8000)
    expect(data.loadingMinutes).toBe(600)
    expect(data.fiscalCumulativeMinutes).toBe(120000)
    expect(data.restraintLimitMinutes).toBe(17400)
    expect(data.excessRestraintMinutes).toBe(300)
    expect(data.avgDriving9hOverCount).toBe(3)
    // 元オブジェクトは書き換えない
    expect(timecard.data.drivingMinutes).toBeNull()
    // 埋め戻した 6 キー全部が乗る (Refs #606-7、画面の theearth 由来印の元)
    expect(data.backfilledFromTheearth).toEqual([
      'drivingMinutes',
      'loadingMinutes',
      'fiscalCumulativeMinutes',
      'restraintLimitMinutes',
      'excessRestraintMinutes',
      'avgDriving9hOverCount',
    ])
  })

  it('theearth 側にも無い分は backfilledFromTheearth に含めない (埋め戻せた分だけ載る)', () => {
    interface Row {
      data: {
        driverCd: string
        drivingMinutes: number | null
        loadingMinutes: number | null
        fiscalCumulativeMinutes: number | null
        restraintLimitMinutes: number | null
        excessRestraintMinutes: number | null
        avgDriving9hOverCount: number
        backfilledFromTheearth?: readonly TheearthBackfillKey[]
      }
    }
    // theearth 側も loadingMinutes / restraintLimitMinutes は null (取れなかった)
    const theearth: Row = {
      data: {
        driverCd: '1670',
        drivingMinutes: 8000,
        loadingMinutes: null,
        fiscalCumulativeMinutes: 120000,
        restraintLimitMinutes: null,
        excessRestraintMinutes: 300,
        avgDriving9hOverCount: 3,
      },
    }
    const timecard: Row = {
      data: {
        driverCd: '1670',
        drivingMinutes: null,
        loadingMinutes: null,
        fiscalCumulativeMinutes: null,
        restraintLimitMinutes: null,
        excessRestraintMinutes: null,
        avgDriving9hOverCount: 0,
      },
    }
    const { merged } = mergeSummarySources([theearth], [timecard])
    const data = merged[0]!.entry.data
    expect(data.backfilledFromTheearth).toEqual([
      'drivingMinutes',
      'fiscalCumulativeMinutes',
      'excessRestraintMinutes',
      'avgDriving9hOverCount',
    ])
    // theearth 側にも無かった分は null のまま、キーにも含めない
    expect(data.loadingMinutes).toBeNull()
    expect(data.restraintLimitMinutes).toBeNull()
    expect(data.backfilledFromTheearth).not.toContain('loadingMinutes')
    expect(data.backfilledFromTheearth).not.toContain('restraintLimitMinutes')
  })

  it('タイムカード側に値があれば埋め戻さない (backfilledFromTheearth も付かない)', () => {
    const theearth = { data: { driverCd: '1', drivingMinutes: 100, avgDriving9hOverCount: 5 } }
    const timecard = { data: { driverCd: '1', drivingMinutes: 0, avgDriving9hOverCount: 2 } }
    const { merged } = mergeSummarySources([theearth], [timecard])
    expect(merged[0]!.entry.data.drivingMinutes).toBe(0)
    expect(merged[0]!.entry.data.avgDriving9hOverCount).toBe(2)
    expect((merged[0]!.entry.data as { backfilledFromTheearth?: unknown }).backfilledFromTheearth).toBeUndefined()
  })

  it('片方が空でも通る (乗務員だけ / 事務員だけの月)', () => {
    expect(mergeSummarySources([entry('1')], []).merged.map(m => m.source)).toEqual(['theearth'])
    expect(mergeSummarySources([], [entry('1')]).merged.map(m => m.source)).toEqual(['timecard'])
    expect(mergeSummarySources([], []).merged).toEqual([])
  })
})

describe('stableTimecardSummaryBody', () => {
  it('内容が同じなら同一バイト列 (R2 の sha256 差分検知が効く)', () => {
    const { summaries } = summarizeTimecardMonth(
      [row('2026-06-01', [['08:00:00', '17:00:00']])],
      { yearMonth: '2026-06', dailyWorkMinutesFor: () => 480, approvedHolidayWork: new Set<string>() },
    )
    const a = stableTimecardSummaryBody('27324455', 2026, 6, summaries[0]!)
    const b = stableTimecardSummaryBody('27324455', 2026, 6, summaries[0]!)
    expect(a).toBe(b)
    expect(JSON.parse(a)).toMatchObject({ compId: '27324455', year: 2026, month: 6, driverCd: '1670' })
  })
})

describe('TimecardSummaryError', () => {
  it('name が設定される', () => {
    const e = new TimecardSummaryError('壊れています')
    expect(e.name).toBe('TimecardSummaryError')
    expect(e.message).toBe('壊れています')
  })
})

describe('定数', () => {
  it('昼休憩と深夜帯の窓', () => {
    expect([LUNCH_FROM_HOUR, LUNCH_TO_HOUR]).toEqual([12, 13])
    expect([NIGHT_FROM_HOUR, NIGHT_TO_HOUR]).toEqual([22, 29])
  })
})

describe('kintaiR2Paths', () => {
  const p = kintaiR2Paths('kintai', '27324455', 2026, 6)

  it('theearth 由来と別 prefix に置く (混ぜると版管理が互いを踏む)', () => {
    expect(p.rawLatest).toBe('kintai/27324455/2026-06/raw/latest.json')
    expect(p.rawDir).toBe('kintai/27324455/2026-06/raw')
    expect(p.rawVersion('20260726T010203')).toBe('kintai/27324455/2026-06/raw/v-20260726T010203.json')
    expect(p.rawHistory).toBe('kintai/27324455/2026-06/raw/history.jsonl')
  })

  it('月は 0 埋めする', () => {
    expect(kintaiR2Paths('kintai', 'c', 2026, 1).rawLatest).toBe('kintai/c/2026-01/raw/latest.json')
  })

  it('社員別サマリのキー', () => {
    expect(p.summaryDir('1670')).toBe('kintai/27324455/2026-06/summary/1670')
    expect(p.summaryLatest('1670')).toBe('kintai/27324455/2026-06/summary/1670/latest.json')
    expect(p.summaryVersion('1670', 'T1')).toBe('kintai/27324455/2026-06/summary/1670/v-T1.json')
  })

  it('乗務員CD が空でも key が壊れない', () => {
    expect(p.summaryLatest('')).toBe('kintai/27324455/2026-06/summary/unknown/latest.json')
  })
})

// ---------------------------------------------------------------------------
// 職種・打刻エラー・休暇 (Refs #433)
// ---------------------------------------------------------------------------

describe('isClericalJob', () => {
  it('本番の表記ゆれ 2 種をどちらも拾う', () => {
    expect(isClericalJob('一般管理事務')).toBe(true)
    expect(isClericalJob('一般事務管理')).toBe(true)
  })

  it('乗務員・作業員・役員等は false', () => {
    for (const job of ['乗務員', '乗務員(トレーラ)', '作業員2', '作業員点呼者', '整備', '役員', '執行役', '特定技能']) {
      expect(isClericalJob(job)).toBe(false)
    }
  })

  it('職種が引けない社員は false (判定を掛けない安全側)', () => {
    expect(isClericalJob(null)).toBe(false)
    expect(isClericalJob(undefined)).toBe(false)
    expect(isClericalJob('')).toBe(false)
  })
})

describe('hasOvernightSession', () => {
  it('始業日と終業日が違えば true', () => {
    expect(hasOvernightSession([{ start: '2026-06-08 07:14:08', end: '2026-06-09 18:52:15' }])).toBe(true)
    // 夜勤の 4 時間でも日跨ぎは日跨ぎ (除外は夜勤者マスタで行う)
    expect(hasOvernightSession([{ start: '2026-06-02 19:43:51', end: '2026-06-03 00:02:17' }])).toBe(true)
  })

  it('同日で終われば false (中抜けが複数あっても)', () => {
    expect(hasOvernightSession([
      { start: '2026-06-11 07:44:15', end: '2026-06-11 11:41:10' },
      { start: '2026-06-11 13:14:38', end: '2026-06-11 16:49:11' },
    ])).toBe(false)
    expect(hasOvernightSession([])).toBe(false)
  })

  it('1 本でも日跨ぎがあれば true', () => {
    expect(hasOvernightSession([
      { start: '2026-06-11 07:44:15', end: '2026-06-11 11:41:10' },
      { start: '2026-06-11 22:00:00', end: '2026-06-12 02:00:00' },
    ])).toBe(true)
  })
})

describe('countLeaves', () => {
  it('公休の集計軸は 公休 / 泊休 / 積置泊休 / 指休', () => {
    expect(countLeaves(['公休', '泊休', '積置泊休', '指休']).publicHoliday).toBe(4)
  })

  it('有休は 1.0、前休・後休は 0.5', () => {
    expect(countLeaves(['有休']).paidLeave).toBe(1)
    expect(countLeaves(['前休', '後休', '前休作', '後休作']).paidLeave).toBe(2)
    expect(countLeaves(['有休', '前休']).paidLeave).toBe(1.5)
  })

  it('欠勤・特休・遅刻・早退はそれぞれの軸へ', () => {
    expect(countLeaves(['欠勤', '特休', '遅刻', '早退'])).toEqual({
      publicHoliday: 0, paidLeave: 0, absence: 1, specialLeave: 1, late: 1, earlyLeave: 1,
    })
  })

  it('カウント対象外の区分 (短時・仮乗務・有夜勤・家畜) は数えない', () => {
    expect(countLeaves(['短時', '仮乗務', '有夜勤', '家畜'])).toEqual(emptyLeaveCounts())
  })

  it('空なら全部 0', () => {
    expect(countLeaves([])).toEqual(emptyLeaveCounts())
  })
})

describe('summarizeTimecardDay — 打刻エラー (日跨ぎ)', () => {
  /** 実データ: 佐藤 泰弘 (1065、一般管理事務) 2026-06-08 07:14 → 06-09 18:52。 */
  const SATO = row('2026-06-08', [['07:14:08', '2026-06-09 18:52:15']])

  it('事務職・非夜勤の日跨ぎは打刻エラー — 実時間の代わりに所定労働時間で計上する', () => {
    const d = summarizeTimecardDay(SATO, { dailyWorkMinutes: 450, approved: false, clerical: true, nightShift: false })
    expect(d.isRestDay).toBe(false)
    expect(d.workingMinutes).toBe(450)
    expect(d.restraintMinutes).toBe(450)
    expect(d.overtimeMinutes).toBe(0)
    // 35.6 時間 = 2138 分は実働に使わず記録として残す (残業合計を汚さない)
    expect(d.punchErrorMinutes).toBe(2138)
    // 打刻は残す — 総務が CakePHP 側で直すための手掛かり
    expect(d.sessions).toEqual([{ start: '2026-06-08 07:14:08', end: '2026-06-09 18:52:15' }])
  })

  it('所定が引けない社員の日跨ぎは、埋める値が無いので従来どおり外す', () => {
    const d = summarizeTimecardDay(SATO, { dailyWorkMinutes: null, approved: false, clerical: true, nightShift: false })
    expect(d.isRestDay).toBe(true)
    expect(d.workingMinutes).toBe(0)
    expect(d.restraintMinutes).toBe(0)
    expect(d.punchErrorMinutes).toBe(2138)
  })

  it('未承認の休日打刻が日跨ぎでも、自主出勤の扱い (賃金計算に入れない) を優先する', () => {
    const d = summarizeTimecardDay(
      row('2026-06-21', [['07:14:08', '2026-06-22 18:52:15']], 'legal'),
      { dailyWorkMinutes: 450, approved: false, clerical: true, nightShift: false },
    )
    expect(d.isRestDay).toBe(true)
    expect(d.workingMinutes).toBe(0)
    expect(d.holidayKind).toBe('legal')
  })

  it('承認済みの休日出勤なら日跨ぎでも所定で計上する (割増は付けない)', () => {
    const d = summarizeTimecardDay(
      row('2026-06-21', [['07:14:08', '2026-06-22 18:52:15']], 'legal'),
      { dailyWorkMinutes: 450, approved: true, clerical: true, nightShift: false },
    )
    expect(d.isRestDay).toBe(false)
    expect(d.workingMinutes).toBe(450)
    // 時間が分からない日に割増の率だけ決めることはできないので平日として計上する
    expect(d.holidayKind).toBe('weekday')
  })

  it('夜勤者は日跨ぎでもエラーにしない (実データ: 山根 19:43→翌00:02)', () => {
    const d = summarizeTimecardDay(
      row('2026-06-02', [['19:43:51', '2026-06-03 00:02:17']]),
      { dailyWorkMinutes: 450, approved: false, clerical: true, nightShift: true },
    )
    expect(d.punchErrorMinutes).toBe(0)
    expect(d.isRestDay).toBe(false)
    expect(d.workingMinutes).toBe(258)
  })

  it('非事務職 (乗務員) は日跨ぎでもエラーにしない', () => {
    const d = summarizeTimecardDay(SATO, { dailyWorkMinutes: 450, approved: false, clerical: false, nightShift: false })
    expect(d.punchErrorMinutes).toBe(0)
    expect(d.isRestDay).toBe(false)
  })

  it('同日で終わる打刻は事務職・非夜勤でもエラーにしない', () => {
    const d = summarizeTimecardDay(
      row('2026-06-01', [['07:13:25', '20:16:42']]),
      { dailyWorkMinutes: 450, approved: false, clerical: true, nightShift: false },
    )
    expect(d.punchErrorMinutes).toBe(0)
    expect(d.isRestDay).toBe(false)
  })

  it('休日の日跨ぎは自主出勤より打刻エラーが優先される', () => {
    const d = summarizeTimecardDay(
      row('2026-06-07', [['07:00:00', '2026-06-08 19:00:00']], 'legal'),
      { dailyWorkMinutes: 450, approved: false, clerical: true, nightShift: false },
    )
    expect(d.punchErrorMinutes).toBeGreaterThan(0)
    expect(d.voluntaryMinutes).toBe(0)
  })
})

describe('summarizeTimecardDay — 非事務職の休日打刻 (Refs #433)', () => {
  const NON_CLERICAL = { dailyWorkMinutes: 480, approved: false, clerical: false, nightShift: false }

  it('自主出勤にせず通常どおり計上する', () => {
    const d = summarizeTimecardDay(row('2026-06-07', [['08:00:00', '17:00:00']], 'legal'), NON_CLERICAL)
    expect(d.isRestDay).toBe(false)
    expect(d.voluntaryMinutes).toBe(0)
    expect(d.workingMinutes).toBe(480)
  })

  it('法定休日 (日曜) は未承認でも holidayKind を保つ = 1.35 が付く', () => {
    const d = summarizeTimecardDay(row('2026-06-07', [['08:00:00', '17:00:00']], 'legal'), NON_CLERICAL)
    expect(d.holidayKind).toBe('legal')
  })

  it('法定外休日 (祝日・指定休) の未承認は weekday へ落とす = 1.25 を付けない', () => {
    const d = summarizeTimecardDay(row('2026-05-04', [['08:00:00', '17:00:00']], 'non_legal'), NON_CLERICAL)
    expect(d.holidayKind).toBe('weekday')
    expect(d.isRestDay).toBe(false)
    expect(d.workingMinutes).toBe(480)
  })

  it('法定外休日でも承認済みなら non_legal のまま = 1.25 が付く', () => {
    const d = summarizeTimecardDay(row('2026-05-04', [['08:00:00', '17:00:00']], 'non_legal'), {
      ...NON_CLERICAL,
      approved: true,
    })
    expect(d.holidayKind).toBe('non_legal')
  })

  it('事務職は従来どおり自主出勤へ倒れる (法定外休日を weekday へ落とさない)', () => {
    const d = summarizeTimecardDay(row('2026-05-04', [['08:00:00', '17:00:00']], 'non_legal'), NO_APPROVAL)
    expect(d.isRestDay).toBe(true)
    expect(d.holidayKind).toBe('non_legal')
    expect(d.voluntaryMinutes).toBe(480)
  })
})

describe('summarizeTimecardDay — 夜勤者の休日打刻 (Refs #433)', () => {
  // 実データ (2026-06): 1706 山根 (事務職・夜勤) は日曜 18:46 始業、1196 副島
  // (作業員・夜勤) は日曜 23:45 始業。同じ日曜夜勤なので同じ扱いにする
  const NIGHT_CLERICAL = { dailyWorkMinutes: 480, approved: false, clerical: true, nightShift: true }
  const NIGHT_WORKER = { ...NIGHT_CLERICAL, clerical: false }

  it('事務職の夜勤者は自主出勤にならず通常計上される (山根 6/14・6/28)', () => {
    const d = summarizeTimecardDay(row('2026-06-14', [['18:46:00', '23:46:00']], 'legal'), NIGHT_CLERICAL)
    expect(d.isRestDay).toBe(false)
    expect(d.voluntaryMinutes).toBe(0)
    expect(d.workingMinutes).toBe(300)
  })

  it('法定休日 (日曜) でも割増を付けない = holidayKind は weekday', () => {
    const d = summarizeTimecardDay(row('2026-06-14', [['18:46:00', '23:46:00']], 'legal'), NIGHT_CLERICAL)
    expect(d.holidayKind).toBe('weekday')
  })

  it('法定外休日 (祝日・指定休) も weekday へ落とす', () => {
    const d = summarizeTimecardDay(row('2026-05-04', [['18:46:00', '23:46:00']], 'non_legal'), NIGHT_CLERICAL)
    expect(d.holidayKind).toBe('weekday')
    expect(d.isRestDay).toBe(false)
  })

  it('非事務職の夜勤者も同じ扱い — 法定休日の 1.35 が付かなくなる (副島 1196)', () => {
    // 職種で扱いを変えない (2026-07-26 ユーザー決定)。非夜勤の非事務職なら legal のまま
    const night = summarizeTimecardDay(row('2026-06-07', [['23:45:00', '2026-06-08 00:33:00']], 'legal'), NIGHT_WORKER)
    const notNight = summarizeTimecardDay(
      row('2026-06-07', [['23:45:00', '2026-06-08 00:33:00']], 'legal'),
      { ...NIGHT_WORKER, nightShift: false },
    )
    expect(night.holidayKind).toBe('weekday')
    expect(notNight.holidayKind).toBe('legal')
  })

  it('承認済みの休日出勤は夜勤者でも割増のまま (承認が明示の意思表示なので優先する)', () => {
    const d = summarizeTimecardDay(row('2026-06-14', [['18:46:00', '23:46:00']], 'legal'), {
      ...NIGHT_CLERICAL,
      approved: true,
    })
    expect(d.holidayKind).toBe('legal')
    expect(d.isRestDay).toBe(false)
  })

  it('月次でも夜勤者に自主出勤が出ない (voluntaryMinutes 0・勤務日として数える)', () => {
    const { summaries } = summarizeTimecardMonth(
      [
        row('2026-06-14', [['18:46:00', '23:46:00']], 'legal'),
        row('2026-06-28', [['18:46:00', '23:46:00']], 'legal'),
      ],
      {
        yearMonth: '2026-06',
        dailyWorkMinutesFor: () => 480,
        approvedHolidayWork: new Set<string>(),
        isClerical: () => true,
        isNightShift: () => true,
      },
    )
    const s = summaries[0]!
    expect(s.voluntaryMinutes).toBe(0)
    expect(s.restDays).toBe(0)
    expect(s.workDays).toBe(2)
  })
})

describe('summarizeTimecardDay — 休暇 (Refs #433)', () => {
  it('打刻なしの休暇日は時間 0 で区分だけ載る (実データ: 佐藤 2026-06-07 公休)', () => {
    const d = summarizeTimecardDay(
      row('2026-06-07', [], 'legal', { leaves: [{ detail: '公休' }] }),
      NO_APPROVAL,
    )
    expect(d.isRestDay).toBe(true)
    expect(d.leaves).toEqual(['公休'])
    expect(d.workingMinutes).toBe(0)
    expect(d.sessions).toEqual([])
  })

  it('打刻のある日の休暇 (遅刻・早退) も運ぶ', () => {
    const d = summarizeTimecardDay(
      row('2026-06-01', [['09:30:00', '17:00:00']], 'weekday', { leaves: [{ detail: '遅刻' }] }),
      NO_APPROVAL,
    )
    expect(d.isRestDay).toBe(false)
    expect(d.leaves).toEqual(['遅刻'])
  })

  it('1 日に複数区分が来ても全部運ぶ', () => {
    const d = summarizeTimecardDay(
      row('2026-06-01', [], 'weekday', { leaves: [{ detail: '前休' }, { detail: '遅刻' }] }),
      NO_APPROVAL,
    )
    expect(d.leaves).toEqual(['前休', '遅刻'])
  })

  it('leaves を返さない上流でも空配列になる (デプロイ順に依存しない)', () => {
    expect(summarizeTimecardDay(row('2026-06-01', [['08:00:00', '17:00:00']]), NO_APPROVAL).leaves).toEqual([])
  })
})

describe('summarizeTimecardMonth — 打刻エラーと休暇 (Refs #433)', () => {
  const monthOpts = (over: Record<string, unknown> = {}) => ({
    yearMonth: '2026-06',
    dailyWorkMinutesFor: () => 450 as number | null,
    approvedHolidayWork: new Set<string>(),
    ...over,
  })

  it('打刻エラーの日も所定労働時間で計上し、実測の拘束は別枠に残す', () => {
    const { summaries } = summarizeTimecardMonth(
      [
        row('2026-06-01', [['07:13:25', '20:16:42']]),
        row('2026-06-08', [['07:14:08', '2026-06-09 18:52:15']]),
        row('2026-06-25', [['07:14:11', '2026-06-26 19:49:05']]),
      ],
      monthOpts({ isClerical: () => true, isNightShift: () => false }),
    )
    const s = summaries[0]!
    expect(s.punchErrorDays).toBe(2)
    expect(s.punchErrorMinutes).toBe(2138 + 2194)
    // 3 日とも勤務日 — 打刻エラーの 2 日は所定 450 分で計上する (Refs #468)
    expect(s.workDays).toBe(3)
    expect(s.workingMinutes).toBe(723 + 450 + 450)
    expect(s.restraintMinutes).toBe(783 + 450 + 450)
  })

  it('所定が引けなければ打刻エラーの日は従来どおり賃金計算から外れる', () => {
    const { summaries } = summarizeTimecardMonth(
      [
        row('2026-06-01', [['07:13:25', '20:16:42']]),
        row('2026-06-08', [['07:14:08', '2026-06-09 18:52:15']]),
      ],
      monthOpts({ dailyWorkMinutesFor: () => null, isClerical: () => true, isNightShift: () => false }),
    )
    const s = summaries[0]!
    expect(s.punchErrorDays).toBe(1)
    expect(s.workDays).toBe(1)
    expect(s.workingMinutes).toBe(723)
  })

  it('夜勤者は日跨ぎが 15 回あっても打刻エラー 0', () => {
    const rows = Array.from({ length: 15 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0')
      const next = String(i + 2).padStart(2, '0')
      return row(`2026-06-${day}`, [['19:43:51', `2026-06-${next} 00:02:17`]])
    })
    const { summaries } = summarizeTimecardMonth(
      rows,
      monthOpts({ isClerical: () => true, isNightShift: () => true }),
    )
    expect(summaries[0]!.punchErrorDays).toBe(0)
    expect(summaries[0]!.workDays).toBe(15)
  })

  it('isClerical / isNightShift 未指定なら全員 非事務職・非夜勤 (判定を掛けない)', () => {
    const { summaries } = summarizeTimecardMonth(
      [row('2026-06-08', [['07:14:08', '2026-06-09 18:52:15']])],
      monthOpts(),
    )
    expect(summaries[0]!.punchErrorDays).toBe(0)
    expect(summaries[0]!.workDays).toBe(1)
  })

  it('休暇を月次で集計する', () => {
    const { summaries } = summarizeTimecardMonth(
      [
        row('2026-06-07', [], 'legal', { leaves: [{ detail: '公休' }] }),
        row('2026-06-09', [], 'weekday', { leaves: [{ detail: '公休' }] }),
        row('2026-06-10', [], 'weekday', { leaves: [{ detail: '有休' }] }),
        row('2026-06-11', [], 'weekday', { leaves: [{ detail: '前休' }] }),
        row('2026-06-12', [], 'weekday', { leaves: [{ detail: '欠勤' }] }),
      ],
      monthOpts({ isClerical: () => true }),
    )
    const s = summaries[0]!
    expect(s.leaveCounts).toEqual({
      publicHoliday: 2, paidLeave: 1.5, absence: 1, specialLeave: 0, late: 0, earlyLeave: 0,
    })
    // 打刻が 1 日も無いので勤務 0・全日 restDays
    expect(s.workDays).toBe(0)
    expect(s.restDays).toBe(5)
  })

  it('休暇の行しか無い社員も summary に出る (公休の突合ができる)', () => {
    const { summaries } = summarizeTimecardMonth(
      [{ ...row('2026-06-07', [], 'legal', { leaves: [{ detail: '公休' }] }), driver_id: 1048, name: '宮崎　康博' }],
      monthOpts({ isClerical: () => true }),
    )
    expect(summaries.map(s => s.driverCd)).toEqual(['1048'])
    expect(summaries[0]!.leaveCounts.publicHoliday).toBe(1)
  })
})

describe('退社打刻なし (end: null、nginx#780)', () => {
  /** 始業だけのセッション (end: null) を含む日を作る。 */
  function openRow(
    date: string,
    starts: string[],
    complete: Array<[string, string]> = [],
    extra: Partial<TimecardDailyRow> = {},
  ): TimecardDailyRow {
    const sessions = [
      ...complete.map(([s, e]) => ({ start: `${date} ${s}`, end: `${date} ${e}` })),
      ...starts.map(s => ({ start: `${date} ${s}`, end: null })),
    ]
    return {
      driver_id: 1722,
      name: '山下　寿裕',
      date,
      start: sessions[0]?.start ?? null,
      end: null,
      restraint_minutes: 0,
      sessions,
      holiday: 'weekday',
      office: '大石運輸倉庫㈱ 本社',
      ...extra,
    }
  }

  it('過去日の未終業は「退社打刻なし」— 所定労働時間で計上し、始業は表示用に残る', () => {
    const d = summarizeTimecardDay(openRow('2026-06-16', ['07:41:00']), NO_APPROVAL)
    expect(d.missingClockOut).toBe(true)
    expect(d.isRestDay).toBe(false)
    expect(d.workingMinutes).toBe(480)
    expect(d.restraintMinutes).toBe(480)
    expect(d.overtimeMinutes).toBe(0)
    expect(d.punchErrorMinutes).toBe(0) // 終業が無いので拘束の長さは分からない
    expect(d.sessions).toEqual([{ start: '2026-06-16 07:41:00', end: null }])
  })

  it('所定が引けない社員の未終業は、埋める値が無いので従来どおり外す', () => {
    const d = summarizeTimecardDay(
      openRow('2026-06-16', ['07:41:00']),
      { ...NO_APPROVAL, dailyWorkMinutes: null },
    )
    expect(d.missingClockOut).toBe(true)
    expect(d.isRestDay).toBe(true)
    expect(d.workingMinutes).toBe(0)
  })

  it('未承認の休日打刻に退社打刻が無くても、自主出勤の扱いを優先して外す', () => {
    const d = summarizeTimecardDay(
      openRow('2026-06-21', ['07:41:00'], [], { holiday: 'legal' }),
      NO_APPROVAL,
    )
    expect(d.missingClockOut).toBe(true)
    expect(d.isRestDay).toBe(true)
    expect(d.holidayKind).toBe('legal')
  })

  it('完結セッションと未終業が混在する日も所定で計上し、完結分の拘束を punchErrorMinutes に退避する', () => {
    const d = summarizeTimecardDay(
      openRow('2026-06-16', ['13:10:00'], [['08:00:00', '12:00:00']]),
      NO_APPROVAL,
    )
    expect(d.missingClockOut).toBe(true)
    expect(d.isRestDay).toBe(false)
    expect(d.workingMinutes).toBe(480)
    expect(d.punchErrorMinutes).toBe(240) // 08:00-12:00
    // 表示用の並びは時刻順 (完結 → 未終業)
    expect(d.sessions).toEqual([
      { start: '2026-06-16 08:00:00', end: '2026-06-16 12:00:00' },
      { start: '2026-06-16 13:10:00', end: null },
    ])
  })

  it('未終業が完結セッションより早い日も時刻順に並ぶ', () => {
    const d = summarizeTimecardDay(
      openRow('2026-06-16', ['07:00:00'], [['08:00:00', '12:00:00']]),
      NO_APPROVAL,
    )
    expect(d.sessions.map(s => s.start)).toEqual(['2026-06-16 07:00:00', '2026-06-16 08:00:00'])
  })

  it('同時刻の始業が並んでも順序が安定している (比較の等値分岐)', () => {
    const d = summarizeTimecardDay(
      openRow('2026-06-16', ['08:00:00'], [['08:00:00', '12:00:00']]),
      NO_APPROVAL,
    )
    expect(d.sessions.map(s => s.start)).toEqual(['2026-06-16 08:00:00', '2026-06-16 08:00:00'])
  })

  it('当日の未終業は勤務中 — フラグを立てず打刻なしの休み扱い', () => {
    const d = summarizeTimecardDay(
      openRow('2026-06-16', ['07:41:00']),
      { ...NO_APPROVAL, today: '2026-06-16' },
    )
    expect(d.missingClockOut).toBeUndefined()
    expect(d.isRestDay).toBe(true)
    expect(d.sessions).toEqual([{ start: '2026-06-16 07:41:00', end: null }])
  })

  it('today より前の日は押し忘れとしてフラグが立つ', () => {
    const d = summarizeTimecardDay(
      openRow('2026-06-16', ['07:41:00']),
      { ...NO_APPROVAL, today: '2026-06-17' },
    )
    expect(d.missingClockOut).toBe(true)
  })

  it('始業時刻が読めない未終業セッションは捨てる (フラグも立たない)', () => {
    const d = summarizeTimecardDay(openRow('2026-06-16', ['ぐちゃぐちゃ']), NO_APPROVAL)
    expect(d.missingClockOut).toBeUndefined()
    expect(d.sessions).toEqual([])
  })

  it('hasOvernightSession は end: null を日跨ぎと数えない', () => {
    expect(hasOvernightSession([{ start: '2026-06-16 07:41:00', end: null }])).toBe(false)
  })

  it('月次: punchErrorDays に数え、warnings に日と件数が出る', () => {
    const { summaries, warnings } = summarizeTimecardMonth(
      [
        openRow('2026-06-16', ['07:41:00']),
        openRow('2026-06-17', ['07:45:00']),
        { ...row('2026-06-23', [['07:38:00', '17:29:00']]), driver_id: 1722, name: '山下　寿裕' },
      ],
      {
        yearMonth: '2026-06',
        dailyWorkMinutesFor: () => 480,
        approvedHolidayWork: new Set<string>(),
        today: '2026-07-27',
      },
    )
    const s = summaries[0]!
    expect(s.punchErrorDays).toBe(2)
    expect(s.punchErrorMinutes).toBe(0)
    expect(s.workDays).toBe(3) // 退社打刻なしの 2 日も所定 480 分で計上する
    expect(s.workingMinutes).toBe(480 + 480 + 531) // 6/23 は 07:38-17:29 − 昼休憩
    expect(warnings).toEqual([
      '乗務員 1722 (山下　寿裕): 退社打刻の無い日が 2 日あります (16, 17 日)'
      + ' — 時間は所定労働時間で計上しています。打刻を直して取り込み直すと実測に置き換わります',
    ])
  })

  it('月次: 所定が引けない社員は外したことを warnings で言う', () => {
    const { summaries, warnings } = summarizeTimecardMonth(
      [openRow('2026-06-16', ['07:41:00'])],
      {
        yearMonth: '2026-06',
        dailyWorkMinutesFor: () => null,
        approvedHolidayWork: new Set<string>(),
        today: '2026-07-27',
      },
    )
    expect(summaries[0]!.workDays).toBe(0)
    expect(warnings).toEqual([
      '乗務員 1722 (山下　寿裕): 退社打刻の無い日が 1 日あります (16 日)'
      + ' — うち 1 日は所定労働時間が引けないため賃金計算から外しています。打刻を直して取り込み直すと実測に置き換わります',
    ])
  })

  it('月次: 未終業が無ければ warnings は出ない', () => {
    const { warnings } = summarizeTimecardMonth(
      [row('2026-06-02', [['08:00:00', '17:00:00']])],
      {
        yearMonth: '2026-06',
        dailyWorkMinutesFor: () => 480,
        approvedHolidayWork: new Set<string>(),
        isClerical: () => true,
        isNightShift: () => false,
      },
    )
    expect(warnings).toEqual([])
  })
})

describe('applyKosokuTimes', () => {
  const day = (over: Record<string, unknown> = {}) => ({
    day: 6,
    isRestDay: false,
    restraintMinutes: 12106,
    workingMinutes: 11566,
    overtimeMinutes: 7726,
    nightMinutes: 0,
    overtimeNightMinutes: 3360,
      ferryMinusMinutes: 0,
      runGapMinutes: 0,
      punchTailMinutes: 0,
      punchHeadMinutes: 0,
      runHeadMinutes: 0,
      lunchOverlapMinutes: 0,
    holidayKind: 'weekday' as const,
    voluntaryMinutes: 0,
    punchErrorMinutes: 0,
    leaves: [] as string[],
    sessions: [{ start: '2026-04-06 05:44:46', end: '2026-04-14 15:31:38' }],
    ...over,
  })
  const part = (over: Record<string, number> = {}) => ({
    restraintMinutes: 699,
    workingMinutes: 486,
    overtimeMinutes: 6,
    nightMinutes: 30,
    overtimeNightMinutes: 10,
      ferryMinusMinutes: 0,
      runGapMinutes: 0,
      punchTailMinutes: 0,
      punchHeadMinutes: 0,
      runHeadMinutes: 0,
      lunchOverlapMinutes: 0,
    ...over,
  })

  it('kosoku のある日は時間を差し替え、休暇・打刻・休日区分は残す', () => {
    const [got] = applyKosokuTimes(
      [day({ leaves: ['指休'], punchErrorMinutes: 99, holidayKind: 'non_legal' })],
      new Map([['2026-04-06', part()]]),
      '2026-04',
    )
    expect(got).toMatchObject({
      day: 6,
      isRestDay: false,
      restraintMinutes: 699,
      workingMinutes: 486,
      overtimeMinutes: 6,
      nightMinutes: 30,
      overtimeNightMinutes: 10,
      ferryMinusMinutes: 0,
      runGapMinutes: 0,
      punchTailMinutes: 0,
      punchHeadMinutes: 0,
      runHeadMinutes: 0,
      lunchOverlapMinutes: 0,
      // 打刻側から引き継ぐもの
      holidayKind: 'non_legal',
      leaves: ['指休'],
      punchErrorMinutes: 99,
      sessions: [{ start: '2026-04-06 05:44:46', end: '2026-04-14 15:31:38' }],
    })
  })

  it('休暇の日に kosoku の勤務があれば出勤に変える', () => {
    const [got] = applyKosokuTimes(
      [day({ isRestDay: true, leaves: ['公休'], restraintMinutes: 0, workingMinutes: 0 })],
      new Map([['2026-04-06', part()]]),
      '2026-04',
    )
    expect(got!.isRestDay).toBe(false)
    expect(got!.workingMinutes).toBe(486)
  })

  it('kosoku に勤務が無い日は時間 0。**isRestDay は打刻側のまま**にして欠けに気付けるようにする', () => {
    const got = applyKosokuTimes([day(), day({ day: 7, isRestDay: true })], new Map(), '2026-04')
    expect(got.map(d => [d.day, d.isRestDay, d.restraintMinutes, d.workingMinutes, d.overtimeMinutes])).toEqual([
      [6, false, 0, 0, 0],
      [7, true, 0, 0, 0],
    ])
  })

  it('打刻側に行が無い日は足す (日曜だけ法定休日)', () => {
    const got = applyKosokuTimes(
      [day()],
      new Map([
        ['2026-04-06', part()],
        ['2026-04-12', part({ workingMinutes: 34 })], // 日曜
        ['2026-04-13', part({ workingMinutes: 60 })], // 月曜
      ]),
      '2026-04',
    )
    expect(got.map(d => [d.day, d.holidayKind, d.isRestDay])).toEqual([
      [6, 'weekday', false],
      [12, 'legal', false],
      [13, 'weekday', false],
    ])
    expect(got[1]).toMatchObject({ leaves: [], sessions: [], voluntaryMinutes: 0, punchErrorMinutes: 0 })
  })

  it('日順に並べ直す', () => {
    const got = applyKosokuTimes(
      [day({ day: 20 })],
      new Map([['2026-04-02', part()], ['2026-04-20', part()]]),
      '2026-04',
    )
    expect(got.map(d => d.day)).toEqual([2, 20])
  })
})
