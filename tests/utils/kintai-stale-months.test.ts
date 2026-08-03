import { describe, it, expect } from 'vitest'
import {
  kintaiStaleMonthBadge,
  kintaiStaleMonthEntry,
  kintaiStaleMonthKey,
  parseKintaiStaleMonths,
} from '~/utils/kintai-stale-months'

/** #620 起票時に確定済みの応答形。 */
function body(over: Record<string, unknown> = {}) {
  return {
    logic_version: '0dd618334e44252b',
    from: '2025-07',
    to: '2026-06',
    default_window_months: 12,
    months: [
      { month: '2026-06', stale_drivers: 0, total_drivers: 0 },
      { month: '2026-05', stale_drivers: 0, total_drivers: 12 },
      { month: '2026-04', stale_drivers: 3, total_drivers: 12 },
    ],
    ...over,
  }
}

describe('parseKintaiStaleMonths', () => {
  it('確定済みの応答を camelCase に読み替える', () => {
    const r = parseKintaiStaleMonths(body())
    expect(r).toEqual({
      logicVersion: '0dd618334e44252b',
      from: '2025-07',
      to: '2026-06',
      defaultWindowMonths: 12,
      months: [
        { month: '2026-06', staleDrivers: 0, totalDrivers: 0 },
        { month: '2026-05', staleDrivers: 0, totalDrivers: 12 },
        { month: '2026-04', staleDrivers: 3, totalDrivers: 12 },
      ],
    })
  })

  it('null/文字列/配列でない months は空扱い (壊さない)', () => {
    expect(parseKintaiStaleMonths(null)).toEqual({
      logicVersion: null,
      from: null,
      to: null,
      defaultWindowMonths: null,
      months: [],
    })
    expect(parseKintaiStaleMonths('x')).toEqual({
      logicVersion: null,
      from: null,
      to: null,
      defaultWindowMonths: null,
      months: [],
    })
    expect(parseKintaiStaleMonths(body({ months: 'not-array' })).months).toEqual([])
  })

  it('month の無い要素・object でない要素は捨てる', () => {
    const r = parseKintaiStaleMonths(
      body({ months: [{ stale_drivers: 1, total_drivers: 1 }, 'x', null, { month: '2026-03', stale_drivers: 1, total_drivers: 5 }] }),
    )
    expect(r.months).toEqual([{ month: '2026-03', staleDrivers: 1, totalDrivers: 5 }])
  })

  it('stale_drivers / total_drivers が欠けたり非数値なら0に倒す', () => {
    const r = parseKintaiStaleMonths(body({ months: [{ month: '2026-02' }, { month: '2026-01', stale_drivers: 'x', total_drivers: null }] }))
    expect(r.months).toEqual([
      { month: '2026-02', staleDrivers: 0, totalDrivers: 0 },
      { month: '2026-01', staleDrivers: 0, totalDrivers: 0 },
    ])
  })

  it('logic_version / from / to / default_window_months が欠けたら null', () => {
    const r = parseKintaiStaleMonths({ months: [] })
    expect(r.logicVersion).toBeNull()
    expect(r.from).toBeNull()
    expect(r.to).toBeNull()
    expect(r.defaultWindowMonths).toBeNull()
  })
})

describe('kintaiStaleMonthBadge (★ #620 の一番の落とし穴)', () => {
  const months = parseKintaiStaleMonths(body()).months

  it('total_drivers === 0 は stale_drivers も0でも「データ無し」(no_data) — 「正常」と混同しない', () => {
    expect(kintaiStaleMonthBadge('2026-06', months)).toBe('no_data')
  })

  it('total_drivers > 0 && stale_drivers === 0 は「畳み済みで最新」(ok) — 塗らない', () => {
    expect(kintaiStaleMonthBadge('2026-05', months)).toBe('ok')
  })

  it('stale_drivers > 0 は「畳み直しが要る」(stale) — 塗る', () => {
    expect(kintaiStaleMonthBadge('2026-04', months)).toBe('stale')
  })

  it('応答に無い月 (窓の外・未取得) は unknown — okと混同しない', () => {
    expect(kintaiStaleMonthBadge('2020-01', months)).toBe('unknown')
  })

  it('total_drivers === 0 かつ stale_drivers > 0 という矛盾した応答でも no_data を優先する (総数0の月に古い乗務員はいない)', () => {
    const weird = [{ month: '2026-06', staleDrivers: 3, totalDrivers: 0 }]
    expect(kintaiStaleMonthBadge('2026-06', weird)).toBe('no_data')
  })
})

describe('kintaiStaleMonthEntry', () => {
  const months = parseKintaiStaleMonths(body()).months

  it('見つかればそのエントリを返す', () => {
    expect(kintaiStaleMonthEntry('2026-04', months)).toEqual({ month: '2026-04', staleDrivers: 3, totalDrivers: 12 })
  })

  it('見つからなければ null', () => {
    expect(kintaiStaleMonthEntry('2020-01', months)).toBeNull()
  })
})

describe('kintaiStaleMonthKey', () => {
  it('年 + 月番号を YYYY-MM に組む (0埋め)', () => {
    expect(kintaiStaleMonthKey(2026, 6)).toBe('2026-06')
    expect(kintaiStaleMonthKey(2026, 12)).toBe('2026-12')
  })
})
