// restraint-wage-source (ichiban wage-source 応答 → loadMonthSummaries 形、
// Refs #452 Phase 3c) のテスト。push (restraint-push) → ichiban 保存 → wage-source
// 応答、と回った summary が R2 経路と同じ形・同じ並びで戻ることを固定する。

import { describe, expect, it } from 'vitest'
import {
  isWageSourceResponse,
  wageSourceMonthToSummaries,
  type WageSourceMonthWire,
} from '../src/restraint-wage-source'
import type { RestraintDriverSummary } from '../src/theearth-restraint-client'
import rawTheearthSummaries from '../../../tests/fixtures/restraint-wage/summaries.json'

const theearthSummaries = rawTheearthSummaries as unknown as RestraintDriverSummary[]

function wireOf(summaries: RestraintDriverSummary[], noData: string[] = []): WageSourceMonthWire {
  return {
    summaries: summaries.map(s => ({
      driver_cd: s.driverCd,
      summary: JSON.parse(JSON.stringify(s)) as unknown,
      fetched_at: '2026-07-01T00-00-00Z',
      last_verified_at: '2026-07-02T00-00-00Z',
    })),
    no_data_drivers: noData,
    synced_at: '2026-07-03T00:00:00Z',
  }
}

describe('wageSourceMonthToSummaries', () => {
  it('fixture サマリが恒等で戻り、乗務員CD の数値順に並ぶ', () => {
    // ichiban は文字列昇順で返す ("10" < "9") — 数値順 (9 < 10) に直ることを見る
    const a = { ...theearthSummaries[0]!, driverCd: '10' }
    const b = { ...theearthSummaries[1]!, driverCd: '9' }
    const out = wageSourceMonthToSummaries(wireOf([a, b], ['9901']))
    expect(out.summaries.map(s => s.data.driverCd)).toStrictEqual(['9', '10'])
    expect(out.summaries[1]!.data).toStrictEqual(a)
    expect(out.summaries[0]!.fetchedAt).toBe('2026-07-01T00-00-00Z')
    expect(out.summaries[0]!.lastVerifiedAt).toBe('2026-07-02T00-00-00Z')
    expect(out.noDataDrivers).toStrictEqual(['9901'])
  })

  it('v1 summary (days なし) は days:[] に補完される (loadMonthSummaries と同じ防御)', () => {
    const { days: _days, ...v1 } = theearthSummaries[0]!
    const wire = wireOf([v1 as unknown as RestraintDriverSummary])
    const out = wageSourceMonthToSummaries(wire)
    expect(out.summaries[0]!.data.days).toStrictEqual([])
  })
})

describe('isWageSourceResponse', () => {
  const month = { summaries: [], no_data_drivers: [], synced_at: null }

  it('4 piece が揃っていれば true', () => {
    expect(
      isWageSourceResponse({
        month: '2026-06',
        prev_month: '2026-05',
        current_theearth: month,
        current_timecard: month,
        prev_theearth: month,
        prev_timecard: month,
      }),
    ).toBe(true)
  })

  it('欠け・非オブジェクトは false', () => {
    expect(isWageSourceResponse(null)).toBe(false)
    expect(isWageSourceResponse('x')).toBe(false)
    expect(isWageSourceResponse({ current_theearth: month })).toBe(false)
    expect(
      isWageSourceResponse({
        current_theearth: month,
        current_timecard: month,
        prev_theearth: month,
        prev_timecard: { summaries: 'broken', no_data_drivers: [] },
      }),
    ).toBe(false)
    expect(
      isWageSourceResponse({
        current_theearth: null,
        current_timecard: month,
        prev_theearth: month,
        prev_timecard: month,
      }),
    ).toBe(false)
  })
})
