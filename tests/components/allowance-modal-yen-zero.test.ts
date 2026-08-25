/**
 * 運行手当モーダル (`AllowanceOperationModal.vue`) の金額に **`¥-0` を出さない**
 * (Refs #843 / #840)。
 *
 * 収支の列 (`legMargin` = 売上 − 支払う手当) は**負になり得る** — 同じ画面が
 * `marginYen < 0` で赤字に塗っているのがその証拠。だから 0 の回に `¥-0` と出ると
 * 「0 円」なのか「符号が化けた」のか読めない。
 *
 * **ここは描画で確かめる。** `yen` は `<script setup>` のローカルなので、実際に
 * マウントして**セルの文字**を読まないと「直したつもり」しか測れない。
 *
 * **陽性対照 (`-0.6` → `¥-1`) を必ず置く。** `Math.abs` のような「符号ごと消す」直しでも
 * 通ってしまうテストにしないため — 本当に赤字の便は赤字のまま出なければならない。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AllowanceOperationModal from '~/components/AllowanceOperationModal.vue'
import type { AllowanceReportRow } from '~/utils/allowance-report'
import type { LegReconcile } from '~/utils/allowance-ichiban'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { getOperationCsvMock } = vi.hoisted(() => ({ getOperationCsvMock: vi.fn() }))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getOperationCsv: getOperationCsvMock,
}))

const UNKO_NO = '2607010121120000001318'

function row(over: Partial<AllowanceReportRow> = {}): AllowanceReportRow {
  return {
    unkoNo: UNKO_NO,
    date: '2026-07-01',
    driverName: '西島',
    vehicleName: '1420',
    seq: 1,
    fromTs: null,
    originCity: '帯広市',
    destCity: '釧路市',
    viaCities: '',
    masterDest: '釧路',
    allowanceYen: 0,
    status: 'ok',
    destSource: 'event',
    ...over,
  } as AllowanceReportRow
}

function hit(salesYen: number): LegReconcile {
  return { key: 'k', status: 'matched', slips: [], quantity: 0, salesYen, split: false, fromPool: false }
}

/** 便 1 本ぶんのモーダルを開いて、その行のセルの文字を返す。 */
async function cellsOf(salesYen: number, allowanceYen = 0) {
  const w = mount(AllowanceOperationModal, {
    props: {
      unkoNo: UNKO_NO,
      readingDate: '2026-07-01',
      vehicleName: '1420',
      driverName: '西島',
      error: null,
      entries: [{ row: row({ allowanceYen }), hit: hit(salesYen) }],
      provisional: {},
      excluded: {},
    },
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, NuxtLink: { template: '<a><slot /></a>' } } },
  })
  await flushPromises()
  const tds = w.findAll('tbody tr td').map(td => td.text())
  return {
    /** 売上の列 (`yen(legSales(e))`)。 */
    sales: tds[5],
    /** 収支の列 (`yen(legMargin(e))`)。 */
    margin: tds[6],
    /** 上の合計の帯 (`yen(totals.*)`)。 */
    header: w.find('.mb-2').text(),
    wrapper: w,
  }
}

beforeEach(() => {
  getOperationCsvMock.mockReset()
  getOperationCsvMock.mockResolvedValue({ headers: [], rows: [] })
})

describe('AllowanceOperationModal — 金額に `¥-0` を出さない (Refs #843)', () => {
  it.each([
    ['-0.4 (Math.round が -0 を返す窓)', -0.4],
    ['-0.5 (窓の端。Math.round(-0.5) は -0)', -0.5],
    ['-0.0004 (端数つきの負。丸めずに出すと "-0")', -0.0004],
    ['-0 そのもの', -0],
    ['0 (退行なし)', 0],
  ])('売上・収支とも %s → ¥0', async (_name, v) => {
    const c = await cellsOf(v)
    expect(c.sales).toBe('¥0')
    expect(c.margin).toBe('¥0')
    expect(c.header).toContain('売上 ¥0')
    expect(c.header).toContain('収支 ¥0')
  })

  it('陽性対照: 本当に負の額は負のまま (-0.6 → ¥-1)', async () => {
    const c = await cellsOf(-0.6)
    expect(c.sales).toBe('¥-1')
    expect(c.margin).toBe('¥-1')
    expect(c.header).toContain('収支 ¥-1')
  })

  it('陽性対照: 赤字の便は赤字のまま (売上 0・手当 12,000 → 収支 ¥-12,000、赤で塗る)', async () => {
    const c = await cellsOf(0, 12000)
    expect(c.margin).toBe('¥-12,000')
    expect(c.wrapper.find('.text-red-600').exists()).toBe(true)
  })

  it('正の額は 1 円も動かない', async () => {
    const c = await cellsOf(50000)
    expect(c.sales).toBe('¥50,000')
    expect(c.margin).toBe('¥50,000')
  })
})
