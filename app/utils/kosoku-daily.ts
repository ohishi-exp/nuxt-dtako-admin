/**
 * 打刻基準の日別サマリ (ドライバーの拘束・深夜) の受け取り (Refs #472 PR-B)。
 *
 * 経路: rust-ichibanboshi `/api/kintai/kosoku-daily` → relay
 * `/restraint-api/kintai/kosoku-daily` → ここ。**relay は中継するだけ**なので、
 * 応答の形を確かめて画面が使う形へ直すのはこの層の担当。
 *
 * ドライバーは打刻を持たない (theearth の拘束 CSV 由来) ため wage-report の
 * `source === 'timecard'` に出てこない。タイムカード表が事務員しか出ていなかった
 * のはこれが理由で、この経路がドライバー側の供給元になる。
 *
 * **この拘束は現行の拘束時間管理表と一致しない。** あちらは運行 (デジタコ) で
 * 拘束を測り、こちらは打刻で測るため、打刻のある乗務員では拘束が増える
 * (実測: 乗務員 1029 の 2026-06 で +1,097 分)。打刻基準化の目的そのものだが、
 * 画面に並べるときは由来が要る。
 */

import type { TimecardTableRow, WorkKindCounts } from './timecard-view'
import { dayOfWeek, daysInMonth } from './timecard-view'

/** 日別サマリ 1 日 (上流 #118 の `DaySummary`、単位はすべて分)。 */
export interface KosokuDay {
  /** 始業日 (`YYYY-MM-DD`)。**日跨ぎ勤務もここに寄る。** */
  date: string
  /** 始業 (`YYYY-MM-DD HH:MM:SS`)。 */
  start: string
  /** 終業 (同上、日跨ぎは翌日以降になる)。 */
  end: string
  /** 始業・終業をどちらの規則で決めたか (`timecard` = 打刻 / `rest` = 休息イベント)。 */
  source: 'timecard' | 'rest'
  /** 始業日が日曜。 */
  isLegalHoliday: boolean
  /** 拘束が 24 時間を超えて打ち切られた (改善基準告示に照らして違反の日)。 */
  over24h: boolean
  /** 拘束 = 終業 − 始業。 */
  restraintMinutes: number
  breakMinutes: number
  workingMinutes: number
  statutoryMinutes: number
  withinStatutoryOvertimeMinutes: number
  /** 法定時間外 (8h 超)。 */
  overtimeMinutes: number
  legalHolidayMinutes: number
  /** 平日の所定内・法定内残業に重なる深夜。 */
  nightMinutes: number
  /** 平日の法定時間外に重なる深夜。`nightMinutes` とは排他。 */
  overtimeNightMinutes: number
  legalHolidayNightMinutes: number
}

/** `{month, drivers: [{driver, days}]}` を乗務員CD 引きの表に直したもの。 */
export interface KosokuDailyIndex {
  month: string
  /** 乗務員CD (`String(Number(...))` 正規化) → その月の勤務日。 */
  byDriver: Map<string, KosokuDay[]>
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/**
 * 日 1 件を画面用に直す。**日付・始業・終業のどれかが欠けた行は捨てる**
 * (`null`) — 時刻の無い勤務は表に置き場が無く、0 として並べると「その日は
 * 働いていない」に見えるため。数値の欠けは 0 で埋める (項目が増減しても落ちない)。
 */
export function toKosokuDay(raw: unknown): KosokuDay | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const date = str(r.date)
  const start = str(r.start)
  const end = str(r.end)
  if (!date || !start || !end) return null
  return {
    date,
    start,
    end,
    source: r.source === 'rest' ? 'rest' : 'timecard',
    isLegalHoliday: r.is_legal_holiday === true,
    over24h: r.over_24h === true,
    restraintMinutes: num(r.restraint_minutes),
    breakMinutes: num(r.break_minutes),
    workingMinutes: num(r.working_minutes),
    statutoryMinutes: num(r.statutory_minutes),
    withinStatutoryOvertimeMinutes: num(r.within_statutory_overtime_minutes),
    overtimeMinutes: num(r.overtime_minutes),
    legalHolidayMinutes: num(r.legal_holiday_minutes),
    nightMinutes: num(r.night_minutes),
    overtimeNightMinutes: num(r.overtime_night_minutes),
    legalHolidayNightMinutes: num(r.legal_holiday_night_minutes),
  }
}

/**
 * relay の応答を乗務員CD 引きの表へ。
 *
 * - 乗務員CD は `String(Number(...))` で正規化する — 画面側の突合キー
 *   (`matchesTimecardFilter` / 社員マスタ) と同じ作法で、`0012` と `12` を
 *   同じ人として引けるようにするため
 * - **日が 1 つも残らなかった乗務員は入れない。** 空配列を持つ乗務員が居ると
 *   「勤務があるが全部空」と「そもそも居ない」が見分けられなくなる
 * - `drivers` が配列でない応答は空で返す (画面はドライバー行が出ないだけ)
 */
export function parseKosokuDaily(body: unknown, fallbackMonth = ''): KosokuDailyIndex {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const month = str(b.month) ?? fallbackMonth
  const byDriver = new Map<string, KosokuDay[]>()
  if (!Array.isArray(b.drivers)) return { month, byDriver }
  for (const entry of b.drivers) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const driver = typeof e.driver === 'number' ? e.driver : Number(str(e.driver) ?? Number.NaN)
    if (!Number.isFinite(driver)) continue
    const days = (Array.isArray(e.days) ? e.days : [])
      .map(toKosokuDay)
      .filter((d): d is KosokuDay => d !== null)
    if (!days.length) continue
    byDriver.set(String(driver), days)
  }
  return { month, byDriver }
}

const DOW_LABELS = ['日', '月', '火', '水', '木', '金', '土']
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/

/**
 * 前月と当月の勤務をつなぎ、**月境界で残る休息由来の欠片を落とす** (Refs #472 PR-C)。
 *
 * 上流は「打刻があれば打刻、無ければ休息イベント」で勤務を組み、打刻の勤務と重なる
 * 休息由来は捨てる。ところが**読み取り範囲が月初から始まる**ため、月初の日は直前の
 * 始業打刻が範囲外になり、打刻の勤務が組めずに休息由来の欠片が残る (実測: 乗務員
 * 1194 の 2026-04-01 は `終業 17:07` の打刻があるのに `04:38〜04:45` の 7 分勤務が
 * 出ていた — 休息と休息の隙間)。
 *
 * 前月の応答には打刻の勤務 (3/31 21:31 → 4/1 17:07) が入っているので、**両方を並べて
 * 同じ優先規則をもう一度当てる**と欠片が消える。
 */
export function mergeKosokuDays(
  prev: readonly KosokuDay[],
  current: readonly KosokuDay[],
): KosokuDay[] {
  const all = [...prev, ...current]
  const punched = all.filter(d => d.source === 'timecard')
  const overlaps = (a: KosokuDay, b: KosokuDay) => a.start < b.end && b.start < a.end
  return all
    .filter(d => d.source === 'timecard' || !punched.some(p => overlaps(d, p)))
    .sort((a, b) => a.start.localeCompare(b.start))
}

/** `YYYY-MM-DD HH:MM:SS` → `{ day, time }`。読めなければ null。 */
function parseStamp(ts: string): { year: number, month: number, day: number, time: string } | null {
  const m = TS_RE.exec(ts)
  if (!m) return null
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), time: `${m[4]}:${m[5]}` }
}

/**
 * ドライバーの日別サマリを**事務員と同じ 8 列**のタイムカード表へ畳む (Refs #472 PR-C)。
 *
 * 列の割り当ては #472 で決めたとおり:
 *
 * | 列 | 中身 |
 * |---|---|
 * | 出勤1 / 退社1 | その日に**始業した 1 本目**の勤務 |
 * | 出勤2 / 退社2 | 同じ日に始業した 2 本目 |
 * | 残業 | `overtimeMinutes + overtimeNightMinutes` (事務員と同じ定義) |
 * | 備考 | 法定休日 / 24 時間超 / 3 本以上の件数 / 日をまたいだ終業 |
 *
 * **列は「その日に起きた出来事を時刻順に詰める」**— 社内 CakePHP の PDF と同じ形
 * (2026-07-27 に実物と突き合わせて確定)。始業・終業はそれぞれ**起きた日**の行に出し、
 * 日の頭に前日から続く終業がある日は `退社1` に入り、その日の始業は `出勤2` へ回る
 * (= `出勤1` が空欄になる)。
 *
 * - **始業が前月でも終業は出す。** 月初に前月から続く勤務が終わる日は珍しくなく、
 *   落とすと「退社が取れていない」日に見える (乗務員 1194 / 2026-04 で確認)
 * - **同じ日に 3 本以上の勤務は想定外** (#472 でユーザー決定)。8 列に収まらない
 *   出来事は列に入れず、**備考に件数を出す** — 黙って消さず、起きたことが分かるようにする
 * - 残業・法定休日・24 時間超は**その日に始業した勤務**から数える (拘束の帰属は
 *   始業日、上流 #118 と同じ)
 */
export function buildKosokuTimecardTable(
  days: readonly KosokuDay[],
  year: number,
  month: number,
): TimecardTableRow[] {
  const last = daysInMonth(year, month)
  const inMonth = (s: { year: number, month: number, day: number }) =>
    s.year === year && s.month === month && s.day <= last

  /** 日 → その日に起きた出来事 (始業 / 終業) を時刻順に。 */
  const eventsByDay = new Map<number, Array<{ time: string, kind: 'in' | 'out' }>>()
  /** 日 → その日に**始業した**勤務 (残業・法定休日・24時間超はこちらから数える)。 */
  const startedByDay = new Map<number, KosokuDay[]>()
  const push = (day: number, time: string, kind: 'in' | 'out') => {
    const list = eventsByDay.get(day) ?? []
    list.push({ time, kind })
    eventsByDay.set(day, list)
  }
  for (const d of days) {
    const start = parseStamp(d.start)
    const end = parseStamp(d.end)
    // **始業が前月でも終業は出す** — 月初に前月から続く勤務が終わる日は珍しくなく、
    // 落とすと「退社が取れていない」日に見える (2026-07-27 に乗務員 1194 で確認)
    if (start && inMonth(start)) {
      push(start.day, start.time, 'in')
      const list = startedByDay.get(start.day) ?? []
      list.push(d)
      startedByDay.set(start.day, list)
    }
    // **24 時間で打ち切った勤務の終業は出さない。** 終業が見つからなかった勤務を
    // 上流が 24 時間で切ったもので、`start + 24h` という**実在しない時刻**が入っている
    // (実測: 乗務員 1194 の 2026-05-07 は `21:32 → 翌 21:32`)。列に出すと翌日の行に
    // 本物の退社があるように見えるので、始業日の備考で「打ち切り」と言う
    if (end && !d.over24h && inMonth(end)) push(end.day, end.time, 'out')
  }

  const rows: TimecardTableRow[] = []
  for (let day = 1; day <= last; day++) {
    const shifts = startedByDay.get(day) ?? []
    // 同時刻なら終業が先 (前の勤務が終わってから次が始まる)
    const rank = (kind: 'in' | 'out') => kind === 'out' ? 0 : 1
    const events = (eventsByDay.get(day) ?? []).sort((a, b) =>
      a.time.localeCompare(b.time) || rank(a.kind) - rank(b.kind))

    // **出来事を時刻順に 出勤1 → 退社1 → 出勤2 → 退社2 へ詰める** (社内 PDF と同じ形)。
    // 日の頭に前日から続く終業がある日は 退社1 に入り、その日の始業は 出勤2 へ回る
    const slots: Array<'in' | 'out'> = ['in', 'out', 'in', 'out']
    const filled: Array<string | null> = [null, null, null, null]
    let slot = 0
    let overflow = 0
    for (const e of events) {
      while (slot < slots.length && slots[slot] !== e.kind) slot += 1
      if (slot >= slots.length) { overflow += 1; continue }
      filled[slot] = e.time
      slot += 1
    }

    const notes: string[] = []
    if (shifts.some(s => s.isLegalHoliday)) notes.push('法定休日')
    // 退社の時刻が無い理由をその行で言う (列を空にしただけだと「取れていない」に見える)
    if (shifts.some(s => s.over24h)) notes.push('退社不明 (拘束 24 時間で打ち切り)')
    // 8 列に収まらない日 = #472 の「想定外」。**黙って消さず件数を出す**
    if (overflow > 0) notes.push(`出退勤 ${events.length} 件`)

    const dow = dayOfWeek(year, month, day)
    rows.push({
      day,
      dow,
      dowLabel: DOW_LABELS[dow]!,
      in1: filled[0]!,
      out1: filled[1]!,
      in2: filled[2]!,
      out2: filled[3]!,
      overtimeMinutes: shifts.reduce((n, s) => n + s.overtimeMinutes + s.overtimeNightMinutes, 0),
      note: notes.join(' / '),
      isSunday: dow === 0,
      // 自主出勤・打刻エラーは打刻側 (事務員) の判定で、ドライバーには無い
      isVoluntary: false,
      isPunchError: false,
      isAfterPunchError: false,
    })
  }
  return rows
}

/** 会社ごとに区切ったタイムカード表の 1 区画。`compId` が null = 会社不明。 */
export interface TimecardCompanySection<T> {
  compId: string | null
  sheets: T[]
}

/**
 * タイムカード表を**会社ごとに区切り、事務員 → ドライバーの順**に並べる
 * (#472 でユーザー決定、2026-07-27)。
 *
 * ドライバーの供給元 (`kosoku-daily`) は会社で絞らず全乗務員を返すので、
 * 会社の見出しで区切らないと他社の人が混ざったまま並ぶ。
 *
 * - 会社の順は `compOrder` (呼び出し側が「開いている会社を先頭」にする)。
 *   そこに無い会社は会社ID 昇順で後ろに付ける
 * - **社員マスタで会社が引けない乗務員CD は末尾の「会社不明」へまとめる** —
 *   落とすと、マスタ未登録の人が黙って表から消える
 * - 同じ会社の中は 事務員 (`isDriver: false`) → ドライバー、それぞれ乗務員CD 順
 */
export function groupTimecardSheetsByCompany<T extends { driverCd: string, isDriver: boolean }>(
  sheets: readonly T[],
  companyOf: (driverCd: string) => string | null,
  compOrder: readonly string[] = [],
): Array<TimecardCompanySection<T>> {
  const byComp = new Map<string, T[]>()
  const unknown: T[] = []
  for (const s of sheets) {
    const comp = companyOf(s.driverCd)
    if (!comp) { unknown.push(s); continue }
    const list = byComp.get(comp) ?? []
    list.push(s)
    byComp.set(comp, list)
  }
  const rest = [...byComp.keys()].filter(c => !compOrder.includes(c)).sort()
  const order = [...compOrder.filter(c => byComp.has(c)), ...rest]
  const sortSheets = (list: T[]) => list.sort((a, b) =>
    (Number(a.isDriver) - Number(b.isDriver))
    || a.driverCd.localeCompare(b.driverCd, undefined, { numeric: true }))
  const out: Array<TimecardCompanySection<T>> = order.map(compId => ({
    compId,
    sheets: sortSheets(byComp.get(compId)!),
  }))
  if (unknown.length) out.push({ compId: null, sheets: sortSheets(unknown) })
  return out
}

/**
 * ドライバーの勤務区分の日数。
 *
 * **打刻側と数え方を揃えられるのは「残業の有無」と「法定休日に働いたか」だけ。**
 * 公休・有休・欠勤は打刻 (CakePHP の休暇区分) にしか無く、運行イベントからは
 * 分からないので **0 のままにする** — 0 を「休みが無かった」と読ませないために、
 * 画面側はドライバーの行に休暇の日数を出さない。
 */
export function countKosokuWorkKinds(days: readonly KosokuDay[]): WorkKindCounts {
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
    halfLeaveDays: 0,
  }
  // 同じ日に 2 勤務ある日を 2 日と数えない (出勤日数がずれる)
  const seen = new Set<string>()
  for (const d of days) {
    if (seen.has(d.date)) continue
    seen.add(d.date)
    const sameDay = days.filter(x => x.date === d.date)
    if (sameDay.some(x => x.isLegalHoliday)) out.holidayWork += 1
    else if (sameDay.some(x => x.overtimeMinutes + x.overtimeNightMinutes > 0)) out.overtime += 1
    else out.normal += 1
  }
  return out
}
