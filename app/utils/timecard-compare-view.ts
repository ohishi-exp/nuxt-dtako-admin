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
  /**
   * その日の差 (`nginx - ours`) をどこまで説明できたか。relay の `CompareDay["cause"]`
   * と同じ値をそのまま持つ (`"none"` / `"lunch"` / `"ferry"` / 複合形 `"a+b"` /
   * `"unknown"` = 未説明)。**ラベル訳は front で持たない** — 訳を複製すると relay 側の
   * 原因追加のたびに front が追随漏れするため、生の値をそのまま出す (Refs #606-8)。
   */
  cause: string
  /** 既知の規則で説明が付いた分 (分)。 */
  explainedMinutes: number
  /** 説明しきれずに残った差 (分)。`diffMinutes + explainedMinutes` 相当。 */
  residualMinutes: number | null
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
  /** 原因が `unknown` の日数。**検知の抜けを測る数字**。 */
  unknownCount: number
  /** 原因が `unknown` の日の残差合計 (分)。 */
  unknownMinutes: number
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

// ---- 月 × 全乗務員の一覧 (Refs #606-8) ----
//
// `driver` を付けずに取ると `results` は乗務員ごとの `TimecardCompareResult`
// (日別込み) の配列で返る。**日別を DOM に出すのは選択した 1 人だけ**にするため、
// ここで「日別を落として 1 乗務員 1 行」に畳む。relay 側にも同じ目的の
// `CompareSummaryRow` / `summarizeCompareResult`
// (`workers/dtako-scraper-relay/src/timecard-compare.ts`) があるが、front からは
// import できない (別デプロイ単位) ので**実装はコピーせずフィールドの意味と名前だけ
// 合わせて**ここに書く。将来 relay 側の応答がこの形そのものを返すようになったら、
// ここは薄いマッピングに縮められるはず。

/** 突合の全 status。0 件の status も落とさず持つ (relay の `ALL_STATUSES` と同義)。 */
const ALL_TIMECARD_COMPARE_STATUSES: TimecardCompareStatus[] = [
  'match',
  'within-tolerance',
  'mismatch',
  'nginx-only',
  'ours-only',
  'both-empty',
]

/** 1 乗務員 × 1 ヶ月の突合を、日別を落として 1 行にしたもの (relay の `CompareSummaryRow` と同義)。 */
export interface TimecardCompareSummaryRow {
  driverCd: string
  /** nginx 側の氏名。`ours-only` の乗務員は空。 */
  name: string
  /** status ごとの日数。すべての status を必ず持つ (0 も載せる)。 */
  statusDays: Record<TimecardCompareStatus, number>
  mismatchCount: number
  anomalyCount: number
  /** kind ごとの anomaly 件数。0 件の kind は載せない。 */
  anomalyKinds: Partial<Record<TimecardCompareAnomaly['kind'], number>>
  /** 推定原因 (`cause`) ごとの日数。0 件と `none` は載せない。 */
  causeDays: Partial<Record<string, number>>
  /** 未説明の日数と、その残差の合計 (分)。検知の抜けを測る数字。 */
  unknownCount: number
  unknownMinutes: number
  totals: TimecardCompareResult['totals']
  /** mismatch 日の `diffMinutes` の最小・最大。mismatch が 1 日も無ければ null。 */
  diffRange: { min: number, max: number } | null
}

/** 突合結果 1 件を 1 行に畳む。日別は落とす。 */
export function summarizeTimecardCompareResult(result: TimecardCompareResult): TimecardCompareSummaryRow {
  const statusDays = Object.fromEntries(
    ALL_TIMECARD_COMPARE_STATUSES.map(s => [s, 0]),
  ) as Record<TimecardCompareStatus, number>
  const anomalyKinds: Partial<Record<TimecardCompareAnomaly['kind'], number>> = {}
  const causeDays: Partial<Record<string, number>> = {}
  let min: number | null = null
  let max: number | null = null

  for (const day of result.days) {
    statusDays[day.status] += 1
    if (day.cause !== 'none') causeDays[day.cause] = (causeDays[day.cause] ?? 0) + 1
    // 幅は mismatch だけで取る。within-tolerance は丸めノイズ、片側欠けの日は
    // diffMinutes が null で引き算になっていない
    if (day.status === 'mismatch' && day.diffMinutes !== null) {
      min = min === null ? day.diffMinutes : Math.min(min, day.diffMinutes)
      max = max === null ? day.diffMinutes : Math.max(max, day.diffMinutes)
    }
  }
  for (const a of result.anomalies) {
    anomalyKinds[a.kind] = (anomalyKinds[a.kind] ?? 0) + 1
  }

  return {
    driverCd: result.driverCd,
    name: result.name,
    statusDays,
    mismatchCount: result.mismatchCount,
    anomalyCount: result.anomalies.length,
    anomalyKinds,
    causeDays,
    unknownCount: result.unknownCount,
    unknownMinutes: result.unknownMinutes,
    totals: result.totals,
    diffRange: min === null || max === null ? null : { min, max },
  }
}

/** 全乗務員ぶんを畳む。並び順は入力のまま。 */
export function summarizeTimecardCompareResults(
  results: readonly TimecardCompareResult[],
): TimecardCompareSummaryRow[] {
  return results.map(summarizeTimecardCompareResult)
}

/**
 * 一覧の既定の並びに揃える: **未説明の残差 (`unknownMinutes`) が大きい順**
 * (ユーザー決定 2026-08-03、Refs #606-8)。「未説明」は検知の抜けを測る数字なので、
 * これが上に来るのが運用上いちばん効く。同値は乗務員CD昇順で安定させる。
 */
export function sortTimecardCompareSummaryRows(
  rows: readonly TimecardCompareSummaryRow[],
): TimecardCompareSummaryRow[] {
  return [...rows].sort((a, b) =>
    b.unknownMinutes - a.unknownMinutes || (Number(a.driverCd) - Number(b.driverCd)))
}

/** 「未説明」列の表示: `N日 / M分`。0 件でも出す (「無い」を明示する)。 */
export function fmtTimecardCompareUnknown(row: Pick<TimecardCompareSummaryRow, 'unknownCount' | 'unknownMinutes'>): string {
  return `${row.unknownCount}日 / ${row.unknownMinutes}分`
}

/** 「差の幅」列の表示: `+H:MM〜+H:MM`。mismatch が無い月は空文字。 */
export function fmtTimecardCompareDiffRange(range: { min: number, max: number } | null): string {
  if (range === null) return ''
  return `${fmtTimecardCompareDiff(range.min)}〜${fmtTimecardCompareDiff(range.max)}`
}

/**
 * 「推定原因の内訳」列の表示。件数が多い順に `cause:件数` を並べる。
 * `cause` は relay の生の値 (英語キー) をそのまま出す — 訳語を front で複製すると
 * relay 側の追加に追随漏れするため (このファイル冒頭のコメント参照)。
 */
export function fmtTimecardCompareCauseDays(causeDays: Partial<Record<string, number>>): string {
  return Object.entries(causeDays)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cause, count]) => `${cause}:${count}`)
    .join(' / ')
}
