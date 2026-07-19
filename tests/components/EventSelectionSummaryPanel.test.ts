import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EventSelectionSummaryPanel from '~/components/EventSelectionSummaryPanel.vue'
import type { SelectedRowsSummary } from '~/utils/event-data-table'
import { UIconStub } from '../helpers/stubs'

function makeSummary(overrides: Partial<SelectedRowsSummary> = {}): SelectedRowsSummary {
  return {
    distanceKm: 12.5,
    durationMin: 95,
    byCategory: { drive: 60, loading: 10, unloading: 15, rest: 0, idle: 10, other: 0 },
    rowCount: 4,
    ...overrides,
  }
}

function createWrapper(summary: SelectedRowsSummary) {
  return mount(EventSelectionSummaryPanel, {
    props: { summary },
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('EventSelectionSummaryPanel', () => {
  it('距離・時間の合計を表示する', () => {
    const wrapper = createWrapper(makeSummary())
    expect(wrapper.text()).toContain('12.5 km')
    expect(wrapper.text()).toContain('1時間35分')
  })

  it('選択行数を表示する', () => {
    const wrapper = createWrapper(makeSummary({ rowCount: 4 }))
    expect(wrapper.text()).toContain('4行')
  })

  it('0 でない区分のみ内訳に表示する', () => {
    const wrapper = createWrapper(makeSummary())
    expect(wrapper.text()).toContain('運転')
    expect(wrapper.text()).toContain('積み')
    expect(wrapper.text()).toContain('降し')
    expect(wrapper.text()).toContain('アイドリング')
    expect(wrapper.text()).not.toContain('休憩・休息')
    expect(wrapper.text()).not.toContain('その他')
  })

  it('全区分 0 なら内訳セクション自体を表示しない', () => {
    const wrapper = createWrapper(makeSummary({
      byCategory: { drive: 0, loading: 0, unloading: 0, rest: 0, idle: 0, other: 0 },
    }))
    expect(wrapper.text()).not.toContain('時間内訳')
  })

  it('閉じるボタンで close を emit する', async () => {
    const wrapper = createWrapper(makeSummary())
    await wrapper.find('button').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
