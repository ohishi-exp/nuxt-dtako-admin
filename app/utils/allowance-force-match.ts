/**
 * **卸しイベントが無い便に、一番星の明細を手で結びつける (強制突合)** (pure)。
 *
 * デジタコの便は**積みイベント 1 つ = 1 便**で、卸地は後続の降しイベントから取る。
 * ところが**運行終了の後に卸している**運行があり、その便には降しが 1 つも付かない
 * (実例 2026-07-16 の運行: `09:31 積み 釧路市西港` → `10:17 運転 123.2km` →
 * `12:21 運行終了 音更町駒場北町` で終わり)。
 *
 * `carryOverDest` (次の運行の先頭の降しから引き継ぐ) が当たればよいが、翌日以降に
 * 卸している・次の運行が引けていない等で当たらないことがある。そのとき便は
 * **卸地が永久に決まらず、手当も売上も付かない**。
 *
 * **一番星には卸地も金額もある。** 人が「この便はこの明細」と決められれば、
 * 卸地・手当・売上がまとめて決まる。**推測では結ばない — 人が選ぶ。**
 *
 * ## 便のキーは `allowance-excluded.ts` と同じ
 *
 * `運行NO#t<積みの開始日時>`。イベントCSV を取り直して積みが増減しても同じ便を指す
 * (`seq` は順番なのでずれる)。結んだ相手は一番星の `rowId` (`管理年月日-管理C`) で、
 * こちらも**値カラムに依存しない安定キー**なので、金額が直されても外れない。
 */
import { excludedKey, type ExcludableRow } from './allowance-excluded'
import { resolveSlipDest } from './allowance-ichiban-legs'
import type { RateRow } from './allowance-rate-master'
import { dayDiff, DATE_SLACK } from './allowance-ichiban'
import { placeKey, type AllowanceLookup } from './allowance-rate'
import { addressToCity, cityToPlace, type LegAllowance } from './allowance-trips'
import { provisionalFor, type ProvisionalMap } from './allowance-provisional'
import type { AllowanceReportRow, OperationAllowance } from './allowance-report'
import type { VehicleDailySlip } from './ichiban'

/** localStorage のキー。**形を変えるときは番号を上げる。** */
export const FORCE_MATCH_KEY = 'dtako:allowance:force-match:v1'

/** 便のキー → 結びつけた一番星明細の `rowId`。 */
export type ForceMatchMap = Record<string, string[]>

/**
 * 保存済みの強制突合を読む。**壊れていても投げない** — 空として扱う。
 * 空配列のキーは捨てる (「結んだが 0 件」は「結んでいない」と同じ)。
 */
export function parseForceMatch(raw: string | null | undefined): ForceMatchMap {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: ForceMatchMap = {}
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key || !Array.isArray(value)) continue
    const ids = [...new Set(value.filter((v): v is string => typeof v === 'string' && v !== ''))]
    if (ids.length > 0) out[key] = ids
  }
  return out
}

export function serializeForceMatch(map: ForceMatchMap): string {
  return JSON.stringify(map)
}

/** 便に明細を結ぶ / 外す。**同じ明細をもう一度渡せば外れる。** */
export function toggleForceMatch(map: ForceMatchMap, legKey: string, rowId: string): ForceMatchMap {
  if (!legKey || !rowId) return map
  const next = { ...map }
  const ids = next[legKey] ?? []
  const kept = ids.filter(id => id !== rowId)
  if (kept.length === ids.length) next[legKey] = [...ids, rowId]
  else if (kept.length > 0) next[legKey] = kept
  else delete next[legKey]
  return next
}

/** その便の結びつけを全部外す。 */
export function clearForceMatch(map: ForceMatchMap, legKey: string): ForceMatchMap {
  if (!(legKey in map)) return map
  const next = { ...map }
  delete next[legKey]
  return next
}

/** 便のキー (`allowance-excluded.ts` と共通)。 */
export function forceMatchKey(row: ExcludableRow): string {
  return excludedKey(row)
}

/** 便の積地 (マスタ語彙)。デジタコの住所から取る。 */
export function legOrigin(row: Pick<AllowanceReportRow, 'originCity'>): string {
  return cityToPlace(addressToCity(row.originCity))
}

/** 強制突合の結果。 */
export interface ForcedLeg {
  slips: VehicleDailySlip[]
  salesYen: number
  quantity: number
  /** 明細から決めた卸地。 */
  dest: string
  /**
   * 決めた卸地でのマスタの引き当て。**そのまま便に移して集計に反映させる**
   * (`forcedLegAllowance`)。金額だけでなく `status` も要るので、
   * `masterDest` / `allowanceYen` と別に丸ごと持つ。
   */
  lookup: AllowanceLookup
  /** マスタで引けた卸地。引けなければ空。 */
  masterDest: string
  /** マスタ → 暫定 の順で決めた手当。どちらも無ければ null。 */
  allowanceYen: number | null
  /** 暫定を当てた。 */
  isProvisional: boolean
}

/**
 * 結びつけた明細から、その便の卸地・手当・売上を決める。
 *
 * **積地はデジタコ側を使う** — 一番星の `発地N` は空のことがあり、便の積地は
 * デジタコの積みイベントで確定しているため。
 */
export function forcedLeg(
  row: Pick<AllowanceReportRow, 'originCity'>,
  slips: VehicleDailySlip[],
  provisional: ProvisionalMap,
  master?: RateRow[],
): ForcedLeg {
  const origin = legOrigin(row)
  const { dest, lookup } = resolveSlipDest(origin, slips, master)
  const masterDest = lookup.status === 'ok' ? lookup.dest : ''
  const provisionalYen = lookup.status === 'ok'
    ? null
    : provisionalFor({ allowanceYen: null, originCity: origin, destCity: dest, masterDest }, provisional)
  return {
    slips,
    salesYen: slips.reduce((sum, s) => sum + s.amount, 0),
    quantity: slips.reduce((sum, s) => sum + s.quantity, 0),
    dest,
    lookup,
    masterDest,
    allowanceYen: lookup.status === 'ok' ? lookup.allowanceYen : provisionalYen,
    isProvisional: provisionalYen !== null,
  }
}

/** 強制突合を当てた便 (キー → 結果)。**明細が 1 つも引けないキーは出さない。** */
export function resolveForceMatches(
  rows: AllowanceReportRow[],
  map: ForceMatchMap,
  slipsByRowId: Map<string, VehicleDailySlip>,
  provisional: ProvisionalMap,
  master?: RateRow[],
): Map<string, ForcedLeg> {
  const out = new Map<string, ForcedLeg>()
  for (const row of rows) {
    const key = forceMatchKey(row)
    const ids = map[key]
    if (ids === undefined) continue
    const slips = ids.map(id => slipsByRowId.get(id)).filter((s): s is VehicleDailySlip => s !== undefined)
    if (slips.length === 0) continue
    out.set(key, forcedLeg(row, slips, provisional, master))
  }
  return out
}

/**
 * **強制突合で決まった卸地・手当を、その便の引き当て結果に映す。**
 *
 * 集計 (`buildMonthlyAllowance`) に渡す**前**に当てるのが肝。便の行
 * (`AllowanceReportRow`) の卸地・マスタ卸地・手当・状態は `toReportRows` が
 * `LegAllowance` から作るので、ここで映しておけば
 *
 * - 便の行の「積地 → 卸地」
 * - 経路キー (`allowance-provisional.ts` の `routeKey` = 暫定手当と手当表PDF との突合)
 * - 便数・手当・未確定の数え方
 *
 * が**全部同じ 1 か所から**追従する。表示側で差し替えると、経路だけ直って
 * 数え方が置き去りになる (実際 `釧路 → (不明)` のまま PDF 突合が「経路違い」で
 * 当たっていた)。
 *
 * **`lookup` は丸ごと差し替える。** 元の引き当ては卸地が空のまま引いたもの
 * (必ず `unknown`) なので、残しても意味が無い。暫定手当はここでは当てない —
 * 経路キーで当てるのが `allowance-provisional.ts` の役目で、ここで確定に混ぜると
 * 「うち暫定」に数えられなくなる。
 */
export function forcedLegAllowance(item: LegAllowance, forced: ForcedLeg): LegAllowance {
  return { leg: { ...item.leg, destCity: forced.dest }, lookup: forced.lookup, destSource: 'forced' }
}

/**
 * 強制突合を運行の引き当て結果に当てる。**結んでいない運行・便はそのまま**
 * (中身が同じなら同じ参照を返す — 無駄に identity を変えると、これを読む
 * `computed` が作り直されて表の開閉が飛ぶ)。
 */
export function applyForcedLegs(
  ops: OperationAllowance[],
  forced: Map<string, ForcedLeg>,
): OperationAllowance[] {
  if (forced.size === 0) return ops
  return ops.map((op) => {
    let touched = false
    const legs = op.legs.map((item, i) => {
      const hit = forced.get(forceMatchKey({ unkoNo: op.unkoNo, seq: i + 1, fromTs: item.leg.fromTs }))
      if (hit === undefined) return item
      touched = true
      return forcedLegAllowance(item, hit)
    })
    return touched ? { ...op, legs } : op
  })
}

/**
 * その便に結べる候補の明細。
 *
 * **同じ乗務員の月ぶんの明細から、日付が ±`DATE_SLACK` 日のものだけ**を出す。
 * 既にどこかの便 (自動でも強制でも) に使われている明細は出さない — 同じ売上を
 * 2 つの便に付けないため。**その便に既に結んである明細は残す** (外せなくなるので)。
 *
 * 積地が分かっている便は**積地が一致する明細を先に**並べる。運行終了後に卸した便は
 * 積地だけが確かなので、そこを手がかりにする。
 */
export function forceMatchCandidates(
  row: Pick<AllowanceReportRow, 'originCity' | 'date'>,
  slips: VehicleDailySlip[],
  usedRowIds: Set<string>,
  ownRowIds: string[],
): VehicleDailySlip[] {
  const origin = legOrigin(row)
  const own = new Set(ownRowIds)
  const near = slips.filter(slip => (own.has(slip.rowId) || !usedRowIds.has(slip.rowId))
    && dayDiff(slip.saleDate, row.date) <= DATE_SLACK)
  const sameOrigin = near.filter(slip => placeKey(slip.origin) === origin && origin !== '')
  const others = near.filter(slip => !sameOrigin.includes(slip))
  return [...sameOrigin, ...others]
}
