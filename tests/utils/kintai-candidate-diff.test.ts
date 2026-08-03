import { describe, it, expect } from 'vitest'
import type { KintaiCandidateDayCoverage, KintaiCandidateDiffItem, KintaiCandidateDiffItemsState } from '~/utils/kintai-candidate-diff'
import {
  buildKintaiCandidateDayCoverage,
  kintaiCandidateDiffDateFromUnkoNo,
  kintaiCandidateDiffFieldRows,
  lookupKintaiCandidateDiff,
} from '~/utils/kintai-candidate-diff'

// issue #633 の実測 (2026-08-04, 2026-06 分) そのもの。
// 1740 / 2606060822000000004157 (2026-06-06) は休憩40分差 (拘束は一致)。
// 1445 / 2606251355420000003447 (2026-06-25) — ★ #633-3 で確定した真相: 06-25 という
// 「日」自体が両側とも存在しない (日跨ぎ勤務で 06-24 20:56 開始・拘束1326分の勤務に
// 含まれる)。#633-1 時点ではこれを「差分リストに無い=一致」と誤読していた
// (このファイルの day_absent 系テストが、その誤りを再発させないための固定点)。
const UNKO_NO_1740 = '2606060822000000004157'
const UNKO_NO_1445 = '2606251355420000003447'

/** 空の day coverage (comparedDays/only_* が全部空)。個々のテストで上書きする。 */
function emptyDayCoverage(): KintaiCandidateDayCoverage | null {
  return buildKintaiCandidateDayCoverage({
    comparedDays: { keys: [], capped: false },
    onlyGcpDays: [],
    onlyOnpremDays: [],
  })
}

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
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [], mismatch: [] },
      dayCoverage: emptyDayCoverage(),
      lastVerifiedAt: null,
    }
    const r = lookupKintaiCandidateDiff('1740', '123', state)
    expect(r).toEqual({ kind: 'unconfirmed', date: null })
  })

  it('★ issue #633 実測1: 1740/2026-06-06 は match (休憩40分差、拘束は一致) — dayCoverage が無くても値差 items だけで判定できる', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [matchItem1740()], mismatch: [] },
      dayCoverage: null,
      lastVerifiedAt: '2026-08-04T01:23:00Z',
    }
    const r = lookupKintaiCandidateDiff('1740', UNKO_NO_1740, state)
    expect(r.kind).toBe('match')
    if (r.kind !== 'match') throw new Error('unreachable')
    expect(r.date).toBe('2026-06-06')
    expect(r.lastVerifiedAt).toBe('2026-08-04T01:23:00Z')
    expect(r.item).toEqual(matchItem1740())
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
      dayCoverage: null,
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
      dayCoverage: null,
      lastVerifiedAt: null,
    }
    const r = lookupKintaiCandidateDiff('1740', UNKO_NO_1740, state)
    expect(r.kind).toBe('match')
  })

  // ─────────────────────────────────────────────────────────────────────
  // ★★ #633-3: compared_days を経由した no_diff / day_absent / one_sided。
  // #633-1 時点の「値差 items に無ければ no_diff」は、突き合わせてすらいない日を
  // 「一致」と誤読するバグだった (1445/2026-06-25 の実例)。ここが再発防止の核心。
  // ─────────────────────────────────────────────────────────────────────

  it('compared_days にあり値差 items に無い日は no_diff (★ ここで初めて「両側一致」と言ってよい)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [], mismatch: [] },
      dayCoverage: buildKintaiCandidateDayCoverage({
        comparedDays: { keys: ['1740|2026-06-06'], capped: false },
        onlyGcpDays: [],
        onlyOnpremDays: [],
      }),
      lastVerifiedAt: '2026-08-04T01:23:00Z',
    }
    const r = lookupKintaiCandidateDiff('1740', UNKO_NO_1740, state)
    expect(r).toEqual({ kind: 'no_diff', date: '2026-06-06', lastVerifiedAt: '2026-08-04T01:23:00Z' })
  })

  it('乗務員CDが一致しても日付が違えば (compared_days の別日) no_diff にはならない (day_absent)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [matchItem1740()], mismatch: [] },
      dayCoverage: buildKintaiCandidateDayCoverage({
        comparedDays: { keys: ['1740|2026-06-06'], capped: false }, // 06-06 だけ、06-07 は無い
        onlyGcpDays: [],
        onlyOnpremDays: [],
      }),
      lastVerifiedAt: null,
    }
    // 1740 だが別の日 (06-07) の候補
    const r = lookupKintaiCandidateDiff('1740', '2606070822000000004157', state)
    expect(r.kind).toBe('day_absent')
  })

  it('★★ issue #633 実測そのもの (#633-3 で確定): 1445/2026-06-25 は day_absent (両側とも突き合わせていない、「一致」ではない)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [matchItem1740()], mismatch: [] }, // 1445 の行は値差 items に無い
      dayCoverage: buildKintaiCandidateDayCoverage({
        // 実測: compared_days にあるのは 1445|2026-06-24 (日跨ぎ勤務の暦日) だけで、
        // 1445|2026-06-25 はどちらの map にも存在しない
        comparedDays: { keys: ['1445|2026-06-24'], capped: false },
        onlyGcpDays: [],
        onlyOnpremDays: [],
      }),
      lastVerifiedAt: '2026-08-04T01:23:00Z',
    }
    const r = lookupKintaiCandidateDiff('1445', UNKO_NO_1445, state)
    expect(r).toEqual({ kind: 'day_absent', date: '2026-06-25', lastVerifiedAt: '2026-08-04T01:23:00Z' })
  })

  it('compared_days に無いが only_gcp にはある日は one_sided (side: gcp)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [], mismatch: [] },
      dayCoverage: buildKintaiCandidateDayCoverage({
        comparedDays: { keys: [], capped: false },
        onlyGcpDays: [{ driverCd: '1445', date: '2026-06-25' }],
        onlyOnpremDays: [],
      }),
      lastVerifiedAt: null,
    }
    const r = lookupKintaiCandidateDiff('1445', UNKO_NO_1445, state)
    expect(r.kind).toBe('one_sided')
    if (r.kind !== 'one_sided') throw new Error('unreachable')
    expect(r.side).toBe('gcp')
  })

  it('compared_days に無いが only_onprem_driver0/other にはある日は one_sided (side: onprem)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [], mismatch: [] },
      dayCoverage: buildKintaiCandidateDayCoverage({
        comparedDays: { keys: [], capped: false },
        onlyGcpDays: [],
        onlyOnpremDays: [{ driverCd: '1445', date: '2026-06-25' }],
      }),
      lastVerifiedAt: null,
    }
    const r = lookupKintaiCandidateDiff('1445', UNKO_NO_1445, state)
    expect(r.kind).toBe('one_sided')
    if (r.kind !== 'one_sided') throw new Error('unreachable')
    expect(r.side).toBe('onprem')
  })

  it('dayCoverage が null (compared_days が応答に無い/壊れている) なら値差 items に無い候補は unconfirmed (「一致」に倒さない)', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [], mismatch: [] },
      dayCoverage: null,
      lastVerifiedAt: '2026-08-04T01:23:00Z',
    }
    const r = lookupKintaiCandidateDiff('1445', UNKO_NO_1445, state)
    expect(r).toEqual({ kind: 'unconfirmed', date: '2026-06-25' })
  })

  it('★ comparedDaysCapped: true なら (対象日が compared_days に無くても) unconfirmed に倒す — 上限で切られていて判別できないため', () => {
    const state: KintaiCandidateDiffItemsState = {
      status: 'ok',
      items: { match: [], mismatch: [] },
      dayCoverage: buildKintaiCandidateDayCoverage({
        comparedDays: { keys: [], capped: true },
        onlyGcpDays: [{ driverCd: '1445', date: '2026-06-25' }], // one_sided の材料があっても
        onlyOnpremDays: [],
      }),
      lastVerifiedAt: null,
    }
    const r = lookupKintaiCandidateDiff('1445', UNKO_NO_1445, state)
    expect(r.kind).toBe('unconfirmed')
  })
})

describe('buildKintaiCandidateDayCoverage', () => {
  it('comparedDays が応答に無い (null) なら coverage 自体が null', () => {
    expect(buildKintaiCandidateDayCoverage({ comparedDays: null, onlyGcpDays: [], onlyOnpremDays: [] })).toBeNull()
  })

  it('乗務員CD前ゼロを正規化して Set に入れる (compared_days の生キーも only_* の行も同じ規則)', () => {
    const coverage = buildKintaiCandidateDayCoverage({
      comparedDays: { keys: ['01740|2026-06-06'], capped: false },
      onlyGcpDays: [{ driverCd: '01445', date: '2026-06-25' }],
      onlyOnpremDays: [{ driverCd: '0009', date: '2026-06-01' }],
    })
    expect(coverage?.comparedDays.has('1740|2026-06-06')).toBe(true)
    expect(coverage?.onlyGcpDays.has('1445|2026-06-25')).toBe(true)
    expect(coverage?.onlyOnpremDays.has('9|2026-06-01')).toBe(true)
  })

  it('capped をそのまま持ち越す', () => {
    expect(buildKintaiCandidateDayCoverage({ comparedDays: { keys: [], capped: true }, onlyGcpDays: [], onlyOnpremDays: [] })?.comparedDaysCapped).toBe(true)
    expect(buildKintaiCandidateDayCoverage({ comparedDays: { keys: [], capped: false }, onlyGcpDays: [], onlyOnpremDays: [] })?.comparedDaysCapped).toBe(false)
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
