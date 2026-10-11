// restraint-push (ichiban への拘束サマリ push body 構築、Refs #452 /
// rust-ichibanboshi#106 Phase 3b) のテスト。ichiban 側 PushBody との整合は
// rust-ichibanboshi/tests/restraint_test.rs が固定する — ここでは entry 変換と
// チャンク分割を固定する。

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildRestraintPushBodies,
  RESTRAINT_PUSH_CHUNK,
  sendRestraintPushBodies,
  type RestraintPushTarget,
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

describe('1 本の PUT の entries の上限', () => {
  it('★ 既定チャンク (40) は勤怠 Worker の上限 (entries 500 / PUT) 以下', () => {
    // 勤怠 Worker の PUT /api/restraint/summaries は entries 501 件以上を 400 で拒む
    // (rust-ichibanboshi workers/kintai/README.md「1 回の PUT の entries の上限 — 500」)
    const many: RestraintD1Entry[] = Array.from({ length: 1201 }, (_, i) =>
      summaryEntry({ ...theearthSummaries[0]!, driverCd: String(i) }),
    )
    const bodies = buildRestraintPushBodies('comp-1', 'theearth', '2026-06', many)
    expect(Math.max(...bodies.map(b => b.entries.length))).toBeLessThanOrEqual(500)
    expect(RESTRAINT_PUSH_CHUNK).toBeLessThanOrEqual(500)
  })
})

describe('sendRestraintPushBodies', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const entries = (n: number): RestraintD1Entry[] =>
    Array.from({ length: n }, (_, i) => ({ kind: 'no-data', driverCd: String(i), meta: META }))

  function target(replies: Array<() => Promise<Response>>) {
    const calls: Array<{ url: string, init: RequestInit }> = []
    const t: RestraintPushTarget = {
      url: 'https://kintai.invalid/api/restraint/summaries',
      headers: { 'X-Kintai-Write-Token': 'tok' },
      fetch: async (url, init) => {
        calls.push({ url, init })
        return replies[calls.length - 1]!()
      },
    }
    return { t, calls }
  }
  const ok = async () => Response.json({ saved: 1 })

  it('body 列を順に PUT し、宛先のヘッダーに content-type を足す', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bodies = buildRestraintPushBodies('comp-1', 'timecard', '2026-06', entries(3), 2)
    const { t, calls } = target([ok, ok])
    expect(await sendRestraintPushBodies('kintai', t, bodies)).toStrictEqual({ outcome: 'done', puts: 2 })
    expect(calls.map(c => c.url)).toStrictEqual([t.url, t.url])
    expect(calls[0]!.init.method).toBe('PUT')
    expect(calls[0]!.init.headers).toStrictEqual({ 'content-type': 'application/json', 'X-Kintai-Write-Token': 'tok' })
    expect(calls.map(c => JSON.parse(String(c.init.body)))).toStrictEqual(bodies)
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toStrictEqual({
      restraint_push: 'done', target: 'kintai', comp_id: 'comp-1', source: 'timecard', ym: '2026-06', entries: 3,
    })
  })

  it('非 2xx なら続きを諦め、status と本文の先頭 200 字だけをログに出す (ヘッダーは出さない)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bodies = buildRestraintPushBodies('comp-1', 'theearth', '2026-06', entries(3), 1)
    const { t, calls } = target([ok, async () => new Response('x'.repeat(300), { status: 403 })])
    expect(await sendRestraintPushBodies('kintai', t, bodies)).toStrictEqual({ outcome: 'upstream-error', status: 403 })
    expect(calls).toHaveLength(2)
    const logged = JSON.parse(String(err.mock.calls[0]![0]))
    expect(logged).toStrictEqual({
      restraint_push: 'upstream-error', target: 'kintai', comp_id: 'comp-1', source: 'theearth', ym: '2026-06',
      status: 403, body: 'x'.repeat(200),
    })
    expect(String(err.mock.calls[0]![0])).not.toContain('tok')
  })

  it('例外は握って error で返す (Error 以外の throw も文字列にする)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bodies = buildRestraintPushBodies('comp-1', 'theearth', '2026-06', entries(1))
    const t: RestraintPushTarget = {
      url: 'u',
      headers: {},
      fetch: async () => {
        throw 'unreachable' // eslint-disable-line no-throw-literal
      },
    }
    expect(await sendRestraintPushBodies('kintai', t, bodies)).toStrictEqual({ outcome: 'error', error: 'unreachable' })
    expect(JSON.parse(String(err.mock.calls[0]![0]))).toMatchObject({ restraint_push: 'error', target: 'kintai' })
  })

  it('宛先が null (未設定) なら叩かずに skipped-not-configured', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const bodies = buildRestraintPushBodies('comp-1', 'theearth', '2026-06', entries(1))
    expect(await sendRestraintPushBodies('kintai', null, bodies)).toStrictEqual({ outcome: 'skipped-not-configured' })
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toStrictEqual({
      restraint_push: 'skipped-not-configured', target: 'kintai', comp_id: 'comp-1', source: 'theearth', ym: '2026-06',
    })
  })

  it('body が無ければ宛先を問わず skipped-empty (ログも出さない)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { t, calls } = target([])
    expect(await sendRestraintPushBodies('kintai', t, [])).toStrictEqual({ outcome: 'skipped-empty' })
    expect(await sendRestraintPushBodies('kintai', null, [])).toStrictEqual({ outcome: 'skipped-empty' })
    expect(calls).toHaveLength(0)
    expect(log).not.toHaveBeenCalled()
  })
})
