// 一番星ヘルスチェックの純粋ロジック (Refs #369)
import { describe, expect, it } from 'vitest'
import {
  KYUYO_COMPANIES,
  buildHealthChecks,
  classifyResult,
  defaultPayrollMonth,
} from '~/utils/ichiban-health'

describe('buildHealthChecks', () => {
  it('既存4系統 + kyuyo companies + 会社ごとの payroll を並べる', () => {
    const checks = buildHealthChecks('2026-06')
    expect(checks.map(c => c.id)).toEqual([
      'health',
      'sales-departments',
      'employees',
      'vehicles',
      'kyuyo-companies',
      'kyuyo-payroll-0100',
      'kyuyo-payroll-0200',
      'kyuyo-payroll-0300',
      'kyuyo-payroll-0400',
    ])
    // kyuyo 系だけ JWT が要る
    expect(checks.filter(c => c.needsAuth).map(c => c.id)).toEqual([
      'kyuyo-companies',
      'kyuyo-payroll-0100',
      'kyuyo-payroll-0200',
      'kyuyo-payroll-0300',
      'kyuyo-payroll-0400',
    ])
    // payroll URL に会社と月が入る
    expect(checks.find(c => c.id === 'kyuyo-payroll-0300')?.url)
      .toBe('/api/kyuyo/payroll?company=0300&month=2026-06')
    // 既存系は ichiban proxy 経由
    expect(checks.find(c => c.id === 'health')?.url).toBe('/api/ichiban/health')
    expect(checks.find(c => c.id === 'employees')?.url).toBe('/api/ichiban/api/employees')
  })
})

describe('defaultPayrollMonth', () => {
  it('前月を YYYY-MM で返す', () => {
    expect(defaultPayrollMonth(new Date(2026, 6, 23))).toBe('2026-06') // 7月 → 6月
    expect(defaultPayrollMonth(new Date(2026, 9, 1))).toBe('2026-09')
  })
  it('1月は前年12月', () => {
    expect(defaultPayrollMonth(new Date(2026, 0, 5))).toBe('2025-12')
  })
})

describe('classifyResult', () => {
  it('非2xx は ng (error メッセージがあれば添える)', () => {
    expect(classifyResult('health', 503, { error: '給与 DB に接続できません' }))
      .toEqual({ level: 'ng', detail: 'HTTP 503: 給与 DB に接続できません' })
    expect(classifyResult('employees', 500, null))
      .toEqual({ level: 'ng', detail: 'HTTP 500' })
    // error が文字列でない / 空文字ならメッセージ無し
    expect(classifyResult('health', 401, { error: '' }))
      .toEqual({ level: 'ng', detail: 'HTTP 401' })
    expect(classifyResult('health', 401, { error: 42 }))
      .toEqual({ level: 'ng', detail: 'HTTP 401' })
  })

  it('health は 200 なら ok (body 不要)', () => {
    expect(classifyResult('health', 200, null)).toEqual({ level: 'ok', detail: 'HTTP 200' })
  })

  describe('kyuyo-companies', () => {
    it('4社 + warnings 0 は ok', () => {
      const body = { companies: [{}, {}, {}, {}], warnings: [] }
      expect(classifyResult('kyuyo-companies', 200, body))
        .toEqual({ level: 'ok', detail: '4 社 / warnings 0' })
    })
    it('warnings ありは warn (権限抜け検知)', () => {
      const body = { companies: [{}, {}, {}, {}], warnings: ['KYDATA0200_126C にアクセスできません'] }
      expect(classifyResult('kyuyo-companies', 200, body).level).toBe('warn')
    })
    it('社数が想定と違えば warn', () => {
      const body = { companies: [{}, {}], warnings: [] }
      expect(classifyResult('kyuyo-companies', 200, body))
        .toEqual({ level: 'warn', detail: `2 社 / warnings 0 (想定 ${KYUYO_COMPANIES.length} 社)` })
    })
    it('companies が無ければ ng', () => {
      expect(classifyResult('kyuyo-companies', 200, {}).level).toBe('ng')
    })
  })

  describe('kyuyo-payroll', () => {
    it('rows あり + warnings 0 は ok', () => {
      const body = { rows: Array.from({ length: 53 }, () => ({})), warnings: [] }
      expect(classifyResult('kyuyo-payroll-0100', 200, body))
        .toEqual({ level: 'ok', detail: '53 名 / warnings 0' })
    })
    it('warnings ありは warn', () => {
      const body = { rows: [{}], warnings: ['SHUKEI1 に集計行がありません'] }
      expect(classifyResult('kyuyo-payroll-0100', 200, body).level).toBe('warn')
    })
    it('0 件は warn (月初でデータ未作成の可能性)', () => {
      // warnings が配列でない防御分岐 (warningCount) も同時にカバー
      expect(classifyResult('kyuyo-payroll-0200', 200, { rows: [] }))
        .toEqual({ level: 'warn', detail: '0 名 / warnings 0' })
    })
    it('rows が無ければ ng', () => {
      expect(classifyResult('kyuyo-payroll-0100', 200, { warnings: [] }).level).toBe('ng')
    })
  })

  describe('既存 API (ApiResponse)', () => {
    it('data 配列 1 件以上は ok', () => {
      expect(classifyResult('employees', 200, { data: [{}, {}] }))
        .toEqual({ level: 'ok', detail: '2 件' })
    })
    it('0 件は warn', () => {
      expect(classifyResult('vehicles', 200, { data: [] }))
        .toEqual({ level: 'warn', detail: '0 件 (マスタが空?)' })
    })
    it('data が無ければ ng', () => {
      expect(classifyResult('sales-departments', 200, null).level).toBe('ng')
    })
  })
})
