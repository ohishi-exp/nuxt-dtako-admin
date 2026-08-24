import { describe, it, expect, vi } from 'vitest'

import handler from '../../server/api/profit/margin-snapshots.get'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'
import { emptyMarginTotals } from '../../app/utils/margin'
import { MARGIN_VERSION_BODY_LIMIT, type MarginVersionListResult } from '../../app/utils/margin-versions'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<MarginVersionListResult>)(event)

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getQuery: (event: { _query: Record<string, string> }) => event._query,
  }
})

class FakeR2Bucket implements R2BucketLite {
  store = new Map<string, string>()
  /** list には出るが get すると null になるキー (削除race等の防御分岐のテスト用)。 */
  phantomKeys: string[] = []
  /** `get()` されたキー (**版の数だけ本文を読んでいない**ことを数えるため)。 */
  gotKeys: string[] = []
  /** `head()` されたキー (**一覧で 1 回も叩かない**ことを固定するため)。 */
  headKeys: string[] = []

  async get(key: string) {
    this.gotKeys.push(key)
    const body = this.store.get(key)
    if (body === undefined) return null
    return { key, text: async () => body }
  }

  async head(key: string) {
    this.headKeys.push(key)
    return this.store.has(key) ? {} : null
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string) {
    this.store.set(key, typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array))
    return {}
  }

  async delete(key: string) {
    this.store.delete(key)
    return {}
  }

  async list(options?: { prefix?: string, cursor?: string }) {
    const prefix = options?.prefix ?? ''
    const keys = [...this.store.keys(), ...this.phantomKeys].filter(k => k.startsWith(prefix))
    // **cursor で 2 回に割って返す** — `listAllProfit` が truncated を回すことも通す。
    const page = options?.cursor === 'p2' ? keys.slice(1) : keys.slice(0, 1)
    const truncated = options?.cursor !== 'p2' && keys.length > 1
    const objects: R2ObjectLite[] = page.map(key => ({ key }))
    return { objects, truncated, cursor: truncated ? 'p2' : undefined }
  }
}

function dirOf(ym: string) {
  return `profit/${ym}/margin-summary`
}

function snapshotJson(ym: string, overrides: Partial<ReturnType<typeof emptyMarginTotals>> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    ym,
    codeVersion: 'v0.0.522',
    savedAt: '2026-08-24T01:20:30.000Z',
    totals: { ...emptyMarginTotals(), ...overrides },
    cache: { ym, savedAt: '2026-08-24T01:20:30.000Z', operations: [], costs: [], uncovered: null, crossMonth: null },
  })
}

async function putVersion(bucket: FakeR2Bucket, ym: string, ts: string, overrides: Partial<ReturnType<typeof emptyMarginTotals>> = {}) {
  await bucket.put(`${dirOf(ym)}/v-${ts}.json`, snapshotJson(ym, overrides))
}

function eventWith(env: Record<string, unknown>, query: Record<string, string> = {}) {
  return { context: { cloudflare: { env } }, _query: query }
}

describe('GET /api/profit/margin-snapshots', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    await expect(call(eventWith({}, { ym: '2026-07' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('ym が無ければ 400 (月を跨いで舐めない)', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym の形が違えば 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026/07' }))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('v-*.json だけを新しい順に返し、金額は保存済みの totals そのまま', async () => {
    const bucket = new FakeR2Bucket()
    await bucket.put(`${dirOf('2026-07')}/latest.json`, snapshotJson('2026-07'))
    await bucket.put(`${dirOf('2026-07')}/history.jsonl`, '{}\n')
    await putVersion(bucket, '2026-07', '20260801T000000', { operations: 90, salesYen: 10000000, allowanceYen: 2400000, marginYen: 4400000 })
    await putVersion(bucket, '2026-07', '20260824T102030', { operations: 91, salesYen: 10260265, allowanceYen: 2499500, marginYen: 4467597 })

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' }))
    expect(result.ym).toBe('2026-07')
    expect(result.total).toBe(2)
    expect(result.omitted).toBe(0)
    expect(result.bodyLimit).toBe(MARGIN_VERSION_BODY_LIMIT)
    expect(result.items.map(i => i.label)).toEqual(['v-20260824T102030', 'v-20260801T000000'])
    expect(result.items[0]!.totals).toEqual({
      operations: 91,
      salesYen: 10260265,
      allowanceYen: 2499500,
      marginYen: 4467597,
    })
    expect(result.items.map(i => i.totalsState)).toEqual(['read', 'read'])
    expect(result.unreadable).toBe(0)
    // **latest.json / history.jsonl の本文は読まない。**
    expect(bucket.gotKeys).toEqual([
      `${dirOf('2026-07')}/v-20260824T102030.json`,
      `${dirOf('2026-07')}/v-20260801T000000.json`,
    ])
    // **codeVersion のために head() を版の数だけ叩かない。**
    expect(bucket.headKeys).toEqual([])
  })

  it('別の月の版は混ざらない (prefix が月ごと)', async () => {
    const bucket = new FakeR2Bucket()
    await putVersion(bucket, '2026-06', '20260610T000000')
    await putVersion(bucket, '2026-07', '20260710T000000')

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' }))
    expect(result.items.map(i => i.label)).toEqual(['v-20260710T000000'])
  })

  it('上限を超えたぶんは本文を読まず、ラベルだけ返して omitted で数える', async () => {
    const bucket = new FakeR2Bucket()
    const count = MARGIN_VERSION_BODY_LIMIT + 3
    for (let i = 0; i < count; i++) {
      await putVersion(bucket, '2026-07', `202607${String(i + 1).padStart(2, '0')}T000000`, { operations: i })
    }

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' }))
    expect(result.total).toBe(count)
    expect(result.items).toHaveLength(count)
    expect(result.omitted).toBe(3)
    // 新しい方 20 本は金額つき、それより古い 3 本は null。
    expect(result.items.slice(0, MARGIN_VERSION_BODY_LIMIT).every(i => i.totals !== null)).toBe(true)
    expect(result.items.slice(MARGIN_VERSION_BODY_LIMIT).every(i => i.totals === null)).toBe(true)
    // **読まなかった (正常) は `unreadable` に数えない。**
    expect(result.items.slice(MARGIN_VERSION_BODY_LIMIT).every(i => i.totalsState === 'over-limit')).toBe(true)
    expect(result.unreadable).toBe(0)
    // **本数によらず一定の回数**しか本文を読まない。
    expect(bucket.gotKeys).toHaveLength(MARGIN_VERSION_BODY_LIMIT)
  })

  it('list に出るが get すると null (削除race等) な版は金額を 0 に倒さず null で返す', async () => {
    const bucket = new FakeR2Bucket()
    await putVersion(bucket, '2026-07', '20260801T000000', { operations: 90 })
    bucket.phantomKeys.push(`${dirOf('2026-07')}/v-20260824T102030.json`)

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' }))
    expect(result.items.map(i => i.totals === null)).toEqual([true, false])
    expect(result.total).toBe(2)
    // **上限で省いたのと別勘定。** 読まなかった (正常) と読めなかった (異常) を混ぜない。
    expect(result.items.map(i => i.totalsState)).toEqual(['unreadable', 'read'])
    expect(result.unreadable).toBe(1)
    expect(result.omitted).toBe(0)
  })

  it('版が 1 つも無ければ空配列', async () => {
    const bucket = new FakeR2Bucket()
    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' }))
    expect(result.items).toEqual([])
    expect(result.total).toBe(0)
    expect(result.omitted).toBe(0)
    expect(result.unreadable).toBe(0)
  })
})
