import { describe, expect, it } from 'vitest'
import {
  DeviceUploadError,
  mintDeviceToken,
  uploadDtakoZip,
  uploadZipViaDevice,
  type FetchLike,
} from '../src/device-upload'

const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02])
const CREDENTIAL = { deviceId: 'dev-1', deviceSecret: 'secret-1' }

function tokenResponse(tenantId = 'tenant-a'): Response {
  return new Response(
    JSON.stringify({ access_token: 'jwt-abc', token_type: 'Bearer', expires_in: 3600, tenant_id: tenantId }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function sequenceFetch(responses: Response[]): FetchLike {
  let i = 0
  return (async () => {
    const res = responses[i]
    i += 1
    if (!res) throw new Error(`unexpected extra fetch call (#${i})`)
    return res
  }) as FetchLike
}

describe('mintDeviceToken', () => {
  it('returns the access_token when the tenant_id matches', async () => {
    const fetchImpl = sequenceFetch([tokenResponse('tenant-a')])
    const token = await mintDeviceToken('https://auth.ippoan.org', CREDENTIAL, 'tenant-a', fetchImpl)
    expect(token).toBe('jwt-abc')
  })

  it('throws when the response tenant_id does not match the expected tenant', async () => {
    const fetchImpl = sequenceFetch([tokenResponse('tenant-b')])
    await expect(mintDeviceToken('https://auth.ippoan.org', CREDENTIAL, 'tenant-a', fetchImpl)).rejects.toThrow(
      'tenant_id 不一致',
    )
  })

  it('throws on a non-2xx response', async () => {
    const fetchImpl = sequenceFetch([new Response('invalid_credential', { status: 401 })])
    await expect(mintDeviceToken('https://auth.ippoan.org', CREDENTIAL, 'tenant-a', fetchImpl)).rejects.toThrow(
      DeviceUploadError,
    )
  })
})

describe('uploadZipViaDevice', () => {
  it('returns the response body on success', async () => {
    const fetchImpl = sequenceFetch([new Response('{"records_added":12}', { status: 200 })])
    const body = await uploadZipViaDevice(
      'https://auth.ippoan.org',
      'jwt-abc',
      'csvdata.zip',
      ZIP_BYTES.buffer as ArrayBuffer,
      fetchImpl,
    )
    expect(body).toBe('{"records_added":12}')
  })

  it('throws on a non-2xx response, including the body in the message', async () => {
    const fetchImpl = sequenceFetch([new Response('forbidden', { status: 403 })])
    await expect(
      uploadZipViaDevice('https://auth.ippoan.org', 'jwt-abc', 'csvdata.zip', ZIP_BYTES.buffer as ArrayBuffer, fetchImpl),
    ).rejects.toThrow('forbidden')
  })
})

describe('uploadDtakoZip', () => {
  it('mints a token then uploads the zip', async () => {
    const fetchImpl = sequenceFetch([tokenResponse('tenant-a'), new Response('ok', { status: 200 })])
    const result = await uploadDtakoZip(
      'https://auth.ippoan.org',
      CREDENTIAL,
      'tenant-a',
      'csvdata.zip',
      ZIP_BYTES.buffer as ArrayBuffer,
      fetchImpl,
    )
    expect(result).toBe('ok')
  })

  it('propagates a tenant mismatch without attempting the upload', async () => {
    const fetchImpl = sequenceFetch([tokenResponse('tenant-b')])
    await expect(
      uploadDtakoZip(
        'https://auth.ippoan.org',
        CREDENTIAL,
        'tenant-a',
        'csvdata.zip',
        ZIP_BYTES.buffer as ArrayBuffer,
        fetchImpl,
      ),
    ).rejects.toThrow('tenant_id 不一致')
  })
})
