/**
 * `app/utils/employee-master.ts` のテスト (Refs #367)。
 */

import { describe, it, expect } from 'vitest'
import {
  buildCdMapEntries,
  buildDriverAttrIndex,
  collectAttrRows,
  findUnregistered,
  joinDriverAttr,
  normalizeAttrText,
  normalizeBranchCode,
  normalizeCompanyLabel,
  normalizeDriverCdKey,
  payScheme,
  planIchibanMatch,
  planPayrollDbImport,
  removeAttrRow,
  resolveAttrsAt,
  sortEmployeeEntries,
  splitCdMapKey,
  upsertAttrRow,
  type EmployeeAttrRow,
  type EmployeeMasterEntry,
  type KyuyoEmployeeRow,
  type KyuyoEmployeesResponse,
} from '../../app/utils/employee-master'
import type { SalaryCsvRow } from '../../app/utils/salary-compare'

function entry(over: Partial<EmployeeMasterEntry> = {}): EmployeeMasterEntry {
  return { company: '株', payrollCd: '7', name: '山田太郎', driverCd: '99', attrs: [], ...over }
}

/** 属性履歴 1 行。所属コード・営業所名・職種名 (Refs #409) は既定 null —
 * migration 0010 以前に取り込んだ行と同じ状態で、必要なテストだけ上書きする。 */
function attr(over: Partial<EmployeeAttrRow> & { effectiveFrom: string }): EmployeeAttrRow {
  return { branch: null, payScheme: null, branchCode: null, branchName: null, jobName: null, ...over }
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
      attr({ effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' }),
      attr({ effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' }),
    ],
  })

  it('対象月の末日時点で最新の行を返す', () => {
    expect(resolveAttrsAt(e, '2025-06')).toEqual(e.attrs[0])
    expect(resolveAttrsAt(e, '2026-12')).toEqual(e.attrs[1])
  })

  it('全て未来なら null', () => {
    expect(resolveAttrsAt(entry({ attrs: [attr({ effectiveFrom: '2026-04-01', branch: null, payScheme: null })] }), '2025-01')).toBeNull()
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
        attr({ effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' }),
        attr({ effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' }),
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
    attr({ effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' }),
    attr({ effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' }),
  ]

  it('新しい適用開始日を追加し昇順に並べ替える', () => {
    const out = upsertAttrRow(base, attr({ effectiveFrom: '2025-10-01', branch: '営業所', payScheme: 'C' }))
    expect(out.map(a => a.effectiveFrom)).toEqual(['2025-04-01', '2025-10-01', '2026-04-01'])
  })

  it('同じ適用開始日の行は置換する', () => {
    const out = upsertAttrRow(base, attr({ effectiveFrom: '2026-04-01', branch: '本社2', payScheme: null }))
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual(attr({ effectiveFrom: '2026-04-01', branch: '本社2', payScheme: null }))
  })

  it('元の配列は変更しない', () => {
    const attrs = [...base]
    upsertAttrRow(attrs, attr({ effectiveFrom: '2027-01-01', branch: null, payScheme: null }))
    expect(attrs).toHaveLength(2)
  })
})

describe('removeAttrRow', () => {
  it('指定した適用開始日の行だけ除く', () => {
    const out = removeAttrRow(
      [
        attr({ effectiveFrom: '2025-04-01', branch: '支社', payScheme: null }),
        attr({ effectiveFrom: '2026-04-01', branch: '本社', payScheme: null }),
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
      entry({ company: '株', payrollCd: '7', attrs: [attr({ effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' })] }),
      entry({ company: '有', payrollCd: '1', attrs: [] }),
    ])
    expect(out).toEqual([
      { company: '株', payrollCd: '7', effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A', branchCode: null, branchName: null, jobName: null },
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
          attr({ effectiveFrom: '2025-04-01', branch: '支社', payScheme: 'B' }),
          attr({ effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' }),
        ],
      })],
      '2026-07',
    )
    expect(index.get('7')).toEqual([
      { company: '株', attrs: attr({ effectiveFrom: '2026-04-01', branch: '本社', payScheme: 'A' }) },
    ])
  })

  it('driverCd 未突合・対象月末時点で有効な行が無い社員は載せない', () => {
    const index = buildDriverAttrIndex(
      [
        entry({ payrollCd: '1', driverCd: null, attrs: [attr({ effectiveFrom: '2020-01-01', branch: '本社', payScheme: null })] }),
        entry({ payrollCd: '2', driverCd: '50', attrs: [attr({ effectiveFrom: '2030-01-01', branch: '本社', payScheme: null })] }),
        entry({ payrollCd: '3', driverCd: '51', attrs: [] }),
      ],
      '2026-07',
    )
    expect(index.size).toBe(0)
  })

  it('同一 driverCd に複数会社が紐づいたら潰さず会社ラベル昇順で全部返す (Refs #403)', () => {
    // 並びはコードポイント順 (有 U+6709 < 株 U+682A)。localeCompare は ICU の
    // 照合順が環境で違い CI と開発機で逆になるため使わない。
    const index = buildDriverAttrIndex(
      [
        entry({ company: '株', payrollCd: '1', driverCd: '9', attrs: [attr({ effectiveFrom: '2020-01-01', branch: '本社 乗務員', payScheme: 'A' })] }),
        entry({ company: '有', payrollCd: '2', driverCd: '9', attrs: [attr({ effectiveFrom: '2021-01-01', branch: '帯広 乗務員', payScheme: 'B' })] }),
      ],
      '2026-07',
    )
    expect(index.get('9')).toEqual([
      { company: '有', attrs: attr({ effectiveFrom: '2021-01-01', branch: '帯広 乗務員', payScheme: 'B' }) },
      { company: '株', attrs: attr({ effectiveFrom: '2020-01-01', branch: '本社 乗務員', payScheme: 'A' }) },
    ])
  })

  it('同じ会社の複数行が同じ driverCd に紐づいても落とさない', () => {
    const index = buildDriverAttrIndex(
      [
        entry({ company: '株', payrollCd: '1', driverCd: '9', attrs: [attr({ effectiveFrom: '2020-01-01', branch: '本社', payScheme: null })] }),
        entry({ company: '株', payrollCd: '2', driverCd: '9', attrs: [attr({ effectiveFrom: '2020-01-01', branch: '諸富', payScheme: null })] }),
      ],
      '2026-07',
    )
    expect(index.get('9')).toHaveLength(2)
  })

  it('入力の並び順が違っても結果が同じ (D1 の SELECT 順に依存しない)', () => {
    const rows = [
      entry({ company: '株', payrollCd: '1', driverCd: '9', attrs: [attr({ effectiveFrom: '2020-01-01', branch: '本社', payScheme: null })] }),
      entry({ company: '有', payrollCd: '2', driverCd: '9', attrs: [attr({ effectiveFrom: '2020-01-01', branch: '帯広', payScheme: null })] }),
    ]
    const forward = buildDriverAttrIndex(rows, '2026-07').get('9')
    const reversed = buildDriverAttrIndex([...rows].reverse(), '2026-07').get('9')
    expect(forward).toEqual(reversed)
  })
})

describe('joinDriverAttr', () => {
  const entries = [
    { company: '株', attrs: attr({ effectiveFrom: '2026-01-01', branch: '本社 乗務員', payScheme: '体系1' }) },
    { company: '有', attrs: attr({ effectiveFrom: '2026-01-01', branch: '帯広 乗務員', payScheme: '体系2' }) },
  ]

  it('複数会社の値を " / " で連結する', () => {
    expect(joinDriverAttr(entries, 'branch')).toBe('本社 乗務員 / 帯広 乗務員')
    expect(joinDriverAttr(entries, 'payScheme')).toBe('体系1 / 体系2')
  })

  it('会社が違っても同値なら 1 つに畳む (従来の 1 値出力と同じになる)', () => {
    expect(joinDriverAttr([
      { company: '株', attrs: attr({ effectiveFrom: '2026-01-01', branch: '本社 乗務員', payScheme: null }) },
      { company: '有', attrs: attr({ effectiveFrom: '2026-01-01', branch: '本社 乗務員', payScheme: null }) },
    ], 'branch')).toBe('本社 乗務員')
  })

  it('未設定 (null・空文字) の値は落とす', () => {
    expect(joinDriverAttr([
      { company: '株', attrs: attr({ effectiveFrom: '2026-01-01', branch: null, payScheme: '' }) },
      { company: '有', attrs: attr({ effectiveFrom: '2026-01-01', branch: '帯広', payScheme: '体系2' }) },
    ], 'branch')).toBe('帯広')
    expect(joinDriverAttr([
      { company: '株', attrs: attr({ effectiveFrom: '2026-01-01', branch: null, payScheme: '' }) },
    ], 'payScheme')).toBe('')
  })

  it('該当なし (undefined・空配列) は空文字', () => {
    expect(joinDriverAttr(undefined, 'branch')).toBe('')
    expect(joinDriverAttr([], 'branch')).toBe('')
  })
})

describe('planIchibanMatch', () => {
  // 実データ形状: 社員R が表示名、社員N が氏名。両方をキーにする。
  const ichiban = [
    { employee_code: '1018', employee_name: '金原　敏雄', employee_r: '金原敏雄' },
    { employee_code: '1729', employee_name: '石坂　彰', employee_r: '石坂　彰' },
    { employee_code: '1101', employee_name: '大石　勉', employee_r: '大石　勉' },
    { employee_code: '9989', employee_name: '大石　勉', employee_r: '大石　勉' },
  ]

  it('氏名が一意なら社員C を提案する (前ゼロは除去)', () => {
    const plan = planIchibanMatch(
      [...ichiban, { employee_code: '0249', employee_name: '植木信彦', employee_r: '植木信彦' }],
      [entry({ company: '有', payrollCd: '222', name: '金原 敏雄', driverCd: null }),
        entry({ company: '有', payrollCd: '900', name: '植木 信彦', driverCd: null })],
    )
    expect(plan.matched).toEqual([
      { company: '有', payrollCd: '222', name: '金原 敏雄', personCd: '1018' },
      { company: '有', payrollCd: '900', name: '植木 信彦', personCd: '249' },
    ])
    expect(plan.ambiguous).toEqual([])
    expect(plan.notFound).toEqual([])
  })

  it('同名が複数なら提案せず候補を返す (大石 勉 → 1101 / 9989)', () => {
    const plan = planIchibanMatch(ichiban, [entry({ company: '有', payrollCd: '941', name: '大石 勉', driverCd: null })])
    expect(plan.matched).toEqual([])
    expect(plan.ambiguous).toEqual([
      { company: '有', payrollCd: '941', name: '大石 勉', candidates: ['1101', '9989'] },
    ])
  })

  it('一番星に無い氏名は notFound に回す', () => {
    const plan = planIchibanMatch(ichiban, [entry({ company: '株', payrollCd: '1773', name: 'イスラムエムディリドイ', driverCd: null })])
    expect(plan.matched).toEqual([])
    expect(plan.notFound).toEqual([{ company: '株', payrollCd: '1773', name: 'イスラムエムディリドイ' }])
  })

  it('社員CD が既に入っている行は触らない (手入力を上書きしない)', () => {
    const plan = planIchibanMatch(ichiban, [entry({ company: '株', payrollCd: '1767', name: '石坂 彰', driverCd: '1729' })])
    expect(plan).toEqual({ matched: [], ambiguous: [], notFound: [] })
  })

  it('× 始まりの無効行は 社員N のみ・社員R のみ・両方 の 3 パターンとも除外する', () => {
    const voided = [
      // 9903 実データ形状: 社員N だけに × が付く
      { employee_code: '9903', employee_name: '×松江隆', employee_r: '松江隆' },
      // 社員R だけに × が付く
      { employee_code: '9909', employee_name: '松本俊之', employee_r: '×松本' },
      // 両方
      { employee_code: '1137', employee_name: '×大石和也', employee_r: '×大石' },
    ]
    const plan = planIchibanMatch(voided, [
      entry({ company: '有', payrollCd: '1', name: '松江 隆', driverCd: null }),
      entry({ company: '有', payrollCd: '2', name: '松本 俊之', driverCd: null }),
      entry({ company: '有', payrollCd: '3', name: '大石 和也', driverCd: null }),
    ])
    expect(plan.matched).toEqual([])
    expect(plan.notFound).toHaveLength(3)
  })

  it('9000 番台でも実在社員は落とさない (北海大運、Refs #403)', () => {
    // 一番星の 9000 番台は拠点・法人・集計枠と実在社員の混成。番号帯で切ると
    // 北海大運の乗務員が突合できなくなる。
    const plan = planIchibanMatch(
      [
        { employee_code: '9001', employee_name: '加納和広北海大運', employee_r: '加納和広' },
        { employee_code: '9101', employee_name: '佐賀(営)', employee_r: '佐賀(営)' },
        { employee_code: '9999', employee_name: '収支用', employee_r: '収支用' },
      ],
      [entry({ company: '有', payrollCd: '10', name: '加納 和広', driverCd: null })],
    )
    expect(plan.matched).toEqual([
      { company: '有', payrollCd: '10', name: '加納 和広', personCd: '9001' },
    ])
  })

  it('氏名が空の一番星行はキーにしない', () => {
    const plan = planIchibanMatch(
      [{ employee_code: '5000', employee_name: '', employee_r: '' }],
      [entry({ company: '有', payrollCd: '1', name: '金原 敏雄', driverCd: null })],
    )
    expect(plan.notFound).toHaveLength(1)
  })

  it('提案は会社ラベル昇順 → 給与コード数値昇順 (入力順に依らない)', () => {
    // コードポイント順 (有 U+6709 < 株 U+682A)。同一会社内は給与コードの数値順。
    const employees = [
      entry({ company: '株', payrollCd: '9', name: '石坂 彰', driverCd: null }),
      entry({ company: '有', payrollCd: '10', name: '金原 敏雄', driverCd: null }),
      entry({ company: '株', payrollCd: '2', name: '大石 和也', driverCd: null }),
    ]
    const forward = planIchibanMatch(ichiban, employees)
    const reversed = planIchibanMatch(ichiban, [...employees].reverse())
    expect(forward).toEqual(reversed)
    expect(forward.matched.map(m => `${m.company}|${m.payrollCd}`)).toEqual(['有|10', '株|9'])
    // 大石 和也 は一番星に居ないので notFound。同一会社内の数値順を確認する
    expect(forward.notFound.map(n => `${n.company}|${n.payrollCd}`)).toEqual(['株|2'])
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

  it('所属コードは正の整数だけ通す (worker の PUT 検証と同一規則、Refs #409)', () => {
    expect(normalizeBranchCode(14)).toBe(14)
    // 0 は給与大臣側の「未設定」
    expect(normalizeBranchCode(0)).toBeNull()
    expect(normalizeBranchCode(-1)).toBeNull()
    expect(normalizeBranchCode(1.5)).toBeNull()
    expect(normalizeBranchCode('14')).toBeNull()
    expect(normalizeBranchCode(null)).toBeNull()
    expect(normalizeBranchCode(undefined)).toBeNull()
  })
})

describe('planPayrollDbImport', () => {
  const kyuyoRow = (over: Partial<KyuyoEmployeeRow> = {}): KyuyoEmployeeRow => ({
    employee_code: '0007',
    employee_code_key: '7',
    employee_name: '山田　太郎',
    department: '本社　乗務員',
    department_code: 14,
    branch_name: '本社',
    job_name: '乗務員',
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

  it('新規社員は employees + attrs を作り、会社は給与大臣の会社コード (Refs #405)', () => {
    const plan = planPayrollDbImport(res([kyuyoRow()]), [], '2026-07', null)
    expect(plan.added).toBe(1)
    expect(plan.merged).toBe(0)
    expect(plan.employees).toEqual([
      { company: '0100', payrollCd: '7', name: '山田　太郎', driverCd: null },
    ])
    expect(plan.attrs).toEqual([
      {
        company: '0100',
        payrollCd: '7',
        effectiveFrom: '2026-07-01',
        branch: '本社 乗務員',
        payScheme: '体系1',
        branchCode: 14,
        branchName: '本社',
        jobName: '乗務員',
      },
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
    const current = entry({ company: '0100', payrollCd: '7', name: '旧氏名', driverCd: '9902' })
    const plan = planPayrollDbImport(res([kyuyoRow()]), [current], '2026-07', '有')
    expect(plan.added).toBe(0)
    expect(plan.merged).toBe(0)
    expect(plan.employees[0]!.driverCd).toBe('9902')
    expect(plan.employees[0]!.name).toBe('山田　太郎')
  })

  it('対象月末時点で同じ所属/体系が効いているなら履歴を増やさない', () => {
    const current = entry({
      company: '0100',
      payrollCd: '7',
      driverCd: null,
      attrs: [attr({
        effectiveFrom: '2026-04-01',
        branch: '本社 乗務員',
        payScheme: '体系1',
        branchCode: 14,
        branchName: '本社',
        jobName: '乗務員',
      })],
    })
    const plan = planPayrollDbImport(res([kyuyoRow()]), [current], '2026-07', null)
    expect(plan.attrs).toEqual([])
  })

  it('所属コードだけ未取得の既存行は、再取り込みで埋める (Refs #409)', () => {
    // migration 0010 以前に取り込んだ本番 182 件がこの状態。所属名は同じでも
    // 所属コード・営業所名・職種名が空なので差分として拾い、履歴行を更新する
    const current = entry({
      company: '0100',
      payrollCd: '7',
      driverCd: null,
      attrs: [attr({ effectiveFrom: '2026-07-01', branch: '本社 乗務員', payScheme: '体系1' })],
    })
    const plan = planPayrollDbImport(res([kyuyoRow()]), [current], '2026-07', null)
    // 同じ effectiveFrom なので D1 側は UPDATE になり、履歴は増えない
    expect(plan.attrs).toEqual([
      {
        company: '0100',
        payrollCd: '7',
        effectiveFrom: '2026-07-01',
        branch: '本社 乗務員',
        payScheme: '体系1',
        branchCode: 14,
        branchName: '本社',
        jobName: '乗務員',
      },
    ])
  })

  it('所属コード列を返さない古い API 応答でも取り込める (rust-ichibanboshi#98 以前)', () => {
    const row = kyuyoRow()
    delete row.department_code
    delete row.branch_name
    delete row.job_name
    const plan = planPayrollDbImport(res([row]), [], '2026-07', null)
    expect(plan.attrs[0]).toMatchObject({
      branch: '本社 乗務員',
      branchCode: null,
      branchName: null,
      jobName: null,
    })
  })

  it('所属コードが 0 (給与大臣側の未設定) なら null にする', () => {
    const plan = planPayrollDbImport(
      res([kyuyoRow({ department_code: 0, branch_name: '  ', job_name: '' })]), [], '2026-07', null)
    expect(plan.attrs[0]).toMatchObject({ branchCode: null, branchName: null, jobName: null })
  })

  it('所属が変わっていれば当月初の履歴を足す', () => {
    const current = entry({
      company: '0100',
      payrollCd: '7',
      driverCd: null,
      attrs: [attr({ effectiveFrom: '2026-04-01', branch: '支社', payScheme: '体系1' })],
    })
    const plan = planPayrollDbImport(res([kyuyoRow()]), [current], '2026-07', null)
    expect(plan.attrs).toEqual([
      {
        company: '0100',
        payrollCd: '7',
        effectiveFrom: '2026-07-01',
        branch: '本社 乗務員',
        payScheme: '体系1',
        branchCode: 14,
        branchName: '本社',
        jobName: '乗務員',
      },
    ])
  })

  it('保存側の NFKC 正規化と同値なら履歴を増やさない (全角スペース差で誤検知しない)', () => {
    const current = entry({
      company: '0100',
      payrollCd: '7',
      driverCd: null,
      attrs: [attr({
        effectiveFrom: '2026-04-01',
        branch: '本社 乗務員',
        payScheme: '体系1',
        branchCode: 14,
        branchName: '本社',
        jobName: '乗務員',
      })],
    })
    const plan = planPayrollDbImport(res([kyuyoRow({ department: '本社　乗務員' })]), [current], '2026-07', null)
    expect(plan.attrs).toEqual([])
  })

  it('所属も体系も無い新規社員は属性行を作らない', () => {
    const plan = planPayrollDbImport(
      res([kyuyoRow({ department: '  ', taikei: 0, department_code: 0, branch_name: '  ', job_name: '  ' })]),
      [], '2026-07', null)
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
