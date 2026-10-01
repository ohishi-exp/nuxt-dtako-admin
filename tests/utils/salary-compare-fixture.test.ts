// 給与比較の共有 fixture テスト (Refs #268、org 方針: local-first-testing skill)
//
// 「最低賃金チェック」側の golden テスト (workers/dtako-scraper-relay/test/
// restraint-wage-golden.test.ts) と**同一の共有 fixture** (tests/fixtures/
// restraint-wage/) を使う — 給与明細 CSV は salary-2026-07.csv、wage-report 側は
// summaries.json + golden/wage-rows.json (本物の computeWageRow を通した出力)。
// 同じ入力から 2 つのタブがそれぞれの観点 (単価マスタ設定の事前チェック /
// 支払い実績の事後チェック) で計算することをテスト構造で保証する。
//
// 給与比較の計算側: 基本給(計算) = wage report の 単価マスタ × 法定時間内 (給与区分に関わらず同じ式)、
// 残業・深夜・休日(計算) = wage report の最低賃金ベースの 残業代 + 深夜の割増 + 休日労働 (Refs #1133)。
import { describe, expect, it } from 'vitest'
import {
  compareSalaryMonth,
  parseSalaryCsv,
  type SalaryItemConfig,
} from '../../app/utils/salary-compare'
import type { WageReportRow } from '../../app/utils/restraint-wage-view'
import summaries from '../fixtures/restraint-wage/summaries.json'
import golden from '../fixtures/restraint-wage/golden/wage-rows.json'
// happy-dom 環境では import.meta.url が file: URL にならず readFileSync が使えない
// ため、CSV は Vite の ?raw import で読む。
import csvText from '../fixtures/restraint-wage/salary-2026-07.csv?raw'

/** 共有 fixture から wage-report 相当の行を組み立てる (wage は golden = 本物の計算出力)。
 *
 * `pay_kubun` は**日給 (2)** — 基本給(計算)・残業・深夜・休日(計算) は給与区分に関わらず wage report の金額
 * なので値は区分で変わらない (salary-compare.test.ts が区分ごとに持つ)。月給 (1) だけ固定残業で差が消える。 */
const reportRows: WageReportRow[] = summaries.map(s => ({
  summary: s as unknown as WageReportRow['summary'],
  fetched_at: null,
  last_verified_at: null,
  pay_kubun: 2,
  wage: golden.find(g => g.driverCd === s.driverCd)!.wage as unknown as WageReportRow['wage'],
}))

const NO_CONFIG: SalaryItemConfig = { items: {} }

describe('parseSalaryCsv (共有 fixture)', () => {
  const parsed = parseSalaryCsv(csvText)

  it('5 行 (乗務員 4 + 給与のみ 1) を 2026-08 (支給月ラベル = 勤務月 2026-07 の翌月) として読む。警告なし', () => {
    expect(parsed.rows.map(r => r.driverCd)).toEqual(['9901', '9902', '9903', '9904', '9999'])
    expect(parsed.months).toEqual(['2026-08'])
    expect(parsed.warnings).toEqual([])
    expect(parsed.itemLabels).toEqual(['基本給', '残業手当', '深夜手当', '通勤手当', '住宅手当'])
  })

  it('【 補助 】単価: 空セルは「単価なし」(null)', () => {
    const byCd = Object.fromEntries(parsed.rows.map(r => [r.driverCd, r]))
    expect(byCd['9901']!.rates).toEqual({ base: 11060, overtime: 1750 })
    expect(byCd['9904']!.rates).toEqual({ base: null, overtime: null })
  })
})

describe('compareSalaryMonth (共有 fixture)', () => {
  const parsed = parseSalaryCsv(csvText)
  const result = compareSalaryMonth(parsed.rows, reportRows, NO_CONFIG, '2023-04')
  const byCd = Object.fromEntries(result.rows.map(r => [r.driverCd, r]))
  const goldenByCd = Object.fromEntries(golden.map(g => [g.driverCd, g.wage]))

  it('突合: 4 乗務員が一致、9999 は csvOnly、reportOnly なし', () => {
    expect(result.rows).toHaveLength(4)
    expect(result.csvOnly.map(d => d.driverCd)).toEqual(['9999'])
    expect(result.reportOnly).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('計算側: 基本給 = golden の法定時間内の金額、残業・深夜・休日 = golden の最低賃金ベースの 残業代 + 深夜の割増 + 休日労働 (明細の単価は使わない): 9901', () => {
    const row = byCd['9901']!
    // 深夜手当 は suggestCategory の既定で残業扱い。通勤手当 (excluded)・
    // 住宅手当 (minwage-only) は基本給計に混入しない (Refs #278)
    expect(row.csvBase).toBe(221200)
    expect(row.csvOvertime).toBe(39200 + 1750)
    // sysBase = wage report の 単価マスタ × 法定時間内 (golden の amounts.statutory)、overtimeMinutes = wage report の 時間外+時間外深夜+週40超
    expect(row.sysBase).toBe(goldenByCd['9901']!.amounts!.statutory)
    expect(row.overtimeMinutes).toBe(1200 + 120)
    expect(row.overtimeMinutes).toBe(goldenByCd['9901']!.overtimeMinutes + goldenByCd['9901']!.nightOvertimeMinutes)
    const g = goldenByCd['9901']!
    // 残業・深夜・休日(計算) = golden の最低賃金ベースの 4 欄の和。9901 は法定時間内の深夜 5h (割増 1,195 円) が在り、休日は 0
    expect(g.minWageNightPay).toBe(1195)
    expect(g.minWageHolidayPay).toBe(0)
    expect(row.sysOvertime).toBe(g.minWageOvertimePay! + g.minWageNightOvertimePay! + g.minWageNightPay! + g.minWageHolidayPay!)
    expect(row.sysOvertimeParts).toEqual({ overtime: g.minWageOvertimePay, nightOvertime: g.minWageNightOvertimePay, night: 1195, holiday: 0 })
    expect(row.premiumMinutes).toEqual({ overtime: 1200 + 120, night: g.minutes.night, holiday: 0 })
    // 明細単価 1750 円/h × 22h = 38500 や 単価マスタ由来の actualOvertimePay (39200) は sys 列に混ざらない
    expect(row.sysOvertime).not.toBe(38500)
    expect(row.sysOvertime).not.toBe(g.actualOvertimePay)
    expect(row.sysTotal).toBe(row.sysBase! + row.sysOvertime!)
    expect(row.diffOvertime).toBe(row.csvOvertime - row.sysOvertime!)
    expect(row.diffBase).toBe(row.csvBase - row.sysBase!)
  })

  it('単価マスタ未設定 (9904) は基本給(計算) と総支給(計算) が null。明細の単価が無くても 残業・深夜・休日(計算) は最低賃金ベースで出る (残業・深夜・休日が 0 なら 0)', () => {
    const row = byCd['9904']!
    expect(row.sysBase).toBeNull()
    expect(row.diffBase).toBeNull()
    expect(row.sysTotal).toBeNull()
    expect(row.diffTotal).toBeNull()
    expect(row.sysOvertime).toBe(0)
    expect(row.diffOvertime).toBe(row.csvOvertime)
  })

  it('残業時間は golden (wage report) の 通常+深夜 そのまま。残業・深夜・休日(計算) も golden の最低賃金ベースの 4 欄の和と同じ値', () => {
    for (const cd of ['9901', '9902', '9903', '9904']) {
      const row = byCd[cd]!
      const wage = goldenByCd[cd]!
      expect(row.overtimeMinutes).toBe(wage.overtimeMinutes + wage.nightOvertimeMinutes)
      expect(row.wageRowOutdated).toBe(false)
      expect(row.sysOvertime).toBe(
        wage.minWageOvertimePay! + wage.minWageNightOvertimePay! + wage.minWageNightPay! + wage.minWageHolidayPay!,
      )
    }
  })

  it('9903 (月60h超): 支払われた残業代が最低賃金ベースの残業代を下回る (差が負)', () => {
    const row = byCd['9903']!
    expect(row.csvOvertime).toBe(120000)
    expect(row.sysOvertime).not.toBeNull()
    expect(row.diffOvertime).toBe(120000 - row.sysOvertime!)
    expect(row.diffOvertime!).toBeLessThan(0)
  })

  it('区分設定で 深夜手当 を基本給扱いに変えると集計が移る', () => {
    const config: SalaryItemConfig = { items: { 深夜手当: 'base' } }
    const row = compareSalaryMonth(parsed.rows, reportRows, config, '2023-04').rows
      .find(r => r.driverCd === '9901')!
    expect(row.csvBase).toBe(221200 + 1750)
    expect(row.csvOvertime).toBe(39200)
  })

  // ---- 5 区分の集計と 基礎単価・労基法37条チェック (Refs #278) ----

  it('5 区分の推定既定: 通勤手当は両方除外、住宅手当は最低賃金のみ算入 (9901)', () => {
    const row = byCd['9901']!
    // 支給計は excluded 含む全項目 → 支給合計額列と一致
    expect(row.csvTotal).toBe(287150)
    expect(row.csvReportedTotal).toBe(287150)
    // 割増基礎 (37条): 基本給のみ (通勤・住宅は不算入)
    expect(row.csvPremiumBase).toBe(221200)
    expect(row.csvPremiumBaseItems).toEqual([{ label: '基本給', amount: 221200 }])
    // 最低賃金の対象 (4条3項): 基本給 + 住宅手当 (通勤手当は除外)
    expect(row.csvMinWageEligible).toBe(221200 + 20000)
    expect(row.csvMinWageEligibleItems).toEqual([
      { label: '基本給', amount: 221200 },
      { label: '住宅手当', amount: 20000 },
    ])
  })

  // 37条の基礎単価 = max(割増基礎 ÷ golden の法定時間内, golden の最低賃金)、理論値 = 残業・深夜・休日(計算) × 基礎単価 ÷ 最低賃金
  const reverseRate = (cd: string, premium: number) => premium / (goldenByCd[cd]!.minutes.statutory / 60)
  const minWageOf = (cd: string) => goldenByCd[cd]!.minWage!.rate

  it('基礎単価 = 割増基礎算入計 ÷ golden の法定時間内 (9901 は逆算が最低賃金以上 → 逆算を採用、理論値は 残業・深夜・休日(計算) に比例)', () => {
    const row = byCd['9901']!
    expect(row.baseRateActual).toBe(reverseRate('9901', 221200))
    expect(row.baseRateActual!).toBeGreaterThan(minWageOf('9901'))
    expect(row.baseRateBasis).toMatchObject({ kind: 'days', floored: false, none: null })
    expect(row.baseRateOvertimePay).toBe(Math.round(row.sysOvertime! * row.baseRateActual! / minWageOf('9901')))
    // csvOvertime = 残業手当 39200 + 通常深夜の 深夜手当 1750 = 40950。理論値も 深夜の割増 (1,195 × 1,400 ÷ 956 = 1,750) を含むので
    // ちょうど同額になる (深夜を足す前は理論値が 39,200 で、深夜手当のぶんだけ明細が上回って見えていた)
    expect(row.baseRateOvertimePay).toBe(39200 + 1750)
    expect(row.diffCsvVsBaseRateOvertime).toBe(row.csvOvertime - row.baseRateOvertimePay!)
    expect(row.diffCsvVsBaseRateOvertime).toBe(0)
  })

  it('9902: 逆算の基礎単価が最低賃金を下回る → 最低賃金を採用 (通勤手当を除外した最低賃金算入分で割れが見える)。理論値 = 残業・深夜・休日(計算)', () => {
    const row = byCd['9902']!
    expect(row.baseRateBasis.reverse).toBe(reverseRate('9902', 144000))
    expect(row.baseRateBasis.reverse!).toBeLessThan(minWageOf('9902'))
    expect(row.baseRateBasis.floored).toBe(true)
    expect(row.baseRateActual).toBe(minWageOf('9902'))
    expect(row.baseRateOvertimePay).toBe(row.sysOvertime)
    expect(row.diffCsvVsBaseRateOvertime).toBe(row.diffOvertime)
    // 通勤手当 5000 は最低賃金の分子に混入しない (混入すると割れ見逃し方向)
    expect(row.csvMinWageEligible).toBe(144000)
    expect(row.csvTotal).toBe(149000)
  })

  it('9903 (月60h超): 逆算を採用し、理論値は 残業・深夜・休日(計算) × 基礎単価 ÷ 最低賃金 (60h 超の係数は wage report の値に入っている)。支払が下回る', () => {
    const row = byCd['9903']!
    expect(row.baseRateActual).toBe(reverseRate('9903', 76800))
    expect(row.baseRateBasis.floored).toBe(false)
    expect(row.baseRateOvertimePay).toBe(Math.round(row.sysOvertime! * row.baseRateActual! / minWageOf('9903')))
    expect(row.diffCsvVsBaseRateOvertime).toBe(120000 - row.baseRateOvertimePay!)
    expect(row.diffCsvVsBaseRateOvertime!).toBeLessThan(0)
  })

  it('9904 (単価マスタ未設定): 基礎単価は明細と golden の法定時間内から出る (残業 0 なら理論値 0)', () => {
    const row = byCd['9904']!
    expect(row.baseRateActual).toBe(Math.max(reverseRate('9904', 152960), minWageOf('9904')))
    expect(row.baseRateOvertimePay).toBe(0)
    expect(row.diffCsvVsBaseRateOvertime).toBe(0)
  })

  it('区分設定で 住宅手当 を両方除外に変えると最低賃金算入分から抜ける', () => {
    const config: SalaryItemConfig = { items: { 住宅手当: 'excluded' } }
    const row = compareSalaryMonth(parsed.rows, reportRows, config, '2023-04').rows
      .find(r => r.driverCd === '9901')!
    expect(row.csvMinWageEligible).toBe(221200)
    expect(row.csvPremiumBase).toBe(221200)
    expect(row.csvTotal).toBe(287150) // 支給計は区分に依らない
  })
})
