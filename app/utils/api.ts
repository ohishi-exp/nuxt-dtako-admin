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
  ScrapeRequest, ScrapeHistoryItem,
  CalendarResponse,
  YTimeExportResponse,
} from '~/types'
import { createAuthFetch } from '@ippoan/auth-client'

let apiBase = ''
let getAccessToken: (() => string | null) | null = null
let getTenantId: (() => string | null) | null = null
let tokenRefresher: (() => Promise<void>) | null = null
// dtako-scraper-relay (DO) への WS 接続先。front Worker 自身が Cloudflare Tunnel /
// Workers VPC 経由で dtako-scraper に到達するため、rust-alc-api 経由の旧 SSE 経路
// (`/api/scraper/trigger`) は使わない。
let scraperRelayUrl = ''

// 同時リフレッシュ防止用 (SSE 系関数の 401 retry が使用。JSON 経路の
// single-flight は createAuthFetch 内部に持つ)
let refreshPromise: Promise<void> | null = null

// JSON 経路の transport (Authorization/X-Tenant-ID 付与 + 401→refresh→retry)
// は @ippoan/auth-client の createAuthFetch に集約 (Refs ippoan/auth-worker#257)
let authFetch: (<T>(path: string, init?: RequestInit) => Promise<T>) | null = null

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
  authFetch = apiBase
    ? createAuthFetch({
        baseUrl: apiBase,
        tokenGetter: () => getAccessToken?.() ?? null,
        tenantIdGetter: () => getTenantId?.() ?? null,
        tokenRefresher: refresher,
        errorLabel: 'API エラー',
      })
    : null
}

/** dtako-scraper-relay の WS 接続先を設定する (app.vue から一度だけ呼ぶ)。 */
export function initScraperRelay(url: string) {
  scraperRelayUrl = url.replace(/\/$/, '')
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
  if (!authFetch) throw new Error('API 未初期化: initApi() を呼んでください')
  return authFetch<T>(path, options)
}

// --- Drivers ---

export async function getDrivers(): Promise<Driver[]> {
  return request<Driver[]>('/api/drivers')
}

// --- Y時間 Export (preview / 計算結果取得) ---

/**
 * Y時間 集計結果 (xlsx 化前) を取得する。
 * `/api/y-time-export` (Worker server route → xlsx) と異なり、こちらは
 * backend (rust-alc-api) の `/api/dtako/y-time-export` を直接叩いて JSON を返す。
 * R2 binding 不要、xlsx 生成不要。プレビュー画面で使う。
 */
export async function getYTimePreview(
  driverCd: string,
  from: string,
  to: string,
): Promise<YTimeExportResponse> {
  const params = new URLSearchParams({ driver_cd: driverCd, from, to })
  return request<YTimeExportResponse>(`/api/dtako/y-time-export?${params.toString()}`)
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

export interface ScrapeHistoryEntry {
  target_date: string // "YYYY-MM-DD"
  comp_id: string
  status: string
  message?: string
}

/**
 * dtako-scraper-relay (front Worker + DO) から結果を受け取った後、履歴を
 * rust-alc-api に保存する。旧 `/api/scraper/trigger` (SSE 中継 + DB 保存) は
 * dtako-scraper が Cloud Run から到達不可能になったため廃止し、保存だけを
 * この経路 (`/api/proxy` 経由、既存の introspect + X-Tenant-ID 注入を再利用) に
 * 切り出した。
 */
export async function saveScrapeHistory(entry: ScrapeHistoryEntry): Promise<void> {
  await request<void>('/api/scraper/history', {
    method: 'POST',
    body: JSON.stringify(entry),
  })
}

export interface ScrapeProgressEvent {
  event: string    // "progress" | "result" | "done" | "error"
  comp_id?: string
  step?: string    // "login" | "download" | "upload" | "queued" | "done"
  status?: string  // "success" | "error"
  message?: string
  /**
   * SCRAPER_MODE=http (Refs ohishi-exp/dtako-scraper#22) 完了時にのみ載る、1回だけ
   * 取得できる csvdata.zip のダウンロード path (`/scraper-zip/{compId}/{requestId}`)。
   * `buildScraperZipUrl()` で絶対 URL に変換して使う。
   */
  zip_url?: string
}

/** `zip_url` (relay 相対 path) を、ダウンロード可能な絶対 https URL に変換する。
 * `scraperRelayUrl` は WS 接続用に `wss://`/`ws://` scheme で保持しているため、
 * 通常の GET には https/http に変換する必要がある。 */
export function buildScraperZipUrl(zipPath: string): string {
  const httpBase = scraperRelayUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://')
  return `${httpBase}${zipPath}`
}

function buildScraperWsUrl(req: ScrapeRequest, token: string): string {
  const params = new URLSearchParams()
  params.set('session', crypto.randomUUID())
  params.set('token', token)
  if (req.start_date) params.set('start_date', req.start_date)
  if (req.end_date) params.set('end_date', req.end_date)
  if (req.comp_id) params.set('comp_id', req.comp_id)
  if (req.skip_upload) params.set('skip_upload', 'true')
  return `${scraperRelayUrl}/ws/scraper?${params.toString()}`
}

/**
 * dtako-scraper-relay (front Worker + DO) への WebSocket でスクレイプ実行。
 * 各イベントで onEvent コールバックが呼ばれる。イベントの JSON 形式は旧 SSE 版
 * (`rust-alc-api` 経由) と同一 (`{event, comp_id, step, status, message}`)。
 *
 * rust-alc-api の `/api/scraper/trigger` (旧 SSE 中継 + SCRAPER_URL 経路) は
 * dtako-scraper が Kagoya VPS の localhost にしか bind されておらず Cloud Run
 * からは到達不可能なため廃止。front Worker (nuxt-dtako-admin) 自身が Cloudflare
 * Tunnel / Workers VPC binding 経由で直接 dtako-scraper に到達する。
 */
export function triggerScrapeStream(
  req: ScrapeRequest,
  onEvent: (evt: ScrapeProgressEvent) => void,
): Promise<void> {
  if (!scraperRelayUrl) return Promise.reject(new Error('scraper relay 未初期化'))

  const connect = (token: string, allowRetry: boolean): Promise<void> => {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(buildScraperWsUrl(req, token))
      let gotAnyMessage = false
      let settled = false

      ws.onmessage = (evt: MessageEvent) => {
        gotAnyMessage = true
        if (evt.data === 'pong') return
        try {
          const parsed = JSON.parse(evt.data) as ScrapeProgressEvent
          onEvent(parsed)
          if (parsed.event === 'done') {
            settled = true
            ws.close(1000, 'done')
            resolve()
          }
        }
        catch { /* ignore parse errors */ }
      }

      ws.onclose = () => {
        if (settled) return
        // ハンドシェイク段階 (メッセージを一度も受け取らずに切断) は認証失敗の
        // 可能性が高い。tokenRefresher があれば一度だけ再取得してリトライする。
        if (!gotAnyMessage && allowRetry && tokenRefresher) {
          settled = true
          ;(async () => {
            try {
              if (!refreshPromise) {
                refreshPromise = tokenRefresher!().finally(() => { refreshPromise = null })
              }
              await refreshPromise
              const newToken = getAccessToken?.()
              if (!newToken) throw new Error('Scraper error: no token after refresh')
              await connect(newToken, false)
              resolve()
            }
            catch (e) {
              reject(e instanceof Error ? e : new Error('Scraper error: connection failed'))
            }
          })()
          return
        }
        settled = true
        resolve()
      }

      ws.onerror = () => {
        // onclose が onerror の後に発火するのでそちらで処理する
      }
    })
  }

  const token = getAccessToken?.()
  if (!token) return Promise.reject(new Error('Scraper error: no token'))
  return connect(token, true)
}

// --- Tenant Switching ---

interface SwitchOrgResponse {
  token: string
  expires_at: string
  organization_id: string
}

export async function switchTenant(tenantId: string): Promise<SwitchTenantResponse> {
  const res = await request<SwitchOrgResponse>('/api/auth/switch-org', {
    method: 'POST',
    body: JSON.stringify({ organization_id: tenantId }),
  })
  const nowSec = Math.floor(Date.now() / 1000)
  return {
    access_token: res.token,
    expires_in: Math.max(0, Number(res.expires_at) - nowSec),
    tenant_id: res.organization_id,
  }
}
