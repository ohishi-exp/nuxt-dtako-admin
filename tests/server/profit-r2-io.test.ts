import { describe, it, expect } from 'vitest'
import { sha256Hex, putVersionedProfit, listAllProfit, appendProfitHistory, type R2BucketLite, type R2ObjectLite } from '../../server/utils/profit-r2-io'

/** インメモリの R2BucketLite フェイク (list は prefix + 1000件ページングを再現)。 */
class FakeR2Bucket implements R2BucketLite {
  store = new Map<string, { body: string, customMetadata?: Record<string, string> }>()

  async get(key: string) {
    const entry = this.store.get(key)
    if (!entry) return null
    return { key, customMetadata: entry.customMetadata, text: async () => entry.body }
  }

  async head(key: string) {
    const entry = this.store.get(key)
    return entry ? { customMetadata: entry.customMetadata } : null
  }

  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { customMetadata?: Record<string, string> }) {
    const body = typeof value === 'string' ? value : new TextDecoder().decode(value as Uint8Array)
    this.store.set(key, { body, customMetadata: options?.customMetadata })
    return {}
  }

  async list(options?: { prefix?: string, cursor?: string }) {
    const prefix = options?.prefix ?? ''
    const allKeys = [...this.store.keys()].filter(k => k.startsWith(prefix)).sort()
    const pageSize = 2 // ページングを確実にテストするため意図的に小さくする
    const start = options?.cursor ? Number(options.cursor) : 0
    const page = allKeys.slice(start, start + pageSize)
    const objects: R2ObjectLite[] = page.map(key => ({ key, customMetadata: this.store.get(key)?.customMetadata }))
    const truncated = start + pageSize < allKeys.length
    return { objects, truncated, cursor: truncated ? String(start + pageSize) : undefined }
  }
}

describe('sha256Hex', () => {
  it('同一バイト列は同一ハッシュになる', async () => {
    const a = await sha256Hex(new TextEncoder().encode('hello'))
    const b = await sha256Hex(new TextEncoder().encode('hello'))
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })

  it('異なるバイト列は異なるハッシュになる', async () => {
    const a = await sha256Hex(new TextEncoder().encode('hello'))
    const b = await sha256Hex(new TextEncoder().encode('world'))
    expect(a).not.toBe(b)
  })
})

describe('putVersionedProfit', () => {
  it('latest が無ければ新規として latest + version を書き込み changed=true を返す', async () => {
    const bucket = new FakeR2Bucket()
    const result = await putVersionedProfit(bucket, 'dir/latest.json', 'dir/v-1.json', '{"a":1}', '{"a":1}', '2026-07-19T00:00:00Z')
    expect(result.changed).toBe(true)
    expect((await bucket.get('dir/latest.json'))?.text()).resolves.toBe('{"a":1}')
    expect((await bucket.get('dir/v-1.json'))?.text()).resolves.toBe('{"a":1}')
  })

  it('hashInput が同一なら版を増やさず lastVerifiedAt だけ更新する', async () => {
    const bucket = new FakeR2Bucket()
    await putVersionedProfit(bucket, 'dir/latest.json', 'dir/v-1.json', '{"a":1}', '{"a":1}', '2026-07-19T00:00:00Z')
    const result = await putVersionedProfit(bucket, 'dir/latest.json', 'dir/v-2.json', '{"a":1}', '{"a":1}', '2026-07-19T01:00:00Z')

    expect(result.changed).toBe(false)
    expect(await bucket.get('dir/v-2.json')).toBeNull() // 版は増えない
    const latest = await bucket.head('dir/latest.json')
    expect(latest?.customMetadata?.lastVerifiedAt).toBe('2026-07-19T01:00:00Z')
    expect(latest?.customMetadata?.fetchedAt).toBe('2026-07-19T00:00:00Z') // 元の取得時刻は保持
  })

  it('body だけが変わり hashInput は同一なら (savedAt 更新など) 版は増やさず latest 本文だけ最新化する', async () => {
    const bucket = new FakeR2Bucket()
    await putVersionedProfit(bucket, 'dir/latest.json', 'dir/v-1.json', '{"a":1,"savedAt":"t0"}', '{"a":1}', '2026-07-19T00:00:00Z')
    const result = await putVersionedProfit(bucket, 'dir/latest.json', 'dir/v-2.json', '{"a":1,"savedAt":"t1"}', '{"a":1}', '2026-07-19T01:00:00Z')

    expect(result.changed).toBe(false)
    expect((await bucket.get('dir/latest.json'))?.text()).resolves.toBe('{"a":1,"savedAt":"t1"}') // 本文は最新化される
    expect(await bucket.get('dir/v-2.json')).toBeNull()
  })

  it('hashInput が変われば latest 上書き + 新しい version を追加する', async () => {
    const bucket = new FakeR2Bucket()
    await putVersionedProfit(bucket, 'dir/latest.json', 'dir/v-1.json', '{"a":1}', '{"a":1}', '2026-07-19T00:00:00Z')
    const result = await putVersionedProfit(bucket, 'dir/latest.json', 'dir/v-2.json', '{"a":2}', '{"a":2}', '2026-07-19T01:00:00Z')

    expect(result.changed).toBe(true)
    expect((await bucket.get('dir/latest.json'))?.text()).resolves.toBe('{"a":2}')
    expect((await bucket.get('dir/v-1.json'))?.text()).resolves.toBe('{"a":1}') // 旧版は残る
    expect((await bucket.get('dir/v-2.json'))?.text()).resolves.toBe('{"a":2}')
  })
})

describe('listAllProfit', () => {
  it('cursor で全ページを回収する', async () => {
    const bucket = new FakeR2Bucket()
    for (let i = 0; i < 5; i++) await bucket.put(`p/${i}.json`, '{}')
    const objects = await listAllProfit(bucket, 'p/')
    expect(objects).toHaveLength(5)
  })

  it('prefix に一致しないキーは含まれない', async () => {
    const bucket = new FakeR2Bucket()
    await bucket.put('p/a.json', '{}')
    await bucket.put('q/b.json', '{}')
    const objects = await listAllProfit(bucket, 'p/')
    expect(objects.map(o => o.key)).toEqual(['p/a.json'])
  })
})

describe('appendProfitHistory', () => {
  it('既存が無ければ新規作成する', async () => {
    const bucket = new FakeR2Bucket()
    await appendProfitHistory(bucket, 'dir/history.jsonl', '{"ts":"1"}')
    expect((await bucket.get('dir/history.jsonl'))?.text()).resolves.toBe('{"ts":"1"}\n')
  })

  it('既存に追記する', async () => {
    const bucket = new FakeR2Bucket()
    await appendProfitHistory(bucket, 'dir/history.jsonl', '{"ts":"1"}')
    await appendProfitHistory(bucket, 'dir/history.jsonl', '{"ts":"2"}')
    expect((await bucket.get('dir/history.jsonl'))?.text()).resolves.toBe('{"ts":"1"}\n{"ts":"2"}\n')
  })
})
