/**
 * `/restraint-compare` の「web地球号から取得して比較」(Refs #1193)。
 *
 * 取得した Blob を File に包んで既存の `compareRestraintCsv` へ渡す。ここでは
 * **渡る値** (ファイル名・年月・状態) だけを検査する。blob 応答なので失敗の本文は読めず、
 * 理由文までは主張しない。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'
import type { RecalcProgressEvent } from '~/utils/api'

const { expireSession } = vi.hoisted(() => ({ expireSession: vi.fn() }))
mockNuxtImport('useRestraintSession', () => () => ({
  session: ref({ token: 't' }),
  authHeaders: () => ({}),
  restoreSession: () => {},
  expireSession,
  showLoginPanel: ref(false),
}))

const compareRestraintCsv = vi.fn()
const recalculateDriverStream = vi.fn()
vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  compareRestraintCsv: (...a: unknown[]) => compareRestraintCsv(...a),
  recalculateDriverStream: (...a: unknown[]) => recalculateDriverStream(...a),
}))

import Page from '~/pages/restraint-compare.vue'

function withUnknownDiff() {
  return [{
    driver_id: 'd1', driver_cd: '0001', driver_name: '山田', system: true,
    unknown_diffs: 1, known_bug_diffs: 0,
    diffs: [{ date: '7月1日', field: '拘束時間', csv_val: '10:00', sys_val: '9:00', known_bug: null }],
    csv: { days: [{ date: '7月1日', is_holiday: false }] },
  }]
}

function mountPage() {
  return mount(Page, { global: { stubs: { ...NUXT_UI_PAGE_STUBS, TheearthSessionHeader: true } } })
}

async function click(w: VueWrapper, label: string) {
  const btn = w.findAll('button').find(b => b.text() === label)
  expect(btn, `button ${label}`).toBeDefined()
  await btn!.trigger('click')
  await flushPromises()
}

async function fetchFor(w: VueWrapper, ym: string, cd = '') {
  await w.find('input[type="month"]').setValue(ym)
  await w.find('input[type="text"]').setValue(cd)
  await click(w, 'web地球号から取得して比較')
}

const okRecalc = async (_y: number, _m: number, _d: string, on: (e: RecalcProgressEvent) => void) => on({ event: 'done' })

beforeEach(() => {
  compareRestraintCsv.mockReset()
  recalculateDriverStream.mockReset()
  expireSession.mockReset()
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue(new Blob(['x'])))
})

describe('取得して比較', () => {
  it('(a) 取得した Blob が File になり、名前に年月と乗務員CDが入って比較へ渡る', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    const w = mountPage()
    await fetchFor(w, '2025-03', '1234')

    const $f = globalThis.$fetch as unknown as ReturnType<typeof vi.fn>
    expect($f).toHaveBeenCalledTimes(1)
    expect($f.mock.calls[0]![1].query).toEqual({ year: 2025, month: 3, driverFrom: '1234', driverTo: '1234' })
    const file = compareRestraintCsv.mock.calls[0]![0]
    expect(file).toBeInstanceOf(File)
    expect(file.name).toBe('web地球号_2025-03_1234.csv')
  })

  it('(b) 取得経路の「再計算」は選んだ年月 (2026 でない年) を渡す', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriverStream.mockImplementation(okRecalc)
    const w = mountPage()
    await fetchFor(w, '2025-03')
    await click(w, '再計算')

    expect(recalculateDriverStream.mock.calls[0]!.slice(0, 3)).toEqual([2025, 3, 'd1'])
  })

  it('(c) ファイル経路は従来どおり 2026 と推定月を渡す', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriverStream.mockImplementation(okRecalc)
    const w = mountPage()
    const input = w.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'a.csv')], configurable: true })
    await input.trigger('change')
    await flushPromises()
    await click(w, '再計算')

    expect(recalculateDriverStream.mock.calls[0]!.slice(0, 3)).toEqual([2026, 7, 'd1'])
  })

  it('(c2) 取得したあとファイルを選び直すと、年月は推定に戻る', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriverStream.mockImplementation(okRecalc)
    const w = mountPage()
    await fetchFor(w, '2025-03')
    const input = w.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['x'], 'a.csv')], configurable: true })
    await input.trigger('change')
    await flushPromises()
    await click(w, '再計算')

    expect(recalculateDriverStream.mock.calls[0]!.slice(0, 2)).toEqual([2026, 7])
  })

  it('(d) 401 は expireSession、比較は呼ばない', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 401 })))
    const w = mountPage()
    await fetchFor(w, '2025-03')

    expect(expireSession).toHaveBeenCalledTimes(1)
    expect(compareRestraintCsv).not.toHaveBeenCalled()
  })

  it('(d) 404 は「web地球号にありません」を出し、結果は空で比較も呼ばない', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(Object.assign(new Error('x'), { status: 404 })))
    const w = mountPage()
    await fetchFor(w, '2025-03', '77')

    const titles = w.findAllComponents({ name: 'UAlert' }).map(a => String(a.props('title')))
    expect(titles).toContain('2025年3月 乗務員 77 の拘束時間管理表は web地球号にありません (集計前の月は出ません)')
    expect(compareRestraintCsv).not.toHaveBeenCalled()
    expect(w.text()).not.toContain('山田')
  })

  it('それ以外の失敗は黙らず error に出る', async () => {
    vi.stubGlobal('$fetch', vi.fn().mockRejectedValue(Object.assign(new Error('[GET] "/restraint-api/csv": 502'), { status: 502 })))
    const w = mountPage()
    await fetchFor(w, '2025-03')

    const titles = w.findAllComponents({ name: 'UAlert' }).map(a => String(a.props('title')))
    expect(titles).toContain('[GET] "/restraint-api/csv": 502')
    expect(compareRestraintCsv).not.toHaveBeenCalled()
  })
})
