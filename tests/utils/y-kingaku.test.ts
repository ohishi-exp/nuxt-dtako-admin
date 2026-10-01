/**
 * Y金額 シートの時間の行 (`app/utils/y-kingaku.ts`、Refs #1133 c1133-31)。
 *
 * テンプレの式を列ごとに写したものなので、テストも列ごとに小さな架空の日で固定する。
 * 日付は 2030 年 (2030-01-06 が日曜)、時刻・設定はどれも架空の値。
 */
import { describe, it, expect } from 'vitest'
import {
  Y_KINGAKU_SETTING_REFS,
  computeYKingaku,
  computeYKingakuDays,
  decodeYKingakuHeader,
  encodeYKingakuHeader,
  parseYKingakuSettings,
  sumYKingakuMonths,
  type YKingakuMonth,
  type YKingakuSettings,
} from '~/utils/y-kingaku'
import type { SheetCellValue, YTimeInputCol, YTimeInputDay } from '~/utils/y-time-xlsx'

/** 法定休日 = 日、週 40h、起算 = 日、所定 = 月〜金 7h・土 4h、末締め、月 60h は不適用 */
const SETTINGS: YKingakuSettings = {
  legalHolidayWeekday: 0,
  weeklyLimitMinutes: 2400,
  weekStartWeekday: 0,
  scheduledMinutes: [0, 420, 420, 420, 420, 420, 240],
  closingDay: 'end',
  over60Applies: false,
}

type Rests = Partial<Record<Exclude<YTimeInputCol, 'F' | 'G' | 'H'>, number>>

/** 始業・終業 (分) と休憩。`prev` は F 列 (前日始業) */
function work(date: string, start: number, end: number, rests: Rests = {}, prev = false): YTimeInputDay {
  return { date, cells: { ...(prev ? { F: 1 } : {}), G: start, H: end, ...rests } }
}
/** 8:00〜17:00・昼休憩 60 分 = 実労働 8h (所定 7h + 法内残業 1h) */
const eightHours = (date: string) => work(date, 480, 1020, { L: 60 })

function days(input: YTimeInputDay[], from: string, to: string, settings = SETTINGS) {
  return new Map(computeYKingakuDays(input, { from, to }, settings).map((d) => [d.date, d]))
}

describe('computeYKingakuDays — 所定内・法内残業・日 8h 超 (Q / S / T 列)', () => {
  const d = days([
    work('2030-01-07', 540, 1020, { L: 60 }),
    work('2030-01-08', 540, 1050, { L: 60 }),
    work('2030-01-09', 480, 1200, { L: 60 }),
  ], '2030-01-07', '2030-01-09')

  it('所定ちょうどの日は所定内だけ', () => {
    expect(d.get('2030-01-07')).toEqual({
      date: '2030-01-07', total: 420, scheduled: 420, statutoryIn: 0, dailyOver: 0, weeklyOver: 0, weekTotal: 420, holiday: 0, night: 0,
    })
  })

  it('所定を超えて 8h 以内は法内残業', () => {
    expect(d.get('2030-01-08')).toMatchObject({ total: 450, scheduled: 420, statutoryIn: 30, dailyOver: 0, weekTotal: 870 })
  })

  it('★ 8h を超えた分は法外残業 (日 8h 超) で、週累計には入らない', () => {
    expect(d.get('2030-01-09')).toMatchObject({ total: 660, scheduled: 420, statutoryIn: 60, dailyOver: 180, weekTotal: 1350 })
  })

  it('入力の無い日も行としては在り、全部 0', () => {
    const empty = days([eightHours('2030-01-07')], '2030-01-07', '2030-01-08').get('2030-01-08')
    expect(empty).toEqual({
      date: '2030-01-08', total: 0, scheduled: 0, statutoryIn: 0, dailyOver: 0, weeklyOver: 0, weekTotal: 480, holiday: 0, night: 0,
    })
  })
})

describe('computeYKingakuDays — 週の制限超え (U / V 列)', () => {
  const weekdays = ['2030-01-07', '2030-01-08', '2030-01-09', '2030-01-10', '2030-01-11']
  const saturday = work('2030-01-12', 480, 780)

  it('★ 週累計がちょうど制限に達していたら、6・7 日目の実労働は全部が週超え', () => {
    const d = days([...weekdays.map(eightHours), saturday], '2030-01-06', '2030-01-12')
    expect(d.get('2030-01-11')!.weekTotal).toBe(2400)
    expect(d.get('2030-01-12')).toMatchObject({ total: 300, weeklyOver: 300, dailyOver: 0, scheduled: 0, statutoryIn: 0, weekTotal: 2400 })
  })

  it('★ 途中で制限を超える日は、超えた分だけ週超え・残りは所定内', () => {
    const friday = work('2030-01-11', 480, 840, { L: 60 })
    const d = days([...weekdays.slice(0, 4).map(eightHours), friday, saturday], '2030-01-06', '2030-01-12')
    expect(d.get('2030-01-11')!.weekTotal).toBe(2220)
    expect(d.get('2030-01-12')).toMatchObject({ weeklyOver: 120, scheduled: 180, statutoryIn: 0, dailyOver: 0, weekTotal: 2400 })
  })

  it('前日までの週累計が「制限 − 8h」以下なら週超えは見ない', () => {
    const d = days([...weekdays.slice(0, 4).map(eightHours), saturday], '2030-01-06', '2030-01-12')
    expect(d.get('2030-01-11')!.weekTotal).toBe(1920)
    expect(d.get('2030-01-12')).toMatchObject({ weeklyOver: 0, scheduled: 240, statutoryIn: 60 })
  })

  it('「制限 − 8h」を超えていても、足して制限に届かなければ 0', () => {
    const friday = work('2030-01-11', 480, 540)
    const d = days([...weekdays.slice(0, 4).map(eightHours), friday, saturday], '2030-01-06', '2030-01-12')
    expect(d.get('2030-01-11')!.weekTotal).toBe(1980)
    expect(d.get('2030-01-12')).toMatchObject({ weeklyOver: 0, scheduled: 240, statutoryIn: 60 })
  })

  it('★ 週の起算曜日を変えると、同じ勤務でも週超えの出る日が変わる', () => {
    const input = ['2030-01-10', '2030-01-11', '2030-01-12', '2030-01-14', '2030-01-15', '2030-01-16'].map(eightHours)
    // 起算 = 日: 木金土 / 月火水 が別の週になり、どちらも制限に届かない
    const sunday = days(input, '2030-01-06', '2030-01-19')
    expect([...sunday.values()].every((x) => x.weeklyOver === 0)).toBe(true)
    // 起算 = 木: 木〜水が 1 週。7 日目の水曜の前に 40h に達する
    const thursday = days(input, '2030-01-06', '2030-01-19', { ...SETTINGS, weekStartWeekday: 4 })
    expect(thursday.get('2030-01-15')).toMatchObject({ weeklyOver: 0, weekTotal: 2400 })
    expect(thursday.get('2030-01-16')).toMatchObject({ weeklyOver: 480, scheduled: 0, statutoryIn: 0, dailyOver: 0 })
  })

  it('★ 冊の初日が週の途中なら、週累計は冊の初日から数える (初日より前は無い)', () => {
    const d = days([...weekdays.slice(2).map(eightHours), saturday], '2030-01-09', '2030-01-12')
    expect(d.get('2030-01-11')!.weekTotal).toBe(1440)
    expect(d.get('2030-01-12')).toMatchObject({ weeklyOver: 0, weekTotal: 1740 })
  })

  it('★ 週が月をまたいでも週累計は切れない (冊の途中でリセットしない)', () => {
    const input = ['2030-01-28', '2030-01-29', '2030-01-30', '2030-01-31', '2030-02-01'].map(eightHours)
    const period = { from: '2030-01-27', to: '2030-02-02' }
    const d = computeYKingakuDays([...input, work('2030-02-02', 480, 780)], period, SETTINGS)
    expect(d.at(-1)).toMatchObject({ date: '2030-02-02', weeklyOver: 300, weekTotal: 2400 })
    const months = computeYKingaku([...input, work('2030-02-02', 480, 780)], period, SETTINGS)
    expect(months.map((m) => [m.from, m.statutoryOut])).toEqual([['2030-01-01', 0], ['2030-02-01', 300]])
  })

  it('冊の初日は 6・7 日目でも週超えを見ない (行 7 の U は式でなく 0)', () => {
    const d = days([saturday], '2030-01-12', '2030-01-12')
    expect(d.get('2030-01-12')).toMatchObject({ weeklyOver: 0, scheduled: 240, statutoryIn: 60 })
  })
})

describe('computeYKingakuDays — 法定休日 (W 列は前後の行の法定休日を見る)', () => {
  it('法定休日の当日 0〜24 時は休日労働で、所定内にも残業にも入らない', () => {
    const d = days([work('2030-01-13', 540, 1020, { L: 60 })], '2030-01-12', '2030-01-14')
    expect(d.get('2030-01-13')).toMatchObject({ total: 420, holiday: 420, scheduled: 0, statutoryIn: 0, dailyOver: 0 })
  })

  it('法定休日の行に前日 22 時からの勤務があると、前日の分は休日労働にしない', () => {
    const d = days([work('2030-01-13', 1320, 360, {}, true)], '2030-01-12', '2030-01-14')
    expect(d.get('2030-01-13')).toMatchObject({ total: 480, holiday: 360, scheduled: 0, statutoryIn: 120, night: 420 })
  })

  it('★ 翌日の行でも、前日 (法定休日) 22 時からの分は休日労働', () => {
    const d = days([work('2030-01-14', 1320, 360, {}, true)], '2030-01-12', '2030-01-14')
    expect(d.get('2030-01-14')).toMatchObject({ total: 480, holiday: 120, scheduled: 360, statutoryIn: 0, dailyOver: 0, night: 420 })
  })

  it('★ 前日の行でも、翌日 (法定休日) 0〜5 時にかかった分は休日労働', () => {
    const d = days([work('2030-01-12', 1200, 180)], '2030-01-12', '2030-01-14')
    expect(d.get('2030-01-12')).toMatchObject({ total: 420, holiday: 180, scheduled: 240, statutoryIn: 0, night: 300 })
  })

  it('冊の端では前後の行が無いので、その分は休日労働にならない (Excel と同じ)', () => {
    const first = days([work('2030-01-14', 1320, 360, {}, true)], '2030-01-14', '2030-01-14')
    expect(first.get('2030-01-14')).toMatchObject({ total: 480, holiday: 0 })
    const last = days([work('2030-01-12', 1200, 180)], '2030-01-12', '2030-01-12')
    expect(last.get('2030-01-12')).toMatchObject({ total: 420, holiday: 0 })
  })

  it('法定休日の曜日は設定で変わる', () => {
    const d = days([work('2030-01-12', 540, 1020)], '2030-01-12', '2030-01-12', { ...SETTINGS, legalHolidayWeekday: 6 })
    expect(d.get('2030-01-12')).toMatchObject({ total: 480, holiday: 480, scheduled: 0 })
  })
})

describe('computeYKingakuDays — 時間帯の割り方 (AB〜AQ 列) と深夜 (X 列)', () => {
  const one = (day: YTimeInputDay) => computeYKingakuDays([day], { from: day.date, to: day.date }, SETTINGS)[0]!

  it('前日始業 (F=1) は前日 5-22 / 22-24 と当日 0 時からに割り、休憩はそれぞれから引く', () => {
    const d = one(work('2030-01-08', 600, 120, { I: 60, J: 30, K: 15 }, true))
    // 前日 10:00〜22:00 = 720 − 60、22:00〜24:00 = 120 − 30、0:00〜2:00 = 120 − 15
    expect(d).toMatchObject({ total: 855, night: 195, dailyOver: 375, scheduled: 420, statutoryIn: 60 })
  })

  it('前日始業が 22 時より後なら、前日 5-22 は 0', () => {
    expect(one(work('2030-01-08', 1380, 60, {}, true))).toMatchObject({ total: 120, night: 120 })
  })

  it('★ 終業が始業以下なら翌日の時刻として読む (日跨ぎ)。24 時を超えた終業はそのまま', () => {
    const wrapped = one(work('2030-01-08', 1200, 180))
    const direct = one(work('2030-01-08', 1200, 1620))
    expect(wrapped).toEqual(direct)
    expect(wrapped).toMatchObject({ total: 420, night: 300 })
  })

  it('0-5 / 5-22 / 22-24 / 24-29 / 29 時超え に割り、深夜は 0-5・22-24・24-29 だけ', () => {
    const d = one(work('2030-01-08', 240, 1860, { K: 10, L: 60, M: 20, N: 30, O: 40 }))
    // 4:00〜5:00 = 60 − 10、5:00〜22:00 = 1020 − 60、22:00〜24:00 = 120 − 20、24:00〜29:00 = 300 − 30、29:00〜31:00 = 120 − 40
    expect(d).toMatchObject({ total: 1460, night: 420 })
  })

  it('前日始業で 5 時までに終わる勤務は、当日 5-22 に何も入らない', () => {
    expect(one(work('2030-01-08', 1320, 200, {}, true))).toMatchObject({ total: 320, night: 320 })
  })

  it('式どおり: 始業が 24 時・29 時以降の値でも、その時間帯より前は 0', () => {
    expect(one(work('2030-01-08', 1500, 1800))).toMatchObject({ total: 300, night: 240 })
    expect(one(work('2030-01-08', 1750, 1800))).toMatchObject({ total: 50, night: 0 })
  })

  it('式どおり: 始業が空の行は拘束 0 (休憩だけ残っていれば負)。終業が空なら 0 時として読む', () => {
    expect(one({ date: '2030-01-08', cells: { I: 30 } })).toMatchObject({ total: -30, scheduled: 0, statutoryIn: -30 })
    expect(one({ date: '2030-01-08', cells: { G: 600 } })).toMatchObject({ total: 840, night: 120 })
  })
})

describe('computeYKingaku — 賃金月度 (Y金額 X・Z 列) と時間の行', () => {
  const input = [eightHours('2030-01-31'), work('2030-02-01', 480, 1200, { L: 60 })]
  const period = { from: '2030-01-06', to: '2030-03-10' }
  const ranges = (months: YKingakuMonth[]) => months.map((m) => `${m.from}〜${m.to}`)

  it('★ 締め日が「末」なら暦月。最後の月度は期間の末日を過ぎても月末まで', () => {
    const months = computeYKingaku(input, period, SETTINGS)
    expect(months).toEqual([
      { from: '2030-01-01', to: '2030-01-31', statutoryIn: 60, statutoryOut: 0, over60: null, holiday: 0, night: 0, total: 480 },
      { from: '2030-02-01', to: '2030-02-28', statutoryIn: 60, statutoryOut: 180, over60: null, holiday: 0, night: 0, total: 660 },
      { from: '2030-03-01', to: '2030-03-31', statutoryIn: 0, statutoryOut: 0, over60: null, holiday: 0, night: 0, total: 0 },
    ])
  })

  it('★ 締め日が日 (20 日締め) なら、21 日〜翌 20 日が 1 月度', () => {
    const months = computeYKingaku(input, period, { ...SETTINGS, closingDay: 20 })
    expect(ranges(months)).toEqual(['2029-12-21〜2030-01-20', '2030-01-21〜2030-02-20', '2030-02-21〜2030-03-20'])
    expect(months.map((m) => m.total)).toEqual([0, 1140, 0])
    expect(months[1]).toMatchObject({ statutoryIn: 120, statutoryOut: 180 })
  })

  it('期間の初日が締め日より後なら、最初の月度の締めは翌月', () => {
    const months = computeYKingaku(input, { from: '2030-01-25', to: '2030-02-10' }, { ...SETTINGS, closingDay: 20 })
    expect(ranges(months)).toEqual(['2030-01-21〜2030-02-20'])
  })

  it('式どおり: 31 日締めは短い月で月末に寄り、以後はその日のまま (EDATE の連鎖)', () => {
    const months = computeYKingaku(input, { from: '2030-01-06', to: '2030-04-10' }, { ...SETTINGS, closingDay: 31 })
    expect(ranges(months)).toEqual([
      '2030-01-01〜2030-01-31', '2030-02-01〜2030-02-28', '2030-03-01〜2030-03-28', '2030-03-29〜2030-04-28',
    ])
  })

  it('休日労働・深夜労働も月度ごとに足す', () => {
    const months = computeYKingaku(
      [work('2030-01-13', 540, 1020, { L: 60 }), work('2030-01-15', 1200, 180)],
      { from: '2030-01-06', to: '2030-01-31' },
      SETTINGS,
    )
    expect(months).toEqual([
      { from: '2030-01-01', to: '2030-01-31', statutoryIn: 0, statutoryOut: 0, over60: null, holiday: 420, night: 300, total: 840 },
    ])
  })

  it('★ 月 60h 超は、適用するときだけ 法外残業 − 60h (下限 0)。適用しないときは null (不適用)', () => {
    // 6:00〜22:00・休憩 60 分 = 実労働 15h → 日 8h 超が 7h。月〜金 × 2 週 = 70h
    const long = ['2030-01-07', '2030-01-08', '2030-01-09', '2030-01-10', '2030-01-11',
      '2030-01-14', '2030-01-15', '2030-01-16', '2030-01-17', '2030-01-18'].map((d) => work(d, 360, 1320, { L: 60 }))
    const jan = { from: '2030-01-06', to: '2030-01-31' }
    const applied = { ...SETTINGS, over60Applies: true }
    expect(computeYKingaku(long, jan, applied)[0]).toMatchObject({ statutoryOut: 4200, over60: 600 })
    expect(computeYKingaku(long.slice(0, 5), jan, applied)[0]).toMatchObject({ statutoryOut: 2100, over60: 0 })
    expect(computeYKingaku(long, jan, SETTINGS)[0]).toMatchObject({ statutoryOut: 4200, over60: null })
  })

  it('★ 入力が 1 日も無い冊は 0 行 (0:00 の並んだ表を作らない)', () => {
    expect(computeYKingaku([], period, SETTINGS)).toEqual([])
  })
})

describe('sumYKingakuMonths — 冊の合計行', () => {
  const month = (over60: number | null): YKingakuMonth => ({
    from: '2030-01-01', to: '2030-01-31', statutoryIn: 10, statutoryOut: 20, over60, holiday: 30, night: 40, total: 100,
  })

  it('列ごとに足す', () => {
    expect(sumYKingakuMonths([month(5), month(7)])).toEqual({
      statutoryIn: 20, statutoryOut: 40, over60: 12, holiday: 60, night: 80, total: 200,
    })
  })

  it('月 60h 超が不適用なら合計も null', () => {
    expect(sumYKingakuMonths([month(null), month(null)]).over60).toBeNull()
    expect(sumYKingakuMonths([month(null), month(3)]).over60).toBeNull()
  })
})

describe('encodeYKingakuHeader / decodeYKingakuHeader — 応答ヘッダの形', () => {
  const months: YKingakuMonth[] = [
    { from: '2030-01-01', to: '2030-01-31', statutoryIn: 60, statutoryOut: 180, over60: null, holiday: 0, night: 300, total: 7245 },
    { from: '2030-02-01', to: '2030-02-28', statutoryIn: -30, statutoryOut: 3700, over60: 100, holiday: 420, night: 0, total: 9000 },
  ]

  it('★ 往復で元に戻り、値は ASCII だけ (ヘッダにそのまま載る)', () => {
    const raw = encodeYKingakuHeader(months)
    expect(raw).toMatch(/^[\x21-\x7e]+$/)
    expect(decodeYKingakuHeader(raw)).toEqual(months)
    expect(decodeYKingakuHeader(encodeYKingakuHeader([]))).toEqual([])
  })

  it('★ 形が違う値は null (壊れた値を 0 として読まない)', () => {
    const enc = (v: unknown) => encodeURIComponent(JSON.stringify(v))
    const row = ['2030-01-01', '2030-01-31', 1, 2, null, 3, 4, 5]
    expect(decodeYKingakuHeader(enc([row]))).not.toBeNull()
    for (const raw of [
      '%',
      'not json',
      enc({ m: [] }),
      enc(['x']),
      enc([row.slice(0, 7)]),
      enc([[20300101, ...row.slice(1)]]),
      enc([['2030-1-1', ...row.slice(1)]]),
      enc([[row[0], 20300131, ...row.slice(2)]]),
      enc([[row[0], '1/31', ...row.slice(2)]]),
      enc([[...row.slice(0, 2), '1', ...row.slice(3)]]),
      enc([[...row.slice(0, 4), 'x', ...row.slice(5)]]),
      enc([[...row.slice(0, 7), null]]),
    ]) {
      expect(decodeYKingakuHeader(raw), raw).toBeNull()
    }
  })
})

describe('parseYKingakuSettings — 要素 シートの設定をセルの型で読む', () => {
  const str = (value: string): SheetCellValue => ({ kind: 'string', value })
  const num = (value: number): SheetCellValue => ({ kind: 'number', value })
  const bool = (value: boolean): SheetCellValue => ({ kind: 'boolean', value })
  const base = (): Record<string, SheetCellValue> => ({
    F5: str('日'), F7: num(40), F9: str('月'),
    E11: str('日'), F11: num(0),
    E12: str('月'), F12: num(0.25),
    E13: str('火'), F13: num(0.25),
    E14: str('水'), F14: num(0.25),
    E15: str('木'), F15: num(0.25),
    E16: str('金'), F16: num(0.25),
    E17: str('土'), F17: num(0.125),
    G19: str('末'), U27: bool(false),
  })
  const reasonOf = (over: Record<string, SheetCellValue>) => {
    const r = parseYKingakuSettings({ ...base(), ...over })
    return r.ok ? null : r.reason
  }

  it('読むセルの一覧は設定の全部 (曜日ごとの所定 7 行ぶんを含む)', () => {
    expect([...Y_KINGAKU_SETTING_REFS].sort()).toEqual(Object.keys(base()).sort())
  })

  it('★ 曜日は文字、所定は日の小数 → 分、週の制限は時間 → 分、月 60h は真偽で読む', () => {
    expect(parseYKingakuSettings(base())).toEqual({
      ok: true,
      settings: {
        legalHolidayWeekday: 0,
        weeklyLimitMinutes: 2400,
        weekStartWeekday: 1,
        scheduledMinutes: [0, 360, 360, 360, 360, 360, 180],
        closingDay: 'end',
        over60Applies: false,
      },
    })
    const other = parseYKingakuSettings({ ...base(), G19: num(20), U27: bool(true), F7: num(37.5) })
    expect(other).toMatchObject({ ok: true, settings: { closingDay: 20, over60Applies: true, weeklyLimitMinutes: 2250 } })
  })

  it('所定の表は並びでなく曜日の文字で引く', () => {
    const r = parseYKingakuSettings({ ...base(), E11: str('土'), E17: str('日') })
    expect(r).toMatchObject({ ok: true, settings: { scheduledMinutes: [180, 360, 360, 360, 360, 360, 0] } })
  })

  it('シートが無ければ理由を返す', () => {
    expect(parseYKingakuSettings(null)).toEqual({ ok: false, reason: 'テンプレに「要素」シートが無い' })
  })

  it('★ 読めない・想定外の値は既定値で埋めず、どのセルかを言う', () => {
    expect(reasonOf({ F5: str('祝') })).toBe('要素!F5 (法定休日の曜日) が 日〜土 の 1 文字でない')
    expect(reasonOf({ F5: num(1) })).toBe('要素!F5 (法定休日の曜日) が 日〜土 の 1 文字でない')
    expect(reasonOf({ F7: str('40') })).toBe('要素!F7 (週労働時間の制限時間数) が正の数値でない')
    expect(reasonOf({ F7: num(0) })).toBe('要素!F7 (週労働時間の制限時間数) が正の数値でない')
    expect(reasonOf({ F9: { kind: 'empty' } })).toBe('要素!F9 (週の起算曜日) が 日〜土 の 1 文字でない')
    expect(reasonOf({ E13: str('火曜') })).toBe('要素!E13 (所定労働時間の曜日) が 日〜土 の 1 文字でない')
    expect(reasonOf({ E13: str('月') })).toBe('要素!E11:E17 に「月」が 2 回ある (所定労働時間を引けない曜日がある)')
    expect(reasonOf({ F14: str('7:00') })).toBe('要素!F14 (水曜の所定労働時間) が 0 以上の数値でない')
    expect(reasonOf({ F14: num(-0.1) })).toBe('要素!F14 (水曜の所定労働時間) が 0 以上の数値でない')
    expect(reasonOf({ G19: str('月末') })).toBe('要素!G19 (締め日) が「末」でも 1〜31 の日でもない')
    expect(reasonOf({ G19: num(0) })).toBe('要素!G19 (締め日) が「末」でも 1〜31 の日でもない')
    expect(reasonOf({ G19: num(32) })).toBe('要素!G19 (締め日) が「末」でも 1〜31 の日でもない')
    expect(reasonOf({ G19: num(15.5) })).toBe('要素!G19 (締め日) が「末」でも 1〜31 の日でもない')
    expect(reasonOf({ G19: { kind: 'error' } })).toBe('要素!G19 (締め日) が「末」でも 1〜31 の日でもない')
  })

  it('★ 月 60h の適用は真偽セルだけを読む (数値の 0 を FALSE と読まない)', () => {
    expect(reasonOf({ U27: num(0) })).toBe('要素!U27 (月60時間規制の適用) が TRUE / FALSE でない')
    expect(reasonOf({ U27: { kind: 'empty' } })).toBe('要素!U27 (月60時間規制の適用) が TRUE / FALSE でない')
  })

  it('セルが 1 つも無い (キーが無い) ときも落ちずに理由を返す', () => {
    expect(parseYKingakuSettings({})).toMatchObject({ ok: false })
    for (const ref of Object.keys(base())) {
      const cells = base()
      delete cells[ref]
      expect(parseYKingakuSettings(cells), ref).toMatchObject({ ok: false })
    }
  })
})
