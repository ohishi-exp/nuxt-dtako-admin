// 粗利タブの入力 → 釧路営業所の組み直し試算の入力 (Refs #760 の 35)。
//
// **形の正本は共有 fixture** `tests/fixtures/kushiro-loading/doto-operations-2026-07.json`。
// そこから粗利タブ側の形 (`MarginOperationInput` + 便ごとの GPS) を作り直し、
// この util を通すと **fixture にそのまま戻る**ことを固定する。戻るなら、粗利タブが
// 組んだ入力を `summarizeDotoRebuild` がそのまま食える。
import { describe, expect, it } from 'vitest'
import {
  MARGIN_LEG_POINTS_KEY,
  buildRebuildOperationInputs,
  legPointsByLegSeq,
  parseLegPoints,
  serializeLegPoints,
  type LegPoints,
} from '~/utils/margin-rebuild-input'
import { buildOperationRoute } from '~/utils/operation-route-map'
import { extractOperationIdle } from '~/utils/allowance-idle'
import { toLatLng } from '~/utils/event-data-table'
import { summarizeDotoRebuild } from '~/utils/kushiro-doto-rebuild'
import type { RebuildOperationInput } from '~/utils/kushiro-doto-rebuild'
import type { MarginLegInput, MarginOperationInput } from '~/utils/margin'
import rawOperations from '../fixtures/kushiro-loading/doto-operations-2026-07.json'

const fixture = rawOperations as unknown as RebuildOperationInput[]

// --- イベントCSV (`operation-route-map.test.ts` と同じ組み立て) ---

const HEADERS = [
  'イベント名', '開始日時', '終了日時', '開始市町村名', '終了市町村名',
  '開始GPS緯度', '開始GPS経度', '開始GPS有効', '終了GPS緯度', '終了GPS経度', '終了GPS有効', '区間距離',
]

type Gps = { lat: string, lng: string, valid?: string }

const KUSHIRO: Gps = { lat: '42590000', lng: '144230000' }
const SHIHORO: Gps = { lat: '43100000', lng: '143150000' }
const SHIMIZU: Gps = { lat: '43000000', lng: '142530000' }
const OBIHIRO: Gps = { lat: '42550000', lng: '143120000' }

function pt(g: Gps) {
  return { lat: toLatLng(g.lat)!, lng: toLatLng(g.lng)! }
}

function ev(name: string, from: Gps, to: Gps, city = ''): string[] {
  return [
    name, '2026/7/1 8:00:00', '2026/7/1 9:00:00', city, city,
    from.lat, from.lng, from.valid ?? '1', to.lat, to.lng, to.valid ?? '1', '10',
  ]
}

/** 便 2 本 (釧路→士幌 / 釧路→清水)。2 便目は降しが 2 つで、最後の降しが便の卸地。 */
const TWO_LEGS: string[][] = [
  ev('運行開始', OBIHIRO, OBIHIRO, '帯広市'),
  ev('運転', OBIHIRO, KUSHIRO),
  ev('積み', KUSHIRO, KUSHIRO, '釧路市'),
  ev('運転', KUSHIRO, SHIHORO),
  ev('降し', SHIHORO, SHIHORO, '士幌町'),
  ev('運転', SHIHORO, KUSHIRO),
  ev('積み', KUSHIRO, KUSHIRO, '釧路市'),
  ev('運転', KUSHIRO, OBIHIRO),
  ev('降し', OBIHIRO, OBIHIRO, '帯広市'),
  ev('運転', OBIHIRO, SHIMIZU),
  ev('降し', SHIMIZU, SHIMIZU, '清水町'),
  ev('運転', SHIMIZU, OBIHIRO),
  ev('運行終了', OBIHIRO, OBIHIRO, '帯広市'),
]

describe('legPointsByLegSeq', () => {
  it('積み・降しの marker を便ごとに畳む (最後の降しが卸地)', () => {
    const points = legPointsByLegSeq(buildOperationRoute(HEADERS, TWO_LEGS).markers)
    expect([...points]).toEqual([
      [1, { loadPoint: pt(KUSHIRO), unloadPoint: pt(SHIHORO) }],
      [2, { loadPoint: pt(KUSHIRO), unloadPoint: pt(SHIMIZU) }],
    ])
  })

  it('運行開始・運行終了 (legSeq が null) は入らない', () => {
    const markers = buildOperationRoute(HEADERS, TWO_LEGS).markers
    expect(markers.filter(m => m.legSeq === null).map(m => m.kind)).toEqual(['start', 'end'])
    expect(legPointsByLegSeq(markers).size).toBe(2)
  })

  it('legSeq は `extractOperationIdle` の便と同じ数え方 (便の切り方を二重化しない)', () => {
    const idle = extractOperationIdle(HEADERS, TWO_LEGS)
    const points = legPointsByLegSeq(buildOperationRoute(HEADERS, TWO_LEGS).markers)
    expect([...points.keys()]).toEqual(idle.legKmDetail.map((_, i) => i + 1))
  })

  it('降しの無い便は卸地が null (0 に倒さない)', () => {
    const rows = TWO_LEGS.slice(0, 7) // 2 便目の積みまで (降し無し)
    const points = legPointsByLegSeq(buildOperationRoute(HEADERS, rows).markers)
    expect(points.get(2)).toEqual({ loadPoint: pt(KUSHIRO), unloadPoint: null })
  })

  it('積みの GPS が無効な便は積地が null', () => {
    const rows = TWO_LEGS.map(r => [...r])
    rows[2] = ev('積み', { ...KUSHIRO, valid: '0' }, { ...KUSHIRO, valid: '0' }, '釧路市')
    const points = legPointsByLegSeq(buildOperationRoute(HEADERS, rows).markers)
    expect(points.get(1)).toEqual({ loadPoint: null, unloadPoint: pt(SHIHORO) })
  })

  it('GPS 列の無い CSV は空 (marker が 1 つも無い)', () => {
    expect(legPointsByLegSeq(buildOperationRoute(['イベント名', '区間距離'], [['積み', '10']]).markers).size).toBe(0)
  })
})

// --- fixture → 粗利タブ側の形 → この util → fixture に戻る ---

/** fixture の便を粗利タブの入力 (`MarginLegInput`) に戻す。**座標は落とす** (別経路で運ぶため)。 */
function marginLegOf(leg: RebuildOperationInput['legs'][number]): MarginLegInput {
  return {
    seq: leg.seq,
    date: '2026-07-01',
    originCity: leg.originCity,
    destCity: leg.destCity,
    salesYen: leg.salesYen,
    allowanceYen: leg.allowanceYen,
    haulKm: leg.haulKm,
    deadheadKm: leg.deadheadKm,
    haulSec: leg.haulSec ?? null,
    deadheadSec: leg.deadheadSec ?? null,
    customers: [],
  }
}

function marginOperationOf(op: RebuildOperationInput): MarginOperationInput {
  return {
    unkoNo: op.unkoNo,
    date: '2026-07-01',
    driverName: op.driverName,
    vehicleCode: op.unkoNo.slice(10, 14),
    totalKm: 0,
    listedTotalKm: null,
    kmBreakdown: op.kmBreakdown,
    salesYen: 0,
    allowanceYen: 0,
    legs: op.legs.map(marginLegOf),
  }
}

/** fixture の座標を `legPointsByLegSeq` が返すのと同じ形に戻す。 */
function pointsOf(op: RebuildOperationInput): Map<number, LegPoints> {
  return new Map(op.legs.map(l => [l.seq, { loadPoint: l.loadPoint ?? null, unloadPoint: l.unloadPoint ?? null }]))
}

const marginInputs = fixture.map(marginOperationOf)
const pointsByUnko = new Map(fixture.map(op => [op.unkoNo, pointsOf(op)]))

describe('buildRebuildOperationInputs', () => {
  it('共有 fixture (道東 23 運行 / 38 便) と 1 バイトも違わない形に戻る', () => {
    expect(buildRebuildOperationInputs(marginInputs, pointsByUnko)).toEqual(fixture)
  })

  it('列の並びまで fixture と同じ (JSON にしたとき同じ形)', () => {
    const built = buildRebuildOperationInputs(marginInputs, pointsByUnko)
    expect(Object.keys(built[0]!)).toEqual(Object.keys(fixture[0]!))
    expect(Object.keys(built[0]!.legs[0]!)).toEqual(Object.keys(fixture[0]!.legs[0]!))
  })

  it('`summarizeDotoRebuild` に通した結果が fixture 直渡しと一致する', () => {
    const built = buildRebuildOperationInputs(marginInputs, pointsByUnko)
    expect(summarizeDotoRebuild(built, { area: 'doto' })).toEqual(summarizeDotoRebuild(fixture, { area: 'doto' }))
  })

  it('GPS を 1 運行も渡さないと全便が欠測 (0 に倒さない)', () => {
    const built = buildRebuildOperationInputs(marginInputs, new Map())
    expect(built.every(op => op.legs.every(l => l.loadPoint === null && l.unloadPoint === null))).toBe(true)
    expect(built.every(op => op.firstLoadPoint === null && op.lastUnloadPoint === null)).toBe(true)
    const summary = summarizeDotoRebuild(built, { area: 'doto' })
    expect(summary.totals.missingLegs).toBe(summary.totals.legs)
    expect(summary.totals.estimatedLegs).toBe(0)
  })

  it('便が 1 本も無い運行は 積地・卸地 とも null', () => {
    const empty: MarginOperationInput = { ...marginInputs[0]!, legs: [] }
    expect(buildRebuildOperationInputs([empty], pointsByUnko)[0]).toEqual({
      unkoNo: empty.unkoNo,
      driverName: empty.driverName,
      kmBreakdown: empty.kmBreakdown,
      firstLoadPoint: null,
      lastUnloadPoint: null,
      legs: [],
    })
  })

  it('便を seq の昇順に並べ直す (先頭の積地・末尾の卸地を入力順に依存させない)', () => {
    const shuffled: MarginOperationInput = { ...marginInputs[0]!, legs: [...marginInputs[0]!.legs].reverse() }
    const built = buildRebuildOperationInputs([shuffled], pointsByUnko)[0]!
    expect(built.legs.map(l => l.seq)).toEqual([1, 2, 3])
    expect(built.firstLoadPoint).toEqual(fixture[0]!.firstLoadPoint)
    expect(built.lastUnloadPoint).toEqual(fixture[0]!.lastUnloadPoint)
  })

  it('先頭の便の積地が欠測なら firstLoadPoint は null (次の便の点で代用しない)', () => {
    const op = fixture[0]!
    const holed = new Map(pointsByUnko)
    holed.set(op.unkoNo, new Map([...pointsOf(op)].map(([seq, p]) =>
      [seq, seq === 1 ? { loadPoint: null, unloadPoint: p.unloadPoint } : p])))
    const built = buildRebuildOperationInputs([marginInputs[0]!], holed)[0]!
    expect(built.firstLoadPoint).toBeNull()
    expect(built.legs[2]!.loadPoint).toEqual(op.legs[2]!.loadPoint)
  })

  it('最終便の卸地が欠測なら lastUnloadPoint は null', () => {
    const op = fixture[0]!
    const holed = new Map(pointsByUnko)
    holed.set(op.unkoNo, new Map([...pointsOf(op)].map(([seq, p]) =>
      [seq, seq === 3 ? { loadPoint: p.loadPoint, unloadPoint: null } : p])))
    expect(buildRebuildOperationInputs([marginInputs[0]!], holed)[0]!.lastUnloadPoint).toBeNull()
  })
})

// --- 保存 (別キー。粗利のキャッシュの形は変えない) ---

describe('serializeLegPoints / parseLegPoints', () => {
  it('キーは粗利のキャッシュと別', () => {
    expect(MARGIN_LEG_POINTS_KEY).toBe('dtako:margin:leg-points:v1')
  })

  it('23 運行ぶんを往復しても同じ', () => {
    const parsed = parseLegPoints(serializeLegPoints({ ym: '2026-07', points: pointsByUnko }))
    expect(parsed!.ym).toBe('2026-07')
    expect(parsed!.points).toEqual(pointsByUnko)
    expect(buildRebuildOperationInputs(marginInputs, parsed!.points)).toEqual(fixture)
  })

  it('空・壊れた JSON・配列・オブジェクトでないものは null', () => {
    expect(parseLegPoints(null)).toBeNull()
    expect(parseLegPoints('')).toBeNull()
    expect(parseLegPoints('{')).toBeNull()
    expect(parseLegPoints('12')).toBeNull()
    expect(parseLegPoints('null')).toBeNull()
    expect(parseLegPoints('{"points":{}}')).toBeNull()
    expect(parseLegPoints('{"ym":"2026-07"}')).toBeNull()
    expect(parseLegPoints('{"ym":"2026-07","points":null}')).toBeNull()
  })

  it('便が配列でない運行は飛ばす / seq が数でない便 (と null の行) は飛ばす', () => {
    const parsed = parseLegPoints('{"ym":"2026-07","points":{"a":1,"b":[null,{"seq":"1"},{"seq":2}]}}')
    expect([...parsed!.points.keys()]).toEqual(['b'])
    expect([...parsed!.points.get('b')!.keys()]).toEqual([2])
  })

  it('壊れた座標は欠測 (null) にする — 0 や NaN を座標として通さない', () => {
    const parsed = parseLegPoints(JSON.stringify({
      ym: '2026-07',
      points: { u: [{ seq: 1, loadPoint: { lat: 999, lng: 0 }, unloadPoint: 'x' }] },
    }))
    expect(parsed!.points.get('u')!.get(1)).toEqual({ loadPoint: null, unloadPoint: null })
  })
})
