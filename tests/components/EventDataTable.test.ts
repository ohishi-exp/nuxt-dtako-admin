import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import EventDataTable from '~/components/EventDataTable.vue'
import type { CsvJsonResponse } from '~/types'

import { UIconStub } from '../helpers/stubs'

// Mock window.open for GPS link tests
const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

const fullHeaders = [
  '開始日時', '終了日時', 'イベントCD', 'イベント名', '区間時間', '区間距離',
  '開始市町村名', '終了市町村名', '対象乗務員区分', '乗務員名１', '乗務員CD1',
  '事業所名', '車輌名', '開始GPS緯度', '開始GPS経度', '開始GPS有効',
  '終了GPS緯度', '終了GPS経度', '終了GPS有効',
]

function makeRow(overrides: Partial<Record<string, string>> = {}): string[] {
  const defaults: Record<string, string> = {
    '開始日時': '2026/03/07 8:00:00',
    '終了日時': '2026/03/07 8:30:00',
    'イベントCD': '01',
    'イベント名': '休憩',
    '区間時間': '30',
    '区間距離': '0',
    '開始市町村名': '東京都',
    '終了市町村名': '千葉市',
    '対象乗務員区分': '1',
    '乗務員名１': '山田太郎',
    '乗務員CD1': 'D001',
    '事業所名': '東京営業所',
    '車輌名': 'トラックA',
    '開始GPS緯度': '35412345',
    '開始GPS経度': '139412345',
    '開始GPS有効': '1',
    '終了GPS緯度': '34412345',
    '終了GPS経度': '135412345',
    '終了GPS有効': '1',
  }
  const merged = { ...defaults, ...overrides }
  return fullHeaders.map(h => merged[h] ?? '')
}

function createWrapper(data: CsvJsonResponse, loading = false) {
  return mount(EventDataTable, {
    props: { data, loading },
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('EventDataTable', () => {
  afterEach(() => {
    windowOpenSpy.mockClear()
  })

  it('shows loading spinner', () => {
    const wrapper = createWrapper({ headers: [], rows: [] }, true)
    expect(wrapper.text()).toContain('読み込み中')
  })

  it('shows empty message when no data', () => {
    const wrapper = createWrapper({ headers: [], rows: [] })
    expect(wrapper.text()).toContain('データがありません')
  })

  it('renders table with data', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow()],
    })
    expect(wrapper.find('table').exists()).toBe(true)
    expect(wrapper.text()).toContain('山田太郎')
    expect(wrapper.text()).toContain('東京営業所')
  })

  it('shows crew tabs for multiple crew roles', () => {
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
        makeRow({ '対象乗務員区分': '1', '乗務員名１': '太郎', '乗務員CD1': 'D001' }),
        makeRow({ '対象乗務員区分': '2', '乗務員名１': '花子', '乗務員CD1': 'D002' }),
      ],
    })
    // Initially shows crew 1
    expect(wrapper.text()).toContain('D001 太郎')
    // Click crew 2 tab
    const tabs = wrapper.findAll('div.border-b button')
    await tabs[1]!.trigger('click')
    await nextTick()
    expect(wrapper.text()).toContain('D002 花子')
  })

  it('filters drive events (toggle)', async () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [
        makeRow({ 'イベント名': '休憩' }),
        makeRow({ 'イベント名': '一般道空車' }),
        makeRow({ 'イベント名': '積み' }),
      ],
    })
    // Default: non-drive events only (休憩, 積み)
    const rows = wrapper.findAll('tbody tr')
    expect(rows.length).toBe(2) // 休憩 + 積み

    // Toggle to drive events
    const toggleButtons = wrapper.findAll('div.ml-auto button')
    await toggleButtons[1]!.trigger('click') // "走行" button
    await nextTick()
    const driveRows = wrapper.findAll('tbody tr')
    expect(driveRows.length).toBe(1) // 一般道空車
  })

  it('toggles back to event mode from drive mode', async () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [
        makeRow({ 'イベント名': '休憩' }),
        makeRow({ 'イベント名': '一般道空車' }),
      ],
    })
    const toggleButtons = wrapper.findAll('div.ml-auto button')
    // Switch to drive
    await toggleButtons[1]!.trigger('click')
    await nextTick()
    expect(wrapper.findAll('tbody tr').length).toBe(1) // only drive
    // Switch back to events
    await toggleButtons[0]!.trigger('click')
    await nextTick()
    expect(wrapper.findAll('tbody tr').length).toBe(1) // only non-drive
  })

  it('shows event/drive counts', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [
        makeRow({ 'イベント名': '休憩' }),
        makeRow({ 'イベント名': '一般道空車' }),
        makeRow({ 'イベント名': '積み' }),
      ],
    })
    expect(wrapper.text()).toContain('イベント (2)')
    expect(wrapper.text()).toContain('走行 (1)')
  })

  it('opens Google Maps on location click', async () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow()],
    })
    // Find a clickable location button
    const locationButton = wrapper.find('button.text-blue-500')
    expect(locationButton.exists()).toBe(true)
    await locationButton.trigger('click')
    expect(windowOpenSpy).toHaveBeenCalledTimes(1)
    const url = windowOpenSpy.mock.calls[0]![0] as string
    expect(url).toContain('google.com/maps')
  })

  it('does not open map when GPS is invalid', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ '開始GPS有効': '0', '終了GPS有効': '0' })],
    })
    // No clickable location buttons should exist
    expect(wrapper.find('button.text-blue-500').exists()).toBe(false)
  })

  it('shows empty rows message when all filtered out', async () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ 'イベント名': '一般道空車' })],
    })
    // Default: non-drive events → all filtered out
    expect(wrapper.text()).toContain('データがありません')
  })

  it('formats cell values in table', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ '区間時間': '90' })],
    })
    expect(wrapper.text()).toContain('1時間30分')
  })

  it('applies event row styling', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ 'イベント名': '積み' })],
    })
    const row = wrapper.find('tbody tr')
    expect(row.classes().join(' ')).toContain('bg-green')
  })

  it('resets active crew when groups change', async () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ '対象乗務員区分': '2' })],
    })
    await nextTick()
    // activeCrewRole auto-adjusts to '2' since '1' doesn't exist
    // Single group → no tab labels, but data should render
    expect(wrapper.text()).toContain('東京営業所')
    expect(wrapper.find('table').exists()).toBe(true)
  })

  it('handles no activeGroup (empty filtered state)', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [],
    })
    expect(wrapper.text()).toContain('データがありません')
  })

  it('renders non-location cells as plain text (v-else branch)', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [makeRow({ 'イベント名': '休憩' })],
    })
    // イベントCD, イベント名 etc. are plain text <span>, not GPS buttons
    const spans = wrapper.findAll('tbody td span')
    expect(spans.length).toBeGreaterThan(0)
  })

  it('renders location with GPS and without GPS in same table', () => {
    const wrapper = createWrapper({
      headers: fullHeaders,
      rows: [
        makeRow({ '開始GPS有効': '1', '終了GPS有効': '1' }),
        makeRow({ '開始GPS有効': '0', '終了GPS有効': '0' }),
      ],
    })
    // First row has GPS buttons, second row has plain spans for location
    const buttons = wrapper.findAll('button.text-blue-500')
    expect(buttons.length).toBeGreaterThan(0)
    // Both rows rendered
    expect(wrapper.findAll('tbody tr').length).toBe(2)
  })

  it('handles no displayColumns (no matching headers)', () => {
    const wrapper = createWrapper({
      headers: ['不要列A', '不要列B'],
      rows: [['a', 'b']],
    })
    // No eventHeaders match → no table rendered, but crewGroups still exist
    expect(wrapper.find('table').exists()).toBe(false)
  })
})
