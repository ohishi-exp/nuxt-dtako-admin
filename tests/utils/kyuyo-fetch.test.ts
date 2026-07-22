// 給与DB取得の純粋ロジック (Refs #369)
import { describe, expect, it } from 'vitest'
import {
  MAX_RANGE_MONTHS,
  PAYROLL_STORAGE_PREFIX,
  SESSION_OWNER_KEY,
  buildFetchPlan,
  expandMonthRange,
  parsePayrollStorageKey,
  payrollStorageKey,
  shouldPurgeSession,
  summarizeStored,
  toStoredPayroll,
  type StoredPayroll,
} from '~/utils/kyuyo-fetch'

describe('expandMonthRange', () => {
  it('from〜to を月配列に展開する (年跨ぎ含む)', () => {
    expect(expandMonthRange('2026-05', '2026-07')).toEqual({
      months: ['2026-05', '2026-06', '2026-07'],
    })
    expect(expandMonthRange('2025-11', '2026-02')).toEqual({
      months: ['2025-11', '2025-12', '2026-01', '2026-02'],
    })
    // 単月
    expect(expandMonthRange('2026-06', '2026-06')).toEqual({ months: ['2026-06'] })
  })
  it('不正入力はエラー', () => {
    expect(expandMonthRange('2026-6', '2026-07')).toEqual({ error: '月は YYYY-MM で指定してください' })
    expect(expandMonthRange('2026-05', '202607')).toEqual({ error: '月は YYYY-MM で指定してください' })
    expect(expandMonthRange('2026-13', '2026-12')).toEqual({ error: '月は YYYY-MM で指定してください' })
    expect(expandMonthRange('2026-00', '2026-01')).toEqual({ error: '月は YYYY-MM で指定してください' })
    expect(expandMonthRange('2026-07', '2026-05')).toEqual({ error: '開始月が終了月より後になっています' })
  })
  it('上限 (既定 12 ヶ月) を超えるとエラー', () => {
    expect(expandMonthRange('2025-01', '2025-12')).toEqual({
      months: [
        '2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06',
        '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
      ],
    })
    expect(expandMonthRange('2025-01', '2026-01')).toEqual({
      error: `一度に取得できるのは ${MAX_RANGE_MONTHS} ヶ月までです`,
    })
    // maxMonths 指定
    expect(expandMonthRange('2026-01', '2026-03', 2)).toEqual({
      error: '一度に取得できるのは 2 ヶ月までです',
    })
  })
})

describe('buildFetchPlan', () => {
  it('会社ごとに月昇順で展開', () => {
    expect(buildFetchPlan(['0100', '0200'], ['2026-05', '2026-06'])).toEqual([
      { company: '0100', month: '2026-05' },
      { company: '0100', month: '2026-06' },
      { company: '0200', month: '2026-05' },
      { company: '0200', month: '2026-06' },
    ])
    expect(buildFetchPlan([], ['2026-05'])).toEqual([])
  })
})

describe('storage キー規則', () => {
  it('生成とパースが往復する', () => {
    const key = payrollStorageKey('0100', '2026-06')
    expect(key).toBe(`${PAYROLL_STORAGE_PREFIX}0100:2026-06`)
    expect(parsePayrollStorageKey(key)).toEqual({ company: '0100', month: '2026-06' })
  })
  it('無関係のキーは null', () => {
    expect(parsePayrollStorageKey('other')).toBeNull()
    expect(parsePayrollStorageKey(SESSION_OWNER_KEY)).toBeNull()
    expect(parsePayrollStorageKey(`${PAYROLL_STORAGE_PREFIX}0100`)).toBeNull() // 月なし
    expect(parsePayrollStorageKey(`${PAYROLL_STORAGE_PREFIX}:2026-06`)).toBeNull() // 会社なし
    expect(parsePayrollStorageKey(`${PAYROLL_STORAGE_PREFIX}0100:`)).toBeNull() // 月が空
  })
})

describe('shouldPurgeSession', () => {
  it('所有者が変わった時だけ purge', () => {
    expect(shouldPurgeSession('user-a', 'user-b')).toBe(true)
    expect(shouldPurgeSession('user-a', 'user-a')).toBe(false)
    // 記録なし / 未ログインでは purge しない
    expect(shouldPurgeSession(null, 'user-a')).toBe(false)
    expect(shouldPurgeSession('', 'user-a')).toBe(false)
    expect(shouldPurgeSession('user-a', null)).toBe(false)
  })
})

describe('toStoredPayroll', () => {
  it('payroll 応答を保存形に変換 (件数・warnings 数を持つ)', () => {
    const body = {
      database: 'KYDATA0100_126C',
      rows: [{ employee_code: '1771' }, { employee_code: '0941' }],
      warnings: ['SHUKEI1 に集計行がありません'],
    }
    expect(toStoredPayroll(body, '2026-07-23T01:00:00Z')).toEqual({
      database: 'KYDATA0100_126C',
      fetchedAt: '2026-07-23T01:00:00Z',
      rowCount: 2,
      warningCount: 1,
      rows: body.rows,
      warnings: body.warnings,
    })
  })
  it('warnings が無くても壊れない / 想定外形式は null', () => {
    const stored = toStoredPayroll({ database: 'X', rows: [] }, 't')
    expect(stored?.warningCount).toBe(0)
    expect(toStoredPayroll(null, 't')).toBeNull()
    expect(toStoredPayroll({ rows: [] }, 't')).toBeNull() // database なし
    expect(toStoredPayroll({ database: 'X' }, 't')).toBeNull() // rows なし
  })
})

describe('summarizeStored', () => {
  const value = (rowCount: number): StoredPayroll => ({
    database: 'KYDATA0100_126C',
    fetchedAt: 't',
    rowCount,
    warningCount: 0,
    rows: [],
    warnings: [],
  })
  it('会社 → 月の昇順に整列し、無関係キーは除外', () => {
    const entries = [
      { key: payrollStorageKey('0200', '2026-05'), value: value(91) },
      { key: payrollStorageKey('0100', '2026-06'), value: value(53) },
      { key: payrollStorageKey('0100', '2026-05'), value: value(52) },
      { key: 'unrelated', value: value(0) },
    ]
    const summaries = summarizeStored(entries)
    expect(summaries.map(s => `${s.company}:${s.month}`)).toEqual([
      '0100:2026-05',
      '0100:2026-06',
      '0200:2026-05',
    ])
    expect(summaries[1]?.rowCount).toBe(53)
  })
})
