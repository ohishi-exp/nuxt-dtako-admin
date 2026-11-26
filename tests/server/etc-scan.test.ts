import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requireAuthMock } = vi.hoisted(() => ({ requireAuthMock: vi.fn() }))
vi.mock('@ippoan/auth-client/server', () => ({ requireAuth: requireAuthMock }))

import {
  blobToBytes,
  etcCardsContext,
  getRegistration,
  getScan,
  insertScan,
  isSha256Hex,
  isUniqueViolation,
  listForTenant,
  parseExtractResult,
  parseId,
  parseTenantList,
  runOcr,
  shaPrefix,
  updateRegistrationFields,
} from '../../server/utils/etc-scan'
import { ROW_OK, ROW_PARTIAL, fakePdf, openEtcScanD1, redactResult, type EtcScanD1 } from '../helpers/etc-scan-d1'

const SHA_A = 'a'.repeat(64)
const SHA_B = 'b'.repeat(64)
const NOW = '2026-11-26T00:00:00.000Z'

let db: EtcScanD1
beforeEach(async () => {
  db = await openEtcScanD1()
  requireAuthMock.mockReset()
})

const redactOf = (res: ReturnType<typeof redactResult>) => ({ extractEtcCard: vi.fn(async () => res) })

describe('小物', () => {
  it('shaPrefix は先頭 12 桁', () => {
    expect(shaPrefix(SHA_A)).toBe('aaaaaaaaaaaa')
  })
  it('parseTenantList: カンマ区切り・空白除去、未設定/空は空集合 (誰も通さない)', () => {
    expect([...parseTenantList(' t1 , t2,,')]).toEqual(['t1', 't2'])
    expect(parseTenantList(null).size).toBe(0)
    expect(parseTenantList(undefined).size).toBe(0)
    expect(parseTenantList('').size).toBe(0)
  })
  it('isSha256Hex は 64 桁の小文字 hex だけ', () => {
    expect(isSha256Hex(SHA_A)).toBe(true)
    expect(isSha256Hex('A'.repeat(64))).toBe(false)
    expect(isSha256Hex('a'.repeat(63))).toBe(false)
    expect(isSha256Hex(undefined)).toBe(false)
  })
  it('parseId は正の整数の文字列だけ', () => {
    expect(parseId('12')).toBe(12)
    expect(parseId('0')).toBeNull()
    expect(parseId('-1')).toBeNull()
    expect(parseId('1.5')).toBeNull()
    expect(parseId(undefined)).toBeNull()
  })
  it('blobToBytes は ArrayBuffer / TypedArray / 数値配列を受け、それ以外は null', () => {
    expect([...blobToBytes(new Uint8Array([1, 2]).buffer)!]).toEqual([1, 2])
    expect([...blobToBytes(new Uint8Array([9, 1, 2, 9]).subarray(1, 3))!]).toEqual([1, 2])
    expect([...blobToBytes([1, 2])!]).toEqual([1, 2])
    expect(blobToBytes('x')).toBeNull()
  })
  it('isUniqueViolation は D1 の UNIQUE 違反の文だけ', () => {
    expect(isUniqueViolation(new Error('D1_ERROR: UNIQUE constraint failed: etc_card_registrations.card_number'))).toBe(true)
    expect(isUniqueViolation('UNIQUE constraint failed: x')).toBe(true)
    expect(isUniqueViolation(new Error('other'))).toBe(false)
  })
})

describe('parseExtractResult', () => {
  it('rows を正規化し、空行を落とす', () => {
    expect(parseExtractResult(redactResult({ rows: [ROW_OK, {}, ROW_PARTIAL], total: 2 }))).toEqual({
      ok: true,
      rows: [
        { kubun: '新規', card_number: '0000000000000010', vehicle_number: 'テスト100あ1234', obu_number: '0000000000000000019' },
        { kubun: '追加', card_number: null, vehicle_number: 'テスト100あ56', obu_number: '0000000000000000029' },
      ],
    })
  })
  it('非 2xx は status と alc-redact の error コードだけを理由にする (本文は入れない)', () => {
    expect(parseExtractResult(redactResult({ error: 'gemini_failed', detail: '0000000000000010' }, 502)))
      .toEqual({ ok: false, error: 'HTTP 502 gemini_failed' })
    expect(parseExtractResult(redactResult('not json', 503))).toEqual({ ok: false, error: 'HTTP 503' })
  })
  it('JSON でない・rows が配列でない 2xx は invalid_response', () => {
    expect(parseExtractResult(redactResult('not json'))).toEqual({ ok: false, error: 'invalid_response' })
    expect(parseExtractResult(redactResult({ rows: 'nope' }))).toEqual({ ok: false, error: 'invalid_response' })
  })
})

describe('insertScan / runOcr (実物の SQLite に migration 0021)', () => {
  const scan = (sha = SHA_A, tenantId = 't1') => ({ sha256: sha, pdf: fakePdf(), tenantId, receivedAt: NOW })

  it('scan は sha256 で冪等 (2 回目は false で行は増えない)。保存直後は ocr_pending の failed', async () => {
    expect(await insertScan(db, scan())).toBe(true)
    expect(await insertScan(db, scan())).toBe(false)
    const rows = db.rows('SELECT sha256, bytes, tenant_id, ocr_status, ocr_error, row_count, pdf FROM etc_card_scans')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ sha256: SHA_A, bytes: fakePdf().byteLength, tenant_id: 't1', ocr_status: 'failed', ocr_error: 'ocr_pending', row_count: 0 })
    expect(new TextDecoder().decode(blobToBytes(rows[0]!.pdf)!)).toBe('%PDF-1.4\nx')
  })

  it('OCR が読めたら行を作り、4 項目が揃えば waiting_run・欠ければ needs_review', async () => {
    await insertScan(db, scan())
    const redact = redactOf(redactResult({ rows: [ROW_OK, ROW_PARTIAL] }))
    expect(await runOcr(db, redact, SHA_A, fakePdf(), NOW)).toEqual({ ok: true, rowCount: 2, inserted: 2 })
    expect(redact.extractEtcCard).toHaveBeenCalledTimes(1)
    expect(db.rows('SELECT kubun, card_number, vehicle_number, plate4, obu_number, status, attempts, created_at FROM etc_card_registrations ORDER BY id')).toEqual([
      { kubun: '新規', card_number: '0000000000000010', vehicle_number: 'テスト100あ1234', plate4: '1234', obu_number: '0000000000000000019', status: 'waiting_run', attempts: 0, created_at: NOW },
      { kubun: '追加', card_number: null, vehicle_number: 'テスト100あ56', plate4: '56', obu_number: '0000000000000000029', status: 'needs_review', attempts: 0, created_at: NOW },
    ])
    expect(db.rows('SELECT ocr_status, ocr_error, row_count FROM etc_card_scans')).toEqual([{ ocr_status: 'ok', ocr_error: null, row_count: 2 }])
  })

  it('同じ card_number の行は足さない (別の scan でも)。card_number が null の行は何度でも足す', async () => {
    await insertScan(db, scan(SHA_A))
    await insertScan(db, scan(SHA_B))
    await runOcr(db, redactOf(redactResult({ rows: [ROW_OK, ROW_PARTIAL] })), SHA_A, fakePdf(), NOW)
    expect(await runOcr(db, redactOf(redactResult({ rows: [ROW_OK, ROW_PARTIAL] })), SHA_B, fakePdf(), NOW))
      .toEqual({ ok: true, rowCount: 2, inserted: 1 })
    expect(db.rows('SELECT scan_sha256, card_number FROM etc_card_registrations ORDER BY id')).toEqual([
      { scan_sha256: SHA_A, card_number: '0000000000000010' },
      { scan_sha256: SHA_A, card_number: null },
      { scan_sha256: SHA_B, card_number: null },
    ])
  })

  it('OCR の失敗 (非 2xx) は scan を failed のまま理由を残し、行は作らない', async () => {
    await insertScan(db, scan())
    expect(await runOcr(db, redactOf(redactResult({ error: 'gemini_failed' }, 502)), SHA_A, fakePdf(), NOW))
      .toEqual({ ok: false, error: 'HTTP 502 gemini_failed' })
    expect(db.rows('SELECT ocr_status, ocr_error FROM etc_card_scans')).toEqual([{ ocr_status: 'failed', ocr_error: 'HTTP 502 gemini_failed' }])
    expect(db.rows('SELECT id FROM etc_card_registrations')).toEqual([])
  })

  it('RPC の例外も失敗として残す (Error 以外の throw も文字列にする)', async () => {
    await insertScan(db, scan())
    const boom = { extractEtcCard: vi.fn(async () => { throw new Error('rpc down') }) }
    expect(await runOcr(db, boom, SHA_A, fakePdf(), NOW)).toEqual({ ok: false, error: 'rpc_error rpc down' })
    const weird = { extractEtcCard: vi.fn(async () => { throw 'str' }) }
    expect(await runOcr(db, weird, SHA_A, fakePdf(), NOW)).toEqual({ ok: false, error: 'rpc_error str' })
  })

  it('run の結果に meta が無い D1 でも落ちない (足した数は 0 と数える)', async () => {
    const bare = { prepare: () => ({ bind() { return this }, first: async () => null, all: async () => ({ results: [] }), run: async () => null }) }
    expect(await insertScan(bare as never, scan())).toBe(false)
  })
})

describe('listForTenant / getRegistration / updateRegistrationFields / getScan', () => {
  beforeEach(async () => {
    await insertScan(db, { sha256: SHA_A, pdf: fakePdf(), tenantId: 't1', receivedAt: '2026-11-01T00:00:00.000Z' })
    await insertScan(db, { sha256: SHA_B, pdf: fakePdf('b'), tenantId: 't2', receivedAt: '2026-11-02T00:00:00.000Z' })
    await runOcr(db, redactOf(redactResult({ rows: [ROW_OK, ROW_PARTIAL] })), SHA_A, fakePdf(), NOW)
  })

  it('一覧はテナントで絞り、カード番号は末尾 5 桁だけ・新しい順。OCR 失敗の scan も添える', async () => {
    const t1 = await listForTenant(db, 't1')
    expect(t1.registrations.map(r => [r.id, r.card_last5, r.status])).toEqual([[2, null, 'needs_review'], [1, '00010', 'waiting_run']])
    expect(JSON.stringify(t1)).not.toContain('0000000000000010')
    expect(t1.failed_scans).toEqual([])
    const t2 = await listForTenant(db, 't2')
    expect(t2.registrations).toEqual([])
    expect(t2.failed_scans).toEqual([{ sha256: SHA_B, bytes: fakePdf('b').byteLength, received_at: '2026-11-02T00:00:00.000Z', ocr_error: 'ocr_pending' }])
  })

  it('1 件の取得は他テナントの行を返さない', async () => {
    expect((await getRegistration(db, 't1', 1))?.card_number).toBe('0000000000000010')
    expect(await getRegistration(db, 't2', 1)).toBeNull()
    expect(await getRegistration(db, 't1', 99)).toBeNull()
  })

  it('手直しは plate4 と status を作り直す。重複カードは UNIQUE 違反で throw', async () => {
    await updateRegistrationFields(db, 2, { kubun: '追加', card_number: '0000000000000020', vehicle_number: 'テスト100あ0078', obu_number: '0000000000000000029' }, 'later')
    expect(db.rows('SELECT card_number, plate4, status, updated_at FROM etc_card_registrations WHERE id = 2'))
      .toEqual([{ card_number: '0000000000000020', plate4: '78', status: 'waiting_run', updated_at: 'later' }])
    const dup = updateRegistrationFields(db, 2, { kubun: '追加', card_number: '0000000000000010', vehicle_number: 'x1', obu_number: null }, 'later')
    await expect(dup).rejects.toThrow(/UNIQUE constraint failed/)
  })

  it('scan の取得もテナントで絞る', async () => {
    expect((await getScan(db, 't2', SHA_B))?.ocr_status).toBe('failed')
    expect(await getScan(db, 't1', SHA_B)).toBeNull()
  })
})

describe('etcCardsContext', () => {
  const event = (env: Record<string, unknown>) => ({ context: { cloudflare: { env } }, node: { req: { headers: {} } } }) as never
  const env = { INTERNAL_SHARED_SECRET: 's', DTAKO_DB: {} }

  it('認証が通れば tenant と D1 を返す', async () => {
    requireAuthMock.mockResolvedValue({ role: 'admin', tenant_id: 't1' })
    const ctx = await etcCardsContext(event(env))
    expect(ctx.tenantId).toBe('t1')
    expect(ctx.db).toBe(env.DTAKO_DB)
    expect(ctx.auth.sharedSecret).toBe('s')
  })
  it('role 不許可は 403 (D1 に触る前)', async () => {
    requireAuthMock.mockResolvedValue({ role: 'viewer', tenant_id: 't1' })
    await expect(etcCardsContext(event(env))).rejects.toMatchObject({ statusCode: 403 })
  })
  it('tenant が取れなければ 403、D1 が無ければ 503', async () => {
    requireAuthMock.mockResolvedValue({ role: 'admin' })
    await expect(etcCardsContext(event(env))).rejects.toMatchObject({ statusCode: 403 })
    requireAuthMock.mockResolvedValue({ role: 'admin', tenant_id: 't1' })
    await expect(etcCardsContext(event({ INTERNAL_SHARED_SECRET: 's' }))).rejects.toMatchObject({ statusCode: 503 })
  })
})
