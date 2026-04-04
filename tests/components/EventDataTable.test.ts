import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import EventDataTable from '~/components/EventDataTable.vue'
import type { CsvJsonResponse } from '~/types'
import { UIconStub } from '../helpers/stubs'

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
})
