/**
 * `/profit/monthly` の「保存済み検証一覧」の確定金額に **`-0 円` を出さない**
 * (Refs #843 / #928)。
 *
 * `confirmedAmount` は一番星の `amount` の和 (`profit-r2.ts`) で、`amount` には
 * コード上の符号の保証が無い。`Math.round` は `-0.5 ≤ v < 0` で **`-0`** を返し、
 * **`(-0).toLocaleString()` は `"-0"`** なので、その回に `-0 円` と出ていた。
 * **「0 円」なのか「符号が化けた」のか読めない**のが害。
 *
 * **ここは描画で確かめる。** `formatYen` は `<script setup>` のローカルなので、
 * 実際にマウントして**セルの文字**を読まないと「直したつもり」しか測れない。
 *
 * **陽性対照 (`-0.6` → `-1 円`) を必ず置く** — `Math.abs` のような「符号ごと消す」
 * 直しでも通ってしまうテストにしないため。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MonthlyPage from '~/pages/profit/monthly.vue'
import type { SnapshotListItem, SnapshotListResult } from '~/utils/profit-r2'

const fetchMock = vi.fn()
vi.stubGlobal('$fetch', fetchMock)

function item(confirmedAmount: number): SnapshotListItem {
  return {
    vehicleCode: '1318',
    unkoNo: '2607161000000000001318',
    segmentId: 'seg-1',
    ym: '2026-07',
    savedAt: '2026-07-16T10:00:00.000Z',
    confirmedAmount,
    slipCount: 1,
    customerNames: ['㈱田浦畜産'],
    saleDateFrom: '2026-07-16',
    saleDateTo: '2026-07-16',
    matchCounts: { exact: 1, partial: 0, none: 0 },
  }
}

/** 1 件だけ載せた一覧を描いて、確定金額セルの文字を返す。 */
async function amountCellText(confirmedAmount: number): Promise<string> {
  const result: SnapshotListResult = { items: [item(confirmedAmount)], total: 1, unreadable: 0 }
  fetchMock.mockResolvedValue(result)
  const w = mount(MonthlyPage, {
    global: {
      stubs: {
        NuxtLink: { template: '<a><slot :navigate="() => {}" /></a>' },
        UModal: { template: '<div />' },
        UButton: { template: '<button><slot /></button>' },
      },
    },
  })
  await flushPromises()
  const cells = w.findAll('tbody td')
  // 確定金額は 5 列目 (保存日時 / 車輌 / 売上年月日 / 得意先 / 確定金額)
  return cells[4]!.text()
}

describe('/profit/monthly の確定金額に `-0 円` を出さない (Refs #843)', () => {
  beforeEach(() => fetchMock.mockReset())

  it.each([
    ['-0.4 (Math.round が -0 を返す窓)', -0.4],
    ['-0.5 (窓の端。Math.round(-0.5) は -0)', -0.5],
    ['-0.0004 (端数つきの負)', -0.0004],
    ['-4.66e-10 (按分の足し順で出る実際の形)', -4.66e-10],
    ['-0 そのもの', -0],
    ['0 (退行なし)', 0],
  ])('%s → 0 円', async (_name, v) => {
    expect(await amountCellText(v)).toBe('0 円')
  })

  it('陽性対照: 本当に負の額は負のまま (-0.6 → -1 円)', async () => {
    expect(await amountCellText(-0.6)).toBe('-1 円')
  })

  it('陽性対照: まとまった負の額も消えない (符号ごと潰していない)', async () => {
    expect(await amountCellText(-50000)).toBe('-50,000 円')
  })

  it('正の額は 1 円も動かない', async () => {
    expect(await amountCellText(41250)).toBe('41,250 円')
  })
})
