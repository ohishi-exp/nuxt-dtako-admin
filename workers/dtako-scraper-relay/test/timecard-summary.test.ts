import { describe, expect, it } from 'vitest'
import {
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
  summarizeTimecardDay,
  summarizeTimecardMonth,
  timestampToSeconds,
  TimecardSummaryError,
  totalLength,
  trailingSlice,
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

const NO_APPROVAL = { dailyWorkMinutes: 480, approved: false }

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
    const d = summarizeTimecardDay(row('2026-06-01', [['08:00:00', '2026-06-02 00:00:00']]), NO_APPROVAL)
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
      { dailyWorkMinutes: 480, approved: false },
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
  const opts = (approved: string[] = [], minutes: number | null = 480) => ({
    yearMonth: '2026-06',
    dailyWorkMinutesFor: () => minutes,
    approvedHolidayWork: new Set(approved),
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
  })

  it('同じ乗務員CD が両方に居たら theearth を採り warning を出す', () => {
    const theearth = entry('1670')
    const { merged, warnings } = mergeSummarySources([theearth], [entry('1670'), entry('205')])
    expect(merged.map(m => m.entry.data.driverCd)).toEqual(['205', '1670'])
    expect(merged.find(m => m.entry.data.driverCd === '1670')!.entry).toBe(theearth)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/1670/)
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
