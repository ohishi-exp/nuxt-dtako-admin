import { describe, expect, it } from 'vitest'
import {
  classifyMonth,
  computeMinWageOvertimePay,
  computeWageAmounts,
  computeWageRow,
  dayOfWeek,
  DEFAULT_WAGE_CONFIG,
  emptyCategoryMinutes,
  minWageForBranch,
  normalizeDateCell,
  normalizeMinWageMaster,
  normalizeSalaryCdMap,
  normalizeSalaryItemConfig,
  normalizeWageConfig,
  normalizeWageMaster,
  rateForMonth,
  splitCsvCells,
  splitMinWageOvertimePay,
  upsertWageMasterFromCsv,
  WAGE_MASTER_CSV_HEADER,
  wageMasterToCsv,
  WageMasterError,
  type MinWageMaster,
  type WageMaster,
} from '../src/restraint-wage'
import type { RestraintDriverSummary, RestraintSummaryDay } from '../src/theearth-restraint-client'

// ---------------------------------------------------------------------------
// fixture helpers
// ---------------------------------------------------------------------------

function day(d: number, over: Partial<RestraintSummaryDay> = {}): RestraintSummaryDay {
  return {
    day: d,
    isRestDay: false,
    restraintMinutes: null,
    workingMinutes: 0,
    overtimeMinutes: 0,
    nightMinutes: 0,
    overtimeNightMinutes: 0,
    ...over,
  }
}

function summary(over: Partial<RestraintDriverSummary> = {}): RestraintDriverSummary {
  return {
    driverCd: '9901',
    driverName: '試験　太郎',
    branchName: 'テスト運輸　第一営業所',
    workDays: 0,
    restDays: 0,
    restraintMinutes: null,
    drivingMinutes: null,
    loadingMinutes: null,
    breakMinutes: null,
    workingMinutes: null,
    overtimeMinutes: null,
    nightMinutes: null,
    overtimeNightMinutes: null,
    maxDailyRestraintMinutes: null,
    fiscalCumulativeMinutes: null,
    restraintLimitMinutes: null,
    excessRestraintMinutes: null,
    over15hDays: 0,
    avgDriving9hOverCount: 0,
    days: [],
    ...over,
  }
}

const MIN_WAGE: MinWageMaster = {
  prefectures: {
    佐賀: [
      { effectiveFrom: '2024-10-01', rate: 956 },
      { effectiveFrom: '2025-10-01', rate: 1030 },
    ],
    北海道: [{ effectiveFrom: '2025-10-01', rate: 1080 }],
  },
  branchToPrefecture: { 'テスト運輸　第一営業所': '佐賀' },
  defaultPrefecture: '佐賀',
}

// ---------------------------------------------------------------------------
// normalize (マスタ検証)
// ---------------------------------------------------------------------------

describe('normalizeWageMaster', () => {
  it('正常系: rates を適用開始日昇順に並べ、name/retiredAt は任意', () => {
    const m = normalizeWageMaster({
      drivers: {
        9901: {
          name: '試験　太郎',
          rates: [
            { effectiveFrom: '2025-10-01', hourlyRate: 1200 },
            { effectiveFrom: '2024-04-01', hourlyRate: 1100 },
          ],
          retiredAt: '2026-03-31',
        },
        9902: { rates: [] },
      },
    })
    expect(m.drivers['9901']!.rates.map(r => r.effectiveFrom)).toEqual(['2024-04-01', '2025-10-01'])
    expect(m.drivers['9901']!.retiredAt).toBe('2026-03-31')
    expect(m.drivers['9902']!.name).toBeUndefined()
  })

  it('構造不正は WageMasterError', () => {
    expect(() => normalizeWageMaster(null)).toThrow(WageMasterError)
    expect(() => normalizeWageMaster([])).toThrow(WageMasterError)
    expect(() => normalizeWageMaster({})).toThrow(/drivers/)
    expect(() => normalizeWageMaster({ drivers: [] })).toThrow(/drivers/)
    expect(() => normalizeWageMaster({ drivers: { 'ab': { rates: [] } } })).toThrow(/乗務員CD/)
    expect(() => normalizeWageMaster({ drivers: { 9901: null } })).toThrow(/オブジェクト/)
    expect(() => normalizeWageMaster({ drivers: { 9901: [] } })).toThrow(/オブジェクト/)
    expect(() => normalizeWageMaster({ drivers: { 9901: { rates: 'x' } } })).toThrow(/配列/)
    expect(() => normalizeWageMaster({ drivers: { 9901: { rates: [{ effectiveFrom: '2025/10/01', hourlyRate: 1 }] } } }))
      .toThrow(/effectiveFrom/)
    expect(() => normalizeWageMaster({ drivers: { 9901: { rates: [{ effectiveFrom: '2025-10-01', hourlyRate: -1 }] } } }))
      .toThrow(/hourlyRate/)
    expect(() => normalizeWageMaster({ drivers: { 9901: { rates: [null] } } })).toThrow(/effectiveFrom/)
  })
})

describe('normalizeMinWageMaster', () => {
  it('正常系: 履歴を昇順に並べる。未指定フィールドは空で埋める', () => {
    const m = normalizeMinWageMaster({
      prefectures: { 佐賀: [{ effectiveFrom: '2025-10-01', rate: 1030 }, { effectiveFrom: '2024-10-01', rate: 956 }] },
      branchToPrefecture: { A営業所: '佐賀' },
      defaultPrefecture: '佐賀',
    })
    expect(m.prefectures['佐賀']!.map(e => e.rate)).toEqual([956, 1030])
    expect(m.defaultPrefecture).toBe('佐賀')
    const empty = normalizeMinWageMaster({})
    expect(empty.prefectures).toEqual({})
    expect(empty.branchToPrefecture).toEqual({})
    expect(empty.defaultPrefecture).toBeUndefined()
  })

  it('構造不正は WageMasterError', () => {
    expect(() => normalizeMinWageMaster(null)).toThrow(WageMasterError)
    expect(() => normalizeMinWageMaster([])).toThrow(WageMasterError)
    expect(() => normalizeMinWageMaster({ prefectures: [] })).toThrow(/prefectures/)
    expect(() => normalizeMinWageMaster({ prefectures: { 佐賀: 'x' } })).toThrow(/配列/)
    expect(() => normalizeMinWageMaster({ prefectures: { 佐賀: [{ effectiveFrom: 'x', rate: 1 }] } })).toThrow(/effectiveFrom/)
    expect(() => normalizeMinWageMaster({ prefectures: { 佐賀: [{ effectiveFrom: '2025-10-01', rate: -1 }] } })).toThrow(/rate/)
    expect(() => normalizeMinWageMaster({ branchToPrefecture: [] })).toThrow(/branchToPrefecture/)
    expect(() => normalizeMinWageMaster({ branchToPrefecture: { A: 1 } })).toThrow(/文字列/)
  })
})

describe('normalizeSalaryItemConfig', () => {
  it('正常な設定を受け付け、項目名を NFKC + trim 正規化する', () => {
    const out = normalizeSalaryItemConfig({
      items: { '基本給  ': 'base', '残業手当': 'overtime', 'ｸﾚｰﾝ手当': 'base' },
    })
    expect(out).toEqual({
      items: { 基本給: 'base', 残業手当: 'overtime', クレーン手当: 'base' },
    })
  })

  it('空の items を受け付ける', () => {
    expect(normalizeSalaryItemConfig({ items: {} })).toEqual({ items: {} })
  })

  it('オブジェクトでない入力を拒否する', () => {
    expect(() => normalizeSalaryItemConfig(null)).toThrow(WageMasterError)
    expect(() => normalizeSalaryItemConfig([])).toThrow(WageMasterError)
    expect(() => normalizeSalaryItemConfig('x')).toThrow(WageMasterError)
  })

  it('items が無い / オブジェクトでない入力を拒否する', () => {
    expect(() => normalizeSalaryItemConfig({})).toThrow(WageMasterError)
    expect(() => normalizeSalaryItemConfig({ items: [] })).toThrow(WageMasterError)
    expect(() => normalizeSalaryItemConfig({ items: 3 })).toThrow(WageMasterError)
  })

  it('空の項目名を拒否する', () => {
    expect(() => normalizeSalaryItemConfig({ items: { '   ': 'base' } })).toThrow('空の項目名')
  })

  it('base / overtime 以外の区分を拒否する', () => {
    expect(() => normalizeSalaryItemConfig({ items: { 基本給: 'bonus' } })).toThrow('"base" | "overtime"')
    expect(() => normalizeSalaryItemConfig({ items: { 基本給: 1 } })).toThrow(WageMasterError)
  })
})

describe('normalizeSalaryCdMap', () => {
  it('正常な突合マスタを受け付け、キーを NFKC + trim 正規化する', () => {
    const out = normalizeSalaryCdMap({
      entries: { '1427|中村一由': '1412', ' １４２７|柳井亮祐 ': '1587' },
    })
    expect(out).toEqual({
      entries: { '1427|中村一由': '1412', '1427|柳井亮祐': '1587' },
    })
  })

  it('空の entries を受け付ける', () => {
    expect(normalizeSalaryCdMap({ entries: {} })).toEqual({ entries: {} })
  })

  it('オブジェクトでない入力を拒否する', () => {
    expect(() => normalizeSalaryCdMap(null)).toThrow(WageMasterError)
    expect(() => normalizeSalaryCdMap([])).toThrow(WageMasterError)
    expect(() => normalizeSalaryCdMap('x')).toThrow(WageMasterError)
  })

  it('entries が無い / オブジェクトでない入力を拒否する', () => {
    expect(() => normalizeSalaryCdMap({})).toThrow(WageMasterError)
    expect(() => normalizeSalaryCdMap({ entries: [] })).toThrow(WageMasterError)
    expect(() => normalizeSalaryCdMap({ entries: 3 })).toThrow(WageMasterError)
  })

  it('"給与コード|氏名" 形式でないキーを拒否する', () => {
    expect(() => normalizeSalaryCdMap({ entries: { '中村一由': '1412' } })).toThrow('給与コード|氏名')
    expect(() => normalizeSalaryCdMap({ entries: { '1427|': '1412' } })).toThrow('給与コード|氏名')
  })

  it('乗務員CDが数字でない値を拒否する', () => {
    expect(() => normalizeSalaryCdMap({ entries: { '1427|中村一由': 'abc' } })).toThrow('乗務員CD')
    expect(() => normalizeSalaryCdMap({ entries: { '1427|中村一由': 1412 } })).toThrow(WageMasterError)
  })
})

describe('normalizeWageConfig', () => {
  it('null/undefined は既定値そのもの', () => {
    expect(normalizeWageConfig(null)).toEqual(DEFAULT_WAGE_CONFIG)
    expect(normalizeWageConfig(undefined)).toEqual(DEFAULT_WAGE_CONFIG)
  })

  it('部分指定は既定値へマージ (rates の一部だけ上書き等)', () => {
    const c = normalizeWageConfig({ rates: { legalHoliday: 1.4 }, legalHolidayWeekday: 6, weekStartsOn: 1, nonLegalHolidayWeekdays: [0], hourlyBasis: 'restraint' })
    expect(c.rates.legalHoliday).toBe(1.4)
    expect(c.rates.overtime).toBe(1.25)
    expect(c.legalHolidayWeekday).toBe(6)
    expect(c.weekStartsOn).toBe(1)
    expect(c.nonLegalHolidayWeekdays).toEqual([0])
    expect(c.hourlyBasis).toBe('restraint')
  })

  it('構造不正は WageMasterError', () => {
    expect(() => normalizeWageConfig([])).toThrow(WageMasterError)
    expect(() => normalizeWageConfig({ rates: { overtime: -1 } })).toThrow(/rates.overtime/)
    expect(() => normalizeWageConfig({ legalHolidayWeekday: 7 })).toThrow(/legalHolidayWeekday/)
    expect(() => normalizeWageConfig({ weekStartsOn: -1 })).toThrow(/weekStartsOn/)
    expect(() => normalizeWageConfig({ nonLegalHolidayWeekdays: [9] })).toThrow(/nonLegalHolidayWeekdays/)
    expect(() => normalizeWageConfig({ nonLegalHolidayWeekdays: 'x' })).toThrow(/nonLegalHolidayWeekdays/)
    expect(() => normalizeWageConfig({ hourlyBasis: 'x' })).toThrow(/hourlyBasis/)
  })
})

// ---------------------------------------------------------------------------
// lookup
// ---------------------------------------------------------------------------

describe('rateForMonth', () => {
  const rates = [
    { effectiveFrom: '2024-04-01', hourlyRate: 1100 },
    { effectiveFrom: '2025-10-01', hourlyRate: 1200 },
  ]

  it('対象月の 1 日に有効な単価を引く (未来の改定は無視)', () => {
    expect(rateForMonth(rates, 2025, 4)).toBe(1100)
    expect(rateForMonth(rates, 2025, 10)).toBe(1200)
    expect(rateForMonth(rates, 2026, 1)).toBe(1200)
  })

  it('適用前・履歴なしは null', () => {
    expect(rateForMonth(rates, 2024, 3)).toBeNull()
    expect(rateForMonth([], 2025, 4)).toBeNull()
  })
})

describe('minWageForBranch', () => {
  it('事業所 → 県 → 対象月の最低賃金 (mapped=true)', () => {
    const r = minWageForBranch(MIN_WAGE, 'テスト運輸　第一営業所', 2025, 11)
    expect(r).toEqual({ rate: 1030, prefecture: '佐賀', mapped: true })
    // 改定前の月は旧額
    expect(minWageForBranch(MIN_WAGE, 'テスト運輸　第一営業所', 2025, 9).rate).toBe(956)
  })

  it('未マッピング事業所は default 県で近似 (mapped=false)', () => {
    const r = minWageForBranch(MIN_WAGE, '未知の営業所', 2025, 11)
    expect(r).toEqual({ rate: 1030, prefecture: '佐賀', mapped: false })
  })

  it('default も無ければ比較不能 / 県に履歴が無ければ rate null', () => {
    expect(minWageForBranch({ prefectures: {}, branchToPrefecture: {} }, 'X', 2025, 1))
      .toEqual({ rate: null, prefecture: null, mapped: false })
    expect(minWageForBranch({ prefectures: {}, branchToPrefecture: { X: '大阪' } }, 'X', 2025, 1))
      .toEqual({ rate: null, prefecture: '大阪', mapped: true })
  })
})

// ---------------------------------------------------------------------------
// 法定区分の分類
// ---------------------------------------------------------------------------

describe('dayOfWeek', () => {
  it('2025-04-06 は日曜 (0)、2025-04-05 は土曜 (6)', () => {
    expect(dayOfWeek(2025, 4, 6)).toBe(0)
    expect(dayOfWeek(2025, 4, 5)).toBe(6)
    expect(dayOfWeek(2025, 4, 1)).toBe(2)
  })
})

describe('classifyMonth (2025-04: 1日=火, 5日=土, 6日=日)', () => {
  const config = DEFAULT_WAGE_CONFIG

  it('平日: 法定時間内 = 実働 − 時間外 − 時間外深夜。深夜は加算対象分数', () => {
    const m = classifyMonth(
      [day(1, { workingMinutes: 600, overtimeMinutes: 120, nightMinutes: 30, overtimeNightMinutes: 10 })],
      2025, 4, config,
    )
    expect(m.statutory).toBe(600 - 120 - 10)
    expect(m.overtime).toBe(120)
    expect(m.night).toBe(30)
    expect(m.overtimeNight).toBe(10)
    expect(m.legalHoliday).toBe(0)
    expect(m.weekly40Excess).toBe(0)
  })

  it('法定休日 (日曜): 時間外の概念なし — 実働すべてを法定休日 (+深夜) に計上', () => {
    const m = classifyMonth(
      [day(6, { workingMinutes: 480, overtimeMinutes: 60, nightMinutes: 60, overtimeNightMinutes: 30 })],
      2025, 4, config,
    )
    expect(m.legalHolidayNight).toBe(90)
    expect(m.legalHoliday).toBe(480 - 90)
    expect(m.overtime).toBe(0)
    expect(m.statutory).toBe(0)
  })

  it('法定外休日 (土曜既定): 実働すべてを法定外休日 (+深夜) に計上', () => {
    const m = classifyMonth([day(5, { workingMinutes: 300, nightMinutes: 20 })], 2025, 4, config)
    expect(m.nonLegalHoliday).toBe(280)
    expect(m.nonLegalHolidayNight).toBe(20)
  })

  it('休日行・実働 0・null は計上しない (防御)', () => {
    const m = classifyMonth(
      [
        day(2, { isRestDay: true, workingMinutes: 600 }),
        day(3, { workingMinutes: 0 }),
        day(4, { workingMinutes: null, overtimeMinutes: null, nightMinutes: null, overtimeNightMinutes: null }),
      ],
      2025, 4, config,
    )
    expect(m).toEqual(emptyCategoryMinutes())
  })

  it('実働 < 時間外の異常データでも法定時間内を負にしない', () => {
    const m = classifyMonth([day(1, { workingMinutes: 60, overtimeMinutes: 120 })], 2025, 4, config)
    expect(m.statutory).toBe(0)
    expect(m.overtime).toBe(120)
  })

  it('週40超過: 日曜起算の週 (4/6〜4/12) で実働 45h・割増なし → 5h', () => {
    // 月〜金 (4/7〜4/11) 各 9h
    const days = [7, 8, 9, 10, 11].map(d => day(d, { workingMinutes: 9 * 60 }))
    const m = classifyMonth(days, 2025, 4, DEFAULT_WAGE_CONFIG)
    expect(m.weekly40Excess).toBe(5 * 60)
  })

  it('週40超過: 既に割増計上済みの分 (時間外・法定外休日) は差し引く', () => {
    const days = [
      ...[7, 8, 9, 10].map(d => day(d, { workingMinutes: 9 * 60 })),
      day(11, { workingMinutes: 9 * 60, overtimeMinutes: 120, overtimeNightMinutes: 30 }),
      day(12, { workingMinutes: 60 }), // 土曜 = 法定外休日 (週の実働には入るが premium として除外)
    ]
    const m = classifyMonth(days, 2025, 4, DEFAULT_WAGE_CONFIG)
    // 週実働 46h − 40h − (時間外 2h + 時間外深夜 0.5h + 法定外休日 1h) = 2.5h
    expect(m.weekly40Excess).toBe(2.5 * 60)
  })

  it('週40超過: 法定休日 (日曜) の実働は週の算定から除外する', () => {
    const days = [
      day(6, { workingMinutes: 10 * 60 }), // 日曜
      ...[7, 8, 9, 10].map(d => day(d, { workingMinutes: 10 * 60 })),
    ]
    const m = classifyMonth(days, 2025, 4, DEFAULT_WAGE_CONFIG)
    expect(m.weekly40Excess).toBe(0) // 平日 40h ちょうど
  })

  it('週の終端が翌月に属する週 (4/27〜5/3) は当月に計上しない', () => {
    const days = [28, 29, 30].map(d => day(d, { workingMinutes: 20 * 60 }))
    const m = classifyMonth(days, 2025, 4, DEFAULT_WAGE_CONFIG)
    expect(m.weekly40Excess).toBe(0)
  })

  it('月初の跨ぎ週 (3/30〜4/5) は前月末日の実働を含めて計算する', () => {
    // 前月 3/31 (月) 10h + 当月 4/1〜4/4 (火〜金) 各 9h = 46h → 超過 6h
    const prevDays = [day(31, { workingMinutes: 10 * 60 })]
    const days = [1, 2, 3, 4].map(d => day(d, { workingMinutes: 9 * 60 }))
    expect(classifyMonth(days, 2025, 4, DEFAULT_WAGE_CONFIG, prevDays).weekly40Excess).toBe(6 * 60)
    // 前月分が無ければ当月分のみ (36h) → 超過なし
    expect(classifyMonth(days, 2025, 4, DEFAULT_WAGE_CONFIG).weekly40Excess).toBe(0)
    // 前月由来の日の区分時間は当月に計上されない
    expect(classifyMonth(days, 2025, 4, DEFAULT_WAGE_CONFIG, prevDays).statutory).toBe(4 * 9 * 60)
  })

  it('1 月の跨ぎ週は前年 12 月として曜日を解決する', () => {
    // 2025-01: 1日=水。跨ぎ週 = 2024-12-29(日)〜2025-01-04(土)
    // 前年 12/30 (月) 20h + 当月 1/2, 1/3 (木金) 各 11h = 42h → 超過 2h
    const prevDays = [day(30, { workingMinutes: 20 * 60 })]
    const days = [2, 3].map(d => day(d, { workingMinutes: 11 * 60 }))
    expect(classifyMonth(days, 2025, 1, DEFAULT_WAGE_CONFIG, prevDays).weekly40Excess).toBe(2 * 60)
  })
})

// ---------------------------------------------------------------------------
// 金額計算
// ---------------------------------------------------------------------------

describe('computeWageAmounts', () => {
  it('区分 × 係数 × 単価。円未満四捨五入', () => {
    const minutes = { ...emptyCategoryMinutes(), statutory: 90, overtime: 60, night: 30 }
    const { amounts, total } = computeWageAmounts(minutes, 1001, DEFAULT_WAGE_CONFIG)
    expect(amounts.statutory).toBe(Math.round(1.5 * 1001)) // 1502 (1501.5 → 四捨五入)
    expect(amounts.overtime).toBe(Math.round(1001 * 1.25))
    expect(amounts.night).toBe(Math.round(0.5 * 1001 * 0.25))
    expect(amounts.legalHoliday).toBe(0)
    expect(total).toBe(Object.values(amounts).reduce((a, b) => a + b, 0))
  })
})

describe('computeWageRow', () => {
  const wageMaster: WageMaster = {
    drivers: { 9901: { name: '試験　太郎', rates: [{ effectiveFrom: '2024-04-01', hourlyRate: 1200 }] } },
  }
  const baseSummary = summary({
    workingMinutes: 40 * 60,
    restraintMinutes: 50 * 60,
    days: [day(1, { workingMinutes: 600, overtimeMinutes: 120 })],
  })

  it('単価あり: 区分金額・合計・換算時給 (実働基準)・最低賃金差', () => {
    const row = computeWageRow(baseSummary, 2025, 4, wageMaster, MIN_WAGE, DEFAULT_WAGE_CONFIG)
    expect(row.hourlyRate).toBe(1200)
    expect(row.amounts!.statutory).toBe(Math.round((480 / 60) * 1200))
    expect(row.amounts!.overtime).toBe(Math.round((120 / 60) * 1200 * 1.25))
    expect(row.totalAmount).toBe(row.amounts!.statutory + row.amounts!.overtime)
    expect(row.hourlyEquivalent).toBe(Math.round(row.totalAmount! / 40))
    expect(row.minWage).toEqual({ rate: 956, prefecture: '佐賀', mapped: true })
    expect(row.minWageDiff).toBe(row.hourlyEquivalent! - 956)
  })

  it('単価マスタに居ない乗務員は金額 null (時間の分類だけ返す)', () => {
    const row = computeWageRow(baseSummary, 2025, 4, { drivers: {} }, MIN_WAGE, DEFAULT_WAGE_CONFIG)
    expect(row.hourlyRate).toBeNull()
    expect(row.amounts).toBeNull()
    expect(row.totalAmount).toBeNull()
    expect(row.hourlyEquivalent).toBeNull()
    expect(row.minWageDiff).toBeNull()
    expect(row.minutes.statutory).toBe(480)
  })

  it('換算時給: 分母 (実働) が無い/0 なら null。restraint 基準にも切替可', () => {
    const noWorking = computeWageRow(
      summary({ workingMinutes: null, days: [day(1, { workingMinutes: 600 })] }),
      2025, 4, wageMaster, MIN_WAGE, DEFAULT_WAGE_CONFIG,
    )
    expect(noWorking.hourlyEquivalent).toBeNull()
    expect(noWorking.minWageDiff).toBeNull()

    const restraintBasis = computeWageRow(
      baseSummary, 2025, 4, wageMaster, MIN_WAGE,
      { ...DEFAULT_WAGE_CONFIG, hourlyBasis: 'restraint' },
    )
    expect(restraintBasis.hourlyEquivalent).toBe(Math.round(restraintBasis.totalAmount! / 50))
  })

  it('実働 0 分 (null でなく 0) は換算時給・最低賃金換算とも null', () => {
    const row = computeWageRow(
      summary({ workingMinutes: 0, days: [day(1, { workingMinutes: 600 })] }),
      2025, 4, wageMaster, MIN_WAGE, DEFAULT_WAGE_CONFIG,
    )
    expect(row.hourlyEquivalent).toBeNull()
    expect(row.minWageTotalPay).toBeNull()
    expect(row.totalPayDiff).toBeNull()
  })

  it('最低賃金が引けない事業所 (未マッピング + default なし) は minWage 系がすべて null', () => {
    const noMinWage: MinWageMaster = { prefectures: {}, branchToPrefecture: {} }
    const row = computeWageRow(baseSummary, 2025, 4, wageMaster, noMinWage, DEFAULT_WAGE_CONFIG)
    expect(row.minWage.rate).toBeNull()
    expect(row.minWageTotalPay).toBeNull()
    expect(row.totalPayDiff).toBeNull()
    expect(row.minWageOvertimePay).toBeNull()
    expect(row.minWageOvertimeRate).toBeNull()
    expect(row.minWageNightOvertimePay).toBeNull()
    expect(row.minWageNightOvertimeRate).toBeNull()
    expect(row.overtimePayDiff).toBeNull()
    expect(row.nightOvertimePayDiff).toBeNull()
    // 単価マスタ側の金額は最低賃金と独立に出る
    expect(row.actualOvertimePay).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 最低賃金ベース残業代 (月60h超 1.5 倍 + 深夜軸の独立加算)
// ---------------------------------------------------------------------------

describe('computeMinWageOvertimePay', () => {
  it('月60h以下は overtime 係数のみ (深夜なし)', () => {
    // 20h = 1200 分。1000 円 × 20h × 1.25
    expect(computeMinWageOvertimePay(1200, 0, 1000, DEFAULT_WAGE_CONFIG)).toBe(25000)
  })

  it('月60h超は超過分だけ overtimeOver60h 係数 (1.5) に切り替わる', () => {
    // 100h: 60h × 1.25 + 40h × 1.5 = 75h + 60h = 135h 分
    expect(computeMinWageOvertimePay(100 * 60, 0, 1000, DEFAULT_WAGE_CONFIG)).toBe(135000)
  })

  it('深夜軸 (+0.25) は 60h 判定と独立に常時加算される', () => {
    // 70h 全部深夜: 時間外軸 60×1.25+10×1.5=90h、深夜軸 70×0.25=17.5h
    expect(computeMinWageOvertimePay(70 * 60, 70 * 60, 1000, DEFAULT_WAGE_CONFIG))
      .toBe(90000 + 17500)
  })
})

describe('splitMinWageOvertimePay', () => {
  it('通常+深夜の合計は computeMinWageOvertimePay と一致する (按分は表示上の慣行)', () => {
    for (const [normal, night] of [[20 * 60, 0], [50 * 60, 20 * 60], [70 * 60, 10 * 60], [0, 70 * 60]] as const) {
      const { normalPay, nightPay } = splitMinWageOvertimePay(normal, night, 1000, DEFAULT_WAGE_CONFIG)
      expect(normalPay + nightPay).toBe(computeMinWageOvertimePay(normal + night, night, 1000, DEFAULT_WAGE_CONFIG))
    }
  })

  it('60h 枠は通常残業から先に消費する (通常 50h + 深夜 20h → 深夜の 10h が 1.5 倍)', () => {
    const { normalPay, nightPay } = splitMinWageOvertimePay(50 * 60, 20 * 60, 1000, DEFAULT_WAGE_CONFIG)
    expect(normalPay).toBe(Math.round(50 * 1000 * 1.25))
    // 深夜: 10h × 1.25 + 10h × 1.5 + 20h × 0.25 (深夜軸)
    expect(nightPay).toBe(Math.round((10 * 1.25 + 10 * 1.5 + 20 * 0.25) * 1000))
  })

  it('通常残業だけで 60h を超えると通常側にも 1.5 倍が乗る', () => {
    const { normalPay, nightPay } = splitMinWageOvertimePay(70 * 60, 60, 1000, DEFAULT_WAGE_CONFIG)
    expect(normalPay).toBe(Math.round((60 * 1.25 + 10 * 1.5) * 1000))
    // 深夜 1h は全量 60h 超 (1.5) + 深夜軸 0.25
    expect(nightPay).toBe(Math.round((1 * 1.5 + 1 * 0.25) * 1000))
  })
})

// ---------------------------------------------------------------------------
// 単価マスタ CSV
// ---------------------------------------------------------------------------

describe('wageMasterToCsv / upsertWageMasterFromCsv', () => {
  const master: WageMaster = {
    drivers: {
      9902: { name: '試験　次郎', rates: [{ effectiveFrom: '2025-01-01', hourlyRate: 1000 }] },
      9901: {
        name: '試験　太郎',
        rates: [
          { effectiveFrom: '2024-04-01', hourlyRate: 1100 },
          { effectiveFrom: '2025-10-01', hourlyRate: 1200 },
        ],
      },
    },
  }

  it('export: 適用開始日 降順 → 乗務員CD 昇順の 1 行 1 履歴', () => {
    const csv = wageMasterToCsv(master)
    expect(csv.split('\r\n')).toEqual([
      WAGE_MASTER_CSV_HEADER,
      '9901,試験　太郎,1200,2025-10-01',
      '9902,試験　次郎,1000,2025-01-01',
      '9901,試験　太郎,1100,2024-04-01',
      '',
    ])
    // name 無しは空欄
    expect(wageMasterToCsv({ drivers: { 1: { rates: [{ effectiveFrom: '2025-01-01', hourlyRate: 900 }] } } }))
      .toContain('1,,900,2025-01-01')
  })

  it('export: 同一適用開始日は乗務員CD の数値昇順に並ぶ', () => {
    const csv = wageMasterToCsv({
      drivers: {
        10: { rates: [{ effectiveFrom: '2025-10-04', hourlyRate: 1010 }] },
        2: { rates: [{ effectiveFrom: '2025-10-04', hourlyRate: 1020 }] },
      },
    })
    expect(csv.split('\r\n').slice(1, 3)).toEqual([
      '2,,1020,2025-10-04',
      '10,,1010,2025-10-04',
    ])
  })

  it('import: 同キー (CD × 適用開始日) は上書き、新キーは追加。既存は消さない', () => {
    const csv = [
      WAGE_MASTER_CSV_HEADER,
      '9901,試験　太郎,1250,2025-10-01', // 上書き
      '9903,試験　三郎,980,2025-04-01', // 新規乗務員
      '9902,,1050,2026-04-01', // 履歴追加 (name 空は既存名を保持)
    ].join('\n')
    const merged = upsertWageMasterFromCsv(master, csv)
    expect(merged.drivers['9901']!.rates).toEqual([
      { effectiveFrom: '2024-04-01', hourlyRate: 1100 },
      { effectiveFrom: '2025-10-01', hourlyRate: 1250 },
    ])
    expect(merged.drivers['9903']!.name).toBe('試験　三郎')
    expect(merged.drivers['9902']!.name).toBe('試験　次郎')
    expect(merged.drivers['9902']!.rates.map(r => r.hourlyRate)).toEqual([1000, 1050])
    // 元のマスタは変更しない (deep copy)
    expect(master.drivers['9901']!.rates[1]!.hourlyRate).toBe(1200)
  })

  it('ヘッダ無し CSV も読める', () => {
    const merged = upsertWageMasterFromCsv({ drivers: {} }, '9901,試験　太郎,1200,2025-10-01')
    expect(merged.drivers['9901']!.rates).toHaveLength(1)
  })

  it('不正 CSV は WageMasterError (空 / CD / 単価 / 日付 / 列不足)', () => {
    expect(() => upsertWageMasterFromCsv(master, '')).toThrow(/空/)
    expect(() => upsertWageMasterFromCsv(master, 'abc,名前,1000,2025-01-01')).toThrow(/乗務員CD/)
    expect(() => upsertWageMasterFromCsv(master, '9901,名前,x,2025-01-01')).toThrow(/単価/)
    expect(() => upsertWageMasterFromCsv(master, '9901,名前,1000,2025年1月1日')).toThrow(/適用開始日/)
    expect(() => upsertWageMasterFromCsv(master, '9901')).toThrow(/適用開始日/)
  })

  it('Excel で開いて保存し直した CSV (日付 2025/10/4・"1,430" 単価・全角) を受け付ける', () => {
    const merged = upsertWageMasterFromCsv({ drivers: {} }, [
      '9901,試験　太郎,"1,430",2025/10/4', // Excel の日付書式 + 桁区切りクォート
      '9902,試験　次郎,1050,2025-1-4', // ゼロ埋めなしハイフン
      '9903,試験　三郎,980,２０２５/１０/０４', // 全角数字
    ].join('\r\n'))
    expect(merged.drivers['9901']!.rates).toEqual([{ effectiveFrom: '2025-10-04', hourlyRate: 1430 }])
    expect(merged.drivers['9902']!.rates).toEqual([{ effectiveFrom: '2025-01-04', hourlyRate: 1050 }])
    expect(merged.drivers['9903']!.rates).toEqual([{ effectiveFrom: '2025-10-04', hourlyRate: 980 }])
  })
})

describe('splitCsvCells / normalizeDateCell', () => {
  it('ダブルクォート内のカンマと "" エスケープを扱う', () => {
    expect(splitCsvCells('a,"b,c","d""e"')).toEqual(['a', 'b,c', 'd"e'])
    expect(splitCsvCells('x')).toEqual(['x'])
  })

  it('normalizeDateCell は各種表記を YYYY-MM-DD に正規化し、不正は null', () => {
    expect(normalizeDateCell('2025-10-04')).toBe('2025-10-04')
    expect(normalizeDateCell('2025/10/4')).toBe('2025-10-04')
    expect(normalizeDateCell(' 2025/1/4 ')).toBe('2025-01-04')
    expect(normalizeDateCell('2025年1月1日')).toBeNull()
    expect(normalizeDateCell('')).toBeNull()
  })
})
