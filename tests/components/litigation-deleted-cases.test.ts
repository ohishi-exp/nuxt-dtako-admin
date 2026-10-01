/**
 * `/litigation` (訴訟準備) の案件の削除・復活 (Refs #1133 c1133-33)。relay は削除を「消さずに 30 日残す」にした
 * (admin / payroll だけ) ので、画面は次の 4 つを持つ。
 *
 * 1. 削除の確認文が「30 日間は復活できる」
 * 2. 案件の一覧の下に「削除した案件」の節 (行ごとに「復活」)。**403 (役割が無い) と 0 件では節を出さない**
 * 3. 復活の失敗 (404 / 409 / その他) の文は、合成後に嘘にならない (押し直しても直らないものを「押してやり直して」と言わない)
 * 4. 削除済みの案件への保存 (PUT の 404) の文も同じ
 *
 * ★ 「読み直しの後に文を入れる」順は、読み直し (`loadCases`) の成功が `pageError` を空にするため。
 *   順を逆にすると文が消える — 下の 404 / 409 のテストが「読み直した後も文が残っている」で固定する。
 *
 * 型は `litigation-viewer-comp.test.ts` をなぞる。値はすべて架空。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: { getDrivers: vi.fn(), getYTimeRows: vi.fn() },
}))

vi.mock('~/utils/download-blob', () => ({ downloadBlob: vi.fn() }))
vi.mock('@ippoan/auth-client', () => ({ useAuth: () => ({ token: { value: 'jwt-token' } }) }))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: api.getDrivers,
  getYTimeRows: api.getYTimeRows,
}))

const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})

const Page = (await import('~/pages/litigation.vue')).default

const CASE = {
  caseId: 'case-live',
  name: '架空の案件A',
  fromMonth: '2025-01',
  toMonth: '2025-03',
  driverCds: ['1001'],
  memo: '',
  createdAt: '2025-04-01T00:00:00.000Z',
  updatedAt: '2025-04-02T00:00:00.000Z',
}
const GONE = {
  case: { ...CASE, caseId: 'case-gone', name: '架空の削除済み案件B', fromMonth: '2024-10', toMonth: '2024-12' },
  deletedAt: '2025-05-31T16:30:00.000Z', // JST 2025-06-01 01:30 → 30 日後は JST 2025-07-01
  deletedBy: 'admin-user',
}

type Call = { method: string, url: string, body?: unknown }
let calls: Call[]
let liveCases: unknown[]
let deletedHandler: () => unknown
let restoreHandler: (body: { caseId: string }) => unknown
let saveHandler: () => unknown
let deleteHandler: () => unknown
let confirmMock: ReturnType<typeof vi.fn>

const err = (status: number, error: string) => Object.assign(new Error(String(status)), { statusCode: status, data: { error } })

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 0))
    await flushPromises()
  }
}

async function mountPage(): Promise<VueWrapper> {
  const w = mount(Page, { global: { stubs: { ...NUXT_UI_PAGE_STUBS, DriverSearchSelect: true, UInput: { props: ['modelValue'], template: '<input />' }, USelectMenu: { props: ['modelValue', 'items'], template: '<select />' } } } })
  await settle()
  return w
}

async function click(w: VueWrapper, label: string, nth = 0) {
  await w.findAll('button').filter(b => b.text().trim() === label)[nth]!.trigger('click')
  await settle()
}

const getCount = (suffix: string) => calls.filter(c => c.method === 'GET' && c.url === `/restraint-api/litigation-cases${suffix}`).length
const section = (w: VueWrapper) => w.find('[data-testid=litigation-deleted]')
const sectionError = (w: VueWrapper) => w.find('[data-testid=litigation-deleted-error]')

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('litigation-viewer-comp', '27324455')
  nuxtState.clear()
  api.getDrivers.mockResolvedValue([])
  calls = []
  liveCases = [CASE]
  deletedHandler = () => ({ cases: [GONE] })
  restoreHandler = () => ({ restored: true, case: GONE.case })
  saveHandler = () => ({ case: CASE })
  deleteHandler = () => ({ deleted: true })
  confirmMock = vi.fn(() => true)
  vi.stubGlobal('confirm', confirmMock)
  vi.stubGlobal('$fetch', vi.fn(async (url: string, opts: { method?: string, body?: unknown } = {}) => {
    const method = opts.method ?? 'GET'
    calls.push({ method, url, body: opts.body })
    if (url === '/restraint-api/viewer-comps') return { comps: ['27324455'] }
    if (url === '/restraint-api/litigation-cases' && method === 'GET') return { cases: liveCases }
    if (url === '/restraint-api/litigation-cases' && method === 'PUT') return saveHandler()
    if (url === '/restraint-api/litigation-cases' && method === 'DELETE') return deleteHandler()
    if (url === '/restraint-api/litigation-cases/deleted') return deletedHandler()
    if (url === '/restraint-api/litigation-cases/restore') return restoreHandler(opts.body as { caseId: string })
    throw new Error(`unexpected $fetch ${method} ${url}`)
  }))
})

describe('削除した案件の節', () => {
  it('★ 一覧に在れば見出しと行 (案件名・期間・削除した日時 (JST)・削除した人・消える日・復活) が出る', async () => {
    const w = await mountPage()
    const s = section(w)
    expect(s.exists()).toBe(true)
    expect(s.text()).toContain('削除した案件 (削除から 30 日間)')
    expect(s.text()).toContain('架空の削除済み案件B')
    expect(s.text()).toContain('2024-10 〜 2024-12')
    expect(s.text()).toContain('2025-06-01 01:30')
    expect(s.text()).toContain('admin-user')
    expect(s.text()).toContain('2025-07-01')
    expect(s.findAll('button').map(b => b.text().trim())).toEqual(['復活'])
    // 生きている案件は節に混ざらない
    expect(s.text()).not.toContain('架空の案件A')
  })

  it('★ 0 件なら節を出さず、警告も出さない', async () => {
    deletedHandler = () => ({ cases: [] })
    const w = await mountPage()
    expect(section(w).exists()).toBe(false)
    expect(sectionError(w).exists()).toBe(false)
    expect(w.text()).not.toContain('削除した案件')
  })

  it('★ 陰性対照: 403 (admin / payroll 以外) なら節も警告も pageError も出さず、案件の一覧は普通に出る', async () => {
    deletedHandler = () => { throw err(403, 'この操作は admin / payroll のみ実行できます') }
    const w = await mountPage()
    expect(section(w).exists()).toBe(false)
    expect(sectionError(w).exists()).toBe(false)
    expect(w.text()).not.toContain('権限がありません')
    expect(w.text()).toContain('架空の案件A')
  })

  it('★ 403 以外の失敗 (500) は節の位置に 1 つの警告を出す。案件の一覧と pageError は巻き込まない', async () => {
    deletedHandler = () => { throw err(500, '内部エラー') }
    const w = await mountPage()
    expect(section(w).exists()).toBe(false)
    expect(sectionError(w).text()).toBe(
      '500 内部エラー — サーバ側の設定か障害です (権限の問題ではありません)。復旧してから'
      + 'ページを読み込み直してください',
    )
    // 上の pageError の帯 (UAlert) は 1 つも出ていない = 警告は節の位置の 1 つだけ
    expect(w.findAll('[data-testid=litigation-deleted-error]')).toHaveLength(1)
    expect(w.text()).toContain('架空の案件A')
  })
})

describe('復活', () => {
  it('★ 成功したら POST {caseId} を送り、案件の一覧と削除した一覧を読み直す (行は節から消え、一覧に戻る)', async () => {
    const w = await mountPage()
    expect(getCount('')).toBe(1)
    expect(getCount('/deleted')).toBe(1)
    // 復活した後の relay の状態
    liveCases = [CASE, GONE.case]
    deletedHandler = () => ({ cases: [] })
    await click(w, '復活')
    expect(calls.find(c => c.url === '/restraint-api/litigation-cases/restore')).toMatchObject({ method: 'POST', body: { caseId: 'case-gone' } })
    expect(getCount('')).toBe(2)
    expect(getCount('/deleted')).toBe(2)
    expect(section(w).exists()).toBe(false)
    expect(w.text()).toContain('架空の削除済み案件B')
  })

  it('★ 404 (30 日を過ぎて消えた): 合成後の 1 文が、読み直した後も残る。2 つの一覧を読み直す', async () => {
    restoreHandler = () => { throw err(404, '削除した案件が見つかりません (30 日を過ぎた可能性があります)') }
    const w = await mountPage()
    deletedHandler = () => ({ cases: [] }) // 消えた後の relay
    await click(w, '復活')
    expect(w.text()).toContain(
      '削除した案件が見つかりません (30 日を過ぎた可能性があります) — 指していた対象がサーバにもう存在しません。'
      + '画面の情報が古くなっているので、読み直した一覧を確認してください',
    )
    expect(getCount('')).toBe(2)
    expect(getCount('/deleted')).toBe(2)
    expect(section(w).exists()).toBe(false)
  })

  it('★ 409 (同じ案件が既に在る): 合成後の 1 文が、読み直した後も残る', async () => {
    restoreHandler = () => { throw err(409, '同じ案件が既に在るため復活できません') }
    const w = await mountPage()
    await click(w, '復活')
    expect(w.text()).toContain(
      '同じ案件が既に在るため復活できません — 送った内容をサーバが受け付けませんでした。'
      + '上の理由のとおりに直してから案件の一覧を確認してください',
    )
    expect(getCount('')).toBe(2)
    expect(getCount('/deleted')).toBe(2)
  })

  it('その他 (500) は「復活」を押してやり直す案内 (押し直せば直りうる)。失敗でも 2 つの一覧を読み直す', async () => {
    restoreHandler = () => { throw err(500, '内部エラー') }
    const w = await mountPage()
    await click(w, '復活')
    expect(w.text()).toContain(
      '内部エラー — サーバ側の設定か障害です (権限の問題ではありません)。復旧してから「復活」を押してやり直してください',
    )
    expect(getCount('')).toBe(2)
    expect(getCount('/deleted')).toBe(2)
  })

  it('復活の失敗のあと、読み直しが成功すれば前の失敗の帯は新しい文に置き換わる (二重に溜まらない)', async () => {
    restoreHandler = () => { throw err(409, '同じ案件が既に在るため復活できません') }
    const w = await mountPage()
    await click(w, '復活')
    restoreHandler = () => { throw err(500, '内部エラー') }
    await click(w, '復活')
    expect(w.text()).not.toContain('同じ案件が既に在るため復活できません')
    expect(w.text()).toContain('内部エラー')
  })
})

describe('削除', () => {
  it('★ 確認文は「30 日間は「削除した案件」から復活できる」で、「取り消せません」とは言わない', async () => {
    const w = await mountPage()
    await click(w, '削除')
    expect(confirmMock).toHaveBeenCalledWith('案件「架空の案件A」を削除しますか？削除から 30 日間は「削除した案件」から復活できます。')
  })

  it('★ 成功したら案件の一覧と削除した一覧を読み直す', async () => {
    const w = await mountPage()
    liveCases = []
    await click(w, '削除')
    expect(calls.find(c => c.method === 'DELETE')).toMatchObject({ url: '/restraint-api/litigation-cases' })
    expect(getCount('')).toBe(2)
    expect(getCount('/deleted')).toBe(2)
  })

  it('キャンセルなら何も送らない', async () => {
    confirmMock.mockReturnValue(false)
    const w = await mountPage()
    await click(w, '削除')
    expect(calls.some(c => c.method === 'DELETE')).toBe(false)
  })

  it('★ 403 の文は既存の合成のまま', async () => {
    deleteHandler = () => { throw err(403, 'この操作は admin / payroll のみ実行できます') }
    const w = await mountPage()
    await click(w, '削除')
    expect(w.text()).toContain(
      'この操作は admin / payroll のみ実行できます — この操作の権限がありません (ログインし直しても変わりません)。'
      + '管理者に許可の追加を依頼してください',
    )
  })
})

describe('削除済みの案件への保存', () => {
  async function openEditAndSave(w: VueWrapper) {
    await click(w, '編集')
    await click(w, '保存')
  }

  it('★ 404 は押し直しても直らないので、一覧に戻る案内にする。2 つの一覧を読み直し、読み直しの後も文が残る', async () => {
    saveHandler = () => { throw err(404, '案件が見つかりません (削除された可能性があります)') }
    const w = await mountPage()
    await openEditAndSave(w)
    expect(calls.find(c => c.method === 'PUT')).toBeTruthy()
    expect(w.text()).toContain(
      '案件が見つかりません (削除された可能性があります) — 指していた対象がサーバにもう存在しません。'
      + '画面の情報が古くなっているので、一覧に戻ってください。admin / payroll は「削除した案件」から復活できます',
    )
    expect(getCount('')).toBe(2)
    expect(getCount('/deleted')).toBe(2)
  })

  it('★ 404 以外 (500) は今までどおり「保存」を押してやり直す案内で、読み直さない', async () => {
    saveHandler = () => { throw err(500, '内部エラー') }
    const w = await mountPage()
    await openEditAndSave(w)
    expect(w.text()).toContain(
      '内部エラー — サーバ側の設定か障害です (権限の問題ではありません)。復旧してから「保存」を押してやり直してください',
    )
    expect(getCount('')).toBe(1)
    expect(getCount('/deleted')).toBe(1)
  })
})
