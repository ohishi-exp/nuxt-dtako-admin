/**
 * `/litigation` (訴訟準備) の「エラー」タブ — Refs #1133 c1133-5。
 *
 * ## 何を固定するか
 *
 * 1. ★ **エラータブの操作で `POST /restraint-api/wage-snapshot` が 0 回**
 *    (最低賃金チェックの自動保存を呼ばない)。**陽性対照として、同じ操作で
 *    `GET /restraint-api/wage-report` が 1 回以上出ること**も見る — 何も呼ばずに
 *    通るだけのテストにしないため。`$fetch` と生 `fetch` の**両方**を包んで数える
 * 2. 表の 3 状態 (異常あり / 異常なし / 判定できない) が**セルごとに出し分く**こと —
 *    特に「取れなかった」を「異常なし」と同じ見た目にしない
 * 3. 取り込みボタン: 運行月と翌月を 1 か月ずつ**直列**に、body に comp_id を入れずに呼ぶ。
 *    502 の空 ZIP は失敗にしない。403 は「admin / payroll のみ」と出して翌月を呼ばない
 *
 * 型は `y-time-export-page.test.ts` をなぞる (`~/utils/api` を `vi.mock` + `importOriginal`、
 * `@ippoan/auth-client` を丸ごと差し替え)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api, saved } = vi.hoisted(() => ({
  api: { getDrivers: vi.fn(), getYTimePreview: vi.fn(), getOperations: vi.fn() },
  saved: [] as { blob: Blob, name: string }[],
}))

vi.mock('~/utils/download-blob', () => ({
  downloadBlob: (blob: Blob, name: string) => { saved.push({ blob, name }) },
}))

vi.mock('@ippoan/auth-client', () => ({ useAuth: () => ({ token: { value: 'jwt-token' } }) }))

vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: api.getDrivers,
  getYTimePreview: api.getYTimePreview,
  getOperations: api.getOperations,
}))

/** `useState` は Nuxt app instance が要る (`[nuxt] instance unavailable`)。この画面は
 * `useRestraintSession` (会社IDの引き継ぎ、restraint-wage-diff-zero.test.ts と同型) 経由で
 * 使うだけなので、キーごとの `ref` に置き換える。 */
const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})

import JSZip from 'jszip'
const Page = (await import('~/pages/litigation.vue')).default

const CASE = {
  caseId: 'c1',
  name: 'テスト事件',
  fromMonth: '2025-01',
  toMonth: '2025-02',
  driverCds: ['1078'],
  memo: '',
  createdBy: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}

const OK_INV = {
  hourlyBasis: 'working',
  unaccounted: { diffMinutes: 0, kind: 'other' },
  workingWithinRestraint: true,
  noShiftOverlap: true,
  shiftOverlap: null,
}

interface Call { via: '$fetch' | 'fetch', method: string, url: string, body?: unknown }
/** オンプレのデジタコ運行 (onprem-month-operations) の 2 月の応答に載せる 22 桁 */
let febOnpremOpeNos: string[] = []
/** `GET /restraint-api/litigation-checks` が返す保存済みの結果 */
let storedItems: unknown[] = []
/** 給与大臣の payroll を 403 にする */
let payrollForbidden = false
/** 保存済みの結果の読み込み (GET litigation-checks) を失敗させる / 解けるまで待たせる */
let storeGetFails = false
let storeGetGate: Promise<void> | null = null
/** wage-report の 2025-02 を 504 にする (既定 true。false なら材料が全部そろう) */
let febWageFails = true
/** `GET litigation-cases` が返す案件の updatedAt (保存で変わった状況を作る) */
let caseUpdatedAt = CASE.updatedAt
/** 立てておくと、給与大臣の payroll は勤務月 2025-02 (= 拘束の材料が取れていない月) だけ、この Promise が解けるまで返らない (読込中の表を見る) */
let payrollGate: Promise<void> | null = null
let calls: Call[] = []
const realFetch = globalThis.fetch

/** `$fetch` を URL で振り分けるモック。呼び出しは全部 `calls` に積む。 */
function stubDollarFetch() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string, opts: { method?: string, query?: Record<string, string>, body?: unknown } = {}) => {
    const q = opts.query ?? {}
    calls.push({ via: '$fetch', method: opts.method ?? 'GET', url: `${url}?${new URLSearchParams(q).toString()}`, body: opts.body })
    if (url === '/restraint-api/litigation-checks') {
      if (opts.method === 'PUT') return { saved: 1, checkedAt: '2026-09-29T03:04:00.000Z' }
      if (storeGetGate) await storeGetGate
      if (storeGetFails) throw Object.assign(new Error('store down'), { statusCode: 500 })
      return { items: storedItems }
    }
    if (url === '/restraint-api/viewer-comps') return { comps: ['27324455'] }
    if (url === '/restraint-api/litigation-cases') return { cases: [{ ...CASE, updatedAt: caseUpdatedAt }] }
    if (url === '/restraint-api/kintai/onprem-month-operations') {
      if (q.month === '2025-01') throw Object.assign(new Error('reading-dates が 502'), { statusCode: 502 })
      return { month: q.month, driver_cd: q.driver_cd, ope_nos: febOnpremOpeNos, truncated: false }
    }
    if (url === '/restraint-api/wage-report') {
      if (q.month === '2025-02' && febWageFails) throw Object.assign(new Error('boom'), { statusCode: 504 })
      return {
        month: q.month,
        restraint_source: 'gcp',
        no_data_drivers: [],
        warnings: [],
        rows: [{
          summary: { driverCd: '1078', driverName: '甲野 太郎', workDays: 20, workingMinutes: 9600, overtimeMinutes: 600, overtimeNightMinutes: 0, days: [{ date: '2025-01-10' }] },
          fetched_at: null,
          last_verified_at: null,
          pay_kubun: 2,
          wage: { minutes: { statutory: 9000 }, overtimeMinutes: 600, nightOvertimeMinutes: 0, minWageOvertimePay: null, minWageNightOvertimePay: null },
          invariants: OK_INV,
        }],
      }
    }
    if (url === '/restraint-api/comp-map') {
      return { comps: [{ compId: '27324455', compLabel: '大石運輸倉庫', payrollCompanies: [{ payrollCompany: '0200', legacyLabel: null, payrollCompanyName: null }] }] }
    }
    if (url === '/restraint-api/employee-master') return { employees: [{ company: '0200', payrollCd: '747', name: '甲野 太郎', driverCd: '1078' }] }
    if (url === '/restraint-api/salary-item-config') return { exists: true, data: { items: { 基本給: 'base', 残業手当: 'overtime' } } }
    if (url === '/api/kyuyo/payroll') {
      if (payrollForbidden) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      if (payrollGate && q.month === '2025-02') await payrollGate
      // 勤務月 q.month の翌月に支給 (pay_date が支給月)
      const [y, m] = (q.month as string).split('-').map(Number) as [number, number]
      const pay = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
      return {
        database: 'KYDATA0200_125C',
        rows: [{
          employee_code: '0747', employee_code_key: '747', employee_name: '甲野 太郎', pay_date: `${pay}-25`,
          payments: { 基本給: 200000, 残業手当: 30000 },
          base_rate: 10000, overtime_rate: 1500, totals: { soshikyu: 230000 },
        }],
        warnings: [],
        // 勤務月 2025-01 は保存 (cache) から、2025-02 は給与大臣 (live) から読んだ
        source: q.month === '2025-02' ? 'live' : 'cache',
        synced_at: q.month === '2025-02' ? '2026-09-30T01:00:00Z' : '2026-09-20T01:00:00Z',
      }
    }
    throw new Error(`unexpected $fetch ${url}`)
  }))
}

/** 生 `fetch` (取り込みボタンが使う) を差し替える。 */
function stubFetch(handler: (url: string, body: unknown) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ via: 'fetch', method: init?.method ?? 'GET', url: String(input), body })
    return handler(String(input), body)
  }) as typeof fetch
}

/** 直列の呼び出しが全部返り切るまで回す (取り込みの stub は応答を setTimeout で遅らせるので、
 * microtask だけでは次のテストに漏れる)。 */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 0))
    await flushPromises()
  }
}

function buttonByText(w: VueWrapper, text: string) {
  const b = w.findAll('button').find(x => x.text().trim() === text)
  if (!b) throw new Error(`ボタン「${text}」が無い: ${w.text().slice(0, 300)}`)
  return b
}

async function openErrorsTabAndRun(): Promise<VueWrapper> {
  const w = mount(Page, {
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true, USelectMenu: true } },
  })
  await settle()
  await buttonByText(w, '開く').trigger('click')
  await buttonByText(w, 'エラー').trigger('click')
  await buttonByText(w, '検知を実行').trigger('click')
  await settle()
  return w
}

function cell(w: VueWrapper, row: string, check: string) {
  const td = w.find(`tr[data-row="${row}"] td[data-check="${check}"]`)
  if (!td.exists()) throw new Error(`セルが無い ${row} ${check}`)
  return td.text()
}

beforeEach(() => {
  calls = []
  febOnpremOpeNos = []
  // alc の運行: 2 月に始めた運行が 1 本 (2 名乗務の相方つき) と、前月に始めて 2 月に読み取った運行
  api.getOperations.mockReset()
  api.getOperations.mockResolvedValue({
    operations: [
      { unko_no: '25021000000000000012341' },
      { unko_no: '25021000000000000012342' },
      { unko_no: '25013100000000000012341' },
    ],
    total: 3,
    page: 1,
    per_page: 200,
  })
  storedItems = []
  payrollForbidden = false
  storeGetFails = false
  storeGetGate = null
  febWageFails = true
  payrollGate = null
  caseUpdatedAt = CASE.updatedAt
  saved.length = 0
  localStorage.clear()
  localStorage.setItem('litigation-viewer-comp', '27324455')
  api.getDrivers.mockResolvedValue([{ id: 'd1', driver_cd: '1078', driver_name: '甲野太郎' }])
  // 1 月だけ勤務がある → 2 月は alc に運行 0 件
  api.getYTimePreview.mockResolvedValue({
    driver: { cd: '1078', name: '甲野太郎' },
    period: { from: '2025-01-01', to: '2025-02-28' },
    rows: [{ date: '2025-01-10' }, { date: '2025-01-11' }],
    warnings: [],
  })
  stubDollarFetch()
  stubFetch(() => new Response('{}', { status: 500 }))
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllGlobals()
})

describe('エラータブ: wage-snapshot を呼ばない', () => {
  it('★ 検知の実行で wage-snapshot は 0 回、wage-report (陽性対照) は 1 回以上 — しかも GCP を指定', async () => {
    const w = await openErrorsTabAndRun()
    const snapshot = calls.filter(c => c.url.includes('/restraint-api/wage-snapshot'))
    const report = calls.filter(c => c.url.startsWith('/restraint-api/wage-report'))
    expect(snapshot).toHaveLength(0)
    expect(report.length).toBeGreaterThanOrEqual(1)
    expect(report.map(c => c.url)).toEqual([
      '/restraint-api/wage-report?month=2025-01&source=gcp',
      '/restraint-api/wage-report?month=2025-02&source=gcp',
    ])
    expect(report.every(c => c.method === 'GET')).toBe(true)
    // 取り込み (書き込み) も押していないので呼ばれない
    expect(calls.filter(c => c.url.includes('alc-upload-driver'))).toHaveLength(0)
    w.unmount()
  })
})

describe('エラータブ: 3 状態の出し分け', () => {
  it('★ セルごとに 異常あり / 異常なし / 判定できない を出し、取れなかった月を「異常なし」にしない', async () => {
    const w = await openErrorsTabAndRun()
    expect(api.getYTimePreview).toHaveBeenCalledWith('1078', '2025-01-01', '2025-02-28')
    // alc の運行
    expect(cell(w, '1078|2025-01', 'alcOps')).toContain('異常なし')
    expect(cell(w, '1078|2025-01', 'alcOps')).toContain('勤務日 2 日')
    expect(cell(w, '1078|2025-02', 'alcOps')).toContain('異常あり')
    // alc にあってオンプレのデジタコに無い運行: 1 月はオンプレが 502 → 判定できない (0 件と言わない)
    expect(cell(w, '1078|2025-01', 'unkoGaps')).toContain('判定できない')
    expect(cell(w, '1078|2025-01', 'unkoGaps')).toContain('502')
    expect(cell(w, '1078|2025-02', 'unkoGaps')).toContain('異常あり')
    expect(cell(w, '1078|2025-02', 'unkoGaps')).toContain('オンプレのデジタコに無い運行 1 件: 2502100000000000001234')
    // 最低賃金の不変条件: 2 月は wage-report が 504 → 判定できない
    expect(cell(w, '1078|2025-01', 'invariants')).toContain('異常なし')
    expect(cell(w, '1078|2025-02', 'invariants')).toContain('判定できない')
    // Y時間の欠け: 出力タブ (ZIP) を回していなくても、検知のプレビューで判定する
    expect(cell(w, '1078|2025-01', 'yTime')).toContain('異常なし')
    expect(cell(w, '1078|2025-01', 'yTime')).not.toContain('未実行')
    // 取り込みボタンは alc 0 件の月だけ
    expect(w.find('tr[data-row="1078|2025-02"] [data-testid="litigation-import"]').exists()).toBe(true)
    expect(w.find('tr[data-row="1078|2025-01"] [data-testid="litigation-import"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('エラータブ: Y時間の欠けを ZIP なしで判定する', () => {
  it('★ プレビューの警告で Y時間に入らなかった運行がある月は、ZIP を作らなくても異常あり (他の月は異常なし)', async () => {
    api.getYTimePreview.mockResolvedValue({
      driver: { cd: '1078', name: '甲野太郎' },
      period: { from: '2025-01-01', to: '2025-02-28' },
      rows: [{ date: '2025-01-10' }, { date: '2025-01-11' }],
      warnings: ['2502030000000000001234: departure_at/return_at が不足、skip', '2025-01-10: 複数 segment 結合 (1 行に集約)'],
    })
    const w = await openErrorsTabAndRun()
    expect(cell(w, '1078|2025-02', 'yTime')).toContain('異常あり')
    expect(cell(w, '1078|2025-02', 'yTime')).toContain('2502030000000000001234 (出庫/帰庫が無い)')
    // 「複数 segment 結合」は欠けではない (陰性対照)
    expect(cell(w, '1078|2025-01', 'yTime')).toContain('異常なし')
    w.unmount()
  })
})

describe('エラータブ: alc とオンプレのデジタコの突き合わせ', () => {
  it('★ alc は読取日で「始めた月〜翌月末」を引き、始めた月の運行だけをオンプレと 22 桁で突き合わせる', async () => {
    febOnpremOpeNos = ['2502100000000000001234']
    const w = await openErrorsTabAndRun()
    expect(api.getOperations).toHaveBeenCalledWith({ driver_cd: '1078', date_from: '2025-02-01', date_to: '2025-03-31', page: 1, per_page: 200 })
    expect(calls.map(c => c.url)).toContain('/restraint-api/kintai/onprem-month-operations?month=2025-02&driver_cd=1078')
    // 前月に始めた運行 (2501…) は 2 月の突き合わせに入らない。タイムカード (勤怠) の口は呼ばない
    expect(cell(w, '1078|2025-02', 'unkoGaps')).toContain('オンプレのデジタコに無い運行なし (alc 1 件・オンプレ 1 件)')
    expect(calls.filter(c => c.url.includes('/kintai/unko-gaps') || c.url.includes('/kintai/refresh/timecard'))).toHaveLength(0)
    expect(w.text()).not.toContain('照合先なし')
    w.unmount()
  })

  it('alc の運行が 200 件を超えるときはページを回し切る', async () => {
    api.getOperations
      .mockResolvedValueOnce({ operations: [{ unko_no: '25010100000000000012341' }], total: 201, page: 1, per_page: 200 })
      .mockResolvedValueOnce({ operations: [{ unko_no: '25010200000000000012341' }], total: 201, page: 2, per_page: 200 })
    const w = await openErrorsTabAndRun()
    expect(api.getOperations.mock.calls.slice(0, 2).map(c => (c[0] as { page: number }).page)).toEqual([1, 2])
    w.unmount()
  })
})

describe('取り込みボタン', () => {
  it('★ 運行月と翌月を 1 本ずつ直列に、comp_id を body に入れずに呼ぶ。502 の空 ZIP は「運行なし」', async () => {
    let inflight = 0
    let maxInflight = 0
    stubFetch(async (_url, body) => {
      // 応答を 1 tick 遅らせる — 直列なら同時に 1 本、並列に撃つと 2 本が重なる
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      await new Promise(r => setTimeout(r, 0))
      inflight--
      const b = body as { from: string }
      return b.from === '2025-02-01'
        ? Response.json({ ok: true, operations_count: 3, split_failed: 0 }, { status: 200 })
        : Response.json({ error: '取得したデータが空の ZIP です (22 bytes) — その読取日に theearth 側のデータがありません' }, { status: 502 })
    })
    const w = await openErrorsTabAndRun()
    const before = api.getYTimePreview.mock.calls.length
    await w.find('tr[data-row="1078|2025-02"] [data-testid="litigation-import"]').trigger('click')
    await settle()
    const posts = calls.filter(c => c.url === '/restraint-api/litigation/alc-upload-driver')
    expect(posts.map(c => c.body)).toEqual([
      { driver_cd: '1078', from: '2025-02-01', to: '2025-02-28' },
      { driver_cd: '1078', from: '2025-03-01', to: '2025-03-31' },
    ])
    expect(posts.every(c => c.method === 'POST')).toBe(true)
    expect(maxInflight).toBe(1)
    const results = w.findAll('tr[data-row="1078|2025-02"] [data-testid="litigation-import-result"]').map(r => r.text())
    expect(results).toEqual([
      '読取日 2025-02-01〜2025-02-28: 取り込み 3 件',
      '読取日 2025-03-01〜2025-03-31: その期間に運行なし (theearth にも無い)',
    ])
    // 取り込めたので、その月だけ読み直す
    expect(api.getYTimePreview.mock.calls.slice(before)).toEqual([['1078', '2025-02-01', '2025-02-28']])
    expect(calls.filter(c => c.url.includes('/restraint-api/wage-snapshot'))).toHaveLength(0)
    w.unmount()
  })

  it('★ 403 は「取り込みは admin / payroll のみ」と出し、翌月は呼ばない・読み直さない', async () => {
    stubFetch(() => Response.json({ error: '取り込みは admin / payroll のみ実行できます' }, { status: 403 }))
    const w = await openErrorsTabAndRun()
    const before = api.getYTimePreview.mock.calls.length
    await w.find('tr[data-row="1078|2025-02"] [data-testid="litigation-import"]').trigger('click')
    await settle()
    expect(calls.filter(c => c.url === '/restraint-api/litigation/alc-upload-driver')).toHaveLength(1)
    expect(w.find('tr[data-row="1078|2025-02"] [data-testid="litigation-import-result"]').text())
      .toBe('読取日 2025-02-01〜2025-02-28: 取り込みは admin / payroll のみ')
    expect(api.getYTimePreview.mock.calls.length).toBe(before)
    w.unmount()
  })
})

describe('出力タブの ZIP に エラー一覧.csv が入らない', () => {
  it('★ ZIP のキーは xlsx と 変更記録.csv だけ (エラー一覧.csv は入らない)', async () => {
    stubFetch((url) => {
      if (url !== '/api/y-time-export') throw new Error(`unexpected fetch ${url}`)
      return new Response('xlsx-bytes', {
        status: 200,
        headers: { 'x-y-time-rows': '5', 'x-y-time-missing-dates': '2025-02-03', 'x-y-time-missing-count': '1' },
      })
    })
    const w = mount(Page, {
      global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true, USelectMenu: true } },
    })
    await settle()
    await buttonByText(w, '開く').trigger('click')
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(saved).toHaveLength(1)
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(['1078_2025-01-2025-02.xlsx', '変更記録.csv'])
    // エラータブを開いていないので wage-report も wage-snapshot も呼ばない
    expect(calls.filter(c => c.url.includes('/restraint-api/wage-'))).toHaveLength(0)
    w.unmount()
  })

  it('Excel が 0 冊でも 変更記録.csv だけの ZIP を保存し、成功の見た目にしない', async () => {
    stubFetch(() => new Response('', { status: 200, headers: { 'x-y-time-rows': '0' } }))
    const w = mount(Page, {
      global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true, USelectMenu: true } },
    })
    await settle()
    await buttonByText(w, '開く').trigger('click')
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    expect(Object.keys(zip.files)).toEqual(['変更記録.csv'])
    const alerts = w.findAllComponents({ name: 'UAlert' })
    expect(alerts.map(a => a.props('color'))).toEqual(['error'])
    expect(alerts[0]!.text()).toContain('変更記録.csv だけを入れて保存しました')
    w.unmount()
  })
})

describe('エラータブ: 検知結果の保存と続きから', () => {
  function mountAndOpen() {
    return (async () => {
      const w = mount(Page, {
        global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true, USelectMenu: true } },
      })
      await settle()
      await buttonByText(w, '開く').trigger('click')
      await buttonByText(w, 'エラー').trigger('click')
      await settle()
      return w
    })()
  }

  it('★ 取れた結果をステップごとに保存する (wage-report は乗務員ぶんだけ切り出す)', async () => {
    const w = await openErrorsTabAndRun()
    const puts = calls.filter(c => c.url.startsWith('/restraint-api/litigation-checks') && c.method === 'PUT')
    const items = puts.flatMap(c => (c.body as { caseId: string, items: { kind: string, key: string, payload: unknown }[] }).items.map(it => ({ ...it, caseId: (c.body as { caseId: string }).caseId })))
    expect(items.every(it => it.caseId === 'c1')).toBe(true)
    expect(items.map(it => `${it.kind} ${it.key}`)).toEqual([
      'alcOps 1078|2025-01', 'alcOps 1078|2025-02',
      'unkoGaps 1078|2025-01', 'unkoGaps 1078|2025-02',
      'wageReport 1078|2025-01', 'wageReport 1078|2025-02',
    ])
    // 勤怠に無い運行は受け側の応答そのまま、失敗は理由ごと
    // alc とオンプレの 22 桁の一覧をそのまま残す
    expect(items[3]!.payload).toEqual({ ok: true, value: { alc: ['2502100000000000001234'], onprem: [], onpremTruncated: false } })
    expect(items[5]!.payload).toMatchObject({ ok: false })
    // 保存時刻が行に出る
    expect(w.find('tr[data-row="1078|2025-01"] [data-testid="litigation-row-checked-at"]').text()).toContain('9/29')
    w.unmount()
  })

  it('★ 開き直すと前回の結果を出し、「続きから」は取れていない分だけ回す', async () => {
    const at = '2026-09-28T01:00:00.000Z'
    const rep = { ok: true, value: { month: '2025-01', restraint_source: 'gcp', no_data_drivers: [], warnings: [], rows: [{ summary: { driverCd: '1078', workDays: 20 }, wage: {}, invariants: OK_INV }] } }
    storedItems = [
      { kind: 'alcOps', key: '1078|2025-01', payload: { ok: true, days: 2, dropped: [] }, checkedAt: at },
      { kind: 'alcOps', key: '1078|2025-02', payload: { ok: true, days: 0, dropped: [] }, checkedAt: at },
      { kind: 'unkoGaps', key: '1078|2025-01', payload: { ok: true, value: { alc: ['a'], onprem: ['a'] } }, checkedAt: at },
      { kind: 'unkoGaps', key: '1078|2025-02', payload: { ok: false, reason: '502 …' }, checkedAt: at },
      { kind: 'wageReport', key: '1078|2025-01', payload: rep, checkedAt: at },
    ]
    api.getYTimePreview.mockClear()
    const w = await mountAndOpen()
    // 検知を押さなくても前回の結果が出る
    expect(cell(w, '1078|2025-01', 'unkoGaps')).toContain('異常なし')
    expect(cell(w, '1078|2025-01', 'invariants')).toContain('異常なし')
    expect(cell(w, '1078|2025-02', 'unkoGaps')).toContain('判定できない')
    expect(cell(w, '1078|2025-02', 'invariants')).toContain('未実行')
    expect(api.getYTimePreview).not.toHaveBeenCalled()
    // 取れていないのは 2 月のデジタコの突き合わせと 2 月の最低賃金の 2 件
    calls = []
    await buttonByText(w, '続きから (2 件)').trigger('click')
    await settle()
    expect(api.getYTimePreview).not.toHaveBeenCalled()
    expect(calls.filter(c => c.method === 'GET' && !c.url.startsWith('/restraint-api/litigation-checks')).map(c => c.url)).toEqual([
      '/restraint-api/kintai/onprem-month-operations?month=2025-02&driver_cd=1078',
      '/restraint-api/wage-report?month=2025-02&source=gcp',
    ])
    expect(cell(w, '1078|2025-02', 'unkoGaps')).toContain('異常あり')
    // 全部やり直すボタンもある (前回の結果がある時の文言)
    expect(buttonByText(w, '検知を全部やり直す').exists()).toBe(true)
    w.unmount()
  })

  it('保存済みの結果を読めなくても画面は壊れず、検知は回せる', async () => {
    const orig = (globalThis as { $fetch: (...a: unknown[]) => unknown }).$fetch
    vi.stubGlobal('$fetch', vi.fn(async (url: string, opts: { method?: string } = {}) => {
      if (url === '/restraint-api/litigation-checks' && (opts.method ?? 'GET') === 'GET') throw Object.assign(new Error('x'), { statusCode: 502 })
      return orig(url, opts)
    }))
    const w = await mountAndOpen()
    expect(w.find('[data-testid="litigation-errors-store-error"]').text()).toContain('保存済みの検知結果を読めませんでした')
    expect(buttonByText(w, '検知を実行').attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})

describe('出力タブ: ZIP に入るものの概要', () => {
  it('★ 作る前から、Excel は「まだ」・変更記録.csv は中身の要点つきで並ぶ', async () => {
    const w = mount(Page, {
      global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true, USelectMenu: true } },
    })
    await settle()
    await buttonByText(w, '開く').trigger('click')
    await settle()
    const summary = w.find('[data-testid="litigation-zip-summary"]')
    expect(summary.text()).toContain('ZIP に入るもの')
    expect(summary.find('[data-zip-file="1078_2025-01-2025-02.xlsx"]').text()).toContain('まだ')
    expect(summary.find('[data-zip-file="エラー一覧.csv"]').exists()).toBe(false)
    expect(summary.find('[data-zip-file="変更記録.csv"]').text()).toContain('空の表')
    w.unmount()
  })
})

describe('給与比較タブ', () => {
  /** エラータブで検知を回した状態 (まだ給与比較タブは開いていない) */
  const openAfterChecks = () => openErrorsTabAndRun()
  async function openSalaryTab(w: VueWrapper) {
    await buttonByText(w, '給与比較').trigger('click')
    await settle()
  }
  const payrollCalls = () => calls.filter(c => c.url.startsWith('/api/kyuyo/payroll')).map(c => c.url)
  const payrollNote = (w: VueWrapper, row: string) => w.find(`[data-salary-row="${row}"] [data-salary-payroll]`)
  const summary = (w: VueWrapper) => w.find('[data-testid="litigation-salary-summary"]').text()

  it('★ タブを開くだけで (ボタンを押さずに) 明細を読む。給与大臣へは勤務月で問い合わせ、翌月支給の明細と エラータブの拘束で比べる', async () => {
    const w = await openAfterChecks()
    // 別のタブに居るあいだは呼ばれない
    expect(payrollCalls()).toEqual([])
    calls = []
    await openSalaryTab(w)
    expect(payrollCalls()).toEqual([
      '/api/kyuyo/payroll?company=0200&month=2025-01',
      '/api/kyuyo/payroll?company=0200&month=2025-02',
    ])
    // 給与コード 747 は社員マスタで 1078 に引き当たる。日額 10,000 × 20 日 = 200,000 で差 0
    const jan = w.find('[data-salary-row="1078|2025-01"]').text()
    expect(jan).toContain('比較済み')
    expect(jan).toContain('(2025-02)')
    expect(jan).toContain('200,000 / 200,000 / 0')
    // 残業は 1,500 円 × 10 h = 15,000 に対して明細 30,000 → +15,000
    expect(jan).toContain('30,000 / 15,000 / +15,000')
    // 2 月は wage-report が 504 だったので比べない (0 と言わない)
    expect(w.find('[data-salary-row="1078|2025-02"]').text()).toContain('拘束の材料が取れていない')
    // 給与の書き込み口 (sync) は叩かない
    expect(calls.filter(c => c.url.includes('/api/kyuyo/sync'))).toHaveLength(0)
    w.unmount()
  })

  it('★ 二重に読まない: 別タブへ行って戻っても、読み終えていれば呼ばない。ボタンは読み直し', async () => {
    const w = await openAfterChecks()
    await openSalaryTab(w)
    expect(payrollCalls()).toHaveLength(2)
    await buttonByText(w, '変更記録').trigger('click')
    await openSalaryTab(w)
    expect(payrollCalls()).toHaveLength(2)
    await buttonByText(w, '給与大臣から読み直す').trigger('click')
    await settle()
    expect(payrollCalls()).toHaveLength(4)
    w.unmount()
  })

  it('★ 明細の状況を行ごとに出す: 材料が取れていない行でも 未読込 → 読込中 → 読込済み と変わり、集計行に 読込済み N / M か月', async () => {
    const w = await openAfterChecks()
    let release!: () => void
    payrollGate = new Promise<void>((r) => { release = r })
    await openSalaryTab(w)
    // 2 か月目 (2025-03 支給) を読んでいる最中。1 か月目 (材料が有る行) は message が「読めた」を言う
    expect(payrollNote(w, '1078|2025-02').text()).toBe('明細: 読込中')
    expect(payrollNote(w, '1078|2025-01').exists()).toBe(false)
    expect(summary(w)).toContain('明細 読込済み 1 / 2 か月')
    expect(w.find('[data-testid="litigation-salary-progress"]').text()).toContain('2 / 2')
    release()
    await settle()
    expect(payrollNote(w, '1078|2025-02').text()).toBe('明細: 読込済み')
    // 材料が有って明細まで進んだ行は message 側が言うので、この 1 行は出さない
    expect(payrollNote(w, '1078|2025-01').exists()).toBe(false)
    expect(summary(w)).toContain('明細 読込済み 2 / 2 か月')
    // 読み終えたら 読込中 は残らない
    expect(w.find('[data-testid="litigation-salary-table"]').text()).not.toContain('読込中')
    w.unmount()
  })

  it('★ 読んでいる最中に案件を閉じて開き直しても、読込中は残らず、開き直したタブでもう一度読む (二重に走らない・古い案件の空 Map を見ない)', async () => {
    const w = await openAfterChecks()
    let release!: () => void
    payrollGate = new Promise<void>((r) => { release = r })
    await openSalaryTab(w)
    expect(payrollNote(w, '1078|2025-02').text()).toBe('明細: 読込中')
    await buttonByText(w, '閉じる').trigger('click')
    await buttonByText(w, '開く').trigger('click')
    await settle()
    // 開き直した直後は出力タブ。給与比較タブではないので、まだ読まない
    await buttonByText(w, '給与比較').trigger('click')
    await settle()
    expect(w.find('[data-testid="litigation-salary-table"]').text()).not.toContain('読込中の')
    release()
    await settle()
    expect(w.find('[data-testid="litigation-salary-table"]').text()).not.toContain('読込中')
    // 古い読み込みは捨てられ、開き直した側が 1 回だけ読み直して 2 / 2
    expect(summary(w)).toContain('明細 読込済み 2 / 2 か月')
    expect(payrollCalls().filter(u => u.endsWith('month=2025-01'))).toHaveLength(2)
    w.unmount()
  })

  it('★ 給与比較タブに居たまま案件が更新されたら (updatedAt が変わる)、空にした Map を見て 1 回だけ読み直す (watch の宣言順)', async () => {
    const w = await openAfterChecks()
    await openSalaryTab(w)
    expect(payrollCalls()).toHaveLength(2)
    caseUpdatedAt = '2026-09-02T00:00:00Z'
    await buttonByText(w, '編集').trigger('click')
    await buttonByText(w, '保存').trigger('click')
    await settle()
    // 更新で明細は空に戻り、給与比較タブに居るので自動で読み直す。古い Map を見て読まない / 二重に読むことはしない
    expect(payrollCalls()).toHaveLength(4)
    expect(summary(w)).toContain('明細 読込済み 2 / 2 か月')
    w.unmount()
  })

  it('★ 失敗 (権限なし) の後は自動で再試行しない。ボタンで読み直す', async () => {
    payrollForbidden = true
    const w = await openAfterChecks()
    await openSalaryTab(w)
    expect(w.find('[data-testid="litigation-salary-error"]').text()).toContain('給与を見る権限がありません')
    expect(payrollCalls()).toHaveLength(1)
    // タブを離れて戻っても、失敗のままなら呼ばない
    await buttonByText(w, '変更記録').trigger('click')
    await openSalaryTab(w)
    expect(payrollCalls()).toHaveLength(1)
    await buttonByText(w, '給与大臣から読み直す').trigger('click')
    await settle()
    expect(payrollCalls()).toHaveLength(2)
    w.unmount()
  })
  it('★ 明細の出どころ: 行の支給月の下に 保存 / 給与大臣 を出し、集計行に数を出す (読んでいない月は出さない)', async () => {
    const w = await openAfterChecks()
    let release!: () => void
    payrollGate = new Promise<void>((r) => { release = r })
    await openSalaryTab(w)
    expect(w.find('[data-salary-row="1078|2025-01"] [data-salary-source]').text()).toContain('サーバー保存')
    expect(w.find('[data-salary-row="1078|2025-02"] [data-salary-source]').exists()).toBe(false)
    release()
    await settle()
    expect(w.find('[data-salary-row="1078|2025-01"] [data-salary-source]').text()).toMatch(/2026\/09\/20.*\(サーバー保存\)/)
    expect(w.find('[data-salary-row="1078|2025-02"] [data-salary-source]').text()).toMatch(/2026\/09\/30.*\(給与大臣から取得\)/)
    expect(summary(w)).toContain('(サーバー保存 1・給与大臣から取得 1)')
    w.unmount()
  })

  /** 検知を回さずに給与比較タブを開く (材料は未取得) */
  async function openSalaryTabDirect(): Promise<VueWrapper> {
    const w = mount(Page, {
      global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true, USelectMenu: true } },
    })
    await settle()
    await buttonByText(w, '開く').trigger('click')
    await openSalaryTab(w)
    return w
  }
  const wageCalls = () => calls.filter(c => c.url.startsWith('/restraint-api/wage-report'))
  const materialsBtn = (w: VueWrapper) => w.find('[data-testid="litigation-salary-materials-run"]')

  it('★ 材料が未取得なら「拘束の材料を取る」を出し、タブを開いただけでは wage-report を呼ばない。押すと取れた月から比較済みになる', async () => {
    febWageFails = false
    const w = await openSalaryTabDirect()
    expect(wageCalls()).toHaveLength(0)
    expect(w.find('[data-salary-row="1078|2025-01"]').text()).toContain('拘束の材料が未取得 (9/29 以前の古い形の保存も含む)')
    expect(materialsBtn(w).exists()).toBe(true)
    expect(materialsBtn(w).attributes('disabled')).toBeUndefined()
    await materialsBtn(w).trigger('click')
    await settle()
    expect(wageCalls().length).toBeGreaterThan(0)
    expect(w.find('[data-salary-row="1078|2025-01"]').text()).toContain('比較済み')
    // 全部そろったらボタンは消える
    expect(materialsBtn(w).exists()).toBe(false)
    w.unmount()
  })

  it('★ 走っている間は進捗を給与比較タブにも出す', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const w = await openSalaryTabDirect()
    const realStub = globalThis.$fetch
    const orig = vi.mocked(realStub)
    vi.stubGlobal('$fetch', vi.fn(async (url: string, opts: never) => {
      if (url === '/restraint-api/wage-report') await gate
      return (orig as unknown as (u: string, o: unknown) => Promise<unknown>)(url, opts)
    }))
    await materialsBtn(w).trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="litigation-salary-materials-progress"]').text()).toContain('検知を実行中')
    release()
    await settle()
    expect(w.find('[data-testid="litigation-salary-materials-progress"]').exists()).toBe(false)
    w.unmount()
  })

  it('★ 保存済みの結果の読み込みに失敗したら、ボタンは disabled でその文を出す (全件取り直しが走らない)', async () => {
    storeGetFails = true
    const w = await openSalaryTabDirect()
    expect(materialsBtn(w).attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="litigation-salary-materials-error"]').text()).toContain('保存済みの検知結果を読めませんでした')
    await materialsBtn(w).trigger('click')
    await settle()
    expect(wageCalls()).toHaveLength(0)
    w.unmount()
  })

  it('★ 保存済みの結果を読み込み中はボタンが disabled', async () => {
    let release!: () => void
    storeGetGate = new Promise<void>((r) => { release = r })
    const w = mount(Page, {
      global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true, USelectMenu: true } },
    })
    await settle()
    await buttonByText(w, '開く').trigger('click')
    await openSalaryTab(w)
    expect(materialsBtn(w).attributes('disabled')).toBeDefined()
    await materialsBtn(w).trigger('click')
    expect(wageCalls()).toHaveLength(0)
    release()
    await settle()
    expect(materialsBtn(w).attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('★ 材料が全部そろっている案件ではボタンを出さない', async () => {
    febWageFails = false
    const w = await openAfterChecks()
    await openSalaryTab(w)
    expect(materialsBtn(w).exists()).toBe(false)
    w.unmount()
  })
})
