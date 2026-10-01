/**
 * `/litigation` (訴訟準備) の出力の版 (Refs #1133 c1133-34)。
 *
 * 「ZIP を作る」は ZIP をダウンロードしたあと、同じファイルと結果を relay へ 1 つの版として保存する。
 * 案件を開くと最新の版の結果を出力タブの表示へ戻す。固定するもの:
 *
 * 1. 順番と直列: ダウンロード → 版の作成 (POST) → ファイルを 1 つずつ (PUT)。**直列は、応答を手で
 *    止める stub で測る** (すぐ返る stub だと、直列でも並列でも同じ結果になる)
 * 2. 保存の失敗でダウンロードの成功の表示を取り消さない (別の警告に、ファイル名と理由)
 * 3. 押した時点で 案件・変更記録を握る。作成中に案件を切り替えても、別の案件の表へ書かない
 * 4. 戻した結果は出力タブの表示だけが読む。**エラータブの行は変わらない**
 * 5. 区切りが今の案件と違う版は戻さず、その旨を出す。一覧より先に「ZIP を作る」を押したら読み戻しを捨てる
 * 6. 版の一覧の 403 (admin / payroll 以外) はエラーにせず 1 行だけ出す
 *
 * 待ちは stub の解決で作る (時間の窓に依らない)。値はすべて架空。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api, saved, events } = vi.hoisted(() => ({
  api: { getDrivers: vi.fn(), getYTimePreview: vi.fn(), getDtakoOperationChanges: vi.fn() },
  saved: [] as { blob: Blob, name: string }[],
  /** ダウンロード・版の作成・ファイルの上げ始めの順 */
  events: [] as string[],
}))

vi.mock('~/utils/download-blob', () => ({
  downloadBlob: (blob: Blob, name: string) => {
    saved.push({ blob, name })
    events.push('download')
  },
}))
vi.mock('@ippoan/auth-client', () => ({ useAuth: () => ({ token: { value: 'jwt-token' } }) }))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: api.getDrivers,
  getYTimePreview: api.getYTimePreview,
  getDtakoOperationChanges: api.getDtakoOperationChanges,
}))

const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})

import JSZip from 'jszip'
const Page = (await import('~/pages/litigation.vue')).default

const COMP = '99999999'
/** 13 か月 = 2 冊 (2024-01〜2024-12 / 2025-01〜2025-01) */
const CASE_A = {
  caseId: 'case-a',
  name: '架空の案件A',
  fromMonth: '2024-01',
  toMonth: '2025-01',
  driverCds: ['1001'],
  memo: '',
  createdBy: null,
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
}
/** 2 か月 = 1 冊 */
const CASE_B = { ...CASE_A, caseId: 'case-b', name: '架空の案件B', fromMonth: '2025-03', toMonth: '2025-04', driverCds: ['1002'] }
const A_BOOK_1 = '1001_2024-01-2024-12.xlsx'
const A_BOOK_2 = '1001_2025-01-2025-01.xlsx'
const CSV_LABEL = '変更記録.csv'

interface StoredFile { name: string, label: string, size: number, bytes: Uint8Array }
interface StoredVersion { versionId: string, createdAt: string, createdBy: string | null, files: StoredFile[], results: unknown }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

const err = (status: number, error: string) => Object.assign(new Error(String(status)), { statusCode: status, data: { error } })
const text = (s: string) => new TextEncoder().encode(s)

/** 案件 A の区切りに合う、保存済みの結果 (1 冊目は作成・書けなかった日 1 日、2 冊目は運行 0 件) */
function snapshotForA(rows = 99) {
  return {
    v: 1,
    chunks: [
      { driverCd: '1001', from: '2024-01-01', to: '2024-12-31' },
      { driverCd: '1001', from: '2025-01-01', to: '2025-01-31' },
    ],
    results: [
      { driverCd: '1001', from: '2024-01-01', to: '2024-12-31', status: 'ok', rows, missingDates: ['2024-02-03'], missingCount: 1, warnings: [], warningsCount: 0, message: `${rows} 行` },
      { driverCd: '1001', from: '2025-01-01', to: '2025-01-31', status: 'empty', rows: 0, missingDates: [], missingCount: 0, warnings: [], warningsCount: 0, message: 'この期間に運行が 0 件 (alc に取り込まれていない可能性)' },
    ],
    changes: { finished: true, rows: 7 },
  }
}

function storedVersion(versionId: string, createdAt: string, results: unknown): StoredVersion {
  return {
    versionId,
    createdAt,
    createdBy: 'someone@example.com',
    files: [
      { name: A_BOOK_1, label: A_BOOK_1, size: 11, bytes: text(`${versionId}:book`) },
      { name: 'changes.csv', label: CSV_LABEL, size: 10, bytes: text(`${versionId}:csv`) },
    ],
    results,
  }
}

type Call = { via: '$fetch' | 'fetch', method: string, url: string, body?: unknown, headers?: Record<string, string> }
let calls: Call[]
let cases: unknown[]
/** 案件ごとの版 (新しい順)。POST / PUT が書き足す */
let versions: Record<string, StoredVersion[]>
/** 版の一覧の GET を差し替える (既定は `versions` をそのまま返す) */
let listHandler: ((caseId: string) => unknown) | null
/** 立てておくと、**最初の**一覧の GET は (応答を作ったあと) これが解けるまで返らない */
let firstListGate: Promise<void> | null
let postHandler: ((body: { caseId: string, results: unknown }) => unknown) | null
let exportHandler: (body: { from: string }) => Response | Promise<Response>
let putHandler: ((name: string) => Response | Promise<Response> | null | Promise<null>) | null
let fileGetHandler: ((name: string) => Response | null) | null
const realFetch = globalThis.fetch

const listResponse = (caseId: string) => ({
  versions: (versions[caseId] ?? []).map(v => ({
    versionId: v.versionId,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
    files: v.files.map(f => ({ name: f.name, label: f.label, size: f.size, sha256: '0'.repeat(64), uploadedAt: v.createdAt })),
  })),
})

function stubDollarFetch() {
  vi.stubGlobal('$fetch', vi.fn(async (url: string, opts: { method?: string, query?: Record<string, string>, body?: unknown, headers?: Record<string, string> } = {}) => {
    const q = opts.query ?? {}
    const method = opts.method ?? 'GET'
    calls.push({ via: '$fetch', method, url: `${url}?${new URLSearchParams(q).toString()}`, body: opts.body, headers: opts.headers })
    if (url === '/restraint-api/viewer-comps') return { comps: [COMP] }
    if (url === '/restraint-api/litigation-cases') return { cases }
    if (url === '/restraint-api/litigation-cases/deleted') throw err(403, 'この操作は admin / payroll のみ実行できます')
    if (url === '/restraint-api/litigation-checks') return { items: [] }
    if (url === '/restraint-api/kintai/change-log') {
      return {
        driver: q.driver, recording_since: '2026-09-25',
        changes: [{
          driver_cd: Number(q.driver), date: '2024-01-05', recorded_at: '2026-09-26T01:00:00Z',
          before: [{ occurred_at: '2024-01-05T23:00:00Z', state: '始業', source: 'timecard', unko_no: null }],
          after: [{ occurred_at: '2024-01-05T22:30:00Z', state: '始業', source: 'timecard', unko_no: null }],
        }],
      }
    }
    if (url === '/restraint-api/litigation-outputs') {
      if (method === 'POST') {
        events.push('POST')
        const body = opts.body as { caseId: string, results: unknown }
        if (postHandler) return postHandler(body)
        const v: StoredVersion = { versionId: `ver-new-${(versions[body.caseId] ?? []).length + 1}`, createdAt: '2026-09-30T03:00:00.000Z', createdBy: 'me@example.com', files: [], results: body.results }
        versions[body.caseId] = [v, ...(versions[body.caseId] ?? [])]
        return { versionId: v.versionId, createdAt: v.createdAt }
      }
      if (q.version_id) {
        const v = (versions[q.case_id!] ?? []).find(x => x.versionId === q.version_id)
        if (!v) throw err(404, '出力の版が見つかりません')
        return { version: { ...listResponse(q.case_id!).versions.find(x => x.versionId === v.versionId), results: v.results } }
      }
      // 応答は呼ばれた時点の中身で作る (止めている間に版が増えても、遅れて届くのは古い一覧)
      const res = listHandler ? listHandler(q.case_id!) : listResponse(q.case_id!)
      const gate = firstListGate
      firstListGate = null
      if (gate) await gate
      return res
    }
    throw new Error(`unexpected $fetch ${method} ${url}`)
  }))
}

function stubFetch() {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = init?.headers as Record<string, string> | undefined
    if (url === '/api/y-time-export') {
      const body = JSON.parse(String(init!.body))
      calls.push({ via: 'fetch', method, url, body })
      return exportHandler(body)
    }
    if (url.startsWith('/restraint-api/litigation-outputs/file?')) {
      const q = new URL(url, 'http://x').searchParams
      const name = q.get('name')!
      if (method === 'PUT') {
        const bytes = new Uint8Array(init!.body as ArrayBuffer)
        calls.push({ via: 'fetch', method, url, body: bytes, headers })
        events.push(`PUT ${name}`)
        const custom = putHandler ? await putHandler(name) : null
        if (custom) return custom
        const v = (versions[q.get('case_id')!] ?? []).find(x => x.versionId === q.get('version_id'))!
        v.files.push({ name, label: q.get('label')!, size: bytes.byteLength, bytes })
        return Response.json({ name, size: bytes.byteLength, sha256: '0'.repeat(64) })
      }
      calls.push({ via: 'fetch', method, url, headers })
      const custom = fileGetHandler ? fileGetHandler(name) : null
      if (custom) return custom
      const f = (versions[q.get('case_id')!] ?? []).find(x => x.versionId === q.get('version_id'))?.files.find(x => x.name === name)
      return f ? new Response(f.bytes, { status: 200 }) : Response.json({ error: 'ファイルが見つかりません' }, { status: 404 })
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }) as typeof fetch
}

/** setTimeout(0) と microtask を回し切る (時間の長さには依らない。止めた stub は解くまで進まない) */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 0))
    await flushPromises()
  }
}

function buttonByText(w: VueWrapper, label: string) {
  const b = w.findAll('button').find(x => x.text().trim() === label)
  if (!b) throw new Error(`ボタン「${label}」が無い: ${w.text().slice(0, 300)}`)
  return b
}

async function mountPage(): Promise<VueWrapper> {
  const w = mount(Page, {
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, UInput: { props: ['modelValue'], template: '<input />' }, DriverSearchSelect: true, USelectMenu: true } },
  })
  await settle()
  return w
}

/** 案件の一覧の行の「開く」を押す (settle しない — 一覧の応答を止めたまま次の操作をするテストが在る) */
async function clickOpen(w: VueWrapper, name: string) {
  const row = w.findAll('tr').find(tr => tr.text().includes(name) && tr.findAll('button').some(b => b.text().trim() === '開く'))!
  await row.findAll('button').find(b => b.text().trim() === '開く')!.trigger('click')
}

async function openCase(w: VueWrapper, name: string) {
  await clickOpen(w, name)
  await settle()
}

const outputTable = (w: VueWrapper) => w.find('[data-testid="litigation-output-table"]')
const statuses = (w: VueWrapper) => outputTable(w).findAll('tbody tr').map(tr => tr.findAll('td')[3]!.text())
const versionRows = (w: VueWrapper) => w.findAll('[data-testid="litigation-output-versions-table"] tbody tr')
const alertColors = (w: VueWrapper) => w.findAllComponents({ name: 'UAlert' }).map(a => a.props('color'))
const urlsOf = (method: string, prefix: string) => calls.filter(c => c.method === method && c.url.startsWith(prefix)).map(c => c.url)
const putNames = () => urlsOf('PUT', '/restraint-api/litigation-outputs/file?').map(u => new URL(u, 'http://x').searchParams.get('name'))
const posts = () => calls.filter(c => c.method === 'POST' && c.url.startsWith('/restraint-api/litigation-outputs'))

beforeEach(() => {
  calls = []
  saved.length = 0
  events.length = 0
  nuxtState.clear()
  cases = [CASE_A, CASE_B]
  versions = {}
  listHandler = null
  firstListGate = null
  postHandler = null
  putHandler = null
  fileGetHandler = null
  exportHandler = body => new Response(`xlsx:${body.from}`, { status: 200, headers: { 'x-y-time-rows': '5' } })
  localStorage.clear()
  localStorage.setItem('litigation-viewer-comp', COMP)
  api.getDrivers.mockResolvedValue([{ id: 'd1', driver_cd: '1001', driver_name: '架空 太郎' }])
  api.getYTimePreview.mockResolvedValue({ driver: { cd: '1001', name: '架空 太郎' }, period: {}, rows: [], warnings: [] })
  api.getDtakoOperationChanges.mockResolvedValue({ recording_since: '2026-09-27', changes: [] })
  stubDollarFetch()
  stubFetch()
})

afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllGlobals()
})

describe('「ZIP を作る」: ダウンロードのあとに版として保存する', () => {
  it('★ ダウンロード → 版の作成 → ファイルを 1 つずつ直列に上げる。進捗は「保存 N / M」、終わると一覧に版が出る', async () => {
    const gates = { [A_BOOK_1]: deferred(), [A_BOOK_2]: deferred(), 'changes.csv': deferred() } as Record<string, ReturnType<typeof deferred>>
    putHandler = async (name) => {
      await gates[name]!.promise
      return null
    }
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(w.find('[data-testid="litigation-output-versions"]').text()).toContain('保存した版はまだありません')
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    // 1 つ目の応答を止めている間、2 つ目は始まらない (並列に上げると 3 つとも始まっている)
    expect(events).toEqual(['download', 'POST', `PUT ${A_BOOK_1}`])
    const progress = () => w.find('[data-testid="litigation-output-save-progress"]')
    expect(progress().text()).toContain('保存 0 / 3')
    // 保存の途中でも、ダウンロードの成功はもう出ている。ボタンは保存が終わるまで押せない
    expect(alertColors(w)).toEqual(['success'])
    expect(w.findComponent({ name: 'UAlert' }).text()).toContain('をダウンロードしました (Excel 2 / 2 冊 + 変更記録.csv)')
    expect(buttonByText(w, 'ZIP を作る').attributes('disabled')).toBeDefined()

    gates[A_BOOK_1]!.resolve()
    await settle()
    expect(events).toEqual(['download', 'POST', `PUT ${A_BOOK_1}`, `PUT ${A_BOOK_2}`])
    expect(progress().text()).toContain('保存 1 / 3')
    gates[A_BOOK_2]!.resolve()
    await settle()
    expect(events).toEqual(['download', 'POST', `PUT ${A_BOOK_1}`, `PUT ${A_BOOK_2}`, 'PUT changes.csv'])
    expect(progress().text()).toContain('保存 2 / 3')
    gates['changes.csv']!.resolve()
    await settle()

    expect(progress().exists()).toBe(false)
    expect(buttonByText(w, 'ZIP を作る').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-testid="litigation-output-save-message"]').text()).toBe('2026-09-30 12:00 の版として保存しました (ファイル 3 個)')
    expect(w.find('[data-testid="litigation-output-save-warning"]').exists()).toBe(false)
    // 一覧を読み直して、作った版が出る
    expect(versionRows(w)).toHaveLength(1)
    expect(versionRows(w)[0]!.text()).toContain('2026-09-30 12:00')
    expect(versionRows(w)[0]!.text()).toContain('me@example.com')
    expect(versionRows(w)[0]!.text()).toContain('Excel 2 冊 / ファイル 3 個')
    w.unmount()
  })

  it('★ 版の results は {v, chunks, results, changes}。上げるファイルは ZIP に入れたものと同じ中身で、保存用の名前と ZIP 内の名前 (label) を持つ', async () => {
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(posts()).toHaveLength(1)
    const body = posts()[0]!.body as { caseId: string, results: { v: number, chunks: unknown[], results: { status: string, rows: number }[], changes: unknown } }
    expect(body.caseId).toBe('case-a')
    expect(body.results.v).toBe(1)
    expect(body.results.chunks).toEqual([
      { driverCd: '1001', from: '2024-01-01', to: '2024-12-31' },
      { driverCd: '1001', from: '2025-01-01', to: '2025-01-31' },
    ])
    expect(body.results.results.map(r => `${r.status} ${r.rows}`)).toEqual(['ok 5', 'ok 5'])
    expect(body.results.changes).toEqual({ finished: false, rows: 0 })
    expect(posts()[0]!.headers!['X-Theearth-Comp-Id']).toBe(COMP)

    const puts = calls.filter(c => c.method === 'PUT' && c.url.startsWith('/restraint-api/litigation-outputs/file?'))
    const params = puts.map(c => Object.fromEntries(new URL(c.url, 'http://x').searchParams))
    expect(params).toEqual([
      { case_id: 'case-a', version_id: 'ver-new-1', name: A_BOOK_1, label: A_BOOK_1 },
      { case_id: 'case-a', version_id: 'ver-new-1', name: A_BOOK_2, label: A_BOOK_2 },
      { case_id: 'case-a', version_id: 'ver-new-1', name: 'changes.csv', label: CSV_LABEL },
    ])
    expect(puts.map(c => c.headers!['X-Theearth-Comp-Id'])).toEqual([COMP, COMP, COMP])
    expect(puts.map(c => c.headers!['content-type'])).toEqual(Array(3).fill('application/octet-stream'))
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual([A_BOOK_1, A_BOOK_2, CSV_LABEL].sort())
    for (const [i, label] of [A_BOOK_1, A_BOOK_2, CSV_LABEL].entries()) {
      expect([...(puts[i]!.body as Uint8Array)]).toEqual([...await zip.file(label)!.async('uint8array')])
    }
    w.unmount()
  })

  it('★ ファイルの 1 つが保存できなくても、ダウンロードの成功の表示は残り、警告にそのファイル名と理由が出る (残りは上げる)', async () => {
    putHandler = name => name === A_BOOK_2 ? Response.json({ error: '架空の保存先の障害' }, { status: 500 }) : null
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(alertColors(w)).toEqual(['success'])
    expect(w.findComponent({ name: 'UAlert' }).text()).toContain('をダウンロードしました')
    const warning = w.find('[data-testid="litigation-output-save-warning"]')
    expect(warning.text()).toContain('版として保存できなかったファイルが 1 / 3 個あります (ZIP のダウンロードは済んでいます)')
    const items = warning.findAll('li').map(li => li.text())
    expect(items).toHaveLength(1)
    expect(items[0]).toContain(`${A_BOOK_2} — `)
    expect(items[0]).toContain('架空の保存先の障害')
    expect(items[0]).toContain('「ZIP を作る」を押してやり直してください')
    expect(w.find('[data-testid="litigation-output-save-message"]').exists()).toBe(false)
    // 失敗の後ろのファイルも上げている。一覧には保存できた 2 個の版が出る
    expect(putNames()).toEqual([A_BOOK_1, A_BOOK_2, 'changes.csv'])
    expect(versionRows(w)[0]!.text()).toContain('Excel 1 冊 / ファイル 2 個')
    w.unmount()
  })

  it('★ 通信が落ちて上げられなかったファイルも、名前つきで警告に出る', async () => {
    putHandler = (name) => {
      if (name === 'changes.csv') throw new TypeError('Failed to fetch')
      return null
    }
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(alertColors(w)).toEqual(['success'])
    const items = w.find('[data-testid="litigation-output-save-warning"]').findAll('li').map(li => li.text())
    expect(items).toHaveLength(1)
    expect(items[0]!.startsWith(`${CSV_LABEL} — `)).toBe(true)
    w.unmount()
  })

  it('★ 版の作成が 403 (admin / payroll 以外) でも、ダウンロードは成功のまま。ファイルは上げない', async () => {
    postHandler = () => { throw err(403, 'この操作は admin / payroll のみ実行できます') }
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(saved).toHaveLength(1)
    expect(alertColors(w)).toEqual(['success'])
    const warning = w.find('[data-testid="litigation-output-save-warning"]')
    expect(warning.text()).toContain('版として保存できませんでした (ZIP のダウンロードは済んでいます)')
    expect(warning.text()).toContain('この操作は admin / payroll のみ実行できます')
    expect(warning.text()).not.toContain('押してやり直してください')
    expect(putNames()).toEqual([])
    // エラータブの判定には、このページで実行した結果がそのまま渡る (保存の成否に依らない)
    expect(statuses(w)).toEqual(['作成', '作成'])
    w.unmount()
  })

  it('★ 版の作成が 404 (途中で案件が削除された) は、一覧を読み直して「削除した案件」から復活する案内を出す', async () => {
    postHandler = () => {
      cases = [CASE_B]
      throw err(404, '案件が見つかりません')
    }
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    const before = urlsOf('GET', '/restraint-api/litigation-cases?').length
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(saved).toHaveLength(1)
    expect(urlsOf('GET', '/restraint-api/litigation-cases?').length).toBe(before + 1)
    const alerts = w.findAllComponents({ name: 'UAlert' })
    expect(alerts.map(a => a.props('color'))).toEqual(['error'])
    expect(alerts[0]!.text()).toContain('版として保存できませんでした (ZIP のダウンロードは済んでいます)')
    expect(alerts[0]!.text()).toContain('一覧に戻ってください。admin / payroll は「削除した案件」から復活できます')
    expect(alerts[0]!.text()).not.toContain('「ZIP を作る」を押してやり直してください')
    // 案件は一覧から消え、詳細は閉じている
    expect(w.find('[data-testid="litigation-output"]').exists()).toBe(false)
    w.unmount()
  })

  it('★ 結果が 500,000 文字を超えたら版を作らず、理由を出す (ダウンロードは成功のまま)', async () => {
    exportHandler = () => new Response('xlsx', { status: 200, headers: { 'x-y-time-rows': '5', 'x-y-time-warnings': 'a'.repeat(250_001) } })
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(saved).toHaveLength(1)
    expect(alertColors(w)).toEqual(['success'])
    expect(posts()).toHaveLength(0)
    const warning = w.find('[data-testid="litigation-output-save-warning"]').text()
    expect(warning).toContain('結果が大きすぎるため、版として保存しませんでした')
    expect(warning).toContain('上限 500,000 文字')
    expect(warning).toContain('ZIP のダウンロードは済んでいます')
    w.unmount()
  })

  it('ZIP を組めなかったときは版を作らない (ダウンロードしていないものを保存しない)', async () => {
    const spy = vi.spyOn(JSZip.prototype, 'generateAsync').mockRejectedValueOnce(new Error('架空の ZIP の失敗'))
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    spy.mockRestore()
    expect(saved).toHaveLength(0)
    expect(posts()).toHaveLength(0)
    expect(alertColors(w)).toEqual(['error'])
    expect(w.findComponent({ name: 'UAlert' }).text()).toContain('ZIP を組めませんでした')
    expect(buttonByText(w, 'ZIP を作る').attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})

describe('押した時点で握る / 出力の世代', () => {
  it('★ ZIP 作成中に案件を切り替えても、切替先の表へ書かない。握った案件へは最後まで保存する (陰性対照: 世代のガードを外すと切替先に「作成」が出る)', async () => {
    const gate = deferred()
    exportHandler = async (body) => {
      await gate.promise
      return new Response(`xlsx:${body.from}`, { status: 200, headers: { 'x-y-time-rows': '5' } })
    }
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(w.find('[data-testid="litigation-output-progress"]').text()).toContain('0 / 2 冊')
    // 1 冊目の応答を止めたまま、別の案件を開く
    await openCase(w, CASE_B.name)
    expect(statuses(w)).toEqual(['未実行'])
    // 切替先では「ZIP を作る」を押せる (前の実行に引きずられない)
    expect(buttonByText(w, 'ZIP を作る').attributes('disabled')).toBeUndefined()
    gate.resolve()
    await settle()

    // 切替先 (案件 B、1 冊) の表・進捗・結果の文に、案件 A の実行は何も書かない
    expect(statuses(w)).toEqual(['未実行'])
    expect(w.find('[data-testid="litigation-output-progress"]').exists()).toBe(false)
    expect(w.find('[data-testid="litigation-output-save-progress"]').exists()).toBe(false)
    expect(w.find('[data-testid="litigation-output-save-message"]').exists()).toBe(false)
    expect(alertColors(w)).toEqual([])
    expect(w.find('[data-testid="litigation-zip-summary"]').text()).toContain('まだ')
    expect(buttonByText(w, 'ZIP を作る').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-testid="litigation-output-versions"]').text()).toContain('保存した版はまだありません')
    // 押した案件 A の ZIP はダウンロードし、版も案件 A へ最後まで保存している
    expect(saved.map(s => s.name)).toEqual([expect.stringContaining('訴訟準備_架空の案件A_')])
    expect((posts()[0]!.body as { caseId: string }).caseId).toBe('case-a')
    expect(urlsOf('PUT', '/restraint-api/litigation-outputs/file?').every(u => u.includes('case_id=case-a'))).toBe(true)
    expect(putNames()).toEqual([A_BOOK_1, A_BOOK_2, 'changes.csv'])
    expect(versions['case-a']![0]!.files).toHaveLength(3)
    w.unmount()
  })

  it('★ 変更記録は押した時点のものを ZIP・版の results・上げる CSV に使う (陰性対照: 実行の最後に読むと、切替で空になった表が入る)', async () => {
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, '変更記録').trigger('click')
    await buttonByText(w, '検知を実行').trigger('click')
    await settle()
    expect(w.find('[data-testid="litigation-changes-count"]').text()).toContain('1 件')
    await buttonByText(w, '出力').trigger('click')
    const gate = deferred()
    exportHandler = async (body) => {
      await gate.promise
      return new Response(`xlsx:${body.from}`, { status: 200, headers: { 'x-y-time-rows': '5' } })
    }
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    // 作成中に別の案件を開く (変更記録タブの表は切替で空になる)
    await openCase(w, CASE_B.name)
    gate.resolve()
    await settle()

    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    const csv = await zip.file(CSV_LABEL)!.async('string')
    expect(csv).toContain('始業 08:00 → 07:30')
    expect(csv).not.toContain('「検知を実行」を押していないため')
    expect((posts()[0]!.body as { results: { changes: unknown } }).results.changes).toEqual({ finished: true, rows: 1 })
    const uploaded = versions['case-a']![0]!.files.find(f => f.name === 'changes.csv')!
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(uploaded.bytes)).toBe(csv)
    w.unmount()
  })

  it('★ 作った後の「ZIP に入るもの」の変更記録は、ZIP に入れた時点の要点のまま (後から検知を実行しても変わらない)', async () => {
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    const csvLine = () => w.find(`[data-testid="litigation-zip-summary"] [data-zip-file="${CSV_LABEL}"]`).text()
    expect(csvLine()).toContain('空の表')
    await buttonByText(w, '変更記録').trigger('click')
    await buttonByText(w, '検知を実行').trigger('click')
    await settle()
    await buttonByText(w, '出力').trigger('click')
    expect(csvLine()).toContain('空の表')
    w.unmount()
  })
})

describe('案件を開いたとき: 最新の版の結果を戻す', () => {
  it('★ 最新の版の結果が表・ZIP に入るもの・紙面に戻り、「…に出力して保存した結果を表示しています」と出る', async () => {
    versions['case-a'] = [
      storedVersion('ver-2', '2026-09-28T16:30:00.000Z', snapshotForA(99)),
      storedVersion('ver-1', '2026-09-20T01:00:00.000Z', snapshotForA(11)),
    ]
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(statuses(w)).toEqual(['作成', '0 件'])
    expect(outputTable(w).text()).toContain('99 行')
    expect(outputTable(w).text()).toContain('テンプレに行が無く書けなかった日 1 日')
    expect(w.find('[data-testid="litigation-output-restored"]').text()).toContain('2026-09-29 01:30 に出力して保存した結果を表示しています')
    expect(w.find('[data-testid="litigation-output-progress"]').text()).toContain('2 / 2 冊')
    expect(w.find('[data-testid="litigation-output-progress"]').text()).toContain('作成 1 / 0 件 1')
    const summary = w.find('[data-testid="litigation-zip-summary"]')
    expect(summary.find(`[data-zip-file="${A_BOOK_1}"]`).text()).toContain('入る')
    expect(summary.find(`[data-zip-file="${A_BOOK_2}"]`).text()).toContain('入らない')
    // 変更記録は、今の変更記録タブ (未実行) ではなく、その版に入れた時点の要点
    expect(summary.find(`[data-zip-file="${CSV_LABEL}"]`).text()).toContain('変更 7 件')
    const sheet = w.find('[data-testid="litigation-print-output"]')
    expect(sheet.find('[data-testid="litigation-print-restored"]').text()).toBe('2026-09-29 01:30 に出力して保存した結果を表示しています')
    expect(sheet.text()).toContain('99 行')
    // 一覧は 2 版、表示中の印は最新の版だけ。読んだ results は最新の 1 件だけ
    expect(versionRows(w).map(r => r.text().includes('表示中'))).toEqual([true, false])
    expect(urlsOf('GET', '/restraint-api/litigation-outputs?').filter(u => u.includes('version_id='))).toEqual([
      '/restraint-api/litigation-outputs?case_id=case-a&version_id=ver-2',
    ])
    // ダウンロードも保存もしていない
    expect(saved).toHaveLength(0)
    expect(posts()).toHaveLength(0)
    w.unmount()
  })

  it('★ 戻した結果はエラータブの行を変えない (陰性対照: 戻した結果を outputResults に入れると「Y時間の欠け」が異常ありになる)', async () => {
    versions['case-a'] = [storedVersion('ver-2', '2026-09-28T16:30:00.000Z', snapshotForA(99))]
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    // 陽性対照: 出力タブには、書けなかった日 1 日 (2024-02-03) の結果が戻っている
    expect(outputTable(w).text()).toContain('2024-02-03')
    await buttonByText(w, 'エラー').trigger('click')
    await settle()
    const cell = (row: string) => w.find(`tr[data-row="${row}"] td[data-check="yTime"]`).text()
    expect(cell('1001|2024-02')).toContain('未実行')
    expect(cell('1001|2024-02')).not.toContain('異常あり')
    expect(w.find('[data-testid="litigation-errors-summary"]').text()).toContain('Y時間の欠け: 異常あり 0 / 異常なし 0 / 判定できない 0 / 未実行 13')
    w.unmount()
  })

  it('★ このページで実行した結果は、今までどおりエラータブへ渡る (戻した結果との違いの陽性対照)', async () => {
    exportHandler = () => new Response('xlsx', { status: 200, headers: { 'x-y-time-rows': '5', 'x-y-time-missing-dates': '2024-02-03', 'x-y-time-missing-count': '1' } })
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    await buttonByText(w, 'エラー').trigger('click')
    await settle()
    expect(w.find('tr[data-row="1001|2024-02"] td[data-check="yTime"]').text()).toContain('異常あり')
    w.unmount()
  })

  it('★ 区切りが今の案件と違う版 (期間・乗務員を変えた) は戻さず、その旨を出す。ZIP は一覧からダウンロードできる', async () => {
    const edited = snapshotForA(99)
    edited.chunks[1] = { driverCd: '1001', from: '2025-01-01', to: '2025-02-28' }
    versions['case-a'] = [storedVersion('ver-2', '2026-09-28T16:30:00.000Z', edited)]
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(statuses(w)).toEqual(['未実行', '未実行'])
    expect(w.find('[data-testid="litigation-output-restored"]').exists()).toBe(false)
    expect(w.find('[data-testid="litigation-output-restore-notice"]').text())
      .toBe('案件の期間・乗務員を変えたため、保存した結果は表示していません (版の一覧から ZIP はダウンロードできます)')
    expect(w.find('[data-testid="litigation-zip-summary"]').text()).toContain('まだ')
    expect(versionRows(w)).toHaveLength(1)
    expect(versionRows(w)[0]!.findAll('button').map(b => b.text().trim())).toEqual(['この版の ZIP をダウンロード', 'この版の結果を表示'])
    w.unmount()
  })

  it('★ 結果が読めない形の版は戻さず、「区切りが違う」とは別の文を出す', async () => {
    versions['case-a'] = [storedVersion('ver-2', '2026-09-28T16:30:00.000Z', { ...snapshotForA(99), v: 2 })]
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(statuses(w)).toEqual(['未実行', '未実行'])
    expect(w.find('[data-testid="litigation-output-restore-notice"]').text())
      .toBe('2026-09-29 01:30 の版は、結果が読めない形で保存されているため表示していません (版の一覧から ZIP はダウンロードできます)')
    w.unmount()
  })

  it('★ 一覧の応答より先に「ZIP を作る」を押したら、新しい実行の結果を優先し、遅れて届いた読み戻しは捨てる。古い一覧で上書きもしない', async () => {
    versions['case-a'] = [storedVersion('ver-old', '2026-09-20T01:00:00.000Z', snapshotForA(99))]
    const gate = deferred()
    firstListGate = gate.promise
    const w = await mountPage()
    await clickOpen(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    // 実行と保存は終わり、保存の後の読み直しで一覧は 2 版になっている (最初の一覧はまだ返っていない)
    expect(statuses(w)).toEqual(['作成', '作成'])
    expect(versionRows(w)).toHaveLength(2)
    gate.resolve()
    await settle()
    // 遅れて届いた最初の一覧 (1 版) と、その最新の版の読み戻しは、どちらも表示へ入らない
    expect(statuses(w)).toEqual(['作成', '作成'])
    expect(outputTable(w).text()).toContain('5 行')
    expect(outputTable(w).text()).not.toContain('99 行')
    expect(w.find('[data-testid="litigation-output-restored"]').exists()).toBe(false)
    expect(versionRows(w)).toHaveLength(2)
    w.unmount()
  })

  it('別の案件を開くと、前の案件の戻した結果・一覧は消え、切替先の版を読む', async () => {
    versions['case-a'] = [storedVersion('ver-2', '2026-09-28T16:30:00.000Z', snapshotForA(99))]
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(w.find('[data-testid="litigation-output-restored"]').exists()).toBe(true)
    await openCase(w, CASE_B.name)
    expect(w.find('[data-testid="litigation-output-restored"]').exists()).toBe(false)
    expect(statuses(w)).toEqual(['未実行'])
    expect(versionRows(w)).toHaveLength(0)
    expect(urlsOf('GET', '/restraint-api/litigation-outputs?')).toContain('/restraint-api/litigation-outputs?case_id=case-b')
    w.unmount()
  })
})

describe('版の一覧', () => {
  beforeEach(() => {
    versions['case-a'] = [
      storedVersion('ver-2', '2026-09-28T16:30:00.000Z', snapshotForA(99)),
      storedVersion('ver-1', '2026-09-20T01:00:00.000Z', snapshotForA(11)),
    ]
  })

  it('★ 版ごとに 日時 (JST)・出力した人・Excel の冊数・ファイル数・合計の大きさ と、2 つのボタンが出る', async () => {
    versions['case-a']![1]!.createdBy = null
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    const rows = versionRows(w)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.findAll('td').slice(0, 4).map(td => td.text().replace(/\s+/g, ' '))).toEqual([
      '2026-09-29 01:30 表示中', 'someone@example.com', 'Excel 1 冊 / ファイル 2 個', '21 B',
    ])
    expect(rows[1]!.findAll('td').slice(0, 2).map(td => td.text())).toEqual(['2026-09-20 10:00', '不明'])
    expect(rows[1]!.findAll('button').map(b => b.text().trim())).toEqual(['この版の ZIP をダウンロード', 'この版の結果を表示'])
    w.unmount()
  })

  it('★ 「この版の ZIP をダウンロード」: ファイルを 1 つずつ取り、ZIP 内の名前は label、ZIP の名前はその版の日付 (JST)', async () => {
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await versionRows(w)[1]!.findAll('button')[0]!.trigger('click')
    await settle()
    expect(urlsOf('GET', '/restraint-api/litigation-outputs/file?')).toEqual([
      `/restraint-api/litigation-outputs/file?case_id=case-a&version_id=ver-1&name=${A_BOOK_1}`,
      '/restraint-api/litigation-outputs/file?case_id=case-a&version_id=ver-1&name=changes.csv',
    ])
    expect(saved.map(s => s.name)).toEqual(['訴訟準備_架空の案件A_2026-09-20.zip'])
    const zip = await JSZip.loadAsync(await saved[0]!.blob.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual([A_BOOK_1, CSV_LABEL].sort())
    expect(await zip.file(A_BOOK_1)!.async('string')).toBe('ver-1:book')
    expect(await zip.file(CSV_LABEL)!.async('string')).toBe('ver-1:csv')
    // 版は増えない (ダウンロードは保存ではない)
    expect(posts()).toHaveLength(0)
    expect(w.find('[data-testid="litigation-version-action-error"]').exists()).toBe(false)
    w.unmount()
  })

  it('★ ファイルが 1 つでも取れなければ ZIP は作らず、取れなかったファイルと理由を出す', async () => {
    fileGetHandler = name => name === 'changes.csv' ? Response.json({ error: 'ファイルが見つかりません' }, { status: 404 }) : null
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    await versionRows(w)[0]!.findAll('button')[0]!.trigger('click')
    await settle()
    expect(saved).toHaveLength(0)
    const error = w.find('[data-testid="litigation-version-action-error"]').text()
    expect(error).toContain(`この版の ZIP を作れませんでした (取れなかったファイル): ${CSV_LABEL} — `)
    expect(error).toContain('ファイルが見つかりません')
    // 失敗の後は、もう一度押せる
    expect(versionRows(w)[0]!.findAll('button')[0]!.attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('★ 「この版の結果を表示」で古い版の結果に切り替わり、「このページで作った結果に戻す」で実行した結果に戻る', async () => {
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(outputTable(w).text()).toContain('99 行')
    await versionRows(w)[1]!.findAll('button')[1]!.trigger('click')
    await settle()
    expect(outputTable(w).text()).toContain('11 行')
    expect(w.find('[data-testid="litigation-output-restored"]').text()).toContain('2026-09-20 10:00 に出力して保存した結果を表示しています')
    expect(versionRows(w).map(r => r.text().includes('表示中'))).toEqual([false, true])
    // このページでまだ実行していない間は、戻る先が無いのでボタンを出さない
    expect(w.findAll('button').some(b => b.text().trim() === 'このページで作った結果に戻す')).toBe(false)

    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
    expect(w.find('[data-testid="litigation-output-restored"]').exists()).toBe(false)
    expect(outputTable(w).text()).toContain('5 行')
    await versionRows(w)[2]!.findAll('button')[1]!.trigger('click')
    await settle()
    expect(outputTable(w).text()).toContain('11 行')
    await buttonByText(w, 'このページで作った結果に戻す').trigger('click')
    expect(outputTable(w).text()).toContain('5 行')
    expect(w.find('[data-testid="litigation-output-restored"]').exists()).toBe(false)
    w.unmount()
  })

  it('★ 一覧が 403 (admin / payroll 以外) のときは、エラーにせず 1 行だけ出す', async () => {
    listHandler = () => { throw err(403, 'この操作は admin / payroll のみ実行できます') }
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(w.find('[data-testid="litigation-output-versions-forbidden"]').text()).toBe('出力の保存と履歴は admin / payroll のみ使えます')
    expect(w.find('[data-testid="litigation-output-versions"]').exists()).toBe(false)
    expect(w.find('[data-testid="litigation-output-versions-error"]').exists()).toBe(false)
    expect(alertColors(w)).toEqual([])
    expect(w.text()).not.toContain('版の一覧を読めませんでした')
    // ボタンは今までどおり出す (front は役割を知らない)
    expect(buttonByText(w, 'ZIP を作る').attributes('disabled')).toBeUndefined()
    w.unmount()
  })

  it('★ 一覧が 403 以外で読めなければ出力タブに理由を出し、「履歴を読み直す」で読み直せる', async () => {
    listHandler = () => { throw err(500, '架空の障害') }
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    const error = w.find('[data-testid="litigation-output-versions-error"]')
    expect(error.text()).toContain('版の一覧を読めませんでした')
    expect(error.text()).toContain('架空の障害')
    expect(error.text()).toContain('「履歴を読み直す」を押してやり直してください')
    expect(w.find('[data-testid="litigation-output-versions"]').text()).not.toContain('保存した版はまだありません')
    listHandler = null
    await buttonByText(w, '履歴を読み直す').trigger('click')
    await settle()
    expect(w.find('[data-testid="litigation-output-versions-error"]').exists()).toBe(false)
    expect(versionRows(w)).toHaveLength(2)
    // 読み直しは一覧だけ (結果は勝手に戻さない)
    expect(w.find('[data-testid="litigation-output-restored"]').exists()).toBe(false)
    w.unmount()
  })

  it('一覧の応答の形が想定外・読めない版が混ざるときも、黙って空にしない', async () => {
    listHandler = () => ({ versions: [{ versionId: 1 }, ...listResponse('case-a').versions] })
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(w.find('[data-testid="litigation-output-versions"]').text()).toContain('形が読めない版が 1 件あり、一覧に出していません')
    expect(versionRows(w)).toHaveLength(2)
    listHandler = () => ({ unexpected: true })
    await buttonByText(w, '履歴を読み直す').trigger('click')
    await settle()
    expect(w.find('[data-testid="litigation-output-versions-error"]').text()).toBe('版の一覧を読めませんでした: 応答の形が想定外')
    w.unmount()
  })

  it('版の結果を読めなかったときは理由を出す (表示は変えない)', async () => {
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    versions['case-a'] = [versions['case-a']![0]!]
    await versionRows(w)[1]!.findAll('button')[1]!.trigger('click')
    await settle()
    const error = w.find('[data-testid="litigation-version-action-error"]').text()
    expect(error).toContain('保存した結果を読めませんでした')
    expect(error).toContain('出力の版が見つかりません')
    expect(outputTable(w).text()).toContain('99 行')
    w.unmount()
  })
})

describe('行の元 (勤怠の勤務の記録 / 運行、Refs #1133 c1133-46)', () => {
  const lines = (w: VueWrapper, i: number) => outputTable(w).findAll('tbody tr')[i]!.findAll('[data-output-line]').map(d => `${d.attributes('data-output-line')}: ${d.text()}`)
  const resultCell = (w: VueWrapper, i: number) => outputTable(w).findAll('tbody tr')[i]!.findAll('td')[4]!.text()
  const errorCell = (w: VueWrapper, row: string, check: string) => w.find(`tr[data-row="${row}"] td[data-check="${check}"]`).text()
  const importButtons = (w: VueWrapper) => w.findAll('[data-testid="litigation-import"]')

  async function run(w: VueWrapper) {
    await openCase(w, CASE_A.name)
    await buttonByText(w, 'ZIP を作る').trigger('click')
    await settle()
  }

  it('★ 勤怠の元: 元・行を作れなかった勤務 (理由ごとの件数)・畳み直しの案内・記録の無い月が表と紙面に出る。0 件の冊は「運行」と言わない', async () => {
    exportHandler = body => body.from === '2024-01-01'
      ? new Response('xlsx', {
          status: 200,
          headers: {
            'x-y-time-rows': '5',
            'x-y-time-source': 'kintai',
            'x-y-time-excluded-reasons': 'no_non_working=2,overlap=1',
            'x-y-time-excluded': '2024-03-04:no_non_working,2024-03-05:no_non_working,2024-06-01:overlap',
            'x-y-time-missing-months': '2024-08,2024-09',
          },
        })
      : new Response('xlsx', { status: 200, headers: { 'x-y-time-rows': '0', 'x-y-time-source': 'kintai' } })
    const w = await mountPage()
    await run(w)
    expect(statuses(w)).toEqual(['作成', '0 件'])
    expect(lines(w, 0)).toEqual([
      'source: 勤怠の記録から作成',
      'excluded: 行を作れなかった勤務 3 件 (まだ畳み直していない 2 件・別の勤務と時間が重なる 1 件) — 始業の日付: 2024-03-04 (まだ畳み直していない), 2024-03-05 (まだ畳み直していない), 2024-06-01 (別の勤務と時間が重なる)',
      'refold: 勤怠の畳み直しが要ります (まだ畳み直していない勤務 2 件)',
      'missingMonths: 勤務の記録が無い月: 2024-08, 2024-09',
    ])
    expect(resultCell(w, 1)).toContain('この期間に勤務が 0 件')
    expect(lines(w, 1)).toEqual(['source: 勤怠の記録から作成'])
    expect(outputTable(w).text()).not.toContain('運行')
    expect(w.find('[data-testid="litigation-output-progress"]').text()).toContain('作成 1 / 0 件 1')
    // 0 件の冊は ZIP に入らず、理由は勤務の語で出る
    expect(w.find(`[data-zip-file="${A_BOOK_2}"]`).text()).toContain('入らない: この期間に勤務が 0 件')
    const sheet = w.find('[data-testid="litigation-print-output"]').text()
    expect(sheet).toContain('5 行 / 勤怠の記録から作成 / 行を作れなかった勤務 3 件')
    expect(sheet).toContain('勤怠の畳み直しが要ります (まだ畳み直していない勤務 2 件) / 勤務の記録が無い月: 2024-08, 2024-09')
    expect(sheet).toContain('この期間に勤務が 0 件 / 勤怠の記録から作成')

    // エラータブ: 勤怠の元の 0 件では「alc の運行」を異常ありにせず、運行の取り込みのボタンを出さない
    await buttonByText(w, 'エラー').trigger('click')
    await settle()
    expect(errorCell(w, '1001|2025-01', 'alcOps')).toContain('未実行')
    expect(errorCell(w, '1001|2025-01', 'yTime')).toContain('書けなかった日なし (この冊は勤務 0 件)')
    expect(importButtons(w)).toHaveLength(0)
    // 行を作れなかった勤務の在る冊は「Y時間の欠け」が異常あり
    expect(errorCell(w, '1001|2024-02', 'yTime')).toContain('異常あり')
    expect(errorCell(w, '1001|2024-02', 'yTime')).toContain('この冊で行を作れなかった勤務 3 件 (出力タブの結果): まだ畳み直していない 2 件・別の勤務と時間が重なる 1 件 — 勤怠の畳み直しが要ります')
    w.unmount()
  })

  it('★ 運行の元へ倒した 2 通り: 理由つきで「運行から作成」と出て、0 件の冊は今までどおり運行の文と取り込みのボタン', async () => {
    exportHandler = body => body.from === '2024-01-01'
      ? new Response('xlsx', { status: 200, headers: { 'x-y-time-rows': '5', 'x-y-time-source': 'alc', 'x-y-time-source-reason': 'out_of_scope' } })
      : new Response('xlsx', { status: 200, headers: { 'x-y-time-rows': '0', 'x-y-time-source': 'alc', 'x-y-time-source-reason': 'not_configured' } })
    const w = await mountPage()
    await run(w)
    expect(lines(w, 0)).toEqual(['source: 運行から作成 (この会社は勤怠の記録が無い)'])
    expect(lines(w, 1)).toEqual(['source: 運行から作成 (この環境は勤怠の設定が無い)'])
    expect(resultCell(w, 1)).toContain('この期間に運行が 0 件 (alc に取り込まれていない可能性)')
    await buttonByText(w, 'エラー').trigger('click')
    await settle()
    expect(errorCell(w, '1001|2025-01', 'alcOps')).toContain('この冊の期間の運行が 0 件 (出力タブの結果)')
    expect(importButtons(w)).toHaveLength(1)
    w.unmount()
  })

  it('★ 倒さない失敗は「失敗」と理由の 1 文で出る (元の行は出さず、alc に未登録とも言わない)', async () => {
    exportHandler = () => Response.json({
      error: true,
      statusCode: 502,
      statusMessage: 'kintai y-time rows failed (relay)',
      message: '勤怠の勤務の記録を読めませんでした (relay 502: gcp kintai shift-days 2024-03: failed)',
      data: { source: 'kintai', stage: 'relay', status: 502, error: 'gcp kintai shift-days 2024-03: failed' },
    }, { status: 502 })
    const w = await mountPage()
    await run(w)
    expect(statuses(w)).toEqual(['失敗', '失敗'])
    expect(resultCell(w, 0)).toContain('502 勤怠の勤務の記録を読めませんでした (relay 502: gcp kintai shift-days 2024-03: failed)')
    expect(lines(w, 0)).toEqual([])
    w.unmount()
  })

  it('★ 行の元の欄の無い旧い版を開いても壊れず、運行から作ったものとして出る', async () => {
    versions['case-a'] = [storedVersion('ver-1', '2026-09-20T01:00:00.000Z', snapshotForA(11))]
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(statuses(w)).toEqual(['作成', '0 件'])
    expect(lines(w, 0)).toEqual(['source: 運行から作成'])
    expect(lines(w, 1)).toEqual(['source: 運行から作成'])
    expect(resultCell(w, 1)).toContain('この期間に運行が 0 件 (alc に取り込まれていない可能性)')
    expect(w.find('[data-testid="litigation-print-output"]').text()).toContain('11 行 / 運行から作成')
    w.unmount()
  })

  it('★ 行の元の欄つきで保存した版は、開き直しても同じ行が戻る', async () => {
    const snapshot = snapshotForA(11) as { results: Record<string, unknown>[] }
    snapshot.results[0] = { ...snapshot.results[0], source: 'kintai', excludedReasons: { no_non_working: 1 }, excluded: [{ date: '2024-03-04', reason: 'no_non_working' }], missingMonths: [] }
    versions['case-a'] = [storedVersion('ver-1', '2026-09-20T01:00:00.000Z', snapshot)]
    const w = await mountPage()
    await openCase(w, CASE_A.name)
    expect(lines(w, 0)).toEqual([
      'source: 勤怠の記録から作成',
      'excluded: 行を作れなかった勤務 1 件 (まだ畳み直していない 1 件) — 始業の日付: 2024-03-04 (まだ畳み直していない)',
      'refold: 勤怠の畳み直しが要ります (まだ畳み直していない勤務 1 件)',
    ])
    w.unmount()
  })
})
