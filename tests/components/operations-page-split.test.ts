/**
 * `/operations` の「IVT一括分割」が**何も起きなかった回を「処理中」と言わないか**
 * (Refs #917)。
 *
 * このページは既存テスト 0 件。**カバレッジ目的では増やさない**ので、置くのは
 * 変えた 1 行の挙動と、その陽性対照 (何も描かない実装でも緑にならないように) だけ。
 *
 * `splitCsvAllStream` は SSE で、`rust-alc-api` は **DB エラーでも 200 を返す**。
 * `done` も `error` も来ずにストリームが閉じたら**何が起きたか分からない**のに、
 * 直す前のこのページは `'処理中...'` と出していた ⇒ **永久に動いているように読める**。
 *
 * **同じ関数の同じ状況を `app/pages/scraper.vue` は loud に出している** —
 * 「応答が空でした (alc から done イベントが来ていません)」。2 画面が違う意味で
 * 表示していたので、`scraper.vue` の側に揃える。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const splitCsvAllStream = vi.fn()

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getOperations: vi.fn(async () => ({
    operations: [{
      id: '1', unko_no: 'U1', crew_role: 1, reading_date: '2026-07-01',
      operation_date: '2026-07-01', driver_name: '山田', vehicle_name: '1号車',
      total_distance: 100, safety_score: 90, economy_score: 90, total_score: 90,
      has_kudgivt: false,
    }],
    total: 1, page: 1, per_page: 50,
  })),
  getDrivers: vi.fn(async () => []),
  getVehicles: vi.fn(async () => []),
  splitCsvAllStream: (...a: unknown[]) => splitCsvAllStream(...a),
}))

mockNuxtImport('useRouter', () => () => ({ push: vi.fn() }))

import Page from '~/pages/operations/index.vue'

const SPLIT_LABEL = 'IVT一括分割 (1件未分割)'

async function mountPage() {
  const w = mount(Page, {
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, DriverSearchSelect: { template: '<div />' } } },
  })
  await flushPromises()
  return w
}

/** 分割の結果表示 (`v-if="splitResult"` の span)。 */
function splitResult(w: VueWrapper) {
  return w.find('span.text-xs.text-gray-500')
}

async function clickSplit(w: VueWrapper) {
  const btn = w.findAll('button').find(b => b.text() === SPLIT_LABEL)
  expect(btn, `button ${SPLIT_LABEL}`).toBeDefined()
  await btn!.trigger('click')
  await flushPromises()
}

describe('/operations の IVT一括分割', () => {
  beforeEach(() => {
    splitCsvAllStream.mockReset()
  })

  it('★ done も error も来ずに閉じた回を「処理中」と言わない', async () => {
    splitCsvAllStream.mockResolvedValue(undefined)

    const w = await mountPage()
    await clickSplit(w)

    expect(splitResult(w).text()).toBe('応答が空でした (alc から done イベントが来ていません)')
    expect(splitResult(w).text()).not.toContain('処理中')
  })

  it('★ 陽性対照: done が来た回は今までどおり件数を出す', async () => {
    splitCsvAllStream.mockImplementation(async (onProgress: (e: any) => void) => {
      onProgress({ event: 'progress', current: 1, total: 2, filename: 'a.csv' })
      onProgress({ event: 'done', success: 2, total: 2, failed: 0 })
    })

    const w = await mountPage()
    await clickSplit(w)

    expect(splitResult(w).text()).toBe('完了: 2/2 成功')
    expect(splitResult(w).text()).not.toContain('応答が空でした')
  })

})
