/**
 * `/operations` の「乗務員未登録のまま走った運行」の警告帯 (Refs ippoan/alc-app#676)。
 *
 * 拾い方 (乗務員CD=0・10km 以上・直近 30 日・出庫/帰庫) は `app/utils/driver0-alert.ts` (100% gate) 側。
 * ここで測るのは画面の**配線**だけ: 該当があれば件数の帯と一覧が出る / 0 件なら出ない /
 * 確かめられなかった回は 0 件と別の表示になる。値は架空。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: {
    getOperations: vi.fn(),
    getOperation: vi.fn(),
    getDrivers: vi.fn(),
    getVehicles: vi.fn(),
  },
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  ...api,
}))

mockNuxtImport('useRouter', () => () => ({ push: vi.fn() }))

import Page from '~/pages/operations/index.vue'

/** 本物の UAlert は説明を `#description` slot で受ける。stub でも slot を描く。 */
const UAlertStub = {
  name: 'UAlert',
  props: ['title', 'description', 'color'],
  template: '<div class="alert">{{ title }} {{ description }}<slot name="description" /></div>',
}

async function mountPage() {
  const w = mount(Page, {
    global: {
      stubs: {
        ...NUXT_UI_PAGE_STUBS,
        UAlert: UAlertStub,
        DriverSearchSelect: { name: 'DriverSearchSelect', template: '<div />' },
      },
    },
  })
  await flushPromises()
  return w
}

function titles(w: ReturnType<typeof mount>) {
  return w.findAllComponents({ name: 'UAlert' }).map(a => a.props('title') as string)
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getDrivers.mockResolvedValue([])
  api.getVehicles.mockResolvedValue([])
  api.getOperation.mockResolvedValue([{ garage_out_at: '2026-11-26T07:00:00Z', garage_in_at: '2026-11-26T18:30:00Z' }])
})

describe('/operations 乗務員未登録の警告帯 (Refs ippoan/alc-app#676)', () => {
  it('★ 乗務員CD=0 で 10km 以上の運行があれば件数の帯と一覧 (運行NO→詳細・出庫・帰庫・距離) を出す', async () => {
    api.getOperations.mockImplementation(async (f: { driver_cd?: string }) =>
      f.driver_cd === '0'
        ? { operations: [{ unko_no: 'U1', vehicle_name: 'テスト1号', total_distance: 52.3 }, { unko_no: 'U2', vehicle_name: 'x', total_distance: 0.1 }], total: 2 }
        : { operations: [], total: 0 })
    const w = await mountPage()

    expect(titles(w)).toContain('乗務員未登録のまま走った運行が 1 件 (直近 30 日、10km 以上)')
    const text = w.text()
    expect(text).toContain('テスト1号')
    expect(text).toContain('2026/11/26 07:00')
    expect(text).toContain('2026/11/26 18:30')
    expect(text).toContain('52.3 km')
    expect(w.find('a[href="/operations/U1"]').exists()).toBe(true)
    expect(api.getOperation).toHaveBeenCalledWith('U1')
  })

  it('★ 逆方向: 該当が無ければ帯を出さない', async () => {
    api.getOperations.mockResolvedValue({ operations: [], total: 0 })
    const w = await mountPage()

    expect(titles(w).some(t => t.includes('乗務員未登録'))).toBe(false)
  })

  it('★ 確かめられなかった回は 0 件と別の表示にする', async () => {
    api.getOperations.mockImplementation(async (f: { driver_cd?: string }) => {
      if (f.driver_cd === '0') throw new Error('API エラー (503): DB に繋がりません')
      return { operations: [], total: 0 }
    })
    const w = await mountPage()

    const t = titles(w)
    expect(t.some(x => x.startsWith('乗務員未登録の運行を確かめられませんでした'))).toBe(true)
    expect(w.text()).toContain('警告の帯が出ていないのは 0 件を意味しません')
  })
})
