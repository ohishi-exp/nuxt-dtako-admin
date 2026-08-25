import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import EventDataTable from '~/components/EventDataTable.vue'
import type { CsvJsonResponse } from '~/types'
import { UIconStub } from '../helpers/stubs'
import { getEventClassifications } from '~/utils/api'

// イベント分類 (`/event-classifications`) の「無視」を表が読むようになったので、
// 取得はモックする。既定は 401 (急加速) だけ無視。
vi.mock('~/utils/api', () => ({
  getEventClassifications: vi.fn(async () => [
    { event_cd: '401', classification: 'ignore' },
    { event_cd: '201', classification: 'work' },
  ]),
}))

const fullHeaders = [
  '開始日時', '終了日時', 'イベントCD', 'イベント名', '区間時間', '区間距離',
  '開始市町村名', '終了市町村名', '対象乗務員区分', '乗務員名１', '乗務員CD1',
  '事業所名', '車輌名',
]

function makeRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const defaults: Record<string, string> = {
    '開始日時': '2026/03/07 8:00:00', '終了日時': '2026/03/07 8:30:00',
    'イベントCD': '01', 'イベント名': '休憩', '区間時間': '30', '区間距離': '0',
    '開始市町村名': '東京都', '終了市町村名': '千葉市',
    '対象乗務員区分': '1', '乗務員名１': '山田太郎', '乗務員CD1': 'D001',
    '事業所名': '東京営業所', '車輌名': 'トラックA',
  }
  const merged = { ...defaults, ...overrides }
  return fullHeaders.map(h => merged[h] ?? '')
}

function createWrapper(data: CsvJsonResponse, loading = false) {
  return mount(EventDataTable, {
    props: { data, loading },
    global: { stubs: { UIcon: UIconStub, EventCrewPanel: { template: '<div class="crew-panel" />', props: ['group', 'headers'] } } },
  })
}

describe('EventDataTable', () => {
  it('shows loading spinner', () => {
    const wrapper = createWrapper({ headers: [], rows: [] }, true)
    expect(wrapper.text()).toContain('読み込み中')
  })

  it('shows empty message when no data', () => {
    const wrapper = createWrapper({ headers: [], rows: [] })
    expect(wrapper.text()).toContain('データがありません')
  })

  it('renders crew panel with data', () => {
    const wrapper = createWrapper({ headers: fullHeaders, rows: [makeRow()] })
    expect(wrapper.find('.crew-panel').exists()).toBe(true)
  })

  it('shows crew tabs for multiple roles', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [
        makeRow({ '対象乗務員区分': '1', '乗務員名１': '太郎' }),
        makeRow({ '対象乗務員区分': '2', '乗務員名１': '花子' }),
      ],
    })
    expect(wrapper.text()).toContain('1番乗務員')
    expect(wrapper.text()).toContain('2番乗務員')
  })

  it('switches crew tab on click', async () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [
        makeRow({ '対象乗務員区分': '1', '乗務員名１': '太郎' }),
        makeRow({ '対象乗務員区分': '2', '乗務員名１': '花子' }),
      ],
    })
    const tabs = wrapper.findAll('div.border-b button')
    await tabs[1]!.trigger('click')
    await nextTick()
    // Active tab class changes
    expect(tabs[1]!.classes().join(' ')).toContain('border-blue')
  })

  it('resets active crew when groups change', async () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ '対象乗務員区分': '2' })],
    })
    await nextTick()
    // Auto-adjusts to '2', crew panel renders
    expect(wrapper.find('.crew-panel').exists()).toBe(true)
  })

  it('shows empty when no matching headers', () => {
    const wrapper = createWrapper({ headers: ['不要列'], rows: [['a']] })
    // crewGroups has 1 group but no displayColumns → panel still renders
    expect(wrapper.find('.crew-panel').exists()).toBe(true)
  })

  it('イベント分類で「無視」にした行を落とし、件数を出して戻せる', async () => {
    // 急加速は 0km / 0分。**区間距離か区間時間を持つ行は無視でも落とさない**
    // (収支の 円/km・円/時間 の材料になるため) ので、ここは 0 にしておく。
    const spike = { 'イベントCD': '401', 'イベント名': '急加速', '区間距離': '0', '区間時間': '0' }
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [
        makeRow({ 'イベントCD': '202', 'イベント名': '積み' }),
        makeRow(spike),
        makeRow(spike),
      ],
    })
    await flushPromises()
    expect(wrapper.text()).toContain('「無視」にした 2 件も表示')
    expect(wrapper.findAll('div.overflow-auto > label')).toHaveLength(1)
    // チェックすると戻せる (件数の表示はそのまま)
    const box = wrapper.find('label input[type="checkbox"]')
    await box.setValue(true)
    await nextTick()
    expect((box.element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.text()).toContain('「無視」にした 2 件も表示')
  })

  it('区間距離や区間時間を持つ無視行は落とさない (収支の材料を消さない)', async () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ 'イベントCD': '401', 'イベント名': '急加速', '区間距離': '252.9', '区間時間': '288' })],
    })
    await flushPromises()
    expect(wrapper.text()).not.toContain('「無視」にした')
  })

  it('分類が引けなくても表は出す (全部見えるだけ)', async () => {
    vi.mocked(getEventClassifications).mockRejectedValueOnce(new Error('引けない'))
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ 'イベントCD': '401', '区間距離': '0', '区間時間': '0' })],
    })
    await flushPromises()
    expect(wrapper.find('.crew-panel').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('「無視」にした')
  })

  it('EventCrewPanel の update:selected-summary をそのまま relay する (実体の EventCrewPanel を使用)', async () => {
    const wrapper = mount(EventDataTable, {
      props: { data: { headers: fullHeaders, rows: [makeRow({ 'イベント名': '積み', '区間時間': '10', '区間距離': '3' })] }, loading: false },
      global: { stubs: { UIcon: UIconStub } },
    })
    await wrapper.find('tbody tr').trigger('click')
    const emitted = wrapper.emitted('update:selectedSummary')
    expect(emitted).toBeTruthy()
    const last = emitted![emitted!.length - 1]![0] as { distanceKm: number, durationMin: number } | null
    expect(last).toMatchObject({ distanceKm: 3, durationMin: 10 })
  })

  it('EventCrewPanel の update:selected-location をそのまま relay する (実体の EventCrewPanel を使用)', async () => {
    const wrapper = mount(EventDataTable, {
      props: { data: { headers: fullHeaders, rows: [makeRow({ '開始市町村名': '長崎市', '終了市町村名': '福岡市' })] }, loading: false },
      global: { stubs: { UIcon: UIconStub } },
    })
    await wrapper.find('tbody tr').trigger('click')
    const emitted = wrapper.emitted('update:selectedLocation')
    expect(emitted).toBeTruthy()
    const last = emitted![emitted!.length - 1]![0] as { originCity: string, destCity: string } | null
    expect(last).toEqual({ originCity: '長崎市', destCity: '福岡市' })
  })

  it('proposedRange prop を EventCrewPanel にそのまま中継する (実体の EventCrewPanel を使用)', async () => {
    const wrapper = mount(EventDataTable, {
      props: { data: { headers: fullHeaders, rows: [makeRow()] }, loading: false },
      global: { stubs: { UIcon: UIconStub } },
    })
    expect(wrapper.find('tbody input[type="checkbox"]').element.checked).toBe(false)
    await wrapper.setProps({
      proposedRange: {
        fromTs: Date.UTC(2026, 2, 7, 8, 0, 0) / 1000,
        toTs: Date.UTC(2026, 2, 7, 8, 30, 0) / 1000,
      },
    })
    expect(wrapper.find('tbody input[type="checkbox"]').element.checked).toBe(true)
  })

  // --- 便の列を **深い reactive の props** で通す (Refs #868、親の指摘)。
  //     ページ側 (`[unko_no].vue`) の `csvData` は `ref<Record<string, CsvJsonResponse>>` で、
  //     `props.data.rows` の**要素まで reactive proxy** になる。引き当て表を作る側と引く側で
  //     proxy と raw が混ざると**全行が引けなくなる**ので、`toRaw` を両側に挟んである。
  //     **その保証をここで固定する** — 壊れたら「判定不能 N 件」が出てこのテストが落ちる。
  describe('便の列 (Refs #868)', () => {
    function mountLive(data: CsvJsonResponse) {
      return mount(EventDataTable, {
        props: { data },
        global: { stubs: { UIcon: UIconStub } },
      })
    }

    function legCells(wrapper: ReturnType<typeof mountLive>): string[] {
      return wrapper.findAll('tbody tr').map(tr => tr.findAll('td')[2]!.text())
    }

    const twoLegRows = [
      makeRow({ 'イベント名': '運行開始' }),
      makeRow({ 'イベント名': '運転' }),
      makeRow({ 'イベント名': '積み' }),
      makeRow({ 'イベント名': '降し' }),
      makeRow({ 'イベント名': '運転' }),
      makeRow({ 'イベント名': '積み' }),
      makeRow({ 'イベント名': '降し' }),
      makeRow({ 'イベント名': '運行終了' }),
    ]

    it('深い reactive の data でも便が引ける (proxy と raw が混ざらない)', async () => {
      const wrapper = mountLive(reactive({ headers: fullHeaders, rows: twoLegRows }))
      await flushPromises()
      expect(legCells(wrapper)).toEqual([
        '便1 回送', '便1 回送', '便1', '便1',
        '便2 回送', '便2', '便2', '便2 帰庫',
      ])
      // 引けなかった行が 1 つも無いこと (identity が破れると全行がこちらに倒れる)。
      expect(wrapper.text()).not.toContain('判定できなかった')
    })

    // 差分レビューで実際に測られた 8 行をそのまま固定する (Refs #868 F1)。
    // **既定で開くイベントタブに 252.9km の `連続運転` が居て、売上区間と同じ
    // 塗りつぶしで「便1」と出ていた**のがこの回帰の中身。お金 (`extractOperationIdle`)
    // はその 252.9km を `overlayKm` に逃がして便1 の `haulKm` に入れていない。
    it('重ね掛け行は 3 タブとも塗りつぶさず「便1 重ね掛け」と出る', async () => {
      const rows = [
        makeRow({ 'イベント名': '運行開始' }),
        makeRow({ 'イベント名': '積み' }),
        makeRow({ 'イベント名': '連続運転', '区間距離': '252.9' }),
        makeRow({ 'イベント名': '一般道実車', '区間距離': '99' }),
        makeRow({ 'イベント名': '一般道実車速度オーバー', '区間距離': '88' }),
        makeRow({ 'イベント名': '運転', '区間距離': '30' }),
        makeRow({ 'イベント名': '降し' }),
        makeRow({ 'イベント名': '運行終了' }),
      ]
      const wrapper = mountLive(reactive({ headers: fullHeaders, rows }))
      await flushPromises()

      const tabs = () => wrapper.findAll('div.ml-auto button')
      const filled = () => wrapper.findAll('tbody tr')
        .map(tr => tr.findAll('td')[2]!.find('span').classes().join(' '))

      // イベントタブ (既定): 連続運転 だけが重ね掛け。
      expect(legCells(wrapper)).toEqual(['便1 回送', '便1', '便1 重ね掛け', '便1', '便1', '便1 帰庫'])
      expect(filled()[2]).not.toContain('bg-blue-100')
      expect(filled()[2]).toContain('border-dashed')
      // 売上区間の行は塗りつぶしのまま (重ね掛けの直し方が売上区間まで薄くしていない)。
      expect(filled()[1]).toContain('bg-blue-100')

      for (const i of [1, 3]) { // 走行 / 速度超過
        await tabs()[i]!.trigger('click')
        await nextTick()
        expect(legCells(wrapper)).toEqual(['便1 重ね掛け'])
        expect(filled()[0]).not.toContain('bg-blue-100')
        expect(filled()[0]).toContain('border-dashed')
      }
    })

    it('「無視した行も表示」を切り替えても便番号が動かない', async () => {
      // 401 (急加速) は `ignore` 指定。**イベントタブに出るが 0km/0分 なので落ちる。**
      const rows = [
        makeRow({ 'イベント名': '運行開始' }),
        // `dropIgnoredRows` が落とすのは **0km / 0分 の行だけ** (数字を持つ行は隠さない)。
        makeRow({ 'イベント名': '急加速', 'イベントCD': '401', '区間時間': '0', '区間距離': '0' }),
        makeRow({ 'イベント名': '積み' }),
        makeRow({ 'イベント名': '降し' }),
        makeRow({ 'イベント名': '運行終了' }),
      ]
      const wrapper = mountLive(reactive({ headers: fullHeaders, rows }))
      await flushPromises()
      const before = legCells(wrapper)
      expect(before).toEqual(['便1 回送', '便1', '便1', '便1 帰庫'])

      await wrapper.find('div.overflow-auto > label input').setValue(true)
      await nextTick()
      // 落としていた 急加速 の 1 行が増えるだけで、他の行の便番号は 1 つも動かない。
      // 急加速 は DISTANCE_EVENT_NAMES に無い重ね掛け行なので「便1 重ね掛け」。
      expect(legCells(wrapper)).toEqual(['便1 回送', '便1 重ね掛け', '便1', '便1', '便1 帰庫'])
      expect(wrapper.text()).not.toContain('判定できなかった')
    })
  })
})
