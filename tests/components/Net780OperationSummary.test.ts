import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Net780OperationSummary from '~/components/Net780OperationSummary.vue'

import { UIconStub } from '../helpers/stubs'

/** NuxtLink の to をそのまま href に映すスタブ (リンク先 URL の検証用)。 */
const NuxtLinkStub = { props: ['to'], template: '<a :href="to"><slot /></a>' }

function createWrapper(propsOverrides = {}) {
  return mount(Net780OperationSummary, {
    props: {
      operationNo: '2607030428090000001109',
      ...propsOverrides,
    },
    global: { stubs: { UIcon: UIconStub, NuxtLink: NuxtLinkStub } },
  })
}

describe('Net780OperationSummary', () => {
  beforeEach(() => {
    // 未アーカイブ (404) → notFound 分岐で /net780 検索リンクを表示させる
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
  })

  it('未アーカイブ時の検索リンクは readingDate/vehicleCd/driverCd を引き継ぐ', async () => {
    const wrapper = createWrapper({
      readingDate: '2026-07-04',
      vehicleCd: '1109',
      driverCd: '1412',
    })
    await flushPromises()
    const link = wrapper.find('a')
    // /net780 の NET780 検索は読取日 (ReadNo) 基準のため、運行日ではなく
    // 読取日を渡す (Refs #316)
    expect(link.attributes('href')).toBe('/net780?readingDate=2026-07-04&vehicleCd=1109&driverCd=1412')
  })

  it('CD 不明時はリンクに readingDate だけ付く', async () => {
    const wrapper = createWrapper({ readingDate: '2026-07-04' })
    await flushPromises()
    expect(wrapper.find('a').attributes('href')).toBe('/net780?readingDate=2026-07-04')
  })
})
