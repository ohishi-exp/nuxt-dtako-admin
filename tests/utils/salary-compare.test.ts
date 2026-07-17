/**
 * `app/utils/salary-compare.ts` のテスト (Refs #253)。
 *
 * - parseSalaryCsv: 給与明細 CSV/TSV の解析 (2025/2026 様式の差分・同名列合算・
 *   賞与行スキップ・NFKC 正規化・警告)
 * - compareSalaryMonth: wage-report との乗務員別突合と差額
 */

import { describe, it, expect } from 'vitest'
import type { WageReportRow } from '../../app/utils/restraint-wage-view'
import {
  compareSalaryMonth,
  effectiveCategory,
  mergeParsedSalaryCsv,
  parseSalaryCsv,
  splitDelimitedLine,
  suggestCategory,
  sumByCategory,
  type SalaryCsvRow,
  type SalaryItemConfig,
} from '../../app/utils/salary-compare'

// ---------------------------------------------------------------------------
// fixture: 実データ (2026 様式) を縮めたヘッダー。残業手当 が 2 列ある点・
// 空白パディング・半角カナ・【 セクション 】 見出しを実物どおり再現する。
// ---------------------------------------------------------------------------

const HEADER_2026 = [
  '社員コード', '社員名', '給与・賞与名',
  '【 勤怠 】  ', '出勤日数', '残業時間    ',
  '【 支給 】  ', '基本給', '無事故手当  ', 'ｸﾚｰﾝ手当    ', '残業手当    ',
  '休日出勤手当', '残業手当', '60H超過残業', '支給合計額  ', '課税支給額  ',
  '【 控除 】  ', '健康保険    ',
  '【 合計 】  ', '差引支給額  ',
].join(',')

function row2026(cd: string, name: string, payName: string, amounts: number[], total: number, taxable = 0): string {
  return [cd, name, payName, '0.0', '22.0', '91.0', '0.0', ...amounts.map(String), String(total), String(taxable), '0.0', '24600.0', '0.0', '316589.0'].join(',')
}

// 支給項目列: 基本給, 無事故手当, ｸﾚｰﾝ手当, 残業手当(1), 休日出勤手当, 残業手当(2), 60H超過残業
const CSV_2026 = [
  HEADER_2026,
  row2026('1239    ', '城田　秀幸', '2026年 1月', [80938, 30000, 2000, 31500, 57270, 130130, 8866], 340704),
  row2026('1240', '山田 太郎', '2026年 2月', [70000, 0, 0, 20000, 0, 50000, 0], 140000),
].join('\r\n')

describe('splitDelimitedLine', () => {
  it('クォート無しのカンマ区切りを分割する', () => {
    expect(splitDelimitedLine('a,b,,c', ',')).toEqual(['a', 'b', '', 'c'])
  })

  it('ダブルクォート内の区切り文字と "" エスケープを扱う', () => {
    expect(splitDelimitedLine('"a,b",c,"d""e"', ',')).toEqual(['a,b', 'c', 'd"e'])
  })

  it('タブ区切りを分割する', () => {
    expect(splitDelimitedLine('a\tb\tc', '\t')).toEqual(['a', 'b', 'c'])
  })
})

describe('suggestCategory / effectiveCategory', () => {
  it('残業・時間外・深夜・休日出勤を含む項目名は残業を推定する', () => {
    expect(suggestCategory('残業手当')).toBe('overtime')
    expect(suggestCategory('60H超過残業')).toBe('overtime')
    expect(suggestCategory('時間外深夜')).toBe('overtime')
    expect(suggestCategory('休日出勤手当')).toBe('overtime')
  })

  it('それ以外は基本給を推定する', () => {
    expect(suggestCategory('基本給')).toBe('base')
    expect(suggestCategory('無事故手当')).toBe('base')
  })

  it('effectiveCategory は設定があれば設定を、無ければ推定を返す', () => {
    const config: SalaryItemConfig = { items: { 無事故手当: 'overtime' } }
    expect(effectiveCategory('無事故手当', config)).toBe('overtime')
    expect(effectiveCategory('基本給', config)).toBe('base')
  })
})

describe('parseSalaryCsv (2026 様式 CSV)', () => {
  const parsed = parseSalaryCsv(CSV_2026)

  it('支給項目をヘッダー順に検出する (合計列・重複は除く)', () => {
    expect(parsed.itemLabels).toEqual([
      '基本給', '無事故手当', 'クレーン手当', '残業手当', '休日出勤手当', '60H超過残業',
    ])
  })

  it('同名列 (残業手当 ×2) は合算する', () => {
    expect(parsed.rows[0]!.amounts['残業手当']).toBe(31500 + 130130)
  })

  it('社員コード・氏名・月・支給合計額を読み取る', () => {
    const r = parsed.rows[0]!
    expect(r.driverCd).toBe('1239')
    expect(r.cdKey).toBe('1239')
    expect(r.driverName).toBe('城田 秀幸') // NFKC で全角空白は半角に
    expect(r.month).toBe('2026-01')
    expect(r.reportedTotal).toBe(340704)
    expect(parsed.rows[1]!.month).toBe('2026-02')
  })

  it('月一覧を昇順で返し、警告は無い', () => {
    expect(parsed.months).toEqual(['2026-01', '2026-02'])
    expect(parsed.warnings).toEqual([])
  })
})

describe('parseSalaryCsv (行スキップと警告)', () => {
  it('賞与行・社員コード無し行・数値でないセルを警告つきで処理する', () => {
    const csv = [
      HEADER_2026,
      row2026('1239', '城田', '2026年 1月', [1, 2, 3, 4, 5, 6, 7], 28),
      row2026('1239', '城田', '2026年夏季賞与', [1, 2, 3, 4, 5, 6, 7], 28),
      row2026('合計', '', '', [1, 2, 3, 4, 5, 6, 7], 28),
      [
        '1240', '山田', '2026年 1月', '0', '22', '91', '0',
        'abc', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0', '0',
      ].join(','),
      '9', // 社員コードだけの行 (給与・賞与名列ごと欠け)
      ',,,', // 社員コードが空の行
    ].join('\n')
    const parsed = parseSalaryCsv(csv)
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.warnings).toHaveLength(5)
    expect(parsed.warnings[0]).toContain('賞与')
    expect(parsed.warnings[1]).toContain('社員コードが数値ではない')
    expect(parsed.warnings[2]).toContain('数値でないため 0')
    expect(parsed.warnings[3]).toContain('年月形式でない')
    expect(parsed.warnings[4]).toContain('(空)')
    expect(parsed.rows[1]!.amounts['基本給']).toBe(0)
  })

  it('全角数字の年月・空セル・行末欠け (短い行) を吸収する', () => {
    const csv = [
      '社員コード,給与・賞与名,【 支給 】,基本給,残業手当,支給合計額,【 控除 】,健康保険',
      '０１２３,２０２６年 １月,,50000,,50000',
      '9,2026年 2月,,10', // 行末の列ごと欠けた行
    ].join('\n')
    const parsed = parseSalaryCsv(csv)
    const r = parsed.rows[0]!
    expect(r.driverCd).toBe('0123')
    expect(r.cdKey).toBe('123')
    expect(r.month).toBe('2026-01')
    expect(r.amounts).toEqual({ 基本給: 50000, 残業手当: 0 })
    // 社員名列が無い様式でも落ちない (このヘッダーでは列 1 が給与・賞与名)
    expect(r.driverName).toBe('2026年 1月')
    // 欠けた列は 0 扱い
    expect(parsed.rows[1]!.amounts).toEqual({ 基本給: 10, 残業手当: 0 })
    expect(parsed.rows[1]!.reportedTotal).toBe(0)
    expect(parsed.warnings).toEqual([])
  })

  it('TSV (Excel コピー) と桁区切りカンマ入り金額を解析する', () => {
    const tsv = [
      // 支給セクション内の空列 (名前なし) は項目扱いしない
      ['社員コード', '社員名', '給与・賞与名', '【 支給 】', '基本給', '', '残業手当', '支給合計額', '【 控除 】'].join('\t'),
      ['1239', '城田　秀幸', '2026年 1月', '', '80,938', '', '161,630', '242,568', ''].join('\t'),
    ].join('\n')
    const parsed = parseSalaryCsv(tsv)
    expect(parsed.itemLabels).toEqual(['基本給', '残業手当'])
    expect(parsed.rows[0]!.amounts).toEqual({ 基本給: 80938, 残業手当: 161630 })
    expect(parsed.rows[0]!.reportedTotal).toBe(242568)
  })

  it('支給合計額列が無い様式は reportedTotal を null にする', () => {
    const csv = [
      '社員コード,給与・賞与名,【 支給 】,基本給,【 控除 】',
      '1,2026年 1月,,100',
    ].join('\n')
    expect(parseSalaryCsv(csv).rows[0]!.reportedTotal).toBeNull()
  })

  it('【 支給 】より後にセクション見出しが無い様式も末尾まで項目として扱う', () => {
    const csv = [
      '社員コード,給与・賞与名,【 支給 】,基本給,課税支給額',
      '1,2026年 1月,,100,100',
    ].join('\n')
    const parsed = parseSalaryCsv(csv)
    expect(parsed.itemLabels).toEqual(['基本給'])
  })
})

describe('parseSalaryCsv (構造エラー)', () => {
  it('空入力を拒否する', () => {
    expect(() => parseSalaryCsv('')).toThrow('空です')
    expect(() => parseSalaryCsv('  \n \n')).toThrow('空です')
  })

  it('先頭列が社員コードでないヘッダーを拒否する', () => {
    expect(() => parseSalaryCsv('a,b,c\n1,2,3')).toThrow('社員コード')
  })

  it('給与・賞与名列が無いヘッダーを拒否する', () => {
    expect(() => parseSalaryCsv('社員コード,社員名\n1,2')).toThrow('給与・賞与名')
  })

  it('【 支給 】セクションが無いヘッダーを拒否する', () => {
    expect(() => parseSalaryCsv('社員コード,給与・賞与名,基本給\n1,2026年 1月,3')).toThrow('【 支給 】')
  })

  it('支給項目列が 1 つも無いヘッダーを拒否する', () => {
    expect(() => parseSalaryCsv('社員コード,給与・賞与名,【 支給 】,支給合計額,【 控除 】\n1,2026年 1月,,0'))
      .toThrow('支給項目列がありません')
  })
})

describe('mergeParsedSalaryCsv (複数取り込み)', () => {
  it('年度違いの様式を行連結・項目の初出順和集合・月の昇順ユニークで合算する', () => {
    // 2025 様式: 家畜運搬調整 あり / 60H超過残業 なし
    const a = parseSalaryCsv([
      '社員コード,給与・賞与名,【 支給 】,基本給,家畜運搬調整,残業手当,支給合計額,【 控除 】',
      '1239,2025年 12月,,70000,5000,20000,95000',
      '1240,2025年 11月,,60000,0,10000,70000',
    ].join('\n'))
    // 2026 様式: 家畜運搬調整 なし / 60H超過残業 あり
    const b = parseSalaryCsv([
      '社員コード,給与・賞与名,【 支給 】,基本給,残業手当,60H超過残業,支給合計額,【 控除 】',
      '1239,2026年 1月,,80000,30000,1000,111000',
    ].join('\n'))
    const merged = mergeParsedSalaryCsv([a, b])
    expect(merged.rows).toHaveLength(3)
    expect(merged.rows.map(r => r.month)).toEqual(['2025-12', '2025-11', '2026-01'])
    expect(merged.itemLabels).toEqual(['基本給', '家畜運搬調整', '残業手当', '60H超過残業'])
    expect(merged.months).toEqual(['2025-11', '2025-12', '2026-01'])
    expect(merged.warnings).toEqual([])
  })

  it('各取り込みの警告を連結する', () => {
    const a = parseSalaryCsv([
      '社員コード,給与・賞与名,【 支給 】,基本給,【 控除 】',
      'x,2026年 1月,,1',
    ].join('\n'))
    const merged = mergeParsedSalaryCsv([a, a])
    expect(merged.warnings).toHaveLength(2)
  })

  it('空リストは空の結果を返す', () => {
    expect(mergeParsedSalaryCsv([])).toEqual({ rows: [], itemLabels: [], months: [], warnings: [] })
  })
})

// ---------------------------------------------------------------------------
// compareSalaryMonth
// ---------------------------------------------------------------------------

function csvRow(over: Partial<SalaryCsvRow> = {}): SalaryCsvRow {
  return {
    driverCd: '1239',
    cdKey: '1239',
    driverName: '城田 秀幸',
    month: '2026-01',
    amounts: { 基本給: 80000, 残業手当: 30000 },
    reportedTotal: 110000,
    ...over,
  }
}

function reportRow(cd: string, name: string, statutory: number | null, total: number | null): WageReportRow {
  return {
    summary: { driverCd: cd, driverName: name },
    wage: {
      amounts: statutory === null ? null : { statutory },
      totalAmount: total,
    },
  } as unknown as WageReportRow
}

describe('sumByCategory', () => {
  it('実効区分で基本給と残業に集計する', () => {
    const config: SalaryItemConfig = { items: { 基本給: 'base', 残業手当: 'overtime' } }
    expect(sumByCategory(csvRow(), config)).toEqual({ base: 80000, overtime: 30000 })
  })

  it('設定が無い項目は推定区分で集計する', () => {
    expect(sumByCategory(csvRow(), { items: {} })).toEqual({ base: 80000, overtime: 30000 })
  })
})

describe('compareSalaryMonth', () => {
  const config: SalaryItemConfig = { items: {} }

  it('乗務員CD (前ゼロ・数値同値) で突合し差額を計算する', () => {
    const out = compareSalaryMonth(
      [csvRow({ driverCd: '01239', cdKey: '1239' })],
      [reportRow('1239', '城田 秀幸', 75000, 100000)],
      config,
    )
    expect(out.rows).toHaveLength(1)
    const r = out.rows[0]!
    expect(r.csvBase).toBe(80000)
    expect(r.csvOvertime).toBe(30000)
    expect(r.csvTotal).toBe(110000)
    expect(r.sysBase).toBe(75000)
    expect(r.sysOvertime).toBe(25000)
    expect(r.sysTotal).toBe(100000)
    expect(r.diffBase).toBe(5000)
    expect(r.diffOvertime).toBe(5000)
    expect(r.diffTotal).toBe(10000)
    expect(out.csvOnly).toEqual([])
    expect(out.reportOnly).toEqual([])
    expect(out.warnings).toEqual([])
  })

  it('単価未設定 (amounts null) の乗務員は計算側を null にする', () => {
    const out = compareSalaryMonth([csvRow()], [reportRow('1239', '城田 秀幸', null, null)], config)
    const r = out.rows[0]!
    expect(r.sysBase).toBeNull()
    expect(r.sysOvertime).toBeNull()
    expect(r.sysTotal).toBeNull()
    expect(r.diffBase).toBeNull()
    expect(r.diffOvertime).toBeNull()
    expect(r.diffTotal).toBeNull()
  })

  it('法定内額はあるが合計が無い場合は割増・合計の差を null にする', () => {
    const out = compareSalaryMonth([csvRow()], [reportRow('1239', '城田 秀幸', 75000, null)], config)
    const r = out.rows[0]!
    expect(r.sysBase).toBe(75000)
    expect(r.sysOvertime).toBeNull()
    expect(r.sysTotal).toBeNull()
    expect(r.diffBase).toBe(5000)
    expect(r.diffOvertime).toBeNull()
    expect(r.diffTotal).toBeNull()
  })

  it('片側にしかいない乗務員を csvOnly / reportOnly に分ける', () => {
    const out = compareSalaryMonth(
      [csvRow(), csvRow({ driverCd: '9999', cdKey: '9999', driverName: '給与のみ' })],
      [reportRow('1239', '城田 秀幸', 1, 2), reportRow('1021', '計算のみ', 1, 2)],
      config,
    )
    expect(out.rows).toHaveLength(1)
    expect(out.csvOnly).toEqual([{ driverCd: '9999', driverName: '給与のみ' }])
    expect(out.reportOnly).toEqual([{ driverCd: '1021', driverName: '計算のみ' }])
  })

  it('CSV 側の重複乗務員は後勝ち + 警告する', () => {
    const out = compareSalaryMonth(
      [csvRow({ amounts: { 基本給: 1 } }), csvRow({ amounts: { 基本給: 2 } })],
      [reportRow('1239', '城田 秀幸', 0, 0)],
      config,
    )
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('重複')
    expect(out.rows[0]!.csvBase).toBe(2)
  })
})
