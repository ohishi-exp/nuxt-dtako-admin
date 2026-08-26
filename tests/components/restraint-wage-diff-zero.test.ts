/**
 * 拘束時間・賃金 (`/restraint-wage`) 「期間集計」タブの差額に **`-0` を出さない**
 * (Refs #843 / #928)。
 *
 * 差は `paid − calc` (`wage-range-view.ts` の `rangeDiff`)。**`-0` そのものは
 * `fmtDiff` の `v === 0` が拾う** (`-0 === 0` は `true` なので `±0`) が、
 * `toLocaleString` の既定 (`maximumFractionDigits: 3`) が `"-0"` にしてしまう
 * `-0.0005 < v < 0` の端数つきの負は素通りしていた。応答の parse は
 * `Number.isFinite` しか見ておらず整数を強制していないので、端数は入り得る。
 *
 * **ここは描画で確かめる。** `fmtDiff` は `<script setup>` のローカルなので、
 * 実際にマウントして**セルの文字**を読まないと「直したつもり」しか測れない。
 *
 * **陽性対照 (`-0.4` → `-0.4`) を必ず置く** — ここは元から丸めていないので、
 * `Math.round` を足す直しが入ったら落ちる形にする。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS, UIconStub } from '../helpers/stubs'

/**
 * `useState` は Nuxt app instance が要る (`[nuxt] instance unavailable`)。
 * この画面は `useTheearthSession` 経由で使うだけなので、**キーごとの `ref` に置き換える**
 * — セッションの復元は `localStorage` からなので、置き換えても経路は本物のまま。
 */
const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})
mockNuxtImport('useRoute', () => () => ({ query: {}, params: {} }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn(), replace: vi.fn() }))

const Page = (await import('~/pages/restraint-wage.vue')).default

const YM = '2026-07'
const DRIVER_CD = '1412'

/** 期間集計タブが叩く口。他の口は「空」を返して画面を素通りさせる。 */
function wageRangeBody(paidBase: number) {
  return {
    from: '2026-01',
    to: YM,
    restraint_source: 'gcp',
    months: [{ ym: YM, saved: true, drivers: 1, computed_at: '2026-07-31T00:00:00Z', stale: false }],
    rows: [{
      driver_cd: DRIVER_CD,
      driver_name: '甲野太郎',
      company: '01',
      branch_code: 1,
      branch_name: '帯広',
      job_name: '運転手',
      months_counted: 1,
      months_missing: [],
      by_month: {},
      // 差 = 給与 − 計算。calc を 0 に置いて、差そのものを `paidBase` で決める。
      calc_base: 0,
      calc_overtime: 0,
      calc_total: 0,
      paid_base: paidBase,
      paid_overtime: 0,
      working_minutes: 10000,
    }],
  }
}

function makeFetch(paidBase: number) {
  const fetchFn = vi.fn(async (url: unknown) => {
    if (typeof url === 'string' && url.includes('/wage-range')) return wageRangeBody(paidBase)
    return {}
  }) as unknown as { (url: unknown): Promise<unknown>, raw: unknown }
  // 画面は wage-report を `$fetch.raw` で読む (`res._data`)。期間集計タブでは使わないが、
  // 未定義だと別のタブの watcher が TypeError で落ちる。
  fetchFn.raw = vi.fn(async () => ({ _data: null }))
  return fetchFn
}

/**
 * 期間集計タブを開いた状態で描いて、**期間合計の「差合計」セル**の 3 段
 * (基本給 / 残業代 / 合計) の文字を返す。
 *
 * タブと対象月は `sessionStorage`、theearth セッションは `localStorage` から
 * `onMounted` が復元する — 画面の実際の経路をそのまま使う。
 */
async function diffCellLines(paidBase: number): Promise<string[]> {
  sessionStorage.setItem('restraint-wage:tab', 'range')
  sessionStorage.setItem('restraint-wage:month', YM)
  localStorage.setItem('theearth-session', JSON.stringify({
    compId: '0001', userName: 'tester', token: 'tok',
  }))
  vi.stubGlobal('$fetch', makeFetch(paidBase))
  const w = mount(Page, {
    global: {
      stubs: {
        ...NUXT_UI_PAGE_STUBS,
        UCheckbox: { props: ['modelValue'], template: '<input type="checkbox" />' },
        UFormField: { template: '<div><slot /></div>' },
        UInput: { props: ['modelValue'], template: '<input :value="modelValue" />' },
        UModal: { template: '<div />' },
        USelectMenu: { props: ['modelValue'], template: '<select />' },
        UTextarea: { props: ['modelValue'], template: '<textarea />' },
        UIcon: UIconStub,
      },
    },
  })
  await flushPromises()
  await flushPromises()
  const row = w.findAll('tbody tr').find(tr => tr.text().includes('甲野太郎'))
  if (!row) throw new Error(`期間集計の行が描けていない: ${w.text().slice(0, 300)}`)
  const cells = row.findAll('td')
  // 最後の td が「差合計」(計算額 / 給与支払額 / 差合計 の 3 ブロックの右端)
  return cells[cells.length - 1]!.findAll('div').map(d => d.text())
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  nuxtState.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/restraint-wage 期間集計の差額に `-0` を出さない (Refs #843)', () => {
  it.each([
    ['-0.0004 (端数つきの負。toLocaleString が "-0" にする窓)', -0.0004],
    ['-0.0004999 (窓の端)', -0.0004999],
    ['-4.66e-10', -4.66e-10],
  ])('%s → 0 (符号を付けない)', async (_name, v) => {
    const [base, , total] = await diffCellLines(v)
    expect(base).toBe('0')
    expect(total).toBe('0')
  })

  it('`-0` そのものは元から `±0` (v === 0 が拾う。当てていないことの記録)', async () => {
    const [base, overtime, total] = await diffCellLines(-0)
    expect(base).toBe('±0')
    expect(overtime).toBe('±0')
    expect(total).toBe('±0')
  })

  it('0 (退行なし)', async () => {
    const [base] = await diffCellLines(0)
    expect(base).toBe('±0')
  })

  // ★ 陽性対照。**1 件 1 本に割ってある** — `Math.round` を足す直しが入ったときに
  // 「何が壊れたか」が本数で見えるようにするため。
  it.each([
    [-0.4, '-0.4'],
    [-0.5, '-0.5'],
    [-0.6, '-0.6'],
    [0.4, '+0.4'],
    [-1234.5, '-1,234.5'],
  ])('★ 陽性対照: %p は小数のまま %p (`Math.round` を足したら落ちる)', async (v, want) => {
    expect((await diffCellLines(v))[0]).toBe(want)
  })

  it('陽性対照: 本当に負の額は負のまま (符号ごと潰していない)', async () => {
    expect((await diffCellLines(-50000))[0]).toBe('-50,000')
  })

  it('正の額は符号つきのまま 1 円も動かない', async () => {
    expect((await diffCellLines(50000))[0]).toBe('+50,000')
  })
})
