import type {
  Driver, Vehicle,
  OperationsResponse, OperationFilter, Operation,
  CsvJsonResponse, CsvType,
  UploadResponse,
  DailyHoursResponse, DailyHoursFilter,
  EventClassification,
  WorkTimesResponse,
  RestraintReportFilter, RestraintReportResponse,
  ApiTokenListItem, CreateApiTokenResponse,
  SwitchTenantResponse,
  ScrapeRequest, ScrapeResponse,
  CalendarResponse,
} from '~/types'

let apiBase = ''
let getAccessToken: (() => string | null) | null = null
let tokenRefresher: (() => Promise<void>) | null = null

// 同時リフレッシュ防止用
let refreshPromise: Promise<void> | null = null

export function initApi(
  baseUrl: string,
  tokenGetter?: () => string | null,
  refresher?: () => Promise<void>,
) {
  apiBase = baseUrl.replace(/\/$/, '')
  getAccessToken = tokenGetter || null
  tokenRefresher = refresher || null
}

/** 認証ヘッダーを構築 */
function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getAccessToken?.()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

/** フィルタを URLSearchParams に変換 */
function toParams(filter: object): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filter)) {
    if (v != null && v !== '') params.set(k, String(v))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!apiBase) throw new Error('API 未初期化: initApi() を呼んでください')

  const isFormData = options.body instanceof FormData

  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...buildAuthHeaders(),
    ...(options.headers as Record<string, string> || {}),
  }

  const res = await fetch(`${apiBase}${path}`, { ...options, headers })

  // 401 → トークンリフレッシュ → リトライ (1回のみ)
  if (res.status === 401 && tokenRefresher && getAccessToken?.()) {
    try {
      if (!refreshPromise) {
        refreshPromise = tokenRefresher().finally(() => { refreshPromise = null })
      }
      await refreshPromise

      const retryHeaders: Record<string, string> = {
        ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
        ...buildAuthHeaders(),
        ...(options.headers as Record<string, string> || {}),
      }
      const retryRes = await fetch(`${apiBase}${path}`, { ...options, headers: retryHeaders })
      if (!retryRes.ok) {
        const body = await retryRes.text().catch(() => '')
        throw new Error(`API エラー (${retryRes.status}): ${body || retryRes.statusText}`)
      }
      if (retryRes.status === 204) return undefined as T
      return retryRes.json()
    } catch {
      // リフレッシュ失敗 → 元のエラーを投げる
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API エラー (${res.status}): ${body || res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

// --- Drivers ---

export async function getDrivers(): Promise<Driver[]> {
  return request<Driver[]>('/api/drivers')
}

// --- Vehicles ---

export async function getVehicles(): Promise<Vehicle[]> {
  return request<Vehicle[]>('/api/vehicles')
}

// --- Operations ---

export async function getOperations(filter: OperationFilter = {}): Promise<OperationsResponse> {
  return request<OperationsResponse>(`/api/operations${toParams(filter)}`)
}

export async function getOperation(unkoNo: string): Promise<Operation[]> {
  return request<Operation[]>(`/api/operations/${encodeURIComponent(unkoNo)}`)
}

export async function deleteOperation(unkoNo: string): Promise<void> {
  await request<void>(`/api/operations/${encodeURIComponent(unkoNo)}`, { method: 'DELETE' })
}

// --- CSV Proxy ---

export async function getOperationCsv(unkoNo: string, csvType: CsvType): Promise<CsvJsonResponse> {
  return request<CsvJsonResponse>(`/api/operations/${encodeURIComponent(unkoNo)}/csv/${csvType}`)
}

// --- Upload ---

export async function uploadZip(file: File): Promise<UploadResponse> {
  const formData = new FormData()
  formData.append('file', file)
  return request<UploadResponse>('/api/upload', {
    method: 'POST',
    body: formData,
  })
}

// --- Event Classifications ---

export async function getEventClassifications(): Promise<EventClassification[]> {
  return request<EventClassification[]>('/api/event-classifications')
}

export async function updateEventClassification(id: string, classification: string): Promise<EventClassification> {
  return request<EventClassification>(`/api/event-classifications/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ classification }),
  })
}

// --- Daily Work Hours ---

export async function getDailyHours(filter: DailyHoursFilter = {}): Promise<DailyHoursResponse> {
  return request<DailyHoursResponse>(`/api/daily-hours${toParams(filter)}`)
}

// --- Work Times (始業・終業) ---

export async function getWorkTimes(filter: DailyHoursFilter = {}): Promise<WorkTimesResponse> {
  return request<WorkTimesResponse>(`/api/work-times${toParams(filter)}`)
}

// --- Restraint Report (拘束時間管理表) ---

export async function getRestraintReport(filter: RestraintReportFilter): Promise<RestraintReportResponse> {
  return request<RestraintReportResponse>(`/api/restraint-report${toParams(filter)}`)
}

// --- API Tokens ---

export async function getApiTokens(): Promise<ApiTokenListItem[]> {
  return request<ApiTokenListItem[]>('/api/api-tokens')
}

export async function createApiToken(name: string, expiresInDays?: number): Promise<CreateApiTokenResponse> {
  return request<CreateApiTokenResponse>('/api/api-tokens', {
    method: 'POST',
    body: JSON.stringify({ name, expires_in_days: expiresInDays ?? null }),
  })
}

export async function revokeApiToken(id: string): Promise<void> {
  await request<void>(`/api/api-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

// --- Calendar ---

export async function getCalendar(year: number, month: number): Promise<CalendarResponse> {
  return request<CalendarResponse>(`/api/operations/calendar?year=${year}&month=${month}`)
}

// --- Scraper ---

export async function triggerScrape(req: ScrapeRequest): Promise<ScrapeResponse> {
  return request<ScrapeResponse>('/api/scraper/trigger', {
    method: 'POST',
    body: JSON.stringify(req),
  })
}

export interface ScrapeProgressEvent {
  event: string    // "progress" | "result" | "done"
  comp_id?: string
  step?: string    // "login" | "download" | "upload" | "done"
  status?: string  // "success" | "error"
  message?: string
}

/**
 * SSE ストリームでスクレイプ実行。各イベントで onEvent コールバックが呼ばれる。
 */
export async function triggerScrapeStream(
  req: ScrapeRequest,
  onEvent: (evt: ScrapeProgressEvent) => void,
): Promise<void> {
  const url = `${apiBase}/api/scraper/trigger`
  const token = getAccessToken?.()
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(req),
  })

  if (!res.ok) {
    throw new Error(`Scraper error: ${res.status} ${await res.text()}`)
  }

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // SSE パース: "data: {...}\n\n"
    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n')
      const message = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)

      for (const line of message.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) {
            try {
              onEvent(JSON.parse(data))
            }
            catch { /* ignore parse errors */ }
          }
        }
      }
    }
  }
}

// --- Tenant Switching ---

export async function switchTenant(tenantId: string): Promise<SwitchTenantResponse> {
  return request<SwitchTenantResponse>('/api/auth/switch-tenant', {
    method: 'POST',
    body: JSON.stringify({ tenant_id: tenantId }),
  })
}
