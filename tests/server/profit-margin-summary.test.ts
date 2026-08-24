import { describe, it, expect, vi, afterEach } from 'vitest'

import postHandler from '../../server/api/profit/margin-summary.post'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'
import { UNKNOWN_CODE_VERSION, type MarginSummarySnapshot } from '../../app/utils/margin-r2'
import { emptyMarginTotals } from '../../app/utils/margin'

const callPost = (event: unknown) => (postHandler as unknown as (e: unknown) => Promise<unknown>)(event)

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    readBody: (event: { _body: unknown }) => Promise.resolve(event._body),
  }
})

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

  async delete(key: string) {
    this.store.delete(key)
    return {}
  }

  async list(options?: { prefix?: string, cursor?: string }) {
    const prefix = options?.prefix ?? ''
    const objects: R2ObjectLite[] = [...this.store.keys()]
      .filter(k => k.startsWith(prefix))
      .map(key => ({ key, customMetadata: this.store.get(key)?.customMetadata }))
    return { objects, truncated: false, cursor: undefined }
  }
}

/** 2026-07 の本番値 (issue #826 の不変条件)。 */
function productionTotals() {
  return { ...emptyMarginTotals(), operations: 91, salesYen: 10260265, allowanceYen: 2499500, marginYen: 4467597 }
}

function validInput(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    ym: '2026-07',
    codeVersion: 'v0.0.517',
    totals: productionTotals(),
    cache: {
      ym: '2026-07',
      savedAt: '2026-08-24T01:23:45.000Z',
      operations: [{ unkoNo: 'u-1' }],
      costs: [{ 費用: 1 }],
      uncovered: null,
      crossMonth: null,
    },
    ...overrides,
  }
}

const eventWith = (bucket: R2BucketLite, body: unknown) =>
  ({ context: { cloudflare: { env: { PROFIT_R2: bucket } } }, _body: body })

const latestKey = 'profit/2026-07/margin-summary/latest.json'
const historyKey = 'profit/2026-07/margin-summary/history.jsonl'
const versionKeys = (bucket: FakeR2Bucket) =>
  [...bucket.store.keys()].filter(k => k.startsWith('profit/2026-07/margin-summary/v-'))

afterEach(() => {
  vi.useRealTimers()
})

describe('POST /api/profit/margin-summary', () => {
  it('PROFIT_R2 未設定なら 503', async () => {
    await expect(callPost({ context: {}, _body: validInput() })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('形が違う body は 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(callPost(eventWith(bucket, null))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, 'x'))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, validInput({ schemaVersion: 2 })))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, validInput({ ym: '2026-7' })))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, validInput({ ym: 99 })))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, validInput({ totals: null })))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, validInput({ totals: 'x' })))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, validInput({ cache: null })))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, validInput({ cache: 'x' })))).rejects.toMatchObject({ statusCode: 400 })
    expect(bucket.store.size).toBe(0)
  })

  it('★ cache.ym が body.ym と違えば 400 (保存先と中身の月をずらさない)', async () => {
    const bucket = new FakeR2Bucket()
    const body = validInput()
    ;(body.cache as { ym: string }).ym = '2026-06'
    await expect(callPost(eventWith(bucket, body))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('operations / costs が配列でなければ 400', async () => {
    const bucket = new FakeR2Bucket()
    await expect(callPost(eventWith(bucket, validInput({
      cache: { ...validInput().cache, operations: {} },
    })))).rejects.toMatchObject({ statusCode: 400 })
    await expect(callPost(eventWith(bucket, validInput({
      cache: { ...validInput().cache, costs: {} },
    })))).rejects.toMatchObject({ statusCode: 400 })
  })

  it('latest + v-{ts} + history に書き、書いた版のキーを返す', async () => {
    const bucket = new FakeR2Bucket()
    const res = await callPost(eventWith(bucket, validInput())) as { saved: boolean, changed: boolean, codeVersion: string, versionKey: string }
    expect(res.saved).toBe(true)
    expect(res.changed).toBe(true)
    expect(res.codeVersion).toBe('v0.0.517')
    expect(bucket.store.has(latestKey)).toBe(true)
    expect(versionKeys(bucket)).toHaveLength(1)
    expect(bucket.store.has(historyKey)).toBe(true)
    // 画面が「どの版になったか」を人に見せられる (Refs #826、親の指摘)
    expect(res.versionKey).toBe(versionKeys(bucket)[0])
    expect(res.versionKey).toMatch(/^profit\/2026-07\/margin-summary\/v-\d{8}T\d{6}\.json$/)
  })

  it('★ 本番値をそのまま保存する (1 円も動かさない)', async () => {
    const bucket = new FakeR2Bucket()
    await callPost(eventWith(bucket, validInput()))
    const saved = JSON.parse(bucket.store.get(latestKey)!.body) as MarginSummarySnapshot
    expect(saved.totals.operations).toBe(91)
    expect(saved.totals.salesYen).toBe(10260265)
    expect(saved.totals.allowanceYen).toBe(2499500)
    expect(saved.totals.marginYen).toBe(4467597)
    // MarginCache は形も中身も変えずそのまま入っている
    expect(saved.cache).toEqual(validInput().cache)
    expect(saved.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('customMetadata に codeVersion を刻む', async () => {
    const bucket = new FakeR2Bucket()
    await callPost(eventWith(bucket, validInput()))
    expect(bucket.store.get(latestKey)!.customMetadata).toMatchObject({ codeVersion: 'v0.0.517' })
    expect(bucket.store.get(versionKeys(bucket)[0]!)!.customMetadata).toMatchObject({ codeVersion: 'v0.0.517' })
  })

  it('★ コード版が空で来ても壊れず「不明」になる (空文字を版に混ぜない)', async () => {
    const bucket = new FakeR2Bucket()
    const res = await callPost(eventWith(bucket, validInput({ codeVersion: '' }))) as { codeVersion: string }
    expect(res.codeVersion).toBe(UNKNOWN_CODE_VERSION)
    expect(bucket.store.get(latestKey)!.customMetadata!.codeVersion).toBe(UNKNOWN_CODE_VERSION)
    const saved = JSON.parse(bucket.store.get(latestKey)!.body) as MarginSummarySnapshot
    expect(saved.codeVersion).toBe(UNKNOWN_CODE_VERSION)
  })

  it('★ コード版の欄そのものが無くても壊れない', async () => {
    const bucket = new FakeR2Bucket()
    const body = validInput()
    delete (body as Record<string, unknown>).codeVersion
    const res = await callPost(eventWith(bucket, body)) as { codeVersion: string }
    expect(res.codeVersion).toBe(UNKNOWN_CODE_VERSION)
  })

  it('★ 同じ内容を再送しても版は増えない (sha256 差分検知)', async () => {
    const bucket = new FakeR2Bucket()
    const first = await callPost(eventWith(bucket, validInput())) as { versionKey: string }
    const res = await callPost(eventWith(bucket, validInput())) as { changed: boolean, versionKey: string }
    expect(res.changed).toBe(false)
    expect(versionKeys(bucket)).toHaveLength(1)
    // ★ 増えなかった回も「どの版と同じか」を返す (画面が名前を出せる)
    expect(res.versionKey).toBe(first.versionKey)
  })

  it('★ 保存時刻だけ違う再送でも版は増えない', async () => {
    const bucket = new FakeR2Bucket()
    await callPost(eventWith(bucket, validInput()))
    const again = validInput()
    ;(again.cache as { savedAt: string }).savedAt = '2026-08-25T09:00:00.000Z'
    const res = await callPost(eventWith(bucket, again)) as { changed: boolean }
    expect(res.changed).toBe(false)
    expect(versionKeys(bucket)).toHaveLength(1)
  })

  it('コード版だけ上がった再送は版を増やさず lastVerifiedCodeVersion を更新する', async () => {
    const bucket = new FakeR2Bucket()
    await callPost(eventWith(bucket, validInput()))
    const res = await callPost(eventWith(bucket, validInput({ codeVersion: 'v0.0.518' }))) as { changed: boolean }
    expect(res.changed).toBe(false)
    expect(versionKeys(bucket)).toHaveLength(1)
    const meta = bucket.store.get(latestKey)!.customMetadata!
    // **数字を作った版は上書きしない。** 追えるのは「同じ数字を最後に確かめた版」。
    expect(meta.codeVersion).toBe('v0.0.517')
    expect(meta.lastVerifiedCodeVersion).toBe('v0.0.518')
  })

  it('★ 粗利が 1 円動けば新しい版が増える', async () => {
    // 版の suffix は `profitVersionTimestamp` (秒単位、検証スナップショットと同じ形) なので、
    // **同じ秒に 2 回保存すると同じ版キーに載る**。時計を進めて別の版になることを見る
    // (実運用では再集計に数十秒かかるので同じ秒には並ばない)。
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T10:20:30.000Z'))
    const bucket = new FakeR2Bucket()
    await callPost(eventWith(bucket, validInput()))
    vi.setSystemTime(new Date('2026-08-24T10:21:30.000Z'))
    const moved = validInput({ totals: { ...productionTotals(), marginYen: 4467598 } })
    const res = await callPost(eventWith(bucket, moved)) as { changed: boolean }
    expect(res.changed).toBe(true)
    expect(versionKeys(bucket)).toHaveLength(2)
    // 旧版は残る (「いつ変わったか」を辿れるのはこれが積むから)。
    const [oldKey, newKey] = versionKeys(bucket).sort()
    expect(JSON.parse(bucket.store.get(oldKey!)!.body).totals.marginYen).toBe(4467597)
    expect(JSON.parse(bucket.store.get(newKey!)!.body).totals.marginYen).toBe(4467598)
  })

  it('history.jsonl は再送のたびに 1 行増える (changed の別なく)', async () => {
    const bucket = new FakeR2Bucket()
    await callPost(eventWith(bucket, validInput()))
    await callPost(eventWith(bucket, validInput()))
    const lines = bucket.store.get(historyKey)!.body.split('\n').filter(l => l !== '')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!)).toMatchObject({ changed: true, marginYen: 4467597, codeVersion: 'v0.0.517' })
    expect(JSON.parse(lines[1]!)).toMatchObject({ changed: false })
  })

  it('月が違えば別の枝に積む', async () => {
    const bucket = new FakeR2Bucket()
    await callPost(eventWith(bucket, validInput()))
    const june = validInput({ ym: '2026-06', cache: { ...validInput().cache, ym: '2026-06' } })
    await callPost(eventWith(bucket, june))
    expect(bucket.store.has('profit/2026-06/margin-summary/latest.json')).toBe(true)
    expect(bucket.store.has(latestKey)).toBe(true)
  })
})
