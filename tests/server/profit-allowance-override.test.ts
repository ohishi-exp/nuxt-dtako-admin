import { beforeEach, describe, expect, it, vi } from 'vitest'

// h3 の defineEventHandler は identity に差し替える (他の server route テストと同じ)。
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    readBody: async (event: { body?: unknown, bodyThrows?: boolean }) => {
      if (event.bodyThrows) throw new Error('invalid json')
      return event.body
    },
  }
})

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import handler from '../../server/api/profit/allowance-override.post'
import type { R2BucketLite, R2ObjectLite } from '../../server/utils/profit-r2-io'
import {
  UNKNOWN_OVERRIDE_BY,
  type AllowanceOverrideSaveResult,
  type ProvisionalOverrideSnapshot,
} from '../../app/utils/allowance-overrides-r2'

/** 本番に実在する唯一の暫定手当 (「広尾→芽室 マスタ待ち」の実体)。 */
const HIROO_MEMURO = '広尾|芽室'

const LATEST = 'profit/allowance-overrides/provisional/latest.json'
const HISTORY = 'profit/allowance-overrides/provisional/history.jsonl'

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

interface TestEvent {
  context: Record<string, unknown>
  body?: unknown
  bodyThrows?: boolean
}

function validBody(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, kind: 'provisional', key: HIROO_MEMURO, value: 9000, ...overrides }
}

function eventWith(env: Record<string, unknown>, body: unknown = validBody(), bodyThrows = false): TestEvent {
  return { context: { cloudflare: { env } }, body, bodyThrows }
}

const call = (event: TestEvent) => (handler as unknown as (e: TestEvent) => Promise<AllowanceOverrideSaveResult>)(event)

function okEnv(bucket: R2BucketLite, extra: Record<string, unknown> = {}) {
  return { INTERNAL_SHARED_SECRET: 'secret', PROFIT_R2: bucket, ...extra }
}

/** 投げられた H3Error の status とメッセージ本文。 */
async function rejection(p: Promise<unknown>): Promise<{ statusCode: number, text: string }> {
  try {
    await p
  }
  catch (e) {
    const err = e as { statusCode?: number, statusMessage?: string, message?: string }
    return { statusCode: err.statusCode ?? 0, text: `${err.statusMessage ?? ''} ${err.message ?? ''}` }
  }
  throw new Error('例外が投げられませんでした')
}

const latestOf = (bucket: FakeR2Bucket): ProvisionalOverrideSnapshot =>
  JSON.parse(bucket.store.get(LATEST)!.body) as ProvisionalOverrideSnapshot

const versionKeys = (bucket: FakeR2Bucket) =>
  [...bucket.store.keys()].filter(k => k.startsWith('profit/allowance-overrides/provisional/v-'))

const historyLines = (bucket: FakeR2Bucket) =>
  (bucket.store.get(HISTORY)?.body ?? '').split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l))

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
})

describe('POST /api/profit/allowance-override — binding と認証', () => {
  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    const got = await rejection(call(eventWith({ PROFIT_R2: new FakeR2Bucket() })))
    expect(got.statusCode).toBe(503)
    expect(got.text).toContain('INTERNAL_SHARED_SECRET')
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    expect((await rejection(call({ context: {}, body: validBody() }))).statusCode).toBe(503)
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    const bucket = new FakeR2Bucket()
    const env = { INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, PROFIT_R2: bucket }
    await call(eventWith(env))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding は 503', async () => {
    const env = { INTERNAL_SHARED_SECRET: { get: async () => undefined }, PROFIT_R2: new FakeR2Bucket() }
    expect((await rejection(call(eventWith(env)))).statusCode).toBe(503)
  })

  it('文字列でも .get() でもない binding は 503 (`[vars]` に数値を書いた等の設定誤り)', async () => {
    const env = { INTERNAL_SHARED_SECRET: 123, PROFIT_R2: new FakeR2Bucket() }
    expect((await rejection(call(eventWith(env)))).statusCode).toBe(503)
  })

  it('★ 未ログインは 401 (requireAuth の例外をそのまま出す)', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const bucket = new FakeR2Bucket()
    expect((await rejection(call(eventWith(okEnv(bucket))))).statusCode).toBe(401)
    // **R2 には 1 バイトも書かない。**
    expect(bucket.store.size).toBe(0)
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    const bucket = new FakeR2Bucket()
    await call(eventWith(okEnv(bucket, { NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv(new FakeR2Bucket(), { NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv(new FakeR2Bucket(), { NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })

  it('PROFIT_R2 未設定なら 503 (ログイン後)', async () => {
    const got = await rejection(call(eventWith({ INTERNAL_SHARED_SECRET: 'secret' })))
    expect(got.statusCode).toBe(503)
    expect(got.text).toContain('PROFIT_R2')
  })
})

describe('POST /api/profit/allowance-override — body の検査', () => {
  it('JSON として読めない body は 400', async () => {
    const got = await rejection(call(eventWith(okEnv(new FakeR2Bucket()), undefined, true)))
    expect(got.statusCode).toBe(400)
  })

  it('★ kind は provisional だけ (excluded / force-match は後続 PR)', async () => {
    const got = await rejection(call(eventWith(okEnv(new FakeR2Bucket()), validBody({ kind: 'excluded' }))))
    expect(got.statusCode).toBe(400)
    expect(got.text).toContain('provisional')
  })

  it('value が 1 以上の整数でも null でもなければ 400', async () => {
    const got = await rejection(call(eventWith(okEnv(new FakeR2Bucket()), validBody({ value: 0 }))))
    expect(got.statusCode).toBe(400)
    expect(got.text).toContain('value')
  })

  it('★ 全体マップを送る口は無い (map を送っても 400)', async () => {
    const bucket = new FakeR2Bucket()
    const got = await rejection(call(eventWith(okEnv(bucket), { schemaVersion: 1, kind: 'provisional', map: { [HIROO_MEMURO]: 9000 } })))
    expect(got.statusCode).toBe(400)
    expect(bucket.store.size).toBe(0)
  })
})

describe('POST /api/profit/allowance-override — 1 件を畳み込む', () => {
  it('latest が無いところに 1 件目。版と履歴が 1 本ずつ増える', async () => {
    const bucket = new FakeR2Bucket()
    const res = await call(eventWith(okEnv(bucket)))

    expect(res).toMatchObject({ saved: true, changed: true, by: 'me@example.com', key: HIROO_MEMURO, value: 9000, entries: 1 })
    expect(res.versionKey).toMatch(/^profit\/allowance-overrides\/provisional\/v-\d{8}T\d{6}\.json$/)

    const latest = latestOf(bucket)
    expect(latest.schemaVersion).toBe(1)
    expect(latest.kind).toBe('provisional')
    expect(latest.entries[HIROO_MEMURO]).toEqual({ value: 9000, by: 'me@example.com', at: res.savedAt })

    expect(versionKeys(bucket)).toHaveLength(1)
    expect(historyLines(bucket)).toEqual([{
      ts: res.savedAt,
      changed: true,
      kind: 'provisional',
      key: HIROO_MEMURO,
      by: 'me@example.com',
      before: null,
      after: 9000,
      entries: 1,
    }])
  })

  it('★ 他の端末が入れた鍵を消さない — 2 台目が押しても相手の確定が残る', async () => {
    const bucket = new FakeR2Bucket()
    // 1 台目 (別の人) が入れた 2 件。
    await call(eventWith(okEnv(bucket), validBody({ key: 'a|b', value: 1000 })))
    requireAuthMock.mockResolvedValue({ active: true, email: 'you@example.com' })
    await call(eventWith(okEnv(bucket), validBody({ key: 'c|d', value: 2000 })))
    // 2 台目 (自分) が 3 件目を入れる。
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
    const res = await call(eventWith(okEnv(bucket)))

    const latest = latestOf(bucket)
    expect(Object.keys(latest.entries).sort()).toEqual(['a|b', 'c|d', HIROO_MEMURO].sort())
    expect(latest.entries['a|b']!.value).toBe(1000)
    expect(latest.entries['c|d']).toMatchObject({ value: 2000, by: 'you@example.com' })
    expect(res.entries).toBe(3)
  })

  it('★ 消す操作は鍵を消さず tombstone を書く (他端末の push で復活しない)', async () => {
    const bucket = new FakeR2Bucket()
    await call(eventWith(okEnv(bucket)))
    const res = await call(eventWith(okEnv(bucket), validBody({ value: null })))

    const latest = latestOf(bucket)
    expect(HIROO_MEMURO in latest.entries).toBe(true)
    expect(latest.entries[HIROO_MEMURO]!.value).toBeNull()
    expect(res.entries).toBe(0)
    expect(res.value).toBeNull()
    expect(historyLines(bucket)[1]).toMatchObject({ before: 9000, after: null, entries: 0 })
  })

  it('★ 同じ値の送り直しでは版を増やさない。履歴は 1 行増える', async () => {
    const bucket = new FakeR2Bucket()
    await call(eventWith(okEnv(bucket)))
    expect(versionKeys(bucket)).toHaveLength(1)

    const res = await call(eventWith(okEnv(bucket)))
    expect(res.changed).toBe(false)
    expect(versionKeys(bucket)).toHaveLength(1)
    expect(historyLines(bucket)).toHaveLength(2)
    expect(historyLines(bucket)[1]).toMatchObject({ changed: false, before: 9000, after: 9000 })
    // 版が増えなかった回も、いま latest が指している版のキーを返す。
    expect(res.versionKey).toBe(versionKeys(bucket)[0])
  })

  it('値が動けば版が増える', async () => {
    const bucket = new FakeR2Bucket()
    await call(eventWith(okEnv(bucket)))
    const res = await call(eventWith(okEnv(bucket), validBody({ value: 8000 })))
    expect(res.changed).toBe(true)
    expect(versionKeys(bucket).length).toBeGreaterThanOrEqual(1)
    expect(latestOf(bucket).entries[HIROO_MEMURO]!.value).toBe(8000)
  })

  it('★ 応答の value は「保存された後の値」— 送った値のエコーではない', async () => {
    const bucket = new FakeR2Bucket()
    // 先に別の値を入れておき、上書きの回に **latest の中身** が返ることを見る。
    await call(eventWith(okEnv(bucket), validBody({ value: 8000 })))
    const res = await call(eventWith(okEnv(bucket), validBody({ value: 9000 })))
    expect(res.value).toBe(9000)
    expect(res.value).toBe(latestOf(bucket).entries[HIROO_MEMURO]!.value)
    // 別の鍵を触った回は、その鍵の値が返る (取り違えていたら気づける)。
    const other = await call(eventWith(okEnv(bucket), validBody({ key: '釧路|帯広', value: 12000 })))
    expect(other).toMatchObject({ key: '釧路|帯広', value: 12000 })
    expect(latestOf(bucket).entries[HIROO_MEMURO]!.value).toBe(9000)
  })

  it('★ 壊れた latest.json は空として扱い、投げない (画面を止めない)', async () => {
    const bucket = new FakeR2Bucket()
    await bucket.put(LATEST, '{壊れて')
    const res = await call(eventWith(okEnv(bucket)))
    expect(res.entries).toBe(1)
    expect(Object.keys(latestOf(bucket).entries)).toEqual([HIROO_MEMURO])
  })

  it('email が取れなくても書ける。by は空文字に倒さない', async () => {
    requireAuthMock.mockResolvedValue({ active: true })
    const bucket = new FakeR2Bucket()
    const res = await call(eventWith(okEnv(bucket)))
    expect(res.by).toBe(UNKNOWN_OVERRIDE_BY)
    expect(historyLines(bucket)[0]).toMatchObject({ by: UNKNOWN_OVERRIDE_BY })
  })

  it('★ 移行 (この端末のぶんを 1 件ずつ送る) を通すと、R2 に全部載る', async () => {
    const bucket = new FakeR2Bucket()
    const local = { [HIROO_MEMURO]: 9000, '釧路|帯広': 12000 }
    for (const [key, value] of Object.entries(local)) {
      await call(eventWith(okEnv(bucket), validBody({ key, value })))
    }
    const latest = latestOf(bucket)
    expect(latest.entries[HIROO_MEMURO]!.value).toBe(9000)
    expect(latest.entries['釧路|帯広']!.value).toBe(12000)
    expect(historyLines(bucket)).toHaveLength(2)
  })
})
