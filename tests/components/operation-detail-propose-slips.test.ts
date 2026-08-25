/**
 * 運行詳細 (`/operations/[unko_no]`) の「一番星の伝票から区間を提案」ボタンが
 * **押しても何も起きない運行で黙らないこと** (Refs #822 ①)。
 *
 * `proposeFromSlips` は検索キー (`raw_data.車輌CD` / 運行日) が無いとき
 * **`proposeStatus` を `'loading'` にする前に `return`** していた。押した人から見ると
 * 表示が一切変わらず、エラーも出ない ⇒ **「ボタンが壊れている」としか読めない**
 * (`SKILL.md` (7)「黙って落とさず数えて画面に言わせる」)。
 *
 * 直しの要点は 2 つあって、どちらもここで固定する:
 *
 * - **無言で終わらせない** — 何が欠けているかを画面に出す
 * - **`'error'` に相乗りさせない** — 「呼んだが駄目だった」は押し直せば変わりうるが、
 *   材料が無い状態は**何度押しても永久に変わらない**。同じ見た目にすると
 *   「もう一度押せば直るかも」と読ませる。だから `'unavailable'` を別に立て、
 *   **車輌CD と運行日のどちらが欠けたかまで言い分ける** (両方あり得る)。
 *
 * **提案の中身 (どの区間を提案するか) は 1 つも変えていない。**陽性対照の
 * 「両方そろっている運行」が今までどおり `'loading'` に入って提案まで走ることを
 * 同じファイルで測り、退行が無いことを示す。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { CsvJsonResponse, Operation } from '~/types'
import type { VehicleDailySlip } from '~/utils/ichiban'

const UNKO_NO = '2607010121120000001318'

const { getOperationMock, getOperationCsvMock, fetchVehicleDailySlipsMock } = vi.hoisted(() => ({
  getOperationMock: vi.fn(),
  getOperationCsvMock: vi.fn(),
  fetchVehicleDailySlipsMock: vi.fn(),
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getOperation: getOperationMock,
  getOperationCsv: getOperationCsvMock,
}))

vi.mock('~/utils/ichiban', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/ichiban')>()),
  fetchVehicleDailySlips: fetchVehicleDailySlipsMock,
}))

mockNuxtImport('useRoute', () => () => ({ params: { unko_no: UNKO_NO } }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn() }))

const HEADERS = [
  'イベント名', '開始日時', '終了日時', '開始市町村名', '終了市町村名',
  '開始GPS緯度', '開始GPS経度', '開始GPS有効', '終了GPS緯度', '終了GPS経度', '終了GPS有効', '区間距離',
]

function ev(name: string, startCity: string, endCity: string, from: string, to: string): string[] {
  return [name, from, to, startCity, endCity, '42590000', '144230000', '1', '42550000', '143120000', '1', '10']
}

/** 釧路市で積んで士幌町で降す 1 便。 */
const EVENTS_CSV: CsvJsonResponse = {
  headers: HEADERS,
  rows: [
    ev('運行開始', '帯広市', '', '2026/7/1 5:00:00', '2026/7/1 5:00:00'),
    ev('積み', '釧路市', '', '2026/7/1 8:00:00', '2026/7/1 8:30:00'),
    ev('降し', '', '士幌町', '2026/7/1 11:00:00', '2026/7/1 11:30:00'),
    ev('運行終了', '', '帯広市', '2026/7/1 20:00:00', '2026/7/1 20:00:00'),
  ],
}

const SLIP = {
  saleDate: '2026-07-01',
  vehicleNumber: '1318',
  customerCode: 'C1',
  customerName: '得意先A',
  originAreaName: '釧路市',
  destAreaName: '士幌町',
  origin: '釧路',
  dest: '士幌',
  isSubcontracted: false,
  amount: 100000,
  itemCode: 'I1',
  itemName: '品目A',
  quantity: 1,
  unitPrice: 100000,
  unit: '式',
  rowId: 'R1',
  requestKind: '0',
} satisfies VehicleDailySlip

/** `raw_data` と日付だけを差し替えて運行を作る (他は提案に効かない)。 */
function operation(raw: Record<string, unknown>, dates: { operation_date?: string, reading_date?: string }): Operation {
  return { unko_no: UNKO_NO, raw_data: raw, ...dates } as unknown as Operation
}

const passthroughStub = { template: '<div><slot /></div>' }

const OperationDetailPage = (await import('~/pages/operations/[unko_no].vue')).default

async function mountPage() {
  const w = mount(OperationDetailPage, {
    global: {
      stubs: {
        UButton: { props: ['label'], template: '<button><slot />{{ label }}</button>' },
        UIcon: { template: '<span />' },
        UModal: { template: '<div />' },
        NuxtLink: { template: '<a><slot /></a>' },
        EventDataTable: passthroughStub,
        CsvDataTable: passthroughStub,
        Net780OperationSummary: passthroughStub,
        EventSpeedMapPanel: passthroughStub,
        EventSelectionSummaryPanel: passthroughStub,
        ProfitPanel: passthroughStub,
        OperationRouteMap: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  return w
}

const PROPOSE_LABEL = '一番星の伝票から区間を提案'

function proposeButton(w: VueWrapper) {
  return w.findAll('button').find(b => b.text() === PROPOSE_LABEL || b.text() === '提案中...')
}

/** 提案ボタンの隣に出る一言 (`.text-xs` の span 群) をまとめて拾う。
 * **区画の生死は文言ではなく要素で見る** ため、押す前/押した後の集合を比べる。 */
function noticeTexts(w: VueWrapper): string[] {
  return w.findAll('span.text-xs').map(s => s.text()).filter(t => t !== '')
}

describe('提案ボタン: 検索キーが無い運行で黙らない (Refs #822 ①)', () => {
  beforeEach(() => {
    getOperationCsvMock.mockReset().mockResolvedValue(EVENTS_CSV)
    fetchVehicleDailySlipsMock.mockReset().mockResolvedValue([SLIP])
    // 計上額パネル (R2) と NET780 はこの検証では引けない扱い (404)。
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
    localStorage.clear()
  })

  it('車輌CD が無い運行: 押すと表示が変わり、車輌CD が無いことが読める', async () => {
    getOperationMock.mockReset().mockResolvedValue([
      operation({ 乗務員CD1: '1412' }, { operation_date: '2026-07-01', reading_date: '2026-07-01' }),
    ])
    const w = await mountPage()
    const before = noticeTexts(w)

    const btn = proposeButton(w)
    expect(btn).toBeDefined()
    await btn!.trigger('click')
    await flushPromises()

    // **無言で終わらない** — 押す前には無かった一言が増えている。
    const after = noticeTexts(w)
    expect(after).not.toEqual(before)
    expect(w.text()).toContain('この運行は車輌CDが無いため提案できません')
    // 材料が無いのだから**一番星は呼んでいない**。
    expect(fetchVehicleDailySlipsMock).not.toHaveBeenCalled()
    // **「提案に失敗しました」(押し直せば変わりうる) には倒さない。**
    expect(w.text()).not.toContain('提案に失敗しました')
    expect(w.text()).not.toContain('一致する伝票が見つかりませんでした')
  })

  it('日付が無い運行: ① と区別できる文が出る', async () => {
    getOperationMock.mockReset().mockResolvedValue([
      operation({ 車輌CD: '1318' }, {}),
    ])
    const w = await mountPage()
    await proposeButton(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('この運行は運行日が無いため提案できません')
    // **①と同じ文にしない** — 原因が分からないと直しようがない。
    expect(w.text()).not.toContain('車輌CD')
    expect(fetchVehicleDailySlipsMock).not.toHaveBeenCalled()
  })

  it('両方無い運行: どちらも欠けていることが分かる (片方だけの文に丸めない)', async () => {
    getOperationMock.mockReset().mockResolvedValue([operation({}, {})])
    const w = await mountPage()
    await proposeButton(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).toContain('この運行は車輌CDと運行日が無いため提案できません')
  })

  it('operation_date が無くても reading_date があれば提案は走る (日付欠けと混同しない)', async () => {
    getOperationMock.mockReset().mockResolvedValue([
      operation({ 車輌CD: '1318' }, { reading_date: '2026-07-01' }),
    ])
    const w = await mountPage()
    await proposeButton(w)!.trigger('click')
    await flushPromises()

    expect(w.text()).not.toContain('提案できません')
    expect(fetchVehicleDailySlipsMock).toHaveBeenCalledTimes(1)
  })

  // ★ 陽性対照: 直した経路が**提案そのものを止めていない**こと。
  it('車輌CD も日付もある運行: 今までどおり loading に入り、提案が走る', async () => {
    getOperationMock.mockReset().mockResolvedValue([
      operation({ 車輌CD: '1318' }, { operation_date: '2026-07-01', reading_date: '2026-07-01' }),
    ])
    // 伝票取得を宙吊りにして「提案中...」を観測する。
    let release: (v: VehicleDailySlip[]) => void = () => {}
    fetchVehicleDailySlipsMock.mockReset().mockImplementation(
      () => new Promise<VehicleDailySlip[]>((resolve) => { release = resolve }),
    )
    const w = await mountPage()

    await proposeButton(w)!.trigger('click')
    await flushPromises()
    // `'loading'` に入っている = ボタンの文字が変わり、押せなくなる。
    expect(proposeButton(w)!.text()).toBe('提案中...')
    expect(proposeButton(w)!.attributes('disabled')).toBeDefined()
    // 検索キーは運行から取った車輌CD、日付は前後に広げた範囲 (提案の中身は不変)。
    expect(fetchVehicleDailySlipsMock).toHaveBeenCalledWith('1318', '2026-06-30', '2026-07-03')

    release([SLIP])
    await flushPromises()

    // 伝票の積地・卸地に対応する区間が見つかって提案が確定する。
    expect(proposeButton(w)!.text()).toBe(PROPOSE_LABEL)
    expect(w.text()).not.toContain('提案できません')
    expect(w.text()).not.toContain('一致する伝票が見つかりませんでした')
    expect(w.text()).not.toContain('提案に失敗しました')
  })
})
