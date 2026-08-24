/**
 * 賃金構成 (Refs #760 の 40) の**「現状」を実支給にする**口 (Refs #814)。
 *
 * PR #813 の「現状」は **旅費の母数 ＋ 一律残業代 ¥10,000** の推計だった。実際に
 * 払った額は**一番星の経費明細の経費種別 `08 給与(人件費)`** に載っていて、
 * `運転手C` (乗務員CD) で畳むと上司向け資料の支給額と**一円まで一致する**
 * (2026-07 / 帯広5名で実測):
 *
 * ```
 * 1412 中村 619,000 / 1587 柳井 562,500 / 1656 西島 552,500
 * 1732 佐竹 572,000 / 1742 増地 509,000            計 2,815,000
 * ```
 *
 * **佐竹の ¥572,000 は 07-27 の過払い ¥1,000 込みで、これが正しい値**
 * (オーナー判断で調整しない)。推計 (母数 ¥561,000 ＋ ¥10,000 = ¥571,000) との
 * ¥1,000 の差はそのまま出す。
 *
 * ## 乗務員CD で畳む (車番では畳めない)
 *
 * 中村・柳井・西島は**車輌をまたぐので給与の行が 2 本に分かれる**。粗利タブが
 * 按分のために引いている経費 (`margin.ts` の `fetchVehicleCosts`) は**車番**で
 * 引くので、その月に粗利へ乗っていない車輌に給与が付いていると落ちる。ここは
 * **`driver` (乗務員CD) ＋ `kind=08` で乗務員ごとに引く** — 車輌をまたいでも
 * 取りこぼさず、会社全体の給与を画面に持ち込まずに済む。
 *
 * ## 上限で切れたら黙って短い額を出さない
 *
 * 上流 (`/api/costs/vehicle-daily`) は `limit` 未指定だと **500 件で切る**。
 * 上限の 5000 を明示したうえで、**返ってきた件数が上限に届いていたら期間を半分に
 * 割って引き直す**。1 日まで割っても届くなら**投げる** — 切れた行を黙って落とすと
 * 実支給が静かに小さく出て、推計より質の悪い数字になる。
 *
 * **`margin.ts` は 1 行も触らない。** 粗利の数字 (運行 91 本 / 売上 ¥10,260,265 /
 * 手当 ¥2,499,500 / 粗利 ¥4,467,597) にはこの口は 1 円も効かない。
 */

import { costYen, mapCostApiRow, type CostRow, type CostsDailyApiRow } from './margin'
import { epochToYmd } from './ichiban'

/** `経費種別C` の `08 給与(人件費)`。**`11 賞与・調整金` は含めない** (別物)。 */
export const SALARY_COST_KIND = '08'

/** 上流 (`/api/costs/vehicle-daily`) の `limit` の上限。既定の 500 では足りない。 */
export const SALARY_FETCH_LIMIT = 5000

/** 半開区間 (`from` 以上 `to` 未満)。`monthCostRange` と同じ規約。 */
export interface CostDateRange {
  from: string
  to: string
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 期間を前半・後半に割る。**割れなければ `null`** — 日付が読めない / 1 日しかない
 * 場合で、呼び出し側はここで「これ以上引き直せない」と分かる。
 */
export function splitCostDateRange(from: string, to: string): { first: CostDateRange, second: CostDateRange } | null {
  const startMs = Date.parse(`${from}T00:00:00Z`)
  const endMs = Date.parse(`${to}T00:00:00Z`)
  // **壊れた日付は割らない。** `Date.parse` は読めないと NaN を返す。
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  const days = Math.round((endMs - startMs) / DAY_MS)
  if (days < 2) return null
  const mid = epochToYmd((startMs + Math.floor(days / 2) * DAY_MS) / 1000)
  return { first: { from, to: mid }, second: { from: mid, to } }
}

/**
 * 経費明細を**乗務員CD で畳んで実支給にする**。
 *
 * - `08` 以外の行は数えない (`kind` で絞って引いていても、混ざった配列を渡されても
 *   同じ答えになるようにしておく)
 * - **乗務員CD が空の行は落とす** — 誰の給与か決まらない行を `''` のキーに積むと、
 *   乗務員CD を引けなかった行 (`AllowanceBaseRow.driverCd === ''`) が偶然それを
 *   拾って、他人の給与を自分の実支給として表示してしまう
 * - 額は `costYen` (= `税抜金額` ＋ `軽油引取税`)。給与の `軽油引取税` は 0 だが、
 *   0 でない行が来たときに黙って落とさない (`margin.ts` と同じ扱い)
 */
export function foldSalaryByDriver(rows: readonly CostRow[]): Record<string, number> {
  const byDriver: Record<string, number> = {}
  for (const row of rows) {
    if (row.costKind !== SALARY_COST_KIND) continue
    const cd = row.driverCode.trim()
    if (cd === '') continue
    byDriver[cd] = (byDriver[cd] ?? 0) + costYen(row)
  }
  return byDriver
}

/**
 * 乗務員 1 人ぶんの給与行を引く (`/api/ichiban/*` proxy 経由)。
 *
 * **上限に届いたら期間を割って引き直す** (module doc 参照)。1 日まで割っても
 * 届くなら投げる — 切れたことを画面に出させるため。
 */
export async function fetchSalaryCostRows(driver: string, from: string, to: string): Promise<CostRow[]> {
  const res = await $fetch<{ source_table: string, data: CostsDailyApiRow[] }>(
    '/api/ichiban/api/costs/vehicle-daily',
    { query: { driver, kind: SALARY_COST_KIND, from, to, limit: String(SALARY_FETCH_LIMIT) } },
  )
  const rows = res.data.map(mapCostApiRow)
  if (rows.length < SALARY_FETCH_LIMIT) return rows
  const halves = splitCostDateRange(from, to)
  if (halves === null) {
    throw new Error(`乗務員 ${driver} の給与行が上限 ${SALARY_FETCH_LIMIT} 件で切れました (${from}〜${to}) — これ以上期間を割れません`)
  }
  const first = await fetchSalaryCostRows(driver, halves.first.from, halves.first.to)
  const second = await fetchSalaryCostRows(driver, halves.second.from, halves.second.to)
  return [...first, ...second]
}

/**
 * 乗務員CD の一覧ぶんの実支給を引く。**乗務員CD → 実支給 (円)。**
 *
 * 引けなかった乗務員をここで 0 にはしない — **返り値に鍵が無いこと**が
 * 「引けていない」で、`computeWageMixRow` がそれを推計に落として理由を出す。
 * 1 人でも失敗したら投げる (部分的に埋まった表を「実支給」と名乗らせない)。
 */
export async function fetchActualWageByDriver(
  driverCds: readonly string[],
  from: string,
  to: string,
): Promise<Record<string, number>> {
  const rows: CostRow[] = []
  for (const cd of driverCds) rows.push(...await fetchSalaryCostRows(cd, from, to))
  return foldSalaryByDriver(rows)
}
