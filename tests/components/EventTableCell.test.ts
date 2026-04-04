import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EventTableCell from '~/components/EventTableCell.vue'
import { UIconStub } from '../helpers/stubs'

const gpsHeaders = ['開始市町村名', '開始GPS緯度', '開始GPS経度', '開始GPS有効']

function createWrapper(props: { headers: string[]; row: string[]; header: string; value: string }) {
  return mount(EventTableCell, {
    props,
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('EventTableCell', () => {
  it('renders EventLocationCell for location column', () => {
    const wrapper = createWrapper({
      headers: gpsHeaders,
      row: ['東京都', '35412345', '139412345', '1'],
      header: '開始市町村名',
      value: '東京都',
    })
    // GPS button should render
    expect(wrapper.find('button').exists()).toBe(true)
  })

  it('renders EventCell for non-location column', () => {
    const wrapper = createWrapper({
      headers: ['イベント名'],
      row: ['休憩'],
      header: 'イベント名',
      value: '休憩',
    })
    // Plain span
    expect(wrapper.find('span').exists()).toBe(true)
    expect(wrapper.find('button').exists()).toBe(false)
  })
})
