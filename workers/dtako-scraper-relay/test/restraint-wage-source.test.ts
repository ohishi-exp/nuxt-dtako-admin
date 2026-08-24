// restraint-wage-source (ichiban wage-source 応答 → loadMonthSummaries 形、
// Refs #452 Phase 3c) のテスト。push (restraint-push) → ichiban 保存 → wage-source
// 応答、と回った summary が R2 経路と同じ形・同じ並びで戻ることを固定する。

import { describe, expect, it } from 'vitest'
import {
  isWageSourceResponse,
  wageSourceMonthR2Fallback,
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
    // no_data_drivers 側が配列でない場合 (`&&` の右辺 false — 短絡のせいで
    // v8 の branches 100% では見えない側)
    expect(
      isWageSourceResponse({
        current_theearth: month,
        current_timecard: month,
        prev_theearth: month,
        prev_timecard: { summaries: [], no_data_drivers: 'broken' },
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

describe('wageSourceMonthR2Fallback', () => {
  // 本番 2026-07 の欠陥 (#812): synced_at は立っているのに写しが空で、R2 には
  // 111 名ぶん在るのに「アーカイブにありません」と出て表が空になっていた。
  const month = (over: Partial<WageSourceMonthWire> = {}): WageSourceMonthWire => ({
    summaries: [],
    no_data_drivers: [],
    synced_at: '2026-07-03T00:00:00Z',
    ...over,
  })

  it('未 push (synced_at null) は落ちる — 従来のタグのまま', () => {
    expect(wageSourceMonthR2Fallback(month({ synced_at: null }))).toBe('r2-piece-fallback')
  })

  it('push 済みなのに summaries 0 かつ no_data_drivers 0 は落ちる — 別タグ', () => {
    expect(wageSourceMonthR2Fallback(month())).toBe('r2-empty-copy-fallback')
  })

  it('summaries 0 でも no_data_drivers があれば落ちない (「調べて 0 名」を信じる)', () => {
    // ここを summaries.length === 0 だけで落とすと、本当に 0 名の月で毎回
    // R2 fan-out (約300 GET) を叩くことになる
    expect(wageSourceMonthR2Fallback(month({ no_data_drivers: ['9901'] }))).toBeNull()
  })

  it('通常 (push 済み・summaries あり) は落ちない', () => {
    const wire = wireOf([theearthSummaries[0]!])
    expect(wire.synced_at).not.toBeNull()
    expect(wageSourceMonthR2Fallback(wire)).toBeNull()
    // no_data_drivers が空でも summaries が在れば写しを使う (短絡の左側)
    expect(wageSourceMonthR2Fallback(month({ summaries: wire.summaries }))).toBeNull()
  })
})
