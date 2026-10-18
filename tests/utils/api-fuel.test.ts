/**
 * 給油 (`/api/fuel/*`、Refs yhonda-ohishi/nginx#814) の API 関数。
 * ★ mock 専用 — 書き込み (POST/PATCH/DELETE) を含むので、`API_BASE_URL` を与えた live モードでも
 * 本物の上流を叩かせない (`api.test.ts` の `callApi` は live だと実 fetch を走らせる)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  initApi,
  getFuelStarts,
  getFuelIntank,
  getFuelUnregisteredCards,
  getFuelCars,
  getFuelCards,
  getFuelCard,
  createFuelCard,
  updateFuelCard,
  deleteFuelCard,
  updateFuelIntankDtakoRow,
  deleteFuelIntank,
  uploadFuelCsv,
  downloadFuelUpload,
} from '~/utils/api'

const BASE = 'http://test'
const SHA = 'a'.repeat(64)
let mockFetch: ReturnType<typeof vi.fn>

function okJson(data: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(data) }
}

beforeEach(() => {
  mockFetch = vi.fn().mockResolvedValue(okJson({ ok: true }))
  vi.stubGlobal('fetch', mockFetch)
  initApi(BASE, () => 'token', undefined, () => 'tid-1')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function call(i = 0): [string, RequestInit & { headers: Record<string, string> }] {
  return mockFetch.mock.calls[i] as [string, RequestInit & { headers: Record<string, string> }]
}

describe('fuel の GET', () => {
  it.each([
    ['getFuelStarts', () => getFuelStarts(), '/api/fuel/starts'],
    ['getFuelIntank()', () => getFuelIntank(), '/api/fuel/intank'],
    ['getFuelIntank(start)', () => getFuelIntank('2023-12-20 07:33:00'), '/api/fuel/intank?start=2023-12-20+07%3A33%3A00'],
    ['getFuelUnregisteredCards', () => getFuelUnregisteredCards(), '/api/fuel/unregistered-cards'],
    ['getFuelCars', () => getFuelCars(), '/api/fuel/cars'],
    ['getFuelCards', () => getFuelCards(), '/api/fuel/cards'],
    ['getFuelCard', () => getFuelCard(12), '/api/fuel/cards/12'],
  ] as [string, () => Promise<unknown>, string][])('%s → GET %s', async (_n, fn, path) => {
    const body = { ok: true, rows: [] }
    mockFetch.mockResolvedValueOnce(okJson(body))
    expect(await fn()).toEqual(body)
    expect(call()[0]).toBe(`${BASE}${path}`)
    expect(call()[1].method).toBeUndefined()
  })
})

describe('fuel の card の書き込み', () => {
  it('createFuelCard は {id, car_id} を POST する', async () => {
    await createFuelCard(40, '307200')
    const [url, init] = call()
    expect(url).toBe(`${BASE}/api/fuel/cards`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ id: 40, car_id: '307200' })
  })

  it('updateFuelCard は渡した欄だけ PATCH する (null は終了日時の解除)', async () => {
    await updateFuelCard(40, { end_datetime: null })
    const [url, init] = call()
    expect(url).toBe(`${BASE}/api/fuel/cards/40`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ end_datetime: null })
  })

  it('deleteFuelCard は DELETE する', async () => {
    await deleteFuelCard(40)
    expect(call()[0]).toBe(`${BASE}/api/fuel/cards/40`)
    expect(call()[1].method).toBe('DELETE')
  })
})

describe('fuel_intank の書き込み (path は `{datetime};{card}`)', () => {
  it('updateFuelIntankDtakoRow は datetime を符号化し、card は素のまま `;` で繋ぐ', async () => {
    await updateFuelIntankDtakoRow('2023-12-20 07:33:00', 12, '231220073300000000351')
    const [url, init] = call()
    expect(url).toBe(`${BASE}/api/fuel/intank/2023-12-20%2007%3A33%3A00;12`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ dtako_row_id: '231220073300000000351' })
  })

  it('updateFuelIntankDtakoRow の null は NULL に戻す本文', async () => {
    await updateFuelIntankDtakoRow('2023-12-20 07:33:00', 12, null)
    expect(JSON.parse(call()[1].body as string)).toEqual({ dtako_row_id: null })
  })

  it('deleteFuelIntank は同じ path を DELETE する', async () => {
    await deleteFuelIntank('2023-12-20 07:33:00', 12)
    expect(call()[0]).toBe(`${BASE}/api/fuel/intank/2023-12-20%2007%3A33%3A00;12`)
    expect(call()[1].method).toBe('DELETE')
  })
})

describe('uploadFuelCsv', () => {
  it('★ 生バイトを text/csv で送る (JSON にされない)', async () => {
    const bytes = new Uint8Array([0x5a, 0x2c, 0x0d, 0x0a]).buffer
    const res = { ok: true, key: `utran/${SHA}.csv`, inserted: 3, skipped: 1, latest_start: null }
    mockFetch.mockResolvedValueOnce(okJson(res))
    expect(await uploadFuelCsv(bytes)).toEqual(res)
    const [url, init] = call()
    expect(url).toBe(`${BASE}/api/fuel/uploads`)
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('text/csv')
    expect(init.body).toBe(bytes)
  })
})

describe('downloadFuelUpload', () => {
  function setupAnchor() {
    const anchor = { href: '', download: '', click: vi.fn() }
    vi.spyOn(document, 'createElement').mockReturnValue(anchor as unknown as HTMLElement)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    return anchor
  }

  it('Bearer と X-Tenant-ID を付けて取り、content-disposition の名前で保存する', async () => {
    const anchor = setupAnchor()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-disposition': 'attachment; filename="UTRAN20231221.CSV"' }),
      blob: () => Promise.resolve(new Blob(['x'])),
    })
    await downloadFuelUpload(SHA, '(未使用)')
    const [url, init] = call()
    expect(url).toBe(`${BASE}/api/fuel/uploads/${SHA}`)
    expect(init.headers).toEqual({ 'Authorization': 'Bearer token', 'X-Tenant-ID': 'tid-1' })
    expect(anchor.download).toBe('UTRAN20231221.CSV')
    expect(anchor.click).toHaveBeenCalled()
  })

  it('token も tenant も無ければヘッダを付けず、名前が無ければ UTRAN.CSV', async () => {
    initApi(BASE, () => null)
    const anchor = setupAnchor()
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: () => Promise.resolve(new Blob(['x'])),
    })
    await downloadFuelUpload(SHA, '(未使用)')
    expect(call()[1].headers).toEqual({})
    expect(anchor.download).toBe('UTRAN.CSV')
  })

  it('非 2xx は理由と次の一手の 1 文で投げる (R2 から消えた後の 404)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: '',
      text: async () => JSON.stringify({ ok: false, error: 'not_found' }),
    })
    await expect(downloadFuelUpload(SHA, 'CSV を取り込み直してください')).rejects.toThrow(/^404 not_found/)
  })
})
