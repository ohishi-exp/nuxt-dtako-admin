import { describe, expect, it } from 'vitest'
import { kosokuPartsByDate, mergeKosokuShiftMaps, parseKosokuDaily, prevYmOf } from '../src/kosoku-daily'

/** 上流 (`/api/kintai/kosoku-daily`) の 1 勤務。実応答のキー名そのまま。 */
const shift = (over: Record<string, unknown> = {}) => ({
  date: '2026-04-06',
  restraint_minutes: 699,
  working_minutes: 486,
  overtime_minutes: 6,
  night_minutes: 30,
  overtime_night_minutes: 10,
  legal_holiday_night_minutes: 5,
  ...over,
})

describe('prevYmOf', () => {
  it('前月を返す', () => {
    expect(prevYmOf('2026-04')).toBe('2026-03')
    expect(prevYmOf('2026-10')).toBe('2026-09')
  })

  it('1 月は前年 12 月', () => {
    expect(prevYmOf('2026-01')).toBe('2025-12')
  })
})

describe('parseKosokuDaily', () => {
  it('乗務員CD 引きに直し、深夜は法定休日ぶんも足す', () => {
    const got = parseKosokuDaily({ drivers: [{ driver: 1104, days: [shift()] }] })
    expect([...got.keys()]).toEqual(['1104'])
    expect(got.get('1104')).toEqual([{
      date: '2026-04-06',
      restraintMinutes: 699,
      workingMinutes: 486,
      overtimeMinutes: 6,
      // 30 (平日の深夜) + 5 (法定休日の深夜) — 画面と賃金は「深夜帯で何分か」しか持たない
      nightMinutes: 35,
      overtimeNightMinutes: 10,
      parts: [],
    }])
  })

  it('乗務員CD は String(Number()) で正規化する (打刻側と同じ規則)', () => {
    const got = parseKosokuDaily({ drivers: [{ driver: '0205', days: [shift()] }] })
    expect([...got.keys()]).toEqual(['205'])
  })

  it('欠けた数値は 0 で埋める (項目が増減しても落ちない)', () => {
    const got = parseKosokuDaily({ drivers: [{ driver: 1, days: [{ date: '2026-04-01' }] }] })
    expect(got.get('1')).toEqual([{
      date: '2026-04-01',
      restraintMinutes: 0,
      workingMinutes: 0,
      overtimeMinutes: 0,
      nightMinutes: 0,
      overtimeNightMinutes: 0,
      parts: [],
    }])
  })

  it('暦日按分の内訳 (parts) を取り込む', () => {
    const got = parseKosokuDaily({
      drivers: [{
        driver: 1,
        days: [shift({
          parts: [
            { date: '2026-04-06', restraint_minutes: 400, working_minutes: 300, overtime_minutes: 0, night_minutes: 20, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
            { date: '2026-04-07', restraint_minutes: 299, working_minutes: 186, overtime_minutes: 6, night_minutes: 10, overtime_night_minutes: 10, legal_holiday_night_minutes: 0 },
          ],
        })],
      }],
    })
    expect(got.get('1')![0]!.parts.map(p => [p.date, p.restraintMinutes])).toEqual([
      ['2026-04-06', 400],
      ['2026-04-07', 299],
    ])
  })

  it('置き場の無い行は捨てる (日付なし・不正な日付・乗務員CD 0 / 非数値)', () => {
    const got = parseKosokuDaily({
      drivers: [
        { driver: 0, days: [shift()] },
        { driver: 'x', days: [shift()] },
        { driver: 2, days: [shift({ date: '2026/04/06' }), shift({ date: 7 }), null, 'x', shift()] },
      ],
    })
    expect([...got.keys()]).toEqual(['2'])
    expect(got.get('2')).toHaveLength(1)
  })

  it('内訳の中の不正な要素も捨てる', () => {
    const got = parseKosokuDaily({
      drivers: [{ driver: 1, days: [shift({ parts: [null, 'x', { date: 'bad' }, { date: '2026-04-06' }] })] }],
    })
    expect(got.get('1')![0]!.parts.map(p => p.date)).toEqual(['2026-04-06'])
  })

  it('応答の形が違えば空 (取り込みを落とさない)', () => {
    expect(parseKosokuDaily(null).size).toBe(0)
    expect(parseKosokuDaily('x').size).toBe(0)
    expect(parseKosokuDaily({}).size).toBe(0)
    expect(parseKosokuDaily({ drivers: 'x' }).size).toBe(0)
    expect(parseKosokuDaily({ drivers: [null, 'x'] }).size).toBe(0)
    expect(parseKosokuDaily({ drivers: [{ driver: 1, days: 'x' }] }).size).toBe(0)
  })
})

describe('kosokuPartsByDate', () => {
  const shifts = parseKosokuDaily({
    drivers: [{
      driver: 1,
      days: [
        // 1 日で終わる勤務 (内訳なし) — 丸ごとその日へ
        shift({ date: '2026-04-06' }),
        // 同じ日にもう 1 勤務 — 1 つの日にまとまる
        shift({ date: '2026-04-06', restraint_minutes: 100, working_minutes: 80, overtime_minutes: 0, night_minutes: 0, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 }),
        // 日跨ぎ — 内訳で割る。前月へ落ちる分と翌月へ落ちる分は拾わない
        shift({
          date: '2026-03-31',
          parts: [
            { date: '2026-03-31', restraint_minutes: 200, working_minutes: 150, overtime_minutes: 0, night_minutes: 0, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
            { date: '2026-04-01', restraint_minutes: 300, working_minutes: 250, overtime_minutes: 20, night_minutes: 40, overtime_night_minutes: 5, legal_holiday_night_minutes: 0 },
          ],
        }),
        shift({ date: '2026-05-01' }),
      ],
    }],
  }).get('1')!

  it('対象月の暦日ごとに合計する', () => {
    const got = kosokuPartsByDate(shifts, '2026-04')
    expect([...got.keys()].sort()).toEqual(['2026-04-01', '2026-04-06'])
    // 前月に始業した勤務の当月ぶんだけが乗る
    expect(got.get('2026-04-01')).toEqual({
      restraintMinutes: 300,
      workingMinutes: 250,
      overtimeMinutes: 20,
      nightMinutes: 40,
      overtimeNightMinutes: 5,
    })
    // 同じ日の 2 勤務が 1 つにまとまる
    expect(got.get('2026-04-06')).toEqual({
      restraintMinutes: 799,
      workingMinutes: 566,
      overtimeMinutes: 6,
      nightMinutes: 35,
      overtimeNightMinutes: 10,
    })
  })

  it('対象月に何も落ちなければ空', () => {
    expect(kosokuPartsByDate(shifts, '2026-12').size).toBe(0)
  })
})

describe('mergeKosokuShiftMaps', () => {
  const map = (cd: string, dates: string[]) =>
    new Map([[cd, dates.map(date => ({
      date,
      restraintMinutes: 0,
      workingMinutes: 0,
      overtimeMinutes: 0,
      nightMinutes: 0,
      overtimeNightMinutes: 0,
      parts: [],
    }))]])

  it('乗務員ごとに連結する', () => {
    const got = mergeKosokuShiftMaps(map('1', ['2026-03-31']), map('1', ['2026-04-01']))!
    expect(got.get('1')!.map(s => s.date)).toEqual(['2026-03-31', '2026-04-01'])
  })

  it('片方にしか居ない乗務員も残す', () => {
    const got = mergeKosokuShiftMaps(map('1', ['2026-03-31']), map('2', ['2026-04-01']))!
    expect([...got.keys()].sort()).toEqual(['1', '2'])
  })

  it('取得できなかった月 (null) はもう一方をそのまま返す', () => {
    const a = map('1', ['2026-03-31'])
    expect(mergeKosokuShiftMaps(null, a)).toBe(a)
    expect(mergeKosokuShiftMaps(a, null)).toBe(a)
    expect(mergeKosokuShiftMaps(null, null)).toBeNull()
  })

  it('元の Map を書き換えない', () => {
    const a = map('1', ['2026-03-31'])
    mergeKosokuShiftMaps(a, map('1', ['2026-04-01']))
    expect(a.get('1')).toHaveLength(1)
  })
})
