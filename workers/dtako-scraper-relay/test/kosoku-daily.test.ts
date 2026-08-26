import { describe, expect, it } from 'vitest'
import {
  crossMonthMinutesByDate,
  kosokuPartsByDate,
  mergeKosokuShiftMaps,
  parseKosokuDaily,
  parseFerryMinusByDriver,
  parseGapMidnightByDriver,
  parseMinusUnkoByDriver,
  parseOursOutsideByDriver,
  parsePaperDriftByDriver,
  parsePaperOutsideByDriver,
  prevYmOf,
  kosokuShiftsState,
} from '../src/kosoku-daily'

/** 上流 (`/api/kintai/kosoku-daily`) の 1 勤務。実応答のキー名そのまま。 */
const shift = (over: Record<string, unknown> = {}) => ({
  date: '2026-04-06',
  restraint_minutes: 699,
  working_minutes: 486,
  // 上流の時間外は**時間外深夜を含む全部** (Refs #564)。16 のうち 10 が深夜
  overtime_minutes: 16,
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
    const got = parseKosokuDaily({ drivers: [{ driver: 1104, days: [shift()] }] }).map
    expect([...got.keys()]).toEqual(['1104'])
    expect(got.get('1104')).toEqual([{
      date: '2026-04-06',
      restraintMinutes: 699,
      workingMinutes: 486,
      // 16 − 10 = 内数の時間外深夜を引いて排他にする (Refs #564)
      overtimeMinutes: 6,
      // 30 (平日の深夜) + 5 (法定休日の深夜) — 画面と賃金は「深夜帯で何分か」しか持たない
      nightMinutes: 35,
      overtimeNightMinutes: 10,
      ferryMinusMinutes: 0,
      runGapMinutes: 0,
      punchTailMinutes: 0,
      punchHeadMinutes: 0,
      runHeadMinutes: 0,
      lunchOverlapMinutes: 0,
      parts: [],
    }])
  })

  it('乗務員CD は String(Number()) で正規化する (打刻側と同じ規則)', () => {
    const got = parseKosokuDaily({ drivers: [{ driver: '0205', days: [shift()] }] }).map
    expect([...got.keys()]).toEqual(['205'])
  })

  it('欠けた数値は 0 で埋める (項目が増減しても落ちない)', () => {
    const got = parseKosokuDaily({ drivers: [{ driver: 1, days: [{ date: '2026-04-01' }] }] }).map
    expect(got.get('1')).toEqual([{
      date: '2026-04-01',
      restraintMinutes: 0,
      workingMinutes: 0,
      overtimeMinutes: 0,
      nightMinutes: 0,
      overtimeNightMinutes: 0,
      ferryMinusMinutes: 0,
      runGapMinutes: 0,
      punchTailMinutes: 0,
      punchHeadMinutes: 0,
      runHeadMinutes: 0,
      lunchOverlapMinutes: 0,
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
    }).map
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
    }).map
    expect([...got.keys()]).toEqual(['2'])
    expect(got.get('2')).toHaveLength(1)
  })

  it('内訳の中の不正な要素も捨てる', () => {
    const got = parseKosokuDaily({
      drivers: [{ driver: 1, days: [shift({ parts: [null, 'x', { date: 'bad' }, { date: '2026-04-06' }] })] }],
    }).map
    expect(got.get('1')![0]!.parts.map(p => p.date)).toEqual(['2026-04-06'])
  })

  it('応答の形が違えば空 (取り込みを落とさない)', () => {
    expect(parseKosokuDaily(null).map.size).toBe(0)
    expect(parseKosokuDaily('x').map.size).toBe(0)
    expect(parseKosokuDaily({}).map.size).toBe(0)
    expect(parseKosokuDaily({ drivers: 'x' }).map.size).toBe(0)
    expect(parseKosokuDaily({ drivers: [null, 'x'] }).map.size).toBe(0)
    expect(parseKosokuDaily({ drivers: [{ driver: 1, days: 'x' }] }).map.size).toBe(0)
  })

  // 上流は `driver` を指定すると `drivers` を持たず、その 1 名を month と並べて
  // トップレベルへ展開して返す (Refs #602 / #599)。**この repo の呼び出し元は
  // まだ `driver` を付けていない**ので予防的な固定 — 増えた瞬間に静かに 0 行に
  // なるのを防ぐ
  it('driver 指定の形 (drivers が無く 1 名がトップレベル) も読む (Refs #602)', () => {
    const got = parseKosokuDaily({
      month: '2026-04',
      driver: 1104,
      days: [shift()],
      duplicate_rows: 0,
    }).map
    expect([...got.keys()]).toEqual(['1104'])
    expect(got.get('1104')).toHaveLength(1)
    // 全乗務員形と同じ値になる (読む場所が変わるだけ)
    expect(got.get('1104')).toEqual(
      parseKosokuDaily({ drivers: [{ driver: 1104, days: [shift()] }] }).map.get('1104'),
    )
  })

  it('drivers 配列があればそちらが正 (トップレベルは見ない)', () => {
    const got = parseKosokuDaily({
      driver: 9999,
      days: [shift()],
      drivers: [{ driver: 1104, days: [shift()] }],
    }).map
    expect([...got.keys()]).toEqual(['1104'])
  })

  // ── unreadable (Refs #960) ──────────────────────────────────────────────
  // 空 Map をそのまま返すと「上流にその行が無い」と「応答の形を読み間違えた」が
  // 呼び出し側から区別できない。前者は取り込み直しで直り、後者は直らない。

  it('陰性対照: 正常な全乗務員形は unreadable が false (map の中身も従来どおり)', () => {
    const res = parseKosokuDaily({ drivers: [{ driver: 1104, days: [shift()] }] })
    expect(res.unreadable).toBe(false)
    expect([...res.map.keys()]).toEqual(['1104'])
    expect(res.map.get('1104')).toHaveLength(1)
  })

  it('陰性対照: 単一乗務員形も unreadable は false', () => {
    const res = parseKosokuDaily({ month: '2026-04', driver: 1104, days: [shift()] })
    expect(res.unreadable).toBe(false)
    expect([...res.map.keys()]).toEqual(['1104'])
  })

  it('陰性対照: 乗務員が 0 名の応答は「読めた上で 0 名」なので unreadable は false', () => {
    expect(parseKosokuDaily({ month: '2026-04', drivers: [] }).unreadable).toBe(false)
    expect(parseKosokuDaily({ month: '2026-04', driver: 1104, days: [] }).unreadable).toBe(false)
  })

  it('★ どちらの形でもなければ unreadable を立てる (map は空のまま)', () => {
    for (const body of [null, undefined, 'x', 42, {}, { month: '2026-04' }, { drivers: 'x' }, [], { days: 'x' }]) {
      const res = parseKosokuDaily(body)
      expect({ body, unreadable: res.unreadable, size: res.map.size })
        .toEqual({ body, unreadable: true, size: 0 })
    }
  })

  it('★ 読めた形なら、中身が全部捨てられて空 Map になっても unreadable は立てない', () => {
    // 「行が無い」と「読めなかった」を混ぜない — 前者は取り込み直しで直る
    const res = parseKosokuDaily({ drivers: [{ driver: 0, days: [shift()] }] })
    expect(res.map.size).toBe(0)
    expect(res.unreadable).toBe(false)
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
  }).map.get('1')!

  it('対象月の暦日ごとに合計する', () => {
    const got = kosokuPartsByDate(shifts, '2026-04')
    expect([...got.keys()].sort()).toEqual(['2026-04-01', '2026-04-06'])
    // 前月に始業した勤務の当月ぶんだけが乗る
    expect(got.get('2026-04-01')).toEqual({
      restraintMinutes: 300,
      workingMinutes: 250,
      // 上流 20 − 内数の時間外深夜 5 (Refs #564)
      overtimeMinutes: 15,
      nightMinutes: 40,
      overtimeNightMinutes: 5,
      ferryMinusMinutes: 0,
      runGapMinutes: 0,
      punchTailMinutes: 0,
      punchHeadMinutes: 0,
      runHeadMinutes: 0,
      lunchOverlapMinutes: 0,
    })
    // 同じ日の 2 勤務が 1 つにまとまる
    expect(got.get('2026-04-06')).toEqual({
      restraintMinutes: 799,
      workingMinutes: 566,
      overtimeMinutes: 6,
      nightMinutes: 35,
      overtimeNightMinutes: 10,
      ferryMinusMinutes: 0,
      runGapMinutes: 0,
      punchTailMinutes: 0,
      punchHeadMinutes: 0,
      runHeadMinutes: 0,
      lunchOverlapMinutes: 0,
    })
  })

  it('対象月に何も落ちなければ空', () => {
    expect(kosokuPartsByDate(shifts, '2026-12').size).toBe(0)
  })
})

describe('crossMonthMinutesByDate', () => {
  // 1196 副島 (純夜勤 23:47→翌 08:03) の形
  const shifts = parseKosokuDaily({
    drivers: [{
      driver: 1196,
      days: [
        // 前月から跨いで当月 1 日に朝側が落ちる勤務
        shift({
          date: '2026-02-28',
          parts: [
            { date: '2026-02-28', restraint_minutes: 13, working_minutes: 13, overtime_minutes: 0, night_minutes: 13, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
            { date: '2026-03-01', restraint_minutes: 481, working_minutes: 421, overtime_minutes: 0, night_minutes: 300, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
          ],
        }),
        // もう 1 本、同じ 03-01 に落ちる跨ぎ勤務 — 合算される
        shift({
          date: '2026-02-27',
          parts: [
            { date: '2026-02-27', restraint_minutes: 60, working_minutes: 60, overtime_minutes: 0, night_minutes: 0, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
            { date: '2026-03-01', restraint_minutes: 7, working_minutes: 7, overtime_minutes: 0, night_minutes: 0, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
          ],
        }),
        // 月内で完結する日跨ぎ勤務 — 跨ぎではないので数えない
        shift({
          date: '2026-03-01',
          parts: [
            { date: '2026-03-01', restraint_minutes: 12, working_minutes: 12, overtime_minutes: 0, night_minutes: 12, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
            { date: '2026-03-02', restraint_minutes: 488, working_minutes: 428, overtime_minutes: 0, night_minutes: 300, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
          ],
        }),
        // 1 日で終わる勤務 (内訳なし) — 跨ぎようがない
        shift({ date: '2026-03-10' }),
        // 当月末に始業して翌月へ跨ぐ勤務 — 当月に落ちる頭だけ数える
        shift({
          date: '2026-03-31',
          parts: [
            { date: '2026-03-31', restraint_minutes: 15, working_minutes: 15, overtime_minutes: 0, night_minutes: 15, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
            { date: '2026-04-01', restraint_minutes: 484, working_minutes: 424, overtime_minutes: 0, night_minutes: 300, overtime_night_minutes: 0, legal_holiday_night_minutes: 0 },
          ],
        }),
      ],
    }],
  }).map.get('1196')!

  it('月境界を跨ぐ勤務の当月分だけを暦日ごとに数える (同じ暦日は合算)', () => {
    const got = crossMonthMinutesByDate(shifts, '2026-03')
    expect([...got.entries()].sort()).toEqual([
      ['2026-03-01', 488], // 481 + 7 (2 本の跨ぎ勤務が同じ暦日に落ちる)
      ['2026-03-31', 15],
    ])
  })

  it('前月側から見れば翌月へ跨ぐ頭が数えられる', () => {
    const got = crossMonthMinutesByDate(shifts, '2026-02')
    expect([...got.entries()].sort()).toEqual([
      ['2026-02-27', 60],
      ['2026-02-28', 13],
    ])
  })

  it('run_gap_minutes を運ぶ・暦日で合算する (rust#170 の継ぎ目)', () => {
    const m = parseKosokuDaily({
      drivers: [{
        driver: 9,
        days: [
          shift({ date: '2026-04-06', run_gap_minutes: 23 }),
          shift({ date: '2026-04-06', run_gap_minutes: 5 }),
        ],
      }],
    }).map.get('9')!
    expect(m[0]!.runGapMinutes).toBe(23)
    expect(kosokuPartsByDate(m, '2026-04').get('2026-04-06')!.runGapMinutes).toBe(28)
  })

  it('punch_tail_minutes を運ぶ (rust#172 の日跨ぎ終業の尻尾)', () => {
    const m = parseKosokuDaily({
      drivers: [{ driver: 8, days: [shift({ date: '2026-04-06', punch_tail_minutes: 151 })] }],
    }).map.get('8')!
    expect(m[0]!.punchTailMinutes).toBe(151)
    expect(kosokuPartsByDate(m, '2026-04').get('2026-04-06')!.punchTailMinutes).toBe(151)
  })

  it('punch_head_minutes を運ぶ (rust#173 の日跨ぎ始業の頭)', () => {
    const m = parseKosokuDaily({
      drivers: [{ driver: 7, days: [shift({ date: '2026-04-06', punch_head_minutes: 979 })] }],
    }).map.get('7')!
    expect(m[0]!.punchHeadMinutes).toBe(979)
    expect(kosokuPartsByDate(m, '2026-04').get('2026-04-06')!.punchHeadMinutes).toBe(979)
  })

  it('run_head_minutes を運ぶ (rust#174 の始業前の運行の頭)', () => {
    const m = parseKosokuDaily({
      drivers: [{ driver: 6, days: [shift({ date: '2026-04-06', run_head_minutes: 8 })] }],
    }).map.get('6')!
    expect(m[0]!.runHeadMinutes).toBe(8)
    expect(kosokuPartsByDate(m, '2026-04').get('2026-04-06')!.runHeadMinutes).toBe(8)
  })

  it('跨ぐ勤務が無ければ空', () => {
    expect(crossMonthMinutesByDate(shifts, '2026-05').size).toBe(0)
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
      ferryMinusMinutes: 0,
      runGapMinutes: 0,
      punchTailMinutes: 0,
      punchHeadMinutes: 0,
      runHeadMinutes: 0,
      lunchOverlapMinutes: 0,
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

describe('parsePaperDriftByDriver', () => {
  it('乗務員CD 引きに直す (Refs ohishi-exp/rust-ichibanboshi#179)', () => {
    const got = parsePaperDriftByDriver({
      drivers: [
        { driver: 1194, days: [], paper_drift_by_date: { '2026-03-11': 3, '2026-03-02': 61 } },
        { driver: 1729, days: [], paper_drift_by_date: { '2026-03-26': -8 } },
      ],
    }).map
    expect(got.get('1194')?.get('2026-03-11')).toBe(3)
    expect(got.get('1194')?.get('2026-03-02')).toBe(61)
    expect(got.get('1729')?.get('2026-03-26')).toBe(-8)
  })

  it('壊れた形は黙って空 — body が object でない / drivers が配列でない', () => {
    expect(parsePaperDriftByDriver(null).map.size).toBe(0)
    expect(parsePaperDriftByDriver('x').map.size).toBe(0)
    expect(parsePaperDriftByDriver({ drivers: 'x' }).map.size).toBe(0)
  })

  it('解釈できない行・値は捨てる', () => {
    const got = parsePaperDriftByDriver({
      drivers: [
        null,
        { driver: 0, paper_drift_by_date: { '2026-03-01': 1 } }, // CD 0
        { driver: 1021 }, // drift 無し
        { driver: 1030, paper_drift_by_date: [1] }, // 配列は形違い
        {
          driver: 1041,
          paper_drift_by_date: { 'not-a-date': 1, '2026-03-05': 'x', '2026-03-06': 2 },
        },
        { driver: 1051, paper_drift_by_date: { 'not-a-date': 1 } }, // 有効な日が残らない
      ],
    }).map
    expect([...got.keys()]).toEqual(['1041'])
    expect(got.get('1041')?.size).toBe(1)
    expect(got.get('1041')?.get('2026-03-06')).toBe(2)
  })
})

describe('parsePaperOutsideByDriver', () => {
  it('乗務員CD 引きに直す (Refs #546 / ohishi-exp/rust-ichibanboshi#182)', () => {
    const got = parsePaperOutsideByDriver({
      drivers: [{ driver: 1069, days: [], paper_outside_by_date: { '2026-01-05': 403 } }],
    }).map
    expect(got.get('1069')?.get('2026-01-05')).toBe(403)
  })

  it('マップが無い乗務員は載らない', () => {
    expect(parsePaperOutsideByDriver({ drivers: [{ driver: 1069 }] }).map.size).toBe(0)
  })
})

describe('parseOursOutsideByDriver', () => {
  it('乗務員CD 引きに直す (Refs #546 / ohishi-exp/rust-ichibanboshi#182)', () => {
    const got = parseOursOutsideByDriver({
      drivers: [{ driver: 1442, days: [], ours_outside_by_date: { '2026-05-27': 753 } }],
    }).map
    expect(got.get('1442')?.get('2026-05-27')).toBe(753)
  })

  it('マップが無い乗務員は載らない', () => {
    expect(parseOursOutsideByDriver({ drivers: [{ driver: 1442 }] }).map.size).toBe(0)
  })
})

describe('parseMinusUnkoByDriver', () => {
  it('乗務員CD 引きに直す (Refs #546 / ohishi-exp/rust-ichibanboshi#182)', () => {
    const got = parseMinusUnkoByDriver({
      drivers: [{ driver: 1729, days: [], minus_unko_by_date: { '2026-01-09': 9 } }],
    }).map
    expect(got.get('1729')?.get('2026-01-09')).toBe(9)
  })

  it('マップが無い乗務員は載らない', () => {
    expect(parseMinusUnkoByDriver({ drivers: [{ driver: 1729 }] }).map.size).toBe(0)
  })
})

describe('parseGapMidnightByDriver', () => {
  it('乗務員CD 引きに直す (Refs #546 / ohishi-exp/rust-ichibanboshi#182)', () => {
    const got = parseGapMidnightByDriver({
      drivers: [{
        driver: 1536,
        days: [],
        gap_midnight_by_date: { '2026-06-10': -8, '2026-06-11': 8 },
      }],
    }).map
    expect(got.get('1536')?.get('2026-06-10')).toBe(-8)
    expect(got.get('1536')?.get('2026-06-11')).toBe(8)
  })

  it('マップが無い乗務員は載らない', () => {
    expect(parseGapMidnightByDriver({ drivers: [{ driver: 1536 }] }).map.size).toBe(0)
  })
})

describe('parseFerryMinusByDriver', () => {
  it('乗務員CD 引きに直す (Refs ohishi-exp/rust-ichibanboshi#181)', () => {
    const got = parseFerryMinusByDriver({
      drivers: [{ driver: 1026, days: [], ferry_minus_by_date: { '2026-05-01': 76 } }],
    }).map
    expect(got.get('1026')?.get('2026-05-01')).toBe(76)
  })

  it('マップが無い乗務員は載らない', () => {
    expect(parseFerryMinusByDriver({ drivers: [{ driver: 1026 }] }).map.size).toBe(0)
  })
})

// 日別マップ 6 本は `parseDateMapByDriver` の薄い包みなので、形状の吸収は
// 代表 2 本で固定する (Refs #602)
describe('日別マップも driver 指定の形を読む (Refs #602)', () => {
  it('drivers が無くトップレベルに展開された 1 名を読む', () => {
    const drift = parsePaperDriftByDriver({
      month: '2026-03',
      driver: 1194,
      days: [],
      paper_drift_by_date: { '2026-03-11': 3 },
      duplicate_rows: 0,
    }).map
    expect(drift.get('1194')?.get('2026-03-11')).toBe(3)

    const ferry = parseFerryMinusByDriver({
      month: '2026-05',
      driver: 1026,
      days: [],
      ferry_minus_by_date: { '2026-05-01': 76 },
    }).map
    expect(ferry.get('1026')?.get('2026-05-01')).toBe(76)
  })

  it('マップが無ければ載らない (単一乗務員形でも同じ)', () => {
    expect(parsePaperDriftByDriver({ month: '2026-03', driver: 1194, days: [] }).map.size).toBe(0)
  })

  // ── unreadable (Refs #960) ──────────────────────────────────────────────
  // cause 別の実額は「その日に値が無い = 0」として読むので、形を読み違えた空 Map を
  // そのまま渡すと突合の差が全部「未説明」に化ける。0 と読めない理由を運ぶ。

  it('陰性対照: 読めた形なら unreadable は false (値が 1 つも無くても)', () => {
    const withValues = parsePaperDriftByDriver({
      drivers: [{ driver: 1194, paper_drift_by_date: { '2026-03-02': -3 } }],
    })
    expect(withValues.unreadable).toBe(false)
    expect(withValues.map.get('1194')?.get('2026-03-02')).toBe(-3)
    // マップが 1 つも載らなくても「読めた上で 0 件」なので false のまま
    expect(parsePaperDriftByDriver({ drivers: [{ driver: 1194 }] }).unreadable).toBe(false)
    expect(parsePaperDriftByDriver({ month: '2026-03', driver: 1194, days: [] }).unreadable).toBe(false)
  })

  it('★ どちらの形でもなければ 6 本とも unreadable を立てる (map は空のまま)', () => {
    const parsers = [
      parsePaperDriftByDriver,
      parseFerryMinusByDriver,
      parsePaperOutsideByDriver,
      parseOursOutsideByDriver,
      parseMinusUnkoByDriver,
      parseGapMidnightByDriver,
    ]
    for (const parse of parsers) {
      for (const body of [null, 'x', {}, { drivers: 'x' }]) {
        const res = parse(body)
        expect({ name: parse.name, unreadable: res.unreadable, size: res.map.size })
          .toEqual({ name: parse.name, unreadable: true, size: 0 })
      }
    }
  })
})

describe('時間外深夜の内数を読み取りで排他へ直す (Refs #564)', () => {
  /** `classifyMonth` が前提にしている契約。 */
  const holdsExclusive = (p: { workingMinutes: number; overtimeMinutes: number; overtimeNightMinutes: number }) =>
    p.workingMinutes - p.overtimeMinutes - p.overtimeNightMinutes >= 0;

  it('上流の時間外から内数の時間外深夜を引く', () => {
    const [got] = parseKosokuDaily({
      drivers: [{ driver: 1, days: [shift({ working_minutes: 946, overtime_minutes: 466, overtime_night_minutes: 120 })] }],
    }).map.get('1')!;
    // 466 は深夜 120 を含む全部なので、引いて 346 / 120 の排他にする
    expect(got!.overtimeMinutes).toBe(346);
    expect(got!.overtimeNightMinutes).toBe(120);
    // 法定内 = 実働 − 時間外 − 時間外深夜 = 480 (所定 8h) で辻褄が合う
    expect(got!.workingMinutes - got!.overtimeMinutes - got!.overtimeNightMinutes).toBe(480);
  });

  it('実働が丸ごと時間外の日 (日跨ぎ勤務の続き) でも契約が崩れない', () => {
    // 2026-06 の本番で出た形。引かないと 時間外 + 時間外深夜 > 実働 になり、
    // classifyMonth の法定内が max(0, …) に張り付いて最低賃金チェックの差分列に負で出る
    const [got] = parseKosokuDaily({
      drivers: [{ driver: 1, days: [shift({ working_minutes: 1072, overtime_minutes: 1072, overtime_night_minutes: 300 })] }],
    }).map.get('1')!;
    expect(got!.overtimeMinutes).toBe(772);
    expect(holdsExclusive(got!)).toBe(true);
    expect(got!.workingMinutes - got!.overtimeMinutes - got!.overtimeNightMinutes).toBe(0);
  });

  it('暦日按分 (parts) も同じ規則。合計しても契約が崩れない', () => {
    const shifts = parseKosokuDaily({
      drivers: [{
        driver: 1,
        days: [shift({
          date: '2026-04-06',
          working_minutes: 1500,
          overtime_minutes: 1020,
          overtime_night_minutes: 420,
          parts: [
            { date: '2026-04-06', restraint_minutes: 800, working_minutes: 700, overtime_minutes: 220, night_minutes: 0, overtime_night_minutes: 120, legal_holiday_night_minutes: 0 },
            { date: '2026-04-07', restraint_minutes: 900, working_minutes: 800, overtime_minutes: 800, night_minutes: 0, overtime_night_minutes: 300, legal_holiday_night_minutes: 0 },
          ],
        })],
      }],
    }).map.get('1')!;
    const byDate = kosokuPartsByDate(shifts, '2026-04');
    expect(byDate.get('2026-04-06')!.overtimeMinutes).toBe(100);
    expect(byDate.get('2026-04-07')!.overtimeMinutes).toBe(500);
    for (const p of byDate.values()) expect(holdsExclusive(p)).toBe(true);
  });

  it('上流が壊れた値 (内数 > 全体) を返しても負にしない', () => {
    const [got] = parseKosokuDaily({
      drivers: [{ driver: 1, days: [shift({ overtime_minutes: 10, overtime_night_minutes: 30 })] }],
    }).map.get('1')!;
    expect(got!.overtimeMinutes).toBe(0);
  });
});

describe('kosokuShiftsState — wage-report の応答に載る「当月の拘束を組めたか」 (Refs #980)', () => {
  const shifts = () => new Map([['1', []]]);

  it('取りに行っていない (null) は「取れなかった」ではない — source=gcp の経路', () => {
    // ★ ここを false 側に倒すと、時間が GCP `day_summaries` に丸ごと差し替わった
    // 表に「取れなかったので打刻由来です」という嘘が出る
    expect(kosokuShiftsState(null)).toBeNull();
  });

  it('取れなかった (shifts が null) は "no"', () => {
    expect(kosokuShiftsState({ shifts: null, unreadable: false })).toBe('no');
  });

  it('形が読めなかったら "unreadable" — 「取れなかった」と同じ見た目にしない', () => {
    // 空 Map なので shifts は非 null。真偽 2 値に畳むと "yes" 側へ落ちる
    expect(kosokuShiftsState({ shifts: new Map(), unreadable: true })).toBe('unreadable');
  });

  it('取れたら "yes"', () => {
    expect(kosokuShiftsState({ shifts: shifts(), unreadable: false })).toBe('yes');
  });
});
