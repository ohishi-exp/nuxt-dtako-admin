// restraint-push (ichiban への拘束サマリ push body 構築、Refs #452 /
// rust-ichibanboshi#106 Phase 3b) のテスト。ichiban 側 PushBody との整合は
// rust-ichibanboshi/tests/restraint_test.rs が固定する — ここでは entry 変換と
// チャンク分割を固定する。

import { describe, expect, it } from 'vitest'
import {
  buildRestraintPushBodies,
  RESTRAINT_PUSH_CHUNK,
} from '../src/restraint-push'
import type { RestraintD1Entry, RestraintSummaryMeta } from '../src/restraint-d1'
import type { RestraintDriverSummary } from '../src/theearth-restraint-client'
import rawTheearthSummaries from '../../../tests/fixtures/restraint-wage/summaries.json'

const theearthSummaries = rawTheearthSummaries as unknown as RestraintDriverSummary[]

const META: RestraintSummaryMeta = {
  sha256: 'a'.repeat(64),
  fetchedAt: '2026-07-01T00-00-00Z',
  lastVerifiedAt: '2026-07-02T00-00-00Z',
}

function summaryEntry(summary: RestraintDriverSummary): RestraintD1Entry {
  return { kind: 'summary', summary, meta: META }
}

describe('buildRestraintPushBodies', () => {
  it('summary / no-data entry を ichiban PushEntry 形に写す', () => {
    const entries: RestraintD1Entry[] = [
      summaryEntry(theearthSummaries[0]!),
      { kind: 'no-data', driverCd: '9999', meta: META },
    ]
    const bodies = buildRestraintPushBodies('comp-1', 'theearth', '2026-06', entries)
    expect(bodies).toHaveLength(1)
    const body = bodies[0]!
    expect(body.comp_id).toBe('comp-1')
    expect(body.source).toBe('theearth')
    expect(body.month).toBe('2026-06')
    expect(body.entries).toHaveLength(2)
    expect(body.entries[0]).toStrictEqual({
      driver_cd: theearthSummaries[0]!.driverCd,
      summary: theearthSummaries[0]!,
      fetched_at: META.fetchedAt,
      last_verified_at: META.lastVerifiedAt,
    })
    expect(body.entries[1]).toStrictEqual({
      driver_cd: '9999',
      no_data: true,
      fetched_at: META.fetchedAt,
      last_verified_at: META.lastVerifiedAt,
    })
  })

  it('チャンクサイズで分割し、順序を保つ', () => {
    const entries: RestraintD1Entry[] = Array.from({ length: 5 }, (_, i) =>
      summaryEntry({ ...theearthSummaries[0]!, driverCd: String(100 + i) }),
    )
    const bodies = buildRestraintPushBodies('comp-1', 'timecard', '2026-06', entries, 2)
    expect(bodies.map(b => b.entries.length)).toStrictEqual([2, 2, 1])
    expect(bodies.flatMap(b => b.entries.map(e => e.driver_cd)))
      .toStrictEqual(['100', '101', '102', '103', '104'])
    for (const body of bodies) expect(body.source).toBe('timecard')
  })

  it('空 entry は空配列 (送信不要)、既定チャンクは 40', () => {
    expect(buildRestraintPushBodies('comp-1', 'theearth', '2026-06', [])).toStrictEqual([])
    expect(RESTRAINT_PUSH_CHUNK).toBe(40)
    const many: RestraintD1Entry[] = Array.from({ length: 81 }, (_, i) =>
      summaryEntry({ ...theearthSummaries[0]!, driverCd: String(i) }),
    )
    const bodies = buildRestraintPushBodies('comp-1', 'theearth', '2026-06', many)
    expect(bodies.map(b => b.entries.length)).toStrictEqual([40, 40, 1])
  })
})
