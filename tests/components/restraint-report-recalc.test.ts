/**
 * `/restraint-report` の再計算が**失敗を「処理中」と言わないか** (Refs #890)。
 *
 * 直す前の `catch` は例外を丸ごと握り潰して
 * `'バックグラウンドで処理中...完了までお待ちください'` を出していた。
 * **再計算が始まってすらいない回でも人は待ち続ける** — 握り潰しではなく嘘だった。
 *
 * ただし**逆方向の誤読も潰す**必要がある。進捗を受け取ってから切れた場合は
 * **サーバ側で走り続けていることがある**ので「失敗しました」と断定しない。
 * **本当に裏で走っている回 (例外なしでストリームが閉じた回) は今までどおり
 * 「処理中」と言う**ことまで見る。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { RecalcProgressEvent } from '~/utils/api'

const recalculateStream = vi.fn()
const recalculateDriverStream = vi.fn()

vi.mock('~/utils/api', () => ({
  getDrivers: vi.fn(async () => [{ id: 'd1', driver_name: '山田' }]),
  getRestraintReport: vi.fn(async () => ({
    driver_id: 'd1', driver_name: '山田', year: 2026, month: 7,
    max_restraint_minutes: 0, days: [], weekly_subtotals: [],
    monthly_total: { drive_minutes: 0, cargo_minutes: 0, break_minutes: 0, restraint_minutes: 0 },
  })),
  downloadRestraintReportPdfStream: vi.fn(),
  downloadRestraintReportPdfSingle: vi.fn(),
  recalculateStream: (...a: unknown[]) => recalculateStream(...a),
  recalculateDriverStream: (...a: unknown[]) => recalculateDriverStream(...a),
}))

import Page from '~/pages/restraint-report.vue'

function mountPage() {
  return mount(Page, {
    global: {
      stubs: {
        DriverSearchSelect: {
          props: ['modelValue'],
          emits: ['update:modelValue'],
          template: '<button class="pick-driver" @click="$emit(\'update:modelValue\', \'d1\')">driver</button>',
        },
        UButton: { props: ['label'], template: '<button>{{ label }}</button>' },
        UAlert: { props: ['title'], template: '<div class="alert">{{ title }}</div>' },
        UIcon: { template: '<i />' },
      },
    },
  })
}

async function setUpMonth(w: ReturnType<typeof mountPage>) {
  await w.find('input[type="month"]').setValue('2026-07')
  await flushPromises()
}

function clickLabel(w: ReturnType<typeof mountPage>, label: string) {
  const btn = w.findAll('button').find(b => b.text() === label)
  expect(btn, `button ${label}`).toBeDefined()
  return btn!.trigger('click')
}

describe('/restraint-report の再計算が失敗をどう出すか', () => {
  beforeEach(() => {
    recalculateStream.mockReset()
    recalculateDriverStream.mockReset()
    vi.stubGlobal('confirm', () => true)
  })

  it('始まってすらいない失敗を「処理中」と言わず、理由を出す', async () => {
    recalculateStream.mockRejectedValue(new Error('再計算に失敗: 503'))
    const w = mountPage()
    await setUpMonth(w)
    await clickLabel(w, '全員再計算')
    await flushPromises()

    expect(w.text()).toContain('再計算を開始できませんでした (再計算に失敗: 503)')
    expect(w.text()).not.toContain('バックグラウンドで処理中')
  })

  it('進捗を受け取ってから切れたら「判りません」と書き、確かめ方を出す', async () => {
    recalculateStream.mockImplementation(async (_y: number, _m: number, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'progress', current: 3, total: 10, step: 'download' })
      throw new Error('network error')
    })
    const w = mountPage()
    await setUpMonth(w)
    await clickLabel(w, '全員再計算')
    await flushPromises()

    expect(w.text()).toContain('再計算の途中で接続が切れました (network error)')
    expect(w.text()).toContain('判りません')
    expect(w.text()).toContain('しばらく後に月を選び直して結果を確認してください')
    // 進捗の途中経過が残っていると、それ自体が「動いている」と読める。
    expect(w.text()).not.toContain('再計算中 (3/10)')
    expect(w.text()).not.toContain('バックグラウンドで処理中')
  })

  it('★ 逆方向: 例外なしで done が来ないだけの回は今までどおり「処理中」', async () => {
    recalculateStream.mockResolvedValue(undefined)
    const w = mountPage()
    await setUpMonth(w)
    await clickLabel(w, '全員再計算')
    await flushPromises()

    expect(w.text()).toContain('バックグラウンドで処理中...完了までお待ちください')
    expect(w.text()).not.toContain('開始できませんでした')
    expect(w.text()).not.toContain('接続が切れました')
  })

  it('error イベントで終わる回は今までどおり理由をそのまま出す', async () => {
    recalculateStream.mockImplementation(async (_y: number, _m: number, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'error', message: '対象月のデータがありません' })
    })
    const w = mountPage()
    await setUpMonth(w)
    await clickLabel(w, '全員再計算')
    await flushPromises()

    expect(w.text()).toContain('対象月のデータがありません')
    expect(w.text()).not.toContain('接続が切れました')
  })

  it('1 人ぶんの再計算も理由を捨てない (以前は「エラーが発生しました」だけ)', async () => {
    recalculateDriverStream.mockRejectedValue(new Error('再計算に失敗: 500'))
    const w = mountPage()
    await setUpMonth(w)
    await w.find('.pick-driver').trigger('click')
    await flushPromises()
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(w.text()).toContain('再計算を開始できませんでした (再計算に失敗: 500)')
    expect(w.text()).not.toContain('エラーが発生しました')
  })
})
