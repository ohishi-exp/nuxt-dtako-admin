import { describe, expect, it } from 'vitest'
import {
  buildEmployeeMasterImportStatements,
  buildEmployeeMasterResponse,
  buildEmployeeMasterWriteStatements,
  cdMapEntriesToEmployees,
  EmployeeMasterError,
  normalizeEmployeeMasterPutBody,
  normalizeNameKey,
  resolveAttrsAt,
  type EmployeeAttrD1Row,
  type EmployeeAttrRow,
  type EmployeeD1Row,
} from '../src/employee-master'

describe('normalizeNameKey', () => {
  it('NFKC 正規化 + 空白除去', () => {
    expect(normalizeNameKey('山田　太郎')).toBe('山田太郎')
    expect(normalizeNameKey(' Ｔａｒｏ Yamada ')).toBe('TaroYamada')
  })
})

describe('normalizeEmployeeMasterPutBody', () => {
  it('全フィールド省略時は空配列', () => {
    expect(normalizeEmployeeMasterPutBody({})).toEqual({
      employees: [],
      attrs: [],
      deleteAttrs: [],
      deleteEmployees: [],
    })
  })

  it('employees を検証・正規化する (前ゼロ除去・NFKC trim・driverCd 前ゼロ除去)', () => {
    const body = normalizeEmployeeMasterPutBody({
      employees: [{ company: ' 株 ', payrollCd: '007', name: ' 山田　太郎 ', driverCd: '0099' }],
    })
    // NFKC 正規化で全角スペース (U+3000) は半角スペースになる (name_key はさらに空白を全除去)
    expect(body.employees).toEqual([{ company: '株', payrollCd: '7', name: '山田 太郎', driverCd: '99' }])
  })

  it('employees.driverCd は null/undefined を許容する', () => {
    const body = normalizeEmployeeMasterPutBody({
      employees: [{ company: '株', payrollCd: '1', name: '甲' }],
    })
    expect(body.employees[0]!.driverCd).toBeNull()
    const body2 = normalizeEmployeeMasterPutBody({
      employees: [{ company: '株', payrollCd: '1', name: '甲', driverCd: null }],
    })
    expect(body2.employees[0]!.driverCd).toBeNull()
  })

  it('attrs を検証・正規化する (branch/payScheme は任意)', () => {
    const body = normalizeEmployeeMasterPutBody({
      attrs: [{ company: '株', payrollCd: '7', effectiveFrom: '2026-04-01', branch: ' 本社 ', payScheme: 'A' }],
    })
    expect(body.attrs).toEqual([
      { company: '株', payrollCd: '7', effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
    ])
  })

  it('attrs.branch/payScheme は null/undefined/空文字を null にする', () => {
    const body = normalizeEmployeeMasterPutBody({
      attrs: [
        { company: '株', payrollCd: '1', effectiveFrom: '2026-01-01', branch: null, payScheme: undefined },
        { company: '株', payrollCd: '1', effectiveFrom: '2026-02-01', branch: '  ', payScheme: 123 },
      ],
    })
    expect(body.attrs[0]).toEqual({
      company: '株',
      payrollCd: '1',
      effectiveFrom: '2026-01-01',
      branch: null,
      payScheme: null,
    })
    expect(body.attrs[1]).toEqual({
      company: '株',
      payrollCd: '1',
      effectiveFrom: '2026-02-01',
      branch: null,
      payScheme: null,
    })
  })

  it('deleteAttrs / deleteEmployees を検証・正規化する', () => {
    const body = normalizeEmployeeMasterPutBody({
      deleteAttrs: [{ company: ' 株 ', payrollCd: '007', effectiveFrom: '2026-04-01' }],
      deleteEmployees: [{ company: ' 有 ', payrollCd: '008' }],
    })
    expect(body.deleteAttrs).toEqual([{ company: '株', payrollCd: '7', effectiveFrom: '2026-04-01' }])
    expect(body.deleteEmployees).toEqual([{ company: '有', payrollCd: '8' }])
  })

  it('body 自体が JSON オブジェクトでなければ EmployeeMasterError', () => {
    expect(() => normalizeEmployeeMasterPutBody(null)).toThrow(EmployeeMasterError)
    expect(() => normalizeEmployeeMasterPutBody([])).toThrow(EmployeeMasterError)
    expect(() => normalizeEmployeeMasterPutBody('x')).toThrow(EmployeeMasterError)
  })

  it('各配列フィールドは配列でなければ EmployeeMasterError', () => {
    expect(() => normalizeEmployeeMasterPutBody({ employees: {} })).toThrow(/employees/)
    expect(() => normalizeEmployeeMasterPutBody({ attrs: 'x' })).toThrow(/attrs/)
    expect(() => normalizeEmployeeMasterPutBody({ deleteAttrs: 1 })).toThrow(/deleteAttrs/)
    expect(() => normalizeEmployeeMasterPutBody({ deleteEmployees: 1 })).toThrow(/deleteEmployees/)
  })

  it('employees[i] の構造不正・必須項目欠如は EmployeeMasterError', () => {
    expect(() => normalizeEmployeeMasterPutBody({ employees: [null] })).toThrow(/employees\[0\]/)
    expect(() => normalizeEmployeeMasterPutBody({ employees: [[]] })).toThrow(/employees\[0\]/)
    expect(() => normalizeEmployeeMasterPutBody({ employees: [{ company: '', payrollCd: '1', name: '甲' }] })).toThrow(
      /company/,
    )
    expect(() =>
      normalizeEmployeeMasterPutBody({ employees: [{ company: '株', payrollCd: 'abc', name: '甲' }] }),
    ).toThrow(/payrollCd/)
    expect(() => normalizeEmployeeMasterPutBody({ employees: [{ company: '株', payrollCd: '1', name: '' }] })).toThrow(
      /name/,
    )
    expect(() =>
      normalizeEmployeeMasterPutBody({ employees: [{ company: '株', payrollCd: '1', name: '甲', driverCd: 'x' }] }),
    ).toThrow(/driverCd/)
  })

  it('attrs[i] の構造不正・必須項目欠如は EmployeeMasterError', () => {
    expect(() => normalizeEmployeeMasterPutBody({ attrs: [null] })).toThrow(/attrs\[0\]/)
    expect(() =>
      normalizeEmployeeMasterPutBody({ attrs: [{ company: '株', payrollCd: '1', effectiveFrom: '2026/01/01' }] }),
    ).toThrow(/effectiveFrom/)
    expect(() =>
      normalizeEmployeeMasterPutBody({ attrs: [{ company: '', payrollCd: '1', effectiveFrom: '2026-01-01' }] }),
    ).toThrow(/company/)
  })

  it('deleteAttrs[i] / deleteEmployees[i] の構造不正は EmployeeMasterError', () => {
    expect(() => normalizeEmployeeMasterPutBody({ deleteAttrs: [null] })).toThrow(/deleteAttrs\[0\]/)
    expect(() =>
      normalizeEmployeeMasterPutBody({ deleteAttrs: [{ company: '株', payrollCd: '1', effectiveFrom: 'x' }] }),
    ).toThrow(/effectiveFrom/)
    expect(() => normalizeEmployeeMasterPutBody({ deleteEmployees: [null] })).toThrow(/deleteEmployees\[0\]/)
    expect(() => normalizeEmployeeMasterPutBody({ deleteEmployees: [{ company: '', payrollCd: '1' }] })).toThrow(
      /company/,
    )
    expect(() => normalizeEmployeeMasterPutBody({ deleteAttrs: [{ company: '', payrollCd: '1', effectiveFrom: '2026-01-01' }] })).toThrow(
      /company/,
    )
  })
})

describe('buildEmployeeMasterWriteStatements', () => {
  it('employees / attrs は upsert 文、delete系は DELETE 文になる', () => {
    const body = normalizeEmployeeMasterPutBody({
      employees: [{ company: '株', payrollCd: '7', name: '山田　太郎', driverCd: '99' }],
      attrs: [{ company: '株', payrollCd: '7', effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' }],
      deleteAttrs: [{ company: '有', payrollCd: '1', effectiveFrom: '2025-01-01' }],
      deleteEmployees: [{ company: '有', payrollCd: '2' }],
    })
    const statements = buildEmployeeMasterWriteStatements(body, '2026-07-23T00:00:00.000Z')
    expect(statements).toHaveLength(5)
    expect(statements[0]!.sql).toMatch(/INSERT INTO employees/)
    expect(statements[0]!.params).toEqual(['株', '7', '山田 太郎', '山田太郎', '99', '2026-07-23T00:00:00.000Z'])
    expect(statements[1]!.sql).toMatch(/INSERT INTO employee_attrs/)
    expect(statements[1]!.params).toEqual(['株', '7', '2026-04-01', '本社', 'A'])
    expect(statements[2]!.sql).toMatch(/DELETE FROM employee_attrs WHERE company/)
    expect(statements[2]!.params).toEqual(['有', '1', '2025-01-01'])
    // deleteEmployees は attrs → employees の順で 2 文
    expect(statements[3]!.sql).toMatch(/DELETE FROM employee_attrs WHERE company = \? AND payroll_cd = \?$/)
    expect(statements[3]!.params).toEqual(['有', '2'])
    expect(statements[4]!.sql).toMatch(/DELETE FROM employees/)
    expect(statements[4]!.params).toEqual(['有', '2'])
  })

  it('空 body は空配列', () => {
    expect(buildEmployeeMasterWriteStatements(normalizeEmployeeMasterPutBody({}), '2026-01-01T00:00:00.000Z')).toEqual(
      [],
    )
  })
})

describe('buildEmployeeMasterImportStatements', () => {
  it('INSERT OR IGNORE 文を組み立てる', () => {
    const statements = buildEmployeeMasterImportStatements(
      [{ company: '株', payrollCd: '7', name: '山田太郎', driverCd: '99' }],
      '2026-07-23T00:00:00.000Z',
    )
    expect(statements).toHaveLength(1)
    expect(statements[0]!.sql).toMatch(/INSERT OR IGNORE INTO employees/)
    expect(statements[0]!.params).toEqual(['株', '7', '山田太郎', '山田太郎', '99', '2026-07-23T00:00:00.000Z'])
  })
})

describe('cdMapEntriesToEmployees', () => {
  it('3部キー (会社スコープ) はキー自身の会社ラベルを使う', () => {
    const out = cdMapEntriesToEmployees({ '有|007|山田太郎': '99' }, '株')
    expect(out).toEqual([{ company: '有', payrollCd: '7', name: '山田太郎', driverCd: '99' }])
  })

  it('2部キー (旧形式) は fallbackCompany を補う', () => {
    const out = cdMapEntriesToEmployees({ '007|山田太郎': '0099' }, '株')
    expect(out).toEqual([{ company: '株', payrollCd: '7', name: '山田太郎', driverCd: '99' }])
  })

  it('fallbackCompany が空で会社ラベルが解決できないキーは除外する', () => {
    expect(cdMapEntriesToEmployees({ '007|山田太郎': '99' }, '')).toEqual([])
  })

  it('不正なキー形式 (2部/3部以外・給与コードが数字でない・氏名欠如) は除外する', () => {
    expect(
      cdMapEntriesToEmployees(
        {
          '007': '99', // 1部
          '株|007|山田太郎|余分': '99', // 4部
          'abc|山田太郎': '99', // 給与コードが数字でない
          '007|': '99', // 氏名が空
          '株||山田太郎': '99', // 3部だが給与コードが空
          '|007|山田太郎': '99', // 3部だが会社ラベルが空
        },
        '株',
      ),
    ).toEqual([])
  })
})

describe('buildEmployeeMasterResponse', () => {
  it('employees + attrs を company|payrollCd で結合し、attrs は effectiveFrom 昇順にする', () => {
    const employeeRows: EmployeeD1Row[] = [
      { company: '株', payroll_cd: '7', name: '山田太郎', driver_cd: '99' },
      { company: '有', payroll_cd: '1', name: '鈴木花子', driver_cd: null },
    ]
    const attrRows = [
      { company: '株', payroll_cd: '7', effective_from: '2026-04-01', branch: '本社', pay_scheme: 'A' },
      { company: '株', payroll_cd: '7', effective_from: '2025-04-01', branch: '支社', pay_scheme: 'B' },
    ]
    const res = buildEmployeeMasterResponse(employeeRows, attrRows, false)
    expect(res.migratable).toBe(false)
    expect(res.employees).toEqual([
      {
        company: '株',
        payrollCd: '7',
        name: '山田太郎',
        driverCd: '99',
        attrs: [
          { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
          { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
        ],
      },
      { company: '有', payrollCd: '1', name: '鈴木花子', driverCd: null, attrs: [] },
    ])
  })

  it('employees が空でも migratable をそのまま反映する', () => {
    expect(buildEmployeeMasterResponse([], [], true)).toEqual({ employees: [], migratable: true })
  })
})

describe('resolveAttrsAt', () => {
  const attrs: EmployeeAttrRow[] = [
    { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
    { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
  ]

  it('対象月の末日時点で最新の行を返す', () => {
    expect(resolveAttrsAt(attrs, '2025-06')).toEqual(attrs[0])
    expect(resolveAttrsAt(attrs, '2026-04')).toEqual(attrs[1])
    expect(resolveAttrsAt(attrs, '2026-12')).toEqual(attrs[1])
  })

  it('全て未来 (対象月の末日より後) なら null', () => {
    expect(resolveAttrsAt(attrs, '2025-01')).toBeNull()
  })

  it('attrs が空なら null', () => {
    expect(resolveAttrsAt([], '2026-01')).toBeNull()
  })

  it('yearMonth が不正な形式・月が範囲外なら null', () => {
    expect(resolveAttrsAt(attrs, '2026-1')).toBeNull()
    expect(resolveAttrsAt(attrs, '2026年01月')).toBeNull()
    expect(resolveAttrsAt(attrs, '2026-13')).toBeNull()
    expect(resolveAttrsAt(attrs, '2026-00')).toBeNull()
  })

  it('うるう年 2 月の末日 (29 日) を正しく解決する', () => {
    const feb: EmployeeAttrRow[] = [{ effectiveFrom: '2024-02-29', branch: null, payScheme: null }]
    expect(resolveAttrsAt(feb, '2024-02')).toEqual(feb[0])
    expect(resolveAttrsAt(feb, '2023-02')).toBeNull()
  })

  it('未整列 (新しい日付が先) でも有効な最新行を正しく選ぶ', () => {
    const unsorted: EmployeeAttrRow[] = [
      { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' },
      { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' },
    ]
    expect(resolveAttrsAt(unsorted, '2026-12')).toEqual(unsorted[0])
  })
})
