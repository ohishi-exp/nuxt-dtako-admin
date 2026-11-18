import { describe, it, expect } from 'vitest'
import { parseTargetOpeNo, isTargetRow } from '~/utils/daily-report-target'

describe('parseTargetOpeNo', () => {
  it('23 桁は先頭 22 桁にする', () => {
    expect(parseTargetOpeNo('26111307025200000035211')).toBe('2611130702520000003521')
  })
  it('22 桁はそのまま', () => {
    expect(parseTargetOpeNo('2611130702520000003521')).toBe('2611130702520000003521')
  })
  it('桁違い・数字以外・文字列以外は null', () => {
    expect(parseTargetOpeNo('261113070252000000352')).toBeNull()
    expect(parseTargetOpeNo('261113070252000000352111')).toBeNull()
    expect(parseTargetOpeNo('2611130702520000003521x')).toBeNull()
    expect(parseTargetOpeNo('')).toBeNull()
    expect(parseTargetOpeNo(undefined)).toBeNull()
    expect(parseTargetOpeNo(['26111307025200000035211'])).toBeNull()
  })
})

describe('isTargetRow', () => {
  it('先頭 22 桁が一致すれば true', () => {
    expect(isTargetRow('2611130702520000003521', '2611130702520000003521')).toBe(true)
  })
  it('一致しなければ false', () => {
    expect(isTargetRow('2611130702520000003522', '2611130702520000003521')).toBe(false)
  })
  it('target が null なら false', () => {
    expect(isTargetRow('2611130702520000003521', null)).toBe(false)
  })
})
