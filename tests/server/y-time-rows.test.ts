/**
 * Y時間 の行を取ってくる util (`server/utils/y-time-rows.ts`、Refs #1133 c1133-46)。
 *
 * 固定するもの:
 *
 * 1. 勤怠の元: relay が返した `shifts` を**そのまま**上流へ渡し、上流の `rows` を**そのまま**返す
 * 2. 1 社固定の認可: relay へ渡す tenant は認証結果の値。**relay の応答の tenant が違えば 500 で上流を呼ばない**。
 *    認証結果に tenant が無ければ relay も呼ばない
 * 3. 運行の経路へ倒すのは 3 つの形だけ。それ以外の失敗は投げて、運行の GET を呼ばない
 * 4. 勤怠の経路の失敗に `upstream: 'alc'` を付けない (404 を「乗務員CD が alc に未登録」と読ませない)
 * 5. どの呼び出しも勤怠の元を試す (試さない呼び方は無い。Refs #1133 c1133-47)
 * 6. route の body の検証 (`yTimeRowsInputFromBody`) — 2 つの route が共用する
 *
 * 値はすべて架空。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const { sendToScraperRelayMock, alcProxyFetchMock } = vi.hoisted(() => ({
  sendToScraperRelayMock: vi.fn(),
  alcProxyFetchMock: vi.fn(),
}))
vi.mock('../../server/utils/scraper-relay', () => ({ sendToScraperRelay: sendToScraperRelayMock }))
vi.mock('../../server/utils/alc-proxy', () => ({ alcProxyFetch: alcProxyFetchMock }))

import { fetchYTimeRows, yTimeRowsInputFromBody, yTimeSourceHeaders, Y_TIME_EXCLUDED_HEADER_LIMIT, type YTimeRowsResult } from '../../server/utils/y-time-rows'

const INPUT = { driverCd: '9001', from: '2025-01-01', to: '2025-12-31' }
const KINTAI = { tenantId: 'tenant-a', sharedSecret: 'secret-x' }

const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } }) as unknown as H3Event
/** binding が在る環境 (中身は `sendToScraperRelay` を mock しているので呼ばれない) */
const withRelay = () => eventWith({ SCRAPER_RELAY: { fetch: vi.fn() } })

/** relay の勤務。中身は util が読まないことを確かめるため、util の知らない欄も持たせる */
const SHIFTS = [
  { start: '2024-12-31 22:00:00', end: '2025-01-01 07:00:00', non_working: [{ start: '2025-01-01 02:00:00', end: '2025-01-01 03:00:00', kind: 'rest', extra: 1 }], note: null },
  { start: '2025-01-02 08:00:00', end: '2025-01-02 17:00:00', non_working: null, note: null },
]
const ROWS = [{ date: '2025-01-01', start_minutes_of_day: 1320, end_minutes_from_bucket_date: 2760, opaque: 'x' }]

const relayOk = (over: Record<string, unknown> = {}) => ({ tenant_id: 'tenant-a', shifts: SHIFTS, missing_months: ['2025-02'], ...over })
const relayError = (statusCode: number, data?: unknown) => Object.assign(new Error('relay'), { statusCode, data })

function upstream(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Status Text',
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as Response
}
const rowsOk = (over: Record<string, unknown> = {}) => upstream(200, { rows: ROWS, warnings: ['w1'], excluded: [{ start: '2025-01-02 08:00:00', end: '2025-01-02 17:00:00', reason: 'no_non_working' }], ...over })
const alcOk = () => upstream(200, { driver: { cd: '9001', name: '架空 太郎' }, period: { from: INPUT.from, to: INPUT.to }, rows: [{ date: '2025-03-01' }], warnings: ['alc-w'] })

/** 上流の呼び出しを path で振り分ける */
function routeUpstream(handlers: { rows?: () => Response, alc?: () => Response }) {
  alcProxyFetchMock.mockImplementation(async (_e: unknown, opts: { path: string }) => {
    if (opts.path === '/api/dtako/y-time-rows' && handlers.rows) return handlers.rows()
    if (opts.path === '/api/dtako/y-time-export' && handlers.alc) return handlers.alc()
    throw new Error(`unexpected upstream ${opts.path}`)
  })
}
const upstreamPaths = () => alcProxyFetchMock.mock.calls.map(c => (c[1] as { path: string }).path)

async function rejection(p: Promise<unknown>) {
  const e = await p.then(() => { throw new Error('例外が投げられませんでした') }, (err: unknown) => err)
  return e as { statusCode: number, statusMessage: string, message: string, data: Record<string, unknown> }
}

beforeEach(() => {
  sendToScraperRelayMock.mockReset()
  alcProxyFetchMock.mockReset()
})

describe('fetchYTimeRows — 勤怠の元', () => {
  it('★ relay へは認証結果の tenant を渡し、relay の shifts をそのまま上流へ渡し、上流の rows をそのまま返す', async () => {
    sendToScraperRelayMock.mockResolvedValue(relayOk())
    routeUpstream({ rows: () => rowsOk() })
    const event = withRelay()
    const res = await fetchYTimeRows(event, INPUT, KINTAI)

    expect(sendToScraperRelayMock).toHaveBeenCalledTimes(1)
    expect(sendToScraperRelayMock).toHaveBeenCalledWith(event, { sharedSecret: 'secret-x' }, '/kintai-relay/y-time-shifts', {
      driver_cd: '9001', from: '2025-01-01', to: '2025-12-31', tenant_id: 'tenant-a',
    })
    expect(alcProxyFetchMock).toHaveBeenCalledTimes(1)
    const opts = alcProxyFetchMock.mock.calls[0]![1] as { path: string, method: string, body: string, contentType: string }
    expect(opts).toMatchObject({ path: '/api/dtako/y-time-rows', method: 'POST', contentType: 'application/json' })
    // 並べ替えない・欄を落とさない・足さない
    expect(JSON.parse(opts.body)).toEqual({ from: '2025-01-01', to: '2025-12-31', shifts: SHIFTS })

    expect(res).toEqual({
      source: 'kintai',
      sourceReason: null,
      rows: ROWS,
      warnings: ['w1'],
      excluded: [{ start: '2025-01-02 08:00:00', end: '2025-01-02 17:00:00', reason: 'no_non_working' }],
      missingMonths: ['2025-02'],
    })
    expect(res.rows).toBe(ROWS)
  })

  it('★ relay の応答の tenant が認証結果と違えば 500 で、上流を呼ばない (勤務を先へ渡さない)', async () => {
    sendToScraperRelayMock.mockResolvedValue(relayOk({ tenant_id: 'tenant-b' }))
    routeUpstream({ rows: () => rowsOk(), alc: () => alcOk() })
    const e = await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))
    expect(e.statusCode).toBe(500)
    expect(e.data).toEqual({ source: 'kintai', stage: 'auth' })
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('★ 認証結果に tenant が無ければ 500 で、relay も上流も呼ばない (運行の経路にも倒さない)', async () => {
    routeUpstream({ rows: () => rowsOk(), alc: () => alcOk() })
    for (const tenantId of [undefined, '']) {
      const e = await rejection(fetchYTimeRows(withRelay(), INPUT, { ...KINTAI, tenantId }))
      expect(e.statusCode).toBe(500)
      expect(e.data).toEqual({ source: 'kintai', stage: 'auth' })
    }
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('relay の応答の形が合わなければ 502 で投げる (空の勤務として先へ進めない)', async () => {
    routeUpstream({ rows: () => rowsOk(), alc: () => alcOk() })
    for (const bad of [
      null,
      [],
      relayOk({ tenant_id: 7 }),
      relayOk({ shifts: {} }),
      relayOk({ shifts: undefined }),
      relayOk({ missing_months: 'x' }),
      relayOk({ missing_months: [1] }),
      relayOk({ missing_months: ['2025/02'] }),
    ]) {
      sendToScraperRelayMock.mockResolvedValue(bad)
      const e = await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))
      expect(e.statusCode).toBe(502)
      expect(e.data).toEqual({ source: 'kintai', stage: 'relay' })
    }
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('上流の応答の形が合わなければ 502 で投げる', async () => {
    sendToScraperRelayMock.mockResolvedValue(relayOk())
    for (const bad of [
      null,
      { rows: 'x', warnings: [], excluded: [] },
      { rows: [], warnings: [1], excluded: [] },
      { rows: [], warnings: [], excluded: 'x' },
      { rows: [], warnings: [], excluded: [{ start: 's', end: 'e' }] },
      { rows: [], warnings: [], excluded: [null] },
    ]) {
      routeUpstream({ rows: () => upstream(200, bad) })
      const e = await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))
      expect(e.statusCode).toBe(502)
      expect(e.data).toEqual({ source: 'kintai', stage: 'upstream' })
    }
    // 2xx なのに JSON でない応答
    routeUpstream({ rows: () => ({ ok: true, status: 200, json: async () => { throw new Error('not json') } }) as unknown as Response })
    expect((await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))).statusCode).toBe(502)
  })
})

describe('fetchYTimeRows — 運行の経路へ倒す 3 つの形', () => {
  it('★ service binding が無い → relay を呼ばずに運行の GET (not_configured)', async () => {
    routeUpstream({ alc: () => alcOk() })
    const res = await fetchYTimeRows(eventWith({}), INPUT, KINTAI)
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).toHaveBeenCalledWith(expect.anything(), {
      path: '/api/dtako/y-time-export',
      query: { driver_cd: '9001', from: '2025-01-01', to: '2025-12-31' },
    })
    // 運行の元は乗務員と期間も落とさずに返す
    expect(res).toEqual({
      source: 'alc',
      sourceReason: 'not_configured',
      rows: [{ date: '2025-03-01' }],
      warnings: ['alc-w'],
      excluded: [],
      missingMonths: [],
      driver: { cd: '9001', name: '架空 太郎' },
      period: { from: '2025-01-01', to: '2025-12-31' },
    })
  })

  it('★ relay が 403 + error=kintai_out_of_scope → 運行の GET (out_of_scope)', async () => {
    sendToScraperRelayMock.mockRejectedValue(relayError(403, { error: 'kintai_out_of_scope' }))
    routeUpstream({ alc: () => alcOk() })
    const res = await fetchYTimeRows(withRelay(), INPUT, KINTAI)
    expect(res).toMatchObject({ source: 'alc', sourceReason: 'out_of_scope' })
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-export'])
  })

  it('★ relay が 503 + reason=kintai_comp_id_unset → 運行の GET (not_configured)', async () => {
    sendToScraperRelayMock.mockRejectedValue(relayError(503, { error: 'kintai-relay not configured', reason: 'kintai_comp_id_unset' }))
    routeUpstream({ alc: () => alcOk() })
    const res = await fetchYTimeRows(withRelay(), INPUT, KINTAI)
    expect(res).toMatchObject({ source: 'alc', sourceReason: 'not_configured' })
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-export'])
  })

  it('倒した先の運行の GET の失敗は、今までと同じ形 (status そのまま・upstream: alc) で投げる', async () => {
    routeUpstream({ alc: () => upstream(404, 'driver_cd not found: 9001') })
    const e = await rejection(fetchYTimeRows(eventWith({}), INPUT, KINTAI))
    expect(e.statusCode).toBe(404)
    expect(e.statusMessage).toBe('backend error: driver_cd not found: 9001')
    expect(e.data).toEqual({ upstream: 'alc' })
  })
})

describe('fetchYTimeRows — 倒さない失敗 (黙って運行の元にすり替えない)', () => {
  const RELAY_FAILURES: [string, number, unknown, number][] = [
    ['502 (1 つの月が読めない)', 502, { error: 'gcp kintai shift-days 2025-03: failed' }, 502],
    ['401 (secret が合わない)', 401, { error: 'Unauthorized' }, 502],
    ['404', 404, null, 502],
    ['400 (検証)', 400, { error: 'period too long' }, 502],
    ['reason の無い 503', 503, { error: 'kintai-relay not configured' }, 503],
    ['tenant not resolved の 503', 503, { error: 'tenant not resolved from dtako_accounts' }, 503],
    ['error が別の 403', 403, { error: 'forbidden' }, 502],
    ['reason が別の 503', 503, { error: 'kintai-relay not configured', reason: 'other' }, 503],
    // 403 に kintai_comp_id_unset・503 に kintai_out_of_scope が付いていても倒さない (status と欄の組で見る)
    ['403 + reason=kintai_comp_id_unset', 403, { reason: 'kintai_comp_id_unset' }, 502],
    ['503 + error=kintai_out_of_scope', 503, { error: 'kintai_out_of_scope' }, 503],
  ]
  it.each(RELAY_FAILURES)('★ relay の %s は投げて、運行の GET も上流も呼ばない', async (_name, status, body, expected) => {
    sendToScraperRelayMock.mockRejectedValue(relayError(status, body))
    routeUpstream({ rows: () => rowsOk(), alc: () => alcOk() })
    const e = await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))
    expect(e.statusCode).toBe(expected)
    expect(e.data).toMatchObject({ source: 'kintai', stage: 'relay', status })
    expect(e.data).not.toHaveProperty('upstream')
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('relay の本文で運ぶのは error と reason の 2 欄だけ。画面の 1 文は message、statusMessage は ASCII', async () => {
    sendToScraperRelayMock.mockRejectedValue(relayError(502, { error: 'gcp kintai shift-days 2025-03: 読めない', reason: 'r', secret_like: 'x' }))
    const e = await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))
    expect(e.data).toEqual({ source: 'kintai', stage: 'relay', status: 502, error: 'gcp kintai shift-days 2025-03: 読めない', reason: 'r' })
    expect(e.message).toBe('勤怠の勤務の記録を読めませんでした (relay 502: gcp kintai shift-days 2025-03: 読めない)')
    // eslint-disable-next-line no-control-regex
    expect(e.statusMessage).toMatch(/^[\x20-\x7e]+$/)
  })

  it('relay へ届かなかった失敗 (status を持たない例外) も 502 で投げる', async () => {
    for (const thrown of [new Error('network'), 'boom']) {
      sendToScraperRelayMock.mockRejectedValue(thrown)
      const e = await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))
      expect(e.statusCode).toBe(502)
      expect(e.message).toBe('勤怠の勤務の記録を読めませんでした (relay 応答なし)')
    }
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it.each([
    [400, 502], [404, 502], [500, 500], [401, 401], [403, 403],
  ])('★ 上流の新しい口の %i は投げて (利用者へは %i)、運行の GET を呼ばない。upstream: alc は付かない', async (status, expected) => {
    sendToScraperRelayMock.mockResolvedValue(relayOk())
    routeUpstream({ rows: () => upstream(status, 'same shift twice'), alc: () => alcOk() })
    const e = await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))
    expect(e.statusCode).toBe(expected)
    expect(e.data).toEqual({ source: 'kintai', stage: 'upstream', status, error: 'same shift twice' })
    expect(e.message).toBe(`勤務の記録から Y時間 の行を作れませんでした (上流 ${status}: same shift twice)`)
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-rows'])
  })

  it('上流の本文が空・読めないときは statusText を理由にする', async () => {
    sendToScraperRelayMock.mockResolvedValue(relayOk())
    routeUpstream({ rows: () => upstream(500, '') })
    expect((await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))).data.error).toBe('Status Text')
    routeUpstream({ rows: () => ({ ok: false, status: 500, statusText: 'Status Text', text: async () => { throw new Error('x') } }) as unknown as Response })
    expect((await rejection(fetchYTimeRows(withRelay(), INPUT, KINTAI))).data.error).toBe('Status Text')
  })
})

describe('fetchYTimeRows — 試さない呼び方は無い (Refs #1133 c1133-47)', () => {
  it('★ 認可の結果 (`authorizeScraperRelay` の戻り値の形) をそのまま渡せば、relay を呼ぶ', async () => {
    sendToScraperRelayMock.mockResolvedValue(relayOk())
    routeUpstream({ rows: () => rowsOk(), alc: () => alcOk() })
    const res = await fetchYTimeRows(withRelay(), INPUT, { sharedSecret: 'secret-x', tenantId: 'tenant-a' })
    expect(sendToScraperRelayMock).toHaveBeenCalledTimes(1)
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-rows'])
    expect(res.source).toBe('kintai')
  })

  it('倒した先の運行の GET で本文が読めなければ statusText を理由にする', async () => {
    routeUpstream({ alc: () => ({ ok: false, status: 502, statusText: 'Bad Gateway', text: async () => { throw new Error('x') } }) as unknown as Response })
    const e = await rejection(fetchYTimeRows(eventWith({}), INPUT, KINTAI))
    expect(e.statusCode).toBe(502)
    expect(e.statusMessage).toBe('backend error: Bad Gateway')
  })
})

describe('yTimeRowsInputFromBody — 2 つの route が共用する body の検証', () => {
  it('★ 3 欄を読んで返す。body のほかの欄 (tenant_id・template_key) は読まない', () => {
    expect(yTimeRowsInputFromBody({ driver_cd: '9001', from: '2025-01-01', to: '2025-01-31', tenant_id: 'tenant-b', template_key: 'templates/x.xlsx' }))
      .toStrictEqual({ driverCd: '9001', from: '2025-01-01', to: '2025-01-31' })
  })

  it.each([
    ['null', null],
    ['文字列', 'x'],
    ['配列', ['9001', '2025-01-01', '2025-01-31']],
    ['空の object', {}],
    ['driver_cd が空', { driver_cd: '', from: '2025-01-01', to: '2025-01-31' }],
    ['driver_cd が数', { driver_cd: 9001, from: '2025-01-01', to: '2025-01-31' }],
    ['from が無い', { driver_cd: '9001', to: '2025-01-31' }],
    ['to が空', { driver_cd: '9001', from: '2025-01-01', to: '' }],
  ])('★ %s は 400 (statusMessage は ASCII)', (_name, body) => {
    let thrown: { statusCode?: number, statusMessage?: string } = {}
    try {
      yTimeRowsInputFromBody(body)
    }
    catch (e) {
      thrown = e as typeof thrown
    }
    expect(thrown.statusCode).toBe(400)
    expect(thrown.statusMessage).toBe('driver_cd / from / to are required')
  })
})

describe('yTimeSourceHeaders', () => {
  const base: YTimeRowsResult = { source: 'kintai', sourceReason: null, rows: [], warnings: [], excluded: [], missingMonths: [] }

  it('元だけのときは x-y-time-source の 1 本', () => {
    expect(yTimeSourceHeaders(base)).toEqual({ 'x-y-time-source': 'kintai' })
    expect(yTimeSourceHeaders({ ...base, source: 'alc', sourceReason: 'out_of_scope' })).toEqual({
      'x-y-time-source': 'alc', 'x-y-time-source-reason': 'out_of_scope',
    })
  })

  it('★ 理由ごとの件数は全件ぶん、一覧は先頭 20 件。日付は時刻の区切りが空白でも T でも先頭 10 文字', () => {
    const excluded = [
      { start: '2025-01-02 08:00:00', end: '2025-01-02 17:00:00', reason: 'no_non_working' },
      { start: '2025-01-03T08:00:00', end: '2025-01-05T17:00:00', reason: 'three_days' },
      ...Array.from({ length: 21 }, (_, i) => ({ start: `2025-02-${String(i + 1).padStart(2, '0')} 08:00:00`, end: 'e', reason: 'no_non_working' })),
    ]
    const h = yTimeSourceHeaders({ ...base, excluded, missingMonths: ['2025-03', '2025-04'] })
    expect(h['x-y-time-excluded-reasons']).toBe('no_non_working=22,three_days=1')
    const listed = h['x-y-time-excluded']!.split(',')
    expect(listed).toHaveLength(Y_TIME_EXCLUDED_HEADER_LIMIT)
    expect(listed.slice(0, 3)).toEqual(['2025-01-02:no_non_working', '2025-01-03:three_days', '2025-02-01:no_non_working'])
    expect(h['x-y-time-missing-months']).toBe('2025-03,2025-04')
  })

  it('ヘッダに載せられない語 (日本語・区切り文字) は決まった語に置き換える (値は ASCII だけ)', () => {
    const h = yTimeSourceHeaders({
      ...base,
      excluded: [
        { start: '日付でない', end: 'e', reason: '理由' },
        { start: '2025-01-02 08:00:00', end: 'e', reason: 'a,b=c' },
      ],
    })
    expect(h['x-y-time-excluded-reasons']).toBe('other=2')
    expect(h['x-y-time-excluded']).toBe('unknown:other,2025-01-02:other')
  })
})
