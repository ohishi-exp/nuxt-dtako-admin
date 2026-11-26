import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PUT_BYTES,
  NOT_RELAYED,
  PURPOSE,
  handlePut,
  hasAuthorization,
  isPdf,
  isRelayed,
  logLine,
  looksLikeFile,
  planReply,
  propfindXml,
  readBodyLimited,
  type EtcScanDeps,
} from '../../server/utils/etc-scan-dav'
import { sha256Hex } from '../../server/utils/profit-r2-io'
import { ROW_OK, fakePdf, openEtcScanD1, redactResult, type EtcScanD1 } from '../helpers/etc-scan-d1'

const BASIC = 'Basic dXNlcjpwYXNz'
const NOW = '2026-11-26T00:00:00.000Z'

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch)
      c.close()
    },
  })
}

describe('isRelayed / hasAuthorization / looksLikeFile / isPdf', () => {
  it('共有秘密が一致したときだけ真 (長さ違い・空・欠落は偽)', () => {
    expect(isRelayed('secret', 'secret')).toBe(true)
    expect(isRelayed('secreT', 'secret')).toBe(false)
    expect(isRelayed('secret-longer', 'secret')).toBe(false)
    expect(isRelayed('', 'secret')).toBe(false)
    expect(isRelayed(null, 'secret')).toBe(false)
    expect(isRelayed('secret', null)).toBe(false)
  })
  it('Authorization は空白だけなら無いのと同じ', () => {
    expect(hasAuthorization(BASIC)).toBe(true)
    expect(hasAuthorization('  ')).toBe(false)
    expect(hasAuthorization(null)).toBe(false)
  })
  it('末尾に拡張子があればファイル', () => {
    expect(looksLikeFile('/dav/scan/x.pdf')).toBe(true)
    expect(looksLikeFile('/dav/scan/')).toBe(false)
    expect(looksLikeFile('/dav')).toBe(false)
  })
  it('%PDF- で始まるものだけ PDF', () => {
    expect(isPdf(fakePdf())).toBe(true)
    expect(isPdf(new TextEncoder().encode('%PDF'))).toBe(false)
    expect(isPdf(new TextEncoder().encode('<html>'))).toBe(false)
  })
})

describe('planReply', () => {
  it('OPTIONS は認証なしで DAV の能力を答える', () => {
    expect(planReply('options', '/dav/', false).reply).toEqual({ status: 200, headers: { 'DAV': '1', 'Allow': 'OPTIONS, PROPFIND, MKCOL, PUT, DELETE', 'MS-Author-Via': 'DAV' } })
  })
  it('認証なしは 401 + Basic の realm etc-scan', () => {
    expect(planReply('PROPFIND', '/dav/', false)).toEqual({ kind: 'unauthorized', reply: { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="etc-scan", charset="UTF-8"' } } })
    expect(planReply('PUT', '/dav/x.pdf', false).reply.status).toBe(401)
  })
  it('認証ありの各メソッド', () => {
    expect(planReply('PROPFIND', '/dav/x.pdf', true).reply.status).toBe(404)
    expect(planReply('PROPFIND', '/dav/a&b<', true).reply).toEqual({ status: 207, headers: { 'Content-Type': 'application/xml; charset=utf-8' }, body: propfindXml('/dav/a&b<') })
    expect(propfindXml('/dav/a&b<')).toContain('<D:href>/dav/a&amp;b&lt;</D:href>')
    expect(planReply('MKCOL', '/dav/x', true).reply.status).toBe(201)
    expect(planReply('DELETE', '/dav/x.pdf', true).reply.status).toBe(204)
    expect(planReply('GET', '/dav/x.pdf', true).reply.status).toBe(404)
    expect(planReply('HEAD', '/dav/x.pdf', true).reply.status).toBe(404)
    expect(planReply('PATCH', '/dav/x.pdf', true).reply).toEqual({ status: 405, headers: { Allow: 'OPTIONS, PROPFIND, MKCOL, PUT, DELETE' } })
  })
})

describe('readBodyLimited', () => {
  it('Content-Length が上限超えなら読まずに null', async () => {
    const s = streamOf(new Uint8Array([1]))
    expect(await readBodyLimited(s, String(MAX_PUT_BYTES + 1))).toBeNull()
    expect(await readBodyLimited(null, String(MAX_PUT_BYTES + 1))).toBeNull()
  })
  it('実際の長さが上限超えなら null、収まれば連結して返す', async () => {
    expect(await readBodyLimited(streamOf(new Uint8Array(3), new Uint8Array(3)), null, 5)).toBeNull()
    expect([...(await readBodyLimited(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), '3', 5))!]).toEqual([1, 2, 3])
  })
  it('body が無ければ 0 バイト。上限の既定は 1.5MB', async () => {
    expect((await readBodyLimited(null, null))!.byteLength).toBe(0)
    expect(MAX_PUT_BYTES).toBe(1.5 * 1024 * 1024)
  })
})

describe('handlePut', () => {
  let db: EtcScanD1
  let deps: EtcScanDeps
  const issueTicket = vi.fn()
  const extractEtcCard = vi.fn()

  beforeEach(async () => {
    db = await openEtcScanD1()
    issueTicket.mockReset().mockResolvedValue({ ticket: 'tk', tenantId: 't1', username: 'mc_1' })
    extractEtcCard.mockReset().mockResolvedValue(redactResult({ rows: [ROW_OK] }))
    deps = { mcred: { issueTicket }, redact: { extractEtcCard }, db, now: () => NOW }
  })

  it('認証なしは 401、上限超えは 413、0 バイトは 201 (どれも RPC を呼ばない)', async () => {
    expect((await handlePut(null, fakePdf(), deps)).reply.status).toBe(401)
    expect(await handlePut(BASIC, null, deps)).toEqual({ kind: 'too_large', reply: { status: 413, headers: {} } })
    expect(await handlePut(BASIC, new Uint8Array(0), deps)).toEqual({ kind: 'empty', reply: { status: 201, headers: {} } })
    expect(issueTicket).not.toHaveBeenCalled()
  })

  it('PDF を保存して OCR し、行を作って 201 (用途 etc-scan・本文の sha256 で issueTicket)', async () => {
    const pdf = fakePdf()
    const sha = await sha256Hex(pdf)
    const out = await handlePut(BASIC, pdf, deps)
    expect(out).toEqual({ kind: 'stored', reply: { status: 201, headers: {} }, log: { sha: sha.slice(0, 12), rows: 1 } })
    expect(issueTicket).toHaveBeenCalledWith(BASIC, PURPOSE, sha)
    expect(PURPOSE).toBe('etc-scan')
    expect(db.rows('SELECT sha256, tenant_id, ocr_status, row_count, received_at FROM etc_card_scans')).toEqual([{ sha256: sha, tenant_id: 't1', ocr_status: 'ok', row_count: 1, received_at: NOW }])
    expect(db.rows('SELECT status FROM etc_card_registrations')).toEqual([{ status: 'waiting_run' }])
  })

  it('issueTicket が null は 401 (rejected) で保存しない', async () => {
    issueTicket.mockResolvedValue(null)
    const out = await handlePut(BASIC, fakePdf(), deps)
    expect(out.kind).toBe('rejected')
    expect(out.reply).toEqual({ status: 401, headers: { 'WWW-Authenticate': 'Basic realm="etc-scan", charset="UTF-8"' } })
    expect(db.rows('SELECT sha256 FROM etc_card_scans')).toEqual([])
    expect(extractEtcCard).not.toHaveBeenCalled()
  })

  it('PDF でなければ 415 (認可の後) で保存しない', async () => {
    const out = await handlePut(BASIC, new TextEncoder().encode('<html>') as Uint8Array<ArrayBuffer>, deps)
    expect(out.kind).toBe('not_pdf')
    expect(out.reply.status).toBe(415)
    expect(issueTicket).toHaveBeenCalledTimes(1)
    expect(db.rows('SELECT sha256 FROM etc_card_scans')).toEqual([])
  })

  it('同じ PDF の 2 回目は 201 (duplicate) で OCR しない', async () => {
    await handlePut(BASIC, fakePdf(), deps)
    const out = await handlePut(BASIC, fakePdf(), deps)
    expect(out.kind).toBe('duplicate')
    expect(out.reply.status).toBe(201)
    expect(extractEtcCard).toHaveBeenCalledTimes(1)
  })

  it('OCR が失敗しても scan は残して 201 (複合機に再送させない)', async () => {
    extractEtcCard.mockResolvedValue(redactResult({ error: 'gemini_failed' }, 502))
    const out = await handlePut(BASIC, fakePdf(), deps)
    expect(out.kind).toBe('stored_ocr_failed')
    expect(out.reply.status).toBe(201)
    expect(out.log?.detail).toBe('HTTP 502 gemini_failed')
    expect(db.rows('SELECT ocr_status, ocr_error FROM etc_card_scans')).toEqual([{ ocr_status: 'failed', ocr_error: 'HTTP 502 gemini_failed' }])
  })

  it('RPC・D1 の例外は 503 (sha が分かっていれば添える)', async () => {
    issueTicket.mockRejectedValue(new Error('rpc down'))
    const a = await handlePut(BASIC, fakePdf(), deps)
    expect(a.kind).toBe('upstream_error')
    expect(a.reply.status).toBe(503)
    expect(a.log?.detail).toBe('rpc down')
    expect(a.log?.sha).toHaveLength(12)

    issueTicket.mockResolvedValue({ ticket: 'tk', tenantId: 't1', username: 'mc_1' })
    db.failWhen = sql => sql.includes('INSERT OR IGNORE INTO etc_card_scans')
    const b = await handlePut(BASIC, fakePdf(), deps)
    expect(b.reply.status).toBe(503)
    expect(b.log?.detail).toContain('injected failure')
  })

  it('sha256 の計算前に落ちたら sha を添えない (Error 以外の throw も文字列に)', async () => {
    const digest = vi.spyOn(crypto.subtle, 'digest').mockRejectedValueOnce('no digest')
    const out = await handlePut(BASIC, fakePdf(), deps)
    expect(out).toEqual({ kind: 'upstream_error', reply: { status: 503, headers: {} }, log: { sha: undefined, detail: 'no digest' } })
    digest.mockRestore()
  })
})

describe('logLine', () => {
  it('メソッド・バイト数・status・kind と log (sha 先頭・行数) だけ', () => {
    expect(logLine('put', 10, { kind: 'stored', reply: { status: 201, headers: {} }, log: { sha: 'abcdefabcdef', rows: 2 } }))
      .toBe('etc-scan dav: {"method":"PUT","bodyBytes":10,"status":201,"kind":"stored","sha":"abcdefabcdef","rows":2}')
    expect(logLine('GET', 0, NOT_RELAYED)).toBe('etc-scan dav: {"method":"GET","bodyBytes":0,"status":404,"kind":"not_relayed"}')
  })
})
