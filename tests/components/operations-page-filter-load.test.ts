/**
 * `/operations` の**絞り込み選択肢 (乗務員 / 車両) の取得失敗**を、
 * 「0 人 / 0 台」と同じ見た目にしないか (Refs #920)。
 *
 * 直す前はこう書かれていた:
 *
 * ```ts
 * getDrivers().then(d => drivers.value = d).catch(() => {}),
 * getVehicles().then(v => vehicles.value = v).catch(() => {}),
 * ```
 *
 * **例外オブジェクトを束縛すらしていない**ので理由は 100% 失われ、選択肢が空の
 * プルダウンだけが残る ⇒ 人は「この期間には乗務員が居ない / 車両が無い」と読む。
 *
 * **逆方向も同じだけ大事**で、失敗の文言だけ足すと**本当に 0 件の回**まで異常に
 * 見える。ここでは両方向を測る。
 *
 * 分割 (`splitAll`) は `operations-page-split.test.ts` の担当 (Refs #917)。
 * **カバレッジ目的では増やさない** — 置くのは変えた挙動と、その逆方向だけ。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { Driver, Vehicle } from '~/types'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: {
    getOperations: vi.fn(),
    getDrivers: vi.fn(),
    getVehicles: vi.fn(),
    splitCsvAllStream: vi.fn(),
  },
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getOperations: api.getOperations,
  getDrivers: api.getDrivers,
  getVehicles: api.getVehicles,
  splitCsvAllStream: api.splitCsvAllStream,
}))

mockNuxtImport('useRouter', () => () => ({ push: vi.fn() }))

import Page from '~/pages/operations/index.vue'

function driver(cd: string, name: string): Driver {
  return { id: cd, tenant_id: 't1', driver_cd: cd, driver_name: name }
}

function vehicle(cd: string, name: string): Vehicle {
  return { id: cd, tenant_id: 't1', vehicle_cd: cd, vehicle_name: name }
}

/** `DriverSearchSelect` は別コンポーネント (別途 gate 済み) なので stub。 */
const DriverSearchSelectStub = {
  name: 'DriverSearchSelect',
  props: ['modelValue', 'drivers', 'valueKey'],
  template: '<div><span class="driver-count">{{ drivers.length }}</span></div>',
}

async function mountPage() {
  const w = mount(Page, {
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, DriverSearchSelect: DriverSearchSelectStub } },
  })
  await flushPromises()
  return w
}

/** `UAlert` は stub でも `title` / `description` を prop で受けて描く (helpers/stubs.ts)。 */
function alertTitles(w: VueWrapper) {
  return w.findAllComponents({ name: 'UAlert' }).map(a => a.props('title'))
}

/** 車両プルダウンを開いて、中の選択肢の数を数える。 */
async function openVehicleDropdown(w: VueWrapper) {
  await w.find('input[type="text"]').trigger('focus')
  await flushPromises()
  return w.findAll('.absolute.z-10 button')
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getOperations.mockResolvedValue({ operations: [], total: 0, page: 1, per_page: 50 })
  api.getDrivers.mockResolvedValue([driver('D1', '山田 太郎')])
  api.getVehicles.mockResolvedValue([vehicle('V1', '1号車')])
})

describe('/operations 絞り込み選択肢の取得', () => {
  it('取得できたら選択肢に渡す (陽性対照)', async () => {
    const w = await mountPage()

    expect(w.find('.driver-count').text()).toBe('1')
    expect(await openVehicleDropdown(w)).toHaveLength(1)
    expect(alertTitles(w)).toHaveLength(0)
  })

  describe('★ 「取得に失敗した」と「本当に 0 人 / 0 台」を別の文にする (Refs #920)', () => {
    it('乗務員一覧が失敗したら理由を出す', async () => {
      api.getDrivers.mockRejectedValue(new Error('API エラー (503): DB に繋がりません'))
      const w = await mountPage()

      expect(alertTitles(w)).toContain('乗務員一覧を取得できませんでした (API エラー (503): DB に繋がりません)')
      expect(w.text()).toContain('0 人なのか読めなかっただけなのかは、この画面では判りません')
      expect(w.text()).toContain('ページを再読み込みして確かめてください')
    })

    it('車両一覧が失敗したら理由を出す', async () => {
      api.getVehicles.mockRejectedValue(new Error('API エラー (502): upstream が落ちています'))
      const w = await mountPage()

      expect(alertTitles(w)).toContain('車両一覧を取得できませんでした (API エラー (502): upstream が落ちています)')
      expect(w.text()).toContain('0 台なのか読めなかっただけなのかは、この画面では判りません')
    })

    it('★ 逆方向: 取得できて 0 人 / 0 台の回は警告を出さない (異常に見せない)', async () => {
      api.getDrivers.mockResolvedValue([])
      api.getVehicles.mockResolvedValue([])
      const w = await mountPage()

      expect(w.find('.driver-count').text()).toBe('0')
      expect(await openVehicleDropdown(w)).toHaveLength(0)
      expect(alertTitles(w)).toHaveLength(0)
      expect(w.text()).not.toContain('取得できませんでした')
      expect(w.text()).not.toContain('判りません')
    })

    it('★ 片方だけ落ちたら、落ちた方の名前だけを出す (もう片方まで疑わせない)', async () => {
      api.getDrivers.mockRejectedValue(new Error('乗務員が落ちた'))
      const w = await mountPage()

      const titles = alertTitles(w)
      expect(titles).toEqual(['乗務員一覧を取得できませんでした (乗務員が落ちた)'])
      // **落ちていない側は今までどおり読めている** (直列化して巻き込んでいない)
      expect(await openVehicleDropdown(w)).toHaveLength(1)
    })

    it('両方落ちたら 2 本とも出す (どちらが落ちたか消さない)', async () => {
      api.getDrivers.mockRejectedValue(new Error('乗務員が落ちた'))
      api.getVehicles.mockRejectedValue(new Error('車両が落ちた'))
      const w = await mountPage()

      expect(alertTitles(w)).toEqual([
        '乗務員一覧を取得できませんでした (乗務員が落ちた)',
        '車両一覧を取得できませんでした (車両が落ちた)',
      ])
    })

    it('Error 以外で失敗しても黙らず、[object Object] も出さない', async () => {
      api.getVehicles.mockRejectedValue({ status: 503 })
      const w = await mountPage()

      expect(alertTitles(w)).toContain('車両一覧を取得できませんでした (理由を読めませんでした)')
      expect(w.text()).not.toContain('[object Object]')
    })

    it('選択肢が読めなくても運行一覧の取得は今までどおり走る', async () => {
      api.getDrivers.mockRejectedValue(new Error('落ちた'))
      api.getVehicles.mockRejectedValue(new Error('落ちた'))
      await mountPage()

      expect(api.getOperations).toHaveBeenCalledTimes(1)
    })
  })
})
