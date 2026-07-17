/**
 * /restraint-wage 系の共有型・表示ヘルパ (Refs #244)。
 * 型は worker (workers/dtako-scraper-relay/src/{theearth-restraint-client,restraint-wage}.ts)
 * の応答と同型。
 */

export interface RestraintSummaryDay {
  day: number
  isRestDay: boolean
  restraintMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  nightMinutes: number | null
  overtimeNightMinutes: number | null
}

export interface RestraintDriverSummary {
  driverCd: string
  driverName: string
  branchName: string
  workDays: number
  restDays: number
  restraintMinutes: number | null
  drivingMinutes: number | null
  loadingMinutes: number | null
  breakMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  nightMinutes: number | null
  overtimeNightMinutes: number | null
  maxDailyRestraintMinutes: number | null
  fiscalCumulativeMinutes: number | null
  restraintLimitMinutes: number | null
  excessRestraintMinutes: number | null
  over15hDays: number
  avgDriving9hOverCount: number
  days: RestraintSummaryDay[]
}

export type WageCategoryKey =
  | 'statutory' | 'overtime' | 'night' | 'overtimeNight'
  | 'nonLegalHoliday' | 'nonLegalHolidayNight' | 'legalHoliday' | 'legalHolidayNight'
  | 'weekly40Excess'

export interface WageRow {
  driverCd: string
  driverName: string
  branchName: string
  hourlyRate: number | null
  minutes: Record<WageCategoryKey, number>
  amounts: Record<WageCategoryKey, number> | null
  totalAmount: number | null
  hourlyEquivalent: number | null
  minWage: { rate: number | null, prefecture: string | null, mapped: boolean }
  minWageDiff: number | null
}

export interface WageReportRow {
  summary: RestraintDriverSummary
  fetched_at: string | null
  last_verified_at: string | null
  wage: WageRow
}

export interface WageReportResponse {
  month: string
  rows: WageReportRow[]
  no_data_drivers: string[]
  warnings: string[]
}

export interface WageRateEntry { effectiveFrom: string, hourlyRate: number }
export interface WageMasterDriver { name?: string, rates: WageRateEntry[], retiredAt?: string }
export interface WageMaster { drivers: Record<string, WageMasterDriver> }

/** 最低賃金 (単価マスタタブ内、全社共通 1 本の履歴、Refs #253)。
 * worker 側の MinWageMaster (prefectures/branchToPrefecture) と互換の形で
 * 保存するが、フロントは単一の履歴だけを編集する (都道府県別マッピングはしない)。 */
export interface MinWageEntry { effectiveFrom: string, rate: number }
export interface MinWageMaster {
  prefectures: Record<string, MinWageEntry[]>
  branchToPrefecture: Record<string, string>
  defaultPrefecture?: string
}
/** minWageMaster.prefectures / defaultPrefecture に使う固定キー。 */
export const MIN_WAGE_DEFAULT_KEY = '全社共通'

export interface ArchiveCsvEntry {
  key: string
  range: string
  file: string
  kind: 'latest' | 'version' | 'history'
  size: number
  fetched_at: string | null
  last_verified_at: string | null
}

export interface ArchiveHistoryEntry { ts?: string, result?: string, sha256?: string, bytes?: number, raw?: string }

/** 時間給の法定区分列 (給与様式の並び、Refs #244)。 */
export const WAGE_COLUMNS: Array<{ key: WageCategoryKey, label: string }> = [
  { key: 'statutory', label: '法定時間内' },
  { key: 'overtime', label: '法定時間外' },
  { key: 'night', label: '深夜' },
  { key: 'overtimeNight', label: '時間外深夜' },
  { key: 'nonLegalHoliday', label: '法定外休日' },
  { key: 'nonLegalHolidayNight', label: '法定外休日深夜' },
  { key: 'legalHoliday', label: '法定休日' },
  { key: 'legalHolidayNight', label: '法定休日深夜' },
  { key: 'weekly40Excess', label: '週40超過' },
]

export const HISTORY_RESULT_LABEL: Record<string, string> = {
  'new-version': '変更あり (新版)',
  'unchanged': '変更なし',
  'no-data': '該当データなし',
}

/** 分 → "XhYYm" (null は "-")。コロン区切りは時刻と紛らわしいため h m 表記 (Refs #251)。 */
export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes == null) return '-'
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${h}h${String(m).padStart(2, '0')}m`
}

/** 円 (null は "-")。 */
export function fmtYen(v: number | null | undefined): string {
  return v == null ? '-' : v.toLocaleString('ja-JP')
}

/** "20260716T183000" (R2 版タイムスタンプ) → "2026-07-16 18:30"。 */
export function fmtArchiveTs(ts: string | null | undefined): string {
  if (!ts) return '-'
  const m = ts.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : ts
}

/** "YYYY-MM" → "YYYY年M月"。 */
export function fmtYm(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  return m ? `${m[1]}年${parseInt(m[2]!, 10)}月` : ym
}
