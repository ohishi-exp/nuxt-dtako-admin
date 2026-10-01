/**
 * `POST /api/y-time-rows` — Y時間 の行を JSON で返す口 (Refs #1133 c1133-47)。
 *
 * 固定するもの:
 *
 * 1. 行は Excel の route と同じ util (`fetchYTimeRows`) が作り、route は結果をそのまま snake_case で返す
 *    (勤怠の元に無い `driver` / `period` を補わない)
 * 2. 前置きは `authorizeScraperRelay` (secret → `requireAuth` → role)。`requireAuth` は 1 回
 * 3. relay へ渡す tenant は認証結果の値。body に `tenant_id` を入れても使われない
 * 4. util の失敗 (勤怠の経路の失敗・運行の経路の 404 の印) はそのまま出る
 *
 * 行を取る util と `authorizeScraperRelay` は本物を通し、肩代わりするのはその先の relay と上流だけ。
 * 値はすべて架空。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock, alcProxyFetchMock, sendToScraperRelayMock, readBodyMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  alcProxyFetchMock: vi.fn(),
  sendToScraperRelayMock: vi.fn(),
  readBodyMock: vi.fn(),
}))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('../../server/utils/alc-proxy', () => ({ alcProxyFetch: alcProxyFetchMock }))
vi.mock('../../server/utils/scraper-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/utils/scraper-relay')>()),
  sendToScraperRelay: sendToScraperRelayMock,
}))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, defineEventHandler: (fn: unknown) => fn, readBody: readBodyMock }
})

import handler from '../../server/api/y-time-rows.post'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<Record<string, unknown>>)(event)

const BODY = { driver_cd: '9001', from: '2025-01-01', to: '2025-01-31' }
const SHIFTS = [{ start: '2025-01-06 08:00:00', end: '2025-01-06 17:00:00', non_working: [], note: null }]
const ROWS = [{ date: '2025-01-06', start_minutes_of_day: 480 }, { date: '2025-01-07', start_minutes_of_day: 485 }]
const EXCLUDED = [{ start: '2025-01-08 08:00:00', end: '2025-01-08 17:00:00', reason: 'no_non_working' }]

const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })
/** relay の binding が在る環境 (中身は `sendToScraperRelay` を mock しているので呼ばれない) */
const relayEnv = () => ({ INTERNAL_SHARED_SECRET: 'secret', SCRAPER_RELAY: { fetch: vi.fn() } })
const upstreamPaths = () => alcProxyFetchMock.mock.calls.map(c => (c[1] as { path: string }).path)
const upstream = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: 'Status Text',
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})
const alcBody = { driver: { cd: '9001', name: '架空 太郎' }, period: { from: BODY.from, to: BODY.to }, rows: [{ date: '2025-01-10' }], warnings: ['alc-w'] }

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin', tenant_id: 'tenant-a' })
  sendToScraperRelayMock.mockReset()
  alcProxyFetchMock.mockReset()
  readBodyMock.mockReset()
  readBodyMock.mockResolvedValue({ ...BODY })
})

describe('POST /api/y-time-rows — 勤怠の元', () => {
  it('★ 応答の欄の全部: 元・行・警告・行を作れなかった勤務・記録の無い月。driver / period は補わない', async () => {
    sendToScraperRelayMock.mockResolvedValue({ tenant_id: 'tenant-a', shifts: SHIFTS, missing_months: ['2025-02'] })
    alcProxyFetchMock.mockResolvedValue(upstream(200, { rows: ROWS, warnings: ['w1'], excluded: EXCLUDED }))
    const res = await call(eventWith(relayEnv()))
    expect(res).toStrictEqual({
      source: 'kintai',
      source_reason: null,
      rows: ROWS,
      warnings: ['w1'],
      excluded: EXCLUDED,
      missing_months: ['2025-02'],
      driver: undefined,
      period: undefined,
    })
    // 上流の行をそのまま返す (並べ替えない・足さない)
    expect(res.rows).toBe(ROWS)
    // JSON にすると driver / period の欄は出ない
    expect(Object.keys(JSON.parse(JSON.stringify(res)))).toEqual(['source', 'source_reason', 'rows', 'warnings', 'excluded', 'missing_months'])
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-rows'])
  })

  it('★ relay へ渡す tenant は認証結果の値。body に tenant_id を入れても使われない。requireAuth は 1 回', async () => {
    readBodyMock.mockResolvedValue({ ...BODY, tenant_id: 'tenant-b' })
    sendToScraperRelayMock.mockResolvedValue({ tenant_id: 'tenant-a', shifts: SHIFTS, missing_months: [] })
    alcProxyFetchMock.mockResolvedValue(upstream(200, { rows: ROWS, warnings: [], excluded: [] }))
    await call(eventWith(relayEnv()))
    expect(sendToScraperRelayMock).toHaveBeenCalledWith(
      expect.anything(), { sharedSecret: 'secret' }, '/kintai-relay/y-time-shifts',
      { driver_cd: '9001', from: '2025-01-01', to: '2025-01-31', tenant_id: 'tenant-a' },
    )
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
  })

  it('★ relay の応答の tenant が認証結果と違えば 500 で、行を 1 行も返さない', async () => {
    sendToScraperRelayMock.mockResolvedValue({ tenant_id: 'tenant-b', shifts: SHIFTS, missing_months: [] })
    await expect(call(eventWith(relayEnv()))).rejects.toMatchObject({ statusCode: 500, data: { source: 'kintai', stage: 'auth' } })
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/y-time-rows — 運行の元へ倒した 2 通り', () => {
  it.each([
    ['勤怠の記録が無い会社', { statusCode: 403, data: { error: 'kintai_out_of_scope' } }, 'out_of_scope'],
    ['勤怠の設定が無い', { statusCode: 503, data: { error: 'kintai-relay not configured', reason: 'kintai_comp_id_unset' } }, 'not_configured'],
  ])('★ %s: 運行の GET の行を返し、倒した理由と driver / period が付く', async (_name, relayError, reason) => {
    sendToScraperRelayMock.mockRejectedValue(Object.assign(new Error('relay'), relayError))
    alcProxyFetchMock.mockResolvedValue(upstream(200, alcBody))
    const res = await call(eventWith(relayEnv()))
    expect(res).toStrictEqual({
      source: 'alc',
      source_reason: reason,
      rows: [{ date: '2025-01-10' }],
      warnings: ['alc-w'],
      excluded: [],
      missing_months: [],
      driver: { cd: '9001', name: '架空 太郎' },
      period: { from: '2025-01-01', to: '2025-01-31' },
    })
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-export'])
  })

  it('service binding が無い環境 (手元の dev) は relay を呼ばずに運行の元 (not_configured)', async () => {
    alcProxyFetchMock.mockResolvedValue(upstream(200, alcBody))
    const res = await call(eventWith({ INTERNAL_SHARED_SECRET: 'secret' }))
    expect(res).toMatchObject({ source: 'alc', source_reason: 'not_configured' })
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/y-time-rows — 失敗', () => {
  it.each([
    ['null', null],
    ['空の object', {}],
    ['driver_cd が空', { ...BODY, driver_cd: '' }],
    ['from が無い', { driver_cd: '9001', to: '2025-01-31' }],
    ['to が空', { ...BODY, to: '' }],
  ])('★ body の検証: %s は 400 で、relay も上流も呼ばない (認証の後)', async (_name, body) => {
    readBodyMock.mockResolvedValue(body)
    await expect(call(eventWith(relayEnv()))).rejects.toMatchObject({ statusCode: 400, statusMessage: 'driver_cd / from / to are required' })
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('★ 勤怠の経路の失敗は util の形のまま出る (倒さない・upstream: alc を付けない・画面の 1 文は message)', async () => {
    sendToScraperRelayMock.mockRejectedValue(Object.assign(new Error('relay'), { statusCode: 502, data: { error: 'gcp kintai shift-days 2025-01: failed' } }))
    const e = await call(eventWith(relayEnv())).catch((err: unknown) => err) as { statusCode: number, message: string, data: Record<string, unknown> }
    expect(e.statusCode).toBe(502)
    expect(e.data).toEqual({ source: 'kintai', stage: 'relay', status: 502, error: 'gcp kintai shift-days 2025-01: failed' })
    expect(e.message).toBe('勤怠の勤務の記録を読めませんでした (relay 502: gcp kintai shift-days 2025-01: failed)')
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('★ 運行の経路の 404 (乗務員CD が alc に未登録) には data.upstream = alc が付いたまま出る', async () => {
    sendToScraperRelayMock.mockRejectedValue(Object.assign(new Error('relay'), { statusCode: 403, data: { error: 'kintai_out_of_scope' } }))
    alcProxyFetchMock.mockResolvedValue(upstream(404, 'driver_cd not found: 9001'))
    await expect(call(eventWith(relayEnv()))).rejects.toMatchObject({ statusCode: 404, data: { upstream: 'alc' } })
  })

  it('認証結果に tenant が無ければ 500 (relay も上流も呼ばない)', async () => {
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin' })
    await expect(call(eventWith(relayEnv()))).rejects.toMatchObject({ statusCode: 500, data: { source: 'kintai', stage: 'auth' } })
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })
})

describe('POST /api/y-time-rows — 前置き (`authorizeScraperRelay`)', () => {
  it('★ 未ログインは 401 で、body も読まず relay も上流も叩かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    await expect(call(eventWith(relayEnv()))).rejects.toMatchObject({ statusCode: 401 })
    expect(readBodyMock).not.toHaveBeenCalled()
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('★ role が admin / payroll でなければ 403 で、body も読まない', async () => {
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'viewer', tenant_id: 'tenant-a' })
    await expect(call(eventWith(relayEnv()))).rejects.toMatchObject({ statusCode: 403 })
    expect(readBodyMock).not.toHaveBeenCalled()
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ SCRAPER_RELAY: { fetch: vi.fn() } }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: 'INTERNAL_SHARED_SECRET binding が未設定です',
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })
})
