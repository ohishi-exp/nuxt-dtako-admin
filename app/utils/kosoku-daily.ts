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
