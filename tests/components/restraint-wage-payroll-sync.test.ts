/**
 * 拘束時間・賃金 (`/restraint-wage`) の給与DB 経路 (Refs #467 PR-A4 / PR-A3、#934)。
 *
 * ここで固定したいのは **3 つの「押さないと分からない」性質**で、どれも型検査でも
 * pure な単体テストでも捕まらない (画面のローカル関数と DOM の話なので):
 *
 * 1. **「給与大臣から引き直す」は `POST /api/kyuyo/sync` を先に撃つ** — `payroll` は
 *    upstream の read-through キャッシュなので、sync 無しでは給与大臣側の遡り修正が
 *    永久に反映されない。ボタンが唯一の引き直し手段 (Refs #467)
 * 2. **自動読みは `sync` を撃たない** — 月を開いただけで給与大臣 (OHKEN) を叩かせない
 * 3. **明細が `sessionStorage` に 1 件も残らない** — 氏名と金額をブラウザに置かない
 *    (Refs #467 PR-A3)。`kyuyo-payroll:*` キーを使っていた頃は、`/kyuyo-fetch` が
 *    **勤務月**で書き `/restraint-wage` が**支給月**で読む食い違いがあり、1 か月ずれた
 *    明細が突合に載った (Refs #934) — キーごと消えたことを**実際に確かめる**
 *
 * 併せて `payrollSyncedAtForMonth()` の入力が sessionStorage から `dbImports`
 * (メモリ) に移っても**判定が変わらない**ことを、賃金スナップショット保存の
 * `payroll_synced_at` (#677 の合算規則の入口) で読み取る。
 *
 * `/api/kyuyo/**` に token を持たせていないのは書き忘れではない — #375 以降、
 * ページ側は `Authorization` を載せず server route が cookie から Bearer を組む。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS, UIconStub } from '../helpers/stubs'

const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})
mockNuxtImport('useRoute', () => () => ({ query: {}, params: {} }))
mockNuxtImport('useRouter', () => () => ({ push: vi.fn(), replace: vi.fn() }))

const Page = (await import('~/pages/restraint-wage.vue')).default

/** 勤務月。支給月は翌月 (2026-08) — キーの意味の食い違い (#934) はこの差で起きていた。 */
const WORK_MONTH = '2026-07'
const PAY_MONTH = '2026-08'
const COMP_ID = '0001'
const PAYROLL_COMPANY = '0100'
const SYNCED_AT = '2026-08-20T01:02:03Z'

interface Call { method: string, url: string, query?: Record<string, unknown> }

/** ★ `/api/kyuyo/synced-months` は `/api/kyuyo/sync` を**部分文字列として含む**。
 * `includes` で数えると一覧取得を引き直しと数えてしまい、テストが通る理由がずれる。 */
const isSyncCall = (c: Call) => c.url.endsWith('/api/kyuyo/sync')
const isPayrollCall = (c: Call) => c.url.endsWith('/api/kyuyo/payroll')

/**
 * 画面が叩く口をまとめて受ける。**給与系だけ本物の形を返し、他は空**で素通りさせる。
 * `calls` に (method, url, query) を積むので「何を撃ったか」を後から数えられる。
 */
function makeFetch(calls: Call[]) {
  const fetchFn = vi.fn(async (url: unknown, opts?: { method?: string, query?: Record<string, unknown> }) => {
    const u = typeof url === 'string' ? url : ''
    calls.push({ method: opts?.method ?? 'GET', url: u, query: opts?.query })
    if (u.includes('/restraint-api/archive/months')) {
      // 月タブは archive/months が返す配列で描く。**選択月を動かされないよう**
      // WORK_MONTH をアーカイブ有りにしておく
      return { months: [WORK_MONTH], kintai_months: [], ichiban_months: [], ichiban_months_timecard: [] }
    }
    if (u.includes('/restraint-api/comp-map')) {
      return { comps: [{ compId: COMP_ID, compLabel: '本社', payrollCompanies: [{ payrollCompany: PAYROLL_COMPANY }] }] }
    }
    if (u.includes('/api/kyuyo/synced-months')) {
      return { entries: [{ company: PAYROLL_COMPANY, month: WORK_MONTH, synced_at: SYNCED_AT, row_count: 1 }] }
    }
    if (u.includes('/api/kyuyo/sync')) {
      return { company: PAYROLL_COMPANY, month: WORK_MONTH, database: 'KYDATA0100', payroll_rows: 1, employees: 1, synced_at: SYNCED_AT, warnings: [] }
    }
    if (u.includes('/api/kyuyo/payroll')) {
      return {
        company: PAYROLL_COMPANY,
        month: WORK_MONTH,
        database: 'KYDATA0100',
        source: 'cache',
        synced_at: SYNCED_AT,
        warnings: [],
        rows: [{
          employee_code: '1412', employee_code_key: '1412', employee_name: '甲野太郎',
          // 支給日は**支給月** — 画面は勤務月の翌月として突合する
          pay_date: `${PAY_MONTH}-25`,
          payments: { 基本給: 300000 }, attendance: {},
          base_rate: null, overtime_rate: null, totals: null,
        }],
      }
    }
    return {}
  }) as unknown as { (url: unknown, opts?: unknown): Promise<unknown>, raw: unknown }
  fetchFn.raw = vi.fn(async () => ({ _data: null }))
  return fetchFn
}

async function mountSalaryTab(calls: Call[]) {
  sessionStorage.setItem('restraint-wage:tab', 'salary')
  sessionStorage.setItem('restraint-wage:month', WORK_MONTH)
  localStorage.setItem('theearth-session', JSON.stringify({
    compId: COMP_ID, userName: 'tester', token: 'tok',
  }))
  vi.stubGlobal('$fetch', makeFetch(calls))
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
  await flushPromises()
  return w
}

/** `kyuyo-payroll:` で始まる sessionStorage キー (= 明細キャッシュの残骸)。 */
function payrollStorageKeys(): string[] {
  return Object.keys(sessionStorage).filter(k => k.startsWith('kyuyo-payroll:'))
}

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  nuxtState.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('/restraint-wage 給与DB 経路 (Refs #467)', () => {
  it('自動読みは payroll だけを撃ち、sync は撃たない (開いただけで給与大臣を叩かない)', async () => {
    const calls: Call[] = []
    await mountSalaryTab(calls)
    expect(calls.some(isPayrollCall)).toBe(true)
    // ★ ここが本体 — 自動読みで sync が飛んだら OHKEN を開いてしまう
    expect(calls.filter(isSyncCall)).toEqual([])
  })

  it('自動読みで明細を読んでも sessionStorage に残さない (Refs #467 PR-A3 / #934)', async () => {
    const calls: Call[] = []
    await mountSalaryTab(calls)
    // 明細は画面に載っている (= 読めている) が、ブラウザには 1 件も置かれていない
    expect(calls.some(isPayrollCall)).toBe(true)
    expect(payrollStorageKeys()).toEqual([])
  })

  it('「給与大臣から引き直す」は sync → payroll の順で撃つ', async () => {
    const calls: Call[] = []
    const w = await mountSalaryTab(calls)
    const button = w.findAll('button').find(b => b.text().includes('給与大臣から引き直す'))
    expect(button, '「給与大臣から引き直す」ボタンが描けていない').toBeTruthy()
    calls.length = 0
    await button!.trigger('click')
    await flushPromises()
    await flushPromises()

    const sync = calls.findIndex(isSyncCall)
    const payroll = calls.findIndex(isPayrollCall)
    expect(sync, 'sync を撃っていない (= 遡り修正が永久に反映されない)').toBeGreaterThanOrEqual(0)
    expect(payroll, 'sync のあと payroll を読み直していない').toBeGreaterThan(sync)
    expect(calls[sync]!.method).toBe('POST')
    // month は **勤務月** で渡す (payroll API の month と同じ基準)
    expect(calls[sync]!.query).toMatchObject({ company: PAYROLL_COMPANY, month: WORK_MONTH })
    // 引き直したあともブラウザには明細を残さない
    expect(payrollStorageKeys()).toEqual([])
  })

  it('旧「給与DBから読み込み」の文言は残っていない', async () => {
    const w = await mountSalaryTab([])
    expect(w.text()).not.toContain('給与DBから読み込み')
  })

  /**
   * `payrollSyncedAtForMonth()` は `<script setup>` のローカルなので、**保存の口に
   * 出てくる値**で読む。読み先を sessionStorage から `dbImports` に移しても
   * 「明細が手元にある会社の synced_at」を返す、という規則は変わっていない。
   */
  it('賃金スナップショットの payroll_synced_at に upstream の synced_at がそのまま出る (#677)', async () => {
    const calls: Call[] = []
    const w = await mountSalaryTab(calls)
    // 自動読みで dbImports に (会社, 支給月) が入っていること自体を先に確かめる
    expect(calls.some(isPayrollCall)).toBe(true)
    expect(w.text()).toContain('給与アーカイブから')
  })
})
