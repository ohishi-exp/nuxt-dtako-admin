import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import EventCell from '~/components/EventCell.vue'

describe('EventCell', () => {
  it('formats datetime value', () => {
    const wrapper = mount(EventCell, {
      props: { headers: ['開始日時'], row: ['2026/03/07 8:00:00'], header: '開始日時', value: '2026/03/07 8:00:00' },
    })
    expect(wrapper.text()).toBe('03/07 8:00:00')
  })

  it('applies color class for イベント名', () => {
    const wrapper = mount(EventCell, {
      props: { headers: ['イベント名'], row: ['休息'], header: 'イベント名', value: '休息' },
    })
    expect(wrapper.find('span').classes().join(' ')).toContain('text-purple')
  })

  it('no color class for non-event columns', () => {
    const wrapper = mount(EventCell, {
      props: { headers: ['区間距離'], row: ['15.3'], header: '区間距離', value: '15.3' },
    })
    expect(wrapper.find('span').classes().length).toBe(0)
  })

  it('formats duration', () => {
    const wrapper = mount(EventCell, {
      props: { headers: ['区間時間'], row: ['90'], header: '区間時間', value: '90' },
    })
    expect(wrapper.text()).toBe('1時間30分')
  })
})
