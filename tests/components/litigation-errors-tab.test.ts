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
  api: { getDrivers: vi.fn(), getYTimePreview: vi.fn() },
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
let calls: Call[] = []
const realFetch = globalThis.fetch

/** `$fetch` を URL で振り分けるモック。呼び出しは全部 `calls` に積む。 */
function stubDollarFetch() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string, opts: { method?: string, query?: Record<string, string> } = {}) => {
    const q = opts.query ?? {}
    calls.push({ via: '$fetch', method: opts.method ?? 'GET', url: `${url}?${new URLSearchParams(q).toString()}` })
    if (url === '/restraint-api/litigation-cases') return { cases: [CASE] }
    if (url === '/restraint-api/kintai/unko-gaps') {
      if (q.month === '2025-01') return { gcp_etags_available: false, driver_cds_available: true, drivers: [] }
      return { gcp_etags_available: true, driver_cds_available: true, drivers: [{ driver_cd: '1078', unko_nos: ['2502100000000000001234'] }] }
    }
    if (url === '/restraint-api/wage-report') {
      if (q.month === '2025-02') throw Object.assign(new Error('boom'), { statusCode: 504 })
      return {
        month: q.month,
        restraint_source: 'gcp',
        no_data_drivers: [],
        warnings: [],
        rows: [{ summary: { driverCd: '1078' }, fetched_at: null, last_verified_at: null, wage: {}, invariants: OK_INV }],
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
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true } },
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
  saved.length = 0
  localStorage.clear()
  localStorage.setItem('litigation-viewer-comp', '1000')
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
    // 取り込み漏れ候補: 1 月は GCP 側が引けていない → 判定できない (0 件と言わない)
    expect(cell(w, '1078|2025-01', 'unkoGaps')).toContain('判定できない')
    expect(cell(w, '1078|2025-01', 'unkoGaps')).toContain('0 件とは言えない')
    expect(cell(w, '1078|2025-02', 'unkoGaps')).toContain('異常あり')
    // 最低賃金の不変条件: 2 月は wage-report が 504 → 判定できない
    expect(cell(w, '1078|2025-01', 'invariants')).toContain('異常なし')
    expect(cell(w, '1078|2025-02', 'invariants')).toContain('判定できない')
    // Y時間の欠け: 出力タブを回していないので未実行
    expect(cell(w, '1078|2025-01', 'yTime')).toContain('未実行')
    // 取り込みボタンは alc 0 件の月だけ
    expect(w.find('tr[data-row="1078|2025-02"] [data-testid="litigation-import"]').exists()).toBe(true)
    expect(w.find('tr[data-row="1078|2025-01"] [data-testid="litigation-import"]').exists()).toBe(false)
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

describe('出力タブの ZIP にエラー一覧.csv を入れる', () => {
  it('★ xlsx と並べて エラー一覧.csv (UTF-8 BOM 付き) が入り、Y時間の欠けが月の行に出る', async () => {
    stubFetch((url) => {
      if (url !== '/api/y-time-export') throw new Error(`unexpected fetch ${url}`)
      return new Response('xlsx-bytes', {
        status: 200,
        headers: { 'x-y-time-rows': '5', 'x-y-time-missing-dates': '2025-02-03', 'x-y-time-missing-count': '1' },
      })
    })
    const w = mount(Page, {
      global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true } },
    })
    await settle()
    await buttonByText(w, '開く').trigger('click')
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(saved).toHaveLength(1)
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(['1078_2025-01-2025-02.xlsx', 'エラー一覧.csv', '変更記録.csv'])
    const csv = await zip.file('エラー一覧.csv')!.async('string')
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    const lines = csv.slice(1).trimEnd().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toMatch(/^1078,甲野太郎,2025-01,未実行,.*,異常なし,書けなかった日なし,未実行,/)
    expect(lines[2]).toMatch(/^1078,甲野太郎,2025-02,未実行,.*,異常あり,テンプレに行が無く書けなかった日: 2025-02-03,未実行,/)
    // エラータブを開いていないので wage-report も wage-snapshot も呼ばない
    expect(calls.filter(c => c.url.includes('/restraint-api/wage-'))).toHaveLength(0)
    w.unmount()
  })

  it('Excel が 0 冊でも エラー一覧.csv だけの ZIP を保存し、成功の見た目にしない', async () => {
    stubFetch(() => new Response('', { status: 200, headers: { 'x-y-time-rows': '0' } }))
    const w = mount(Page, {
      global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true } },
    })
    await settle()
    await buttonByText(w, '開く').trigger('click')
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    expect(Object.keys(zip.files)).toEqual(['エラー一覧.csv', '変更記録.csv'])
    const alerts = w.findAllComponents({ name: 'UAlert' })
    expect(alerts.map(a => a.props('color'))).toEqual(['error'])
    expect(alerts[0]!.text()).toContain('エラー一覧.csv / 変更記録.csv だけを入れて保存しました')
    w.unmount()
  })
})
