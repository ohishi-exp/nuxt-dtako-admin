// --- Auth ---

export interface TenantInfo {
  tenant_id: string
  tenant_name: string
}

export interface AuthUser {
  id: string
  email: string
  name: string
  tenant_id: string
  role: string
  tenants?: TenantInfo[]
}

export interface AuthResponse {
  access_token: string
  refresh_token: string
  user: AuthUser
}

export interface RefreshResponse {
  access_token: string
  expires_in: number
}

export interface SwitchTenantResponse {
  access_token: string
  expires_in: number
  tenant_id: string
  tenant_name: string
}

// --- Tenant Members ---

export interface TenantMember {
  email: string
  role: string
  created_at: string
}

// --- API Tokens ---

export interface ApiTokenListItem {
  id: string
  name: string
  token_prefix: string
  expires_at: string | null
  revoked_at: string | null
  last_used_at: string | null
  created_at: string
}

export interface CreateApiTokenResponse {
  id: string
  name: string
  token: string
  token_prefix: string
}

// --- Domain ---

export interface Driver {
  id: string
  tenant_id: string
  driver_cd: string
  driver_name: string
}

export interface Vehicle {
  id: string
  tenant_id: string
  vehicle_cd: string
  vehicle_name: string
}

// --- Operations ---

export interface OperationListItem {
  id: string
  unko_no: string
  crew_role: number
  reading_date: string
  operation_date: string | null
  driver_name: string | null
  vehicle_name: string | null
  total_distance: number | null
  safety_score: number | null
  economy_score: number | null
  total_score: number | null
}

export interface OperationsResponse {
  operations: OperationListItem[]
  total: number
  page: number
  per_page: number
}

export interface Operation {
  id: string
  tenant_id: string
  unko_no: string
  crew_role: number
  reading_date: string
  operation_date: string | null
  office_id: string | null
  vehicle_id: string | null
  driver_id: string | null
  departure_at: string | null
  return_at: string | null
  garage_out_at: string | null
  garage_in_at: string | null
  meter_start: number | null
  meter_end: number | null
  total_distance: number | null
  drive_time_general: number | null
  drive_time_highway: number | null
  drive_time_bypass: number | null
  safety_score: number | null
  economy_score: number | null
  total_score: number | null
  raw_data: Record<string, unknown>
  r2_key_prefix: string | null
  uploaded_at: string
}

export interface OperationFilter {
  date_from?: string
  date_to?: string
  driver_cd?: string
  vehicle_cd?: string
  page?: number
  per_page?: number
}

// --- CSV Proxy ---

export interface CsvJsonResponse {
  headers: string[]
  rows: string[][]
}

export type CsvType = 'kudguri' | 'events' | 'tolls' | 'ferries' | 'speed'

// --- Upload ---

export interface UploadResponse {
  upload_id: string
  operations_count: number
  status: string
}

export interface PendingUpload {
  id: string
  tenant_id: string
  filename: string
  status: string
  error_message: string | null
  created_at: string
}

// --- Event Classifications ---

export interface EventClassification {
  id: string
  tenant_id: string
  event_cd: string
  event_name: string
  classification: string
  created_at: string
}

// --- Daily Work Hours ---

export interface DailyWorkHours {
  id: string
  tenant_id: string
  driver_id: string
  work_date: string
  total_work_minutes: number | null
  total_drive_minutes: number | null
  total_rest_minutes: number | null
  total_distance: number | null
  operation_count: number
  unko_nos: string[] | null
  created_at: string
  updated_at: string
}

export interface DailyHoursFilter {
  driver_id?: string
  date_from?: string
  date_to?: string
  page?: number
  per_page?: number
}

export interface DailyHoursResponse {
  items: DailyWorkHours[]
  total: number
  page: number
  per_page: number
}

// --- Work Times (始業・終業) ---

export interface WorkTimeItem {
  id: string
  driver_id: string
  work_date: string
  unko_no: string
  segment_index: number
  start_at: string
  end_at: string
  work_minutes: number
  labor_minutes: number
}

export interface WorkTimesResponse {
  items: WorkTimeItem[]
  total: number
  page: number
  per_page: number
}

// --- Scraper ---

export interface ScrapeRequest {
  start_date?: string
  end_date?: string
  comp_id?: string
  skip_upload?: boolean
}

export interface ScrapeResult {
  comp_id: string
  status: string
  message: string
}

export interface ScrapeResponse {
  results: ScrapeResult[]
}

export interface ScrapeHistoryItem {
  id: string
  target_date: string
  comp_id: string
  status: string
  message: string | null
  created_at: string
}

// --- Calendar ---

export interface ScrapeStatusEntry {
  comp_id: string
  status: string
}

export interface CalendarDateEntry {
  date: string
  count: number
  scrapes?: ScrapeStatusEntry[]
}

export interface CalendarResponse {
  year: number
  month: number
  dates: CalendarDateEntry[]
}

// --- Restraint Report (拘束時間管理表) ---

export interface RestraintReportFilter {
  driver_id: string
  year: number
  month: number
}

export interface OperationDetail {
  unko_no: string
  drive_minutes: number
  cargo_minutes: number
  break_minutes: number
  restraint_minutes: number
}

export interface RestraintDayRow {
  date: string
  is_holiday: boolean
  start_time: string | null
  end_time: string | null
  operations: OperationDetail[]
  drive_minutes: number
  cargo_minutes: number
  break_minutes: number
  restraint_total_minutes: number
  restraint_cumulative_minutes: number
  drive_average_minutes: number
  rest_period_minutes: number | null
  remarks: string
}

export interface WeeklySubtotal {
  week_end_date: string
  drive_minutes: number
  cargo_minutes: number
  break_minutes: number
  restraint_minutes: number
}

export interface MonthlyTotal {
  drive_minutes: number
  cargo_minutes: number
  break_minutes: number
  restraint_minutes: number
  fiscal_year_cumulative_minutes: number
  fiscal_year_total_minutes: number
}

export interface RestraintReportResponse {
  driver_id: string
  driver_name: string
  year: number
  month: number
  max_restraint_minutes: number
  days: RestraintDayRow[]
  weekly_subtotals: WeeklySubtotal[]
  monthly_total: MonthlyTotal
}
