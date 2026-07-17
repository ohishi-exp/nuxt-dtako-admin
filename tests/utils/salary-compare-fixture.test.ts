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

  it('5 行 (乗務員 4 + 給与のみ 1) を 2026-07 として読む。警告なし', () => {
    expect(parsed.rows.map(r => r.driverCd)).toEqual(['9901', '9902', '9903', '9904', '9999'])
    expect(parsed.months).toEqual(['2026-07'])
    expect(parsed.warnings).toEqual([])
    expect(parsed.itemLabels).toEqual(['基本給', '残業手当', '深夜手当'])
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
    // 深夜手当 は suggestCategory の既定で残業扱い
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
})
