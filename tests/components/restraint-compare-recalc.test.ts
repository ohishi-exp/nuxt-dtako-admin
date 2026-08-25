/**
 * `/restraint-compare` の再計算が**失敗を成功に読ませないか** (Refs #917)。
 *
 * `/api/recalculate-driver` / `/api/recalculate-drivers` は SSE で、`rust-alc-api` は
 * **DB エラーでも 200 を返し、エラーはストリーム本文に入れる**。
 * ⇒ **失敗を知る手段は `error` イベントだけ**なのに、直す前のこのページは
 *
 * - 1 人ぶん (`recalcDriver`): `await` を抜けた直後の「再計算完了 → 再比較」が
 *   **エラーかどうかを一切見ずに** `一致！` / `完了` で同じキーを上書きしていた
 *   ⇒ 理由が数ミリ秒だけ出て消え、**失敗が「一致！」になった**
 * - 一括 (`recalcDiffsOnly`): `finally` が `batchRecalcProgress` を**成功でも失敗でも
 *   無条件に空にする**。進捗はボタンのラベルにしか出ないので
 *   ⇒ **失敗が無かったことになった**
 *
 * ここで固定するのは「**エラーの回に成功の文言が出ない**」と、その裏返しの
 * 「**成功の回は今までどおり結果が出る**」の両方 (陽性対照が無いと、
 * 何も描かないだけの実装でも緑になる)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import type { VueWrapper } from '@vue/test-utils'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'
import type { RecalcProgressEvent, BatchRecalcEvent } from '~/utils/api'

const compareRestraintCsv = vi.fn()
const recalculateDriverStream = vi.fn()
const recalculateDriversBatch = vi.fn()

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  compareRestraintCsv: (...a: unknown[]) => compareRestraintCsv(...a),
  recalculateDriverStream: (...a: unknown[]) => recalculateDriverStream(...a),
  recalculateDriversBatch: (...a: unknown[]) => recalculateDriversBatch(...a),
}))

import Page from '~/pages/restraint-compare.vue'

/** 未知差分 1 件を持つ 1 人ぶんの比較結果 (既定の filterMode = 'unknown' に映る)。 */
function withUnknownDiff() {
  return [{
    driver_id: 'd1',
    driver_cd: '0001',
    driver_name: '山田',
    system: true,
    unknown_diffs: 1,
    known_bug_diffs: 0,
    diffs: [{ date: '7月1日', field: '拘束時間', csv_val: '10:00', sys_val: '9:00', known_bug: null }],
    csv: { days: [{ date: '7月1日', is_holiday: false }] },
  }]
}

/** 差分ゼロ = 再比較が「一致！」を出す側の結果。 */
function matched() {
  const [r] = withUnknownDiff()
  return [{ ...r!, unknown_diffs: 0, known_bug_diffs: 0, diffs: [] }]
}

function mountPage() {
  return mount(Page, { global: { stubs: NUXT_UI_PAGE_STUBS } })
}

async function selectCsv(w: VueWrapper) {
  const input = w.find('input[type="file"]')
  const file = new File(['x'], 'restraint.csv', { type: 'text/csv' })
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

function clickLabel(w: VueWrapper, label: string) {
  const btn = w.findAll('button').find(b => b.text() === label)
  expect(btn, `button ${label}`).toBeDefined()
  return btn!.trigger('click')
}

/** 1 人ぶんの結果表示 (`v-if="result && !loading"` の span)。 */
function driverResult(w: VueWrapper) {
  return w.findAll('span.text-xs.font-bold').at(-1)
}

/** `UAlert` の title を全部集める (画面に出ている「理由」だけを見るため)。 */
function alertTitles(w: VueWrapper): string[] {
  return w.findAllComponents({ name: 'UAlert' }).map(a => String(a.props('title') ?? ''))
}

beforeEach(() => {
  compareRestraintCsv.mockReset()
  recalculateDriverStream.mockReset()
  recalculateDriversBatch.mockReset()
})

describe('1 人ぶんの再計算 (recalcDriver)', () => {
  it('★ error イベントの回に「一致！」で上書きしない', async () => {
    compareRestraintCsv.mockResolvedValueOnce(withUnknownDiff()).mockResolvedValue(matched())
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'error', message: '対象月のデータがありません' })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.text()).toBe('対象月のデータがありません')
    // 失敗した回に再比較すると、再計算されていない古い値で結果が出る。呼んでいないこと。
    expect(compareRestraintCsv).toHaveBeenCalledTimes(1)
  })

  it('★ 失敗は赤で出す (文言判定ではなく error フラグで色を決める)', async () => {
    compareRestraintCsv.mockResolvedValueOnce(withUnknownDiff()).mockResolvedValue(matched())
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      // **理由文に「一致」の 2 文字が入る回**。文言で色を決めていると緑になる。
      onProgress({ event: 'error', message: '運行NO と乗務員が一致しません' })
    })

    const w = mountPage()
    await selectCsv(w)
    // 一致すると「未知差分」の絞り込みから行が消えるので全員表示にしておく
    // (直す前の実装が `一致！` で上書きする側に倒れることまで見るため)。
    await clickLabel(w, '全員 (1)')
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.classes()).toContain('text-red-600')
    expect(driverResult(w)!.classes()).not.toContain('text-green-600')
  })

  it('message の無い error でも「エラー」で終わらせず、再計算が失敗したと書く', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'error' })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.text()).toBe('再計算に失敗しました')
  })

  it('始まってすらいない例外は理由を捨てず「開始できませんでした」と書く', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriverStream.mockRejectedValue(new Error('再計算に失敗: 503'))

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.text()).toBe('再計算を開始できませんでした (再計算に失敗: 503)')
    expect(compareRestraintCsv).toHaveBeenCalledTimes(1)
  })

  it('進捗を受け取ってから切れたら断定せず「判りません」と書く', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'progress', current: 3, total: 10, step: 'download' })
      throw new Error('network error')
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '再計算')
    await flushPromises()

    const text = driverResult(w)!.text()
    expect(text).toContain('再計算の途中で接続が切れました (network error)')
    expect(text).toContain('判りません')
    // 進捗の途中経過が残っていると、それ自体が「動いている」と読める。
    expect(text).not.toContain('DL中 (3/10)')
  })

  it('error イベントの後に例外が出ても、具体的な理由の方を残す', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'error', message: '乗務員が見つかりません' })
      throw new Error('stream closed')
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.text()).toBe('乗務員が見つかりません')
    expect(driverResult(w)!.text()).not.toContain('接続が切れました')
  })

  it('再計算は通って再比較だけ落ちた回は、そう書く (もう一度回せとは読ませない)', async () => {
    compareRestraintCsv.mockResolvedValueOnce(withUnknownDiff()).mockRejectedValue(new Error('比較 API 500'))
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'done' })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.text()).toBe('再計算は終わりましたが再比較に失敗しました (比較 API 500)')
    expect(driverResult(w)!.classes()).toContain('text-red-600')
  })

  it('★ 陽性対照: 成功した回は今までどおり再比較して「一致！」を出す', async () => {
    compareRestraintCsv.mockResolvedValueOnce(withUnknownDiff()).mockResolvedValue(matched())
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'progress', current: 1, total: 2, step: 'download' })
      onProgress({ event: 'done' })
    })

    const w = mountPage()
    await selectCsv(w)
    // 既定の絞り込みは「未知差分」。一致すると行ごと消えて結果が読めないので全員表示にする。
    await clickLabel(w, '全員 (1)')
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(compareRestraintCsv).toHaveBeenCalledTimes(2)
    expect(driverResult(w)!.text()).toBe('一致！')
    expect(driverResult(w)!.classes()).toContain('text-green-600')
  })
})

describe('一括再計算 (recalcDiffsOnly)', () => {
  const BATCH_LABEL = '未知差分1名 再計算'

  it('★ error イベントの回に、進捗欄が空になって終わらない', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockImplementation(async (_y: number, _m: number, _ids: string[], onProgress: (e: BatchRecalcEvent) => void) => {
      onProgress({ event: 'progress', current: 1, total: 1 })
      onProgress({ event: 'error', message: 'DB に接続できません' })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(alertTitles(w)).toContain('DB に接続できません')
    // 失敗した回に再比較しない (古い値で「一致！」が出る)。
    expect(compareRestraintCsv).toHaveBeenCalledTimes(1)
  })

  it('message の無い error でも一括再計算が失敗したと書く', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockImplementation(async (_y: number, _m: number, _ids: string[], onProgress: (e: BatchRecalcEvent) => void) => {
      onProgress({ event: 'error' })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(alertTitles(w)).toContain('一括再計算に失敗しました')
  })

  it('始まってすらいない例外は理由を捨てず「開始できませんでした」と書く', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockRejectedValue(new Error('再計算に失敗: 502'))

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(alertTitles(w)).toContain('再計算を開始できませんでした (再計算に失敗: 502)')
    expect(compareRestraintCsv).toHaveBeenCalledTimes(1)
  })

  it('進捗を受け取ってから切れたら断定せず「判りません」と書く', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockImplementation(async (_y: number, _m: number, _ids: string[], onProgress: (e: BatchRecalcEvent) => void) => {
      onProgress({ event: 'progress', current: 1, total: 3 })
      throw new Error('network error')
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(alertTitles(w).join(' ')).toContain('再計算の途中で接続が切れました (network error)')
  })

  it('error イベントの後に例外が出ても、具体的な理由の方を残す', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockImplementation(async (_y: number, _m: number, _ids: string[], onProgress: (e: BatchRecalcEvent) => void) => {
      onProgress({ event: 'error', message: '対象がありません' })
      throw new Error('stream closed')
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(alertTitles(w)).toContain('対象がありません')
    expect(alertTitles(w).join(' ')).not.toContain('接続が切れました')
  })

  it('★ 陽性対照: 成功した回は再比較まで進み、失敗の理由を出さない', async () => {
    compareRestraintCsv.mockResolvedValueOnce(withUnknownDiff()).mockResolvedValue(matched())
    recalculateDriversBatch.mockImplementation(async (_y: number, _m: number, _ids: string[], onProgress: (e: BatchRecalcEvent) => void) => {
      onProgress({ event: 'progress', current: 1, total: 1 })
      onProgress({ event: 'batch_done', total: 1 })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(compareRestraintCsv).toHaveBeenCalledTimes(2)
    expect(alertTitles(w).join(' ')).toBe('')
  })
})
