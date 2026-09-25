/**
 * `/litigation` (訴訟準備) の会社選択 — 会社を毎回選ばせない + 選び間違いを直せる (ユーザー要望)。
 *
 * ## 何を固定するか
 *
 * 1. ★ 同じブラウザで restraint-wage.vue (`restraint-viewer-comp`) を既に使っていれば、
 *    その会社を自動で引き継ぎ、選択欄を出さない。theearth ログイン履歴 (`theearth-last-account`) も候補
 * 2. ★ `DTAKO_COMPS` に無い保存値 (手入力時代の `1590` 等) は引き継がない — 引き継ぐと relay が
 *    401「セッションが無効か期限切れ」を返し続け、再ログインしても消えなかった (本番で発生)
 * 3. ★ 候補が無ければ選択欄を出す (陰性対照 — 常に自動化されるわけではない)
 * 4. ★ 選んで「開始」を押すとその場で一覧を読む。「変更」で選択欄に戻れ、エラー帯も消える
 *
 * 型は `litigation-errors-tab.test.ts` をなぞる (`mockNuxtImport('useState', ...)` で
 * `useRestraintSession` の `lastAccount` を素通しする)。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { ref, type Ref } from 'vue'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { NUXT_UI_PAGE_STUBS } from '../helpers/stubs'

const { api } = vi.hoisted(() => ({
  api: { getDrivers: vi.fn(), getYTimePreview: vi.fn() },
}))

vi.mock('~/utils/download-blob', () => ({ downloadBlob: vi.fn() }))
vi.mock('@ippoan/auth-client', () => ({ useAuth: () => ({ token: { value: 'jwt-token' } }) }))
vi.mock('~/utils/api', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/api')>()),
  getDrivers: api.getDrivers,
  getYTimePreview: api.getYTimePreview,
}))

const nuxtState = new Map<string, Ref<unknown>>()
mockNuxtImport('useState', () => (key: string, init?: () => unknown) => {
  if (!nuxtState.has(key)) nuxtState.set(key, ref(init ? init() : null))
  return nuxtState.get(key)!
})

const Page = (await import('~/pages/litigation.vue')).default

let fetchMock: ReturnType<typeof vi.fn>

async function settle() {
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 0))
    await flushPromises()
  }
}

function mountPage(): VueWrapper {
  return mount(Page, {
    global: { stubs: { ...NUXT_UI_PAGE_STUBS, DriverSearchSelect: true } },
  })
}

/** 会社の選択欄が出ているか (UCard スタブは `#header` を描画しないので、
 * 選択欄の中にしか無い「開始」ボタンの有無で判定する)。 */
function hasViewerForm(w: VueWrapper): boolean {
  return w.findAll('button').some(b => b.text().trim() === '開始')
}

/** 案件一覧を読みに行った会社ID (X-Theearth-Comp-Id) の列。 */
function loadedComps(): string[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === '/restraint-api/litigation-cases')
    .map(([, opts]) => (opts as { headers: Record<string, string> }).headers['X-Theearth-Comp-Id']!)
}

beforeEach(() => {
  localStorage.clear()
  nuxtState.clear()
  api.getDrivers.mockResolvedValue([])
  fetchMock = vi.fn(async (url: string) => {
    if (url === '/restraint-api/litigation-cases') return { cases: [] }
    throw new Error(`unexpected $fetch ${url}`)
  })
  vi.stubGlobal('$fetch', fetchMock)
})

describe('/litigation 会社の自動引き継ぎ', () => {
  it('★ litigation 自身の保存値があればそれを使い、選択欄を出さずに一覧を読む', async () => {
    localStorage.setItem('litigation-viewer-comp', '27324455')
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(false)
    expect(w.text()).toContain('会社: 27324455 (大石運輸倉庫)')
    expect(loadedComps()).toEqual(['27324455'])
  })

  it('★ litigation 自身の保存値が無ければ restraint-wage.vue の保存値 (restraint-viewer-comp) を引き継ぐ', async () => {
    localStorage.setItem('restraint-viewer-comp', '75700192')
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(false)
    expect(w.text()).toContain('会社: 75700192 (北海大運)')
    // 次回のために litigation 自身のキーにも書いておく
    expect(localStorage.getItem('litigation-viewer-comp')).toBe('75700192')
  })

  it('★ restraint-viewer-comp も無ければ theearth ログイン履歴 (lastAccount) を引き継ぐ', async () => {
    localStorage.setItem('theearth-last-account', JSON.stringify({ compId: '27324455', userName: 'someone' }))
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(false)
    expect(w.text()).toContain('会社: 27324455 (大石運輸倉庫)')
  })

  it('★ DTAKO_COMPS に無い保存値 (1590) は引き継がず、一覧も読みに行かない (自動で 401 にしない)', async () => {
    localStorage.setItem('litigation-viewer-comp', '1590')
    localStorage.setItem('restraint-viewer-comp', '1590')
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(true)
    expect(loadedComps()).toEqual([])
    expect(localStorage.getItem('litigation-viewer-comp')).toBe('1590') // 選び直すまで上書きしない
  })

  it('★ 前の候補が DTAKO_COMPS に無ければ次の候補を採る', async () => {
    localStorage.setItem('litigation-viewer-comp', '1590')
    localStorage.setItem('restraint-viewer-comp', '75700192')
    const w = mountPage()
    await settle()
    expect(w.text()).toContain('会社: 75700192 (北海大運)')
    expect(localStorage.getItem('litigation-viewer-comp')).toBe('75700192')
  })

  it('陰性対照: 保存値がどこにも無ければ選択欄を出す', async () => {
    const w = mountPage()
    await settle()
    expect(hasViewerForm(w)).toBe(true)
    expect(w.text()).not.toContain('会社: ')
    expect(loadedComps()).toEqual([])
  })
})

describe('/litigation 会社の選択と変更', () => {
  it('★ 選択欄は DTAKO_COMPS の 2 社。選んで「開始」を押すとその場で一覧を読み、保存する', async () => {
    const w = mountPage()
    await settle()
    const select = w.find('select')
    expect(select.findAll('option').map(o => o.attributes('value'))).toEqual(['27324455', '75700192'])
    await select.setValue('75700192')
    await w.findAll('button').find(b => b.text().trim() === '開始')!.trigger('click')
    await settle()
    expect(hasViewerForm(w)).toBe(false)
    expect(loadedComps()).toEqual(['75700192'])
    expect(localStorage.getItem('litigation-viewer-comp')).toBe('75700192')
  })

  it('★ 「変更」で選択欄に戻り、エラー帯も消える。選び直すと新しい会社で読み直す', async () => {
    localStorage.setItem('litigation-viewer-comp', '75700192')
    fetchMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('401'), { statusCode: 401, data: { error: 'セッションが無効か期限切れです。再ログインしてください' } })
    })
    const w = mountPage()
    await settle()
    expect(w.text()).toContain('セッションが無効か期限切れです')

    await w.findAll('button').find(b => b.text().trim() === '変更')!.trigger('click')
    await settle()
    expect(hasViewerForm(w)).toBe(true)
    expect(w.text()).not.toContain('セッションが無効か期限切れです')

    await w.find('select').setValue('27324455')
    await w.findAll('button').find(b => b.text().trim() === '開始')!.trigger('click')
    await settle()
    expect(loadedComps()).toEqual(['75700192', '27324455'])
    expect(w.text()).toContain('会社: 27324455 (大石運輸倉庫)')
  })
})
