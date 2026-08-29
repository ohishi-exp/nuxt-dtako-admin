/**
 * `/daily-hours` の**乗務員プルダウンの取得失敗**を「0 人」と同じ見た目に
 * しないか (Refs #920)。
 *
 * 直す前は `getDrivers().then(d => drivers.value = d).catch(() => {})` で、
 * **例外オブジェクトを束縛すらしていない**ので理由は 100% 失われていた。
 * 残るのは空のプルダウンだけ ⇒ 人は「乗務員が居ない」と読む。
 *
 * **逆方向も同じだけ大事**で、失敗の文言だけ足すと**本当に 0 人の回**まで異常に
 * 見える。ここでは両方向を測る。**カバレッジ目的では増やさない** — この画面の表の
 * 組み立てや月ゲートは別の担当。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { Driver } from '~/types'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: {
    getDailyHours: vi.fn(),
    getWorkTimes: vi.fn(),
    getDrivers: vi.fn(),
  },
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDailyHours: api.getDailyHours,
  getWorkTimes: api.getWorkTimes,
  getDrivers: api.getDrivers,
}))

import Page from '~/pages/daily-hours/index.vue'

function driver(id: string, name: string): Driver {
  return { id, tenant_id: 't1', driver_cd: id, driver_name: name }
}

const DriverSearchSelectStub = {
  name: 'DriverSearchSelect',
  props: ['modelValue', 'drivers'],
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

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getDailyHours.mockResolvedValue({ items: [], total: 0, page: 1, per_page: 50 })
  api.getWorkTimes.mockResolvedValue({ items: [], total: 0, page: 1, per_page: 50 })
  api.getDrivers.mockResolvedValue([driver('d1', '山田 太郎')])
})

describe('/daily-hours 乗務員一覧の取得', () => {
  it('取得できたら選択肢に渡す (陽性対照)', async () => {
    const w = await mountPage()

    expect(w.find('.driver-count').text()).toBe('1')
    expect(alertTitles(w)).toHaveLength(0)
  })

  describe('★ 「取得に失敗した」と「本当に 0 人」を別の文にする (Refs #920)', () => {
    it('失敗したら理由を出す', async () => {
      api.getDrivers.mockRejectedValue(new Error('API エラー (503): DB に繋がりません'))
      const w = await mountPage()

      // ★ **理由のうしろに「次に何をすればいいか」が付く** (Refs #1008)。
      //   status は `createAuthFetch` が組んだ `(503): ` から読む
      //   (この経路の例外は ofetch の `FetchError` ではなく素の `Error`)。
      //   この画面に一覧を取り直すボタンは無いので、案内はページの再読み込み。
      expect(alertTitles(w)).toEqual(['乗務員一覧を取得できませんでした (API エラー (503): DB に繋がりません'
        + ' — サーバ側の設定か障害です (権限の問題ではありません)。復旧してからページを再読み込みしてください)'])
      expect(w.text()).toContain('0 人なのか読めなかっただけなのかは、この画面では判りません')
    })

    it('★ 逆方向: 取得できて 0 人だった回は警告を出さない (異常に見せない)', async () => {
      api.getDrivers.mockResolvedValue([])
      const w = await mountPage()

      expect(w.find('.driver-count').text()).toBe('0')
      expect(alertTitles(w)).toHaveLength(0)
      expect(w.text()).not.toContain('取得できませんでした')
      expect(w.text()).not.toContain('判りません')
    })

    it('Error 以外で失敗しても黙らず、[object Object] も出さない', async () => {
      api.getDrivers.mockRejectedValue({ status: 503 })
      const w = await mountPage()

      expect(alertTitles(w)).toContain('乗務員一覧を取得できませんでした (理由を読めませんでした — ページを再読み込みしてください)')
      expect(w.text()).not.toContain('[object Object]')
    })

    it('★★ 403 で「次の一手」が 2 つ並んで食い違わない / 読めない回でも 0 にならない (#1008 PR-3)', async () => {
      // **注記から次の一手を落とした** (#1008 PR-3)。落とす前は 403 で
      // title「ログインし直しても変わりません。管理者に許可の追加を依頼してください」と
      // description「— ページを再読み込みして確かめてください」が**食い違っていた**
      // (nuxt dev + CDP で実測)。⇒ 次の一手は status を知っている `title` の側だけが持つ。
      //
      // **落とすだけだと 0 になる経路がある** — `describeCaughtError` は status を
      // 読めない回に次の一手を付けないので、`describeListFailure` が補っている。
      // ここでは **403 (食い違わない) と 読めない回 (0 にならない) の両方**を見る。
      api.getDrivers.mockRejectedValue(new Error('API エラー (403): 権限がありません'))
      const w403 = await mountPage()
      const a403 = w403.findAllComponents({ name: 'UAlert' })[0]!
      expect(a403.props('title')).toContain('管理者に許可の追加を依頼してください')
      expect(`${a403.props('title')} ${a403.props('description')}`).not.toContain('再読み込み')
      expect(a403.props('description')).toBe('0 人なのか読めなかっただけなのかは、この画面では判りません')

      api.getDrivers.mockRejectedValue(new Error('status を読めない理由'))
      const wU = await mountPage()
      const aUnknown = wU.findAllComponents({ name: 'UAlert' })[0]!
      // ★ status が読めない回は **title の側に** 次の一手が入る (0 にしない)
      expect(aUnknown.props('title')).toContain('ページを再読み込みしてください')
    })

    it('乗務員一覧が読めなくても表のデータ取得は今までどおり走る', async () => {
      api.getDrivers.mockRejectedValue(new Error('落ちた'))
      await mountPage()

      expect(api.getDailyHours).toHaveBeenCalledTimes(1)
      expect(api.getWorkTimes).toHaveBeenCalledTimes(1)
    })
  })
})
