/**
 * `/daily-hours` の**表そのものの取得失敗**が画面に出るか (Refs #1008)。
 *
 * 直す前の `fetchData()` の catch は **`console.error` 1 行だけ**で、ref にも
 * template にも何も置いていなかった。結果、失敗しても画面は `loading` が終わって
 * 表が `v-else-if="…length === 0"` の枝に入り、**無言で「データがありません」**と
 * 出るだけ ⇒ **「取得に失敗した」と「本当に 0 件」が人には区別できない。**
 *
 * ## ★ 測るのは「別の表示になる」こと — 片方だけでは退化を捕まえられない
 *
 * 「失敗したら理由が出る」だけを測ると、**失敗時に「データがありません」も一緒に
 * 出続ける**退化に戻っても緑のままになる。だから
 *
 * 1. **成功して 0 件の回**の画面テキスト
 * 2. **失敗した回**の画面テキスト
 *
 * を両方採り、**同じ文字列にならない**ことを直接固定する。表の「データがありません」
 * 自体はどちらの回にも出る (v-else-if の枝は同じ) ので、**差を作っているのは
 * 足した `UAlert` だけ** — その `UAlert` を消せばこのテストは落ちる。
 *
 * 乗務員プルダウンの取得失敗 (Refs #920) は `daily-hours-page.test.ts` の担当。
 * **カバレッジ目的では増やさない** — 置くのは変えた挙動と、その逆方向だけ。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import type { Driver } from '~/types'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'
import { RETRY, nextStepCases, expectExactlyOneNextStep } from '../helpers/next-step'

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

/** 足した `UAlert` の `description` (**次の一手を持たない**ことを測るため)。 */
function alertDescriptions(w: VueWrapper) {
  return w.findAllComponents({ name: 'UAlert' }).map(a => a.props('description'))
}

/** `getDailyHours` / `getWorkTimes` の空の応答。 */
const EMPTY = { items: [], total: 0, page: 1, per_page: 50 }

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
  api.getDailyHours.mockResolvedValue(EMPTY)
  api.getWorkTimes.mockResolvedValue(EMPTY)
  api.getDrivers.mockResolvedValue([driver('d1', '山田 太郎')])
})

describe('/daily-hours 表の取得失敗 (Refs #1008)', () => {
  it('取得できたら警告を出さない (陽性対照)', async () => {
    const w = await mountPage()

    expect(alertTitles(w)).toHaveLength(0)
    expect(w.text()).not.toContain('取得できませんでした')
  })

  describe('★ 「取得に失敗した」と「本当に 0 件」を別の表示にする', () => {
    it('失敗したら理由と「次に何をすればいいか」を出す', async () => {
      api.getDailyHours.mockRejectedValue(new Error('API エラー (503): DB に繋がりません'))
      const w = await mountPage()

      // status は `createAuthFetch` が組んだ `(503): ` から読む
      // (この経路の例外は ofetch の `FetchError` ではなく素の `Error`)。
      // この表を取り直すボタンは失敗した回には出ていないので、案内は再読み込み。
      expect(alertTitles(w)).toEqual(['日別労働時間を取得できませんでした (API エラー (503): DB に繋がりません'
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

      api.getDailyHours.mockRejectedValue(new Error('API エラー (500): 落ちた'))
      const ng = (await mountPage()).text()

      // 表の枝はどちらも同じ (「データがありません」) — **差を作るのは足した警告だけ**。
      expect(ok).toContain('データがありません')
      expect(ng).toContain('データがありません')
      expect(ng).not.toBe(ok)
      expect(ng).toContain('取得できませんでした')
      expect(ok).not.toContain('取得できませんでした')
    })

    it('もう一方 (getWorkTimes) が落ちても同じように出る', async () => {
      api.getWorkTimes.mockRejectedValue(new Error('API エラー (502): upstream が落ちています'))
      const w = await mountPage()

      expect(alertTitles(w)).toEqual(['日別労働時間を取得できませんでした (API エラー (502): upstream が落ちています'
        + ' — サーバ側の設定か障害です (権限の問題ではありません)。復旧してからページを再読み込みしてください)'])
    })


    // ★★ **4 経路 × この画面の `UAlert`** で「次の一手はちょうど 1 つ、食い違わない」
    //    (Refs #1008 PR-3)。条件の本体は `tests/helpers/next-step.ts`。
    //    **403 だけを見ると `0` になる壊れ方 (③④) を取り逃す。**
    it.each(nextStepCases(RETRY).map(c => [c.label, c] as const))(
      '日別労働時間の表 — %s',
      async (_label, c) => {{
        api.getDailyHours.mockRejectedValue(c.error)
        const w = await mountPage()
        const a = w.findAllComponents({ name: 'UAlert' })[0]!
        expectExactlyOneNextStep(a.props('title'), a.props('description'), c.next)
      }},
    )

    it('★★ 403 で「次の一手」が 2 つ並んで食い違わない (dev で実測した欠陥の再現)', async () => {
      // 初稿の `description` は末尾が「— ページを再読み込みして確かめてください」だった。
      // 403 の `title` は **「ログインし直しても変わりません」「管理者に許可の追加を
      // 依頼してください」** なので、**title が効かないと言った手を description が
      // 勧める**形になっていた (nuxt dev + CDP で 403 を撃って実測)。
      // ⇒ **次の一手は status を知っている `title` の側だけが持つ。**
      api.getDailyHours.mockRejectedValue(new Error('API エラー (403): 権限がありません'))
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
      api.getDailyHours.mockRejectedValue({ status: 503 })
      const w = await mountPage()

      expect(alertTitles(w)).toContain('日別労働時間を取得できませんでした (理由を読めませんでした — ページを再読み込みしてください)')
      expect(w.text()).not.toContain('[object Object]')
    })

    it('取り直して成功したら消える (前回の失敗を残さない)', async () => {
      api.getDailyHours.mockRejectedValueOnce(new Error('API エラー (503): 落ちた'))
      const w = await mountPage()
      expect(alertTitles(w)).toHaveLength(1)

      // 月を変えると `watch` が `fetchData` を走らせ直す (2 回目は成功する mock)。
      await w.find('input[type="month"]').setValue('2026-01')
      await flushPromises()

      expect(alertTitles(w)).toHaveLength(0)
    })

    it('乗務員一覧の失敗とは別の文で出る (どちらが落ちたか消さない)', async () => {
      api.getDrivers.mockRejectedValue(new Error('乗務員が落ちた'))
      api.getDailyHours.mockRejectedValue(new Error('表が落ちた'))
      const w = await mountPage()

      expect(alertTitles(w)).toEqual([
        '乗務員一覧を取得できませんでした (乗務員が落ちた — ページを再読み込みしてください)',
        '日別労働時間を取得できませんでした (表が落ちた — ページを再読み込みしてください)',
      ])
    })
  })
})
