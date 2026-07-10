import { describe, expect, it, vi } from 'vitest'

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn }
})

const { alcInternalProxyFetchMock } = vi.hoisted(() => ({ alcInternalProxyFetchMock: vi.fn() }))
vi.mock('../../server/utils/alc-internal-proxy', () => ({ alcInternalProxyFetch: alcInternalProxyFetchMock }))

import handler from '../../server/api/tariff/dtako-operations.get'

interface TestEvent {
  context: Record<string, unknown>
  path: string
  node: { req: { url: string, headers: Record<string, string | undefined> } }
}

function eventWith(
  env: Record<string, unknown>,
  query: Record<string, string> = {},
  headers: Record<string, string | undefined> = {},
): TestEvent {
  const url = `/api/tariff/dtako-operations?${new URLSearchParams(query)}`
  return {
    context: { cloudflare: { env } },
    path: url,
    node: { req: { url, headers } },
  }
}

const call = (event: TestEvent) => (handler as unknown as (e: TestEvent) => Promise<unknown>)(event)

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

describe('GET /api/tariff/dtako-operations', () => {
  it('INTERNAL_SHARED_SECRET 未設定は 503', async () => {
    await expect(call(eventWith({}, { tenant_id: 't1' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('cloudflare env 自体が無くても (?? {} フォールバック) 503 になる', async () => {
    const event = { context: {}, path: '/api/tariff/dtako-operations', node: { req: { url: '', headers: {} } } }
    await expect(call(event as unknown as TestEvent)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('INTERNAL_SHARED_SECRET が Secrets Store binding (.get()) でも解決する', async () => {
    const env = { INTERNAL_SHARED_SECRET: { get: async () => 'secret-x' } }
    alcInternalProxyFetchMock.mockResolvedValue(jsonResponse({ operations: [] }))
    const res = await call(
      eventWith(env, { tenant_id: 't1' }, { 'x-internal-shared-secret': 'secret-x' }),
    ) as { operations: unknown[] }
    expect(res.operations).toEqual([])
  })

  it('Secrets Store binding の .get() が null を返しても (?? null フォールバック) 503 になる', async () => {
    const env = { INTERNAL_SHARED_SECRET: { get: async () => null } }
    await expect(call(eventWith(env, { tenant_id: 't1' }))).rejects.toMatchObject({ statusCode: 503 })
  })

  it('X-Internal-Shared-Secret ヘッダ自体が無い (undefined) 場合も 401', async () => {
    const event = eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }, { tenant_id: 't1' })
    event.node.req.headers['x-internal-shared-secret'] = undefined
    await expect(call(event)).rejects.toMatchObject({ statusCode: 401 })
  })

  it('X-Internal-Shared-Secret 欠落・不一致・複数値ヘッダは 401', async () => {
    const env = { INTERNAL_SHARED_SECRET: 'secret-x' }
    await expect(
      call(eventWith(env, { tenant_id: 't1' })),
    ).rejects.toMatchObject({ statusCode: 401 })
    await expect(
      call(eventWith(env, { tenant_id: 't1' }, { 'x-internal-shared-secret': 'wrong' })),
    ).rejects.toMatchObject({ statusCode: 401 })
    // h3/node の raw header は稀に配列になりうる (multi-value)。先頭値を使う実装分岐を確認
    await expect(
      call(eventWith(env, { tenant_id: 't1' }, { 'x-internal-shared-secret': ['wrong'] as unknown as string })),
    ).rejects.toMatchObject({ statusCode: 401 })
    // 空配列 (provided[0] が undefined になる ?? '' フォールバック分岐) も 401
    await expect(
      call(eventWith(env, { tenant_id: 't1' }, { 'x-internal-shared-secret': [] as unknown as string })),
    ).rejects.toMatchObject({ statusCode: 401 })
  })

  it('tenant_id 欠落は 400', async () => {
    await expect(
      call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }, {}, { 'x-internal-shared-secret': 'secret-x' })),
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('正常: upstream レスポンスを薄い形に変換して返す', async () => {
    alcInternalProxyFetchMock.mockResolvedValue(
      jsonResponse({
        operations: [
          { unko_no: 'U1', vehicle_cd: '0272-01', operation_date: '2026-06-20', reading_date: '2026-06-20', total_distance: 123.4 },
          { unko_no: 'U2', vehicle_cd: null, operation_date: null, reading_date: '2026-06-19', total_distance: null },
        ],
      }),
    )
    const res = await call(
      eventWith(
        { INTERNAL_SHARED_SECRET: 'secret-x' },
        { tenant_id: 't1', from: '2026-06-01', to: '2026-06-30', vehicleCd: '0272-01' },
        { 'x-internal-shared-secret': 'secret-x' },
      ),
    ) as { operations: unknown[] }
    expect(res.operations).toEqual([
      { unkoNo: 'U1', vehicleCd: '0272-01', date: '2026-06-20', distanceKm: 123.4 },
      { unkoNo: 'U2', vehicleCd: null, date: '2026-06-19', distanceKm: null },
    ])
    expect(alcInternalProxyFetchMock).toHaveBeenCalledWith(expect.anything(), {
      path: '/api/internal/operations',
      tenantId: 't1',
      query: { date_from: '2026-06-01', date_to: '2026-06-30', vehicle_cd: '0272-01' },
    })
  })

  it('upstream 401/403 は 502 に変換 (詳細を漏らさない)', async () => {
    alcInternalProxyFetchMock.mockResolvedValue(jsonResponse({}, 401))
    await expect(
      call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }, { tenant_id: 't1' }, { 'x-internal-shared-secret': 'secret-x' })),
    ).rejects.toMatchObject({ statusCode: 502 })
  })

  it('upstream 500 はそのまま透過', async () => {
    alcInternalProxyFetchMock.mockResolvedValue(jsonResponse({}, 500))
    await expect(
      call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }, { tenant_id: 't1' }, { 'x-internal-shared-secret': 'secret-x' })),
    ).rejects.toMatchObject({ statusCode: 500 })
  })

  it('alcInternalProxyFetch の throw (503 等) はそのまま re-throw', async () => {
    const err = Object.assign(new Error('no secret'), { statusCode: 503 })
    alcInternalProxyFetchMock.mockRejectedValue(err)
    await expect(
      call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }, { tenant_id: 't1' }, { 'x-internal-shared-secret': 'secret-x' })),
    ).rejects.toMatchObject({ statusCode: 503 })
  })

  it('alcInternalProxyFetch の非 statusCode エラーは 502', async () => {
    alcInternalProxyFetchMock.mockRejectedValue(new Error('network down'))
    await expect(
      call(eventWith({ INTERNAL_SHARED_SECRET: 'secret-x' }, { tenant_id: 't1' }, { 'x-internal-shared-secret': 'secret-x' })),
    ).rejects.toMatchObject({ statusCode: 502 })
  })
})
