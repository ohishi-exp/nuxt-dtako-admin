/**
 * `app/utils/restraint-wage-view.ts` の表示ヘルパテスト。
 *
 * - fmtMinutes: 分 → "XhYYm" 表記 (Refs #251)。null/undefined は "-"
 * - fmtYen / fmtArchiveTs / fmtYm の基本フォーマット
 */

import { describe, it, expect } from 'vitest'
import { fmtMinutes, fmtYen, fmtArchiveTs, fmtYm, nextYm, prevYm } from '../../app/utils/restraint-wage-view'

describe('fmtMinutes', () => {
  it('時間+分を "XhYYm" 表記にする', () => {
    expect(fmtMinutes(345 * 60 + 50)).toBe('345h50m')
    expect(fmtMinutes(239 * 60 + 39)).toBe('239h39m')
  })

  it('分は 2 桁ゼロ埋めする', () => {
    expect(fmtMinutes(63)).toBe('1h03m')
    expect(fmtMinutes(60)).toBe('1h00m')
  })

  it('1 時間未満は 0h 始まり', () => {
    expect(fmtMinutes(36)).toBe('0h36m')
    expect(fmtMinutes(0)).toBe('0h00m')
  })

  it('null / undefined は "-"', () => {
    expect(fmtMinutes(null)).toBe('-')
    expect(fmtMinutes(undefined)).toBe('-')
  })
})

describe('fmtYen', () => {
  it('3 桁区切りにする', () => {
    expect(fmtYen(1234567)).toBe('1,234,567')
  })

  it('null / undefined は "-"', () => {
    expect(fmtYen(null)).toBe('-')
    expect(fmtYen(undefined)).toBe('-')
  })
})

describe('fmtArchiveTs', () => {
  it('R2 版タイムスタンプを "YYYY-MM-DD HH:mm" にする', () => {
    expect(fmtArchiveTs('20260716T183000')).toBe('2026-07-16 18:30')
  })

  it('形式不一致はそのまま返す', () => {
    expect(fmtArchiveTs('invalid')).toBe('invalid')
  })

  it('null / undefined / 空文字は "-"', () => {
    expect(fmtArchiveTs(null)).toBe('-')
    expect(fmtArchiveTs(undefined)).toBe('-')
    expect(fmtArchiveTs('')).toBe('-')
  })
})

describe('fmtYm', () => {
  it('"YYYY-MM" を "YYYY年M月" にする (先頭ゼロ除去)', () => {
    expect(fmtYm('2025-04')).toBe('2025年4月')
    expect(fmtYm('2025-12')).toBe('2025年12月')
  })

  it('形式不一致はそのまま返す', () => {
    expect(fmtYm('2025/04')).toBe('2025/04')
  })
})

describe('nextYm / prevYm (支給月 ⇄ 勤務月、月末締め・翌月払い Refs #282)', () => {
  it('nextYm: 通常月は +1', () => {
    expect(nextYm('2026-06')).toBe('2026-07')
    expect(nextYm('2026-01')).toBe('2026-02')
  })

  it('nextYm: 12月は翌年1月へ繰り上がる (年跨ぎ)', () => {
    expect(nextYm('2026-12')).toBe('2027-01')
  })

  it('prevYm: 通常月は -1', () => {
    expect(prevYm('2026-07')).toBe('2026-06')
    expect(prevYm('2026-12')).toBe('2026-11')
  })

  it('prevYm: 1月は前年12月へ繰り下がる (年跨ぎ)', () => {
    expect(prevYm('2027-01')).toBe('2026-12')
  })

  it('往復で元に戻る (12月/1月境界含む)', () => {
    for (const ym of ['2026-01', '2026-06', '2026-12']) {
      expect(prevYm(nextYm(ym))).toBe(ym)
    }
  })

  it('形式不一致はそのまま返す', () => {
    expect(nextYm('2026/12')).toBe('2026/12')
    expect(prevYm('bad')).toBe('bad')
  })
})
