/**
 * `GET /api/vehicle-settings/history` の**認可** (Refs #988)。
 *
 * この口は `docs/plan-922-single-signin.md` §1 の D 段 (Nitro 側の認可が 1 つも無く、
 * **Cloudflare Access だけが前段**) に居た。Access は edge の設定で、この repo が
 * 意図して置いた防御ではない。A 段の `requireAuth` を `y-time-template.put.ts` と
 * 同じ形で足したので、
 *
 * - **陰性対照**: 未ログインは 401 で、**R2 を 1 度も list しない**
 *   (`requireAuth` の行を消すとこの it が落ちる)
 * - **陽性対照**: 認証が通れば**従来どおり**一覧も集計も返る
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    getQuery: (event: { _query?: Record<string, unknown> }) => event._query ?? {},
  }
})

import handler from '../../server/api/vehicle-settings/history.get'
import type { HistoryItem, VehicleSummary } from '../../server/api/vehicle-settings/history.get'

const call = (event: unknown) =>
  (handler as unknown as (e: unknown) => Promise<HistoryItem[] | VehicleSummary[]>)(event)

interface FakeObject {
  key: string
  size: number
  uploaded: Date | string
  customMetadata?: Record<string, string>
}

/** cursor を返す list を作る (1 回 2 件で切って truncated を通す)。 */
class FakeR2 {
  list = vi.fn(async (opts: { prefix?: string, cursor?: string, limit?: number }) => {
    const all = this.objects.filter(o => !opts.prefix || o.key.startsWith(opts.prefix))
    const start = opts.cursor ? Number(opts.cursor) : 0
    const page = all.slice(start, start + this.pageSize)
    const next = start + this.pageSize
    return {
      objects: page,
      truncated: next < all.length,
      cursor: next < all.length ? String(next) : undefined,
    }
  })

  constructor(public objects: FakeObject[], public pageSize = 1000) {}
}

const OBJECTS: FakeObject[] = [
  {
    key: 'vehicle-settings/4437/20260514_093253-0-0-4437.json',
    size: 120,
    uploaded: new Date('2026-05-14T09:32:53Z'),
    customMetadata: { machine_id: 'M1', firm_main_app: 'v1.2' },
  },
  {
    key: 'vehicle-settings/4437/20260601_101010-0-0-4437.json',
    size: 130,
    uploaded: '2026-06-01T10:10:10.000Z',
    customMetadata: { uploaded_at: '2026-06-01T10:10:10.000Z' },
  },
  // `uploaded` が **文字列**で来て customMetadata が無い行 (toIso の文字列側)。
  // 06-01 より**古い**ので、集計側で「latest を更新しない」枝も同時に通る。
  { key: 'vehicle-settings/4437/20260401_070000-0-0-4437.json', size: 110, uploaded: '2026-04-01T07:00:00.000Z' },
  // .cfg 原本は一覧に出さない (ext !== 'json')
  { key: 'vehicle-settings/4437/20260601_101010-0-0-4437.cfg', size: 900, uploaded: new Date('2026-06-01T10:10:10Z') },
  // prefix 配下だが key の形が違う = parse できない → 無視
  { key: 'vehicle-settings/broken.json', size: 1, uploaded: new Date('2026-06-02T00:00:00Z') },
  {
    key: 'vehicle-settings/1201/20260701_080000-0-0-1201.json',
    size: 140,
    uploaded: new Date('2026-07-01T08:00:00Z'),
  },
]

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })

function eventWith(env: Record<string, unknown>, query: Record<string, unknown> = {}) {
  return { context: { cloudflare: { env } }, _query: query }
}

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com' })
})

describe('GET /api/vehicle-settings/history — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、R2 を 1 度も list しない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = new FakeR2(OBJECTS)
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2 })))).rejects.toMatchObject({ statusCode: 401 })
    expect(r2.list).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ DTAKO_R2: new FakeR2(OBJECTS) }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {}, _query: {} })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_R2: new FakeR2([]) }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: new FakeR2([]) })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: new FakeR2([]) })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2([]), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2([]), NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: new FakeR2([]), NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('GET /api/vehicle-settings/history — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('DTAKO_R2 未設定なら 503 (ログイン後。secret の 503 と文言で分ける)', async () => {
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
    expect(requireAuthMock).toHaveBeenCalled()
  })

  it('★ vehicle_cd 指定: json だけを新しい順で返す', async () => {
    const res = (await call(eventWith(okEnv({ DTAKO_R2: new FakeR2(OBJECTS) }), { vehicle_cd: '4437' }))) as HistoryItem[]
    expect(res.map(r => r.dump_dir)).toEqual([
      '20260601_101010-0-0-4437',
      '20260514_093253-0-0-4437',
      '20260401_070000-0-0-4437',
    ])
    // uploaded が文字列で来た行はそのまま (Date に往復させない)
    expect(res[2]).toMatchObject({ uploaded_at: '2026-04-01T07:00:00.000Z' })
    // customMetadata.uploaded_at が無い側は R2 の uploaded (Date) を ISO 化する
    expect(res[1]).toMatchObject({
      vehicle_cd: '4437',
      uploaded_at: '2026-05-14T09:32:53.000Z',
      size: 120,
      machine_id: 'M1',
      firm_main_app: 'v1.2',
    })
    // metadata が無ければ null で埋める (「読まなかった」を空文字で誤魔化さない)
    expect(res[0]).toMatchObject({ machine_id: null, firm_main_app: null })
  })

  it('vehicle_cd が英数 / _ / - 以外なら 400 (認証の後)', async () => {
    const r2 = new FakeR2(OBJECTS)
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2 }), { vehicle_cd: '../etc' })))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(r2.list).not.toHaveBeenCalled()
  })

  it('vehicle_cd が空文字 / 文字列でないときは全車輛集計に落ちる', async () => {
    const empty = (await call(eventWith(okEnv({ DTAKO_R2: new FakeR2(OBJECTS) }), { vehicle_cd: '' }))) as VehicleSummary[]
    expect(empty.map(r => r.vehicle_cd)).toEqual(['1201', '4437'])
    const notString = (await call(eventWith(okEnv({ DTAKO_R2: new FakeR2(OBJECTS) }), { vehicle_cd: 7 }))) as VehicleSummary[]
    expect(notString.map(r => r.vehicle_cd)).toEqual(['1201', '4437'])
  })

  it('★ 引数なし: vehicle_cd 別に件数と最新を集計する', async () => {
    const res = (await call(eventWith(okEnv({ DTAKO_R2: new FakeR2(OBJECTS) })))) as VehicleSummary[]
    expect(res).toEqual([
      { vehicle_cd: '1201', count: 1, latest_uploaded_at: '2026-07-01T08:00:00.000Z' },
      // 04-01 は 06-01 より古いので latest は動かない
      { vehicle_cd: '4437', count: 3, latest_uploaded_at: '2026-06-01T10:10:10.000Z' },
    ])
  })

  it('R2 の cursor を辿って 1000 件超も全部拾う', async () => {
    const r2 = new FakeR2(OBJECTS, 2)
    const res = (await call(eventWith(okEnv({ DTAKO_R2: r2 })))) as VehicleSummary[]
    expect(r2.list.mock.calls.length).toBeGreaterThan(1)
    expect(res.find(r => r.vehicle_cd === '4437')!.count).toBe(3)
  })
})
