/**
 * `/restraint-compare` の再計算が**失敗を成功に読ませないか** (Refs #917)。
 *
 * `/api/recalculate-driver` / `/api/recalculate-drivers` は SSE で、`rust-alc-api` は
 * **DB エラーでも 200 を返し、エラーはストリーム本文に入れる**。
 * ⇒ **失敗を知る手段は `error` イベントだけ**なのに、直す前のこのページは
 *
 * - 1 人ぶん (`recalcDriver`): `await` を抜けた直後の「再計算完了 → 再比較」が
 *   **エラーかどうかを一切見ずに** 同じキーを上書きしていた
 * - 一括 (`recalcDiffsOnly`): `finally` が `batchRecalcProgress` を**成功でも失敗でも
 *   無条件に空にする**。進捗はボタンのラベルにしか出ないので失敗が消えた
 *
 * **実測 (dev + ローカル alc スタブ + headless Chrome、2026-08-25)**: 直す前は
 * どちらの経路でも画面が **`未知差分 (0)` / `未知差分なし`** になった。理由が
 * 消えるだけでなく、**行ごと絞り込みから外れて「全部一致した」に見える**。
 *
 * 書き方は `tests/components/restraint-report-recalc.test.ts` に合わせている。
 * **カバレッジのアームを埋めるためのテストは置かない** (ページは coverage gate の
 * 対象外、2026-08-25 方針)。ここにあるのは挙動を固定するものだけ。
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

/** 一括再計算ボタンのラベル (走行中は進捗、終われば通常文言に戻る)。 */
function batchButtonLabel(w: VueWrapper): string {
  return w.findAll('button').map(b => b.text()).find(t => t.includes('再計算') && t !== '再計算') ?? ''
}

beforeEach(() => {
  compareRestraintCsv.mockReset()
  recalculateDriverStream.mockReset()
  recalculateDriversBatch.mockReset()
})

describe('1 人ぶんの再計算 (recalcDriver)', () => {
  it('★ error イベントの回は再比較せず、理由を出したまま終わる', async () => {
    compareRestraintCsv.mockResolvedValueOnce(withUnknownDiff()).mockResolvedValue(matched())
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      onProgress({ event: 'error', message: '対象月のデータがありません' })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.text()).toBe('対象月のデータがありません')
    // 失敗した回に再比較すると、再計算されていない古い値で結果が出る。
    expect(compareRestraintCsv).toHaveBeenCalledTimes(1)
  })

  it('★ 陽性対照: 成功した回は再比較して結果を出す', async () => {
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

  it('失敗の色は文言ではなく結果そのものから決める', async () => {
    compareRestraintCsv.mockResolvedValueOnce(withUnknownDiff()).mockResolvedValue(matched())
    recalculateDriverStream.mockImplementation(async (_y: number, _m: number, _d: string, onProgress: (e: RecalcProgressEvent) => void) => {
      // **理由文に「一致」の 2 文字が入る回**。文言で色を決めていると緑になる。
      onProgress({ event: 'error', message: '運行NO と乗務員が一致しません' })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '全員 (1)')
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.classes()).toContain('text-red-600')
    expect(driverResult(w)!.classes()).not.toContain('text-green-600')
  })

  it('始まってすらいない失敗は理由を捨てない (以前は `catch {}` で「エラー」だけ)', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriverStream.mockRejectedValue(new Error('再計算に失敗: 503'))

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, '再計算')
    await flushPromises()

    expect(driverResult(w)!.text()).toBe('再計算を開始できませんでした (再計算に失敗: 503)')
    expect(compareRestraintCsv).toHaveBeenCalledTimes(1)
  })

  it('進捗を受け取ってから切れた回は「失敗した」と断定しない', async () => {
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
    expect(text).toBe('再計算が途中で切れました (network error)。完了したかは不明 — 再比較で確認')
    // 進捗の途中経過が残っていると、それ自体が「動いている」と読める。
    expect(text).not.toContain('DL中 (3/10)')
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
})

describe('一括再計算 (recalcDiffsOnly)', () => {
  const BATCH_LABEL = '未知差分1名 再計算'

  it('★ error イベントの回は再比較せず、理由が finally の後も残る', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockImplementation(async (_y: number, _m: number, _ids: string[], onProgress: (e: BatchRecalcEvent) => void) => {
      onProgress({ event: 'progress', current: 1, total: 1 })
      onProgress({ event: 'error', message: 'DB に接続できません' })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    // ★ ここが本命 — `finally` が走り切った後に読んでいる。
    expect(alertTitles(w)).toContain('DB に接続できません')
    // 失敗した回に再比較しない (再計算されていない古い値で結果が出る)。
    expect(compareRestraintCsv).toHaveBeenCalledTimes(1)
  })

  // ★ `retry` に渡す表記が、**画面に実際に描かれているラベルと 1 文字も違わない**ことを
  //    見る (Refs #1008)。このボタンだけラベルが件数入りで可変なので、式を 2 か所に書くと
  //    片方だけ変わって「存在しないボタン」を案内する。`batchRecalcLabel` (computed) を
  //    template と `retry` で共有しているので、ここが両者を突き合わせる場所になる。
  it('★ retry は画面に出ている一括ボタンのラベルそのもの (件数入り)', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockResolvedValue(undefined)

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    const retry = recalculateDriversBatch.mock.calls[0]![4] as string
    expect(retry).toBe(`「${batchButtonLabel(w)}」を押してください`)
    // 陰性対照: 伏せ字や固定文言に戻っていないこと (件数が実際に入っている)。
    expect(retry).toBe('「未知差分1名 再計算」を押してください')
    expect(retry).not.toContain('…')
  })

  it('★ 陽性対照: 成功した回は再比較まで進み、進捗は空に戻る', async () => {
    // 再比較後も差分が残る側にしておく (一致させるとボタンごと消えてラベルが読めない)。
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockImplementation(async (_y: number, _m: number, _ids: string[], onProgress: (e: BatchRecalcEvent) => void) => {
      onProgress({ event: 'progress', current: 1, total: 1 })
      onProgress({ event: 'batch_done', total: 1 })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(compareRestraintCsv).toHaveBeenCalledTimes(2)
    // 進捗 (ボタンのラベル) は消え、通常文言に戻っている。
    expect(batchButtonLabel(w)).toBe(BATCH_LABEL)
    expect(alertTitles(w).join(' ')).toBe('')
  })

  it('一括再計算は通って再比較だけ落ちた回は、そう書く (もう一度 全員ぶん回せとは読ませない)', async () => {
    compareRestraintCsv.mockResolvedValueOnce(withUnknownDiff()).mockRejectedValue(new Error('比較に失敗: 500'))
    recalculateDriversBatch.mockImplementation(async (_y: number, _m: number, _ids: string[], onProgress: (e: BatchRecalcEvent) => void) => {
      onProgress({ event: 'progress', current: 1, total: 1 })
      onProgress({ event: 'batch_done', total: 1 })
    })

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(alertTitles(w)).toContain('一括再計算は終わりましたが再比較に失敗しました (比較に失敗: 500)')
    // 理由を 2 つの UAlert で言わない (素の `比較に失敗: 500` は畳んである)。
    expect(alertTitles(w)).not.toContain('比較に失敗: 500')
    // 再計算は終わっている。「再計算に失敗」系の文言を出さない。
    expect(alertTitles(w).join(' ')).not.toContain('再計算を開始できませんでした')
    expect(alertTitles(w).join(' ')).not.toContain('再計算が途中で切れました')
  })

  it('始まってすらいない失敗は理由を捨てない', async () => {
    compareRestraintCsv.mockResolvedValue(withUnknownDiff())
    recalculateDriversBatch.mockRejectedValue(new Error('再計算に失敗: 502'))

    const w = mountPage()
    await selectCsv(w)
    await clickLabel(w, BATCH_LABEL)
    await flushPromises()

    expect(alertTitles(w)).toContain('再計算を開始できませんでした (再計算に失敗: 502)')
    expect(compareRestraintCsv).toHaveBeenCalledTimes(1)
  })
})
