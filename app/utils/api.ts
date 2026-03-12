import type {
  Driver, Vehicle,
  OperationsResponse, OperationFilter, Operation,
  CsvJsonResponse, CsvType,
  UploadResponse,
  DailyHoursResponse, DailyHoursFilter,
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

// --- Daily Work Hours ---

export async function getDailyHours(filter: DailyHoursFilter = {}): Promise<DailyHoursResponse> {
  return request<DailyHoursResponse>(`/api/daily-hours${toParams(filter)}`)
}
