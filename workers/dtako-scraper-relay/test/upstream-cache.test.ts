import { describe, expect, it } from 'vitest'
import {
  aggregateCacheState,
  CacheStateTracker,
  gunzipText,
  gzipText,
  parseVersionResponse,
  UPSTREAM_CACHE_MAX_GZ_BYTES,
  UpstreamCache,
  type SqlStorageLike,
} from '../src/upstream-cache'

interface FakeRow {
  body_gz: Uint8Array | ArrayBuffer
  sha256: string
  upstream_etag: string
  fetched_at: number
  verified_at: number
}

/** SqlStorage の最小メモリ実装。発行された SQL の種類を記録して検証に使う。 */
class FakeSql implements SqlStorageLike {
  rows = new Map<string, FakeRow>()
  execLog: string[] = []

  exec(query: string, ...bindings: unknown[]) {
    this.execLog.push(query.trim().split(/\s+/, 2).join(' '))
    if (query.startsWith('CREATE TABLE')) return cursor([])
    if (query.startsWith('SELECT')) {
      const [kind, month] = bindings as [string, string]
      const row = this.rows.get(`${kind}|${month}`)
      return cursor(row ? [{ body_gz: row.body_gz, upstream_etag: row.upstream_etag }] : [])
    }
    if (query.startsWith('UPDATE')) {
      const [now, kind, month] = bindings as [number, string, string]
      const row = this.rows.get(`${kind}|${month}`)
      if (row) row.verified_at = now
      return cursor([])
    }
    // INSERT ... ON CONFLICT (upsert)
    const [kind, month, body, sha256, etag, fetchedAt, verifiedAt] = bindings as [
      string, string, ArrayBuffer, string, string, number, number,
    ]
    this.rows.set(`${kind}|${month}`, {
      body_gz: body,
      sha256,
      upstream_etag: etag,
      fetched_at: fetchedAt,
      verified_at: verifiedAt,
    })
    return cursor([])
  }
}

function cursor(rows: Array<Record<string, unknown>>) {
  return { toArray: () => rows }
}

describe('UpstreamCache', () => {
  it('put → getFresh (版一致) で本文が往復し、verified_at が進む', async () => {
    const sql = new FakeSql()
    const cache = new UpstreamCache(sql)
    const gz = await gzipText('{"drivers":[]}')
    expect(cache.put('kosoku', '2026-06', gz, 'sha', 'etag-1', 1000)).toBe(true)
    const hit = cache.getFresh('kosoku', '2026-06', 'etag-1', 2000)
    expect(hit).not.toBeNull()
    expect(await gunzipText(hit!)).toBe('{"drivers":[]}')
    expect(sql.rows.get('kosoku|2026-06')!.verified_at).toBe(2000)
  })

  it('行なし・版不一致は null (verified_at は触らない)', async () => {
    const sql = new FakeSql()
    const cache = new UpstreamCache(sql)
    expect(cache.getFresh('daily', '2026-06', 'etag-1', 1000)).toBeNull()
    const gz = await gzipText('{"rows":[]}')
    cache.put('daily', '2026-06', gz, 'sha', 'etag-1', 1000)
    expect(cache.getFresh('daily', '2026-06', 'etag-2', 2000)).toBeNull()
    expect(sql.rows.get('daily|2026-06')!.verified_at).toBe(1000)
  })

  it('BLOB が ArrayBuffer で返る実装 (本番 SqlStorage) でも Uint8Array に正規化する', async () => {
    const sql = new FakeSql()
    const cache = new UpstreamCache(sql)
    const gz = await gzipText('body')
    cache.put('daily', '2026-06', gz, 'sha', 'e', 1)
    // put は ArrayBuffer で格納している (本番の SqlStorage BLOB と同じ形)
    expect(sql.rows.get('daily|2026-06')!.body_gz).toBeInstanceOf(ArrayBuffer)
    const hit = cache.getFresh('daily', '2026-06', 'e', 2)
    expect(hit).toBeInstanceOf(Uint8Array)
    expect(await gunzipText(hit!)).toBe('body')
    // Uint8Array を返すテスト実装でもそのまま通る
    sql.rows.get('daily|2026-06')!.body_gz = gz
    expect(await gunzipText(cache.getFresh('daily', '2026-06', 'e', 3)!)).toBe('body')
  })

  it('gzip 後 1.9MB 超は格納せず false (ライブ動作のまま)', () => {
    const sql = new FakeSql()
    const cache = new UpstreamCache(sql)
    const oversized = new Uint8Array(UPSTREAM_CACHE_MAX_GZ_BYTES + 1)
    expect(cache.put('kosoku', '2026-06', oversized, 'sha', 'e', 1)).toBe(false)
    expect(sql.rows.size).toBe(0)
  })

  it('upsert は同キーの行を置き換える。CREATE TABLE は 1 回だけ', async () => {
    const sql = new FakeSql()
    const cache = new UpstreamCache(sql)
    cache.put('kosoku', '2026-06', await gzipText('v1'), 'sha1', 'e1', 1)
    cache.put('kosoku', '2026-06', await gzipText('v2'), 'sha2', 'e2', 2)
    expect(sql.rows.size).toBe(1)
    expect(await gunzipText(cache.getFresh('kosoku', '2026-06', 'e2', 3)!)).toBe('v2')
    expect(sql.execLog.filter((q) => q.startsWith('CREATE'))).toHaveLength(1)
  })
})

describe('gzipText / gunzipText', () => {
  it('日本語込みのテキストが往復する', async () => {
    const text = JSON.stringify({ month: '2026-06', 乗務員: 'テスト', rows: [1, 2, 3] })
    expect(await gunzipText(await gzipText(text))).toBe(text)
  })

  it('壊れた gzip は throw する (呼び出し側がライブへ倒す)', async () => {
    await expect(gunzipText(new Uint8Array([1, 2, 3]))).rejects.toThrow()
  })
})

describe('parseVersionResponse', () => {
  it('{month, etag} から etag を取り出す', () => {
    expect(parseVersionResponse({ month: '2026-06', etag: 'abc' })).toBe('abc')
  })

  it('形が違う・空文字は null', () => {
    expect(parseVersionResponse(null)).toBeNull()
    expect(parseVersionResponse('etag')).toBeNull()
    expect(parseVersionResponse({})).toBeNull()
    expect(parseVersionResponse({ etag: 42 })).toBeNull()
    expect(parseVersionResponse({ etag: '' })).toBeNull()
  })
})

describe('aggregateCacheState / CacheStateTracker', () => {
  it('記録なし (フラグ off 等) は live', () => {
    expect(aggregateCacheState([])).toBe('live')
    expect(new CacheStateTracker().aggregate()).toBe('live')
  })

  it('全部 hit は hit', () => {
    expect(aggregateCacheState(['hit', 'hit'])).toBe('hit')
  })

  it('どれかが miss なら miss (live 混在でも取り直しがあった事実を優先)', () => {
    expect(aggregateCacheState(['hit', 'miss'])).toBe('miss')
    expect(aggregateCacheState(['miss', 'live'])).toBe('miss')
  })

  it('hit と live の混在・全部 live は live', () => {
    expect(aggregateCacheState(['hit', 'live'])).toBe('live')
    expect(aggregateCacheState(['live'])).toBe('live')
  })

  it('tracker は add した結果を畳む', () => {
    const tracker = new CacheStateTracker()
    tracker.add('hit')
    tracker.add('miss')
    expect(tracker.aggregate()).toBe('miss')
  })
})
