/**
 * /restraint-wage 系の共有型・表示ヘルパ (Refs #244)。
 * 型は worker (workers/dtako-scraper-relay/src/{theearth-restraint-client,restraint-wage}.ts)
 * の応答と同型。
 */

/** 打刻区間 ("YYYY-MM-DD HH:MM:SS")。タイムカード由来の日にだけ入る (Refs #424 PR-E)。 */
export interface TimecardSession {
  start: string
  end: string
}

export interface RestraintSummaryDay {
  day: number
  isRestDay: boolean
  restraintMinutes: number | null
  workingMinutes: number | null
  overtimeMinutes: number | null
  nightMinutes: number | null
  overtimeNightMinutes: number | null
  /** 休日区分。タイムカード由来のみ (theearth 由来は暦を持たないので undefined)。 */
  holidayKind?: 'legal' | 'non_legal' | 'weekday'
  /** 自主出勤として賃金計算から外した実働 (分)。タイムカード由来のみ。 */
  voluntaryMinutes?: number
  /** その日の打刻区間 (中抜けがあれば 2 つ以上)。タイムカード由来のみ。 */
  sessions?: TimecardSession[]
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
  minWageTotalPay: number | null
  minWageStatutoryPay: number | null
  minWageNightPay: number | null
  totalPayDiff: number | null
  overtimeMinutes: number
  minWageOvertimeRate: number | null
  minWageOvertimePay: number | null
  actualOvertimePay: number | null
  overtimePayDiff: number | null
  nightOvertimeMinutes: number
  minWageNightOvertimeRate: number | null
  minWageNightOvertimePay: number | null
  actualNightOvertimePay: number | null
  nightOvertimePayDiff: number | null
}

export interface WageReportRow {
  summary: RestraintDriverSummary
  fetched_at: string | null
  last_verified_at: string | null
  wage: WageRow
  /** 行の出どころ (Refs #424 PR-D)。古い応答には無いので optional。 */
  source?: 'theearth' | 'timecard'
  /** 給与区分 (`SHAIN3.KKUBUN`): 1=月給 / 2=日給 / 3=時給 / 4=その他 (Refs #429)。
   * 社員マスタに無い / 未取り込みなら null。給与比較が「基本給(計算)」の
   * 単価の掛け方を決めるのに使う。 */
  pay_kubun?: number | null
}

export interface WageReportResponse {
  month: string
  rows: WageReportRow[]
  no_data_drivers: string[]
  warnings: string[]
}

/** `prefecture` は最低賃金の一括設定で入った場合の根拠県 (手入力には付かない、Refs #409)。 */
export interface WageRateEntry { effectiveFrom: string, hourlyRate: number, prefecture?: string }
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

/** 翌月 "YYYY-MM" (月末締め・翌月払いの支給月表示・給与 CSV 突合用、Refs #282)。
 * 12月は翌年1月へ繰り上がる。形式不正はそのまま返す。 */
export function nextYm(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  if (!m) return ym
  const y = parseInt(m[1]!, 10)
  const mo = parseInt(m[2]!, 10)
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}

/** 前月 "YYYY-MM" (支給月ラベル → 勤務月の逆引き)。1月は前年12月へ繰り下がる。 */
export function prevYm(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  if (!m) return ym
  const y = parseInt(m[1]!, 10)
  const mo = parseInt(m[2]!, 10)
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}`
}

/** "YYYY-MM" → "YYYY年M月"。 */
export function fmtYm(ym: string): string {
  const m = ym.match(/^(\d{4})-(\d{2})$/)
  return m ? `${m[1]}年${parseInt(m[2]!, 10)}月` : ym
}

/** 期間取得の上限 (給与DB は 1 社 10〜20 秒 × 会社数 × 月数 なので取り過ぎを防ぐ)。 */
export const MONTH_RANGE_MAX = 24

/**
 * `from`〜`to` (どちらも "YYYY-MM"、両端含む) の月を昇順で並べる。
 *
 * 逆順に指定されても入れ替えて扱う (画面で から/まで を逆に選べてしまうため)。
 * `max` 件で打ち切る — 給与DB の期間取得は 1 社 10〜20 秒かかるので、うっかり
 * 数年分を指定した時に何十分も走らせない。形式不正はどちらも空配列
 * (呼び出し側で「指定なし」として扱う)。
 */
export function monthRange(from: string, to: string, max = MONTH_RANGE_MAX): string[] {
  const valid = (ym: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(ym)
  if (!valid(from) || !valid(to)) return []
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  const out: string[] = []
  let cur = lo
  while (cur <= hi && out.length < max) {
    out.push(cur)
    cur = nextYm(cur)
  }
  return out
}
