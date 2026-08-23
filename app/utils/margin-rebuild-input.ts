/**
 * 粗利タブの集計から、**釧路営業所発の組み直し試算 (`kushiro-doto-rebuild.ts`) の入力**
 * を組み立てる (pure — DOM も fetch も持たない。Refs #760 の 35)。
 *
 * ```
 * イベントCSV ─ buildOperationRoute ─ markers ─ legPointsByLegSeq ─┐
 *            └ extractOperationIdle ─ legKmDetail ─ buildMarginLegs ┴─ ここ ─ RebuildOperationInput[]
 * ```
 *
 * ## なぜ `OperationMargin` (計算結果) からは組めないのか
 *
 * `RebuildLegInput` が要る `haulSec` / `deadheadSec` は **`MarginLegInput` (入力) には
 * あるが `LegMargin` (計算結果) には無い**。⇒ 入力側 (`MarginOperationInput[]` =
 * 粗利タブの `inputs`) から組む。**`margin.ts` には 1 行も足していない** — 95KB・
 * カバレッジ 100% の中核で、粗利の不変条件が乗っているため。
 *
 * ## GPS は新しく解析しない
 *
 * 積地・卸地の実測 GPS は `buildOperationRoute` が既に出している `markers`
 * (`kind: 'load' | 'unload'` / `legSeq`) をそのまま畳むだけ。**便の切り方の判定を
 * ここで二重化しない** — `legSeq` は `allowance-idle.ts` と同じ行で切られていて
 * `MarginLegInput.seq` と一致する (`operation-route-map.ts` 冒頭の契約)。
 *
 * ## 欠測は必ず `null` (0 に倒さない)
 *
 * 座標が取れない便は `loadPoint` / `unloadPoint` を `null` のまま渡す。
 * `addRebuildLeg` が `missingLegs` として数え、推定の母集団から外す。
 * **0 に倒すと「営業所の目の前で積んだ便」に化けて、営業所どうしの差が壊れる。**
 */
import { isValidLatLng } from './depot-distance'
import type { LatLng, RouteMarker } from './operation-route-map'
import type { RebuildLegInput, RebuildOperationInput } from './kushiro-doto-rebuild'
import type { MarginLegInput, MarginOperationInput } from './margin'

/** 便 1 本ぶんの実測 GPS。取れなければ `null` (**0 に倒さない**)。 */
export interface LegPoints {
  loadPoint: LatLng | null
  unloadPoint: LatLng | null
}

/**
 * `buildOperationRoute` の marker を **便 (`legSeq`) ごとの積地・卸地**に畳む。
 *
 * - `start` / `end` の marker は `legSeq` が `null` なので、その 1 つの門で落ちる
 *   (`kind` を見て選り分ける必要が無い — `operation-route-map.ts` の契約)
 * - 同じ便に `load` / `unload` は**それぞれ高々 1 つ**しか出ない (積みは便の頭、
 *   降しはその便の最後の 1 行)。⇒ 重複の解決を書かず、そのまま入れる
 * - marker が 1 つも無い便はこの Map に**現れない**。呼び出し側 (`buildRebuildOperationInputs`)
 *   が `null` で埋める
 */
export function legPointsByLegSeq(markers: readonly RouteMarker[]): Map<number, LegPoints> {
  const points = new Map<number, LegPoints>()
  for (const marker of markers) {
    if (marker.legSeq === null) continue
    const entry = points.get(marker.legSeq) ?? { loadPoint: null, unloadPoint: null }
    if (marker.kind === 'load') entry.loadPoint = { lat: marker.lat, lng: marker.lng }
    else entry.unloadPoint = { lat: marker.lat, lng: marker.lng }
    points.set(marker.legSeq, entry)
  }
  return points
}

/** 便 1 本を `RebuildLegInput` に写す。**座標以外は `MarginLegInput` をそのまま運ぶ。** */
function toRebuildLeg(leg: MarginLegInput, points: LegPoints | undefined): RebuildLegInput {
  return {
    seq: leg.seq,
    originCity: leg.originCity,
    destCity: leg.destCity,
    salesYen: leg.salesYen,
    allowanceYen: leg.allowanceYen,
    haulKm: leg.haulKm,
    deadheadKm: leg.deadheadKm,
    loadPoint: points?.loadPoint ?? null,
    unloadPoint: points?.unloadPoint ?? null,
    haulSec: leg.haulSec,
    deadheadSec: leg.deadheadSec,
  }
}

/**
 * 粗利タブの入力 (`inputs`) + 便ごとの GPS → **組み直し試算の入力**。
 *
 * - 便は **`seq` の昇順に並べ直す** — 「最初の積地」「最後の卸地」を順序に依存させない
 * - `firstLoadPoint` / `lastUnloadPoint` は **先頭の便の積地 / 末尾の便の卸地**。
 *   その便の座標が取れていなければ `null` (**次の便の座標で代用しない** — 出庫は
 *   1 便目の積地へ向かう移動、帰庫は最終便の卸地からの移動なので、別の便の点を
 *   入れると営業所ごとの推定が実際と違う地点を測る)
 * - 便が 1 本も無い運行 (全便が除外された等) は両方 `null`
 * - **画面の数字には 1 円も効かない** — 粗利は `buildOperationMargins` が同じ
 *   `inputs` から独立に出す。ここは読むだけ
 */
export function buildRebuildOperationInputs(
  operations: readonly MarginOperationInput[],
  pointsByUnko: ReadonlyMap<string, ReadonlyMap<number, LegPoints>>,
): RebuildOperationInput[] {
  return operations.map((operation) => {
    const points = pointsByUnko.get(operation.unkoNo)
    const legs = [...operation.legs]
      .sort((a, b) => a.seq - b.seq)
      .map(leg => toRebuildLeg(leg, points?.get(leg.seq)))
    return {
      unkoNo: operation.unkoNo,
      driverName: operation.driverName,
      kmBreakdown: operation.kmBreakdown,
      firstLoadPoint: legs[0]?.loadPoint ?? null,
      lastUnloadPoint: legs[legs.length - 1]?.unloadPoint ?? null,
      legs,
    }
  })
}

/**
 * 便ごとの GPS の保存先。**`MARGIN_CACHE_KEY` の形は変えない** (別のキーにする) —
 * 粗利の集計そのものは GPS を 1 つも見ないので、片方が壊れてももう片方は動く。
 *
 * これが無いと、キャッシュから復元した画面 (= タブを開いた直後の既定の状態) では
 * 全便が座標の欠測に見え、組み直し試算が「38 便すべて欠測」になる。
 */
export const MARGIN_LEG_POINTS_KEY = 'dtako:margin:leg-points:v1'

/** 保存する形。`ym` は `MarginCache.ym` と同じ月で、違えば使わない。 */
export interface LegPointsCache {
  ym: string
  /** 運行NO → 便 (`seq`) → 積地・卸地。 */
  points: Map<string, Map<number, LegPoints>>
}

/** 保存の JSON に出す便 1 本ぶん (Map は JSON にならないので配列で持つ)。 */
interface StoredLegPoints extends LegPoints {
  seq: number
}

export function serializeLegPoints(cache: LegPointsCache): string {
  const points: Record<string, StoredLegPoints[]> = {}
  for (const [unkoNo, legs] of cache.points) {
    points[unkoNo] = [...legs].map(([seq, p]) => ({ seq, loadPoint: p.loadPoint, unloadPoint: p.unloadPoint }))
  }
  return JSON.stringify({ ym: cache.ym, points })
}

/** 壊れた座標は `null` (欠測) にする。**0 や NaN を座標として通さない。** */
function storedPoint(value: unknown): LatLng | null {
  const point = value as LatLng | null | undefined
  return isValidLatLng(point) ? { lat: point.lat, lng: point.lng } : null
}

/**
 * 保存済みの GPS を読む。**壊れていても投げない** — 無かったことにする
 * (`parseMarginCache` と同じ流儀)。読めなかった便は欠測として数えられる。
 */
export function parseLegPoints(raw: string | null | undefined): LegPointsCache | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const cache = parsed as { ym?: unknown, points?: unknown }
  if (typeof cache.ym !== 'string') return null
  if (typeof cache.points !== 'object' || cache.points === null) return null
  const points = new Map<string, Map<number, LegPoints>>()
  for (const [unkoNo, legs] of Object.entries(cache.points as Record<string, unknown>)) {
    if (!Array.isArray(legs)) continue
    const byLeg = new Map<number, LegPoints>()
    for (const leg of legs as StoredLegPoints[]) {
      if (typeof leg?.seq !== 'number') continue
      byLeg.set(leg.seq, { loadPoint: storedPoint(leg.loadPoint), unloadPoint: storedPoint(leg.unloadPoint) })
    }
    points.set(unkoNo, byLeg)
  }
  return { ym: cache.ym, points }
}
