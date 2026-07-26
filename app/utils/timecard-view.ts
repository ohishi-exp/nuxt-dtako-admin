/**
 * 日別サマリ → タイムカード表の行 (Refs #424 PR-E)。
 *
 * 表の形は**社内 CakePHP が既に出している PDF に合わせる** (`yhonda-ohishi/nginx`
 * の `TimeCardController::createPdf`) — 総務がその形で見慣れているため。
 *
 * ```
 *  日 | 曜 | 出勤1 | 退社1 | 出勤2 | 退社2 | 残業 | 備考
 * ```
 *
 * - **1〜月末まで全日を出す** (打刻の無い日も空行として並べる)。PDF が固定行数の
 *   用紙だったのと同じで、日付が飛ぶと目で追えなくなる
 * - 出勤2/退社2 は**中抜けの 2 回目** (`sessions[1]`)。3 回以上ある日は列に
 *   収まらないので備考に件数を出す
 * - 残業列は**打刻から計算した残業** (実働 − 所定労働時間)。給与明細の
 *   基本残業等とは別物で、両者を並べて見るのが #424 の目的
 * - 日曜は網掛け (PDF の `fill = ($ds == "日")` と同じ)
 */
import type { RestraintSummaryDay } from './restraint-wage-view'

export interface TimecardTableRow {
  /** 日 (1-31)。 */
  day: number
  /** 曜日 (0=日 … 6=土)。 */
  dow: number
  /** 曜日ラベル (日〜土)。 */
  dowLabel: string
  /** 出勤1 / 退社1 / 出勤2 / 退社2 ("HH:MM"、日跨ぎは「翌 05:30」)。打刻が無ければ null。 */
  in1: string | null
  out1: string | null
  in2: string | null
  out2: string | null
  /** 打刻計算の残業 (分、時間外 + 時間外深夜)。0 なら表示しない。 */
  overtimeMinutes: number
  /** 備考 (休暇区分 + 勤務区分 + 打刻エラー + 3 回以上の打刻の件数)。無ければ空文字。 */
  note: string
  /** 日曜 (網掛けの対象)。 */
  isSunday: boolean
  /** 打刻はあるが賃金計算から外した日 (自主出勤)。画面で色を変える。 */
  isVoluntary: boolean
  /** 打刻エラーの日 (事務職・非夜勤の日跨ぎ)。画面で赤くする (Refs #433)。 */
  isPunchError: boolean
  /** 前日が打刻エラーの日。前日の終業がこの日の打刻と組まれて行ごと消えている
   * 可能性があるので、空欄の理由として出す (Refs #433)。 */
  isAfterPunchError: boolean
}

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土']

/** その月の日数。`yearMonth` が不正なら 0。 */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return 0
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 曜日 (0=日)。UTC で計算する — ローカル TZ に依存させない。 */
export function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/

/**
 * "YYYY-MM-DD HH:MM:SS" → "HH:MM"。**その日の日付と違えば「翌 HH:MM」**を返す
 * (日跨ぎ勤務の退社時刻が前日の時刻に見えてしまうのを防ぐ)。読めない形式は null。
 */
export function formatPunch(ts: string | undefined, baseDate: string): string | null {
  if (!ts) return null
  const m = TS_RE.exec(ts)
  if (!m) return null
  const hhmm = `${m[4]}:${m[5]}`
  const date = `${m[1]}-${m[2]}-${m[3]}`
  return date === baseDate ? hhmm : `翌 ${hhmm}`
}

/** その日が打刻エラーか (事務職・非夜勤の日跨ぎ、Refs #433)。 */
export function isPunchErrorDay(d: RestraintSummaryDay | undefined): boolean {
  return (d?.punchErrorMinutes ?? 0) > 0
}

/**
 * 日別サマリ 1 件の勤務区分ラベル。通常勤務は空文字。
 *
 * **打刻エラーが最優先** — その日の時間はすべて信用できないので、休日出勤や
 * 自主出勤として説明してはいけない。
 */
export function dayKindLabel(d: RestraintSummaryDay): string {
  if (isPunchErrorDay(d)) return '打刻エラー'
  const kind = d.holidayKind
  if (d.isRestDay) {
    // 打刻はあるが賃金計算から外した日 = 自主出勤 (休みの日は空欄のまま)
    return (d.voluntaryMinutes ?? 0) > 0 ? '自主出勤' : ''
  }
  if (kind === 'legal') return '休日出勤 (法定)'
  if (kind === 'non_legal') return '休日出勤'
  return ''
}

/**
 * 日別サマリを 1〜月末のタイムカード表へ畳む。
 *
 * `days` に無い日 (欠勤・休み) も行としては出す — 空欄の行が並ぶこと自体が
 * 「その日は打刻が無い」という情報になる。
 */
export function buildTimecardTable(
  days: readonly RestraintSummaryDay[],
  year: number,
  month: number,
): TimecardTableRow[] {
  const byDay = new Map<number, RestraintSummaryDay>()
  for (const d of days) byDay.set(d.day, d)

  const rows: TimecardTableRow[] = []
  const last = daysInMonth(year, month)
  for (let day = 1; day <= last; day++) {
    const dow = dayOfWeek(year, month, day)
    const d = byDay.get(day)
    const sessions = d?.sessions ?? []
    const baseDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
    const punchError = isPunchErrorDay(d)
    // 前日の終業を押し忘れると、その打刻がこの日の打刻と組まれて**この日の行ごと消える**
    // (実データで確認)。空欄の理由が分かるように出す
    const afterPunchError = isPunchErrorDay(byDay.get(day - 1))
    const notes: string[] = []
    // 休暇区分 (公休 / 有休 / 遅刻 …) は CakePHP の PDF と同じく原文をそのまま出す
    notes.push(...(d?.leaves ?? []))
    const kind = d ? dayKindLabel(d) : ''
    if (kind) notes.push(kind)
    if (afterPunchError) notes.push('前日の打刻エラーの影響')
    // 3 回以上の打刻は 出勤2/退社2 の列に収まらないので件数だけ残す
    if (sessions.length > 2) notes.push(`打刻 ${sessions.length} 回`)

    rows.push({
      day,
      dow,
      dowLabel: DOW_LABELS[dow]!,
      in1: formatPunch(sessions[0]?.start, baseDate),
      out1: formatPunch(sessions[0]?.end, baseDate),
      in2: formatPunch(sessions[1]?.start, baseDate),
      out2: formatPunch(sessions[1]?.end, baseDate),
      overtimeMinutes: (d?.overtimeMinutes ?? 0) + (d?.overtimeNightMinutes ?? 0),
      note: notes.join(' / '),
      isSunday: dow === 0,
      isVoluntary: Boolean(d?.isRestDay && (d.voluntaryMinutes ?? 0) > 0),
      isPunchError: punchError,
      isAfterPunchError: afterPunchError,
    })
  }
  return rows
}

/** 勤務区分ごとの日数 (月次集計・給与比較の「勤務区分」列に出す)。 */
export interface WorkKindCounts {
  /** 打刻があり賃金計算に入った日のうち、残業の無い日。 */
  normal: number
  /** 残業のあった日。 */
  overtime: number
  /** 承認済み休日出勤の日。 */
  holidayWork: number
  /** 自主出勤の日 (賃金計算からは外れている)。 */
  voluntary: number
  /** 自主出勤の実働合計 (分)。 */
  voluntaryMinutes: number
  /** 打刻エラーの日 (賃金計算からは外れている、Refs #433)。 */
  punchError: number
  /** 打刻エラーとして外した拘束の合計 (分)。 */
  punchErrorMinutes: number
  /** 公休日数 (公休 / 泊休 / 積置泊休 / 指休)。 */
  publicHoliday: number
  /** 有休日数 (有休 = 1.0、前休 / 後休 = 0.5)。 */
  paidLeave: number
  /** 欠勤日数。 */
  absence: number
}

/** 1 日 1.0 と数える休暇 → 集計軸。worker 側 `countLeaves` と同一規則
 * (worker を app から import できないため実装は 2 箇所になる。変える時は両方)。 */
const LEAVE_FULL_DAY: Record<string, 'publicHoliday' | 'paidLeave' | 'absence'> = {
  公休: 'publicHoliday',
  泊休: 'publicHoliday',
  積置泊休: 'publicHoliday',
  指休: 'publicHoliday',
  有休: 'paidLeave',
  欠勤: 'absence',
}

/** 0.5 日と数える休暇 (半休)。 */
const LEAVE_HALF_DAY = new Set(['前休', '後休', '前休作', '後休作'])

/**
 * 日別サマリから勤務区分の日数を数える。
 *
 * theearth 由来の日 (`holidayKind` を持たない) は休日出勤の判定ができないので、
 * 残業の有無だけで normal / overtime に分かれる。タイムカード由来と混ぜて数えない
 * ように、呼び出し側は source で絞ること。
 *
 * **打刻エラーは他のどの区分にも入れない** (Refs #433) — その日の時間は信用できず、
 * 休日出勤とも自主出勤とも言えないため。
 */
export function countWorkKinds(days: readonly RestraintSummaryDay[]): WorkKindCounts {
  const out: WorkKindCounts = {
    normal: 0,
    overtime: 0,
    holidayWork: 0,
    voluntary: 0,
    voluntaryMinutes: 0,
    punchError: 0,
    punchErrorMinutes: 0,
    publicHoliday: 0,
    paidLeave: 0,
    absence: 0,
  }
  for (const d of days) {
    for (const detail of d.leaves ?? []) {
      const full = LEAVE_FULL_DAY[detail]
      if (full) out[full] += 1
      else if (LEAVE_HALF_DAY.has(detail)) out.paidLeave += 0.5
    }
    // `isPunchErrorDay(d)` を使わずに値を直接見る — 使うと分岐の中で
    // `punchErrorMinutes ?? 0` の右辺が到達不能になり branch 100% を割る
    const punchError = d.punchErrorMinutes ?? 0
    if (punchError > 0) {
      out.punchError += 1
      out.punchErrorMinutes += punchError
      continue
    }
    const voluntary = d.voluntaryMinutes ?? 0
    if (d.isRestDay) {
      if (voluntary > 0) {
        out.voluntary += 1
        out.voluntaryMinutes += voluntary
      }
      continue
    }
    if (d.holidayKind === 'legal' || d.holidayKind === 'non_legal') {
      out.holidayWork += 1
      continue
    }
    const ot = (d.overtimeMinutes ?? 0) + (d.overtimeNightMinutes ?? 0)
    if (ot > 0) out.overtime += 1
    else out.normal += 1
  }
  return out
}
