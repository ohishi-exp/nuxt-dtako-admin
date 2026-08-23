import { describe, it, expect } from 'vitest'
import { buildOperationRoute, type RouteSegment } from '~/utils/operation-route-map'
import { extractOperationIdle } from '~/utils/allowance-idle'
import { toLatLng } from '~/utils/event-data-table'

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
    expect(buildOperationRoute(noGps, [['運転', '', '', '42590000', '144230000', '1']]))
      .toEqual({ segments: [], markers: [], pointCount: 0, droppedRows: 0 })
    expect(buildOperationRoute(HEADERS.filter(h => h !== 'イベント名'), [HEADERS.map(() => '1')]))
      .toEqual({ segments: [], markers: [], pointCount: 0, droppedRows: 0 })
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
    expect(buildOperationRoute(HEADERS, [])).toEqual({ segments: [], markers: [], pointCount: 0, droppedRows: 0 })
  })
})
