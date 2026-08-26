/**
 * `/profit/compare` (類似運行検索・比較) の金額に **`-0 円` を出さない**
 * (Refs #843 / #928)。
 *
 * 売上は一番星の `amount` の和 (`groupSlipsByVehicleDate`) で、`amount` には
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
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import type { VehicleDailySlip } from '~/utils/ichiban'

const { searchVehicleDailySlipsMock, getOperationsMock, getOperationCsvMock } = vi.hoisted(() => ({
  searchVehicleDailySlipsMock: vi.fn(),
  getOperationsMock: vi.fn(),
  getOperationCsvMock: vi.fn(),
}))

vi.mock('~/utils/ichiban', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/ichiban')>()),
  searchVehicleDailySlips: searchVehicleDailySlipsMock,
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getOperations: getOperationsMock,
  getOperationCsv: getOperationCsvMock,
}))

// 車輌クエリ付きで来た体にする — 画面はこの場合に自動検索する
mockNuxtImport('useRoute', () => () => ({ query: { vehicle: '1318' } }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn() }))

const ComparePage = (await import('~/pages/profit/compare.vue')).default

function slip(amount: number): VehicleDailySlip {
  return {
    saleDate: '2026-07-16',
    vehicleNumber: '1318',
    customerCode: '000001',
    customerName: '㈱田浦畜産',
    originAreaName: '釧路',
    destAreaName: '上士幌',
    origin: '釧路',
    dest: '上士幌',
    isSubcontracted: false,
    amount,
    itemCode: '',
    itemName: '',
    quantity: 0,
    unitPrice: 0,
    unit: '',
    rowId: '20260716-12',
    requestKind: '0',
  }
}

/** 伝票 1 枚だけの検索結果を描いて、金額セルの文字を返す。 */
async function amountCellText(amount: number): Promise<string> {
  searchVehicleDailySlipsMock.mockResolvedValue([slip(amount)])
  const w = mount(ComparePage, {
    global: {
      stubs: {
        NuxtLink: { template: '<a><slot /></a>' },
        UButton: { props: ['label'], template: '<button>{{ label }}</button>' },
        UIcon: { template: '<span />' },
      },
    },
  })
  await flushPromises()
  const cells = w.findAll('tbody td')
  // 金額は 6 列目 (売上年月日 / 車番 / 乗務員 / 得意先 / 積地→卸地 / 金額)
  return cells[5]!.text()
}

beforeEach(() => {
  searchVehicleDailySlipsMock.mockReset()
  getOperationsMock.mockReset().mockResolvedValue({ operations: [] })
  getOperationCsvMock.mockReset().mockResolvedValue({ headers: [], rows: [] })
  vi.stubGlobal('$fetch', vi.fn().mockResolvedValue({ items: [] }))
})

describe('/profit/compare の金額に `-0 円` を出さない (Refs #843)', () => {
  it.each([
    ['-0.4 (Math.round が -0 を返す窓)', -0.4],
    ['-0.5 (窓の端。Math.round(-0.5) は -0)', -0.5],
    ['-0.0004 (端数つきの負)', -0.0004],
    ['-4.66e-10 (按分の足し順で出る実際の形)', -4.66e-10],
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
