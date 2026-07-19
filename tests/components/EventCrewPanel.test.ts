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

  describe('行選択 → 速度カラー Map 用の selectedRange emit', () => {
    it('行クリックで選択され、開始日時/終了日時から算出した range を emit する', async () => {
      const wrapper = createWrapper(makeGroup([makeRow('休憩')]))
      await wrapper.find('tbody tr').trigger('click')
      const emitted = wrapper.emitted('update:selectedRange')
      expect(emitted).toBeTruthy()
      const last = emitted![emitted!.length - 1]![0] as { fromTs: number, toTs: number } | null
      expect(last).toEqual({
        fromTs: Date.UTC(2026, 2, 7, 8, 0, 0) / 1000,
        toTs: Date.UTC(2026, 2, 7, 8, 30, 0) / 1000,
      })
      expect(wrapper.text()).toContain('1行選択中')
    })

    it('選択済みの行を再クリックすると解除され null を emit する', async () => {
      const wrapper = createWrapper(makeGroup([makeRow('休憩')]))
      const row = wrapper.find('tbody tr')
      await row.trigger('click')
      await row.trigger('click')
      const emitted = wrapper.emitted('update:selectedRange')!
      expect(emitted[emitted.length - 1]![0]).toBeNull()
      expect(wrapper.text()).not.toContain('行選択中')
    })

    it('チェックボックスの直接クリックでも選択できる', async () => {
      const wrapper = createWrapper(makeGroup([makeRow('休憩')]))
      await wrapper.find('input[type="checkbox"]').trigger('click')
      expect(wrapper.text()).toContain('1行選択中')
    })

    it('チェックボックス列のセル (input 以外の余白部分) クリックでも選択できる', async () => {
      const wrapper = createWrapper(makeGroup([makeRow('休憩')]))
      await wrapper.find('tbody td').trigger('click')
      expect(wrapper.text()).toContain('1行選択中')
    })

    it('複数行選択すると開始日時の最小・終了日時の最大が range になる', async () => {
      const rows = [
        ['2026/03/07 09:00:00', '2026/03/07 09:30:00', '01', '休憩'],
        ['2026/03/07 08:00:00', '2026/03/07 08:10:00', '01', '休憩'],
      ]
      const wrapper = createWrapper(makeGroup(rows))
      const trs = wrapper.findAll('tbody tr')
      await trs[0]!.trigger('click')
      await trs[1]!.trigger('click')
      const emitted = wrapper.emitted('update:selectedRange')!
      const last = emitted[emitted.length - 1]![0] as { fromTs: number, toTs: number }
      expect(last).toEqual({
        fromTs: Date.UTC(2026, 2, 7, 8, 0, 0) / 1000,
        toTs: Date.UTC(2026, 2, 7, 9, 30, 0) / 1000,
      })
      expect(wrapper.text()).toContain('2行選択中')
    })

    it('「選択解除」ボタンで選択をクリアし null を emit する', async () => {
      const wrapper = createWrapper(makeGroup([makeRow('休憩')]))
      await wrapper.find('tbody tr').trigger('click')
      expect(wrapper.text()).toContain('1行選択中')
      await wrapper.find('button.text-blue-600').trigger('click')
      expect(wrapper.text()).not.toContain('行選択中')
      const emitted = wrapper.emitted('update:selectedRange')!
      expect(emitted[emitted.length - 1]![0]).toBeNull()
    })

    it('乗務員 (group) が切り替わると選択がクリアされる', async () => {
      const group1 = makeGroup([makeRow('休憩')])
      const wrapper = createWrapper(group1)
      await wrapper.find('tbody tr').trigger('click')
      expect(wrapper.text()).toContain('1行選択中')

      const group2 = { ...makeGroup([makeRow('積み')]), crewRole: '2' }
      await wrapper.setProps({ group: group2 })
      await nextTick()
      expect(wrapper.text()).not.toContain('行選択中')
    })

    it('走行/イベント表示切替でも選択がクリアされる', async () => {
      const wrapper = createWrapper(makeGroup([makeRow('休憩'), makeRow('一般道空車')]))
      await wrapper.find('tbody tr').trigger('click')
      expect(wrapper.text()).toContain('1行選択中')

      const toggleButtons = wrapper.findAll('div.ml-auto button')
      await toggleButtons[1]!.trigger('click')
      await nextTick()
      expect(wrapper.text()).not.toContain('行選択中')
    })
  })
})
