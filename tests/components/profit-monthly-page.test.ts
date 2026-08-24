/**
 * `/profit/monthly` の「保存済み検証一覧」が、**本文を読めなかった保存の件数を人に言うか**
 * (Refs #850)。
 *
 * API が数を返しても画面が黙っていれば、「この条件では保存が無い」と「読めなかった」が
 * 同じ見た目のままになる。**0 件の一覧と一緒に出ること**まで見る。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MonthlyPage from '~/pages/profit/monthly.vue'
import type { SnapshotListResult } from '~/utils/profit-r2'

const fetchMock = vi.fn()
vi.stubGlobal('$fetch', fetchMock)

function mountPage() {
  return mount(MonthlyPage, {
    global: {
      stubs: {
        NuxtLink: { template: '<a><slot :navigate="() => {}" /></a>' },
        UModal: { template: '<div />' },
        UButton: { template: '<button><slot /></button>' },
      },
    },
  })
}

function listResult(overrides: Partial<SnapshotListResult> = {}): SnapshotListResult {
  return { items: [], total: 0, unreadable: 0, ...overrides }
}

describe('/profit/monthly の保存済み検証一覧', () => {
  beforeEach(() => fetchMock.mockReset())

  it('読めなかった保存があれば件数と理由を出す (0 件の一覧と一緒でも出る)', async () => {
    fetchMock.mockResolvedValue(listResult({ unreadable: 2 }))
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('2 件は保存の本文を R2 から読めませんでした')
    expect(w.text()).toContain('この条件で保存が無いのではなく、読めていません')
    // 「保存が無い」の文言と**両方**出る — 一覧が空なのは事実なので消さない。
    expect(w.text()).toContain('条件に一致する保存済みスナップショットはありません')
  })

  it('読めなかった保存が無ければ何も出さない', async () => {
    fetchMock.mockResolvedValue(listResult())
    const w = mountPage()
    await flushPromises()
    expect(w.text()).not.toContain('読めていません')
  })

  // #859: 「一番星マッチ率検証 (月次)」の比較セクションは廃止した。#849 で書き込みを
  // 止めた結果、分子 (確認済み合計) が凍結する一方で分母 (一番星月計、毎回ライブ) だけが
  // 増え続け、「マッチできていない量が増え続けている」という誤診を生む形だったため。
  // **この画面から `/api/profit/monthly` を叩かないこと**まで見る (route ごと消えており、
  // 叩けば 404 になる)。
  it('マッチ率の比較セクションは出ず、/api/profit/monthly も叩かない', async () => {
    fetchMock.mockResolvedValue(listResult())
    const w = mountPage()
    await flushPromises()
    expect(w.text()).not.toContain('一番星マッチ率検証')
    expect(w.text()).not.toContain('一番星 月計')
    expect(w.text()).not.toContain('確認済み合計')
    expect(fetchMock.mock.calls.every(([url]) => url !== '/api/profit/monthly')).toBe(true)
  })

  it('一覧そのものを読めなかったときは前の件数を持ち越さない', async () => {
    fetchMock.mockResolvedValueOnce(listResult({ unreadable: 3 }))
    const w = mountPage()
    await flushPromises()
    expect(w.text()).toContain('3 件は保存の本文を R2 から読めませんでした')

    fetchMock.mockRejectedValueOnce(new Error('R2 に届きませんでした'))
    await w.find('button').trigger('click')
    await flushPromises()
    expect(w.text()).not.toContain('読めていません')
    expect(w.text()).toContain('R2 に届きませんでした')
  })
})
