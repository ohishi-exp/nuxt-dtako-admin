/**
 * nginx のタイムカード表との突合結果 (`GET /restraint-api/timecard-compare`) を
 * 画面に出すための型と整形 (Refs #492 PR-B)。
 *
 * 計算は relay 側 (`workers/dtako-scraper-relay/src/timecard-compare.ts`) で済んでいる。
 * ここは**表示だけ** — 判定を持たせない (両側で判定すると必ずずれる)。
 */

import { dayOfWeek } from './timecard-view'

/** 突合の状態。relay の `TimecardCompareDay["status"]` と同じ。 */
export type TimecardCompareStatus =
  | 'match'
  | 'within-tolerance'
  | 'mismatch'
  | 'nginx-only'
  | 'ours-only'
  | 'both-empty'

export interface TimecardCompareAnomaly {
  kind:
    | 'negative-kosoku'
    | 'negative-kosoku-type'
    | 'impossible-kosoku'
    | 'negative-total'
    | 'ferry-minus'
  date: string | null
  field: string | null
  minutes: number
  message: string
}

export interface TimecardCompareDay {
  date: string
  nginxMinutes: number | null
  oursMinutes: number | null
  diffMinutes: number | null
  status: TimecardCompareStatus
  /** その日に nginx が引いた同日フェリー控除 (分)。該当なしは null。 */
  ferryMinusMinutes: number | null
  anomalies: TimecardCompareAnomaly[]
}

export interface TimecardCompareResult {
  month: string
  driverCd: string
  name: string
  toleranceMinutes: number
  days: TimecardCompareDay[]
  totals: {
    nginxMinutes: number
    oursMinutes: number
    diffMinutes: number
    /** 月内のフェリー控除の合計 (分)。 */
    ferryMinusMinutes: number
  }
  mismatchCount: number
  anomalies: TimecardCompareAnomaly[]
}

export interface TimecardCompareResponse {
  month: string
  driver: string | null
  onlyAnomalies: boolean
  oursAvailable: boolean
  results: TimecardCompareResult[]
}

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const

/** 表の 1 行 (突合結果の日 + 曜日)。 */
export interface TimecardCompareRow extends TimecardCompareDay {
  /** 日 (1〜31)。 */
  day: number
  /** 曜日ラベル (日〜土)。 */
  weekdayLabel: string
  /** 日曜 (網掛けの対象。タイムカード表と揃える)。 */
  isSunday: boolean
}

/** `YYYY-MM-DD` の日別結果に曜日を添える。日付が読めない行は落とす。 */
export function toTimecardCompareRows(days: readonly TimecardCompareDay[]): TimecardCompareRow[] {
  const rows: TimecardCompareRow[] = []
  for (const d of days) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.date)
    if (!m) continue
    const dow = dayOfWeek(Number(m[1]), Number(m[2]), Number(m[3]))
    rows.push({
      ...d,
      day: Number(m[3]),
      weekdayLabel: WEEKDAY_LABELS[dow]!,
      isSunday: dow === 0,
    })
  }
  return rows
}

/** 状態の日本語ラベル。 */
export function timecardCompareStatusLabel(status: TimecardCompareStatus): string {
  switch (status) {
    case 'match': return '一致'
    case 'within-tolerance': return '許容内'
    case 'mismatch': return '差あり'
    case 'nginx-only': return 'nginx のみ'
    case 'ours-only': return 'こちらのみ'
    default: return ''
  }
}

/**
 * 行の色。**nginx 側の異常 (負の拘束など) を最優先**する — 差が無くても直す対象なので、
 * 差分の色に埋もれさせない (yhonda-ohishi/nginx#783)。
 */
export function timecardCompareRowClass(row: TimecardCompareRow): string {
  if (row.anomalies.length > 0) return 'bg-red-50 dark:bg-red-950/40'
  switch (row.status) {
    case 'mismatch': return 'bg-amber-50 dark:bg-amber-950/40'
    case 'nginx-only':
    case 'ours-only': return 'bg-orange-50 dark:bg-orange-950/40'
    case 'within-tolerance': return 'bg-gray-50 dark:bg-gray-900/40'
    default: return ''
  }
}

/** 分 → `H:MM`。null は空文字 (「行が無い」を 0 と書き分ける)。 */
export function fmtTimecardCompareMinutes(minutes: number | null): string {
  if (minutes === null) return ''
  const sign = minutes < 0 ? '-' : ''
  const abs = Math.abs(minutes)
  return `${sign}${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`
}

/** 差分 (分) → 符号つき `+H:MM`。0 は `0:00`、null は空文字。 */
export function fmtTimecardCompareDiff(minutes: number | null): string {
  if (minutes === null) return ''
  return `${minutes > 0 ? '+' : ''}${fmtTimecardCompareMinutes(minutes)}`
}

/** 見出しに出す要約。差が無くても異常があれば言う。 */
export function timecardCompareHeadline(result: TimecardCompareResult): string {
  const parts: string[] = []
  parts.push(result.mismatchCount > 0 ? `差あり ${result.mismatchCount} 日` : '差なし')
  if (result.anomalies.length > 0) parts.push(`nginx 側の異常 ${result.anomalies.length} 件`)
  // 控除は差の主因なので月計を見出しに出す (日ごとの列だけだと合計が読めない)
  if (result.totals.ferryMinusMinutes > 0) {
    parts.push(`フェリー控除 ${result.totals.ferryMinusMinutes} 分`)
  }
  return parts.join(' / ')
}

/** その月にフェリー控除が 1 日でもあるか (列を出すかの判定)。 */
export function hasFerryMinus(result: TimecardCompareResult): boolean {
  return result.totals.ferryMinusMinutes > 0
}
