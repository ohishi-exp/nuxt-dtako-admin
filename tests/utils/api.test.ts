import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, type Mock } from 'vitest'
import { isLive } from '../helpers/api-test-env'

// SSE helper: creates a ReadableStream emitting SSE-formatted events
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

// Helper: create a mock Response
function mockResponse(body: unknown, status = 200, ok = true): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
    blob: vi.fn().mockResolvedValue(new Blob(['pdf-data'], { type: 'application/pdf' })),
    body: null,
    headers: new Headers(),
  } as unknown as Response
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

// Helper: set up document.createElement and URL mocks for PDF download tests
function setupDownloadMocks() {
  const mockAnchor = { href: '', download: '', click: vi.fn() }
  const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLElement)
  const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://test/fake-uuid')
  const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  return { mockAnchor, createElementSpy, createObjectURLSpy, revokeObjectURLSpy }
}

describe('api', () => {
  let api: typeof import('~/utils/api')
  let fetchMock: Mock

  beforeEach(async () => {
    vi.resetModules()
    vi.restoreAllMocks()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    api = await import('~/utils/api')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // ===== initApi / request basics =====

  describe('initApi / request basics', () => {
    it('throws before initApi is called', async () => {
      await expect(api.getDrivers()).rejects.toThrow('API 未初期化')
    })

    it('successful JSON response', async () => {
      api.initApi('http://test')
      const drivers = [{ id: '1', driver_cd: 'D001', driver_name: 'Test' }]
      fetchMock.mockResolvedValue(mockResponse(drivers))

      const result = await api.getDrivers()
      expect(result).toEqual(drivers)
      expect(fetchMock).toHaveBeenCalledWith('http://test/api/drivers', expect.objectContaining({
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }))
    })

    it('strips trailing slash from baseUrl', async () => {
      api.initApi('http://test/')
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getDrivers()
      expect(fetchMock).toHaveBeenCalledWith('http://test/api/drivers', expect.anything())
    })

    it('204 returns undefined', async () => {
      api.initApi('http://test')
      fetchMock.mockResolvedValue(mockResponse(null, 204, true))
      const result = await api.deleteOperation('U001')
      expect(result).toBeUndefined()
    })

    it('error response throws with status and body', async () => {
      api.initApi('http://test')
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: vi.fn().mockResolvedValue('invalid params'),
      })
      await expect(api.getDrivers()).rejects.toThrow('API エラー (400): invalid params')
    })

    it('error response uses statusText when text() fails', async () => {
      api.initApi('http://test')
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: vi.fn().mockRejectedValue(new Error('fail')),
      })
      await expect(api.getDrivers()).rejects.toThrow('API エラー (500): Internal Server Error')
    })

    it('FormData request omits Content-Type header', async () => {
      api.initApi('http://test')
      fetchMock.mockResolvedValue(mockResponse({ upload_id: '1', operations_count: 0, status: 'ok' }))

      const file = new File(['zip-content'], 'test.zip', { type: 'application/zip' })
      await api.uploadZip(file)

      const [, opts] = fetchMock.mock.calls[0]
      expect(opts.headers).not.toHaveProperty('Content-Type')
      expect(opts.body).toBeInstanceOf(FormData)
    })

    it('includes X-Tenant-ID header from tenantIdGetter', async () => {
      api.initApi('http://test', undefined, undefined, () => 'tenant-123')
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getDrivers()

      const [, opts] = fetchMock.mock.calls[0]
      expect(opts.headers['X-Tenant-ID']).toBe('tenant-123')
    })

    it('omits X-Tenant-ID when tenantIdGetter returns null', async () => {
      api.initApi('http://test', undefined, undefined, () => null)
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getDrivers()

      const [, opts] = fetchMock.mock.calls[0]
      expect(opts.headers).not.toHaveProperty('X-Tenant-ID')
    })

    it('toParams converts filter to query string', async () => {
      api.initApi('http://test')
      fetchMock.mockResolvedValue(mockResponse({ operations: [], total: 0, page: 1, per_page: 20 }))

      await api.getOperations({ date_from: '2026-01-01', driver_cd: 'D001', page: 1 })

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('date_from=2026-01-01')
      expect(url).toContain('driver_cd=D001')
      expect(url).toContain('page=1')
    })

    it('toParams skips null/undefined/empty values', async () => {
      api.initApi('http://test')
      fetchMock.mockResolvedValue(mockResponse({ operations: [], total: 0, page: 1, per_page: 20 }))

      await api.getOperations({ date_from: '2026-01-01', date_to: undefined, driver_cd: '', vehicle_cd: null as unknown as string })

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('date_from=2026-01-01')
      expect(url).not.toContain('date_to')
      expect(url).not.toContain('driver_cd')
      expect(url).not.toContain('vehicle_cd')
    })

    it('toParams returns empty when no valid values', async () => {
      api.initApi('http://test')
      fetchMock.mockResolvedValue(mockResponse({ operations: [], total: 0, page: 1, per_page: 20 }))

      await api.getOperations({})

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toBe('http://test/api/operations')
    })

    it('getUploadDownloadUrl returns correct URL', () => {
      api.initApi('http://test')
      const url = api.getUploadDownloadUrl('upload-123')
      expect(url).toBe('http://test/api/internal/download/upload-123')
    })

    it('getUploadDownloadUrl encodes special characters', () => {
      api.initApi('http://test')
      const url = api.getUploadDownloadUrl('upload/with spaces')
      expect(url).toBe('http://test/api/internal/download/upload%2Fwith%20spaces')
    })
  })

  // ===== CRUD functions =====

  describe('CRUD functions', () => {
    beforeEach(() => {
      api.initApi('http://test')
    })

    it('getDrivers', async () => {
      const data = [{ id: '1' }]
      fetchMock.mockResolvedValue(mockResponse(data))
      expect(await api.getDrivers()).toEqual(data)
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/drivers')
    })

    it('getVehicles', async () => {
      const data = [{ id: '1' }]
      fetchMock.mockResolvedValue(mockResponse(data))
      expect(await api.getVehicles()).toEqual(data)
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/vehicles')
    })

    it('getOperations with filter', async () => {
      fetchMock.mockResolvedValue(mockResponse({ operations: [], total: 0, page: 1, per_page: 20 }))
      await api.getOperations({ date_from: '2026-01-01' })
      expect(fetchMock.mock.calls[0][0]).toContain('/api/operations?')
    })

    it('getOperation', async () => {
      fetchMock.mockResolvedValue(mockResponse([{ id: '1' }]))
      await api.getOperation('U001')
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/operations/U001')
    })

    it('getOperation encodes special characters', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getOperation('U/001')
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/operations/U%2F001')
    })

    it('deleteOperation', async () => {
      fetchMock.mockResolvedValue(mockResponse(null, 204, true))
      await api.deleteOperation('U001')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/operations/U001')
      expect(opts.method).toBe('DELETE')
    })

    it('getOperationCsv', async () => {
      fetchMock.mockResolvedValue(mockResponse({ headers: [], rows: [] }))
      await api.getOperationCsv('U001', 'kudguri')
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/operations/U001/csv/kudguri')
    })

    it('uploadZip', async () => {
      fetchMock.mockResolvedValue(mockResponse({ upload_id: '1', operations_count: 5, status: 'ok' }))
      const file = new File(['data'], 'test.zip')
      const result = await api.uploadZip(file)
      expect(result.upload_id).toBe('1')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/upload')
      expect(opts.method).toBe('POST')
    })

    it('getPendingUploads', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getPendingUploads()
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/internal/pending')
    })

    it('rerunUpload', async () => {
      fetchMock.mockResolvedValue(mockResponse({ upload_id: '1', operations_count: 0, status: 'ok' }))
      await api.rerunUpload('upload-1')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/internal/rerun/upload-1')
      expect(opts.method).toBe('POST')
    })

    it('getEventClassifications', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getEventClassifications()
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/event-classifications')
    })

    it('updateEventClassification', async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: '1', classification: 'A' }))
      await api.updateEventClassification('1', 'A')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/event-classifications/1')
      expect(opts.method).toBe('PUT')
      expect(JSON.parse(opts.body)).toEqual({ classification: 'A' })
    })

    it('getDailyHours', async () => {
      fetchMock.mockResolvedValue(mockResponse({ items: [], total: 0, page: 1, per_page: 20 }))
      await api.getDailyHours({ driver_id: 'D1' })
      expect(fetchMock.mock.calls[0][0]).toContain('/api/daily-hours?driver_id=D1')
    })

    it('getDailyHours with no filter', async () => {
      fetchMock.mockResolvedValue(mockResponse({ items: [], total: 0, page: 1, per_page: 20 }))
      await api.getDailyHours()
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/daily-hours')
    })

    it('getWorkTimes', async () => {
      fetchMock.mockResolvedValue(mockResponse({ items: [], total: 0, page: 1, per_page: 20 }))
      await api.getWorkTimes({ date_from: '2026-01-01' })
      expect(fetchMock.mock.calls[0][0]).toContain('/api/work-times?date_from=2026-01-01')
    })

    it('getWorkTimes with no filter', async () => {
      fetchMock.mockResolvedValue(mockResponse({ items: [], total: 0, page: 1, per_page: 20 }))
      await api.getWorkTimes()
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/work-times')
    })

    it('getRestraintReport', async () => {
      fetchMock.mockResolvedValue(mockResponse({ driver_id: 'D1' }))
      await api.getRestraintReport({ driver_id: 'D1', year: 2026, month: 3 })
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('/api/restraint-report?')
      expect(url).toContain('driver_id=D1')
      expect(url).toContain('year=2026')
      expect(url).toContain('month=3')
    })

    it('getMembers', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getMembers()
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/members')
    })

    it('inviteMember', async () => {
      fetchMock.mockResolvedValue(mockResponse({ email: 'a@b.com', role: 'admin' }))
      await api.inviteMember('a@b.com', 'admin')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/members')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ email: 'a@b.com', role: 'admin' })
    })

    it('updateMemberRole', async () => {
      fetchMock.mockResolvedValue(mockResponse(null, 204, true))
      await api.updateMemberRole('a@b.com', 'viewer')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/members/a%40b.com')
      expect(opts.method).toBe('PATCH')
      expect(JSON.parse(opts.body)).toEqual({ role: 'viewer' })
    })

    it('deleteMember', async () => {
      fetchMock.mockResolvedValue(mockResponse(null, 204, true))
      await api.deleteMember('a@b.com')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/members/a%40b.com')
      expect(opts.method).toBe('DELETE')
    })

    it('getApiTokens', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getApiTokens()
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/api-tokens')
    })

    it('createApiToken', async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: '1', name: 'test', token: 'abc', token_prefix: 'ab' }))
      await api.createApiToken('test', 30)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/api-tokens')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ name: 'test', expires_in_days: 30 })
    })

    it('createApiToken with no expiry sends null', async () => {
      fetchMock.mockResolvedValue(mockResponse({ id: '1', name: 'test', token: 'abc', token_prefix: 'ab' }))
      await api.createApiToken('test')
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.expires_in_days).toBeNull()
    })

    it('revokeApiToken', async () => {
      fetchMock.mockResolvedValue(mockResponse(null, 204, true))
      await api.revokeApiToken('tok-1')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/api-tokens/tok-1')
      expect(opts.method).toBe('DELETE')
    })

    it('getCalendar', async () => {
      fetchMock.mockResolvedValue(mockResponse({ year: 2026, month: 3, dates: [] }))
      await api.getCalendar(2026, 3)
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/operations/calendar?year=2026&month=3')
    })

    it('getScrapeHistory', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getScrapeHistory(10)
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/scraper/history?limit=10')
    })

    it('getScrapeHistory default limit', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getScrapeHistory()
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/scraper/history?limit=50')
    })

    it('triggerScrape', async () => {
      fetchMock.mockResolvedValue(mockResponse({ results: [] }))
      await api.triggerScrape({ start_date: '2026-01-01' })
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/scraper/trigger')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ start_date: '2026-01-01' })
    })

    it('switchTenant', async () => {
      fetchMock.mockResolvedValue(mockResponse({ access_token: 'new', expires_in: 3600, tenant_id: 't2', tenant_name: 'T2' }))
      const result = await api.switchTenant('t2')
      expect(result.tenant_id).toBe('t2')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/auth/switch-tenant')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ tenant_id: 't2' })
    })

    it('getUploads', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))
      await api.getUploads()
      expect(fetchMock.mock.calls[0][0]).toBe('http://test/api/uploads')
    })

    it('splitCsv', async () => {
      fetchMock.mockResolvedValue(mockResponse({ status: 'ok' }))
      await api.splitCsv('upload-1')
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/split-csv/upload-1')
      expect(opts.method).toBe('POST')
    })
  })

  // ===== SSE streaming =====

  describe('SSE streaming', () => {
    beforeEach(() => {
      api.initApi('http://test', () => 'token-abc', undefined, () => 'tid-1')
    })

    it('recalculateStream parses SSE events and calls onProgress', async () => {
      const events = [
        { event: 'progress', current: 1, total: 3, filename: 'a.csv' },
        { event: 'progress', current: 2, total: 3, filename: 'b.csv' },
        { event: 'done', success: 3, failed: 0 },
      ]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.recalculateStream(2026, 3, evt => received.push(evt))

      expect(received).toEqual(events)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/recalculate?year=2026&month=3')
      expect(opts.method).toBe('POST')
      expect(opts.headers['X-Tenant-ID']).toBe('tid-1')
    })

    it('recalculateStream throws on non-ok response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })
      await expect(api.recalculateStream(2026, 3, () => {})).rejects.toThrow('再計算に失敗: 500')
    })

    it('recalculateStream throws when body is null', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(api.recalculateStream(2026, 3, () => {})).rejects.toThrow('No response body')
    })

    it('recalculateDriverStream parses SSE events', async () => {
      const events = [
        { event: 'progress', current: 1, total: 5 },
        { event: 'done', success: 5, failed: 0 },
      ]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.recalculateDriverStream(2026, 3, 'D001', evt => received.push(evt))

      expect(received).toEqual(events)
      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('driver_id=D001')
    })

    it('recalculateDriverStream throws on non-ok response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 403, statusText: 'Forbidden' })
      await expect(api.recalculateDriverStream(2026, 3, 'D001', () => {})).rejects.toThrow('再計算に失敗: 403')
    })

    it('recalculateDriverStream throws when body is null', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(api.recalculateDriverStream(2026, 3, 'D001', () => {})).rejects.toThrow('No response body')
    })

    it('recalculateDriversBatch sends JSON body and parses SSE', async () => {
      const events = [
        { event: 'batch_start', total_drivers: 2 },
        { event: 'driver_done', driver_cd: 'D001' },
        { event: 'batch_done' },
      ]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.recalculateDriversBatch(2026, 3, ['D001', 'D002'], evt => received.push(evt))

      expect(received).toEqual(events)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/recalculate-drivers')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ year: 2026, month: 3, driver_ids: ['D001', 'D002'] })
      expect(opts.headers['Content-Type']).toBe('application/json')
    })

    it('recalculateDriversBatch throws on non-ok response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })
      await expect(api.recalculateDriversBatch(2026, 3, [], () => {})).rejects.toThrow('一括再計算に失敗: 500')
    })

    it('recalculateDriversBatch throws when body is null', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(api.recalculateDriversBatch(2026, 3, ['D1'], () => {})).rejects.toThrow('No response body')
    })

    it('triggerScrapeStream throws when body is null', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, body: null, text: vi.fn().mockResolvedValue('') })
      await expect(api.triggerScrapeStream({}, () => {})).rejects.toThrow('No response body')
    })

    it('triggerScrapeStream parses SSE events', async () => {
      const events = [
        { event: 'progress', comp_id: 'C1', step: 'login' },
        { event: 'result', comp_id: 'C1', status: 'success' },
        { event: 'done' },
      ]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.triggerScrapeStream({ start_date: '2026-01-01' }, evt => received.push(evt))

      expect(received).toEqual(events)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/scraper/trigger')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ start_date: '2026-01-01' })
    })

    it('triggerScrapeStream throws on non-ok with body text', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 422,
        text: vi.fn().mockResolvedValue('bad input'),
      })
      await expect(api.triggerScrapeStream({}, () => {})).rejects.toThrow('Scraper error: 422 bad input')
    })

    it('splitCsvAllStream parses SSE events', async () => {
      const events = [
        { event: 'progress', current: 1, total: 2 },
        { event: 'done' },
      ]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.splitCsvAllStream(evt => received.push(evt))

      expect(received).toEqual(events)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/split-csv-all')
      expect(opts.method).toBe('POST')
    })

    it('splitCsvAllStream throws on non-ok response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })
      await expect(api.splitCsvAllStream(() => {})).rejects.toThrow('分割に失敗: 500')
    })

    it('splitCsvAllStream throws when body is null', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(api.splitCsvAllStream(() => {})).rejects.toThrow('No response body')
    })

    it('downloadRestraintReportPdfStream parses SSE and triggers download on done', async () => {
      const { mockAnchor, createElementSpy, revokeObjectURLSpy } = setupDownloadMocks()
      const base64Data = btoa('fake-pdf-content')

      const events = [
        { event: 'progress', current: 1, total: 3, driver_name: 'Driver A' },
        { event: 'done', data: base64Data },
      ]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.downloadRestraintReportPdfStream(2026, 3, evt => received.push(evt))

      expect(received).toHaveLength(2)
      expect(received[0]).toEqual(events[0])
      expect((received[1] as any).event).toBe('done')

      // Verify download was triggered
      expect(createElementSpy).toHaveBeenCalledWith('a')
      expect(mockAnchor.download).toBe('拘束時間管理表_2026年03月.pdf')
      expect(mockAnchor.click).toHaveBeenCalled()
      expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:http://test/fake-uuid')

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toBe('http://test/api/restraint-report/pdf-stream?year=2026&month=3')
    })

    it('downloadRestraintReportPdfStream throws on non-ok response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Error' })
      await expect(api.downloadRestraintReportPdfStream(2026, 3, () => {})).rejects.toThrow('PDF生成に失敗しました: 500')
    })

    it('downloadRestraintReportPdfStream throws when body is null', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, body: null })
      await expect(api.downloadRestraintReportPdfStream(2026, 3, () => {})).rejects.toThrow('No response body')
    })

    it('SSE stream ignores invalid JSON in data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: not-json\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateStream(2026, 3, evt => received.push(evt))

      // Invalid JSON should be silently ignored
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
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateStream(2026, 3, evt => received.push(evt))

      expect(received).toEqual([{ event: 'done' }])
    })

    it('SSE stream handles non-data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // SSE can have "event:" and "id:" lines too
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateStream(2026, 3, evt => received.push(evt))

      expect(received).toEqual([{ event: 'done' }])
    })

    it('recalculateDriverStream ignores invalid JSON in data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {bad json}\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateDriverStream(2026, 3, 'D001', evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('recalculateDriversBatch ignores invalid JSON in data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: not-valid\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'batch_done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateDriversBatch(2026, 3, ['D1'], evt => received.push(evt))
      expect(received).toEqual([{ event: 'batch_done' }])
    })

    it('triggerScrapeStream ignores invalid JSON in data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: <<<invalid\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.triggerScrapeStream({}, evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('downloadRestraintReportPdfStream ignores invalid JSON in data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: broken-json\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'progress', current: 1, total: 1 })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.downloadRestraintReportPdfStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual([{ event: 'progress', current: 1, total: 1 }])
    })

    it('splitCsvAllStream ignores invalid JSON in data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {nope}\n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.splitCsvAllStream(evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('recalculateDriverStream handles empty data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: \n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateDriverStream(2026, 3, 'D001', evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('recalculateDriverStream handles non-data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateDriverStream(2026, 3, 'D001', evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('recalculateDriversBatch handles empty data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: \n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'batch_done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateDriversBatch(2026, 3, ['D1'], evt => received.push(evt))
      expect(received).toEqual([{ event: 'batch_done' }])
    })

    it('recalculateDriversBatch handles non-data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`id: 1\ndata: ${JSON.stringify({ event: 'batch_done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateDriversBatch(2026, 3, ['D1'], evt => received.push(evt))
      expect(received).toEqual([{ event: 'batch_done' }])
    })

    it('triggerScrapeStream handles empty data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: \n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.triggerScrapeStream({}, evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('triggerScrapeStream handles non-data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: msg\ndata: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.triggerScrapeStream({}, evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('downloadRestraintReportPdfStream handles empty data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: \n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'progress', current: 1, total: 1 })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.downloadRestraintReportPdfStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual([{ event: 'progress', current: 1, total: 1 }])
    })

    it('downloadRestraintReportPdfStream handles non-data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: msg\ndata: ${JSON.stringify({ event: 'progress', current: 1, total: 1 })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.downloadRestraintReportPdfStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual([{ event: 'progress', current: 1, total: 1 }])
    })

    it('splitCsvAllStream handles non-data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`retry: 1000\ndata: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.splitCsvAllStream(evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
    })

    it('splitCsvAllStream handles empty data lines', async () => {
      const encoder = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: \n\n'))
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ event: 'done' })}\n\n`))
          controller.close()
        },
      })
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.splitCsvAllStream(evt => received.push(evt))
      expect(received).toEqual([{ event: 'done' }])
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
      fetchMock.mockResolvedValue(mockStreamResponse(stream))

      const received: unknown[] = []
      await api.recalculateStream(2026, 3, evt => received.push(evt))

      expect(received).toEqual([{ event: 'progress', current: 1 }])
    })
  })

  // ===== 401 retry with token refresh =====

  describe('401 retry with token refresh', () => {
    it('recalculateStream retries on 401 after token refresh', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      const events = [{ event: 'done' }]
      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.recalculateStream(2026, 3, evt => received.push(evt))

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(received).toEqual(events)
    })

    it('recalculateDriverStream retries on 401', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream([{ event: 'done' }])))

      const received: unknown[] = []
      await api.recalculateDriverStream(2026, 3, 'D001', evt => received.push(evt))

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('recalculateDriversBatch retries on 401', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream([{ event: 'batch_done' }])))

      const received: unknown[] = []
      await api.recalculateDriversBatch(2026, 3, ['D1'], evt => received.push(evt))

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('downloadRestraintReportPdfStream retries on 401', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream([{ event: 'progress', current: 1, total: 1 }])))

      await api.downloadRestraintReportPdfStream(2026, 3, () => {})

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('triggerScrapeStream retries on 401', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce(mockStreamResponse(createSSEStream([{ event: 'done' }])))

      const received: unknown[] = []
      await api.triggerScrapeStream({}, evt => received.push(evt))

      expect(refresher).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('401 without tokenRefresher does not retry', async () => {
      api.initApi('http://test', () => 'token', undefined, () => 'tid')

      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })

      await expect(api.recalculateStream(2026, 3, () => {})).rejects.toThrow('再計算に失敗: 401')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('401 retry still fails if second request is non-ok', async () => {
      const refresher = vi.fn().mockResolvedValue(undefined)
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock
        .mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })
        .mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' })

      await expect(api.recalculateStream(2026, 3, () => {})).rejects.toThrow('再計算に失敗: 403')
    })

    it('401 retry handles refresher failure gracefully', async () => {
      const refresher = vi.fn().mockRejectedValue(new Error('refresh failed'))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      // After refresher fails, the original 401 response is still used for the ok check
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })

      await expect(api.recalculateStream(2026, 3, () => {})).rejects.toThrow('再計算に失敗: 401')
    })

    it('recalculateDriverStream handles refresher failure gracefully', async () => {
      const refresher = vi.fn().mockRejectedValue(new Error('refresh failed'))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })

      await expect(api.recalculateDriverStream(2026, 3, 'D001', () => {})).rejects.toThrow('再計算に失敗: 401')
    })

    it('recalculateDriversBatch handles refresher failure gracefully', async () => {
      const refresher = vi.fn().mockRejectedValue(new Error('refresh failed'))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })

      await expect(api.recalculateDriversBatch(2026, 3, ['D1'], () => {})).rejects.toThrow('一括再計算に失敗: 401')
    })

    it('triggerScrapeStream handles refresher failure gracefully', async () => {
      const refresher = vi.fn().mockRejectedValue(new Error('refresh failed'))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized', text: vi.fn().mockResolvedValue('Unauthorized') })

      await expect(api.triggerScrapeStream({}, () => {})).rejects.toThrow('Scraper error: 401')
    })

    it('downloadRestraintReportPdfStream handles refresher failure gracefully', async () => {
      const refresher = vi.fn().mockRejectedValue(new Error('refresh failed'))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, statusText: 'Unauthorized' })

      await expect(api.downloadRestraintReportPdfStream(2026, 3, () => {})).rejects.toThrow('PDF生成に失敗しました: 401')
    })

    it('concurrent 401 retries share the same refresh promise', async () => {
      let resolveRefresh: () => void
      const refresher = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRefresh = r }))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      // Both calls get 401, then both should share the same refresh
      fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })

      const p1 = api.recalculateStream(2026, 3, () => {}).catch(() => {})
      const p2 = api.recalculateStream(2026, 4, () => {}).catch(() => {})

      // Wait a tick for the refresher to be called
      await new Promise(r => setTimeout(r, 0))

      // resolveRefresh should be defined; the refresher should only have been called once
      // because the second call reuses refreshPromise
      expect(refresher).toHaveBeenCalledTimes(1)

      resolveRefresh!()
      await Promise.all([p1, p2])
    })

    it('concurrent 401 retries share refresh for recalculateDriverStream', async () => {
      let resolveRefresh: () => void
      const refresher = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRefresh = r }))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })

      const p1 = api.recalculateDriverStream(2026, 3, 'D001', () => {}).catch(() => {})
      const p2 = api.recalculateDriverStream(2026, 3, 'D002', () => {}).catch(() => {})

      await new Promise(r => setTimeout(r, 0))
      expect(refresher).toHaveBeenCalledTimes(1)

      resolveRefresh!()
      await Promise.all([p1, p2])
    })

    it('concurrent 401 retries share refresh for recalculateDriversBatch', async () => {
      let resolveRefresh: () => void
      const refresher = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRefresh = r }))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })

      const p1 = api.recalculateDriversBatch(2026, 3, ['D1'], () => {}).catch(() => {})
      const p2 = api.recalculateDriversBatch(2026, 3, ['D2'], () => {}).catch(() => {})

      await new Promise(r => setTimeout(r, 0))
      expect(refresher).toHaveBeenCalledTimes(1)

      resolveRefresh!()
      await Promise.all([p1, p2])
    })

    it('concurrent 401 retries share refresh for downloadRestraintReportPdfStream', async () => {
      let resolveRefresh: () => void
      const refresher = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRefresh = r }))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' })

      const p1 = api.downloadRestraintReportPdfStream(2026, 3, () => {}).catch(() => {})
      const p2 = api.downloadRestraintReportPdfStream(2026, 4, () => {}).catch(() => {})

      await new Promise(r => setTimeout(r, 0))
      expect(refresher).toHaveBeenCalledTimes(1)

      resolveRefresh!()
      await Promise.all([p1, p2])
    })

    it('concurrent 401 retries share refresh for triggerScrapeStream', async () => {
      let resolveRefresh: () => void
      const refresher = vi.fn().mockImplementation(() => new Promise<void>((r) => { resolveRefresh = r }))
      api.initApi('http://test', () => 'token', refresher, () => 'tid')

      fetchMock.mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized', text: vi.fn().mockResolvedValue('Unauthorized') })

      const p1 = api.triggerScrapeStream({}, () => {}).catch(() => {})
      const p2 = api.triggerScrapeStream({}, () => {}).catch(() => {})

      await new Promise(r => setTimeout(r, 0))
      expect(refresher).toHaveBeenCalledTimes(1)

      resolveRefresh!()
      await Promise.all([p1, p2])
    })
  })

  // ===== no tokenGetter / no tenantIdGetter =====

  describe('SSE streaming without tokenGetter or tenantIdGetter', () => {
    it('recalculateStream works without tokenGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      const events = [{ event: 'done' }]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.recalculateStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual(events)
      // No X-Tenant-ID header
      const headers = fetchMock.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })

    it('splitCsvAllStream works without tokenGetter or tenantIdGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      const events = [{ event: 'done' }]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.splitCsvAllStream(evt => received.push(evt))
      expect(received).toEqual(events)
      const headers = fetchMock.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })

    it('downloadRestraintReportPdfStream works without tokenGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      const events = [{ event: 'progress', current: 1, total: 1 }]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.downloadRestraintReportPdfStream(2026, 3, evt => received.push(evt))
      expect(received).toEqual(events)
    })

    it('triggerScrapeStream works without tokenGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      const events = [{ event: 'done' }]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.triggerScrapeStream({}, evt => received.push(evt))
      expect(received).toEqual(events)
    })

    it('recalculateDriverStream works without tokenGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      const events = [{ event: 'done' }]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.recalculateDriverStream(2026, 3, 'D001', evt => received.push(evt))
      expect(received).toEqual(events)
    })

    it('recalculateDriversBatch works without tokenGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      const events = [{ event: 'batch_done' }]
      fetchMock.mockResolvedValue(mockStreamResponse(createSSEStream(events)))

      const received: unknown[] = []
      await api.recalculateDriversBatch(2026, 3, ['D1'], evt => received.push(evt))
      expect(received).toEqual(events)
    })

    it('compareRestraintCsv works without tokenGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      fetchMock.mockResolvedValue(mockResponse([]))

      const file = new File(['csv'], 'r.csv')
      const result = await api.compareRestraintCsv(file)
      expect(result).toEqual([])
      const headers = fetchMock.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })

    it('downloadRestraintReportPdfSingle works without tokenGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob()),
      })
      setupDownloadMocks()

      await api.downloadRestraintReportPdfSingle(2026, 3, 'D001', 'Test')
      const headers = fetchMock.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })
  })

  // ===== compareRestraintCsv =====

  describe('compareRestraintCsv', () => {
    beforeEach(() => {
      api.initApi('http://test', () => 'token', undefined, () => 'tid-1')
    })

    it('sends FormData with file', async () => {
      const responseData = [{ driver_cd: 'D001', diff: 10 }]
      fetchMock.mockResolvedValue(mockResponse(responseData))

      const file = new File(['csv-content'], 'report.csv', { type: 'text/csv' })
      const result = await api.compareRestraintCsv(file)

      expect(result).toEqual(responseData)
      const [url, opts] = fetchMock.mock.calls[0]
      expect(url).toBe('http://test/api/restraint-report/compare-csv')
      expect(opts.method).toBe('POST')
      expect(opts.body).toBeInstanceOf(FormData)
      expect(opts.headers['X-Tenant-ID']).toBe('tid-1')
    })

    it('includes driverCd query param when provided', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))

      const file = new File(['csv-content'], 'report.csv')
      await api.compareRestraintCsv(file, 'D001')

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toBe('http://test/api/restraint-report/compare-csv?driver_cd=D001')
    })

    it('encodes special characters in driverCd', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))

      const file = new File(['csv-content'], 'report.csv')
      await api.compareRestraintCsv(file, 'D/001')

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toContain('driver_cd=D%2F001')
    })

    it('omits driverCd param when not provided', async () => {
      fetchMock.mockResolvedValue(mockResponse([]))

      const file = new File(['csv-content'], 'report.csv')
      await api.compareRestraintCsv(file)

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).not.toContain('driver_cd')
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400, statusText: 'Bad Request' })
      const file = new File(['csv'], 'r.csv')
      await expect(api.compareRestraintCsv(file)).rejects.toThrow('比較に失敗: 400')
    })
  })

  // ===== downloadRestraintReportPdfSingle =====

  describe('downloadRestraintReportPdfSingle', () => {
    beforeEach(() => {
      api.initApi('http://test', () => 'token', undefined, () => 'tid-1')
    })

    it('fetches PDF blob and creates download link', async () => {
      const mockBlob = new Blob(['pdf'], { type: 'application/pdf' })
      const mockBlobUrl = 'blob:http://test/pdf-uuid'
      const mockAnchor = { href: '', download: '', click: vi.fn() }

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(mockBlob),
      })
      const createElementSpy = vi.spyOn(document, 'createElement').mockReturnValue(mockAnchor as unknown as HTMLElement)
      const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue(mockBlobUrl)
      const revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

      await api.downloadRestraintReportPdfSingle(2026, 3, 'D001', 'Driver A')

      const url = fetchMock.mock.calls[0][0] as string
      expect(url).toBe('http://test/api/restraint-report/pdf?year=2026&month=3&driver_id=D001')

      expect(createElementSpy).toHaveBeenCalledWith('a')
      expect(createObjectURLSpy).toHaveBeenCalledWith(mockBlob)
      expect(mockAnchor.href).toBe(mockBlobUrl)
      expect(mockAnchor.download).toBe('拘束時間管理表_Driver A_2026年03月.pdf')
      expect(mockAnchor.click).toHaveBeenCalled()
      expect(revokeObjectURLSpy).toHaveBeenCalledWith(mockBlobUrl)
    })

    it('includes X-Tenant-ID header', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob()),
      })
      setupDownloadMocks()

      await api.downloadRestraintReportPdfSingle(2026, 1, 'D001', 'Test')

      const headers = fetchMock.mock.calls[0][1].headers
      expect(headers['X-Tenant-ID']).toBe('tid-1')
    })

    it('formats month with zero-padding', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob()),
      })
      const { mockAnchor } = setupDownloadMocks()

      await api.downloadRestraintReportPdfSingle(2026, 1, 'D001', 'DriverX')

      expect(mockAnchor.download).toBe('拘束時間管理表_DriverX_2026年01月.pdf')
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 500 })
      await expect(api.downloadRestraintReportPdfSingle(2026, 3, 'D001', 'Test')).rejects.toThrow('PDF生成に失敗: 500')
    })

    it('works without tenantIdGetter', async () => {
      vi.resetModules()
      api = await import('~/utils/api')
      api.initApi('http://test')

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        blob: vi.fn().mockResolvedValue(new Blob()),
      })
      setupDownloadMocks()

      await api.downloadRestraintReportPdfSingle(2026, 3, 'D001', 'Test')

      const headers = fetchMock.mock.calls[0][1].headers
      expect(headers).not.toHaveProperty('X-Tenant-ID')
    })
  })
})

// ===========================================================================
// Live smoke tests (API_BASE_URL が設定されている場合のみ実行)
// ===========================================================================
describe.skipIf(!isLive)('live smoke tests', () => {
  let api: typeof import('~/utils/api')

  beforeAll(async () => {
    const { setupApi, restoreNativeApis } = await import('../helpers/api-test-env')
    restoreNativeApis()
    await setupApi()
    api = await import('~/utils/api')
  })

  it('getDrivers returns array', async () => {
    const result = await api.getDrivers()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getVehicles returns array', async () => {
    const result = await api.getVehicles()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getOperations returns paginated response', async () => {
    const result = await api.getOperations()
    expect(result).toHaveProperty('operations')
    expect(result).toHaveProperty('total')
  })

  it('getEventClassifications returns array', async () => {
    const result = await api.getEventClassifications()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getPendingUploads returns array', async () => {
    const result = await api.getPendingUploads()
    expect(Array.isArray(result)).toBe(true)
  })

  it('getUploads returns array', async () => {
    const result = await api.getUploads()
    expect(Array.isArray(result)).toBe(true)
  })
})
