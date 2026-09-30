/**
 * 拘束×賃金 最低賃金チェック: 「⚠ 単価未設定 … (単価マスタタブで登録してください)」の 1 行を
 * 共通の「直し方」パネル (MinWageFixesPanel、訴訟準備・給与比較と同じ部品) に置き換えた配線 (Refs #1133)。
 * パネルの中身 (集計・dryRun→確定) は litigation-errors-tab.test.ts と tests/utils/min-wage-fix.test.ts が
 * 押さえている。ここは **この画面の入力 (wage-report の行) と ③ (読み直し) の中身** を測る。
 * 値は fixture (架空) を 1 行だけ書き換える。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS, UIconStub } from '../helpers/stubs'
import summaries from '../fixtures/restraint-wage/summaries.json'
import goldenRows from '../fixtures/restraint-wage/golden/wage-rows.json'

const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})
mockNuxtImport('useRoute', () => () => ({ query: {}, params: {} }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn(), replace: vi.fn() }))

const Page = (await import('~/pages/restraint-wage.vue')).default

const YM = '2026-07'
const FIRST_CD = goldenRows[0]!.driverCd
const FULL_MIN_WAGE = { rate: 1000, prefecture: '架空県', mapped: true, rateEffectiveFrom: '2025-10-01' }

/** 共有 fixture (`tests/fixtures/restraint-wage/`) の summary と golden の wage を
 * 乗務員CD で突き合わせて wage-report 応答の形に畳む。**表に行が出れば足りる** —
 * この注記は `rows.length` があるときだけ描かれるため。 */
function wageReportBody(patch: Record<string, unknown>) {
  const wageByCd = new Map(goldenRows.map(g => [g.driverCd, g.wage]))
  return {
    month: YM,
    rows: summaries
      .filter(s => wageByCd.has(s.driverCd))
      .map(s => ({
        summary: s,
        fetched_at: null,
        last_verified_at: null,
        // fixture には単価未設定の乗務員が元から居るので、他の行は単価・最低賃金ありに揃える
        wage: { ...wageByCd.get(s.driverCd), hourlyRate: 1000, minWage: FULL_MIN_WAGE, ...(s.driverCd === FIRST_CD ? patch : {}) },
      })),
    no_data_drivers: [],
    warnings: [],
    restraint_source: 'gcp',
  }
}

let calls: { url: string, method: string, body: unknown }[] = []

/** 最低賃金チェックタブを開いた状態で描く。タブ・対象月は `sessionStorage`、
 * theearth セッションは `localStorage` から `onMounted` が復元する
 * (画面の実際の経路をそのまま使う)。 */
async function mountMinWageTab(patch: Record<string, unknown>) {
  sessionStorage.setItem('restraint-wage:tab', 'minwage')
  sessionStorage.setItem('restraint-wage:month', YM)
  localStorage.setItem('theearth-session', JSON.stringify({
    compId: '0001', userName: 'tester', token: 'tok',
  }))
  const body = wageReportBody(patch)
  // 既定ソースは `gcp` (plain `$fetch`)。`current` は `$fetch.raw` (`res._data`) を通る。
  // **どちらが選ばれても行が出る**ようにしておく (既定が変わってもこのテストは意味を保つ)。
  // wage-report 以外の口は**空だが型の合う形**で返す。素の `{}` を返すと
  // `archiveMonths.value = res.months` のような代入で `undefined` が入り、
  // 月セレクタの `.includes` が落ちる (このタブとは無関係の描画で試験が死ぬ)。
  // ★ 配列を返すべきキーは**必ず配列で**返す (`employees` を落として `{}` にすると
  //    `employeeOrderAttrsByDriver` が `entries is not iterable` で throw し、
  //    **Vue がその subtree の更新を止める** — state は正しいのに DOM だけ
  //    「集計を読み込んでいます…」のまま固まり、注記が無いように見える。
  const EMPTY = {
    months: [], rows: [], items: [], entries: [], employees: [], warnings: [], data: null,
  }
  const reply = (url: unknown) =>
    (typeof url === 'string' && url.includes('/wage-report') ? body
      : typeof url === 'string' && url.includes('/min-wage/import-mhlw') ? { changed: true, prefectures: 12, added: 12, updated: 0, years: { from: '2002-10', to: '2025-10' }, data: { prefectures: {}, branchToPrefecture: {} } }
        : EMPTY)
  const fetchFn = vi.fn(async (url: unknown, opts?: { method?: string, body?: unknown }) => {
    calls.push({ url: String(url), method: opts?.method ?? 'GET', body: opts?.body })
    return reply(url)
  }) as unknown as {
    (url: unknown): Promise<unknown>, raw: unknown
  }
  fetchFn.raw = vi.fn(async (url: unknown) => {
    calls.push({ url: String(url), method: 'GET', body: undefined })
    return { _data: reply(url) }
  })
  vi.stubGlobal('$fetch', fetchFn)

  const w = mount(Page, {
    global: {
      stubs: {
        ...NUXT_UI_PAGE_STUBS,
        // 共有スタブの `UCard` は**既定スロットしか描かない**。最低賃金カードの
        // 説明文は `#header` にあるので、**本物のテンプレートに近づける方向**で
        // ここだけ上書きする (描く量を減らす上書きではない)。
        UCard: { name: 'UCard', template: '<div><slot name="header" /><slot /><slot name="footer" /></div>' },
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
  // `onMounted` が session/tab/month を復元 → watcher が GCP wage-report を撃つ →
  // 応答で表が描かれる、と**段が深い**。1〜2 回の flush では
  // 「集計を読み込んでいます…」のままになる。
  for (let i = 0; i < 8; i++) await flushPromises()
  return w
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  nuxtState.clear()
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const panel = (w: { find: (s: string) => { exists: () => boolean, text: () => string } }) => w.find('[data-testid="min-wage-fixes"]')

describe('/restraint-wage 最低賃金チェック: 単価未設定の行を「直し方」パネルにする (Refs #1133)', () => {
  it('★ 全行に単価と最低賃金があればパネルは出ない (陰性対照)', async () => {
    const w = await mountMinWageTab({ minWage: FULL_MIN_WAGE })
    expect(w.findAll('table.minwage-table').length).toBe(1)
    expect(panel(w).exists()).toBe(false)
  })

  it('★ 単価未設定の乗務員は ② に氏名つきのボタンで出る (期間はこの月)。旧文言「単価マスタタブで登録してください」は出ない。拘束×賃金へのリンクは出さない', async () => {
    const w = await mountMinWageTab({ hourlyRate: null, minWage: FULL_MIN_WAGE })
    expect(panel(w).text()).toContain(`② 単価マスタに単価が無い月 1 件 (${YM})`)
    const btn = w.find('[data-testid="min-wage-rate-master-preview"]')
    expect(btn.text()).toContain(`(${FIRST_CD}) の単価を最低賃金で入れる (${YM})`)
    expect(w.text()).not.toContain('単価マスタタブで登録してください')
    expect(panel(w).text()).not.toContain('拘束×賃金を開く')
  })

  it('★ 最低賃金が引けない行 (県は引けている) は ① の取り込みボタン。押すと共通の口 (history) を叩き、画面のメッセージにも件数が出る', async () => {
    const w = await mountMinWageTab({ minWage: { rate: null, prefecture: '架空県', mapped: false } })
    expect(w.find('[data-testid="min-wage-fix-minwage"]').text()).toContain(`1 件 (${YM})`)
    calls = []
    await w.find('[data-testid="min-wage-fix-import"]').trigger('click')
    for (let i = 0; i < 4; i++) await flushPromises()
    expect(calls.filter(c => c.url.includes('/min-wage/import-mhlw')).map(c => [c.method, c.body])).toEqual([['POST', { source: 'history' }]])
    expect(w.find('[data-testid="min-wage-fix-import-message"]').text()).toContain('厚労省から 12 件を取り込みました (2002-10〜2025-10)')
  })

  it('★ ③ はこの月の集計と単価マスタを読み直す (既存の再読込。キャッシュを使わない)', async () => {
    const w = await mountMinWageTab({ hourlyRate: null, minWage: FULL_MIN_WAGE })
    calls = []
    await w.find('[data-testid="min-wage-fix-retake-button"]').trigger('click')
    for (let i = 0; i < 6; i++) await flushPromises()
    const urls = calls.map(c => c.url)
    expect(urls.some(u => u.includes('/restraint-api/wage-master'))).toBe(true)
    expect(urls.filter(u => u.includes('/wage-report')).length).toBeGreaterThanOrEqual(1)
  })
})
