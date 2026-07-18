// 給与比較の共有 fixture テスト (Refs #268、org 方針: local-first-testing skill)
//
// 「最低賃金チェック」側の golden テスト (workers/dtako-scraper-relay/test/
// restraint-wage-golden.test.ts) と**同一の共有 fixture** (tests/fixtures/
// restraint-wage/) を使う — 給与明細 CSV は salary-2026-07.csv、wage-report 側は
// summaries.json + golden/wage-rows.json (本物の computeWageRow を通した出力)。
// 同じ入力から 2 つのタブがそれぞれの観点 (単価マスタ設定の事前チェック /
// 支払い実績の事後チェック) で計算することをテスト構造で保証する。
//
// 給与比較の計算側 (sysBase/sysOvertime) は**給与明細の【 補助 】単価基準**で
// 単価マスタを参照しない (タブ責務分離、docs/plan-268-wage-tab-separation.md)。
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

/** 共有 fixture から wage-report 相当の行を組み立てる (wage は golden = 本物の計算出力)。 */
const reportRows: WageReportRow[] = summaries.map(s => ({
  summary: s as unknown as WageReportRow['summary'],
  fetched_at: null,
  last_verified_at: null,
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
  const result = compareSalaryMonth(parsed.rows, reportRows, NO_CONFIG)
  const byCd = Object.fromEntries(result.rows.map(r => [r.driverCd, r]))
  const goldenByCd = Object.fromEntries(golden.map(g => [g.driverCd, g.wage]))

  it('突合: 4 乗務員が一致、9999 は csvOnly、reportOnly なし', () => {
    expect(result.rows).toHaveLength(4)
    expect(result.csvOnly.map(d => d.driverCd)).toEqual(['9999'])
    expect(result.reportOnly).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('計算側は給与明細の【 補助 】単価基準 (単価マスタ非参照): 9901', () => {
    const row = byCd['9901']!
    // 深夜手当 は suggestCategory の既定で残業扱い。通勤手当 (excluded)・
    // 住宅手当 (minwage-only) は基本給計に混入しない (Refs #278)
    expect(row.csvBase).toBe(221200)
    expect(row.csvOvertime).toBe(39200 + 1750)
    // sysBase = 基本単価(日額) × 稼働日数、sysOvertime = 残業単価(時給) × (時間外+時間外深夜)
    expect(row.sysBase).toBe(11060 * 20)
    expect(row.sysOvertimeMinutes).toBe(1200 + 120)
    expect(row.sysOvertime).toBe(Math.round((1750 * (1200 + 120)) / 60))
    // 単価マスタの時給 1400 円由来の値 (golden の actualOvertimePay = 39200) は
    // sys 列に混ざらない — 明細単価 1750 円/h × 22h = 38500 になるはず
    expect(row.sysOvertime).toBe(38500)
    expect(row.sysOvertime).not.toBe(goldenByCd['9901']!.actualOvertimePay)
    expect(row.diffBase).toBe(row.csvBase - row.sysBase!)
  })

  it('CSV 単価なし (9904) は sys 列が null (按分計算しない)', () => {
    const row = byCd['9904']!
    expect(row.sysBase).toBeNull()
    expect(row.sysOvertime).toBeNull()
    expect(row.sysTotal).toBeNull()
    expect(row.diffBase).toBeNull()
    expect(row.diffOvertime).toBeNull()
    expect(row.diffTotal).toBeNull()
  })

  it('残業(最低賃金) は golden の理論値 (通常+深夜) と同じ値・同じ時間軸', () => {
    for (const cd of ['9901', '9902', '9903', '9904']) {
      const row = byCd[cd]!
      const wage = goldenByCd[cd]!
      expect(row.minWageOvertimeMinutes).toBe(wage.overtimeMinutes + wage.nightOvertimeMinutes)
      expect(row.minWageOvertimePay).toBe(
        wage.minWageOvertimePay === null || wage.minWageNightOvertimePay === null
          ? null
          : wage.minWageOvertimePay + wage.minWageNightOvertimePay,
      )
    }
  })

  it('9903 (月60h超): 支払われた残業代が最低賃金理論値を下回る (差が負)', () => {
    const row = byCd['9903']!
    expect(row.csvOvertime).toBe(120000)
    expect(row.minWageOvertimePay).not.toBeNull()
    expect(row.diffCsvVsMinWageOvertime).toBe(120000 - row.minWageOvertimePay!)
    expect(row.diffCsvVsMinWageOvertime!).toBeLessThan(0)
  })

  it('9904 (単価マスタ未設定): 最低賃金理論値は単価マスタと独立に出る (残業 0 なら 0)', () => {
    const row = byCd['9904']!
    expect(row.minWageOvertimePay).toBe(0)
    expect(row.diffCsvVsMinWageOvertime).toBe(0)
  })

  it('区分設定で 深夜手当 を基本給扱いに変えると集計が移る', () => {
    const config: SalaryItemConfig = { items: { 深夜手当: 'base' } }
    const row = compareSalaryMonth(parsed.rows, reportRows, config).rows
      .find(r => r.driverCd === '9901')!
    expect(row.csvBase).toBe(221200 + 1750)
    expect(row.csvOvertime).toBe(39200)
  })

  // ---- 5 区分の集計と 基礎単価(実績)・労基法37条チェック (Refs #278) ----

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

  it('基礎単価(実績) = 割増基礎算入計 ÷ 法定内時間 — 単価マスタとの検算 (9901: 1400 円)', () => {
    const row = byCd['9901']!
    expect(row.statutoryMinutes).toBe(9480) // 158h
    expect(row.baseRateActual).toBe(221200 / 158) // = 1400、単価マスタの時給と一致
    expect(row.baseRateActual).toBe(goldenByCd['9901']!.hourlyRate)
  })

  it('残業(基礎単価) 理論値 (37条): 9901 は支払残業手当がちょうど理論値どおり', () => {
    const row = byCd['9901']!
    // 22h×1400×1.25 + 深夜 2h×1400×0.25 = 38500 + 700 = 39200 (= 残業手当)
    expect(row.baseRateOvertimePay).toBe(39200)
    // csvOvertime には通常深夜の 深夜手当 1750 も入るため差は +1750 (適法)
    expect(row.diffCsvVsBaseRateOvertime).toBe(40950 - 39200)
  })

  it('9902: 基礎単価(実績) 900 円 — 通勤手当を除外した最低賃金算入分で割れが見える', () => {
    const row = byCd['9902']!
    expect(row.baseRateActual).toBe(144000 / 160) // = 900 < 最低賃金 956
    // 通勤手当 5000 は最低賃金の分子に混入しない (混入すると割れ見逃し方向)
    expect(row.csvMinWageEligible).toBe(144000)
    expect(row.csvTotal).toBe(149000)
  })

  it('9903 (月60h超): 支払残業代が基礎単価ベースの37条理論値を下回る (主判定が負)', () => {
    const row = byCd['9903']!
    expect(row.baseRateActual).toBe(76800 / 80) // = 960 = 単価マスタと一致
    // 60h×960×1.25 + 40h×960×1.5 = 72000 + 57600 = 129600
    expect(row.baseRateOvertimePay).toBe(129600)
    expect(row.diffCsvVsBaseRateOvertime).toBe(120000 - 129600)
    expect(row.diffCsvVsBaseRateOvertime!).toBeLessThan(0)
    // 絶対下限 (最低賃金 956 円ベース 129060) も割れている
    expect(row.diffCsvVsMinWageOvertime!).toBeLessThan(0)
  })

  it('9904 (単価マスタ未設定): 基礎単価(実績) は明細から出る (残業 0 なら理論値 0)', () => {
    const row = byCd['9904']!
    expect(row.baseRateActual).toBe(152960 / 160) // = 956
    expect(row.baseRateOvertimePay).toBe(0)
    expect(row.diffCsvVsBaseRateOvertime).toBe(0)
  })

  it('区分設定で 住宅手当 を両方除外に変えると最低賃金算入分から抜ける', () => {
    const config: SalaryItemConfig = { items: { 住宅手当: 'excluded' } }
    const row = compareSalaryMonth(parsed.rows, reportRows, config).rows
      .find(r => r.driverCd === '9901')!
    expect(row.csvMinWageEligible).toBe(221200)
    expect(row.csvPremiumBase).toBe(221200)
    expect(row.csvTotal).toBe(287150) // 支給計は区分に依らない
  })
})
