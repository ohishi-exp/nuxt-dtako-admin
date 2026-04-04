import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import EventCrewPanel from '~/components/EventCrewPanel.vue'
import type { CrewGroup } from '~/utils/event-data-table'
import { UIconStub } from '../helpers/stubs'

const headers = [
  '開始日時', '終了日時', 'イベントCD', 'イベント名', '区間時間', '区間距離',
  '開始市町村名', '終了市町村名', '開始GPS緯度', '開始GPS経度', '開始GPS有効',
]

function makeRow(eventName: string): string[] {
  return ['2026/03/07 8:00:00', '2026/03/07 8:30:00', '01', eventName, '30', '5', '東京都', '千葉市', '35412345', '139412345', '1']
}

function makeGroup(rows: string[][]): CrewGroup {
  return { label: '1番乗務員', crewRole: '1', driverName: '太郎', driverCd: 'D001', officeName: '東京営業所', vehicleName: 'トラックA', rows }
}

function createWrapper(group: CrewGroup) {
  return mount(EventCrewPanel, {
    props: { group, headers },
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('EventCrewPanel', () => {
  it('renders group info', () => {
    const wrapper = createWrapper(makeGroup([makeRow('休憩')]))
    expect(wrapper.text()).toContain('東京営業所')
    expect(wrapper.text()).toContain('トラックA')
    expect(wrapper.text()).toContain('D001 太郎')
  })

  it('shows event/drive counts', () => {
    const wrapper = createWrapper(makeGroup([makeRow('休憩'), makeRow('一般道空車'), makeRow('積み')]))
    expect(wrapper.text()).toContain('イベント (2)')
    expect(wrapper.text()).toContain('走行 (1)')
  })

  it('filters to drive events on toggle', async () => {
    const wrapper = createWrapper(makeGroup([makeRow('休憩'), makeRow('一般道空車')]))
    // Default: non-drive
    expect(wrapper.findAll('tbody tr').length).toBe(1)
    // Toggle to drive
    const toggleButtons = wrapper.findAll('div.ml-auto button')
    await toggleButtons[1]!.trigger('click')
    await nextTick()
    expect(wrapper.findAll('tbody tr').length).toBe(1)
  })

  it('toggles back to event mode', async () => {
    const wrapper = createWrapper(makeGroup([makeRow('休憩'), makeRow('一般道空車')]))
    const toggleButtons = wrapper.findAll('div.ml-auto button')
    await toggleButtons[1]!.trigger('click')
    await nextTick()
    await toggleButtons[0]!.trigger('click')
    await nextTick()
    expect(wrapper.findAll('tbody tr').length).toBe(1)
  })

  it('renders table with formatted cells', () => {
    const wrapper = createWrapper(makeGroup([makeRow('休憩')]))
    expect(wrapper.find('table').exists()).toBe(true)
    expect(wrapper.text()).toContain('30分')
  })

  it('shows empty message when all filtered out', () => {
    const wrapper = createWrapper(makeGroup([makeRow('一般道空車')]))
    expect(wrapper.text()).toContain('データがありません')
  })

  it('renders location cell with GPS button', () => {
    const wrapper = createWrapper(makeGroup([makeRow('休憩')]))
    expect(wrapper.find('button.text-blue-500').exists()).toBe(true)
  })

  it('handles row shorter than headers (undefined cell value)', () => {
    // Row with fewer elements than headers → row[col.index] is undefined → ?? '' fallback
    const shortRow = ['2026/03/07 8:00:00', '2026/03/07 8:30:00', '01', '休憩']
    const wrapper = createWrapper(makeGroup([shortRow]))
    expect(wrapper.find('table').exists()).toBe(true)
  })

  it('applies event row styling', () => {
    const wrapper = createWrapper(makeGroup([makeRow('積み')]))
    const row = wrapper.find('tbody tr')
    expect(row.classes().join(' ')).toContain('bg-green')
  })
})
