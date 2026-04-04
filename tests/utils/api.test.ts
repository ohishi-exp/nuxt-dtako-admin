import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest'
import {
  initApi,
  getDrivers,
  getVehicles,
  getOperations,
  getOperation,
  deleteOperation,
  getOperationCsv,
  uploadZip,
  getPendingUploads,
  rerunUpload,
  getUploadDownloadUrl,
  getEventClassifications,
  updateEventClassification,
  getDailyHours,
  getWorkTimes,
  getRestraintReport,
  getMembers,
  inviteMember,
  updateMemberRole,
  deleteMember,
  getApiTokens,
  createApiToken,
  revokeApiToken,
  getCalendar,
  getScrapeHistory,
  triggerScrape,
  switchTenant,
  getUploads,
  splitCsv,
  compareRestraintCsv,
  downloadRestraintReportPdfSingle,
  downloadRestraintReportPdfStream,
  recalculateStream,
  recalculateDriverStream,
  recalculateDriversBatch,
  triggerScrapeStream,
  splitCsvAllStream,
} from '~/utils/api'
import {
  isLive,
  mockFetch,
  setupApi,
  teardownApi,
  stubOk,
  stub204,
  stubResponse,
  callApi,
  assertMock,
  errResponse,
  API_BASE,
  restoreNativeApis,
} from '../helpers/api-test-env'

// ---------------------------------------------------------------------------
// Mock-only helpers (SSE / download)
// ---------------------------------------------------------------------------

function createSSEStream(events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const chunks = events.map(e => encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
  let i = 0
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++])
      else controller.close()
    },
  })
}

function mockStreamResponse(stream: ReadableStream<Uint8Array>, status = 200, ok = true): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: vi.fn(),
    text: vi.fn().mockResolvedValue(''),
    body: stream,
    headers: new Headers(),
  } as unknown as Response
}

function setupDownloadMocks() {
  const mockAnchor = { href: '', download: '', click: vi.fn() }
  const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLElement)
  const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://test/fake-uuid')
  const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { mockAnchor, createElementSpy, createObjectURLSpy, revokeObjectURLSpy }
}

// ===========================================================================
// Main test suite
// ===========================================================================

describe('api', () => {
  beforeAll(() => {
    if (isLive) restoreNativeApis()
  })

  beforeEach(async () => {
    await setupApi()
  })

  afterEach(() => {
    teardownApi()
  })

  // ===== initApi / request basics =====

  describe('initApi / request basics', () => {
    it('throws before initApi is called', async () => {
      initApi('')
      await expect(getDrivers()).rejects.toThrow('API 未初期化')
      // Restore for subsequent tests
      await setupApi()
    })

    it('successful JSON response', async () => {
      const drivers = [{ id: '1', driver_cd: 'D001', driver_name: 'Test' }]
      stubOk(drivers)
      await callApi(() => getDrivers())
      assertMock(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          `${API_BASE}/api/drivers`,
          expect.objectContaining({
            headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
          }),
        )
      })
    })

    it('strips trailing slash from baseUrl', async () => {
      initApi(API_BASE + '/')
      stubOk([])
      await callApi(() => getDrivers())
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/api/drivers`)
      })
    })

    it('204 returns undefined', async () => {
      stub204()
      const result = await callApi(() => deleteOperation('U001'))
      assertMock(() => {
        expect(result).toBeUndefined()
      })
    })

    it('error response throws with status and body', async () => {
      if (isLive) return
      stubResponse(errResponse(400, 'invalid params'))
      await expect(getDrivers()).rejects.toThrow('API エラー (400): invalid params')
    })

    it('error response uses statusText when text() fails', async () => {
      if (isLive) return
      stubResponse({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockRejectedValue(new Error('fail')),
      })
      await expect(getDrivers()).rejects.toThrow('API エラー (500): Internal Server Error')
    })

    it('FormData request omits Content-Type header', async () => {
      stubOk({ upload_id: '1', operations_count: 0, status: 'ok' })
      const file = new File(['zip-content'], 'test.zip', { type: 'application/zip' })
      await callApi(() => uploadZip(file))

      assertMock(() => {
        const [, opts] = mockFetch.mock.calls[0]
        expect(opts.headers).not.toHaveProperty('Content-Type')
        expect(opts.body).toBeInstanceOf(FormData)
      })
    })

    it('includes X-Tenant-ID header from tenantIdGetter', async () => {
      stubOk([])
      await callApi(() => getDrivers())

      assertMock(() => {
        const [, opts] = mockFetch.mock.calls[0]
        expect(opts.headers['X-Tenant-ID']).toBeTruthy()
      })
    })

    it('includes Authorization header when tokenGetter is provided', async () => {
      if (isLive) return
      initApi(API_BASE, () => 'my-token', undefined, () => 'tid')
      stubOk([])
      await getDrivers()

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.headers['Authorization']).toBe('Bearer my-token')
      expect(opts.headers['X-Tenant-ID']).toBe('tid')
    })

    it('omits Authorization header when tokenGetter returns null', async () => {
      if (isLive) return
      initApi(API_BASE, () => null, undefined, () => 'tid')
      stubOk([])
      await getDrivers()

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.headers).not.toHaveProperty('Authorization')
    })

    it('omits X-Tenant-ID when tenantIdGetter returns null', async () => {
      if (isLive) return
      initApi(API_BASE, undefined, undefined, () => null)
      stubOk([])
      await getDrivers()

      const [, opts] = mockFetch.mock.calls[0]
      expect(opts.headers).not.toHaveProperty('X-Tenant-ID')
    })

    it('toParams converts filter to query string', async () => {
      stubOk({ operations: [], total: 0, page: 1, per_page: 20 })
      await callApi(() => getOperations({ date_from: '2026-01-01', driver_cd: 'D001', page: 1 }))

      assertMock(() => {
        const url = mockFetch.mock.calls[0][0] as string
        expect(url).toContain('date_from=2026-01-01')
        expect(url).toContain('driver_cd=D001')
        expect(url).toContain('page=1')
      })
    })

    it('toParams skips null/undefined/empty values', async () => {
      stubOk({ operations: [], total: 0, page: 1, per_page: 20 })
      await callApi(() => getOperations({ date_from: '2026-01-01', date_to: undefined, driver_cd: '', vehicle_cd: null as unknown as string }))

      assertMock(() => {
        const url = mockFetch.mock.calls[0][0] as string
        expect(url).toContain('date_from=2026-01-01')
        expect(url).not.toContain('date_to')
        expect(url).not.toContain('driver_cd')
        expect(url).not.toContain('vehicle_cd')
      })
    })

    it('toParams returns empty when no valid values', async () => {
      stubOk({ operations: [], total: 0, page: 1, per_page: 20 })
      await callApi(() => getOperations({}))

      assertMock(() => {
        const url = mockFetch.mock.calls[0][0] as string
        expect(url).toBe(`${API_BASE}/api/operations`)
      })
    })

    it('getUploadDownloadUrl returns correct URL', () => {
      const url = getUploadDownloadUrl('upload-123')
      expect(url).toBe(`${API_BASE}/api/internal/download/upload-123`)
    })

    it('getUploadDownloadUrl encodes special characters', () => {
      const url = getUploadDownloadUrl('upload/with spaces')
      expect(url).toBe(`${API_BASE}/api/internal/download/upload%2Fwith%20spaces`)
    })
  })

  // ===== Simple GET functions =====

  describe('simple GET functions', () => {
    it.each([
      ['getDrivers', () => getDrivers(), '/api/drivers'],
      ['getVehicles', () => getVehicles(), '/api/vehicles'],
      ['getEventClassifications', () => getEventClassifications(), '/api/event-classifications'],
      ['getMembers', () => getMembers(), '/api/members'],
      ['getPendingUploads', () => getPendingUploads(), '/api/internal/pending'],
      ['getApiTokens', () => getApiTokens(), '/api/api-tokens'],
      ['getUploads', () => getUploads(), '/api/uploads'],
    ] as [string, () => Promise<unknown>, string][])('%s → GET %s', async (_name, fn, expectedPath) => {
      stubOk({})
      await callApi(fn)
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}${expectedPath}`)
      })
    })
  })

  // ===== GET with filter / params =====

  describe('GET with filter / params', () => {
    it.each([
      ['getOperations({})', () => getOperations({}), '/api/operations'],
      ['getDailyHours()', () => getDailyHours(), '/api/daily-hours'],
      ['getDailyHours({driver_id})', () => getDailyHours({ driver_id: 'D1' }), '/api/daily-hours?driver_id=D1'],
      ['getWorkTimes()', () => getWorkTimes(), '/api/work-times'],
      ['getWorkTimes({date_from})', () => getWorkTimes({ date_from: '2026-01-01' }), '/api/work-times?date_from=2026-01-01'],
    ] as [string, () => Promise<unknown>, string][])('%s → GET %s', async (_name, fn, expectedPath) => {
      stubOk({})
      await callApi(fn)
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}${expectedPath}`)
      })
    })

    it('getOperations with filter', async () => {
      stubOk({ operations: [], total: 0, page: 1, per_page: 20 })
      await callApi(() => getOperations({ date_from: '2026-01-01' }))
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toContain('/api/operations?')
      })
    })

    it('getOperation', async () => {
      stubOk([{ id: '1' }])
      await callApi(() => getOperation('U001'))
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/api/operations/U001`)
      })
    })

    it('getOperation encodes special characters', async () => {
      stubOk([])
      await callApi(() => getOperation('U/001'))
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/api/operations/U%2F001`)
      })
    })

    it('getOperationCsv', async () => {
      stubOk({ headers: [], rows: [] })
      await callApi(() => getOperationCsv('U001', 'kudguri'))
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/api/operations/U001/csv/kudguri`)
      })
    })

    it('getRestraintReport', async () => {
      stubOk({ driver_id: 'D1' })
      await callApi(() => getRestraintReport({ driver_id: 'D1', year: 2026, month: 3 }))
      assertMock(() => {
        const url = mockFetch.mock.calls[0][0] as string
        expect(url).toContain('/api/restraint-report?')
        expect(url).toContain('driver_id=D1')
        expect(url).toContain('year=2026')
        expect(url).toContain('month=3')
      })
    })

    it('getCalendar', async () => {
      stubOk({ year: 2026, month: 3, dates: [] })
      await callApi(() => getCalendar(2026, 3))
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/api/operations/calendar?year=2026&month=3`)
      })
    })

    it('getScrapeHistory with limit', async () => {
      stubOk([])
      await callApi(() => getScrapeHistory(10))
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/api/scraper/history?limit=10`)
      })
    })

    it('getScrapeHistory default limit', async () => {
      stubOk([])
      await callApi(() => getScrapeHistory())
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}/api/scraper/history?limit=50`)
      })
    })
  })

  // ===== POST functions =====

  describe('POST functions', () => {
    it.each([
      ['rerunUpload', () => rerunUpload('upload-1'), '/api/internal/rerun/upload-1'],
      ['triggerScrape', () => triggerScrape({ start_date: '2026-01-01' }), '/api/scraper/trigger'],
      ['splitCsv', () => splitCsv('upload-1'), '/api/split-csv/upload-1'],
      ['switchTenant', () => switchTenant('t2'), '/api/auth/switch-tenant'],
    ] as [string, () => Promise<unknown>, string][])('%s → POST %s', async (_name, fn, expectedPath) => {
      stubOk({})
      await callApi(fn)
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}${expectedPath}`)
        expect(mockFetch.mock.calls[0][1].method).toBe('POST')
      })
    })

    it('uploadZip', async () => {
      stubOk({ upload_id: '1', operations_count: 5, status: 'ok' })
      const file = new File(['data'], 'test.zip')
      await callApi(() => uploadZip(file))
      assertMock(() => {
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe(`${API_BASE}/api/upload`)
        expect(opts.method).toBe('POST')
      })
    })

    it('inviteMember', async () => {
      stubOk({ email: 'a@b.com', role: 'admin' })
      await callApi(() => inviteMember('a@b.com', 'admin'))
      assertMock(() => {
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe(`${API_BASE}/api/members`)
        expect(opts.method).toBe('POST')
        expect(JSON.parse(opts.body)).toEqual({ email: 'a@b.com', role: 'admin' })
      })
    })

    it('createApiToken', async () => {
      stubOk({ id: '1', name: 'test', token: 'abc', token_prefix: 'ab' })
      await callApi(() => createApiToken('test', 30))
      assertMock(() => {
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe(`${API_BASE}/api/api-tokens`)
        expect(opts.method).toBe('POST')
        expect(JSON.parse(opts.body)).toEqual({ name: 'test', expires_in_days: 30 })
      })
    })

    it('createApiToken with no expiry sends null', async () => {
      stubOk({ id: '1', name: 'test', token: 'abc', token_prefix: 'ab' })
      await callApi(() => createApiToken('test'))
      assertMock(() => {
        const body = JSON.parse(mockFetch.mock.calls[0][1].body)
        expect(body.expires_in_days).toBeNull()
      })
    })

    it('triggerScrape sends JSON body', async () => {
      stubOk({ results: [] })
      await callApi(() => triggerScrape({ start_date: '2026-01-01' }))
      assertMock(() => {
        expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ start_date: '2026-01-01' })
      })
    })

    it('switchTenant sends tenant_id', async () => {
      stubOk({ access_token: 'new', expires_in: 3600, tenant_id: 't2', tenant_name: 'T2' })
      await callApi(() => switchTenant('t2'))
      assertMock(() => {
        expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({ tenant_id: 't2' })
      })
    })
  })

  // ===== PUT/PATCH functions =====

  describe('PUT/PATCH functions', () => {
    it('updateEventClassification', async () => {
      stubOk({ id: '1', classification: 'A' })
      await callApi(() => updateEventClassification('1', 'A'))
      assertMock(() => {
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe(`${API_BASE}/api/event-classifications/1`)
        expect(opts.method).toBe('PUT')
        expect(JSON.parse(opts.body)).toEqual({ classification: 'A' })
      })
    })

    it('updateMemberRole', async () => {
      stub204()
      await callApi(() => updateMemberRole('a@b.com', 'viewer'))
      assertMock(() => {
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe(`${API_BASE}/api/members/a%40b.com`)
        expect(opts.method).toBe('PATCH')
        expect(JSON.parse(opts.body)).toEqual({ role: 'viewer' })
      })
    })
  })

  // ===== DELETE functions =====

  describe('DELETE functions', () => {
    it.each([
      ['deleteOperation', () => deleteOperation('U001'), '/api/operations/U001'],
      ['deleteMember', () => deleteMember('a@b.com'), '/api/members/a%40b.com'],
      ['revokeApiToken', () => revokeApiToken('tok-1'), '/api/api-tokens/tok-1'],
    ] as [string, () => Promise<unknown>, string][])('%s → DELETE %s', async (_name, fn, expectedPath) => {
      stub204()
      await callApi(fn)
      assertMock(() => {
        expect(mockFetch.mock.calls[0][0]).toBe(`${API_BASE}${expectedPath}`)
        expect(mockFetch.mock.calls[0][1].method).toBe('DELETE')
      })
    })
  })

  // ===== compareRestraintCsv =====

  describe('compareRestraintCsv', () => {
    it('sends FormData with file', async () => {
      stubOk([{ driver_cd: 'D001', diff: 10 }])
      const file = new File(['csv-content'], 'report.csv', { type: 'text/csv' })
      await callApi(() => compareRestraintCsv(file))
      assertMock(() => {
        const [url, opts] = mockFetch.mock.calls[0]
        expect(url).toBe(`${API_BASE}/api/restraint-report/compare-csv`)
        expect(opts.method).toBe('POST')
        expect(opts.body).toBeInstanceOf(FormData)
      })
    })

    it('includes driverCd query param when provided', async () => {
      stubOk([])
      const file = new File(['csv-content'], 'report.csv')
      await callApi(() => compareRestraintCsv(file, 'D001'))
      assertMock(() => {
        const url = mockFetch.mock.calls[0][0] as string
        expect(url).toBe(`${API_BASE}/api/restraint-report/compare-csv?driver_cd=D001`)
      })
    })

    it('encodes special characters in driverCd', async () => {
      stubOk([])
      const file = new File(['csv-content'], 'report.csv')
      await callApi(() => compareRestraintCsv(file, 'D/001'))
      assertMock(() => {
        const url = mockFetch.mock.calls[0][0] as string
        expect(url).toContain('driver_cd=D%2F001')
      })
    })

    it('omits driverCd param when not provided', async () => {
      stubOk([])
      const file = new File(['csv-content'], 'report.csv')
      await callApi(() => compareRestraintCsv(file))
      assertMock(() => {
        const url = mockFetch.mock.calls[0][0] as string
        expect(url).not.toContain('driver_cd')
      })
    })

    it('throws on non-ok response', async () => {
      if (isLive) return
      stubResponse({ ok: false, status: 400, statusText: 'Bad Request' })
      const file = new File(['csv'], 'r.csv')
      await expect(compareRestraintCsv(file)).rejects.toThrow('比較に失敗: 400')
    })
  })

  // ===========================================================================
  // Mock-only sections
  // ===========================================================================

  // ===== SSE streaming =====

  describe.runIf(!isLive)('SSE streaming', () => {
    beforeEach(() => {
      initApi('http://test', () => 'token-abc', undefined, () => 'tid-1')
    })

    it('recalculateStream parses SSE events and calls onProgress', async () => {
      const events = [
        { event: 'progress', current: 1, total: 3, filename: 'a.csv' },
        { event: 'progress', current: 2, total: 3, filename: 'b.csv' },
        { event: 'done', success: 3, failed: 0 },
      ]
      mockFetch.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await recalculateStream(2026, 3, evt => received.push(evt))

      expect(received).toEqual(events)
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('http://test/api/recalculate?year=2026&month=3')
      expect(opts.method).toBe('POST')
      expect(opts.headers['X-Tenant-ID']).toBe('tid-1')
    })

    it('recalculateStream throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })
      await expect(recalculateStream(2026, 3, () => {})).rejects.toThrow('再計算に失敗: 500')
    })

    it('recalculateStream throws when body is null', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(recalculateStream(2026, 3, () => {})).rejects.toThrow('No response body')
    })

    it('recalculateDriverStream parses SSE events', async () => {
      const events = [
        { event: 'progress', current: 1, total: 5 },
        { event: 'done', success: 5, failed: 0 },
      ]
      mockFetch.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await recalculateDriverStream(2026, 3, 'D001', evt => received.push(evt))

      expect(received).toEqual(events)
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('driver_id=D001')
    })

    it('recalculateDriverStream throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' })
      await expect(recalculateDriverStream(2026, 3, 'D001', () => {})).rejects.toThrow('再計算に失敗: 403')
    })

    it('recalculateDriverStream throws when body is null', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(recalculateDriverStream(2026, 3, 'D001', () => {})).rejects.toThrow('No response body')
    })

    it('recalculateDriversBatch sends JSON body and parses SSE', async () => {
      const events = [
        { event: 'batch_start', total_drivers: 2 },
        { event: 'driver_done', driver_cd: 'D001' },
        { event: 'batch_done' },
      ]
      mockFetch.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await recalculateDriversBatch(2026, 3, ['D001', 'D002'], evt => received.push(evt))

      expect(received).toEqual(events)
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('http://test/api/recalculate-drivers')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ year: 2026, month: 3, driver_ids: ['D001', 'D002'] })
      expect(opts.headers['Content-Type']).toBe('application/json')
    })

    it('recalculateDriversBatch throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })
      await expect(recalculateDriversBatch(2026, 3, [], () => {})).rejects.toThrow('一括再計算に失敗: 500')
    })

    it('recalculateDriversBatch throws when body is null', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(recalculateDriversBatch(2026, 3, ['D1'], () => {})).rejects.toThrow('No response body')
    })

    it('triggerScrapeStream throws when body is null', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, body: null, text: vi.fn().mockResolvedValue('') })
      await expect(triggerScrapeStream({}, () => {})).rejects.toThrow('No response body')
    })

    it('triggerScrapeStream parses SSE events', async () => {
      const events = [
        { event: 'progress', comp_id: 'C1', step: 'login' },
        { event: 'result', comp_id: 'C1', status: 'success' },
        { event: 'done' },
      ]
      mockFetch.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await triggerScrapeStream({ start_date: '2026-01-01' }, evt => received.push(evt))

      expect(received).toEqual(events)
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('http://test/api/scraper/trigger')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ start_date: '2026-01-01' })
    })

    it('triggerScrapeStream throws on non-ok with body text', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 422,
        text: vi.fn().mockResolvedValue('bad input'),
      })
      await expect(triggerScrapeStream({}, () => {})).rejects.toThrow('Scraper error: 422 bad input')
    })

    it('splitCsvAllStream parses SSE events', async () => {
      const events = [
        { event: 'progress', current: 1, total: 2 },
        { event: 'done' },
      ]
      mockFetch.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await splitCsvAllStream(evt => received.push(evt))

      expect(received).toEqual(events)
      const [url, opts] = mockFetch.mock.calls[0]
      expect(url).toBe('http://test/api/split-csv-all')
      expect(opts.method).toBe('POST')
    })

    it('splitCsvAllStream throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })
      await expect(splitCsvAllStream(() => {})).rejects.toThrow('分割に失敗: 500')
    })

    it('splitCsvAllStream throws when body is null', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(splitCsvAllStream(() => {})).rejects.toThrow('No response body')
    })

    it('downloadRestraintReportPdfStream parses SSE and triggers download on done', async () => {
      const { mockAnchor, createElementSpy, revokeObjectURLSpy } = setupDownloadMocks()
      const base64Data = btoa('fake-pdf-content')

      const events = [
        { event: 'progress', current: 1, total: 3, driver_name: 'Driver A' },
        { event: 'done', data: base64Data },
      ]
      mockFetch.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await downloadRestraintReportPdfStream(2026, 3, evt => received.push(evt))

      expect(received).toHaveLength(2)
      expect(received[0]).toEqual(events[0])
      expect((received[1] as any).event).toBe('done')

      expect(createElementSpy).toHaveBeenCalledWith('a')
      expect(mockAnchor.download).toBe('拘束時間管理表_2026年03月.pdf')
      expect(mockAnchor.click).toHaveBeenCalled()
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://test/fake-uuid')

      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toBe('http://test/api/restraint-report/pdf-stream?year=2026&month=3')
    })

    it('downloadRestraintReportPdfStream throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })
      await expect(downloadRestraintReportPdfStream(2026, 3, () => {})).rejects.toThrow('PDF生成に失敗しました: 500')
    })

    it('downloadRestraintReportPdfStream throws when body is null', async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(downloadRestraintReportPdfStream(2026, 3, () => {})).rejects.toThrow('No response body')
    })

    // --- SSE edge cases ---

    it('SSE stream ignores invalid JSON in data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: not-json\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      mockFetch.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await recalculateStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('SSE stream handles empty data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: \n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      mockFetch.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await recalculateStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('SSE stream handles non-data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      mockFetch.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await recalculateStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it.each([
      ['recalculateDriverStream', (cb: (e: unknown) => void) => recalculateDriverStream(2026, 3, 'D001', cb)],
      ['recalculateDriversBatch', (cb: (e: unknown) => void) => recalculateDriversBatch(2026, 3, ['D1'], cb)],
      ['triggerScrapeStream', (cb: (e: unknown) => void) => triggerScrapeStream({}, cb)],
      ['downloadRestraintReportPdfStream', (cb: (e: unknown) => void) => downloadRestraintReportPdfStream(2026, 3, cb)],
      ['splitCsvAllStream', (cb: (e: unknown) => void) => splitCsvAllStream(cb)],
    ] as [string, (cb: (e: unknown) => void) => Promise<void>][])('%s ignores invalid JSON in data lines', async (_name, fn) => {
      const encoder = new TextEncoder()
      const doneEvent = _name === 'recalculateDriversBatch' ? 'batch_done' : (_name === 'downloadRestraintReportPdfStream' ? 'progress' : 'done')
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {bad json}\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: doneEvent, current: 1, total: 1 })}\n\n`))
          controller.close()
        },
      })
      mockFetch.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await fn(evt => received.push(evt))
      expect(received).toEqual([{ event: doneEvent, current: 1, total: 1 }])
    })

    it.each([
      ['recalculateDriverStream', (cb: (e: unknown) => void) => recalculateDriverStream(2026, 3, 'D001', cb)],
      ['recalculateDriversBatch', (cb: (e: unknown) => void) => recalculateDriversBatch(2026, 3, ['D1'], cb)],
      ['triggerScrapeStream', (cb: (e: unknown) => void) => triggerScrapeStream({}, cb)],
      ['downloadRestraintReportPdfStream', (cb: (e: unknown) => void) => downloadRestraintReportPdfStream(2026, 3, cb)],
      ['splitCsvAllStream', (cb: (e: unknown) => void) => splitCsvAllStream(cb)],
    ] as [string, (cb: (e: unknown) => void) => Promise<void>][])('%s handles empty data lines', async (_name, fn) => {
      const encoder = new TextEncoder()
      const doneEvent = _name === 'recalculateDriversBatch' ? 'batch_done' : (_name === 'downloadRestraintReportPdfStream' ? 'progress' : 'done')
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: \n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: doneEvent, current: 1, total: 1 })}\n\n`))
          controller.close()
        },
      })
      mockFetch.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await fn(evt => received.push(evt))
      expect(received).toEqual([{ event: doneEvent, current: 1, total: 1 }])
    })

    it.each([
      ['recalculateDriverStream', (cb: (e: unknown) => void) => recalculateDriverStream(2026, 3, 'D001', cb)],
      ['recalculateDriversBatch', (cb: (e: unknown) => void) => recalculateDriversBatch(2026, 3, ['D1'], cb)],
      ['triggerScrapeStream', (cb: (e: unknown) => void) => triggerScrapeStream({}, cb)],
      ['downloadRestraintReportPdfStream', (cb: (e: unknown) => void) => downloadRestraintReportPdfStream(2026, 3, cb)],
      ['splitCsvAllStream', (cb: (e: unknown) => void) => splitCsvAllStream(cb)],
    ] as [string, (cb: (e: unknown) => void) => Promise<void>][])('%s handles non-data lines', async (_name, fn) => {
      const encoder = new TextEncoder()
      const doneEvent = _name === 'recalculateDriversBatch' ? 'batch_done' : (_name === 'downloadRestraintReportPdfStream' ? 'progress' : 'done')
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: msg\ndata: ${JSON.stringify({ event: doneEvent, current: 1, total: 1 })}\n\n`))
          controller.close()
        },
      })
      mockFetch.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await fn(evt => received.push(evt))
      expect(received).toEqual([{ event: doneEvent, current: 1, total: 1 }])
    })

    it('SSE stream handles chunked data across multiple reads', async () => {
      const encoder = new TextEncoder()
      const fullMessage = `data: ${JSON.stringify({ event: 'progress', current: 1 })}\n\n`
      const midpoint = Math.floor(fullMessage.length / 2)
      const chunk1 = encoder.encode(fullMessage.slice(0, midpoint))
      const chunk2 = encoder.encode(fullMessage.slice(midpoint))

      let i = 0
      const chunks = [chunk1, chunk2]
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(chunks[i++])
          else controller.close()
        },
      })
      mockFetch.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await recalculateStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual([{ event: 'progress', current: 1 }])
    })
  })

  // ===== 401 retry with token refresh =====

  describe.runIf(!isLive)('401 retry with token refresh', () => {
    it('recalculateStream retries on 401 after token refresh', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      initApi('http://test', () => 'token', refresher, () => 'tid')

      const events = [{ event: 'done' }]
      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await recalculateStream(2026, 3, evt => received.push(evt))

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      expect(received).toEqual(events)
    })

    it('recalculateDriverStream retries on 401', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream([{ event: 'done' }])))

      const received: unknown[] = []
      await recalculateDriverStream(2026, 3, 'D001', evt => received.push(evt))

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('recalculateDriversBatch retries on 401', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream([{ event: 'batch_done' }])))

      const received: unknown[] = []
      await recalculateDriversBatch(2026, 3, ['D1'], evt => received.push(evt))

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('downloadRestraintReportPdfStream retries on 401', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream([{ event: 'progress', current: 1, total: 1 }])))

      await downloadRestraintReportPdfStream(2026, 3, () => {})

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('triggerScrapeStream retries on 401', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream([{ event: 'done' }])))

      const received: unknown[] = []
      await triggerScrapeStream({}, evt => received.push(evt))

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('401 without tokenRefresher does not retry', async () => {
      initApi('http://test', () => 'token', undefined, () => 'tid')

      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })

      await expect(recalculateStream(2026, 3, () => {})).rejects.toThrow('再計算に失敗: 401')
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('401 retry still fails if second request is non-ok', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' })

      await expect(recalculateStream(2026, 3, () => {})).rejects.toThrow('再計算に失敗: 403')
    })

    it('401 retry handles refresher failure gracefully', async () => {
      const refresher = vi.fn().mockRejectedValue(new Error('refresh failed'))
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })

      await expect(recalculateStream(2026, 3, () => {})).rejects.toThrow('再計算に失敗: 401')
    })

    it.each([
      ['recalculateDriverStream', () => recalculateDriverStream(2026, 3, 'D001', () => {}), '再計算に失敗: 401'],
      ['recalculateDriversBatch', () => recalculateDriversBatch(2026, 3, ['D1'], () => {}), '一括再計算に失敗: 401'],
      ['triggerScrapeStream', () => triggerScrapeStream({}, () => {}), 'Scraper error: 401'],
      ['downloadRestraintReportPdfStream', () => downloadRestraintReportPdfStream(2026, 3, () => {}), 'PDF生成に失敗しました: 401'],
    ] as [string, () => Promise<void>, string][])('%s handles refresher failure gracefully', async (_name, fn, errorMsg) => {
      const refresher = vi.fn().mockRejectedValue(new Error('refresh failed'))
      initApi('http://test', () => 'token', refresher, () => 'tid')

      const resp: any = { ok: false, status: 401, statusText: 'Unauthorized' }
      if (_name === 'triggerScrapeStream') {
        resp.text = vi.fn().mockResolvedValue('Unauthorized')
      }
      mockFetch.mockResolvedValueOnce(resp)

      await expect(fn()).rejects.toThrow(errorMsg)
    })

    it('concurrent 401 retries share the same refresh promise', async () => {
      let resolveRefresh: () => void
      const refresher = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRefresh = r }))
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })

      const p1 = recalculateStream(2026, 3, () => {}).catch(() => {})
      const p2 = recalculateStream(2026, 4, () => {}).catch(() => {})

      await new Promise(r => setTimeout(r, 0))
      expect(refresher).toHaveBeenCalledTimes(1)

      resolveRefresh!()
      await Promise.all([p1, p2])
    })

    it.each([
      ['recalculateDriverStream', (m: number) => recalculateDriverStream(2026, 3, `D00${m}`, () => {})],
      ['recalculateDriversBatch', (m: number) => recalculateDriversBatch(2026, 3, [`D${m}`], () => {})],
      ['downloadRestraintReportPdfStream', (m: number) => downloadRestraintReportPdfStream(2026, m, () => {})],
    ] as [string, (m: number) => Promise<void>][])('concurrent 401 retries share refresh for %s', async (_name, fn) => {
      let resolveRefresh: () => void
      const refresher = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRefresh = r }))
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })

      const p1 = fn(1).catch(() => {})
      const p2 = fn(2).catch(() => {})

      await new Promise(r => setTimeout(r, 0))
      expect(refresher).toHaveBeenCalledTimes(1)

      resolveRefresh!()
      await Promise.all([p1, p2])
    })

    it('concurrent 401 retries share refresh for triggerScrapeStream', async () => {
      let resolveRefresh: () => void
      const refresher = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRefresh = r }))
      initApi('http://test', () => 'token', refresher, () => 'tid')

      mockFetch.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: vi.fn().mockResolvedValue('Unauthorized') })

      const p1 = triggerScrapeStream({}, () => {}).catch(() => {})
      const p2 = triggerScrapeStream({}, () => {}).catch(() => {})

      await new Promise(r => setTimeout(r, 0))
      expect(refresher).toHaveBeenCalledTimes(1)

      resolveRefresh!()
      await Promise.all([p1, p2])
    })
  })

  // ===== downloadRestraintReportPdfSingle =====

  describe.runIf(!isLive)('downloadRestraintReportPdfSingle', () => {
    beforeEach(() => {
      initApi('http://test', () => 'token', undefined, () => 'tid-1')
    })

    it('fetches PDF blob and creates download link', async () => {
      const mockBlob = new Blob(['pdf'], { type: 'application/pdf' })
      const mockBlobUrl = 'blob:http://test/pdf-uuid'
      const mockAnchor = { href: '', download: '', click: vi.fn() }

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(mockBlob),
      })
      const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLElement)
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockBlobUrl)
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

      await downloadRestraintReportPdfSingle(2026, 3, 'D001', 'Driver A')

      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toBe('http://test/api/restraint-report/pdf?year=2026&month=3&driver_id=D001')

      expect(createElementSpy).toHaveBeenCalledWith('a')
      expect(createObjectURLSpy).toHaveBeenCalledWith(mockBlob)
      expect(mockAnchor.href).toBe(mockBlobUrl)
      expect(mockAnchor.download).toBe('拘束時間管理表_Driver A_2026年03月.pdf')
      expect(mockAnchor.click).toHaveBeenCalled()
      expect(revokeObjectURLSpy).toHaveBeenCalledWith(mockBlobUrl)
    })

    it('includes X-Tenant-ID header', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob()),
      })
      setupDownloadMocks()

      await downloadRestraintReportPdfSingle(2026, 1, 'D001', 'Test')

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers['X-Tenant-ID']).toBe('tid-1')
    })

    it('formats month with zero-padding', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob()),
      })
      const { mockAnchor } = setupDownloadMocks()

      await downloadRestraintReportPdfSingle(2026, 1, 'D001', 'DriverX')

      expect(mockAnchor.download).toBe('拘束時間管理表_DriverX_2026年01月.pdf')
    })

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 })
      await expect(downloadRestraintReportPdfSingle(2026, 3, 'D001', 'Test')).rejects.toThrow('PDF生成に失敗: 500')
    })

    it('works without tenantIdGetter', async () => {
      initApi('http://test')

      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob()),
      })
      setupDownloadMocks()

      await downloadRestraintReportPdfSingle(2026, 3, 'D001', 'Test')

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })
  })

  // ===== SSE streaming without tokenGetter or tenantIdGetter =====

  describe.runIf(!isLive)('SSE streaming without tokenGetter or tenantIdGetter', () => {
    beforeEach(() => {
      initApi('http://test')
    })

    it.each([
      ['recalculateStream', (cb: (e: unknown) => void) => recalculateStream(2026, 3, cb), 'done'],
      ['recalculateDriverStream', (cb: (e: unknown) => void) => recalculateDriverStream(2026, 3, 'D001', cb), 'done'],
      ['recalculateDriversBatch', (cb: (e: unknown) => void) => recalculateDriversBatch(2026, 3, ['D1'], cb), 'batch_done'],
      ['triggerScrapeStream', (cb: (e: unknown) => void) => triggerScrapeStream({}, cb), 'done'],
      ['splitCsvAllStream', (cb: (e: unknown) => void) => splitCsvAllStream(cb), 'done'],
      ['downloadRestraintReportPdfStream', (cb: (e: unknown) => void) => downloadRestraintReportPdfStream(2026, 3, cb), 'progress'],
    ] as [string, (cb: (e: unknown) => void) => Promise<void>, string][])('%s works without tokenGetter', async (_name, fn, doneEvent) => {
      const events = [{ event: doneEvent, current: 1, total: 1 }]
      mockFetch.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await fn(evt => received.push(evt))
      expect(received).toEqual(events)
    })

    it('recalculateStream omits X-Tenant-ID header', async () => {
      mockFetch.mockResolvedValue(mockStreamResponse(createSSEStream([{ event: 'done' }])))
      await recalculateStream(2026, 3, () => {})
      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })

    it('compareRestraintCsv works without tokenGetter', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue([]),
        text: vi.fn().mockResolvedValue('[]'),
      })

      const file = new File(['csv'], 'r.csv')
      const result = await compareRestraintCsv(file)
      expect(result).toEqual([])
      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })

    it('downloadRestraintReportPdfSingle works without tokenGetter', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob()),
      })
      setupDownloadMocks()

      await downloadRestraintReportPdfSingle(2026, 3, 'D001', 'Test')
      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })
  })
})
