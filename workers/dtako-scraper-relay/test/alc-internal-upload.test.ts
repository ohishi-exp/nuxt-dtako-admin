import { describe, expect, it } from 'vitest'
import {
  AlcInternalUploadError,
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
