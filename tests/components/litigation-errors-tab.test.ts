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
/** `GET /restraint-api/employee-master` が返す社員マスタ (PUT が成功すると足される) */
let employeeMaster: { company: string, payrollCd: string, name: string, driverCd: string | null, attrs?: Record<string, unknown>[] }[] = []
/** `GET /api/kyuyo/employees` (給与大臣の社員一覧) が返す行。空にすると「その年度に居ない」 */
let kyuyoEmployeeRows: Record<string, unknown>[] = []
let kyuyoEmployeesFails = false
/** 社員マスタの PUT を 500 にする */
let employeePutFails = false
/** `GET /api/kyuyo/synced-months` の応答の entries。null なら失敗 (unexpected) にする */
let syncedEntries: { company: string, month: string }[] | null = null
/** comp-map が返す給与大臣の会社 / 案件の終了月 (並列の検査で会社 × 月を増やす) */
let payrollCompanies = ['0200']
let caseToMonth = CASE.toMonth
/** > 0 なら payroll は非同期にこの ms 待つ (同期スタブだと同時に飛ぶ本数が測れない)。in-flight を数える */
let payrollDelayMs = 0
let payrollInflight = 0
let payrollPeak = 0
/** payroll の開始順 (`会社|勤務月`) と、開始した時点の in-flight 本数 */
let payrollStarts: { key: string, inflight: number }[] = []
/** `会社|勤務月` の payroll を 500 にする */
let payrollFailKey: string | null = null
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
    if (url === '/restraint-api/litigation-cases') return { cases: [{ ...CASE, toMonth: caseToMonth, updatedAt: caseUpdatedAt }] }
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
      return { comps: [{ compId: '27324455', compLabel: '大石運輸倉庫', payrollCompanies: payrollCompanies.map(c => ({ payrollCompany: c, legacyLabel: null, payrollCompanyName: null })) }] }
    }
    if (url === '/restraint-api/employee-master') {
      if (opts.method === 'PUT') {
        if (employeePutFails) throw Object.assign(new Error('d1 down'), { statusCode: 500 })
        const body = opts.body as { employees: typeof employeeMaster, attrs: (Record<string, unknown> & { company: string, payrollCd: string })[] }
        employeeMaster = [...employeeMaster, ...body.employees]
        employeeMaster = employeeMaster.map(e => ({
          ...e,
          attrs: [...(e.attrs ?? []), ...body.attrs.filter(a => a.company === e.company && a.payrollCd === e.payrollCd)],
        }))
        return { ok: true }
      }
      return { employees: employeeMaster.map(e => ({ attrs: [], ...e })) }
    }
    if (url === '/api/kyuyo/employees') {
      if (kyuyoEmployeesFails) throw Object.assign(new Error('kyuyo down'), { statusCode: 502 })
      return { company: q.company, company_name: 'テスト運輸', month: q.month, database: 'KYDATA0200_125C', employees: kyuyoEmployeeRows, warnings: [] }
    }
    if (url === '/restraint-api/salary-item-config') return { exists: true, data: { items: { 基本給: 'base', 残業手当: 'overtime' } } }
    if (url === '/api/kyuyo/synced-months') {
      if (!syncedEntries) throw Object.assign(new Error('synced-months down'), { statusCode: 500 })
      return { entries: syncedEntries.map(e => ({ ...e, row_count: 1, synced_at: '2026-09-20T01:00:00Z' })) }
    }
    if (url === '/api/kyuyo/payroll') {
      if (payrollForbidden) throw Object.assign(new Error('forbidden'), { statusCode: 403 })
      if (payrollGate && q.month === '2025-02') await payrollGate
      if (payrollDelayMs > 0) {
        payrollStarts.push({ key: `${q.company}|${q.month}`, inflight: ++payrollInflight })
        payrollPeak = Math.max(payrollPeak, payrollInflight)
        await new Promise(r => setTimeout(r, payrollDelayMs))
        payrollInflight--
      }
      if (payrollFailKey === `${q.company}|${q.month}`) throw Object.assign(new Error('boom'), { statusCode: 500 })
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
  syncedEntries = null
  payrollCompanies = ['0200']
  caseToMonth = CASE.toMonth
  payrollDelayMs = 0
  payrollInflight = 0
  payrollPeak = 0
  payrollStarts = []
  payrollFailKey = null
  employeeMaster = [{ company: '0200', payrollCd: '747', name: '甲野 太郎', driverCd: '1078' }]
  employeePutFails = false
  kyuyoEmployeesFails = false
  // 給与大臣の同じ会社に、登録対象の 747 (日給) と別人が居る
  kyuyoEmployeeRows = [
    { employee_code: '0747', employee_code_key: '747', employee_name: '甲野太郎', department: '本社', department_code: 3, branch_name: '本社営業所', job_name: '乗務員', taikei: 1, kkubun: 2, hire_date: null, retire_date: null, retired: false },
    { employee_code: '0748', employee_code_key: '748', employee_name: '乙山次郎', department: '本社', taikei: 1, kkubun: 1, retired: false },
  ]
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
    const cell = (key: string) => w.findAll(`[data-salary-row="1078|2025-01"] [data-salary-cell="${key}"] [data-salary-line]`).map(l => l.text())
    expect(cell('base')).toEqual(['明細200,000', '計算200,000', '差0'])
    // 残業は 1,500 円 × 10 h = 15,000 に対して明細 30,000 → +15,000
    expect(cell('overtime')).toEqual(['明細30,000', '計算15,000', '差+15,000'])
    expect(cell('total')).toHaveLength(3)
    // 2 月は wage-report が 504 だったので比べない (0 と言わない)
    expect(w.find('[data-salary-row="1078|2025-02"]').text()).toContain('拘束の材料が取れていない')
    // 給与の書き込み口 (sync) は叩かない
    expect(calls.filter(c => c.url.split('?')[0] === '/api/kyuyo/sync')).toHaveLength(0)
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

  describe('「明細なし」の乗務員をその場で社員マスタに登録する', () => {
    const registerBtns = (w: VueWrapper) => w.findAll('[data-testid="litigation-salary-register-button"]')
    const hint = (w: VueWrapper) => w.find('[data-testid="litigation-salary-register-hint"]')
    const message = (w: VueWrapper) => w.find('[data-testid="litigation-salary-register-message"]').text()
    const employeeCalls = () => calls.filter(c => c.url.startsWith('/restraint-api/employee-master'))

    beforeEach(() => {
      // 給与コード 747 (明細) と乗務員CD 1078 の対応が社員マスタに無い
      employeeMaster = []
      febWageFails = false
    })

    it('★ 氏名が一意に一致すればボタンを出し、押すとその 1 人だけ (金額無し) PUT → 社員マスタを読み直して比較済みになる。明細は読み直さない', async () => {
      const w = await openAfterChecks()
      await openSalaryTab(w)
      expect(w.find('[data-salary-row="1078|2025-01"]').text()).toContain('明細なし')
      expect(registerBtns(w).map(b => b.text())).toEqual(['社員マスタに登録: 747 甲野太郎 (会社 0200) → 乗務員 1078'])
      expect(hint(w).exists()).toBe(false)
      const payrollBefore = payrollCalls().length
      calls = calls.filter(c => !c.url.startsWith('/restraint-api/employee-master'))
      await registerBtns(w)[0]!.trigger('click')
      await settle()
      const puts = employeeCalls().filter(c => c.method === 'PUT')
      expect(puts).toHaveLength(1)
      expect(puts[0]!.body).toEqual({
        employees: [{ company: '0200', payrollCd: '747', name: '甲野太郎', driverCd: '1078', hireDate: null, retireDate: null }],
        attrs: [{ company: '0200', payrollCd: '747', effectiveFrom: '2025-01-01', branch: '本社', payScheme: '体系1', branchCode: 3, branchName: '本社営業所', jobName: '乗務員', payKubun: 2 }],
        deleteAttrs: [],
        deleteEmployees: [],
      })
      expect(employeeCalls().filter(c => c.method === 'GET')).toHaveLength(1)
      expect(payrollCalls()).toHaveLength(payrollBefore)
      expect(w.find('[data-salary-row="1078|2025-01"]').text()).toContain('比較済み')
      expect(w.find('[data-salary-row="1078|2025-02"]').text()).toContain('比較済み')
      expect(message(w)).toBe('社員マスタに登録しました: 747 甲野太郎 (会社 0200) → 乗務員 1078 — 区分を入れました。基本給の計算に反映するには拘束の材料を取り直してください')
      // 「明細なし」が無くなればボタンも消える
      expect(w.find('[data-testid="litigation-salary-register"]').exists()).toBe(false)
      w.unmount()
    })

    it('★ 乗務員一覧に同じ氏名が 2 人いれば (案件の外でも) ボタンを出さず、社員マスタタブへの案内文を出す', async () => {
      api.getDrivers.mockResolvedValue([
        { id: 'd1', driver_cd: '1078', driver_name: '甲野太郎' },
        { id: 'd2', driver_cd: '2078', driver_name: '甲野 太郎' },
      ])
      const w = await openAfterChecks()
      await openSalaryTab(w)
      expect(w.find('[data-salary-row="1078|2025-01"]').text()).toContain('明細なし')
      expect(registerBtns(w)).toHaveLength(0)
      expect(hint(w).text()).toContain('拘束×賃金の社員マスタタブ')
      w.unmount()
    })

    it('★ 社員マスタに (会社, 給与コード) が既に在れば (乗務員CD 未設定でも) 上書きしないようボタンを出さない', async () => {
      employeeMaster = [{ company: '0200', payrollCd: '747', name: '甲野 太郎', driverCd: null }]
      const w = await openAfterChecks()
      await openSalaryTab(w)
      expect(w.find('[data-salary-row="1078|2025-01"]').text()).toContain('明細なし')
      expect(registerBtns(w)).toHaveLength(0)
      expect(hint(w).exists()).toBe(true)
      w.unmount()
    })

    it('★ PUT に失敗したらその文を出し、社員マスタを読み直さない (行は明細なしのまま)', async () => {
      employeePutFails = true
      const w = await openAfterChecks()
      await openSalaryTab(w)
      calls = calls.filter(c => !c.url.startsWith('/restraint-api/employee-master'))
      await registerBtns(w)[0]!.trigger('click')
      await settle()
      expect(message(w)).toContain('社員マスタに登録できませんでした (747 甲野太郎 (会社 0200) → 乗務員 1078)')
      expect(employeeCalls().map(c => c.method)).toEqual(['PUT'])
      expect(w.find('[data-salary-row="1078|2025-01"]').text()).toContain('明細なし')
      expect(registerBtns(w)[0]!.attributes('disabled')).toBeUndefined()
      w.unmount()
    })
  })

  describe('社員マスタに属性 (給与区分) も入れ、拘束の材料を取り直す', () => {
    const registerBtns = (w: VueWrapper) => w.findAll('[data-testid="litigation-salary-register-button"]')
    const attrsBtns = (w: VueWrapper) => w.findAll('[data-testid="litigation-salary-attrs-button"]')
    const retakeBtn = (w: VueWrapper) => w.find('[data-testid="litigation-salary-materials-retake"]')
    const message = (w: VueWrapper) => w.find('[data-testid="litigation-salary-register-message"]').text()
    const employeeCalls = () => calls.filter(c => c.url.startsWith('/restraint-api/employee-master'))
    const kyuyoCalls = () => calls.filter(c => c.url.startsWith('/api/kyuyo/employees'))
    const puts = () => employeeCalls().filter(c => c.method === 'PUT')

    beforeEach(() => {
      // 給与コード 747 (明細) と乗務員CD 1078 の対応が社員マスタに無い
      employeeMaster = []
      febWageFails = false
    })

    it('★ 登録: 給与大臣の社員一覧を 1 回 (会社と案件の最初の月で) 読み、その 1 人の属性を案件の最初の月の 1 日付けで PUT する。旧ラベルの削除は送らない', async () => {
      const w = await openAfterChecks()
      await openSalaryTab(w)
      calls = []
      await registerBtns(w)[0]!.trigger('click')
      await settle()
      expect(kyuyoCalls().map(c => c.url)).toEqual(['/api/kyuyo/employees?company=0200&month=2025-01'])
      expect(puts()).toHaveLength(1)
      const body = puts()[0]!.body as { employees: unknown[], attrs: { payrollCd: string, effectiveFrom: string, payKubun: number }[], deleteAttrs: unknown[], deleteEmployees: unknown[] }
      expect(body.employees).toHaveLength(1)
      // 同じ会社の別人 (748) の属性は載らない
      expect(body.attrs.map(a => [a.payrollCd, a.effectiveFrom, a.payKubun])).toEqual([['747', '2025-01-01', 2]])
      expect(body.deleteAttrs).toEqual([])
      expect(body.deleteEmployees).toEqual([])
      expect(retakeBtn(w).text()).toBe('拘束の材料を取り直す (2 か月)')
      w.unmount()
    })

    it('★ 「拘束の材料を取り直す」は wage-report だけを月の数だけ直列に取り直す (alc の運行・オンプレ突き合わせは呼ばない)。開いただけ・登録しただけでは走らない', async () => {
      const w = await openAfterChecks()
      await openSalaryTab(w)
      calls = []
      api.getOperations.mockClear()
      await registerBtns(w)[0]!.trigger('click')
      await settle()
      expect(calls.filter(c => c.url.startsWith('/restraint-api/wage-report'))).toHaveLength(0)
      await retakeBtn(w).trigger('click')
      await settle()
      expect(calls.filter(c => c.url.startsWith('/restraint-api/wage-report')).map(c => c.url)).toEqual([
        '/restraint-api/wage-report?month=2025-01&source=gcp',
        '/restraint-api/wage-report?month=2025-02&source=gcp',
      ])
      expect(calls.filter(c => c.url.startsWith('/restraint-api/kintai/onprem-month-operations'))).toHaveLength(0)
      expect(api.getOperations).not.toHaveBeenCalled()
      // 取り直し終わったらボタンは消える
      expect(retakeBtn(w).exists()).toBe(false)
      w.unmount()
    })

    it('★ 給与大臣のその年度に居ないときは属性なしで登録し、その旨を出す (取り直しボタンは出さない)', async () => {
      kyuyoEmployeeRows = []
      const w = await openAfterChecks()
      await openSalaryTab(w)
      await registerBtns(w)[0]!.trigger('click')
      await settle()
      const body = puts()[0]!.body as { employees: unknown[], attrs: unknown[] }
      expect(body.employees).toHaveLength(1)
      expect(body.attrs).toEqual([])
      expect(message(w)).toContain('給与区分が取れませんでした (給与大臣の 2025-01 の年度に居ない) — 拘束×賃金の社員マスタタブで区分を入れてください')
      expect(retakeBtn(w).exists()).toBe(false)
      w.unmount()
    })

    it('★ 給与大臣を読めなかったときも登録は通し、読めなかった旨を出す', async () => {
      kyuyoEmployeesFails = true
      const w = await openAfterChecks()
      await openSalaryTab(w)
      await registerBtns(w)[0]!.trigger('click')
      await settle()
      expect((puts()[0]!.body as { attrs: unknown[] }).attrs).toEqual([])
      expect(message(w)).toContain('社員マスタに登録しました')
      expect(message(w)).toContain('給与区分が取れませんでした')
      w.unmount()
    })

    it('★ 給与区分が 0 (給与大臣に無い) の社員は、成功文ではなく基本給は計算できない旨を出し、取り直しを促さない', async () => {
      kyuyoEmployeeRows = [{ employee_code: '0747', employee_code_key: '747', employee_name: '甲野太郎', department: '本社', taikei: 1, kkubun: 0, retired: false }]
      const w = await openAfterChecks()
      await openSalaryTab(w)
      await registerBtns(w)[0]!.trigger('click')
      await settle()
      expect(message(w)).toContain('給与区分が給与大臣に無いので基本給は計算できません')
      expect(message(w)).not.toContain('区分を入れました')
      expect(retakeBtn(w).exists()).toBe(false)
      w.unmount()
    })

    it('★ 登録済みで属性が空の人には「属性を入れる」を出し、押すと employees: [] で attrs だけ PUT する (氏名・乗務員CD を上書きしない)', async () => {
      employeeMaster = [{ company: '0200', payrollCd: '747', name: '古い写し', driverCd: '1078' }]
      const w = await openAfterChecks()
      await openSalaryTab(w)
      expect(registerBtns(w)).toHaveLength(0)
      expect(attrsBtns(w).map(b => b.text())).toEqual(['属性を入れる: 747 古い写し (会社 0200) — 給与大臣の区分・所属を 2025-01 付けで入れる'])
      calls = []
      await attrsBtns(w)[0]!.trigger('click')
      await settle()
      expect(kyuyoCalls()).toHaveLength(1)
      expect(puts()).toHaveLength(1)
      const body = puts()[0]!.body as { employees: unknown[], attrs: { payrollCd: string, payKubun: number }[], deleteAttrs: unknown[], deleteEmployees: unknown[] }
      expect(body.employees).toEqual([])
      expect(body.attrs.map(a => [a.payrollCd, a.payKubun])).toEqual([['747', 2]])
      expect(body.deleteAttrs).toEqual([])
      expect(body.deleteEmployees).toEqual([])
      expect(message(w)).toContain('属性を入れました: 747 古い写し (会社 0200) → 乗務員 1078')
      // 入れたら候補から消え、取り直しが出る
      expect(attrsBtns(w)).toHaveLength(0)
      expect(retakeBtn(w).exists()).toBe(true)
      w.unmount()
    })

    it('★ 属性が 1 行でも在る人、乗務員CD が無い人、案件の外の人には「属性を入れる」を出さない', async () => {
      employeeMaster = [
        { company: '0200', payrollCd: '747', name: '甲野太郎', driverCd: '1078', attrs: [{ effectiveFrom: '2024-04-01', payKubun: 1 }] },
        { company: '0200', payrollCd: '748', name: '乙山次郎', driverCd: null },
        { company: '0200', payrollCd: '749', name: '丙川三郎', driverCd: '2222' },
      ]
      const w = await openAfterChecks()
      await openSalaryTab(w)
      expect(w.find('[data-testid="litigation-salary-attrs"]').exists()).toBe(false)
      w.unmount()
    })

    it('★ 属性を入れるとき給与大臣のその年度に居なければ PUT しない', async () => {
      employeeMaster = [{ company: '0200', payrollCd: '747', name: '甲野太郎', driverCd: '1078' }]
      kyuyoEmployeeRows = []
      const w = await openAfterChecks()
      await openSalaryTab(w)
      calls = []
      await attrsBtns(w)[0]!.trigger('click')
      await settle()
      expect(puts()).toHaveLength(0)
      expect(message(w)).toContain('属性を入れられませんでした')
      w.unmount()
    })
  })
})

describe('給与比較タブ: 明細を保存済みはまとめて、保存が無い月は 1 本ずつ (Refs #1133)', () => {
  async function openSalary(): Promise<VueWrapper> {
    const w = await openErrorsTabAndRun()
    calls = []
    await buttonByText(w, '給与比較').trigger('click')
    return w
  }
  const payrollCalls = () => calls.filter(c => c.url.startsWith('/api/kyuyo/payroll')).map(c => c.url)
  const loaded = (w: VueWrapper) => w.find('[data-testid="litigation-salary-summary"]').text()
  /** 読み終える (進捗が消え、飛んでいる本が 0) まで待つ */
  const done = (w: VueWrapper) => vi.waitFor(() => {
    expect(w.find('[data-testid="litigation-salary-progress"]').exists()).toBe(false)
    expect(payrollInflight).toBe(0)
  }, { timeout: 5000 })
  /** 2025-01〜06 の 6 か月 × 2 社 = 12 本 */
  function sixMonthsTwoCompanies() {
    caseToMonth = '2025-06'
    payrollCompanies = ['0200', '0300']
    payrollDelayMs = 15
  }
  const allKeys = () => ['01', '02', '03', '04', '05', '06'].flatMap(m => payrollCompanies.map(c => `${c}|2025-${m}`))
  const synced = (keys: string[]) => keys.map((k) => { const [company, month] = k.split('|'); return { company: company!, month: month! } })

  it('★ 全部保存済みなら同時に 2〜6 本が飛ぶ (遅延スタブで in-flight を数える)。synced-months は 1 回だけ', async () => {
    sixMonthsTwoCompanies()
    syncedEntries = synced(allKeys())
    const w = await openSalary()
    await done(w)
    expect(payrollCalls()).toHaveLength(12)
    expect(payrollPeak).toBeGreaterThanOrEqual(2)
    expect(payrollPeak).toBeLessThanOrEqual(6)
    expect(calls.filter(c => c.url.startsWith('/api/kyuyo/synced-months'))).toHaveLength(1)
    expect(loaded(w)).toContain('明細 読込済み 6 / 6 か月')
    w.unmount()
  })

  it('★ 進捗は 読込 N / M (保存済み X 本をまとめて…)、読んでいる間の行は 読込中', async () => {
    sixMonthsTwoCompanies()
    syncedEntries = synced(allKeys())
    payrollDelayMs = 60
    const w = await openSalary()
    await vi.waitFor(() => expect(w.find('[data-testid="litigation-salary-progress"]').text()).toContain('読込 0 / 12 (保存済み 12 本をまとめて読んでいます)'))
    expect(w.find('[data-salary-row="1078|2025-02"] [data-salary-payroll]').text()).toBe('明細: 読込中')
    await done(w)
    expect(w.find('[data-testid="litigation-salary-table"]').text()).not.toContain('読込中')
    w.unmount()
  })

  it('★ 保存が無い月は保存済みを読み終えた後に 1 本ずつ (開始時の in-flight が常に 1)', async () => {
    sixMonthsTwoCompanies()
    const live = ['0200|2025-04', '0300|2025-04']
    syncedEntries = synced(allKeys().filter(k => !live.includes(k)))
    const w = await openSalary()
    await done(w)
    const keys = payrollStarts.map(s => s.key)
    expect(keys.slice(-2)).toEqual(live)
    // live 2 本は、直前の本が返ってから始まる = 開始時の in-flight は自分だけ
    expect(payrollStarts.slice(-2).map(s => s.inflight)).toEqual([1, 1])
    expect(keys).toHaveLength(12)
    expect(loaded(w)).toContain('明細 読込済み 6 / 6 か月')
    w.unmount()
  })

  it('★ synced-months が失敗したら全部直列 (in-flight は最大 1)。月の並びは従来どおり', async () => {
    sixMonthsTwoCompanies()
    syncedEntries = null
    const w = await openSalary()
    await done(w)
    expect(payrollPeak).toBe(1)
    expect(payrollStarts.map(s => s.key)).toEqual(allKeys())
    expect(loaded(w)).toContain('明細 読込済み 6 / 6 か月')
    w.unmount()
  })

  it('★ 403 は全体を止める: 次の塊を呼ばない', async () => {
    sixMonthsTwoCompanies()
    syncedEntries = synced(allKeys())
    payrollForbidden = true
    const w = await openSalary()
    await vi.waitFor(() => expect(w.find('[data-testid="litigation-salary-error"]').exists()).toBe(true))
    await settle()
    expect(w.find('[data-testid="litigation-salary-error"]').text()).toContain('給与を見る権限がありません')
    expect(payrollCalls()).toHaveLength(6)
    w.unmount()
  })

  it('★ 1 社が読めなければ、その月 (支給月) は読めない。ほかの月は読める (並列でも)', async () => {
    sixMonthsTwoCompanies()
    syncedEntries = synced(allKeys())
    payrollFailKey = '0300|2025-02'
    const w = await openSalary()
    await done(w)
    expect(w.find('[data-salary-row="1078|2025-02"] [data-salary-payroll]').text()).toContain('明細: 読めない — 会社 0300')
    expect(loaded(w)).toContain('明細 読込済み 5 / 6 か月')
    w.unmount()
  })

  it('★ 並列で読んでいる最中に案件を閉じて開き直したら、古い結果は入らない', async () => {
    sixMonthsTwoCompanies()
    syncedEntries = synced(allKeys())
    payrollDelayMs = 60
    const w = await openSalary()
    await vi.waitFor(() => expect(payrollInflight).toBeGreaterThan(0))
    await buttonByText(w, '閉じる').trigger('click')
    await buttonByText(w, '開く').trigger('click')
    await buttonByText(w, '給与比較').trigger('click')
    // 開き直した側は、読み終えるまで古い読み込みの結果を見ない
    await new Promise(r => setTimeout(r, 200))
    await done(w)
    await settle()
    expect(loaded(w)).toContain('明細 読込済み 6 / 6 か月')
    // 古い側 (最初の 6 本以降を呼ばない) + 開き直した側 12 本
    expect(payrollCalls().length).toBeLessThanOrEqual(6 + 12)
    w.unmount()
  })
})
