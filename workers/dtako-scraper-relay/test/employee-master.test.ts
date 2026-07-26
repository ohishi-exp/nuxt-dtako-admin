import { describe, expect, it } from 'vitest'
import {
  buildCompMapResponse,
  buildEmployeeMasterResponse,
  buildEmployeeMasterWriteStatements,
  EmployeeMasterError,
  normalizeEmployeeMasterPutBody,
  normalizeNameKey,
  payKubunByDriverCdAt,
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
      payrollCompanyName: null,
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
      { company: '株', payrollCd: '7', effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A', branchCode: null, branchName: null, jobName: null, payKubun: null },
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
      branchCode: null,
      branchName: null,
      jobName: null,
      payKubun: null,
    })
    expect(body.attrs[1]).toEqual({
      company: '株',
      payrollCd: '1',
      effectiveFrom: '2026-02-01',
      branch: null,
      payScheme: null,
      branchCode: null,
      branchName: null,
      jobName: null,
      payKubun: null,
    })
  })

  it('attrs.payKubun は 1〜4 の整数だけ通し、範囲外・0・非数値は null にする (Refs #429)', () => {
    const attrOf = (payKubun: unknown) => ({
      company: '株', payrollCd: '1', effectiveFrom: '2026-01-01', payKubun,
    })
    const body = normalizeEmployeeMasterPutBody({
      attrs: [attrOf(1), attrOf(4), attrOf(0), attrOf(5), attrOf(-1), attrOf(2.5), attrOf('2'), attrOf(undefined)],
    })
    // 知らない値を既定区分へ寄せない — 寄せると月給者に日額計算を掛ける壊れ方が残る
    expect(body.attrs.map(a => a.payKubun)).toEqual([1, 4, null, null, null, null, null, null])
  })

  it('attrs.branchCode/branchName/jobName を検証・正規化する (Refs #409)', () => {
    const body = normalizeEmployeeMasterPutBody({
      attrs: [{
        company: '株',
        payrollCd: '7',
        effectiveFrom: '2026-04-01',
        branch: '本社　乗務員',
        payScheme: '体系1',
        branchCode: 14,
        branchName: ' 本社 ',
        jobName: '乗務員',
      }],
    })
    expect(body.attrs[0]).toEqual({
      company: '株',
      payrollCd: '7',
      effectiveFrom: '2026-04-01',
      branch: '本社 乗務員',
      payScheme: '体系1',
      branchCode: 14,
      branchName: '本社',
      jobName: '乗務員',
      payKubun: null,
    })
  })

  it('branchCode は 0・非整数・非数値を null にする (並べ替えのヒントなので fail-soft)', () => {
    const attrs = [0, -1, 1.5, '14', null, undefined, Number.NaN].map((branchCode, i) => ({
      company: '株',
      payrollCd: '1',
      effectiveFrom: `2026-01-${String(i + 1).padStart(2, '0')}`,
      branchCode,
    }))
    const body = normalizeEmployeeMasterPutBody({ attrs })
    expect(body.attrs.map(a => a.branchCode)).toEqual([null, null, null, null, null, null, null])
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
    const statements = buildEmployeeMasterWriteStatements(body, '2026-07-23T00:00:00.000Z', '27324455')
    expect(statements).toHaveLength(5)
    expect(statements[0]!.sql).toMatch(/INSERT INTO employees/)
    expect(statements[0]!.params).toEqual(['27324455', '株', '7', '山田 太郎', '山田太郎', '99', '2026-07-23T00:00:00.000Z'])
    expect(statements[1]!.sql).toMatch(/INSERT INTO employee_attrs/)
    expect(statements[1]!.params).toEqual(['27324455', '株', '7', '2026-04-01', '本社', 'A', null, null, null, null])
    expect(statements[2]!.sql).toMatch(/DELETE FROM employee_attrs WHERE comp_id/)
    expect(statements[2]!.params).toEqual(['27324455', '有', '1', '2025-01-01'])
    // deleteEmployees は attrs → employees の順で 2 文
    expect(statements[3]!.sql).toMatch(/DELETE FROM employee_attrs WHERE comp_id = \? AND company = \? AND payroll_cd = \?$/)
    expect(statements[3]!.params).toEqual(['27324455', '有', '2'])
    expect(statements[4]!.sql).toMatch(/DELETE FROM employees/)
    expect(statements[4]!.params).toEqual(['27324455', '有', '2'])
  })

  it('全文が comp_id をバインドする (テナント跨ぎで書かない、Refs #367)', () => {
    const body = normalizeEmployeeMasterPutBody({
      employees: [{ company: '株', payrollCd: '7', name: '山田太郎', driverCd: null }],
      attrs: [{ company: '株', payrollCd: '7', effectiveFrom: '2026-04-01', branch: null, payScheme: null }],
      deleteAttrs: [{ company: '有', payrollCd: '1', effectiveFrom: '2025-01-01' }],
      deleteEmployees: [{ company: '有', payrollCd: '2' }],
    })
    const statements = buildEmployeeMasterWriteStatements(body, '2026-07-23T00:00:00.000Z', '75700192')
    expect(statements.every(s => s.sql.includes('comp_id'))).toBe(true)
    expect(statements.every(s => s.params[0] === '75700192')).toBe(true)
  })

  it('attrs の upsert は所属コード・営業所名・職種名・給与区分も更新する (Refs #409 #429)', () => {
    const body = normalizeEmployeeMasterPutBody({
      attrs: [{
        company: '0100',
        payrollCd: '7',
        effectiveFrom: '2026-06-01',
        branch: '本社 乗務員',
        payScheme: '体系1',
        branchCode: 14,
        branchName: '本社',
        jobName: '乗務員',
        payKubun: 2,
      }],
    })
    const [stmt] = buildEmployeeMasterWriteStatements(body, '2026-07-25T00:00:00.000Z', '27324455')
    expect(stmt!.sql).toMatch(/branch_code = excluded\.branch_code/)
    expect(stmt!.sql).toMatch(/branch_name = excluded\.branch_name/)
    expect(stmt!.sql).toMatch(/job_name = excluded\.job_name/)
    expect(stmt!.sql).toMatch(/pay_kubun = excluded\.pay_kubun/)
    // 既存行 (migration 0010/0013 以前) は同じ effective_from で UPDATE され、列が埋まる
    expect(stmt!.params).toEqual([
      '27324455', '0100', '7', '2026-06-01', '本社 乗務員', '体系1', 14, '本社', '乗務員', 2,
    ])
  })

  it('空 body は空配列', () => {
    expect(
      buildEmployeeMasterWriteStatements(normalizeEmployeeMasterPutBody({}), '2026-01-01T00:00:00.000Z', '27324455'),
    ).toEqual([])
  })

  it('payrollCompanyName があれば comp_payroll_map の表示名を更新する (Refs #405)', () => {
    const body = normalizeEmployeeMasterPutBody({
      payrollCompanyName: { payrollCompany: '0100', name: ' 有限会社　大石運輸 ' },
    })
    const statements = buildEmployeeMasterWriteStatements(body, '2026-01-01T00:00:00.000Z', '27324455')
    expect(statements).toHaveLength(1)
    expect(statements[0]!.sql).toMatch(/UPDATE comp_payroll_map SET payroll_company_name/)
    // NFKC + trim を通す (全角スペースは残す — 会社名の一部でありうる)
    expect(statements[0]!.params).toEqual(['有限会社 大石運輸', '27324455', '0100'])
  })
})

describe('normalizeEmployeeMasterPutBody — payrollCompanyName (Refs #405)', () => {
  it('省略・null は null', () => {
    expect(normalizeEmployeeMasterPutBody({}).payrollCompanyName).toBeNull()
    expect(normalizeEmployeeMasterPutBody({ payrollCompanyName: null }).payrollCompanyName).toBeNull()
  })

  it('会社名が空文字なら null (未取得扱い、表示専用なので落として良い)', () => {
    expect(normalizeEmployeeMasterPutBody({
      payrollCompanyName: { payrollCompany: '0100', name: '   ' },
    }).payrollCompanyName).toBeNull()
    expect(normalizeEmployeeMasterPutBody({
      payrollCompanyName: { payrollCompany: '0100' },
    }).payrollCompanyName).toBeNull()
  })

  it('オブジェクトでなければ 400 相当のエラー', () => {
    expect(() => normalizeEmployeeMasterPutBody({ payrollCompanyName: 'x' })).toThrow(EmployeeMasterError)
    expect(() => normalizeEmployeeMasterPutBody({ payrollCompanyName: [] })).toThrow(EmployeeMasterError)
  })

  it('payrollCompany が空なら 400 相当のエラー', () => {
    expect(() => normalizeEmployeeMasterPutBody({
      payrollCompanyName: { payrollCompany: '', name: 'x' },
    })).toThrow(EmployeeMasterError)
  })
})

describe('buildEmployeeMasterResponse', () => {
  it('employees + attrs を company|payrollCd で結合し、attrs は effectiveFrom 昇順にする', () => {
    const employeeRows: EmployeeD1Row[] = [
      { company: '株', payroll_cd: '7', name: '山田太郎', driver_cd: '99' },
      { company: '有', payroll_cd: '1', name: '鈴木花子', driver_cd: null },
    ]
    const attrRows = [
      { company: '株', payroll_cd: '7', effective_from: '2026-04-01', branch: '本社', pay_scheme: 'A', branch_code: 14, branch_name: '本社', job_name: '乗務員', pay_kubun: 2 },
      // migration 0013 以前に取り込んだ行は pay_kubun が NULL のまま
      { company: '株', payroll_cd: '7', effective_from: '2025-04-01', branch: '支社', pay_scheme: 'B', branch_code: null, branch_name: null, job_name: null, pay_kubun: null },
    ]
    const res = buildEmployeeMasterResponse(employeeRows, attrRows)
    expect(res.employees).toEqual([
      {
        company: '株',
        payrollCd: '7',
        name: '山田太郎',
        driverCd: '99',
        attrs: [
          { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B', branchCode: null, branchName: null, jobName: null, payKubun: null },
          { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A', branchCode: 14, branchName: '本社', jobName: '乗務員', payKubun: 2 },
        ],
      },
      { company: '有', payrollCd: '1', name: '鈴木花子', driverCd: null, attrs: [] },
    ])
  })

  it('行が無ければ空配列を返す', () => {
    expect(buildEmployeeMasterResponse([], [])).toEqual({ employees: [] })
  })
})

describe('resolveAttrsAt', () => {
  const attrs: EmployeeAttrRow[] = [
    { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B', branchCode: null, branchName: null, jobName: null, payKubun: null },
    { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A', branchCode: null, branchName: null, jobName: null, payKubun: null },
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
    const feb: EmployeeAttrRow[] = [{ effectiveFrom: '2024-02-29', branch: null, payScheme: null, branchCode: null, branchName: null, jobName: null, payKubun: null }]
    expect(resolveAttrsAt(feb, '2024-02')).toEqual(feb[0])
    expect(resolveAttrsAt(feb, '2023-02')).toBeNull()
  })

  it('未整列 (新しい日付が先) でも有効な最新行を正しく選ぶ', () => {
    const unsorted: EmployeeAttrRow[] = [
      { effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A', branchCode: null, branchName: null, jobName: null, payKubun: null },
      { effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B', branchCode: null, branchName: null, jobName: null, payKubun: null },
    ]
    expect(resolveAttrsAt(unsorted, '2026-12')).toEqual(unsorted[0])
  })
})

describe('payKubunByDriverCdAt', () => {
  const attr = (effectiveFrom: string, payKubun: number | null) => ({ effectiveFrom, payKubun })

  it('乗務員CD → 月末時点の給与区分を引く', () => {
    const employees = [
      { driverCd: '99', attrs: [attr('2025-04-01', 2), attr('2026-04-01', 1)] },
      { driverCd: '100', attrs: [attr('2025-04-01', 3)] },
    ]
    const at2025 = payKubunByDriverCdAt(employees, '2025-06', resolveAttrsAt as never)
    expect(at2025.get('99')).toBe(2)
    // 履歴が切り替わったあとの月は新しい区分
    const at2026 = payKubunByDriverCdAt(employees, '2026-06', resolveAttrsAt as never)
    expect(at2026.get('99')).toBe(1)
    expect(at2026.get('100')).toBe(3)
  })

  it('乗務員CD 無し・履歴なし・区分 null は Map に入れない (呼び出し側が「不明」に倒せる)', () => {
    const employees = [
      { driverCd: null, attrs: [attr('2025-04-01', 2)] },
      // 月末より後の履歴しか無い
      { driverCd: '1', attrs: [attr('2030-01-01', 2)] },
      // migration 0013 以前の行 (pay_kubun が NULL)
      { driverCd: '2', attrs: [attr('2025-04-01', null)] },
      { driverCd: '3', attrs: [] },
    ]
    const map = payKubunByDriverCdAt(employees, '2026-06', resolveAttrsAt as never)
    expect(map.size).toBe(0)
  })
})

describe('buildCompMapResponse', () => {
  const rows = [
    { comp_id: '27324455', comp_label: '大石運輸倉庫', payroll_company: '0200', legacy_label: '株', payroll_company_name: '大石運輸倉庫株式会社', sort_order: 2 },
    { comp_id: '27324455', comp_label: '大石運輸倉庫', payroll_company: '0100', legacy_label: '有', payroll_company_name: '有限会社 大石運輸', sort_order: 1 },
    { comp_id: '75700192', comp_label: '北海大運', payroll_company: '0400', legacy_label: null, payroll_company_name: null, sort_order: 1 },
  ]

  it('会社単位に畳み、sort_order 昇順で並べる', () => {
    const out = buildCompMapResponse(rows, new Set(['27324455', '75700192']))
    expect(out).toHaveLength(2)
    expect(out[0]!.compId).toBe('27324455')
    expect(out[0]!.compLabel).toBe('大石運輸倉庫')
    expect(out[0]!.payrollCompanies.map(p => p.payrollCompany)).toEqual(['0100', '0200'])
    expect(out[0]!.payrollCompanies[0]!.legacyLabel).toBe('有')
    expect(out[0]!.payrollCompanies[0]!.payrollCompanyName).toBe('有限会社 大石運輸')
    expect(out[1]!.payrollCompanies).toEqual([
      { payrollCompany: '0400', legacyLabel: null, payrollCompanyName: null },
    ])
  })

  it('allowed に無い会社は落とす (別テナントへ会社名を見せない)', () => {
    const out = buildCompMapResponse(rows, new Set(['75700192']))
    expect(out.map(c => c.compId)).toEqual(['75700192'])
  })

  it('allowed が空なら空配列', () => {
    expect(buildCompMapResponse(rows, new Set())).toEqual([])
  })

  it('同一 sort_order は会社コード昇順で安定する', () => {
    const tied = [
      { comp_id: 'c', comp_label: 'C', payroll_company: '0200', legacy_label: null, payroll_company_name: null, sort_order: 1 },
      { comp_id: 'c', comp_label: 'C', payroll_company: '0100', legacy_label: null, payroll_company_name: null, sort_order: 1 },
    ]
    const out = buildCompMapResponse(tied, new Set(['c']))
    expect(out[0]!.payrollCompanies.map(p => p.payrollCompany)).toEqual(['0100', '0200'])
  })
})
