/**
 * マスタで手当が決まらない便に**暫定の手当**を当てる (pure)。
 *
 * 料金・給与マスタ (`帯広　バルク車　料金・給与一覧.xlsx`) は帯広の仕事を全部は
 * 網羅していない。実データで出た穴の例が **広尾 → 芽室** で、マスタには広尾発の
 * 卸地が 12 通り載っているのに芽室が 1 行も無い (どの積地からも 0 件)。この便は
 * 売上は一番星から出るのに手当だけ決まらず、収支が「経費を引く前の額」になる。
 *
 * **給与明細から金額が分かっていることがある** (2026-08-21 ユーザー: 広尾〜芽室 は
 * 9,000 円)。マスタを直すまでの間、その額を入れて収支を出せるようにする。
 *
 * **暫定は確定と混ぜない。** 合計には入れるが、
 * **「うち暫定 ¥N (M便)」を必ず併記する**のが呼び出し側の責務。
 *
 * ## 便ごとではなく経路ごとに持つ
 *
 * 同じ穴は月に何便も出る (広尾〜芽室 は 2026-07 だけで複数)。**便ごとに入れさせると
 * 入れ漏れが起きて合計が静かにズレる**ので、`積地|卸地` の経路キーで持って、
 * 同じ経路の便すべてに一度で効かせる。
 */
import { addressToCity, cityToPlace } from './allowance-trips'
import { normalizePlace } from './allowance-rate'
import type { AllowanceReportRow } from './allowance-report'

/** localStorage のキー。**形を変えるときは番号を上げる。** */
export const PROVISIONAL_KEY = 'dtako:allowance:provisional:v1'

/** 経路キーを組むのに要る分だけ。 */
export type RouteRow = Pick<AllowanceReportRow, 'originCity' | 'destCity' | 'masterDest'>

/**
 * 便の経路キー (`広尾|芽室`)。
 *
 * 卸地は**マスタで決まっていればその語彙**を、決まっていなければデジタコの住所から
 * 取り出した市町村名を使う。暫定を入れるのは後者だけだが、キーの作り方を分けると
 * 「マスタに行が入った瞬間にキーが変わって暫定が外れる」挙動が読めなくなるので、
 * どちらも同じ関数で組む。
 *
 * 積地・卸地のどちらも取れなければ空文字 (= 暫定を当てられない)。
 */
export function routeKey(row: RouteRow): string {
  const origin = cityToPlace(addressToCity(row.originCity))
  const master = normalizePlace(row.masterDest)
  const dest = master || cityToPlace(addressToCity(row.destCity))
  if (!origin && !dest) return ''
  return `${origin}|${dest}`
}

/** 経路キー → 暫定の手当 (円/便)。 */
export type ProvisionalMap = Record<string, number>

/**
 * 保存済みの暫定手当を読む。**壊れていても投げない** — 空として扱う。
 * 数でない値・0 以下・整数でない値は捨てる (給与に混ざる数字なので緩めない)。
 */
export function parseProvisional(raw: string | null | undefined): ProvisionalMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: ProvisionalMap = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) continue
    out[key] = value
  }
  return out
}

export function serializeProvisional(map: ProvisionalMap): string {
  return JSON.stringify(map)
}

/**
 * 暫定手当を入れる。**0 以下・整数でない値・空キーは「消す」扱い**にする
 * (入力欄を空にしたら外れる、が素直な操作なので)。
 */
export function setProvisional(map: ProvisionalMap, key: string, yen: number): ProvisionalMap {
  const next = { ...map }
  if (!key || !Number.isInteger(yen) || yen <= 0) delete next[key]
  else next[key] = yen
  return next
}

/**
 * その便に効く暫定手当。**マスタで金額が決まっている便には当てない**
 * (確定を暫定で上書きすると、マスタを直したのに画面が変わらなくなる)。
 */
export function provisionalFor(
  row: Pick<AllowanceReportRow, 'allowanceYen'> & RouteRow,
  map: ProvisionalMap,
): number | null {
  if (row.allowanceYen !== null) return null
  return map[routeKey(row)] ?? null
}

export interface ProvisionalTotals {
  /** 暫定が当たった便数。 */
  trips: number
  /** 暫定の合計 (円)。**確定の手当とは別に数える。** */
  yen: number
  /** 暫定も当たらなかった便数 (= 手当がまるごと不明)。 */
  missingTrips: number
}

export function emptyProvisionalTotals(): ProvisionalTotals {
  return { trips: 0, yen: 0, missingTrips: 0 }
}

/** 手当が決まらない便のうち、暫定が当たったぶんを合計する。 */
export function summarizeProvisional(
  rows: (Pick<AllowanceReportRow, 'allowanceYen'> & RouteRow)[],
  map: ProvisionalMap,
): ProvisionalTotals {
  const totals = emptyProvisionalTotals()
  for (const row of rows) {
    if (row.allowanceYen !== null) continue
    const yen = provisionalFor(row, map)
    if (yen === null) {
      totals.missingTrips += 1
      continue
    }
    totals.trips += 1
    totals.yen += yen
  }
  return totals
}

/** 暫定を入れられる経路の一覧 (同じ経路は 1 行に畳む)。入力欄を並べるのに使う。 */
export interface ProvisionalRoute {
  key: string
  /** その経路の便数。 */
  trips: number
  /** いま入っている暫定額。未設定なら null。 */
  yen: number | null
  /** 表示用 (`広尾 → 芽室`)。 */
  label: string
}

export function provisionalRoutes(
  rows: (Pick<AllowanceReportRow, 'allowanceYen'> & RouteRow)[],
  map: ProvisionalMap,
): ProvisionalRoute[] {
  const byKey = new Map<string, ProvisionalRoute>()
  for (const row of rows) {
    if (row.allowanceYen !== null) continue
    const key = routeKey(row)
    if (!key) continue
    const hit = byKey.get(key)
      ?? { key, trips: 0, yen: map[key] ?? null, label: key.replace('|', ' → ') }
    hit.trips += 1
    byKey.set(key, hit)
  }
  return [...byKey.values()].sort((a, b) => (a.key > b.key ? 1 : -1))
}
