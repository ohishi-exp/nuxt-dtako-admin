/**
 * イベントCSV (KUDGIVT) の GPS から、1 運行の経路を**便ごとに色分けして描ける形**に
 * 畳む (pure)。粗利タブの運行行「地図」が使う (Refs #760 の 18)。
 *
 * ```
 * 運行開始 ─ deadhead ─ 積み ══ haul ══ 降し ─ deadhead ─ 積み ══ haul ══ 降し ─ deadhead ─ 運行終了
 *                       └── 便 1 ──┘                     └── 便 2 ──┘
 * ```
 *
 * - **便の切り方は `allowance-idle.ts` (`extractOperationIdle`) と同じ行で切る。**
 *   積み = 便の頭 (積みが 1 つ = 便 1 つ)、その便の最後の降しまでが売上走行 (`haul`)。
 *   最初の積みより前・便の最後の降しの後 (次の積みまで / 末尾まで) は回送 (`deadhead`)。
 *   降しが 1 つも無い便の積み以降と、積みが 1 行も無い運行の走行は `other`
 *   (`OperationIdle.otherKm` と同じ受け皿)。**ここで便の数え方を新しく作らない** —
 *   `legSeq` は 1 始まりで `MarginLegInput.seq` / `LegKmDetail` の index (+1) と一致する
 * - **点列に入れる行は `DISTANCE_EVENT_NAMES` の行だけ。** 重ね掛け行 (速度オーバー・
 *   専用道・高速道 …) は同じ走行をもう一度なぞるだけなので描かない (距離と同じ判定)
 * - **度分形式 → 十進は `getGpsForCell` に任せる** (`GPS有効 === '0'` の点は捨てる)。
 *   自前で換算しない
 * - GPS 列 (緯度・経度 4 列) が無い CSV は `segments: [] / markers: []`、
 *   `pointCount 0 / droppedRows 0`。**GPS 列はあるが全行無効**なら `droppedRows > 0`
 *   になるので、呼び出し側が「GPS 列なし」と「GPS が全部無効」を区別できる
 */
import { colIndex, classifyTimeCategory, getGpsForCell } from './event-data-table'
import { DISTANCE_EVENT_NAMES } from './allowance-idle'

/** 始業・終業はイベント名で決まる (`classifyTimeCategory` では `other`)。`allowance-idle.ts` と同じ。 */
const OPERATION_START_EVENT = '運行開始'
const OPERATION_END_EVENT = '運行終了'

export interface LatLng {
  lat: number
  lng: number
}

/** 経路の一区切り。同じ `kind` / `legSeq` が続く行を 1 本の線にまとめたもの。 */
export interface RouteSegment {
  /** `haul` = 積み → その便の最後の降し (売上走行) / `deadhead` = 回送 / `other` = 降しの無い便の走行・積みの無い運行。 */
  kind: 'haul' | 'deadhead' | 'other'
  /**
   * 属する便 (1 始まり)。回送はその便へ向かう移動として **次の便** に付く (1 便目の
   * 積前は 1、最後の便の降後 (帰庫) は最後の便 = `LegKmDetail.approachKm / tailKm` と
   * 同じ割り当て)。積みが 1 行も無い運行は null。
   */
  legSeq: number | null
  /** 行順に 開始GPS → 終了GPS を並べた点列 (同じ点が続くときは 1 つにまとめる)。 */
  path: LatLng[]
}

export interface RouteMarker {
  kind: 'start' | 'end' | 'load' | 'unload'
  /** `load` / `unload` はその便 (1 始まり)。`start` / `end` は null。 */
  legSeq: number | null
  lat: number
  lng: number
  /** 例: `便 2 積み 釧路市` / `運行開始 帯広市`。市町村名の列が無ければ名前だけ。 */
  label: string
  /** その行の `開始日時` (start / load) または `終了日時` (end / unload)。列が無ければ空文字。 */
  ts: string
}

export interface OperationRoute {
  segments: RouteSegment[]
  markers: RouteMarker[]
  /** `segments` に置いた点の総数。0 なら描くものが無い。 */
  pointCount: number
  /** タイムライン行 (`DISTANCE_EVENT_NAMES`) のうち、開始・終了どちらかの GPS が使えなかった行数。 */
  droppedRows: number
}

/** 行ごとの分類 (1 回目の走査で便を確定させてから 2 回目で線にする)。 */
interface ClassifiedRow {
  row: string[]
  kind: RouteSegment['kind']
  legSeq: number | null
}

/** 便 1 本ぶんの行位置。`allowance-idle.ts` の `IdleLeg` と同じ数え方で、位置だけ覚える。 */
interface LegRows {
  /** 積みの行 (`classified` の index)。 */
  loadAt: number
  /** その便の最後の降しの行。降しが無ければ null。 */
  lastUnloadAt: number | null
}

function cellAt(row: string[], idx: number): string {
  return idx < 0 ? '' : (row[idx] ?? '')
}

function samePoint(a: LatLng | undefined, b: LatLng): boolean {
  return a !== undefined && a.lat === b.lat && a.lng === b.lng
}

function emptyRoute(): OperationRoute {
  return { segments: [], markers: [], pointCount: 0, droppedRows: 0 }
}

export function buildOperationRoute(headers: string[], rows: string[][]): OperationRoute {
  const nameIdx = colIndex(headers, 'イベント名')
  const startTsIdx = colIndex(headers, '開始日時')
  const endTsIdx = colIndex(headers, '終了日時')
  const startCityIdx = colIndex(headers, '開始市町村名')
  const endCityIdx = colIndex(headers, '終了市町村名')
  const gpsCols = ['開始GPS緯度', '開始GPS経度', '終了GPS緯度', '終了GPS経度']
  if (nameIdx < 0 || gpsCols.some(c => colIndex(headers, c) < 0)) return emptyRoute()

  // --- 1 回目: タイムライン行だけ残して便の位置を確定する (`extractOperationIdle` と同じ行で切る)。
  const timeline: string[][] = []
  const legs: LegRows[] = []
  for (const row of rows) {
    const name = cellAt(row, nameIdx).trim()
    if (!DISTANCE_EVENT_NAMES.includes(name)) continue
    const at = timeline.length
    timeline.push(row)
    const category = classifyTimeCategory(name)
    if (category === 'loading') {
      legs.push({ loadAt: at, lastUnloadAt: null })
      continue
    }
    const current = legs[legs.length - 1]
    // 最初の積みより前の降し = 前の運行の積み残し。属する便が無い。
    if (category === 'unloading' && current) current.lastUnloadAt = at
  }

  // --- 行ごとの kind / legSeq。
  const classified: ClassifiedRow[] = timeline.map(row => ({ row, kind: 'other', legSeq: null }))
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    const seq = i + 1
    const prev = legs[i - 1]
    const next = legs[i + 1]
    const end = next ? next.loadAt : timeline.length
    // その便へ向かう回送: 1 便目は積前ぜんぶ、2 便目以降は直前の便の最後の降しの次から。
    // 直前の便に降しが無ければ、その走行は直前の便の `other` に乗せたまま (付け替えない)。
    const approachFrom = prev ? (prev.lastUnloadAt === null ? leg.loadAt : prev.lastUnloadAt + 1) : 0
    for (let r = approachFrom; r < leg.loadAt; r++) classified[r] = { row: timeline[r]!, kind: 'deadhead', legSeq: seq }
    if (leg.lastUnloadAt === null) {
      for (let r = leg.loadAt; r < end; r++) classified[r] = { row: timeline[r]!, kind: 'other', legSeq: seq }
      continue
    }
    for (let r = leg.loadAt; r <= leg.lastUnloadAt; r++) classified[r] = { row: timeline[r]!, kind: 'haul', legSeq: seq }
    // 便の最後の降しの後 → 次の積みの手前 (便間) / 末尾まで (降後 = 帰庫) は、次の便が
    // あれば次の便の approach として上で塗られるので、ここでは最後の便のぶんだけ塗る。
    if (!next) for (let r = leg.lastUnloadAt + 1; r < end; r++) classified[r] = { row: timeline[r]!, kind: 'deadhead', legSeq: seq }
  }

  // --- 2 回目: 点列とマーカー。
  const segments: RouteSegment[] = []
  const markers: RouteMarker[] = []
  let pointCount = 0
  let droppedRows = 0
  let startMarkerDone = false
  let endMarker: RouteMarker | null = null
  for (const c of classified) {
    const startGps = getGpsForCell(headers, c.row, '開始市町村名')
    const endGps = getGpsForCell(headers, c.row, '終了市町村名')
    if (startGps === null || endGps === null) droppedRows++

    const last = segments[segments.length - 1]
    const seg = last && last.kind === c.kind && last.legSeq === c.legSeq
      ? last
      : { kind: c.kind, legSeq: c.legSeq, path: [] as LatLng[] }
    if (seg !== last) segments.push(seg)
    for (const p of [startGps, endGps]) {
      if (p === null || samePoint(seg.path[seg.path.length - 1], p)) continue
      seg.path.push(p)
      pointCount++
    }

    const name = cellAt(c.row, nameIdx).trim()
    const category = classifyTimeCategory(name)
    if (name === OPERATION_START_EVENT && !startMarkerDone) {
      // 最初の 運行開始 を採る (`extractOperationIdle` と同じ)。GPS が無ければ出さない。
      startMarkerDone = true
      if (startGps !== null) {
        markers.push({
          kind: 'start',
          legSeq: null,
          lat: startGps.lat,
          lng: startGps.lng,
          label: labelWithCity(OPERATION_START_EVENT, cellAt(c.row, startCityIdx)),
          ts: cellAt(c.row, startTsIdx),
        })
      }
    }
    else if (name === OPERATION_END_EVENT && endGps !== null) {
      // 最後の 運行終了 を採る。
      endMarker = {
        kind: 'end',
        legSeq: null,
        lat: endGps.lat,
        lng: endGps.lng,
        label: labelWithCity(OPERATION_END_EVENT, cellAt(c.row, endCityIdx)),
        ts: cellAt(c.row, endTsIdx),
      }
    }
    else if (category === 'loading' && startGps !== null) {
      // 積みは必ず便の頭 (`legSeq` はその便)。
      markers.push({
        kind: 'load',
        legSeq: c.legSeq,
        lat: startGps.lat,
        lng: startGps.lng,
        label: labelWithCity(`便 ${c.legSeq} 積み`, cellAt(c.row, startCityIdx)),
        ts: cellAt(c.row, startTsIdx),
      })
    }
  }
  if (endMarker !== null) markers.push(endMarker)
  // 各便の最後の降し (`haul` の最後の行)。積み残しの降し (便に属さない) は出さない。
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    if (leg.lastUnloadAt === null) continue
    const row = timeline[leg.lastUnloadAt]!
    const gps = getGpsForCell(headers, row, '終了市町村名')
    if (gps === null) continue
    markers.push({
      kind: 'unload',
      legSeq: i + 1,
      lat: gps.lat,
      lng: gps.lng,
      label: labelWithCity(`便 ${i + 1} 降し`, cellAt(row, endCityIdx)),
      ts: cellAt(row, endTsIdx),
    })
  }
  // 点を 1 つも置けなかった区切りは捨てる (線にならない)。
  return { segments: segments.filter(s => s.path.length > 0), markers, pointCount, droppedRows }
}

/** `便 1 積み 釧路市` のように市町村名を添える。無ければ名前だけ。 */
function labelWithCity(base: string, city: string): string {
  const trimmed = city.trim()
  return trimmed === '' ? base : `${base} ${trimmed}`
}
