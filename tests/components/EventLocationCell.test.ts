import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import EventLocationCell from '~/components/EventLocationCell.vue'
import { UIconStub } from '../helpers/stubs'

const windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

const headers = ['開始市町村名', '開始GPS緯度', '開始GPS経度', '開始GPS有効']

function createWrapper(props: { headers: string[]; row: string[]; header: string; value: string }) {
  return mount(EventLocationCell, {
    props,
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('EventLocationCell', () => {
  afterEach(() => {
    windowOpenSpy.mockClear()
  })

  it('renders GPS button when valid GPS data', () => {
    const wrapper = createWrapper({
      headers,
      row: ['東京都', '35412345', '139412345', '1'],
      header: '開始市町村名',
      value: '東京都',
    })
    expect(wrapper.find('button').exists()).toBe(true)
    expect(wrapper.find('button').text()).toContain('東京都')
  })

  it('renders plain span when no GPS data', () => {
    const wrapper = createWrapper({
      headers: ['開始市町村名'],
      row: ['東京都'],
      header: '開始市町村名',
      value: '東京都',
    })
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.find('span').text()).toBe('東京都')
  })

  it('renders plain span when GPS invalid', () => {
    const wrapper = createWrapper({
      headers,
      row: ['東京都', '35412345', '139412345', '0'],
      header: '開始市町村名',
      value: '東京都',
    })
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.find('span').text()).toBe('東京都')
  })

  it('opens Google Maps on click', async () => {
    const wrapper = createWrapper({
      headers,
      row: ['東京都', '35412345', '139412345', '1'],
      header: '開始市町村名',
      value: '東京都',
    })
    await wrapper.find('button').trigger('click')
    expect(windowOpenSpy).toHaveBeenCalledTimes(1)
    const url = windowOpenSpy.mock.calls[0]![0] as string
    expect(url).toContain('google.com/maps')
  })
})
