import { describe, expect, it } from 'vitest'
import { LitigationCaseError } from '../src/litigation-case'
import {
  buildLitigationCheckDeleteStatement,
  buildLitigationCheckListResponse,
  buildLitigationCheckListStatement,
  buildLitigationCheckUpsertStatement,
  LITIGATION_CHECK_MAX_ITEMS,
  LITIGATION_CHECK_MAX_PAYLOAD_CHARS,
  normalizeLitigationCheckPut,
} from '../src/litigation-check'

const COMP = '27324455'
const NOW = '2026-09-29T00:00:00.000Z'
const item = (over: Record<string, unknown> = {}) => ({ kind: 'unkoGaps', key: '9101|2023-06', payload: { ok: true, value: { a: 1 } }, ...over })

describe('normalizeLitigationCheckPut', () => {
  it('正常系: payload は JSON 文字列にして持つ', () => {
    expect(normalizeLitigationCheckPut({ caseId: ' c1 ', items: [item(), item({ kind: 'wageReport', payload: null })] })).toEqual({
      caseId: 'c1',
      items: [
        { kind: 'unkoGaps', key: '9101|2023-06', payload: '{"ok":true,"value":{"a":1}}' },
        { kind: 'wageReport', key: '9101|2023-06', payload: 'null' },
      ],
    })
  })

  it.each([
    ['body が配列', []],
    ['body が null', null],
    ['caseId が無い', { items: [item()] }],
    ['caseId が空白', { caseId: ' ', items: [item()] }],
    ['items が空', { caseId: 'c1', items: [] }],
    ['items が配列でない', { caseId: 'c1', items: 'x' }],
    ['items が多すぎる', { caseId: 'c1', items: Array.from({ length: LITIGATION_CHECK_MAX_ITEMS + 1 }, () => item()) }],
    ['kind が不正', { caseId: 'c1', items: [item({ kind: 'yTime' })] }],
    ['item が null', { caseId: 'c1', items: [null] }],
    ['key の形が違う', { caseId: 'c1', items: [item({ key: '2023-06' })] }],
    ['key の月が 13', { caseId: 'c1', items: [item({ key: '9101|2023-13' })] }],
    ['key が文字列でない', { caseId: 'c1', items: [item({ key: 1 })] }],
    ['payload が無い', { caseId: 'c1', items: [{ kind: 'alcOps', key: '9101|2023-06' }] }],
    ['payload が大きすぎる', { caseId: 'c1', items: [item({ payload: 'x'.repeat(LITIGATION_CHECK_MAX_PAYLOAD_CHARS) })] }],
  ])('400 にする: %s', (_label, raw) => {
    expect(() => normalizeLitigationCheckPut(raw)).toThrow(LitigationCaseError)
  })
})

describe('D1 文', () => {
  it('upsert は comp/case/kind/key で 1 行に上書きし、時刻も更新する', () => {
    const s = buildLitigationCheckUpsertStatement(COMP, 'c1', { kind: 'alcOps', key: '9101|2023-06', payload: '{}' }, NOW)
    expect(s.sql).toContain('ON CONFLICT(comp_id, case_id, kind, item_key) DO UPDATE')
    expect(s.sql).toContain('checked_at = excluded.checked_at')
    expect(s.params).toEqual([COMP, 'c1', 'alcOps', '9101|2023-06', '{}', NOW])
  })

  it('一覧と削除は comp と case で絞る', () => {
    expect(buildLitigationCheckListStatement(COMP, 'c1').params).toEqual([COMP, 'c1'])
    const d = buildLitigationCheckDeleteStatement(COMP, 'c1')
    expect(d.sql).toContain('DELETE FROM litigation_check_results WHERE comp_id = ? AND case_id = ?')
    expect(d.params).toEqual([COMP, 'c1'])
  })
})

describe('buildLitigationCheckListResponse', () => {
  it('payload を JSON に戻し、種類が不明な行・JSON でない行は落とす', () => {
    expect(buildLitigationCheckListResponse([
      { kind: 'unkoGaps', item_key: '9101|2023-06', payload: '{"ok":true}', checked_at: NOW },
      { kind: 'yTime', item_key: '9101|2023-06', payload: '{}', checked_at: NOW },
      { kind: 'alcOps', item_key: '9101|2023-07', payload: '{broken', checked_at: NOW },
    ])).toEqual([{ kind: 'unkoGaps', key: '9101|2023-06', payload: { ok: true }, checkedAt: NOW }])
  })
})
