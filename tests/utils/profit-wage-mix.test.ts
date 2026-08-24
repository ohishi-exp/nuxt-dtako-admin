import { describe, expect, it } from 'vitest'
import {
  computeWageMixRow,
  defaultWageMixSettings,
  hourlyEquivalent,
  minWageWarning,
  MIN_DAILY_WAGE_YEN,
  MIN_HOURLY_WAGE_YEN,
  DEFAULT_FLAT_OVERTIME_YEN,
  NO_ACTUAL_PAY_REASON,
  NO_RESTRAINT_REASON,
  PARTIAL_RESTRAINT_REASON,
  summarizeWageMix,
  travelRateLabel,
  WAGE_MIX_METHOD_LABELS,
  type WageMixInput,
  type WageMixSettings,
} from '~/utils/profit-wage-mix'

/**
 * 2026-07 / 帯広5名の実データ。
 *
 * - 拘束は本番 `/restraint-api/archive/summaries?month=2026-07` の実測値
 *   (`fetched_at 20260821T141955`、MCP `get_restraint_summary` と同一の R2 キー)
 * - 旅費の母数は実支給 ¥2,764,000 ベース (`profit-allowance-base.ts` が組む)
 * - **実支給は一番星の経費明細 `08 給与(人件費)` の実測値** (計 ¥2,815,000、Refs #814)。
 *   上司向け資料の支給額と一円まで一致する。**佐竹の ¥572,000 は 07-27 の過払い
 *   ¥1,000 込みで、これが正しい値** (オーナー判断で調整しない)
 */
const DRIVERS: WageMixInput[] = [
  { driverCd: '1412', driverName: '中村　一由', allowanceBaseYen: 609000, actualPayYen: 619000, restraint: { workingMinutes: 18974, overtimeMinutes: 6397, nightMinutes: 918, workDays: 27 } },
  { driverCd: '1587', driverName: '柳井　亮祐', allowanceBaseYen: 552500, actualPayYen: 562500, restraint: { workingMinutes: 15517, overtimeMinutes: 4611, nightMinutes: 7884, workDays: 23 } },
  { driverCd: '1656', driverName: '西島　健太', allowanceBaseYen: 542500, actualPayYen: 552500, restraint: { workingMinutes: 12681, overtimeMinutes: 4312, nightMinutes: 883, workDays: 18 } },
  { driverCd: '1732', driverName: '佐竹　繁', allowanceBaseYen: 561000, actualPayYen: 572000, restraint: { workingMinutes: 19689, overtimeMinutes: 6760, nightMinutes: 2015, workDays: 27 } },
  { driverCd: '1742', driverName: '増地　誠', allowanceBaseYen: 499000, actualPayYen: 509000, restraint: { workingMinutes: 18919, overtimeMinutes: 5962, nightMinutes: 1493, workDays: 27 } },
]

function settings(over: Partial<WageMixSettings> = {}): WageMixSettings {
  return { ...defaultWageMixSettings(), ...over }
}

describe('定数', () => {
  it('最低賃金と日額の下限が対応する', () => {
    expect(MIN_HOURLY_WAGE_YEN).toBe(1075)
    expect(MIN_DAILY_WAGE_YEN).toBe(8600)
  })

  it('既定は 方式A・最低賃金ちょうど・旅費 35%・一律残業代 ¥10,000', () => {
    expect(defaultWageMixSettings()).toEqual({
      method: 'hours', hourlyRateYen: 1075, dailyRateYen: 8600, travelRate: 0.35, flatOvertimeYen: 10000,
    })
  })

  it('推計に落ちたときの一律残業代の既定は ¥10,000', () => {
    expect(DEFAULT_FLAT_OVERTIME_YEN).toBe(10000)
  })

  it('方式のラベルが両方ある', () => {
    expect(WAGE_MIX_METHOD_LABELS.hours).toContain('法定内時間')
    expect(WAGE_MIX_METHOD_LABELS.days).toContain('稼働日数')
  })
})

describe('computeWageMixRow — 方式B (日数) は資料の数字を再現する', () => {
  const rows = DRIVERS.map(d => computeWageMixRow(d, settings({ method: 'days' })))

  it('基本給は 日額 × 稼働日数 で、資料の合計 ¥1,049,200 と一致する', () => {
    expect(rows.map(r => r.baseWageYen)).toEqual([232200, 197800, 154800, 232200, 232200])
    expect(rows.reduce((s, r) => s + (r.baseWageYen ?? 0), 0)).toBe(1049200)
  })

  it('旅費 35% は資料の乗務員別・合計 ¥967,400 と一致する', () => {
    expect(rows.map(r => r.travelYen)).toEqual([213150, 193375, 189875, 196350, 174650])
    expect(rows.reduce((s, r) => s + r.travelYen, 0)).toBe(967400)
  })

  it('残業は 割増係数h × 日額 ÷ 8 (柳井は資料の ¥138,581 と完全一致)', () => {
    expect(rows[1]!.overtimeYen).toBe(138581)
    expect(rows.map(r => r.overtimeYen)).toEqual([147378, 138581, 100526, 160421, 140211])
  })

  it('総額は 基本給 + 残業 + 旅費', () => {
    expect(rows.map(r => r.totalYen)).toEqual([592728, 529756, 445201, 588971, 547061])
    for (const r of rows) expect(r.totalYen).toBe(r.baseWageYen! + r.overtimeYen! + r.travelYen)
  })

  it('★ 現状は実支給。計 ¥2,815,000 で上司向け資料と一円まで一致する (佐竹は過払い ¥1,000 込み)', () => {
    expect(rows.map(r => r.currentYen)).toEqual([619000, 562500, 552500, 572000, 509000])
    expect(rows.reduce((s, r) => s + r.currentYen, 0)).toBe(2815000)
    expect(rows.every(r => !r.currentEstimated)).toBe(true)
    expect(rows.every(r => r.currentReason === null)).toBe(true)
  })

  it('★ 佐竹だけ実支給 ¥572,000 が推計 ¥571,000 (母数 + 一律残業代) を ¥1,000 上回る', () => {
    expect(rows[3]!.currentYen).toBe(572000)
    expect(rows[3]!.allowanceBaseYen + DEFAULT_FLAT_OVERTIME_YEN).toBe(571000)
  })

  it('差は 試算 − 現状', () => {
    for (const r of rows) expect(r.diffYen).toBe(r.totalYen! - r.currentYen)
  })
})

describe('computeWageMixRow — 方式A (時間) は完全な拘束で資料より上振れする', () => {
  const rows = DRIVERS.map(d => computeWageMixRow(d, settings({ method: 'hours' })))

  it('基本給は 法定内時間 (実働 − 時間外) × 単価', () => {
    expect(rows.map(r => r.baseWageYen)).toEqual([225338, 195399, 149945, 231645, 232146])
  })

  it('法定内時間は 実働 − 時間外', () => {
    expect(rows[0]!.statutoryHours).toBeCloseTo((18974 - 6397) / 60, 9)
  })

  it('単価 ¥1,075 は日額 ¥8,600 ÷ 8 と同値なので残業は方式B と同額になる', () => {
    const days = DRIVERS.map(d => computeWageMixRow(d, settings({ method: 'days' })))
    expect(rows.map(r => r.overtimeYen)).toEqual(days.map(r => r.overtimeYen))
  })

  it('★ 柳井の方式A は資料の −¥253,848 ではなく −¥35,145 になる (拘束が完全になったため)', () => {
    expect(rows[1]!.diffYen).toBe(-35145)
  })
})

describe('computeWageMixRow — 割増の係数', () => {
  const one = (r: Partial<WageMixInput['restraint']> & { workDays: number }): WageMixInput => ({
    driverCd: '1', driverName: 'x', allowanceBaseYen: 0, actualPayYen: null,
    restraint: { workingMinutes: 0, overtimeMinutes: 0, nightMinutes: 0, ...r },
  })

  it('時間外は 1.25 倍', () => {
    expect(computeWageMixRow(one({ overtimeMinutes: 60, workDays: 0 }), settings()).overtimeYen)
      .toBe(Math.round(1.25 * 1075))
  })

  it('深夜は 0.25 倍', () => {
    expect(computeWageMixRow(one({ nightMinutes: 60, workDays: 0 }), settings()).overtimeYen)
      .toBe(Math.round(0.25 * 1075))
  })

  it('法定休日は 0.35 倍 (拘束時間サマリは持たないので通常は 0)', () => {
    expect(computeWageMixRow(one({ holidayMinutes: 60, workDays: 0 }), settings()).overtimeYen)
      .toBe(Math.round(0.35 * 1075))
  })

  it('法定休日が null なら 0 として扱う', () => {
    expect(computeWageMixRow(one({ holidayMinutes: null, workDays: 0 }), settings()).premiumHours).toBe(0)
  })

  it('時間外が実働を上回っても法定内は負にしない', () => {
    const row = computeWageMixRow(one({ workingMinutes: 60, overtimeMinutes: 600, workDays: 0 }), settings())
    expect(row.statutoryHours).toBe(0)
    expect(row.baseWageYen).toBe(0)
  })
})

describe('computeWageMixRow — 欠測を 0 に倒さない', () => {
  const noRestraint: WageMixInput = { driverCd: '1999', driverName: '拘束なし', allowanceBaseYen: 100000, actualPayYen: null, restraint: null }

  it('拘束が無ければ金額は null、理由を立てる', () => {
    const row = computeWageMixRow(noRestraint, settings())
    expect(row.baseWageYen).toBeNull()
    expect(row.overtimeYen).toBeNull()
    expect(row.totalYen).toBeNull()
    expect(row.diffYen).toBeNull()
    expect(row.statutoryHours).toBeNull()
    expect(row.premiumHours).toBeNull()
    expect(row.workDays).toBeNull()
    expect(row.missingReason).toBe(NO_RESTRAINT_REASON)
  })

  it('拘束が無くても旅費と現状は出す (旅費は便で決まり拘束を 1 分も見ない)', () => {
    const row = computeWageMixRow(noRestraint, settings())
    expect(row.travelYen).toBe(35000)
    // 実支給が引けていないので推計 (母数 ¥100,000 ＋ 一律残業代 ¥10,000)。
    expect(row.currentYen).toBe(110000)
    expect(row.currentEstimated).toBe(true)
  })

  it('拘束が無くても実支給が引けていればそれを出す', () => {
    const row = computeWageMixRow({ ...noRestraint, actualPayYen: 123456 }, settings())
    expect(row.totalYen).toBeNull()
    expect(row.currentYen).toBe(123456)
    expect(row.currentEstimated).toBe(false)
    expect(row.currentReason).toBeNull()
  })

  it.each([
    ['実働', { workingMinutes: null, overtimeMinutes: 0, nightMinutes: 0 }],
    ['時間外', { workingMinutes: 0, overtimeMinutes: null, nightMinutes: 0 }],
    ['深夜', { workingMinutes: 0, overtimeMinutes: 0, nightMinutes: null }],
  ])('%s が空なら金額を出さない', (_label, restraint) => {
    const row = computeWageMixRow(
      { driverCd: '1', driverName: 'x', allowanceBaseYen: 0, actualPayYen: null, restraint: { ...restraint, workDays: 10 } },
      settings(),
    )
    expect(row.totalYen).toBeNull()
    expect(row.missingReason).toBe(PARTIAL_RESTRAINT_REASON)
  })

  it('揃っていれば理由は立たない', () => {
    expect(computeWageMixRow(DRIVERS[0]!, settings()).missingReason).toBeNull()
  })
})

describe('computeWageMixRow — 実支給が引けなければ推計に落とす (0 に倒さない、Refs #814)', () => {
  it('実支給が null なら 母数 + 一律残業代 ¥10,000 の推計になり、理由が立つ', () => {
    const row = computeWageMixRow({ ...DRIVERS[3]!, actualPayYen: null }, settings())
    expect(row.currentYen).toBe(571000)
    expect(row.currentEstimated).toBe(true)
    expect(row.currentReason).toBe(NO_ACTUAL_PAY_REASON)
  })

  it('★ 0 には倒さない — 実支給 ¥0 と「引けていない」は別物', () => {
    const zero = computeWageMixRow({ ...DRIVERS[3]!, actualPayYen: 0 }, settings())
    expect(zero.currentYen).toBe(0)
    expect(zero.currentEstimated).toBe(false)
    const missing = computeWageMixRow({ ...DRIVERS[3]!, actualPayYen: null }, settings())
    expect(missing.currentYen).toBe(571000)
    expect(missing.currentEstimated).toBe(true)
  })

  it('月ぜんぶが引けていないときは呼び出し側の理由に差し替わる', () => {
    const row = computeWageMixRow(
      { ...DRIVERS[0]!, actualPayYen: null, actualPayReason: '経費明細を読めていない' },
      settings(),
    )
    expect(row.currentReason).toBe('経費明細を読めていない')
  })

  it('実支給が引けていれば理由は差し替えられても立たない', () => {
    const row = computeWageMixRow({ ...DRIVERS[0]!, actualPayReason: '経費明細を読めていない' }, settings())
    expect(row.currentReason).toBeNull()
    expect(row.currentEstimated).toBe(false)
  })

  it('差は 試算 − 現状 (実支給ベース)', () => {
    const row = computeWageMixRow(DRIVERS[3]!, settings({ method: 'days' }))
    expect(row.diffYen).toBe(row.totalYen! - 572000)
  })

  it('★ 一律残業代は入力のまま — 推計に落ちた乗務員の額が入力どおり動く', () => {
    const row = computeWageMixRow({ ...DRIVERS[3]!, actualPayYen: null }, settings({ flatOvertimeYen: 25000 }))
    expect(row.currentYen).toBe(586000)
  })

  it('★ 一律残業代は実支給が引けた乗務員には 1 円も効かない', () => {
    const a = computeWageMixRow(DRIVERS[3]!, settings({ flatOvertimeYen: 10000 }))
    const b = computeWageMixRow(DRIVERS[3]!, settings({ flatOvertimeYen: 999999 }))
    expect(a.currentYen).toBe(572000)
    expect(b.currentYen).toBe(572000)
  })
})

describe('summarizeWageMix', () => {
  it('方式B の合計が資料の 旅費 ¥967,400 / 基本給 ¥1,049,200 と一致する', () => {
    const totals = summarizeWageMix(DRIVERS.map(d => computeWageMixRow(d, settings({ method: 'days' }))))
    expect(totals).toMatchObject({
      drivers: 5, computed: 5, missingDrivers: [], missingTravelYen: 0,
      allowanceBaseYen: 2764000, travelYen: 967400, baseWageYen: 1049200,
      overtimeYen: 687117, totalYen: 2703717, currentYen: 2815000, diffYen: -111283,
      estimatedDrivers: [], estimatedComputed: 0, estimatedCurrentYen: 0,
      workDays: 122,
    })
  })

  it('合計は 基本給 + 残業 + 旅費 (この不変条件を崩さない)', () => {
    const totals = summarizeWageMix(DRIVERS.map(d => computeWageMixRow(d, settings())))
    expect(totals.totalYen).toBe(totals.baseWageYen + totals.overtimeYen + totals.travelYen)
  })

  it('時間の合計も畳む', () => {
    const totals = summarizeWageMix(DRIVERS.map(d => computeWageMixRow(d, settings())))
    expect(totals.premiumHours).toBeCloseTo(639.179167, 5)
    expect(totals.statutoryHours).toBeCloseTo(962.3, 5)
  })

  it('欠測の乗務員は合計に入れず、名前と旅費を別に持つ', () => {
    const rows = [
      computeWageMixRow(DRIVERS[0]!, settings()),
      computeWageMixRow({ driverCd: '1999', driverName: '拘束なし', allowanceBaseYen: 100000, actualPayYen: null, restraint: null }, settings()),
    ]
    const totals = summarizeWageMix(rows)
    expect(totals.drivers).toBe(2)
    expect(totals.computed).toBe(1)
    expect(totals.missingDrivers).toEqual(['拘束なし'])
    expect(totals.missingTravelYen).toBe(35000)
    // 合計から外れた行でも、表に現状が出るので推計は名指しする。
    // ただし**合計には入っていない**ので、混在の額 (estimatedCurrentYen) は 0。
    expect(totals.estimatedDrivers).toEqual(['拘束なし'])
    expect(totals.estimatedComputed).toBe(0)
    expect(totals.estimatedCurrentYen).toBe(0)
    expect(totals.allowanceBaseYen).toBe(609000)
    expect(totals.travelYen).toBe(213150)
  })

  it('実支給を引けた乗務員と推計に落ちた乗務員が混ざれば、推計の側だけ名指しする', () => {
    const rows = [
      computeWageMixRow(DRIVERS[0]!, settings()),
      computeWageMixRow({ ...DRIVERS[1]!, actualPayYen: null }, settings()),
    ]
    const totals = summarizeWageMix(rows)
    expect(totals.estimatedDrivers).toEqual(['柳井　亮祐'])
    expect(totals.currentYen).toBe(619000 + 562500)
    // **混ざったなら混ざったと言えるだけの材料を持つ。**
    expect(totals.estimatedComputed).toBe(1)
    expect(totals.estimatedCurrentYen).toBe(562500)
    expect(totals.currentYen - totals.estimatedCurrentYen).toBe(619000)
  })

  it('1 人も居なければ全部 0', () => {
    expect(summarizeWageMix([])).toEqual({
      drivers: 0, computed: 0, missingDrivers: [], estimatedDrivers: [],
      estimatedComputed: 0, estimatedCurrentYen: 0, allowanceBaseYen: 0, travelYen: 0,
      baseWageYen: 0, overtimeYen: 0, totalYen: 0, currentYen: 0, diffYen: 0,
      statutoryHours: 0, premiumHours: 0, workDays: 0, missingTravelYen: 0,
    })
  })

  it('金額が出ているのに個々の列だけ null でも合計は落ちない', () => {
    const totals = summarizeWageMix([{
      driverCd: '1', driverName: 'x', allowanceBaseYen: 0, travelYen: 0,
      statutoryHours: null, premiumHours: null, workDays: null,
      baseWageYen: null, overtimeYen: null, totalYen: 10, currentYen: 0, diffYen: null,
      currentEstimated: false, currentReason: null, missingReason: null,
    }])
    expect(totals).toMatchObject({ computed: 1, totalYen: 10, baseWageYen: 0, overtimeYen: 0, workDays: 0, diffYen: 0 })
  })
})

describe('旅費率', () => {
  it('35% → 40% で各人の母数の 5% だけ増える', () => {
    const at35 = summarizeWageMix(DRIVERS.map(d => computeWageMixRow(d, settings({ travelRate: 0.35 }))))
    const at40 = summarizeWageMix(DRIVERS.map(d => computeWageMixRow(d, settings({ travelRate: 0.4 }))))
    expect(at40.travelYen - at35.travelYen).toBe(138200)
    expect(at40.travelYen).toBe(1105600)
  })

  it('ラベルは % 表記 (端数 1 桁まで)', () => {
    expect(travelRateLabel(0.35)).toBe('35%')
    expect(travelRateLabel(0.4)).toBe('40%')
    expect(travelRateLabel(0.375)).toBe('37.5%')
  })
})

describe('minWageWarning / hourlyEquivalent', () => {
  it('日額を時給に直す', () => {
    expect(hourlyEquivalent(8600)).toBe(1075)
  })

  it('方式A の単価が下限以上なら警告しない', () => {
    expect(minWageWarning(settings({ method: 'hours', hourlyRateYen: 1075 }))).toBeNull()
    expect(minWageWarning(settings({ method: 'hours', hourlyRateYen: 1400 }))).toBeNull()
  })

  it('方式A の単価が下限を下回れば警告する (クランプはしない)', () => {
    expect(minWageWarning(settings({ method: 'hours', hourlyRateYen: 1000 })))
      .toBe('単価 ¥1,000 は最低賃金 ¥1,075 を下回っています')
  })

  it('方式B の日額が下限以上なら警告しない', () => {
    expect(minWageWarning(settings({ method: 'days', dailyRateYen: 8600 }))).toBeNull()
  })

  it('方式B の日額が下限を下回れば時給換算を添えて警告する', () => {
    expect(minWageWarning(settings({ method: 'days', dailyRateYen: 8000 })))
      .toBe('日額 ¥8,000 は時給 ¥1,000 相当で、最低賃金 ¥1,075 を下回っています')
  })

  it('方式A の単価を下げても方式B の警告には効かない (方式ごとに見る)', () => {
    expect(minWageWarning(settings({ method: 'days', hourlyRateYen: 1, dailyRateYen: 8600 }))).toBeNull()
  })
})
