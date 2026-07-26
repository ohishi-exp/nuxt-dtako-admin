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
import type { RestraintSummaryDay, WageReportRow } from './restraint-wage-view'

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

/** "YYYY-MM-DD HH:MM:SS" → "HH:MM"。読めない形式は null。
 *
 * **「翌 HH:MM」は返さない** — 打刻は必ず**押された日の行**に出す方針になったため
 * (下記 `carriedPunchOuts`)。日をまたぐ表示そのものが表から無くなった。 */
export function formatPunch(ts: string | undefined): string | null {
  if (!ts) return null
  const m = TS_RE.exec(ts)
  return m ? `${m[4]}:${m[5]}` : null
}

/** その日が打刻エラーか (事務職・非夜勤の日跨ぎ、Refs #433)。 */
export function isPunchErrorDay(d: RestraintSummaryDay | undefined): boolean {
  return (d?.punchErrorMinutes ?? 0) > 0
}

/** "YYYY-MM-DD HH:MM:SS" の日 (1-31)。読めなければ 0。 */
function dayOfTimestamp(ts: string): number {
  const m = TS_RE.exec(ts)
  return m ? Number(m[3]) : 0
}

/** 前の日から持ち越された退勤打刻。 */
export interface CarriedPunchOut {
  /** "HH:MM" (押された日の時刻なので「翌」は付かない)。 */
  time: string
  /** 持ち越し元が打刻エラーの日か。true の日だけ赤くして理由を出す。 */
  fromError: boolean
}

/**
 * 日をまたいで終わった打刻の退勤を、**実際に押された日**へ移す (Refs #433)。
 *
 * タイムカードは「その日に何を押したか」の記録なので、**打刻は押された日の行に
 * 出す**。日をまたいだ退勤を始業日の行に「翌 13:51」と出すと、
 *
 * - 押した日 (翌日) の行が空欄のままになり、何も押していないように見える
 * - 押し忘れ (打刻エラー) の場合は、翌日に押された退勤があたかもその日の退社で
 *   あるかのように読めてしまう — これは端的に嘘
 *
 * 移したあとは「1日は出勤だけ / 2日は退勤だけ」と並び、実際の打刻がそのまま読める。
 * 日をまたぐ勤務そのものは正常 (夜勤・長距離) なので、**エラーかどうかで扱いは
 * 変えない** — 変えるのは色と備考だけ。
 *
 * 月をまたいでずれ込んだ分は表に出す行が無いので落とす。
 */
export function carriedPunchOuts(
  days: readonly RestraintSummaryDay[],
  year: number,
  month: number,
): Map<number, CarriedPunchOut> {
  const out = new Map<number, CarriedPunchOut>()
  const last = daysInMonth(year, month)
  for (const d of days) {
    const fromError = isPunchErrorDay(d)
    for (const s of d.sessions ?? []) {
      // 日と時刻を 1 回のマッチで取る (別々に解析すると、片方だけ失敗する分岐が
      // 実際には起こり得ないのに残ってしまう)
      const m = TS_RE.exec(s.end)
      if (!m) continue
      const endDay = Number(m[3])
      // 同じ日に終わっている打刻はずれ込んでいない。月をまたいだ分は行が無い
      if (endDay === d.day || endDay > last) continue
      out.set(endDay, { time: `${m[4]}:${m[5]}`, fromError })
    }
  }
  return out
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
  // 押し忘れでずれ込んだ退勤を、実際に打刻された日へ返す (Refs #433)
  const carried = carriedPunchOuts(days, year, month)
  for (let day = 1; day <= last; day++) {
    const dow = dayOfWeek(year, month, day)
    const d = byDay.get(day)
    const sessions = d?.sessions ?? []
    const punchError = isPunchErrorDay(d)
    const carriedOut = carried.get(day) ?? null
    // 前日の終業を押し忘れると、その打刻がこの日の退勤と組まれて**この日の行ごと消える**
    // (実データで確認)。空欄の理由が分かるように出す。**正常な日跨ぎ (夜勤・長距離) で
    // 退勤が持ち越された日は対象外** — そちらは異常ではないので色も備考も付けない
    const afterPunchError = carriedOut?.fromError === true
    const notes: string[] = []
    // 休暇区分 (公休 / 有休 / 遅刻 …) は CakePHP の PDF と同じく原文をそのまま出す
    notes.push(...(d?.leaves ?? []))
    const kind = d ? dayKindLabel(d) : ''
    if (kind) notes.push(kind)
    if (afterPunchError) notes.push('前日の打刻エラーの影響')
    // 3 回以上の打刻は 出勤2/退社2 の列に収まらないので件数だけ残す
    if (sessions.length > 2) notes.push(`打刻 ${sessions.length} 回`)

    // **日をまたいだ退勤はこの行に出さない** — その打刻は翌日に押されたものなので、
    // 押された日の行に出す (`carriedPunchOuts`)。始業は必ずこの日なので対象外
    const punchOut = (index: number): string | null => {
      const end = sessions[index]?.end
      if (end && dayOfTimestamp(end) !== day) return null
      return formatPunch(end)
    }

    rows.push({
      day,
      dow,
      dowLabel: DOW_LABELS[dow]!,
      in1: formatPunch(sessions[0]?.start),
      // 自分の打刻が無く前日から持ち越された退勤だけがある日は、それを退社に出す
      out1: punchOut(0) ?? (sessions.length === 0 ? (carriedOut?.time ?? null) : null),
      in2: formatPunch(sessions[1]?.start),
      out2: punchOut(1),
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

/** 期間サマリー印刷の 1 行 = 1 人分の月次集計 (Refs #443)。 */
export interface TimecardSummaryRow {
  driverCd: string
  driverName: string
  /** 出勤・自主出勤・打刻エラーの日数 (日別から数える)。 */
  counts: WorkKindCounts
  /** 出勤日数 = 通常 + 残業。**残業の有無で分けない** — 給与明細の「出勤日数」と
   * 突き合わせる列なので、残業した日も出勤 1 日として数える (2026-07-26 指摘)。
   * 休日出勤は別列 (承認の要る別枠なので合算しない)。 */
  attendanceDays: number
  /** 休暇日数。**worker が数えた `leaveCounts` をそのまま使う** (下記)。 */
  leaves: { publicHoliday: number, paidLeave: number, absence: number, specialLeave: number, late: number, earlyLeave: number }
  /** 実働 (分)。 */
  workingMinutes: number
  /** 打刻から計算した残業 (時間外 + 時間外深夜、分)。 */
  overtimeMinutes: number
  /** 給与明細の残業手当 (円)。その月の明細が未取り込みなら null。 */
  salaryOvertime: number | null
}

const EMPTY_LEAVES = { publicHoliday: 0, paidLeave: 0, absence: 0, specialLeave: 0, late: 0, earlyLeave: 0 }

/**
 * wage-report の行を期間サマリー印刷の一覧へ畳む (Refs #443)。
 *
 * 呼び出し側で `source === 'timecard'` に絞ってから渡すこと — theearth 由来の行は
 * 打刻も休暇も持たないので、混ぜると 0 の行が並ぶだけになる。
 *
 * **休暇日数は日別から数え直さず `summary.leaveCounts` を使う** — 半休の数え方や
 * どの区分を公休に入れるかは worker の `countLeaves` が正で、画面側に 2 つ目の
 * 規則を置くと worker を変えた時に静かに食い違う (`buildAttendanceDays` と同じ理由)。
 *
 * `salaryOvertimeByDriver` は乗務員CD (数値正規化キー) → 給与明細の残業手当。
 * その月の明細を取り込んでいなければ空の Map を渡す (列は空欄になる)。
 */
export function buildTimecardSummary(
  rows: readonly WageReportRow[],
  salaryOvertimeByDriver: ReadonlyMap<string, number>,
): TimecardSummaryRow[] {
  return rows.map((r) => {
    const counts = countWorkKinds(r.summary.days)
    return {
      driverCd: r.summary.driverCd,
      driverName: r.summary.driverName,
      counts,
      attendanceDays: counts.normal + counts.overtime,
      leaves: r.summary.leaveCounts ?? EMPTY_LEAVES,
      workingMinutes: r.summary.workingMinutes ?? 0,
      overtimeMinutes: (r.summary.overtimeMinutes ?? 0) + (r.summary.overtimeNightMinutes ?? 0),
      salaryOvertime: salaryOvertimeByDriver.get(String(Number(r.summary.driverCd))) ?? null,
    }
  })
}
