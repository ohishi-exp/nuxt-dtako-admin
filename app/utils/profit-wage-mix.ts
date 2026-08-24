/**
 * 乗務員別の**賃金構成** (基本給 ＋ 残業 ＋ 旅費) の試算 (pure、Refs #760 の 40)。
 *
 * 帯広の給与は、いま**運行手当がそのまま基本給として支給され、上に全員一律
 * ¥10,000 の残業代が乗っているだけ**で、帳簿上「残業がほぼ無い」姿になっている。
 * これを三段に組み直すとどうなるかを粗利タブで見るための計算。
 *
 * ## 三段
 *
 * ```
 * 基本給   方式A: 法定内時間 × 単価        方式B: 日額 × 稼働日数
 * 残業     方式A: 割増係数h × 単価         方式B: 割増係数h × 日額 ÷ 8
 * 旅費     どちらも 運行手当テーブルの一定率 (`profit-allowance-base.ts` が母数を作る)
 *
 * 割増係数h = (時間外 × 1.25 ＋ 深夜 × 0.25 ＋ 法定休日 × 0.35) ÷ 60
 * 法定内時間 = 実働 − 時間外   (負にはしない)
 * ```
 *
 * ## 決まっていること (勝手に変えない)
 *
 * - **旅費は km 比例にできない。** 走行 0km で手当 ¥4,500 の便が実在する
 *   (2026-07 運行 001318 柳井 07-16。降しの記録が無く走行が 0 に落ちている)。
 *   距離を分母に置くとこの便は分母に何も足さずに手当だけ足す
 * - **総額を現状に固定しない。** 残業が増えれば総額が増えるのが判例上の要請
 *   (最高裁 2020-03-30 国際自動車事件)。旅費を「総額から賃金を引いた残り」で
 *   決めるとこの型に嵌まるので、**便ごとの定額の率**にしてある
 * - **単価・日額の下限は最低賃金** (北海道 ¥1,075、2025-10-04 発効)。方式A は
 *   単価 ¥1,075 以上、方式B は日額 ¥8,600 以上 (= 時給 ¥1,075)。
 *   **下回る入力はクランプせず警告する** — 黙って直すと入れた値と出た値が違う
 *   画面になる
 *
 * ## 拘束時間の出どころと、欠測の扱い
 *
 * 素材は **`/restraint-api/archive/summaries`** (R2 の拘束時間サマリ)。
 * **GCP (`day_summaries`) は使わない** — 行が欠けている (2026-07 実測で
 * 柳井 86.5h / 実績 264.5h = 33%)。archive の値は MCP `get_restraint_summary` と
 * 同一の R2 キーを読むことを本番で実測済み。
 *
 * ## 現状 (実支給) の出どころ (Refs #814)
 *
 * 「現状」の列は**一番星の経費明細 `08 給与(人件費)` を乗務員CD で畳んだ実支給**
 * (`profit-actual-wage.ts` が引く)。2026-07 / 帯広5名で上司向け資料の支給額と
 * **一円まで一致**する (計 ¥2,815,000)。**過払いも調整せずそのまま出す**
 * (佐竹の 07-27 ¥1,000。オーナー判断)。
 *
 * **引けなかった乗務員は 0 に倒さず、推計 (旅費の母数 ＋ 一律残業代) に落として理由を
 * 画面に出す。** 0 を現状として出すと「試算 − 現状」の差が丸ごと嘘になる。
 * 一律残業代は**入力のまま**残してある (`WageMixSettings.flatOvertimeYen`) — 推計の
 * 仮定をコードに固定すると画面から動かせなくなるため。**画面は推計が 1 人でも居る
 * ときだけこの入力を出す。**
 *
 * **拘束が引けない乗務員は金額を出さず `null`。0 分に倒さない** — 0 で計算すると
 * 「働いていないから安い」という嘘の数字が出て、最低賃金割れの判定まで嘘になる
 * (この repo の思想。拘束×賃金タブも同じ扱い)。**旅費だけは出す** — 旅費は便で
 * 決まり拘束を 1 分も見ないため。ただし**合計には入れない**。
 */

/** 最低賃金 (北海道、2025-10-04 発効)。方式A の単価の下限。 */
export const MIN_HOURLY_WAGE_YEN = 1075

/** 1 日の所定労働時間。方式B の日額 ⇄ 時給の換算に使う。 */
export const SCHEDULED_HOURS_PER_DAY = 8

/** 方式B の日額の下限 (= 最低賃金 × 所定 8h)。 */
export const MIN_DAILY_WAGE_YEN = MIN_HOURLY_WAGE_YEN * SCHEDULED_HOURS_PER_DAY

/** 時間外の割増率 (労基法37条)。 */
export const OVERTIME_MULTIPLIER = 1.25
/** 深夜の割増率 (時間外と重ならない深夜そのもの)。 */
export const NIGHT_MULTIPLIER = 0.25
/** 法定休日の割増率。 */
export const HOLIDAY_MULTIPLIER = 0.35

/** 旅費率の目安 (資料が並べた 2 水準)。**自由に入れられる**ので上限ではない。 */
export const TRAVEL_RATE_PRESETS = [0.35, 0.4] as const
export const DEFAULT_TRAVEL_RATE = 0.35

/**
 * 現状の一律残業代の**既定値** (全員一律で乗っている額)。
 *
 * **実支給を引けなかった乗務員の推計にだけ効く** (Refs #814)。実支給が引けていれば
 * 1 円も使わない。**入力として振れる値のまま残す** — 推計に落ちたときの仮定を
 * コードに固定すると、画面から動かせない前提になって後退する。画面は
 * **推計が 1 人でも居るときだけ**この入力を出す。
 */
export const DEFAULT_FLAT_OVERTIME_YEN = 10000

/** 賃金の計算方式。`hours` = 方式A (時間で決める) / `days` = 方式B (日数で決める)。 */
export type WageMixMethod = 'hours' | 'days'

export const WAGE_MIX_METHOD_LABELS: Record<WageMixMethod, string> = {
  hours: 'A 時間 (法定内時間 × 単価)',
  days: 'B 日数 (日額 × 稼働日数)',
}

/** 拘束時間サマリのうち、賃金構成が読む列だけ。 */
export interface WageMixRestraint {
  /** 実働 (分)。 */
  workingMinutes: number | null
  /** 時間外 (分)。 */
  overtimeMinutes: number | null
  /** 深夜 (分)。 */
  nightMinutes: number | null
  /** 法定休日 (分)。**拘束時間サマリは持っていない**ので通常 null。 */
  holidayMinutes?: number | null
  /** 稼働日数。 */
  workDays: number
}

/** 乗務員 1 人ぶんの材料。 */
export interface WageMixInput {
  driverCd: string
  driverName: string
  /** 旅費の母数 (運行手当テーブルの引き当て額)。 */
  allowanceBaseYen: number
  /** 拘束時間サマリ。**引けていなければ null** (0 に倒さない)。 */
  restraint: WageMixRestraint | null
  /**
   * **実支給** (一番星の経費明細 `08 給与(人件費)` を乗務員CD で畳んだ額、Refs #814)。
   *
   * **引けていなければ null。0 に倒さない** — 0 を実支給として出すと「試算 − 現状」の
   * 差が丸ごと嘘になる。null なら推計 (母数 ＋ 一律残業代) に落として理由を出す。
   * **過払いは調整しない** (2026-07 佐竹の ¥1,000 はオーナー判断でそのまま)。
   */
  actualPayYen: number | null
  /**
   * `actualPayYen` が null の理由。**月ぜんぶが引けていない** (経費明細の取得に
   * 失敗した) ときに呼び出し側が差し替える。省略すると
   * `NO_ACTUAL_PAY_REASON` (この乗務員の行が無い) になる。
   */
  actualPayReason?: string
}

export interface WageMixSettings {
  method: WageMixMethod
  /** 方式A の時間単価 (円)。 */
  hourlyRateYen: number
  /** 方式B の日額 (円)。 */
  dailyRateYen: number
  /** 旅費率 (0.35 = 35%)。 */
  travelRate: number
  /**
   * 現状の一律残業代 (円/人)。**実支給を引けなかった乗務員の推計にだけ効く。**
   * 実支給が引けていれば 1 円も使わない。
   */
  flatOvertimeYen: number
}

export function defaultWageMixSettings(): WageMixSettings {
  return {
    method: 'hours',
    hourlyRateYen: MIN_HOURLY_WAGE_YEN,
    dailyRateYen: MIN_DAILY_WAGE_YEN,
    travelRate: DEFAULT_TRAVEL_RATE,
    flatOvertimeYen: DEFAULT_FLAT_OVERTIME_YEN,
  }
}

/** 乗務員 1 人ぶんの試算結果。**拘束が無い列は `null`** (0 ではない)。 */
export interface WageMixRow {
  driverCd: string
  driverName: string
  /** 旅費の母数。 */
  allowanceBaseYen: number
  /** 旅費。**拘束が無くても出せる** (便で決まるため)。 */
  travelYen: number
  /** 法定内時間 (時間)。 */
  statutoryHours: number | null
  /** 割増係数 (時間)。時間外×1.25 + 深夜×0.25 + 法定休日×0.35。 */
  premiumHours: number | null
  workDays: number | null
  baseWageYen: number | null
  overtimeYen: number | null
  /** 基本給 + 残業 + 旅費。**拘束が引けていなければ null。** */
  totalYen: number | null
  /**
   * 現状。**実支給** (経費明細 08 を乗務員CD で畳んだ額)。引けていなければ
   * 推計 (母数 ＋ 一律残業代) に落ちる (`currentEstimated` が true)。
   */
  currentYen: number
  /** `currentYen` が実支給でなく推計か。**画面で必ず断る。** */
  currentEstimated: boolean
  /** 推計に落ちた理由。実支給が引けていれば null。 */
  currentReason: string | null
  /** 試算 − 現状。`totalYen` が null なら null。 */
  diffYen: number | null
  /** 拘束が引けていない理由。引けていれば null。 */
  missingReason: string | null
}

/** 拘束が引けていない乗務員に出す理由 (画面にそのまま出す)。 */
export const NO_RESTRAINT_REASON = '拘束時間が取れていない (拘束時間サマリに行が無い)'
export const PARTIAL_RESTRAINT_REASON = '拘束時間が取れていない (実働 / 時間外 / 深夜 のいずれかが空)'

/** 実支給が引けていない乗務員に出す理由 (画面にそのまま出す)。 */
export const NO_ACTUAL_PAY_REASON = '実支給が取れていない (経費明細 08 給与(人件費) にこの乗務員の行が無い)'

/** 円に丸める。表示と合計で同じ丸めを使う (合計 ≠ 各行の和 を作らない)。 */
function yen(value: number): number {
  return Math.round(value)
}

/**
 * 乗務員 1 人を計算する。
 *
 * `restraint` が null、または実働 / 時間外 / 深夜 のどれかが null なら
 * **金額を出さず `missingReason` を立てる**。旅費だけは母数から出す。
 */
export function computeWageMixRow(input: WageMixInput, settings: WageMixSettings): WageMixRow {
  const travelYen = yen(input.allowanceBaseYen * settings.travelRate)
  // **現状は実支給。** 引けていなければ推計 (母数 ＋ 一律残業代) に落とすが、
  // **0 には倒さない** — 0 を現状として出すと差が丸ごと嘘になる。
  const currentEstimated = input.actualPayYen === null
  const currentYen = input.actualPayYen ?? (input.allowanceBaseYen + settings.flatOvertimeYen)
  const currentReason = currentEstimated ? (input.actualPayReason ?? NO_ACTUAL_PAY_REASON) : null
  const missing: WageMixRow = {
    driverCd: input.driverCd,
    driverName: input.driverName,
    allowanceBaseYen: input.allowanceBaseYen,
    travelYen,
    statutoryHours: null,
    premiumHours: null,
    workDays: null,
    baseWageYen: null,
    overtimeYen: null,
    totalYen: null,
    currentYen,
    currentEstimated,
    currentReason,
    diffYen: null,
    missingReason: NO_RESTRAINT_REASON,
  }
  const r = input.restraint
  if (r === null) return missing
  if (r.workingMinutes === null || r.overtimeMinutes === null || r.nightMinutes === null) {
    return { ...missing, missingReason: PARTIAL_RESTRAINT_REASON }
  }
  // **法定内は負にしない。** 時間外が実働を上回る (集計の食い違い) 月に
  // 「基本給がマイナス」を出すと、そのぶん総額が下がって嘘の割安になる
  const statutoryMinutes = Math.max(0, r.workingMinutes - r.overtimeMinutes)
  const holidayMinutes = r.holidayMinutes ?? 0
  const premiumMinutes
    = r.overtimeMinutes * OVERTIME_MULTIPLIER
      + r.nightMinutes * NIGHT_MULTIPLIER
      + holidayMinutes * HOLIDAY_MULTIPLIER
  const statutoryHours = statutoryMinutes / 60
  const premiumHours = premiumMinutes / 60
  const unitYen = settings.method === 'hours'
    ? settings.hourlyRateYen
    : settings.dailyRateYen / SCHEDULED_HOURS_PER_DAY
  const baseWageYen = settings.method === 'hours'
    ? yen(statutoryHours * settings.hourlyRateYen)
    : yen(r.workDays * settings.dailyRateYen)
  const overtimeYen = yen(premiumHours * unitYen)
  const totalYen = baseWageYen + overtimeYen + travelYen
  return {
    driverCd: input.driverCd,
    driverName: input.driverName,
    allowanceBaseYen: input.allowanceBaseYen,
    travelYen,
    statutoryHours,
    premiumHours,
    workDays: r.workDays,
    baseWageYen,
    overtimeYen,
    totalYen,
    currentYen,
    currentEstimated,
    currentReason,
    diffYen: totalYen - currentYen,
    missingReason: null,
  }
}

/** 月の合計。**金額を出せた乗務員だけ**を足す (欠測を 0 として混ぜない)。 */
export interface WageMixTotals {
  /** 乗務員の人数 (欠測込み)。 */
  drivers: number
  /** 金額を出せた人数。 */
  computed: number
  /** 拘束が取れず金額を出せなかった乗務員名。**画面に必ず出す。** */
  missingDrivers: string[]
  /**
   * 実支給を引けず**現状が推計に落ちた乗務員名** (Refs #814)。**画面に必ず出す。**
   * 拘束が取れず合計から外れた乗務員も含める — 表にはその行の現状が出るため。
   */
  estimatedDrivers: string[]
  /** そのうち**合計に入っている**人数 (拘束が取れて金額を出せた乗務員)。 */
  estimatedComputed: number
  /** **合計の `currentYen` に含まれている推計の額。** 混在を画面に出すために使う。 */
  estimatedCurrentYen: number
  allowanceBaseYen: number
  travelYen: number
  baseWageYen: number
  overtimeYen: number
  /** `baseWageYen + overtimeYen + travelYen` (この不変条件を崩さない)。 */
  totalYen: number
  currentYen: number
  diffYen: number
  statutoryHours: number
  premiumHours: number
  workDays: number
  /** 欠測の乗務員の旅費 (**合計には入れていない**額)。 */
  missingTravelYen: number
}

export function summarizeWageMix(rows: readonly WageMixRow[]): WageMixTotals {
  const totals: WageMixTotals = {
    drivers: rows.length,
    computed: 0,
    missingDrivers: [],
    estimatedDrivers: [],
    estimatedComputed: 0,
    estimatedCurrentYen: 0,
    allowanceBaseYen: 0,
    travelYen: 0,
    baseWageYen: 0,
    overtimeYen: 0,
    totalYen: 0,
    currentYen: 0,
    diffYen: 0,
    statutoryHours: 0,
    premiumHours: 0,
    workDays: 0,
    missingTravelYen: 0,
  }
  for (const row of rows) {
    // **合計に入る行かどうかに関わらず数える** — 表に出る現状はどの行も出るため。
    if (row.currentEstimated) totals.estimatedDrivers.push(row.driverName)
    if (row.totalYen === null) {
      totals.missingDrivers.push(row.driverName)
      totals.missingTravelYen += row.travelYen
      continue
    }
    totals.computed += 1
    // **混ぜたなら混ざったと言う。** 合計の現状のうち推計ぶんを別に持つ。
    if (row.currentEstimated) {
      totals.estimatedComputed += 1
      totals.estimatedCurrentYen += row.currentYen
    }
    totals.allowanceBaseYen += row.allowanceBaseYen
    totals.travelYen += row.travelYen
    totals.baseWageYen += row.baseWageYen ?? 0
    totals.overtimeYen += row.overtimeYen ?? 0
    totals.totalYen += row.totalYen
    totals.currentYen += row.currentYen
    totals.diffYen += row.diffYen ?? 0
    totals.statutoryHours += row.statutoryHours ?? 0
    totals.premiumHours += row.premiumHours ?? 0
    totals.workDays += row.workDays ?? 0
  }
  return totals
}

/** 方式B の日額を時給に直す (最低賃金の判定に使う)。 */
export function hourlyEquivalent(dailyRateYen: number): number {
  return dailyRateYen / SCHEDULED_HOURS_PER_DAY
}

/**
 * 単価 / 日額が最低賃金を下回っていれば警告文、満たしていれば null。
 * **クランプはしない** — 入れた値と出た値が違う画面を作らないため。
 */
export function minWageWarning(settings: WageMixSettings): string | null {
  if (settings.method === 'hours') {
    if (settings.hourlyRateYen >= MIN_HOURLY_WAGE_YEN) return null
    return `単価 ¥${settings.hourlyRateYen.toLocaleString()} は最低賃金 ¥${MIN_HOURLY_WAGE_YEN.toLocaleString()} を下回っています`
  }
  if (settings.dailyRateYen >= MIN_DAILY_WAGE_YEN) return null
  const hourly = Math.round(hourlyEquivalent(settings.dailyRateYen))
  return `日額 ¥${settings.dailyRateYen.toLocaleString()} は時給 ¥${hourly.toLocaleString()} 相当で、最低賃金 ¥${MIN_HOURLY_WAGE_YEN.toLocaleString()} を下回っています`
}

/** 旅費率の表示 (`0.35` → `35%`)。端数は 1 桁まで出す。 */
export function travelRateLabel(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`
}
