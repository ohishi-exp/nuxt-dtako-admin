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
  compareCompanyLabel,
  compareSalaryMonth,
  computeSysBase,
  mergeSalaryCsvRows,
  computeOvertimePayAtRate,
  effectiveCategory,
  mergeParsedSalaryCsv,
  normalizeNameKey,
  overtimeHoursComparison,
  parseSalaryCsv,
  resolveCdKey,
  salaryCdMapKey,
  splitDelimitedLine,
  suggestCategory,
  suggestCdMapEntries,
  sumByCategory,
  type SalaryCdMap,
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
  '【 補助 】  ', '残業単価    ', '基本単価    ',
  '【 合計 】  ', '差引支給額  ',
].join(',')

function row2026(cd: string, name: string, payName: string, amounts: number[], total: number, taxable = 0): string {
  return [cd, name, payName, '0.0', '22.0', '91.0', '0.0', ...amounts.map(String), String(total), String(taxable), '0.0', '24600.0', '0.0', '1430', '3679', '0.0', '316589.0'].join(',')
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

  it('住宅・別居・子女教育は最低賃金のみ算入を推定する (Refs #278)', () => {
    expect(suggestCategory('住宅手当')).toBe('minwage-only')
    expect(suggestCategory('別居手当')).toBe('minwage-only')
    expect(suggestCategory('子女教育手当')).toBe('minwage-only')
  })

  it('精勤・皆勤は割増基礎のみ算入を推定する', () => {
    expect(suggestCategory('精勤手当')).toBe('premium-base-only')
    expect(suggestCategory('皆勤手当')).toBe('premium-base-only')
  })

  it('通勤・家族・賞与・臨時は両方除外を推定する', () => {
    expect(suggestCategory('通勤手当')).toBe('excluded')
    expect(suggestCategory('家族手当')).toBe('excluded')
    expect(suggestCategory('賞与')).toBe('excluded')
    expect(suggestCategory('臨時給与')).toBe('excluded')
  })

  it('それ以外 (職務・無事故手当等) は基本給を推定する (割増基礎に算入必須)', () => {
    expect(suggestCategory('基本給')).toBe('base')
    expect(suggestCategory('無事故手当')).toBe('base')
    expect(suggestCategory('職務手当')).toBe('base')
  })

  it('effectiveCategory は設定があれば設定を、無ければ推定を返す (旧 2 区分の保存値も有効)', () => {
    const config: SalaryItemConfig = { items: { 無事故手当: 'overtime', 通勤手当: 'base' } }
    expect(effectiveCategory('無事故手当', config)).toBe('overtime')
    expect(effectiveCategory('基本給', config)).toBe('base')
    // 旧 2 区分時代に 'base' 保存済みの項目は推定 (excluded) より設定が勝つ
    expect(effectiveCategory('通勤手当', config)).toBe('base')
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

  it('company 引数を渡すと全行にその会社ラベルをスタンプする (省略時は空文字、Refs #253)', () => {
    expect(parsed.rows.every(r => r.company === '')).toBe(true)
    const withCompany = parseSalaryCsv(CSV_2026, '株式会社')
    expect(withCompany.rows.every(r => r.company === '株式会社')).toBe(true)
  })

  it('【 補助 】の基本単価・残業単価を読み取る', () => {
    expect(parsed.rows[0]!.rates).toEqual({ base: 3679, overtime: 1430 })
  })
})

describe('parseSalaryCsv (単価列)', () => {
  it('単価列が無い様式は null、0 の単価も null にする', () => {
    const noRates = parseSalaryCsv([
      '社員コード,給与・賞与名,【 支給 】,基本給,【 控除 】',
      '1,2026年 1月,,100',
    ].join('\n'))
    expect(noRates.rows[0]!.rates).toEqual({ base: null, overtime: null })

    const zeroRate = parseSalaryCsv([
      '社員コード,給与・賞与名,【 支給 】,基本給,【 控除 】,健康保険,【 補助 】,残業単価,基本単価',
      '1,2026年 1月,,100,,0,,0,3679',
    ].join('\n'))
    expect(zeroRate.rows[0]!.rates).toEqual({ base: 3679, overtime: null })
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
    expect(parsed.warnings).toHaveLength(4)
    expect(parsed.warnings[0]).toContain('社員コードが数値ではない')
    expect(parsed.warnings[1]).toContain('数値でないため 0')
    expect(parsed.warnings[2]).toContain('(空)')
    // 年月形式でない行 (賞与等) は名前×件数に集約して 1 警告
    expect(parsed.warnings[3]).toContain('年月形式でない 2 行をスキップ')
    expect(parsed.warnings[3]).toContain('2026年夏季賞与 ×1')
    expect(parsed.warnings[3]).toContain('空 ×1')
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
    company: '',
    driverName: '城田 秀幸',
    month: '2026-01',
    amounts: { 基本給: 80000, 残業手当: 30000 },
    reportedTotal: 110000,
    rates: { base: null, overtime: null },
    ...over,
  }
}

function reportRow(
  cd: string,
  name: string,
  over: {
    workDays?: number
    workingMinutes?: number | null
    overtimeMinutes?: number | null
    overtimeNightMinutes?: number | null
    breakMinutes?: number | null
    drivingMinutes?: number | null
    statutoryMinutes?: number
    /** 給与区分 (Refs #429)。**既定は日給 (2)** — 従来の `単価 × 稼働日数` を
     * 前提にしている既存ケースの意図をそのまま保つため。 */
    payKubun?: number | null
    /** 休暇の日数集計 (Refs #433)。タイムカード由来の行だけが持つ。 */
    leaveCounts?: WageReportRow['summary']['leaveCounts']
    /** 打刻エラーの日数 (Refs #433)。 */
    punchErrorDays?: number
  } = {},
): WageReportRow {
  return {
    summary: {
      driverCd: cd,
      driverName: name,
      workDays: over.workDays ?? 0,
      workingMinutes: over.workingMinutes === undefined ? 0 : over.workingMinutes,
      overtimeMinutes: over.overtimeMinutes === undefined ? 0 : over.overtimeMinutes,
      overtimeNightMinutes: over.overtimeNightMinutes === undefined ? 0 : over.overtimeNightMinutes,
      breakMinutes: over.breakMinutes === undefined ? 0 : over.breakMinutes,
      drivingMinutes: over.drivingMinutes === undefined ? 0 : over.drivingMinutes,
      leaveCounts: over.leaveCounts,
      punchErrorDays: over.punchErrorDays,
    },
    pay_kubun: over.payKubun === undefined ? 2 : over.payKubun,
    // 残業(最低賃金) 列の素材 (wage-report の wage 側)。単体テストでは最低賃金
    // 未設定 (null)・法定内 0 分を既定とし、実データ相当の値は共有 fixture テスト
    // (salary-compare-fixture.test.ts) が golden 経由で検証する。
    wage: {
      minutes: { statutory: over.statutoryMinutes ?? 0 },
      overtimeMinutes: over.overtimeMinutes ?? 0,
      nightOvertimeMinutes: over.overtimeNightMinutes ?? 0,
      minWageOvertimePay: null,
      minWageNightOvertimePay: null,
    },
  } as unknown as WageReportRow
}

describe('computeSysBase (給与区分による分岐、Refs #429)', () => {
  it('日給 (2) は 日額 × 稼働日数', () => {
    expect(computeSysBase(11060, 2, 20, 9600)).toBe(221200)
  })

  it('時給 (3) は 時給 × 実働時間 (分は 60 で割って円未満四捨五入)', () => {
    // 1,031 円 × 192h08m (11528 分) = 198,089.46… → 198,089
    expect(computeSysBase(1031, 3, 24, 11528)).toBe(198089)
  })

  it('月給 (1) は null — 月額に稼働日数を掛けても実額に対応しない', () => {
    // これが 110,000 × 24 = 2,640,000 と表示されていた壊れ方 (実データ、谷西)
    expect(computeSysBase(110000, 1, 24, 11528)).toBeNull()
  })

  it('その他 (4)・未設定 (0)・不明 (null) はすべて null に倒す', () => {
    // 既定を日給にすると、月給者へ日額計算を掛ける今回の壊れ方が再発する
    expect(computeSysBase(11060, 4, 20, 9600)).toBeNull()
    expect(computeSysBase(11060, 0, 20, 9600)).toBeNull()
    expect(computeSysBase(11060, null, 20, 9600)).toBeNull()
  })

  it('単価が無ければ区分に関わらず null (従来どおり「単価なし」)', () => {
    expect(computeSysBase(null, 2, 20, 9600)).toBeNull()
    expect(computeSysBase(null, 3, 20, 9600)).toBeNull()
  })

  it('稼働 0 日・実働 0 分でも 0 を返す (null と区別する)', () => {
    expect(computeSysBase(11060, 2, 0, 0)).toBe(0)
    expect(computeSysBase(1031, 3, 0, 0)).toBe(0)
  })
})

describe('compareSalaryMonth — 給与区分 (Refs #429)', () => {
  const config: SalaryItemConfig = { items: { 基本給: 'base', 残業手当: 'overtime' } }

  it('月給者は基本給の計算列と差分を出さない (実額だけ残る)', () => {
    const csv = csvRow({ driverCd: '1380', cdKey: '1380', driverName: '谷西 由恵', amounts: { 基本給: 165000 }, rates: { base: 110000, overtime: null } })
    const [row] = compareSalaryMonth([csv], [reportRow('1380', '谷西 由恵', { workDays: 24, payKubun: 1 })], config).rows
    expect(row!.csvBase).toBe(165000)
    expect(row!.sysBase).toBeNull()
    expect(row!.diffBase).toBeNull()
    expect(row!.sysTotal).toBeNull()
    expect(row!.diffTotal).toBeNull()
  })

  it('時給者は実働時間で計算する', () => {
    const csv = csvRow({ driverCd: '91', cdKey: '91', driverName: '時給 太郎', amounts: { 基本給: 200000 }, rates: { base: 1031, overtime: null } })
    const [row] = compareSalaryMonth([csv], [reportRow('91', '時給 太郎', { workDays: 24, workingMinutes: 11528, payKubun: 3 })], config).rows
    expect(row!.sysBase).toBe(198089)
    expect(row!.diffBase).toBe(200000 - 198089)
  })

  it('時給者の実働が null (theearth CSV の欠損) でも 0 として扱う', () => {
    const csv = csvRow({ driverCd: '91', cdKey: '91', driverName: '時給 太郎', amounts: { 基本給: 200000 }, rates: { base: 1031, overtime: null } })
    const [row] = compareSalaryMonth([csv], [reportRow('91', '時給 太郎', { workingMinutes: null, payKubun: 3 })], config).rows
    expect(row!.sysBase).toBe(0)
  })

  it('区分が引けない行 (社員マスタ未取り込み) も計算列を出さない', () => {
    const csv = csvRow({ driverCd: '1', cdKey: '1', driverName: '未取込 太郎', amounts: { 基本給: 100000 }, rates: { base: 5000, overtime: null } })
    const [row] = compareSalaryMonth([csv], [reportRow('1', '未取込 太郎', { workDays: 20, payKubun: null })], config).rows
    expect(row!.sysBase).toBeNull()
  })
})

describe('sumByCategory', () => {
  it('実効区分で 5 区分に集計し、内訳を積む', () => {
    const config: SalaryItemConfig = { items: { 基本給: 'base', 残業手当: 'overtime' } }
    const out = sumByCategory(csvRow(), config)
    expect(out.buckets['base']).toEqual({ total: 80000, items: [{ label: '基本給', amount: 80000 }] })
    expect(out.buckets['overtime']).toEqual({ total: 30000, items: [{ label: '残業手当', amount: 30000 }] })
    expect(out.buckets['minwage-only']).toEqual({ total: 0, items: [] })
    expect(out.total).toBe(110000)
  })

  it('設定が無い項目は推定区分で集計する', () => {
    expect(sumByCategory(csvRow(), { items: {} }).buckets['base'].total).toBe(80000)
    expect(sumByCategory(csvRow(), { items: {} }).buckets['overtime'].total).toBe(30000)
  })

  it('割増基礎 = base + premium-base-only、最低賃金 = base + minwage-only、支給計は excluded 含む全項目', () => {
    const row = csvRow({
      amounts: { 基本給: 100000, 精勤手当: 10000, 住宅手当: 20000, 通勤手当: 5000, 残業手当: 30000 },
    })
    const out = sumByCategory(row, { items: {} })
    expect(out.premiumBase).toEqual({
      total: 110000,
      items: [{ label: '基本給', amount: 100000 }, { label: '精勤手当', amount: 10000 }],
    })
    expect(out.minWageEligible).toEqual({
      total: 120000,
      items: [{ label: '基本給', amount: 100000 }, { label: '住宅手当', amount: 20000 }],
    })
    expect(out.buckets['excluded'].total).toBe(5000)
    expect(out.total).toBe(165000)
  })
})

describe('computeOvertimePayAtRate (労基法37条、worker computeMinWageOvertimePay と同一ロジック)', () => {
  it('月60h 以内は 1.25 倍', () => {
    expect(computeOvertimePayAtRate(20 * 60, 0, 1000)).toBe(25000)
  })

  it('月60h 超過分は 1.5 倍に切り替わる', () => {
    expect(computeOvertimePayAtRate(100 * 60, 0, 1000)).toBe(60 * 1250 + 40 * 1500) // 135,000
  })

  it('深夜分は 60h 判定と独立に常時 +0.25 倍を上乗せする', () => {
    // 70h 全部が深夜: 時間外軸 60h×1.25 + 10h×1.5、深夜軸 70h×0.25
    expect(computeOvertimePayAtRate(70 * 60, 70 * 60, 1000)).toBe(75000 + 15000 + 17500)
  })

  it('円未満は四捨五入する', () => {
    expect(computeOvertimePayAtRate(90, 0, 1401)).toBe(Math.round(1.5 * 1401 * 1.25)) // 2,627
  })
})

describe('overtimeHoursComparison (タイムカード表示用、Refs #441)', () => {
  it('基礎単価があれば給与の残業額を時間へ逆算する', () => {
    // 25,000円 ÷ 1,000円/h × 60 = 1,500分
    const c = overtimeHoursComparison({ sysOvertimeMinutes: 1200, csvOvertime: 25000, baseRateActual: 1000 })
    expect(c.restraintMinutes).toBe(1200)
    expect(c.paidMinutes).toBe(1500)
    expect(c.diffMinutes).toBe(1200 - 1500) // 打刻より給与換算の方が多い (割増を戻していないため)
  })

  it('差は 拘束 − 給与換算 (正 = 打刻の方が多い = 未払いの疑い)', () => {
    const c = overtimeHoursComparison({ sysOvertimeMinutes: 2000, csvOvertime: 10000, baseRateActual: 1000 })
    expect(c.paidMinutes).toBe(600)
    expect(c.diffMinutes).toBe(1400)
  })

  it('基礎単価が null なら支給側は計算不能 (null)', () => {
    const c = overtimeHoursComparison({ sysOvertimeMinutes: 1200, csvOvertime: 25000, baseRateActual: null })
    expect(c.paidMinutes).toBeNull()
    expect(c.diffMinutes).toBeNull()
  })

  it('基礎単価が 0 以下でも計算不能 (0除算を避ける)', () => {
    const c = overtimeHoursComparison({ sysOvertimeMinutes: 1200, csvOvertime: 25000, baseRateActual: 0 })
    expect(c.paidMinutes).toBeNull()
  })

  it('給与の残業計上額が 0 なら支給分は 0 分 (全額が未払いとして差に出る)', () => {
    const c = overtimeHoursComparison({ sysOvertimeMinutes: 1200, csvOvertime: 0, baseRateActual: 1000 })
    expect(c.paidMinutes).toBe(0)
    expect(c.diffMinutes).toBe(1200)
  })

  it('分未満は四捨五入する', () => {
    const c = overtimeHoursComparison({ sysOvertimeMinutes: 0, csvOvertime: 1000, baseRateActual: 1401 })
    expect(c.paidMinutes).toBe(Math.round((1000 / 1401) * 60)) // 43
  })
})

describe('salaryCdMapKey / normalizeNameKey / resolveCdKey', () => {
  it('前ゼロ除去 + 氏名の空白全除去でキーを作る', () => {
    expect(salaryCdMapKey('01427', '中村　一由')).toBe('1427|中村一由')
    expect(normalizeNameKey(' 城田  秀幸 ')).toBe('城田秀幸')
  })

  it('会社ラベルがあれば先頭に付与した 3 部キーになる (Refs #253)', () => {
    expect(salaryCdMapKey('01427', '中村　一由', '株式会社')).toBe('株式会社|1427|中村一由')
    // 会社ラベル省略時は旧形式 (2 部) と完全に同じ文字列 — 後方互換
    expect(salaryCdMapKey('01427', '中村　一由', '')).toBe(salaryCdMapKey('01427', '中村　一由'))
  })

  it('resolveCdKey はマスタ命中時に引き当て、無ければ給与コードのまま', () => {
    const cdMap: SalaryCdMap = { entries: { '1427|中村一由': '01412' } }
    expect(resolveCdKey(csvRow({ driverCd: '1427', cdKey: '1427', driverName: '中村 一由' }), cdMap)).toBe('1412')
    expect(resolveCdKey(csvRow(), cdMap)).toBe('1239')
  })

  it('会社スコープの 3 部キーを優先し、無ければ旧形式 (会社無し) の 2 部キーへ落ちる', () => {
    const cdMap: SalaryCdMap = {
      entries: {
        '株式会社|1427|中村一由': '01412',
        '1600|佐藤太郎': '01700', // 会社ラベル導入前に保存された旧形式のエントリ
      },
    }
    // 3 部キーが命中
    expect(resolveCdKey(csvRow({ driverCd: '1427', cdKey: '1427', driverName: '中村 一由', company: '株式会社' }), cdMap)).toBe('1412')
    // 3 部キーは無いが会社ラベル込みの行 → 旧形式 (会社無し) キーへフォールバックして命中
    expect(resolveCdKey(csvRow({ driverCd: '1600', cdKey: '1600', driverName: '佐藤 太郎', company: '有限会社' }), cdMap)).toBe('1700')
    // どちらのキーにも無ければ生の給与コードのまま
    expect(resolveCdKey(csvRow({ driverCd: '9999', cdKey: '9999', driverName: '該当なし', company: '株式会社' }), cdMap)).toBe('9999')
  })
})

describe('suggestCdMapEntries', () => {
  const reports = [
    reportRow('1412', '中村 一由'),
    reportRow('1587', '柳井 亮祐'),
    reportRow('1601', '佐藤 太郎'),
    reportRow('1602', '佐藤 太郎'), // 同姓同名 → 提案しない
    reportRow('1239', '城田 秀幸'),
  ]

  it('未突合行を氏名の一意一致で提案する (重複行は 1 回だけ)', () => {
    const rows = [
      csvRow({ driverCd: '1427', cdKey: '1427', driverName: '中村　一由' }),
      csvRow({ driverCd: '1427', cdKey: '1427', driverName: '中村　一由' }), // 同一人物の別月行
      csvRow({ driverCd: '1710', cdKey: '1710', driverName: '佐藤 太郎' }), // 同姓同名 2 名 → 提案不可
      csvRow({ driverCd: '1800', cdKey: '1800', driverName: '該当 なし' }), // 名前不一致
      csvRow(), // 1239 はコード直接一致 → 提案不要
    ]
    const out = suggestCdMapEntries(rows, reports, { entries: {} })
    expect(out).toEqual({ '1427|中村一由': '1412' })
  })

  it('マスタ登録済みの行は提案しない', () => {
    const rows = [csvRow({ driverCd: '1427', cdKey: '1427', driverName: '中村 一由' })]
    const out = suggestCdMapEntries(rows, reports, { entries: { '1427|中村一由': '9999' } })
    expect(out).toEqual({})
  })

  it('会社ラベルがある行は会社スコープの 3 部キーで提案する (Refs #253)', () => {
    const rows = [csvRow({ company: '株式会社', driverCd: '1427', cdKey: '1427', driverName: '中村　一由' })]
    const out = suggestCdMapEntries(rows, reports, { entries: {} })
    expect(out).toEqual({ '株式会社|1427|中村一由': '1412' })
  })

  it('旧形式 (会社無し) のキーで既にマスタ登録済みなら会社スコープでも提案しない', () => {
    const rows = [csvRow({ company: '株式会社', driverCd: '1427', cdKey: '1427', driverName: '中村 一由' })]
    const out = suggestCdMapEntries(rows, reports, { entries: { '1427|中村一由': '9999' } })
    expect(out).toEqual({})
  })

  it('給与コードが実在の乗務員CDと偶然一致していても氏名が違えば提案する (Refs #253)', () => {
    // 1412 は中村一由の乗務員CD。別会社の給与コード 1412 がたまたま同じ数字だが
    // 本人は柳井亮祐 (別人) — コードの一致だけを見て「提案不要」にしてはいけない。
    const rows = [csvRow({ company: '有限会社', driverCd: '1412', cdKey: '1412', driverName: '柳井 亮祐' })]
    const out = suggestCdMapEntries(rows, reports, { entries: {} })
    expect(out).toEqual({ '有限会社|1412|柳井亮祐': '1587' })
  })
})

describe('compareSalaryMonth', () => {
  const config: SalaryItemConfig = { items: {} }

  it('乗務員CD (前ゼロ・数値同値) で突合し、給与明細の単価 × システム集計で差額を計算する', () => {
    const out = compareSalaryMonth(
      // 基本単価 3679 円/日、残業単価 1430 円/h (実データの城田氏の単価)
      [csvRow({ driverCd: '01239', cdKey: '1239', rates: { base: 3679, overtime: 1430 } })],
      // 稼働 22 日、時間外 90h + 時間外深夜 2h
      [reportRow('1239', '城田 秀幸', { workDays: 22, overtimeMinutes: 90 * 60, overtimeNightMinutes: 120 })],
      config,
    )
    expect(out.rows).toHaveLength(1)
    const r = out.rows[0]!
    expect(r.csvBase).toBe(80000)
    expect(r.csvOvertime).toBe(30000)
    expect(r.csvTotal).toBe(110000)
    expect(r.sysWorkDays).toBe(22)
    expect(r.sysOvertimeMinutes).toBe(92 * 60)
    expect(r.sysBase).toBe(3679 * 22) // 80,938
    expect(r.sysOvertime).toBe(1430 * 92) // 131,560
    expect(r.sysTotal).toBe(80938 + 131560)
    expect(r.diffBase).toBe(80000 - 80938)
    expect(r.diffOvertime).toBe(30000 - 131560)
    expect(r.diffTotal).toBe(110000 - 212498)
    expect(out.csvOnly).toEqual([])
    expect(out.reportOnly).toEqual([])
    expect(out.warnings).toEqual([])
  })

  it('分単位の残業は時給を按分して円未満を四捨五入する', () => {
    const out = compareSalaryMonth(
      [csvRow({ rates: { base: null, overtime: 1430 } })],
      [reportRow('1239', '城田 秀幸', { overtimeMinutes: 90 })], // 1.5h
      config,
    )
    expect(out.rows[0]!.sysOvertime).toBe(2145) // 1430 × 1.5
  })

  it('summary の時間外が null でも 0 として扱う', () => {
    const out = compareSalaryMonth(
      [csvRow({ rates: { base: 3679, overtime: 1430 } })],
      [reportRow('1239', '城田 秀幸', { workDays: 10, overtimeMinutes: null, overtimeNightMinutes: null })],
      config,
    )
    expect(out.rows[0]!.sysOvertime).toBe(0)
    expect(out.rows[0]!.sysBase).toBe(36790)
  })

  it('基本単価・残業単価が無い行は独自の按分計算をせず null にする (「単価なし」)', () => {
    const out = compareSalaryMonth([csvRow()], [reportRow('1239', '城田 秀幸', { workDays: 22, overtimeMinutes: 60 * 60 })], config)
    const r = out.rows[0]!
    expect(r.sysBase).toBeNull()
    expect(r.diffBase).toBeNull()
    expect(r.sysOvertime).toBeNull()
    expect(r.diffOvertime).toBeNull()
    expect(r.sysTotal).toBeNull()
    expect(r.diffTotal).toBeNull()
  })

  it('基本単価だけ無い行は基本給(計算)のみ null、残業単価があれば残業(計算)は出る', () => {
    const out = compareSalaryMonth(
      [csvRow({ rates: { base: null, overtime: 1430 } })],
      [reportRow('1239', '城田 秀幸', { overtimeMinutes: 90 })], // 1.5h
      config,
    )
    const r = out.rows[0]!
    expect(r.sysBase).toBeNull()
    expect(r.sysOvertime).toBe(2145) // 1430 × 1.5h
    expect(r.sysTotal).toBeNull() // 片方 null なら合計も null
  })

  it('csvBaseItems / csvOvertimeItems に区分ごとの支給項目内訳を積む', () => {
    const out = compareSalaryMonth(
      [csvRow({ amounts: { 基本給: 80000, 無事故手当: 5000, 残業手当: 20000, '60H超過残業': 10000 } })],
      [reportRow('1239', '城田 秀幸')],
      config,
    )
    const r = out.rows[0]!
    expect(r.csvBaseItems).toEqual([{ label: '基本給', amount: 80000 }, { label: '無事故手当', amount: 5000 }])
    expect(r.csvOvertimeItems).toEqual([{ label: '残業手当', amount: 20000 }, { label: '60H超過残業', amount: 10000 }])
  })

  it('片側にしかいない乗務員を csvOnly / reportOnly に分ける (未確認の行のみ csvOnly に出る)', () => {
    // 9999 は突合マスタ未登録・直接一致もしない (未確認) → csvOnly に出る側。
    const out = compareSalaryMonth(
      [csvRow(), csvRow({ driverCd: '9999', cdKey: '9999', driverName: '給与のみ' })],
      [reportRow('1239', '城田 秀幸'), reportRow('1021', '計算のみ')],
      config,
    )
    expect(out.rows).toHaveLength(1)
    expect(out.csvOnly).toEqual([{ driverCd: '9999', driverName: '給与のみ', company: '' }])
    expect(out.reportOnly).toEqual([{ driverCd: '1021', driverName: '計算のみ' }])
  })

  it('乗務員CDが確定済み (登録済み) でも今月の wage-report に本人がいない行は csvOnly にも rows にも出さず消える (Refs #253)', () => {
    // 実例: 突合マスタに「1699 仲里剛 → 1672」が登録済みだが、退職等でこの月の
    // wage-report に driverCd 1672 がいない — 比較対象が無いだけで人が確認する
    // 対象ではないので、csvOnly の「乗務員CDを選択」ドロップダウンに出してはいけない。
    const cdMap: SalaryCdMap = { entries: { '1699|仲里剛': '1672' } }
    const out = compareSalaryMonth(
      [csvRow({ driverCd: '1699', cdKey: '1699', driverName: '仲里 剛' })],
      [reportRow('1021', '計算のみ')], // 1672 は今月の wage-report に不在
      config,
      cdMap,
    )
    expect(out.rows).toEqual([])
    expect(out.csvOnly).toEqual([])
    expect(out.conflicts).toEqual([])
    expect(out.reportOnly).toEqual([{ driverCd: '1021', driverName: '計算のみ' }])
  })

  it('同じ乗務員が今月の wage-report にいれば普通に rows へ出る (対照ケース)', () => {
    const cdMap: SalaryCdMap = { entries: { '1699|仲里剛': '1672' } }
    const out = compareSalaryMonth(
      [csvRow({ driverCd: '1699', cdKey: '1699', driverName: '仲里 剛' })],
      [reportRow('1672', '仲里 剛')],
      config,
      cdMap,
    )
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]!.driverName).toBe('仲里 剛')
    expect(out.csvOnly).toEqual([])
  })

  it('突合マスタで給与コード ≠ 乗務員CD の乗務員を引き当てる', () => {
    const cdMap: SalaryCdMap = { entries: { '1427|中村一由': '1412' } }
    const out = compareSalaryMonth(
      [csvRow({ driverCd: '1427', cdKey: '1427', driverName: '中村　一由' })],
      [reportRow('1412', '中村 一由', { workDays: 22 })],
      config,
      cdMap,
    )
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]!.driverCd).toBe('1427')
    expect(out.rows[0]!.mappedDriverCd).toBe('1412')
    expect(out.csvOnly).toEqual([])
    expect(out.reportOnly).toEqual([])
  })

  it('直接一致した行は mappedDriverCd を null にする', () => {
    const out = compareSalaryMonth([csvRow()], [reportRow('1239', '城田 秀幸')], config)
    expect(out.rows[0]!.mappedDriverCd).toBeNull()
  })

  it('最低賃金が引けない乗務員は 残業(最低賃金) 系が null (時間軸は出る)', () => {
    const out = compareSalaryMonth(
      [csvRow()],
      [reportRow('1239', '城田 秀幸', { overtimeMinutes: 60, overtimeNightMinutes: 30 })],
      config,
    )
    const r = out.rows[0]!
    expect(r.minWageOvertimeMinutes).toBe(90)
    expect(r.minWageOvertimePay).toBeNull()
    expect(r.diffCsvVsMinWageOvertime).toBeNull()
  })

  it('基礎単価(実績) と 残業(基礎単価) は最低賃金設定と独立に明細+法定内時間から出る (Refs #278)', () => {
    const out = compareSalaryMonth(
      [csvRow()], // 基本給 80000 (base) + 残業手当 30000 (overtime)
      [reportRow('1239', '城田 秀幸', { statutoryMinutes: 160 * 60, overtimeMinutes: 20 * 60 })],
      config,
    )
    const r = out.rows[0]!
    expect(r.statutoryMinutes).toBe(160 * 60)
    expect(r.baseRateActual).toBe(500) // 80000 ÷ 160h
    expect(r.baseRateOvertimePay).toBe(12500) // 20h × 500 × 1.25
    expect(r.diffCsvVsBaseRateOvertime).toBe(30000 - 12500)
  })

  it('法定内時間が 0 (v1 アーカイブ等) の行は 基礎単価(実績) 系が null (算出不可)', () => {
    const out = compareSalaryMonth(
      [csvRow()],
      [reportRow('1239', '城田 秀幸', { overtimeMinutes: 20 * 60 })],
      config,
    )
    const r = out.rows[0]!
    expect(r.baseRateActual).toBeNull()
    expect(r.baseRateOvertimePay).toBeNull()
    expect(r.diffCsvVsBaseRateOvertime).toBeNull()
  })

  it('CSV 側の重複乗務員は後勝ち + 警告する', () => {
    const out = compareSalaryMonth(
      [csvRow({ amounts: { 基本給: 1 } }), csvRow({ amounts: { 基本給: 2 } })],
      [reportRow('1239', '城田 秀幸')],
      config,
    )
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('重複')
    expect(out.rows[0]!.csvBase).toBe(2)
  })

  it('同一人物の同月重複 (会社・氏名が同じ) は従来どおり後勝ち + 通常警告 (conflicts には出ない)', () => {
    const out = compareSalaryMonth(
      [
        csvRow({ company: '株式会社', amounts: { 基本給: 1 } }),
        csvRow({ company: '株式会社', amounts: { 基本給: 2 } }),
      ],
      [reportRow('1239', '城田 秀幸')],
      config,
    )
    expect(out.conflicts).toEqual([])
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('重複')
    expect(out.rows[0]!.csvBase).toBe(2)
  })

  it('給与コードが乗務員CDと偶然数字一致しただけ (氏名不一致) の行は衝突にせず、単なる未突合にする (Refs #253)', () => {
    // kabu 社の 0222 = 城田秀幸 (乗務員CD 222 と数字・氏名の両方一致 = 本当の直接一致)、
    // yuu 社の 0222 = 別人の金原敏雄 (会社が違うので社員コードが偶然一致しただけ、氏名は不一致)。
    // 金原敏雄はまだ誰にも確認されていないので、衝突として人に聞くのではなく
    // 普通の未突合として扱う — 相手が見つからないだけの行を衝突扱いしない。
    const out = compareSalaryMonth(
      [
        csvRow({ company: '株式会社', driverCd: '0222', cdKey: '222', driverName: '城田 秀幸' }),
        csvRow({ company: '有限会社', driverCd: '0222', cdKey: '222', driverName: '金原 敏雄' }),
      ],
      [reportRow('222', '城田 秀幸')],
      config,
    )
    expect(out.conflicts).toEqual([])
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]!.driverName).toBe('城田 秀幸')
    expect(out.csvOnly).toEqual([{ driverCd: '0222', driverName: '金原 敏雄', company: '有限会社' }])
    expect(out.reportOnly).toEqual([])
  })

  it('突合マスタの登録ミス等で複数の確認済み行が同じ乗務員CDに来たら conflicts に隔離する (Refs #253)', () => {
    // 株式会社の 1523 (坂本孝一) と 有限会社の 1547 (宮﨑浩二) が、どちらも
    // (誤って) cdMap で乗務員CD 1523 に登録されてしまっているケース。
    const cdMap: SalaryCdMap = {
      entries: { '株式会社|1523|坂本孝一': '1523', '有限会社|1547|宮﨑浩二': '1523' },
    }
    const out = compareSalaryMonth(
      [
        csvRow({ company: '株式会社', driverCd: '1523', cdKey: '1523', driverName: '坂本 孝一' }),
        csvRow({ company: '有限会社', driverCd: '1547', cdKey: '1547', driverName: '宮﨑 浩二' }),
      ],
      [reportRow('1523', '宮﨑 浩二')],
      config,
      cdMap,
    )
    expect(out.rows).toEqual([])
    expect(out.csvOnly).toEqual([])
    expect(out.conflicts).toEqual([
      {
        driverCd: '1523',
        entries: [
          { company: '株式会社', driverCd: '1523', driverName: '坂本 孝一' },
          { company: '有限会社', driverCd: '1547', driverName: '宮﨑 浩二' },
        ],
      },
    ])
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('氏名の異なる複数の給与コードが解決されました')
  })

  it('衝突エントリの会社ラベルが空の場合は警告で「会社未設定」と表示する', () => {
    const cdMap: SalaryCdMap = {
      entries: { '1523|坂本孝一': '1523', '有限会社|1547|宮﨑浩二': '1523' },
    }
    const out = compareSalaryMonth(
      [
        csvRow({ company: '', driverCd: '1523', cdKey: '1523', driverName: '坂本 孝一' }),
        csvRow({ company: '有限会社', driverCd: '1547', cdKey: '1547', driverName: '宮﨑 浩二' }),
      ],
      [reportRow('1523', '宮﨑 浩二')],
      config,
      cdMap,
    )
    expect(out.warnings[0]).toContain('会社未設定:1523 坂本 孝一')
  })

  it('突合マスタで会社ごとに引き当て直せば conflicts は解消される', () => {
    const cdMap: SalaryCdMap = { entries: { '有限会社|222|金原敏雄': '1601' } }
    const out = compareSalaryMonth(
      [
        csvRow({ company: '株式会社', driverCd: '0222', cdKey: '222', driverName: '城田 秀幸' }),
        csvRow({ company: '有限会社', driverCd: '0222', cdKey: '222', driverName: '金原 敏雄' }),
      ],
      [reportRow('222', '城田 秀幸'), reportRow('1601', '金原 敏雄')],
      config,
      cdMap,
    )
    expect(out.conflicts).toEqual([])
    expect(out.rows).toHaveLength(2)
    expect(out.rows.map(r => r.driverName).sort()).toEqual(['城田 秀幸', '金原 敏雄'])
  })
})

// ---------------------------------------------------------------------------
// 複数会社の給与行の合算 (1 人 = 社員C に複数の給与社員CD、Refs #403)
// ---------------------------------------------------------------------------

describe('compareCompanyLabel', () => {
  it('コードポイント順で比較する (locale に依らない)', () => {
    // 有 U+6709 (26377) < 株 U+682A (26666)。ICU の 'ja' 照合とは順が違うが、
    // 環境で結果が変わらないことを優先する (CI Linux と開発機 Windows で逆転した)
    expect(compareCompanyLabel('有', '株')).toBe(-1)
    expect(compareCompanyLabel('株', '有')).toBe(1)
    expect(compareCompanyLabel('株', '株')).toBe(0)
  })
})

describe('mergeSalaryCsvRows', () => {
  it('1 件ならその行をそのまま返す', () => {
    const row = csvRow({ amounts: { 基本給: 100 } })
    expect(mergeSalaryCsvRows([row])).toBe(row)
  })

  it('支給項目を項目名ごとに合算し、会社ラベルを連結する', () => {
    const out = mergeSalaryCsvRows([
      csvRow({ company: '有限会社 大石運輸', driverCd: '1649', amounts: { 基本給: 100, 残業手当: 10 } }),
      csvRow({ company: '大石運輸倉庫株式会社', driverCd: '1644', amounts: { 基本給: 200, 住宅手当: 5 } }),
    ])
    expect(out.company).toBe('有限会社 大石運輸 / 大石運輸倉庫株式会社')
    expect(out.amounts).toEqual({ 基本給: 300, 残業手当: 10, 住宅手当: 5 })
  })

  it('支給合計額は全行が値を持つ時だけ合算し、欠損があれば null', () => {
    expect(mergeSalaryCsvRows([
      csvRow({ reportedTotal: 100 }),
      csvRow({ company: '有', reportedTotal: 200 }),
    ]).reportedTotal).toBe(300)
    expect(mergeSalaryCsvRows([
      csvRow({ reportedTotal: 100 }),
      csvRow({ company: '有', reportedTotal: null }),
    ]).reportedTotal).toBeNull()
  })

  it('単価は全行で同値なら採用、異なれば null (按分しない)', () => {
    expect(mergeSalaryCsvRows([
      csvRow({ rates: { base: 12000, overtime: 1500 } }),
      csvRow({ company: '有', rates: { base: 12000, overtime: 1500 } }),
    ]).rates).toEqual({ base: 12000, overtime: 1500 })

    expect(mergeSalaryCsvRows([
      csvRow({ rates: { base: 12000, overtime: 1500 } }),
      csvRow({ company: '有', rates: { base: 9000, overtime: 1500 } }),
    ]).rates).toEqual({ base: null, overtime: 1500 })

    expect(mergeSalaryCsvRows([
      csvRow({ rates: { base: null, overtime: null } }),
      csvRow({ company: '有', rates: { base: null, overtime: null } }),
    ]).rates).toEqual({ base: null, overtime: null })
  })
})

describe('compareSalaryMonth — 複数会社の合算 (Refs #403)', () => {
  const config: SalaryItemConfig = { items: {} }
  // 実データの社員C 1619 鵜瀬裕一: 有限会社 1649 (鵜瀨) と 大石運輸倉庫 1644 (鵜瀬)
  // の 2 社に給与行がある乗務員。従来は conflicts に隔離され最低賃金チェックから
  // 落ちていた。
  const cdMap: SalaryCdMap = {
    entries: { '有限会社|1649|鵜瀬裕一': '1619', '大石運輸倉庫|1644|鵜瀬裕一': '1619' },
  }

  it('氏名が一致する複数会社の行は 1 人として合算する', () => {
    const out = compareSalaryMonth(
      [
        csvRow({ company: '大石運輸倉庫', driverCd: '1644', cdKey: '1644', driverName: '鵜瀬 裕一', amounts: { 基本給: 200000, 残業手当: 30000 } }),
        csvRow({ company: '有限会社', driverCd: '1649', cdKey: '1649', driverName: '鵜瀬 裕一', amounts: { 基本給: 100000, 残業手当: 20000 } }),
      ],
      [reportRow('1619', '鵜瀬 裕一')],
      config,
      cdMap,
    )
    expect(out.conflicts).toEqual([])
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]!.csvBase).toBe(300000)
    expect(out.rows[0]!.csvOvertime).toBe(50000)
    // 会社ラベル昇順 (コードポイント順: 大 U+5927 < 有 U+6709) で内訳を持つ。
    // 入力順に依らない — localeCompare だと CI と開発機で順が逆になる
    expect(out.rows[0]!.mergedFrom).toEqual([
      { company: '大石運輸倉庫', driverCd: '1644' },
      { company: '有限会社', driverCd: '1649' },
    ])
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('1 人として合算しました')
  })

  it('3 社ぶんも合算する (実データの社員C 1132 相当)', () => {
    const out = compareSalaryMonth(
      [
        csvRow({ company: '有限会社', driverCd: '1202', cdKey: '1202', driverName: '大石 和也', amounts: { 基本給: 100 } }),
        csvRow({ company: '大石運輸倉庫', driverCd: '1202', cdKey: '1202', driverName: '大石 和也', amounts: { 基本給: 200 } }),
        csvRow({ company: '佐賀大石', driverCd: '41', cdKey: '41', driverName: '大石 和也', amounts: { 基本給: 400 } }),
      ],
      [reportRow('1132', '大石 和也')],
      config,
      {
        entries: {
          '有限会社|1202|大石和也': '1132',
          '大石運輸倉庫|1202|大石和也': '1132',
          '佐賀大石|41|大石和也': '1132',
        },
      },
    )
    expect(out.rows).toHaveLength(1)
    expect(out.rows[0]!.csvBase).toBe(700)
    expect(out.rows[0]!.mergedFrom).toHaveLength(3)
  })

  it('単一会社の行は mergedFrom が null (従来の挙動)', () => {
    const out = compareSalaryMonth(
      [csvRow({ driverCd: '0222', cdKey: '222', driverName: '金原 敏雄' })],
      [reportRow('222', '金原 敏雄')],
      config,
    )
    expect(out.rows[0]!.mergedFrom).toBeNull()
    expect(out.warnings).toEqual([])
  })

  it('会社ごとに単価が違う合算は計算列が「単価なし」になり警告に明記される', () => {
    const out = compareSalaryMonth(
      [
        csvRow({ company: '有限会社', driverCd: '1649', cdKey: '1649', driverName: '鵜瀬 裕一', rates: { base: 12000, overtime: 1500 } }),
        csvRow({ company: '大石運輸倉庫', driverCd: '1644', cdKey: '1644', driverName: '鵜瀬 裕一', rates: { base: 9000, overtime: 1500 } }),
      ],
      [reportRow('1619', '鵜瀬 裕一')],
      config,
      cdMap,
    )
    expect(out.rows[0]!.sysBase).toBeNull()
    expect(out.warnings[0]).toContain('会社ごとに単価が異なるため')
  })

  it('単価が全社同値の合算は計算列が出る (警告に単価の注記は付かない)', () => {
    const out = compareSalaryMonth(
      [
        csvRow({ company: '有限会社', driverCd: '1649', cdKey: '1649', driverName: '鵜瀬 裕一', rates: { base: 12000, overtime: 1500 } }),
        csvRow({ company: '大石運輸倉庫', driverCd: '1644', cdKey: '1644', driverName: '鵜瀬 裕一', rates: { base: 12000, overtime: 1500 } }),
      ],
      [reportRow('1619', '鵜瀬 裕一')],
      config,
      cdMap,
    )
    expect(out.rows[0]!.sysBase).not.toBeNull()
    expect(out.warnings[0]).not.toContain('単価が異なる')
  })

  it('合算行の会社ラベルが空でも警告は「会社未設定」で出る', () => {
    const out = compareSalaryMonth(
      [
        csvRow({ company: '', driverCd: '1649', cdKey: '1649', driverName: '鵜瀬 裕一' }),
        csvRow({ company: '大石運輸倉庫', driverCd: '1644', cdKey: '1644', driverName: '鵜瀬 裕一' }),
      ],
      [reportRow('1619', '鵜瀬 裕一')],
      config,
      { entries: { '1649|鵜瀬裕一': '1619', '大石運輸倉庫|1644|鵜瀬裕一': '1619' } },
    )
    expect(out.warnings[0]).toContain('会社未設定:1649')
  })
})

describe('parseSalaryCsv — 【 勤怠 】セクション (Refs #433)', () => {
  const HEADER = '社員コード,社員名,給与・賞与名,【 勤怠 】,出勤日数,公休日数,有休日数,欠勤日数,【 支給 】,基本給,支給合計額,【 補助 】,基本単価'

  it('勤怠の日数を項目名つきで取り込み、支給項目には混ぜない', () => {
    const parsed = parseSalaryCsv(`${HEADER}\n1065,佐藤　泰弘,2026年 7月,,21,5,0,0,,220000,220000,,11000`)
    expect(parsed.rows[0]!.attendance).toEqual({ 出勤日数: 21, 公休日数: 5, 有休日数: 0, 欠勤日数: 0 })
    expect(parsed.itemLabels).toEqual(['基本給'])
  })

  it('半休の 0.5 も数値として読む', () => {
    const parsed = parseSalaryCsv(`${HEADER}\n1621,西山　珠里,2026年 7月,,20,4,3.5,0,,180000,180000,,9000`)
    expect(parsed.rows[0]!.attendance!['有休日数']).toBe(3.5)
  })

  it('数値でない欄は載せない (「0 日」と「欄が無い」を混同しない)', () => {
    const parsed = parseSalaryCsv(`${HEADER}\n1065,佐藤　泰弘,2026年 7月,,21,,-,0,,220000,220000,,11000`)
    const a = parsed.rows[0]!.attendance!
    expect(a['出勤日数']).toBe(21)
    // 空欄は 0 として読む (給与明細の「0 日」と同じ扱い)
    expect(a['公休日数']).toBe(0)
    // '-' は数値でないので項目ごと落とす
    expect('有休日数' in a).toBe(false)
  })

  it('【 勤怠 】セクションが無い様式でも壊れない (空オブジェクト)', () => {
    const parsed = parseSalaryCsv(
      '社員コード,社員名,給与・賞与名,【 支給 】,基本給,支給合計額\n1065,佐藤　泰弘,2026年 7月,,220000,220000',
    )
    expect(parsed.rows[0]!.attendance).toEqual({})
  })

  it('勤怠の空セル (様式のパディング) は項目にしない', () => {
    const parsed = parseSalaryCsv([
      '社員コード,社員名,給与・賞与名,【 勤怠 】,出勤日数,,【 支給 】,基本給,支給合計額',
      '1065,佐藤　泰弘,2026年 7月,,21,,,220000,220000',
    ].join('\n'))
    expect(parsed.rows[0]!.attendance).toEqual({ 出勤日数: 21 })
  })

  it('行が勤怠列より短くても落ちない (欠けた欄は 0)', () => {
    const parsed = parseSalaryCsv([
      '社員コード,社員名,給与・賞与名,【 勤怠 】,出勤日数,公休日数,【 支給 】,基本給,支給合計額',
      '1065,佐藤　泰弘,2026年 7月,,21',
    ].join('\n'))
    expect(parsed.rows[0]!.attendance).toEqual({ 出勤日数: 21, 公休日数: 0 })
  })

  it('実データ様式 (2026) の勤怠も読める', () => {
    const parsed = parseSalaryCsv(CSV_2026)
    expect(parsed.rows[0]!.attendance).toEqual({ 出勤日数: 22, 残業時間: 91 })
  })
})

describe('compareSalaryMonth — 勤怠日数の突合 (Refs #433)', () => {
  it('計算側は summary の leaveCounts / punchErrorDays をそのまま使う', () => {
    const result = compareSalaryMonth(
      [csvRow({
        cdKey: '1065',
        driverCd: '1065',
        driverName: '佐藤 泰弘',
        attendance: { 出勤日数: 22, 公休日数: 5, 欠勤日数: 0 },
      })],
      [reportRow('1065', '佐藤 泰弘', {
        workDays: 21,
        leaveCounts: { publicHoliday: 5, paidLeave: 1.5, absence: 0, specialLeave: 0, late: 0, earlyLeave: 0 },
        punchErrorDays: 2,
      })],
      { items: {} },
    )
    expect(result.rows[0]!.attendanceDays).toEqual({
      sys: { work: 21, publicHoliday: 5, paidLeave: 1.5, absence: 0, punchError: 2 },
      csv: { work: 22, publicHoliday: 5, absence: 0 },
    })
  })

  it('デジタコ由来の行 (leaveCounts なし) は休暇 0・打刻エラー 0', () => {
    const result = compareSalaryMonth(
      [csvRow({ cdKey: '1029', driverCd: '1029', driverName: '冨田 竜' })],
      [reportRow('1029', '冨田 竜', { workDays: 18 })],
      { items: {} },
    )
    expect(result.rows[0]!.attendanceDays.sys).toEqual({
      work: 18, publicHoliday: 0, paidLeave: 0, absence: 0, punchError: 0,
    })
    expect(result.rows[0]!.attendanceDays.csv).toEqual({})
  })

  it('給与DB 由来 (attendance 未設定) でも落ちない', () => {
    const row = csvRow({ cdKey: '1065', driverCd: '1065', driverName: '佐藤 泰弘' })
    delete (row as { attendance?: unknown }).attendance
    const result = compareSalaryMonth([row], [reportRow('1065', '佐藤 泰弘', { workDays: 21 })], { items: {} })
    expect(result.rows[0]!.attendanceDays.csv).toEqual({})
  })

  it('給与明細に無い軸だけが欠ける (出勤だけある様式)', () => {
    const result = compareSalaryMonth(
      [csvRow({ cdKey: '1065', driverCd: '1065', driverName: '佐藤 泰弘', attendance: { 出勤日数: 22 } })],
      [reportRow('1065', '佐藤 泰弘', { workDays: 21 })],
      { items: {} },
    )
    expect(result.rows[0]!.attendanceDays.csv).toEqual({ work: 22 })
  })
})
