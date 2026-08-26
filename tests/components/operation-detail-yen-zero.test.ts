/**
 * 運行詳細 (`/operations/[unko_no]`) の計上額パネルの金額に **`¥-0` を出さない**
 * (Refs #843 / #840)。
 *
 * 売上は一番星の `amount` をそのまま足したものなので**負にもなる**。`Math.round` は
 * `-0.5 ≤ v < 0` で **`-0`** を返し、**`(-0).toLocaleString()` は `"-0"`** なので、
 * その回に「合計 ¥-0」「便1 ¥-0」と出ていた。**「0 円」なのか「符号が化けた」のか
 * 読めない**のが害。
 *
 * **ここは描画で確かめる。** `yen` は `<script setup>` のローカルなので、実際に
 * マウントして**セルの文字**を読まないと「直したつもり」しか測れない。
 *
 * **陽性対照 (`-0.6` → `¥-1`) を必ず置く。** `Math.abs` のような「符号ごと消す」直しでも
 * 通ってしまうテストにしないため。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { OPERATION_LEG_SALES_KEY, serializeOperationLegSales } from '~/utils/operation-leg-sales'
import type { Operation } from '~/types'

const UNKO_NO = '2607010121120000001318'

const { getOperationMock, getOperationCsvMock } = vi.hoisted(() => ({
  getOperationMock: vi.fn(),
  getOperationCsvMock: vi.fn(),
}))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getOperation: getOperationMock,
  getOperationCsv: getOperationCsvMock,
}))

mockNuxtImport('useRoute', () => () => ({ params: { unko_no: UNKO_NO } }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn() }))

const OPERATION = {
  unko_no: UNKO_NO,
  reading_date: '2026-07-01',
  operation_date: '2026-07-01',
  raw_data: { 車輌CD: '1318', 乗務員CD1: '1412' },
} as unknown as Operation

const passthroughStub = { template: '<div><slot /></div>' }

const OperationDetailPage = (await import('~/pages/operations/[unko_no].vue')).default

function mountPage() {
  return mount(OperationDetailPage, {
    global: {
      stubs: {
        UButton: { props: ['label'], template: '<button>{{ label }}</button>' },
        UIcon: { template: '<span />' },
        UModal: { template: '<div />' },
        NuxtLink: { template: '<a><slot /></a>' },
        EventDataTable: passthroughStub,
        CsvDataTable: passthroughStub,
        Net780OperationSummary: passthroughStub,
        EventSpeedMapPanel: passthroughStub,
        EventSelectionSummaryPanel: passthroughStub,
        ProfitPanel: passthroughStub,
        OperationRouteMap: { template: '<div />' },
      },
    },
  })
}

/**
 * この端末の突合結果 (localStorage) に便 1 本を置いて計上額パネルを出す。
 * **`ready` なので R2 は 1 回も叩かない** (画面のコメントどおり)。
 */
async function panelTextOf(yen: number) {
  localStorage.setItem(OPERATION_LEG_SALES_KEY, serializeOperationLegSales({
    ym: '2026-07',
    byUnko: { [UNKO_NO]: [{ seq: 1, customers: [{ name: '○○運輸', yen }], slipIds: ['r1'] }] },
  }))
  const w = mountPage()
  await flushPromises()
  return w.text()
}

beforeEach(() => {
  getOperationMock.mockReset().mockResolvedValue([OPERATION])
  getOperationCsvMock.mockReset().mockResolvedValue({ headers: [], rows: [] })
  vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
  localStorage.clear()
})

describe('運行詳細の計上額に `¥-0` を出さない (Refs #843)', () => {
  it.each([
    ['-0.4 (Math.round が -0 を返す窓)', -0.4],
    ['-0.5 (窓の端。Math.round(-0.5) は -0)', -0.5],
    ['-0.0004 (端数つきの負。丸めずに出すと "-0")', -0.0004],
    ['-4.66e-10 (按分の足し順で出る実際の形)', -4.66e-10],
    ['-0 そのもの', -0],
    ['0 (退行なし)', 0],
  ])('%s → ¥0', async (_name, yen) => {
    const text = await panelTextOf(yen)
    expect(text).toContain('合計 ¥0')
    expect(text).not.toContain('¥-0')
  })

  it('陽性対照: 本当に負の額は負のまま (-0.6 → ¥-1)', async () => {
    const text = await panelTextOf(-0.6)
    expect(text).toContain('合計 ¥-1')
  })

  it('陽性対照: まとまった負の額も消えない (-50,000 → ¥-50,000)', async () => {
    const text = await panelTextOf(-50000)
    expect(text).toContain('合計 ¥-50,000')
  })

  it('正の額は 1 円も動かない', async () => {
    const text = await panelTextOf(50000)
    expect(text).toContain('合計 ¥50,000')
  })
})
