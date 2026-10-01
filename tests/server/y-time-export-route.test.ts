/**
 * `POST /api/y-time-export` の**認可** (Refs #988)。
 *
 * **ここは D 段 (認可ゼロ) ではなく B 段だった** — `alcProxyFetch` が browser JWT を
 * 転送し、上流 auth-worker `/alc-proxy` が token 不在を 401 にする。それでも A 段へ
 * 上げるのは、**B 段の防御が上流の実装依存**でこの repo からは保証できないため
 * (`docs/plan-922-single-signin.md` §1 が `/api/ichiban/**` の項で書いている性質と同じ)。
 * **⇒ 無防備ではなく、入れる前も無認証の呼び出し元に xlsx は返っていない。**
 * `unconfirmed.get` と違い**上流を待ってから R2 に触る**ので、
 * 「未ログインでも R2 が動く」という利得もこちらには無い。
 * 返る xlsx は**乗務員 1 人の日別 拘束/運転/休憩の実データ**。
 *
 * - **陰性対照**: 未ログインは 401 で、**body を読む前・上流を叩く前**に落ちる
 * - **陽性対照**: 認証が通れば従来どおり xlsx bytes が返り、
 *   missing-dates / warnings ヘッダも従来どおり載る
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock, alcProxyFetchMock, sendToScraperRelayMock, readBodyMock, setResponseHeaderMock, writeYTimeRowsMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  alcProxyFetchMock: vi.fn(),
  sendToScraperRelayMock: vi.fn(),
  readBodyMock: vi.fn(),
  setResponseHeaderMock: vi.fn(),
  writeYTimeRowsMock: vi.fn(),
}))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))
vi.mock('../../server/utils/alc-proxy', () => ({ alcProxyFetch: alcProxyFetchMock }))
// 行を取る util (`server/utils/y-time-rows.ts`) は本物を通す。肩代わりするのはその先の relay と上流だけ
vi.mock('../../server/utils/scraper-relay', () => ({ sendToScraperRelay: sendToScraperRelayMock }))
vi.mock('~/utils/y-time-xlsx', () => ({
  writeYTimeRows: writeYTimeRowsMock,
  buildFilename: (cd: string, from: string, to: string) => `y-time_${cd}_${from}_${to}.xlsx`,
}))
vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    readBody: readBodyMock,
    setResponseHeader: setResponseHeaderMock,
  }
})

import handler from '../../server/api/y-time-export.post'

const call = (event: unknown) => (handler as unknown as (e: unknown) => Promise<Uint8Array>)(event)

const BODY = { driver_cd: '0001', from: '2026-07-01', to: '2026-07-31', template_key: 'templates/kyoto-soft/base.xlsx' }
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04])

function r2With(objects: Record<string, ArrayBuffer>) {
  return {
    get: vi.fn(async (key: string) => (key in objects ? { arrayBuffer: async () => objects[key]! } : null)),
  }
}
const templateR2 = () => r2With({ [BODY.template_key]: new ArrayBuffer(8) })

const okEnv = (extra: Record<string, unknown> = {}) => ({ INTERNAL_SHARED_SECRET: 'secret', ...extra })
const eventWith = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } } })

beforeEach(() => {
  requireAuthMock.mockReset()
  requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin', tenant_id: 'tenant-a' })
  sendToScraperRelayMock.mockReset()
  readBodyMock.mockReset()
  readBodyMock.mockResolvedValue({ ...BODY })
  alcProxyFetchMock.mockReset()
  alcProxyFetchMock.mockResolvedValue({
    ok: true, status: 200, statusText: 'OK', json: async () => ({ rows: [], warnings: [] }),
  })
  setResponseHeaderMock.mockReset()
  writeYTimeRowsMock.mockReset()
  writeYTimeRowsMock.mockResolvedValue({ bytes: XLSX_BYTES, missingDates: [] })
})

describe('POST /api/y-time-export — 認可 (Refs #988)', () => {
  it('★ 未ログインは 401 で、body も読まず上流も叩かない', async () => {
    requireAuthMock.mockRejectedValue(Object.assign(new Error('Unauthorized'), { statusCode: 401 }))
    const r2 = templateR2()
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2 })))).rejects.toMatchObject({ statusCode: 401 })
    expect(readBodyMock).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
    expect(r2.get).not.toHaveBeenCalled()
  })

  it('INTERNAL_SHARED_SECRET 未設定なら 503 (auth を通す前に落ちる)', async () => {
    await expect(call(eventWith({ DTAKO_R2: templateR2() }))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('INTERNAL_SHARED_SECRET'),
    })
    expect(requireAuthMock).not.toHaveBeenCalled()
  })

  it('cloudflare env そのものが無くても 503 (落ちない)', async () => {
    await expect(call({ context: {} })).rejects.toMatchObject({ statusCode: 503 })
  })

  it('Secrets Store binding (.get()) からも secret を取れる', async () => {
    await call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => 'from-store' }, DTAKO_R2: templateR2() }))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ sharedSecret: 'from-store' })
  })

  it('.get() が値を返さない binding / 文字列でも .get() でもない binding は 503', async () => {
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: { get: async () => undefined }, DTAKO_R2: templateR2() })))
      .rejects.toMatchObject({ statusCode: 503 })
    await expect(call(eventWith({ INTERNAL_SHARED_SECRET: 123, DTAKO_R2: templateR2() })))
      .rejects.toMatchObject({ statusCode: 503 })
  })

  it('auth-worker の URL は env が有れば env、無ければ既定', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: templateR2(), NUXT_PUBLIC_AUTH_WORKER_URL: 'https://auth.example.test' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.example.test' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: templateR2(), NUXT_PUBLIC_AUTH_WORKER_URL: '' })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })

    requireAuthMock.mockClear()
    await call(eventWith(okEnv({ DTAKO_R2: templateR2(), NUXT_PUBLIC_AUTH_WORKER_URL: 7 })))
    expect(requireAuthMock.mock.calls[0]![1]).toMatchObject({ authWorkerUrl: 'https://auth.ippoan.org' })
  })
})

describe('POST /api/y-time-export — 陽性対照 (塞いだだけで使えなくなっていない)', () => {
  it('★ 認証が通れば従来どおり xlsx bytes を返し、filename も従来どおり', async () => {
    const r2 = templateR2()
    const res = await call(eventWith(okEnv({ DTAKO_R2: r2 })))
    expect(res).toBe(XLSX_BYTES)
    expect(alcProxyFetchMock).toHaveBeenCalledWith(expect.anything(), {
      path: '/api/dtako/y-time-export',
      query: { driver_cd: '0001', from: '2026-07-01', to: '2026-07-31' },
    })
    expect(r2.get).toHaveBeenCalledWith(BODY.template_key)
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'content-type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'content-disposition',
      'attachment; filename="y-time_0001_2026-07-01_2026-07-31.xlsx"',
    )
  })

  it('欠落必須項目 / templates/ 以外の template_key は 400 (認証の後)', async () => {
    const env = okEnv({ DTAKO_R2: templateR2() })
    for (const bad of [null, {}, { ...BODY, driver_cd: '' }, { ...BODY, from: '' },
      { ...BODY, to: '' }, { ...BODY, template_key: '' }]) {
      readBodyMock.mockResolvedValue(bad)
      await expect(call(eventWith(env))).rejects.toMatchObject({ statusCode: 400 })
    }
    readBodyMock.mockResolvedValue({ ...BODY, template_key: 'vehicle-settings/4437/x.json' })
    await expect(call(eventWith(env))).rejects.toMatchObject({
      statusCode: 400,
      statusMessage: expect.stringContaining('templates/'),
    })
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('上流エラーはその status と本文で loud fail する (本文が読めなければ statusText)', async () => {
    alcProxyFetchMock.mockResolvedValue({
      ok: false, status: 502, statusText: 'Bad Gateway', text: async () => 'upstream down',
    })
    await expect(call(eventWith(okEnv({ DTAKO_R2: templateR2() })))).rejects.toMatchObject({
      statusCode: 502, statusMessage: expect.stringContaining('upstream down'),
    })

    alcProxyFetchMock.mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized', text: async () => { throw new Error('boom') },
    })
    await expect(call(eventWith(okEnv({ DTAKO_R2: templateR2() })))).rejects.toMatchObject({
      statusCode: 401, statusMessage: expect.stringContaining('Unauthorized'),
    })
  })

  it('DTAKO_R2 未設定なら 503 (ログイン後。secret の 503 と文言で分ける)', async () => {
    await expect(call(eventWith(okEnv()))).rejects.toMatchObject({
      statusCode: 503,
      statusMessage: expect.stringContaining('DTAKO_R2'),
    })
  })

  it('テンプレが R2 に無ければ 404', async () => {
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2With({}) })))).rejects.toMatchObject({
      statusCode: 404,
      statusMessage: expect.stringContaining(BODY.template_key),
    })
  })

  it('missing-dates / warnings は従来どおりヘッダに載る (本文は binary なので)', async () => {
    writeYTimeRowsMock.mockResolvedValue({ bytes: XLSX_BYTES, missingDates: ['2026-07-05', '2026-07-06'] })
    alcProxyFetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ rows: [], warnings: ['行が足りません'] }),
    })
    await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'x-y-time-missing-dates', '2026-07-05,2026-07-06',
    )
    // 日本語をそのままヘッダに入れると 500 になるので URI encode したまま
    expect(setResponseHeaderMock).toHaveBeenCalledWith(
      expect.anything(), 'x-y-time-warnings', encodeURIComponent('行が足りません'),
    )
  })

  it('期間クリアの指示は従来どおり writeYTimeRows に渡る', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
    expect(writeYTimeRowsMock.mock.calls[0]![2]).toEqual({
      clearPeriod: { from: '2026-07-01', to: '2026-07-31' },
    })
  })

  it('上流のエラーにだけ data.upstream = alc が付く (テンプレ不在の 404 には付かない)', async () => {
    alcProxyFetchMock.mockResolvedValue({
      ok: false, status: 404, statusText: 'Not Found', text: async () => 'driver_cd not found: 9999',
    })
    await expect(call(eventWith(okEnv({ DTAKO_R2: templateR2() })))).rejects.toMatchObject({
      statusCode: 404, data: { upstream: 'alc' },
    })

    alcProxyFetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ rows: [], warnings: [] }),
    })
    const err = await call(eventWith(okEnv({ DTAKO_R2: r2With({}) }))).catch((e: unknown) => e)
    expect(err).toMatchObject({ statusCode: 404 })
    expect((err as { data?: unknown }).data).toBeUndefined()
  })
})

describe('POST /api/y-time-export — period_rewrite と件数ヘッダ (Refs #1133 c1133-2)', () => {
  it('★ period_rewrite: true のときだけ from/to を period として writeYTimeRows に渡す', async () => {
    readBodyMock.mockResolvedValue({ ...BODY, period_rewrite: true })
    await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
    expect(writeYTimeRowsMock.mock.calls[0]![2]).toEqual({
      clearPeriod: { from: '2026-07-01', to: '2026-07-31' },
      period: { from: '2026-07-01', to: '2026-07-31' },
    })
  })

  it('period_rewrite が true 以外 (false / 文字列) なら period は渡らない', async () => {
    for (const v of [false, 'true', 1]) {
      writeYTimeRowsMock.mockClear()
      readBodyMock.mockResolvedValue({ ...BODY, period_rewrite: v })
      await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
      expect(writeYTimeRowsMock.mock.calls[0]![2]).toEqual({
        clearPeriod: { from: '2026-07-01', to: '2026-07-31' },
      })
    }
  })

  it('★ 行数・欠けた日の総数・警告の総数を切り詰めずに別ヘッダで返す', async () => {
    const missing = Array.from({ length: 31 }, (_, i) => `2026-07-${String(i + 1).padStart(2, '0')}`)
    writeYTimeRowsMock.mockResolvedValue({ bytes: XLSX_BYTES, missingDates: missing })
    alcProxyFetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ rows: [{}, {}, {}], warnings: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    })
    await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
    const headers = Object.fromEntries(setResponseHeaderMock.mock.calls.map(c => [c[1], c[2]]))
    expect(headers['x-y-time-rows']).toBe('3')
    expect(headers['x-y-time-missing-count']).toBe('31')
    expect(headers['x-y-time-warnings-count']).toBe('6')
    // 既存ヘッダは今までどおり先頭 30 件 / 5 件で切る
    expect(String(headers['x-y-time-missing-dates']).split(',')).toHaveLength(30)
    expect(decodeURIComponent(String(headers['x-y-time-warnings'])).split(' / ')).toHaveLength(5)
  })

  it('rows 0 でも件数ヘッダは 0 で載る (何の 0 件かを画面が言い分ける材料)', async () => {
    await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
    const headers = Object.fromEntries(setResponseHeaderMock.mock.calls.map(c => [c[1], c[2]]))
    expect(headers['x-y-time-rows']).toBe('0')
    expect(headers['x-y-time-missing-count']).toBe('0')
    expect(headers['x-y-time-warnings-count']).toBe('0')
  })

  it('★ period_rewrite: true でも、付ける応答ヘッダは今までの 7 本と行の元だけで、本文は writeYTimeRows の bytes そのまま (時間の集計は載せない、Refs #1133 c1133-36)', async () => {
    readBodyMock.mockResolvedValue({ ...BODY, period_rewrite: true })
    writeYTimeRowsMock.mockResolvedValue({ bytes: XLSX_BYTES, missingDates: ['2026-07-05'] })
    alcProxyFetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ rows: [{}], warnings: ['w'] }),
    })
    const res = await call(eventWith(okEnv({ DTAKO_R2: templateR2() })))
    expect(res).toBe(XLSX_BYTES)
    expect(setResponseHeaderMock.mock.calls.map(c => c[1])).toEqual([
      'x-y-time-rows',
      'x-y-time-missing-count',
      'x-y-time-warnings-count',
      'x-y-time-missing-dates',
      'x-y-time-warnings',
      // relay の binding が無い環境 = 運行の元へ倒した
      'x-y-time-source',
      'x-y-time-source-reason',
      'content-type',
      'content-disposition',
    ])
  })
})

describe('POST /api/y-time-export — 行の元 (勤怠の勤務の記録、Refs #1133 c1133-46)', () => {
  const REWRITE = { ...BODY, period_rewrite: true }
  const SHIFTS = [{ start: '2026-07-01 08:00:00', end: '2026-07-01 17:00:00', non_working: [], note: null }]
  const ROWS = [{ date: '2026-07-01' }, { date: '2026-07-02' }]
  const relayEnv = () => okEnv({ DTAKO_R2: templateR2(), SCRAPER_RELAY: { fetch: vi.fn() } })
  const headersSet = () => Object.fromEntries(setResponseHeaderMock.mock.calls.map(c => [c[1], c[2]])) as Record<string, string>
  const upstreamPaths = () => alcProxyFetchMock.mock.calls.map(c => (c[1] as { path: string }).path)

  function kintaiUpstream(excluded: { start: string, end: string, reason: string }[] = []) {
    sendToScraperRelayMock.mockResolvedValue({ tenant_id: 'tenant-a', shifts: SHIFTS, missing_months: ['2026-08'] })
    alcProxyFetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ rows: ROWS, warnings: [], excluded }),
    })
  }

  it('★ 勤怠の元: 上流の rows をそのまま writeYTimeRows に渡し、元・行を作れなかった勤務・記録の無い月をヘッダで返す', async () => {
    readBodyMock.mockResolvedValue(REWRITE)
    kintaiUpstream([
      { start: '2026-07-03 08:00:00', end: '2026-07-03 17:00:00', reason: 'no_non_working' },
      { start: '2026-07-04T08:00:00', end: '2026-07-04T17:00:00', reason: 'overlap' },
    ])
    const res = await call(eventWith(relayEnv()))
    expect(res).toBe(XLSX_BYTES)
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-rows'])
    expect(writeYTimeRowsMock.mock.calls[0]![1]).toBe(ROWS)
    expect(headersSet()).toMatchObject({
      'x-y-time-rows': '2',
      'x-y-time-source': 'kintai',
      'x-y-time-excluded-reasons': 'no_non_working=1,overlap=1',
      'x-y-time-excluded': '2026-07-03:no_non_working,2026-07-04:overlap',
      'x-y-time-missing-months': '2026-08',
    })
    expect(headersSet()).not.toHaveProperty('x-y-time-source-reason')
  })

  it('★ relay へ渡す tenant は requireAuth の結果。利用者の body に tenant_id を入れても使われない', async () => {
    readBodyMock.mockResolvedValue({ ...REWRITE, tenant_id: 'tenant-b' })
    kintaiUpstream()
    await call(eventWith(relayEnv()))
    expect(sendToScraperRelayMock).toHaveBeenCalledWith(
      expect.anything(), { sharedSecret: 'secret' }, '/kintai-relay/y-time-shifts',
      { driver_cd: '0001', from: '2026-07-01', to: '2026-07-31', tenant_id: 'tenant-a' },
    )
    // 認証は 1 回だけ (relay の定型の認証を重ねて呼ばない)
    expect(requireAuthMock).toHaveBeenCalledTimes(1)
  })

  it('★ 倒した 2 通り: 勤怠の記録が無い会社 (out_of_scope) / 勤怠の設定が無い (not_configured) は運行の GET で作る', async () => {
    readBodyMock.mockResolvedValue(REWRITE)
    alcProxyFetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK', json: async () => ({ rows: [{}], warnings: [] }),
    })
    sendToScraperRelayMock.mockRejectedValue(Object.assign(new Error('relay'), { statusCode: 403, data: { error: 'kintai_out_of_scope' } }))
    await call(eventWith(relayEnv()))
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-export'])
    expect(headersSet()).toMatchObject({ 'x-y-time-rows': '1', 'x-y-time-source': 'alc', 'x-y-time-source-reason': 'out_of_scope' })

    setResponseHeaderMock.mockClear()
    sendToScraperRelayMock.mockRejectedValue(Object.assign(new Error('relay'), { statusCode: 503, data: { error: 'kintai-relay not configured', reason: 'kintai_comp_id_unset' } }))
    await call(eventWith(relayEnv()))
    expect(headersSet()).toMatchObject({ 'x-y-time-source': 'alc', 'x-y-time-source-reason': 'not_configured' })
    for (const name of ['x-y-time-excluded-reasons', 'x-y-time-excluded', 'x-y-time-missing-months']) {
      expect(headersSet()).not.toHaveProperty(name)
    }
  })

  it('★ 倒さない失敗は Excel を作らずに投げる (テンプレにも触らない)', async () => {
    readBodyMock.mockResolvedValue(REWRITE)
    sendToScraperRelayMock.mockRejectedValue(Object.assign(new Error('relay'), { statusCode: 502, data: { error: 'gcp kintai shift-days 2026-07: failed' } }))
    const r2 = templateR2()
    await expect(call(eventWith(okEnv({ DTAKO_R2: r2, SCRAPER_RELAY: { fetch: vi.fn() } })))).rejects.toMatchObject({
      statusCode: 502, data: { source: 'kintai', stage: 'relay', status: 502 },
    })
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
    expect(r2.get).not.toHaveBeenCalled()
    expect(writeYTimeRowsMock).not.toHaveBeenCalled()
  })

  it('★ period_rewrite の無い呼び出しは relay を呼ばず、認証結果に tenant が無くても今までどおり運行の元で作る', async () => {
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin' })
    await call(eventWith(relayEnv()))
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
    expect(upstreamPaths()).toEqual(['/api/dtako/y-time-export'])
    expect(headersSet()).toMatchObject({ 'x-y-time-source': 'alc' })
    expect(headersSet()).not.toHaveProperty('x-y-time-source-reason')
  })

  it('period_rewrite: true で認証結果に tenant が無ければ 500 (relay も上流も呼ばない)', async () => {
    requireAuthMock.mockResolvedValue({ active: true, email: 'me@example.com', role: 'admin' })
    readBodyMock.mockResolvedValue(REWRITE)
    await expect(call(eventWith(relayEnv()))).rejects.toMatchObject({ statusCode: 500, data: { source: 'kintai', stage: 'auth' } })
    expect(sendToScraperRelayMock).not.toHaveBeenCalled()
    expect(alcProxyFetchMock).not.toHaveBeenCalled()
  })

  it('★ 行を作れなかった勤務が 20 件を超えるとき、一覧は 20 件・理由ごとの件数は全件', async () => {
    readBodyMock.mockResolvedValue(REWRITE)
    kintaiUpstream(Array.from({ length: 23 }, (_, i) => ({
      start: `2026-07-${String(i + 1).padStart(2, '0')} 08:00:00`, end: 'e', reason: i < 21 ? 'no_non_working' : 'night_bands',
    })))
    await call(eventWith(relayEnv()))
    expect(headersSet()['x-y-time-excluded']!.split(',')).toHaveLength(20)
    expect(headersSet()['x-y-time-excluded-reasons']).toBe('no_non_working=21,night_bands=2')
  })
})
