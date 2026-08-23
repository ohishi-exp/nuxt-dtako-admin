import { describe, it, expect } from 'vitest'
import {
  buildOperationRoute,
  buildOverlayTrack,
  pickLegsFromRoute,
  mergeRoutes,
  splitTrackByWindows,
  parseRouteMapLayers,
  serializeRouteMapLayers,
  filterRouteByLayers,
  DEFAULT_ROUTE_MAP_LAYERS,
  ROUTE_MAP_LAYERS_KEY,
  SEGMENT_LAYER,
  MARKER_LAYER,
  type LegWindow,
  type OperationRoute,
  type RouteSegment,
  type RouteMapLayers,
} from '~/utils/operation-route-map'
import { extractOperationIdle } from '~/utils/allowance-idle'
import { toLatLng, parseEventDatetimeToTs } from '~/utils/event-data-table'

const HEADERS = [
  'イベント名', '開始日時', '終了日時', '開始市町村名', '終了市町村名',
  '開始GPS緯度', '開始GPS経度', '開始GPS有効', '終了GPS緯度', '終了GPS経度', '終了GPS有効', '区間距離',
]

/** 度分形式の GPS (開始 = 終了 の 1 点、または 開始 → 終了 の 2 点)。 */
type Gps = { lat: string, lng: string, valid?: string }

const KUSHIRO: Gps = { lat: '42590000', lng: '144230000' }
const SHIHORO: Gps = { lat: '43100000', lng: '143150000' }
const SHIMIZU: Gps = { lat: '43000000', lng: '142530000' }
const OBIHIRO: Gps = { lat: '42550000', lng: '143120000' }
const NOWHERE: Gps = { lat: '0', lng: '0' }

function pt(g: Gps) {
  return { lat: toLatLng(g.lat)!, lng: toLatLng(g.lng)! }
}

interface EvOpts {
  startCity?: string
  endCity?: string
  km?: string
  ts?: [string, string]
}

/** イベントCSV の 1 行 (列は HEADERS の順)。`from` → `to` の GPS。 */
function ev(name: string, from: Gps, to: Gps, o: EvOpts = {}): string[] {
  return [
    name, o.ts?.[0] ?? '2026/7/1 8:00:00', o.ts?.[1] ?? '2026/7/1 9:00:00', o.startCity ?? '', o.endCity ?? '',
    from.lat, from.lng, from.valid ?? '1', to.lat, to.lng, to.valid ?? '1', o.km ?? '10',
  ]
}

/** 便 2 本 (釧路→士幌 / 釧路→清水)。2 便目は降しが 2 つ (最後の降しまでが売上走行)。 */
const TWO_LEGS: string[][] = [
  ev('運行開始', OBIHIRO, OBIHIRO, { startCity: '帯広市', ts: ['2026/7/1 5:00:00', '2026/7/1 5:00:00'] }),
  ev('運転', OBIHIRO, KUSHIRO),
  ev('積み', KUSHIRO, KUSHIRO, { startCity: '釧路市', ts: ['2026/7/1 8:00:00', '2026/7/1 8:30:00'] }),
  ev('運転', KUSHIRO, SHIHORO),
  ev('降し', SHIHORO, SHIHORO, { endCity: '士幌町', ts: ['2026/7/1 11:00:00', '2026/7/1 11:30:00'] }),
  ev('運転', SHIHORO, KUSHIRO),
  ev('積み', KUSHIRO, KUSHIRO, { startCity: '釧路市', ts: ['2026/7/1 14:00:00', '2026/7/1 14:30:00'] }),
  ev('運転', KUSHIRO, OBIHIRO),
  ev('降し', OBIHIRO, OBIHIRO, { endCity: '帯広市' }),
  ev('運転', OBIHIRO, SHIMIZU),
  ev('降し', SHIMIZU, SHIMIZU, { endCity: '清水町', ts: ['2026/7/1 18:00:00', '2026/7/1 18:30:00'] }),
  ev('運転', SHIMIZU, OBIHIRO),
  ev('運行終了', OBIHIRO, OBIHIRO, { endCity: '帯広市', ts: ['2026/7/1 20:00:00', '2026/7/1 20:00:00'] }),
]

function shape(segs: RouteSegment[]) {
  return segs.map(s => ({ kind: s.kind, legSeq: s.legSeq, n: s.path.length }))
}

/** `2026/7/1 8:00:00` → epoch 秒 (窓の期待値用)。 */
function T(s: string): number {
  return parseEventDatetimeToTs(s)!
}

const EMPTY_ROUTE: OperationRoute = { segments: [], markers: [], pointCount: 0, droppedRows: 0, windows: [] }

describe('buildOperationRoute', () => {
  it('便 2 本: 積前・便間・降後が回送、積み → 最後の降し が売上走行。便番号は extractOperationIdle と同じ本数', () => {
    const route = buildOperationRoute(HEADERS, TWO_LEGS)
    expect(shape(route.segments)).toEqual([
      { kind: 'deadhead', legSeq: 1, n: 2 }, // 運行開始(帯広) → 運転 帯広→釧路
      { kind: 'haul', legSeq: 1, n: 2 }, // 積み(釧路) → 運転 → 降し(士幌)
      { kind: 'deadhead', legSeq: 2, n: 2 }, // 運転 士幌→釧路
      { kind: 'haul', legSeq: 2, n: 3 }, // 積み(釧路) → 帯広 → 降し(清水)
      { kind: 'deadhead', legSeq: 2, n: 2 }, // 運転 清水→帯広 → 運行終了
    ])
    expect(route.segments[1]!.path).toEqual([pt(KUSHIRO), pt(SHIHORO)])
    expect(route.segments[3]!.path).toEqual([pt(KUSHIRO), pt(OBIHIRO), pt(SHIMIZU)])
    expect(route.pointCount).toBe(11)
    expect(route.droppedRows).toBe(0)
    expect(route.markers).toEqual([
      { kind: 'start', legSeq: null, ...pt(OBIHIRO), label: '運行開始 帯広市', ts: '2026/7/1 5:00:00' },
      { kind: 'load', legSeq: 1, ...pt(KUSHIRO), label: '便 1 積み 釧路市', ts: '2026/7/1 8:00:00' },
      { kind: 'load', legSeq: 2, ...pt(KUSHIRO), label: '便 2 積み 釧路市', ts: '2026/7/1 14:00:00' },
      { kind: 'end', legSeq: null, ...pt(OBIHIRO), label: '運行終了 帯広市', ts: '2026/7/1 20:00:00' },
      { kind: 'unload', legSeq: 1, ...pt(SHIHORO), label: '便 1 降し 士幌町', ts: '2026/7/1 11:30:00' },
      { kind: 'unload', legSeq: 2, ...pt(SHIMIZU), label: '便 2 降し 清水町', ts: '2026/7/1 18:30:00' },
    ])
    // 便の数え方は allowance-idle と同じ (legKm の本数 = 最大 legSeq)。
    const idle = extractOperationIdle(HEADERS, TWO_LEGS)
    const maxSeq = Math.max(...route.segments.map(s => s.legSeq ?? 0))
    expect(idle.legKm.length).toBe(2)
    expect(maxSeq).toBe(2)
  })

  it('降しの無い便は積み以降が other (次の積みの手前まで)。最後の便なら末尾まで', () => {
    const rows = [
      ev('運行開始', OBIHIRO, OBIHIRO),
      ev('積み', KUSHIRO, KUSHIRO),
      ev('運転', KUSHIRO, SHIHORO),
      ev('積み', SHIHORO, SHIHORO),
      ev('運転', SHIHORO, SHIMIZU),
      ev('降し', SHIMIZU, SHIMIZU),
      ev('運転', SHIMIZU, OBIHIRO),
      ev('積み', OBIHIRO, OBIHIRO),
      ev('運転', OBIHIRO, KUSHIRO),
      ev('運行終了', KUSHIRO, KUSHIRO),
    ]
    const route = buildOperationRoute(HEADERS, rows)
    expect(shape(route.segments)).toEqual([
      { kind: 'deadhead', legSeq: 1, n: 1 },
      { kind: 'other', legSeq: 1, n: 2 }, // 降し無し便: 積み → 運転 (次の積みの手前まで)。便 2 の approach にしない
      { kind: 'haul', legSeq: 2, n: 2 },
      { kind: 'deadhead', legSeq: 3, n: 2 },
      { kind: 'other', legSeq: 3, n: 2 }, // 最後の便に降しが無い: 末尾 (運行終了) まで other
    ])
    expect(route.markers.map(m => `${m.kind}${m.legSeq ?? ''}`)).toEqual(['start', 'load1', 'load2', 'load3', 'end', 'unload2'])
    expect(extractOperationIdle(HEADERS, rows).legKm.length).toBe(3)
  })

  it('GPS 無効 (有効=0 / 値 0) の行は点を置かずマーカーも出さず droppedRows に数える', () => {
    const rows = [
      ev('運行開始', { ...OBIHIRO, valid: '0' }, OBIHIRO), // 開始が無効 → start マーカー無し
      ev('運転', OBIHIRO, KUSHIRO),
      ev('積み', { ...KUSHIRO, valid: '0' }, KUSHIRO), // 積みの開始が無効 → load マーカー無し
      ev('運転', KUSHIRO, SHIHORO),
      ev('降し', SHIHORO, NOWHERE), // 終了 0,0 → unload マーカー無し
      ev('運転', NOWHERE, NOWHERE), // 両方無効: 線にならない区切り (segments から落ちる)
      ev('運行終了', OBIHIRO, { ...OBIHIRO, valid: '0' }), // 終了が無効 → end マーカー無し
    ]
    const route = buildOperationRoute(HEADERS, rows)
    expect(shape(route.segments)).toEqual([
      { kind: 'deadhead', legSeq: 1, n: 2 },
      { kind: 'haul', legSeq: 1, n: 2 },
      { kind: 'deadhead', legSeq: 1, n: 1 }, // 運転(無効) + 運行終了(開始のみ)
    ])
    expect(route.markers).toEqual([])
    expect(route.droppedRows).toBe(5)
    expect(route.pointCount).toBe(5)
  })

  it('GPS 列が無い / イベント名 列が無い CSV は空 (点 0、落とした行 0)', () => {
    const noGps = ['イベント名', '開始日時', '終了日時', '開始GPS緯度', '開始GPS経度', '開始GPS有効']
    expect(buildOperationRoute(noGps, [['運転', '', '', '42590000', '144230000', '1']])).toEqual(EMPTY_ROUTE)
    expect(buildOperationRoute(HEADERS.filter(h => h !== 'イベント名'), [HEADERS.map(() => '1')])).toEqual(EMPTY_ROUTE)
  })

  it('重ね掛け行 (DISTANCE_EVENT_NAMES に無い) は点列に入れない', () => {
    const rows = [
      ev('積み', KUSHIRO, KUSHIRO),
      ev('専用道', NOWHERE, { lat: '10000000', lng: '10000000' }),
      ev('一般道速度オーバー', { lat: '10000000', lng: '10000000' }, { lat: '10000000', lng: '10000000' }),
      ev('降し', SHIHORO, SHIHORO),
    ]
    const route = buildOperationRoute(HEADERS, rows)
    expect(shape(route.segments)).toEqual([{ kind: 'haul', legSeq: 1, n: 2 }])
    expect(route.segments[0]!.path).toEqual([pt(KUSHIRO), pt(SHIHORO)])
    expect(route.droppedRows).toBe(0)
  })

  it('運行開始 が複数なら最初、運行終了 が複数なら最後をマーカーにする', () => {
    const rows = [
      ev('運行開始', OBIHIRO, OBIHIRO, { ts: ['a', 'a'] }),
      ev('運行開始', KUSHIRO, KUSHIRO, { ts: ['b', 'b'] }),
      ev('運転', KUSHIRO, SHIHORO),
      ev('運行終了', SHIHORO, SHIHORO, { ts: ['c', 'c'] }),
      ev('運行終了', SHIMIZU, SHIMIZU, { ts: ['d', 'd'] }),
    ]
    const route = buildOperationRoute(HEADERS, rows)
    expect(route.markers.map(m => [m.kind, m.ts])).toEqual([['start', 'a'], ['end', 'd']])
    // 積みが 1 行も無い運行の走行は other (legSeq null) — otherKm と同じ受け皿。
    expect(shape(route.segments)).toEqual([{ kind: 'other', legSeq: null, n: 4 }])
  })

  it('最初の積みより前の降し (積み残し) は便に属さず、降しマーカーも出さない', () => {
    const rows = [
      ev('運行開始', OBIHIRO, OBIHIRO),
      ev('降し', OBIHIRO, OBIHIRO),
      ev('積み', KUSHIRO, KUSHIRO),
      ev('降し', SHIHORO, SHIHORO),
    ]
    const route = buildOperationRoute(HEADERS, rows)
    expect(shape(route.segments)).toEqual([
      { kind: 'deadhead', legSeq: 1, n: 1 },
      { kind: 'haul', legSeq: 1, n: 2 },
    ])
    expect(route.markers.map(m => `${m.kind}${m.legSeq ?? ''}`)).toEqual(['start', 'load1', 'unload1'])
  })

  it('市町村名・日時の列が無い / 短い行でも落ちない (label は名前だけ、ts は空)', () => {
    const headers = ['イベント名', '開始GPS緯度', '開始GPS経度', '終了GPS緯度', '終了GPS経度']
    const rows = [
      ['運行開始', OBIHIRO.lat, OBIHIRO.lng, OBIHIRO.lat, OBIHIRO.lng],
      ['積み', KUSHIRO.lat, KUSHIRO.lng, KUSHIRO.lat, KUSHIRO.lng],
      ['降し', SHIHORO.lat, SHIHORO.lng, SHIHORO.lat, SHIHORO.lng],
      ['運行終了'], // 短い行 (GPS 列が無い) → 点もマーカーも無し
      [], // 空の行 (イベント名すら無い) → タイムライン行ではない
    ]
    const route = buildOperationRoute(headers, rows)
    expect(route.markers).toEqual([
      { kind: 'start', legSeq: null, ...pt(OBIHIRO), label: '運行開始', ts: '' },
      { kind: 'load', legSeq: 1, ...pt(KUSHIRO), label: '便 1 積み', ts: '' },
      { kind: 'unload', legSeq: 1, ...pt(SHIHORO), label: '便 1 降し', ts: '' },
    ])
    expect(route.droppedRows).toBe(1)
    // 市町村名が空白だけの列も名前だけにする。
    const withBlankCity = buildOperationRoute(HEADERS, [ev('積み', KUSHIRO, KUSHIRO, { startCity: '  ' })])
    expect(withBlankCity.markers[0]!.label).toBe('便 1 積み')
  })

  it('同じ点が続くときは 1 つにまとめる (緯度だけ同じ / 経度だけ同じ は別の点)', () => {
    const sameLat: Gps = { lat: KUSHIRO.lat, lng: '144000000' }
    const sameLng: Gps = { lat: '42000000', lng: KUSHIRO.lng }
    const rows = [
      ev('運転', KUSHIRO, KUSHIRO),
      ev('運転', KUSHIRO, sameLat),
      ev('運転', sameLat, KUSHIRO),
      ev('運転', KUSHIRO, sameLng),
    ]
    const route = buildOperationRoute(HEADERS, rows)
    expect(route.segments[0]!.path).toEqual([pt(KUSHIRO), pt(sameLat), pt(KUSHIRO), pt(sameLng)])
    expect(route.pointCount).toBe(4)
  })

  it('便が連続する (間に運転が無い) と、同じ色でも便ごとに区切る', () => {
    const rows = [
      ev('積み', KUSHIRO, KUSHIRO),
      ev('降し', SHIHORO, SHIHORO),
      ev('積み', SHIHORO, SHIHORO),
      ev('降し', OBIHIRO, OBIHIRO),
      ev('積み', OBIHIRO, OBIHIRO), // 降し無し
      ev('積み', SHIMIZU, SHIMIZU), // 降し無し
    ]
    expect(shape(buildOperationRoute(HEADERS, rows).segments)).toEqual([
      { kind: 'haul', legSeq: 1, n: 2 },
      { kind: 'haul', legSeq: 2, n: 2 },
      { kind: 'other', legSeq: 3, n: 1 },
      { kind: 'other', legSeq: 4, n: 1 },
    ])
  })

  it('行が無ければ空', () => {
    expect(buildOperationRoute(HEADERS, [])).toEqual(EMPTY_ROUTE)
  })
})

describe('buildOperationRoute / windows (NET780 軌跡を切る時間窓)', () => {
  it('便 2 本: 運行開始→積み1 / 積み1→降し1 / 降し1→積み2 / 積み2→最後の降し2 / 降し2→運行終了', () => {
    const route = buildOperationRoute(HEADERS, TWO_LEGS)
    expect(route.windows).toEqual<LegWindow[]>([
      { legSeq: 1, kind: 'deadhead', fromTs: T('2026/7/1 5:00:00'), toTs: T('2026/7/1 8:00:00') },
      { legSeq: 1, kind: 'haul', fromTs: T('2026/7/1 8:00:00'), toTs: T('2026/7/1 11:30:00') },
      { legSeq: 2, kind: 'deadhead', fromTs: T('2026/7/1 11:30:00'), toTs: T('2026/7/1 14:00:00') },
      { legSeq: 2, kind: 'haul', fromTs: T('2026/7/1 14:00:00'), toTs: T('2026/7/1 18:30:00') },
      { legSeq: 2, kind: 'deadhead', fromTs: T('2026/7/1 18:30:00'), toTs: T('2026/7/1 20:00:00') },
    ])
    // 既存の segments / markers / pointCount / droppedRows は変わらない (別の describe で検証)。
    expect(route.pointCount).toBe(11)
  })

  it('時刻が読めない行の窓は作らない (積み 2 の開始日時が空 → 便 2 の回送と売上走行が無い。他は残る)', () => {
    const rows = TWO_LEGS.map(r => [...r])
    rows[6]![1] = '' // 2 つ目の 積み の 開始日時
    const route = buildOperationRoute(HEADERS, rows)
    expect(route.windows.map(w => `${w.kind}${w.legSeq}`)).toEqual(['deadhead1', 'haul1', 'deadhead2'])
    expect(route.windows[2]).toEqual({ legSeq: 2, kind: 'deadhead', fromTs: T('2026/7/1 18:30:00'), toTs: T('2026/7/1 20:00:00') })
    // 運行開始 の開始日時が読めない → 便 1 の回送だけ無い。
    const rows2 = TWO_LEGS.map(r => [...r])
    rows2[0]![1] = 'x'
    expect(buildOperationRoute(HEADERS, rows2).windows.map(w => `${w.kind}${w.legSeq}`))
      .toEqual(['haul1', 'deadhead2', 'haul2', 'deadhead2'])
    // 運行終了 の終了日時が読めない → 帰庫の回送だけ無い。
    const rows3 = TWO_LEGS.map(r => [...r])
    rows3[12]![2] = ''
    expect(buildOperationRoute(HEADERS, rows3).windows.map(w => `${w.kind}${w.legSeq}`))
      .toEqual(['deadhead1', 'haul1', 'deadhead2', 'haul2'])
    // segments / markers は時刻に依らない。
    expect(shape(route.segments)).toEqual(shape(buildOperationRoute(HEADERS, TWO_LEGS).segments))
  })

  it('運行開始 / 運行終了 の行が無ければ、最初の回送と帰庫の回送は無い', () => {
    const rows = TWO_LEGS.slice(1, 12)
    expect(buildOperationRoute(HEADERS, rows).windows.map(w => `${w.kind}${w.legSeq}`))
      .toEqual(['haul1', 'deadhead2', 'haul2'])
    // 運行開始 が 2 つなら最初、運行終了 が 2 つなら最後 (マーカーと同じ)。
    const twoStarts = [
      ev('運行開始', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 4:00:00', '2026/7/1 4:00:00'] }),
      ev('運行開始', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 4:30:00', '2026/7/1 4:30:00'] }),
      ...TWO_LEGS.slice(1, 12),
      ev('運行終了', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 19:00:00', '2026/7/1 19:00:00'] }),
      ev('運行終了', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 21:00:00', '2026/7/1 21:00:00'] }),
    ]
    const windows = buildOperationRoute(HEADERS, twoStarts).windows
    expect(windows[0]).toEqual({ legSeq: 1, kind: 'deadhead', fromTs: T('2026/7/1 4:00:00'), toTs: T('2026/7/1 8:00:00') })
    expect(windows[4]).toEqual({ legSeq: 2, kind: 'deadhead', fromTs: T('2026/7/1 18:30:00'), toTs: T('2026/7/1 21:00:00') })
  })

  it('降しの無い便は売上走行の窓が無く、次の便の回送も前の便の降しが無いので無い。最後の便なら帰庫も無い', () => {
    const rows = [
      ev('運行開始', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 5:00:00', '2026/7/1 5:00:00'] }),
      ev('積み', KUSHIRO, KUSHIRO, { ts: ['2026/7/1 6:00:00', '2026/7/1 6:10:00'] }), // 降し無し
      ev('積み', SHIHORO, SHIHORO, { ts: ['2026/7/1 7:00:00', '2026/7/1 7:10:00'] }),
      ev('降し', SHIMIZU, SHIMIZU, { ts: ['2026/7/1 8:00:00', '2026/7/1 8:10:00'] }),
      ev('積み', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 9:00:00', '2026/7/1 9:10:00'] }), // 降し無し (最後の便)
      ev('運行終了', KUSHIRO, KUSHIRO, { ts: ['2026/7/1 10:00:00', '2026/7/1 10:00:00'] }),
    ]
    expect(buildOperationRoute(HEADERS, rows).windows).toEqual<LegWindow[]>([
      { legSeq: 1, kind: 'deadhead', fromTs: T('2026/7/1 5:00:00'), toTs: T('2026/7/1 6:00:00') },
      { legSeq: 2, kind: 'haul', fromTs: T('2026/7/1 7:00:00'), toTs: T('2026/7/1 8:10:00') },
      { legSeq: 3, kind: 'deadhead', fromTs: T('2026/7/1 8:10:00'), toTs: T('2026/7/1 9:00:00') },
    ])
  })

  it('日時の列が無い CSV / 積みが 1 行も無い運行は窓が無い', () => {
    const headers = ['イベント名', '開始GPS緯度', '開始GPS経度', '終了GPS緯度', '終了GPS経度']
    const rows = [
      ['運行開始', OBIHIRO.lat, OBIHIRO.lng, OBIHIRO.lat, OBIHIRO.lng],
      ['積み', KUSHIRO.lat, KUSHIRO.lng, KUSHIRO.lat, KUSHIRO.lng],
      ['降し', SHIHORO.lat, SHIHORO.lng, SHIHORO.lat, SHIHORO.lng],
    ]
    expect(buildOperationRoute(headers, rows).windows).toEqual([])
    expect(buildOperationRoute(HEADERS, [ev('運行開始', OBIHIRO, OBIHIRO), ev('運転', OBIHIRO, KUSHIRO)]).windows).toEqual([])
  })
})

describe('splitTrackByWindows', () => {
  const P = (ts: number, lat: number, lng = 143) => ({ ts, lat, lng })
  const windows: LegWindow[] = [
    { legSeq: 1, kind: 'deadhead', fromTs: 100, toTs: 200 },
    { legSeq: 1, kind: 'haul', fromTs: 200, toTs: 300 },
  ]

  it('窓に入る点を窓ごとに 1 本の軌跡にし、窓の外は捨てる。境界 (両端) は含む', () => {
    const points = [P(50, 1), P(100, 2), P(150, 3), P(200, 4), P(250, 5), P(300, 6), P(350, 7)]
    expect(splitTrackByWindows(points, windows)).toEqual<RouteSegment[]>([
      { kind: 'trackDeadhead', legSeq: 1, path: [{ lat: 2, lng: 143 }, { lat: 3, lng: 143 }, { lat: 4, lng: 143 }] },
      { kind: 'trackHaul', legSeq: 1, path: [{ lat: 4, lng: 143 }, { lat: 5, lng: 143 }, { lat: 6, lng: 143 }] },
    ])
  })

  it('点が 1 つしか残らない窓は線にしない (同じ点が続けば 1 つにまとめる)。窓も点も無ければ空', () => {
    // deadhead 窓は 1 点だけ、haul 窓は 3 点とも同じ場所 (止まっていただけ) → どちらも線にならない。
    const points = [P(150, 1), P(210, 5), P(220, 5), P(230, 5)]
    expect(splitTrackByWindows(points, windows)).toEqual([])
    // 同じ点のまとめ: 緯度だけ同じは別の点。
    const moved = [P(210, 5), P(220, 5), P(230, 5, 144), P(240, 5, 144)]
    expect(splitTrackByWindows(moved, windows)).toEqual<RouteSegment[]>([
      { kind: 'trackHaul', legSeq: 1, path: [{ lat: 5, lng: 143 }, { lat: 5, lng: 144 }] },
    ])
    expect(splitTrackByWindows([], windows)).toEqual([])
    expect(splitTrackByWindows(points, [])).toEqual([])
  })

  it('legSeq は窓のもの。buildOperationRoute の windows にそのまま掛けられる', () => {
    const route = buildOperationRoute(HEADERS, TWO_LEGS)
    const points = [
      P(T('2026/7/1 6:00:00'), 42.9), P(T('2026/7/1 7:00:00'), 42.8), // 便 1 の回送
      P(T('2026/7/1 15:00:00'), 43.0), P(T('2026/7/1 16:00:00'), 43.1), // 便 2 の売上走行
      P(T('2026/7/1 19:00:00'), 42.95), // 帰庫 (1 点だけ → 線にしない)
    ]
    expect(shape(splitTrackByWindows(points, route.windows))).toEqual([
      { kind: 'trackDeadhead', legSeq: 1, n: 2 },
      { kind: 'trackHaul', legSeq: 2, n: 2 },
    ])
  })
})

describe('pickLegsFromRoute', () => {
  const route = buildOperationRoute(HEADERS, TWO_LEGS)

  it('seqs にある便の売上走行と、その便へ向かう回送だけを残す (start / end は落とす)', () => {
    const picked = pickLegsFromRoute(route, [2])
    expect(shape(picked.segments)).toEqual([
      { kind: 'deadhead', legSeq: 2, n: 2 }, // 便 2 へ向かう回送 (士幌 → 釧路)
      { kind: 'haul', legSeq: 2, n: 3 },
      { kind: 'deadhead', legSeq: 2, n: 2 }, // 便 2 の降後 (帰庫)
    ])
    // 運行開始 / 運行終了 のマーカーは出さない。積み・降しはその便のぶんだけ。
    expect(picked.markers.map(m => `${m.kind}${m.legSeq ?? ''}`)).toEqual(['load2', 'unload2'])
    expect(picked.pointCount).toBe(7)
    expect(picked.droppedRows).toBe(route.droppedRows)
    // windows もその便のぶんだけ (NET780 軌跡を便 2 だけに切れる)。
    expect(picked.windows.map(w => `${w.kind}${w.legSeq}`)).toEqual(['deadhead2', 'haul2', 'deadhead2'])
  })

  it('seqs が空なら segments も markers も windows も空 (pointCount 0、droppedRows はそのまま)', () => {
    const withDropped: OperationRoute = { ...route, droppedRows: 3 }
    const picked = pickLegsFromRoute(withDropped, [])
    expect(picked).toEqual({ segments: [], markers: [], pointCount: 0, droppedRows: 3, windows: [] })
  })

  it('NET780 軌跡 (trackHaul / trackDeadhead) も legSeq が一致すれば haul / deadhead と同じに残る', () => {
    const track: RouteSegment[] = [
      { kind: 'trackDeadhead', legSeq: 1, path: [{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }] },
      { kind: 'trackHaul', legSeq: 2, path: [{ lat: 3, lng: 3 }, { lat: 4, lng: 4 }] },
    ]
    const withTrack: OperationRoute = { ...route, segments: [...route.segments, ...track] }
    expect(shape(pickLegsFromRoute(withTrack, [2]).segments)).toEqual([
      { kind: 'deadhead', legSeq: 2, n: 2 },
      { kind: 'haul', legSeq: 2, n: 3 },
      { kind: 'deadhead', legSeq: 2, n: 2 },
      { kind: 'trackHaul', legSeq: 2, n: 2 },
    ])
  })

  it('複数の便を渡すと両方残る', () => {
    expect(shape(pickLegsFromRoute(route, [1, 2]).segments)).toEqual(shape(route.segments))
    expect(pickLegsFromRoute(route, [1, 2]).markers.map(m => `${m.kind}${m.legSeq ?? ''}`))
      .toEqual(['load1', 'load2', 'unload1', 'unload2'])
  })

  it('other は legSeq が一致するときだけ残る (降しの無い便)', () => {
    const rows = [
      ev('積み', KUSHIRO, KUSHIRO),
      ev('運転', KUSHIRO, SHIHORO), // 降し無し便 → other legSeq 1
      ev('積み', SHIHORO, SHIHORO),
      ev('降し', SHIMIZU, SHIMIZU),
    ]
    const built = buildOperationRoute(HEADERS, rows)
    expect(shape(built.segments)).toEqual([
      { kind: 'other', legSeq: 1, n: 2 },
      { kind: 'haul', legSeq: 2, n: 2 },
    ])
    expect(shape(pickLegsFromRoute(built, [1]).segments)).toEqual([{ kind: 'other', legSeq: 1, n: 2 }])
    expect(shape(pickLegsFromRoute(built, [2]).segments)).toEqual([{ kind: 'haul', legSeq: 2, n: 2 }])
  })

  it('legSeq が null の区切り (積みが 1 行も無い運行) は何を渡しても残らない', () => {
    const built = buildOperationRoute(HEADERS, [ev('運行開始', OBIHIRO, OBIHIRO), ev('運転', OBIHIRO, KUSHIRO)])
    expect(shape(built.segments)).toEqual([{ kind: 'other', legSeq: null, n: 2 }])
    expect(built.markers.map(m => m.kind)).toEqual(['start'])
    // legSeq null の区切りも、start マーカーも落ちる。
    expect(pickLegsFromRoute(built, [1])).toEqual(EMPTY_ROUTE)
  })
})

describe('mergeRoutes', () => {
  it('2 本を連結し、pointCount / droppedRows は和', () => {
    const a = pickLegsFromRoute(buildOperationRoute(HEADERS, TWO_LEGS), [1])
    const b: OperationRoute = { ...pickLegsFromRoute(buildOperationRoute(HEADERS, TWO_LEGS), [2]), droppedRows: 2 }
    const merged = mergeRoutes([a, b])
    expect(shape(merged.segments)).toEqual([...shape(a.segments), ...shape(b.segments)])
    expect(merged.markers).toEqual([...a.markers, ...b.markers])
    expect(merged.pointCount).toBe(a.pointCount + b.pointCount)
    expect(merged.droppedRows).toBe(a.droppedRows + 2)
    expect(merged.windows).toEqual([...a.windows, ...b.windows])
    expect(merged.windows.length).toBe(5)
    // 元は変えない (pure)。
    expect(a.segments.length).toBe(2)
  })

  it('空配列なら空の route', () => {
    expect(mergeRoutes([])).toEqual(EMPTY_ROUTE)
  })
})

describe('buildOverlayTrack (重ね掛け行も混ぜた軌跡、Refs #760 の 24)', () => {
  // 重ね掛け行だけが持つ点 (高速道の出入口・速度オーバー区間の両端)。
  const IC_IN: Gps = { lat: '42580000', lng: '143400000' }
  const IC_OUT: Gps = { lat: '43050000', lng: '144000000' }
  const PASS_A: Gps = { lat: '43020000', lng: '143480000' }
  const PASS_B: Gps = { lat: '43080000', lng: '143300000' }

  /** 便 1 本。回送に 高速道、売上走行に 一般道実車 の重ね掛け行が挟まる。 */
  const ONE_LEG: string[][] = [
    ev('運行開始', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 5:00:00', '2026/7/1 5:00:00'] }),
    ev('運転', OBIHIRO, KUSHIRO, { ts: ['2026/7/1 5:00:00', '2026/7/1 8:00:00'] }),
    ev('高速道', IC_IN, IC_OUT, { ts: ['2026/7/1 6:00:00', '2026/7/1 7:00:00'] }),
    ev('積み', KUSHIRO, KUSHIRO, { ts: ['2026/7/1 8:00:00', '2026/7/1 8:30:00'] }),
    ev('運転', KUSHIRO, SHIHORO, { ts: ['2026/7/1 8:30:00', '2026/7/1 11:00:00'] }),
    ev('一般道実車', PASS_A, PASS_B, { ts: ['2026/7/1 9:00:00', '2026/7/1 10:00:00'] }),
    ev('降し', SHIHORO, SHIHORO, { ts: ['2026/7/1 11:00:00', '2026/7/1 11:30:00'] }),
    ev('運行終了', SHIHORO, SHIHORO, { ts: ['2026/7/1 12:00:00', '2026/7/1 12:00:00'] }),
  ]

  it('重ね掛け行の始点・終点も点になる (イベント線より点が増える)', () => {
    const rows = [
      ev('運転', OBIHIRO, KUSHIRO, { ts: ['2026/7/1 8:00:00', '2026/7/1 12:00:00'] }),
      ev('高速道', IC_IN, IC_OUT, { ts: ['2026/7/1 9:00:00', '2026/7/1 11:00:00'] }),
    ]
    expect(buildOverlayTrack(HEADERS, rows)).toEqual([
      { ts: T('2026/7/1 8:00:00'), ...pt(OBIHIRO) },
      { ts: T('2026/7/1 9:00:00'), ...pt(IC_IN) },
      { ts: T('2026/7/1 11:00:00'), ...pt(IC_OUT) },
      { ts: T('2026/7/1 12:00:00'), ...pt(KUSHIRO) },
    ])
    // 同じ CSV でも buildOperationRoute は 運転 の 2 点だけ (距離の二重計上を避ける判定はそのまま)。
    expect(buildOperationRoute(HEADERS, rows).pointCount).toBeLessThan(buildOverlayTrack(HEADERS, rows).length)
  })

  it('GPS 無効 (有効=0 / 値 0) の点と、日時が読めない点は捨てる', () => {
    const rows = [
      ev('運転', { ...OBIHIRO, valid: '0' }, KUSHIRO, { ts: ['2026/7/1 8:00:00', '2026/7/1 9:00:00'] }),
      ev('高速道', SHIHORO, NOWHERE, { ts: ['2026/7/1 10:00:00', '2026/7/1 11:00:00'] }),
      ev('専用道', SHIMIZU, SHIMIZU, { ts: ['', 'まだ運行中'] }),
    ]
    expect(buildOverlayTrack(HEADERS, rows)).toEqual([
      { ts: T('2026/7/1 9:00:00'), ...pt(KUSHIRO) },
      { ts: T('2026/7/1 10:00:00'), ...pt(SHIHORO) },
    ])
  })

  it('ts 昇順に並べ替える。同じ時刻の点は CSV の行順のまま (安定ソート)', () => {
    const rows = [
      // 重ね掛け行は運行全体にまたがるので、CSV の行順は時刻順ではない。
      ev('専用道', SHIMIZU, SHIMIZU, { ts: ['2026/7/1 20:00:00', '2026/7/1 20:00:00'] }),
      ev('運転', OBIHIRO, KUSHIRO, { ts: ['2026/7/1 8:00:00', '2026/7/1 9:00:00'] }),
    ]
    expect(buildOverlayTrack(HEADERS, rows)).toEqual([
      { ts: T('2026/7/1 8:00:00'), ...pt(OBIHIRO) },
      { ts: T('2026/7/1 9:00:00'), ...pt(KUSHIRO) },
      { ts: T('2026/7/1 20:00:00'), ...pt(SHIMIZU) },
    ])
    const sameTs = [
      ev('運転', OBIHIRO, KUSHIRO, { ts: ['2026/7/1 8:00:00', '2026/7/1 8:00:00'] }),
      ev('高速道', SHIHORO, SHIMIZU, { ts: ['2026/7/1 8:00:00', '2026/7/1 8:00:00'] }),
    ]
    expect(buildOverlayTrack(HEADERS, sameTs).map(p => p.lat))
      .toEqual([OBIHIRO, KUSHIRO, SHIHORO, SHIMIZU].map(g => pt(g).lat))
  })

  it('同一の (ts, lat, lng) は 1 つに畳む。時刻か場所が違えば別の点', () => {
    const rows = [
      ev('運行開始', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 5:00:00', '2026/7/1 5:00:00'] }),
      // 重ね掛け行はタイムライン行と同じ時刻・同じ点をもう一度持つ (畳まないと点が倍になる)。
      ev('連続運転', OBIHIRO, KUSHIRO, { ts: ['2026/7/1 5:00:00', '2026/7/1 9:00:00'] }),
      ev('運転', OBIHIRO, KUSHIRO, { ts: ['2026/7/1 5:00:00', '2026/7/1 9:00:00'] }),
      // 同じ場所に別の時刻で戻ってきた点は残る (畳むのは ts も同じときだけ)。
      ev('休憩', OBIHIRO, OBIHIRO, { ts: ['2026/7/1 12:00:00', '2026/7/1 12:00:00'] }),
    ]
    expect(buildOverlayTrack(HEADERS, rows)).toEqual([
      { ts: T('2026/7/1 5:00:00'), ...pt(OBIHIRO) },
      { ts: T('2026/7/1 9:00:00'), ...pt(KUSHIRO) },
      { ts: T('2026/7/1 12:00:00'), ...pt(OBIHIRO) },
    ])
  })

  it('イベント名 列 / GPS 列 / 日時 列が無い CSV・短い行は空 (buildOperationRoute と同じ判定)', () => {
    const noGps = ['イベント名', '開始日時', '終了日時', '開始GPS緯度', '開始GPS経度', '開始GPS有効']
    expect(buildOverlayTrack(noGps, [['運転', '2026/7/1 8:00:00', '2026/7/1 9:00:00', KUSHIRO.lat, KUSHIRO.lng, '1']])).toEqual([])
    expect(buildOverlayTrack(HEADERS.filter(h => h !== 'イベント名'), [HEADERS.map(() => '1')])).toEqual([])
    // GPS 列はあるが日時の列が無い → 時刻が読めないので点にならない。
    const noTs = ['イベント名', '開始GPS緯度', '開始GPS経度', '終了GPS緯度', '終了GPS経度']
    expect(buildOverlayTrack(noTs, [['運転', OBIHIRO.lat, OBIHIRO.lng, KUSHIRO.lat, KUSHIRO.lng]])).toEqual([])
    // 日時の列まで届かない短い行・空の行でも落ちない。
    expect(buildOverlayTrack(HEADERS, [['運転'], []])).toEqual([])
  })

  it('windows で切ると便の色が付いた trackHaul / trackDeadhead になり、イベント線より折れ点が増える', () => {
    const route = buildOperationRoute(HEADERS, ONE_LEG)
    const track = splitTrackByWindows(buildOverlayTrack(HEADERS, ONE_LEG), route.windows)
    expect(track.map(s => `${s.kind}${s.legSeq}`)).toEqual(['trackDeadhead1', 'trackHaul1'])
    // 回送の時間帯には 高速道 の出入口が挟まる。
    expect(track[0]!.path).toEqual([pt(OBIHIRO), pt(IC_IN), pt(IC_OUT), pt(KUSHIRO)])
    // 売上走行の時間帯には 一般道実車 の両端が挟まる (イベント線は 積み → 降し の 2 点だけ)。
    const haul = route.segments.find(s => s.kind === 'haul')!
    expect(haul.path).toEqual([pt(KUSHIRO), pt(SHIHORO)])
    expect(track[1]!.path).toEqual([pt(KUSHIRO), pt(PASS_A), pt(PASS_B), pt(SHIHORO)])
    expect(track[1]!.path.length).toBeGreaterThan(haul.path.length)
    // 帰庫の窓 (降し → 運行終了) は同じ場所に居ただけ → 1 点に畳まれて線にならない。
    expect(route.windows.map(w => `${w.kind}${w.legSeq}`)).toEqual(['deadhead1', 'haul1', 'deadhead1'])
  })

  it('既存の segments / markers / pointCount / droppedRows / windows は変えない', () => {
    const before = buildOperationRoute(HEADERS, ONE_LEG)
    buildOverlayTrack(HEADERS, ONE_LEG)
    expect(buildOperationRoute(HEADERS, ONE_LEG)).toEqual(before)
    // 重ね掛け行を混ぜても buildOperationRoute の点列は DISTANCE_EVENT_NAMES の行だけ。
    const timelineOnly = ONE_LEG.filter(r => !['高速道', '一般道実車'].includes(r[0]!))
    expect(buildOperationRoute(HEADERS, timelineOnly)).toEqual(before)
  })
})

describe('parseRouteMapLayers / serializeRouteMapLayers (レイヤ切替の保存、Refs #760 の 25)', () => {
  it('既定は 軌跡 ON / 直線 2 つ OFF / 積み・降し ON / 開始終了 ON', () => {
    expect(DEFAULT_ROUTE_MAP_LAYERS).toEqual<RouteMapLayers>({
      track: true, haulLine: false, deadheadLine: false, load: true, unload: true, startEnd: true,
    })
    expect(ROUTE_MAP_LAYERS_KEY).toBe('dtako:margin:routeMapLayers')
  })

  it('null (未保存) / JSON でない / object でない (数値・null・配列) は既定', () => {
    for (const raw of [null, 'not json', '5', 'null', '"str"', 'true']) {
      expect(parseRouteMapLayers(raw)).toEqual(DEFAULT_ROUTE_MAP_LAYERS)
    }
    // 配列は object だがキーが無いので既定に倒れる。
    expect(parseRouteMapLayers('[true,false]')).toEqual(DEFAULT_ROUTE_MAP_LAYERS)
    // 既定そのものは凍結しているが、返すのは別オブジェクト (書き換えて壊さない)。
    expect(parseRouteMapLayers(null)).not.toBe(DEFAULT_ROUTE_MAP_LAYERS)
  })

  it('保存した値を往復できる (serialize → parse)', () => {
    const layers: RouteMapLayers = { track: false, haulLine: true, deadheadLine: true, load: false, unload: true, startEnd: false }
    expect(parseRouteMapLayers(serializeRouteMapLayers(layers))).toEqual(layers)
  })

  it('キーごとに boolean でなければそのキーだけ既定。余分なキーは無視', () => {
    expect(parseRouteMapLayers(JSON.stringify({ deadheadLine: true, track: 'yes', load: 0, foo: false }))).toEqual({
      ...DEFAULT_ROUTE_MAP_LAYERS,
      deadheadLine: true,
    })
    expect(parseRouteMapLayers('{}')).toEqual(DEFAULT_ROUTE_MAP_LAYERS)
  })
})

describe('filterRouteByLayers (レイヤで絞る、Refs #760 の 25)', () => {
  /** イベント線 + 軌跡 + マーカー全種が揃った route。 */
  function fullRoute(): OperationRoute {
    const base = buildOperationRoute(HEADERS, TWO_LEGS)
    const track = splitTrackByWindows(buildOverlayTrack(HEADERS, TWO_LEGS), base.windows)
    return { ...base, segments: [...base.segments, ...track] }
  }

  it('kind → 層の対応: 直線 haul = 売上走行の直線 / deadhead・other = 回送の直線 / track* = 軌跡、マーカー start・end = 開始終了', () => {
    expect(SEGMENT_LAYER).toEqual({ haul: 'haulLine', deadhead: 'deadheadLine', other: 'deadheadLine', trackHaul: 'track', trackDeadhead: 'track' })
    expect(MARKER_LAYER).toEqual({ start: 'startEnd', end: 'startEnd', load: 'load', unload: 'unload' })
  })

  it('既定 (直線 OFF) では軌跡とマーカーだけ残り、イベント線は全部落ちる。pointCount は残した点数', () => {
    const route = fullRoute()
    const kindsBefore = new Set(route.segments.map(s => s.kind))
    expect([...kindsBefore].sort()).toEqual(['deadhead', 'haul', 'trackDeadhead', 'trackHaul'])
    const shown = filterRouteByLayers(route, DEFAULT_ROUTE_MAP_LAYERS)
    expect([...new Set(shown.segments.map(s => s.kind))].sort()).toEqual(['trackDeadhead', 'trackHaul'])
    expect(shown.markers).toEqual(route.markers)
    expect(shown.pointCount).toBe(shown.segments.reduce((n, s) => n + s.path.length, 0))
    // 層で変わらないものはそのまま。
    expect(shown.droppedRows).toBe(route.droppedRows)
    expect(shown.windows).toEqual(route.windows)
    // 元は変えない (pure)。
    expect(route.segments.some(s => s.kind === 'haul')).toBe(true)
  })

  it('回送の直線だけ ON にすると deadhead (と other) のイベント線が戻る。売上走行の直線は別の層', () => {
    const route = fullRoute()
    const deadheadOnly = filterRouteByLayers(route, { ...DEFAULT_ROUTE_MAP_LAYERS, deadheadLine: true })
    expect([...new Set(deadheadOnly.segments.map(s => s.kind))].sort()).toEqual(['deadhead', 'trackDeadhead', 'trackHaul'])
    const haulOnly = filterRouteByLayers(route, { ...DEFAULT_ROUTE_MAP_LAYERS, track: false, haulLine: true })
    expect([...new Set(haulOnly.segments.map(s => s.kind))]).toEqual(['haul'])
    // other (降しの無い便) は回送の直線の層。
    const withOther: OperationRoute = { ...route, segments: [{ kind: 'other', legSeq: 1, path: [pt(KUSHIRO), pt(SHIHORO)] }] }
    expect(filterRouteByLayers(withOther, { ...DEFAULT_ROUTE_MAP_LAYERS, deadheadLine: true }).segments).toEqual(withOther.segments)
    expect(filterRouteByLayers(withOther, DEFAULT_ROUTE_MAP_LAYERS).segments).toEqual([])
  })

  it('マーカーは 積み / 降し / 開始終了 の 3 層で別々に落とせる', () => {
    const route = fullRoute()
    const kinds = (l: RouteMapLayers) => filterRouteByLayers(route, l).markers.map(m => m.kind)
    expect(kinds({ ...DEFAULT_ROUTE_MAP_LAYERS, load: false })).toEqual(route.markers.filter(m => m.kind !== 'load').map(m => m.kind))
    expect(kinds({ ...DEFAULT_ROUTE_MAP_LAYERS, unload: false })).toEqual(route.markers.filter(m => m.kind !== 'unload').map(m => m.kind))
    expect(kinds({ ...DEFAULT_ROUTE_MAP_LAYERS, startEnd: false })).toEqual(['load', 'load', 'unload', 'unload'])
    expect(kinds({ ...DEFAULT_ROUTE_MAP_LAYERS, load: false, unload: false, startEnd: false })).toEqual([])
  })

  it('全部 OFF なら segments も markers も空 (pointCount 0)。全部 ON なら元のまま', () => {
    const route = fullRoute()
    const none: RouteMapLayers = { track: false, haulLine: false, deadheadLine: false, load: false, unload: false, startEnd: false }
    expect(filterRouteByLayers(route, none)).toEqual({ ...route, segments: [], markers: [], pointCount: 0 })
    const all: RouteMapLayers = { track: true, haulLine: true, deadheadLine: true, load: true, unload: true, startEnd: true }
    expect(filterRouteByLayers(route, all)).toEqual({ ...route, pointCount: route.segments.reduce((n, s) => n + s.path.length, 0) })
  })
})
