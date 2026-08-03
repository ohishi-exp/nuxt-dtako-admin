import { describe, it, expect } from 'vitest'
import type { KintaiCandidateDiffItem, KintaiCandidateDiffItemsState } from '~/utils/kintai-candidate-diff'
import {
  kintaiCandidateDiffDateFromUnkoNo,
  kintaiCandidateDiffFieldRows,
  lookupKintaiCandidateDiff,
} from '~/utils/kintai-candidate-diff'

// issue #633 の実測 (2026-08-04, 2026-06 分) そのもの。
// 1740 / 2606060822000000004157 (2026-06-06) は休憩40分差 (拘束は一致)。
// 1445 / 2606251355420000003447 (2026-06-25) は差分リストに無し (両側一致)。
const UNKO_NO_1740 = '2606060822000000004157'
const UNKO_NO_1445 = '2606251355420000003447'

function diffValue(over: Record<string, number> = {}): Record<string, number> {
  return {
    restraint_minutes: 593,
    working_minutes: 494,
    break_minutes: 100,
    overtime_minutes: 14,
    ...over,
  }
}

function matchItem1740(): KintaiCandidateDiffItem {
  return {
    driverCd: '1740',
    date: '2026-06-06',
    diffFields: ['break_minutes', 'working_minutes', 'overtime_minutes'],
    gcp: diffValue(),
    onprem: diffValue({ working_minutes: 534, break_minutes: 60, overtime_minutes: 54 }),
  }
}

describe('kintaiCandidateDiffDateFromUnkoNo', () => {
  it('先頭6桁 (YYMMDD) から運行日を作る (issue #633 の実物2件)', () => {
    expect(kintaiCandidateDiffDateFromUnkoNo(UNKO_NO_1740)).toBe('2026-06-06')
    expect(kintaiCandidateDiffDateFromUnkoNo(UNKO_NO_1445)).toBe('2026-06-25')
  })

  it('22桁 (GCP側) でも23桁 (オンプレ側) でも読める', () => {
    expect(kintaiCandidateDiffDateFromUnkoNo('26060608220000000415')).toBeNull() // 20桁は不正
    expect(kintaiCandidateDiffDateFromUnkoNo('2606060822000000004157')).toBe('2026-06-06') // 22桁
    expect(kintaiCandidateDiffDateFromUnkoNo('26060608220000000041571')).toBe('2026-06-06') // 23桁
  })

  it('22桁・23桁のどちらでもない入力は null (捏造しない)', () => {
    expect(kintaiCandidateDiffDateFromUnkoNo('123')).toBeNull()
    expect(kintaiCandidateDiffDateFromUnkoNo('')).toBeNull()
    expect(kintaiCandidateDiffDateFromUnkoNo('abc')).toBeNull()
  })
})

describe('lookupKintaiCandidateDiff', () => {
  it('items がライブ取得されていない (none) 月は unconfirmed', () => {
    const state: KintaiCandidateDiffItemsState = { status: 'none' }
    const r = lookupKintaiCandidateDiff('1740', UNKO_NO_1740, state)
    expect(r).toEqual({ kind: 'unconfirmed', date: '2026-06-06' })
  })

  it('items が読めなかった (unreadable) 月も unconfirmed', () => {
    const state: KintaiCandidateDiffItemsState = { status: 'unreadable' }
    const r = lookupKintaiCandidateDiff('1740', UNKO_NO_1740, state)
    expect(r.kind).toBe('unconfirmed')
  })

  it('運行NOの桁数が不正なら (ok 状態でも) unconfirmed かつ date は null', () => {
    const state: KintaiCandidateDiffItemsState = { status: 'ok', items: { match: [], mismatch: [] }, lastVerifiedAt: null }
    const r = lookupKintaiCandidateDiff('1740', '123', state)
    expect(r).toEqual({ kind: 'unconfirmed', date: null })
  })

  it('★ issue #633 実測1: 1740/2026-06-06 は match (休憩40分差、拘束は一致)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [matchItem1740()], mismatch: [] },
      lastVerifiedAt: '2026-08-04T01:23:00Z',
    }
    const r = lookupKintaiCandidateDiff('1740', UNKO_NO_1740, state)
    expect(r.kind).toBe('match')
    if (r.kind !== 'match') throw new Error('unreachable')
    expect(r.date).toBe('2026-06-06')
    expect(r.lastVerifiedAt).toBe('2026-08-04T01:23:00Z')
    expect(r.item).toEqual(matchItem1740())
  })

  it('★ issue #633 実測2: 1445/2026-06-25 は差分リストに無いので no_diff (「両側一致」であって「取り込み不要」ではない)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [matchItem1740()], mismatch: [] }, // 1445 の行は無い = 差分リストに出てこない
      lastVerifiedAt: '2026-08-04T01:23:00Z',
    }
    const r = lookupKintaiCandidateDiff('1445', UNKO_NO_1445, state)
    expect(r).toEqual({ kind: 'no_diff', date: '2026-06-25', lastVerifiedAt: '2026-08-04T01:23:00Z' })
  })

  it('拘束も不一致 (mismatch カテゴリ) を match より優先して見つける', () => {
    const mismatchItem: KintaiCandidateDiffItem = {
      driverCd: '9999',
      date: '2026-06-10',
      diffFields: ['restraint_minutes'],
      gcp: diffValue({ restraint_minutes: 600 }),
      onprem: diffValue({ restraint_minutes: 500 }),
    }
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [], mismatch: [mismatchItem] },
      lastVerifiedAt: null,
    }
    const r = lookupKintaiCandidateDiff('9999', '2606100000000000000001', state)
    expect(r.kind).toBe('mismatch')
    if (r.kind !== 'mismatch') throw new Error('unreachable')
    expect(r.item).toEqual(mismatchItem)
  })

  it('乗務員CDは前ゼロ違いでも同一とみなす (normalizeDriverCdKey と同じ規則)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [{ ...matchItem1740(), driverCd: '01740' }], mismatch: [] },
      lastVerifiedAt: null,
    }
    const r = lookupKintaiCandidateDiff('1740', UNKO_NO_1740, state)
    expect(r.kind).toBe('match')
  })

  it('乗務員CDが一致しても日付が違えば no_diff', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [matchItem1740()], mismatch: [] },
      lastVerifiedAt: null,
    }
    // 1740 だが別の日の候補
    const r = lookupKintaiCandidateDiff('1740', '2606070822000000004157', state)
    expect(r.kind).toBe('no_diff')
  })
})

describe('kintaiCandidateDiffFieldRows', () => {
  it('拘束/休憩/実働/残業の4項目をGCP⇔オンプレで並べ、差の有無を持つ (issue #633 の例そのもの)', () => {
    const rows = kintaiCandidateDiffFieldRows(matchItem1740())
    expect(rows).toEqual([
      { field: 'restraint_minutes', label: '拘束', gcp: 593, onprem: 593, differs: false },
      { field: 'break_minutes', label: '休憩', gcp: 100, onprem: 60, differs: true },
      { field: 'working_minutes', label: '実働', gcp: 494, onprem: 534, differs: true },
      { field: 'overtime_minutes', label: '残業', gcp: 14, onprem: 54, differs: true },
    ])
  })

  it('欠けているフィールドは0扱い (落ちない)', () => {
    const rows = kintaiCandidateDiffFieldRows({ driverCd: '1', date: '2026-06-01', diffFields: [], gcp: {}, onprem: {} })
    expect(rows.every(r => r.gcp === 0 && r.onprem === 0 && !r.differs)).toBe(true)
  })
})
