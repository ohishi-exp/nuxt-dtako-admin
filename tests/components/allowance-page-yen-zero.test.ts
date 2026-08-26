/**
 * 運行手当タブ (`/profit/allowance`) の金額に **`¥-0` を出さない** (Refs #843 / #840)。
 *
 * この画面の `yen()` は収支 (`margin()` = 売上 − 手当) と PDF との差
 * (`screenYen - pdfYen`) を出すので**負になり得る**。0 の回に `¥-0` と出ると
 * 「0 円」なのか「符号が化けた」のか読めない。
 *
 * **ここは描画で確かめる。** `yen` は `<script setup>` のローカルなので、実際に
 * マウントして**画面の文字**を読まないと「直したつもり」しか測れない。
 * 入口は**手当表PDF の帯** — `onMounted` が `PDF_TRIPS_KEY` を読むだけで出るので、
 * 集計 (通信) を 1 回も走らせずに `yen()` の値を運べる。
 *
 * **陽性対照 (`-0.6` → `¥-1`) を必ず置く。** `Math.abs` のような「符号ごと消す」直しでも
 * 通ってしまうテストにしないため。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { PDF_TRIPS_KEY, serializePdfTripFile } from '~/utils/allowance-pdf-compare'

const { getDriversMock } = vi.hoisted(() => ({ getDriversMock: vi.fn() }))

vi.mock('~/utils/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: getDriversMock,
}))

mockNuxtImport('useRoute', () => () => ({ query: {} }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn(), replace: vi.fn() }))

const passthroughStub = { template: '<div><slot /></div>' }

const AllowancePage = (await import('~/pages/profit/allowance.vue')).default

/** 手当表PDF の帯だけを出して、その合計の文字を返す。 */
async function pdfBandTextOf(allowanceYen: number) {
  localStorage.setItem(PDF_TRIPS_KEY, serializePdfTripFile({
    ym: '2026-07',
    trips: [{ driverName: '中村一由', date: '2026-07-01', origin: '帯広', dest: '釧路', allowanceYen }],
  }))
  const w = mount(AllowancePage, {
    global: {
      stubs: {
        NuxtLink: { template: '<a><slot /></a>' },
        DriverSearchSelect: passthroughStub,
        AllowanceOperationModal: { template: '<div />' },
      },
    },
  })
  await flushPromises()
  return w.text()
}

beforeEach(() => {
  getDriversMock.mockReset().mockResolvedValue([])
  vi.stubGlobal('$fetch', vi.fn().mockRejectedValue({ statusCode: 404 }))
  localStorage.clear()
})

describe('運行手当タブの金額に `¥-0` を出さない (Refs #843)', () => {
  it.each([
    // `toLocaleString` の既定は `maximumFractionDigits: 3` なので、**この窓の端数つきの負が
    // まるごと `"-0"` に丸められて出る**。`+ 0` では届かない (`-0.0004` は `-0` ではない)。
    ['-0.0004 (端数つきの負)', -0.0004],
    ['-0.0004999 (窓の内側の端)', -0.0004999],
    ['-4.66e-10 (按分の足し順で出る実際の形)', -4.66e-10],
    // **`-0` そのものはここまで届かない** — `serializePdfTripFile` は `JSON.stringify` で、
    // `JSON.stringify(-0)` は `"0"` になる。直す前でもこの行だけは通る (測定の限界)。
    ['-0 そのもの (JSON を往復すると +0 になる)', -0],
    ['0 (退行なし)', 0],
  ])('%s → ¥0', async (_name, v) => {
    const text = await pdfBandTextOf(v)
    expect(text).toContain('= ¥0 を読み込み済み')
    expect(text).not.toContain('¥-0')
  })

  /**
   * ★ **丸め方を変えていないことの陽性対照** (親の指摘、Refs #843)。
   *
   * この画面は元から丸めていない (`v.toLocaleString()`)。`Math.round` を足して直すと
   * `¥1,234.5` → `¥1,235` と**表示が変わってしまう**。そして**この画面には小数が
   * 実際に入り得る** — 手当表PDF の CSV (`parsePdfAllowanceCsv`) は `Number(rawYen)` と
   * `Number.isFinite` しか見ておらず、整数チェックが無いため。
   *
   * **小数がそのまま出ることを固定する。** これが崩れたら「黙って丸め方を変えた」。
   */
  it.each([
    ['小数はそのまま (正)', 1234.5, '= ¥1,234.5 を読み込み済み'],
    ['小数はそのまま (負)', -1234.5, '= ¥-1,234.5 を読み込み済み'],
    ['端数 3 桁もそのまま', 0.125, '= ¥0.125 を読み込み済み'],
  ])('陽性対照 (丸めていない): %s', async (_name, v, expected) => {
    expect(await pdfBandTextOf(v)).toContain(expected)
  })

  it.each([
    ['-0.4 (窓の外。丸めないので小数のまま)', -0.4, '= ¥-0.4 を読み込み済み'],
    ['-0.6', -0.6, '= ¥-0.6 を読み込み済み'],
    ['-413,000', -413000, '= ¥-413,000 を読み込み済み'],
  ])('陽性対照 (符号を消していない): %s', async (_name, v, expected) => {
    expect(await pdfBandTextOf(v)).toContain(expected)
  })

  it('正の額は 1 円も動かない', async () => {
    expect(await pdfBandTextOf(413000)).toContain('= ¥413,000 を読み込み済み')
  })
})
