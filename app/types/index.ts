// --- Auth ---

export interface AuthUser {
  id: string
  email: string
  name: string
  tenant_id: string
  role: string
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
