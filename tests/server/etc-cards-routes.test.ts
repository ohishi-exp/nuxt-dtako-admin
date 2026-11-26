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
import regDateHandler from '../../server/api/etc-cards/[id]/registration-date.patch'
import registerHandler from '../../server/api/etc-cards/[id]/register.post'
import recheckHandler from '../../server/api/etc-cards/accounts-recheck.post'
import rescanHandler from '../../server/api/etc-cards/[id]/rescan.post'
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

  it('登録日: 入れると run_date / unko_no を消し、dry_run_ok / failed は waiting_run に戻す。受信日も返す', async () => {
    for (const status of ['dry_run_ok', 'failed', 'waiting_run']) {
      db.exec("UPDATE etc_card_registrations SET status = ?, run_date = '2026-11-01', unko_no = 'U1' WHERE id = 1", status)
      const res = await call(regDateHandler, event({ method: 'PATCH', params: { id: '1' }, body: { registration_date: '2026-11-10' } }))
      expect(res).toMatchObject({ id: 1, registration_date: '2026-11-10', received_at: 'r', run_date: null, unko_no: null, status: 'waiting_run' })
      db.exec('UPDATE etc_card_registrations SET registration_date = NULL WHERE id = 1')
    }
    // 要確認の行にも入れられる (status は要確認のまま)。null / 空文字で消せる
    expect(await call(regDateHandler, event({ method: 'PATCH', params: { id: '2' }, body: { registration_date: '2026-11-10' } }))).toMatchObject({ status: 'needs_review', registration_date: '2026-11-10' })
    expect(await call(regDateHandler, event({ method: 'PATCH', params: { id: '2' }, body: { registration_date: '' } }))).toMatchObject({ registration_date: null })
  })

  it('登録日: 同じ値なら何も書かない (run_date は残る)', async () => {
    db.exec("UPDATE etc_card_registrations SET status = 'dry_run_ok', registration_date = '2026-11-10', run_date = '2026-11-12', unko_no = 'U1' WHERE id = 1")
    const res = await call(regDateHandler, event({ method: 'PATCH', params: { id: '1' }, body: { registration_date: '2026-11-10' } }))
    expect(res).toMatchObject({ status: 'dry_run_ok', run_date: '2026-11-12', unko_no: 'U1' })
  })

  it('登録日: 登録済みは 409、日付の誤りは 400 で理由を data に、他テナント・無い行は 404、id の誤りは 400', async () => {
    db.exec("UPDATE etc_card_registrations SET status = 'registered' WHERE id = 1")
    expect((await rejection(call(regDateHandler, event({ method: 'PATCH', params: { id: '1' }, body: { registration_date: null } })))).statusCode).toBe(409)
    const bad = await rejection(call(regDateHandler, event({ method: 'PATCH', params: { id: '2' }, body: { registration_date: '2026-02-30' } })))
    expect(bad.statusCode).toBe(400)
    expect(bad.data).toEqual({ error: '登録日は YYYY-MM-DD の日付です' })
    expect((await rejection(call(regDateHandler, event({ method: 'PATCH', params: { id: '2' }, body: undefined })))).statusCode).toBe(400)
    expect((await rejection(call(regDateHandler, event({ method: 'PATCH', params: { id: '99' }, body: { registration_date: null } })))).statusCode).toBe(404)
    expect((await rejection(call(regDateHandler, event({ method: 'PATCH', params: { id: 'x' }, body: {} })))).statusCode).toBe(400)
    requireAuthMock.mockResolvedValue({ role: 'admin', tenant_id: 't2' })
    expect((await rejection(call(regDateHandler, event({ method: 'PATCH', params: { id: '2' }, body: { registration_date: null } })))).statusCode).toBe(404)
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

  it('accounts-recheck: relay の POST /kintai-relay/etc-run へ {} を共有秘密付きで送り、件数だけ返す (user_id を返さない)', async () => {
    relayFetch.mockResolvedValue(new Response(JSON.stringify({ results: [
      { kind: 'etc', target: 'fakeuser-0001', ok: true, detail: 'HTTP 202: {"user_id":"fakeuser-0001"}' },
      { kind: 'etc', target: 'fakeuser-0002', ok: false, detail: 'HTTP 500: x' },
    ] }), { status: 200 }))
    const res = await call(recheckHandler, event({ method: 'POST' }))
    expect(res).toEqual({ total: 2, ok: 1 })
    expect(JSON.stringify(res)).not.toContain('fakeuser')
    const [url, init] = relayFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.internal/kintai-relay/etc-run')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{}')
    expect((init.headers as Record<string, string>)['X-Alc-Proxy-Secret']).toBe(SECRET)
    relayFetch.mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    expect(await call(recheckHandler, event({ method: 'POST' }))).toEqual({ total: 0, ok: 0 })
  })

  it('accounts-recheck: relay の失敗は本文を件数と error 文だけに詰め直して status ごと投げる', async () => {
    relayFetch.mockResolvedValue(new Response(JSON.stringify({ results: [
      { kind: 'etc', target: 'fakeuser-0001', ok: false, detail: 'HTTP 500: fakeuser-0001' },
    ] }), { status: 502 }))
    const all = await rejection(call(recheckHandler, event({ method: 'POST' })))
    expect(all.statusCode).toBe(502)
    expect(all.data).toEqual({ total: 1, ok: 0 })
    expect(all.message).toBe('relay: 1 件中 0 件しか受け付けられませんでした')
    expect(JSON.stringify(all)).not.toContain('fakeuser')
    relayFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'ETC_ACCOUNTS が未設定です' }), { status: 404 }))
    const none = await rejection(call(recheckHandler, event({ method: 'POST' })))
    expect(none.statusCode).toBe(404)
    expect(none.message).toBe('relay: ETC_ACCOUNTS が未設定です')
    relayFetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    expect((await rejection(call(recheckHandler, event({ method: 'POST' })))).message).toBe('relay: HTTP 401')
    // binding 未設定 (data を持たない例外) はそのまま
    expect((await rejection(call(recheckHandler, event({ method: 'POST', env: env({ SCRAPER_RELAY: undefined }) })))).statusCode).toBe(503)
  })

  it('rescan: relay の POST /etc-card/rescan へ {id} を共有秘密付きで送り、202 と応答をそのまま返す', async () => {
    relayFetch.mockResolvedValue(new Response(JSON.stringify({ accepted: true, id: 1, comp_ids: ['c1'] }), { status: 202 }))
    const e = event({ method: 'POST', params: { id: '1' } })
    expect(await call(rescanHandler, e)).toEqual({ accepted: true, id: 1, comp_ids: ['c1'] })
    expect(e.res.status).toBe(202)
    const [url, init] = relayFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://relay.internal/etc-card/rescan')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"id":1}')
    expect((init.headers as Record<string, string>)['X-Alc-Proxy-Secret']).toBe(SECRET)
  })

  it('rescan: relay の失敗は status ごと (本文の error を添えて)、他テナントの行・id の誤りは relay を呼ばない', async () => {
    relayFetch.mockResolvedValue(new Response('Not Found', { status: 404 }))
    expect((await rejection(call(rescanHandler, event({ method: 'POST', params: { id: '1' } })))).statusCode).toBe(404)
    relayFetch.mockResolvedValue(new Response(JSON.stringify({ error: 'off' }), { status: 503 }))
    const off = await rejection(call(rescanHandler, event({ method: 'POST', params: { id: '1' } })))
    expect(off.statusCode).toBe(503)
    expect(off.message).toContain('503 off')
    relayFetch.mockClear()
    requireAuthMock.mockResolvedValue({ role: 'admin', tenant_id: 't2' })
    expect((await rejection(call(rescanHandler, event({ method: 'POST', params: { id: '1' } })))).statusCode).toBe(404)
    expect((await rejection(call(rescanHandler, event({ method: 'POST', params: { id: 'x' } })))).statusCode).toBe(400)
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
