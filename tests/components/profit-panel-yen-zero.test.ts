/**
 * 収支パネル (`ProfitPanel`) の金額に **`-0` を出さない** (Refs #843 / #928)。
 *
 * 結んだ売上は一番星の `amount` の和 (`sumAmount`) で、`amount` にはコード上の符号の
 * 保証が無い。`Math.round` は `-0.5 ≤ v < 0` で **`-0`** を返し、**`(-0).toLocaleString()`
 * は `"-0"`** なので、その回に「結んだ売上 -0 円」「円/km -0」と出ていた。
 * **「0 円」なのか「符号が化けた」のか読めない**のが害。
 *
 * **ここは描画で確かめる。** `formatYen` は `<script setup>` のローカルなので、
 * 実際にマウントして**セルの文字**を読まないと「直したつもり」しか測れない。
 *
 * **陽性対照 (`-0.6` → `-1`) を必ず置く** — `Math.abs` のような「符号ごと消す」直しでも
 * 通ってしまうテストにしないため。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ProfitPanel from '~/components/ProfitPanel.vue'
import type { VehicleDailySlip } from '~/utils/ichiban'
import { OPERATION_LEG_SALES_KEY, serializeOperationLegSales } from '~/utils/operation-leg-sales'
import { UIconStub } from '../helpers/stubs'

const { fetchDriverDailySlipsMock } = vi.hoisted(() => ({
  fetchDriverDailySlipsMock: vi.fn(),
}))

vi.mock('~/utils/ichiban', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/ichiban')>()),
  fetchDriverDailySlips: fetchDriverDailySlipsMock,
}))

const UNKO = '2607161000000000001318'
const ROW_ID = '20260716-12'
const LEG1_TS = Date.UTC(2026, 6, 16, 9, 31) / 1000
const LEG2_TS = Date.UTC(2026, 6, 16, 13, 0) / 1000

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
    rowId: ROW_ID,
    requestKind: '0',
  }
}

/**
 * ①が既にこの明細を便 1 に当てている状態で描く。
 * ラベルの**次の span** が金額なので、そこの文字を返す。
 */
async function labelledValues(amount: number): Promise<Map<string, string>> {
  localStorage.setItem(OPERATION_LEG_SALES_KEY, serializeOperationLegSales({
    ym: '2026-07',
    byUnko: { [UNKO]: [{ seq: 1, customers: [], slipIds: [ROW_ID] }] },
  }))
  fetchDriverDailySlipsMock.mockResolvedValue([slip(amount)])
  const w = mount(ProfitPanel, {
    props: {
      unkoNo: UNKO,
      driverCd: '0123',
      range: { fromTs: LEG1_TS, toTs: LEG2_TS + 3600 },
      location: { originCity: '釧路市', destCity: '上士幌町' },
      summary: {
        distanceKm: 10,
        durationMin: 60,
        byCategory: { drive: 30, loading: 0, unloading: 0, rest: 0, idle: 0, other: 0 },
        rowCount: 3,
      },
      legs: [{
        loadRowIndex: 0,
        unloadRowIndexes: [],
        originCity: '北海道釧路市西港1-98-41',
        destCity: '',
        viaCities: [],
        fromTs: LEG1_TS,
        toTs: null,
      }],
    },
    global: { stubs: { UIcon: UIconStub } },
  })
  await flushPromises()
  const spans = w.findAll('span')
  const map = new Map<string, string>()
  for (const [i, s] of spans.entries()) {
    const next = spans[i + 1]
    if (next) map.set(s.text(), next.text())
  }
  return map
}

beforeEach(() => {
  localStorage.clear()
  fetchDriverDailySlipsMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('収支パネルの金額に `-0` を出さない (Refs #843)', () => {
  it.each([
    ['-0.4 (Math.round が -0 を返す窓)', -0.4],
    ['-0.5 (窓の端。Math.round(-0.5) は -0)', -0.5],
    ['-0.0004 (端数つきの負)', -0.0004],
    ['-4.66e-10 (按分の足し順で出る実際の形)', -4.66e-10],
    ['-0 そのもの', -0],
    ['0 (退行なし)', 0],
  ])('%s → 結んだ売上 0 円 / 円/km 0', async (_name, v) => {
    const values = await labelledValues(v)
    expect(values.get('結んだ売上 (税抜)')).toBe('0 円')
    // -0.4 / 10km = -0.04 → Math.round が -0 を返すもう 1 つの窓
    expect(values.get('円/km')).toBe('0')
  })

  it('陽性対照: 本当に負の額は負のまま (-0.6 → -1 円)', async () => {
    const values = await labelledValues(-0.6)
    expect(values.get('結んだ売上 (税抜)')).toBe('-1 円')
  })

  it('陽性対照: まとまった負の額も消えない (符号ごと潰していない)', async () => {
    const values = await labelledValues(-50000)
    expect(values.get('結んだ売上 (税抜)')).toBe('-50,000 円')
    // -50,000 / 10km = -5,000
    expect(values.get('円/km')).toBe('-5,000')
  })

  it('正の額は 1 円も動かない', async () => {
    const values = await labelledValues(41250)
    expect(values.get('結んだ売上 (税抜)')).toBe('41,250 円')
  })
})
