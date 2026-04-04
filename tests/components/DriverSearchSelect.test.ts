import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DriverSearchSelect from '~/components/DriverSearchSelect.vue'

import { UIconStub } from '../helpers/stubs'

const drivers = [
  { id: '1', driver_cd: 'D001', driver_name: '山田太郎' },
  { id: '2', driver_cd: 'D002', driver_name: '佐藤花子' },
  { id: '3', driver_cd: 'D003', driver_name: '田中一郎' },
]

function createWrapper(propsOverrides = {}) {
  return mount(DriverSearchSelect, {
    props: {
      drivers,
      modelValue: '',
      ...propsOverrides,
    },
    global: { stubs: { UIcon: UIconStub } },
  })
}

describe('DriverSearchSelect', () => {
  it('shows placeholder when no value', () => {
    const wrapper = createWrapper()
    const input = wrapper.find('input')
    expect(input.attributes('placeholder')).toBe('すべて')
  })

  it('shows custom placeholder', () => {
    const wrapper = createWrapper({ placeholder: '選択してください' })
    expect(wrapper.find('input').attributes('placeholder')).toBe('選択してください')
  })

  it('filters drivers by name', async () => {
    const wrapper = createWrapper()
    const input = wrapper.find('input')
    await input.trigger('focus')
    await input.setValue('山田')
    await nextTick()
    const dropdownButtons = wrapper.findAll('div[class*="absolute z-10"] button')
    expect(dropdownButtons.length).toBe(1)
    expect(dropdownButtons[0]!.text()).toContain('山田太郎')
  })

  it('filters drivers by driver_cd', async () => {
    const wrapper = createWrapper()
    const input = wrapper.find('input')
    await input.trigger('focus')
    await nextTick()
    // Confirm dropdown is open with all drivers
    expect(wrapper.findAll('div.absolute button').length).toBe(3)
    await input.setValue('D002')
    await nextTick()
    const dropdownButtons = wrapper.findAll('div.absolute button')
    expect(dropdownButtons.length).toBe(1)
    expect(dropdownButtons[0]!.text()).toContain('佐藤花子')
  })

  it('shows all drivers when search is empty', async () => {
    const wrapper = createWrapper()
    const input = wrapper.find('input')
    await input.trigger('focus')
    await nextTick()
    const dropdownButtons = wrapper.findAll('div[class*="absolute z-10"] button')
    expect(dropdownButtons.length).toBe(3)
  })

  it('shows empty message when no match', async () => {
    const wrapper = createWrapper()
    const input = wrapper.find('input')
    await input.trigger('focus')
    await input.setValue('存在しない')
    await nextTick()
    expect(wrapper.text()).toContain('該当なし')
  })

  it('emits update:modelValue on selectDriver', async () => {
    const wrapper = createWrapper()
    const input = wrapper.find('input')
    await input.trigger('focus')
    await nextTick()
    const firstButton = wrapper.findAll('div[class*="absolute z-10"] button')[0]!
    await firstButton.trigger('mousedown')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['1'])
  })

  it('uses driver_cd as value when valueKey=driver_cd', async () => {
    const wrapper = createWrapper({ valueKey: 'driver_cd' })
    const input = wrapper.find('input')
    await input.trigger('focus')
    await nextTick()
    const firstButton = wrapper.findAll('div[class*="absolute z-10"] button')[0]!
    await firstButton.trigger('mousedown')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['D001'])
  })

  it('shows clear button when modelValue is set', () => {
    const wrapper = createWrapper({ modelValue: '1' })
    const clearButton = wrapper.find('div.relative > button')
    expect(clearButton.exists()).toBe(true)
  })

  it('clears value on clear button click', async () => {
    const wrapper = createWrapper({ modelValue: '1' })
    const clearButton = wrapper.find('div.relative > button')
    await clearButton.trigger('click')
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual([''])
  })

  it('syncs search text from modelValue watcher', async () => {
    const wrapper = createWrapper({ modelValue: '2' })
    await nextTick()
    const input = wrapper.find('input')
    expect((input.element as HTMLInputElement).value).toBe('佐藤花子')
  })

  it('does not update search when modelValue changes to unknown id', async () => {
    const wrapper = createWrapper({ modelValue: '1' })
    await nextTick()
    await wrapper.setProps({ modelValue: 'unknown-id' })
    await nextTick()
    // No matching driver, search stays as-is (find returns undefined)
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('山田太郎')
  })

  it('clears search text when modelValue is cleared', async () => {
    const wrapper = createWrapper({ modelValue: '1' })
    await nextTick()
    await wrapper.setProps({ modelValue: '' })
    await nextTick()
    const input = wrapper.find('input')
    expect((input.element as HTMLInputElement).value).toBe('')
  })

  it('syncs search when drivers load after modelValue', async () => {
    const wrapper = mount(DriverSearchSelect, {
      props: { drivers: [], modelValue: '1' },
      global: { stubs: { UIcon: UIconStub } },
    })
    await nextTick()
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('')
    await wrapper.setProps({ drivers })
    await nextTick()
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('山田太郎')
  })

  it('does not update search when drivers change but modelValue is empty', async () => {
    const wrapper = mount(DriverSearchSelect, {
      props: { drivers: [], modelValue: '' },
      global: { stubs: { UIcon: UIconStub } },
    })
    await nextTick()
    await wrapper.setProps({ drivers })
    await nextTick()
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('')
  })

  it('does not update search when drivers change but modelValue not found', async () => {
    const wrapper = mount(DriverSearchSelect, {
      props: { drivers: [], modelValue: 'nonexistent' },
      global: { stubs: { UIcon: UIconStub } },
    })
    await nextTick()
    await wrapper.setProps({ drivers })
    await nextTick()
    // modelValue 'nonexistent' doesn't match any driver id, so search stays empty
    expect((wrapper.find('input').element as HTMLInputElement).value).toBe('')
  })

  it('closes dropdown on blur', async () => {
    vi.useFakeTimers()
    const wrapper = createWrapper()
    const input = wrapper.find('input')
    await input.trigger('focus')
    await nextTick()
    expect(wrapper.find('div[class*="absolute z-10"]').exists()).toBe(true)
    await input.trigger('blur')
    vi.advanceTimersByTime(200)
    await nextTick()
    expect(wrapper.find('div[class*="absolute z-10"]').exists()).toBe(false)
    vi.useRealTimers()
  })

  it('applies custom width class', () => {
    const wrapper = createWrapper({ width: 'w-64' })
    const input = wrapper.find('input')
    expect(input.classes()).toContain('w-64')
  })
})
