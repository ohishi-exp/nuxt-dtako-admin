/**
 * 粗利タブの集計から、**釧路営業所発の組み直し試算 (`kushiro-doto-rebuild.ts`) の入力**
 * を組み立てる (pure — DOM も fetch も持たない。Refs #760 の 35)。
 *
 * ```
 * イベントCSV ─ buildOperationRoute ─ route ── legPointsByLegSeq ──┐
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
 * (`kind: 'load' | 'unload' | 'end'` / `legSeq`) をそのまま畳むだけ。**便の切り方の
 * 判定をここで二重化しない** — `legSeq` は `allowance-idle.ts` と同じ行で切られていて
 * `MarginLegInput.seq` と一致する (`operation-route-map.ts` 冒頭の契約)。最終便の
 * 判定に使う `legCount` も同じ切り方で数えた本数をそのまま受け取る。
 *
 * ## 欠測は必ず `null` (0 に倒さない)
 *
 * 座標が取れない便は `loadPoint` / `unloadPoint` を `null` のまま渡す。
 * `addRebuildLeg` が `missingLegs` として数え、推定の母集団から外す。
 * **0 に倒すと「営業所の目の前で積んだ便」に化けて、営業所どうしの差が壊れる。**
 *
 * ## 降しの記録が無い最終便だけ、運行終了を卸地として代用する (Refs #760 の 38)
 *
 * オーナー (2026-08-23):「降し記録がなく、運行終了を降しとして強制したい 運行」。
 * 本番 2026-07 は **12 便が卸地の欠測**で、全部が「運行の最終便 かつ 降しイベントが
 * 1 行も無い」便だった (`postUnloadKm` が 0 になる形)。**その 12 本の運行終了 GPS を
 * 実測すると 11 本が音更町駒場** (帯広営業所から 14.4km) — **帰庫ではなく中継拠点**で、
 * `allowance-rate-master.ts` の `釧路 → 駒場` / `駒場 → ユナイテッド牧場` (どちらも
 * 中継、¥4,500) と一致する。⇒ 運行終了はその便で**荷が車から離れた場所**なので、
 * 卸地として使ってよい。
 *
 * **適用は「運行の最終便」かつ「卸地マーカーが無い」ときだけ。** 途中便で運行終了を
 * 卸地に使うのは明らかな誤りなので、最終便かどうかは `OperationRoute.legCount`
 * (= `extractOperationIdle` と同じ便の切り方) で決める。**marker の `legSeq` の
 * 最大値では代用しない** — 積みの GPS が無効な最終便には marker が出ず、1 つ手前の
 * **途中便**に代用してしまう。
 *
 * **代用したことは `unloadFromOperationEnd` で持ち回る (黙って混ぜない)。** 実測の
 * 卸地と代用の卸地を読み手が区別できないと、「推定を出せた便」の母集団の性格が
 * 変わったことに気付けない。実例: `001420` 西島 07-13 の別海便は運行終了が標茶町で、
 * 卸地 (別海町中西別) から **約 20km 手前**。代用しないと推定に入らないが、
 * 混ぜたまま黙ると道東の推定が静かに内側へ寄る。
 *
 * ## km には 1 つも触らない
 *
 * 代用するのは**座標だけ**。`allowance-idle.ts` の `haulKm` / `otherKm` /
 * `kmBreakdown` は 1 つも変えない — 粗利の不変条件 (運行 91 本 / 走行 57,829.4km /
 * 売上 ¥10,260,265 / 手当 ¥2,499,500 / 粗利 ¥4,467,597) が動く。
 */
import { isValidLatLng } from './depot-distance'
import type { LatLng, OperationRoute } from './operation-route-map'
import type { RebuildLegInput, RebuildOperationInput } from './kushiro-doto-rebuild'
import type { MarginLegInput, MarginOperationInput } from './margin'

/** 便 1 本ぶんの実測 GPS。取れなければ `null` (**0 に倒さない**)。 */
export interface LegPoints {
  loadPoint: LatLng | null
  unloadPoint: LatLng | null
  /**
   * `unloadPoint` が **実測の降しではなく、運行終了の位置で代用**したものか。
   * 実測の降しから採れたとき / そもそも卸地が欠測のときは `false`。
   */
  unloadFromOperationEnd: boolean
}

/** 空の枠。`??` の右辺で使うので 1 か所にまとめる (3 つ目のフィールドを足し忘れないため)。 */
function emptyLegPoints(): LegPoints {
  return { loadPoint: null, unloadPoint: null, unloadFromOperationEnd: false }
}

/**
 * 降しの記録が無い**最終便**の卸地を、**運行終了の位置で代用**する (Refs #760 の 38)。
 *
 * - `legCount` が 0 (便が 1 本も無い / GPS 列の無い CSV) なら何もしない
 * - 運行終了の GPS が取れていない運行も何もしない (**0 に倒さない**)
 * - 最終便に卸地の marker が既にあれば**触らない** (実測が最優先)
 * - 最終便の marker が 1 つも無いときは枠ごと作る。積地は `null` のままなので
 *   `addRebuildLeg` はその便を欠測として数える (代用しても推定には入らない)
 */
function substituteOperationEnd(
  points: Map<number, LegPoints>,
  legCount: number,
  operationEnd: LatLng | null,
): Map<number, LegPoints> {
  if (legCount <= 0) return points
  if (operationEnd === null) return points
  const last = points.get(legCount) ?? emptyLegPoints()
  if (last.unloadPoint !== null) return points
  points.set(legCount, { ...last, unloadPoint: operationEnd, unloadFromOperationEnd: true })
  return points
}

/**
 * `buildOperationRoute` の結果を **便 (`legSeq`) ごとの積地・卸地**に畳む。
 *
 * - `start` / `end` の marker は `legSeq` が `null`。**`end` だけは拾う** — 降しの
 *   記録が無い最終便の卸地に代用するため (`substituteOperationEnd`)
 * - 同じ便に `load` / `unload` は**それぞれ高々 1 つ**しか出ない (積みは便の頭、
 *   降しはその便の最後の 1 行)。⇒ 重複の解決を書かず、そのまま入れる
 * - marker が 1 つも無い便はこの Map に**現れない**。呼び出し側 (`buildRebuildOperationInputs`)
 *   が `null` で埋める
 * - **`markers` ではなく `OperationRoute` を受ける**のは `legCount` (最終便の判定) が
 *   要るから。便の数え方をここで作り直さない
 */
export function legPointsByLegSeq(route: OperationRoute): Map<number, LegPoints> {
  const points = new Map<number, LegPoints>()
  let operationEnd: LatLng | null = null
  for (const marker of route.markers) {
    if (marker.legSeq === null) {
      if (marker.kind === 'end') operationEnd = { lat: marker.lat, lng: marker.lng }
      continue
    }
    const entry = points.get(marker.legSeq) ?? emptyLegPoints()
    if (marker.kind === 'load') entry.loadPoint = { lat: marker.lat, lng: marker.lng }
    else entry.unloadPoint = { lat: marker.lat, lng: marker.lng }
    points.set(marker.legSeq, entry)
  }
  return substituteOperationEnd(points, route.legCount, operationEnd)
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
    unloadFromOperationEnd: points?.unloadFromOperationEnd ?? false,
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
 *
 * **`unloadFromOperationEnd` を足しても `v1` のまま**にしてある。キーを上げると
 * 保存済みの座標が全部捨てられ、CSV 91 本を引き直すまで「38 便すべて欠測」に戻る。
 * 旧 v1 の保存はこのキーを持たないだけで、卸地はそのとき欠測だった値のまま
 * (代用前の姿) なので、`false` として読んでも画面の注記と食い違わない。
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
    points[unkoNo] = [...legs].map(([seq, p]) => ({
      seq,
      loadPoint: p.loadPoint,
      unloadPoint: p.unloadPoint,
      unloadFromOperationEnd: p.unloadFromOperationEnd,
    }))
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
      byLeg.set(leg.seq, {
        loadPoint: storedPoint(leg.loadPoint),
        unloadPoint: storedPoint(leg.unloadPoint),
        // **`=== true` で受ける** — このキーを持たない旧 v1 の保存 (代用を入れる前に
        // 書かれたもの) は `undefined` になり、代用なし = 実測だけ、と読める。
        // その運行の卸地は当時も `null` で保存されているので矛盾しない。
        unloadFromOperationEnd: leg.unloadFromOperationEnd === true,
      })
    }
    points.set(unkoNo, byLeg)
  }
  return { ym: cache.ym, points }
}
