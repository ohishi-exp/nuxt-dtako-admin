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
  /**
   * 法定時間外 (8h 超) のうち**深夜に重ならない分**。
   *
   * **上流とは意味が違う** — 上流の `overtime_minutes` は時間外の全部で
   * `overtime_night_minutes` はその内数。**読み取り時に引いて排他にしている**
   * (Refs #564、`toKosokuDay`/`toKosokuParts`)。時間外の合計が要る所は
   * `overtimeMinutes + overtimeNightMinutes` で足す。
   */
  overtimeMinutes: number
  legalHolidayMinutes: number
  /** 平日の所定内・法定内残業に重なる深夜。 */
  nightMinutes: number
  /** 平日の法定時間外に重なる深夜。`nightMinutes`・`overtimeMinutes` とは排他。 */
  overtimeNightMinutes: number
  legalHolidayNightMinutes: number
  /**
   * この勤務の中にあった**打刻そのもの** (時刻順、上流 #128)。
   *
   * `start` / `end` は勤務としての解釈 (分に丸め・24 時間で打ち切り) が入るが、
   * こちらは生の打刻。**表の 出勤/退社 列はこちらを使う** — 社内タイムカード表は
   * 打刻を日ごとに並べただけのもので、勤務という単位を持たないため。
   * 休息イベント由来の勤務は空 (打刻が無い)。
   */
  punches: KosokuPunch[]
  /**
   * **暦日按分の内訳** (上流 #130)。日跨ぎ勤務だけ入り、1 日で終わる勤務は空。
   *
   * この日の各分数は勤務を**始業日へ丸ごと寄せた**値。月の拘束・深夜は**暦日按分**で
   * 出す (ユーザー決定 2026-07-27) ので、内訳があるときはこちらを足す。
   */
  parts: KosokuDayPart[]
}

/** 暦日按分の 1 日分 (上流 #130)。 */
export interface KosokuDayPart {
  /** 暦日 (`YYYY-MM-DD`)。 */
  date: string
  restraintMinutes: number
  workingMinutes: number
  overtimeMinutes: number
  legalHolidayMinutes: number
  nightMinutes: number
  overtimeNightMinutes: number
  legalHolidayNightMinutes: number
}

/** 勤務を構成した打刻 1 つ (上流 #128)。 */
export interface KosokuPunch {
  /** `YYYY-MM-DD HH:MM:SS` (秒つき)。 */
  at: string
  /** `始業` / `終業`。 */
  state: string
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
 * 上流の `overtime_minutes` から `overtime_night_minutes` を引いた
 * 「深夜に重ならない時間外」(Refs #564)。
 *
 * 上流 (rust-ichibanboshi `src/kosoku.rs`) は実働を 1 分ずつ歩き、法定時間外の 1 分を
 * `overtime_minutes` に足したうえで、その分が深夜ならさらに `overtime_night_minutes`
 * にも足す — つまり**時間外深夜は時間外の内数**。この画面側の型は 2 つを**排他**として
 * 扱い、合計が要る所で足す (`buildKosokuTimecardTable` の残業列など) ので、
 * 読み取り時に引いておく。引かないと残業列と月合計で深夜残業が二重に乗る。
 *
 * `Math.max` は上流が壊れた値を返した時の防御 (上流の構成上 内数 ≤ 全体 は保証される)。
 */
function exclusiveOvertime(r: Record<string, unknown>): number {
  return Math.max(0, num(r.overtime_minutes) - num(r.overtime_night_minutes))
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
    // 上流の時間外深夜は時間外の内数なので引いて排他にする (Refs #564)
    overtimeMinutes: exclusiveOvertime(r),
    legalHolidayMinutes: num(r.legal_holiday_minutes),
    nightMinutes: num(r.night_minutes),
    overtimeNightMinutes: num(r.overtime_night_minutes),
    legalHolidayNightMinutes: num(r.legal_holiday_night_minutes),
    punches: toKosokuPunches(r.punches),
    parts: toKosokuParts(r.parts),
  }
}

/** 暦日按分の内訳を直す。**日付の無い項目は捨てる** (どの日か決められない)。 */
function toKosokuParts(raw: unknown): KosokuDayPart[] {
  if (!Array.isArray(raw)) return []
  const out: KosokuDayPart[] = []
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue
    const r = p as Record<string, unknown>
    const date = str(r.date)
    if (!date) continue
    out.push({
      date,
      restraintMinutes: num(r.restraint_minutes),
      workingMinutes: num(r.working_minutes),
      overtimeMinutes: exclusiveOvertime(r),
      legalHolidayMinutes: num(r.legal_holiday_minutes),
      nightMinutes: num(r.night_minutes),
      overtimeNightMinutes: num(r.overtime_night_minutes),
      legalHolidayNightMinutes: num(r.legal_holiday_night_minutes),
    })
  }
  return out
}

/** 打刻の配列を直す。**時刻の無い項目は捨てる** (列に置けない)。 */
function toKosokuPunches(raw: unknown): KosokuPunch[] {
  if (!Array.isArray(raw)) return []
  const out: KosokuPunch[] = []
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) continue
    const at = str((p as Record<string, unknown>).at)
    if (!at) continue
    out.push({ at, state: str((p as Record<string, unknown>).state) ?? '' })
  }
  return out
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
 * - 残業・法定休日は**暦日按分**、24 時間超は**その日に始業した勤務**から数える
 */
export function buildKosokuTimecardTable(
  days: readonly KosokuDay[],
  year: number,
  month: number,
): TimecardTableRow[] {
  const last = daysInMonth(year, month)
  const ym = `${year}-${String(month).padStart(2, '0')}`
  const inMonth = (s: { year: number, month: number, day: number }) =>
    s.year === year && s.month === month && s.day <= last
  // **残業も法定休日も暦日按分で見る** (ユーザー指摘 2026-07-27)。勤務単位のままだと
  // 3 日間の勤務の残業がまるごと始業日の行に乗り、ヘッダ (按分) と食い違う
  const byDate = kosokuByCalendarDate(days, ym)

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
    // 勤務そのものは始業日に紐づける (残業・法定休日・24 時間超はここから数える)
    if (start && inMonth(start)) {
      const list = startedByDay.get(start.day) ?? []
      list.push(d)
      startedByDay.set(start.day, list)
    }

    // **列に出すのは打刻だけ** (ユーザー決定 2026-07-27)。勤務の端 (`start`/`end`) は
    // 休息の境目であって出勤・退社ではないので、列に出すと打刻と見分けが付かない —
    // 長距離の 1 運行を休息で割った途中の区間 (上流 #133) がまさにそれ。
    // 拘束・残業は日別の値として数えたまま
    for (const p of d.punches) {
      const at = parseStamp(p.at)
      // **始業が前月でも終業は出す** — 月初に前月から続く勤務が終わる日は珍しくない
      if (at && inMonth(at)) push(at.day, at.time, p.state === '終業' ? 'out' : 'in')
    }
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

    const date = `${ym}-${String(day).padStart(2, '0')}`
    const attributed = byDate.get(date)

    // **法定休日は備考に書かない** — 残業列に括弧つきの数字で出す (2026-07-28 決定)。
    // 「法定休日」と書いてあっても何時間かが分からず、備考の幅も食っていた
    const notes: string[] = []
    // 退社の時刻が無い理由をその行で言う (列を空にしただけだと「取れていない」に見える)。
    // 打刻がある勤務は実際の終業を列に出せるので、打ち切りでも「不明」ではない
    if (shifts.some(s => s.over24h && !s.punches.length)) {
      notes.push('退社不明 (拘束 24 時間で打ち切り)')
    }
    else if (shifts.some(s => s.over24h)) {
      notes.push('拘束 24 時間超')
    }
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
      // **その日に乗った残業** (按分後)。勤務単位で足すと日跨ぎの勤務が始業日に
      // 丸ごと乗り、ヘッダの合計と読み方が食い違う
      overtimeMinutes: (attributed?.overtimeMinutes ?? 0) + (attributed?.overtimeNightMinutes ?? 0),
      // 法定休日 (日曜) の実働。**残業ではない** ので残業列には括弧つきで出す
      legalHolidayMinutes: attributed?.legalHolidayMinutes ?? 0,
      // 1 人表示の内訳列 (Refs 2026-07-28)。按分後の暦日で揃える
      restraintMinutes: attributed?.restraintMinutes ?? 0,
      breakMinutes: Math.max(0, (attributed?.restraintMinutes ?? 0) - (attributed?.workingMinutes ?? 0)),
      overtimeNightMinutes: attributed?.overtimeNightMinutes ?? 0,
      // 法定休日の深夜もここへ足す (割増は違うが「深夜帯に何分働いたか」を出す列)
      nightMinutes: (attributed?.nightMinutes ?? 0) + (attributed?.legalHolidayNightMinutes ?? 0),
      // **打刻が無い日でも実働は出す。** 長距離は運行途中に打刻が無く、列が空のままだと
      // 「動いているのに拘束が取れていない」ように見える (2026-07-27 指摘)。
      // 拘束ではなく実働 (拘束 − 休憩) を出すのはユーザー指示 — 拘束のままだと
      // 残業と噛み合わない (拘束 10h17m でも休憩 3h04m を抜けば実働 7h13m で残業 0)
      workingMinutes: attributed?.workingMinutes ?? 0,
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

/** 会社ごとに区切ったタイムカード表の 1 区画。`company` が null = 会社不明。 */
export interface TimecardCompanySection<T> {
  /** 給与大臣の会社コード 4 桁 (`0100` 等)。null = 社員マスタに乗務員CD が無い。 */
  company: string | null
  sheets: T[]
}

/**
 * 職種の並び順 (ユーザー決定 2026-07-28)。**事務 → 作業 → 整備 → 乗務 → その他**。
 *
 * `employee_attrs.job_name` (= 給与大臣 `SHOZOKU.NAME2`) は自由文字列で表記ゆれが
 * あるので**部分一致**で振り分ける — 本番の実測値は
 * `一般管理事務` / `一般事務管理` (前後の入れ替わった行が 1 名混ざっている)、
 * `作業員` / `作業員2` / `作業員点呼者`、`整備`、
 * `乗務員` / `乗務員(トレーラ)` / `乗務員(トレーラ-)` / `乗務員(トレーラー)` / `トレーラ乗務員`。
 *
 * どれにも当てはまらない職種 (`役員` `執行役` `特定技能`) と**職種が引けない社員**は
 * `other` で末尾にまとめる (ユーザー決定 2026-07-28) — 推測で乗務員や作業員に混ぜず、
 * 区分の付いていない人がそのまま目に見える形で残す。
 */
export const TIMECARD_JOB_GROUPS = ['clerical', 'worker', 'maintenance', 'driver', 'other'] as const
export type TimecardJobGroup = typeof TIMECARD_JOB_GROUPS[number]

/** 職種名 → 並び順の区分。判定は部分一致 (上記)。 */
export function timecardJobGroup(jobName: string | null | undefined): TimecardJobGroup {
  if (typeof jobName !== 'string') return 'other'
  // `作業員点呼者` のように複数の語を含む値があるので、順に見て最初に当たった区分を採る
  if (jobName.includes('事務')) return 'clerical'
  if (jobName.includes('作業')) return 'worker'
  if (jobName.includes('整備')) return 'maintenance'
  if (jobName.includes('乗務') || jobName.includes('運転')) return 'driver'
  return 'other'
}

/**
 * タイムカード表を**給与大臣の会社コードごとに区切り、職種順**に並べる
 * (ユーザー決定 2026-07-28。元は dtako 会社ID × 事務員→ドライバー、#472 PR-C)。
 *
 * 区切りが dtako 会社ID (`27324455`) だと、その中に給与会社 `0100` `0200` `0300` の
 * 3 社が混在したまま 183 名が 1 区画に並ぶ。給与の突合はもともと会社コード単位
 * (Refs #405) なので、表の区切りもそちらに合わせる。
 *
 * ドライバーの供給元 (`kosoku-daily`) は会社で絞らず全乗務員を返すので、
 * 会社の見出しで区切らないと他社の人が混ざったまま並ぶ。
 *
 * - 会社の順は**会社コード昇順** (`0100` → `0200` → …)。4 桁ゼロ詰めなので
 *   文字列順 = 番号順
 * - **社員マスタで会社が引けない乗務員CD は末尾の「会社不明」へまとめる** —
 *   落とすと、マスタ未登録の人が黙って表から消える
 * - 同じ会社の中は `TIMECARD_JOB_GROUPS` の順 → 乗務員CD 順
 */
export function groupTimecardSheetsByCompany<T extends { driverCd: string }>(
  sheets: readonly T[],
  companyOf: (driverCd: string) => string | null,
  jobGroupOf: (driverCd: string) => TimecardJobGroup = () => 'other',
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
  const rank = (cd: string) => TIMECARD_JOB_GROUPS.indexOf(jobGroupOf(cd))
  const sortSheets = (list: T[]) => list.sort((a, b) =>
    (rank(a.driverCd) - rank(b.driverCd))
    || a.driverCd.localeCompare(b.driverCd, undefined, { numeric: true }))
  const out: Array<TimecardCompanySection<T>> = [...byComp.keys()].sort().map(company => ({
    company,
    sheets: sortSheets(byComp.get(company)!),
  }))
  if (unknown.length) out.push({ company: null, sheets: sortSheets(unknown) })
  return out
}

/** 月の拘束と深夜 (人ごとのヘッダに出す、Refs #472 PR-D)。 */
export interface KosokuMonthTotals {
  restraintMinutes: number
  /** 平日の所定内・法定内残業に重なる深夜。 */
  nightMinutes: number
  /** 平日の法定時間外に重なる深夜。`nightMinutes` とは排他 (上流 #118)。 */
  overtimeNightMinutes: number
  /** 法定時間外 (8h 超)。法定休日の実働は含まない (あちらは休日割増に一本化)。 */
  overtimeMinutes: number
  /** 法定休日 (日曜) の実働。深夜ぶんも含む。 */
  legalHolidayMinutes: number
}

/**
 * 月の拘束と深夜を**暦日按分**で合計する (ユーザー決定 2026-07-27)。
 *
 * 上流は勤務を始業日へ丸ごと寄せるが、現行の拘束時間管理表は暦日へ配る。**寄せ方は
 * 暦日按分に合わせる** — 月末に始業して翌月に終わる勤務が、まるごと前の月に乗らない
 * ようにするため。日跨ぎ勤務には上流が内訳 (`parts`) を添えてくる (#130) ので、
 * それがあるときは対象月に落ちる分だけを足す。
 *
 * - **`parts` が無い勤務** (1 日で終わる / 上流が古い) は、その勤務の日付が対象月なら
 *   丸ごと足す — 1 日で終わる勤務は按分しても同じ値になる
 * - **法定休日の深夜も深夜に足す** — 上流は割増ごとに別項目で持つが、画面に出すのは
 *   「その月に深夜帯で何分働いたか」。割増の違う時間外深夜だけ内訳として残す
 * - 拘束は 24 時間で打ち切られた勤務も**打ち切り後の値のまま**足す (上流 #118 の
 *   判断を画面で覆さない)
 */
export function sumKosokuMonth(days: readonly KosokuDay[], month: string): KosokuMonthTotals {
  const acc: KosokuMonthTotals = {
    restraintMinutes: 0,
    nightMinutes: 0,
    overtimeNightMinutes: 0,
    overtimeMinutes: 0,
    legalHolidayMinutes: 0,
  }
  for (const p of kosokuByCalendarDate(days, month).values()) {
    acc.restraintMinutes += p.restraintMinutes
    acc.nightMinutes += p.nightMinutes + p.legalHolidayNightMinutes
    acc.overtimeNightMinutes += p.overtimeNightMinutes
    acc.overtimeMinutes += p.overtimeMinutes
    acc.legalHolidayMinutes += p.legalHolidayMinutes
  }
  return acc
}

/**
 * 対象月の**暦日ごとの合計**を作る (Refs #472)。拘束・深夜の月合計も出勤日数も
 * ここから数える — 按分した後の値だけを見れば、寄せ方の違いが 1 か所で済む。
 *
 * - 内訳 (`parts`) がある勤務は対象月に落ちる日だけを足す
 * - 内訳の無い勤務 (1 日で終わる / 上流が古い) は、その勤務の日付が対象月なら丸ごと
 *   その日へ足す
 * - **同じ日に複数の勤務があれば 1 つの日にまとまる** (日数を二重に数えない)
 */
export function kosokuByCalendarDate(
  days: readonly KosokuDay[],
  month: string,
): Map<string, KosokuDayPart> {
  const byDate = new Map<string, KosokuDayPart>()
  const add = (date: string, v: Omit<KosokuDayPart, 'date'>) => {
    if (!date.startsWith(month)) return
    const cur = byDate.get(date) ?? {
      date,
      restraintMinutes: 0,
      workingMinutes: 0,
      overtimeMinutes: 0,
      legalHolidayMinutes: 0,
      nightMinutes: 0,
      overtimeNightMinutes: 0,
      legalHolidayNightMinutes: 0,
    }
    cur.restraintMinutes += v.restraintMinutes
    cur.workingMinutes += v.workingMinutes
    cur.overtimeMinutes += v.overtimeMinutes
    cur.legalHolidayMinutes += v.legalHolidayMinutes
    cur.nightMinutes += v.nightMinutes
    cur.overtimeNightMinutes += v.overtimeNightMinutes
    cur.legalHolidayNightMinutes += v.legalHolidayNightMinutes
    byDate.set(date, cur)
  }
  for (const d of days) {
    if (d.parts.length) {
      for (const p of d.parts) add(p.date, p)
      continue
    }
    add(d.date, {
      restraintMinutes: d.restraintMinutes,
      workingMinutes: d.workingMinutes,
      overtimeMinutes: d.overtimeMinutes,
      legalHolidayMinutes: d.legalHolidayMinutes,
      nightMinutes: d.nightMinutes,
      overtimeNightMinutes: d.overtimeNightMinutes,
      legalHolidayNightMinutes: d.legalHolidayNightMinutes,
    })
  }
  return byDate
}

/**
 * ドライバーの勤務区分の日数を**按分後の暦日**から数える (ユーザー指摘 2026-07-27)。
 *
 * 拘束を暦日按分するなら日数も同じ基準で数える。**始業日で数えると、前月末に始業して
 * 1 日に終わった勤務の 1 日目が当月の出勤日数から抜ける** (拘束の分数は入るのに日数は
 * 入らない、という食い違いになる)。**按分後に拘束が乗っている暦日をそのまま数える。**
 *
 * - 同じ日に 2 勤務あっても 1 日 (`kosokuByCalendarDate` がまとめる)
 * - その日の区分は**按分後の値**で決める: 法定休日 > 残業 > 通常
 * - **打刻側と数え方を揃えられるのはここまで。** 公休・有休・欠勤は打刻 (CakePHP の
 *   休暇区分) にしか無く運行イベントからは分からないので 0 のままにする — 0 を
 *   「休みが無かった」と読ませないために、画面側はドライバーの行に休暇の日数を出さない
 */
export function countKosokuWorkKinds(days: readonly KosokuDay[], month: string): WorkKindCounts {
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
  for (const p of kosokuByCalendarDate(days, month).values()) {
    // 拘束が乗っていない日は数えない (内訳が 0 分の日を出勤にしない)
    if (p.restraintMinutes <= 0) continue
    if (p.legalHolidayMinutes > 0) out.holidayWork += 1
    else if (p.overtimeMinutes + p.overtimeNightMinutes > 0) out.overtime += 1
    else out.normal += 1
  }
  return out
}
