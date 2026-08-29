/**
 * `/operations` の**運行一覧そのものの取得失敗**が画面に出るか (Refs #1008)。
 *
 * 直す前の `fetchData()` の catch は **`console.error` 1 行だけ**で、ref にも
 * template にも何も置いていなかった。結果、失敗しても画面は `loading` が終わって
 * 表が `v-else-if="operations.length === 0"` の枝に入り、**無言で
 * 「データがありません」**と出るだけ ⇒ **「取得に失敗した」と「本当に 0 件」が
 * 人には区別できない。**
 *
 * ## ★ 測るのは「別の表示になる」こと — 片方だけでは退化を捕まえられない
 *
 * 「失敗したら理由が出る」だけを測ると、**失敗時に「データがありません」も一緒に
 * 出続ける**退化に戻っても緑のままになる。だから **成功して 0 件の回**と
 * **失敗した回**の画面テキストを両方採り、**同じ文字列にならない**ことを直接固定する。
 * 表の枝はどちらの回も同じなので、**差を作っているのは足した `UAlert` だけ**。
 *
 * 絞り込み選択肢の取得失敗 (Refs #920) は `operations-page-filter-load.test.ts`、
 * 分割 (`splitAll`) は `operations-page-split.test.ts` の担当。
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

/** 足した `UAlert` の `description` (**次の一手を持たない**ことを測るため)。 */
function alertDescriptions(w: VueWrapper) {
  return w.findAllComponents({ name: 'UAlert' }).map(a => a.props('description'))
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getOperations.mockResolvedValue({ operations: [], total: 0, page: 1, per_page: 50 })
  api.getDrivers.mockResolvedValue([driver('D1', '山田 太郎')])
  api.getVehicles.mockResolvedValue([vehicle('V1', '1号車')])
})

describe('/operations 運行一覧の取得失敗 (Refs #1008)', () => {
  it('取得できたら警告を出さない (陽性対照)', async () => {
    const w = await mountPage()

    expect(alertTitles(w)).toHaveLength(0)
    expect(w.text()).not.toContain('取得できませんでした')
  })

  describe('★ 「取得に失敗した」と「本当に 0 件」を別の表示にする', () => {
    it('失敗したら理由と「次に何をすればいいか」を出す', async () => {
      api.getOperations.mockRejectedValue(new Error('API エラー (503): DB に繋がりません'))
      const w = await mountPage()

      expect(alertTitles(w)).toEqual(['運行一覧を取得できませんでした (API エラー (503): DB に繋がりません'
        + ' — サーバ側の設定か障害です (権限の問題ではありません)。復旧してからページを再読み込みしてください)'])
      expect(w.text()).toContain('下の表の「データがありません」は 0 件を意味しません')
      // ★ 503 は次の一手が「復旧してから再読み込み」なので title 側にだけ在る。
      expect(alertDescriptions(w)).toEqual(['下の表の「データがありません」は 0 件を意味しません'])
    })

    it('★ 逆方向: 取得できて 0 件だった回は警告を出さない (異常に見せない)', async () => {
      const w = await mountPage()

      expect(w.text()).toContain('データがありません')
      expect(alertTitles(w)).toHaveLength(0)
      expect(w.text()).not.toContain('0 件を意味しません')
    })

    it('★★ 失敗した回と 0 件の回で画面が違う (退化したら落ちる)', async () => {
      const ok = (await mountPage()).text()

      api.getOperations.mockRejectedValue(new Error('API エラー (500): 落ちた'))
      const ng = (await mountPage()).text()

      // 表の枝はどちらも同じ (「データがありません」) — **差を作るのは足した警告だけ**。
      expect(ok).toContain('データがありません')
      expect(ng).toContain('データがありません')
      expect(ng).not.toBe(ok)
      expect(ng).toContain('取得できませんでした')
      expect(ok).not.toContain('取得できませんでした')
    })

    it('★★ 403 で「次の一手」が 2 つ並んで食い違わない (dev で実測した欠陥の再現)', async () => {
      // 初稿の `description` は末尾が「— ページを再読み込みして確かめてください」だった。
      // 403 の `title` は **「ログインし直しても変わりません」「管理者に許可の追加を
      // 依頼してください」** なので、**title が効かないと言った手を description が
      // 勧める**形になっていた (nuxt dev + CDP で 403 を撃って実測)。
      // ⇒ **次の一手は status を知っている `title` の側だけが持つ。**
      api.getOperations.mockRejectedValue(new Error('API エラー (403): 権限がありません'))
      const w = await mountPage()

      const alert = w.findAllComponents({ name: 'UAlert' })[0]!
      expect(alert.props('title')).toContain('管理者に許可の追加を依頼してください')
      expect(alert.props('title')).toContain('ログインし直しても変わりません')
      // ★ 同じ箱の中に「再読み込み」を勧める文が無い (title も description も)
      expect(alert.props('description')).not.toContain('再読み込み')
      expect(`${alert.props('title')} ${alert.props('description')}`).not.toContain('再読み込み')
      // 区別のための事実そのものは残っている
      expect(alert.props('description')).toBe('下の表の「データがありません」は 0 件を意味しません')
    })

    it('Error 以外で失敗しても黙らず、[object Object] も出さない', async () => {
      api.getOperations.mockRejectedValue({ status: 503 })
      const w = await mountPage()

      expect(alertTitles(w)).toContain('運行一覧を取得できませんでした (理由を読めませんでした — ページを再読み込みしてください)')
      expect(w.text()).not.toContain('[object Object]')
    })

    it('取り直して成功したら消える (前回の失敗を残さない)', async () => {
      api.getOperations.mockRejectedValueOnce(new Error('API エラー (503): 落ちた'))
      const w = await mountPage()
      expect(alertTitles(w)).toHaveLength(1)

      // 開始日を変えると `watch` が `fetchData` を走らせ直す (2 回目は成功する mock)。
      await w.find('input[type="date"]').setValue('2026-01-01')
      await flushPromises()

      expect(alertTitles(w)).toHaveLength(0)
    })

    it('絞り込み選択肢の失敗とは別の文で出る (どれが落ちたか消さない)', async () => {
      api.getDrivers.mockRejectedValue(new Error('乗務員が落ちた'))
      api.getVehicles.mockRejectedValue(new Error('車両が落ちた'))
      api.getOperations.mockRejectedValue(new Error('表が落ちた'))
      const w = await mountPage()

      expect(alertTitles(w)).toEqual([
        '乗務員一覧を取得できませんでした (乗務員が落ちた — ページを再読み込みしてください)',
        '車両一覧を取得できませんでした (車両が落ちた — ページを再読み込みしてください)',
        '運行一覧を取得できませんでした (表が落ちた — ページを再読み込みしてください)',
      ])
    })
  })
})
