import { describe, expect, it } from 'vitest'
import {
  computeWageMixRow,
  defaultWageMixSettings,
  type WageMixInput,
  type WageMixRow,
  type WageMixSettings,
} from '~/utils/profit-wage-mix'
import {
  hasWageMixAmounts,
  wageMixBaseFormula,
  wageMixOvertimeFormula,
} from '~/utils/profit-wage-formula'

/**
 * 2026-07 の中村 1412 (実データ)。拘束は本番
 * `/restraint-api/archive/summaries?month=2026-07` の実測値。
 *
 * - 法定内 = (18974 − 6397) / 60 = 209.6166…h → 表示 `209.6h`
 * - 時間外 = 6397 / 60 = 106.6166…h → 表示 `106.6h`
 * - 深夜 = 918 / 60 = 15.3h
 * - 割増係数 = (6397×1.25 + 918×0.25) / 60 = 137.0958…h → 表示 `137.1h`
 */
const NAKAMURA: WageMixInput = {
  driverCd: '1412',
  driverName: '中村　一由',
  allowanceBaseYen: 609000,
  actualPayYen: 619000,
  restraint: { workingMinutes: 18974, overtimeMinutes: 6397, nightMinutes: 918, workDays: 27 },
}

function settings(over: Partial<WageMixSettings> = {}): WageMixSettings {
  return { ...defaultWageMixSettings(), ...over }
}

function rowOf(input: WageMixInput = NAKAMURA, over: Partial<WageMixSettings> = {}): WageMixRow {
  return computeWageMixRow(input, settings(over))
}

describe('wageMixBaseFormula — 基本給', () => {
  it('★ 方式A は 法定内時間 × 単価 (issue #816 の例と一字一句一致)', () => {
    expect(wageMixBaseFormula(rowOf(), settings())).toBe('209.6h × ¥1,075 = ¥225,338')
  })

  it('★ 方式B は 稼働日数 × 日額 (issue #816 の例と一字一句一致)', () => {
    const s = settings({ method: 'days' })
    expect(wageMixBaseFormula(rowOf(NAKAMURA, { method: 'days' }), s)).toBe('27日 × ¥8,600 = ¥232,200')
  })

  it('単価・日額を振っても = の右は表の金額そのもの (式で計算し直さない)', () => {
    for (const over of [{ hourlyRateYen: 1200 }, { method: 'days' as const, dailyRateYen: 9600 }]) {
      const s = settings(over)
      const row = computeWageMixRow(NAKAMURA, s)
      expect(wageMixBaseFormula(row, s)!.endsWith(`= ¥${row.baseWageYen!.toLocaleString()}`)).toBe(true)
    }
  })

  it('旅費率は基本給の式に効かない (35% と 40% で同じ)', () => {
    const a = wageMixBaseFormula(rowOf(NAKAMURA, { travelRate: 0.35 }), settings({ travelRate: 0.35 }))
    const b = wageMixBaseFormula(rowOf(NAKAMURA, { travelRate: 0.4 }), settings({ travelRate: 0.4 }))
    expect(a).toBe(b)
  })
})

describe('wageMixOvertimeFormula — 残業', () => {
  it('★ 方式A は 割増の内訳 × 単価 (issue #816 の例と一字一句一致)', () => {
    expect(wageMixOvertimeFormula(rowOf(), settings()))
      .toBe('(時間外 106.6h × 1.25 ＋ 深夜 15.3h × 0.25) × ¥1,075 = ¥147,378')
  })

  it('★ 方式B の単価は (日額 ÷ 8) のまま出す — ¥1,075 に潰さない', () => {
    const s = settings({ method: 'days' })
    expect(wageMixOvertimeFormula(computeWageMixRow(NAKAMURA, s), s))
      .toBe('(時間外 106.6h × 1.25 ＋ 深夜 15.3h × 0.25) × (日額 ¥8,600 ÷ 8) = ¥147,378')
  })

  it('日額が 8 で割り切れなくても式が壊れない (単価に潰していないため)', () => {
    const s = settings({ method: 'days', dailyRateYen: 8500 })
    const row = computeWageMixRow(NAKAMURA, s)
    expect(wageMixOvertimeFormula(row, s))
      .toBe(`(時間外 106.6h × 1.25 ＋ 深夜 15.3h × 0.25) × (日額 ¥8,500 ÷ 8) = ¥${row.overtimeYen!.toLocaleString()}`)
  })

  it('法定休日が有れば項が増える', () => {
    const s = settings()
    const row = computeWageMixRow(
      { ...NAKAMURA, restraint: { ...NAKAMURA.restraint!, holidayMinutes: 480 } },
      s,
    )
    expect(wageMixOvertimeFormula(row, s))
      .toBe(`(時間外 106.6h × 1.25 ＋ 深夜 15.3h × 0.25 ＋ 法定休日 8h × 0.35) × ¥1,075 = ¥${row.overtimeYen!.toLocaleString()}`)
  })

  it('法定休日が 0 なら項を並べない (金額に 1 円も効いていないため)', () => {
    const s = settings()
    const row = computeWageMixRow({ ...NAKAMURA, restraint: { ...NAKAMURA.restraint!, holidayMinutes: 0 } }, s)
    expect(wageMixOvertimeFormula(row, s)).not.toContain('法定休日')
  })

  it('旅費率は残業の式に効かない (35% と 40% で同じ)', () => {
    const a = wageMixOvertimeFormula(rowOf(NAKAMURA, { travelRate: 0.35 }), settings({ travelRate: 0.35 }))
    const b = wageMixOvertimeFormula(rowOf(NAKAMURA, { travelRate: 0.4 }), settings({ travelRate: 0.4 }))
    expect(a).toBe(b)
  })
})

describe('方式 × 旅費率 の 4 通りとも、= の右が表の金額と一致する', () => {
  it.each([
    ['hours', 0.35], ['hours', 0.4], ['days', 0.35], ['days', 0.4],
  ] as const)('方式 %s / 旅費 %s', (method, travelRate) => {
    const s = settings({ method, travelRate })
    const row = computeWageMixRow(NAKAMURA, s)
    expect(wageMixBaseFormula(row, s)).toContain(`= ¥${row.baseWageYen!.toLocaleString()}`)
    expect(wageMixOvertimeFormula(row, s)).toContain(`= ¥${row.overtimeYen!.toLocaleString()}`)
  })
})

describe('欠測の行は式を出さない (0h × 単価 = ¥0 を出さない)', () => {
  it('拘束が無い行は両方 null', () => {
    const row = computeWageMixRow({ ...NAKAMURA, restraint: null }, settings())
    expect(wageMixBaseFormula(row, settings())).toBeNull()
    expect(wageMixOvertimeFormula(row, settings())).toBeNull()
  })

  it.each([
    ['実働', { workingMinutes: null, overtimeMinutes: 0, nightMinutes: 0 }],
    ['時間外', { workingMinutes: 0, overtimeMinutes: null, nightMinutes: 0 }],
    ['深夜', { workingMinutes: 0, overtimeMinutes: 0, nightMinutes: null }],
  ])('%s が空の行も両方 null', (_label, restraint) => {
    const row = computeWageMixRow({ ...NAKAMURA, restraint: { ...restraint, workDays: 27 } }, settings())
    expect(wageMixBaseFormula(row, settings())).toBeNull()
    expect(wageMixOvertimeFormula(row, settings())).toBeNull()
  })

  it('★ 実支給が引けず現状が推計に落ちた行でも、拘束が有れば式は出る', () => {
    const row = computeWageMixRow({ ...NAKAMURA, actualPayYen: null }, settings())
    expect(row.currentEstimated).toBe(true)
    expect(wageMixBaseFormula(row, settings())).toBe('209.6h × ¥1,075 = ¥225,338')
    expect(wageMixOvertimeFormula(row, settings()))
      .toBe('(時間外 106.6h × 1.25 ＋ 深夜 15.3h × 0.25) × ¥1,075 = ¥147,378')
  })
})

describe('hasWageMixAmounts — 時間と金額は一緒に埋まるか、一緒に null か', () => {
  const FIELDS = [
    'statutoryHours', 'premiumHours', 'overtimeHours', 'nightHours', 'holidayHours',
    'workDays', 'baseWageYen', 'overtimeYen',
  ] as const

  it('計算できた行は 8 つとも埋まっている', () => {
    const row = rowOf()
    expect(hasWageMixAmounts(row)).toBe(true)
    for (const f of FIELDS) expect(row[f]).not.toBeNull()
  })

  it('欠測の行は 8 つとも null', () => {
    const row = computeWageMixRow({ ...NAKAMURA, restraint: null }, settings())
    expect(hasWageMixAmounts(row)).toBe(false)
    for (const f of FIELDS) expect(row[f]).toBeNull()
  })

  it('内訳は割増係数を分解しただけ (金額には 1 円も効かない)', () => {
    const row = rowOf()
    expect(row.overtimeHours).toBeCloseTo(6397 / 60, 9)
    expect(row.nightHours).toBeCloseTo(918 / 60, 9)
    expect(row.holidayHours).toBe(0)
    expect(row.overtimeHours! * 1.25 + row.nightHours! * 0.25 + row.holidayHours! * 0.35)
      .toBeCloseTo(row.premiumHours!, 9)
  })
})
