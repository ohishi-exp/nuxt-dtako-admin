/**
 * `/dav/**` と `/api/etc-cards/**` の route (Refs #1287)。h3 の event 周りだけ差し替え、D1 は実物の SQLite。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

interface TestEvent {
  method: string
  req?: Request
  params?: Record<string, string>
  body?: unknown
  context: { cloudflare: { env: Record<string, unknown> } }
  node: { req: { headers: Record<string, string> } }
  res: { status?: number, headers: Record<string, string> }
}

vi.mock('h3', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    defineEventHandler: (fn: unknown) => fn,
    toWebRequest: (e: TestEvent) => e.req,
    getRequestURL: (e: TestEvent) => new URL(e.req!.url),
    setResponseStatus: (e: TestEvent, s: number) => { e.res.status = s },
    setResponseHeaders: (e: TestEvent, h: Record<string, string>) => { Object.assign(e.res.headers, h) },
    getRouterParam: (e: TestEvent, k: string) => e.params?.[k],
    readBody: async (e: TestEvent) => e.body,
  }
})

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import davHandler from '../../server/routes/dav/[...path]'
import listHandler from '../../server/api/etc-cards/index.get'
import patchHandler from '../../server/api/etc-cards/[id].patch'
import registerHandler from '../../server/api/etc-cards/[id]/register.post'
import ocrHandler from '../../server/api/etc-cards/scans/[sha256]/ocr.post'
import { insertScan, runOcr } from '../../server/utils/etc-scan'
import { ROW_OK, ROW_PARTIAL, fakePdf, openEtcScanD1, redactResult, type EtcScanD1 } from '../helpers/etc-scan-d1'

type Handler = (e: TestEvent) => Promise<unknown>
const call = (h: unknown, e: TestEvent) => (h as Handler)(e)

const SECRET = 'dev-local-not-a-real-secret'
const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)

let db: EtcScanD1
const issueTicket = vi.fn()
const extractEtcCard = vi.fn()
const relayFetch = vi.fn()

function env(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    INTERNAL_SHARED_SECRET: SECRET,
    AUTH_MCRED: { issueTicket },
    ALC_REDACT: { extractEtcCard },
    DTAKO_DB: db,
    SCRAPER_RELAY: { fetch: relayFetch },
    ...extra,
  }
}

function event(e: Partial<TestEvent> & { env?: Record<string, unknown> } = {}): TestEvent {
  return {
    method: e.method ?? 'GET',
    req: e.req,
    params: e.params,
    body: e.body,
    context: { cloudflare: { env: e.env ?? env() } },
    node: { req: { headers: {} } },
    res: { headers: {} },
  }
}

async function rejection(p: Promise<unknown>): Promise<{ statusCode: number, data: unknown, message: string }> {
  try {
    await p
  }
  catch (e) {
    const err = e as { statusCode: number, data: unknown, message: string }
    return { statusCode: err.statusCode, data: err.data, message: err.message }
  }
  throw new Error('例外が投げられませんでした')
}

beforeEach(async () => {
  db = await openEtcScanD1()
  issueTicket.mockReset().mockResolvedValue({ ticket: 'tk', tenantId: 't1', username: 'mc_1' })
  extractEtcCard.mockReset().mockResolvedValue(redactResult({ rows: [ROW_OK, ROW_PARTIAL] }))
  relayFetch.mockReset()
  requireAuthMock.mockReset().mockResolvedValue({ role: 'admin', tenant_id: 't1' })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('/dav/**', () => {
  const put = (headers: Record<string, string>, body: BodyInit = fakePdf()) =>
    new Request('https://dtako.example/dav/scan/x.pdf', { method: 'PUT', headers, body })

  it('共有秘密なしの PUT は 404 (存在を見せない)。RPC も D1 も触らない', async () => {
    const e = event({ method: 'PUT', req: put({ authorization: 'Basic x' }) })
    expect(await call(davHandler, e)).toBe('')
    expect(e.res.status).toBe(404)
    expect(issueTicket).not.toHaveBeenCalled()
    expect(db.rows('SELECT sha256 FROM etc_card_scans')).toEqual([])
  })

  it('共有秘密が違っても 404', async () => {
    const e = event({ method: 'PUT', req: put({ 'authorization': 'Basic x', 'x-internal-shared-secret': 'wrong' }) })
    await call(davHandler, e)
    expect(e.res.status).toBe(404)
  })

  it('中継された PUT は保存して OCR し 201', async () => {
    const e = event({ method: 'PUT', req: put({ 'authorization': 'Basic x', 'x-internal-shared-secret': SECRET }) })
    await call(davHandler, e)
    expect(e.res.status).toBe(201)
    expect(db.rows('SELECT ocr_status, row_count FROM etc_card_scans')).toEqual([{ ocr_status: 'ok', row_count: 2 }])
    // ログに番号を出さない
    const logged = (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join('\n')
    expect(logged).toContain('"kind":"stored"')
    expect(logged).not.toContain(ROW_OK.card_number)
  })

  it('中継された PUT でも issueTicket が null (auth-worker の APP_TENANT_ACL で拒否を含む) なら 401 で保存しない', async () => {
    issueTicket.mockResolvedValueOnce(null)
    const e = event({ method: 'PUT', req: put({ 'authorization': 'Basic x', 'x-internal-shared-secret': SECRET }) })
    await call(davHandler, e)
    expect(e.res.status).toBe(401)
    expect(db.rows('SELECT sha256 FROM etc_card_scans')).toEqual([])
  })

  it('binding が欠けていれば 503 (本文は読まない)', async () => {
    const e = event({ method: 'PUT', req: put({ 'authorization': 'Basic x', 'x-internal-shared-secret': SECRET }), env: env({ ALC_REDACT: undefined }) })
    await call(davHandler, e)
    expect(e.res.status).toBe(503)
  })

  it('中継された PROPFIND / 認証なし PUT は planReply どおり', async () => {
    const pf = event({ method: 'PROPFIND', req: new Request('https://dtako.example/dav/scan/', { method: 'PROPFIND', headers: { 'authorization': 'Basic x', 'x-internal-shared-secret': SECRET } }) })
    expect(await call(davHandler, pf)).toContain('<D:href>/dav/scan/</D:href>')
    expect(pf.res.status).toBe(207)
    const noAuth = event({ method: 'PUT', req: put({ 'x-internal-shared-secret': SECRET }) })
    await call(davHandler, noAuth)
    expect(noAuth.res.status).toBe(401)
    expect(noAuth.res.headers['WWW-Authenticate']).toContain('etc-scan')
  })
})

describe('/api/etc-cards', () => {
  beforeEach(async () => {
    await insertScan(db, { sha256: SHA_A, pdf: fakePdf(), tenantId: 't1', receivedAt: 'r' })
    await runOcr(db, { extractEtcCard }, SHA_A, fakePdf(), 'n') // id 1 = waiting_run, id 2 = needs_review
    await insertScan(db, { sha256: SHA_B, pdf: fakePdf('b'), tenantId: 't1', receivedAt: 'r2' }) // OCR 未了 = failed
  })

  it('GET は末尾 5 桁だけ返し、未ログインは 401 をそのまま返す', async () => {
    const res = await call(listHandler, event()) as { registrations: { card_last5: string | null }[], failed_scans: unknown[] }
    expect(res.registrations.map(r => r.card_last5)).toEqual([null, '00010'])
    expect(res.failed_scans).toHaveLength(1)
    requireAuthMock.mockRejectedValue(Object.assign(new Error('unauth'), { statusCode: 401 }))
    expect((await rejection(call(listHandler, event()))).statusCode).toBe(401)
  })

  it('PATCH: 要確認の行を直すと waiting_run になり、全桁は返さない', async () => {
    const res = await call(patchHandler, event({ method: 'PATCH', params: { id: '2' }, body: { card_number: '0000000000000020' } }))
    expect(res).toMatchObject({ id: 2, card_last5: '00020', status: 'waiting_run', plate4: '56' })
    expect(JSON.stringify(res)).not.toContain('0000000000000020')
  })

  it('PATCH: 誤りの入力は 400 で理由を data に、要確認でない行は 409、他テナント・無い行は 404、id の誤りは 400', async () => {
    const bad = await rejection(call(patchHandler, event({ method: 'PATCH', params: { id: '2' }, body: { obu_number: '1' } })))
    expect(bad.statusCode).toBe(400)
    expect(bad.data).toEqual({ error: '車載器番号は数字 19 桁です' })
    expect((await rejection(call(patchHandler, event({ method: 'PATCH', params: { id: '1' }, body: {} })))).statusCode).toBe(409)
    requireAuthMock.mockResolvedValue({ role: 'admin', tenant_id: 't2' })
    expect((await rejection(call(patchHandler, event({ method: 'PATCH', params: { id: '2' }, body: {} })))).statusCode).toBe(404)
    expect((await rejection(call(patchHandler, event({ method: 'PATCH', params: { id: 'x' }, body: {} })))).statusCode).toBe(400)
  })

  it('PATCH: 既にあるカード番号にすると 409', async () => {
    const dup = await rejection(call(patchHandler, event({ method: 'PATCH', params: { id: '2' }, body: { card_number: ROW_OK.card_number } })))
    expect(dup.statusCode).toBe(409)
  })

  it('register: relay の POST /etc-card/register へ {id} を共有秘密付きで送り、応答をそのまま返す', async () => {
    relayFetch.mockResolvedValue(new Response(JSON.stringify({ ok: true, status: 'dry_run_ok' }), { status: 200 }))
    expect(await call(registerHandler, event({ method: 'POST', params: { id: '1' } }))).toEqual({ ok: true, status: 'dry_run_ok' })
    const [url, init] = relayFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.internal/etc-card/register')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"id":1}')
    expect((init.headers as Record<string, string>)['X-Alc-Proxy-Secret']).toBe(SECRET)
  })

  it('register: relay に口が無い (404) はそのまま 404、他テナントの行は relay を呼ばず 404', async () => {
    relayFetch.mockResolvedValue(new Response('Not Found', { status: 404 }))
    const r = await rejection(call(registerHandler, event({ method: 'POST', params: { id: '1' } })))
    expect(r.statusCode).toBe(404)
    relayFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'no_run' }), { status: 409 }))
    expect((await rejection(call(registerHandler, event({ method: 'POST', params: { id: '1' } })))).message).toContain('409 no_run')
    relayFetch.mockClear()
    requireAuthMock.mockResolvedValue({ role: 'admin', tenant_id: 't2' })
    expect((await rejection(call(registerHandler, event({ method: 'POST', params: { id: '1' } })))).statusCode).toBe(404)
    expect((await rejection(call(registerHandler, event({ method: 'POST', params: { id: '0' } })))).statusCode).toBe(400)
    expect(relayFetch).not.toHaveBeenCalled()
  })

  it('再 OCR: 失敗した scan を D1 の PDF で読み直し、成功済みは 409', async () => {
    extractEtcCard.mockClear().mockResolvedValue(redactResult({ rows: [{ ...ROW_OK, card_number: '0000000000000030' }] }))
    expect(await call(ocrHandler, event({ method: 'POST', params: { sha256: SHA_B } }))).toEqual({ ok: true, row_count: 1, inserted: 1 })
    expect(new TextDecoder().decode(extractEtcCard.mock.calls[0]![0] as ArrayBuffer)).toBe('%PDF-1.4\nb')
    expect((await rejection(call(ocrHandler, event({ method: 'POST', params: { sha256: SHA_B } })))).statusCode).toBe(409)
  })

  it('再 OCR: また失敗したら ok:false で理由を返す。sha256 の誤り 400・無い 404・ALC_REDACT 無し 503', async () => {
    extractEtcCard.mockResolvedValue(redactResult({ error: 'gemini_failed' }, 502))
    expect(await call(ocrHandler, event({ method: 'POST', params: { sha256: SHA_B } }))).toEqual({ ok: false, error: 'HTTP 502 gemini_failed' })
    expect((await rejection(call(ocrHandler, event({ method: 'POST', params: { sha256: 'xyz' } })))).statusCode).toBe(400)
    expect((await rejection(call(ocrHandler, event({ method: 'POST', params: { sha256: 'c'.repeat(64) } })))).statusCode).toBe(404)
    expect((await rejection(call(ocrHandler, event({ method: 'POST', params: { sha256: SHA_B }, env: env({ ALC_REDACT: undefined }) })))).statusCode).toBe(503)
  })
})
