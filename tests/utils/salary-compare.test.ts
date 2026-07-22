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
  computeOvertimePayAtRate,
  effectiveCategory,
  mergeParsedSalaryCsv,
  normalizeNameKey,
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
    overtimeMinutes?: number | null
    overtimeNightMinutes?: number | null
    breakMinutes?: number | null
    drivingMinutes?: number | null
    statutoryMinutes?: number
  } = {},
): WageReportRow {
  return {
    summary: {
      driverCd: cd,
      driverName: name,
      workDays: over.workDays ?? 0,
      overtimeMinutes: over.overtimeMinutes === undefined ? 0 : over.overtimeMinutes,
      overtimeNightMinutes: over.overtimeNightMinutes === undefined ? 0 : over.overtimeNightMinutes,
      breakMinutes: over.breakMinutes === undefined ? 0 : over.breakMinutes,
      drivingMinutes: over.drivingMinutes === undefined ? 0 : over.drivingMinutes,
    },
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

  it('片側にしかいない乗務員を csvOnly / reportOnly に分ける', () => {
    const out = compareSalaryMonth(
      [csvRow(), csvRow({ driverCd: '9999', cdKey: '9999', driverName: '給与のみ' })],
      [reportRow('1239', '城田 秀幸'), reportRow('1021', '計算のみ')],
      config,
    )
    expect(out.rows).toHaveLength(1)
    expect(out.csvOnly).toEqual([{ driverCd: '9999', driverName: '給与のみ', company: '' }])
    expect(out.reportOnly).toEqual([{ driverCd: '1021', driverName: '計算のみ' }])
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

  it('別会社の給与コードが同じ乗務員CDへ解決されたら conflicts に隔離し、サイレント上書きしない (Refs #253)', () => {
    // kabu 社の 0222 = 城田秀幸 (乗務員CD 222 と直接一致)、
    // yuu 社の 0222 = 別人の金原敏雄 (会社が違うだけで社員コードが偶然一致)
    const out = compareSalaryMonth(
      [
        csvRow({ company: '株式会社', driverCd: '0222', cdKey: '222', driverName: '城田 秀幸' }),
        csvRow({ company: '有限会社', driverCd: '0222', cdKey: '222', driverName: '金原 敏雄' }),
      ],
      [reportRow('222', '城田 秀幸')],
      config,
    )
    // 会社が違う 2 人が同じ乗務員CDに解決された行はどちらも rows/csvOnly に出ない
    expect(out.rows).toEqual([])
    expect(out.csvOnly).toEqual([])
    expect(out.reportOnly).toEqual([{ driverCd: '222', driverName: '城田 秀幸' }])
    expect(out.conflicts).toEqual([
      {
        driverCd: '222',
        entries: [
          { company: '株式会社', driverCd: '0222', driverName: '城田 秀幸' },
          { company: '有限会社', driverCd: '0222', driverName: '金原 敏雄' },
        ],
      },
    ])
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toContain('複数の会社の給与コードが解決されました')
  })

  it('衝突エントリの会社ラベルが空の場合は警告で「会社未設定」と表示する', () => {
    const out = compareSalaryMonth(
      [
        csvRow({ company: '', driverCd: '0222', cdKey: '222', driverName: '城田 秀幸' }),
        csvRow({ company: '有限会社', driverCd: '0222', cdKey: '222', driverName: '金原 敏雄' }),
      ],
      [reportRow('222', '城田 秀幸')],
      config,
    )
    expect(out.warnings[0]).toContain('会社未設定:0222 城田 秀幸')
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
