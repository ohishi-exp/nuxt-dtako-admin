/**
 * 運行詳細 (`/operations/[unko_no]`) の「経路地図」ボタン (Refs #873)。
 *
 * **粗利タブと同じ経路・同じ便番号が出ること**と、**軌跡が無い運行で黙らないこと**を
 * 固定する。経路の組み立てそのものは `operation-route-map.test.ts` (pure) が持つので、
 * ここで見るのは**配線**だけ:
 *
 * - イベントタブが既に読んだ CSV をそのまま渡す (**地図を開くための追加 fetch が無い**)
 * - `buildOperationRoute` と同じ結果が `OperationRouteMap` に渡る (便の数え直しをしない)
 * - NET780 が未アーカイブでも軌跡の理由が画面に出る
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { buildOperationRoute } from '~/utils/operation-route-map'
import type { CsvJsonResponse, Operation } from '~/types'

const UNKO_NO = '2607010121120000001318'

const { getOperationMock, getOperationCsvMock } = vi.hoisted(() => ({
  getOperationMock: vi.fn(),
  getOperationCsvMock: vi.fn(),
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getOperation: getOperationMock,
  getOperationCsv: getOperationCsvMock,
}))

mockNuxtImport('useRoute', () => () => ({ params: { unko_no: UNKO_NO } }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn() }))

const HEADERS = [
  'イベント名', '開始日時', '終了日時', '開始市町村名', '終了市町村名',
  '開始GPS緯度', '開始GPS経度', '開始GPS有効', '終了GPS緯度', '終了GPS経度', '終了GPS有効', '区間距離',
]
const KUSHIRO = ['42590000', '144230000']
const OBIHIRO = ['42550000', '143120000']
const SHIHORO = ['43100000', '143150000']

function ev(name: string, from: string[], to: string[], startCity = '', endCity = '', ts = ['2026/7/1 8:00:00', '2026/7/1 9:00:00']): string[] {
  return [name, ts[0]!, ts[1]!, startCity, endCity, from[0]!, from[1]!, '1', to[0]!, to[1]!, '1', '10']
}

/** 便 2 本 (帯広 → 釧路積み → 士幌降し → 釧路積み → 帯広降し)。 */
const EVENTS_CSV: CsvJsonResponse = {
  headers: HEADERS,
  rows: [
    ev('運行開始', OBIHIRO, OBIHIRO, '帯広市', '', ['2026/7/1 5:00:00', '2026/7/1 5:00:00']),
    ev('運転', OBIHIRO, KUSHIRO),
    ev('積み', KUSHIRO, KUSHIRO, '釧路市', '', ['2026/7/1 8:00:00', '2026/7/1 8:30:00']),
    ev('運転', KUSHIRO, SHIHORO),
    ev('降し', SHIHORO, SHIHORO, '', '士幌町', ['2026/7/1 11:00:00', '2026/7/1 11:30:00']),
    ev('運転', SHIHORO, KUSHIRO),
    ev('積み', KUSHIRO, KUSHIRO, '釧路市', '', ['2026/7/1 14:00:00', '2026/7/1 14:30:00']),
    ev('運転', KUSHIRO, OBIHIRO),
    ev('降し', OBIHIRO, OBIHIRO, '', '帯広市', ['2026/7/1 18:00:00', '2026/7/1 18:30:00']),
    ev('運行終了', OBIHIRO, OBIHIRO, '', '帯広市', ['2026/7/1 20:00:00', '2026/7/1 20:00:00']),
  ],
}

const OPERATION = {
  unko_no: UNKO_NO,
  reading_date: '2026-07-01',
  operation_date: '2026-07-01',
  raw_data: { 車輌CD: '1318', 乗務員CD1: '1412' },
} as unknown as Operation

/** `OperationRouteMap` は Google Maps を読むので、受け取った props を記録するだけにする。 */
const routeMapProps: Array<Record<string, unknown>> = []
const OperationRouteMapStub = {
  props: ['route', 'title', 'loading', 'error', 'trackNote', 'layers', 'net780MissingCount'],
  setup(props: Record<string, unknown>) {
    routeMapProps.push(props)
    return () => null
  },
}

const passthroughStub = { template: '<div><slot /></div>' }
const buttonStub = { props: ['label'], template: '<button>{{ label }}</button>' }

function mountPage() {
  return mount(OperationDetailPage, {
    global: {
      stubs: {
        UButton: buttonStub,
        UIcon: { template: '<span />' },
        UModal: { template: '<div />' },
        NuxtLink: { template: '<a><slot /></a>' },
        EventDataTable: passthroughStub,
        CsvDataTable: passthroughStub,
        Net780OperationSummary: passthroughStub,
        EventSpeedMapPanel: passthroughStub,
        EventSelectionSummaryPanel: passthroughStub,
        ProfitPanel: passthroughStub,
        OperationRouteMap: OperationRouteMapStub,
      },
    },
  })
}

// `~/pages/...` の import はモック定義より後に評価されるよう動的に読む。
const OperationDetailPage = (await import('~/pages/operations/[unko_no].vue')).default

describe('運行詳細の経路地図 (Refs #873)', () => {
  beforeEach(() => {
    routeMapProps.length = 0
    getOperationMock.mockReset().mockResolvedValue([OPERATION])
    getOperationCsvMock.mockReset().mockResolvedValue(EVENTS_CSV)
    // 計上額パネル (R2) と NET780 は、この検証では引けない扱い (404) にする。
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
    localStorage.clear()
  })

  it('ボタンを押すまで地図は出ず、押すと粗利タブと同じ経路が渡る', async () => {
    const w = mountPage()
    await flushPromises()
    expect(routeMapProps).toHaveLength(0)

    // イベントタブは mount 時に既に CSV を読んでいる。**地図を開いても読み直さない。**
    const csvCallsBefore = getOperationCsvMock.mock.calls.length
    expect(csvCallsBefore).toBe(1)

    const button = w.findAll('button').find(b => b.text() === '経路地図')
    expect(button).toBeDefined()
    await button!.trigger('click')
    await flushPromises()

    expect(getOperationCsvMock.mock.calls.length).toBe(csvCallsBefore)
    expect(routeMapProps).toHaveLength(1)
    const props = routeMapProps[0]!
    // **便の切り方は `buildOperationRoute` が正** — 画面で数え直さない。
    const expected = buildOperationRoute(EVENTS_CSV.headers, EVENTS_CSV.rows)
    const route = props.route as ReturnType<typeof buildOperationRoute>
    expect(route.legCount).toBe(2)
    expect(route.markers).toEqual(expected.markers)
    expect(route.windows).toEqual(expected.windows)
    // イベント線はそのまま入っていて、その後ろに軌跡が足されている。
    expect(route.segments.slice(0, expected.segments.length)).toEqual(expected.segments)
    expect(route.segments.length).toBeGreaterThan(expected.segments.length)
    expect(props.title).toBe(`運行 ${UNKO_NO} (読取日 2026-07-01) — 便 2 本`)
    expect(props.error).toBeNull()
  })

  it('NET780 が未アーカイブでも軌跡の出どころを言う (黙って線を消さない)', async () => {
    const w = mountPage()
    await flushPromises()
    await w.findAll('button').find(b => b.text() === '経路地図')!.trigger('click')
    await flushPromises()
    expect(routeMapProps[0]!.trackNote)
      .toBe('軌跡: イベント行の GPS (重ね掛け行も含む) — この運行の NET780 はまだアーカイブされていません')
  })

  it('イベントCSV が引けなかったときは「GPS が無い」ではなく取得の失敗として出す', async () => {
    getOperationCsvMock.mockReset().mockRejectedValue(new Error('csv boom'))
    const w = mountPage()
    await flushPromises()
    await w.findAll('button').find(b => b.text() === '経路地図')!.trigger('click')
    await flushPromises()
    // **握り潰された空 CSV を「GPS 列が無い」と読ませない** (Refs #873)。
    expect(routeMapProps[0]!.error).toBe('csv boom')
  })

  it('NET780 の一括取得ボタンは出さない (relay を叩くのは粗利タブの仕事)', async () => {
    const w = mountPage()
    await flushPromises()
    await w.findAll('button').find(b => b.text() === '経路地図')!.trigger('click')
    await flushPromises()
    expect(routeMapProps[0]!.net780MissingCount).toBeUndefined()
  })

  // ★ 親の指摘 (a): GPS が読めない運行で**空の地図**が出ると「走っていない」に読める。
  describe('GPS が読めない運行', () => {
    it('GPS 列が無い CSV は「便 0 本」と名乗らない (数えられなかっただけ)', async () => {
      getOperationCsvMock.mockReset().mockResolvedValue({
        headers: ['イベント名', '開始日時', '終了日時'],
        rows: [['積み', '2026/7/1 8:00:00', '2026/7/1 8:30:00']],
      })
      const w = mountPage()
      await flushPromises()
      await w.findAll('button').find(b => b.text() === '経路地図')!.trigger('click')
      await flushPromises()
      const props = routeMapProps[0]!
      const route = props.route as ReturnType<typeof buildOperationRoute>
      // `buildOperationRoute` は GPS 列が無いと emptyRoute() を返す = 描くものが無い。
      expect(route.segments).toEqual([])
      expect(route.droppedRows).toBe(0)
      // **見出しで「便 0 本」と嘘をつかない。**「なぜ空か」はモーダルの overlay が言う
      // (`OperationRouteMap.vue` の `emptyReason`: GPS 列が無いか、行がありません)。
      expect(props.title).toBe(`運行 ${UNKO_NO} (読取日 2026-07-01)`)
      // **取得の失敗ではない** (error は null のまま = overlay が「引けなかった」に倒れない)。
      expect(props.error).toBeNull()
    })

    it('GPS 列はあるが全行無効なら、落とした行数が route に乗る (画面が数を出せる)', async () => {
      const dead = { ...EVENTS_CSV, rows: EVENTS_CSV.rows.map(r => [...r.slice(0, 5), '0', '0', '0', '0', '0', '0', r[11]!]) }
      getOperationCsvMock.mockReset().mockResolvedValue(dead)
      const w = mountPage()
      await flushPromises()
      await w.findAll('button').find(b => b.text() === '経路地図')!.trigger('click')
      await flushPromises()
      const route = routeMapProps[0]!.route as ReturnType<typeof buildOperationRoute>
      expect(route.segments).toEqual([])
      // **黙って 0 にしない** — `OperationRouteMap` の overlay が
      // 「GPS が有効な行がありません (GPS 無効の行 N)」を出せる材料。
      expect(route.droppedRows).toBeGreaterThan(0)
      // 便は数えられている (GPS ではなくイベント名で切るため) ので本数は出す。
      expect(routeMapProps[0]!.title).toContain('便 2 本')
    })
  })

  // ★ 親の指摘 (b): イベントタブを開いていない状態で押すと、そこで CSV を取りに行く。
  it('CSV 未取得のまま押しても無反応にならない (取得中は loading を渡す)', async () => {
    let release: ((v: CsvJsonResponse) => void) | null = null
    getOperationCsvMock.mockReset().mockImplementation(() => new Promise<CsvJsonResponse>((r) => { release = r }))
    const w = mountPage()
    await flushPromises()
    await w.findAll('button').find(b => b.text() === '経路地図')!.trigger('click')
    await flushPromises()
    // モーダルは**押した直後に開く**。中は「イベントCSV を取得中...」の overlay。
    expect(routeMapProps).toHaveLength(1)
    expect(routeMapProps[0]!.loading).toBe(true)
    expect(routeMapProps[0]!.route).toBeNull()
    release!(EVENTS_CSV)
    await flushPromises()
    expect(routeMapProps[0]!.loading).toBe(false)
    expect(routeMapProps[0]!.route).not.toBeNull()
  })

  // ★ 親の検証項目: 便が多い運行 (積み 12) で色分け・便番号が破綻しないか。
  it('積み 12 便でも便番号は 1..12 のまま (イベント表の 5 色循環に引きずられない)', async () => {
    const rows: string[][] = [ev('運行開始', OBIHIRO, OBIHIRO, '帯広市', '', ['2026/7/1 5:00:00', '2026/7/1 5:00:00'])]
    for (let i = 0; i < 12; i++) {
      const h = 6 + i
      rows.push(ev('積み', KUSHIRO, KUSHIRO, '釧路市', '', [`2026/7/1 ${h}:00:00`, `2026/7/1 ${h}:10:00`]))
      rows.push(ev('運転', KUSHIRO, SHIHORO, '', '', [`2026/7/1 ${h}:10:00`, `2026/7/1 ${h}:30:00`]))
      rows.push(ev('降し', SHIHORO, SHIHORO, '', '士幌町', [`2026/7/1 ${h}:30:00`, `2026/7/1 ${h}:40:00`]))
      rows.push(ev('運転', SHIHORO, KUSHIRO, '', '', [`2026/7/1 ${h}:40:00`, `2026/7/1 ${h}:55:00`]))
    }
    rows.push(ev('運行終了', OBIHIRO, OBIHIRO, '', '帯広市', ['2026/7/1 20:00:00', '2026/7/1 20:00:00']))
    getOperationCsvMock.mockReset().mockResolvedValue({ headers: HEADERS, rows })
    const w = mountPage()
    await flushPromises()
    await w.findAll('button').find(b => b.text() === '経路地図')!.trigger('click')
    await flushPromises()
    const route = routeMapProps[0]!.route as ReturnType<typeof buildOperationRoute>
    expect(route.legCount).toBe(12)
    // **地図は便を色ではなく数字で出す** (`OperationRouteMap` の marker ラベル)。
    // 5 で circulate するのはイベント表のセル色 (`LEG_COLOR_COUNT`) だけで、
    // 便番号そのものは 1..12 が別々に残る。
    expect(route.markers.filter(m => m.kind === 'load').map(m => m.legSeq))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(route.markers.filter(m => m.kind === 'unload').map(m => m.legSeq))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(routeMapProps[0]!.title).toContain('便 12 本')
  })
})
