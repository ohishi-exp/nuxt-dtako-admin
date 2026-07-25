/**
 * `app/utils/employee-master.ts` のテスト (Refs #367)。
 */

import { describe, it, expect } from 'vitest'
import {
  buildCdMapEntries,
  buildDriverAttrIndex,
  collectAttrRows,
  findUnregistered,
  normalizeAttrText,
  normalizeCompanyLabel,
  normalizeDriverCdKey,
  payScheme,
  planPayrollDbImport,
  removeAttrRow,
  resolveAttrsAt,
  sortEmployeeEntries,
  splitCdMapKey,
  upsertAttrRow,
  type EmployeeMasterEntry,
  type KyuyoEmployeeRow,
  type KyuyoEmployeesResponse,
} from '../../app/utils/employee-master'
import type { SalaryCsvRow } from '../../app/utils/salary-compare'

function entry(over: Partial<EmployeeMasterEntry> = {}): EmployeeMasterEntry {
  return { company: '株', payrollCd: '7', name: '山田太郎', driverCd: '99', attrs: [], ...over }
}

function csvRow(over: Partial<SalaryCsvRow> = {}): SalaryCsvRow {
  return {
    driverCd: '007',
    cdKey: '7',
    company: '株',
    driverName: '山田太郎',
    month: '2026-07',
    amounts: {},
    reportedTotal: null,
    rates: { base: null, overtime: null },
    ...over,
  }
}

describe('resolveAttrsAt', () => {
  const e = entry({
    attrs: [
      { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
      { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
    ],
  })

  it('対象月の末日時点で最新の行を返す', () => {
    expect(resolveAttrsAt(e, '2025-06')).toEqual(e.attrs[0])
    expect(resolveAttrsAt(e, '2026-12')).toEqual(e.attrs[1])
  })

  it('全て未来なら null', () => {
    expect(resolveAttrsAt(entry({ attrs: [{ effectiveFrom: '2026-04-01', branch: null, payScheme: null }] }), '2025-01')).toBeNull()
  })

  it('attrs が空なら null', () => {
    expect(resolveAttrsAt(entry({ attrs: [] }), '2026-01')).toBeNull()
  })

  it('yearMonth が不正な形式・範囲外なら null', () => {
    expect(resolveAttrsAt(e, '2026-1')).toBeNull()
    expect(resolveAttrsAt(e, '2026-13')).toBeNull()
  })

  it('未整列でも有効な最新行を正しく選ぶ', () => {
    const unsorted = entry({
      attrs: [
        { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
        { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
      ],
    })
    expect(resolveAttrsAt(unsorted, '2026-12')).toEqual(unsorted.attrs[0])
  })
})

describe('buildCdMapEntries', () => {
  it('driverCd がある行だけ SalaryCdMap 形に変換する', () => {
    const out = buildCdMapEntries([
      entry({ company: '株', payrollCd: '7', name: '山田太郎', driverCd: '99' }),
      entry({ company: '有', payrollCd: '1', name: '鈴木花子', driverCd: null }),
    ])
    expect(out.entries).toEqual({ '株|7|山田太郎': '99' })
  })

  it('空配列は空の entries', () => {
    expect(buildCdMapEntries([])).toEqual({ entries: {} })
  })
})

describe('splitCdMapKey', () => {
  it('3部キーを company/payrollCd/name に分解する', () => {
    expect(splitCdMapKey('株|7|山田太郎')).toEqual({ company: '株', payrollCd: '7', name: '山田太郎' })
  })

  it('氏名に | を含む3部超キーは company を先頭、残りを氏名として結合する', () => {
    expect(splitCdMapKey('株|7|山田|太郎')).toEqual({ company: '株', payrollCd: '7', name: '山田|太郎' })
  })

  it('2部キー (旧形式、会社ラベル無し) は company を空文字にする', () => {
    expect(splitCdMapKey('7|山田太郎')).toEqual({ company: '', payrollCd: '7', name: '山田太郎' })
  })

  it('1部しかない不正な形式でも欠けたフィールドは空文字にする', () => {
    expect(splitCdMapKey('7')).toEqual({ company: '', payrollCd: '7', name: '' })
  })
})

describe('findUnregistered', () => {
  it('社員マスタに (company, payrollCd) が無い CSV 行を列挙する', () => {
    const out = findUnregistered(
      [csvRow({ company: '株', cdKey: '7', driverName: '山田太郎' }), csvRow({ company: '有', cdKey: '1', driverName: '鈴木花子' })],
      [entry({ company: '株', payrollCd: '7' })],
    )
    expect(out).toEqual([{ company: '有', payrollCd: '1', name: '鈴木花子' }])
  })

  it('既に登録済み (driverCd 未設定でも company+payrollCd が一致) なら除外する', () => {
    const out = findUnregistered(
      [csvRow({ company: '株', cdKey: '7' })],
      [entry({ company: '株', payrollCd: '7', driverCd: null })],
    )
    expect(out).toEqual([])
  })

  it('同じ (company, payrollCd) の重複行は1件にまとめる', () => {
    const out = findUnregistered(
      [csvRow({ company: '株', cdKey: '7', driverName: '山田太郎' }), csvRow({ company: '株', cdKey: '7', driverName: '山田太郎' })],
      [],
    )
    expect(out).toEqual([{ company: '株', payrollCd: '7', name: '山田太郎' }])
  })

  it('CSV 行が無ければ空配列', () => {
    expect(findUnregistered([], [])).toEqual([])
  })

  it('company が未設定 (空文字) の行は除外する (D1 の PK は company 非空必須)', () => {
    expect(findUnregistered([csvRow({ company: '', cdKey: '7', driverName: '山田太郎' })], [])).toEqual([])
  })
})

describe('upsertAttrRow', () => {
  const base = [
    { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
    { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
  ]

  it('新しい適用開始日を追加し昇順に並べ替える', () => {
    const out = upsertAttrRow(base, { effectiveFrom: '2025-10-01', branch: '営業所', payScheme: 'C' })
    expect(out.map(a => a.effectiveFrom)).toEqual(['2025-04-01', '2025-10-01', '2026-04-01'])
  })

  it('同じ適用開始日の行は置換する', () => {
    const out = upsertAttrRow(base, { effectiveFrom: '2026-04-01', branch: '本社2', payScheme: null })
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ effectiveFrom: '2026-04-01', branch: '本社2', payScheme: null })
  })

  it('元の配列は変更しない', () => {
    const attrs = [...base]
    upsertAttrRow(attrs, { effectiveFrom: '2027-01-01', branch: null, payScheme: null })
    expect(attrs).toHaveLength(2)
  })
})

describe('removeAttrRow', () => {
  it('指定した適用開始日の行だけ除く', () => {
    const out = removeAttrRow(
      [
        { effectiveFrom: '2025-04-01', branch: '支社', payScheme: null },
        { effectiveFrom: '2026-04-01', branch: '本社', payScheme: null },
      ],
      '2025-04-01',
    )
    expect(out.map(a => a.effectiveFrom)).toEqual(['2026-04-01'])
  })

  it('一致する行が無ければそのまま', () => {
    expect(removeAttrRow([], '2025-04-01')).toEqual([])
  })
})

describe('collectAttrRows', () => {
  it('全社員の属性履歴を社員キー込みの平坦な配列へ展開する', () => {
    const out = collectAttrRows([
      entry({ company: '株', payrollCd: '7', attrs: [{ effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' }] }),
      entry({ company: '有', payrollCd: '1', attrs: [] }),
    ])
    expect(out).toEqual([
      { company: '株', payrollCd: '7', effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
    ])
  })

  it('社員が居なければ空配列', () => {
    expect(collectAttrRows([])).toEqual([])
  })
})

describe('normalizeDriverCdKey', () => {
  it('数字は前ゼロを落とす', () => {
    expect(normalizeDriverCdKey('007')).toBe('7')
    expect(normalizeDriverCdKey(' 12 ')).toBe('12')
  })

  it('数字でない値はそのまま (fail-soft)', () => {
    expect(normalizeDriverCdKey('A7')).toBe('A7')
    expect(normalizeDriverCdKey('')).toBe('')
  })
})

describe('buildDriverAttrIndex', () => {
  it('乗務員CD → 対象月末時点の属性 を引ける (前ゼロ差を吸収)', () => {
    const index = buildDriverAttrIndex(
      [entry({
        driverCd: '007',
        attrs: [
          { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
          { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
        ],
      })],
      '2026-07',
    )
    expect(index.get('7')).toEqual({ effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' })
  })

  it('driverCd 未突合・対象月末時点で有効な行が無い社員は載せない', () => {
    const index = buildDriverAttrIndex(
      [
        entry({ payrollCd: '1', driverCd: null, attrs: [{ effectiveFrom: '2020-01-01', branch: '本社', payScheme: null }] }),
        entry({ payrollCd: '2', driverCd: '50', attrs: [{ effectiveFrom: '2030-01-01', branch: '本社', payScheme: null }] }),
        entry({ payrollCd: '3', driverCd: '51', attrs: [] }),
      ],
      '2026-07',
    )
    expect(index.size).toBe(0)
  })

  it('同一 driverCd に複数社員が突合されていたら先勝ち', () => {
    const index = buildDriverAttrIndex(
      [
        entry({ company: '株', payrollCd: '1', driverCd: '9', attrs: [{ effectiveFrom: '2020-01-01', branch: '先', payScheme: null }] }),
        entry({ company: '有', payrollCd: '2', driverCd: '9', attrs: [{ effectiveFrom: '2021-01-01', branch: '後', payScheme: null }] }),
      ],
      '2026-07',
    )
    expect(index.get('9')?.branch).toBe('先')
  })
})

describe('sortEmployeeEntries', () => {
  it('会社ラベル昇順 → 給与コード数値昇順に並べる', () => {
    const out = sortEmployeeEntries([
      entry({ company: '有', payrollCd: '2' }),
      entry({ company: '株', payrollCd: '10' }),
      entry({ company: '株', payrollCd: '9' }),
    ])
    expect(out.map(e => `${e.company}|${e.payrollCd}`)).toEqual(['株|9', '株|10', '有|2'])
  })

  it('元の配列は変更しない', () => {
    const employees = [entry({ company: '有', payrollCd: '2' }), entry({ company: '株', payrollCd: '1' })]
    sortEmployeeEntries(employees)
    expect(employees[0]!.company).toBe('有')
  })
})

describe('normalizeCompanyLabel / payScheme', () => {
  it('会社ラベルは NFKC + trim (worker の PUT と同一規則)', () => {
    expect(normalizeCompanyLabel(' 有限会社　大石運輸 ')).toBe('有限会社 大石運輸')
  })

  it('属性テキストは NFKC + trim、空は null (worker の保存と揃える)', () => {
    expect(normalizeAttrText('本社　乗務員')).toBe('本社 乗務員')
    expect(normalizeAttrText('   ')).toBeNull()
    expect(normalizeAttrText(null)).toBeNull()
  })

  it('給与体系は 0 (未設定) なら null', () => {
    expect(payScheme(1)).toBe('体系1')
    expect(payScheme(0)).toBeNull()
  })
})

describe('planPayrollDbImport', () => {
  const kyuyoRow = (over: Partial<KyuyoEmployeeRow> = {}): KyuyoEmployeeRow => ({
    employee_code: '0007',
    employee_code_key: '7',
    employee_name: '山田　太郎',
    department: '本社　乗務員',
    taikei: 1,
    retired: false,
    ...over,
  })
  const res = (rows: KyuyoEmployeeRow[]): KyuyoEmployeesResponse => ({
    company: '0100',
    company_name: '有限会社　大石運輸',
    month: '2026-07',
    database: 'KYDATA0100_126C',
    employees: rows,
    warnings: [],
  })

  it('新規社員は employees + attrs を作り、会社ラベルは CONAME1 の正規化', () => {
    const plan = planPayrollDbImport(res([kyuyoRow()]), [], '2026-07', null)
    expect(plan.added).toBe(1)
    expect(plan.merged).toBe(0)
    expect(plan.employees).toEqual([
      { company: '有限会社 大石運輸', payrollCd: '7', name: '山田　太郎', driverCd: null },
    ])
    expect(plan.attrs).toEqual([
      { company: '有限会社 大石運輸', payrollCd: '7', effectiveFrom: '2026-07-01', branch: '本社 乗務員', payScheme: '体系1' },
    ])
    expect(plan.deleteEmployees).toEqual([])
  })

  it('旧ラベル行があれば乗務員CDを引き継いで旧行を削除する', () => {
    const legacy = entry({ company: '有', payrollCd: '7', name: '山田太郎', driverCd: '9901' })
    const plan = planPayrollDbImport(res([kyuyoRow()]), [legacy], '2026-07', '有')
    expect(plan.merged).toBe(1)
    expect(plan.employees[0]!.driverCd).toBe('9901')
    expect(plan.deleteEmployees).toEqual([{ company: '有', payrollCd: '7' }])
  })

  it('既に新ラベルで登録済みなら added に数えず、乗務員CDを保つ', () => {
    const current = entry({ company: '有限会社 大石運輸', payrollCd: '7', name: '旧氏名', driverCd: '9902' })
    const plan = planPayrollDbImport(res([kyuyoRow()]), [current], '2026-07', '有')
    expect(plan.added).toBe(0)
    expect(plan.merged).toBe(0)
    expect(plan.employees[0]!.driverCd).toBe('9902')
    expect(plan.employees[0]!.name).toBe('山田　太郎')
  })

  it('対象月末時点で同じ所属/体系が効いているなら履歴を増やさない', () => {
    const current = entry({
      company: '有限会社 大石運輸',
      payrollCd: '7',
      driverCd: null,
      attrs: [{ effectiveFrom: '2026-04-01', branch: '本社 乗務員', payScheme: '体系1' }],
    })
    const plan = planPayrollDbImport(res([kyuyoRow()]), [current], '2026-07', null)
    expect(plan.attrs).toEqual([])
  })

  it('所属が変わっていれば当月初の履歴を足す', () => {
    const current = entry({
      company: '有限会社 大石運輸',
      payrollCd: '7',
      driverCd: null,
      attrs: [{ effectiveFrom: '2026-04-01', branch: '支社', payScheme: '体系1' }],
    })
    const plan = planPayrollDbImport(res([kyuyoRow()]), [current], '2026-07', null)
    expect(plan.attrs).toEqual([
      { company: '有限会社 大石運輸', payrollCd: '7', effectiveFrom: '2026-07-01', branch: '本社 乗務員', payScheme: '体系1' },
    ])
  })

  it('保存側の NFKC 正規化と同値なら履歴を増やさない (全角スペース差で誤検知しない)', () => {
    const current = entry({
      company: '有限会社 大石運輸',
      payrollCd: '7',
      driverCd: null,
      attrs: [{ effectiveFrom: '2026-04-01', branch: '本社 乗務員', payScheme: '体系1' }],
    })
    const plan = planPayrollDbImport(res([kyuyoRow({ department: '本社　乗務員' })]), [current], '2026-07', null)
    expect(plan.attrs).toEqual([])
  })

  it('所属も体系も無い新規社員は属性行を作らない', () => {
    const plan = planPayrollDbImport(res([kyuyoRow({ department: '  ', taikei: 0 })]), [], '2026-07', null)
    expect(plan.employees).toHaveLength(1)
    expect(plan.attrs).toEqual([])
  })

  it('社員番号が空の行は捨てる', () => {
    const plan = planPayrollDbImport(res([kyuyoRow({ employee_code_key: '  ' })]), [], '2026-07', null)
    expect(plan.employees).toEqual([])
  })

  it('退職者も取り込む (過去月の突合に要る)', () => {
    const plan = planPayrollDbImport(res([kyuyoRow({ retired: true })]), [], '2026-07', null)
    expect(plan.employees).toHaveLength(1)
  })
})
