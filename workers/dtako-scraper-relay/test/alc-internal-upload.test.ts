import { describe, expect, it } from 'vitest'
import {
  AlcInternalUploadError,
  parseAlcUploadResponse,
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
