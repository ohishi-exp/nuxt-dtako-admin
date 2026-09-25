/**
 * `/litigation` (訴訟準備) の「変更記録」タブ — Refs #1133 c1133-6。
 *
 * ## 何を固定するか
 *
 * 1. 打刻 (`GET /restraint-api/kintai/change-log`) + 運行
 *    (`getDtakoOperationChanges` = `/api/proxy/api/dtako/operation-changes`) の
 *    2 系統を読み、記録時刻の新しい順に 1 つの表へまとめること
 * 2. ★ 記録開始日の文言 — 「変更なし」「記録が無い」「読めなかった (403)」を混同しない
 * 3. ★ 403 (KINTAI_COMP_ID 以外の会社) は専用の文言を出し、それ以降は打刻を叩かない
 *    (運行は別経路なので引き続き読む)
 * 4. 出力タブの ZIP に 変更記録.csv (検知後の内容) が入ること
 *
 * 型は `litigation-errors-tab.test.ts` をなぞる。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api, saved } = vi.hoisted(() => ({
  api: { getDrivers: vi.fn(), getYTimePreview: vi.fn(), getDtakoOperationChanges: vi.fn() },
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
  getDtakoOperationChanges: api.getDtakoOperationChanges,
}))

import JSZip from 'jszip'
import Page from '~/pages/litigation.vue'

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

interface Call { via: '$fetch' | 'fetch', method: string, url: string, body?: unknown }
let calls: Call[] = []
const realFetch = globalThis.fetch

type DollarFetchHandler = (url: string, query: Record<string, string>) => unknown

let kintaiHandler: DollarFetchHandler = () => ({ changes: [] })

/** `$fetch` を URL で振り分けるモック。呼び出しは全部 `calls` に積む。 */
function stubDollarFetch() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string, opts: { method?: string, query?: Record<string, string> } = {}) => {
    const q = opts.query ?? {}
    calls.push({ via: '$fetch', method: opts.method ?? 'GET', url: `${url}?${new URLSearchParams(q).toString()}` })
    if (url === '/restraint-api/litigation-cases') return { cases: [CASE] }
    if (url === '/restraint-api/kintai/change-log') {
      const result = kintaiHandler(url, q)
      if (result instanceof Error) throw result
      return result
    }
    throw new Error(`unexpected $fetch ${url}`)
  }))
}

function stubFetch() {
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch
}

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

async function openChangesTabAndRun(): Promise<VueWrapper> {
  const w = mount(Page, {
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true } },
  })
  await settle()
  await buttonByText(w, '開く').trigger('click')
  await buttonByText(w, '変更記録').trigger('click')
  await buttonByText(w, '検知を実行').trigger('click')
  await settle()
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  calls = []
  saved.length = 0
  localStorage.clear()
  localStorage.setItem('litigation-viewer-comp', '1000')
  api.getDrivers.mockResolvedValue([{ id: 'd1', driver_cd: '1078', driver_name: '甲野太郎' }])
  api.getYTimePreview.mockResolvedValue({ driver: { cd: '1078', name: '甲野太郎' }, period: {}, rows: [], warnings: [] })
  kintaiHandler = () => ({
    driver: '1078', recording_since: '2026-09-25',
    changes: [{
      driver_cd: 1078, date: '2025-01-05', recorded_at: '2026-09-26T01:00:00Z',
      before: [{ occurred_at: '2025-01-05T23:00:00Z', state: '始業', source: 'timecard', unko_no: null }],
      after: [{ occurred_at: '2025-01-05T22:30:00Z', state: '始業', source: 'timecard', unko_no: null }],
    }],
  })
  api.getDtakoOperationChanges.mockResolvedValue({
    driver_cd: '1078', recording_since: '2026-09-27',
    changes: [{
      unko_no: '2501100341010000004219', crew_role: 1, recorded_at: '2026-09-28T01:00:00Z', reason: 'reupload',
      before: { driver_cd: '1078', break_minutes: 0, rest_minutes: 200, drive_minutes: 100, cargo_minutes: 50 },
      after: { driver_cd: '1078', break_minutes: 178, rest_minutes: 200, drive_minutes: 100, cargo_minutes: 50 },
    }],
  })
  stubDollarFetch()
  stubFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllGlobals()
})

describe('変更記録タブ: 打刻+運行を1つの表にまとめる', () => {
  it('★ 記録時刻の新しい順に並び、記録開始日の文言を出す', async () => {
    const w = await openChangesTabAndRun()
    // alc (2026-09-28) の方が kintai (2026-09-26) より新しい → alc が先
    const rows = w.findAll('[data-testid="litigation-changes-table"] tbody tr')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.text()).toContain('運行')
    expect(rows[0]!.text()).toContain('休憩 0 → 178 分')
    expect(rows[1]!.text()).toContain('打刻')
    expect(rows[1]!.text()).toContain('始業 08:00 → 07:30')
    expect(w.find('[data-testid="litigation-changes-kintai-notice"]').text()).toContain('打刻の変更記録は 2026-09-25 から')
    expect(w.find('[data-testid="litigation-changes-alc-notice"]').text()).toContain('運行の変更記録は 2026-09-27 から')
    expect(w.find('[data-testid="litigation-changes-count"]').text()).toContain('2 件')
    // 呼び出し確認: 案件の開始月初〜終了月末 (2025-01-01〜2025-02-28) で読んでいる
    expect(calls.filter(c => c.url.startsWith('/restraint-api/kintai/change-log')).map(c => c.url)).toEqual([
      '/restraint-api/kintai/change-log?driver=1078&from=2025-01-01&to=2025-02-28',
    ])
    expect(api.getDtakoOperationChanges).toHaveBeenCalledWith('1078', '2025-01-01', '2025-02-28')
    w.unmount()
  })

  it('★ recording_since が null なら「まだ1件も記録されていない」', async () => {
    kintaiHandler = () => ({ recording_since: null, changes: [] })
    api.getDtakoOperationChanges.mockResolvedValue({ recording_since: null, changes: [] })
    const w = await openChangesTabAndRun()
    expect(w.find('[data-testid="litigation-changes-kintai-notice"]').text()).toContain('まだ打刻の変更記録が1件も無い')
    expect(w.find('[data-testid="litigation-changes-alc-notice"]').text()).toContain('まだ運行の変更記録が1件も無い')
    expect(w.find('[data-testid="litigation-changes-table"]').text()).toContain('変更記録はありません')
    w.unmount()
  })

  it('★ 403 (別会社) は専用の文言を出し、以降打刻を叩かない。運行は読む', async () => {
    let kintaiCalls = 0
    kintaiHandler = () => {
      kintaiCalls++
      return Object.assign(new Error('forbidden'), { statusCode: 403 })
    }
    const w = await openChangesTabAndRun()
    expect(w.find('[data-testid="litigation-changes-kintai-notice"]').text())
      .toContain('この会社の打刻の変更記録は読めません')
    expect(kintaiCalls).toBe(1)
    expect(api.getDtakoOperationChanges).toHaveBeenCalledTimes(1)
    expect(w.find('[data-testid="litigation-changes-alc-notice"]').text()).toContain('運行の変更記録は 2026-09-27 から')
    w.unmount()
  })
})

describe('変更記録タブ: ZIP への統合', () => {
  it('★ 検知を実行したあとに ZIP を作ると 変更記録.csv に検知結果が入る', async () => {
    const w = await openChangesTabAndRun()
    await buttonByText(w, '出力').trigger('click')
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(saved).toHaveLength(1)
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    const csv = await zip.file('変更記録.csv')!.async('string')
    expect(csv.charCodeAt(0)).toBe(0xFEFF)
    expect(csv).toContain('休憩 0 → 178 分')
    expect(csv).toContain('始業 08:00 → 07:30')
    expect(csv).toContain('打刻の変更記録は 2026-09-25 から')
    w.unmount()
  })

  it('検知を実行していなければ、その旨を書いた空の表になる', async () => {
    const w = mount(Page, {
      global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true } },
    })
    await settle()
    await buttonByText(w, '開く').trigger('click')
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    const csv = await zip.file('変更記録.csv')!.async('string')
    expect(csv).toContain('「検知を実行」を押していないため、この表は空です')
    w.unmount()
  })
})
