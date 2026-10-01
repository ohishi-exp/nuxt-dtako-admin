/**
 * Y金額 シートの「時間の行」を Excel を開かずに出す pure ロジック (Refs #1133 c1133-31)。
 *
 * このシステムは Y時間 シートの入力列 (C・F〜O) を書くだけで、式は Excel が開いたときに
 * 計算する。訴訟準備の出力タブは、その計算結果のうち **Y金額 シートの時間の行**
 * (賃金月度ごとの 法内残業 / 法外残業 / 月 60h 超 / 休日労働 / 深夜労働 / 総労働時間) を
 * 画面と紙面に出したいので、**テンプレの式を列ごとに 1 対 1 で写す**。
 *
 * - 正本はテンプレの式。式を変えたテンプレを PUT したら、ここも写し直す
 * - relay の賃金計算 (`restraint-wage.ts`) は規則が違う (締め日が無い・週の超過の計上月が違う)
 *   ので使わない
 * - Excel の時刻は 1 日 = 1 の小数、ここは**分** (`VALUE("8:00")` = 480)。式に丸めは無い
 * - **1 冊 = 1 ブック**。Y時間 の行 7 が期間の初日で、行 6 より上は見出し (文字は SUM で 0)。
 *   週累計 (V 列) も前後の行の法定休日 (D 列) も、冊の端で切れる — Excel と同じ
 * - 入力は「シートに実際に書かれた値」(`writeYTimeRows` の `inputDays`)。上流の行そのままではない
 */
import type { SheetCellValue, YTimeInputDay } from './y-time-xlsx'

/** `要素` シートの設定 (曜日は 0 = 日 … 6 = 土) */
export interface YKingakuSettings {
  /** `要素!F5` 法定休日の曜日 */
  legalHolidayWeekday: number
  /** `要素!F7` 週労働時間の制限 (分)。Y時間!AB3 = `要素!$F$7*1/24` */
  weeklyLimitMinutes: number
  /** `要素!F9` 週の起算曜日。Y時間!AA3 */
  weekStartWeekday: number
  /** `要素!E11:F17` 曜日ごとの所定労働時間 (分)。添字 = 曜日 */
  scheduledMinutes: readonly number[]
  /** `要素!G19` 締め日。「末」か日 (1〜31) */
  closingDay: 'end' | number
  /** `要素!U27` 月 60h 規制の適用 */
  over60Applies: boolean
}

/** 設定を持つシート */
export const Y_KINGAKU_SETTING_SHEET = '要素'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const SCHEDULE_ROWS = [11, 12, 13, 14, 15, 16, 17]

/** `parseYKingakuSettings` が読む `要素` シートのセル */
export const Y_KINGAKU_SETTING_REFS: readonly string[] = [
  'F5', 'F7', 'F9',
  ...SCHEDULE_ROWS.flatMap((r) => [`E${r}`, `F${r}`]),
  'G19', 'U27',
]

export type YKingakuSettingsResult =
  | { ok: true, settings: YKingakuSettings }
  | { ok: false, reason: string }

function weekdayOf(cell: SheetCellValue | undefined): number {
  return cell?.kind === 'string' ? WEEKDAYS.indexOf(cell.value) : -1
}

/**
 * `要素` シートのセル (`readSheetCells` の結果) を設定に読む。
 *
 * **読めない・想定外の値は既定値で埋めない** — 違う設定で計算した数字を Excel と同じ顔で
 * 出さないために、理由を返して「集計なし」にする。セルの型で読み分ける
 * (`要素!U27` は真偽セル。数値の 0 を FALSE と読まない)。
 */
export function parseYKingakuSettings(cells: Record<string, SheetCellValue> | null): YKingakuSettingsResult {
  if (!cells) return { ok: false, reason: 'テンプレに「要素」シートが無い' }

  const legalHolidayWeekday = weekdayOf(cells.F5)
  if (legalHolidayWeekday < 0) return { ok: false, reason: '要素!F5 (法定休日の曜日) が 日〜土 の 1 文字でない' }

  const limit = cells.F7
  if (limit?.kind !== 'number' || limit.value <= 0) {
    return { ok: false, reason: '要素!F7 (週労働時間の制限時間数) が正の数値でない' }
  }

  const weekStartWeekday = weekdayOf(cells.F9)
  if (weekStartWeekday < 0) return { ok: false, reason: '要素!F9 (週の起算曜日) が 日〜土 の 1 文字でない' }

  // E11:F17 は Y時間!E 列が曜日で引く表 (VLOOKUP)。並びを決め打ちせず、曜日の文字で引く
  const scheduledMinutes: number[] = []
  for (const r of SCHEDULE_ROWS) {
    const weekday = weekdayOf(cells[`E${r}`])
    if (weekday < 0) return { ok: false, reason: `要素!E${r} (所定労働時間の曜日) が 日〜土 の 1 文字でない` }
    if (scheduledMinutes[weekday] !== undefined) {
      return { ok: false, reason: `要素!E11:E17 に「${WEEKDAYS[weekday]}」が 2 回ある (所定労働時間を引けない曜日がある)` }
    }
    const hours = cells[`F${r}`]
    if (hours?.kind !== 'number' || hours.value < 0) {
      return { ok: false, reason: `要素!F${r} (${WEEKDAYS[weekday]}曜の所定労働時間) が 0 以上の数値でない` }
    }
    scheduledMinutes[weekday] = Math.round(hours.value * 1440)
  }

  const closing = cells.G19
  let closingDay: 'end' | number
  if (closing?.kind === 'string' && closing.value === '末') closingDay = 'end'
  else if (closing?.kind === 'number' && Number.isInteger(closing.value) && closing.value >= 1 && closing.value <= 31) closingDay = closing.value
  else return { ok: false, reason: '要素!G19 (締め日) が「末」でも 1〜31 の日でもない' }

  const over60 = cells.U27
  if (over60?.kind !== 'boolean') return { ok: false, reason: '要素!U27 (月60時間規制の適用) が TRUE / FALSE でない' }

  return {
    ok: true,
    settings: {
      legalHolidayWeekday,
      weeklyLimitMinutes: Math.round(limit.value * 60),
      weekStartWeekday,
      scheduledMinutes,
      closingDay,
      over60Applies: over60.value,
    },
  }
}

// ---- 日付 (UTC の通日で持つ。時刻・タイムゾーンは関係しない) ----

const DAY_MS = 86400000

function dayNumber(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number) as [number, number, number]
  return Date.UTC(y, m - 1, d) / DAY_MS
}

function ymdOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

/** Excel の `DATE(y, m, d)` (m は 1 始まり。月・日のあふれは繰り上がる) */
function excelDate(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) / DAY_MS
}

/** Excel の `EOMONTH(day, months)` */
function eomonth(day: number, months: number): number {
  const d = new Date(day * DAY_MS)
  return excelDate(d.getUTCFullYear(), d.getUTCMonth() + 1 + months + 1, 0)
}

/** Excel の `EDATE(day, months)` (行き先の月に同じ日が無ければ月末) */
function edate(day: number, months: number): number {
  const d = new Date(day * DAY_MS)
  const same = excelDate(d.getUTCFullYear(), d.getUTCMonth() + 1 + months, d.getUTCDate())
  return Math.min(same, eomonth(day, months))
}

// ---- Y時間 シートの式の列 ----

/** Y時間 シートの 1 行 (1 日) の式の列 (分) */
export interface YKingakuDay {
  /** A 列 */
  date: string
  /** P 列 実労働時間合計 */
  total: number
  /** Q 列 所定時間内労働 */
  scheduled: number
  /** S 列 法内残業 */
  statutoryIn: number
  /** T 列 法外残業 (日 8h 超) */
  dailyOver: number
  /** U 列 法外残業 (週の制限超え) */
  weeklyOver: number
  /** V 列 週累計 */
  weekTotal: number
  /** W 列 休日労働 */
  holiday: number
  /** X 列 深夜労働 */
  night: number
}

export interface YKingakuPeriod {
  /** `要素!F3` (`yyyy-mm-dd`) */
  from: string
  /** `要素!I3` (`yyyy-mm-dd`) */
  to: string
}

const H5 = 300
const H8 = 480
const H22 = 1320
const H24 = 1440
const H29 = 1740

/**
 * Y時間 シートの式の列を、期間の初日 (行 7) から末日まで 1 日ずつ計算する。
 * 入力の無い日も行としては在る (式が 0 を出す) ので、期間の全日を返す。
 */
export function computeYKingakuDays(
  inputDays: readonly YTimeInputDay[],
  period: YKingakuPeriod,
  settings: YKingakuSettings,
): YKingakuDay[] {
  const byDate = new Map(inputDays.map((d) => [d.date, d.cells]))
  const first = dayNumber(period.from)
  const last = dayNumber(period.to)
  const limit = settings.weeklyLimitMinutes
  // B 列 `TEXT(A,"aaa")` (1970-01-01 = 木)
  const weekdayOfDay = (day: number) => (day + 4) % 7
  // D 列 `IF(B=要素!$F$5,1,"")`。期間の外の行は A が空なので D も空 (= 法定休日でない)
  const isLegalHoliday = (day: number) =>
    day >= first && day <= last && weekdayOfDay(day) === settings.legalHolidayWeekday

  const out: YKingakuDay[] = []
  /** 行ごとの Q + S (V 列が足す範囲) */
  const inLimit: number[] = []
  for (let day = first; day <= last; day++) {
    const cells = byDate.get(ymdOf(day)) ?? {}
    const weekday = weekdayOfDay(day)
    // E 列 `VLOOKUP(B,要素!$E$11:$G$17,2,FALSE)`
    const scheduledOfDay = settings.scheduledMinutes[weekday]!
    // AA 列 第○曜日 `MOD(WEEKDAY(A,1)+1-$AA$3,7)` (0 は 7)。週の起算曜日が 1
    const dayOfWeek = ((weekday - settings.weekStartWeekday + 7) % 7) + 1

    const g = cells.G
    const prev = cells.F === 1
    // AD〜AJ 拘束を 7 つの時間帯に割った長さ。どれも `IF(G="",0,…)`
    const span = [0, 0, 0, 0, 0, 0, 0]
    if (g !== undefined) {
      // 空のセルは Excel の比較・加減算でも 0 (書き込みは G と H を必ず対で書く)
      const h = cells.H ?? 0
      // AB `IF(F=1,0,G)` / AC `IF(F=1,H,IF(H<=G,1+H,H))`
      const ab = prev ? 0 : g
      const ac = prev ? h : h <= g ? H24 + h : h
      // AD 前 5-22 `IF(F=1,IF(G<=VALUE("22:00"),1-G-VALUE("2:00"),0),0)`
      span[0] = prev && g <= H22 ? H24 - g - 120 : 0
      // AE 前 22-24 `IF(F=1,MIN(1-G,VALUE("2:00")),0)`
      span[1] = prev ? Math.min(H24 - g, 120) : 0
      // AF 0-5 `IF(VALUE("5:00")<=AB,0,MIN(VALUE("5:00"),AC)-AB)`
      span[2] = H5 <= ab ? 0 : Math.min(H5, ac) - ab
      // AG 5-22 `IF(OR(AC<=VALUE("5:00"),VALUE("22:00")<=AB),0,MIN(VALUE("22:00"),AC)-MAX(VALUE("5:00"),AB))`
      span[3] = ac <= H5 || H22 <= ab ? 0 : Math.min(H22, ac) - Math.max(H5, ab)
      // AH 22-24 (AG と同じ形で 22:00〜24:00)
      span[4] = ac <= H22 || H24 <= ab ? 0 : Math.min(H24, ac) - Math.max(H22, ab)
      // AI 24-29 (同じ形で 24:00〜29:00)
      span[5] = ac <= H24 || H29 <= ab ? 0 : Math.min(H29, ac) - Math.max(H24, ab)
      // AJ 29-46 `IF(AC<=VALUE("29:00"),0,AC-MAX(AB,VALUE("29:00")))`
      span[6] = ac <= H29 ? 0 : ac - Math.max(ab, H29)
    }
    // AK〜AQ 実労働 = 拘束 − 休憩 (`AK=AD-IF(I="",0,I)` を列ごとに 1 つずつずらした形)
    const [ak, al, am, an, ao, ap, aq] = [
      span[0]! - (cells.I ?? 0),
      span[1]! - (cells.J ?? 0),
      span[2]! - (cells.K ?? 0),
      span[3]! - (cells.L ?? 0),
      span[4]! - (cells.M ?? 0),
      span[5]! - (cells.N ?? 0),
      span[6]! - (cells.O ?? 0),
    ]
    // P `SUM(AK:AQ)`
    const total = ak + al + am + an + ao + ap + aq
    // W `IF(D[前の行]=1,SUM(AK,AL),0)+IF(D=1,SUM(AM:AO),0)+IF(D[次の行]=1,SUM(AP,AQ),0)`
    const holiday
      = (isLegalHoliday(day - 1) ? ak + al : 0)
        + (isLegalHoliday(day) ? am + an + ao : 0)
        + (isLegalHoliday(day + 1) ? ap + aq : 0)
    // U `IF(AND(1<=AA,AA<=5),0,IF(V[前の行]=$AB$3,P-W,IF(V[前の行]>($AB$3-(8/24)),MAX(V[前の行]+P-W-$AB$3,0),0)))`
    // 行 7 (冊の初日) の U は式でなく 0 の直書き
    const prevWeekTotal = out.length > 0 ? out[out.length - 1]!.weekTotal : null
    let weeklyOver = 0
    if (prevWeekTotal !== null && dayOfWeek > 5) {
      if (prevWeekTotal === limit) weeklyOver = total - holiday
      else if (prevWeekTotal > limit - H8) weeklyOver = Math.max(prevWeekTotal + total - holiday - limit, 0)
    }
    // T `IF(U>0,0,MAX(P-W-VALUE("8:00"),0))`
    const dailyOver = weeklyOver > 0 ? 0 : Math.max(total - holiday - H8, 0)
    // Q `IF(OR(G="",D=1),0,IF(U>0,MIN(E,P-U-W),MIN(E,P-W)))`
    let scheduled = 0
    if (g !== undefined && !isLegalHoliday(day)) {
      scheduled = weeklyOver > 0
        ? Math.min(scheduledOfDay, total - weeklyOver - holiday)
        : Math.min(scheduledOfDay, total - holiday)
    }
    // S `P-Q-T-U-W`
    const statutoryIn = total - scheduled - dailyOver - weeklyOver - holiday
    // V `IF(AA=1,SUM(Q,S),IF(AA=2,SUM(Q[1 行前]:Q,S[1 行前]:S),…))` — 週の起算曜日からその日までの Q + S。
    // 冊の初日より前の行は見出しなので 0 (週の途中から始まる冊は、その週だけ累計が小さい)
    inLimit.push(scheduled + statutoryIn)
    let weekTotal = 0
    for (let i = Math.max(0, inLimit.length - dayOfWeek); i < inLimit.length; i++) weekTotal += inLimit[i]!

    out.push({
      date: ymdOf(day),
      total,
      scheduled,
      statutoryIn,
      dailyOver,
      weeklyOver,
      weekTotal,
      holiday,
      // X `SUM(AL,AM,AO,AP)`
      night: al + am + ao + ap,
    })
  }
  return out
}

// ---- Y金額 シートの時間の行 ----

/** Y金額 シートの 1 賃金月度の時間の行 (分) */
export interface YKingakuMonth {
  /** X 列 対象期間の初日 */
  from: string
  /** Z 列 対象期間の末日 */
  to: string
  /** E 列 法内残業 = Y時間 S 列の合計 */
  statutoryIn: number
  /** F 列 法外残業 = Y時間 T 列 + U 列の合計 */
  statutoryOut: number
  /** G 列 月 60h 超 = `MAX(F-VALUE("60:00"),0)`。`要素!U27` が FALSE なら「不適用」= null */
  over60: number | null
  /** H 列 休日労働 = Y時間 W 列の合計 */
  holiday: number
  /** I 列 深夜労働 = Y時間 X 列の合計 */
  night: number
  /** J 列 総労働時間 = Y時間 P 列の合計 */
  total: number
}

/**
 * 賃金月度の区切り (Y金額 X 列・Z 列)。
 *
 * - 最初 (行 6): 締め日が「末」なら `X=EOMONTH(F3,-1)+1` / `Z=EOMONTH(F3,0)`。日なら
 *   `Z=IF(DAY(F3)>締め日, DATE(翌月の年, 翌月, 締め日), DATE(年, 月, 締め日))` / `X=EDATE(Z,-1)+1`
 * - 次 (行 8 以降): `X=IF(Z[前]+1<=I3, Z[前]+1, "")` / `Z=IF(締め日="末",EOMONTH(X,0),EDATE(Z[前],1))`
 *
 * 最初の月度の初日は期間の初日より前、最後の月度の末日は期間の末日より後になり得る
 * (Excel の対象期間の表示もそうなる)。
 */
function wageMonths(period: YKingakuPeriod, closingDay: 'end' | number): { from: number, to: number }[] {
  const first = dayNumber(period.from)
  const last = dayNumber(period.to)
  let from: number
  let to: number
  if (closingDay === 'end') {
    from = eomonth(first, -1) + 1
    to = eomonth(first, 0)
  }
  else {
    const f = new Date(first * DAY_MS)
    const base = f.getUTCDate() > closingDay ? new Date(edate(first, 1) * DAY_MS) : f
    to = excelDate(base.getUTCFullYear(), base.getUTCMonth() + 1, closingDay)
    from = edate(to, -1) + 1
  }
  const out: { from: number, to: number }[] = []
  while (from <= last) {
    out.push({ from, to })
    from = to + 1
    to = closingDay === 'end' ? eomonth(from, 0) : edate(to, 1)
  }
  return out
}

/**
 * Y金額 シートの時間の行を、賃金月度ごとに出す。
 * **入力が 1 日も無い冊は 0 行** (運行 0 件の冊に、0:00 の並んだ表を出さない)。
 */
export function computeYKingaku(
  inputDays: readonly YTimeInputDay[],
  period: YKingakuPeriod,
  settings: YKingakuSettings,
): YKingakuMonth[] {
  if (inputDays.length === 0) return []
  const days = computeYKingakuDays(inputDays, period, settings)
  return wageMonths(period, settings.closingDay).map(({ from, to }) => {
    const month: YKingakuMonth = {
      from: ymdOf(from), to: ymdOf(to), statutoryIn: 0, statutoryOut: 0, over60: null, holiday: 0, night: 0, total: 0,
    }
    // `SUMIFS(Y時間!列, Y時間!$A, ">="&X, Y時間!$A, "<="&Z)`
    for (const d of days) {
      if (d.date < month.from || d.date > month.to) continue
      month.statutoryIn += d.statutoryIn
      month.statutoryOut += d.dailyOver + d.weeklyOver
      month.holiday += d.holiday
      month.night += d.night
      month.total += d.total
    }
    if (settings.over60Applies) month.over60 = Math.max(month.statutoryOut - 3600, 0)
    return month
  })
}

/** 冊の合計行。月 60h 超は不適用の月が 1 つでもあれば null (適用は冊で 1 つの設定) */
export function sumYKingakuMonths(months: readonly YKingakuMonth[]): Omit<YKingakuMonth, 'from' | 'to'> {
  const sum = { statutoryIn: 0, statutoryOut: 0, over60: 0 as number | null, holiday: 0, night: 0, total: 0 }
  for (const m of months) {
    sum.statutoryIn += m.statutoryIn
    sum.statutoryOut += m.statutoryOut
    sum.over60 = sum.over60 === null || m.over60 === null ? null : sum.over60 + m.over60
    sum.holiday += m.holiday
    sum.night += m.night
    sum.total += m.total
  }
  return sum
}

// ---- 応答ヘッダ (`x-y-time-kingaku`) の形 ----

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 月度の配列を応答ヘッダの値にする。1 月度 = `[from, to, 法内, 法外, 60h超, 休日, 深夜, 総]` の
 * 配列 (キー名を持たせず短くする)。JSON を `encodeURIComponent` で ASCII に落とす。
 */
export function encodeYKingakuHeader(months: readonly YKingakuMonth[]): string {
  return encodeURIComponent(JSON.stringify(
    months.map((m) => [m.from, m.to, m.statutoryIn, m.statutoryOut, m.over60, m.holiday, m.night, m.total]),
  ))
}

/** `encodeYKingakuHeader` の逆。形が違えば null (壊れた値を 0 として出さない) */
export function decodeYKingakuHeader(raw: string): YKingakuMonth[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeURIComponent(raw))
  }
  catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const months: YKingakuMonth[] = []
  for (const row of parsed as unknown[]) {
    if (!Array.isArray(row) || row.length !== 8) return null
    const [from, to, statutoryIn, statutoryOut, over60, holiday, night, total] = row as unknown[]
    if (typeof from !== 'string' || !YMD_RE.test(from) || typeof to !== 'string' || !YMD_RE.test(to)) return null
    if (![statutoryIn, statutoryOut, holiday, night, total].every((v) => typeof v === 'number' && Number.isFinite(v))) return null
    if (over60 !== null && !(typeof over60 === 'number' && Number.isFinite(over60))) return null
    months.push({
      from, to,
      statutoryIn: statutoryIn as number,
      statutoryOut: statutoryOut as number,
      over60: over60 as number | null,
      holiday: holiday as number,
      night: night as number,
      total: total as number,
    })
  }
  return months
}
