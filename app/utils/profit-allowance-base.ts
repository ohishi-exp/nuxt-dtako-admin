/**
 * 賃金構成 (Refs #760 の 40) の**旅費の母数**を乗務員別に組み立てる (pure)。
 *
 * 旅費は「運行手当テーブル (便ごとの定額) の一定率」で決める。母数は
 * **実際に支給した手当**でなければ意味を持たない — 賃金構成は「払った額をどう
 * 三段に分けるか」の話なので、母数が実支給とずれると分けた先が全部ずれる。
 *
 * 粗利タブが持っている手当は**当月運行の便**のぶんで、実支給とは 2 つずれる
 * (2026-07 / 帯広5名で実測):
 *
 * ```
 * 2,499,500  粗利タブの手当    運行の開始日で切った当月運行の便すべて
 *   −55,000  翌月日付の便      その運行が持つ翌月日付の便 (翌月の給与になる)
 *  +319,500  粗利の対象外の便  デジタコに運行が無く粗利から落ちている便
 * ─────────
 * 2,764,000  運行手当タブ = 実際に支給した基本給 (過払い ¥1,000 を除く)
 * ```
 *
 * **翌月日付の便は運行の `legs[].date` から乗務員別に引ける** (実測で合計 ¥55,000 =
 * `CrossMonthLegs.nextMonthAllowanceYen` に一致)。**対象外の便だけが乗務員別に無い** —
 * `MarginCache` (`margin.ts`) は合計しか持たないため。`margin.ts` は粗利の不変条件が
 * 乗る中核なので触らず、**`dtako:margin:leg-points:v1` と同じ「別キー」の作法**で
 * 乗務員別の対象外を持つ。片方が壊れてももう片方は動く。
 *
 * **対象外が取れていなければ 0 に倒さない** — `uncoveredYen: null` / `complete: false`
 * にして、画面が「当月運行の便のみの母数」と言い切れるようにする。0 として足すと
 * 西島 (実測で対象外 ¥203,500 = 手当の 4 割) の旅費が黙って 4 割低く出る。
 */

/** 乗務員別の対象外便を保存する localStorage キー。**`MARGIN_CACHE_KEY` とは別**。 */
export const UNCOVERED_BY_DRIVER_KEY = 'dtako:profit:uncovered-by-driver:v1'

/** 保存する形。`ym` は `MarginCache.ym` と同じ月で、違えば使わない。 */
export interface UncoveredByDriverCache {
  ym: string
  /** 乗務員CD → 対象外便の手当 (円)。 */
  byDriver: Record<string, number>
}

/** 母数の材料になる便 1 本 (`MarginOperationInput.legs` の必要な列だけ)。 */
export interface AllowanceBaseLeg {
  /** 便の日付 (`YYYY-MM-DD`)。 */
  date: string
  /** その便の手当 (確定 ?? 暫定 ?? 0)。 */
  allowanceYen: number
}

/** 母数の材料になる運行 1 本 (`MarginOperationInput` の必要な列だけ)。 */
export interface AllowanceBaseOperation {
  driverName: string
  legs: AllowanceBaseLeg[]
}

/** 乗務員 1 人ぶんの旅費の母数。 */
export interface AllowanceBaseRow {
  driverCd: string
  driverName: string
  /** 粗利タブの手当 (当月運行の便すべて)。 */
  operationYen: number
  /** そのうち**翌月日付の便**。母数から引く。 */
  nextMonthYen: number
  /** 粗利の対象外になっている便。**取れていなければ `null`** (0 に倒さない)。 */
  uncoveredYen: number | null
  /** 旅費の母数。`uncoveredYen` が null なら「当月運行の便のみ」の額。 */
  baseYen: number
  /** 母数が実支給ベース (対象外便まで含む) か。false なら画面で断る。 */
  complete: boolean
}

/** `YYYY-MM` の翌月。`2026-12` → `2027-01`。 */
export function nextYm(ym: string): string {
  const year = Number(ym.slice(0, 4))
  const month = Number(ym.slice(5, 7))
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return ''
  const carried = month === 12
  return `${carried ? year + 1 : year}-${String(carried ? 1 : month + 1).padStart(2, '0')}`
}

/**
 * 対象外の便を乗務員別に畳む。**`buildUncoveredLegs` の返り値をそのまま渡す。**
 *
 * 乗務員名 → 乗務員CD は呼び出し側 (`driverCdByName`) が持っているので受け取る。
 * **CD を引けない乗務員は落とす** — 名前で持つと拘束サマリ (CD 基準) と結べない。
 *
 * **金額の決まらなかった便 (`allowanceYen: null`) は数えない** — `summarizeIchibanLegs`
 * と同じ扱いにする。0 として足すと、乗務員別の和が画面に出ている対象外の合計
 * (`UncoveredTotals.allowanceYen`) と一致しなくなる。
 */
export function sumUncoveredByDriver(
  legs: readonly { driverName: string, allowanceYen: number | null }[],
  cdByName: ReadonlyMap<string, string>,
): Record<string, number> {
  const byDriver: Record<string, number> = {}
  for (const leg of legs) {
    if (leg.allowanceYen === null) continue
    const cd = cdByName.get(leg.driverName.trim())
    if (cd === undefined) continue
    byDriver[cd] = (byDriver[cd] ?? 0) + leg.allowanceYen
  }
  return byDriver
}

export function serializeUncoveredByDriver(cache: UncoveredByDriverCache): string {
  return JSON.stringify({ ym: cache.ym, byDriver: cache.byDriver })
}

/**
 * 保存済みの対象外便を読む。**壊れていても投げない** — 無かったことにする
 * (`parseMarginCache` / `parseLegPoints` と同じ流儀)。読めなければ母数は
 * 「当月運行の便のみ」に倒れ、画面がそう断る。
 */
export function parseUncoveredByDriver(raw: string | null | undefined): UncoveredByDriverCache | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const cache = parsed as { ym?: unknown, byDriver?: unknown }
  if (typeof cache.ym !== 'string') return null
  if (typeof cache.byDriver !== 'object' || cache.byDriver === null) return null
  const byDriver: Record<string, number> = {}
  for (const [cd, yen] of Object.entries(cache.byDriver as Record<string, unknown>)) {
    // **数でない値は落とす。** 0 に倒すと「対象外 0 円」と区別が付かなくなる。
    if (typeof yen === 'number' && Number.isFinite(yen)) byDriver[cd] = yen
  }
  return { ym: cache.ym, byDriver }
}

/**
 * 乗務員別の旅費の母数を組む。
 *
 * `uncoveredByDriver` が `null` (集計前 / 古いキャッシュ / 月違い) なら
 * **全員 `complete: false`** にする。個々の乗務員に対象外便が 1 本も無い場合
 * (実測の佐竹) は `uncoveredYen: 0` / `complete: true` — 「0 と分かっている」と
 * 「分からない」を混ぜない。
 *
 * `cdByName` に無い乗務員は CD を空文字にして残す (画面が拘束と結べないことを出す)。
 */
export function buildAllowanceBase(
  operations: readonly AllowanceBaseOperation[],
  ym: string,
  cdByName: ReadonlyMap<string, string>,
  uncoveredByDriver: Record<string, number> | null,
): AllowanceBaseRow[] {
  const next = nextYm(ym)
  const byName = new Map<string, { operationYen: number, nextMonthYen: number }>()
  for (const op of operations) {
    const name = op.driverName.trim()
    const acc = byName.get(name) ?? { operationYen: 0, nextMonthYen: 0 }
    for (const leg of op.legs) {
      acc.operationYen += leg.allowanceYen
      // **翌月日付の便は翌月の給与になる。** `next` が空 (月の形が壊れている) なら
      // 1 本も当たらないので、母数は当月運行ぶんそのままになる
      if (next !== '' && leg.date.slice(0, 7) === next) acc.nextMonthYen += leg.allowanceYen
    }
    byName.set(name, acc)
  }
  const rows: AllowanceBaseRow[] = []
  for (const [driverName, acc] of byName) {
    const driverCd = cdByName.get(driverName) ?? ''
    const uncoveredYen = uncoveredByDriver === null ? null : (uncoveredByDriver[driverCd] ?? 0)
    const baseYen = acc.operationYen - acc.nextMonthYen + (uncoveredYen ?? 0)
    rows.push({
      driverCd,
      driverName,
      operationYen: acc.operationYen,
      nextMonthYen: acc.nextMonthYen,
      uncoveredYen,
      baseYen,
      complete: uncoveredYen !== null,
    })
  }
  // 並びは**乗務員CD の昇順** (粗利タブの表と同じ)。CD が引けない行は末尾。
  return rows.sort((a, b) => {
    if (a.driverCd === b.driverCd) return a.driverName > b.driverName ? 1 : -1
    if (a.driverCd === '') return 1
    if (b.driverCd === '') return -1
    return a.driverCd > b.driverCd ? 1 : -1
  })
}
