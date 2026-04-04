import type {
  Driver, Vehicle,
  OperationsResponse, OperationFilter, Operation,
  CsvJsonResponse, CsvType,
  UploadResponse, PendingUpload,
  DailyHoursResponse, DailyHoursFilter,
  EventClassification,
  WorkTimesResponse,
  RestraintReportFilter, RestraintReportResponse,
  ApiTokenListItem, CreateApiTokenResponse,
  TenantMember,
  SwitchTenantResponse,
  ScrapeRequest, ScrapeResponse, ScrapeHistoryItem,
  CalendarResponse,
} from '~/types'

let apiBase = ''
let getAccessToken: (() => string | null) | null = null
let getTenantId: (() => string | null) | null = null
let tokenRefresher: (() => Promise<void>) | null = null

// 同時リフレッシュ防止用
let refreshPromise: Promise<void> | null = null

export function initApi(
  baseUrl: string,
  tokenGetter?: () => string | null,
  refresher?: () => Promise<void>,
  tenantIdGetter?: () => string | null,
) {
  apiBase = baseUrl.replace(/\/$/, '')
  getAccessToken = tokenGetter || null
  tokenRefresher = refresher || null
  getTenantId = tenantIdGetter || null
}

/** 認証ヘッダーを構築 (Authorization: Bearer + X-Tenant-ID フォールバック) */
function buildAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const token = getAccessToken?.()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const tid = getTenantId?.()
  if (tid) {
    headers['X-Tenant-ID'] = tid
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

export async function getPendingUploads(): Promise<PendingUpload[]> {
  return request<PendingUpload[]>('/api/internal/pending')
}

export async function rerunUpload(uploadId: string): Promise<UploadResponse> {
  return request<UploadResponse>(`/api/internal/rerun/${encodeURIComponent(uploadId)}`, {
    method: 'POST',
  })
}

export function getUploadDownloadUrl(uploadId: string): string {
  return `${apiBase}/api/internal/download/${encodeURIComponent(uploadId)}`
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

// --- Restraint Report PDF ---

export async function downloadRestraintReportPdfSingle(year: number, month: number, driverId: string, driverName: string): Promise<void> {
  const token = getAccessToken?.()
  const headers: Record<string, string> = {}
  const tid = getTenantId?.(); if (tid) headers['X-Tenant-ID'] = tid
  const res = await fetch(`${apiBase}/api/restraint-report/pdf?year=${year}&month=${month}&driver_id=${driverId}`, { headers })
  if (!res.ok) throw new Error(`PDF生成に失敗: ${res.status}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `拘束時間管理表_${driverName}_${year}年${String(month).padStart(2, '0')}月.pdf`
  a.click()
  URL.revokeObjectURL(url)
}

export interface PdfProgressEvent {
  event: string       // "progress" | "done" | "error"
  current?: number
  total?: number
  driver_name?: string
  step?: string       // "fetch" | "render" | "save"
  data?: string       // base64 PDF data (only on "done")
  message?: string
}

export async function downloadRestraintReportPdfStream(
  year: number,
  month: number,
  onProgress: (evt: PdfProgressEvent) => void,
): Promise<void> {
  const url = `${apiBase}/api/restraint-report/pdf-stream?year=${year}&month=${month}`

  const doFetch = async () => {
    const token = getAccessToken?.()
    const headers: Record<string, string> = {}
    const tid = getTenantId?.(); if (tid) headers['X-Tenant-ID'] = tid
    return fetch(url, { headers })
  }

  let res = await doFetch()

  // 401 → トークンリフレッシュ → リトライ
  if (res.status === 401 && tokenRefresher) {
    try {
      if (!refreshPromise) {
        refreshPromise = tokenRefresher().finally(() => { refreshPromise = null })
      }
      await refreshPromise
      res = await doFetch()
    } catch {
      // リフレッシュ失敗
    }
  }

  if (!res.ok) throw new Error(`PDF生成に失敗しました: ${res.status}`)

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n')
      const message = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)

      for (const line of message.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) {
            try {
              const evt: PdfProgressEvent = JSON.parse(data)
              onProgress(evt)

              // done イベントの場合、base64をデコードしてダウンロード
              if (evt.event === 'done' && evt.data) {
                const binary = atob(evt.data)
                const bytes = new Uint8Array(binary.length)
                for (let i = 0; i < binary.length; i++) {
                  bytes[i] = binary.charCodeAt(i)
                }
                const blob = new Blob([bytes], { type: 'application/pdf' })
                const blobUrl = URL.createObjectURL(blob)
                const a = document.createElement('a')
                a.href = blobUrl
                a.download = `拘束時間管理表_${year}年${String(month).padStart(2, '0')}月.pdf`
                a.click()
                URL.revokeObjectURL(blobUrl)
              }
            } catch { /* ignore parse errors */ }
          }
        }
      }
    }
  }
}

// --- Recalculate ---

export interface RecalcProgressEvent {
  event: string
  current?: number
  total?: number
  filename?: string
  step?: string
  success?: number
  failed?: number
  message?: string
}

export async function recalculateStream(
  year: number,
  month: number,
  onProgress: (evt: RecalcProgressEvent) => void,
): Promise<void> {
  const url = `${apiBase}/api/recalculate?year=${year}&month=${month}`

  const doFetch = async () => {
    const token = getAccessToken?.()
    const headers: Record<string, string> = {}
    const tid = getTenantId?.(); if (tid) headers['X-Tenant-ID'] = tid
    return fetch(url, { method: 'POST', headers })
  }

  let res = await doFetch()

  if (res.status === 401 && tokenRefresher) {
    try {
      if (!refreshPromise) {
        refreshPromise = tokenRefresher().finally(() => { refreshPromise = null })
      }
      await refreshPromise
      res = await doFetch()
    } catch { /* ignore */ }
  }

  if (!res.ok) throw new Error(`再計算に失敗: ${res.status}`)

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n')
      const message = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of message.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) {
            try { onProgress(JSON.parse(data)) } catch { /* ignore */ }
          }
        }
      }
    }
  }
}

export async function compareRestraintCsv(file: File, driverCd?: string): Promise<any[]> {
  const formData = new FormData()
  formData.append('file', file)
  const token = getAccessToken?.()
  const headers: Record<string, string> = {}
  const tid = getTenantId?.(); if (tid) headers['X-Tenant-ID'] = tid
  const params = driverCd ? `?driver_cd=${encodeURIComponent(driverCd)}` : ''
  const res = await fetch(`${apiBase}/api/restraint-report/compare-csv${params}`, {
    method: 'POST',
    headers,
    body: formData,
  })
  if (!res.ok) throw new Error(`比較に失敗: ${res.status}`)
  return res.json()
}

export async function recalculateDriverStream(
  year: number,
  month: number,
  driverId: string,
  onProgress: (evt: RecalcProgressEvent) => void,
): Promise<void> {
  const url = `${apiBase}/api/recalculate-driver?year=${year}&month=${month}&driver_id=${driverId}`

  const doFetch = async () => {
    const token = getAccessToken?.()
    const headers: Record<string, string> = {}
    const tid = getTenantId?.(); if (tid) headers['X-Tenant-ID'] = tid
    return fetch(url, { method: 'POST', headers })
  }

  let res = await doFetch()

  if (res.status === 401 && tokenRefresher) {
    try {
      if (!refreshPromise) {
        refreshPromise = tokenRefresher().finally(() => { refreshPromise = null })
      }
      await refreshPromise
      res = await doFetch()
    } catch { /* ignore */ }
  }

  if (!res.ok) throw new Error(`再計算に失敗: ${res.status}`)

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n')
      const message = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of message.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) {
            try { onProgress(JSON.parse(data)) } catch { /* ignore */ }
          }
        }
      }
    }
  }
}

export type BatchRecalcEvent = {
  event: 'batch_start' | 'progress' | 'driver_start' | 'driver_done' | 'driver_error' | 'batch_done' | 'error'
  total_drivers?: number
  current?: number
  total?: number
  step?: string
  driver_cd?: string
  message?: string
}

export async function recalculateDriversBatch(
  year: number,
  month: number,
  driverIds: string[],
  onProgress: (evt: BatchRecalcEvent) => void,
): Promise<void> {
  const url = `${apiBase}/api/recalculate-drivers`

  const doFetch = async () => {
    const token = getAccessToken?.()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const tid = getTenantId?.(); if (tid) headers['X-Tenant-ID'] = tid
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ year, month, driver_ids: driverIds }),
    })
  }

  let res = await doFetch()

  if (res.status === 401 && tokenRefresher) {
    try {
      if (!refreshPromise) {
        refreshPromise = tokenRefresher().finally(() => { refreshPromise = null })
      }
      await refreshPromise
      res = await doFetch()
    } catch { /* ignore */ }
  }

  if (!res.ok) throw new Error(`一括再計算に失敗: ${res.status}`)

  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')

  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n')
      const message = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of message.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) {
            try { onProgress(JSON.parse(data)) } catch { /* ignore */ }
          }
        }
      }
    }
  }
}

// --- Uploads & CSV Split ---

export async function getUploads(): Promise<any[]> {
  return request<any[]>('/api/uploads')
}

export async function splitCsv(uploadId: string): Promise<any> {
  return request<any>(`/api/split-csv/${uploadId}`, { method: 'POST' })
}

export async function splitCsvAllStream(
  onProgress: (evt: any) => void,
): Promise<void> {
  const url = `${apiBase}/api/split-csv-all`
  const token = getAccessToken?.()
  const headers: Record<string, string> = {}
  const tid = getTenantId?.(); if (tid) headers['X-Tenant-ID'] = tid
  const res = await fetch(url, { method: 'POST', headers })
  if (!res.ok) throw new Error(`分割に失敗: ${res.status}`)
  const reader = res.body?.getReader()
  if (!reader) throw new Error('No response body')
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n')
      const message = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of message.split('\n')) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim()
          if (data) {
            try { onProgress(JSON.parse(data)) } catch { /* ignore */ }
          }
        }
      }
    }
  }
}

// --- Members ---

export async function getMembers(): Promise<TenantMember[]> {
  return request<TenantMember[]>('/api/members')
}

export async function inviteMember(email: string, role: string): Promise<TenantMember> {
  return request<TenantMember>('/api/members', {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  })
}

export async function updateMemberRole(email: string, role: string): Promise<void> {
  await request<void>(`/api/members/${encodeURIComponent(email)}`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
}

export async function deleteMember(email: string): Promise<void> {
  await request<void>(`/api/members/${encodeURIComponent(email)}`, { method: 'DELETE' })
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

export async function getScrapeHistory(limit = 50): Promise<ScrapeHistoryItem[]> {
  return request<ScrapeHistoryItem[]>(`/api/scraper/history?limit=${limit}`)
}

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

  const doFetch = async () => {
    const token = getAccessToken?.()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const tid = getTenantId?.(); if (tid) headers['X-Tenant-ID'] = tid
    return fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
    })
  }

  let res = await doFetch()

  // 401 → トークンリフレッシュ → リトライ
  if (res.status === 401 && tokenRefresher) {
    try {
      if (!refreshPromise) {
        refreshPromise = tokenRefresher().finally(() => { refreshPromise = null })
      }
      await refreshPromise
      res = await doFetch()
    } catch {
      // リフレッシュ失敗
    }
  }

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
