import { describe, expect, it } from 'vitest'
import {
  AlcInternalUploadError,
  parseAlcUploadResponse,
  recalcPendingViaAlcInternalProxy,
  RECALC_PENDING_MAX_ROUNDS,
  uploadDtakoZipViaAlcInternalProxy,
  type FetchLike,
} from '../src/alc-internal-upload'

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02]).buffer as ArrayBuffer

function sequenceFetch(responses: Response[]): FetchLike {
  let i = 0
  return (async () => {
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`)
    return res
  }) as FetchLike
}

describe('uploadDtakoZipViaAlcInternalProxy', () => {
  it('sends X-Alc-Proxy-Secret / X-Tenant-ID + multipart body with field name "file"', async () => {
    let capturedUrl = ''
    let capturedInit: RequestInit | undefined
    const fetchImpl: FetchLike = (async (url: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(url)
      capturedInit = init
      return new Response('{"upload_id":"abc","operations_count":3,"status":"completed"}', { status: 200 })
    }) as FetchLike

    const result = await uploadDtakoZipViaAlcInternalProxy(
      { sharedSecret: 'shared-1', tenantId: 'tenant-a', filename: 'csvdata.zip', zipBytes: ZIP_BYTES },
      fetchImpl,
    )

    expect(result).toBe('{"upload_id":"abc","operations_count":3,"status":"completed"}')
    expect(capturedUrl).toBe('https://auth-worker.internal/alc-internal-proxy/api/upload')
    const headers = capturedInit?.headers as Record<string, string>
    expect(headers['X-Alc-Proxy-Secret']).toBe('shared-1')
    expect(headers['X-Tenant-ID']).toBe('tenant-a')
    expect(headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=/)

    const bodyText = new TextDecoder().decode(capturedInit?.body as ArrayBuffer)
    expect(bodyText).toContain('Content-Disposition: form-data; name="file"; filename="csvdata.zip"')
    expect(bodyText).toContain('Content-Type: application/zip')
  })

  it('throws AlcInternalUploadError with response body on non-2xx', async () => {
    const fetchImpl = sequenceFetch([new Response('forbidden', { status: 403 })])
    await expect(
      uploadDtakoZipViaAlcInternalProxy(
        { sharedSecret: 's', tenantId: 't', filename: 'csvdata.zip', zipBytes: ZIP_BYTES },
        fetchImpl,
      ),
    ).rejects.toThrow(AlcInternalUploadError)
    const fetchImpl2 = sequenceFetch([new Response('forbidden', { status: 403 })])
    await expect(
      uploadDtakoZipViaAlcInternalProxy(
        { sharedSecret: 's', tenantId: 't', filename: 'csvdata.zip', zipBytes: ZIP_BYTES },
        fetchImpl2,
      ),
    ).rejects.toThrow('forbidden')
  })
})

describe('parseAlcUploadResponse', () => {
  it('takes upload_id / operations_count / split_failed out of the UploadResponse', () => {
    expect(
      parseAlcUploadResponse(
        '{"upload_id":"abc","operations_count":3,"status":"completed","split_failed":2}',
      ),
    ).toEqual({ uploadId: 'abc', operationsCount: 3, splitFailed: 2 })
  })

  it('keeps split_failed: 0 as 0 (取り込み + 分割ともに成功)', () => {
    expect(parseAlcUploadResponse('{"upload_id":"abc","operations_count":0,"split_failed":0}'))
      .toEqual({ uploadId: 'abc', operationsCount: 0, splitFailed: 0 })
  })

  it('null (不明) にする — 欠落フィールドを 0 に丸めない (旧 alc に「成功」と嘘をつかないため)', () => {
    expect(parseAlcUploadResponse('{"upload_id":"abc","operations_count":3,"status":"completed"}'))
      .toEqual({ uploadId: 'abc', operationsCount: 3, splitFailed: null })
  })

  it('returns all-null for unparseable / non-object / wrong-typed bodies', () => {
    const allNull = { uploadId: null, operationsCount: null, splitFailed: null }
    expect(parseAlcUploadResponse('not json')).toEqual(allNull)
    expect(parseAlcUploadResponse('null')).toEqual(allNull)
    expect(parseAlcUploadResponse('"a string"')).toEqual(allNull)
    expect(parseAlcUploadResponse('[]')).toEqual({ ...allNull })
    expect(
      parseAlcUploadResponse('{"upload_id":"","operations_count":"3","split_failed":"2"}'),
    ).toEqual(allNull)
    expect(
      parseAlcUploadResponse('{"upload_id":7,"operations_count":null,"split_failed":null}'),
    ).toEqual(allNull)
  })

  it('rejects non-finite numbers (JSON の 1e999 は Infinity になる)', () => {
    expect(parseAlcUploadResponse('{"upload_id":"x","operations_count":1e999,"split_failed":1e999}'))
      .toEqual({ uploadId: 'x', operationsCount: null, splitFailed: null })
  })
})


describe('recalcPendingViaAlcInternalProxy', () => {
  const input = { sharedSecret: 'shared-1', tenantId: 'tenant-a' }
  const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })

  it('POSTs the internal-proxy path with the same secret / tenant headers as upload', async () => {
    let url = ''
    let init: RequestInit | undefined
    const fetchImpl: FetchLike = (async (u: RequestInfo | URL, i?: RequestInit) => {
      url = String(u)
      init = i
      return json({ processed: 3, failed: 1, remaining: 0 })
    }) as FetchLike

    const result = await recalcPendingViaAlcInternalProxy(input, fetchImpl)

    expect(url).toBe('https://auth-worker.internal/alc-internal-proxy/api/recalculate-pending')
    expect(init?.method).toBe('POST')
    const headers = init?.headers as Record<string, string>
    expect(headers['X-Alc-Proxy-Secret']).toBe('shared-1')
    expect(headers['X-Tenant-ID']).toBe('tenant-a')
    expect(result).toEqual({ processed: 3, failed: 1, remaining: 0, rounds: 1, error: null })
  })

  it('repeats until remaining is 0 and sums the counts', async () => {
    const fetchImpl = sequenceFetch([
      json({ processed: 10, failed: 1, remaining: 5 }),
      json({ processed: 4, failed: 0, remaining: 1 }),
      json({ processed: 1, failed: 0, remaining: 0 }),
    ])
    const result = await recalcPendingViaAlcInternalProxy(input, fetchImpl)
    expect(result).toEqual({ processed: 15, failed: 1, remaining: 0, rounds: 3, error: null })
  })

  it('does not repeat just because failed > 0', async () => {
    const fetchImpl = sequenceFetch([json({ processed: 0, failed: 7, remaining: 0 })])
    const result = await recalcPendingViaAlcInternalProxy(input, fetchImpl)
    expect(result.rounds).toBe(1)
    expect(result.failed).toBe(7)
  })

  it('stops at the round cap and reports remaining > 0', async () => {
    let calls = 0
    const fetchImpl: FetchLike = (async () => {
      calls += 1
      return json({ processed: 1, failed: 0, remaining: 9 })
    }) as FetchLike
    const result = await recalcPendingViaAlcInternalProxy(input, fetchImpl)
    expect(calls).toBe(RECALC_PENDING_MAX_ROUNDS)
    expect(result).toMatchObject({ rounds: RECALC_PENDING_MAX_ROUNDS, remaining: 9, error: null })
    expect(result.processed).toBe(RECALC_PENDING_MAX_ROUNDS)
  })

  it('honours an explicit maxRounds', async () => {
    const fetchImpl = sequenceFetch([json({ processed: 1, failed: 0, remaining: 9 })])
    const result = await recalcPendingViaAlcInternalProxy(input, fetchImpl, 1)
    expect(result.rounds).toBe(1)
    expect(result.remaining).toBe(9)
  })

  it('returns (does not throw) on HTTP error, keeping the counts so far', async () => {
    const fetchImpl = sequenceFetch([
      json({ processed: 2, failed: 0, remaining: 3 }),
      new Response('boom', { status: 502 }),
    ])
    const result = await recalcPendingViaAlcInternalProxy(input, fetchImpl)
    expect(result).toMatchObject({ processed: 2, remaining: 3, rounds: 2 })
    expect(result.error?.kind).toBe('http')
    expect(result.error?.message).toContain('502')
  })

  it('returns a network error (Error and non-Error rejections)', async () => {
    const asError = (async () => {
      throw new Error('connection reset')
    }) as FetchLike
    const r1 = await recalcPendingViaAlcInternalProxy(input, asError)
    expect(r1.error).toEqual({ kind: 'network', message: 'connection reset' })

    const asString = (async () => {
      throw 'plain'
    }) as unknown as FetchLike
    const r2 = await recalcPendingViaAlcInternalProxy(input, asString)
    expect(r2.error).toEqual({ kind: 'network', message: 'plain' })
  })

  it.each([
    ['not JSON', 'not json'],
    ['JSON but not an object', 'null'],
    ['a field missing', '{"processed":1,"failed":0}'],
    ['a field of the wrong type', '{"processed":"1","failed":0,"remaining":0}'],
    ['a non-finite count', '{"processed":1e999,"failed":0,"remaining":0}'],
  ])('returns a parse error when the response is %s', async (_name, body) => {
    const fetchImpl = sequenceFetch([new Response(body, { status: 200 })])
    const result = await recalcPendingViaAlcInternalProxy(input, fetchImpl)
    expect(result.error?.kind).toBe('parse')
    expect(result.rounds).toBe(1)
  })
})
