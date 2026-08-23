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
 *   専用道・高速道 …) は同じ走行をもう一度なぞるだけなので描かない (距離と同じ判定)。
 *   ただし重ね掛け行の GPS も「その時刻にそこに居た」実測点なので、**別関数**
 *   `buildOverlayTrack` が全行を点列にして、この線の下に軌跡として敷ける (Refs #760 の 24)
 * - **度分形式 → 十進は `getGpsForCell` に任せる** (`GPS有効 === '0'` の点は捨てる)。
 *   自前で換算しない
 * - GPS 列 (緯度・経度 4 列) が無い CSV は `segments: [] / markers: []`、
 *   `pointCount 0 / droppedRows 0`。**GPS 列はあるが全行無効**なら `droppedRows > 0`
 *   になるので、呼び出し側が「GPS 列なし」と「GPS が全部無効」を区別できる
 * - **`windows` は便ごとの時間窓** (Refs #760 の 21)。NET780 の道なり GPS (`.spd`) を
 *   同じ便の色で重ねるために、売上走行 = 積みの `開始日時` 〜 その便の最後の降しの
 *   `終了日時`、回送 = 運行開始 / 前の便の最後の降し 〜 積み、最後の便の降し 〜 運行終了
 *   を epoch 秒で持つ。時刻が読めない行の窓は作らない (黙って 0 にしない)。
 *   点列を窓で切るのは `splitTrackByWindows`
 */
import { colIndex, classifyTimeCategory, getGpsForCell, parseEventDatetimeToTs } from './event-data-table'
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
  /**
   * `haul` = 積み → その便の最後の降し (売上走行) / `deadhead` = 回送 / `other` = 降しの無い便の
   * 走行・積みの無い運行。`trackHaul` / `trackDeadhead` は **NET780 の道なり軌跡** (`splitTrackByWindows`)
   * で、イベント線の下に細く描く (`buildOperationRoute` は出さない)。
   */
  kind: 'haul' | 'deadhead' | 'other' | 'trackHaul' | 'trackDeadhead'
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

/**
 * 便 1 本の時間窓 (epoch 秒、`parseEventDatetimeToTs` と同じ「JST の壁時計を UTC として
 * 読んだ値」。NET780 の `ts` も同じ流儀なのでそのまま比べられる)。
 * `haul` = 積みの `開始日時` 〜 その便の最後の降しの `終了日時`。`deadhead` = その便へ向かう
 * 移動 (1 便目は 運行開始 の `開始日時` 〜 積み、2 便目以降は前の便の最後の降しの `終了日時`
 * 〜 積み) と、最後の便の降し 〜 運行終了 の `終了日時` (`legSeq` は最後の便)。
 */
export interface LegWindow {
  legSeq: number
  kind: 'haul' | 'deadhead'
  fromTs: number
  toTs: number
}

export interface OperationRoute {
  segments: RouteSegment[]
  markers: RouteMarker[]
  /** `segments` に置いた点の総数。0 なら描くものが無い。 */
  pointCount: number
  /** タイムライン行 (`DISTANCE_EVENT_NAMES`) のうち、開始・終了どちらかの GPS が使えなかった行数。 */
  droppedRows: number
  /** 便ごとの時間窓 (NET780 軌跡を切るため)。時刻が読めない便の窓は入らない。 */
  windows: LegWindow[]
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
  return { segments: [], markers: [], pointCount: 0, droppedRows: 0, windows: [] }
}

/** 行の `開始日時` / `終了日時` を epoch 秒に。列が無い・読めない → null。 */
function rowTs(row: string[] | undefined, idx: number): number | null {
  return row === undefined ? null : parseEventDatetimeToTs(cellAt(row, idx))
}

/**
 * 便ごとの時間窓。`legs` / `timeline` は `buildOperationRoute` の 1 回目の走査の結果。
 * 運行開始は最初の行、運行終了は最後の行 (マーカーと同じ採り方)。どちらかの時刻が
 * 読めない窓は作らない。
 */
function buildLegWindows(
  timeline: string[][],
  legs: LegRows[],
  nameIdx: number,
  startTsIdx: number,
  endTsIdx: number,
): LegWindow[] {
  const isEvent = (name: string) => (row: string[]) => cellAt(row, nameIdx).trim() === name
  const startRow = timeline.find(isEvent(OPERATION_START_EVENT))
  const endRow = [...timeline].reverse().find(isEvent(OPERATION_END_EVENT))
  const windows: LegWindow[] = []
  const push = (legSeq: number, kind: LegWindow['kind'], fromTs: number | null, toTs: number | null) => {
    if (fromTs !== null && toTs !== null) windows.push({ legSeq, kind, fromTs, toTs })
  }
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i]!
    const seq = i + 1
    const prev = legs[i - 1]
    const loadTs = rowTs(timeline[leg.loadAt], startTsIdx)
    const unloadTs = leg.lastUnloadAt === null ? null : rowTs(timeline[leg.lastUnloadAt], endTsIdx)
    // その便へ向かう回送: 1 便目は運行開始から、2 便目以降は前の便の最後の降しから
    // (前の便に降しが無ければ `other` のままで窓にしない — segments の塗り方と同じ)。
    const approachFrom = prev
      ? (prev.lastUnloadAt === null ? null : rowTs(timeline[prev.lastUnloadAt], endTsIdx))
      : rowTs(startRow, startTsIdx)
    push(seq, 'deadhead', approachFrom, loadTs)
    push(seq, 'haul', loadTs, unloadTs)
    // 最後の便の降し → 運行終了 (帰庫) は最後の便の回送。
    if (i === legs.length - 1) push(seq, 'deadhead', unloadTs, rowTs(endRow, endTsIdx))
  }
  return windows
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
  return {
    segments: segments.filter(s => s.path.length > 0),
    markers,
    pointCount,
    droppedRows,
    windows: buildLegWindows(timeline, legs, nameIdx, startTsIdx, endTsIdx),
  }
}

/**
 * NET780 の道なり GPS 点列 (ts 昇順) を便の時間窓で切り、窓ごとに 1 本の軌跡にする
 * (Refs #760 の 21)。窓の外の点は捨て、窓の境界で区切る。同じ点が続けば 1 つにまとめ、
 * 点が 1 つしか残らない窓 (止まっていただけ) は線にしない。`legSeq` は窓のもの。
 * `kind` は `haul` → `trackHaul` / `deadhead` → `trackDeadhead` (イベント線の下に描く用)。
 */
export function splitTrackByWindows(
  points: Array<{ ts: number, lat: number, lng: number }>,
  windows: LegWindow[],
): RouteSegment[] {
  const segments: RouteSegment[] = []
  for (const w of windows) {
    const path: LatLng[] = []
    for (const p of points) {
      if (p.ts < w.fromTs || p.ts > w.toTs || samePoint(path[path.length - 1], p)) continue
      path.push({ lat: p.lat, lng: p.lng })
    }
    if (path.length < 2) continue
    segments.push({ kind: w.kind === 'haul' ? 'trackHaul' : 'trackDeadhead', legSeq: w.legSeq, path })
  }
  return segments
}

/**
 * **全行**の始点・終点 GPS を時刻順に並べた点列 (Refs #760 の 24)。`splitTrackByWindows`
 * に掛けると `buildOperationRoute` のイベント線より**密な**軌跡になる。
 *
 * `buildOperationRoute` の点列は `DISTANCE_EVENT_NAMES` の行 (運転・積み・降し・休憩・
 * 休息・アイドリング・運行開始・運行終了) だけを結ぶ。重ね掛け行 (速度オーバー / 専用道 /
 * 高速道 / 一般道空車・実車 / 連続運転 …) を**距離**から外しているのは同じ走行の二重計上を
 * 避けるためで (`DISTANCE_EVENT_NAMES` の doc 参照)、**位置としては正しい実測点**である
 * ことに変わりはない。⇒ 距離には足さないまま、点列にだけ混ぜる。高速道の出入口や
 * 速度オーバー区間の両端がそのぶん増え、直線のスケッチが道の形に近づく。
 *
 * - **イベント名で行を選り好みしない** (ここが `buildOperationRoute` との唯一の違い)
 * - `GPS有効 = 0` / 度分が読めない点、`開始日時` / `終了日時` が読めない点は捨てる
 *   (`getGpsForCell` / `parseEventDatetimeToTs` に任せる。自前で換算・0 埋めしない)
 * - **ts 昇順に安定ソート**する (`Array.prototype.sort` は安定なので、同じ時刻の点は
 *   CSV の行順のまま残る)。同一の `(ts, lat, lng)` は 1 つに畳む — 重ね掛け行は
 *   タイムライン行と同じ時刻・同じ点をもう一度持つので、畳まないと点が倍になる
 * - イベント名列 / GPS 列が無い CSV は `[]` (`buildOperationRoute` の判定と同じ)
 *
 * **距離・時間の集計 (`allowance-idle.ts`) には一切関係しない。** 表・検算・棒グラフの
 * 数字は動かない。
 */
export function buildOverlayTrack(headers: string[], rows: string[][]): Array<{ ts: number, lat: number, lng: number }> {
  const nameIdx = colIndex(headers, 'イベント名')
  const startTsIdx = colIndex(headers, '開始日時')
  const endTsIdx = colIndex(headers, '終了日時')
  const gpsCols = ['開始GPS緯度', '開始GPS経度', '終了GPS緯度', '終了GPS経度']
  if (nameIdx < 0 || gpsCols.some(c => colIndex(headers, c) < 0)) return []

  const points: Array<{ ts: number, lat: number, lng: number }> = []
  const seen = new Set<string>()
  const push = (ts: number | null, gps: LatLng | null) => {
    if (ts === null || gps === null) return
    const key = `${ts},${gps.lat},${gps.lng}`
    if (seen.has(key)) return
    seen.add(key)
    points.push({ ts, lat: gps.lat, lng: gps.lng })
  }
  for (const row of rows) {
    push(parseEventDatetimeToTs(cellAt(row, startTsIdx)), getGpsForCell(headers, row, '開始市町村名'))
    push(parseEventDatetimeToTs(cellAt(row, endTsIdx)), getGpsForCell(headers, row, '終了市町村名'))
  }
  // CSV の行順は時刻順とは限らない (重ね掛け行は運行全体にまたがる行が途中に挟まる)。
  points.sort((a, b) => a.ts - b.ts)
  return points
}

/** `便 1 積み 釧路市` のように市町村名を添える。無ければ名前だけ。 */
function labelWithCity(base: string, city: string): string {
  const trimmed = city.trim()
  return trimmed === '' ? base : `${base} ${trimmed}`
}

/**
 * 運行 1 本の経路から、**指定した便のぶんだけ**を残す (Refs #760 の 19)。
 * 取引先 × 経路の行から「この経路の便を全部重ねた地図」を描くのに使う —
 * 経路行に入っている便 (`RouteSummary.legRefs`) の `seq` を渡すと、その便の売上走行と
 * **その便へ向かう回送**だけが残る。
 *
 * - `segments`: `legSeq` が `seqs` にあるものだけ。回送も `legSeq` が同じ便へ向かう
 *   移動なのでそのまま残る (`haul` / `deadhead` / `other` を区別しない — `other` も
 *   `legSeq` が一致するときだけ残る。`legSeq` が null の区切りは常に落ちる)
 * - `markers`: `load` / `unload` で `legSeq` が `seqs` にあるものだけ。
 *   **`start` / `end` (運行開始・運行終了) は落とす** — 便を重ねる地図では、
 *   その便と関係ない運行の起終点が並ぶだけで読めなくなる
 * - `pointCount` は**残した** `segments` の点数、`droppedRows` は運行ぶんをそのまま
 *   (何行 GPS が使えなかったかは便で割れない)
 * - `windows`: `legSeq` が `seqs` にある窓だけ (NET780 軌跡もその便のぶんだけ切れるように)。
 *   `trackHaul` / `trackDeadhead` の区切りも `legSeq` で同じに残る
 */
export function pickLegsFromRoute(route: OperationRoute, seqs: number[]): OperationRoute {
  // `Set<number | null>` にしておくと `legSeq` の null を素直に落とせる (`seqs` に null は
  // 入らないので `keep.has(null)` は必ず false)。`legSeq !== null &&` を書くと、
  // 実データでは false にならない分岐が 1 つ増えるだけになる。
  const keep = new Set<number | null>(seqs)
  const segments = route.segments.filter(s => keep.has(s.legSeq))
  return {
    segments,
    markers: route.markers.filter(m => (m.kind === 'load' || m.kind === 'unload') && keep.has(m.legSeq)),
    pointCount: segments.reduce((sum, s) => sum + s.path.length, 0),
    droppedRows: route.droppedRows,
    windows: route.windows.filter(w => keep.has(w.legSeq)),
  }
}

/**
 * 複数の運行の経路を 1 枚に重ねる (Refs #760 の 19)。`segments` / `markers` をそのまま
 * 連結し (`windows` も)、`pointCount` / `droppedRows` は和。**便番号は運行ごとに 1 から振り直されている**
 * ので、重ねた後の `legSeq` は「何本目の便か」ではなくなる (マーカーの `label` も同じ) —
 * 描くのに要るのは色と位置だけなので、振り直さない。
 */
export function mergeRoutes(routes: OperationRoute[]): OperationRoute {
  const merged = emptyRoute()
  for (const r of routes) {
    merged.segments.push(...r.segments)
    merged.markers.push(...r.markers)
    merged.windows.push(...r.windows)
    merged.pointCount += r.pointCount
    merged.droppedRows += r.droppedRows
  }
  return merged
}
