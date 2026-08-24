import { describe, it, expect, vi } from 'vitest'

import handler from '../../server/api/profit/margin-snapshot.get'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'
import { emptyMarginTotals } from '../../app/utils/margin'
import { MARGIN_SUMMARY_SCHEMA_VERSION, type MarginSummarySnapshot } from '../../app/utils/margin-r2'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<MarginSummarySnapshot>)(event)

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
  /** `get()` されたキー。**組み立てたキーが正しいこと**を固定するため。 */
  gotKeys: string[] = []

  async get(key: string) {
    this.gotKeys.push(key)
    const body = this.store.get(key)
    if (body === undefined) return null
    return { key, text: async () => body }
  }

  async head(key: string) {
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
    const objects: R2ObjectLite[] = [...this.store.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key }))
    return { objects, truncated: false as const, cursor: undefined }
  }
}

const DIR_2607 = 'profit/2026-07/margin-summary'

function snapshotJson(ym: string, overrides: Partial<ReturnType<typeof emptyMarginTotals>> = {}) {
  return JSON.stringify({
    schemaVersion: MARGIN_SUMMARY_SCHEMA_VERSION,
    ym,
    codeVersion: 'v0.0.524',
    savedAt: '2026-08-24T10:01:53.000Z',
    totals: { ...emptyMarginTotals(), ...overrides },
    cache: { ym, savedAt: '2026-08-24T10:01:53.000Z', operations: [], costs: [], uncovered: null, crossMonth: null },
  })
}

function eventWith(env: Record<string, unknown>, query: Record<string, string> = {}) {
  return { context: { cloudflare: { env } }, _query: query }
}

describe('GET /api/profit/margin-snapshot', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    await expect(call(eventWith({}, { ym: '2026-07', version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('ym が無ければ 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('ym の形が違えば 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026/07', version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('version が無ければ 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07' })))
      .rejects.toMatchObject({ statusCode: 400 })
  })

  it('★ 版の名前の形が違えば 400 — R2 を 1 回も叩かない', async () => {
    const bucket = new FakeR2Bucket()
    for (const version of [
      'latest',
      'v-20260824T190153.json',
      '../../secret',
      'v-2026-08-24T19:01:53',
      'v-20260824T19015',
    ]) {
      await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version })))
        .rejects.toMatchObject({ statusCode: 400 })
    }
    // **画面が持っている R2 のキーをそのまま鍵にしない**ので、弾いた時点で読みに行かない。
    expect(bucket.gotKeys).toEqual([])
  })

  it('★ キーは ym と版の名前から marginR2Paths で組む (クエリのキーで get しない)', async () => {
    const bucket = new FakeR2Bucket()
    await bucket.put(`${DIR_2607}/v-20260824T190153.json`, snapshotJson('2026-07', { marginYen: 4467597 }))

    const result = await call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260824T190153' }))
    expect(bucket.gotKeys).toEqual([`${DIR_2607}/v-20260824T190153.json`])
    expect(result.ym).toBe('2026-07')
    expect(result.schemaVersion).toBe(MARGIN_SUMMARY_SCHEMA_VERSION)
    // **保存済みの JSON をそのまま返す** (数字を 1 円も作らない・変えない)。
    expect(result.totals.marginYen).toBe(4467597)
    expect(result.codeVersion).toBe('v0.0.524')
    expect(result.savedAt).toBe('2026-08-24T10:01:53.000Z')
    expect(result.cache.ym).toBe('2026-07')
  })

  it('★ 別の月の同じ名前の版は読まない (prefix が月ごと)', async () => {
    const bucket = new FakeR2Bucket()
    await bucket.put('profit/2026-06/margin-summary/v-20260824T190153.json', snapshotJson('2026-06'))

    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260824T190153' })))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(bucket.gotKeys).toEqual([`${DIR_2607}/v-20260824T190153.json`])
  })

  it('★ 一覧に出ていても本文が無ければ 404 (空の版に倒さない)', async () => {
    const bucket = new FakeR2Bucket()
    await expect(call(eventWith({ PROFIT_R2: bucket }, { ym: '2026-07', version: 'v-20260101T000000' })))
      .rejects.toMatchObject({ statusCode: 404, statusMessage: '版 v-20260101T000000 の本文を R2 から読めませんでした' })
  })
})
