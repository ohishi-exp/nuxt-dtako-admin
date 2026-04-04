import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import CsvDataTable from '~/components/CsvDataTable.vue'

import { UIconStub } from '../helpers/stubs'

function createWrapper(props: { headers: string[]; rows: string[][]; loading?: boolean }) {
  return mount(CsvDataTable, {
    props,
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('CsvDataTable', () => {
  it('shows loading spinner when loading=true', () => {
    const wrapper = createWrapper({ headers: ['A'], rows: [], loading: true })
    expect(wrapper.text()).toContain('読み込み中')
  })

  it('shows empty message when headers is empty', () => {
    const wrapper = createWrapper({ headers: [], rows: [] })
    expect(wrapper.text()).toContain('データがありません')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('renders table with headers and rows', () => {
    const wrapper = createWrapper({
      headers: ['名前', '年齢'],
      rows: [['太郎', '30'], ['花子', '25']],
    })
    const ths = wrapper.findAll('th')
    expect(ths.map(th => th.text())).toEqual(['名前', '年齢'])
    const tds = wrapper.findAll('td')
    expect(tds.map(td => td.text())).toEqual(['太郎', '30', '花子', '25'])
  })

  it('shows empty row message when headers exist but rows is empty', () => {
    const wrapper = createWrapper({ headers: ['A', 'B'], rows: [] })
    expect(wrapper.find('table').exists()).toBe(true)
    expect(wrapper.text()).toContain('データがありません')
  })

  it('does not show loading spinner when loading is false', () => {
    const wrapper = createWrapper({ headers: ['A'], rows: [['1']] })
    expect(wrapper.text()).not.toContain('読み込み中')
  })
})
