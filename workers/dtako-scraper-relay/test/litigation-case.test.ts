import { describe, expect, it } from 'vitest'
import {
  buildLitigationCaseDeleteStatement,
  buildLitigationCaseGetStatement,
  buildLitigationCaseListResponse,
  buildLitigationCaseListStatement,
  buildLitigationCaseUpsertStatement,
  extractCaseId,
  LitigationCaseError,
  LITIGATION_CASE_MAX_DRIVERS,
  LITIGATION_CASE_MAX_MONTHS,
  LITIGATION_CASE_NAME_MAX_LENGTH,
  normalizeLitigationCaseInput,
  parseLitigationCaseRow,
  type LitigationCaseD1Row,
} from '../src/litigation-case'

const COMP = '27324455'
const NOW = '2026-09-25T00:00:00.000Z'

function baseRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '未払残業代請求事件',
    fromMonth: '2024-04',
    toMonth: '2024-06',
    driverCds: ['1194', '1523'],
    memo: '第1回口頭弁論に向けて',
    ...overrides,
  }
}

describe('normalizeLitigationCaseInput', () => {
  it('正常系: そのまま正規化される', () => {
    const input = normalizeLitigationCaseInput(baseRaw())
    expect(input).toEqual({
      name: '未払残業代請求事件',
      fromMonth: '2024-04',
      toMonth: '2024-06',
      driverCds: ['1194', '1523'],
      memo: '第1回口頭弁論に向けて',
    })
  })

  it('name は NFKC 正規化 + trim される', () => {
    const input = normalizeLitigationCaseInput(baseRaw({ name: '　全角ＡＢＣ　' }))
    expect(input.name).toBe('全角ABC')
  })

  it('fromMonth > toMonth は昇順へ入れ替える', () => {
    const input = normalizeLitigationCaseInput(baseRaw({ fromMonth: '2024-06', toMonth: '2024-04' }))
    expect(input.fromMonth).toBe('2024-04')
    expect(input.toMonth).toBe('2024-06')
  })

  it('driverCds は前ゼロを除去し重複を除去する (入力順を保つ)', () => {
    const input = normalizeLitigationCaseInput(baseRaw({ driverCds: ['01194', '1194', '1523'] }))
    expect(input.driverCds).toEqual(['1194', '1523'])
  })

  it('memo 省略時は空文字', () => {
    const raw = baseRaw()
    delete raw.memo
    const input = normalizeLitigationCaseInput(raw)
    expect(input.memo).toBe('')
  })

  it('memo が文字列でなければ空文字へ倒す', () => {
    const input = normalizeLitigationCaseInput(baseRaw({ memo: 123 }))
    expect(input.memo).toBe('')
  })

  it('memo は NFKC 正規化 + trim される', () => {
    const input = normalizeLitigationCaseInput(baseRaw({ memo: '　備考　' }))
    expect(input.memo).toBe('備考')
  })

  it('入力がオブジェクトでなければ LitigationCaseError', () => {
    expect(() => normalizeLitigationCaseInput(null)).toThrow(LitigationCaseError)
    expect(() => normalizeLitigationCaseInput('x')).toThrow(LitigationCaseError)
    expect(() => normalizeLitigationCaseInput([1, 2])).toThrow(LitigationCaseError)
  })

  it('name が文字列でなければ LitigationCaseError', () => {
    expect(() => normalizeLitigationCaseInput(baseRaw({ name: 123 }))).toThrow(LitigationCaseError)
  })

  it('name が空文字なら LitigationCaseError', () => {
    expect(() => normalizeLitigationCaseInput(baseRaw({ name: '   ' }))).toThrow(LitigationCaseError)
  })

  it(`name が ${LITIGATION_CASE_NAME_MAX_LENGTH} 文字を超えたら LitigationCaseError`, () => {
    const tooLong = 'あ'.repeat(LITIGATION_CASE_NAME_MAX_LENGTH + 1)
    expect(() => normalizeLitigationCaseInput(baseRaw({ name: tooLong }))).toThrow(LitigationCaseError)
  })

  it(`name がちょうど ${LITIGATION_CASE_NAME_MAX_LENGTH} 文字なら通る`, () => {
    const maxLen = 'あ'.repeat(LITIGATION_CASE_NAME_MAX_LENGTH)
    expect(normalizeLitigationCaseInput(baseRaw({ name: maxLen })).name).toBe(maxLen)
  })

  it('fromMonth が YYYY-MM 形式でなければ LitigationCaseError', () => {
    expect(() => normalizeLitigationCaseInput(baseRaw({ fromMonth: '2024/04' }))).toThrow(LitigationCaseError)
    expect(() => normalizeLitigationCaseInput(baseRaw({ fromMonth: 123 }))).toThrow(LitigationCaseError)
  })

  it('toMonth が YYYY-MM 形式でなければ LitigationCaseError', () => {
    expect(() => normalizeLitigationCaseInput(baseRaw({ toMonth: '2024-13' }))).toThrow(LitigationCaseError)
  })

  it(`期間が ${LITIGATION_CASE_MAX_MONTHS} か月を超えたら LitigationCaseError`, () => {
    // 2020-01 〜 2025-02 = 61 か月
    expect(() =>
      normalizeLitigationCaseInput(baseRaw({ fromMonth: '2020-01', toMonth: '2025-02' })),
    ).toThrow(LitigationCaseError)
  })

  it(`期間がちょうど ${LITIGATION_CASE_MAX_MONTHS} か月なら通る`, () => {
    // 2020-01 〜 2024-12 = 60 か月
    const input = normalizeLitigationCaseInput(baseRaw({ fromMonth: '2020-01', toMonth: '2024-12' }))
    expect(input.fromMonth).toBe('2020-01')
    expect(input.toMonth).toBe('2024-12')
  })

  it('driverCds が配列でなければ LitigationCaseError', () => {
    expect(() => normalizeLitigationCaseInput(baseRaw({ driverCds: '1194' }))).toThrow(LitigationCaseError)
  })

  it('driverCds の要素が数字 (最大8桁) でなければ LitigationCaseError', () => {
    expect(() => normalizeLitigationCaseInput(baseRaw({ driverCds: ['abc'] }))).toThrow(LitigationCaseError)
    expect(() => normalizeLitigationCaseInput(baseRaw({ driverCds: ['123456789'] }))).toThrow(LitigationCaseError)
    expect(() => normalizeLitigationCaseInput(baseRaw({ driverCds: [1194] }))).toThrow(LitigationCaseError)
  })

  it('driverCds が空配列なら LitigationCaseError', () => {
    expect(() => normalizeLitigationCaseInput(baseRaw({ driverCds: [] }))).toThrow(LitigationCaseError)
  })

  it('重複除去後も driverCds が空なら LitigationCaseError', () => {
    // 重複除去前は非空だが、除去後は 1 件だけ残る想定を明示するテスト (境界確認)
    expect(() => normalizeLitigationCaseInput(baseRaw({ driverCds: ['1194', '01194'] }))).not.toThrow()
  })

  it(`driverCds が ${LITIGATION_CASE_MAX_DRIVERS} 件を超えたら LitigationCaseError`, () => {
    const many = Array.from({ length: LITIGATION_CASE_MAX_DRIVERS + 1 }, (_, i) => String(i + 1))
    expect(() => normalizeLitigationCaseInput(baseRaw({ driverCds: many }))).toThrow(LitigationCaseError)
  })

  it(`driverCds がちょうど ${LITIGATION_CASE_MAX_DRIVERS} 件なら通る`, () => {
    const many = Array.from({ length: LITIGATION_CASE_MAX_DRIVERS }, (_, i) => String(i + 1))
    expect(normalizeLitigationCaseInput(baseRaw({ driverCds: many })).driverCds).toHaveLength(LITIGATION_CASE_MAX_DRIVERS)
  })
})

describe('extractCaseId', () => {
  it('caseId が非空文字列なら trim して返す', () => {
    expect(extractCaseId({ caseId: '  abc-123  ' })).toBe('abc-123')
  })

  it('caseId が無ければ null', () => {
    expect(extractCaseId({})).toBeNull()
  })

  it('caseId が文字列でなければ null', () => {
    expect(extractCaseId({ caseId: 123 })).toBeNull()
  })

  it('caseId が空文字/空白のみなら null', () => {
    expect(extractCaseId({ caseId: '   ' })).toBeNull()
  })

  it('raw が falsy なら null', () => {
    expect(extractCaseId(null)).toBeNull()
    expect(extractCaseId(undefined)).toBeNull()
  })

  it('raw がオブジェクトでなければ null', () => {
    expect(extractCaseId('x')).toBeNull()
  })

  it('raw が配列なら null', () => {
    expect(extractCaseId(['caseId'])).toBeNull()
  })
})

describe('D1 文の組み立て', () => {
  it('buildLitigationCaseUpsertStatement は comp_id を先頭に持つ', () => {
    const input = normalizeLitigationCaseInput(baseRaw())
    const stmt = buildLitigationCaseUpsertStatement(input, 'case-1', COMP, 'viewer@example.com', NOW)
    expect(stmt.sql).toMatch(/INSERT INTO litigation_cases/)
    expect(stmt.sql).toMatch(/ON CONFLICT\(comp_id, case_id\) DO UPDATE SET/)
    expect(stmt.params).toEqual([
      COMP,
      'case-1',
      input.name,
      input.fromMonth,
      input.toMonth,
      JSON.stringify(input.driverCds),
      input.memo,
      'viewer@example.com',
      NOW,
      NOW,
    ])
  })

  it('buildLitigationCaseUpsertStatement は createdBy が null でも組める', () => {
    const input = normalizeLitigationCaseInput(baseRaw())
    const stmt = buildLitigationCaseUpsertStatement(input, 'case-1', COMP, null, NOW)
    expect(stmt.params[7]).toBeNull()
  })

  it('buildLitigationCaseListStatement は comp_id だけを条件にする', () => {
    const stmt = buildLitigationCaseListStatement(COMP)
    expect(stmt.sql).toMatch(/WHERE comp_id = \?/)
    expect(stmt.sql).toMatch(/ORDER BY updated_at DESC/)
    expect(stmt.params).toEqual([COMP])
  })

  it('buildLitigationCaseGetStatement は comp_id と case_id を条件にする', () => {
    const stmt = buildLitigationCaseGetStatement(COMP, 'case-1')
    expect(stmt.sql).toMatch(/WHERE comp_id = \? AND case_id = \?/)
    expect(stmt.params).toEqual([COMP, 'case-1'])
  })

  it('buildLitigationCaseDeleteStatement は comp_id と case_id を条件にする', () => {
    const stmt = buildLitigationCaseDeleteStatement(COMP, 'case-1')
    expect(stmt.sql).toMatch(/DELETE FROM litigation_cases WHERE comp_id = \? AND case_id = \?/)
    expect(stmt.params).toEqual([COMP, 'case-1'])
  })
})

function row(overrides: Partial<LitigationCaseD1Row> = {}): LitigationCaseD1Row {
  return {
    case_id: 'case-1',
    name: '未払残業代請求事件',
    from_month: '2024-04',
    to_month: '2024-06',
    driver_cds: JSON.stringify(['1194', '1523']),
    memo: '',
    created_by: 'viewer@example.com',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  }
}

describe('parseLitigationCaseRow', () => {
  it('driver_cds を JSON parse して配列で返す', () => {
    const parsed = parseLitigationCaseRow(row())
    expect(parsed).toEqual({
      caseId: 'case-1',
      name: '未払残業代請求事件',
      fromMonth: '2024-04',
      toMonth: '2024-06',
      driverCds: ['1194', '1523'],
      memo: '',
      createdBy: 'viewer@example.com',
      createdAt: NOW,
      updatedAt: NOW,
    })
  })

  it('driver_cds が壊れた JSON なら空配列 (fail-soft)', () => {
    const parsed = parseLitigationCaseRow(row({ driver_cds: 'not-json' }))
    expect(parsed.driverCds).toEqual([])
  })

  it('driver_cds が配列以外の JSON なら空配列', () => {
    const parsed = parseLitigationCaseRow(row({ driver_cds: '{"a":1}' }))
    expect(parsed.driverCds).toEqual([])
  })

  it('driver_cds の要素に文字列以外が混ざっていたら除外する', () => {
    const parsed = parseLitigationCaseRow(row({ driver_cds: JSON.stringify(['1194', 1523, null]) }))
    expect(parsed.driverCds).toEqual(['1194'])
  })

  it('created_by が null でもそのまま通す', () => {
    const parsed = parseLitigationCaseRow(row({ created_by: null }))
    expect(parsed.createdBy).toBeNull()
  })
})

describe('buildLitigationCaseListResponse', () => {
  it('updated_at の新しい順に並べる', () => {
    const rows = [
      row({ case_id: 'old', updated_at: '2026-01-01T00:00:00.000Z' }),
      row({ case_id: 'new', updated_at: '2026-03-01T00:00:00.000Z' }),
      row({ case_id: 'mid', updated_at: '2026-02-01T00:00:00.000Z' }),
    ]
    expect(buildLitigationCaseListResponse(rows).map((r) => r.caseId)).toEqual(['new', 'mid', 'old'])
  })

  it('updated_at が同じ行は元の順序を保つ (0 を返す分岐)', () => {
    const rows = [
      row({ case_id: 'a', updated_at: NOW }),
      row({ case_id: 'b', updated_at: NOW }),
    ]
    expect(buildLitigationCaseListResponse(rows).map((r) => r.caseId)).toEqual(['a', 'b'])
  })

  it('空配列なら空配列', () => {
    expect(buildLitigationCaseListResponse([])).toEqual([])
  })
})
